// Board open (with commitment) and the public board feed.
import { tx, money } from './db.js';
import { newBag, countsOf, COMMIT_SCHEME, KINDS } from './bag.js';
import { GRID, CLOSE_AT, BIG_UNLOCK, STALL_MS, HOLD_MS, POLL_MS, STAKES, LIVE_STAKES, EA_AT } from './config.js';

export const OPEN_LOCK = 7340600; // + stake -> per-stake advisory lock for board opening

const BOARD_COLS = `id, stake, n, status, opened_at, stall_from, plays, carry_in, carry_used, host_drawn,
  commit_hash, commit_scheme, bag_left`;

export async function getOpenBoard(q, stake) {
  const { rows } = await q.query(`SELECT ${BOARD_COLS} FROM boards WHERE stake = $1 AND status = 'open'`, [stake]);
  return rows[0] || null;
}

/**
 * Return the open board for a stake, opening board n+1 if there is none.
 * Safe under concurrent first requests: a per-stake transaction advisory lock serializes openers,
 * and the partial unique index boards_one_open_per_stake is the hard backstop.
 * The bag is shuffled and locked here; only the commit hash and counts are public.
 */
export async function ensureOpenBoard(pool, stake) {
  if (!LIVE_STAKES.includes(stake)) throw Object.assign(new Error('stake not live'), { status: 404, expose: 'Board not open' });
  const existing = await getOpenBoard(pool, stake);
  if (existing) return existing;
  return tx(pool, async c => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [OPEN_LOCK + stake]);
    const again = await getOpenBoard(c, stake);
    if (again) return again;
    const { rows: [last] } = await c.query(
      `SELECT n, status, summary FROM boards WHERE stake = $1 ORDER BY n DESC LIMIT 1`, [stake]);
    const n = last ? last.n + 1 : 1;
    const carryIn = last && last.summary && last.summary.carryOut ? money(last.summary.carryOut) : 0;
    return insertBoard(c, stake, n, carryIn);
  });
}

/** Insert board (stake, n) with a freshly shuffled, locked bag. Caller holds the right locks. */
export async function insertBoard(c, stake, n, carryIn) {
  await c.query('SELECT pg_advisory_xact_lock($1)', [OPEN_LOCK + stake]);
  const bag = newBag(stake, n);
  const { rows: [board] } = await c.query(
    `INSERT INTO boards (stake, n, carry_in, commit_hash, commit_scheme, bag_left)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${BOARD_COLS}`,
    [stake, n, carryIn, bag.commit, COMMIT_SCHEME, JSON.stringify(countsOf(bag.order))]);
  await c.query('INSERT INTO board_secrets (board_id, salt, draw_order) VALUES ($1, $2, $3)',
    [board.id, bag.salt, bag.codes]);
  return board;
}

/** Display label: self-typed @handles stay hidden until X sign-in; screened in-game handles show. */
export function displayName(p) {
  if (p.handle && p.handle_kind === 'x' && p.x_user_id) return '@' + p.handle;
  if (p.handle && p.handle_kind === 'game') return p.handle;
  return `Player ${String(p.id).padStart(4, '0')}`;
}

/** Public feed for one stake. Never touches board_secrets. */
export async function boardFeed(pool, stake) {
  const b = await ensureOpenBoard(pool, stake);
  const [plays, held] = await Promise.all([
    pool.query(
      `SELECT p.idx, p.play_no, p.prize, p.at, p.player_id, pl.id, pl.handle, pl.handle_kind, pl.x_user_id, pl.is_bot
         FROM plays p JOIN players pl ON pl.id = p.player_id
        WHERE p.board_id = $1 ORDER BY p.play_no`, [b.id]),
    pool.query(
      `SELECT idx FROM hold_squares WHERE stake = $1 AND board_n = $2 AND expires_at > now() ORDER BY idx`,
      [stake, b.n]),
  ]);
  const [pre, last] = await Promise.all([
    pool.query(
      `SELECT (SELECT count(*) FROM prepicks WHERE stake = $1 AND board_n = $2)::int AS prepicked,
              (SELECT count(*) FROM hold_squares WHERE stake = $1 AND board_n = $2 AND expires_at > now())::int AS held`,
      [stake, b.n + 1]),
    pool.query(
      `SELECT id, n, reason, opened_at, closed_at, commit_hash, summary, reveal FROM boards
        WHERE stake = $1 AND status = 'closed' ORDER BY n DESC LIMIT 1`, [stake]),
  ]);
  const lc = last.rows[0];
  // who: compact player table so each square only carries an index
  const who = [], whoIx = new Map();
  const squares = plays.rows.map(r => {
    let k = whoIx.get(r.player_id);
    if (k === undefined) { k = who.length; whoIx.set(r.player_id, k); who.push({ name: displayName(r), bot: r.is_bot }); }
    return [r.idx, r.play_no, KINDS[r.prize], k];
  });
  const recent = squares.slice(-12).reverse().map(([i, k, p, w]) => ({ i, k, p, who: w }));
  const heldIdx = held.rows.map(r => r.idx);
  const openedAt = new Date(b.opened_at), stallFrom = new Date(b.stall_from);
  return {
    v: 1,
    serverTime: new Date().toISOString(),
    pollMs: POLL_MS,
    stakes: STAKES,
    board: {
      id: Number(b.id), stake: b.stake, n: b.n, status: b.status,
      label: `$${b.stake} Board #${b.n}`,
      version: `${b.id}.${b.plays}.${heldIdx.length}`,
      grid: GRID, closeAt: CLOSE_AT, plays: b.plays,
      openedAt: openedAt.toISOString(),
      stallAt: new Date(stallFrom.getTime() + STALL_MS).toISOString(),
      bigUnlockAt: BIG_UNLOCK, bigLive: b.plays >= BIG_UNLOCK,
      carryIn: money(b.carry_in), carryUsed: b.carry_used, hostDrawn: b.host_drawn,
      pot: b.bag_left,
      commit: { hash: b.commit_hash, scheme: b.commit_scheme, note: 'Bag shuffled and locked at open; salt and order revealed at close.' },
      holdMinutes: HOLD_MS / 60e3,
    },
    next: { n: b.n + 1, label: `$${b.stake} Board #${b.n + 1}`, prepicked: pre.rows[0].prepicked, held: pre.rows[0].held, earlyAccessAt: EA_AT },
    lastClosed: lc ? {
      id: Number(lc.id), n: lc.n, label: `$${stake} Board #${lc.n}`, reason: lc.reason,
      openedAt: new Date(lc.opened_at).toISOString(), closedAt: new Date(lc.closed_at).toISOString(),
      commit: lc.commit_hash, summary: lc.summary, reveal: lc.reveal, // salt + order are public once a board closes
    } : null,
    squares,   // [squareIndex 0-499, playNo 1-400, prize, whoIndex]
    who,       // [{ name, bot }]  bots are labeled 🤖 in the UI
    held: heldIdx,
    recent,
  };
}

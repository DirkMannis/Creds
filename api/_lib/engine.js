// Server game engine: the write path. Ported from the play-money engine in index.html
// (play, milestone, closeBoard, wallet, Early Access, stall rule).
//
// Every action runs in ONE transaction that first locks the open board row (SELECT ... FOR UPDATE),
// which serializes all plays on a board. Every money movement is an append-only ledger row; the
// wallets row caches the sum of a player's bucketed rows. Lock order: board -> holds -> wallets.
//
// Ledger conventions
//   bucket NULL       not wallet money: a simulated X Money tip coming in ('play'/'prepay'),
//                     or an informational row with amount 0 ('win', 'preplay')
//   bucket board:<id> winnings from that board (unlocks + settle); paid out or carried at its close
//   bucket carry:<id> balance kept in play (opt-out), replay credit on board <id>; paid out at its close
//   wallet.unlocked = sum(amount) over the player's bucketed rows; no bucket ever goes negative.
import { randomInt } from 'node:crypto';
import { tx, money } from './db.js';
import { KINDS, unselectedSpots, LETTER } from './bag.js';
import { insertBoard, displayName, OPEN_LOCK } from './board.js';
import {
  GRID, CLOSE_AT, MILESTONE, BIG_UNLOCK, EA_AT, HOLD_MS, STALL_MS, CASHOUT_MS, LIVE_STAKES,
  PREPICK_MAX, MAX_SQUARES_PER_HOLD, capFor,
} from './config.js';

const r2 = v => Math.round(v * 100) / 100;
const fmt = v => '$' + (Math.abs(v % 1) > 0.001 ? (+v).toFixed(2) : String(Math.round(v)));
const label = (stake, n) => `$${stake} Board #${n}`;
const PRIZE = { double: 'Double Up', big: 'Big Send', host: 'Host Tip', patron: 'Patron' };

export class GameError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.expose = message; this.extra = extra; }
}
const fail = (status, message, extra) => { throw new GameError(status, message, extra); };

/* ---------------- pending writes ---------------- */
class Book {
  constructor(c) { this.c = c; this.rows = []; this.payouts = []; }
  post(player_id, kind, amount, { bucket = null, board_id = null, square = null, note = null, ref = null } = {}) {
    this.rows.push({ player_id, kind, amount: r2(amount), bucket, board_id, square, note, ref });
  }
  payout(player_id, kind, amount, board_id) { this.payouts.push({ player_id, kind, amount: r2(amount), board_id }); }
  async flush() {
    const { c } = this;
    if (this.rows.length) {
      const R = this.rows; this.rows = [];
      await c.query(
        `INSERT INTO ledger (player_id, kind, bucket, board_id, square, amount, note, ref)
         SELECT * FROM unnest($1::bigint[], $2::text[], $3::text[], $4::bigint[], $5::smallint[], $6::numeric[], $7::text[], $8::text[])`,
        [R.map(r => r.player_id), R.map(r => r.kind), R.map(r => r.bucket), R.map(r => r.board_id), R.map(r => r.square),
          R.map(r => r.amount), R.map(r => r.note), R.map(r => r.ref)]);
      const delta = new Map();
      for (const r of R) if (r.bucket) delta.set(String(r.player_id), r2((delta.get(String(r.player_id)) || 0) + r.amount));
      const ids = [...delta.keys()].filter(k => delta.get(k) !== 0).sort((a, b) => Number(a) - Number(b));
      if (ids.length) {
        // lock wallet rows in player-id order (consistent order keeps deadlocks rare; tx() retries any)
        await c.query(`INSERT INTO wallets (player_id) SELECT unnest($1::bigint[]) ORDER BY 1 ON CONFLICT (player_id) DO NOTHING`, [ids]);
        await c.query('SELECT 1 FROM wallets WHERE player_id = ANY($1::bigint[]) ORDER BY player_id FOR UPDATE', [ids]);
        await c.query(
          `UPDATE wallets SET unlocked = unlocked + t.d, updated_at = now()
             FROM unnest($1::bigint[], $2::numeric[]) AS t(pid, d) WHERE wallets.player_id = t.pid`,
          [ids, ids.map(k => delta.get(k))]);
      }
    }
    if (this.payouts.length) {
      const P = this.payouts; this.payouts = [];
      await c.query(
        `INSERT INTO payouts (player_id, kind, amount, board_id, send_by)
         SELECT pid, k, a, b, now() + make_interval(secs => $5) FROM unnest($1::bigint[], $2::text[], $3::numeric[], $4::bigint[]) AS t(pid, k, a, b)`,
        [P.map(p => p.player_id), P.map(p => p.kind), P.map(p => p.amount), P.map(p => p.board_id), CASHOUT_MS / 1000]);
    }
  }
}

/* ---------------- board state ---------------- */
const normBoard = b => ({ ...b, id: Number(b.id), carry_in: money(b.carry_in), seeded: money(b.seeded), bag_left: { ...b.bag_left } });

/** Lock the open board for a stake (opening one if needed) and apply the 5-day stall rule.
 *  Returns { b, closed } where closed is the summary if a stalled board was just closed. */
export async function lockOpenBoard(c, stake, book) {
  if (!LIVE_STAKES.includes(stake)) fail(404, 'Board not open');
  const q = () => c.query(
    `SELECT *, (now() >= stall_from + make_interval(secs => $2)) AS stall_due FROM boards
      WHERE stake = $1 AND status = 'open' FOR UPDATE`, [stake, STALL_MS / 1000]);
  let { rows: [b] } = await q();
  if (!b) {
    // No open board visible. Another transaction may have just closed one and opened n+1: take the
    // per-stake open lock, then look again with a fresh snapshot before opening a board ourselves.
    await c.query('SELECT pg_advisory_xact_lock($1)', [OPEN_LOCK + stake]);
    ({ rows: [b] } = await q());
  }
  if (!b) {
    const { rows: [last] } = await c.query('SELECT n, summary FROM boards WHERE stake = $1 ORDER BY n DESC LIMIT 1', [stake]);
    await insertBoard(c, stake, last ? last.n + 1 : 1, last && last.summary ? money(last.summary.carryOut) : 0);
    ({ rows: [b] } = await q());
  }
  let closed = null;
  if (b.stall_due) {
    if (b.plays === 0) { // an empty board restarts its clock instead of closing
      await c.query('UPDATE boards SET stall_from = now() WHERE id = $1', [b.id]);
    } else {
      const st = await loadState(c, normBoard(b), book);
      closed = await closeBoard(st, 'stall');
      ({ rows: [b] } = await q());
    }
  }
  return { b: normBoard(b), closed };
}

async function loadState(c, b, book) {
  const [{ rows: [sec] }, { rows: wins }] = await Promise.all([
    c.query('SELECT salt, draw_order FROM board_secrets WHERE board_id = $1', [b.id]),
    c.query(`SELECT w.play_no, w.player_id, w.kind, w.amount, w.unlocked, w.evened_at, w.final, p.idx
               FROM wins w JOIN plays p ON p.board_id = w.board_id AND p.play_no = w.play_no
              WHERE w.board_id = $1 ORDER BY w.play_no`, [b.id]),
  ]);
  return {
    c, book: book || new Book(c), b, salt: sec.salt, order: sec.draw_order.map(Number),
    wins: wins.map(w => ({ ...w, player_id: Number(w.player_id), amount: money(w.amount), unlocked: money(w.unlocked) })),
    newPlays: [], dirty: new Set(),
  };
}

/** Draw the next ticket for square idx (play k gets ticket k). */
function playSquare(st, idx, player, via) {
  const { b, book } = st;
  if (b.plays >= CLOSE_AT) fail(409, 'This board is full.');
  const k = b.plays + 1, kind = KINDS[st.order[k - 1]];
  b.plays = k; b.bag_left[kind]--;
  st.newPlays.push({ idx, k, pid: player.id, name: player.name, code: st.order[k - 1], via });
  if (kind === 'double' || kind === 'big') {
    const amount = kind === 'double' ? 2 * b.stake : r2(5 * b.stake + (b.carry_used ? 0 : b.carry_in));
    if (kind === 'big') b.carry_used = true;
    const w = { play_no: k, idx, player_id: player.id, kind, amount, unlocked: 0, evened_at: null, final: false, isNew: true };
    st.wins.push(w);
    book.post(player.id, 'win', 0, { board_id: b.id, square: idx, note: `${PRIZE[kind]} drawn · ${fmt(amount)} pending · counts as it unlocks` });
  } else if (kind === 'host') b.host_drawn = true;
  if (k % MILESTONE === 0) milestone(st);
  return kind;
}

/** The unlock ladder, run every 20 plays. Funded by tips already in (plus carryover). */
function milestone(st) {
  const { b, book } = st, m = b.plays;
  let budget = b.plays * b.stake + b.carry_in - st.wins.reduce((a, w) => a + w.unlocked, 0);
  const give = (w, a) => {
    a = r2(Math.max(0, Math.min(a, w.amount - w.unlocked))); if (!a) return;
    w.unlocked = r2(w.unlocked + a); budget -= a; st.dirty.add(w);
    book.post(w.player_id, 'unlock', a, { bucket: `board:${b.id}`, board_id: b.id, square: w.idx,
      note: `Unlocked at ${m} plays · ${PRIZE[w.kind]} #${w.idx + 1} · ${label(b.stake, b.n)}` });
  };
  const dbl = st.wins.filter(w => w.kind === 'double').sort((x, y) => x.play_no - y.play_no);
  // 1) even-up every Double Up drawn since the last milestone
  for (const w of dbl) if (w.evened_at === null) { if (budget <= 0) break; give(w, Math.min(b.stake, budget)); w.evened_at = m; st.dirty.add(w); }
  // 2) profit tranche on wins evened at an earlier milestone, oldest first
  for (const w of dbl) if (w.evened_at !== null && w.evened_at < m && w.unlocked < w.amount) { if (budget <= 0) break; give(w, Math.min(w.amount - w.unlocked, budget)); }
  // 3) Big Sends unlock from 100 plays (host seeds any shortfall)
  if (m >= BIG_UNLOCK) for (const w of st.wins) if (w.kind === 'big' && w.unlocked < w.amount) {
    const need = w.amount - w.unlocked;
    b.seeded = r2(b.seeded + Math.max(0, need - Math.max(0, budget)));
    give(w, need); w.evened_at = m; st.dirty.add(w);
  }
}

async function writeState(st) {
  const { c, b } = st;
  if (st.newPlays.length) {
    const P = st.newPlays; st.newPlays = [];
    try {
      await c.query(
        `INSERT INTO plays (board_id, idx, play_no, player_id, handle_snap, prize, via)
         SELECT $1, * FROM unnest($2::smallint[], $3::smallint[], $4::bigint[], $5::text[], $6::smallint[], $7::text[])`,
        [b.id, P.map(p => p.idx), P.map(p => p.k), P.map(p => p.pid), P.map(p => p.name), P.map(p => p.code), P.map(p => p.via)]);
    } catch (e) {
      if (e.code === '23505') fail(409, 'One of those squares was just taken.');
      throw e;
    }
  }
  const fresh = st.wins.filter(w => w.isNew);
  if (fresh.length) {
    await c.query(
      `INSERT INTO wins (board_id, play_no, player_id, kind, amount, unlocked, evened_at, final)
       SELECT $1, * FROM unnest($2::smallint[], $3::bigint[], $4::text[], $5::numeric[], $6::numeric[], $7::smallint[], $8::boolean[])`,
      [b.id, fresh.map(w => w.play_no), fresh.map(w => w.player_id), fresh.map(w => w.kind), fresh.map(w => w.amount),
        fresh.map(w => w.unlocked), fresh.map(w => w.evened_at), fresh.map(w => w.final)]);
    for (const w of fresh) { delete w.isNew; st.dirty.delete(w); }
  }
  const dirty = [...st.dirty]; st.dirty.clear();
  if (dirty.length) await c.query(
    `UPDATE wins SET unlocked = t.u, evened_at = t.e, final = t.f
       FROM unnest($2::smallint[], $3::numeric[], $4::smallint[], $5::boolean[]) AS t(k, u, e, f)
      WHERE wins.board_id = $1 AND wins.play_no = t.k`,
    [b.id, dirty.map(w => w.play_no), dirty.map(w => w.unlocked), dirty.map(w => w.evened_at), dirty.map(w => w.final)]);
  await c.query(
    `UPDATE boards SET plays = $2, bag_left = $3, carry_used = $4, host_drawn = $5, seeded = $6 WHERE id = $1`,
    [b.id, b.plays, JSON.stringify(b.bag_left), b.carry_used, b.host_drawn, b.seeded]);
  await st.book.flush();
}

/* ---------------- close + settle ---------------- */
/**
 * Close a board (full at 400, or stalled) and settle it in the published order:
 *   1) Big Sends drawn are paid in full (host seeds any shortfall)
 *   2) Double Ups: unlocked amounts stand; the rest is paid from what's left, scaled down if short
 *   3) Host Tip (if drawn) from what's left, up to 5 tips
 *   4) Carryover = leftover + 5 tips per undrawn Big Send (host-funded) -> next board's first Big Send
 * Then each player's balance from this board is paid out (default) or carried (opt-out), credit carried
 * INTO this board that's still unused is paid out, board n+1 opens, and its Early Access picks are played.
 */
async function closeBoard(st, reason) {
  const { c, b, book } = st;
  await writeState(st);
  const M = r2(b.plays * b.stake + b.carry_in);
  const bigs = st.wins.filter(w => w.kind === 'big');
  const dbl = st.wins.filter(w => w.kind === 'double').sort((x, y) => x.play_no - y.play_no);
  const settle = (w, d, sc) => {
    if (d <= 0.001) return;
    book.post(w.player_id, 'settle', d, { bucket: `board:${b.id}`, board_id: b.id, square: w.idx,
      note: `Settled at close · ${PRIZE[w.kind]} #${w.idx + 1} · ${label(b.stake, b.n)}${sc}` });
  };
  for (const w of bigs) { const d = r2(w.amount - w.unlocked); w.unlocked = w.amount; settle(w, d, ''); }
  const bigPaid = r2(bigs.reduce((a, w) => a + w.amount, 0));
  const U = dbl.reduce((a, w) => a + w.unlocked, 0), R = dbl.reduce((a, w) => a + (w.amount - w.unlocked), 0);
  const pool = M - bigPaid - U;
  const scale = R > 0 ? Math.max(0, Math.min(1, pool / R)) : 1;
  const sc = scale < 1 ? ` (Double Ups scaled ${Math.round(scale * 100)}%)` : '';
  for (const w of dbl) { const fin = r2(w.unlocked + (w.amount - w.unlocked) * scale); settle(w, r2(fin - w.unlocked), sc); w.unlocked = fin; }
  const dblPaid = r2(dbl.reduce((a, w) => a + w.unlocked, 0));
  const hostPaid = b.host_drawn ? r2(Math.max(0, Math.min(5 * b.stake, M - bigPaid - dblPaid))) : 0;
  const seeded = r2(Math.max(0, bigPaid + dblPaid + hostPaid - M));
  const leftover = r2(Math.max(0, M - bigPaid - dblPaid - hostPaid));
  const undrawnBig = b.bag_left.big;
  const carryOut = r2(leftover + undrawnBig * 5 * b.stake);
  for (const w of st.wins) { w.final = true; st.dirty.add(w); }

  const { rows: playedRows } = await c.query('SELECT idx FROM plays WHERE board_id = $1', [b.id]);
  const played = new Set(playedRows.map(r => r.idx));
  const empties = []; for (let i = 0; i < GRID; i++) if (!played.has(i)) empties.push(i);
  const unselected = unselectedSpots(st.salt, empties, b.bag_left);
  const { rows: names } = bigs.length ? await c.query(
    'SELECT id, handle, handle_kind, x_user_id FROM players WHERE id = ANY($1::bigint[])', [bigs.map(w => w.player_id)]) : { rows: [] };
  const nameOf = id => { const p = names.find(x => Number(x.id) === id); return p ? displayName(p) : ''; };

  await writeState(st); // settle rows + final flags
  const summary = {
    reason, plays: b.plays, tipsIn: r2(b.plays * b.stake), carryIn: b.carry_in, M,
    bigs: bigs.map(w => ({ name: nameOf(w.player_id), amount: w.amount, i: w.idx })), bigPaid,
    dblCount: dbl.length, dblPaid, scale: Math.round(scale * 10000) / 10000,
    hostDrawn: b.host_drawn, hostPaid, seeded, leftover, undrawnBig, carryOut, unselected,
  };
  const reveal = { salt: st.salt.toString('hex'), order: st.order.map(k => LETTER[KINDS[k]]).join('') };
  await c.query(
    `UPDATE boards SET status = 'closed', closed_at = now(), reason = $2, summary = $3, reveal = $4 WHERE id = $1`,
    [b.id, reason, JSON.stringify(summary), JSON.stringify(reveal)]);
  const next = normBoard(await insertBoard(c, b.stake, b.n + 1, carryOut));
  next.seeded = 0;

  // wallets: unused carried credit pays out; this board's balance pays out (default) or carries (opt-out)
  const { rows: bal } = await c.query(
    `SELECT l.player_id, l.bucket, sum(l.amount) AS amt, p.keep_balance
       FROM ledger l JOIN players p ON p.id = l.player_id
      WHERE l.bucket = ANY($1::text[]) GROUP BY l.player_id, l.bucket, p.keep_balance
     HAVING sum(l.amount) > 0 ORDER BY l.player_id`, [[`board:${b.id}`, `carry:${b.id}`]]);
  const kept = [];
  for (const r of bal) {
    const pid = Number(r.player_id), amt = money(r.amt);
    if (r.bucket === `carry:${b.id}`) {
      book.post(pid, 'payout', -amt, { bucket: r.bucket, board_id: b.id, note: `Carried credit unused at close · ${label(b.stake, b.n)} · would be sent via X Money within 16 h` });
      book.payout(pid, 'carry_unused', amt, b.id);
    } else if (r.keep_balance) {
      book.post(pid, 'carry', -amt, { bucket: r.bucket, board_id: b.id, note: `Kept in play → ${label(b.stake, next.n)}` });
      book.post(pid, 'carry', amt, { bucket: `carry:${next.id}`, board_id: next.id, note: `Replay credit on ${label(b.stake, next.n)} · auto-pays when it closes if unused` });
      kept.push(pid);
    } else {
      book.post(pid, 'payout', -amt, { bucket: r.bucket, board_id: b.id, note: `Auto payout at close · ${label(b.stake, b.n)} · would be sent via X Money within 16 h` });
      book.payout(pid, 'close', amt, b.id);
    }
  }
  await book.flush();
  if (kept.length) await c.query('UPDATE players SET keep_balance = false WHERE id = ANY($1::bigint[])', [kept]); // opt-out covers one close
  await c.query(`UPDATE players SET boards_played = boards_played + 1
                  WHERE id IN (SELECT DISTINCT player_id FROM plays WHERE board_id = $1)`, [b.id]);
  // holds on the closed board, and unpaid Early Access holds for the board that just opened, are released
  await c.query(`DELETE FROM holds WHERE stake = $1 AND ((NOT early AND board_n = $2) OR (early AND board_n = $3))`, [b.stake, b.n, next.n]);

  // Early Access: paid pre-picks are played first, in square order, drawn from the new board's full bag
  const { rows: pre } = await c.query(
    `SELECT pp.idx, pp.player_id, p.handle, p.handle_kind, p.x_user_id, p.id
       FROM prepicks pp JOIN players p ON p.id = pp.player_id
      WHERE pp.stake = $1 AND pp.board_n = $2 AND NOT pp.played ORDER BY pp.idx`, [b.stake, next.n]);
  let earlyPlayed = 0;
  if (pre.length) {
    const st2 = await loadState(c, next, book);
    for (const r of pre) {
      const pid = Number(r.player_id), kind = playSquare(st2, r.idx, { id: pid, name: displayName(r) }, 'early');
      book.post(pid, 'preplay', 0, { board_id: next.id, square: r.idx, note: `Early Access pick played · ${PRIZE[kind]}` });
    }
    await writeState(st2);
    await c.query('UPDATE prepicks SET played = true WHERE stake = $1 AND board_n = $2', [b.stake, next.n]);
    earlyPlayed = pre.length;
  }
  return { board: { id: b.id, stake: b.stake, n: b.n }, summary, next: { id: next.id, n: next.n, carryIn: carryOut, earlyPlayed } };
}

/* ---------------- wallet helpers ---------------- */
async function walletBuckets(c, playerId) {
  await c.query('SELECT 1 FROM wallets WHERE player_id = $1 FOR UPDATE', [playerId]);
  const { rows } = await c.query(
    `SELECT bucket, sum(amount) AS amt FROM ledger WHERE player_id = $1 AND bucket IS NOT NULL
      GROUP BY bucket HAVING sum(amount) > 0`, [playerId]);
  // carried credit is spent first (it expires soonest), then the rest oldest first
  return rows.map(r => ({ bucket: r.bucket, amt: money(r.amt) }))
    .sort((x, y) => (y.bucket.startsWith('carry:') - x.bucket.startsWith('carry:')) || (Number(x.bucket.split(':')[1]) - Number(y.bucket.split(':')[1])));
}
function takeFrom(buckets, amount) {
  const out = []; let left = amount;
  for (const k of buckets) {
    if (left <= 0) break;
    const t = r2(Math.min(left, k.amt)); if (t <= 0) continue;
    k.amt = r2(k.amt - t); left = r2(left - t); out.push({ bucket: k.bucket, amt: t });
  }
  return out;
}

const hasLive = (c, playerId) => c.query('SELECT id FROM holds WHERE player_id = $1 AND expires_at > now()', [playerId]);
const holdCode = () => { const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; for (let i = 0; i < 3; i++) s += A[randomInt(A.length)]; return 'GROK-' + s; };

function parseSquares(squares) {
  if (!Array.isArray(squares) || !squares.length) fail(400, 'Pick at least one square.');
  if (squares.length > MAX_SQUARES_PER_HOLD) fail(400, `Up to ${MAX_SQUARES_PER_HOLD} squares per hold.`);
  const out = [...new Set(squares)];
  if (out.length !== squares.length) fail(400, 'Each square can only be picked once.');
  if (!out.every(i => Number.isInteger(i) && i >= 0 && i < GRID)) fail(400, `Squares are numbered 0-${GRID - 1} in the API (1-${GRID} on screen).`);
  return out.sort((a, b) => a - b);
}
const guardPlayer = p => {
  if (p.is_staff) fail(403, "Host and admin accounts can't play.");
  if (p.banned) fail(403, 'This account is not allowed to play.');
};
const pub = id => ({ id: Number(id) });

/* ---------------- actions ---------------- */

/** Reserve squares for HOLD_MS (5 minutes) and issue a GROK-XXX memo code.
 *  early = true holds squares on the NEXT board (Early Access, needs 10+ plays on the open board). */
export async function createHold(pool, player, { stake, squares, early = false }) {
  guardPlayer(player);
  const sq = parseSquares(squares);
  return tx(pool, async c => {
    const book = new Book(c);
    const { b, closed } = await lockOpenBoard(c, stake, book);
    await c.query('DELETE FROM holds WHERE expires_at <= now()');
    if ((await hasLive(c, player.id)).rows.length) fail(409, 'Finish or cancel your current hold first.');
    const cap = capFor(player.boards_played);
    const { rows: [{ mine }] } = await c.query('SELECT count(*)::int AS mine FROM plays WHERE board_id = $1 AND player_id = $2', [b.id, player.id]);
    const n = early ? b.n + 1 : b.n;
    if (!early) {
      const { rows: taken } = await c.query('SELECT idx FROM plays WHERE board_id = $1 AND idx = ANY($2::smallint[])', [b.id, sq]);
      if (taken.length) fail(409, 'Already played: ' + taken.map(r => '#' + (r.idx + 1)).join(', '), { taken: taken.map(r => r.idx) });
      if (mine + sq.length > cap) fail(409, `You can pick ${Math.max(0, cap - mine)} more on this board (cap ${cap}).`, { roomLeft: Math.max(0, cap - mine) });
      const { rows: [{ held }] } = await c.query('SELECT count(*)::int AS held FROM hold_squares WHERE stake = $1 AND board_n = $2', [stake, n]);
      const room = CLOSE_AT - b.plays - held;
      if (sq.length > room) fail(409, `Only ${Math.max(0, room)} square${room === 1 ? '' : 's'} left to play on this board right now.`, { boardRoom: Math.max(0, room) });
    } else {
      if (mine < EA_AT) fail(403, `Play ${EA_AT}+ squares on ${label(stake, b.n)} for Early Access (you have ${mine}).`);
      const { rows: taken } = await c.query('SELECT idx FROM prepicks WHERE stake = $1 AND board_n = $2 AND idx = ANY($3::smallint[])', [stake, n, sq]);
      if (taken.length) fail(409, 'Already pre-picked: ' + taken.map(r => '#' + (r.idx + 1)).join(', '), { taken: taken.map(r => r.idx) });
      const { rows: [{ minePre, allPre }] } = await c.query(
        `SELECT count(*) FILTER (WHERE player_id = $3)::int AS "minePre", count(*)::int AS "allPre" FROM prepicks WHERE stake = $1 AND board_n = $2`, [stake, n, player.id]);
      if (minePre + sq.length > cap) fail(409, `You can pre-pick ${Math.max(0, cap - minePre)} more on ${label(stake, n)} (cap ${cap}).`);
      const { rows: [{ held }] } = await c.query('SELECT count(*)::int AS held FROM hold_squares WHERE stake = $1 AND board_n = $2', [stake, n]);
      if (allPre + held + sq.length > PREPICK_MAX) fail(409, `Early Access for ${label(stake, n)} is full right now.`);
    }
    let code, hold;
    for (let t = 0; t < 8 && !hold; t++) {
      code = holdCode();
      const { rows } = await c.query(
        `INSERT INTO holds (player_id, stake, board_n, early, squares, code, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))
         ON CONFLICT (code) DO NOTHING RETURNING id, expires_at`, [player.id, stake, n, early, sq, code, HOLD_MS / 1000]);
      hold = rows[0];
    }
    if (!hold) fail(503, 'Could not issue a memo code, try again.');
    const { rows: got } = await c.query(
      `INSERT INTO hold_squares (stake, board_n, idx, hold_id, expires_at)
       SELECT $1, $2, i, $3, $4 FROM unnest($5::smallint[]) AS i ON CONFLICT DO NOTHING RETURNING idx`,
      [stake, n, hold.id, hold.expires_at, sq]);
    if (got.length !== sq.length) {
      const busy = sq.filter(i => !got.some(r => r.idx === i));
      fail(409, 'Someone else is holding: ' + busy.map(i => '#' + (i + 1)).join(', '), { held: busy });
    }
    await book.flush();
    return {
      hold: { id: Number(hold.id), code, stake, n, early, squares: sq, amount: sq.length * stake,
        expiresAt: new Date(hold.expires_at).toISOString(), holdMinutes: HOLD_MS / 60e3 },
      closedBoard: closed,
    };
  });
}

export async function cancelHold(pool, player) {
  const { rowCount } = await pool.query('DELETE FROM holds WHERE player_id = $1', [player.id]);
  return { cancelled: rowCount > 0 };
}

/** Pay the current hold. method 'xmoney_sim' (simulated X Money tip) or 'wallet' (a Replay from
 *  unlocked winnings). Squares are drawn in square-number order. Play 400 closes the board. */
export async function payHold(pool, player, { method }) {
  guardPlayer(player);
  if (!['xmoney_sim', 'wallet'].includes(method)) fail(400, "method must be 'xmoney_sim' or 'wallet'");
  return tx(pool, async c => {
    const book = new Book(c);
    const { rows: [h0] } = await c.query('SELECT stake FROM holds WHERE player_id = $1', [player.id]);
    if (!h0) fail(404, 'No hold to pay. Pick squares first.');
    const { b, closed: stalled } = await lockOpenBoard(c, h0.stake, book);
    const { rows: [h] } = await c.query(
      'SELECT *, expires_at <= now() AS expired FROM holds WHERE player_id = $1 FOR UPDATE', [player.id]);
    const release = async (status, message) => {
      if (h) await c.query('DELETE FROM holds WHERE id = $1', [h.id]);
      await book.flush();
      return { error: { status, message }, closedBoard: stalled };
    };
    if (!h) return release(409, 'That board closed, so your hold was released.');
    if (h.expired) return release(410, 'Your 5-minute hold expired, so the squares went back on the board.');
    const stake = h.stake, sq = h.squares.map(Number).sort((x, y) => x - y);
    if (h.early ? h.board_n !== b.n + 1 : h.board_n !== b.n) return release(409, 'That board already opened or closed, so your hold was released.');
    const amount = sq.length * stake, cap = capFor(player.boards_played);
    const name = displayName(player), kindPay = h.early ? 'prepay' : (method === 'wallet' ? 'replay' : 'play');
    let slices = null;
    if (method === 'wallet') {
      const buckets = await walletBuckets(c, player.id);
      const have = r2(buckets.reduce((a, k) => a + k.amt, 0));
      if (have < amount) fail(402, `Not enough unlocked in your wallet (${fmt(have)} of ${fmt(amount)}).`);
      slices = sq.map(() => takeFrom(buckets, stake));
    }
    const pay = (i, idx, note, boardId) => {
      if (slices) for (const s of slices[i]) book.post(player.id, kindPay, -s.amt, { bucket: s.bucket, board_id: boardId, square: idx, note: `${note} · paid from wallet`, ref: `hold:${h.id}:${idx}:${s.bucket}` });
      else book.post(player.id, kindPay, -stake, { board_id: boardId, square: idx, note: `${note} · X Money (simulated) · ${h.code}`, ref: `hold:${h.id}:${idx}` });
    };
    if (h.early) {
      const { rows: [{ minePre }] } = await c.query('SELECT count(*)::int AS "minePre" FROM prepicks WHERE stake = $1 AND board_n = $2 AND player_id = $3', [stake, h.board_n, player.id]);
      if (minePre + sq.length > cap) return release(409, `Over your cap of ${cap} on ${label(stake, h.board_n)}; hold released.`);
      await c.query(`INSERT INTO prepicks (stake, board_n, idx, player_id, via, code)
                     SELECT $1, $2, i, $3, $4, $5 FROM unnest($6::smallint[]) AS i`, [stake, h.board_n, player.id, method, h.code, sq]);
      sq.forEach((idx, i) => pay(i, idx, `Early Access pick · ${label(stake, h.board_n)} · plays when it opens`, null));
      await c.query('DELETE FROM holds WHERE id = $1', [h.id]);
      await book.flush();
      return { early: true, stake, n: h.board_n, squares: sq, amount, closedBoard: stalled };
    }
    const { rows: [{ mine }] } = await c.query('SELECT count(*)::int AS mine FROM plays WHERE board_id = $1 AND player_id = $2', [b.id, player.id]);
    if (mine + sq.length > cap) return release(409, `Over your cap of ${cap} on this board; hold released.`);
    if (b.plays + sq.length > CLOSE_AT) return release(409, 'Not enough squares left to play on this board; hold released.');
    const st = await loadState(c, b, book);
    const results = sq.map((idx, i) => {
      const p = playSquare(st, idx, { id: player.id, name }, method === 'wallet' ? 'wallet' : 'xmoney_sim');
      pay(i, idx, PRIZE[p], b.id);
      const w = (p === 'double' || p === 'big') ? st.wins.find(x => x.play_no === st.b.plays) : null;
      return { i: idx, k: st.b.plays, p, amount: w ? w.amount : 0 };
    });
    await c.query('DELETE FROM holds WHERE id = $1', [h.id]);
    await writeState(st);
    let closedBoard = stalled;
    if (st.b.plays >= CLOSE_AT) closedBoard = await closeBoard(st, 'full');
    return { results, amount, method, board: { id: b.id, stake, n: b.n, plays: st.b.plays }, closedBoard };
  });
}

/** Cash out every unlocked dollar (would be sent via X Money within 16 hours; nothing is sent in the beta). */
export async function cashOut(pool, player) {
  return tx(pool, async c => {
    const book = new Book(c);
    const buckets = await walletBuckets(c, player.id);
    const total = r2(buckets.reduce((a, k) => a + k.amt, 0));
    if (total <= 0) fail(400, 'Nothing unlocked to cash out.');
    for (const k of buckets) book.post(player.id, 'cashout', -k.amt, { bucket: k.bucket, note: 'Cash-out · would be sent via X Money within 16 h' });
    book.payout(player.id, 'cashout', total, null);
    await book.flush();
    const { rows: [p] } = await c.query(`SELECT send_by FROM payouts WHERE player_id = $1 AND kind = 'cashout' ORDER BY id DESC LIMIT 1`, [player.id]);
    return { amount: total, sendBy: new Date(p.send_by).toISOString() };
  });
}

/** "Keep my balance in play" opt-out: carry this board's balance to the next board at its close. */
export async function setKeep(pool, player, on) {
  const { rows: [p] } = await pool.query(
    'UPDATE players SET keep_balance = $2, keep_set_at = now() WHERE id = $1 RETURNING keep_balance', [player.id, !!on]);
  return { keepBalance: p.keep_balance };
}

/** Backstop: apply the stall rule and clear expired holds on every live board. Idempotent. */
export async function tick(pool) {
  const out = [];
  for (const stake of LIVE_STAKES) {
    const r = await tx(pool, async c => {
      const book = new Book(c);
      const { b, closed } = await lockOpenBoard(c, stake, book);
      await book.flush();
      return { stake, open: b.n, closed: closed ? closed.board.n : null };
    });
    out.push(r);
  }
  const { rowCount } = await pool.query('DELETE FROM holds WHERE expires_at <= now()');
  return { boards: out, expiredHoldsCleared: rowCount };
}

/** Cheap pre-check for the public feed: only takes the board lock if the stall clock has run out. */
export async function stallCheck(pool, stake) {
  const { rows } = await pool.query(
    `SELECT 1 FROM boards WHERE stake = $1 AND status = 'open' AND now() >= stall_from + make_interval(secs => $2)`, [stake, STALL_MS / 1000]);
  if (!rows.length) return null;
  return tx(pool, async c => { const book = new Book(c); const { closed } = await lockOpenBoard(c, stake, book); await book.flush(); return closed; });
}

export const _internals = { milestone, playSquare, takeFrom, parseSquares, pub };

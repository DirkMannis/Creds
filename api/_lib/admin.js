// Admin operations (behind ADMIN_KEY; see api/admin/[action].js). Each one runs in a transaction that
// locks the open board first, exactly like player actions, so they can't race a play or a close.
import { tx, money } from './db.js';
import { lockOpenBoard, stallCheck, _core } from './engine.js';
import { insertBoard } from './board.js';
import { LETTER, KINDS } from './bag.js';
import { LIVE_STAKES, STALL_MS, BETA, ADMIN_TOPUP_MAX, HOUR } from './config.js';

const { Book, loadState, closeBoard, afterClose, normBoard, fail, label } = _core;
const r2 = v => Math.round(v * 100) / 100;
const liveStake = s => { const v = Number(s); if (!LIVE_STAKES.includes(v)) fail(400, `stake must be one of ${LIVE_STAKES.join(', ')}`); return v; };

/** Force-close the open board now (reason 'admin'); settles exactly like a full/stall close. */
export async function forceClose(pool, { stake }) {
  const s = liveStake(stake);
  return tx(pool, async c => {
    const book = new Book(c);
    const { b } = await lockOpenBoard(c, s, book);
    if (b.plays === 0) fail(409, `${label(s, b.n)} has no plays yet; nothing to close.`);
    const r = await closeBoard(await loadState(c, b, book), 'admin');
    return { closed: r.board.n, next: r.next.n, carryOut: r.summary.carryOut, earlyPlayed: r.next.earlyPlayed };
  });
}

/** Stall fast-forward: move the open board's 5-day stall clock forward by `hours` (default: make it due now),
 *  then run the normal stall check (closes it if due and it has plays; an empty board just restarts its clock). */
export async function stallForward(pool, { stake, hours }) {
  const s = liveStake(stake);
  const h = hours === undefined || hours === null ? null : Number(hours);
  if (h !== null && !(h > 0 && h <= 24 * 30)) fail(400, 'hours must be between 0 and 720');
  const { rows: [b] } = await pool.query(
    `UPDATE boards SET stall_from = ${h === null ? `now() - make_interval(secs => $2)` : `stall_from - make_interval(secs => $2)`}
      WHERE stake = $1 AND status = 'open' RETURNING n, stall_from`, [s, h === null ? STALL_MS / 1000 : h * HOUR / 1000]);
  if (!b) fail(404, 'No open board');
  const closed = await stallCheck(pool, s);
  return { board: b.n, stallAt: new Date(new Date(b.stall_from).getTime() + STALL_MS).toISOString(), closed: closed ? closed.board.n : null };
}

/** Credit top-up (play money) into a human player's wallet, 'dev' bucket. */
export async function credit(pool, { playerId, amount }) {
  const pid = Number(playerId), amt = r2(Number(amount));
  if (!Number.isSafeInteger(pid) || pid < 1) fail(400, 'playerId must be a player id');
  if (!(amt > 0 && amt <= ADMIN_TOPUP_MAX)) fail(400, `amount must be between $0.01 and $${ADMIN_TOPUP_MAX}`);
  return tx(pool, async c => {
    const { rows: [p] } = await c.query('SELECT id, is_bot, is_staff FROM players WHERE id = $1', [pid]);
    if (!p) fail(404, 'No such player');
    if (p.is_bot || p.is_staff) fail(409, 'Bots and staff accounts can’t be topped up.');
    const book = new Book(c);
    book.post(pid, 'dev_topup', amt, { bucket: 'dev', note: `Beta credit top-up (admin) · play money` });
    await book.flush();
    const { rows: [w] } = await c.query('SELECT unlocked FROM wallets WHERE player_id = $1', [pid]);
    return { playerId: pid, credited: amt, wallet: money(w.unlocked) };
  });
}

/**
 * Reset a board (beta only): voids the open board. Every human gets their plays refunded as wallet
 * credit ('adjust', dev bucket), unlocked winnings on it are voided, bot balances are voided, credit carried
 * INTO it moves to the next board, and the next board opens with the same carryover. The commitment is
 * still revealed so the draws stay verifiable. Boards played counts don't change.
 */
export async function resetBoard(pool, { stake, confirm }) {
  if (!BETA) fail(404, 'Reset is beta-only');
  const s = liveStake(stake);
  if (confirm !== 'RESET') fail(400, 'Send confirm: "RESET" to reset a board.');
  return tx(pool, async c => {
    const book = new Book(c);
    const { b } = await lockOpenBoard(c, s, book);
    const st = await loadState(c, b, book);
    const { rows: plays } = await c.query(
      `SELECT p.player_id, count(*)::int AS n FROM plays p JOIN players pl ON pl.id = p.player_id
        WHERE p.board_id = $1 AND NOT pl.is_bot GROUP BY p.player_id ORDER BY p.player_id`, [b.id]);
    const { rows: bal } = await c.query(
      `SELECT player_id, bucket, sum(amount) AS amt FROM
         (SELECT player_id, bucket, amount FROM ledger WHERE bucket = ANY($1::text[])
          UNION ALL SELECT player_id, bucket, amount FROM bot_ledger WHERE bucket = ANY($1::text[])) l
        GROUP BY player_id, bucket HAVING sum(amount) <> 0 ORDER BY player_id`, [[`board:${b.id}`, `carry:${b.id}`]]);
    await c.query(`UPDATE boards SET status = 'closed', closed_at = now(), reason = 'reset' WHERE id = $1`, [b.id]);
    const next = normBoard(await insertBoardAfter(c, b));
    // 1) refunds
    let refunded = 0;
    for (const r of plays) {
      const amt = r2(r.n * b.stake); refunded = r2(refunded + amt);
      book.post(Number(r.player_id), 'adjust', amt, { bucket: 'dev', board_id: b.id, note: `Refund: ${label(s, b.n)} was reset (beta) · ${r.n} play${r.n === 1 ? '' : 's'}` });
    }
    // 2) void this board's balances (unlocks) and move carried-in credit to the next board
    let voided = 0, carried = 0;
    for (const r of bal) {
      const pid = Number(r.player_id), amt = money(r.amt);
      if (r.bucket === `carry:${b.id}`) {
        carried = r2(carried + amt);
        book.post(pid, 'carry', -amt, { bucket: r.bucket, board_id: b.id, note: `${label(s, b.n)} was reset · credit moves → ${label(s, next.n)}` });
        book.post(pid, 'carry', amt, { bucket: `carry:${next.id}`, board_id: next.id, note: `Replay credit on ${label(s, next.n)} · auto-pays when it closes if unused` });
      } else {
        voided = r2(voided + amt);
        book.post(pid, 'adjust', -amt, { bucket: r.bucket, board_id: b.id, note: `Voided: ${label(s, b.n)} was reset (beta)` });
      }
    }
    await book.flush();
    await c.query('UPDATE wins SET final = true WHERE board_id = $1', [b.id]);
    const summary = {
      reason: 'reset', voided: true, plays: b.plays, tipsIn: r2(b.plays * b.stake), carryIn: b.carry_in, M: r2(b.plays * b.stake + b.carry_in),
      refunded, voidedUnlocks: voided, carriedMoved: carried,
      bigs: [], bigPaid: 0, dblCount: 0, dblPaid: 0, scale: 1, hostDrawn: false, hostPaid: 0, seeded: 0, leftover: 0,
      undrawnBig: b.bag_left.big, carryOut: b.carry_in, unselected: [],
    };
    const reveal = { salt: st.salt.toString('hex'), order: st.order.map(k => LETTER[KINDS[k]]).join('') };
    await c.query(`UPDATE boards SET summary = $2, reveal = $3 WHERE id = $1`,
      [b.id, JSON.stringify(summary), JSON.stringify(reveal)]);
    const earlyPlayed = await afterClose(c, b, next, book);
    return { reset: b.n, plays: b.plays, refunded, voided, carriedMoved: carried, next: next.n, earlyPlayed };
  });
}
// next board opens with the same carryover the reset board had (nothing was settled)
const insertBoardAfter = (c, b) => insertBoard(c, b.stake, b.n + 1, b.carry_in);

/** Read-only status for the dev panel. */
export async function adminStatus(pool) {
  const [{ rows: boards }, { rows: audit }, { rows: [bots] }] = await Promise.all([
    pool.query(`SELECT stake, n, plays, opened_at, stall_from, bots_at FROM boards WHERE status = 'open' ORDER BY stake`),
    pool.query(`SELECT at, action, args FROM admin_audit ORDER BY id DESC LIMIT 15`),
    pool.query(`SELECT count(*)::int AS n FROM players WHERE is_bot`),
  ]);
  return {
    boards: boards.map(b => ({ stake: b.stake, n: b.n, plays: b.plays, openedAt: b.opened_at, stallAt: new Date(new Date(b.stall_from).getTime() + STALL_MS).toISOString(), botsAt: b.bots_at })),
    audit: audit.map(a => ({ at: a.at, action: a.action, args: a.args })),
    botPlayers: bots.n,
  };
}

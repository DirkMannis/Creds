// Player history: a read-only view over the append-only ledger (newest first).
// JSON pages are keyset-paginated by ledger id; CSV is capped at HISTORY_CSV_MAX rows (newest).
import { money } from './db.js';

export const HISTORY_PAGE_DEFAULT = 50, HISTORY_PAGE_MAX = 200, HISTORY_CSV_MAX = 5000;

const EVENT = {
  play: 'Play', replay: 'Replay', prepay: 'Early Access pick', preplay: 'Early Access pick played',
  win: 'Win drawn', unlock: 'Unlocked', settle: 'Settled at close', cashout: 'Cash-out',
  dev_topup: 'DEV top-up', adjust: 'Adjustment',
};
function eventOf(r) {
  if (r.kind === 'carry') return Number(r.amount) < 0 ? 'Kept in play' : 'Carried to next board';
  if (r.kind === 'payout') return /^Carried credit unused/.test(r.note || '') ? 'Payout · carried credit unused' : 'Payout at close';
  return EVENT[r.kind] || r.kind;
}

function row(r) {
  const amount = money(r.amount);
  const m = r.kind === 'win' && /\$([\d.]+) pending/.exec(r.note || '');
  return {
    id: Number(r.id), at: new Date(r.at).toISOString(), kind: r.kind, event: eventOf(r),
    board: r.board_id ? { id: Number(r.board_id), stake: r.stake, n: r.n, label: `$${r.stake} #${r.n}` } : null,
    square: r.square === null || r.square === undefined ? null : r.square + 1,   // 1-500 display number
    amount, pending: m ? Number(m[1]) : 0,
    bucket: r.bucket ? r.bucket.split(':')[0] : null,                          // 'board' | 'carry' | 'dev' | null (external)
    note: r.note || '',
  };
}

const SELECT = `SELECT l.id, l.at, l.kind, l.bucket, l.board_id, l.square, l.amount, l.note, b.stake, b.n
                  FROM ledger l LEFT JOIN boards b ON b.id = l.board_id`;

/** One page, newest first. before = ledger id cursor (exclusive). boardId filters to one board. */
export async function historyPage(q, playerId, { limit = HISTORY_PAGE_DEFAULT, before = null, boardId = null } = {}) {
  limit = Math.max(1, Math.min(HISTORY_PAGE_MAX, Math.floor(limit) || HISTORY_PAGE_DEFAULT));
  const args = [playerId, limit + 1];
  let where = 'l.player_id = $1';
  if (before) { args.push(before); where += ` AND l.id < $${args.length}`; }
  if (boardId) { args.push(boardId); where += ` AND l.board_id = $${args.length}`; }
  const [{ rows }, { rows: [t] }] = await Promise.all([
    q.query(`${SELECT} WHERE ${where} ORDER BY l.id DESC LIMIT $2`, args),
    q.query('SELECT count(*)::int AS n FROM ledger WHERE player_id = $1', [playerId]),
  ]);
  const more = rows.length > limit;
  const entries = rows.slice(0, limit).map(row);
  return { total: t.n, entries, nextBefore: more ? entries[entries.length - 1].id : null };
}

const csvCell = v => { v = String(v ?? ''); if (/^[=+\-@\t\r]/.test(v) && !/^-?\d/.test(v)) v = "'" + v; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };

/** CSV of the newest HISTORY_CSV_MAX entries (no lifetime columns). */
export async function historyCsv(q, playerId) {
  const { rows } = await q.query(`${SELECT} WHERE l.player_id = $1 ORDER BY l.id DESC LIMIT $2`, [playerId, HISTORY_CSV_MAX + 1]);
  const capped = rows.length > HISTORY_CSV_MAX;
  const lines = [['time_utc', 'board', 'square', 'event', 'amount', 'pending', 'note']];
  for (const r of rows.slice(0, HISTORY_CSV_MAX).map(row))
    lines.push([r.at, r.board ? r.board.label : '', r.square ?? '', r.event, r.amount.toFixed(2), r.pending ? r.pending.toFixed(2) : '', r.note]);
  return { csv: lines.map(l => l.map(csvCell).join(',')).join('\n') + '\n', rows: lines.length - 1, capped };
}

// Wallet summary for the token's player.
import { money } from './db.js';
import { capFor, LIVE_STAKES, EA_AT } from './config.js';
import { displayName } from './board.js';

export async function meSummary(q, player) {
  const [wallet, buckets, pending, boards, hold, prepicks, hist, payouts, wins] = await Promise.all([
    q.query('SELECT unlocked FROM wallets WHERE player_id = $1', [player.id]),
    q.query(`SELECT bucket, sum(amount) AS amt FROM ledger
              WHERE player_id = $1 AND bucket IS NOT NULL GROUP BY bucket HAVING sum(amount) > 0 ORDER BY bucket`, [player.id]),
    q.query(`SELECT coalesce(sum(amount - unlocked), 0) AS pending, count(*) AS n FROM wins
              WHERE player_id = $1 AND NOT final`, [player.id]),
    q.query(`SELECT b.stake, b.n, b.id, coalesce(array_agg(p.idx ORDER BY p.idx) FILTER (WHERE p.idx IS NOT NULL), '{}') AS squares
               FROM boards b LEFT JOIN plays p ON p.board_id = b.id AND p.player_id = $1
              WHERE b.status = 'open' AND b.stake = ANY($2::int[]) GROUP BY b.stake, b.n, b.id`, [player.id, LIVE_STAKES]),
    q.query(`SELECT stake, board_n, early, squares, code, expires_at FROM holds
              WHERE player_id = $1 AND expires_at > now()`, [player.id]),
    q.query(`SELECT stake, board_n, count(*) AS n, array_agg(idx ORDER BY idx) AS squares FROM prepicks
              WHERE player_id = $1 AND NOT played GROUP BY stake, board_n ORDER BY stake, board_n`, [player.id]),
    q.query('SELECT count(*) AS n FROM ledger WHERE player_id = $1', [player.id]),
    q.query(`SELECT id, at, kind, board_id, amount, send_by, status, now() >= send_by AS due FROM payouts
              WHERE player_id = $1 ORDER BY id DESC LIMIT 10`, [player.id]),
    q.query(`SELECT b.stake, b.n, p.idx, w.kind, w.amount, w.unlocked FROM wins w
               JOIN boards b ON b.id = w.board_id JOIN plays p ON p.board_id = w.board_id AND p.play_no = w.play_no
              WHERE w.player_id = $1 AND b.status = 'open' ORDER BY w.board_id, w.play_no`, [player.id]),
  ]);
  const cap = capFor(player.boards_played);
  const h = hold.rows[0];
  return {
    player: {
      id: Number(player.id), name: displayName(player), handleKind: player.handle_kind || null,
      boardsPlayed: player.boards_played, cap, keepBalance: player.keep_balance,
      since: new Date(player.created_at).toISOString(),
    },
    wallet: {
      unlocked: money(wallet.rows[0] && wallet.rows[0].unlocked),
      pending: money(pending.rows[0].pending), pendingWins: Number(pending.rows[0].n),
      buckets: buckets.rows.map(r => ({ bucket: r.bucket, amount: money(r.amt) })),
      payoutDefault: 'auto payout at close unless "Keep my balance in play" is on',
    },
    boards: Object.fromEntries(boards.rows.map(r => {
      const sq = (r.squares || []).map(Number), mine = sq.length;
      return [r.stake, { n: r.n, mySquares: mine, squares: sq, roomLeft: Math.max(0, cap - mine), earlyAccessNext: mine >= EA_AT }];
    })),
    hold: h ? { stake: h.stake, n: h.board_n, early: h.early, squares: h.squares, code: h.code, expiresAt: new Date(h.expires_at).toISOString() } : null,
    prepicks: prepicks.rows.map(r => ({ stake: r.stake, n: r.board_n, count: Number(r.n), squares: (r.squares || []).map(Number) })),
    wins: wins.rows.map(r => ({ stake: r.stake, n: r.n, i: r.idx, kind: r.kind, amount: money(r.amount), unlocked: money(r.unlocked) })),
    historyEntries: Number(hist.rows[0].n),
    payouts: payouts.rows.map(r => ({ id: Number(r.id), at: new Date(r.at).toISOString(), kind: r.kind, amount: money(r.amount),
      sendBy: new Date(r.send_by).toISOString(), status: r.due && r.status === 'would_send' ? 'would_have_been_sent' : r.status })),
  };
}

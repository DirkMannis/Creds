// GET /api/boards?stake=5&before=<n>&limit=20 -> fairness index for the /fair page:
// the open board's commitment hash, plus closed boards (newest first) with their commit hash.
// Salt + draw order for a closed board come from GET /api/board/:stake?n=<n>.
import { withPool } from './_lib/db.js';
import { json, error, handle } from './_lib/http.js';
import { LIVE_STAKES, STAKES } from './_lib/config.js';

export const GET = handle('boards', async request => {
  const url = new URL(request.url);
  const stake = Number(url.searchParams.get('stake') || 5);
  if (!STAKES.some(s => s.v === stake)) return error(404, 'Unknown board');
  const before = url.searchParams.get('before'), limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 20));
  if (before !== null && !/^\d{1,6}$/.test(before)) return error(400, 'before must be a board number');
  const out = await withPool(async pool => {
    const [{ rows: open }, { rows: closed }] = await Promise.all([
      pool.query(`SELECT n, plays, opened_at, commit_hash, commit_scheme FROM boards WHERE stake = $1 AND status = 'open'`, [stake]),
      pool.query(
        `SELECT n, reason, plays, opened_at, closed_at, commit_hash FROM boards
          WHERE stake = $1 AND status = 'closed' AND ($2::int IS NULL OR n < $2) ORDER BY n DESC LIMIT $3`,
        [stake, before === null ? null : Number(before), limit + 1]),
    ]);
    const more = closed.length > limit; if (more) closed.pop();
    return {
      v: 1, stake, live: LIVE_STAKES.includes(stake),
      scheme: 'sha256:grok-tip-board/v1|stake|n|salt_hex|order_letters',
      open: open.map(b => ({ n: b.n, label: `$${stake} Board #${b.n}`, plays: b.plays, openedAt: new Date(b.opened_at).toISOString(), commit: b.commit_hash })),
      closed: closed.map(b => ({ n: b.n, label: `$${stake} Board #${b.n}`, reason: b.reason, plays: b.plays,
        openedAt: new Date(b.opened_at).toISOString(), closedAt: new Date(b.closed_at).toISOString(), commit: b.commit_hash })),
      nextBefore: more ? closed[closed.length - 1].n : null,
    };
  });
  return json(out, { cache: 'public, max-age=0, s-maxage=10' });
});

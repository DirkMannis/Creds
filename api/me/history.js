// GET /api/me/history  (Authorization: Bearer <token>) -> the player's full history log, newest first.
//   ?limit=50 (max 200) &before=<entry id> -> { total, entries, nextBefore }   (keyset pagination)
//   ?board=<board id>                       -> only entries for that board
//   ?format=csv                             -> CSV download of the newest 5000 entries
import { withPool } from '../_lib/db.js';
import { playerFromRequest } from '../_lib/auth.js';
import { historyPage, historyCsv, HISTORY_CSV_MAX } from '../_lib/history.js';
import { json, error, handle } from '../_lib/http.js';

const int = v => (v !== null && /^\d{1,15}$/.test(v) ? Number(v) : null);

export const GET = handle('me/history', async request => withPool(async pool => {
  const player = await playerFromRequest(pool, request);
  if (!player) return error(401, 'No session. POST /api/session first.');
  const u = new URL(request.url).searchParams;
  if (u.get('format') === 'csv') {
    const { csv, capped } = await historyCsv(pool, player.id);
    return new Response(csv, { headers: {
      'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store',
      'content-disposition': `attachment; filename="tip-board-history-${new Date().toISOString().slice(0, 10)}.csv"`,
      'x-history-capped': capped ? String(HISTORY_CSV_MAX) : 'no',
    } });
  }
  for (const k of ['limit', 'before', 'board']) if (u.get(k) !== null && int(u.get(k)) === null) return error(400, `${k} must be a number`);
  return json(await historyPage(pool, player.id, { limit: int(u.get('limit')) ?? undefined, before: int(u.get('before')), boardId: int(u.get('board')) }));
}));

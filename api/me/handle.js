// POST /api/me/handle {handle}  (Authorization: Bearer <token>) -> set a screened in-game handle.
// {handle: null} clears it (tiles show "Player 0123" again). Lookalikes of an existing handle are refused.
import { withPool } from '../_lib/db.js';
import { playerFromRequest } from '../_lib/auth.js';
import { screenHandle, normHandle } from '../_lib/names.js';
import { displayName } from '../_lib/board.js';
import { json, error, handle, readJson } from '../_lib/http.js';
import { rateLimit } from '../_lib/ratelimit.js';

export const POST = handle('me/handle', async request => withPool(async pool => {
  const player = await playerFromRequest(pool, request);
  if (!player) return error(401, 'No session. POST /api/session first.');
  const limited = await rateLimit(pool, request, player.id, 'me/handle');
  if (limited) return limited;
  const body = await readJson(request);
  if (player.handle_kind === 'x') return error(409, 'Your tiles use your X handle.');
  if (body.handle === null || body.handle === '') {
    await pool.query('UPDATE players SET handle = NULL, handle_norm = NULL, handle_kind = NULL WHERE id = $1', [player.id]);
    return json({ name: displayName({ id: player.id }), handleKind: null });
  }
  const why = screenHandle(body.handle);
  if (why) return error(400, why);
  const h = String(body.handle).trim();
  try {
    await pool.query(`UPDATE players SET handle = $2, handle_norm = $3, handle_kind = 'game' WHERE id = $1`, [player.id, h, normHandle(h)]);
  } catch (e) {
    if (e && e.code === '23505') return error(409, 'Too close to an existing player’s name. Try another.');
    throw e;
  }
  return json({ name: h, handleKind: 'game' });
}));

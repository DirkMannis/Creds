// GET /api/me  (Authorization: Bearer <token>) -> the token's wallet summary. Never cached.
import { withPool } from './_lib/db.js';
import { playerFromRequest } from './_lib/auth.js';
import { meSummary } from './_lib/me.js';
import { json, error, handle } from './_lib/http.js';

export const GET = handle('me', async request => withPool(async pool => {
  const player = await playerFromRequest(pool, request);
  if (!player) return error(401, 'No session. POST /api/session first.');
  return json(await meSummary(pool, player));
}));

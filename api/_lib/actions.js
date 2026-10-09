// Shared wrapper for authenticated player actions (POST, never cached).
import { withPool } from './db.js';
import { playerFromRequest } from './auth.js';
import { json, error, handle, readJson } from './http.js';

export function playerAction(name, fn) {
  return handle(name, async request => {
    const body = request.method === 'GET' || request.method === 'DELETE' ? {} : await readJson(request);
    return withPool(async pool => {
      const player = await playerFromRequest(pool, request);
      if (!player) return error(401, 'No session. POST /api/session first.');
      const out = await fn(pool, player, body, request);
      if (out && out.error) return json({ error: out.error.message, closedBoard: out.closedBoard || null }, { status: out.error.status });
      return json(out);
    });
  });
}

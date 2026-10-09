// Shared wrapper for authenticated player actions (POST, never cached). Writes are rate-limited
// per player and per IP (friendly 429 + Retry-After).
import { withPool } from './db.js';
import { playerFromRequest } from './auth.js';
import { json, error, handle, readJson } from './http.js';
import { rateLimit } from './ratelimit.js';

export function playerAction(name, fn) {
  return handle(name, async request => {
    const body = request.method === 'GET' || request.method === 'DELETE' ? {} : await readJson(request);
    return withPool(async pool => {
      const player = await playerFromRequest(pool, request);
      if (!player) return error(401, 'No session. POST /api/session first.');
      if (request.method !== 'GET') { const limited = await rateLimit(pool, request, player.id, name); if (limited) return limited; }
      const out = await fn(pool, player, body, request);
      if (out && out.error) return json({ error: out.error.message, closedBoard: out.closedBoard || null }, { status: out.error.status });
      return json(out);
    });
  });
}

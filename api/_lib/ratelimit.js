// Write-endpoint rate limits over the rate_events table (keys are hashed; raw IPs are never stored).
// Per player: RATE_PER_PLAYER writes per RATE_WINDOW_S; per IP: RATE_PER_IP (skipped when the IP is unknown).
import { createHash } from 'node:crypto';
import { ipKey } from './auth.js';
import { clientIp, json } from './http.js';
import { RATE_WINDOW_S, RATE_PER_PLAYER, RATE_PER_IP } from './config.js';

const playerKey = id => createHash('sha256').update('tipboard-player|' + id).digest('hex').slice(0, 32);

/** Returns null if allowed (and records the event), or a friendly 429 Response. */
export async function rateLimit(pool, request, playerId, action = 'write') {
  const ip = clientIp(request);
  const pk = playerKey(playerId), ik = ip === 'unknown' ? null : ipKey(ip);
  const { rows: [r] } = await pool.query(
    `SELECT count(*) FILTER (WHERE key = $1)::int AS p, count(*) FILTER (WHERE key = $2)::int AS i,
            ceil(extract(epoch FROM (min(at) FILTER (WHERE key = $1) + make_interval(secs => $3)) - now()))::int AS pwait,
            ceil(extract(epoch FROM (min(at) FILTER (WHERE key = $2) + make_interval(secs => $3)) - now()))::int AS iwait
       FROM rate_events WHERE action = 'write' AND key IN ($1, coalesce($2, $1)) AND at > now() - make_interval(secs => $3)`,
    [pk, ik, RATE_WINDOW_S]);
  const overP = r.p >= RATE_PER_PLAYER, overI = ik && r.i >= RATE_PER_IP;
  if (overP || overI) {
    const wait = Math.max(1, Math.min(RATE_WINDOW_S, (overP ? r.pwait : r.iwait) || RATE_WINDOW_S));
    return json({
      error: `Whoa, that’s a lot of taps. Take a breather and try again in ${wait} s.`,
      rateLimited: true, retryAfter: wait, scope: overP ? 'player' : 'ip', action,
    }, { status: 429, headers: { 'retry-after': String(wait) } });
  }
  await pool.query(`INSERT INTO rate_events (key, action) SELECT unnest($1::text[]), 'write'`, [[pk, ...(ik ? [ik] : [])]]);
  return null;
}

// POST /api/session  -> issues an anonymous device token (beta identity).
// If the request already carries a valid token, returns that player instead of minting a new one.
import { withPool, tx } from './_lib/db.js';
import { newToken, hashToken, playerFromRequest, ipKey } from './_lib/auth.js';
import { json, error, handle, clientIp } from './_lib/http.js';
import { capFor, SESSIONS_PER_IP_PER_DAY } from './_lib/config.js';
import { displayName } from './_lib/board.js';

const view = p => ({ id: Number(p.id), name: displayName(p), boardsPlayed: p.boards_played, cap: capFor(p.boards_played) });

export const POST = handle('session', async request => withPool(async pool => {
  const existing = await playerFromRequest(pool, request);
  if (existing) return json({ player: view(existing), reused: true });

  const key = ipKey(clientIp(request));
  const token = newToken();
  const player = await tx(pool, async c => {
    const { rows: [r] } = await c.query(
      `SELECT count(*) AS n FROM rate_events WHERE action = 'session' AND key = $1 AND at > now() - interval '1 day'`, [key]);
    if (Number(r.n) >= SESSIONS_PER_IP_PER_DAY) return null;
    await c.query(`INSERT INTO rate_events (key, action) VALUES ($1, 'session')`, [key]);
    const { rows: [p] } = await c.query(
      `INSERT INTO players (token_hash) VALUES ($1) RETURNING id, handle, handle_kind, boards_played`, [hashToken(token)]);
    await c.query('INSERT INTO wallets (player_id) VALUES ($1)', [p.id]);
    return p;
  });
  if (!player) return error(429, 'Too many new players from this network today. Try again tomorrow.');
  return json({ token, player: view(player), reused: false }, { status: 201 });
}));

export const GET = () => error(405, 'Use POST');

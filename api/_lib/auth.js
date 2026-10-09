// Anonymous device tokens for the beta (no recovery code; clearing the browser loses the play-money wallet).
// The browser keeps the token in localStorage and sends "Authorization: Bearer <token>".
// The database only ever stores SHA-256(token).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const newToken = () => 'tb1_' + randomBytes(32).toString('base64url'); // 256-bit
export const hashToken = token => createHash('sha256').update(String(token)).digest('hex');
const TOKEN_RE = /^tb1_[A-Za-z0-9_-]{43}$/;

export function bearer(request) {
  const m = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') || '');
  return m && TOKEN_RE.test(m[1]) ? m[1] : null;
}

/** Look up the player for this request's token (null if missing/unknown/banned). Touches last_seen_at. */
export async function playerFromRequest(q, request) {
  const token = bearer(request);
  if (!token) return null;
  const { rows } = await q.query(
    `UPDATE players SET last_seen_at = now() WHERE token_hash = $1 AND NOT banned
     RETURNING id, handle, handle_kind, x_user_id, boards_played, keep_balance, is_bot, is_staff, created_at`,
    [hashToken(token)]);
  return rows[0] || null;
}

/** Constant-time check of the x-admin-key header against ADMIN_KEY. False if ADMIN_KEY is unset. */
export function isAdmin(request) {
  const want = process.env.ADMIN_KEY, got = request.headers.get('x-admin-key');
  if (!want || want.length < 16 || !got) return false;
  const a = createHash('sha256').update(want).digest(), b = createHash('sha256').update(got).digest();
  return timingSafeEqual(a, b);
}

/** Hash an IP for rate limiting so raw IPs are never stored. */
export const ipKey = ip => createHash('sha256').update('tipboard-ip|' + ip).digest('hex').slice(0, 32);

// GET /api/cron/tick  -> daily backstop: 5-day stall rule + expired-hold cleanup (also runs lazily on every request).
// Vercel Cron sends "Authorization: Bearer <CRON_SECRET>" when CRON_SECRET is set; then it's required.
import { withPool } from '../_lib/db.js';
import { tick } from '../_lib/engine.js';
import { isAdmin } from '../_lib/auth.js';
import { json, error, handle } from '../_lib/http.js';

export const GET = handle('cron/tick', async request => {
  const secret = process.env.CRON_SECRET;
  const ok = !secret || request.headers.get('authorization') === `Bearer ${secret}` || isAdmin(request);
  if (!ok) return error(401, 'Unauthorized');
  return json(await withPool(pool => tick(pool)));
});

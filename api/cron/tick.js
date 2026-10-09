// GET /api/cron/tick  -> daily backstop: 5-day stall rule, expired-hold cleanup, bot catch-up, rate_events pruning
// (the first three also run lazily on requests).
// Vercel Cron sends "Authorization: Bearer <CRON_SECRET>" when CRON_SECRET is set; then it's required.
import { withPool } from '../_lib/db.js';
import { tick } from '../_lib/engine.js';
import { botTick } from '../_lib/bots.js';
import { isAdmin } from '../_lib/auth.js';
import { json, error, handle } from '../_lib/http.js';

export const GET = handle('cron/tick', async request => {
  const secret = process.env.CRON_SECRET;
  const ok = !secret || request.headers.get('authorization') === `Bearer ${secret}` || isAdmin(request);
  if (!ok) return error(401, 'Unauthorized');
  return json(await withPool(async pool => {
    const r = await tick(pool);
    const bots = await botTick(pool); // backstop: catch bots up even if nobody loaded the board
    const { rowCount } = await pool.query(`DELETE FROM rate_events WHERE at < now() - interval '2 days'`);
    return { ...r, botPlays: bots, rateEventsPruned: rowCount };
  }));
});

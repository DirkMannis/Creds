// Admin API (header x-admin-key: <ADMIN_KEY>, 16+ chars). Every route is a 404 unless ADMIN_KEY is set and matches.
// Every POST action writes an admin_audit row (args + result or error), whether it succeeds or not.
//   GET  /api/admin/status                       -> open boards, bot settings, recent audit rows
//   POST /api/admin/close   {stake}              -> force-close the open board now (reason 'admin')
//   POST /api/admin/stall   {stake, hours?}      -> stall fast-forward (default: make the 5-day stall due now)
//   POST /api/admin/credit  {playerId, amount}   -> play-money credit top-up (≤ $1000) for a human player
//   POST /api/admin/reset   {stake, confirm:"RESET"} -> void + refund the open board (beta only)
//   POST /api/admin/bots    {enabled?, perHour?} -> bots on/off and speed (env BOTS_ENABLED=false overrides)
// (POST /api/admin/migrate is its own file.)
import { withPool } from '../_lib/db.js';
import { isAdmin } from '../_lib/auth.js';
import { json, error, handle, readJson } from '../_lib/http.js';
import { forceClose, stallForward, credit, resetBoard, adminStatus } from '../_lib/admin.js';
import { botSettings, setBotSettings } from '../_lib/bots.js';

const ACTIONS = {
  close: (pool, a) => forceClose(pool, a),
  stall: (pool, a) => stallForward(pool, a),
  credit: (pool, a) => credit(pool, a),
  reset: (pool, a) => resetBoard(pool, a),
  bots: async (pool, a) => ({ bots: await setBotSettings(pool, a) }),
};

const actionOf = request => {
  const url = new URL(request.url);
  return url.searchParams.get('action') || url.pathname.split('/').filter(Boolean).pop();
};

export const GET = handle('admin', async request => {
  if (!isAdmin(request)) return error(404, 'Not found');
  if (actionOf(request) !== 'status') return error(404, 'Not found');
  return json(await withPool(async pool => ({ ...(await adminStatus(pool)), bots: await botSettings(pool) })));
});

export const POST = handle('admin', async request => {
  if (!isAdmin(request)) return error(404, 'Not found');
  const action = actionOf(request), run = ACTIONS[action];
  if (!run) return error(404, 'Not found');
  const args = await readJson(request);
  return withPool(async pool => {
    const audit = row => pool.query(`INSERT INTO admin_audit (actor, action, args) VALUES ('admin-key', $1, $2)`,
      [action, JSON.stringify(row)]);
    try {
      const result = await run(pool, args);
      await audit({ args, ok: true, result });
      return json({ ok: true, action, ...result });
    } catch (e) {
      const status = e && e.status && e.expose ? e.status : 500;
      await audit({ args, ok: false, error: status === 500 ? 'server error' : e.expose }).catch(() => {});
      throw e;
    }
  });
});

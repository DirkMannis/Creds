// Local dev/test server: serves index.html and routes /api/* to the real Vercel Function handlers,
// backed by local Postgres (port 55432) through the production Neon driver + the ws proxy in helpers.js.
//   node test/server.js [port]      env: TEST_DB (default tipboard_ui), KEEP_DB=1 to reuse the database
// Bots: env BOTS_ENABLED is set to true here, but the admin bot setting starts OFF (tests turn bots on
// through the admin API / dev panel). ADMIN_KEY defaults to a fixed local test key.
// Test-only routes under /__test/* poke the database directly (stall a board, set boards played).
// Never deployed: test/ is in .vercelignore.
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool } from '@neondatabase/serverless';
import { freshDb, startProxy, PG_HOST, PG_PORT } from './helpers.js';
process.env.BOTS_ENABLED = process.env.TEST_BOTS_ENV || 'true';
process.env.ADMIN_KEY ||= 'local-test-admin-key-0123456789';

const PORT = Number(process.argv[2] || process.env.PORT || 8833);
const DB = process.env.TEST_DB || 'tipboard_ui';
if (process.env.KEEP_DB) { await startProxy(); process.env.DATABASE_URL = `postgresql://postgres@${PG_HOST}:${PG_PORT}/${DB}`; }
else await freshDb(DB);
const INDEX = fileURLToPath(new URL('../index.html', import.meta.url));
const FAIR = fileURLToPath(new URL('../fair.html', import.meta.url));

const mod = async p => import(new URL(`../api/${p}`, import.meta.url));
const R = {
  'session': await mod('session.js'), 'me': await mod('me.js'), 'me/history': await mod('me/history.js'), 'me/handle': await mod('me/handle.js'),
  'hold': await mod('hold.js'), 'pay': await mod('pay.js'), 'replay': await mod('replay.js'), 'cashout': await mod('cashout.js'),
  'keep': await mod('keep.js'), 'cron/tick': await mod('cron/tick.js'), 'board': await mod('board/[stake].js'),
  'boards': await mod('boards.js'), 'admin/migrate': await mod('admin/migrate.js'), 'admin': await mod('admin/[action].js'),
};
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
{ // schema + admin bot setting OFF to start (deterministic UI tests)
  const { migrate } = await import('../api/_db/migrate.js');
  await migrate(pool);
  await pool.query(`INSERT INTO settings (key, value) VALUES ('bots', '{"enabled": false, "perHour": 60}') ON CONFLICT (key) DO NOTHING`);
}
let ipSeq = 0;

async function toRequest(req, url) {
  const chunks = []; for await (const c of req) chunks.push(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  // every new session gets its own fake client IP so many test browsers don't trip the per-IP session limit
  if (!headers.get('x-forwarded-for')) headers.set('x-forwarded-for', `10.77.${(++ipSeq >> 8) & 255}.${ipSeq & 255}`);
  return new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) || !chunks.length ? undefined : Buffer.concat(chunks) });
}
async function send(res, r) {
  const h = {}; r.headers.forEach((v, k) => { h[k] = v; });
  res.writeHead(r.status, h); res.end(Buffer.from(await r.arrayBuffer()));
}
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(fs.readFileSync(INDEX));
    }
    if (url.pathname === '/fair' || url.pathname === '/fair.html') { // vercel.json cleanUrls serves fair.html at /fair
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(fs.readFileSync(FAIR));
    }
    if (url.pathname.startsWith('/__test/')) {
      const what = url.pathname.slice(8), q = url.searchParams;
      if (what === 'stall') { // close the open board for a stake through the real 5-day stall rule
        await pool.query(`UPDATE boards SET stall_from = now() - interval '5 days 1 minute' WHERE stake = $1 AND status = 'open'`, [Number(q.get('stake'))]);
        return json(res, 200, { ok: true });
      }
      if (what === 'boardsPlayed') {
        await pool.query('UPDATE players SET boards_played = $2 WHERE id = $1', [Number(q.get('player')), Number(q.get('n'))]);
        return json(res, 200, { ok: true });
      }
      if (what === 'expireHolds') { await pool.query(`UPDATE holds SET created_at = now() - interval '10 minutes', expires_at = now() - interval '1 second'`);
        await pool.query(`UPDATE hold_squares SET expires_at = now() - interval '1 second'`); return json(res, 200, { ok: true }); }
      if (what === 'bots') { // pretend the bots have been idle for N minutes (lazy catch-up then plays them)
        await pool.query(`UPDATE boards SET bots_at = now() - make_interval(mins => $2) WHERE stake = $1 AND status = 'open'`, [Number(q.get('stake')), Number(q.get('minutes') || 60)]);
        return json(res, 200, { ok: true });
      }
      if (what === 'rateFill') { // pre-fill rate_events so the next write from this player hits the 429
        const { createHash } = await import('node:crypto');
        const k = createHash('sha256').update('tipboard-player|' + Number(q.get('player'))).digest('hex').slice(0, 32);
        await pool.query(`INSERT INTO rate_events (key, action) SELECT $1, 'write' FROM generate_series(1, $2)`, [k, Number(q.get('n') || 30)]);
        return json(res, 200, { ok: true });
      }
      if (what === 'rateClear') { await pool.query('DELETE FROM rate_events WHERE action = $1', ['write']); return json(res, 200, { ok: true }); }
      return json(res, 404, { error: 'unknown test route' });
    }
    let m;
    if ((m = /^\/api\/board\/(\d+)$/.exec(url.pathname))) { url.searchParams.set('stake', m[1]); }
    if ((m = /^\/api\/admin\/([a-z]+)$/.exec(url.pathname)) && m[1] !== 'migrate') url.searchParams.set('action', m[1]);
    const key = url.pathname.startsWith('/api/board/') ? 'board'
      : url.searchParams.has('action') ? 'admin' : url.pathname.replace(/^\/api\//, '');
    const h = R[key] && R[key][req.method];
    if (!h) return json(res, R[key] ? 405 : 404, { error: 'Not found' });
    return send(res, await h(await toRequest(req, url.href)));
  } catch (e) { console.error(e); json(res, 500, { error: 'test server error' }); }
});
server.listen(PORT, '127.0.0.1', () => console.log(`tip board test server on http://127.0.0.1:${PORT} (db ${DB})`));

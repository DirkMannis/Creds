// Local dev/test server: serves index.html and routes /api/* to the real Vercel Function handlers,
// backed by local Postgres (port 55432) through the production Neon driver + the ws proxy in helpers.js.
//   node test/server.js [port]      env: TEST_DB (default tipboard_ui), KEEP_DB=1 to reuse the database
// Test-only routes under /__test/* poke the database directly (stall a board, set boards played).
// Never deployed: test/ is in .vercelignore.
import http from 'node:http';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Pool } from '@neondatabase/serverless';
import { freshDb, startProxy, PG_HOST, PG_PORT } from './helpers.js';

const PORT = Number(process.argv[2] || process.env.PORT || 8833);
const DB = process.env.TEST_DB || 'tipboard_ui';
if (process.env.KEEP_DB) { await startProxy(); process.env.DATABASE_URL = `postgresql://postgres@${PG_HOST}:${PG_PORT}/${DB}`; }
else await freshDb(DB);
const INDEX = fileURLToPath(new URL('../index.html', import.meta.url));

const mod = async p => import(new URL(`../api/${p}`, import.meta.url));
const R = {
  'session': await mod('session.js'), 'me': await mod('me.js'), 'me/history': await mod('me/history.js'), 'me/handle': await mod('me/handle.js'),
  'hold': await mod('hold.js'), 'pay': await mod('pay.js'), 'replay': await mod('replay.js'), 'cashout': await mod('cashout.js'),
  'keep': await mod('keep.js'), 'cron/tick': await mod('cron/tick.js'), 'board': await mod('board/[stake].js'),
};
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
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
      return json(res, 404, { error: 'unknown test route' });
    }
    let m;
    if ((m = /^\/api\/board\/(\d+)$/.exec(url.pathname))) { url.searchParams.set('stake', m[1]); }
    const key = url.pathname.startsWith('/api/board/') ? 'board' : url.pathname.replace(/^\/api\//, '');
    const h = R[key] && R[key][req.method];
    if (!h) return json(res, R[key] ? 405 : 404, { error: 'Not found' });
    return send(res, await h(await toRequest(req, url.href)));
  } catch (e) { console.error(e); json(res, 500, { error: 'test server error' }); }
});
server.listen(PORT, '127.0.0.1', () => console.log(`tip board test server on http://127.0.0.1:${PORT} (db ${DB})`));

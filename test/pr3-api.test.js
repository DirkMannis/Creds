// PR 3: endpoints the browser needs: /api/me/history (JSON pages + CSV), /api/me/handle,
// my squares/wins/prepick squares in /api/me, win amounts in pay results, closed-board snapshots.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from '@neondatabase/serverless';
import { freshDb, stopProxy, req } from './helpers.js';
import * as session from '../api/session.js';
import * as board from '../api/board/[stake].js';
import * as me from '../api/me.js';
import * as history from '../api/me/history.js';
import * as handleEp from '../api/me/handle.js';
import * as hold from '../api/hold.js';
import * as pay from '../api/pay.js';
import * as cashout from '../api/cashout.js';

let pool, ipSeq = 0;
before(async () => { await freshDb('tipboard_pr3'); pool = new Pool({ connectionString: process.env.DATABASE_URL }); });
after(async () => { await pool.end(); await stopProxy(); });

async function call(handler, path, { token, body, method = 'POST' } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await handler(req(path, { method, headers, body: method === 'GET' || body === undefined ? undefined : JSON.stringify(body) }));
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: ct.includes('json') ? await res.json() : await res.text() };
}
async function newPlayer() {
  const n = ++ipSeq;
  const s = await (await session.POST(req('/api/session', { method: 'POST', headers: { 'x-forwarded-for': `10.8.${n >> 8}.${n & 255}` } }))).json();
  return { token: s.token, id: s.player.id };
}
const feed = async (stake, q = '') => (await call(board.GET, `/api/board/${stake}${q}`, { method: 'GET' }));
const meOf = async p => (await call(me.GET, '/api/me', { token: p.token, method: 'GET' })).body;
async function play(p, stake, squares, method = 'xmoney_sim') {
  const h = await call(hold.POST, '/api/hold', { token: p.token, body: { stake, squares } });
  assert.equal(h.status, 200, JSON.stringify(h.body));
  const r = await call(pay.POST, '/api/pay', { token: p.token, body: { method } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

test('me lists my squares and wins; pay results carry win amounts', async () => {
  const a = await newPlayer();
  const r = await play(a, 5, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  for (const x of r.results) {
    if (x.p === 'double') assert.equal(x.amount, 10);
    else if (x.p === 'big') assert.ok(x.amount >= 25);
    else assert.equal(x.amount, 0);
  }
  const m = await meOf(a);
  assert.deepEqual(m.boards[5].squares, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(m.boards[5].mySquares, 10);
  assert.equal((m.boards[20] ? m.boards[20].squares : []).length, 0);
  const wins = r.results.filter(x => x.p === 'double' || x.p === 'big');
  assert.equal(m.wins.length, wins.length);
  for (const w of m.wins) assert.ok(wins.some(x => x.i === w.i && x.p === w.kind && x.amount === w.amount));
  // Early Access pre-picks list their squares
  const h = await call(hold.POST, '/api/hold', { token: a.token, body: { stake: 5, squares: [42, 7], early: true } });
  assert.equal(h.status, 200, JSON.stringify(h.body));
  assert.equal((await call(pay.POST, '/api/pay', { token: a.token, body: { method: 'xmoney_sim' } })).status, 200);
  const m2 = await meOf(a);
  assert.deepEqual(m2.prepicks, [{ stake: 5, n: m.boards[5].n + 1, count: 2, squares: [7, 42] }]);
});

test('history: keyset pages, board filter, CSV without lifetime columns', async () => {
  const a = await newPlayer();
  await play(a, 20, [100, 101, 102]);
  await play(a, 20, [103, 104]);
  const all = await call(history.GET, '/api/me/history?limit=200', { token: a.token, method: 'GET' });
  assert.equal(all.status, 200);
  const n = all.body.total;
  assert.ok(n >= 5, 'at least 5 play rows');
  assert.equal(all.body.entries.length, n);
  assert.equal(all.body.nextBefore, null);
  const plays = all.body.entries.filter(e => e.kind === 'play');
  assert.equal(plays.length, 5);
  for (const e of plays) { assert.equal(e.amount, -20); assert.equal(e.event, 'Play'); assert.match(e.board.label, /^\$20 #\d+$/); assert.ok(e.square >= 101 && e.square <= 105, 'square is 1-based'); }
  for (const e of all.body.entries.filter(e => e.kind === 'win')) assert.ok(e.pending > 0);
  // pages of 2 walk the same rows, newest first, no overlap
  const seen = []; let before = null;
  do {
    const pg = await call(history.GET, `/api/me/history?limit=2${before ? '&before=' + before : ''}`, { token: a.token, method: 'GET' });
    assert.ok(pg.body.entries.length <= 2);
    seen.push(...pg.body.entries.map(e => e.id)); before = pg.body.nextBefore;
  } while (before);
  assert.deepEqual(seen, all.body.entries.map(e => e.id));
  assert.deepEqual([...seen].sort((x, y) => y - x), seen);
  // limit is clamped
  const big = await call(history.GET, '/api/me/history?limit=100000', { token: a.token, method: 'GET' });
  assert.equal(big.status, 200);
  assert.equal((await call(history.GET, '/api/me/history?limit=abc', { token: a.token, method: 'GET' })).status, 400);
  // board filter
  const bid = plays[0].board.id;
  const fb = await call(history.GET, `/api/me/history?board=${bid}`, { token: a.token, method: 'GET' });
  assert.ok(fb.body.entries.every(e => e.board && e.board.id === bid));
  // CSV
  const csv = await call(history.GET, '/api/me/history?format=csv', { token: a.token, method: 'GET' });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="tip-board-history-/);
  const lines = csv.body.trim().split('\n');
  assert.equal(lines[0], 'time_utc,board,square,event,amount,pending,note');
  assert.ok(!/lifetime/i.test(csv.body));
  assert.equal(lines.length - 1, n);
  // no session
  assert.equal((await call(history.GET, '/api/me/history', { method: 'GET' })).status, 401);
  // another player's history is never visible
  const b = await newPlayer();
  assert.equal((await call(history.GET, '/api/me/history', { token: b.token, method: 'GET' })).body.total, 0);
});

test('handle: screened, unique by lookalike, shown on tiles; @handles refused', async () => {
  const a = await newPlayer(), b = await newPlayer();
  const set = (p, handle) => call(handleEp.POST, '/api/me/handle', { token: p.token, body: { handle } });
  assert.equal((await set(a, '@DirkMannis')).status, 400);
  assert.equal((await set(a, 'xMoneyOfficial')).status, 400);
  assert.equal((await set(a, 'grok')).status, 400);
  assert.equal((await set(a, 'ab')).status, 400);
  assert.equal((await set(a, 'Player_0042')).status, 400);
  assert.equal((await set(a, 'sh1tlord')).status, 400);
  const ok = await set(a, 'NightOwl_42');
  assert.equal(ok.status, 200); assert.equal(ok.body.name, 'NightOwl_42');
  assert.equal((await set(b, 'nightow1_42')).status, 409, 'lookalike refused');
  assert.equal((await set(a, 'NightOwl_42')).status, 200, 'same player can re-save');
  await play(a, 20, [300]);
  const f = (await feed(20)).body;
  const sq = f.squares.find(s => s[0] === 300);
  assert.equal(f.who[sq[3]].name, 'NightOwl_42');
  assert.equal((await meOf(a)).player.name, 'NightOwl_42');
  const cl = await set(a, null);
  assert.equal(cl.status, 200); assert.match(cl.body.name, /^Player \d{4,}$/);
  assert.equal((await set(b, 'nightow1_42')).status, 200, 'freed after clear');
  assert.equal((await call(handleEp.POST, '/api/me/handle', { body: { handle: 'Someone' } })).status, 401);
});

test('closed board snapshot and recentClosed', async () => {
  const p = await newPlayer();
  await play(p, 5, [250, 251]);
  const open = (await feed(5)).body.board;
  assert.equal((await feed(5, `?n=${open.n}`)).status, 404, 'open board has no snapshot');
  assert.equal((await feed(5, '?n=abc')).status, 400);
  await pool.query(`UPDATE boards SET stall_from = now() - interval '5 days 1 minute' WHERE id = $1`, [open.id]);
  const f = (await feed(5)).body;
  assert.equal(f.lastClosed.n, open.n);
  assert.equal(f.recentClosed[0].n, open.n); assert.equal(f.recentClosed[0].reason, 'stall');
  const snap = await feed(5, `?n=${open.n}`);
  assert.equal(snap.status, 200);
  assert.match(snap.headers.get('cache-control'), /s-maxage=86400/);
  assert.equal(snap.body.board.plays, open.plays);
  assert.equal(snap.body.squares.length, open.plays);
  assert.ok(snap.body.board.reveal && snap.body.board.reveal.salt);
  assert.ok(Array.isArray(snap.body.board.summary.unselected));
  // per-board history for "You" in the summary: payout or carry rows for this board
  const h = await call(history.GET, `/api/me/history?board=${open.id}`, { token: p.token, method: 'GET' });
  assert.ok(h.body.entries.some(e => e.kind === 'play'));
  // cash-out still works through the API and shows in history
  const m = await meOf(p);
  if (m.wallet.unlocked > 0) {
    assert.equal((await call(cashout.POST, '/api/cashout', { token: p.token, body: {} })).status, 200);
  }
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from '@neondatabase/serverless';
import { freshDb, stopProxy, req } from './helpers.js';
import { migrate, currentVersion, SCHEMA_VERSION, _resetEnsured } from '../api/_db/migrate.js';
import { BAG, buildTickets, newBag, shuffleWithSalt, commitHash, verifyReveal, countsOf, orderLetters, KINDS } from '../api/_lib/bag.js';
import { HOLD_MS, CLOSE_AT, GRID } from '../api/_lib/config.js';
import * as session from '../api/session.js';
import * as board from '../api/board/[stake].js';
import * as me from '../api/me.js';
import * as adminMigrate from '../api/admin/migrate.js';

let pool;
before(async () => { await freshDb('tipboard_test'); _resetEnsured(); pool = new Pool({ connectionString: process.env.DATABASE_URL }); });
after(async () => { await pool.end(); await stopProxy(); });

// ---------- schema ----------
test('schema applies cleanly, is idempotent, and survives 8 concurrent migrations', async () => {
  assert.equal(await currentVersion(pool), 0);
  const pools = Array.from({ length: 8 }, () => new Pool({ connectionString: process.env.DATABASE_URL }));
  const res = await Promise.all(pools.map(p => migrate(p)));
  await Promise.all(pools.map(p => p.end()));
  assert.equal(res.filter(r => r.applied).length, 1, 'exactly one run applies the schema');
  assert.equal(await currentVersion(pool), SCHEMA_VERSION);
  const again = await migrate(pool);
  assert.equal(again.applied, false);
  const { rows } = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`);
  assert.deepEqual(rows.map(r => r.table_name), ['admin_audit', 'board_secrets', 'boards', 'hold_squares', 'holds', 'ledger',
    'payouts', 'players', 'plays', 'prepicks', 'rate_events', 'schema_migrations', 'wallets', 'wins']);
  // forcing the full SQL again (not just the version check) must also be a no-op
  const { schemaSql } = await import('../api/_db/migrate.js');
  await pool.query(schemaSql());
});

test('constraints: one open board per stake, no double squares, no double tickets', async () => {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const { rows: [p] } = await c.query(`INSERT INTO players (token_hash) VALUES (repeat('a', 64)) RETURNING id`);
    const ins = (stake, n) => c.query(`INSERT INTO boards (stake, n, commit_hash, commit_scheme, bag_left)
      VALUES ($1, $2, repeat('0', 64), 'x', '{}') RETURNING id`, [stake, n]);
    const { rows: [b] } = await ins(5, 900);
    await c.query('SAVEPOINT s');
    await assert.rejects(ins(5, 901), /boards_one_open_per_stake/);
    await c.query('ROLLBACK TO s');
    await assert.rejects(ins(5, 900), /duplicate key/); await c.query('ROLLBACK TO s');
    const play = (idx, no) => c.query(`INSERT INTO plays (board_id, idx, play_no, player_id, prize, via) VALUES ($1, $2, $3, $4, 0, 'bot')`, [b.id, idx, no, p.id]);
    await play(10, 1);
    await assert.rejects(play(10, 2), /plays_pkey/, 'same square twice'); await c.query('ROLLBACK TO s');
    await play(10, 1).catch(() => {}); await c.query('ROLLBACK TO s');
    await play(11, 2);
    await c.query('SAVEPOINT t');
    await assert.rejects(play(12, 2), /plays_board_id_play_no_key/, 'same ticket twice'); await c.query('ROLLBACK TO t');
    await assert.rejects(play(500, 3), /check/i, 'square out of range'); await c.query('ROLLBACK TO t');
    await assert.rejects(play(13, 401), /check/i, 'play 401'); await c.query('ROLLBACK TO t');
    // hold squares: two holds can't share a square
    const { rows: [h] } = await c.query(`INSERT INTO holds (player_id, stake, board_n, squares, code, expires_at)
      VALUES ($1, 5, 900, '{20}', 'GROK-AB2', now() + interval '5 minutes') RETURNING id`, [p.id]);
    await c.query(`INSERT INTO hold_squares (stake, board_n, idx, hold_id, expires_at) VALUES (5, 900, 20, $1, now())`, [h.id]);
    await assert.rejects(c.query(`INSERT INTO hold_squares (stake, board_n, idx, hold_id, expires_at) VALUES (5, 900, 20, $1, now())`, [h.id]), /hold_squares_pkey/);
    await c.query('ROLLBACK TO t');
    await assert.rejects(c.query(`INSERT INTO wallets (player_id, unlocked) VALUES ($1, -1)`, [p.id]), /check/i, 'negative wallet');
  } finally { await c.query('ROLLBACK'); c.release(); }
});

// ---------- bag + commitment ----------
test('bag composition is 192 / 2 / 1 / 205 = 400', () => {
  assert.deepEqual({ ...BAG }, { double: 192, big: 2, host: 1, patron: 205 });
  const t = buildTickets();
  assert.equal(t.length, CLOSE_AT);
  assert.deepEqual(countsOf(t), { double: 192, big: 2, host: 1, patron: 205 });
  const b = newBag(5, 1);
  assert.equal(b.order.length, 400);
  assert.deepEqual(countsOf(b.order), countsOf(t), 'shuffle keeps the counts');
  assert.equal(b.codes.length, 400);
  assert.ok(b.codes.every(x => [0, 1, 2, 3].includes(x)));
  assert.equal(GRID - CLOSE_AT, 100, '100 squares stay unselected');
  assert.equal(HOLD_MS, 5 * 60 * 1000, 'hold is 5 minutes');
});

test('seeded shuffle is deterministic per salt and differs across salts', () => {
  const salt = Buffer.alloc(32, 7);
  const a = shuffleWithSalt(buildTickets(), salt), b = shuffleWithSalt(buildTickets(), salt);
  assert.deepEqual(a, b);
  const c = shuffleWithSalt(buildTickets(), Buffer.alloc(32, 8));
  assert.notDeepEqual(a, c);
  // rough uniformity: Big Send positions over many salts are spread over the 400 slots
  const pos = []; for (let s = 0; s < 300; s++) { const o = shuffleWithSalt(buildTickets(), Buffer.from(String(s).padStart(32, '0'))); pos.push(o.indexOf('big')); }
  const mean = pos.reduce((x, y) => x + y, 0) / pos.length;
  assert.ok(mean > 80 && mean < 220, `first Big Send mean position ${mean}`);
});

test('commit hash verifies at reveal and catches tampering', () => {
  const b = newBag(20, 7);
  const ok = verifyReveal({ stake: 20, n: 7, saltHex: b.salt.toString('hex'), orderLetters: orderLetters(b.order), commit: b.commit });
  assert.deepEqual(ok, { orderMatches: true, hashMatches: true });
  const swapped = b.order.slice(); const i = swapped.indexOf('big'), j = swapped.indexOf('patron'); [swapped[i], swapped[j]] = [swapped[j], swapped[i]];
  assert.notEqual(commitHash({ stake: 20, n: 7, salt: b.salt, order: swapped }), b.commit, 'swapped tickets change the hash');
  assert.equal(verifyReveal({ stake: 20, n: 7, saltHex: b.salt.toString('hex'), orderLetters: orderLetters(swapped), commit: b.commit }).orderMatches, false);
  assert.equal(verifyReveal({ stake: 20, n: 8, saltHex: b.salt.toString('hex'), orderLetters: orderLetters(b.order), commit: b.commit }).hashMatches, false, 'bound to board n');
  assert.match(b.commit, /^[0-9a-f]{64}$/);
});

// ---------- API ----------
test('20 parallel first requests open exactly one board per stake, with a valid commitment', async () => {
  _resetEnsured();
  const reqs = [];
  for (let i = 0; i < 20; i++) reqs.push(board.GET(req('/api/board/5')), board.GET(req('/api/board/20?stake=20')));
  const res = await Promise.all(reqs);
  assert.ok(res.every(r => r.status === 200), 'all 200: ' + res.map(r => r.status).join(','));
  const bodies = await Promise.all(res.map(r => r.json()));
  for (const stake of [5, 20]) {
    const ids = new Set(bodies.filter(b => b.board.stake === stake).map(b => b.board.id));
    assert.equal(ids.size, 1, `one board id for $${stake}`);
  }
  const { rows } = await pool.query(`SELECT stake, count(*)::int AS n FROM boards GROUP BY stake ORDER BY stake`);
  assert.deepEqual(rows, [{ stake: 5, n: 1 }, { stake: 20, n: 1 }]);
  // the stored secret reproduces the published commitment
  const { rows: s } = await pool.query(`SELECT b.stake, b.n, b.commit_hash, b.bag_left, encode(bs.salt, 'hex') AS salt, bs.draw_order
                                          FROM boards b JOIN board_secrets bs ON bs.board_id = b.id`);
  for (const r of s) {
    const letters = r.draw_order.map(c => ({ 0: 'P', 1: 'D', 2: 'B', 3: 'H' }[c])).join('');
    assert.deepEqual(verifyReveal({ stake: r.stake, n: r.n, saltHex: r.salt, orderLetters: letters, commit: r.commit_hash }), { orderMatches: true, hashMatches: true });
    assert.deepEqual(r.bag_left, { double: 192, big: 2, host: 1, patron: 205 });
  }
});

test('next board opens once across 20 separate instances (pools), with carryover from the closed board', async () => {
  const { ensureOpenBoard } = await import('../api/_lib/board.js');
  await pool.query(`UPDATE boards SET status = 'closed', closed_at = now(), reason = 'stall', summary = '{"carryOut": 37.5}' WHERE stake = 20 AND status = 'open'`);
  const pools = Array.from({ length: 20 }, () => new Pool({ connectionString: process.env.DATABASE_URL }));
  const boards = await Promise.all(pools.map(p => ensureOpenBoard(p, 20)));
  await Promise.all(pools.map(p => p.end()));
  assert.equal(new Set(boards.map(b => String(b.id))).size, 1);
  assert.equal(boards[0].n, 2);
  assert.equal(Number(boards[0].carry_in), 37.5);
  const { rows } = await pool.query(`SELECT n, status FROM boards WHERE stake = 20 ORDER BY n`);
  assert.deepEqual(rows, [{ n: 1, status: 'closed' }, { n: 2, status: 'open' }]);
  const { rows: sec } = await pool.query(`SELECT count(*)::int AS n FROM board_secrets`);
  assert.equal(sec[0].n, 3, 'one locked bag per board');
});

test('board feed shape, cache header, and no secrets', async () => {
  const r = await board.GET(req('/api/board/5'));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'public, max-age=0, s-maxage=3');
  const text = await r.text(), f = JSON.parse(text);
  assert.equal(f.v, 1);
  assert.equal(f.pollMs, 4000);
  assert.deepEqual(Object.keys(f).sort(), ['board', 'held', 'lastClosed', 'next', 'pollMs', 'recent', 'serverTime', 'squares', 'stakes', 'v', 'who']);
  const b = f.board;
  assert.equal(b.stake, 5); assert.equal(b.n, 1); assert.equal(b.status, 'open'); assert.equal(b.label, '$5 Board #1');
  assert.equal(b.grid, 500); assert.equal(b.closeAt, 400); assert.equal(b.plays, 0); assert.equal(b.bigUnlockAt, 100);
  assert.equal(b.holdMinutes, 5);
  assert.deepEqual(b.pot, { double: 192, big: 2, host: 1, patron: 205 });
  assert.match(b.commit.hash, /^[0-9a-f]{64}$/);
  assert.equal(Date.parse(b.stallAt) - Date.parse(b.openedAt) >= 5 * 864e5 - 1000, true);
  assert.deepEqual(f.squares, []); assert.deepEqual(f.held, []); assert.deepEqual(f.recent, []);
  const { rows: [sec] } = await pool.query(`SELECT encode(salt, 'hex') AS salt, draw_order FROM board_secrets bs JOIN boards b ON b.id = bs.board_id WHERE b.stake = 5`);
  assert.ok(!text.includes(sec.salt), 'feed never includes the salt');
  assert.ok(!/draw_order|token/i.test(text), 'feed never includes the order or tokens');
  assert.ok(!text.includes(JSON.stringify(sec.draw_order)), 'feed never includes the draw order');
  // with plays: compact squares, who table, bot label, and @handles hidden without X sign-in
  const { rows: [bd] } = await pool.query(`SELECT id FROM boards WHERE stake = 5 AND status = 'open'`);
  const { rows: [bot] } = await pool.query(`INSERT INTO players (token_hash, handle, handle_norm, handle_kind, is_bot) VALUES (repeat('b',64), 'tipsy_otter', 'tipsyotter', 'game', true) RETURNING id`);
  const { rows: [anon] } = await pool.query(`INSERT INTO players (token_hash) VALUES (repeat('c',64)) RETURNING id`);
  await pool.query(`INSERT INTO plays (board_id, idx, play_no, player_id, prize, via) VALUES ($1, 0, 1, $2, 1, 'bot'), ($1, 499, 2, $3, 0, 'xmoney_sim')`, [bd.id, bot.id, anon.id]);
  await pool.query(`UPDATE boards SET plays = 2 WHERE id = $1`, [bd.id]);
  const f2 = await (await board.GET(req('/api/board/5'))).json();
  assert.deepEqual(f2.squares, [[0, 1, 'double', 0], [499, 2, 'patron', 1]]);
  assert.deepEqual(f2.who[0], { name: 'tipsy_otter', bot: true });
  assert.equal(f2.who[1].bot, false); assert.match(f2.who[1].name, /^Player \d{4,}$/);
  assert.equal(f2.recent[0].i, 499);
  assert.notEqual(f2.board.version, b.version);
});

test('stakes: $100 is coming soon, junk is 404, neither opens a board', async () => {
  const r100 = await board.GET(req('/api/board/100'));
  assert.equal(r100.status, 404); assert.match((await r100.json()).error, /coming soon/);
  assert.equal((await board.GET(req('/api/board/abc'))).status, 404);
  assert.equal((await board.GET(req('/api/board/7'))).status, 404);
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM boards WHERE stake NOT IN (5, 20)`);
  assert.equal(rows[0].n, 0);
});

test('session issues a token (hash-only storage), reuses it, and rate-limits per IP', async () => {
  const hdr = { 'x-forwarded-for': '203.0.113.9' };
  const r = await session.POST(req('/api/session', { method: 'POST', headers: hdr }));
  assert.equal(r.status, 201); assert.equal(r.headers.get('cache-control'), 'no-store');
  const s = await r.json();
  assert.match(s.token, /^tb1_[A-Za-z0-9_-]{43}$/);
  assert.equal(s.reused, false); assert.equal(s.player.cap, 20); assert.equal(s.player.boardsPlayed, 0);
  const { rows } = await pool.query(`SELECT token_hash FROM players WHERE id = $1`, [s.player.id]);
  assert.notEqual(rows[0].token_hash, s.token); assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
  const { rows: w } = await pool.query(`SELECT unlocked FROM wallets WHERE player_id = $1`, [s.player.id]);
  assert.equal(Number(w[0].unlocked), 0);
  // same token -> same player, no new token
  const r2 = await session.POST(req('/api/session', { method: 'POST', headers: { ...hdr, authorization: 'Bearer ' + s.token } }));
  const s2 = await r2.json();
  assert.equal(r2.status, 200); assert.equal(s2.reused, true); assert.equal(s2.player.id, s.player.id); assert.equal(s2.token, undefined);
  // 10 new players per IP per day
  const codes = [];
  for (let i = 0; i < 10; i++) codes.push((await session.POST(req('/api/session', { method: 'POST', headers: hdr }))).status);
  assert.deepEqual(codes, [201, 201, 201, 201, 201, 201, 201, 201, 201, 429]);
  assert.equal((await session.POST(req('/api/session', { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.1' } }))).status, 201);
  assert.equal((await session.GET(req('/api/session'))).status, 405);
});

test('me returns the wallet summary for a token, 401 without one', async () => {
  assert.equal((await me.GET(req('/api/me'))).status, 401);
  assert.equal((await me.GET(req('/api/me', { headers: { authorization: 'Bearer tb1_' + 'x'.repeat(43) } }))).status, 401);
  const s = await (await session.POST(req('/api/session', { method: 'POST', headers: { 'x-forwarded-for': '192.0.2.50' } }))).json();
  const auth = { authorization: 'Bearer ' + s.token };
  const r = await me.GET(req('/api/me', { headers: auth }));
  assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
  const m = await r.json();
  assert.deepEqual(Object.keys(m).sort(), ['boards', 'historyEntries', 'hold', 'payouts', 'player', 'prepicks', 'wallet']);
  assert.equal(m.player.id, s.player.id); assert.equal(m.player.cap, 20); assert.equal(m.player.keepBalance, false);
  assert.deepEqual(m.wallet.buckets, []); assert.equal(m.wallet.unlocked, 0); assert.equal(m.wallet.pending, 0);
  assert.equal(m.hold, null); assert.deepEqual(m.prepicks, []);
  assert.deepEqual(Object.keys(m.boards).sort(), ['20', '5']);
  assert.deepEqual(m.boards['5'], { n: 1, mySquares: 0, roomLeft: 20, earlyAccessNext: false });
  // ledger + wins flow into the summary
  const { rows: [bd] } = await pool.query(`SELECT id FROM boards WHERE stake = 5 AND status = 'open'`);
  await pool.query(`INSERT INTO plays (board_id, idx, play_no, player_id, prize, via) VALUES ($1, 100, 3, $2, 1, 'xmoney_sim')`, [bd.id, s.player.id]);
  await pool.query(`INSERT INTO wins (board_id, play_no, player_id, kind, amount, unlocked) VALUES ($1, 3, $2, 'double', 10, 5)`, [bd.id, s.player.id]);
  await pool.query(`INSERT INTO ledger (player_id, kind, bucket, board_id, square, amount) VALUES ($1, 'unlock', $2, $3, 100, 5)`, [s.player.id, 'board:' + bd.id, bd.id]);
  await pool.query(`UPDATE wallets SET unlocked = 5 WHERE player_id = $1`, [s.player.id]);
  const m2 = await (await me.GET(req('/api/me', { headers: auth }))).json();
  assert.equal(m2.wallet.unlocked, 5); assert.equal(m2.wallet.pending, 5); assert.equal(m2.wallet.pendingWins, 1);
  assert.deepEqual(m2.wallet.buckets, [{ bucket: 'board:' + bd.id, amount: 5 }]);
  assert.equal(m2.boards['5'].mySquares, 1); assert.equal(m2.boards['5'].roomLeft, 19);
  assert.equal(m2.historyEntries, 1);
});

test('admin migrate is hidden without a valid ADMIN_KEY and audited with one', async () => {
  delete process.env.ADMIN_KEY;
  assert.equal((await adminMigrate.POST(req('/api/admin/migrate', { method: 'POST', headers: { 'x-admin-key': 'anything-at-all-123' } }))).status, 404);
  process.env.ADMIN_KEY = 'test-admin-key-0123456789';
  assert.equal((await adminMigrate.POST(req('/api/admin/migrate', { method: 'POST', headers: { 'x-admin-key': 'wrong-key-000000000000' } }))).status, 404);
  const r = await adminMigrate.POST(req('/api/admin/migrate', { method: 'POST', headers: { 'x-admin-key': process.env.ADMIN_KEY } }));
  assert.equal(r.status, 200); assert.equal((await r.json()).applied, false);
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM admin_audit WHERE action = 'migrate'`);
  assert.equal(rows[0].n, 1);
  delete process.env.ADMIN_KEY;
});

test('missing DATABASE_URL returns a clean 503 (no stack, no URL)', async () => {
  const saved = process.env.DATABASE_URL; delete process.env.DATABASE_URL;
  try {
    const r = await board.GET(req('/api/board/5'));
    assert.equal(r.status, 503); assert.deepEqual(await r.json(), { error: 'Database not configured' });
  } finally { process.env.DATABASE_URL = saved; }
});

// PR 4: lazy 🤖 bots (bot ledger, caps, holds, Early Access, kill switch, catch-up), admin API (+ audit),
// write rate limits, the /api/boards fairness index, and cron backstop. Real handlers + local Postgres.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Pool } from '@neondatabase/serverless';
import { freshDb, stopProxy, req } from './helpers.js';
import { verifyReveal } from '../api/_lib/bag.js';
import { BOT_NAMES } from '../api/_lib/bots.js';
import * as session from '../api/session.js';
import * as board from '../api/board/[stake].js';
import * as boards from '../api/boards.js';
import * as me from '../api/me.js';
import * as history from '../api/me/history.js';
import * as handleApi from '../api/me/handle.js';
import * as hold from '../api/hold.js';
import * as pay from '../api/pay.js';
import * as keep from '../api/keep.js';
import * as cron from '../api/cron/tick.js';
import * as admin from '../api/admin/[action].js';

const KEY = 'pr4-test-admin-key-abcdef0123';
let pool, ipSeq = 0;
before(async () => {
  await freshDb('tipboard_pr4'); pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await (await import('../api/_db/migrate.js')).migrate(pool);
  process.env.ADMIN_KEY = KEY; process.env.BOTS_ENABLED = 'true';
});
after(async () => { process.env.BOTS_ENABLED = 'false'; delete process.env.ADMIN_KEY; await pool.end(); await stopProxy(); });

const r2 = v => Math.round(v * 100) / 100, num = Number;
const nextIp = () => { const n = ++ipSeq; return `10.44.${n >> 8}.${n & 255}`; };
async function call(handler, path, { token, body, method = 'POST', headers = {}, ip } = {}) {
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip || nextIp(), ...headers };
  if (token) h.authorization = 'Bearer ' + token;
  const res = await handler(req(path, { method, headers: h, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) }));
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed, headers: res.headers };
}
const adminCall = (action, body, { key = KEY, method = 'POST' } = {}) =>
  call(admin[method], `/api/admin/${action}?action=${action}`, { method, body, headers: key ? { 'x-admin-key': key } : {} });
async function newPlayer() {
  const res = await session.POST(req('/api/session', { method: 'POST', headers: { 'x-forwarded-for': nextIp() } }));
  const s = await res.json(); return { token: s.token, id: s.player.id };
}
const feed = async stake => (await call(board.GET, `/api/board/${stake}?stake=${stake}`, { method: 'GET' })).body;
const openBoard = async stake => (await pool.query(`SELECT * FROM boards WHERE stake = $1 AND status = 'open'`, [stake])).rows[0];
const backdateBots = (stake, minutes) => pool.query(`UPDATE boards SET bots_at = now() - make_interval(mins => $2) WHERE stake = $1 AND status = 'open'`, [stake, minutes]);
const setBots = s => pool.query(`INSERT INTO settings (key, value) VALUES ('bots', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [JSON.stringify(s)]);
async function play(p, stake, squares, method = 'xmoney_sim') {
  const h = await call(hold.POST, '/api/hold', { token: p.token, body: { stake, squares } });
  assert.equal(h.status, 200, JSON.stringify(h.body));
  const r = await call(pay.POST, '/api/pay', { token: p.token, body: { method } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
async function emptySquares(stake) {
  const f = await feed(stake), used = new Set([...f.squares.map(s => s[0]), ...f.held]);
  const out = []; for (let i = 0; i < 500; i++) if (!used.has(i)) out.push(i);
  return out;
}
beforeEach(async () => { if (pool) { await setBots({ enabled: true, perHour: 60 }); await pool.query('DELETE FROM rate_events'); } });

/** Human ledger/wallets stay clean, bot money balances in bot_ledger, and the close reconciles. */
async function reconcileWithBots(boardId) {
  const { rows: [b] } = await pool.query('SELECT * FROM boards WHERE id = $1', [boardId]);
  const s = b.summary, tipsIn = b.plays * b.stake;
  assert.equal(b.status, 'closed'); assert.equal(s.tipsIn, tipsIn);
  const both = `(SELECT player_id, kind, bucket, board_id, amount FROM ledger UNION ALL SELECT player_id, kind, bucket, board_id, amount FROM bot_ledger)`;
  const { rows: [paid] } = await pool.query(`SELECT coalesce(-sum(amount), 0) AS v FROM ${both} l WHERE board_id = $1 AND kind IN ('play', 'replay')`, [boardId]);
  const { rows: [pre] } = await pool.query(`SELECT count(*)::int AS n FROM plays WHERE board_id = $1 AND via = 'early'`, [boardId]);
  assert.equal(r2(num(paid.v) + pre.n * b.stake), tipsIn, 'human + bot tips in == plays × stake');
  const { rows: [cr] } = await pool.query(`SELECT coalesce(sum(amount), 0) AS v FROM ${both} l WHERE board_id = $1 AND kind IN ('unlock', 'settle')`, [boardId]);
  assert.equal(r2(num(cr.v)), r2(s.bigPaid + s.dblPaid), 'human + bot credits == Big Sends + Double Ups');
  assert.equal(r2(tipsIn + num(b.carry_in) + s.seeded), r2(s.bigPaid + s.dblPaid + s.hostPaid + s.leftover), 'tips in == tips out + host + leftover');
  assert.equal(s.carryOut, r2(s.leftover + s.undrawnBig * 5 * b.stake));
  const { rows: [nx] } = await pool.query('SELECT carry_in FROM boards WHERE stake = $1 AND n = $2', [b.stake, b.n + 1]);
  assert.equal(num(nx.carry_in), s.carryOut, 'next board opens with the carryover');
  const { rows: open } = await pool.query(`SELECT player_id, bucket FROM ${both} l WHERE bucket = $1 GROUP BY 1, 2 HAVING sum(amount) <> 0`, ['board:' + boardId]);
  assert.deepEqual(open, [], 'every board balance (human and bot) settled at close');
  // segregation: no bot ever appears in the human ledger, wallets, payouts or prepicks; no human in bot_ledger
  const { rows: [seg] } = await pool.query(`SELECT
      (SELECT count(*) FROM ledger l JOIN players p ON p.id = l.player_id WHERE p.is_bot)::int AS bot_in_ledger,
      (SELECT count(*) FROM wallets w JOIN players p ON p.id = w.player_id WHERE p.is_bot)::int AS bot_wallets,
      (SELECT count(*) FROM payouts x JOIN players p ON p.id = x.player_id WHERE p.is_bot)::int AS bot_payouts,
      (SELECT count(*) FROM prepicks x JOIN players p ON p.id = x.player_id WHERE p.is_bot)::int AS bot_prepicks,
      (SELECT count(*) FROM holds x JOIN players p ON p.id = x.player_id WHERE p.is_bot)::int AS bot_holds,
      (SELECT count(*) FROM bot_ledger l JOIN players p ON p.id = l.player_id WHERE NOT p.is_bot)::int AS human_in_bot_ledger`);
  assert.deepEqual(seg, { bot_in_ledger: 0, bot_wallets: 0, bot_payouts: 0, bot_prepicks: 0, bot_holds: 0, human_in_bot_ledger: 0 });
  // wallet cache == human ledger
  const { rows: bad } = await pool.query(`SELECT w.player_id FROM wallets w LEFT JOIN (SELECT player_id, sum(amount) s FROM ledger WHERE bucket IS NOT NULL GROUP BY 1) l USING (player_id) WHERE w.unlocked <> coalesce(l.s, 0)`);
  assert.deepEqual(bad, []);
  assert.deepEqual(verifyReveal({ stake: b.stake, n: b.n, saltHex: b.reveal.salt, orderLetters: b.reveal.order, commit: b.commit_hash }), { orderMatches: true, hashMatches: true });
  return { b, s };
}

/* ---------------- bots ---------------- */
test('bots: names are valid in-game handles; feed reports bots; nothing happens without elapsed time', async () => {
  assert.equal(BOT_NAMES.length, 60); assert.ok(BOT_NAMES.every(n => /^[A-Za-z0-9_]{3,15}$/.test(n)));
  const f = await feed(5);
  assert.deepEqual(f.bots.on, true); assert.equal(f.bots.perHour, 60); assert.match(f.bots.note, /removed before real money/);
  assert.equal(f.board.plays, 0, 'a brand-new board has no elapsed bot time');
});

test('bots: kill switch (env BOTS_ENABLED=false) and admin pause both stop them', async () => {
  await backdateBots(5, 60);
  for (const v of ['false', '0', 'off', 'no']) {
    process.env.BOTS_ENABLED = v;
    const f = await feed(5);
    assert.equal(f.board.plays, 0, `BOTS_ENABLED=${v}`); assert.equal(f.bots.on, false);
  }
  process.env.BOTS_ENABLED = 'true';
  await setBots({ enabled: false, perHour: 60 });
  assert.equal((await feed(5)).board.plays, 0, 'admin pause');
  await setBots({ enabled: true, perHour: 60 });
  assert.equal((await feed(5)).board.plays, 20, 'back on: catches up, at most 20 per request');
});

test('bots: catch up on elapsed time at the set rate, capped per request and by a 3 h backlog', async () => {
  const b0 = await openBoard(5); // 20 plays from the previous test, 40 min of backlog left
  const f1 = await feed(5); assert.equal(f1.board.plays, b0.plays + 20, 'next request plays another 20');
  const f2 = await feed(5); assert.equal(f2.board.plays, b0.plays + 40, 'and the remaining 20 minutes');
  const f3 = await feed(5); assert.equal(f3.board.plays, b0.plays + 40, 'no backlog left: nothing');
  await backdateBots(5, 10 * 60); // 10 hours idle -> only 3 hours (180 plays) count
  let plays = f3.board.plays;
  for (let i = 0; i < 12; i++) plays = (await feed(5)).board.plays;
  assert.equal(plays, f3.board.plays + 180, '3 h backlog cap at 60/h');
  // labels: every bot square is flagged in the feed's who table, and recent flips carry it
  const f = await feed(5);
  assert.ok(f.who.every(w => w.bot === true)); assert.ok(f.who.every(w => BOT_NAMES.includes(w.name)));
  assert.ok(f.recent.length && f.recent.every(r => f.who[r.who].bot));
  const { rows: via } = await pool.query(`SELECT DISTINCT via FROM plays WHERE board_id = $1`, [b0.id]);
  assert.deepEqual(via.map(r => r.via), ['bot']);
  // caps: no bot over its per-board cap (20 for a new player)
  const { rows: [mx] } = await pool.query(`SELECT max(n)::int AS m FROM (SELECT count(*) n FROM plays WHERE board_id = $1 GROUP BY player_id) x`, [b0.id]);
  assert.ok(mx.m <= 20, `max bot plays ${mx.m}`);
  // their money is in bot_ledger only
  const { rows: [bl] } = await pool.query(`SELECT count(*)::int AS n, -sum(amount) AS paid FROM bot_ledger WHERE board_id = $1 AND kind = 'play'`, [b0.id]);
  assert.equal(bl.n, plays); assert.equal(num(bl.paid), plays * 5);
  const { rows: [hl] } = await pool.query(`SELECT count(*)::int AS n FROM ledger`);
  assert.equal(hl.n, 0, 'nothing in the human ledger');
});

test('bot-filled board with humans: bots skip held squares and leave room for holds, never touch Early Access; close reconciles', async () => {
  const stake = 20;
  await feed(stake);
  const b1 = await openBoard(stake);
  const [h1, h2, h3] = [await newPlayer(), await newPlayer(), await newPlayer()];
  await call(keep.POST, '/api/keep', { token: h3.token, body: { on: true } });
  const free = await emptySquares(stake);
  await play(h1, stake, free.slice(0, 10));                       // 10 plays -> Early Access
  const ea = await call(hold.POST, '/api/hold', { token: h1.token, body: { stake, squares: [7, 8, 9], early: true } });
  assert.equal(ea.status, 200, JSON.stringify(ea.body));
  assert.equal((await call(pay.POST, '/api/pay', { token: h1.token, body: { method: 'xmoney_sim' } })).status, 200);
  await play(h3, stake, free.slice(10, 15));
  // h2 holds 5 squares and doesn't pay yet
  const held = free.slice(15, 20);
  assert.equal((await call(hold.POST, '/api/hold', { token: h2.token, body: { stake, squares: held } })).status, 200);
  // bots run hot: 3600/h, 3 h of backlog -> they fill everything except the room for h2's hold
  await setBots({ enabled: true, perHour: 3600 });
  await backdateBots(stake, 180);
  let f; for (let i = 0; i < 30; i++) f = await feed(stake);
  assert.equal(f.board.n, b1.n, 'not closed while a human holds the last squares');
  assert.equal(f.board.plays, 395, 'bots stop at 400 − held squares');
  const taken = new Set(f.squares.map(s => s[0]));
  assert.ok(held.every(i => !taken.has(i)), 'bots never take a held square');
  assert.deepEqual(f.held.sort((a, z) => a - z), held.sort((a, z) => a - z));
  // the human pays -> play 400 -> close
  const r = await call(pay.POST, '/api/pay', { token: h2.token, body: { method: 'xmoney_sim' } });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.ok(r.body.closedBoard, 'human play 400 closes the board');
  const { s } = await reconcileWithBots(b1.id);
  assert.equal(s.plays, 400);
  for (const big of s.bigs) if (big.bot) assert.match(big.name, /^🤖 /);
  // Early Access: next board opened with h1's 3 pre-picks played first; bots have no prepicks
  const b2 = await openBoard(stake);
  const { rows: p2 } = await pool.query('SELECT idx, via, player_id FROM plays WHERE board_id = $1 ORDER BY play_no', [b2.id]);
  assert.deepEqual(p2.map(x => [x.idx, x.via, Number(x.player_id)]), [[7, 'early', h1.id], [8, 'early', h1.id], [9, 'early', h1.id]]);
  // h3 opted to keep: carried to b2 (bots never carry)
  const { rows: carry } = await pool.query(`SELECT DISTINCT player_id FROM ledger WHERE bucket = $1`, ['carry:' + b2.id]);
  assert.ok(carry.every(c => Number(c.player_id) === h3.id));
  const { rows: [bc] } = await pool.query(`SELECT count(*)::int AS n FROM bot_ledger WHERE bucket LIKE 'carry:%'`);
  assert.equal(bc.n, 0);
  // human history shows only their own rows; no bot names; closed snapshot labels bots
  const hist = await call(history.GET, '/api/me/history?limit=200', { token: h1.token, method: 'GET' });
  assert.equal(hist.status, 200); assert.ok(hist.body.entries.every(e => !/🤖/.test(e.note)));
  const snap = (await call(board.GET, `/api/board/${stake}?stake=${stake}&n=${b1.n}`, { method: 'GET' })).body;
  assert.ok(snap.who.some(w => w.bot) && snap.who.some(w => !w.bot));
  // bots' boards_played went up like anyone's (their cap grows to 40 after 2 boards)
  const { rows: [bp] } = await pool.query(`SELECT count(*)::int AS n FROM players WHERE is_bot AND boards_played = 1`);
  assert.ok(bp.n > 0);
});

test('bots alone fill a board to close via the cron backstop and it reconciles', async () => {
  const stake = 5;
  const b = await openBoard(stake);
  await setBots({ enabled: true, perHour: 3600 });
  await backdateBots(stake, 180);
  const res = await call(cron.GET, '/api/cron/tick', { method: 'GET', headers: { 'x-admin-key': KEY } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.botPlays['5'], 400 - b.plays);
  const { rows: [c] } = await pool.query('SELECT status, reason, plays FROM boards WHERE id = $1', [b.id]);
  assert.deepEqual(c, { status: 'closed', reason: 'full', plays: 400 });
  await reconcileWithBots(b.id);
});

/* ---------------- admin ---------------- */
test('admin: 404 when ADMIN_KEY is unset, too short, or wrong; nothing is audited for strangers', async () => {
  const saved = process.env.ADMIN_KEY;
  delete process.env.ADMIN_KEY;
  assert.equal((await adminCall('status', undefined, { method: 'GET' })).status, 404);
  assert.equal((await adminCall('close', { stake: 5 })).status, 404);
  process.env.ADMIN_KEY = 'short';
  assert.equal((await adminCall('close', { stake: 5 }, { key: 'short' })).status, 404);
  process.env.ADMIN_KEY = saved;
  assert.equal((await adminCall('close', { stake: 5 }, { key: 'wrong-key-wrong-key' })).status, 404);
  assert.equal((await adminCall('close', { stake: 5 }, { key: null })).status, 404);
  assert.equal((await adminCall('nope', {})).status, 404);
  const { rows: [a] } = await pool.query('SELECT count(*)::int AS n FROM admin_audit');
  assert.equal(a.n, 0);
});

test('admin: every action works and writes an audit row (success and failure)', async () => {
  const audits = async () => (await pool.query('SELECT action, args FROM admin_audit ORDER BY id')).rows;
  const st = await adminCall('status', undefined, { method: 'GET' });
  assert.equal(st.status, 200); assert.equal(st.body.boards.length, 2); assert.equal(st.body.bots.enabled, true);
  // bots on/off/speed
  let r = await adminCall('bots', { enabled: false, perHour: 120 });
  assert.equal(r.status, 200); assert.deepEqual([r.body.bots.enabled, r.body.bots.perHour], [false, 120]);
  r = await adminCall('bots', { perHour: 0 }); assert.equal(r.status, 400);
  r = await adminCall('bots', { enabled: true }); assert.deepEqual([r.body.bots.enabled, r.body.bots.perHour], [true, 120]);
  // credit
  const h = await newPlayer();
  r = await adminCall('credit', { playerId: h.id, amount: 25 });
  assert.equal(r.status, 200); assert.equal(r.body.wallet, 25);
  assert.equal((await call(me.GET, '/api/me', { token: h.token, method: 'GET' })).body.wallet.unlocked, 25);
  assert.equal((await adminCall('credit', { playerId: h.id, amount: 5000 })).status, 400);
  const { rows: [bot] } = await pool.query('SELECT id FROM players WHERE is_bot LIMIT 1');
  assert.equal((await adminCall('credit', { playerId: Number(bot.id), amount: 5 })).status, 409, 'no top-ups for bots');
  // force close (empty board refused; with plays closes with reason admin)
  await setBots({ enabled: false, perHour: 60 });
  const b20 = await openBoard(20);
  await play(h, 20, (await emptySquares(20)).slice(0, 1));
  r = await adminCall('close', { stake: 20 });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.closed, b20.n);
  const { rows: [c] } = await pool.query('SELECT reason, summary FROM boards WHERE id = $1', [b20.id]);
  assert.equal(c.reason, 'admin');
  await reconcileWithBots(b20.id);
  r = await adminCall('close', { stake: 20 });
  assert.equal(r.status, 409, 'an empty board has nothing to close'); assert.match(r.body.error, /no plays yet/);
  // stall fast-forward by hours (not due yet), then default (due now -> closes since it has plays)
  const b5 = await openBoard(5);
  await play(h, 5, (await emptySquares(5)).slice(0, 1), 'xmoney_sim');
  r = await adminCall('stall', { stake: 5, hours: 24 });
  assert.equal(r.status, 200); assert.equal(r.body.closed, null);
  r = await adminCall('stall', { stake: 5 });
  assert.equal(r.status, 200); assert.equal(r.body.closed, b5.n);
  assert.equal((await pool.query('SELECT reason FROM boards WHERE id = $1', [b5.id])).rows[0].reason, 'stall');
  assert.equal((await adminCall('stall', { stake: 7 })).status, 400);
  const log = await audits();
  assert.deepEqual(log.map(a => [a.action, a.args.ok]), [
    ['bots', true], ['bots', false], ['bots', true], ['credit', true], ['credit', false], ['credit', false],
    ['close', true], ['close', false], ['stall', true], ['stall', true], ['stall', false]]);
  assert.equal(log[0].args.args.perHour, 120); assert.match(log[1].args.error, /speed/);
  assert.equal(log[0].args.result.bots.perHour, 120);
});

test('admin reset (beta): refunds humans, voids board balances (human + bot), moves carried credit, verifiable reveal', async () => {
  const stake = 20;
  const b = await openBoard(stake);
  // a carried credit INTO this board (keeper from the forced close above has none, so seed one directly)
  const [a, k] = [await newPlayer(), await newPlayer()];
  await pool.query(`INSERT INTO ledger (player_id, kind, bucket, board_id, amount, note) VALUES ($1, 'carry', $2, $3, 15, 'test carry')`, [k.id, 'carry:' + b.id, b.id]);
  await pool.query('UPDATE wallets SET unlocked = unlocked + 15 WHERE player_id = $1', [k.id]);
  const free = await emptySquares(stake);
  for (let i = 0; i < 3; i++) await play(a, stake, free.slice(i * 6, i * 6 + 6));
  await setBots({ enabled: true, perHour: 3600 }); await backdateBots(stake, 60);
  for (let i = 0; i < 10; i++) await feed(stake);
  const pre = await openBoard(stake);
  assert.ok(pre.plays >= 100, 'bots played past the Big Send unlock so there are unlocked balances to void');
  const { rows: [aPlays] } = await pool.query(`SELECT count(*)::int AS n FROM plays WHERE board_id = $1 AND player_id = $2`, [b.id, a.id]);
  const { rows: [bpBefore] } = await pool.query('SELECT boards_played FROM players WHERE id = $1', [a.id]);
  assert.equal((await adminCall('reset', { stake })).status, 400, 'needs confirm: RESET');
  const r = await adminCall('reset', { stake, confirm: 'RESET' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.refunded, aPlays.n * stake); assert.equal(r.body.carriedMoved, 15);
  const { rows: [c] } = await pool.query('SELECT * FROM boards WHERE id = $1', [b.id]);
  assert.equal(c.reason, 'reset'); assert.equal(c.summary.voided, true);
  const nb = await openBoard(stake);
  assert.equal(nb.n, b.n + 1); assert.equal(num(nb.carry_in), num(b.carry_in));
  const both = `(SELECT player_id, bucket, amount FROM ledger UNION ALL SELECT player_id, bucket, amount FROM bot_ledger)`;
  const { rows: openBal } = await pool.query(`SELECT player_id FROM ${both} l WHERE bucket = ANY($1) GROUP BY player_id, bucket HAVING sum(amount) <> 0`, [['board:' + b.id, 'carry:' + b.id]]);
  assert.deepEqual(openBal, [], 'board + carry buckets for the reset board are zero');
  const { rows: [kc] } = await pool.query(`SELECT sum(amount) AS s FROM ledger WHERE player_id = $1 AND bucket = $2`, [k.id, 'carry:' + nb.id]);
  assert.equal(num(kc.s), 15);
  const ma = (await call(me.GET, '/api/me', { token: a.token, method: 'GET' })).body;
  assert.equal(ma.wallet.unlocked, aPlays.n * stake, 'refund lands in the wallet as play money');
  assert.equal((await pool.query('SELECT boards_played FROM players WHERE id = $1', [a.id])).rows[0].boards_played, bpBefore.boards_played);
  assert.deepEqual(verifyReveal({ stake, n: c.n, saltHex: c.reveal.salt, orderLetters: c.reveal.order, commit: c.commit_hash }), { orderMatches: true, hashMatches: true });
  const { rows: [au] } = await pool.query(`SELECT args FROM admin_audit WHERE action = 'reset' ORDER BY id DESC LIMIT 1`);
  assert.equal(au.args.ok, true); assert.equal(au.args.result.reset, b.n);
});

/* ---------------- rate limits ---------------- */
test('rate limits: 30 writes/min per player, 120/min per IP, friendly 429 with Retry-After; reads are never limited', async () => {
  await setBots({ enabled: false, perHour: 60 });
  const p = await newPlayer();
  for (let i = 0; i < 30; i++) {
    const r = await call(keep.POST, '/api/keep', { token: p.token, body: { on: i % 2 === 0 } });
    assert.equal(r.status, 200, `write ${i + 1}`);
  }
  const lim = await call(keep.POST, '/api/keep', { token: p.token, body: { on: true } });
  assert.equal(lim.status, 429); assert.equal(lim.body.rateLimited, true); assert.equal(lim.body.scope, 'player');
  assert.match(lim.body.error, /try again in \d+ s/); assert.ok(Number(lim.headers.get('retry-after')) >= 1);
  assert.equal((await call(handleApi.POST, '/api/me/handle', { token: p.token, body: { handle: 'rate_tester' } })).status, 429, 'handle changes count too');
  assert.equal((await call(me.GET, '/api/me', { token: p.token, method: 'GET' })).status, 200, 'reads are fine');
  assert.equal((await call(hold.POST, '/api/hold', { token: p.token, body: { stake: 5, squares: [499] } })).status, 429);
  // per IP: many players behind one address
  await pool.query('DELETE FROM rate_events');
  const ip = '10.200.0.1', ps = []; for (let i = 0; i < 5; i++) ps.push(await newPlayer());
  let n = 0, last;
  for (let i = 0; i < 125 && (!last || last.status !== 429); i++) { last = await call(keep.POST, '/api/keep', { token: ps[i % 5].token, body: { on: false }, ip }); n++; }
  assert.equal(n, 121); assert.equal(last.status, 429); assert.equal(last.body.scope, 'ip');
  // a different IP is fine for those same players (their own per-player counts are 24 each)
  assert.equal((await call(keep.POST, '/api/keep', { token: ps[0].token, body: { on: false } })).status, 200);
  // cron prunes old rate events
  await pool.query(`UPDATE rate_events SET at = now() - interval '3 days'`);
  const t = await call(cron.GET, '/api/cron/tick', { method: 'GET', headers: { 'x-admin-key': KEY } });
  assert.ok(t.body.rateEventsPruned >= 120);
});

/* ---------------- fairness index ---------------- */
test('/api/boards lists commit hashes (open + closed, newest first, paginated); /fair is served and linked', async () => {
  const r = await call(boards.GET, '/api/boards?stake=20&limit=2', { method: 'GET' });
  assert.equal(r.status, 200);
  assert.equal(r.body.open.length, 1); assert.match(r.body.open[0].commit, /^[0-9a-f]{64}$/);
  assert.equal(r.body.closed.length, 2); assert.ok(r.body.closed[0].n > r.body.closed[1].n);
  assert.ok(r.body.nextBefore); assert.ok(!('salt' in r.body.closed[0]) && !JSON.stringify(r.body).includes('"order"'), 'no secrets');
  const r2b = await call(boards.GET, `/api/boards?stake=20&before=${r.body.nextBefore}`, { method: 'GET' });
  assert.ok(r2b.body.closed.every(b => b.n < r.body.nextBefore));
  assert.equal((await call(boards.GET, '/api/boards?stake=7', { method: 'GET' })).status, 404);
  assert.equal((await call(boards.GET, '/api/boards?stake=5&before=x', { method: 'GET' })).status, 400);
  const vj = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url)));
  assert.equal(vj.cleanUrls, true, '/fair serves fair.html');
  const fair = fs.readFileSync(new URL('../fair.html', import.meta.url), 'utf8');
  assert.match(fair, /crypto\.subtle/); assert.match(fair, /\/api\/boards/);
  const index = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(index, /href="\/fair/); assert.ok(!/admin tools arrive in PR ?4/i.test(index));
  assert.match(index, /Beta boards include labeled 🤖 practice players so boards close; removed before real money/);
});

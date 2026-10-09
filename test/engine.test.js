// PR 2: server engine + write path. Runs against real Postgres through the production Neon driver.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Pool } from '@neondatabase/serverless';
import { freshDb, stopProxy, req } from './helpers.js';
import { verifyReveal } from '../api/_lib/bag.js';
import { _internals } from '../api/_lib/engine.js';
import * as session from '../api/session.js';
import * as board from '../api/board/[stake].js';
import * as me from '../api/me.js';
import * as hold from '../api/hold.js';
import * as pay from '../api/pay.js';
import * as replay from '../api/replay.js';
import * as cashout from '../api/cashout.js';
import * as keep from '../api/keep.js';
import * as cron from '../api/cron/tick.js';

let pool, ipSeq = 0;
before(async () => { await freshDb('tipboard_engine'); pool = new Pool({ connectionString: process.env.DATABASE_URL }); });
after(async () => { await pool.end(); await stopProxy(); });

const r2 = v => Math.round(v * 100) / 100;
const num = v => Number(v);
async function call(handler, path, { token, body, method = 'POST' } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await handler(req(path, { method, headers, body: body === undefined || method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}
async function newPlayer() {
  const n = ++ipSeq;
  const res = await session.POST(req('/api/session', { method: 'POST', headers: { 'x-forwarded-for': `10.9.${n >> 8}.${n & 255}` } }));
  const s = await res.json();
  return { token: s.token, id: s.player.id };
}
const players = async n => Promise.all(Array.from({ length: n }, newPlayer));
const feed = async stake => (await call(board.GET, `/api/board/${stake}`, { method: 'GET' })).body;
const meOf = async p => (await call(me.GET, '/api/me', { token: p.token, method: 'GET' })).body;
const doHold = (p, stake, squares, early) => call(hold.POST, '/api/hold', { token: p.token, body: { stake, squares, early } });
const doPay = (p, method = 'xmoney_sim') => call(pay.POST, '/api/pay', { token: p.token, body: { method } });
async function play(p, stake, squares, method) {
  const h = await doHold(p, stake, squares);
  assert.equal(h.status, 200, JSON.stringify(h.body));
  const r = await doPay(p, method);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
async function emptySquares(stake) {
  const f = await feed(stake), used = new Set([...f.squares.map(s => s[0]), ...f.held]);
  const out = []; for (let i = 0; i < 500; i++) if (!used.has(i)) out.push(i);
  return out;
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const openBoard = async stake => (await pool.query(`SELECT * FROM boards WHERE stake = $1 AND status = 'open'`, [stake])).rows[0];

/** Global invariants: ledger == wallets, no negative bucket, plays unique and contiguous. */
async function assertInvariants(msg = '') {
  const { rows: bad } = await pool.query(`
    SELECT w.player_id, w.unlocked, coalesce(l.s, 0) AS s FROM wallets w
      LEFT JOIN (SELECT player_id, sum(amount) s FROM ledger WHERE bucket IS NOT NULL GROUP BY player_id) l USING (player_id)
     WHERE w.unlocked <> coalesce(l.s, 0)`);
  assert.deepEqual(bad, [], 'wallet cache == ledger ' + msg);
  const { rows: neg } = await pool.query(`SELECT player_id, bucket, sum(amount) FROM ledger WHERE bucket IS NOT NULL GROUP BY 1, 2 HAVING sum(amount) < 0`);
  assert.deepEqual(neg, [], 'no negative bucket ' + msg);
  const { rows: gaps } = await pool.query(`
    SELECT b.id, b.plays, count(p.*)::int AS n, coalesce(max(p.play_no), 0) AS mx, count(DISTINCT p.idx)::int AS sq
      FROM boards b LEFT JOIN plays p ON p.board_id = b.id GROUP BY b.id HAVING b.plays <> count(p.*) OR coalesce(max(p.play_no), 0) <> b.plays OR count(DISTINCT p.idx) <> count(p.*)`);
  assert.deepEqual(gaps, [], 'plays contiguous and unique ' + msg);
  const { rows: tix } = await pool.query(`SELECT p.board_id FROM plays p JOIN board_secrets s ON s.board_id = p.board_id WHERE s.draw_order[p.play_no] <> p.prize`);
  assert.deepEqual(tix, [], 'every play drew ticket #play_no from the locked order ' + msg);
}

/** Reconcile one closed board: every tip in = every tip out + carryover + host. */
async function reconcile(boardId) {
  const { rows: [b] } = await pool.query('SELECT * FROM boards WHERE id = $1', [boardId]);
  const s = b.summary;
  assert.equal(b.status, 'closed');
  const tipsIn = b.plays * b.stake;
  assert.equal(s.tipsIn, tipsIn);
  const { rows: [paid] } = await pool.query(`SELECT coalesce(-sum(amount), 0) AS v FROM ledger WHERE board_id = $1 AND kind IN ('play', 'replay')`, [boardId]);
  const { rows: [pre] } = await pool.query(`SELECT count(*)::int AS n FROM plays WHERE board_id = $1 AND via = 'early'`, [boardId]);
  assert.equal(r2(num(paid.v) + pre.n * b.stake), tipsIn, 'ledger tips in (incl. Early Access prepaid) == plays × stake');
  const { rows: [cr] } = await pool.query(`SELECT coalesce(sum(amount), 0) AS v FROM ledger WHERE board_id = $1 AND kind IN ('unlock', 'settle')`, [boardId]);
  assert.equal(r2(num(cr.v)), r2(s.bigPaid + s.dblPaid), 'player credits == Big Sends + Double Ups paid');
  const { rows: [w] } = await pool.query(`SELECT coalesce(sum(unlocked), 0) AS u, bool_and(final) AS f, count(*)::int AS n FROM wins WHERE board_id = $1`, [boardId]);
  assert.equal(r2(num(w.u)), r2(s.bigPaid + s.dblPaid)); if (w.n) assert.equal(w.f, true, 'all wins final');
  // the identity: tips in + carry in + host seed = winners + host + leftover; carryover = leftover + undrawn Big Sends
  assert.equal(r2(tipsIn + num(b.carry_in) + s.seeded), r2(s.bigPaid + s.dblPaid + s.hostPaid + s.leftover), 'tips in == tips out + host + leftover');
  assert.equal(s.carryOut, r2(s.leftover + s.undrawnBig * 5 * b.stake));
  assert.ok(s.hostPaid <= 5 * b.stake && s.scale <= 1 && s.scale >= 0);
  const { rows: [nx] } = await pool.query('SELECT carry_in FROM boards WHERE stake = $1 AND n = $2', [b.stake, b.n + 1]);
  assert.equal(num(nx.carry_in), s.carryOut, 'next board opens with the carryover');
  const { rows: [bk] } = await pool.query(`SELECT count(*)::int AS n FROM (SELECT player_id FROM ledger WHERE bucket = $1 GROUP BY 1 HAVING sum(amount) <> 0) x`, ['board:' + boardId]);
  assert.equal(bk.n, 0, 'every board balance was paid out or carried at close');
  assert.deepEqual(verifyReveal({ stake: b.stake, n: b.n, saltHex: b.reveal.salt, orderLetters: b.reveal.order, commit: b.commit_hash }), { orderMatches: true, hashMatches: true });
  return { b, s };
}

/* ---------------- pure logic (ported from the local engine tests) ---------------- */
test('unlock ladder: even-up at the next 20, profit at the following 20, Big Sends from 100 with host seed', () => {
  const posts = [];
  const st = { b: { id: 1, stake: 5, n: 1, plays: 20, carry_in: 0, seeded: 0 }, book: { post: (...a) => posts.push(a) }, dirty: new Set(),
    wins: [{ play_no: 1, idx: 0, player_id: 1, kind: 'double', amount: 10, unlocked: 0, evened_at: null },
      { play_no: 15, idx: 1, player_id: 2, kind: 'double', amount: 10, unlocked: 0, evened_at: null },
      { play_no: 5, idx: 2, player_id: 3, kind: 'big', amount: 25, unlocked: 0, evened_at: null }] };
  _internals.milestone(st);
  assert.deepEqual(st.wins.map(w => w.unlocked), [5, 5, 0], '20: Double Ups even up (1 tip back)');
  st.b.plays = 40; _internals.milestone(st);
  assert.deepEqual(st.wins.map(w => w.unlocked), [10, 10, 0], '40: profit tranche');
  st.b.plays = 100; _internals.milestone(st);
  assert.equal(st.wins[2].unlocked, 25, '100: Big Send unlocks'); assert.equal(st.b.seeded, 0);
  // budget exhausted: 20 Double Ups in the first 20 plays, then a Big Send at 100 needs a host seed
  const s2 = { b: { id: 2, stake: 5, n: 1, plays: 20, carry_in: 0, seeded: 0 }, book: { post() {} }, dirty: new Set(),
    wins: Array.from({ length: 20 }, (_, i) => ({ play_no: i + 1, idx: i, player_id: 1, kind: 'double', amount: 10, unlocked: 0, evened_at: null })) };
  _internals.milestone(s2);
  assert.equal(s2.wins.reduce((a, w) => a + w.unlocked, 0), 100, 'all 100 tipped in goes to even-ups');
  s2.b.plays = 40; _internals.milestone(s2);
  assert.ok(s2.wins.every(w => w.unlocked === 10));
  s2.wins.push({ play_no: 100, idx: 99, player_id: 2, kind: 'big', amount: 25, unlocked: 0, evened_at: null });
  s2.b.plays = 100; s2.b.plays = 100; // 500 in, 400 already unlocked -> budget 100 covers it
  _internals.milestone(s2); assert.equal(s2.b.seeded, 0);
  const s3 = { b: { id: 3, stake: 5, n: 1, plays: 100, carry_in: 0, seeded: 0 }, book: { post() {} }, dirty: new Set(),
    wins: [...Array.from({ length: 50 }, (_, i) => ({ play_no: i + 1, idx: i, player_id: 1, kind: 'double', amount: 10, unlocked: 10, evened_at: 20 })),
      { play_no: 60, idx: 60, player_id: 2, kind: 'big', amount: 25, unlocked: 0, evened_at: null }] };
  _internals.milestone(s3);
  assert.equal(s3.wins[50].unlocked, 25); assert.equal(s3.b.seeded, 25, 'host seeds a Big Send the tips cannot cover yet');
});

test('square parsing: 0-499, unique, 1..40 per hold', () => {
  assert.deepEqual(_internals.parseSquares([5, 1, 3]), [1, 3, 5]);
  for (const bad of [[], [1, 1], [500], [-1], [1.5], ['3'], Array.from({ length: 41 }, (_, i) => i)]) assert.throws(() => _internals.parseSquares(bad), /square|Pick/i, JSON.stringify(bad).slice(0, 30));
});

test('wallet spend: carried credit first, then oldest board', () => {
  const b = [{ bucket: 'board:3', amt: 4 }, { bucket: 'board:1', amt: 10 }, { bucket: 'carry:7', amt: 3 }]
    .sort((x, y) => (y.bucket.startsWith('carry:') - x.bucket.startsWith('carry:')) || (Number(x.bucket.split(':')[1]) - Number(y.bucket.split(':')[1])));
  assert.deepEqual(_internals.takeFrom(b, 5), [{ bucket: 'carry:7', amt: 3 }, { bucket: 'board:1', amt: 2 }]);
});

/* ---------------- holds ---------------- */
test('hold: 5-minute hold with GROK code, one per player, exclusive squares, caps, staff blocked', async () => {
  const [a, b, s] = await players(3);
  await feed(5);
  const h = await doHold(a, 5, [10, 11, 12]);
  assert.equal(h.status, 200, JSON.stringify(h.body));
  assert.match(h.body.hold.code, /^GROK-[A-Z2-9]{3}$/);
  const mins = (Date.parse(h.body.hold.expiresAt) - Date.now()) / 60e3;
  assert.ok(mins > 4.9 && mins <= 5.01, 'held for 5 minutes, got ' + mins);
  assert.equal(h.body.hold.amount, 15); assert.equal(h.body.hold.holdMinutes, 5);
  assert.deepEqual((await feed(5)).held, [10, 11, 12], 'feed shows held squares');
  assert.equal((await doHold(a, 5, [20])).status, 409, 'one hold at a time');
  const clash = await doHold(b, 5, [12, 13]);
  assert.equal(clash.status, 409); assert.deepEqual(clash.body.held, [12]);
  assert.equal((await doHold(b, 5, [499])).status, 200);
  assert.equal((await call(hold.DELETE, '/api/hold', { token: b.token, method: 'DELETE' })).body.cancelled, true);
  assert.equal((await doHold(b, 5, Array.from({ length: 21 }, (_, i) => 100 + i))).status, 409, 'cap 20 for new players');
  assert.match((await doHold(b, 5, Array.from({ length: 21 }, (_, i) => 100 + i))).body.error, /pick 20 more.*cap 20/);
  assert.equal((await doHold(b, 5, [1, 1])).status, 400);
  assert.equal((await doHold(b, 100, [1])).status, 404, '$100 not live');
  await pool.query('UPDATE players SET is_staff = true WHERE id = $1', [s.id]);
  const st = await doHold(s, 5, [300]);
  assert.equal(st.status, 403); assert.match(st.body.error, /Host and admin accounts can't play/);
  assert.equal((await call(hold.POST, '/api/hold', { body: { stake: 5, squares: [1] } })).status, 401);
  await call(hold.DELETE, '/api/hold', { token: a.token, method: 'DELETE' });
});

test('pay: simulated X Money draws in square order, ledger rows, hold consumed; expired holds fail with 410', async () => {
  const [a, b] = await players(2);
  const before = await openBoard(5);
  const r = await play(a, 5, [42, 7, 300], 'xmoney_sim');
  assert.deepEqual(r.results.map(x => x.i), [7, 42, 300], 'drawn in square-number order');
  assert.deepEqual(r.results.map(x => x.k), [before.plays + 1, before.plays + 2, before.plays + 3]);
  const { rows } = await pool.query(`SELECT kind, amount, bucket, square FROM ledger WHERE player_id = $1 AND kind = 'play' ORDER BY id`, [a.id]);
  assert.deepEqual(rows.map(x => [x.kind, num(x.amount), x.bucket, x.square]), [['play', -5, null, 7], ['play', -5, null, 42], ['play', -5, null, 300]]);
  assert.equal((await doPay(a)).status, 404, 'hold already used');
  const f = await feed(5);
  assert.ok([7, 42, 300].every(i => f.squares.some(s => s[0] === i)));
  assert.equal((await doHold(b, 5, [7])).status, 409, 'played squares cannot be held');
  // expiry
  assert.equal((await doHold(b, 5, [8, 9])).status, 200);
  await pool.query(`UPDATE holds SET created_at = now() - interval '6 minutes', expires_at = now() - interval '1 minute' WHERE player_id = $1`, [b.id]);
  const late = await doPay(b);
  assert.equal(late.status, 410); assert.match(late.body.error, /5-minute hold expired/);
  assert.equal((await doHold(a, 5, [8])).status, 200, 'expired squares are free again');
  await call(hold.DELETE, '/api/hold', { token: a.token, method: 'DELETE' });
  assert.equal((await doPay(b, 'wallet')).status, 404);
  assert.equal((await doPay(a, 'bitcoin')).status, 400);
  await assertInvariants('after pay');
});

test('replay needs unlocked dollars; cash-out empties the wallet as a would-be-sent payout (16 h)', async () => {
  const [a] = await players(1);
  assert.equal((await doHold(a, 5, [(await emptySquares(5))[0]])).status, 200);
  const r = await call(replay.POST, '/api/replay', { token: a.token });
  assert.equal(r.status, 402); assert.match(r.body.error, /Not enough unlocked/);
  await call(hold.DELETE, '/api/hold', { token: a.token, method: 'DELETE' });
  // give the player $12 of winnings from a dev-style ledger credit on an old board bucket
  const bid = (await openBoard(5)).id;
  await pool.query(`INSERT INTO ledger (player_id, kind, bucket, board_id, amount, note) VALUES ($1, 'adjust', $2, $3, 12, 'test credit')`, [a.id, 'board:' + bid, bid]);
  await pool.query('UPDATE wallets SET unlocked = 12 WHERE player_id = $1', [a.id]);
  const sq = (await emptySquares(5)).slice(0, 2);
  const rp = await (async () => { await doHold(a, 5, sq); return call(replay.POST, '/api/replay', { token: a.token }); })();
  assert.equal(rp.status, 200, JSON.stringify(rp.body));
  const m = await meOf(a);
  assert.equal(m.wallet.unlocked, 2);
  const c = await call(cashout.POST, '/api/cashout', { token: a.token });
  assert.equal(c.status, 200); assert.equal(c.body.amount, 2);
  const hrs = (Date.parse(c.body.sendBy) - Date.now()) / 36e5;
  assert.ok(hrs > 15.9 && hrs <= 16.01, 'would be sent within 16 h');
  assert.equal((await meOf(a)).wallet.unlocked, 0);
  assert.equal((await meOf(a)).payouts[0].kind, 'cashout');
  assert.equal((await call(cashout.POST, '/api/cashout', { token: a.token })).status, 400);
  await assertInvariants('after replay + cashout');
});

/* ---------------- full board ---------------- */
test('full board: 400 plays close exactly once, settle in order, reconcile, opt-out carry, Early Access, caps', async () => {
  // fresh $20 board for a clean run
  const ps = await players(22);
  const keepers = ps.slice(0, 3);
  for (const k of keepers) assert.equal((await call(keep.POST, '/api/keep', { token: k.token, body: { on: true } })).body.keepBalance, true);
  await feed(20);
  const b1 = await openBoard(20);
  // deterministic wallet activity: keepers 1-2 hold $30 of winnings on this board; player 5 holds $200 (for Replays)
  for (const [p, amt] of [[ps[1], 30], [ps[2], 30], [ps[5], 200]]) {
    await pool.query(`INSERT INTO ledger (player_id, kind, bucket, board_id, amount, note) VALUES ($1, 'adjust', $2, $3, $4, 'test winnings')`, [p.id, 'board:' + b1.id, b1.id, amt]);
    await pool.query('UPDATE wallets SET unlocked = unlocked + $2 WHERE player_id = $1', [p.id, amt]);
  }
  const free = shuffle(await emptySquares(20));
  // player 0 plays 10 first, then pre-picks 3 squares on the next board (Early Access)
  const ea = ps[0];
  await play(ea, 20, free.splice(0, 9));
  const gate = await doHold(ea, 20, [1, 2], true);
  assert.equal(gate.status, 403); assert.match(gate.body.error, /Play 10\+ squares/);
  await play(ea, 20, free.splice(0, 1));
  const pre = await doHold(ea, 20, [250, 3, 77], true);
  assert.equal(pre.status, 200, JSON.stringify(pre.body)); assert.equal(pre.body.hold.n, b1.n + 1); assert.equal(pre.body.hold.early, true);
  const pp = await doPay(ea);
  assert.equal(pp.status, 200); assert.equal(pp.body.early, true);
  assert.equal((await feed(20)).next.prepicked, 3);
  // everyone else fills the board; players with winnings sometimes Replay from their wallet
  let replays = 0;
  for (let round = 0; round < 200; round++) {
    const b = await openBoard(20);
    if (!b || b.n !== b1.n) break;
    const p = ps[1 + (round % 21)];
    const m = await meOf(p);
    const room = Math.min(m.boards["20"].roomLeft, 400 - b.plays, 5 + (round % 4));
    if (room <= 0) continue;
    const wallet = m.wallet.unlocked >= room * 20;
    const r = await play(p, 20, free.splice(0, room), wallet ? 'wallet' : 'xmoney_sim');
    if (wallet) replays++;
    if (r.closedBoard) { assert.equal(r.board.plays, 400); break; }
  }
  const { rows: closed } = await pool.query(`SELECT id, n, reason, plays FROM boards WHERE stake = 20 AND status = 'closed' AND n >= $1`, [b1.n]);
  assert.deepEqual(closed.map(x => [x.n, x.reason, x.plays]), [[b1.n, 'full', 400]], 'closed exactly once, at 400');
  const { s } = await reconcile(b1.id);
  assert.equal(s.undrawnBig, 0); assert.deepEqual(s.unselected, [], 'full board: nothing left unselected');
  assert.equal(s.bigs.length, 2);
  // opt-out: keepers who had a balance carried it to the next board, and the flag reset; others got payouts
  const b2 = await openBoard(20);
  for (const k of keepers) {
    const { rows: [c] } = await pool.query(`SELECT coalesce(sum(amount), 0) AS v FROM ledger WHERE player_id = $1 AND bucket = $2`, [k.id, 'carry:' + b2.id]);
    const { rows: [pk] } = await pool.query('SELECT keep_balance FROM players WHERE id = $1', [k.id]);
    const { rows: [po] } = await pool.query(`SELECT count(*)::int AS n FROM payouts WHERE player_id = $1 AND board_id = $2 AND kind = 'close'`, [k.id, b1.id]);
    if (num(c.v) > 0) { assert.equal(pk.keep_balance, false, 'opt-out resets after it is used'); assert.equal(po.n, 0, 'carried, not paid'); }
  }
  const { rows: [pay1] } = await pool.query(`SELECT coalesce(sum(amount), 0) AS v FROM payouts WHERE board_id = $1 AND kind = 'close'`, [b1.id]);
  const { rows: [car1] } = await pool.query(`SELECT coalesce(sum(amount), 0) AS v FROM ledger WHERE bucket = $1 AND kind = 'carry'`, ['carry:' + b2.id]);
  const { rows: [held1] } = await pool.query(`SELECT coalesce(sum(amount), 0) AS v FROM ledger WHERE bucket = $1 AND kind NOT IN ('payout', 'carry')`, ['board:' + b1.id]);
  assert.equal(r2(num(pay1.v) + num(car1.v)), r2(num(held1.v)), 'board balances = auto payouts + carried');
  // Early Access picks were played first on the next board, in square order
  const { rows: early } = await pool.query(`SELECT idx, play_no, via FROM plays WHERE board_id = $1 ORDER BY play_no`, [b2.id]);
  assert.deepEqual(early.map(x => [x.idx, x.play_no, x.via]), [[3, 1, 'early'], [77, 2, 'early'], [250, 3, 'early']]);
  const { rows: pl } = await pool.query(`SELECT count(*)::int AS n FROM ledger WHERE player_id = $1 AND kind = 'preplay'`, [ea.id]);
  assert.equal(pl[0].n, 3);
  // boards played went up for everyone who played
  const { rows: bp } = await pool.query(`SELECT count(*)::int AS n FROM players WHERE boards_played < 1 AND id IN (SELECT player_id FROM plays WHERE board_id = $1)`, [b1.id]);
  assert.equal(bp[0].n, 0);
  await assertInvariants('after full close');
  // feed shows the closed board with its reveal
  const f = await feed(20);
  assert.equal(f.lastClosed.n, b1.n); assert.equal(f.lastClosed.reveal.order.length, 400); assert.equal(f.board.n, b1.n + 1);
  assert.equal(f.board.carryIn, s.carryOut);

  // a keeper with carried credit replays: carried credit is spent first
  const withCarry = [];
  for (const k of keepers) { const m = await meOf(k); const c = m.wallet.buckets.find(x => x.bucket === 'carry:' + b2.id); if (c) withCarry.push({ k, c: c.amount }); }
  assert.ok(withCarry.length >= 2, 'both funded keepers carried their balance');
  {
    const { k, c } = withCarry[0];
    assert.ok(c >= 30);
    await play(k, 20, (await emptySquares(20)).slice(0, 1), 'wallet');
    const m = await meOf(k);
    const after = (m.wallet.buckets.find(x => x.bucket === 'carry:' + b2.id) || { amount: 0 }).amount;
    assert.equal(after, r2(c - 20), 'replay spends carried credit first');
  }

  // stall: board 2 (a few plays) closes after 5 days; leftover prizes become Unselected; unused carry pays out
  await pool.query(`UPDATE boards SET stall_from = now() - interval '5 days 1 minute' WHERE id = $1`, [b2.id]);
  const f2 = await feed(20);
  assert.equal(f2.lastClosed.n, b2.n); assert.equal(f2.lastClosed.reason, 'stall'); assert.equal(f2.board.n, b2.n + 1);
  const { s: s2, b: bb2 } = await reconcile(b2.id);
  const left = bb2.bag_left;
  assert.equal(s2.unselected.length, left.double + left.big + left.host, 'every leftover prize is shown as Unselected');
  const { rows: used } = await pool.query('SELECT idx FROM plays WHERE board_id = $1', [b2.id]);
  assert.ok(s2.unselected.every(u => !used.some(x => x.idx === u.i)), 'Unselected prizes sit on empty squares');
  assert.equal(new Set(s2.unselected.map(u => u.i)).size, s2.unselected.length);
  assert.ok(s2.carryOut >= s2.undrawnBig * 100, 'undrawn Big Sends roll forward (host-funded)');
  const { rows: [cu] } = await pool.query(`SELECT coalesce(sum(amount), 0) AS v FROM ledger WHERE bucket = $1`, ['carry:' + b2.id]);
  assert.equal(num(cu.v), 0, 'carried credit unused at the next close was paid out');
  const { rows: [x] } = await pool.query(`SELECT count(*)::int AS n FROM payouts WHERE kind = 'carry_unused' AND board_id = $1`, [b2.id]);
  assert.ok(x.n >= 2, 'unused carried credit paid out at the next close');
  // after 2 boards the cap is 40
  const m0 = await meOf(ea);
  assert.equal(m0.player.boardsPlayed, 2); assert.equal(m0.player.cap, 40);
  await assertInvariants('after stall close');
  assert.ok(replays >= 1, 'at least one wallet Replay during the fill');
});

test('stall: an empty board restarts its clock instead of closing; cron tick is idempotent', async () => {
  const b = await openBoard(5);
  await pool.query(`DELETE FROM holds`);
  // move $5 to a fresh empty board by closing the current one through the stall rule
  await pool.query(`UPDATE boards SET stall_from = now() - interval '6 days' WHERE id = $1`, [b.id]);
  await feed(5);
  const e = await openBoard(5);
  assert.equal(e.n, b.n + 1); assert.equal(e.plays, 0);
  await pool.query(`UPDATE boards SET stall_from = now() - interval '6 days' WHERE id = $1`, [e.id]);
  const t = await call(cron.GET, '/api/cron/tick', { method: 'GET' });
  assert.equal(t.status, 200);
  const e2 = await openBoard(5);
  assert.equal(e2.id, e.id, 'empty board stays open'); assert.ok(Date.now() - Date.parse(e2.stall_from) < 60e3, 'clock restarted');
  const t2 = await call(cron.GET, '/api/cron/tick', { method: 'GET' });
  assert.deepEqual(t2.body.boards.map(x => x.closed), [null, null]);
  process.env.CRON_SECRET = 'cron-secret-for-tests-123';
  assert.equal((await call(cron.GET, '/api/cron/tick', { method: 'GET' })).status, 401);
  const ok = await cron.GET(req('/api/cron/tick', { headers: { authorization: 'Bearer cron-secret-for-tests-123' } }));
  assert.equal(ok.status, 200);
  delete process.env.CRON_SECRET;
  await assertInvariants('after stall/tick');
});

/* ---------------- concurrency ---------------- */
test('concurrency: 19 players fill 380 in parallel, then 50 race for the last 20 squares; one close at 400', async () => {
  const fillers = await players(19);
  const start = await openBoard(5);
  assert.equal(start.plays, 0);
  const free = shuffle(await emptySquares(5));
  const slices = fillers.map((_, i) => free.slice(i * 20, i * 20 + 20));
  const fill = await Promise.all(fillers.map(async (p, i) => {
    const h = await doHold(p, 5, slices[i]); if (h.status !== 200) return h;
    return doPay(p);
  }));
  assert.deepEqual(fill.map(r => r.status), Array(19).fill(200), JSON.stringify(fill.find(r => r.status !== 200)));
  assert.equal((await openBoard(5)).plays, 380);
  // 50 racers each try to hold 2 squares out of the same 30 contested squares
  const racers = await players(50);
  const contested = free.slice(380, 410);
  const holds = await Promise.all(racers.map(p => doHold(p, 5, shuffle(contested.slice()).slice(0, 2))));
  const won = racers.filter((_, i) => holds[i].status === 200);
  const heldSq = won.flatMap((_, i) => holds[racers.indexOf(won[i])].body.hold.squares);
  assert.equal(new Set(heldSq).size, heldSq.length, 'no square held twice');
  assert.ok(heldSq.length <= 20, 'holds never exceed the 20 squares left');
  assert.ok(holds.every(h => [200, 409].includes(h.status)), holds.map(h => h.status).join());
  // let the losers grab whatever room is left so the board can reach exactly 400
  let room = 400 - 380 - heldSq.length;
  const extra = [];
  for (const p of racers.filter(p => !won.includes(p))) {
    if (room <= 0) break;
    const sq = (await emptySquares(5)).slice(0, 1);
    const h = await doHold(p, 5, sq);
    if (h.status === 200) { extra.push(p); room--; }
  }
  const pays = await Promise.all([...won, ...extra].map(p => doPay(p)));
  assert.ok(pays.every(r => r.status === 200), pays.map(r => r.status + ':' + (r.body.error || '')).join());
  const closers = pays.filter(r => r.body.closedBoard);
  assert.equal(closers.length, 1, 'exactly one payment closed the board');
  const { rows } = await pool.query(`SELECT n, status, plays FROM boards WHERE stake = 5 AND n >= $1 ORDER BY n`, [start.n]);
  assert.deepEqual(rows.map(r => [r.n, r.status, r.plays]), [[start.n, 'closed', 400], [start.n + 1, 'open', 0]]);
  const { rows: [d] } = await pool.query(`SELECT count(*)::int AS n, count(DISTINCT idx)::int AS sq, count(DISTINCT play_no)::int AS k FROM plays WHERE board_id = $1`, [start.id]);
  assert.deepEqual(d, { n: 400, sq: 400, k: 400 }, 'no double squares or tickets');
  const { rows: [bag] } = await pool.query('SELECT bag_left FROM boards WHERE id = $1', [start.id]);
  assert.deepEqual(bag.bag_left, { double: 0, big: 0, host: 0, patron: 0 }, 'every ticket drawn exactly once');
  await reconcile(start.id);
  await assertInvariants('after race');
});

test('concurrency: parallel cash-out and wallet replay for the same player never overdraw', async () => {
  const [a] = await players(1);
  const bid = (await openBoard(5)).id;
  await pool.query(`INSERT INTO ledger (player_id, kind, bucket, board_id, amount, note) VALUES ($1, 'adjust', $2, $3, 10, 'test credit')`, [a.id, 'board:' + bid, bid]);
  await pool.query('UPDATE wallets SET unlocked = 10 WHERE player_id = $1', [a.id]);
  assert.equal((await doHold(a, 5, (await emptySquares(5)).slice(0, 2))).status, 200);
  const [c, r] = await Promise.all([call(cashout.POST, '/api/cashout', { token: a.token }), doPay(a, 'wallet')]);
  const ok = [c.status, r.status].sort().join();
  assert.ok(ok === '200,402' || ok === '200,400', 'one wins, the other sees an empty wallet: ' + ok);
  assert.equal((await meOf(a)).wallet.unlocked, 0);
  await assertInvariants('after cashout race');
});

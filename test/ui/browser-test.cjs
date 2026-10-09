// Tip board v2 (shared boards) browser test (puppeteer-core + Chrome; not part of `npm test`).
// Start the local server first:  node test/server.js 8833   then: node test/ui/browser-test.cjs (with puppeteer-core installed)
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const BASE = process.env.TB_URL || 'http://127.0.0.1:8833', URL0 = BASE + '/';
const SHOTS = '/workspace/tip-board/shots/', DL = '/tmp/tb-dl';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  — ' + detail : ''}`); };
async function waitFor(fn, ms = 8000, step = 100) { const t0 = Date.now(); let v; while (Date.now() - t0 < ms) { try { v = await fn(); if (v) return v; } catch { } await sleep(step); } return v; }

/* ---- direct API helpers (other players) ---- */
async function call(path, { token, method = 'GET', body } = {}) {
  const headers = {}; if (token) headers.authorization = 'Bearer ' + token; if (body) headers['content-type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const ct = r.headers.get('content-type') || ''; return { status: r.status, headers: r.headers, body: ct.includes('json') ? await r.json() : await r.text() };
}
const newApiPlayer = async () => (await call('/api/session', { method: 'POST' })).body;
async function apiPlay(token, stake, squares, method = 'xmoney_sim', early = false) {
  const h = await call('/api/hold', { token, method: 'POST', body: { stake, squares, early } });
  if (h.status !== 200) return h;
  return call('/api/pay', { token, method: 'POST', body: { method } });
}
async function emptySquares(stake) { const f = (await call(`/api/board/${stake}`)).body; const used = new Set([...f.squares.map(s => s[0]), ...f.held]); const o = []; for (let i = 0; i < 500; i++) if (!used.has(i)) o.push(i); return o; }
async function fillPlays(stake, count) { // other players add `count` plays (20 max each)
  let left = count; while (left > 0) { const p = await newApiPlayer(); const e = (await emptySquares(stake)).slice(-Math.min(20, left)); const r = await apiPlay(p.token, stake, e); if (r.status !== 200) throw new Error('fill failed ' + JSON.stringify(r.body)); left -= e.length; }
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true }); fs.rmSync(DL, { recursive: true, force: true }); fs.mkdirSync(DL, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: 'new', args: ['--no-sandbox', '--disable-gpu'] });
  const errs = [];
  const wire = p => { p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); });
    p.on('dialog', d => d.accept(d.type() === 'prompt' && p.__prompt ? p.__prompt(d.message()) : undefined)); };
  async function newPage(vp = { width: 1360, height: 1000 }, path = '', pre) {
    const ctx = await browser.createBrowserContext(); const p = await ctx.newPage(); wire(p); await p.setViewport(vp);
    if (pre) await p.evaluateOnNewDocument(pre);
    await p.goto(URL0 + path, { waitUntil: 'load' });
    await waitFor(() => p.evaluate(() => !!(window.__tip && window.__tip.API.me && window.__tip.API.feed[5])));
    return p;
  }
  async function onboard(p) {
    await waitFor(() => p.$('.modal[data-kind=name]'));
    await p.click('input[value=anon]'); await p.click('#agree'); await p.click('[data-act=saveName]');
    await waitFor(() => p.evaluate(() => !document.querySelector('.modal[data-kind=name]')));
  }
  const tokenOf = p => p.evaluate(() => localStorage.getItem('grokTipBoard.token'));
  const text = p => p.evaluate(() => document.body.innerText);
  const tileCls = (p, i) => p.$eval(`#grid > div[data-i="${i}"]`, e => e.className);
  const tileTitle = (p, i) => p.$eval(`#grid > div[data-i="${i}"]`, e => e.title);
  async function manual(p, s) { await p.$eval('#manualIn', (e, v) => { e.value = v; }, s); await p.click('#manualForm button[type=submit]'); await sleep(80); return p.$eval('#manualMsg', e => ({ text: e.textContent, bad: e.classList.contains('bad') })); }
  async function payFlow(p, method = 'paySim') { // after selecting: hold -> pay modal -> simulate -> flips -> result modal
    await p.click('[data-act=hold]');
    await waitFor(() => p.$('.modal[data-kind=pay]'));
    await p.click(`[data-act=${method}]`);
    await waitFor(() => p.$('.modal[data-kind=result],.modal[data-kind=prepick]'), 20000);
  }

  /* ---------- A. boot: loading state, one-time reset notice, old state cleared, onboarding without X handles ---------- */
  let A;
  {
    const ctx = await browser.createBrowserContext(); const p = await ctx.newPage(); wire(p); await p.setViewport({ width: 1360, height: 1000 });
    await p.evaluateOnNewDocument(() => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('grokTipBoard.v1', JSON.stringify({ v: 1, me: { x: 'DirkMannis' } })); } });
    await p.setRequestInterception(true);
    let slow = true; const slowH = r => { if (slow && r.url().includes('/api/board/')) setTimeout(() => r.continue(), 1200); else r.continue(); }; p.on('request', slowH);
    await p.goto(URL0, { waitUntil: 'domcontentloaded' });
    await sleep(300);
    const nb = await p.$eval('#netbar', e => ({ hidden: e.hidden, text: e.textContent }));
    check('loading state shown while the board loads', !nb.hidden && /Loading/.test(nb.text), nb.text);
    check('grid shows a loading skeleton', await p.$eval('#grid', e => e.classList.contains('loading')));
    slow = false;
    await waitFor(() => p.evaluate(() => !!(window.__tip.API.me && window.__tip.API.feed[5])));
    check('old local game state (grokTipBoard.v1) cleared', await p.evaluate(() => localStorage.getItem('grokTipBoard.v1') === null));
    check('netbar hides once loaded', await waitFor(() => p.$eval('#netbar', e => e.hidden)));
    const notice = await p.$eval('#resetNotice', e => !e.hidden && e.innerText);
    check('one-time notice: "Beta reset: boards are now multiplayer. Everyone sees the same board."', notice && notice.includes('Beta reset: boards are now multiplayer. Everyone sees the same board.'));
    await waitFor(() => p.$('.modal[data-kind=name]'));
    check('onboarding: X handle option is disabled until Sign in with X', await p.$eval('input[name=mode][value=x]', e => e.disabled));
    check('onboarding: no typed @handle field', !(await p.$('#nmX')));
    await onboard(p);
    const name = await p.$eval('#walletName', e => e.textContent);
    check('wallet header shows the API name ("Player 0123" style)', /^Player \d{4,}$/.test(name), name);
    check('no hardcoded @DirkMannis anywhere', !(await text(p)).includes('DirkMannis'));
    await p.click('[data-act=dismissNotice]');
    check('notice dismissed', await p.$eval('#resetNotice', e => e.hidden));
    p.off('request', slowH); await p.setRequestInterception(false);
    await p.reload({ waitUntil: 'load' }); await waitFor(() => p.evaluate(() => !!window.__tip.API.me));
    check('notice stays dismissed after reload (one-time)', await p.$eval('#resetNotice', e => e.hidden));
    check('no onboarding again after reload', !(await p.$('.modal[data-kind=name]')));
    check('same player after reload (token kept in localStorage)', (await p.$eval('#walletName', e => e.textContent)) === name);
    A = p;
  }

  /* ---------- B. DEV hidden unless ?dev=1; admin needs a key (PR 4) ---------- */
  {
    const vis = p => p.$eval('#devToggle', e => { const r = e.getBoundingClientRect(); return !e.hidden && getComputedStyle(e).display !== 'none' && r.width > 0; });
    check('DEV button hidden without ?dev=1', !(await vis(A)));
    const p = await newPage(undefined, '?dev=1'); await onboard(p);
    check('DEV button visible with ?dev=1', await vis(p));
    await p.click('#devToggle'); await sleep(150);
    const dp = await p.$eval('#devPanel', e => ({ text: e.innerText, key: !!e.querySelector('[data-dev=adminKey]'), adm: !!e.querySelector('#admPanel') }));
    check('DEV panel no longer says "admin tools arrive in PR 4"', !/arrive in PR ?4/i.test(dp.text), dp.text.slice(0, 200));
    check('DEV panel asks for the admin key (sessionStorage only) before showing admin actions', dp.key && !dp.adm && /sessionStorage only/.test(dp.text));
    await p.browserContext().close();
  }

  /* ---------- C. Rules: 5-min hold, no Lifetime ---------- */
  {
    await A.click('#rulesBtn'); await sleep(150);
    const r = await A.$eval('#rulesBody', e => e.innerText);
    check('rules say squares are held 5 min', /held 5 min/.test(r));
    check('rules have no 15-minute hold text', !/15[ -]min/i.test(r));
    check('rules have no Lifetime +/−', !/lifetime/i.test(r));
    check('rules keep a history/CSV section', /history log can be downloaded as CSV/.test(r));
    check('rules disclose the bots: "Beta boards include labeled 🤖 practice players so boards close; removed before real money"', r.includes('Beta boards include labeled 🤖 practice players so boards close; removed before real money'));
    check('rules link to the Fairness page (/fair)', await A.$eval('#rulesBody', e => !!e.querySelector('a[href="/fair"]')));
    await A.screenshot({ path: SHOTS + '10-desktop-rules.png' });
    await A.click('[data-close-drawer]');
  }

  /* ---------- D. Two browsers + hold -> pay -> sequential flip ---------- */
  let B;
  {
    B = await newPage(); await onboard(B);
    const bName = await B.$eval('#walletName', e => e.textContent), aName = await A.$eval('#walletName', e => e.textContent);
    check('two browsers are two different players', aName !== bName, `${aName} / ${bName}`);
    const m = await manual(A, '1, 2, 3');
    check('manual entry adds 3 squares', !m.bad && /Added #1, #2, #3/.test(m.text), m.text);
    await A.click('[data-act=hold]');
    await waitFor(() => A.$('.modal[data-kind=pay]'));
    const pay = await A.$eval('.modal[data-kind=pay]', e => e.innerText);
    const timer = await A.$eval('#payLeft', e => e.textContent);
    check('pay modal shows a GROK code', /GROK-[A-Z2-9]{3,6}/.test(pay));
    check('hold timer is 5 minutes', /^[45]m \d\ds$/.test(timer) && /5-min hold/.test(pay), timer);
    await A.screenshot({ path: SHOTS + '10-desktop-pay.png' });
    // B sees A's held squares as held-by-someone within a poll
    const heldSeen = await waitFor(async () => /heldx/.test(await tileCls(B, 0)), 6000);
    check('other browser sees the held squares within one poll', heldSeen);
    const bm = await manual(B, '2');
    check('manual entry refuses a square held by another player', bm.bad && /held by another player/.test(bm.text), bm.text);
    // record flip order
    await A.evaluate(() => { window.__flips = []; const g = document.getElementById('grid'); new MutationObserver(ms => { for (const m of ms) { const el = m.target; if (el.classList && el.classList.contains('flip-in')) window.__flips.push(+el.dataset.i); } }).observe(g, { attributes: true, subtree: true, attributeFilter: ['class'] }); });
    await A.click('[data-act=paySim]');
    const drawing = await waitFor(() => A.evaluate(() => document.querySelectorAll('#grid .drawing').length), 3000, 30);
    check('tiles show "drawing" before they flip', drawing >= 1, String(drawing));
    await waitFor(() => A.$('.modal[data-kind=result]'), 15000);
    const flips = await A.evaluate(() => [...new Set(window.__flips)]);
    check('own draws flip one at a time in square order', JSON.stringify(flips) === '[0,1,2]', JSON.stringify(flips));
    const res = await A.$eval('.modal[data-kind=result]', e => e.innerText);
    check('result modal lists all 3 squares', ['#1 ·', '#2 ·', '#3 ·'].every(s => res.includes(s)));
    check('result modal has a share post', /Share it/.test(res) && await A.$('.modal[data-kind=result] a[href^="https://x.com/intent/post"]'));
    await A.click('.modal [data-close]');
    const aCls = await tileCls(A, 0);
    check('own tiles marked "mine"', /mine/.test(aCls) && /(double|big|host|patron)/.test(aCls), aCls);
    const seen = await waitFor(async () => /(double|big|host|patron)/.test(await tileCls(B, 0)) && /(double|big|host|patron)/.test(await tileCls(B, 2)), 6000);
    check('other browser sees the plays within one poll (≤ 6 s)', seen);
    check('other browser does not mark them as its own', !/mine/.test(await tileCls(B, 0)));
    check('tile title names the player from the API', (await tileTitle(B, 0)).includes(aName), await tileTitle(B, 0));
    const bm2 = await manual(B, '3');
    check('manual entry refuses a square already played (server state)', bm2.bad && /#3 is already played/.test(bm2.text), bm2.text);
    // B plays, A sees it
    await manual(B, '10'); await payFlow(B); await B.click('.modal [data-close]');
    check('first browser sees the second browser’s play within one poll', await waitFor(async () => /(double|big|host|patron)/.test(await tileCls(A, 9)), 6000));
    // two-browser composite screenshot
    await A.screenshot({ path: '/tmp/tbA.png' }); await B.screenshot({ path: '/tmp/tbB.png' });
    const comp = await browser.newPage(); await comp.setViewport({ width: 2740, height: 1000 });
    const b64 = f => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
    await comp.setContent(`<body style="margin:0;background:#000;display:flex;gap:20px"><img src="${b64('/tmp/tbA.png')}" width="1360"><img src="${b64('/tmp/tbB.png')}" width="1360"></body>`);
    await sleep(200); await comp.screenshot({ path: SHOTS + '10-two-browsers.png' }); await comp.close();
  }

  /* ---------- E. manual entry validation ---------- */
  {
    const t1 = await manual(A, 'abc'); check('manual: rejects non-numbers', t1.bad && /isn't a square number/.test(t1.text));
    const t2 = await manual(A, '501'); check('manual: rejects out of range', t2.bad && /out of range \(1–500\)/.test(t2.text));
    const t3 = await manual(A, '20 21 22 23 24 25'); check('manual: max 5 at a time', t3.bad && /Up to 5 squares/.test(t3.text));
    const t4 = await manual(A, '30, 30'); check('manual: rejects duplicates', t4.bad && /listed twice/.test(t4.text));
    const t5 = await manual(A, '1'); check('manual: refuses own played square', t5.bad && /#1 is already played \(by you\)/.test(t5.text), t5.text);
    await A.click('[data-act=clearSel]').catch(() => { });
  }

  /* ---------- F. cap (server-enforced, shown in UI) ---------- */
  {
    const C = await newPage(); await onboard(C);
    const tok = await tokenOf(C);
    const e = (await emptySquares(5)).slice(0, 20);
    const r = await apiPlay(tok, 5, e);
    check('API: 20 squares played for a new player', r.status === 200);
    const over = await call('/api/hold', { token: tok, method: 'POST', body: { stake: 5, squares: [(await emptySquares(5))[0]] } });
    check('server refuses the 21st square (cap 20)', over.status === 409, JSON.stringify(over.body));
    await C.evaluate(() => window.__tip.refreshAll());
    const free = (await emptySquares(5))[0] + 1;
    const m = await manual(C, String(free));
    check('UI blocks picks past the cap', m.bad && /cap of 20/.test(m.text), m.text);
    check('header shows 20/20', /20<\/b>\/20/.test(await C.$eval('#boardHead', e => e.innerHTML)));
    const pid = (await call('/api/me', { token: tok })).body.player.id;
    await call(`/__test/boardsPlayed?player=${pid}&n=2`);
    await C.evaluate(() => window.__tip.refreshAll());
    const m2 = await manual(C, String(free));
    check('cap rises to 40 after 2 boards', !m2.bad, m2.text);
    await C.browserContext().close();
  }

  /* ---------- G. Early Access gating ---------- */
  {
    await A.click('[data-view=next]'); await sleep(150);
    check('next board is locked before 10 plays', await A.$eval('#gridLock', e => !e.hidden));
    const m = await manual(A, '5');
    check('manual entry on locked next board explains Early Access', m.bad && /isn't open yet/.test(m.text), m.text);
    check('no Early Access button yet', !(await A.$('[data-act=eaStart]')));
    await A.click('[data-view=open]');
    // A reaches 10 squares on $5
    const e = (await emptySquares(5)).slice(0, 7);
    await manual(A, e.slice(0, 5).map(i => i + 1).join(',')); await payFlow(A); await A.click('.modal [data-close]');
    await manual(A, e.slice(5).map(i => i + 1).join(',')); await payFlow(A); await A.click('.modal [data-close]');
    await A.click('[data-view=next]'); await sleep(150);
    check('Early Access unlocked at 10 plays', !!(await A.$('[data-act=eaStart]')));
    await A.click('[data-act=eaStart]'); await sleep(100);
    await manual(A, '7, 8');
    await payFlow(A);
    check('Early Access picks paid and locked', !!(await A.$('.modal[data-kind=prepick]')));
    await A.click('.modal [data-close]'); await sleep(200);
    await A.click('[data-view=next]').catch(() => { }); await sleep(200);
    check('pre-picked squares shown on the next board', /pre/.test(await tileCls(A, 6)) && /pre/.test(await tileCls(A, 7)));
    await A.click('[data-view=open]');
  }

  /* ---------- H. opt-out toggle ---------- */
  {
    const tok = await tokenOf(A);
    await A.click('#keepBal');
    check('opt-out on (server)', await waitFor(async () => (await call('/api/me', { token: tok })).body.player.keepBalance === true));
    check('opt-out shows as on', await waitFor(() => A.$eval('#keepBal', e => e.checked)));
    await A.click('#keepBal');
    check('opt-out off again (server)', await waitFor(async () => (await call('/api/me', { token: tok })).body.player.keepBalance === false));
  }

  /* ---------- I. cash-out (unlock via the 20-play ladder on $20) ---------- */
  {
    const tok = await tokenOf(A);
    await A.click('.tab[data-stake="20"]'); await waitFor(() => A.evaluate(() => window.__tip.active === 20));
    const e = (await emptySquares(20)).slice(0, 10);
    for (const chunk of [e.slice(0, 5), e.slice(5)]) { await manual(A, chunk.map(i => i + 1).join(' ')); await payFlow(A); await A.click('.modal [data-close]'); }
    await fillPlays(20, 30); // 40 plays -> two milestones
    const u = await waitFor(async () => (await call('/api/me', { token: tok })).body.wallet.unlocked, 4000);
    check('A has unlocked dollars after the 20/40-play unlocks', u > 0, '$' + u);
    await A.evaluate(() => window.__tip.refreshAll());
    const shown = await A.$eval('#walUnlocked', e => e.textContent);
    check('wallet shows the unlocked amount', shown === '$' + (u % 1 ? u.toFixed(2) : u), shown);
    await A.screenshot({ path: SHOTS + '10-desktop-board.png' });
    const side = await A.$('aside.side'); await side.screenshot({ path: SHOTS + '10-desktop-wallet-history.png' });
    await A.click('[data-act=cashOut]');
    check('cash-out empties unlocked', await waitFor(async () => (await call('/api/me', { token: tok })).body.wallet.unlocked === 0));
    check('cash-out listed in wallet', await waitFor(async () => /Cash-out request/.test(await A.$eval('#walletCard', e => e.innerText))));
  }

  /* ---------- J. history + CSV (no lifetime columns) ---------- */
  {
    const tok = await tokenOf(A);
    await A.evaluate(() => window.__tip.refreshAll()); await sleep(500);
    const h = await A.$eval('#statsCard', e => e.innerText);
    check('history card lists plays, wins/unlocks and the cash-out', /Play/.test(h) && /Cash-out/.test(h), h.slice(0, 600).replace(/\n/g, ' | '));
    check('history card has no Lifetime', !/lifetime/i.test(h));
    const cdp = await browser.target().createCDPSession(); await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, browserContextId: A.browserContext().id });
    await A.evaluate(() => document.querySelector('[data-act=csv]').click());
    const f = await waitFor(() => { const x = fs.readdirSync(DL).filter(n => n.endsWith('.csv')); return x.length && x[0]; }, 6000);
    const csv = f ? fs.readFileSync(DL + '/' + f, 'utf8') : '';
    check('CSV downloaded', !!f, f || '');
    check('CSV header has no lifetime columns', csv.split('\n')[0] === 'time_utc,board,square,event,amount,pending,note', csv.split('\n')[0]);
    check('CSV has no "lifetime" anywhere', !/lifetime/i.test(csv));
    const api = await call('/api/me/history?limit=500', { token: tok });
    check('CSV rows = history entries', csv.trim().split('\n').length - 1 === api.body.total, `${csv.trim().split('\n').length - 1} vs ${api.body.total}`);
    check('history JSON is capped per page (≤ 200)', api.body.entries.length <= 200);
  }

  /* ---------- K. close summary from lastClosed (Unselected prizes), archive ---------- */
  {
    await A.click('.tab[data-stake="5"]'); await waitFor(() => A.evaluate(() => window.__tip.active === 5));
    await call('/__test/stall?stake=5');
    await B.evaluate(() => window.__tip.pollNow());
    const sm = await waitFor(() => A.$('.modal[data-kind=summary]'), 12000);
    check('close summary appears for the closed board', !!sm);
    const s = sm ? await A.$eval('.modal[data-kind=summary]', e => e.innerText) : '';
    check('summary reveals Unselected prizes', /Unselected prizes/.test(s) && (await A.$$('.modal .mini .ghost')).length > 0);
    check('summary shows my squares', /You: 10 squares/.test(s), (s.match(/You:[^\n]*/) || [''])[0]);
    check('summary has no Lifetime', !/lifetime/i.test(s));
    check('summary Fairness row links to /fair for this board', !!(await A.$('.modal[data-kind=summary] a[href="/fair?stake=5&n=1"]')));
    await A.screenshot({ path: SHOTS + '10-desktop-summary.png' });
    await A.click('.modal [data-close]');
    check('new board is open after close', await waitFor(() => A.evaluate(() => window.__tip.API.feed[5].board.n === 2)));
    check('archive lists the closed board', /\$5 Board #1/.test(await A.$eval('#archiveCard', e => e.innerText)));
    check('Early Access picks were played on the new board', await waitFor(async () => /mine/.test(await tileCls(A, 6)) && /mine/.test(await tileCls(A, 7)), 6000));
  }

  /* ---------- L. no "Lifetime" anywhere ---------- */
  {
    const html = await A.content();
    check('no "Lifetime" text anywhere in the page', !/lifetime/i.test(html));
    const src = fs.readFileSync('/workspace/creds-repo/index.html', 'utf8');
    check('no "Lifetime" or 15-minute hold in the shipped index.html', !/lifetime/i.test(src) && !/15[ -]min/i.test(src));
  }

  /* ---------- M. offline + server error states ---------- */
  {
    await A.setOfflineMode(true); await A.evaluate(() => window.__tip.pollNow());
    const off = await waitFor(() => A.$eval('#netbar', e => !e.hidden && e.textContent), 6000);
    check('offline state shown', /offline|reach the server/i.test(off || ''), off);
    await A.screenshot({ path: SHOTS + '10-desktop-offline.png' });
    await A.setOfflineMode(false); await A.evaluate(() => window.__tip.pollNow());
    check('recovers when back online', await waitFor(() => A.$eval('#netbar', e => e.hidden), 8000));
    await A.setRequestInterception(true);
    const h = r => { if (r.url().includes('/api/board/')) r.respond({ status: 500, contentType: 'application/json', body: '{"error":"Server error"}' }); else r.continue(); };
    A.on('request', h); await A.evaluate(() => window.__tip.pollNow());
    const er = await waitFor(() => A.$eval('#netbar', e => !e.hidden && e.className.includes('error') && e.textContent), 6000);
    check('server error state shown', !!er, er);
    A.off('request', h); await A.setRequestInterception(false); await A.evaluate(() => window.__tip.pollNow());
    check('recovers after the error', await waitFor(() => A.$eval('#netbar', e => e.hidden), 8000));
  }

  /* ---------- N. polling pauses while hidden ---------- */
  {
    const n0 = []; const onReq = r => { if (r.url().includes('/api/board/')) n0.push(Date.now()); };
    B.on('request', onReq);
    await sleep(4500); const visible = n0.length;
    await B.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    n0.length = 0; await sleep(9000); const hidden = n0.length;
    await B.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    B.off('request', onReq);
    check('polls about every 4 s while visible', visible >= 1, String(visible));
    check('no polling while the tab is hidden', hidden === 0, String(hidden));
  }

  /* ---------- O. mobile layout ---------- */
  {
    const M = await newPage({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await onboard(M);
    const lay = await M.evaluate(() => { const g = document.getElementById('grid').getBoundingClientRect(); const t = document.querySelector('#grid > div').getBoundingClientRect();
      const top0 = t.top; return { sw: document.scrollingElement.scrollWidth, gw: g.width, tw: Math.round(t.width * 10) / 10, cols: [...document.querySelectorAll('#grid > div')].filter(e => Math.abs(e.getBoundingClientRect().top - top0) < 1).length }; });
    check('mobile: no horizontal scroll', lay.sw <= 390, JSON.stringify(lay));
    check('mobile: grid fits the screen, 20 columns', lay.gw <= 390 && lay.cols === 20, JSON.stringify(lay));
    await M.screenshot({ path: SHOTS + '10-mobile-board.png' });
    await (await M.$('#walletCard')).scrollIntoView(); await sleep(200);
    await M.screenshot({ path: SHOTS + '10-mobile-wallet.png' });
    await (await M.$('#statsCard')).scrollIntoView(); await sleep(200);
    await M.screenshot({ path: SHOTS + '10-mobile-history.png' });
    await M.click('#rulesBtn'); await sleep(250);
    await M.screenshot({ path: SHOTS + '10-mobile-rules.png' });
    check('mobile: rules drawer shows the 5-min hold', /held 5 min/.test(await M.$eval('#rulesBody', e => e.innerText)));
    await M.browserContext().close();
  }

  /* ---------- P. PR 4: friendly 429, admin dev panel, 🤖 bots, /fair verify + exports ---------- */
  const ADMIN_KEY = 'local-test-admin-key-0123456789';
  {
    // friendly 429: this player has used up the per-minute write budget
    const myId = await A.evaluate(() => window.__tip.API.me.player.id);
    await call(`/__test/rateFill?player=${myId}&n=30`);
    const before = await A.$eval('#keepBal', e => e.checked);
    await A.click('#keepBal');
    const t = await waitFor(() => A.evaluate(() => { const x = [...document.querySelectorAll('.toast.slow')].pop(); return x && x.textContent; }), 4000);
    check('rate limit: friendly 429 toast ("take a breather … try again in N s")', /🐢/.test(t || '') && /breather/.test(t || '') && /try again in \d+ s/.test(t || ''), t);
    check('rate limit: the toggle snaps back (nothing changed on the server)', await waitFor(async () => (await A.$eval('#keepBal', e => e.checked)) === before, 3000));
    await A.screenshot({ path: SHOTS + '11-desktop-429-toast.png' });
    await call('/__test/rateClear');
  }
  let D;
  const domClick = (pg, sel) => pg.evaluate(q => { const e = document.querySelector(q); if (!e) return false; e.click(); return true; }, sel);
  {
    D = await newPage(undefined, '?dev=1'); await onboard(D);
    await D.click('#devToggle'); await sleep(200);
    D.__prompt = () => 'wrong-key-wrong-key';
    await D.click('[data-dev=adminKey]');
    const bad = await waitFor(() => D.$eval('#devAdmin', e => e.innerText.includes('not accepted') && e.innerText), 4000);
    check('admin: a wrong key is refused (404 → "not accepted") and forgotten', !!bad && await D.evaluate(() => sessionStorage.getItem('grokTipBoard.adminKey') === null), bad);
    D.__prompt = () => ADMIN_KEY;
    await D.click('[data-dev=adminKey]');
    check('admin: correct key unlocks the admin controls', !!(await waitFor(() => D.$('#admPanel'), 5000)));
    check('admin: key kept in sessionStorage only (not localStorage)', await D.evaluate(k => sessionStorage.getItem('grokTipBoard.adminKey') === k && !Object.keys(localStorage).some(x => (localStorage.getItem(x) || '').includes(k)), ADMIN_KEY));
    // bots on, fast; pretend they've been idle an hour; feed polls let them catch up 20 plays at a time
    const idle = () => waitFor(() => D.evaluate(() => !window.__tip.ADM.busy && !!document.getElementById('admPanel') && ![...document.querySelectorAll('#devAdmin [data-dev^="adm:"]')].some(b => b.disabled)), 5000);
    await domClick(D, '#admBotsOn'); await sleep(100); await idle();
    await D.select('#admSpeed', '3600'); await idle(); await domClick(D, '[data-dev="adm:speed"]'); await sleep(100); await idle();
    const st = await waitFor(async () => { const r = await fetch(BASE + '/api/admin/status', { headers: { 'x-admin-key': ADMIN_KEY } }); const j = await r.json(); return j.bots.enabled && j.bots.perHour === 3600 && j; }, 5000);
    check('admin: bots on + speed set through the panel', !!st);
    check('admin: status without the key is a 404', (await call('/api/admin/status')).status === 404);
    const start = await D.evaluate(() => window.__tip.API.feed[5].board.plays);
    await call('/__test/bots?stake=5&minutes=60');
    const grown = await waitFor(async () => { await D.evaluate(() => window.__tip.pollNow()); const n = await D.evaluate(() => window.__tip.API.feed[5].board.plays); return n >= start + 60 && n; }, 30000, 600);
    check('bots: lazy catch-up on feed requests (20 per request)', !!grown, `${start} → ${grown}`);
    await D.evaluate(() => window.__tip.refreshAll());
    const ui = await D.evaluate(() => ({ botTiles: document.querySelectorAll('#grid .tile.bot').length, patronBots: [...document.querySelectorAll('#grid .tile.patron.bot')].every(t => t.textContent === '🤖'),
      title: (document.querySelector('#grid .tile.bot') || {}).title || '', pill: (document.querySelector('.botpill') || {}).textContent || '', flips: document.getElementById('feedList').innerText,
      legend: document.querySelector('.legend').innerText, feedNote: document.getElementById('feedCard').innerText }));
    check('bots: tiles are labeled 🤖 (class + patron icon + title)', ui.botTiles >= 60 && ui.patronBots && /🤖 .*practice player/.test(ui.title), JSON.stringify({ n: ui.botTiles, t: ui.title }));
    check('bots: header pill says practice players are on', /🤖 Practice players on/.test(ui.pill), ui.pill);
    check('bots: latest flips label them 🤖', /🤖/.test(ui.flips) && /practice player/.test(ui.feedNote));
    check('bots: legend explains 🤖', /🤖\s*Practice player/.test(ui.legend), ui.legend);
    await D.click('#devToggle'); await sleep(100);
    await D.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove()));
    await D.screenshot({ path: SHOTS + '11-desktop-board-bots.png' });
    await D.click('#devToggle'); await sleep(300);
    // credit top-up for my own player id (prefilled)
    const u0 = await D.evaluate(() => window.__tip.API.me.wallet.unlocked);
    await D.$eval('#admAmt', e => { e.value = '50'; }); await idle(); await domClick(D, '[data-dev="adm:credit"]');
    check('admin: credit top-up lands in the wallet', await waitFor(async () => (await D.evaluate(() => window.__tip.API.me.wallet.unlocked)) === u0 + 50, 6000));
    await waitFor(() => D.evaluate(() => /credit/.test(document.getElementById('admAudit').innerText)), 4000);
    await D.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove()));
    await D.screenshot({ path: SHOTS + '11-desktop-dev-panel.png' });
    // force close via the panel → admin summary with a /fair link; bots' Big Sends carry 🤖
    const n5 = await D.evaluate(() => window.__tip.API.feed[5].board.n);
    await idle(); await domClick(D, '[data-dev="adm:close"]');
    const sm = await waitFor(() => D.$('.modal[data-kind=summary]'), 12000);
    const stxt = sm ? await D.$eval('.modal[data-kind=summary]', e => e.innerText) : '';
    check('admin: force close → summary "Closed by admin"', /Closed by admin/.test(stxt), stxt.split('\n')[0]);
    check('admin: summary links to /fair for that board', !!(await D.$(`.modal[data-kind=summary] a[href="/fair?stake=5&n=${n5}"]`)));
    const bigs = await call(`/api/board/5?n=${n5}`);
    check('summary: Big Sends won by bots are named with 🤖', bigs.body.board.summary.bigs.every(b => !b.bot || /^🤖 /.test(b.name)), JSON.stringify(bigs.body.board.summary.bigs));
    await D.click('.modal [data-close]');
    // stall +24 h and reset on the $20 board
    await D.click('.tab[data-stake="20"]'); await waitFor(() => D.evaluate(() => window.__tip.active === 20)); await sleep(300);
    await D.evaluate(() => window.__tip.refreshAll());
    const s0 = (await (await fetch(BASE + '/api/admin/status', { headers: { 'x-admin-key': ADMIN_KEY } })).json()).boards.find(b => b.stake === 20);
    await idle(); await domClick(D, '[data-dev="adm:stall24"]');
    const s1 = await waitFor(async () => { const b = (await (await fetch(BASE + '/api/admin/status', { headers: { 'x-admin-key': ADMIN_KEY } })).json()).boards.find(x => x.stake === 20); return Date.parse(b.stallAt) < Date.parse(s0.stallAt) - 23 * 36e5 && b; }, 5000);
    check('admin: stall fast-forward moves the 5-day clock', !!s1);
    const n20 = s0.n;
    D.__prompt = () => 'RESET';
    await idle(); await domClick(D, '[data-dev="adm:reset"]');
    const rs = await waitFor(() => D.$('.modal[data-kind=summary]'), 12000);
    const rtxt = rs ? await D.$eval('.modal[data-kind=summary]', e => e.innerText) : '';
    check('admin: reset (beta) → "was reset" summary with refunds explained', new RegExp(`Board #${n20} was reset`).test(rtxt) && /refunded/.test(rtxt), rtxt.slice(0, 160));
    if (rs) await D.click('.modal [data-close]');
    const audit = (await (await fetch(BASE + '/api/admin/status', { headers: { 'x-admin-key': ADMIN_KEY } })).json()).audit.map(a => a.action);
    check('admin: every panel action wrote an audit row', ['bots', 'credit', 'close', 'stall', 'reset'].every(a => audit.includes(a)), audit.join(','));
    // forget key
    if (await D.$eval('#devPanel', e => e.hidden)) { await D.click('#devToggle'); await sleep(200); }
    await idle(); await domClick(D, '[data-dev=adminForget]'); await sleep(100);
    check('admin: "Forget key" clears sessionStorage', await D.evaluate(() => sessionStorage.getItem('grokTipBoard.adminKey') === null) && !!(await D.$('[data-dev=adminKey]')));
  }
  {
    // /fair: commit list, client-side verify, tamper detection, CSV/JSON exports
    const F = await (await browser.createBrowserContext()).newPage(); wire(F); await F.setViewport({ width: 1360, height: 1000 });
    await F.goto(BASE + '/fair?stake=5', { waitUntil: 'load' });
    await waitFor(() => F.$('#closedBody table'), 6000);
    const list = await F.evaluate(() => ({ open: document.getElementById('openCommit') && document.getElementById('openCommit').textContent, rows: [...document.querySelectorAll('#closedBody tbody tr')].map(r => r.dataset.n) }));
    const feed5 = (await call('/api/board/5')).body;
    check('/fair lists the open board’s commitment hash', list.open === feed5.board.commit.hash, list.open);
    check('/fair lists closed boards newest first', list.rows.length >= 2 && Number(list.rows[0]) > Number(list.rows[1]), list.rows.join(','));
    await F.click(`[data-verify="${list.rows[0]}"]`);
    const v = await waitFor(() => F.$eval('#verdict', e => e.textContent), 15000);
    const checks = await F.$$eval('.checks li', l => l.map(x => x.innerText.split('\n')[0]));
    check('/fair Verify: ✅ recomputed SHA-256 + order + every play', /✅ Verified/.test(v || '') && checks.length >= 5 && checks.every(c => c.startsWith('✅')), checks.join(' | '));
    check('/fair Verify: bots are marked 🤖 in the draw list', await F.evaluate(() => document.querySelectorAll('#vBody .pill.bot').length > 0));
    check('/fair deep link updates the URL (?stake=5&n=…)', (await F.evaluate(() => location.search)) === `?stake=5&n=${list.rows[0]}`);
    await F.screenshot({ path: SHOTS + '11-desktop-fair-verify.png' });
    const cdp = await browser.target().createCDPSession(); await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL, browserContextId: F.browserContext().id });
    await F.click('#vCsv'); await F.click('#vJson');
    const got = await waitFor(() => { const x = fs.readdirSync(DL).filter(n => /^tip-board-5-\d+\.(csv|json)$/.test(n)); return x.length === 2 && x; }, 6000);
    const csvF = got && got.find(n => n.endsWith('.csv')), jsonF = got && got.find(n => n.endsWith('.json'));
    const csv = csvF ? fs.readFileSync(DL + '/' + csvF, 'utf8').trim().split(/\r?\n/) : [];
    const snap = (await call(`/api/board/5?n=${list.rows[0]}`)).body;
    check('/fair CSV export: header + one row per play (+ unselected)', csv[0] === 'board,play_no,square,player,bot,prize,ticket' && csv.length - 1 === snap.squares.length + (snap.board.summary.unselected || []).length, `${csv[0]} · ${csv.length - 1} rows`);
    check('/fair CSV marks bot plays', csv.some(l => /,yes,/.test(l)));
    const js = jsonF ? JSON.parse(fs.readFileSync(DL + '/' + jsonF, 'utf8')) : {};
    check('/fair JSON export: commit, reveal, plays and verify results', js.commit && js.commit.hash === snap.board.commit.hash && js.reveal && js.reveal.salt === snap.board.reveal.salt && js.plays.length === snap.squares.length && js.verify.every(x => x.ok));
    // tamper: flip one hex digit of the revealed salt in transit → ❌
    const T = await (await browser.createBrowserContext()).newPage(); wire(T); await T.setViewport({ width: 1360, height: 1000 });
    await T.setRequestInterception(true);
    T.on('request', async r => {
      if (/\/api\/board\/5\?n=/.test(r.url())) { const j = (await call(new URL(r.url()).pathname + new URL(r.url()).search)).body; const s = j.board.reveal.salt; j.board.reveal.salt = s.slice(0, -1) + (s.slice(-1) === '0' ? '1' : '0'); r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(j) }); }
      else r.continue();
    });
    await T.goto(BASE + `/fair?stake=5&n=${list.rows[0]}`, { waitUntil: 'load' });
    const tv = await waitFor(() => T.$eval('#verdict', e => e.textContent), 15000);
    const tch = await T.$$eval('.checks li', l => l.map(x => x.innerText.split('\n')[0]));
    check('/fair Verify: a tampered salt fails ❌ (hash + order)', /❌/.test(tv || '') && tch.filter(c => c.startsWith('❌')).length >= 2, tch.join(' | '));
    await T.screenshot({ path: SHOTS + '11-desktop-fair-tampered.png' });
    await T.browserContext().close();
    // mobile /fair
    await F.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await F.goto(BASE + `/fair?stake=5&n=${list.rows[0]}`, { waitUntil: 'load' }); await waitFor(() => F.$('#verdict'), 15000);
    check('/fair mobile: no horizontal scroll', await F.evaluate(() => document.scrollingElement.scrollWidth <= 390));
    await F.screenshot({ path: SHOTS + '11-mobile-fair.png' });
    await F.browserContext().close();
    // turn bots back off for anyone reusing this DB
    await fetch(BASE + '/api/admin/bots', { method: 'POST', headers: { 'x-admin-key': ADMIN_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
    await D.browserContext().close();
  }

  check('no page errors', errs.length === 0, errs.slice(0, 5).join(' | '));
  await browser.close();
  const fail = results.filter(r => !r.ok);
  console.log(`\n${results.length - fail.length}/${results.length} passed`);
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });

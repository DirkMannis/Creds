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
  const wire = p => { p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); }); p.on('dialog', d => d.accept()); };
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
    check('one-time notice: "Beta reset: boards are now shared. Everyone sees the same board."', notice && notice.includes('Beta reset: boards are now shared. Everyone sees the same board.'));
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

  /* ---------- B. DEV hidden unless ?dev=1; sim-only actions disabled with PR 4 note ---------- */
  {
    const vis = p => p.$eval('#devToggle', e => { const r = e.getBoundingClientRect(); return !e.hidden && getComputedStyle(e).display !== 'none' && r.width > 0; });
    check('DEV button hidden without ?dev=1', !(await vis(A)));
    const p = await newPage(undefined, '?dev=1'); await onboard(p);
    check('DEV button visible with ?dev=1', await vis(p));
    await p.click('#devToggle'); await sleep(150);
    const dp = await p.$eval('#devPanel', e => ({ text: e.innerText, dis: [...e.querySelectorAll('.grp.off button')].every(b => b.disabled), n: e.querySelectorAll('.grp.off button').length }));
    check('DEV panel notes "admin tools arrive in PR 4"', /admin tools arrive in PR 4/i.test(dp.text));
    check('local simulation actions are disabled', dp.n >= 4 && dp.dis, `${dp.n} buttons`);
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

  check('no page errors', errs.length === 0, errs.slice(0, 5).join(' | '));
  await browser.close();
  const fail = results.filter(r => !r.ok);
  console.log(`\n${results.length - fail.length}/${results.length} passed`);
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });

// GET /api/board/:stake  -> public board feed for the $5 or $20 board (cached ~3 s at the CDN).
// GET /api/board/:stake?n=<n> -> snapshot of a closed board (squares, summary, reveal).
// Opens the board (with a published commitment hash) if none is open for that stake.
// Each feed request also advances the lazy 🤖 practice bots (see _lib/bots.js).
import { withPool } from '../_lib/db.js';
import { boardFeed, closedBoard } from '../_lib/board.js';
import { stallCheck } from '../_lib/engine.js';
import { botAdvance, botSettings } from '../_lib/bots.js';
import { json, error, handle, stakeFrom } from '../_lib/http.js';
import { LIVE_STAKES, STAKES, FEED_S_MAXAGE } from '../_lib/config.js';

export const GET = handle('board', async request => {
  const stake = stakeFrom(request);
  if (!LIVE_STAKES.includes(stake)) {
    const s = STAKES.find(x => x.v === stake);
    return error(404, s ? `$${stake} boards are ${s.note}` : 'Unknown board');
  }
  const nRaw = new URL(request.url).searchParams.get('n');
  if (nRaw !== null) {
    // GET /api/board/:stake?n=12 -> closed-board snapshot (immutable once closed, so it caches longer)
    if (!/^\d{1,6}$/.test(nRaw)) return error(400, 'n must be a board number');
    const snap = await withPool(pool => closedBoard(pool, stake, Number(nRaw)));
    if (!snap) return error(404, 'That board is not closed (or does not exist).');
    return json(snap, { cache: 'public, max-age=60, s-maxage=86400' });
  }
  const feed = await withPool(async pool => {
    await stallCheck(pool, stake);
    // lazy bots: catch up on elapsed time, rate-capped per request; a bot hiccup never breaks the feed
    await botAdvance(pool, stake).catch(e => console.error('[bots]', e && e.message));
    const [f, s] = await Promise.all([boardFeed(pool, stake), botSettings(pool)]);
    return { ...f, bots: { on: s.enabled, perHour: s.perHour, note: 'Labeled 🤖 practice players (play money) so beta boards close; removed before real money.' } };
  });
  return json(feed, { cache: `public, max-age=0, s-maxage=${FEED_S_MAXAGE}` });
});

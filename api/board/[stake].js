// GET /api/board/:stake  -> public board feed for the $5 or $20 board (cached ~3 s at the CDN).
// Opens the board (with a published commitment hash) if none is open for that stake.
import { withPool } from '../_lib/db.js';
import { boardFeed } from '../_lib/board.js';
import { stallCheck } from '../_lib/engine.js';
import { json, error, handle, stakeFrom } from '../_lib/http.js';
import { LIVE_STAKES, STAKES, FEED_S_MAXAGE } from '../_lib/config.js';

export const GET = handle('board', async request => {
  const stake = stakeFrom(request);
  if (!LIVE_STAKES.includes(stake)) {
    const s = STAKES.find(x => x.v === stake);
    return error(404, s ? `$${stake} boards are ${s.note}` : 'Unknown board');
  }
  const feed = await withPool(async pool => { await stallCheck(pool, stake); return boardFeed(pool, stake); });
  return json(feed, { cache: `public, max-age=0, s-maxage=${FEED_S_MAXAGE}` });
});

// Shared game constants for the server. Mirrors the play-money engine in index.html.
export const GRID = 500;          // squares on a board (20 wide x 25 tall)
export const CLOSE_AT = 400;      // a board closes when 400 squares are played
export const MILESTONE = 20;      // unlock ladder runs every 20 paid plays
export const BIG_UNLOCK = 100;    // Big Sends unlock from 100 plays
export const EA_AT = 10;          // Early Access for 10+ plays on a board
export const MANUAL_MAX = 5;      // typed square numbers per entry
export const CAP_NEW = 20, CAP_REGULAR = 40, CAP_REGULAR_AFTER = 2; // squares per board; 40 after 2 boards

export const MIN = 60e3, HOUR = 36e5, DAY = 864e5;
export const HOLD_MS = 5 * MIN;        // a square payment hold lasts 5 minutes (was 15 in the local beta)
export const STALL_MS = 5 * DAY;       // 5-day stall rule
export const CASHOUT_MS = 16 * HOUR;   // cash-outs are sent within 16 hours

export const STAKES = [
  { v: 5, live: true, note: 'main' },
  { v: 20, live: true, note: 'open' },
  { v: 100, live: false, note: 'coming soon' },
];
export const LIVE_STAKES = STAKES.filter(s => s.live).map(s => s.v);

export const POLL_MS = 4000;   // what the browser should poll at while visible
export const FEED_S_MAXAGE = 3; // CDN cache seconds for the public board feed

export const capFor = boardsPlayed => (boardsPlayed >= CAP_REGULAR_AFTER ? CAP_REGULAR : CAP_NEW);
export const SESSIONS_PER_IP_PER_DAY = 10; // new anonymous players per (hashed) IP per day

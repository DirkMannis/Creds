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
export const PREPICK_MAX = 200;           // Early Access pre-picks (paid + held) per upcoming board
export const MAX_SQUARES_PER_HOLD = CAP_REGULAR;

// ---- PR 4: bots, admin, rate limits ----
export const BETA = true;                 // free play-money beta (admin "reset board" is beta-only)
export const BOT_COUNT = 60;              // labeled 🤖 practice players
export const BOT_DEFAULT_PER_HOUR = 60;   // bot plays per hour per board: 400 plays in ~6-7 h
export const BOT_MAX_PER_HOUR = 3600;
export const BOT_MAX_PER_REQUEST = 20;    // plays a single board-feed request may add (catch-up is spread out)
export const BOT_MIN_GAP_MS = 5000;       // at most one bot step per board every 5 s
export const BOT_MAX_BACKLOG_MS = 3 * HOUR; // after a quiet spell, bots catch up at most 3 hours of plays
export const RATE_WINDOW_S = 60;          // write-endpoint rate limits (per rolling minute)
export const RATE_PER_PLAYER = 30;
export const RATE_PER_IP = 120;
export const ADMIN_TOPUP_MAX = 1000;

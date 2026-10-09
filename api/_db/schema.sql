-- Tip board (free play-money beta): shared-boards data model, schema versions 1-2.
-- Applied by api/_db/migrate.js (idempotent: every statement is IF NOT EXISTS, run under an advisory lock).
-- Money is numeric(12,2) dollars. Times are timestamptz.
--
-- Game constants live in api/_lib/config.js: 500 squares, closes at 400 plays or after 5 days,
-- a square payment hold lasts 5 minutes (HOLD_MS), caps 20 / 40 after 2 boards.
-- The bag (api/_lib/bag.js) is 192 Double Up, 2 Big Send, 1 Host Tip, 205 Patron:
-- shuffled and locked at open, SHA-256 commitment published at open, revealed at close.
-- Host and admin accounts (players.is_staff) can't play.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     int PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- Players. Beta identity = anonymous device token; only its SHA-256 hash is stored.
-- Self-typed @handles are hidden until real X sign-in (handle_kind 'x' requires x_user_id).
CREATE TABLE IF NOT EXISTS players (
  id             bigserial PRIMARY KEY,
  token_hash     text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  handle         text CHECK (handle IS NULL OR char_length(handle) BETWEEN 2 AND 16),
  handle_norm    text UNIQUE,
  handle_kind    text CHECK (handle_kind IN ('game', 'x')),
  x_user_id      text UNIQUE,
  boards_played  int NOT NULL DEFAULT 0 CHECK (boards_played >= 0),
  keep_balance   boolean NOT NULL DEFAULT false,   -- "Keep my balance in play" opt-out; reset after each close
  keep_set_at    timestamptz,
  is_bot         boolean NOT NULL DEFAULT false,   -- labeled bots (beta only)
  is_staff       boolean NOT NULL DEFAULT false,   -- host / admins: can't play
  banned         boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((handle IS NULL) = (handle_norm IS NULL)),
  CHECK (handle_kind <> 'x' OR x_user_id IS NOT NULL)
);

-- Boards. Exactly one open board per stake (partial unique index below).
CREATE TABLE IF NOT EXISTS boards (
  id             bigserial PRIMARY KEY,
  stake          int NOT NULL CHECK (stake IN (5, 20, 100)),
  n              int NOT NULL CHECK (n >= 1),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_at      timestamptz NOT NULL DEFAULT now(),
  stall_from     timestamptz NOT NULL DEFAULT now(),  -- 5-day stall clock; an empty board restarts it
  closed_at      timestamptz,
  reason         text CHECK (reason IN ('full', 'stall', 'admin')),
  plays          int NOT NULL DEFAULT 0 CHECK (plays BETWEEN 0 AND 400),
  carry_in       numeric(12,2) NOT NULL DEFAULT 0 CHECK (carry_in >= 0),
  carry_used     boolean NOT NULL DEFAULT false,
  host_drawn     boolean NOT NULL DEFAULT false,
  seeded         numeric(12,2) NOT NULL DEFAULT 0 CHECK (seeded >= 0),
  commit_hash    text NOT NULL CHECK (commit_hash ~ '^[0-9a-f]{64}$'),
  commit_scheme  text NOT NULL,
  bag_left       jsonb NOT NULL,                      -- public remaining counts {double,big,host,patron}
  summary        jsonb,                               -- close payouts, Unselected prizes, carry out
  reveal         jsonb,                               -- {salt, order} copied from board_secrets at close
  UNIQUE (stake, n),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL)),
  CHECK (status = 'open' OR reason IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS boards_one_open_per_stake ON boards (stake) WHERE status = 'open';

-- The locked ticket bag. NEVER read by public endpoints while the board is open.
-- Ticket for play k is draw_order[k] (1-based). Codes: 0 Patron, 1 Double Up, 2 Big Send, 3 Host Tip.
CREATE TABLE IF NOT EXISTS board_secrets (
  board_id    bigint PRIMARY KEY REFERENCES boards (id) ON DELETE CASCADE,
  salt        bytea NOT NULL CHECK (octet_length(salt) = 32),
  draw_order  smallint[] NOT NULL CHECK (array_length(draw_order, 1) = 400)
);

-- Plays: one row per played square. Insert-only.
-- PK (board_id, idx) blocks two plays on one square; UNIQUE (board_id, play_no) blocks drawing a ticket twice.
CREATE TABLE IF NOT EXISTS plays (
  board_id     bigint NOT NULL REFERENCES boards (id),
  idx          smallint NOT NULL CHECK (idx BETWEEN 0 AND 499),
  play_no      smallint NOT NULL CHECK (play_no BETWEEN 1 AND 400),
  player_id    bigint NOT NULL REFERENCES players (id),
  handle_snap  text,
  prize        smallint NOT NULL CHECK (prize BETWEEN 0 AND 3),
  via          text NOT NULL CHECK (via IN ('xmoney_sim', 'wallet', 'early', 'bot')),
  at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (board_id, idx),
  UNIQUE (board_id, play_no)
);
CREATE INDEX IF NOT EXISTS plays_player ON plays (player_id, board_id);

-- Wins (Double Ups and Big Sends) and their unlock progress.
CREATE TABLE IF NOT EXISTS wins (
  id         bigserial PRIMARY KEY,
  board_id   bigint NOT NULL REFERENCES boards (id),
  play_no    smallint NOT NULL,
  player_id  bigint NOT NULL REFERENCES players (id),
  kind       text NOT NULL CHECK (kind IN ('double', 'big')),
  amount     numeric(12,2) NOT NULL CHECK (amount > 0),
  unlocked   numeric(12,2) NOT NULL DEFAULT 0 CHECK (unlocked >= 0 AND unlocked <= amount),
  evened_at  smallint,                     -- milestone (play count) that evened it up
  final      boolean NOT NULL DEFAULT false,
  UNIQUE (board_id, play_no),
  FOREIGN KEY (board_id, play_no) REFERENCES plays (board_id, play_no)
);
CREATE INDEX IF NOT EXISTS wins_player ON wins (player_id) WHERE NOT final;

-- Payment holds: squares reserved for HOLD_MS (5 minutes) while the tip is sent.
-- One live hold per player. hold_squares' PK stops two holds on the same square;
-- expired rows are cleared inside the next play transaction.
CREATE TABLE IF NOT EXISTS holds (
  id          bigserial PRIMARY KEY,
  player_id   bigint NOT NULL UNIQUE REFERENCES players (id),
  stake       int NOT NULL,
  board_n     int NOT NULL,
  early       boolean NOT NULL DEFAULT false,   -- Early Access hold on the next board
  squares     smallint[] NOT NULL CHECK (array_length(squares, 1) BETWEEN 1 AND 40),
  code        text NOT NULL CHECK (code ~ '^GROK-[A-Z2-9]{3,6}$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,             -- created_at + 5 minutes
  CHECK (expires_at > created_at)
);
CREATE TABLE IF NOT EXISTS hold_squares (
  stake       int NOT NULL,
  board_n     int NOT NULL,
  idx         smallint NOT NULL CHECK (idx BETWEEN 0 AND 499),
  hold_id     bigint NOT NULL REFERENCES holds (id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  PRIMARY KEY (stake, board_n, idx)
);

-- Early Access pre-picks (paid), played first and in order when board n opens.
CREATE TABLE IF NOT EXISTS prepicks (
  stake      int NOT NULL,
  board_n    int NOT NULL,
  idx        smallint NOT NULL CHECK (idx BETWEEN 0 AND 499),
  player_id  bigint NOT NULL REFERENCES players (id),
  via        text NOT NULL CHECK (via IN ('xmoney_sim', 'wallet')),
  code       text,
  at         timestamptz NOT NULL DEFAULT now(),
  played     boolean NOT NULL DEFAULT false,
  PRIMARY KEY (stake, board_n, idx)
);
CREATE INDEX IF NOT EXISTS prepicks_player ON prepicks (player_id, stake, board_n);

-- Append-only money ledger: every play, replay, pre-pay, win, unlock, settle, carry, payout,
-- cash-out and dev top-up. History and CSV are SELECTs over this table. Never updated or deleted.
-- bucket: 'board:<board id>', 'carry:<board id>', or 'dev'. ref is an optional idempotency key.
CREATE TABLE IF NOT EXISTS ledger (
  id         bigserial PRIMARY KEY,
  player_id  bigint NOT NULL REFERENCES players (id),
  at         timestamptz NOT NULL DEFAULT now(),
  kind       text NOT NULL CHECK (kind IN ('play', 'replay', 'prepay', 'win', 'unlock', 'settle', 'carry',
                                           'payout', 'cashout', 'dev_topup', 'adjust')),
  bucket     text,
  board_id   bigint REFERENCES boards (id),
  square     smallint,
  amount     numeric(12,2) NOT NULL,
  note       text,
  ref        text UNIQUE
);
CREATE INDEX IF NOT EXISTS ledger_player ON ledger (player_id, id DESC);

-- Cached wallet balance (sum of unlocked buckets). Row-locked for replays and cash-outs.
CREATE TABLE IF NOT EXISTS wallets (
  player_id   bigint PRIMARY KEY REFERENCES players (id),
  unlocked    numeric(12,2) NOT NULL DEFAULT 0 CHECK (unlocked >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_audit (
  id      bigserial PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT now(),
  actor   text NOT NULL,
  action  text NOT NULL,
  args    jsonb
);

-- Simple rate limiting (IP and player keys are hashed, never raw IPs).
CREATE TABLE IF NOT EXISTS rate_events (
  id      bigserial PRIMARY KEY,
  at      timestamptz NOT NULL DEFAULT now(),
  key     text NOT NULL,
  action  text NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_events_lookup ON rate_events (action, key, at);

INSERT INTO schema_migrations (version) VALUES (1) ON CONFLICT (version) DO NOTHING;

-- ===================== v2: server engine + write path (additive, idempotent) =====================

-- Would-be-sent payouts (free beta: nothing is actually sent). One row per cash-out request,
-- auto payout at close, or unused carried credit paid at the next close. send_by = requested + 16 h.
CREATE TABLE IF NOT EXISTS payouts (
  id          bigserial PRIMARY KEY,
  player_id   bigint NOT NULL REFERENCES players (id),
  at          timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL CHECK (kind IN ('cashout', 'close', 'carry_unused')),
  board_id    bigint REFERENCES boards (id),
  amount      numeric(12,2) NOT NULL CHECK (amount > 0),
  send_by     timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'would_send' CHECK (status IN ('would_send', 'sent', 'void'))
);
CREATE INDEX IF NOT EXISTS payouts_player ON payouts (player_id, id DESC);

-- Memo codes are unique among live holds (holds are deleted when paid, cancelled or expired).
CREATE UNIQUE INDEX IF NOT EXISTS holds_code_key ON holds (code);

-- Ledger kinds: v2 adds 'preplay' (an Early Access pick was played when its board opened; amount 0,
-- the money moved at 'prepay'). 'win' rows are informational (amount 0, the prize is in the note).
ALTER TABLE ledger DROP CONSTRAINT IF EXISTS ledger_kind_check;
ALTER TABLE ledger ADD CONSTRAINT ledger_kind_check CHECK (kind IN ('play', 'replay', 'prepay', 'preplay', 'win',
  'unlock', 'settle', 'carry', 'payout', 'cashout', 'dev_topup', 'adjust'));
CREATE INDEX IF NOT EXISTS ledger_bucket ON ledger (bucket, player_id) WHERE bucket IS NOT NULL;

INSERT INTO schema_migrations (version) VALUES (2) ON CONFLICT (version) DO NOTHING;

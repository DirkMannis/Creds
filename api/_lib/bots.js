// Lazy server-side bots: labeled 🤖 practice players so beta boards close in hours, not days.
// They advance on board-feed requests (and the daily cron), catching up on elapsed time at a set rate,
// capped per request. Play money only: their money lives in bot_ledger, never in wallets or human history.
// Rules they follow: the normal per-board cap, never a square a human is holding, never more than the
// room left after human holds, and never Early Access (they only play the open board).
// Kill switch: BOTS_ENABLED=false (env) turns them off everywhere; the admin API can also pause them.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { tx } from './db.js';
import { lockOpenBoard, _core } from './engine.js';
import { normHandle } from './names.js';
import {
  GRID, CLOSE_AT, capFor, LIVE_STAKES, BOT_COUNT, BOT_DEFAULT_PER_HOUR, BOT_MAX_PER_HOUR, BOT_MAX_PER_REQUEST,
  BOT_MIN_GAP_MS, BOT_MAX_BACKLOG_MS,
} from './config.js';

const { Book, loadState, playSquare, writeState, closeBoard, PRIZE } = _core;

const ADJ = ['tipsy','cosmic','lucky','salty','quantum','sleepy','turbo','neon','spicy','chill','rogue','mellow','hyper','pixel','feral','dapper','zesty','glitchy','sunny','midnight'];
const NOUN = ['otter','gremlin','falcon','moose','taco','wizard','panda','comet','badger','noodle','yeti','llama','kraken','goblin','walrus','ferret','pickle','raccoon','nebula','biscuit'];
/** Deterministic bot names (3–15 chars, no @, so they can never pass as X handles). */
export const BOT_NAMES = (() => {
  const out = [];
  for (let k = 0; out.length < BOT_COUNT; k++) {
    const a = ADJ[k % ADJ.length], n = NOUN[(k * 7 + Math.floor(k / ADJ.length) * 3) % NOUN.length];
    const name = (k % 3 === 0 ? `${a}${n[0].toUpperCase()}${n.slice(1)}` : `${a}_${n}`).slice(0, 15);
    if (!out.includes(name)) out.push(name);
  }
  return out;
})();

export const envBotsOn = () => !/^(0|false|off|no|disabled)$/i.test(String(process.env.BOTS_ENABLED ?? 'true').trim());

/** Effective bot settings: env kill switch AND admin setting (default on, 60 plays/hour/board). */
export async function botSettings(q) {
  const { rows: [r] } = await q.query(`SELECT value FROM settings WHERE key = 'bots'`);
  const v = (r && r.value) || {};
  const perHour = Math.max(1, Math.min(BOT_MAX_PER_HOUR, Number(v.perHour) || BOT_DEFAULT_PER_HOUR));
  const adminOn = v.enabled !== false, env = envBotsOn();
  return { enabled: env && adminOn, env, admin: adminOn, perHour };
}

export async function setBotSettings(q, { enabled, perHour }) {
  const cur = await botSettings(q);
  const next = { enabled: enabled === undefined ? cur.admin : !!enabled, perHour: perHour === undefined ? cur.perHour : Math.round(Number(perHour)) };
  if (!Number.isFinite(next.perHour) || next.perHour < 1 || next.perHour > BOT_MAX_PER_HOUR) throw Object.assign(new Error('bad speed'), { status: 400, expose: `speed must be 1-${BOT_MAX_PER_HOUR} plays per hour` });
  await q.query(`INSERT INTO settings (key, value) VALUES ('bots', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`, [JSON.stringify(next)]);
  return botSettings(q);
}

/** Make sure the bot players exist; returns [{ id, name, boards_played }]. */
async function ensureBots(c) {
  let { rows } = await c.query('SELECT id, handle, boards_played FROM players WHERE is_bot ORDER BY id');
  if (rows.length < BOT_COUNT) {
    const have = new Set(rows.map(r => r.handle));
    const want = BOT_NAMES.filter(n => !have.has(n));
    // bots never log in: their token hash is random and unknown to anyone
    await c.query(
      `INSERT INTO players (token_hash, handle, handle_norm, handle_kind, is_bot)
       SELECT t, h, hn, 'game', true FROM unnest($1::text[], $2::text[], $3::text[]) AS x(t, h, hn) ON CONFLICT DO NOTHING`,
      [want.map(() => createHash('sha256').update(randomBytes(32)).digest('hex')), want, want.map(normHandle)]);
    ({ rows } = await c.query('SELECT id, handle, boards_played FROM players WHERE is_bot ORDER BY id'));
  }
  return rows.map(r => ({ id: Number(r.id), name: r.handle, boards_played: r.boards_played }));
}

/**
 * Advance the bots on one stake's open board by however many plays are due since bots_at
 * (perHour rate, backlog capped at BOT_MAX_BACKLOG_MS), at most `max` plays this call.
 * Returns { played, closed } (closed = close result if play 400 happened).
 */
export async function botAdvance(pool, stake, { max = BOT_MAX_PER_REQUEST } = {}) {
  if (!LIVE_STAKES.includes(stake)) return { played: 0 };
  const s = await botSettings(pool);
  if (!s.enabled) return { played: 0, off: true };
  const msPer = 3600e3 / s.perHour;
  // cheap unlocked pre-check so most feed requests never take the board lock
  const { rows: [pre] } = await pool.query(
    `SELECT extract(epoch FROM now() - bots_at) * 1000 AS lag FROM boards WHERE stake = $1 AND status = 'open'`, [stake]);
  if (!pre || Number(pre.lag) < Math.max(msPer, BOT_MIN_GAP_MS)) return { played: 0 };
  return tx(pool, async c => {
    const book = new Book(c);
    const { b, closed: stalled } = await lockOpenBoard(c, stake, book);
    const { rows: [t] } = await c.query('SELECT extract(epoch FROM now() - bots_at) * 1000 AS lag FROM boards WHERE id = $1', [b.id]);
    const lag = Math.min(Number(t.lag), BOT_MAX_BACKLOG_MS);
    if (lag < Math.max(msPer, BOT_MIN_GAP_MS)) { await book.flush(); return { played: 0, closed: stalled }; }
    const [{ rows: held }, { rows: played }, bots] = await Promise.all([
      c.query('SELECT idx FROM hold_squares WHERE stake = $1 AND board_n = $2 AND expires_at > now()', [stake, b.n]),
      c.query('SELECT idx, player_id FROM plays WHERE board_id = $1', [b.id]),
      ensureBots(c),
    ]);
    const blocked = new Set([...held.map(r => r.idx), ...played.map(r => r.idx)]);
    const count = new Map(); for (const r of played) count.set(Number(r.player_id), (count.get(Number(r.player_id)) || 0) + 1);
    const empties = []; for (let i = 0; i < GRID; i++) if (!blocked.has(i)) empties.push(i);
    // leave room for every square humans are holding right now
    const room = Math.max(0, CLOSE_AT - b.plays - held.length);
    const due = Math.min(Math.floor(lag / msPer), max, room, empties.length);
    let n = 0, closed = stalled;
    if (due > 0) {
      const st = await loadState(c, b, book);
      for (; n < due; n++) {
        const ok = bots.filter(x => (count.get(x.id) || 0) < capFor(x.boards_played));
        if (!ok.length) break;
        const bot = ok[randomInt(ok.length)], idx = empties.splice(randomInt(empties.length), 1)[0];
        const kind = playSquare(st, idx, { id: bot.id, name: bot.name }, 'bot');
        book.post(bot.id, 'play', -b.stake, { board_id: b.id, square: idx, note: `🤖 practice play (play money) · ${PRIZE[kind]}` });
        count.set(bot.id, (count.get(bot.id) || 0) + 1);
      }
      await writeState(st);
      if (st.b.plays >= CLOSE_AT) closed = await closeBoard(st, 'full');
    }
    // the bot clock keeps any unplayed remainder (capped backlog), so catch-up continues next request
    if (!closed || closed === stalled) await c.query(`UPDATE boards SET bots_at = now() - make_interval(secs => $2) WHERE id = $1`,
      [b.id, Math.max(0, lag - n * msPer) / 1000]);
    await book.flush();
    return { played: n, closed };
  });
}

/** Cron backstop: catch every live board up (bigger per-call cap). */
export async function botTick(pool) {
  const out = {};
  for (const stake of LIVE_STAKES) out[stake] = (await botAdvance(pool, stake, { max: CLOSE_AT }).catch(e => ({ error: e.message }))).played ?? 0;
  return out;
}

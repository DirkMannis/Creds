// POST /api/cashout  -> cash out all unlocked winnings (would be sent via X Money within 16 h; nothing is sent in the beta)
import { playerAction } from './_lib/actions.js';
import { cashOut } from './_lib/engine.js';

export const POST = playerAction('cashout', (pool, player) => cashOut(pool, player));

// POST /api/replay  -> same as POST /api/pay { method: 'wallet' }: pay your hold from unlocked winnings.
import { playerAction } from './_lib/actions.js';
import { payHold } from './_lib/engine.js';

export const POST = playerAction('replay', (pool, player) => payHold(pool, player, { method: 'wallet' }));

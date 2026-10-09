// POST /api/keep { on: true|false }  -> "Keep my balance in play" opt-out (default off = auto payout at close)
import { playerAction } from './_lib/actions.js';
import { setKeep } from './_lib/engine.js';

export const POST = playerAction('keep', (pool, player, body) => setKeep(pool, player, body.on === true));

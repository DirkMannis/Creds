// POST   /api/hold  { stake: 5|20, squares: [0-499...], early?: true }  -> 5-minute hold + GROK-XXX memo code
//        early: true = Early Access pre-pick on the NEXT board (needs 10+ plays on the open board)
// DELETE /api/hold                                                     -> cancel your hold
import { playerAction } from './_lib/actions.js';
import { createHold, cancelHold } from './_lib/engine.js';

export const POST = playerAction('hold', (pool, player, body) =>
  createHold(pool, player, { stake: Number(body.stake), squares: body.squares, early: body.early === true }));

export const DELETE = playerAction('hold:cancel', (pool, player) => cancelHold(pool, player));

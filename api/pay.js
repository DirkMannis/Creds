// POST /api/pay { method: 'xmoney_sim' | 'wallet' }  -> pays your current hold (free beta: play money)
//   xmoney_sim = simulate the X Money tip arriving; wallet = a Replay from unlocked winnings.
//   Squares are drawn in square-number order; play 400 closes and settles the board.
import { playerAction } from './_lib/actions.js';
import { payHold } from './_lib/engine.js';

export const POST = playerAction('pay', (pool, player, body) => payHold(pool, player, { method: body.method || 'xmoney_sim' }));

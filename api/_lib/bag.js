// The prize bag for one board, shuffled and locked at open.
//
// 400 tickets: 192 Double Up, 2 Big Send, 1 Host Tip, 205 Patron. Play k draws ticket k
// (tickets attach to the play sequence, never to squares).
//
// Fairness: at open the server picks a random 32-byte salt and derives the draw order from it
// with a deterministic shuffle (HMAC-SHA256 stream + rejection sampling, Fisher-Yates).
// It publishes commit = SHA-256("grok-tip-board/v1|<stake>|<n>|<salt hex>|<order>") where <order>
// is the 400 tickets as letters (D = Double Up, B = Big Send, H = Host Tip, P = Patron).
// At close the salt and order are revealed; anyone can recompute both the order and the hash.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { CLOSE_AT } from './config.js';

export const BAG = Object.freeze({ double: 192, big: 2, host: 1, patron: 205 });
export const KINDS = ['patron', 'double', 'big', 'host'];          // smallint code = index
export const CODE = Object.freeze({ patron: 0, double: 1, big: 2, host: 3 });
export const LETTER = Object.freeze({ patron: 'P', double: 'D', big: 'B', host: 'H' });
export const COMMIT_SCHEME = 'sha256:grok-tip-board/v1|stake|n|salt_hex|order_letters';

if (BAG.double + BAG.big + BAG.host + BAG.patron !== CLOSE_AT) throw new Error('bag must hold exactly CLOSE_AT tickets');

/** Unshuffled ticket list, as kind names. */
export function buildTickets(bag = BAG) {
  const out = [];
  for (const k of ['double', 'big', 'host', 'patron']) for (let i = 0; i < bag[k]; i++) out.push(k);
  return out;
}

/** Deterministic, unbiased integer stream seeded by the (secret) salt. */
function seededRng(salt) {
  let counter = 0, buf = Buffer.alloc(0), off = 0;
  const next32 = () => {
    if (off + 4 > buf.length) {
      buf = createHmac('sha256', salt).update(`shuffle:${counter++}`).digest();
      off = 0;
    }
    const v = buf.readUInt32BE(off); off += 4; return v;
  };
  // uniform integer in [0, n) by rejection sampling
  return n => {
    const limit = Math.floor(0x100000000 / n) * n;
    for (;;) { const v = next32(); if (v < limit) return v % n; }
  };
}

/** Fisher-Yates shuffle driven by the salt. Same salt -> same order. */
export function shuffleWithSalt(tickets, salt) {
  const a = tickets.slice(), rnd = seededRng(salt);
  for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export const orderLetters = order => order.map(k => LETTER[k]).join('');

export function commitHash({ stake, n, salt, order }) {
  const saltHex = Buffer.isBuffer(salt) ? salt.toString('hex') : String(salt);
  return createHash('sha256').update(`grok-tip-board/v1|${stake}|${n}|${saltHex}|${orderLetters(order)}`).digest('hex');
}

/** Build a fresh bag for board (stake, n): returns the secret salt + order and the public commit. */
export function newBag(stake, n, salt = randomBytes(32)) {
  const order = shuffleWithSalt(buildTickets(), salt);
  return { salt, order, codes: order.map(k => CODE[k]), commit: commitHash({ stake, n, salt, order }) };
}

/** What a verifier does at reveal: re-derive the order from the salt and re-hash it. */
export function verifyReveal({ stake, n, saltHex, orderLetters: letters, commit }) {
  const salt = Buffer.from(saltHex, 'hex');
  const order = shuffleWithSalt(buildTickets(), salt);
  const derived = orderLetters(order);
  return { orderMatches: derived === letters, hashMatches: commitHash({ stake, n, salt, order }) === commit };
}

export const countsOf = order => {
  const c = { double: 0, big: 0, host: 0, patron: 0 };
  for (const k of order) c[k]++;
  return c;
};

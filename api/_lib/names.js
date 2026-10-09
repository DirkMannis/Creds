// In-game handle screening (server side; the browser runs the same rules only as a hint).
// Self-typed @handles are not accepted here: X handles need real X sign-in (later PR).
const BLOCK = ['fuck','shit','cunt','nigg','fag','retard','rape','nazi','hitler','porn','cock','dick','pussy','whore','slut','kys','bitch','penis','vagina','cum','jizz','anal','molest','pedo','fck','fuk','fack','phuck','fvck','fcuk','sh1t','shyt','azz','arse','twat','wank','nlgg','kkk'];
const RESERVED_SUB = ['official','admin','support','verified','moderator','staff','helpdesk','xmoney','cashapp'];
const RESERVED_EXACT = ['grok','xai','x','elon','elonmusk','twitter','host','operator','system','mod','team','grokbot','dirkmannis','tipboard'];

/** Lookalike-folded form; also the uniqueness key (players.handle_norm). */
export const normHandle = s => String(s).toLowerCase().replace(/^@/, '').replace(/[0]/g, 'o').replace(/[1!|]/g, 'i').replace(/l/g, 'i')
  .replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't').replace(/8/g, 'b').replace(/[$]/g, 's').replace(/[_.\-\s]/g, '');

/** '' if OK, else a user-facing reason. */
export function screenHandle(raw) {
  const s = String(raw ?? '').trim();
  if (s.startsWith('@')) return 'X handles arrive with Sign in with X. Pick an in-game handle (no @) for now.';
  if (!/^[A-Za-z0-9_]{3,15}$/.test(s)) return 'In-game handles are 3–15 letters, numbers or _.';
  if (/^player_?\d+$/i.test(s)) return 'That looks like an automatic player number. Pick something else.';
  const n = normHandle(s), plain = s.toLowerCase().replace(/[_]/g, '');
  if (BLOCK.some(w => n.includes(normHandle(w)) || plain.includes(w))) return 'That name didn’t pass the filter. Try another.';
  if (RESERVED_SUB.some(w => n.includes(normHandle(w)))) return 'Names can’t suggest staff or official accounts.';
  if (RESERVED_EXACT.some(w => n === normHandle(w))) return 'That name is reserved (too close to a real account or the host).';
  return '';
}

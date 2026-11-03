// When the browser receiver's Done screen asks for support (web/receive-logic.js, the phone app's rule in
// android/.../DonatePrompt.kt): at most every fifth successful transfer, never two in a row, never after "Don't ask
// again"; counts in localStorage, and without storage at most once per page load.
//
//   node web/tests/donate-logic.mjs
import { DONATE, donateAfter, DonateGate } from '../receive-logic.js';

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const store = () => { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
const shows = (gate, n) => Array.from({ length: n }, () => gate.afterTransfer());
const at = (seq) => seq.map((s, i) => (s ? i + 1 : 0)).filter(Boolean);

check(DONATE.EVERY === 5 && DONATE.TEXT === 'LensBolt is free. If it helped, you can support it.' &&
  DONATE.COFFEE === 'https://buymeacoffee.com/akhildara1l' && DONATE.SPONSORS === 'https://github.com/sponsors/akhil-dara', 'the rule, the words and the two links (the phone app\'s)');

// --- the rule ---
let c = { transfers: 0, lastShown: 0, never: false }, seen = [];
for (let i = 0; i < 12; i++) { const r = donateAfter(c); c = r.count; seen.push(r.show); }
check(JSON.stringify(at(seen)) === '[5,10]', `shown on the 5th and 10th success (${at(seen)})`);
check(seen.every((s, i) => !(s && seen[i - 1])), 'never two in a row');
check(!donateAfter({ transfers: 40, lastShown: 0, never: true }).show, '"Don\'t ask again": never');
check(donateAfter({ transfers: 3, lastShown: 9, never: false }).count.lastShown === 3, 'a last prompt ahead of the count (restored storage) counts as the last transfer');

// --- with storage: the counts survive a reload ---
const s = store();
check(JSON.stringify(at(shows(new DonateGate(s), 4))) === '[]', 'four successes: not yet');
const reloaded = new DonateGate(s);
check(reloaded.afterTransfer() === true && s.getItem(DONATE.KEYS.count) === '5' && s.getItem(DONATE.KEYS.shown) === '5', 'the fifth, after a reload: shown, the counts stored');
check(JSON.stringify(at(shows(reloaded, 5))) === '[5]', 'then again five later');
reloaded.never();
check(s.getItem(DONATE.KEYS.never) === '1' && JSON.stringify(at(shows(new DonateGate(s), 20))) === '[]', '"Don\'t ask again" is remembered: never again');
const junk = store(); junk.setItem(DONATE.KEYS.count, 'abc'); junk.setItem(DONATE.KEYS.shown, '-7');
check(JSON.stringify(at(shows(new DonateGate(junk), 6))) === '[5]', 'unreadable counts start again from 0');

// --- without storage (missing, or refusing): at most once per page load ---
const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
for (const [what, st] of [['storage that throws', throwing], ['no storage', null]]) {
  const g = new DonateGate(st);
  const seq = shows(g, 30);
  check(JSON.stringify(at(seq)) === '[5]', `${what}: shown once in this page load, on the 5th success (${at(seq)})`);
  const g2 = new DonateGate(st);
  g2.never();
  check(JSON.stringify(at(shows(g2, 10))) === '[]', `${what}: "Don't ask again" holds for this page load`);
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);

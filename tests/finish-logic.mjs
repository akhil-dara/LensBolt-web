// The sender's Finish field on its own (web/finish-logic.js): the word being typed, the completion shown after
// it (Tab only), accepting it, and what Enter does with the words. No browser, no wasm: the word rules come in as
// functions (the page passes the wasm's suggest_word, check_finish_words and WebSender.finish).
//
//   node web/tests/finish-logic.mjs
import { wordAt, completion, accept, refusedWord, findWord, applyWords, refusal, fileKey, wordsStayFor, codeMeaning } from '../finish-logic.js';

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// a stand-in for the wasm suggest_word: the one word of a small list starting with the letters, never "att"
// (one mistake from "ant"), as words::suggest withholds it
const LIST = ['ant', 'attic', 'river', 'candle', 'tulip', 'walnut', 'wallet'];
const suggest = (t) => {
  const s = t.toLowerCase();
  if (s.length < 2 || s === 'att') return '';
  const m = LIST.filter((w) => w.startsWith(s));
  return m.length === 1 ? m[0] : '';
};

// --- the word being typed ---
check(eq(wordAt('river can', 9), { start: 6, end: 9, text: 'can' }), 'the word the caret ends');
check(wordAt('river ', 6) === null && wordAt('', 0) === null, 'no word right after a space, or in an empty field');
check(eq(wordAt('river,can', 9), { start: 6, end: 9, text: 'can' }) && eq(wordAt('river-can', 9), { start: 6, end: 9, text: 'can' }), 'dashes and commas separate words too');
check(wordAt('river can', 3) === null, 'a caret inside a word: no word (nothing to complete there)');

// --- the completion: the whole suggested word, after the letters typed ---
check(eq(completion('river can', 9, suggest), { word: 'candle', rest: 'dle', start: 6, end: 9 }), 'letters that start one word show the rest of it');
check(eq(completion('Riv', 3, suggest), { word: 'river', rest: 'er', start: 0, end: 3 }), 'any case: the rest is shown in the list\'s letters');
check(completion('att', 3, suggest) === null, 'a start the core withholds (one mistake from another word) shows nothing');
check(completion('wal', 3, suggest) === null, 'a start shared by two words shows nothing');
check(completion('r', 1, suggest) === null, 'one letter is never enough');
check(completion('river', 5, suggest) === null, 'a word typed in full: nothing left to complete');
check(completion('can river', 3, suggest) === null, 'only at the end of the field (the shown rest sits after the last letter)');
check(completion('river can', 9, suggest, 7) === null, 'not while letters are selected');
check(completion('river ', 6, suggest) === null, 'nothing after a space');

// --- Tab accepts: the whole word and a space; Tab with nothing to accept is left to the browser ---
check(eq(accept('river can', 9, suggest), { value: 'river candle ', caret: 13 }), 'Tab: the whole word, then a space, caret after it');
check(eq(accept('CAN', 3, suggest), { value: 'candle ', caret: 7 }), 'the accepted word is shown in full, in the list\'s letters');
check(accept('att', 3, suggest) === null && accept('river ', 6, suggest) === null, 'nothing to accept: null (Tab moves focus as usual)');

// --- a refused word is selected for typing again ---
check(refusedWord('“walet” is close to more than one word. Type it again.') === 'walet', 'the refused word is read from the message');
check(refusedWord('These words are for another file, or one is mistyped. Check them on the phone.') === null, 'a message naming no word: null');
check(eq(findWord('river, Walet tulip', 'walet'), [7, 12]), 'the refused word is found in the field, any case');
check(findWord('river', 'walet') === null, 'a word not in the field: null');

// --- Enter: the words checked; accepted words read back in full; a refusal names what to fix ---
const describe = (t) => { if (/zzz/.test(t)) throw '“zzz” is not one of the words. Check it on the phone.'; if (/tulip/.test(t)) throw 'These words are for another file, or one is mistyped. Check them on the phone.'; return '2 parts: 3, 7'; };
const read = (t) => (/zzz/.test(t) ? '' : t.toLowerCase().replace(/rivr/, 'river').split(/[\s,-]+/).filter(Boolean).join(' '));
check(eq(applyWords('  ', describe, read), { kind: 'clear' }), 'an empty field: back to sending everything');
check(eq(applyWords('Rivr-candle', describe, read), { kind: 'ok', desc: '2 parts: 3, 7', words: 'river candle' }), 'accepted: what the words mean, and the words as read, in full');
check(eq(applyWords('river zzz', describe, read), { kind: 'error', error: '“zzz” is not one of the words. Check it on the phone.', select: [6, 9] }), 'a refused word: the message, and that word selected');
check(eq(applyWords('river tulip', describe, read), { kind: 'error', error: 'These words are for another file, or one is mistyped. Check them on the phone.', select: null }), 'a refused code: the message, nothing selected');
check(eq(applyWords('river', () => { throw new Error('boom'); }, read), { kind: 'error', error: 'boom', select: null }), 'an Error object gives its message');
check(eq(refusal('tulip Zzz', '“zzz” is not one of the words.'), { kind: 'error', error: '“zzz” is not one of the words.', select: [6, 9] }), 'a refusal at Start selects the word it names, like Enter');

// --- words stay with their file: the words were typed for one file; another file chosen clears them ---
const A = { name: 'a.bin', size: 2000000, lastModified: 1 }, B = { name: 'b.bin', size: 1000000, lastModified: 2 };
check(fileKey(A) === fileKey({ ...A }) && fileKey(A) !== fileKey(B) && fileKey(A) !== fileKey({ ...A, lastModified: 3 }) && fileKey(null) === null, 'fileKey: the same file chosen again has the same key; another file, or the file changed since, another');
check(wordsStayFor(fileKey(A), A) && wordsStayFor(fileKey(A), { ...A }), 'words typed for a file stay when the same file is chosen again (a resume)');
check(!wordsStayFor(fileKey(A), B), "A's words do not stay for B");
check(wordsStayFor(null, B), 'words typed before any file was chosen stay with the file chosen next');

// --- the calibration field says what the words mean ---
check(codeMeaning('3,bw,30') === '3 px · black and white · 30 fps', `codeMeaning: ${codeMeaning('3,bw,30')}`);
check(codeMeaning('4,c8,60') === '4 px · 8 colours · 60 fps' && codeMeaning('2,g4,24') === '2 px · 4 greys · 24 fps' && codeMeaning('5,c16,120') === '5 px · 16 colours · 120 fps', 'codeMeaning: colours, greys, every frame rate');

// --- the real bindings (web/pkg, from python web/build.py): the core's rules reach the page as the page uses them ---
const { existsSync, readFileSync } = await import('node:fs');
const pkg = new URL('../pkg/', import.meta.url);
if (!existsSync(new URL('lensbolt_web_bg.wasm', pkg))) { console.log('FAIL web/pkg is missing: run python web/build.py'); failed++; }
else {
  const m = await import(new URL('lensbolt_web.js', pkg));
  await m.default({ module_or_path: readFileSync(new URL('lensbolt_web_bg.wasm', pkg)) });
  const coreWords = process.env.LENSBOLT_CORE ? `${process.env.LENSBOLT_CORE}/src/words.rs` : '';
  const WORDS = coreWords ? [...readFileSync(coreWords, 'utf8').split('pub const WORDS')[1].split('];')[0].matchAll(/"([a-z]+)"/g)].map((x) => x[1]) : null;
  if (WORDS) check(WORDS.length === 1024, `the word list read from lensbolt-core (${WORDS.length} words)`); else console.log('skip the word-list comparison: set LENSBOLT_CORE to a lensbolt-core checkout');
  check(m.suggest_word('tuli') === 'tulip' && m.suggest_word('att') === '' && m.suggest_word('atti') === '', 'suggest_word: "tuli" completes to tulip; "att" and "atti" (each one mistake from the start of another word) show nothing');
  check(m.suggest_word('factor') === '', 'suggest_word: "factor" (one mistake on actor) never suggests factory');
  check(m.suggest_word('CAND') === m.suggest_word('cand'), 'suggest_word: any case');
  const real = (t) => m.suggest_word(t);
  check(eq(accept('river tuli', 10, real), { value: 'river tulip ', caret: 12 }), 'Tab with the real list: the whole word');

  // a file of 2 segments (parts are segments) and one of 3 chunks in one segment (parts are its chunks)
  const file = (mb, seed) => { const n = Math.round(mb * 1e6), d = new Uint8Array(n); let x = seed; for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; d[i] = x & 255; } return d; };
  const big = file(20, 2463534242), small = file(2.5, 99);
  const [id, parts] = m.finish_context('big.bin', big).split(',').map(Number);
  const [sid, sparts] = m.finish_context('small.bin', small).split(',').map(Number);
  check(parts === 2 && sparts === 3, `parts: 2 segments of a 20 MB file, 3 chunks of a 2.5 MB file (${parts}, ${sparts})`);
  check(id % 2 === 1 && m.finish_context('big.bin', big) === `${id},${parts}`, `the transfer id is the file's, the same every time (${id})`);
  const code = m.finish_code(id, parts, Uint32Array.from([1]));
  check(/^[a-z]+( [a-z]+){0,3}$/.test(code), `a code for part 2 of 2: one word (2 tag + 2 map + 6 check bits) (${code})`);
  check(m.describe_finish(id, parts, code) === '1 part: 2', `before Start: what the words mean (${m.describe_finish(id, parts, code)})`);
  check(m.describe_finish(id, parts, code.toUpperCase().replace(/ /g, ', ')) === '1 part: 2', 'any case, commas between words');
  const scode = m.finish_code(sid, sparts, Uint32Array.from([0, 2]));
  check(m.describe_finish(sid, sparts, scode) === '2 parts: 1, 3', `a one-segment file names its chunks (${scode}: ${m.describe_finish(sid, sparts, scode)})`);
  const refused = (f) => { try { f(); return null; } catch (e) { return String(e); } };
  const read2 = (t) => { try { return m.check_finish_words(t); } catch { return ''; } };
  // before Start: spelling and count only, no file
  check(m.check_finish_words('LANTERN, walnut-tulip') === 'lantern walnut tulip', 'check_finish_words: the words as read, in full, any case and separators');
  check(/“qqqz” is not one of the words/.test(refused(() => m.check_finish_words('lantern qqqz')) || ''), 'check_finish_words: a word not on the list is named');
  check(/at most four/.test(refused(() => m.check_finish_words('tulip walnut lantern tulip walnut')) || ''), 'check_finish_words: five words are too many');
  check(/the words the phone shows/.test(refused(() => m.check_finish_words(' - ')) || ''), 'check_finish_words: nothing typed');
  // two or three words starting with a word of the list's last quarter are never finish words (a code starting there
  // is always four words) and never steered into the calibration field: type all four
  const FOUR = 'The phone shows four words: type all four (calibration words go under Advanced).';
  const four = m.finish_code(0x4c5b, 320, Uint32Array.from([...Array(17).keys()].map((i) => i * 18)));
  check(four.split(' ').length === 4 && WORDS.indexOf(four.split(' ')[0]) >= 768, `a window code: four words, the first from the last quarter (${four})`);
  for (const k of [1, 2, 3]) {
    const part = four.split(' ').slice(0, k).join(' ');
    check(refused(() => m.check_finish_words(part)) === FOUR, `check_finish_words: ${k} of its words (${part}): ${refused(() => m.check_finish_words(part))}`);
  }
  check(refused(() => m.check_finish_words(`${WORDS[900]} ${WORDS[5]}`)) === FOUR, 'any two words starting in the last quarter: type all four');
  check(m.check_finish_words(four) === four, 'all four words pass the spelling check');
  check(/another file/.test(refused(() => m.describe_finish(id ^ 2, parts, code)) || ''), `another file's words are refused (${refused(() => m.describe_finish(id ^ 2, parts, code))})`);
  check(/at most four/.test(refused(() => m.describe_finish(id, parts, Array(5).fill(code).join(' '))) || ''), 'more than four words: the phone shows at most four');
  check(/the words the phone shows/.test(refused(() => m.describe_finish(id, parts, ' , ')) || ''), 'no words: type the words the phone shows');
  // one mistake that lands within one mistake of two words: reported as ambiguous, never guessed (Review Focus 3)
  const one = (a, b) => { if (Math.abs(a.length - b.length) > 1) return false; for (let i = 0; i <= Math.max(a.length, b.length); i++) for (const c of 'abcdefghijklmnopqrstuvwxyz') { if (a.slice(0, i) + c + a.slice(i + 1) === b || a.slice(0, i) + c + a.slice(i) === b) return true; } for (let i = 0; i < a.length; i++) if (a.slice(0, i) + a.slice(i + 1) === b || (i + 1 < a.length && a.slice(0, i) + a[i + 1] + a[i] + a.slice(i + 2) === b)) return true; return false; };
  let amb = null;
  for (const w of WORDS.slice(0, 200)) { for (let i = 0; i < w.length && !amb; i++) for (const c of 'aeiou') { const x = w.slice(0, i) + c + w.slice(i + 1); if (x !== w && WORDS.filter((v) => one(v, x)).length >= 2) { amb = { x, w }; break; } } if (amb) break; }
  check(!!amb, `found a typo one mistake from two words (${amb && `${amb.x}: ${WORDS.filter((v) => one(v, amb.x)).join(' / ')}`})`);
  if (amb) {
    const typed = `${code.split(' ')[0]} ${amb.x}`, r = applyWords(typed, m.check_finish_words, read2);
    check(r.kind === 'error' && r.error === `“${amb.x}” is close to more than one word. Type it again.` && eq(r.select, [typed.length - amb.x.length, typed.length]), `an ambiguous typo is refused, named and selected (${r.error})`);
    check(read2(typed) === '', 'an ambiguous word reads as nothing');
  }
  const typo = code.split(' ').map((w, i) => (i === 0 ? w.slice(0, -1) : w)).join(' ');
  if (read2(typo)) check(read2(typo) === code && m.describe_finish(id, parts, typo) === '1 part: 2', `a missing last letter is read back in full (${typo} -> ${read2(typo)})`);

  // the sender: the same meaning as before Start; a refused code keeps the current one; Send everything clears it
  const sender = () => new m.WebSender('big.bin', big, 1024, 1024, '', false);
  const a = sender();
  check(a.finish(code) === '1 part: 2' && a.finishing() === '1 part: 2', 'WebSender.finish: what the words mean, and it sends only those parts');
  { const e = refused(() => a.finish(m.finish_code(sid, sparts, Uint32Array.from([0])))); check(!!e && a.finishing() === '1 part: 2', `a refused code changes nothing (${e})`); }
  a.send_everything();
  check(a.finishing() === '' && !a.focus_done(), 'Send everything: back to every part');
  a.free();
  // the named parts sent, the sender goes back to every part by itself and says so (focus_done) until new words
  {
    const s = new m.WebSender('big.bin', big, 1024, 1024, 'satin-swift', false);
    s.finish(code);
    let n = 0;
    while (!s.focus_done() && n < 5000) { s.next_frame_rgba(); n++; }
    check(s.focus_done() && s.finishing() === '' && n > 100, `the named part sent: back to every part by itself after ${n} frames (focus_done)`);
    check(s.finish(code) === '1 part: 2' && !s.focus_done(), 'new words: the named parts again, focus_done false');
    s.free();
  }
  // words typed before Start reach a sender built at Start: it draws its own fresh repair offset, so two senders of
  // the same file given the same words send different packets (a restarted sender never repeats what the receiver
  // has); with no words the schedule is the file's own, the same on both (Review Focus 1)
  const frames = (s, k) => { const out = []; for (let i = 0; i < k; i++) out.push(Buffer.from(s.next_frame_rgba())); return out; };
  const [p, q] = [sender(), sender()], [u, v] = [sender(), sender()];
  p.finish(code); q.finish(code);
  const fp = frames(p, 6), fq = frames(q, 6), fu = frames(u, 6), fv = frames(v, 6);
  const same = (x, y) => x.map((f, i) => f.equals(y[i]));
  check(same(fu, fv).every(Boolean), 'two senders of one file with no words: the same frames');
  check(same(fp, fq)[0] && same(fp, fq).slice(1).every((s) => !s), `two senders given the same words: the manifest frame alike, every data frame different (${same(fp, fq).map((s) => (s ? '=' : 'x')).join('')})`);
  check(same(fp, fu).slice(1).every((s) => !s), 'the words change what is sent');
  for (const s of [p, q, u, v]) s.free();

  // calibration words share the list, and the two fields never take each other's words
  const PRESETS = { 'sauce-minivan': '3,bw,30', 'satin-swift': '2,bw,30', 'sardine-berry': '1,bw,30' };
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const [c, d] of Object.entries(PRESETS)) {
    check(m.describe_code(c) === d && html.includes(`value="${c}"`), `the Speed preset ${c} is ${d} (${refused(() => m.describe_code(c)) || m.describe_code(c)})`);
    check(m.describe_code(c.toUpperCase().replace('-', ', ')) === d, `${c}: any case, comma between the words`);
    const calib = refused(() => m.check_finish_words(c)) || '';
    check(calib === FOUR, `calibration words in the Finish field are refused before Start, saying where they go (${calib})`);
    check(refused(() => m.describe_finish(id, parts, c)) === FOUR, `and against the file (${c})`);
    const s = sender();
    check(refused(() => s.finish(c)) === FOUR && s.finishing() === '', `and by the sender at Start, which keeps sending everything (${c})`);
    s.free();
  }
  // every finish code of the two test files is refused by the Speed field (none is ever calibration words)
  let fin = 0, finBad = [];
  for (const [fid, n] of [[id, parts], [sid, sparts], [0x4c5b, 32], [0x4c5b, 320]]) {
    const pats = n <= 3 ? [[0], [1], [n - 1], [0, n - 1]] : [[0], [3, 14, 27], [...Array(7).keys()].map((i) => i + 5), [1, 2, 9, 30], [...Array(17).keys()].map((i) => i * Math.floor(n / 17))];
    for (const pat of pats) {
      const c = m.finish_code(fid, n, Uint32Array.from(pat.filter((u) => u < n)));
      if (!c) continue;
      fin++;
      const e = refused(() => m.describe_code(c));
      if (!e) finBad.push(c);
      else if (c.split(' ').length >= 3 || /^[a-z]+ [a-z]+$/.test(c) && WORDS.indexOf(c.split(' ')[0]) < 768) {
        if (e !== 'These are not calibration words. Finish words go in Finish words.') finBad.push(`${c}: ${e}`);
      }
    }
  }
  check(fin >= 10 && finBad.length === 0, `finish words in the Speed field: ${fin} codes refused, named as finish words where they have 2+ words (${finBad.join('; ')})`);
  check(m.describe_code('song-pretzel') === '2,bw,60' && m.describe_code('tofu-studio') === '3,c8,20', 'calibration words for other frame rates (60 and 20 fps: the codes name 20, the 3-refresh rate, not 24)');
  check(refused(() => m.describe_code('sardine')) === 'Those words are not a LensBolt code. Check the spelling on the phone.', 'one word alone (calibration words being typed) is not called finish words');
  check(refused(() => m.describe_code('sardine-be')) === 'Those words are not a LensBolt code. Check the spelling on the phone.', 'a word being typed: the same sentence (the alert does not change with every letter)');
}

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

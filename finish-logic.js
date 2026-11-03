// The sender's Finish field, apart from the page: the word being typed, the completion shown after it (accepted
// with Tab only: Space ends a word as typed, and the matcher then reads it), and what Enter does with the words;
// also which file the words belong to, and what calibration words mean.
// Pure: the word rules come in as functions (the wasm's suggest_word, check_finish_words or WebSender.finish),
// so node tests this on its own: node web/tests/finish-logic.mjs.

const SEP = /[\s,-]/;
const isSep = (c) => SEP.test(c);

/** The word the caret ends: its start, end and letters; null when the caret is not right after a word. */
export function wordAt(value, caret) {
  if (caret < value.length && !isSep(value[caret])) return null;
  let start = caret;
  while (start > 0 && !isSep(value[start - 1])) start--;
  return start === caret ? null : { start, end: caret, text: value.slice(start, caret) };
}

/** The completion shown after the last letters of the field: the whole word `suggest` names for them and the
 *  rest of it still to type; null when there is none to show (the caret elsewhere, a selection, a word already
 *  typed in full, or no suggestion: `suggest` never names a word other than the one meant). */
export function completion(value, caret, suggest, selEnd = caret) {
  if (selEnd !== caret || caret !== value.length) return null;
  const w = wordAt(value, caret);
  if (!w || w.text.length < 2) return null;
  const typed = w.text.toLowerCase(), word = suggest(w.text) || '';
  if (!word || word === typed || !word.startsWith(typed)) return null;
  return { word, rest: word.slice(typed.length), start: w.start, end: w.end };
}

/** Tab: the typed letters become the whole word, then a space; the new value and caret, or null when there is
 *  nothing to accept (Tab then moves the focus as it always does). */
export function accept(value, caret, suggest, selEnd = caret) {
  const c = completion(value, caret, suggest, selEnd);
  if (!c) return null;
  const v = value.slice(0, c.start) + c.word + ' ';
  return { value: v, caret: v.length };
}

/** The word a refusal names (between the quotes of its message), or null. */
export function refusedWord(message) {
  const m = /“([^”]*)”/.exec(message || '');
  return m ? m[1] : null;
}

/** Where `word` is in the field, any case: [start, end] of its first use, or null. */
export function findWord(value, word) {
  const re = /[^\s,-]+/g, want = String(word).toLowerCase();
  for (let m; (m = re.exec(value));) if (m[0].toLowerCase() === want) return [m.index, m.index + m[0].length];
  return null;
}

/** Enter: an empty field goes back to sending everything; otherwise `check` (which throws the refusal as a
 *  message) says what the words mean, and `read` gives them back as the matcher read them, each in full. A
 *  refusal that names one word selects it in the field for typing again. */
export function applyWords(text, check, read) {
  const t = text.trim();
  if (!t) return { kind: 'clear' };
  try {
    const desc = check(t);
    return { kind: 'ok', desc, words: read(t) || t };
  } catch (e) { return refusal(text, e); }
}

/** A refusal (a thrown message or Error) for the words in the field: its message, and the word it names
 *  selected for typing again when it names one. */
export function refusal(text, e) {
  const error = String(e && e.message !== undefined ? e.message : e);
  const w = refusedWord(error);
  return { kind: 'error', error, select: w ? findWord(text, w) : null };
}

/** A chosen file as the words remember it: its name, size and last change (the same file chosen again for a resume
 *  has the same key; another file, or this one changed since, another). null for no file. */
export function fileKey(f) {
  return f ? `${f.name}\n${f.size}\n${f.lastModified}` : null;
}

/** Whether words typed for the file of key `wordsFile` stay when `picked` is chosen: for the same file (a resume),
 *  and words typed before any file was chosen; never for another file (its words would be checked against this one,
 *  and a wrong code passes the check 1 time in 64). */
export function wordsStayFor(wordsFile, picked) {
  return wordsFile === null || wordsFile === fileKey(picked);
}

const ALPHABETS = { bw: 'black and white', g4: '4 greys', g8: '8 greys', c4: '4 colours', c8: '8 colours', c16: '16 colours' };
/** What calibration words mean, from describe_code's "pitch,alphabet,fps": "3 px · black and white · 30 fps". */
export function codeMeaning(desc) {
  const [pitch, alphabet, fps] = String(desc).split(',');
  return `${pitch} px · ${ALPHABETS[alphabet] || alphabet} · ${fps} fps`;
}

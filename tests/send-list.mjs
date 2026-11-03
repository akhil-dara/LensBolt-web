// The sender's file list on its own (web/send-list.js): sizes and the running total, names split so the extension
// stays in view, what a drop brings (files; folders left out), which list the finish words belong to, where the
// focus goes after Remove, how finish words read for a batch, and the one-time flashing notice. No browser, no wasm.
//
//   node web/tests/send-list.mjs
import { BROWSER_LIMIT, fmtSize, totals, totalLine, totalText, memoryNote, isMemoryRefusal, splitName, dropped, folderNote, selectionKey, wordsStay, focusAfter, partsPhrase,
  noticeSeen, rememberNotice, NOTICE_KEY, slices, passLine, stoppedLine, readingLine, readingNews, progressDue, removedText } from '../send-list.js';

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const file = (name, size, lastModified = 1) => ({ name, size, lastModified });

// Remove all is never silent: the line beside its Undo
check(removedText(1) === 'Removed 1 file.' && removedText(200) === 'Removed 200 files.' && removedText(10000) === 'Removed 10,000 files.', `Remove all says how many (${removedText(10000)})`);

// --- sizes and the running total ---
check(fmtSize(0) === '0 B' && fmtSize(999) === '999 B' && fmtSize(1500) === '2 KB' && fmtSize(2.5e6) === '2.5 MB' && fmtSize(1.5e9) === '1.50 GB', 'sizes as the page shows them');
check(eq(totals([file('a', 10), file('b', 0), file('a', 10)]), { count: 3, bytes: 20 }), 'the total counts every file, duplicates and empty ones included');
check(totalLine([]) === '' && totalLine([file('a.jpg', 0)]) === '1 file · 0 B' && totalLine([file('a', 1e6), file('b', 1.5e6)]) === '2 files · 2.5 MB', 'the running total line');
check(totalText(0, 0) === '' && totalText(10000, 2.5e6) === '10000 files · 2.5 MB' && totalText(1, 0) === '1 file · 0 B', 'the total from counts kept as the list changes (no walk over the list)');
// the desktop app is named once: in the note beside the list, never in a row
const DESK = 'The LensBolt desktop app sends any size from disk.';
check(BROWSER_LIMIT === 1.5e9 && memoryNote(1.5e9, false) === '' && memoryNote(1.6e9, false) === `Over 1.5 GB in all: this tab holds every file in memory while it sends, and may run out. ${DESK}`,
  'past 1.5 GB read into memory (not at it) the note names the desktop app');
check(memoryNote(0, true) === `This tab cannot hold every file in memory. ${DESK}` && memoryNote(2e9, true) === memoryNote(0, true), 'a file this tab could not hold: the note, once, whatever was read');
check(isMemoryRefusal('This browser cannot hold this file in memory.') && !isMemoryRefusal('Could not read this file (NotReadableError). Remove it and add it again.'), 'which row errors are memory refusals');

// --- names: the end stays in view ---
check(eq(splitName('holiday.jpeg'), { stem: 'holiday', ext: '.jpeg' }), 'stem and extension');
check(eq(splitName('archive.tar.gz'), { stem: 'archive.tar', ext: '.gz' }), 'the last extension');
check(eq(splitName('.bashrc'), { stem: '.bashrc', ext: '' }) && eq(splitName('README'), { stem: 'README', ext: '' }) && eq(splitName('a.'), { stem: 'a.', ext: '' }), 'a leading dot, no dot, a trailing dot: no extension');
check(eq(splitName('x.' + 'e'.repeat(20)), { stem: 'x.' + 'e'.repeat(20), ext: '' }), 'an "extension" over 16 characters is part of the name');

// --- a drop: files only ---
const a = file('a.jpg', 5), b = file('b', 0), dir = file('Photos', 0);
check(eq(dropped([{ file: a, isDirectory: false }, { file: dir, isDirectory: true }, { file: b, isDirectory: false }]), { files: [a, b], folders: 1 }), 'folders are left out, files kept in order (a 0-byte file too)');
check(eq(dropped([{ file: null, isDirectory: false }]), { files: [], folders: 0 }), 'an item that is no file brings nothing');
check(folderNote(0) === '' && folderNote(1) === 'A folder was left out: LensBolt sends files. Open the folder and drop the files in it.' &&
  folderNote(3) === '3 folders were left out: LensBolt sends files. Open the folders and drop the files in them.', 'what is said about left-out folders');

// --- which list the finish words belong to ---
const key = (f) => `${f.name}\n${f.size}\n${f.lastModified}`;
check(selectionKey([], key) === null, 'no files: no list');
check(selectionKey([a], key) === key(a), 'one file: the file\'s own key (as before the list)');
check(selectionKey([a, b], key) !== selectionKey([b, a], key) && selectionKey([a, a], key) !== selectionKey([a], key), 'another order or a duplicate is another batch');
check(wordsStay(null, 'k') && wordsStay('k', 'k') && !wordsStay('k', 'j'), 'words typed before any file stay; for the same list they stay; for another list they go');
check(wordsStay('k', null), 'an emptied list keeps the words until files are chosen again (the same file again: a resume)');

// --- Remove: where the focus goes ---
check(focusAfter(3, 1) === 1 && focusAfter(3, 2) === 1 && focusAfter(1, 0) === -1, 'after Remove: the next row (now at the same place), else the one before, else none (the drop area)');

// --- finish words for a batch ---
check(partsPhrase('3 files: a.jpg, b.pdf +1') === 'the parts holding 3 files: a.jpg, b.pdf +1' && partsPhrase('1 file: d.bin') === 'the parts holding 1 file: d.bin', 'a batch: the parts holding the files');
check(partsPhrase('3 parts: 7, 12, 30') === '3 parts: 7, 12, 30' && partsPhrase('') === '', 'one file: the parts, unchanged');

// --- the flashing notice, once per browser ---
const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
const s = store();
check(!noticeSeen(s), 'not seen in a fresh browser');
rememberNotice(s);
check(noticeSeen(s) && s.getItem(NOTICE_KEY) === '1', 'remembered once acknowledged');
const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
check(!noticeSeen(throwing) && (rememberNotice(throwing), true), 'storage that throws: shown again, never an error');
check(!noticeSeen(null) && !noticeSeen(undefined) && (rememberNotice(null), true), 'no storage at all: shown again, never an error');

// --- reading a file into memory a piece at a time ---
check(eq(slices(0, 16), []) && eq(slices(10, 16), [[0, 10]]) && eq(slices(40, 16), [[0, 16], [16, 32], [32, 40]]), 'pieces of at most the piece size, the last one short; none for an empty file');
check(readingLine(0, 0) === '' && readingLine(37, 200) === 'Reading files: 37 of 200 in.' && readingLine(0, 1) === 'Reading the file.', 'the reading line');
check(readingNews(200, true) === 'Reading 200 files.' && readingNews(1, true) === 'Reading 1 file.' && readingNews(200, false) === '200 files read.' && readingNews(1, false) === 'The file is read.', 'what is announced: reading starts, reading ends');
check(progressDue(1500, 1000, false) === false && progressDue(2000, 1000, false) && progressDue(1001, 1000, true), 'the progress line changes at most once a second, and at once when reading ends');

// --- the lines that name the file, or the files ---
check(passLine(7.24, 1) === 'The screen shows this file once every <b class="tnum">7.2 s</b>. A steady phone finishes in one to two passes.', 'one file: as before');
check(passLine(42.6, 3) === 'The screen shows these 3 files once every <b class="tnum">43 s</b>. A steady phone finishes in one to two passes.', 'a batch');
check(stoppedLine(300, 30, 200, 1) === 'Stopped after 0:10 (1.5× the file).' && stoppedLine(300, 30, 200, 4) === 'Stopped after 0:10 (1.5× the files).' && stoppedLine(1, 30, 200, 4) === 'Stopped before sending.', 'the Stop line');

console.log(failed ? `\n${failed} failed` : '\nall ok');
process.exit(failed ? 1 : 0);

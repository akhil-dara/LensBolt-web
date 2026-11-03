// The sender's file list, apart from the page: sizes and the running total, names split so their end stays in
// view, what a drop brings, which list finish words belong to, where the focus goes after Remove, how finish words
// read for a batch, the one-time flashing notice, and the lines that name the file or the files.
// Pure (storage comes in as an argument), so node tests it on its own: node web/tests/send-list.mjs.

/** Above this many bytes in all, the page points to the desktop app: every chosen file is held in this tab's
 *  memory while it is sent. */
export const BROWSER_LIMIT = 1.5e9;
/** The localStorage key that remembers the flashing notice was acknowledged in this browser. */
export const NOTICE_KEY = 'lb-flash-ok';

export const fmtSize = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n >= 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n >= 1e3 ? (n / 1e3).toFixed(0) + ' KB' : n + ' B');

/** How many files and bytes the list holds (duplicates and empty files count like any other). */
export function totals(files) {
  let bytes = 0;
  for (const f of files) bytes += f.size;
  return { count: files.length, bytes };
}

/** The running total from counts the page keeps as the list changes: "3 files · 12.4 MB"; empty for no files. */
export const totalText = (count, bytes) => (count ? `${count} file${count === 1 ? '' : 's'} · ${fmtSize(bytes)}` : '');
/** The running total of a list of files. */
export function totalLine(files) {
  const { count, bytes } = totals(files);
  return totalText(count, bytes);
}

const DESKTOP = 'The LensBolt desktop app sends any size from disk.';
/** The note beside the list, the one place the desktop app is named: past 1.5 GB read into this tab's memory (bytes
 *  actually read, not files refused), or once a file could not be held at all; empty otherwise. */
export function memoryNote(readBytes, refused) {
  if (refused) return `This tab cannot hold every file in memory. ${DESKTOP}`;
  return readBytes > BROWSER_LIMIT ? `Over 1.5 GB in all: this tab holds every file in memory while it sends, and may run out. ${DESKTOP}` : '';
}
/** Whether a row's error is the module refusing a file for memory (WebFiles::begin), not a read failure. */
export const isMemoryRefusal = (msg) => /^This browser cannot hold this file in memory\./.test(String(msg));

/** A name as a stem that may be shortened and an extension that stays: the last ".ext" of at most 16 characters
 *  after a non-empty stem; none for ".bashrc", "README" or "a.". */
export function splitName(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1 || name.length - dot > 16) return { stem: name, ext: '' };
  return { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/** What a drop brings: its files, in order, and how many folders were left out (LensBolt sends files; a folder's
 *  structure is not sent, so its files are dropped by the user, not gathered here). `items`: { file, isDirectory }. */
export function dropped(items) {
  const files = [];
  let folders = 0;
  for (const it of items) {
    if (it.isDirectory) folders++;
    else if (it.file) files.push(it.file);
  }
  return { files, folders };
}

/** What is said when a drop held folders; empty when none. */
export function folderNote(n) {
  if (!n) return '';
  return n === 1 ? 'A folder was left out: LensBolt sends files. Open the folder and drop the files in it.'
    : `${n} folders were left out: LensBolt sends files. Open the folders and drop the files in them.`;
}

/** The list as finish words remember it: null for no files, the file's own key for one (as before the list), the
 *  keys in order for several (another order, or a file added twice, is another batch, with other words). */
export function selectionKey(files, fileKey) {
  if (!files.length) return null;
  return files.length === 1 ? fileKey(files[0]) : files.map(fileKey).join('\u0000');
}

/** Whether words typed for the list `wordsKey` stay with the list `key`: words typed before any file, the same list,
 *  and an emptied list (until files are chosen again: the same file again is a resume) keep them; another list
 *  clears them (checked against it, a wrong code would pass 1 time in 64). */
export const wordsStay = (wordsKey, key) => key === null || wordsKey === null || wordsKey === key;

/** After row `index` of `count` rows is removed: the index, in the list as it is now, of the row that takes the focus
 *  (the next one, which moved up into its place, else the one before), or -1 when the list is now empty (the drop
 *  area takes it). */
export function focusAfter(count, index) {
  if (index + 1 < count) return index;
  return index > 0 ? index - 1 : -1;
}

/** What finish words send, in a sentence: a batch names the files in the parts the words name (the phone may hold
 *  some of them already: they are the files in these parts), one file names its parts. */
export const partsPhrase = (desc) => (/^\d+ files?: /.test(desc) ? `the parts holding ${desc}` : desc);

/** Whether this browser was told the tile flashes; false when storage is missing or refuses (told again). */
export function noticeSeen(storage) {
  try { return !!storage && storage.getItem(NOTICE_KEY) === '1'; } catch { return false; }
}
export function rememberNotice(storage) {
  try { if (storage) storage.setItem(NOTICE_KEY, '1'); } catch { /* not remembered: shown again next time */ }
}

/** A file of `size` bytes read in pieces of at most `piece`: [start, end) of each, in order. */
export function slices(size, piece) {
  const out = [];
  for (let at = 0; at < size; at += piece) out.push([at, Math.min(size, at + piece)]);
  return out;
}

/** While files are read into memory: how many are in; empty when none is being read. */
export function readingLine(done, count) {
  if (!count || done >= count) return '';
  return count === 1 ? 'Reading the file.' : `Reading files: ${done} of ${count} in.`;
}

/** What a screen reader hears about reading: when it starts, and when it ends (the progress between is only shown). */
export function readingNews(count, starting) {
  if (starting) return `Reading ${count} file${count === 1 ? '' : 's'}.`;
  return count === 1 ? 'The file is read.' : `${count} files read.`;
}
/** Whether the progress line may change now: at most once a second, and at once when reading ends. */
export const progressDue = (now, lastShown, finished) => finished || now - lastShown >= 1000;

/** How long one pass over the file (or the files) takes on screen; HTML (the time in bold). */
export function passLine(seconds, count) {
  const s = seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds));
  return `The screen shows ${count > 1 ? `these ${count} files` : 'this file'} once every <b class="tnum">${s} s</b>. A steady phone finishes in one to two passes.`;
}

/** The status line after Stop: frames shown `n` at `fps`, `perPass` frames a pass. */
export function stoppedLine(n, fps, perPass, count) {
  if (n <= 1) return 'Stopped before sending.';
  const t = n / fps;
  return `Stopped after ${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')} (${(n / perPass).toFixed(1)}× the file${count > 1 ? 's' : ''}).`;
}

/** After Remove all, beside its Undo: "Removed 200 files." */
export const removedText = (n) => `Removed ${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')} file${n === 1 ? '' : 's'}.`;

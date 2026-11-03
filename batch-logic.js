// The browser receiver's batch view, apart from the page: the summary line in real numbers, each file's state in
// plain words, the filters, which rows a scrolled list draws, names shortened in the middle only when they do not fit,
// a name made free in a folder, CRC-32 and a stored (uncompressed) zip laid out as parts of a Blob, so Save all never
// holds the files in memory. Pure, so node tests it on its own: node web/tests/batch-logic.mjs.

/** Sizes as the receiver shows them (binary units, as the rest of the page). */
export const human = (b) => (b >= 1 << 30 ? (b / 1073741824).toFixed(2) + ' GB' : b >= 1 << 20 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : b + ' B');
/** A count with thousands separated: 10,000. */
export const count = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const files = (n) => `${count(n)} file${n === 1 ? '' : 's'}`;
const REFUSED = 'The file list did not verify: no file can be saved.';

/** While receiving: "12 of 40 files · 18.0 MB of 64.0 MB" (the stream's bytes), failures named; before the list,
 *  "Waiting for the file list". `b`: the status's batch object. */
export function summaryLive(b, gotBytes, streamBytes) {
  if (b.error) return REFUSED;
  if (!b.total) return 'Waiting for the file list';
  return `${count(b.received)} of ${files(b.total)}${b.failed ? ` · ${count(b.failed)} failed` : ''} · ${human(gotBytes)} of ${human(streamBytes)}`;
}

/** Done: "3 files · 2.2 MB · all verified" (the bytes of the files received, added up), or "38 of 40 files · 2.1 MB
 *  · 2 failed". `notKept` files were received but their copy on the device failed (`why`, e.g. "storage full"): then
 *  "38 of 40 kept · 2 not kept: storage full", never "all verified". */
export function summaryDone(b, receivedBytes, notKept = 0, why = '') {
  if (b.error) return REFUSED;
  if (notKept > 0) return `${count(Math.max(0, b.received - notKept))} of ${count(b.total)} kept · ${count(notKept)} not kept${why ? `: ${why}` : ''}${b.failed ? ` · ${count(b.failed)} failed` : ''}`;
  if (b.received === b.total && !b.failed) return `${files(b.total)} · ${human(receivedBytes)} · ${b.total === 1 ? 'verified' : 'all verified'}`;
  return `${count(b.received)} of ${files(b.total)} · ${human(receivedBytes)}${b.failed ? ` · ${count(b.failed)} failed` : ''}`;
}

// the receiver's reasons (core/src/file/receiver.rs) in the page's words
const REASONS = { 'checksum mismatch': 'its bytes did not verify', 'does not unpack to its size': 'it did not unpack to its size', 'cannot be unpacked': 'it could not be unpacked' };
/** A file's state: "Waiting", "Receiving 40%", "Received", "Failed: storage full". `f`: a batch_page file. */
export function stateText(f) {
  switch (f.state) {
    case 'receiving': return `Receiving ${Math.floor((f.progress || 0) * 100)}%`;
    case 'received': return 'Received';
    case 'failed': return `Failed: ${REASONS[f.reason] || f.reason || 'unknown reason'}`;
    default: return 'Waiting';
  }
}
/** A row as a screen reader reads it: "photo.jpg, 2.1 MB, received". */
export const rowLabel = (f) => `${f.name}, ${human(f.size)}, ${stateText(f).toLowerCase()}`;

export const FILTERS = ['all', 'received', 'missing', 'failed'];
/** How many files each filter shows. Missing: neither received nor failed (each file's own state). */
export const filterCounts = (b) => ({ all: b.total, received: b.received, missing: Math.max(0, b.total - b.received - b.failed), failed: b.failed });
export function inFilter(state, filter) {
  if (filter === 'received') return state === 'received';
  if (filter === 'failed') return state === 'failed';
  if (filter === 'missing') return state !== 'received' && state !== 'failed';
  return true;
}

/** The rows a list of `count` rows of `rowH` px draws when scrolled to `top` in a view `viewH` px tall: [start, end),
 *  those in view and `over` more either side. */
export function visibleRows(top, viewH, rowH, count, over) {
  const start = Math.max(0, Math.floor(top / rowH) - over);
  return [Math.min(start, count), Math.min(count, Math.ceil((top + viewH) / rowH) + over)];
}

/** [stem, extension]: the last ".ext" of at most 16 characters after a non-empty stem (the sender's rule). */
export function splitName(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1 || name.length - dot > 16) return [name, ''];
  return [name.slice(0, dot), name.slice(dot)];
}
/** `name` as it fits (`fits(text)`: whether a text fits the space, two lines say): whole when it does, else the
 *  longest "start…end.ext" that does, the extension always kept. */
export function middleFit(name, fits) {
  if (fits(name)) return name;
  const [stem, ext] = splitName(name);
  const at = (k) => { const head = Math.ceil(k * 0.6), tail = k - head; return stem.slice(0, head) + '…' + (tail ? stem.slice(stem.length - tail) : '') + ext; };
  let lo = 0, hi = stem.length - 1;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(at(mid))) lo = mid; else hi = mid - 1; }
  return at(lo);
}

/** `name`, or the first of "name (2).ext", "name (3).ext", ... that `taken` says is free (the receiver's own rule). */
export function freeName(name, taken) {
  if (!taken(name)) return name;
  const [stem, ext] = splitName(name);
  for (let n = 2; ; n++) { const c = `${stem} (${n})${ext}`; if (!taken(c)) return c; }
}

const TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
/** CRC-32 (the zip's) of `bytes`, carried on from `crc` for a file read in pieces. */
export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return ~c >>> 0;
}

/** A stored zip of `entries` ({ name, size, crc, data }: `data` a Blob or bytes) as the parts of a Blob: each file's
 *  header, the file itself (never copied), then the central directory and its end. Names are UTF-8; zip64 is used
 *  when a size, an offset or the count needs it (or `zip64`). */
export function zipParts(entries, { zip64 = false, date = new Date() } = {}) {
  const enc = new TextEncoder(), parts = [], central = [];
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const MAX = 0xFFFFFFFF;
  let offset = 0;
  const big = (v) => zip64 || v >= MAX;
  for (const e of entries) {
    const name = enc.encode(e.name), wide = big(e.size) || big(offset);
    // local header: sizes in a zip64 extra field when wide
    const lx = wide ? 20 : 0, local = new DataView(new ArrayBuffer(30 + name.length + lx));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, wide ? 45 : 20, true); local.setUint16(6, 0x0800, true);
    local.setUint16(8, 0, true); local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true); local.setUint32(14, e.crc, true);
    local.setUint32(18, wide ? MAX : e.size, true); local.setUint32(22, wide ? MAX : e.size, true); local.setUint16(26, name.length, true); local.setUint16(28, lx, true);
    new Uint8Array(local.buffer).set(name, 30);
    if (wide) { local.setUint16(30 + name.length, 1, true); local.setUint16(32 + name.length, 16, true); local.setBigUint64(34 + name.length, BigInt(e.size), true); local.setBigUint64(42 + name.length, BigInt(e.size), true); }
    parts.push(new Uint8Array(local.buffer), e.data);
    // central record: sizes and the offset in the extra field when wide
    const cx = wide ? 28 : 0, c = new DataView(new ArrayBuffer(46 + name.length + cx));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, (3 << 8) | 45, true); c.setUint16(6, wide ? 45 : 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true); c.setUint16(12, dosTime, true); c.setUint16(14, dosDate, true); c.setUint32(16, e.crc, true);
    c.setUint32(20, wide ? MAX : e.size, true); c.setUint32(24, wide ? MAX : e.size, true); c.setUint16(28, name.length, true); c.setUint16(30, cx, true);
    c.setUint32(38, 0o100644 << 16, true); c.setUint32(42, wide ? MAX : offset, true);
    new Uint8Array(c.buffer).set(name, 46);
    if (wide) { const x = 46 + name.length; c.setUint16(x, 1, true); c.setUint16(x + 2, 24, true); c.setBigUint64(x + 4, BigInt(e.size), true); c.setBigUint64(x + 12, BigInt(e.size), true); c.setBigUint64(x + 20, BigInt(offset), true); }
    central.push(new Uint8Array(c.buffer));
    offset += local.byteLength + e.size;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0), cdAt = offset, count = entries.length;
  parts.push(...central);
  const wideEnd = zip64 || count >= 0xFFFF || big(cdAt) || big(cdSize);
  const end = new DataView(new ArrayBuffer((wideEnd ? 56 + 20 : 0) + 22));
  let p = 0;
  if (wideEnd) {
    end.setUint32(0, 0x06064b50, true); end.setBigUint64(4, 44n, true); end.setUint16(12, 45, true); end.setUint16(14, 45, true);
    end.setBigUint64(24, BigInt(count), true); end.setBigUint64(32, BigInt(count), true); end.setBigUint64(40, BigInt(cdSize), true); end.setBigUint64(48, BigInt(cdAt), true);
    end.setUint32(56, 0x07064b50, true); end.setBigUint64(64, BigInt(cdAt + cdSize), true); end.setUint32(72, 1, true);
    p = 76;
  }
  end.setUint32(p, 0x06054b50, true);
  end.setUint16(p + 8, wideEnd ? 0xFFFF : count, true); end.setUint16(p + 10, wideEnd ? 0xFFFF : count, true);
  end.setUint32(p + 12, wideEnd ? MAX : cdSize, true); end.setUint32(p + 16, wideEnd ? MAX : cdAt, true);
  parts.push(new Uint8Array(end.buffer));
  return parts;
}

/** The files to save, from what the worker said it kept (`saved`: name -> { store | blob | error }), not from the rows
 *  fetched so far: those kept, in the list's order (`indexOf(name)`: the file's place, undefined when not known yet:
 *  last, in the order kept). */
export function keptInOrder(saved, indexOf) {
  const names = [...saved].filter(([, k]) => k && !k.error).map(([n]) => n);
  const at = (n) => { const i = indexOf(n); return Number.isFinite(i) ? i : Infinity; };
  return names.map((n, k) => [n, at(n), k]).sort((x, y) => x[1] - y[1] || x[2] - y[2]).map((x) => x[0]);
}

/** What a screen reader hears of a batch while it arrives (the summary line itself is not a live region): the summary
 *  when the file list arrives, a failure or a refused list at once, other count changes at most every `minMs`;
 *  bytes moving alone, never. `update` returns the text to say, or ''. */
export class Announcer {
  constructor(minMs = 5000) { this.minMs = minMs; this.key = null; this.at = -Infinity; this.failed = 0; this.error = null; this.total = 0; }
  update(b, text, now) {
    if (!b || (!b.total && !b.error)) return '';
    const key = `${b.total}|${b.received}|${b.failed}|${b.error || ''}`;
    if (key === this.key) return '';
    const urgent = this.key === null || b.failed !== this.failed || (b.error || null) !== this.error || b.total !== this.total;
    if (!urgent && now - this.at < this.minMs) return '';
    this.key = key; this.at = now; this.failed = b.failed; this.error = b.error || null; this.total = b.total;
    return text;
  }
}

/** Rows tied to files (`rows`: file key -> row): those whose file is still `needed` keep it, and so does the row
 *  holding the keyboard focus (`focused`: its file key), wherever it is; the others are `free` to take the files in
 *  `need` that have no row. */
export function rowPlan(rows, needed, focused) {
  const want = new Set(needed), keep = new Map(), free = [];
  for (const [k, r] of rows) { if (want.has(k) || k === focused) keep.set(k, r); else free.push(r); }
  return { keep, free, need: needed.filter((k) => !keep.has(k)) };
}

/** The space a batch needs on the device: the receiver's peak (`disk_peak`) and the largest file once more (each file
 *  is copied out of the receiver's store into a file of its own; the store's copy goes once it is out). 0 before the
 *  peak is known. */
export const batchNeed = (diskPeak, largest) => (diskPeak > 0 ? diskPeak + (largest || 0) : 0);

/** A row's state badge (shown, never pressed): tone, icon and words, never the colour alone. `done`: the batch has
 *  ended (a file still waiting is then Missing, the filter's word); `kept`: what the device kept of a received file
 *  ({ error } when its copy failed, e.g. storage full). */
export function badge(f, done, kept) {
  if (f.state === 'received') return kept && kept.error ? { tone: 'warn', icon: 'alert', text: `Not kept: ${kept.error}` } : { tone: 'ok', icon: 'check', text: 'Received' };
  if (f.state === 'receiving') return { tone: 'live', icon: 'down', text: stateText(f) };
  if (f.state === 'failed') return { tone: 'warn', icon: 'alert', text: stateText(f) };
  return done ? { tone: 'warn', icon: 'alert', text: 'Missing' } : { tone: 'wait', icon: 'clock', text: 'Waiting' };
}

/** The batch Done screen's tone and the guide pill's words: every file verified and kept ('ok', "Received"), or
 *  amber with how many ("Received 38 of 40", "Kept 38 of 40"). */
export function doneState(b, notKept = 0) {
  if (b.error) return { tone: 'warn', guide: 'Not received' };
  if (notKept > 0) return { tone: 'warn', guide: `Kept ${count(Math.max(0, b.received - notKept))} of ${count(b.total)}` };
  if (b.received === b.total && !b.failed) return { tone: 'ok', guide: 'Received' };
  return { tone: 'warn', guide: `Received ${count(b.received)} of ${count(b.total)}` };
}

/** The filters' counts from the whole list (Done: the last status may be a frame behind the list). */
export function filterCountsOf(list) {
  const n = { all: list.length, received: 0, missing: 0, failed: 0 };
  for (const f of list) { if (f && f.state === 'received') n.received++; else if (f && f.state === 'failed') n.failed++; else n.missing++; }
  return n;
}

/** Receive another while files are not saved: what it asks first. Keep is the safe default (the last button). */
export function discardAsk({ batch, received = 0, name = '' }) {
  const what = batch ? `${files(received)}` : name || 'the file';
  return {
    title: batch ? `Discard ${what.replace(/ files?$/, (m) => ` received${m}`)}?` : `Discard ${what}?`,
    text: batch ? `${received === 1 ? 'It is' : 'They are'} not saved yet. Save all keeps ${received === 1 ? 'it' : 'them'}; a new transfer removes ${received === 1 ? 'it' : 'them'} from this page.`
      : 'It is not saved yet. Save keeps it; a new transfer removes it from this page.',
    discard: 'Discard', keep: batch && received !== 1 ? 'Keep them' : 'Keep it',
  };
}

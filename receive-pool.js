// The browser receiver's reader pool: R reader workers decode camera frames side by side, one collector worker holds
// the file. These are the pool's rules, without workers (a module of their own for the node tests; the single-file
// build inlines them): how many readers, which reader takes a frame, when results reach the collector, which
// geometry a reader is handed, and when a reader is given up on.
//
// Each camera frame goes to the first idle reader; with none idle it is dropped and counted (no queue: at most R
// frames are in flight, and the fountain code does not mind which frames arrive). Results go to the collector as
// they finish (`order: true` holds a result until the earlier frames are in; the collector takes late records
// either way, keeping the newest frame's fields). Records waiting for the collector are bounded: past `backlog`,
// frames are dropped. Each reader tracks the frames it reads; when another reader has read a newer frame, that
// geometry goes with the next frame, so a reader that lost the tile finds it again at once.

/** Readers at most: past 4 the collector, the camera and the page share what is left. */
export const READERS_MAX = 4;

/** Readers at most on a device with this much memory or less (navigator.deviceMemory, GB): each reader is a
 * WebAssembly instance with its own frame buffers (~40 MB of the browser's memory measured per reader). */
export const SMALL_MEMORY_GB = 4, READERS_SMALL_MEMORY = 2;

/** Reader workers for a device with `cores` (navigator.hardwareConcurrency) and `memoryGb` (navigator.deviceMemory,
 * where the browser tells): cores - 2 (the page and the collector keep theirs), at most 4, at most 2 with 4 GB or
 * less, and none (the single worker that reads and collects) when that leaves fewer than 2: one reader beside the
 * collector measured no faster than the single worker. `forced` (the page's ?readers=N) wins when it is a count: 0
 * is the single worker, at most 8. How many of them take frames follows their decode time (`ReaderPool.fit`). */
export function readerCount(cores, forced, memoryGb) {
  if (Number.isFinite(forced) && forced >= 0) return Math.min(Math.floor(forced), 8);
  let r = cores > 0 ? Math.min(READERS_MAX, Math.floor(cores) - 2) : 0;
  if (memoryGb > 0 && memoryGb <= SMALL_MEMORY_GB) r = Math.min(r, READERS_SMALL_MEMORY);
  return r >= 2 ? r : 0;
}

export class ReaderPool {
  /** `n` readers. `busyMs`: a reader silent this long is given up on for its frame; `backlog`: records the collector
   * may have waiting (sent, held for order, or being read) before frames are dropped (default 2 per reader); `order`: hold a
   * result until the earlier frames' are in. */
  constructor(n, { busyMs = 5000, backlog = 2 * n, order = false } = {}) {
    this.readers = Array.from({ length: n }, () => ({ ready: false, dead: false, busy: false, seq: 0, since: 0, geo: 0, ms: 0 }));
    // readers that take frames (the first `cap`), from the decode time (`fit`); all of them until it is measured
    this.cap = n; this.turn = 0; this.results = 0;
    this.busyMs = busyMs; this.backlog = backlog; this.order = order;
    this.seq = 0; this.next = 1; this.held = new Map();
    this.offered = 0; this.dropped = 0; this.pending = 0;
    // the newest frame read with a tile, and its geometry (WebReader.hint)
    this.hint = { seq: 0, bytes: null };
  }
  /** Reader `i` has started. */
  ready(i) { if (!this.readers[i].dead) this.readers[i].ready = true; }
  /** Reader `i` failed (it did not start, or stopped). Its frame in flight, if any, is given up on. Returns the
   * results that were waiting for that frame (`deliver`) and whether no reader is left, started or starting
   * (`fallback`: the page goes back to the single worker). */
  failed(i) {
    const r = this.readers[i];
    r.dead = true; r.ready = false;
    let deliver = [];
    if (r.busy) { r.busy = false; deliver = this.giveUp(r.seq); }
    return { deliver, fallback: !this.readers.some((x) => !x.dead) };
  }
  /** Readers that take frames. */
  get live() { return this.readers.filter((r) => r.ready && !r.dead).length; }
  /** Whether frames go to the readers (else to the single worker). */
  get active() { return this.live > 0; }
  /** Frames being read now. */
  get inFlight() { return this.readers.filter((r) => r.busy).length; }
  /** Records the collector has waiting: sent and not answered, and held for order. */
  get waiting() { return this.pending + this.held.size; }
  /** The collector counted a re-anchor (status `reanchors` grew): every reader forgets its geometry with its next
   *  frame ('clear' in place of hint bytes) and identifies the tile from scratch; the first fresh read's geometry then
   *  spreads as usual. */
  reanchor() { this.hint = { seq: this.seq + 1, bytes: 'clear' }; }
  /** A camera frame at `now`: `{ reader, seq, hint }` (hint: newer geometry for that reader, else null), or null when
   * it is dropped (every reader busy, or the collector behind; counted) or the pool is not active (not counted). */
  offer(now) {
    if (!this.active) return null;
    this.offered++;
    const i = this.readers.findIndex((r, k) => k < this.cap && r.ready && !r.dead && !r.busy);
    // the frames being read will wait too once read: all of them stay within the backlog
    if (i < 0 || this.waiting + this.inFlight >= this.backlog) { this.dropped++; return null; }
    const r = this.readers[i];
    r.busy = true; r.seq = ++this.seq; r.since = now;
    let hint = null;
    if (this.hint.bytes && this.hint.seq > r.geo) { hint = this.hint.bytes; r.geo = this.hint.seq; }
    return { reader: i, seq: r.seq, hint };
  }
  /** Reader `i`'s result for frame `seq` (`{ ok, ms, hint }`: a tile read, its decode time, its geometry); returns the
   * results now due at the collector. With `order`, a result waits for the earlier frames; a result for a frame
   * already given up on goes at once. */
  done(i, seq, result, now) {
    const r = this.readers[i];
    // a reader's turn: from the frame offered to its result (the copy, the decode and both messages), what paces it
    if (r.busy && r.seq === seq) { r.busy = false; const turn = now - r.since; if (turn >= 0) { this.turn = this.turn ? this.turn * 0.9 + turn * 0.1 : turn; this.results++; } }
    if (Number.isFinite(result.ms)) r.ms = r.ms ? r.ms * 0.8 + result.ms * 0.2 : result.ms;
    if (result.ok) {
      r.geo = Math.max(r.geo, seq);
      if (result.hint && seq > this.hint.seq) this.hint = { seq, bytes: result.hint };
    }
    if (!this.order || seq < this.next) return [result];
    this.held.set(seq, result);
    return this.flush();
  }
  /** How many readers take frames, for a camera frame every `frameMs`: as many as reading at the camera's rate needs
   * (a reader's turn, frame offered to result, over the frame interval, plus one), from 1 to all of them; the rest
   * stay idle (no CPU, no heat, nothing held).
   * Decided once 10 frames are read; until then all take frames. Readers that are not live do not count: the cap
   * reaches that many live readers. Returns the cap (an index: readers before it take frames). */
  fit(frameMs) {
    if (this.results < 10 || !(frameMs > 0)) return this.cap;
    const want = Math.max(1, Math.min(this.readers.length, Math.floor(this.turn / frameMs) + 1));
    let live = 0, cap = this.readers.length;
    for (let k = 0; k < this.readers.length; k++) if (this.readers[k].ready && !this.readers[k].dead && ++live === want) { cap = k + 1; break; }
    this.cap = cap;
    return cap;
  }
  /** Readers silent past `busyMs` at `now` are given up on for their frame (they take frames again); returns the
   * results that were waiting for those frames, and how many readers were given up on. */
  expire(now) {
    let stalled = 0, deliver = [];
    for (const r of this.readers) {
      if (r.busy && now - r.since > this.busyMs) { r.busy = false; stalled++; deliver = deliver.concat(this.giveUp(r.seq)); }
    }
    return { deliver, stalled };
  }
  /** The page was hidden (no frames, no answers) and shows again at `now`: frames in flight are timed from now. */
  resume(now) { for (const r of this.readers) if (r.busy) r.since = now; }
  /** Frame `seq` will not come: the results held behind it go on. */
  giveUp(seq) {
    if (!this.order || seq < this.next || this.held.has(seq)) return [];
    this.held.set(seq, null);
    return this.flush();
  }
  flush() {
    const out = [];
    while (this.held.has(this.next)) { const x = this.held.get(this.next); this.held.delete(this.next); this.next++; if (x) out.push(x); }
    return out;
  }
  /** `n` records sent to the collector; `answered` when it gives a status for one. */
  toCollector(n = 1) { this.pending += n; }
  answered() { if (this.pending > 0) this.pending--; }
  /** For the details line: readers in use, decode ms per reader, frames offered and dropped for busy readers. */
  stats() { return { readers: this.live, taking: this.readers.filter((r, k) => k < this.cap && r.ready && !r.dead).length, ms: this.readers.map((r) => Math.round(r.ms)), offered: this.offered, dropped: this.dropped }; }
}

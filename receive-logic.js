// The browser receiver's rules, apart from the page: the guidance line, the camera's zoom and focus decisions,
// the sender-rate and other-version banners, the "nothing happening?" hint and the finish words. Pure (time and readings are passed in, nothing is
// read from the page or the camera), so node tests them on their own: node web/tests/receiver-logic.mjs.
// The guidance follows the phone app's rules (android/app/src/main/java/com/lensbolt/app/Guidance.kt).

/** A read counts as current for this long: the status of one frame says little, the last second says what the camera sees. */
export const FRESH_MS = 1200;
// codewords this share or better: the tile reads, so the user is never told to move
const READS_WELL = 0.9;
// edge-to-edge sampling spread that costs reads, and one worth fixing even while reading
const SKEW_HURTS = 1.15, SKEW_STRONG = 1.3;
const SEEN_MS = 3000;

export const HINTS = {
  search: { lock: 'search', text: 'Point at the LensBolt screen' },
  // the whole square must show: the tile was seen before, or nothing at all for a while
  whole: { lock: 'search', text: 'Point at the LensBolt screen so the whole square shows' },
  // the tile was lost mid-transfer: progress has stopped
  lost: { lock: 'warn', text: 'Point back at the LensBolt screen' },
  square: { lock: 'warn', text: 'Square up to the screen' },
  steady: { lock: 'warn', text: 'Hold steady' },
  zooming: { lock: 'locked', text: 'Hold steady: zooming in' },
  locked: { lock: 'locked', text: 'Locked on, reading' },
  // the square already fills the picture and its cells are still too small: closer cannot help, a coarser format can
  dense: { lock: 'warn', text: 'Too fine for this camera: choose a slower speed on the computer' },
  good: { lock: 'good', text: 'Hold steady' },
  // locked on (the tile tracked, codewords decoding now and then) while most do not: reading, and why when the
  // status shows it (two sender frames blended in each picture; the border's edges soft); not locked: hold steady
  reading: { lock: 'locked', text: 'Reading…' },
  readingOverlap: { lock: 'locked', text: 'Reading… two frames overlap in each picture: a slower sender rate helps (20 or 15 fps)' },
  readingTiming: { lock: 'locked', text: "Reading… finding the screen's timing" },
  readingFocus: { lock: 'locked', text: 'Reading… focusing' },
  // the tile tracked, not one codeword decoding (so never locked on): reading, not "Hold steady" alone
  readingUnlocked: { lock: 'warn', text: 'Reading…' },
  readingUnlockedFocus: { lock: 'warn', text: 'Reading… focusing' },
  steadyFocus: { lock: 'warn', text: 'Hold steady: focusing' },
};
/** The blend that costs reads (status `mix`: the share of the tile two sender frames share the light over; the
 *  2026-11-02 captures that read 0-4 of 111: 0.49-0.59, every clean capture measured 0.00-0.03; the app steps its
 *  camera's phase on the same line) and the border edge width that means soft focus or smear (status `edge_px`,
 *  camera px: 1.48-1.53 on every phone capture measured). As the app's Guidance.MIX_SHOWS / EDGE_SOFT. */
export const MIX_SHOWS = 0.15, EDGE_SOFT = 2.5;
/** "Locked on": the tile read without a gap for TRACK_MS and a codeword decoded among the last LAST_READS data
 *  reads; once on, held HOLD_MS after the codewords stop, gone at once when the tile is lost (the app's LockWatch).
 *  A transfer whose reads mostly fail but still decode now and then is being read. */
export class LockWatch {
  constructor(trackMs = 500, lastReads = 10, holdMs = 1000) { this.trackMs = trackMs; this.lastReads = lastReads; this.holdMs = holdMs; this.reset(); }
  reset() { this.since = -Infinity; this.onAt = -Infinity; this.recent = []; }
  /** One status: `fresh` a tile read lately; `newRead` it brought a new data read, with `codewordsOk`. */
  update(fresh, newRead, codewordsOk, now) {
    if (!fresh) { this.reset(); return false; }
    if (this.since === -Infinity) this.since = now;
    if (newRead) { this.recent.push(codewordsOk); if (this.recent.length > this.lastReads) this.recent.shift(); }
    const on = now - this.since >= this.trackMs && this.recent.some((c) => c > 0);
    if (on) this.onAt = now;
    return on || now - this.onAt < this.holdMs;
  }
}
/** The square's share of the picture from which "move closer" cannot help any more. */
export const FILLS = 0.85;
/** "Move closer", with how close: the square's share of the camera picture now. */
export function closer(fill) {
  if (fill >= FILLS) return HINTS.dense;
  const now = fill > 0 ? ` (now ${Math.round(Math.min(fill, 1) * 100)}%)` : '';
  return { lock: 'warn', text: `Move closer: the square should fill the frame${now}`, kind: 'closer' };
}
const kind = (h) => h.kind || h.text + '|' + h.lock;
/** Which guidance line shows (as the app's HintHold): a new line waits out `holdMs` only between two warnings
 *  (one odd capture never flips "Move closer" to "Square up"); it shows at once when the square is found (the
 *  shown line is searching or lost) and when all is well again. The same line with new numbers shows at once. */
export class HintHold {
  constructor(holdMs = 600) { this.holdMs = holdMs; this.reset(); }
  reset() { this.shown = HINTS.search; this.cand = null; this.since = 0; }
  next(h, now) {
    if (kind(h) === kind(this.shown)) { this.shown = h; this.cand = null; return h; }
    // a warning after a warning or after a good line waits out the hold; lost and searching show at once
    const hold = this.shown.lock !== 'search' && this.shown !== HINTS.lost && h.lock === 'warn' && h !== HINTS.lost;
    if (!hold) { this.shown = h; this.cand = null; return h; }
    if (!this.cand || kind(h) !== kind(this.cand)) { this.cand = h; this.since = now; return this.shown; }
    this.cand = h;
    if (now - this.since >= this.holdMs) { this.shown = h; this.cand = null; }
    return this.shown;
  }
}

/** "2px bw 1024x1024" -> { pitch, alphabet, w, h }; null for anything else. */
export function parseFormat(f) {
  const m = /^(\d+)px (\w+) (\d+)x(\d+)$/.exec(f || '');
  return m ? { pitch: +m[1], alphabet: m[2], w: +m[3], h: +m[4] } : null;
}
/** Camera px per cell at which a format starts to read: 1 px b/w from ~2.45 (the 1 px verdict on real captures),
 *  2 px b/w and coarser from 1.45 (the reader's local equaliser on degraded real captures,
 *  docs/2026-10-31-fhd-2px-floor.md, with margin; larger cells read at least as well); grey and colour alphabets
 *  are held to the higher figure until measured. The app uses the same floors. */
export function floor(pitch, bw) { return !bw || pitch <= 1 ? 2.45 : 1.45; }
/** "Move closer" below this share over the floor (while codewords fail); the refocus watch keeps to the same line,
 *  so one cell size never says both "closer" and "refocus". */
export const CLOSER_OVER_FLOOR = 1.1;
/** Largest over smallest edge sampling: 1.0 is square-on. */
export function skew(edges) {
  if (!edges || !edges.length) return 1;
  const lo = Math.min(...edges), hi = Math.max(...edges);
  return lo > 0 ? hi / lo : 1;
}
/** The tile's four corners [x0, y0, ... x3, y3] (camera px): its two mean side lengths. */
function sides(c) {
  const d = (i, j) => Math.hypot(c[2 * i] - c[2 * j], c[2 * i + 1] - c[2 * j + 1]);
  return [(d(0, 1) + d(3, 2)) / 2, (d(1, 2) + d(0, 3)) / 2];
}
/** The square's share of the picture: its shorter side over the frame's shorter side (0 when unknown). */
export function fillOf(corners, frame) {
  if (!corners || corners.length !== 8 || !frame || !(frame[0] > 0 && frame[1] > 0)) return 0;
  return Math.min(...sides(corners)) / Math.min(frame[0], frame[1]);
}

/** A status's tile corners and frame size, read from the frame's coded planes (`rotation` the turn the camera tagged
 *  it with: an Android camera held upright gives landscape planes turned 90), as the picture the page shows: corners
 *  [x0, y0, ... x3, y3] turned clockwise by `rotation`, the frame [width, height] swapped for 90 and 270. Fill and
 *  cell size do not change; the focus point and the zoom's margins are then where the user sees the square. */
export function toDisplay(corners, frame, rotation) {
  const r = ((rotation || 0) % 360 + 360) % 360;
  if (!r || !frame || !(frame.length === 2)) return { corners, frame };
  const [w, h] = frame;
  const turn = r === 90 ? (x, y) => [h - y, x] : r === 180 ? (x, y) => [w - x, h - y] : r === 270 ? (x, y) => [y, w - x] : null;
  if (!turn) return { corners, frame };
  const c = corners && corners.length === 8 ? [0, 1, 2, 3].flatMap((i) => turn(corners[2 * i], corners[2 * i + 1])) : corners;
  return { corners: c, frame: r === 180 ? frame : [h, w] };
}

/** Turns the stream of statuses into what the guidance needs: whether a tile read lately, and the last failure. */

// ---- the screen's timing (the browser's PhaseLock) ----
/** A camera in a browser cannot move its capture timing by a frame as the app does, and on Android Chrome a
 *  frame-rate change on the live track never completes (a phone, 2026-11-03: applyConstraints hung while the
 *  worker read the track). What a page can do is start the camera again: a fresh sensor start lands at a new,
 *  random phase against the screen's frame, and on a panel whose clean window is about half the frame about half
 *  of the starts read whole. So: a second of blended (or collapsed) reads with the rates matching, and the camera
 *  is re-opened; a whole read within the window locks (no more re-opens while the reads stay good); a start that
 *  reads nothing is followed by another, up to `TRIES`, then the page gives up and the guidance names the sender's
 *  rate. Measured: a bad phase read 0 of 111 for a whole run at 07:26. */
export const SWEEP = {
  HIGH_MS: 1000,       // the blend (or collapsed reads) over the last second starts the search
  TRY_MS: 3500,        // after a re-open: the time for the camera to settle and the reads to say whole or not
  TRIES: 6,            // re-opens in one search before the page rests
  REST_MS: 20000,      // after a search that never read whole: this long from its last re-open to the next search
                       // (it never gives up for good: the camera button, which re-opens the camera too, read where
                       // the page had stopped trying; phone, 2026-11-05)
  GAP_MS: 6000,        // between searches
  UNLOCK_MS: 1500,     // locked: the blend up (or reads collapsed) this long unlocks (another search)
};
export class PhaseSweep {
  constructor() { this.state = 'watch'; this.at = -Infinity; this.window = []; this.tries = 0; this.searches = 0; this.rerolls = 0; this.locked = false; this.off = false; this.lastAt = -Infinity; this.since = -Infinity; this.restUntil = -Infinity; }
  /** Resting after a search that read nothing whole: the rate advice shows. */
  get resting() { return this.lastAt < this.restUntil; }
  /** One status. `mix`: the last data read's blend; `whole`: it read 90% of its codewords; `collapsed`: the tracker's
   *  clean-reads-collapsed flag; `senderFps`, `camFps`: the sender's rate and the camera's measured rate. Returns
   *  { reroll: true } when the camera should be opened again now, else null. */
  update({ now, newData, mix, whole, collapsed, senderFps, camFps }) {
    if (this.off) return null;
    const rates = senderFps > 0 && camFps > 0 && Math.abs(senderFps / camFps - 1) <= 0.15;
    if (newData) { this.window.push({ t: now, mix, whole }); this.lastAt = now; }
    while (this.window.length && now - this.window[0].t > SWEEP.HIGH_MS) this.window.shift();
    if (now - this.lastAt > 600) this.window.length = 0;
    const full = this.window.length >= 3 && now - this.window[0].t >= SWEEP.HIGH_MS * 0.6;
    const mean = this.window.length ? this.window.reduce((a, w) => a + w.mix, 0) / this.window.length : 0;
    const bad = full && (mean >= 0.15 || collapsed);
    const anyWhole = this.window.some((w) => w.whole);
    const reroll = () => { this.tries++; this.rerolls++; this.at = now; this.window.length = 0; this.state = 'sweep'; return { reroll: true }; };
    switch (this.state) {
      case 'watch':
        if (bad && rates && now - this.at >= SWEEP.GAP_MS && now >= this.restUntil) { this.searches++; this.tries = 0; return reroll(); }
        return null;
      case 'sweep':
        if (newData && whole) { this.state = 'locked'; this.locked = true; this.since = -Infinity; this.at = now; return null; }
        if (now - this.at >= SWEEP.TRY_MS) {
          if (this.tries >= SWEEP.TRIES) { this.restUntil = this.at + SWEEP.REST_MS; this.state = 'watch'; return null; }
          return reroll();
        }
        return null;
      case 'locked':
        if (bad && !anyWhole) { if (this.since === -Infinity) this.since = now; if (now - this.since >= SWEEP.UNLOCK_MS) { this.locked = false; this.state = 'watch'; this.since = -Infinity; this.at = now - SWEEP.GAP_MS; } }
        else this.since = -Infinity;
        return null;
    }
    return null;
  }
  /** The page is at work on the timing (the guidance says so instead of the sender's rate). */
  get fixing() { return !this.off && (this.state === 'sweep' || this.state === 'locked'); }
}

// ---- short exposure (a fast screen: a phone's OLED) ----
/** A screen that switches its pixels in well under a millisecond (a phone's OLED) blends two sender frames only
 *  where the camera's exposure spans the change: with a 10 ms exposure about a third of a close tile reads as a
 *  mix (a phone filming a phone sender, 2026-11-03: 0-4 of 49 codewords on most captures, "two frames overlap"),
 *  so every codeword takes damage. A short exposure narrows that band. Android Chrome takes a manual exposure
 *  and ISO on the live track without stalling it (a frame-rate change does stall), but its automatic mode adds
 *  gain the manual one does not: 2 ms at ISO 500 read 11x darker than the automatic 10 ms, 2 ms at ISO 3200
 *  about half as bright, the tile's contrast kept. So: a trial when reads keep blending, kept only when it reads
 *  better, reverted otherwise (an LCD's own slow settling does not shorten with the exposure: there the phase
 *  search is the fix, and the trial reads no better and reverts). */
export const SHORT = {
  MIX: 0.25,           // the blend share that counts
  BLENDED: 0.7,        // ... on at least this share of the reads in the watch window
  WATCH_MS: 1500,      // blended this long, the tile found, starts a trial
  TRIAL_MS: 3000,      // a trial runs this long before it is judged (the first 500 ms not counted: settling)
  SETTLE_MS: 500,
  EXPOSURE: 25,        // the trial's exposure, 100 us units (2.5 ms)
  ISO: 3200,
  GAIN_MIX: 0.1,       // kept when the blend falls by this much ...
  GAIN_SHARE: 0.15,    // ... or the share of codewords read rises by this much
  FOUND_MIN: 0.5,      // and the tile is still found on at least this share of reads
  LOST_MS: 2500,       // kept: no tile this long and it lets go (too dark, or the phone moved)
  BACKOFF_MS: 20000,   // after a trial that read no better
  MAX_TRIALS: 3,
};
export class ShortExposure {
  /** `caps`: the track's capabilities (exposureMode, exposureTime and iso ranges). */
  constructor(caps = {}) {
    const et = caps.exposureTime, iso = caps.iso;
    this.supported = Array.isArray(caps.exposureMode) && caps.exposureMode.includes('manual') && !!et && !!iso && et.max > et.min && iso.max > iso.min;
    this.settings = this.supported ? { exposureTime: Math.min(et.max, Math.max(et.min, SHORT.EXPOSURE)), iso: Math.min(iso.max, Math.max(iso.min, SHORT.ISO)) } : null;
    this.state = 'watch'; this.window = []; this.trials = 0; this.since = -Infinity; this.lastFound = -Infinity; this.baseline = null; this.note = '';
  }
  get trialing() { return this.state === 'trial'; }
  get kept() { return this.state === 'kept'; }
  /** The camera should run short (re-applied after a camera restart). */
  get active() { return this.state === 'trial' || this.state === 'kept'; }
  /** One status: `found` the tile seen in this capture, `newData` a data read with `codewordsOk` of `codewords`,
   *  `mix` its blend share. Returns { apply: 'short' } or { apply: 'auto' } when the camera should change, else null. */
  update({ now, newData, found, mix, codewordsOk, codewords }) {
    if (!this.supported) return null;
    if (found) this.lastFound = now;
    this.window.push({ t: now, found: !!found, mix: newData ? mix || 0 : null, share: newData && codewords > 0 ? codewordsOk / codewords : null });
    while (this.window.length && now - this.window[0].t > SHORT.TRIAL_MS + SHORT.WATCH_MS) this.window.shift();
    const stats = (from) => {
      const w = this.window.filter((x) => x.t >= from), d = w.filter((x) => x.mix !== null);
      const mean = (k) => d.length ? d.reduce((a, x) => a + x[k], 0) / d.length : 0;
      return { n: w.length, reads: d.length, found: w.length ? w.filter((x) => x.found).length / w.length : 0, mix: mean('mix'), share: mean('share'), blended: d.length ? d.filter((x) => x.mix >= SHORT.MIX).length / d.length : 0 };
    };
    switch (this.state) {
      case 'watch': {
        if (now < this.since) return null;   // backing off
        const from = now - SHORT.WATCH_MS, st = stats(from);
        const spans = this.window.length && this.window[0].t <= from + SHORT.WATCH_MS * 0.3;
        if (!spans || st.reads < 5 || st.found < SHORT.FOUND_MIN || st.blended < SHORT.BLENDED) return null;
        if (this.trials >= SHORT.MAX_TRIALS) { this.supported = false; this.note = 'short exposure: no better here'; return null; }
        this.baseline = st; this.state = 'trial'; this.since = now; this.trials++;
        this.note = 'short exposure: trying';
        return { apply: 'short' };
      }
      case 'trial': {
        if (now - this.since < SHORT.TRIAL_MS) return null;
        const st = stats(this.since + SHORT.SETTLE_MS), b = this.baseline;
        const better = st.found >= SHORT.FOUND_MIN && st.reads >= 3 && (b.mix - st.mix >= SHORT.GAIN_MIX || st.share - b.share >= SHORT.GAIN_SHARE);
        if (better) { this.state = 'kept'; this.note = `short exposure: kept (blend ${b.mix.toFixed(2)} -> ${st.mix.toFixed(2)})`; return null; }
        this.state = 'watch'; this.since = now + SHORT.BACKOFF_MS; this.window.length = 0;
        this.note = 'short exposure: no better, automatic';
        return { apply: 'auto' };
      }
      case 'kept': {
        if (now - this.lastFound < SHORT.LOST_MS) return null;
        this.state = 'watch'; this.since = now + SHORT.BACKOFF_MS; this.window.length = 0;
        this.note = 'short exposure: tile lost, automatic';
        return { apply: 'auto' };
      }
    }
    return null;
  }
}

/** Clean-looking data reads in a row under a fifth of their codewords before they count as a blend. */
export const COLLAPSED_READS = 5;
export class ReadTracker {
  constructor() { this.lock = new LockWatch(); this.dataReads = 0; this.decoded = 0; this.failed = 0; this.readAt = -Infinity; this.failAt = -Infinity; this.seenAt = -Infinity; this.firstSeenAt = -Infinity; this.progressAt = -Infinity; this.progress = 0; }
  update(s, now) {
    const newRead = s.decoded > this.decoded;
    if (newRead) this.readAt = now;
    // a new DATA read (the status's codewords are the data's; a manifest read leaves them as they were); an older
    // core without the count: every read
    const newData = s.data_reads === undefined ? newRead : s.data_reads > this.dataReads;
    this.dataReads = s.data_reads || 0;
    if (s.failed > this.failed) this.failAt = now;
    this.decoded = s.decoded || 0; this.failed = s.failed || 0;
    const fmt = parseFormat(s.format);
    // data reads in a row that look clean (sharp edges, cells at the floor or above) yet read under a fifth of their
    // codewords: a blend the measure under-reports (a slow LCD panel settles), and a browser cannot move the
    // camera's timing; several in a row before the guidance says so (a straddled capture is one)
    if (newData) {
      const edge = s.edge_px || 0, cw = s.codewords || 0, cell = s.cell_px || 0;
      const clean = edge > 0 && edge <= EDGE_SOFT && fmt && cell >= floor(fmt.pitch, fmt.alphabet === 'bw');
      this.poorRun = cw > 0 && (s.codewords_ok || 0) * 5 < cw && clean ? (this.poorRun || 0) + 1 : 0;
    }
    const fresh = now - this.readAt < FRESH_MS;
    if (fresh) { this.seenAt = now; if (this.firstSeenAt === -Infinity) this.firstSeenAt = now; }
    // progress: the manifest, then unique data
    const p = (s.have_manifest ? 1 : 0) + (s.received_bytes || 0);
    if (p > this.progress) { this.progress = p; this.progressAt = now; }
    return {
      fresh, failure: now - this.failAt < FRESH_MS ? s.last_error || null : null,
      pitch: fmt ? fmt.pitch : 0, bw: fmt ? fmt.alphabet === 'bw' : false,
      cellPx: s.cell_px || 0, edges: s.edges || [], codewordsOk: s.codewords_ok || 0, codewords: s.codewords || 0,
      receiving: (s.stream_size || 0) > 0 || !!s.have_manifest, manifest: !!s.have_manifest,
      mix: s.mix || 0, edgePx: s.edge_px || 0, locked: this.lock.update(fresh, newData, s.codewords_ok || 0, now),
      collapsed: (this.poorRun || 0) >= COLLAPSED_READS, newData,
      fill: fillOf(s.corners, s.frame), frames: s.frames || 0,
      // the square was read in the last few seconds: a blurred or torn frame now is motion, not a lost square
      seenBefore: now - this.seenAt < SEEN_MS,
    };
  }
}

/** The guidance line from a reading (ReadTracker.update); `zoomCanHelp`: the page is about to zoom in, so a
 *  small square is the camera's job, not the user's. Never "Move closer" while the codewords read. */
export function hint(r, zoomCanHelp = false) {
  if (r.fresh) {
    const reads = r.codewords <= 0 || r.codewordsOk >= r.codewords * READS_WELL;
    const sk = skew(r.edges);
    if (sk > SKEW_STRONG) return HINTS.square;
    if (!reads) {
      // found, but losing codewords: too small for its format, at an angle, out of focus or moving
      if (r.cellPx > 0 && r.cellPx < floor(r.pitch, r.bw) * CLOSER_OVER_FLOOR) return zoomCanHelp ? HINTS.zooming : closer(r.fill);
      if (sk > SKEW_HURTS) return HINTS.square;
      // two frames blended: holding steady cannot fix it: reading, locked or not. A read that looks clean (sharp
      // edges, cells above the floor) yet reads under a fifth of its codewords is a blend the measure under-reports
      // (a slow LCD panel settles: 15-25% of the previous frame over the whole tile, 2026-11-03); a browser
      // cannot move the camera's timing, so the sender's rate is the fix here too
      if ((r.mix || 0) >= MIX_SHOWS || r.collapsed) return r.phaseFixing ? HINTS.readingTiming : HINTS.readingOverlap;
      const soft = (r.edgePx || 0) > EDGE_SOFT;
      if (r.locked) return soft ? HINTS.readingFocus : HINTS.reading;
      if (r.codewordsOk <= 0) return soft ? HINTS.readingUnlockedFocus : HINTS.readingUnlocked;
      return soft ? HINTS.steadyFocus : HINTS.steady;
    }
    return r.manifest ? HINTS.good : HINTS.locked;
  }
  const f = r.failure || '';
  // the markers were found but the frame did not read: blur, or the header lost in motion
  if (/^(TooBlurry|NoHeader)/.test(f) && r.seenBefore) return HINTS.steady;
  if (r.receiving) return HINTS.lost;
  return r.frames > 45 ? HINTS.whole : HINTS.search;
}

/** The guidance for Share a window: the page reads a window on this computer (a VM or remote desktop showing the
 *  sender), so nothing is held, aimed or focused. What helps is the window: in front, whole, large enough. */
export const SHARE_HINTS = {
  search: { lock: 'search', text: 'Looking for the LensBolt square in the shared window' },
  whole: { lock: 'warn', text: 'Show the whole LensBolt square in the shared window, nothing covering it' },
  lost: { lock: 'warn', text: 'The square left the shared window: bring the sender back to the front' },
  small: { lock: 'warn', text: "The square is small in the shared window: make the sender's window larger" },
  reading: { lock: 'locked', text: 'Reading the shared window' },
  good: { lock: 'good', text: 'Reading the shared window' },
};
/** shareHint: the line for a reading (ReadTracker.update) of a shared window. */
export function shareHint(r) {
  if (r.fresh) {
    const reads = r.codewords <= 0 || r.codewordsOk >= r.codewords * READS_WELL;
    if (!reads && r.cellPx > 0 && r.cellPx < floor(r.pitch, r.bw) * CLOSER_OVER_FLOOR) return SHARE_HINTS.small;
    return r.manifest ? SHARE_HINTS.good : SHARE_HINTS.reading;
  }
  if (r.receiving) return SHARE_HINTS.lost;
  return r.frames > 45 ? SHARE_HINTS.whole : SHARE_HINTS.search;
}

// Zoom: the camera's own zoom (on a large sensor it is real detail, not an upscale) makes a small square big.
export const ZOOM = {
  // zoom in when the square's short side is under this share of the picture's (0.7 until 2026-11-03: a square at
  // 74% on a 1080 px capture gave 1.46 camera px per 2 px cell, the floor, and read 4 of 111 codewords)
  START_BELOW: 0.78,
  TARGET: 0.8,        // ... aiming at this share
  OUT_ABOVE: 0.95,    // zoom out when it is over this share (the user came closer)
  IN_MARGIN: 0.85,    // after zooming in, every corner stays within this share of the way from centre to edge
  OUT_MARGIN: 0.97,   // a corner beyond this share: zoom out before the square leaves the picture
  MAX_STEP: 2,        // at most this factor per change (the decoder re-finds the square between steps)
  SETTLE_MS: 700,     // after a change: the camera settles (exposure, focus) before the next
  LOST_MS: 2000,      // the square not seen this long: back to the widest view to find it again
};
/** The zoom to set now, or null to leave it. `z`: the track's zoom now; `caps`: the auto zoom's { min, max, step }
 *  (ZoomLimits.caps); `corners`, `frame`: the last data read's square and the picture size (camera px); `found`: a
 *  current read; `lostMs`: since the square was last read; `sinceChangeMs`: since the last zoom change; `reads`:
 *  the codewords read well (>= 90%): then a working transfer is not disturbed (only a corner near the edge zooms
 *  out); `goneMs`: since a capture last showed the markers (defaults to `lostMs`). */
export function zoomStep({ z, caps, corners, frame, found, lostMs, sinceChangeMs, reads = false, goneMs = lostMs }) {
  if (!caps || !(caps.max > caps.min)) return null;
  const step = caps.step > 0 ? caps.step : 0.1;
  const snap = (v, down) => {
    const k = (v - caps.min) / step;
    const n = down ? Math.floor(k + 1e-6) : Math.ceil(k - 1e-6);
    return Math.min(caps.max, Math.max(caps.min, +(caps.min + n * step).toFixed(6)));
  };
  // back to the widest view only when the markers themselves are gone (`goneMs`: no marker found for that long);
  // a frame that is blurred (the camera refocusing after a zoom-in) or reads no header is not a lost square, and
  // zooming out on it then in again moved the picture up and down
  if (!found) return Math.min(lostMs, goneMs) >= ZOOM.LOST_MS && z > caps.min + step / 2 ? caps.min : null;
  if (sinceChangeMs < ZOOM.SETTLE_MS) return null;
  const fill = fillOf(corners, frame);
  if (!(fill > 0)) return null;
  // how far a zoom factor k (about the picture's centre) can go before a corner passes `margin` of the half-frame
  const [cx, cy] = [frame[0] / 2, frame[1] / 2];
  const fit = (margin) => {
    let k = Infinity;
    for (let i = 0; i < 4; i++) {
      const dx = Math.abs(corners[2 * i] - cx), dy = Math.abs(corners[2 * i + 1] - cy);
      if (dx > 0) k = Math.min(k, margin * cx / dx);
      if (dy > 0) k = Math.min(k, margin * cy / dy);
    }
    return k;
  };
  const kOut = fit(ZOOM.OUT_MARGIN);
  if ((kOut < 1 || (fill > ZOOM.OUT_ABOVE && !reads)) && z > caps.min + step / 2) {
    // too big, or near an edge: back out to the target and inside the margin
    const k = Math.min(ZOOM.TARGET / fill, fit(ZOOM.IN_MARGIN), 1);
    const next = snap(Math.max(z * Math.max(k, 1 / ZOOM.MAX_STEP), caps.min), true);
    return next < z - step / 2 ? next : (z > caps.min ? snap(z - step, true) : null);
  }
  if (fill < ZOOM.START_BELOW && z < caps.max - step / 2 && !reads) {
    const k = Math.min(ZOOM.TARGET / fill, fit(ZOOM.IN_MARGIN), ZOOM.MAX_STEP);
    const next = snap(z * k, true);
    // a change worth making: at least one step and 5%
    return next >= z + step - 1e-6 && next >= z * 1.05 ? next : null;
  }
  return null;
}

/** What auto zoom may use on one lens: from the track's starting zoom (never under 1x: a camera that offers less
 *  may be switching to its ultrawide there) to 3x at most, and below a zoom-in that lost the square within 1.5 s of
 *  being set (the square left the picture, or the camera changed lens there). A blurred frame (the camera
 *  refocusing after the zoom) is not a lost square. The learned limit relaxes one step per 30 s without a loss, and
 *  `reset` (a new transfer) forgets it. */
export const LIMITS = { AUTO_MAX: 3, LOSE_MS: 1500, LOST_CONFIRM_MS: 700, RELAX_MS: 30000 };
export class ZoomLimits {
  constructor(caps, startZoom) {
    this.step = caps.step > 0 ? caps.step : 0.1;
    this.base = Math.min(caps.max, Math.max(1, caps.min, startZoom || 1));
    this.ceil0 = Math.min(caps.max, LIMITS.AUTO_MAX);
    this.reset();
  }
  reset() { this.ceil = this.ceil0; this.set = null; this.seenAt = -Infinity; this.lossAt = -Infinity; }
  /** { min, max, step } for zoomStep, or null when there is less than a step of room. */
  caps() { return this.ceil - this.base >= this.step - 1e-9 ? { min: this.base, max: this.ceil, step: this.step } : null; }
  /** The page zoomed in to `z` at `now` (zooming out is never what loses the square). */
  zoomed(z, now) { this.set = z > this.base + this.step / 2 ? { z, at: now } : null; }
  /** One status: whether the square was read, and the decoder's failure if not. Returns true when it just learned a
   *  zoom that loses the square. */
  update(found, now, failure = null) {
    if (this.ceil < this.ceil0 && now - this.lossAt >= LIMITS.RELAX_MS) {
      this.ceil = Math.min(this.ceil0, +(this.ceil + this.step).toFixed(6));
      this.lossAt = now;
    }
    // a frame too blurred to search (focus catching up with the zoom) says nothing about where the square is
    if (!found && /^TooBlurry/.test(failure || '')) { this.seenAt = now; return false; }
    if (found) {
      this.seenAt = now;
      if (this.set && now - this.set.at > LIMITS.LOSE_MS) this.set = null; // that zoom held the square
      return false;
    }
    if (!this.set || now - this.seenAt < LIMITS.LOST_CONFIRM_MS || this.seenAt - this.set.at > LIMITS.LOSE_MS) return false;
    const k = Math.floor((this.set.z - this.step - this.base) / this.step + 1e-6);
    this.ceil = Math.max(this.base, +(this.base + k * this.step).toFixed(6));
    this.set = null; this.lossAt = now;
    return true;
  }
}

// Focus: continuous by default; a single-shot refocus at the square when it reads badly although its cells are
// large enough (blur, not distance), or when its sharpness falls well under the best seen at this zoom.
export const FOCUS = { POOR: 0.5, DROP: 0.6, FOR_MS: 1000, COOLDOWN_MS: 4000, GONE_MS: 2000 };
export class FocusWatch {
  constructor() { this.best = 0; this.poorSince = -Infinity; this.lastAt = -Infinity; this.zoom = null; this.format = null; this.seenAt = -Infinity; }
  /** One status: returns true when a refocus is due now (then the watch waits COOLDOWN_MS). */
  update({ found, codewordsOk, codewords, cellPx, floorPx, sharpness, zoom, format = null, mix = 0, edgePx = 0, now }) {
    // another zoom or another data format scores differently: a new best
    if (zoom !== this.zoom || format !== this.format) { this.zoom = zoom; this.format = format; this.best = 0; this.poorSince = -Infinity; }
    // a status without a read (a missed frame) neither starts nor ends a poor spell; the square gone for a while does
    if (!found) { if (now - this.seenAt > FOCUS.GONE_MS) this.poorSince = -Infinity; return false; }
    this.seenAt = now;
    if (sharpness > this.best) this.best = sharpness;
    // a transfer that reads well (>= 90%) is never disturbed
    const reading = codewords <= 0 || codewordsOk >= codewords * READS_WELL;
    // cells where the guidance says "Move closer" (under CLOSER_OVER_FLOOR x the floor) are distance, not focus
    // two sender frames blended with sharp border edges: not focus either
    const blended = mix >= MIX_SHOWS && !(edgePx > EDGE_SOFT);
    const misreads = codewords > 0 && codewordsOk < codewords * FOCUS.POOR && cellPx >= floorPx * CLOSER_OVER_FLOOR && !blended;
    const soft = !reading && sharpness > 0 && this.best > 0 && sharpness < this.best * FOCUS.DROP;
    if (!(misreads || soft)) { if (reading) this.poorSince = -Infinity; return false; }
    if (this.poorSince === -Infinity) this.poorSince = now;
    if (now - this.poorSince < FOCUS.FOR_MS || now - this.lastAt < FOCUS.COOLDOWN_MS) return false;
    this.lastAt = now; this.poorSince = -Infinity; this.best = 0;
    return true;
  }
}

// The frame rates the sender page offers (calibration words can pick others, but only in the lab).
export const SENDER_FPS = [15, 30, 60];
/** "The sender shows 60 fps; this camera reads 30. Set the sender to 30 fps or keep going: it will take about twice
 *  as long.": advice, not an order. A rate within 1.5 fps of one the page offers counts as it. The suggestion is the
 *  fastest page rate the camera keeps up with (15 for a slower camera), and only one below the sender's; else
 *  "Keep going" alone. Keeping going takes about sender / camera as long (as in the app). */
export function fpsBannerText(sender, cam) {
  const near = (x) => SENDER_FPS.find((f) => Math.abs(x - f) <= 1.5);
  const camRate = near(cam) ?? cam, senderRate = near(sender) ?? sender;
  const fit = SENDER_FPS.filter((f) => f <= camRate + 1e-9);
  const opt = fit.length ? Math.max(...fit) : SENDER_FPS[0], f = sender / camRate;
  const longer = f >= 2.5 ? `${Math.round(f)} times` : f >= 1.75 ? 'twice' : `${(Math.round(f * 10) / 10).toFixed(1)} times`;
  const head = `The sender shows ${Math.round(sender)} fps; this camera reads ${Math.round(camRate)}.`;
  return opt < senderRate - 1e-9 ? `${head} Set the sender to ${opt} fps or keep going: it will take about ${longer} as long.` : `${head} Keep going: it will take about ${longer} as long.`;
}
/** The sender-rate banner: up once the sender's rate has exceeded the camera's by more than 20% for `afterMs` in a
 *  row (never for a smaller difference), then held for `holdMs` after it clears (a stutter never blinks it). */
export class FpsBanner {
  constructor(holdMs = 2000, afterMs = 3000) { this.holdMs = holdMs; this.afterMs = afterMs; this.text = null; this.until = -Infinity; this.since = -Infinity; }
  update(senderFps, camFps, now) {
    if (senderFps > 0 && camFps > 0 && senderFps > 1.2 * camFps) {
      if (this.since === -Infinity) this.since = now;
      if (now - this.since >= this.afterMs) { this.text = fpsBannerText(senderFps, camFps); this.until = now + this.holdMs; }
    } else { this.since = -Infinity; if (now >= this.until) this.text = null; }
    return this.text;
  }
}

/** The other-version banner's words. */
export const VERSION_TEXT = 'The sender is a different LensBolt version. Update both to the same version.';
/** The other-version banner (the app's VersionWatch): the decoder read the sender's header whole and it names
 *  another format version (`OtherVersion(v)`: nothing will ever decode). Up once such reports have gone on for
 *  `holdMs` with no tile of this version read; other failures in between (a blurred capture, a missed header)
 *  neither start nor end the run; a read ends it, and so does no report for FRESH_MS (the camera turned away).
 *  `update` takes a reading (ReadTracker.update) and returns the words or null. */
export class VersionWatch {
  constructor(holdMs = 1000) { this.holdMs = holdMs; this.reset(); }
  reset() { this.firstAt = -Infinity; this.lastAt = -Infinity; this.on = false; }
  update(r, now) {
    if (r.fresh) { this.reset(); return null; }
    if (/^OtherVersion/.test(r.failure || '')) {
      if (!this.on) { this.on = true; this.firstAt = now; }
      this.lastAt = now;
    } else if (this.on && now - this.lastAt >= FRESH_MS) this.reset();
    return this.on && now - this.firstAt >= this.holdMs ? VERSION_TEXT : null;
  }
}

/** The "nothing happening?" hint, with concrete advice, after a while without any square (8 s) or without
 *  progress while the square is seen (10 s); null otherwise. Times from the tracker (ReadTracker). */
export const IDLE = { NOTHING_MS: 8000, STUCK_MS: 10000 };
export function idleHint({ now, startedAt, seenAt, firstSeenAt, progressAt, complete, lenses }) {
  if (complete) return null;
  const other = lenses > 1 ? ' Or try another lens with the camera button at the top.' : '';
  if (!(firstSeenAt > -Infinity)) {
    if (now - startedAt < IDLE.NOTHING_MS) return null;
    return { title: 'Nothing yet?', text: 'Check that the computer shows the LensBolt square (press Start there), turn its screen brightness up, and hold this phone 20 to 40 cm away so the whole square shows. Tilt a little if there is glare.' + other };
  }
  const since = Math.max(firstSeenAt, progressAt);
  if (now - seenAt < FRESH_MS && now - since >= IDLE.STUCK_MS) {
    return { title: 'Seen, but not reading', text: 'Rest your elbows to hold the phone still and let the square fill most of the picture. Tap the picture to focus. If it still does not read, choose a slower speed on the computer.' + other };
  }
  return null;
}

/** idleHint for Share a window: nothing seen in the window yet, or seen but not reading (no hold, no distance). */
export function idleShare({ now, startedAt, seenAt, firstSeenAt, progressAt, complete }) {
  if (complete) return null;
  if (!(firstSeenAt > -Infinity)) {
    if (now - startedAt < IDLE.NOTHING_MS) return null;
    return { title: 'Nothing yet?', text: 'Check that the shared window shows the LensBolt sender with Start pressed, in front and not minimised. Choose Fastest on the sender: it suits a shared window best. If you picked another window, close this screen and choose Share a window again.' };
  }
  const since = Math.max(firstSeenAt, progressAt);
  if (now - seenAt < FRESH_MS && now - since >= IDLE.STUCK_MS) {
    return { title: 'Seen, but not reading', text: "Make the sender's window larger (or full screen inside the VM or remote desktop), keep it uncovered, and choose Fastest on the sender." };
  }
  return null;
}

// ---- when receiving cannot go on ----
/** Headroom on top of the receiver's peak (the app's Storage.MARGIN_BYTES); "nearly used": over this share of
 *  the quota, or less than the margin left. */
export const SPACE = { MARGIN: 64 * 1048576, NEARLY_FULL: 0.95 };
/** A receiver error (`receiver_error`: the file could not be written or checked, say the phone's storage is full)
 *  or a decoder error (`error`: the worker threw; a trapped decoder throws on every frame) in two statuses in a
 *  row: receiving stops. One odd frame never stops it. */
export class ErrorRun {
  constructor() { this.n = 0; }
  update(s) { this.n = s && (s.receiver_error || s.error) ? this.n + 1 : 0; return this.n >= 2; }
}
/** Bytes a transfer needs on this device: the receiver's peak (`disk_peak`: the stream, plus the unpacked file
 *  while a compressed transfer finishes), never less than the stream, plus the margin (the app's needBytes). */
export const needBytes = (streamSize, diskPeak) => Math.max(streamSize || 0, diskPeak || 0) + SPACE.MARGIN;
/** Once the manifest is in: null when the file fits (or the browser gives no estimate), else { free, need }.
 *  `own`: bytes the page's stores already hold (counted in `usage`, and reused by this transfer). */
export function spaceShort({ estimate, own = 0, streamSize, diskPeak }) {
  if (!estimate || !(estimate.quota > 0)) return null;
  const free = Math.max(0, estimate.quota - (estimate.usage || 0) + (own || 0)), need = needBytes(streamSize, diskPeak);
  return free < need ? { free, need } : null;
}
const mbDown = (b) => `${Math.floor(b / 1048576).toLocaleString('en-US')} MB`;
const mbUp = (b) => `${Math.ceil(b / 1048576).toLocaleString('en-US')} MB`;
/** The words for a stop, plain: not enough space (an early stop with what is free and needed, or a failure with
 *  the storage nearly used), else receiving stopped. Both lead back to Start camera. */
export function stopMessage(estimate, own = 0, short = null) {
  const again = 'Free some space, then tap Start camera to try again.';
  if (short) return { title: 'Not enough space on this phone', text: `${mbDown(short.free)} free, ${mbUp(short.need)} needed for this file. ${again}` };
  const q = estimate && estimate.quota > 0 ? estimate.quota : 0, used = estimate ? estimate.usage || 0 : 0;
  if (q && (used >= q * SPACE.NEARLY_FULL || q - used < SPACE.MARGIN)) return { title: 'Not enough space on this phone', text: `The storage this page may use is full. ${again}` };
  return { title: 'Receiving stopped', text: 'The file could not be put together. Tap Start camera to try again.' };
}

// ---- finish words: the receiver names the parts still missing; typed on the sender, it sends only those ----
/** The line shown above the words. */
export const FINISH_TEXT = 'Type these on the sender to finish faster';
/** The words to show for a status: the receiver's current words (they change as parts finish), none before it
 *  offers any and none once the file is complete. Typing them is never required. */
export function finishWords(s) {
  return s && !s.complete && typeof s.finish_words === 'string' && s.finish_words ? s.finish_words : null;
}
/** The parts the shown words name, for a small line under them ("Parts 7, 12–15, 30", from 1 as the sender shows
 *  them: the core's `finish_parts`); null whenever no words are shown. */
export function finishParts(s) {
  return finishWords(s) && typeof s.finish_parts === 'string' && s.finish_parts ? s.finish_parts : null;
}

// ---- the support card on the Done screen (the phone app's rule, android/.../DonatePrompt.kt) ----
/** At most every fifth successful transfer, never two in a row, never after "Don't ask again". */
export const DONATE = {
  EVERY: 5,
  TEXT: 'LensBolt is free. If it helped, you can support it.',
  COFFEE: 'https://buymeacoffee.com/akhildara1l',
  SPONSORS: 'https://github.com/sponsors/akhil-dara',
  KEYS: { count: 'lb-donate-count', shown: 'lb-donate-shown', never: 'lb-donate-never' },
};
/** One more successful transfer: the new counts ({ transfers, lastShown: the transfer it last showed on, 0 never,
 *  never }) and whether its Done screen shows the card. A last showing "ahead" of the count (restored storage) counts
 *  as the last transfer. */
export function donateAfter(c) {
  const n = c.transfers + 1, last = Math.min(c.lastShown, c.transfers);
  const show = !c.never && n - last >= DONATE.EVERY;
  return { count: { transfers: n, lastShown: show ? n : last, never: c.never }, show };
}
const whole = (v) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : 0; };
/** The counts kept in `storage` (localStorage; any call may throw). Where storage is missing or refuses, the counts
 *  live in this page and the card shows at most once per page load. */
export class DonateGate {
  constructor(storage) {
    this.s = storage; this.shownHere = false;
    const K = DONATE.KEYS;
    try {
      if (!storage) throw new Error('no storage');
      this.c = { transfers: whole(storage.getItem(K.count)), lastShown: whole(storage.getItem(K.shown)), never: storage.getItem(K.never) === '1' };
      storage.setItem(K.count, String(this.c.transfers)); // writable too
      this.stored = true;
    } catch { this.c = { transfers: 0, lastShown: 0, never: false }; this.stored = false; }
  }
  save() {
    if (!this.stored) return;
    const K = DONATE.KEYS;
    try { this.s.setItem(K.count, String(this.c.transfers)); this.s.setItem(K.shown, String(this.c.lastShown)); if (this.c.never) this.s.setItem(K.never, '1'); }
    catch { this.stored = false; }
  }
  /** A successful transfer: whether its Done screen shows the card. */
  afterTransfer() {
    const r = donateAfter(this.c);
    this.c = r.count;
    const show = r.show && (this.stored || !this.shownHere);
    if (show) this.shownHere = true;
    this.save();
    return show;
  }
  /** "Don't ask again". */
  never() { this.c.never = true; this.save(); }
}

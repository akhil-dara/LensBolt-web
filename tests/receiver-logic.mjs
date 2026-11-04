// The browser receiver's rules on their own (web/receive-logic.js): guidance, zoom, focus, the sender-rate banner
// and the "nothing happening?" hint. No browser needed:
//
//   node web/tests/receiver-logic.mjs
//   LB_FRAMES=<dir of cam_N.i420 + cam_N.json> node web/tests/receiver-logic.mjs    (also replays real camera
//        frames through the built wasm, web/pkg, and prints the zoom each read would ask for)
import { FRESH_MS, HINTS, HintHold, COLLAPSED_READS, PhaseSweep, SWEEP, ShortExposure, SHORT, closer, floor, skew, fillOf, toDisplay, parseFormat, ReadTracker, LockWatch, hint, zoomStep, ZOOM, ZoomLimits, FocusWatch, FpsBanner, fpsBannerText, SENDER_FPS, VersionWatch, VERSION_TEXT, idleHint, ErrorRun, needBytes, spaceShort, stopMessage, SPACE, finishWords, finishParts, FINISH_TEXT, shareHint, SHARE_HINTS, idleShare, physicalLens, singleLenses, tooClose, LensPick, LENS } from '../receive-logic.js';

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- guidance for a shared window (Share a window: no camera, nothing held): never "move closer", "hold steady" or
// "square up"; what to do with the window instead, and "choose Fastest on the sender" when nothing comes ---
{
  const r = (o) => ({ fresh: true, failure: null, pitch: 2, bw: true, cellPx: 3, edges: [1, 1, 1, 1], codewordsOk: 83, codewords: 83, receiving: true, manifest: true, fill: 0.5, frames: 100, seenBefore: true, ...o });
  const cases = [r({}), r({ manifest: false }), r({ cellPx: 1.0, codewordsOk: 10 }), r({ codewordsOk: 10, edges: [1, 1.5, 1, 1.5] }), r({ codewordsOk: 10, mix: 0.5 }), r({ codewordsOk: 0, edgePx: 4 }),
    r({ fresh: false, failure: 'TooBlurry' }), r({ fresh: false, receiving: true }), r({ fresh: false, receiving: false, frames: 10 }), r({ fresh: false, receiving: false, frames: 100 })];
  const said = cases.map((c) => shareHint(c));
  check(said.every((h) => h && h.text && !/closer|steady|hold|square up|focus|tilt|elbow/i.test(h.text)), `a shared window is never told to move, hold or focus (${[...new Set(said.map((h) => h.text))].join(' | ')})`);
  check(eq(shareHint(r({})), SHARE_HINTS.good) && shareHint(r({ manifest: false })).lock === 'locked', 'reading the window: good once the file name is in, locked before');
  check(/larger/.test(shareHint(r({ cellPx: 1.0, codewordsOk: 10 })).text), `cells too small in the window: make the sender's window larger (${shareHint(r({ cellPx: 1.0, codewordsOk: 10 })).text})`);
  check(eq(shareHint(r({ fresh: false, receiving: true })), SHARE_HINTS.lost) && eq(shareHint(r({ fresh: false, receiving: false, frames: 10 })), SHARE_HINTS.search), 'lost mid-transfer, and looking at first');
  const base = { startedAt: 0, seenAt: -Infinity, firstSeenAt: -Infinity, progressAt: -Infinity, complete: false };
  check(idleShare({ ...base, now: 7000 }) === null, 'a shared window: no note for the first seconds');
  const n = idleShare({ ...base, now: 8000 });
  check(!!n && /Fastest/.test(n.text) && /window/.test(n.text) && !/hold|closer|phone/i.test(n.text), `nothing seen in the window: what to check, and Fastest on the sender (${n && n.text})`);
  check(idleShare({ ...base, now: 9000, firstSeenAt: 1000, seenAt: 8900, progressAt: 1000 }) === null && /Fastest|larger/.test(idleShare({ ...base, now: 12000, firstSeenAt: 1000, seenAt: 11900, progressAt: 1000 }).text), 'seen but not reading: the window larger or Fastest');
  check(idleShare({ ...base, now: 9000, complete: true }) === null, 'complete: no note');
}

// --- guidance (the app's rules: android/.../Guidance.kt and GuidanceTest.kt) ---
const square = [1, 1, 1, 1];
const read = (o) => ({ fresh: true, failure: null, pitch: 2, bw: true, cellPx: 3, edges: square, codewordsOk: 83, codewords: 83, receiving: true, manifest: true, fill: 0.5, frames: 100, seenBefore: true, ...o });
check(eq(hint(read({ cellPx: 1.0 })), HINTS.good) && eq(hint(read({ cellPx: 1.2, codewordsOk: 76 })), HINTS.good), 'codewords that read never say closer, however small the cells');
check(hint(read({ cellPx: 1.4, codewordsOk: 30, fill: 0.42 })).text === 'Move closer: the square should fill the frame (now 42%)', `small cells that lose codewords say closer, with how much of the frame the square fills (${hint(read({ cellPx: 1.4, codewordsOk: 30, fill: 0.42 })).text})`);
check(eq(hint(read({ cellPx: 2.1, codewordsOk: 30 })), HINTS.steady) && eq(hint(read({ cellPx: 1.7, codewordsOk: 30 })), HINTS.steady), '2.1 and 1.7 camera px are enough for 2 px b/w (floor 1.45): hold steady, not closer');
check(hint(read({ cellPx: 2.1, codewordsOk: 30, pitch: 1 })).lock === 'warn' && /closer/.test(hint(read({ cellPx: 2.1, codewordsOk: 30, pitch: 1 })).text), '... not for 1 px (floor 2.45)');
check(/closer/.test(hint(read({ cellPx: 2.1, codewordsOk: 30, pitch: 4, bw: false })).text), '... nor for colour');
check(floor(2, true) === 1.45 && floor(1, true) === 2.45 && floor(2, false) === 2.45 && floor(3, true) === 1.45 && floor(4, true) === 1.45, 'floors per format: 1.45 for 2 px and coarser b/w, 2.45 for 1 px, grey and colour');
check(eq(hint(read({ cellPx: 1.4, codewordsOk: 30 }), true), HINTS.zooming), 'a small square the camera is about to zoom in on: "zooming in", not "move closer"');
check(eq(hint(read({ cellPx: 3, codewordsOk: 30, edges: [1, 1.2, 1, 0.98] })), HINTS.square), 'perspective that costs reads: square up');
check(eq(hint(read({ edges: [1, 1.2, 1, 0.98] })), HINTS.good) && eq(hint(read({ edges: [1, 1.4, 1, 1] })), HINTS.square), 'a mild tilt that reads is left alone; a strong one is worth fixing');
check(eq(hint(read({ manifest: false })), HINTS.locked), 'reading, no manifest yet: locked on');
check(eq(hint(read({ fresh: false, failure: 'NoMarkers', receiving: false, frames: 10 })), HINTS.search) && eq(hint(read({ fresh: false, failure: 'NoMarkers', receiving: false, frames: 60 })), HINTS.whole), 'nothing read: point at the screen (the whole square, after a while)');
check(eq(hint(read({ fresh: false, failure: 'NoMarkers', receiving: true })), HINTS.lost), 'lost mid-transfer: point back');
check(eq(hint(read({ fresh: false, failure: 'TooBlurry(1.8)' })), HINTS.steady) && eq(hint(read({ fresh: false, failure: 'NoHeader' })), HINTS.steady), 'a blurred or torn frame just after a read: hold steady');
check(eq(hint(read({ fresh: false, failure: 'TooBlurry(0.0)', seenBefore: false, receiving: false, frames: 10 })), HINTS.search), 'a blurred frame with no square seen lately (a blank wall): point at the screen, not "hold steady"');
check(Math.abs(skew([1, 1.5, 1.2, 1.1]) - 1.5) < 1e-9 && skew([]) === 1 && skew([0, 1, 1, 1]) === 1, 'skew is the largest over the smallest edge');
check(eq(parseFormat('2px bw 1024x1024'), { pitch: 2, alphabet: 'bw', w: 1024, h: 1024 }) && parseFormat(null) === null, 'the status format string parses');
check(closer(0).text === 'Move closer: the square should fill the frame', 'closer without a known fill');
check(eq(hint(read({ cellPx: 1.3, codewordsOk: 4, fill: 0.95 })), HINTS.dense), 'cells too small although the square fills the picture: a slower speed, not "move closer"');

// the line shown: a new warning waits 600 ms after another warning; finding the square or all being well shows at once
{
  const h = new HintHold(600);
  check(eq(h.next(closer(0.4), 0), closer(0.4)), 'found (the shown line was searching): the warning shows at once');
  check(h.next(closer(0.45), 50).text.endsWith('(now 45%)'), 'the same warning with a new share shows at once');
  check(eq(h.next(HINTS.square, 100), closer(0.45)) && eq(h.next(HINTS.square, 600), closer(0.45)), 'another warning waits (one odd capture never flips the line)');
  check(eq(h.next(HINTS.square, 700), HINTS.square), '... and shows once it held 600 ms');
  check(eq(h.next(HINTS.good, 710), HINTS.good), 'all well again: at once');
  check(eq(h.next(HINTS.square, 712), HINTS.good) && eq(h.next(HINTS.square, 1312), HINTS.square), 'the good line to a warning waits 600 ms too');
  h.next(HINTS.good, 1315);
  check(eq(h.next(HINTS.lost, 720), HINTS.lost) && eq(h.next(HINTS.square, 730), HINTS.square), 'from the good line or from lost: at once');
  h.reset();
  check(eq(h.shown, HINTS.search), 'reset: searching');
}

// the tracker: fresh for 1.2 s after a decode, the failure for as long, progress from the manifest and bytes
{
  const t = new ReadTracker();
  let r = t.update({ frames: 1, decoded: 1, failed: 0, format: '2px bw 1024x1024', cell_px: 2.2, edges: [1.1, 1.1, 1.1, 1.1], codewords_ok: 5, codewords: 111, corners: [100, 100, 1100, 100, 1100, 1100, 100, 1100], frame: [2000, 1500] }, 1000);
  check(r.fresh && r.pitch === 2 && r.bw && Math.abs(r.fill - 1000 / 1500) < 1e-9, `a decode is fresh, with its format and fill (${r.fill.toFixed(3)})`);
  r = t.update({ frames: 2, decoded: 1, failed: 1, last_error: 'NoMarkers', format: '2px bw 1024x1024' }, 2100);
  check(r.fresh && r.failure === 'NoMarkers', 'still fresh 1.1 s later, the failure seen');
  r = t.update({ frames: 3, decoded: 1, failed: 1, last_error: 'NoMarkers', format: '2px bw 1024x1024' }, 3500);
  check(!r.fresh && r.failure === null && r.seenBefore, 'stale after 1.2 s; an old failure is not news; the square was seen lately');
  check(t.firstSeenAt === 1000 && t.progressAt === -Infinity, 'first seen at the first decode; no progress yet');
  t.update({ frames: 4, decoded: 2, failed: 1, have_manifest: true }, 4000);
  t.update({ frames: 5, decoded: 3, failed: 1, have_manifest: true, received_bytes: 1024 }, 4500);
  check(t.progressAt === 4500, 'the manifest and then new bytes are progress');
}

// --- zoom ---
const caps = { min: 1, max: 10, step: 0.1 };
const frame = [2448, 3264];
// a square of side `side` centred at (cx, cy) in the picture
const sq = (side, cx = frame[0] / 2, cy = frame[1] / 2) => [cx - side / 2, cy - side / 2, cx + side / 2, cy - side / 2, cx + side / 2, cy + side / 2, cx - side / 2, cy + side / 2];
const z = (o) => zoomStep({ z: 1, caps, corners: sq(1224), frame, found: true, lostMs: 0, sinceChangeMs: 5000, ...o });
check(Math.abs(fillOf(sq(1224), frame) - 0.5) < 1e-9, 'fill: the square\'s side over the picture\'s short side');
// a frame tagged with a turn (an Android camera held upright: landscape planes, rotation 90) is read in its coded
// planes; the corners and the frame turn into the picture the page shows, the fill stays
{
  const c = [1000, 100, 1500, 100, 1500, 600, 1000, 600], f = [1920, 1080];
  const d90 = toDisplay(c, f, 90), d270 = toDisplay(c, f, 270), d180 = toDisplay(c, f, 180), d0 = toDisplay(c, f, 0);
  check(eq(d90.frame, [1080, 1920]) && eq(d90.corners, [980, 1000, 980, 1500, 480, 1500, 480, 1000]), 'rotation 90: frame swapped, the corner at coded (x, y) shows at (h - y, x)');
  check(eq(d270.frame, [1080, 1920]) && eq(d270.corners, [100, 920, 100, 420, 600, 420, 600, 920]), 'rotation 270: the corner at coded (x, y) shows at (y, w - x)');
  check(eq(d180.frame, f) && eq(d180.corners, [920, 980, 420, 980, 420, 480, 920, 480]), 'rotation 180: frame kept, corners mirrored through the centre');
  check(d0.corners === c && d0.frame === f, 'rotation 0: as it was');
  check([d90, d180, d270].every((d) => Math.abs(fillOf(d.corners, d.frame) - fillOf(c, f)) < 1e-9), 'the fill is the same at every turn');
  check(eq(toDisplay(null, f, 90), { corners: null, frame: [1080, 1920] }), 'no corners (nothing read): only the frame turns');
}
check(z({}) === 1.6, `half the short side, centred: zoom 1.6 (0.8 / 0.5, on the 0.1 step) (${z({})})`);
check(z({ corners: sq(612) }) === 2, `a quarter: one step of at most 2x (${z({ corners: sq(612) })})`);
check(z({ corners: sq(1224 * 1.5) }) === null, 'three quarters filled: no change (above the 70% start)');
check(z({ caps: { min: 1, max: 1, step: 0.1 } }) === null && z({ caps: null }) === null, 'a camera without zoom: nothing to do');
check(z({ z: 9.9, corners: sq(1224) }) === null && z({ z: 9.5, corners: sq(1224) }) === 10, 'never above the camera\'s maximum');
check(z({ sinceChangeMs: 300 }) === null, 'right after a change: wait for the camera to settle');
{
  // off-centre: the zoom stops before a corner passes 85% of the way to the edge
  const c = sq(1000, 2448 * 0.6, 3264 / 2), next = z({ corners: c });
  const far = Math.abs(c[2] - 1224) * next;
  check(next > 1 && next < 0.8 / (1000 / 2448) && far <= 0.85 * 1224 + 1, `an off-centre square: zoom ${next} keeps its far corner at ${(far / 1224 * 100).toFixed(0)}% of the half-width`);
  check(z({ corners: sq(1000, 2448 * 0.7, 3264 / 2) }) === null, 'further off-centre: no zoom at all (the square would leave the margin)');
}
check(z({ z: 2, corners: sq(2448 * 0.97) }) < 2, `the user came closer (97%): zoom out (${z({ z: 2, corners: sq(2448 * 0.97) })})`);
check(z({ z: 2, corners: sq(1000, 2448 - 520, 3264 / 2) }) < 2, 'a corner at the edge: zoom out before the square leaves the picture');
check(z({ z: 1, corners: sq(2448 * 0.97) }) === null, 'at the widest view nothing to undo');
check(z({ z: 3, found: false, lostMs: 2100 }) === 1 && z({ z: 3, found: false, lostMs: 1500 }) === null && z({ z: 1, found: false, lostMs: 9000 }) === null, 'lost for 2 s: back to the widest view (not sooner, not twice)');
// unread is not gone: frames blurred by the refocus after a zoom-in (or a header that did not read) keep the zoom;
// only markers missing for 2 s send it back out (it went zoom in, refocus blur, zoom out, zoom in on the phone)
check(z({ z: 3, found: false, lostMs: 4000, goneMs: 0 }) === null && z({ z: 3, found: false, lostMs: 4000, goneMs: 1200 }) === null && z({ z: 3, found: false, lostMs: 4000, goneMs: 2100 }) === 1,
  'no read for 4 s but the markers in view (blur, no header): the zoom stays; markers gone for 2 s: back out');
{
  // closed loop: the picture's centre stays put, zooming scales the square about it; from a square at 30% of the
  // short side the zoom settles with the square at 70-95% and every corner inside the picture all the way
  const settle = (off) => {
    let zoom = 1, steps = 0, inside = true, fill = 0, edge = 0;
    const base = 0.3 * 2448;
    for (let t = 0; t < 20; t++) {
      const k = zoom, c = sq(base * k, 1224 + off[0] * k, 1632 + off[1] * k);
      inside &&= c.every((v, i) => v >= 0 && v <= frame[i % 2]);
      fill = fillOf(c, frame);
      edge = Math.max(...c.map((v, i) => Math.abs(v - frame[i % 2] / 2) / (frame[i % 2] / 2)));
      const next = zoomStep({ z: zoom, caps, corners: c, frame, found: true, lostMs: 0, sinceChangeMs: 1000 });
      if (next === null) break;
      zoom = next; steps++;
    }
    return { zoom, steps, inside, fill, edge };
  };
  const a = settle([40, -30]);
  // the lower bound is the margin's (a corner near 85% of the way to the edge stops the zoom at 75% here), not the
  // start threshold's: an off-centre square cannot always reach the target
  check(a.fill >= 0.7 && a.fill <= ZOOM.OUT_ABOVE && a.inside && a.steps <= 3, `from 30% near the centre the zoom settles at ${a.zoom} (square ${(a.fill * 100).toFixed(0)}% of the short side, ${a.steps} steps, always inside)`);
  const b = settle([140, -90]);
  check(b.inside && b.edge <= ZOOM.IN_MARGIN + 1e-9 && b.zoom > 1, `off-centre it stops where a corner nears the margin: zoom ${b.zoom}, square ${(b.fill * 100).toFixed(0)}%, farthest corner ${(b.edge * 100).toFixed(0)}% of the way to the edge`);
}

// --- focus ---
{
  const f = new FocusWatch();
  // edgePx 3: the border's edge soft (focus); the drift blend's sharp edges are below
  const st = (o) => ({ found: true, codewordsOk: 5, codewords: 111, cellPx: 2.3, floorPx: 1.8, sharpness: 20, zoom: 1, edgePx: 3, now: 0, ...o });
  check(!f.update(st({ now: 0 })) && !f.update(st({ now: 600 })), 'reading badly at a readable cell size: not yet (under 1 s)');
  check(f.update(st({ now: 1100 })), 'reading badly for 1 s with cells large enough: refocus');
  check(!f.update(st({ now: 1300 })) && !f.update(st({ now: 3000 })), '... then a pause (no refocus storm)');
  check(f.update(st({ now: 5200 })) && !f.update(st({ now: 5300 })), '... and again after the pause if it still reads badly');
  const g = new FocusWatch();
  check(!g.update(st({ codewordsOk: 111, now: 0 })) && !g.update(st({ codewordsOk: 111, now: 5000 })), 'reading well: never');
  // reads failing with sharp border edges (a timing blend below the blend line, a drift): not focus, no refocus (each
  // refocus hunts the lens, and the picture's scale breathes with it: 24 refocuses in a transfer, phone 2026-11-05)
  const sharp = new FocusWatch();
  let sharpN = 0; for (let t = 0; t <= 20000; t += 100) if (sharp.update(st({ codewordsOk: 40, edgePx: 1.6, mix: 0.08, now: t }))) sharpN++;
  check(sharpN === 0, `reads failing with sharp edges for 20 s: no refocus (${sharpN})`);
  const sharpDrop = new FocusWatch();
  sharpDrop.update(st({ codewordsOk: 80, sharpness: 40, edgePx: 1.6, now: 0 }));
  let dropN = 0; for (let t = 100; t <= 10000; t += 100) if (sharpDrop.update(st({ codewordsOk: 80, sharpness: 20, edgePx: 1.6, now: t }))) dropN++;
  check(dropN === 0, `sharpness down with sharp border edges: no refocus (${dropN})`);
  const h = new FocusWatch();
  h.update(st({ codewordsOk: 5, cellPx: 1.5, now: 0 }));
  check(!h.update(st({ codewordsOk: 5, cellPx: 1.5, now: 3000 })), 'cells too small for the format: distance, not focus (no refocus)');
  // one threshold for "Move closer" and the refocus: 1.5 px at 2 px b/w (floor 1.45) says closer, so no refocus;
  // 1.65 px does not say closer, so a poor read there is focus
  const h2 = new FocusWatch();
  h2.update(st({ codewordsOk: 5, cellPx: 1.5, floorPx: 1.45, now: 0 }));
  check(!h2.update(st({ codewordsOk: 5, cellPx: 1.5, floorPx: 1.45, now: 3000 })) && /closer/.test(hint(read({ cellPx: 1.5, codewordsOk: 5 })).text), '1.5 px at 2 px b/w: "Move closer", no refocus');
  const h3 = new FocusWatch();
  h3.update(st({ codewordsOk: 5, cellPx: 1.65, floorPx: 1.45, now: 0 }));
  check(h3.update(st({ codewordsOk: 5, cellPx: 1.65, floorPx: 1.45, now: 1100 })) && eq(hint(read({ cellPx: 1.65, codewordsOk: 5 })), HINTS.steady), '1.65 px at 2 px b/w: not closer, a refocus');
  const k = new FocusWatch();
  k.update(st({ codewordsOk: 80, sharpness: 40, now: 0 }));
  k.update(st({ codewordsOk: 80, sharpness: 20, now: 100 }));
  check(k.update(st({ codewordsOk: 80, sharpness: 20, now: 1200 })), 'sharpness at half the best seen for 1 s while reading under 90%: refocus');
  const kk = new FocusWatch();
  kk.update(st({ codewordsOk: 111, sharpness: 40, now: 0 }));
  kk.update(st({ codewordsOk: 111, sharpness: 20, now: 100 }));
  check(!kk.update(st({ codewordsOk: 111, sharpness: 20, now: 1200 })) && !kk.update(st({ codewordsOk: 105, sharpness: 20, now: 3000 })), 'a transfer that reads well is never disturbed, whatever the sharpness');
  const m = new FocusWatch();
  m.update(st({ codewordsOk: 80, sharpness: 40, now: 0 }));
  check(!m.update(st({ codewordsOk: 80, sharpness: 20, zoom: 2, now: 100 })) && !m.update(st({ codewordsOk: 80, sharpness: 20, zoom: 2, now: 1300 })), 'a new zoom starts a new best (a zoomed picture scores differently)');
  check(!m.update(st({ found: false, now: 9000 })), 'no square: nothing to focus on');
  const q = new FocusWatch();
  q.update(st({ codewordsOk: 80, sharpness: 40, format: '3px bw 1024x1024', now: 0 }));
  check(!q.update(st({ codewordsOk: 80, sharpness: 20, format: '2px bw 1024x1024', now: 100 })) && !q.update(st({ codewordsOk: 80, sharpness: 20, format: '2px bw 1024x1024', now: 1300 })), 'another data format starts a new best (a finer format scores differently)');
}

// a long run as the page sees it: data reads at 3 of 111, a status without a read now and then (NoHeader), and the
// manifest once a second (its status keeps the data read's format, codewords and sharpness: core/tests/session.rs;
// `manifestSharp` models a status that took the manifest's own sharper score, as before that fix; the data's border
// edge soft (3 camera px), as out of focus)
{
  const run = (cell, fill, manifestSharp = 15) => {
    const t = new ReadTracker(), hold = new HintHold(600), f = new FocusWatch();
    const side = fill * 1500, c = [1000 - side / 2, 750 - side / 2, 1000 + side / 2, 750 - side / 2, 1000 + side / 2, 750 + side / 2, 1000 - side / 2, 750 + side / 2];
    let dec = 0, fail = 0, lines = new Set(), refocus = 0;
    for (let i = 0; i < 90; i++) {
      const now = i * 1000 / 30;
      const miss = i % 7 === 3, manifest = i % 30 === 29;
      if (miss) fail++; else dec++;
      const s = { frames: i + 1, decoded: dec, failed: fail, last_error: miss ? 'NoHeader' : null, format: '2px bw 1024x1024', cell_px: cell, edges: [cell / 2, cell / 2, cell / 2, cell / 2], codewords_ok: 3, codewords: 111, have_manifest: true, stream_size: 1e6, received_bytes: 0, corners: c, frame: [2000, 1500], sharpness: manifest ? manifestSharp : 15, edge_px: 3 };
      const r = t.update(s, now);
      const shown = hold.next(hint(r), now);
      if (i > 3) lines.add(shown.text);
      if (f.update({ found: t.readAt === now, codewordsOk: r.codewordsOk, codewords: r.codewords, cellPx: r.cellPx, floorPx: floor(r.pitch, r.bw), sharpness: s.sharpness, zoom: 1, format: s.format, edgePx: r.edgePx, now })) refocus++;
    }
    return { lines: [...lines], refocus };
  };
  const a = run(1.4, 0.6);
  check(a.refocus === 0, `3 of 111 at 1.4 px (distance, not focus: below the 1.45 floor), every status with the data's sharpness: no refocus (${a.refocus})`);
  check(run(1.4, 0.6, 40).refocus > 0, "(a status carrying the manifest's sharper score would make the data look soft and refocus: why the session keeps the data's)");
  check(a.lines.length === 1 && a.lines[0] === 'Move closer: the square should fill the frame (now 60%)', `3 of 111 at 1.4 px for 3 s, with misses and manifest reads between: always "${a.lines.join('" / "')}"`);
  const b = run(2.3, 0.6);
  check(b.refocus >= 1 && b.lines.every((l) => /^(Hold steady|Reading…)/.test(l)) && b.lines.some((l) => l.startsWith('Reading…')), `3 of 111 at 2.3 px, soft: refocus still fires (${b.refocus} in 3 s) through misses and manifest reads; the tile tracked and codewords decoding: "Reading…" (lines ${b.lines.join(' / ')})`);
}

// --- the lock (the app's LockWatch, GuidanceTest.kt): the tile read without a gap for 0.5 s and a codeword
// decoded among the last 10 reads; reads failing while locked say "Reading…" with why, never "Hold steady" alone
{
  const w = new LockWatch();
  check(!w.update(true, true, 4, 0) && !w.update(true, true, 0, 400) && w.update(true, true, 0, 500), 'locked after 0.5 s tracked with a codeword among the reads');
  let t = 500;
  for (let i = 0; i < 9; i++) { t += 33; w.update(true, true, 0, t); }
  check(w.update(true, true, 0, t + 33) && w.update(true, true, 0, 1700) && !w.update(true, true, 0, 1740), 'ten reads without a codeword: held 1 s after the last good status, then off');
  check(w.update(true, true, 3, 1800), 'one decodes: locked again');
  check(!w.update(false, false, 0, 4000) && !w.update(true, true, 50, 4100) && w.update(true, true, 50, 4600), 'the tile lost: off at once, the half second starts again');
  const base = read({ cellPx: 1.8, codewordsOk: 4, codewords: 111, mix: 0, edgePx: 1.5, locked: true });
  check(eq(hint(base), HINTS.reading) && HINTS.reading.lock === 'locked', 'locked, reads failing: "Reading…", locked on');
  check(eq(hint({ ...base, mix: 0.54 }), HINTS.readingOverlap) && eq(hint({ ...base, edgePx: 3.2 }), HINTS.readingFocus), '... with why: two frames overlap, or focusing');
  check(eq(hint({ ...base, locked: false }), HINTS.steady) && eq(hint({ ...base, locked: false, edgePx: 3.2 }), HINTS.steadyFocus), 'not locked yet, codewords decoding: hold steady, with why when it shows');
  const none = { ...base, locked: false, codewordsOk: 0 };
  check(eq(hint(none), HINTS.readingUnlocked) && HINTS.readingUnlocked.text === 'Reading…' && HINTS.readingUnlocked.lock === 'warn' && eq(hint({ ...none, edgePx: 3.2 }), HINTS.readingUnlockedFocus) && HINTS.readingUnlockedFocus.text === 'Reading… focusing',
    'the tile tracked and not one codeword decoding (never locked): "Reading…" with why, not locked on, never "Hold steady" alone');
  // a clean-looking read that collapses (2 of 111 with sharp edges, cells above the floor) is a blend the measure
  // under-reports: the same advice (the sender's rate); soft edges say focusing instead
  check(eq(hint({ ...base, mix: 0.0, codewordsOk: 2, codewords: 111, edgePx: 1.5, collapsed: true }), HINTS.readingOverlap), 'reads collapsed while clean (the tracker counted them): the blend advice');
  check(eq(hint({ ...base, locked: false, mix: 0.54 }), HINTS.readingOverlap) && eq(hint({ ...base, mix: 0.15 }), HINTS.readingOverlap) && eq(hint({ ...base, mix: 0.03 }), HINTS.reading), 'a blend says reading, locked or not (holding steady cannot fix it), from 0.15 (the phase-step line)');
  // a manifest read leaves the data's codewords in the status: not a new data read
  const tm = new ReadTracker();
  let rm;
  for (let i = 0; i <= 20; i++) rm = tm.update({ frames: i + 1, decoded: i + 1, data_reads: i < 5 ? i + 1 : 5, failed: 0, format: '2px bw 1024x1024', cell_px: 1.8, edges: [0.9, 0.9, 0.9, 0.9], codewords_ok: 3, codewords: 111 }, i * 33);
  check(rm.fresh && tm.lock.recent.length === 5, `16 manifest reads after 5 data reads: only the 5 data reads count toward the lock (${tm.lock.recent.length})`);
  // the focus watch: a blend with sharp edges is not focus
  const fb = new FocusWatch();
  const sb = (o) => ({ found: true, codewordsOk: 5, codewords: 111, cellPx: 2.3, floorPx: 1.45, sharpness: 20, zoom: 1, mix: 0.54, edgePx: 1.5, now: 0, ...o });
  fb.update(sb({ now: 0 }));
  check(!fb.update(sb({ now: 1100 })) && !fb.update(sb({ now: 3000 })), 'reading badly with two frames blended and sharp edges: no refocus');
  check(fb.update(sb({ edgePx: 3.2, now: 4200 })) || fb.update(sb({ edgePx: 3.2, now: 5300 })), '... with soft edges: refocus');
  check(/closer/.test(hint({ ...base, cellPx: 1.5 }).text), 'too small still says closer, locked or not');
  // the tracker carries the status's mix and edge width, and the lock
  const tr = new ReadTracker();
  let r;
  for (let i = 0; i <= 20; i++) r = tr.update({ frames: i + 1, decoded: i + 1, failed: 0, format: '2px bw 1024x1024', cell_px: 1.8, edges: [0.9, 0.9, 0.9, 0.9], codewords_ok: i % 5 === 0 ? 2 : 0, codewords: 111, mix: 0.54, edge_px: 1.5 }, i * 33);
  check(r.locked && r.mix === 0.54 && r.edgePx === 1.5 && eq(hint(r), HINTS.readingOverlap), `the tracker: locked after 0.5 s with a codeword now and then, mix and edge width carried (${hint(r).text})`);
  // clean-looking data reads (mix 0, sharp, cells above the floor) under a fifth of their codewords: after
  // COLLAPSED_READS in a row the tracker calls them a blend; one good read clears it
  const tc = new ReadTracker();
  const st = (i, ok) => ({ frames: i + 1, decoded: i + 1, data_reads: i + 1, failed: 0, format: '2px bw 1024x1024', cell_px: 1.8, edges: [0.9, 0.9, 0.9, 0.9], codewords_ok: ok, codewords: 96, mix: 0.0, edge_px: 1.5, corners: [100, 100, 900, 100, 900, 900, 100, 900], frame: [1080, 1920] });
  let rc; for (let i = 0; i < COLLAPSED_READS - 1; i++) rc = tc.update(st(i, 2), i * 33);
  check(!rc.collapsed, 'four poor clean reads: not yet');
  rc = tc.update(st(COLLAPSED_READS - 1, 2), 200);
  check(rc.collapsed && eq(hint(rc), HINTS.readingOverlap), `five in a row: a blend (${hint(rc).text})`);
  rc = tc.update(st(COLLAPSED_READS, 96), 240);
  check(!rc.collapsed, 'a whole read clears it');
  // a drift slides through partial reads before it reads nothing: under half the codewords with sharp edges counts
  // (phone, 2026-11-05: 108, 72, 35, 20, 13 of 111 over 8 s, the blend measure 0.10-0.15, the search 8 s late)
  const driftT = new ReadTracker();
  let driftR; for (let i = 0; i < COLLAPSED_READS; i++) driftR = driftT.update(st(i, 45), i * 33);
  check(driftR.collapsed, `five sharp reads at 45 of 96 codewords: the blend shows (${driftR.collapsed})`);
  const softT = new ReadTracker();
  const softSt = (i, ok) => ({ ...st(i, ok), edge_px: 3.4 });
  let softR; for (let i = 0; i < 10; i++) softR = softT.update(softSt(i, 45), i * 33);
  check(!softR.collapsed, 'the same reads with soft edges (motion, focus): not a blend');
  const halfT = new ReadTracker();
  let halfR; for (let i = 0; i < 10; i++) halfR = halfT.update(st(i, 60), i * 33);
  check(!halfR.collapsed, 'over half the codewords: not counted');
}
{ // the phase search: a second of blended reads with the rates matching re-opens the camera; a whole read within the
  // try locks; a try that reads nothing is followed by another, six in a search before it gives up; locked and
  // blended again for 1.5 s: unlocked, another search after the gap
  const run = (p, { mix, whole = false, collapsed = false, camFps = 30, from = 0, to, step = 33 }) => { let out = null, n = 0; for (let t = from; t <= to; t += step) { const a = p.update({ now: t, newData: true, mix, whole, collapsed, senderFps: 30, camFps }); if (a) { out = { t, ...a }; n++; } } return out && { ...out, n }; };
  const p = new PhaseSweep();
  const a = run(p, { mix: 0.5, to: 1500 });
  check(a && a.reroll && a.n === 1 && a.t >= 600 && a.t <= 1100 && p.fixing, `blended for a second: the camera opened again (at ${a && a.t} ms)`);
  const h = run(p, { mix: 0.0, whole: true, from: 1600, to: 1700 });
  check(h === null && p.locked && p.fixing, 'the first whole read: locked, no more re-opens');
  const n = run(p, { mix: 0.0, whole: true, from: 1800, to: 6000 });
  check(n === null && p.locked, 'whole reads while locked: nothing');
  const u = run(p, { mix: 0.5, from: 6100, to: 9000 });
  check(u && u.reroll && !p.locked, `locked, then blended again: unlocked and searching (${u && u.t})`);
  const f = new PhaseSweep();
  const g = run(f, { mix: 0.5, to: 30000 });
  check(g && g.n === SWEEP.TRIES && f.resting && !f.fixing, `a search that never reads whole: ${g && g.n} re-opens, then a rest (the rate advice shows)`);
  // it never gives up for good: after the rest another search (the camera button, which also re-opens the camera,
  // read where the page had stopped trying: phone, 2026-11-05)
  const rest = run(f, { mix: 0.5, from: 30033, to: g.t + SWEEP.REST_MS - 100 });
  check(rest === null, `no re-open during the rest (${rest && rest.t})`);
  const again = run(f, { mix: 0.5, from: g.t + SWEEP.REST_MS - 67, to: g.t + SWEEP.REST_MS + 3000 });
  check(again && again.reroll && f.fixing && !f.resting, `after the rest: searching again (at ${again && again.t - g.t} ms after the last try)`);
  // cells too fine to read (a 1 px sender on a Full HD camera) look blended to the blend measure: no camera restart,
  // which cannot help (phone, 2026-11-05: 27 restarts in 2.5 minutes on 0.7-1.0 camera px per cell)
  const fine = new PhaseSweep();
  let fr = 0; for (let t = 0; t <= 30000; t += 33) if (fine.update({ now: t, newData: true, mix: 0.9, whole: false, collapsed: false, senderFps: 30, camFps: 30, readable: false })) fr++;
  check(fr === 0 && !fine.fixing, `reads too fine to read: no restart in 30 s (${fr})`);
  const fineThenOk = run(fine, { mix: 0.5, from: 30033, to: 32000 });
  check(fineThenOk && fineThenOk.reroll, 'readable cells, blended: the search starts');
  const rb = { fresh: true, failure: null, pitch: 2, bw: true, cellPx: 1.8, edges: [0.9, 0.9, 0.9, 0.9], codewordsOk: 4, codewords: 111, receiving: true, mix: 0.54, edgePx: 1.5, locked: true };
  check(eq(hint({ ...rb, phaseFixing: true }), HINTS.readingTiming) && eq(hint(rb), HINTS.readingOverlap), 'while the page searches the line says it is finding the timing; otherwise the rate advice');
}

// --- a virtual camera that spans several lenses: the main lens instead (the system swaps lenses inside a virtual one
// on its own close up: the picture's scale and focus change mid-transfer) ---
{
  const devs = [{ deviceId: 't', label: 'Back Triple Camera' }, { deviceId: 'u', label: 'Back Ultra Wide Camera' }, { deviceId: 'm', label: 'Back Camera' }, { deviceId: 'w', label: 'Back Dual Wide Camera' }];
  check(physicalLens('Back Triple Camera', devs)?.deviceId === 'm', 'a triple virtual camera: the main lens');
  check(physicalLens('Back Dual Wide Camera', devs)?.deviceId === 'm', 'a dual virtual camera: the main lens');
  check(physicalLens('Back Camera', devs) === null, 'already the main lens: nothing to change');
  check(physicalLens('Back Ultra Wide Camera', devs) === null, 'a single lens the user picked: kept');
  check(physicalLens('camera2 0, facing back', devs) === null, 'a camera with no virtual label: kept');
  check(physicalLens('Back Triple Camera', devs.filter((d) => d.deviceId !== 'm')) === null, 'no main lens listed: the virtual camera stays');
  // Android: the primary back camera is camera 0; Chrome's own pick was the ultrawide (camera 3) on a phone whose
  // ultrawide read 0-4 of 111 with sharp edges (its distortion bends the grid of a square filling the view)
  const andr = [{ deviceId: 'f', label: 'camera 1, facing front' }, { deviceId: 'u3', label: 'camera 3, facing back' }, { deviceId: 't2', label: 'camera 2, facing back' }, { deviceId: 'm0', label: 'camera 0, facing back' }];
  check(physicalLens('camera 3, facing back', andr)?.deviceId === 'm0', 'Android: opened on camera 3, the main lens is camera 0');
  check(physicalLens('camera 0, facing back', andr) === null, 'Android: already on camera 0');
  check(physicalLens('camera 3, facing back', andr.filter((d) => d.deviceId !== 'm0')) === null, 'Android without a camera 0: kept');
  // the camera button cycles single lenses only (a virtual one picked by the button, and remembered, swapped lenses
  // again: phone, 2026-11-05)
  check(singleLenses(devs).map((d) => d.deviceId).join() === 'u,m', `the button's lenses: the single ones (${singleLenses(devs).map((d) => d.label).join(', ')})`);
  const onlyVirtual = devs.filter((d) => /dual|triple/i.test(d.label));
  check(singleLenses(onlyVirtual).length === 2, 'only virtual cameras listed: all of them stay choosable');
  check(singleLenses([{ deviceId: 'a', label: 'camera2 0, facing back' }, { deviceId: 'b', label: 'camera2 2, facing back' }]).length === 2, 'labels with no virtual cameras: all stay');
}

// --- too close to focus, and the lens that reads best ---
{
  const rr = (o) => ({ fresh: true, pitch: 2, bw: true, cellPx: 3.2, edgePx: 3.4, codewordsOk: 4, codewords: 111, ...o });
  check(tooClose(rr({}), { at: 0.13, min: 0.13 }), 'soft, reading badly, the lens at its closest focus: too close');
  check(!tooClose(rr({}), { at: 0.4, min: 0.13 }), 'soft but the lens still has room to focus: not too close (focus, not distance)');
  check(!tooClose(rr({ edgePx: 1.6 }), { at: 0.13, min: 0.13 }), 'sharp edges: not too close (a blend, not focus)');
  check(!tooClose(rr({ codewordsOk: 111 }), { at: 0.13, min: 0.13 }), 'reading well: never');
  check(tooClose(rr({}), null), 'no focus reported: soft with cells at twice the floor or more is too close');
  check(!tooClose(rr({ cellPx: 2.2 }), null), '... with cells under twice the floor it is not (blur, not distance)');

  const lenses = ['main', 'wide', 'tele'];
  // the main lens too close for 1.5 s: the next lens; it reads whole after settling: kept, and no more switching
  const p = new LensPick();
  let ask = null, t = 0, cur = 'main';
  const step = (o) => { const a = p.update({ now: t, lenses, current: cur, found: true, ...o }); t += 100; if (a) { ask = a; cur = a; } return a; };
  for (let i = 0; i < 14; i++) step({ close: true, whole: false });
  check(ask === null, 'too close for 1.4 s: not yet');
  for (let i = 0; i < 3; i++) step({ close: true, whole: false });
  check(ask === 'wide' && p.trying, `too close for 1.5 s: the next single lens (${ask})`);
  ask = null;
  for (let i = 0; i < 60; i++) step({ close: false, whole: true });
  check(ask === null && p.done && cur === 'wide', `the new lens reads whole: kept, settled (${cur}, done ${p.done})`);
  for (let i = 0; i < 40; i++) step({ close: true, whole: false });
  check(cur === 'wide', 'settled for the visit: no more switching (no ping-pong)');
  // every lens worse: back to the one that read best
  const q = new LensPick();
  let qc = 'main', qt = 0, seen = [];
  const qs = (o) => { const a = q.update({ now: qt, lenses, current: qc, found: true, ...o }); qt += 100; if (a) { seen.push(a); qc = a; } };
  for (let i = 0; i < 40; i++) qs({ close: true, whole: i % 3 === 0 });
  for (let i = 0; i < 200 && !q.done; i++) qs({ close: true, whole: false });
  check(q.done && qc === 'main' && seen.join() === 'wide,tele,main', `no lens reads better: each tried once, then back to the best (${seen.join(' -> ')})`);
  check(new LensPick().update({ now: 0, lenses: ['main'], current: 'main', found: true, close: true, whole: false }) === null, 'one lens: nothing to switch to');
  // a lens that cannot read the square at a readable size (sharp, big enough, under a fifth whole for 6 s: an
  // ultrawide's distortion) is changed too, not only one too close to focus
  const u = new LensPick();
  let uc = 'main', ut = 0, uask = null;
  for (let i = 0; i < 80 && !uask; i++) { const a = u.update({ now: ut, lenses, current: uc, found: true, close: false, poor: true, whole: false }); ut += 100; if (a) uask = a; }
  check(uask === 'wide' && ut >= LENS.POOR_MS * 0.95, `reading under a fifth whole at a readable size for ${ut} ms: the next lens (${uask})`);
  const ok2 = new LensPick();
  let okAsk = null; for (let i = 0; i < 100; i++) { const a = ok2.update({ now: i * 100, lenses, current: 'main', found: true, close: false, poor: false, whole: i % 2 === 0 }); if (a) okAsk = a; }
  check(okAsk === null, 'reading at all (not poor): the lens stays');
  const r0 = { fresh: true, failure: null, pitch: 2, bw: true, cellPx: 3.2, edges: [1.6, 1.6, 1.6, 1.6], codewordsOk: 4, codewords: 111, receiving: true, mix: 0, edgePx: 3.4, locked: true };
  check(/move the phone back/i.test(hint({ ...r0, tooClose: true }).text), `too close and no lens left to try: "${hint({ ...r0, tooClose: true }).text}"`);
  check(/lens/i.test(hint({ ...r0, tooClose: true, lensTrying: true }).text), `while another lens is tried: "${hint({ ...r0, tooClose: true, lensTrying: true }).text}"`);
}

// --- zoom limits: the starting zoom as the floor (never under 1x: under it may be another lens), at most 3x, and a
// zoom that lost the square is not tried again on this lens ---
{
  const caps = { min: 0.6, max: 10, step: 0.1 };
  check(eq(new ZoomLimits(caps, 0.6).caps(), { min: 1, max: 3, step: 0.1 }), `a camera from 0.6x: auto zoom between 1x and 3x (${JSON.stringify(new ZoomLimits(caps, 0.6).caps())})`);
  check(new ZoomLimits(caps, 1.5).caps().min === 1.5, 'a camera that starts at 1.5x: that is the floor');
  check(new ZoomLimits({ min: 1, max: 1.05, step: 0.1 }, 1).caps() === null, 'less than a step of room: no auto zoom');
  const l = new ZoomLimits({ min: 1, max: 10, step: 0.1 }, 1);
  l.zoomed(2.4, 1000);
  l.update(true, 1100); l.update(true, 1300);
  check(!l.update(false, 1500) && !l.update(false, 1900), 'a few frames without the square: not yet lost');
  check(l.update(false, 2100) && l.caps().max === 2.3, `the square lost 0.3 s after zooming to 2.4x: this lens stays below it from now on (max ${l.caps().max})`);
  const m = new ZoomLimits({ min: 1, max: 10, step: 0.1 }, 1);
  m.zoomed(2.4, 1000);
  for (let t = 1100; t <= 2700; t += 100) m.update(true, t);
  check(!m.update(false, 4000) && m.caps().max === 3, 'the square read for 1.5 s after the zoom, lost later: the zoom was fine, the limit stays');
  const b = new ZoomLimits({ min: 1, max: 10, step: 0.1 }, 1);
  b.zoomed(2.4, 1000); b.update(true, 1100);
  for (let t = 1200; t <= 2400; t += 100) b.update(false, t, 'TooBlurry(2.1)');
  check(b.caps().max === 3 && !b.update(true, 2500), 'blurred frames after a zoom (focus catching up) are not a lost square');
  const r = new ZoomLimits({ min: 1, max: 10, step: 0.1 }, 1);
  r.zoomed(2.4, 1000); r.update(true, 1100); r.update(false, 1900);
  const learned = r.caps().max;
  r.update(true, 20000);
  const at20 = r.caps().max;
  r.update(true, 31950);
  const at31 = r.caps().max;
  r.update(true, 62000);
  check(learned === 2.3 && at20 === 2.3 && at31 === 2.4 && r.caps().max === 2.5, `a learned limit relaxes one step per 30 s without a loss (${learned} -> ${at20} at 20 s -> ${at31} at 31 s -> ${r.caps().max} at 62 s)`);
  r.reset();
  check(r.caps().max === 3, 'a new transfer forgets it');
}
{
  // after a zoom-in only the manifest reads (the data frames fail at first): its corners are the square's place now
  const W = 2448, H = 3264, sqAt = (fill) => { const s2 = fill * W; return [W / 2 - s2 / 2, H / 2 - s2 / 2, W / 2 + s2 / 2, H / 2 - s2 / 2, W / 2 + s2 / 2, H / 2 + s2 / 2, W / 2 - s2 / 2, H / 2 + s2 / 2]; };
  const lim = { min: 1, max: 3, step: 0.1 };
  const first = zoomStep({ z: 1, caps: lim, corners: sqAt(0.4), frame: [W, H], found: true, lostMs: 0, sinceChangeMs: 5000 });
  const fresh = zoomStep({ z: first, caps: lim, corners: sqAt(0.4 * first), frame: [W, H], found: true, lostMs: 0, sinceChangeMs: 1000 });
  const stale = zoomStep({ z: first, caps: lim, corners: sqAt(0.4), frame: [W, H], found: true, lostMs: 0, sinceChangeMs: 1000 });
  check(first === 2 && fresh === null && stale === 3, `zoom 1 -> ${first}; the manifest's fresh corners (80%) stop it there (${fresh}); the data read's stale ones would push on to ${stale}`);
}
{
  // a transfer that reads well: no zoom in; out near an edge still
  const c = [1224 - 500, 1632 - 500, 1224 + 500, 1632 - 500, 1224 + 500, 1632 + 500, 1224 - 500, 1632 + 500];
  const zz = (o) => zoomStep({ z: 1, caps: { min: 1, max: 3, step: 0.1 }, corners: c, frame: [2448, 3264], found: true, lostMs: 0, sinceChangeMs: 5000, ...o });
  check(zz({}) > 1 && zz({ reads: true }) === null, `a small square that reads well is left alone (${zz({})} when not reading, ${zz({ reads: true })} when reading)`);
  const edge = [2448 - 1100, 1000, 2448 - 30, 1000, 2448 - 30, 2070, 2448 - 1100, 2070];
  check(zz({ z: 2, corners: edge, reads: true }) < 2, 'reading well but at the edge: zoom out still');
}

// --- the sender-rate banner: advice, not an order; up once the sender has been over 1.2x the camera for 3 s in a
// row (never for a difference under 20%), held 2 s after it clears (the app's SenderFpsWatch, SenderFpsTest.kt) ---
{
  const T60 = 'The sender shows 60 fps; this camera reads 30. Set the sender to 30 fps or keep going: it will take about twice as long.';
  const b = new FpsBanner();
  check(b.update(0, 30, 0) === null && b.update(35, 30, 100) === null, 'unknown or within 20%: no banner');
  check(b.update(60, 30, 200) === null && b.update(60, 30, 3100) === null, 'a faster sender for under 3 s: no banner yet');
  const t = b.update(60, 30, 3200);
  check(t === T60, `60 against 30 for 3 s: ${t}`);
  check(b.update(0, 30, 4500) === t && b.update(30, 30, 5100) === t, 'held for 2 s after it clears (a stutter never blinks it)');
  check(b.update(30, 30, 5201) === null, '... then gone');
  const c = new FpsBanner();
  c.update(60, 30, 0); c.update(30, 30, 2000);
  check(c.update(60, 30, 2200) === null && c.update(60, 30, 5000) === null && c.update(60, 30, 5200) === T60, 'a run broken before 3 s starts again');
  const n = new FpsBanner();
  let any = false;
  for (let t = 0; t <= 20000; t += 200) any = any || n.update(35.9, 30, t) !== null || n.update(29.9, 24.95, t + 100) !== null;
  check(!any, 'never for a difference under 20% (35.9 against 30, 29.9 against 24.95, for 20 s)');
  check(fpsBannerText(60, 29.2) === T60, `a camera within 1.5 fps of a choice is named by it (${fpsBannerText(60, 29.2)})`);
  check(fpsBannerText(30, 20) === 'The sender shows 30 fps; this camera reads 20. Set the sender to 15 fps or keep going: it will take about 1.5 times as long.', `a slow camera: the fastest choice it keeps up with (${fpsBannerText(30, 20)})`);
  // only the sender page's own rates (15, 30, 60), and only one below the sender's; else keep going alone
  check(SENDER_FPS.join() === '15,30,60', `the rates the sender page offers (${SENDER_FPS})`);
  check(fpsBannerText(30, 24) === 'The sender shows 30 fps; this camera reads 24. Set the sender to 15 fps or keep going: it will take about 1.3 times as long.', `30 against 24: never 24, which the sender does not offer (${fpsBannerText(30, 24)})`);
  check(fpsBannerText(15, 10) === 'The sender shows 15 fps; this camera reads 10. Keep going: it will take about 1.5 times as long.', `15 against 10: nothing slower to suggest (${fpsBannerText(15, 10)})`);
  check(fpsBannerText(15.4, 9) === 'The sender shows 15 fps; this camera reads 9. Keep going: it will take about 1.7 times as long.', `a sender measured at 15.4 is at 15 (${fpsBannerText(15.4, 9)})`);
  check(fpsBannerText(48, 30) === 'The sender shows 48 fps; this camera reads 30. Set the sender to 30 fps or keep going: it will take about 1.6 times as long.', `a 48 fps sender (its screen's own rate) against 30 (${fpsBannerText(48, 30)})`);
  check(fpsBannerText(120, 30) === 'The sender shows 120 fps; this camera reads 30. Set the sender to 30 fps or keep going: it will take about 4 times as long.', `120 against 30 (${fpsBannerText(120, 30)})`);
}

// --- the sender is another LensBolt version (the app's VersionWatch, VersionWatchTest.kt) ---
{
  check(VERSION_TEXT === 'The sender is a different LensBolt version. Update both to the same version.', 'the other-version words');
  // statuses of a version-8 sender as the browser receiver sees it: every frame fails at its header, read whole
  const t = new ReadTracker(), w = new VersionWatch();
  let shown = [];
  for (let n = 1; n <= 20; n++) {
    const now = n * 100;
    const r = t.update({ decoded: 0, failed: n, last_error: 'OtherVersion(8)', frames: n }, now);
    shown.push(w.update(r, now));
  }
  check(shown.slice(0, 9).every((x) => x === null) && shown[9] === null && shown.slice(10).every((x) => x === VERSION_TEXT), `shown once the reports have gone on for 1 s (${shown.map((x) => (x ? 1 : 0)).join('')})`);
  // a blurred capture or a missed header in the run neither starts nor ends it; a read of this version ends it
  const v = new VersionWatch(), r = (failure, fresh = false) => ({ fresh, failure });
  check(v.update(r('NoMarkers'), 0) === null && v.update(r('NoHeader'), 2000) === null, 'other failures alone: nothing');
  check(v.update(r('OtherVersion(8)'), 3000) === null && v.update(r('TooBlurry(1.2)'), 3500) === null && v.update(r('OtherVersion(8)'), 4000) === VERSION_TEXT, 'a blurred capture in the run does not end it');
  check(v.update(r(null), 4500) === VERSION_TEXT, 'kept while the last report is fresh');
  check(v.update(r('OtherVersion(8)', true), 4600) === null && v.update(r('OtherVersion(8)'), 5000) === null, 'a read of this version ends it (the user updated the sender)');
  check(v.update(r('OtherVersion(8)'), 6000) === VERSION_TEXT && v.update(r(null), 6000 + FRESH_MS) === null && v.update(r('OtherVersion(8)'), 7300) === null, 'no report for a fresh window: the camera turned away, start again');
  v.reset();
  check(v.update(r('OtherVersion(10)'), 8000) === null && v.update(r('OtherVersion(10)'), 9000) === VERSION_TEXT, 'a newer version alike; reset forgets the run');
  // the guidance line does not say "hold steady" for it: holding steady cannot help
  check(eq(hint(read({ fresh: false, failure: 'OtherVersion(8)', receiving: false, frames: 10 })), HINTS.search), 'guidance for another version: point at the screen, never hold steady');
}

// --- "nothing happening?" ---
{
  const base = { now: 0, startedAt: 0, seenAt: -Infinity, firstSeenAt: -Infinity, progressAt: -Infinity, complete: false, lenses: 1 };
  check(idleHint({ ...base, now: 7000 }) === null, 'nothing for 7 s: no hint yet');
  const n = idleHint({ ...base, now: 8000 });
  check(n && n.title === 'Nothing yet?' && /brightness/.test(n.text) && !/lens/.test(n.text), `nothing for 8 s: "${n && n.title}" with what to check`);
  check(/another lens/.test(idleHint({ ...base, now: 8000, lenses: 3 }).text), 'with several lenses: suggests another');
  const seen = { ...base, firstSeenAt: 1000, seenAt: 11500 };
  check(idleHint({ ...seen, now: 10900 }) === null, 'seen, under 10 s without progress: no hint');
  const s = idleHint({ ...seen, now: 11500 });
  check(s && s.title === 'Seen, but not reading' && /slower speed/.test(s.text), `seen 10 s without progress: "${s && s.title}"`);
  check(idleHint({ ...seen, progressAt: 9000, now: 11500 }) === null, 'progress lately: no hint');
  check(idleHint({ ...seen, seenAt: 5000, now: 11500 }) === null, 'not seen now: the guidance line speaks, not the hint');
  check(idleHint({ ...base, now: 60000, complete: true }) === null, 'done: no hint');
}

// --- optional: real camera frames through the built receiver ---
// --- when receiving cannot go on: a receiver or decoder error twice in a row, or too little space for the file ---
{
  const e = new ErrorRun();
  check(!e.update({ receiver_error: 'storage is full' }) && e.update({ receiver_error: 'storage is full' }), 'a receiver error in two statuses in a row stops receiving');
  const w = new ErrorRun();
  check(!w.update({ error: 'unreachable' }) && !w.update({ decoded: 3, receiver_error: null }) && !w.update({ error: 'unreachable' }), 'one decoder error between good statuses never stops it');
  check(w.update({ error: 'unreachable' }), 'two decoder errors in a row stop it (a trapped decoder answers every frame with one)');
  const m = new ErrorRun();
  check(!m.update({ error: 'x' }) && m.update({ receiver_error: 'y' }), 'a decoder error then a receiver error: two in a row');
  const MB = 1048576, GB = 1024 * MB;
  check(needBytes(100 * MB, 0) === 100 * MB + SPACE.MARGIN && needBytes(100 * MB, 690 * MB) === 690 * MB + SPACE.MARGIN, 'the need: the receiver peak (at least the stream) plus the margin, as the app');
  check(spaceShort({ estimate: { quota: 10 * GB, usage: 1 * GB }, own: 0, streamSize: 100 * MB, diskPeak: 100 * MB }) === null, 'a file that fits: no stop');
  const short = spaceShort({ estimate: { quota: 2 * GB, usage: 1900 * MB }, own: 0, streamSize: 300 * MB, diskPeak: 300 * MB });
  check(short && short.free === 2 * GB - 1900 * MB && short.need === 300 * MB + SPACE.MARGIN, `a file that does not fit: stop with what is free and needed (${JSON.stringify(short)})`);
  check(spaceShort({ estimate: { quota: 2 * GB, usage: 1900 * MB }, own: 300 * MB, streamSize: 300 * MB, diskPeak: 300 * MB }) === null, "the page's own stores (already counted in usage) are reused: they count as free");
  check(spaceShort({ estimate: null, own: 0, streamSize: 300 * MB, diskPeak: 0 }) === null && spaceShort({ estimate: { quota: 0, usage: 0 }, own: 0, streamSize: 1, diskPeak: 0 }) === null, 'no estimate: no early stop (the error path still catches a full store)');
  const sp = stopMessage({ quota: 2 * GB, usage: 2 * GB - 10 * MB }, 0);
  check(sp.title === 'Not enough space on this phone' && /Free some space/.test(sp.text) && /Start camera/.test(sp.text), `storage nearly used: not enough space (${sp.title}: ${sp.text})`);
  check(stopMessage({ quota: 100 * GB, usage: 96 * GB }, 0).title === 'Not enough space on this phone', 'over 95% of the quota used: not enough space');
  const gen = stopMessage({ quota: 100 * GB, usage: 1 * GB }, 0);
  check(gen.title === 'Receiving stopped' && /Start camera to try again/.test(gen.text), `room left: receiving stopped, with a way to try again (${gen.title}: ${gen.text})`);
  check(stopMessage(null, 0).title === 'Receiving stopped', 'no estimate: receiving stopped');
  const early = stopMessage(null, 0, short);
  check(early.title === 'Not enough space on this phone' && early.text.startsWith('148 MB free, 364 MB needed for this file.'), `the early stop names what is free and needed (${early.text})`);
}

// --- finish words: shown while receiving once the receiver offers them, never after the file is complete ---
check(finishWords(null) === null && finishWords({ finish_words: null }) === null && finishWords({}) === null, 'no words offered: none shown');
check(finishWords({ finish_words: 'river candle', complete: false }) === 'river candle', 'offered words are shown as they are');
check(finishWords({ finish_words: 'river candle', complete: true }) === null, 'a complete file shows no words');
check(finishWords({ finish_words: '' }) === null && finishWords({ finish_words: 42 }) === null, 'an empty or odd value shows nothing');
check(FINISH_TEXT === 'Type these on the sender to finish faster', `the line above the words (${FINISH_TEXT})`);
// the parts the words name, in a small line under them (the core's finish_parts, from 1 as the sender says them)
check(finishParts({ finish_words: 'river candle', finish_parts: 'Parts 7, 12–15, 30' }) === 'Parts 7, 12–15, 30', 'the parts the words name are shown under them');
check(finishParts({ finish_words: null, finish_parts: 'Part 2' }) === null, 'no words: no parts line');
check(finishParts({ finish_words: 'river candle', finish_parts: 'Part 2', complete: true }) === null, 'complete: no parts line');
check(finishParts({ finish_words: 'river candle' }) === null && finishParts({ finish_words: 'river candle', finish_parts: '' }) === null && finishParts(null) === null, 'words without parts (an older core): no parts line');

if (process.env.LB_FRAMES) {
  const { readFileSync, readdirSync } = await import('node:fs');
  const pkg = new URL('../pkg/', import.meta.url);
  const m = await import(new URL('lensbolt_web.js', pkg));
  await m.default({ module_or_path: readFileSync(new URL('lensbolt_web_bg.wasm', pkg)) });
  const rx = new m.WebReceiver(), dir = process.env.LB_FRAMES;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort((a, b) => parseInt(a.slice(4)) - parseInt(b.slice(4)))) {
    const meta = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')), buf = new Uint8Array(readFileSync(`${dir}/${f.replace('.json', '.i420')}`));
    const s = JSON.parse(rx.push_i420(buf, meta.w, meta.h, Uint32Array.from(meta.layout.flatMap((p) => [p.offset, p.stride])), performance.now()));
    s.frame = [meta.w, meta.h];
    const fill = fillOf(s.corners, s.frame);
    const next = zoomStep({ z: 1, caps, corners: s.corners, frame: s.frame, found: !s.last_error, lostMs: 0, sinceChangeMs: 5000 });
    console.log(`     ${f.replace('.json', '')}: ${s.last_error || 'read'} ${s.format || ''} cell ${s.cell_px} px, codewords ${s.codewords_ok}/${s.codewords}, sharpness ${s.sharpness}, fill ${(fill * 100).toFixed(0)}% -> zoom ${next}`);
  }
}

{ // short exposure for blended captures: the camera's manual exposure tried for 3 s when reads keep blending,
  // kept when the blend falls (or the codewords rise), reverted otherwise; kept, it lets go when the tile is lost
  const CAPS = { exposureMode: ['continuous', 'manual'], exposureTime: { min: 0.86, max: 5000, step: 0.1 }, iso: { min: 100, max: 6400, step: 1 } };
  const feed = (x, { from, to, mix, share = 0.05, found = true, step = 33 }) => { const asks = []; for (let t = from; t <= to; t += step) { const a = x.update({ now: t, newData: found, found, mix, codewordsOk: Math.round(share * 111), codewords: 111 }); if (a) asks.push({ t, ...a }); } return asks; };
  check(!new ShortExposure({}).supported && !new ShortExposure({ exposureMode: ['continuous'] }).supported, 'no manual exposure (or no ISO range): no short exposure');
  const none = new ShortExposure({});
  check(feed(none, { from: 0, to: 6000, mix: 0.5 }).length === 0, 'a camera without it is never asked');
  const x = new ShortExposure(CAPS);
  check(x.settings.exposureTime === 25 && x.settings.iso === 3200, `the trial: 2.5 ms at ISO 3200 (${JSON.stringify(x.settings)})`);
  check(feed(x, { from: 0, to: 4000, mix: 0.05, share: 1 }).length === 0, 'clean reads: no trial');
  const a = feed(x, { from: 4033, to: 6000, mix: 0.5 });
  check(a.length === 1 && a[0].apply === 'short' && x.trialing && a[0].t - 4033 >= 1000 && a[0].t - 4033 <= 2000, `1.5 s of blended reads: a trial (${JSON.stringify(a)})`);
  // the trial reads better: kept, and nothing more is asked while it stays good
  const b = feed(x, { from: 6033, to: 12000, mix: 0.08, share: 0.9 });
  check(b.length === 0 && x.kept && x.active, `the blend fell under the trial: kept (${JSON.stringify(b)}, ${x.state})`);
  // kept, then the tile is lost for 2.5 s (too dark, or the phone moved away): back to automatic
  const c = feed(x, { from: 12033, to: 16000, mix: 0, found: false });
  check(c.length === 1 && c[0].apply === 'auto' && !x.active, `kept, then no tile for 2.5 s: automatic again (${JSON.stringify(c)})`);
  // a trial that reads no better: reverted, and no new trial before the back-off
  const y = new ShortExposure(CAPS);
  feed(y, { from: 0, to: 2000, mix: 0.5 });
  const d = feed(y, { from: 2033, to: 6000, mix: 0.48, share: 0.06 });
  check(d.length === 1 && d[0].apply === 'auto' && !y.active, `a trial no better: reverted (${JSON.stringify(d)})`);
  check(feed(y, { from: 6033, to: 20000, mix: 0.5 }).length === 0, 'no new trial inside the back-off');
  const e = feed(y, { from: 20033, to: 40000, mix: 0.5 });
  check(e.length >= 1 && e[0].apply === 'short', `after the back-off: another trial (${JSON.stringify(e.slice(0, 2))})`);
  // three failed trials: off for the session
  const z = new ShortExposure(CAPS);
  for (let i = 0; i < 4; i++) feed(z, { from: i * 30000, to: i * 30000 + 29967, mix: 0.5, share: 0.05 });
  check(!z.supported || z.trials === SHORT.MAX_TRIALS, `trials stop at ${SHORT.MAX_TRIALS} (${z.trials})`);
  // a camera whose range does not reach the trial settings: clamped into it
  const w = new ShortExposure({ exposureMode: ['manual'], exposureTime: { min: 40, max: 3000 }, iso: { min: 50, max: 1600 } });
  check(w.settings.exposureTime === 40 && w.settings.iso === 1600, `clamped to the camera's range (${JSON.stringify(w.settings)})`);
}

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

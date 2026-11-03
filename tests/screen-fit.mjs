// The sender's tile scale and display rate on their own (web/screen-fit.js): each tile pixel drawn as s x s device
// pixels, s chosen from devicePixelRatio so a 2 px cell is at least 1.5 CSS px (about 0.4 mm), smaller where the
// 1024-wide tile does not fit at that s; a manual 1x/2x/3x used where it fits; the Screen line; the display's
// measured drawing rate and the rate the sender then sends at. No browser, no wasm.
//
//   node web/tests/screen-fit.mjs
import { autoScale, chooseTile, screenLine, drawRate, sendRate, parseScale } from '../screen-fit.js';

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

// --- the block size from devicePixelRatio: the smallest s with 2s / dpr >= 1.5 ---
const AUTO = { 1: 1, 1.25: 1, 1.5: 2, 1.75: 2, 2: 2, 2.25: 2, 2.5: 2, 3: 3 };
for (const [d, s] of Object.entries(AUTO)) check(autoScale(+d) === s, `dpr ${d}: block ${s} (got ${autoScale(+d)})`);

// --- every device scale x screen (device px): the block, the tile, at most 1024 wide, a 2 px cell >= 1.5 CSS px
// where the tile fits at the dpr's own block. Expected values worked out by hand from the rule: at block s the
// tile is 1024 wide if the screen is >= 1024 s wide, and the tallest of 1024/896/768/640 that is <= height / s ---
const SCREENS = ['1920x1080', '2560x1440', '2880x1800', '3024x1964', '3840x2160', '5120x2880'];
const DPRS = [1, 1.25, 1.5, 2, 2.5, 3];
// [s, tileH] per screen for dpr 1 and 1.25 (block 1), dpr 1.5 / 2 / 2.5 (block 2), dpr 3 (block 3)
const WANT = {
  '1920x1080': { 1: [1, 1024], 2: [1, 1024], 3: [1, 1024] }, // 960 px at block 2: falls back to 1x
  '2560x1440': { 1: [1, 1024], 2: [2, 640], 3: [2, 640] }, // 853 px at block 3: falls back to 2x
  '2880x1800': { 1: [1, 1024], 2: [2, 896], 3: [2, 896] }, // a 15" Retina
  '3024x1964': { 1: [1, 1024], 2: [2, 896], 3: [2, 896] }, // 1008 px at block 3
  '3840x2160': { 1: [1, 1024], 2: [2, 1024], 3: [3, 640] },
  '5120x2880': { 1: [1, 1024], 2: [2, 1024], 3: [3, 896] },
};
for (const sc of SCREENS) {
  const [W, H] = sc.split('x').map(Number);
  for (const d of DPRS) {
    const c = chooseTile(d, W, H), [s, th] = WANT[sc][autoScale(d)];
    const cellCss = (2 * c.s) / d;
    const ok = c.s === s && c.w === 1024 && c.h === th && c.w <= 1024 && c.w * c.s <= W && c.h * c.s <= H
      && (c.s !== autoScale(d) || cellCss >= 1.5) && !c.manual;
    check(ok, `${sc} at dpr ${d}: tile ${c.w}x${c.h} at ${c.s}x (want 1024x${th} at ${s}x), 2 px cell ${cellCss.toFixed(2)} CSS px`);
  }
}
// the cell is at least 1.5 CSS px wherever the dpr's own block fits
for (const d of DPRS) check((2 * autoScale(d)) / d >= 1.5, `dpr ${d}: a 2 px cell at block ${autoScale(d)} is ${((2 * autoScale(d)) / d).toFixed(2)} CSS px`);

// the brief's own examples
{
  const a = chooseTile(2, 2880, 1800), b = chooseTile(2, 2560, 1664), c = chooseTile(2.5, 3840, 2160);
  check(a.s === 2 && a.w === 1024 && a.h === 896, `Retina 2880x1800 at dpr 2: 1024x896 at 2x (${a.w}x${a.h} at ${a.s}x)`);
  check(b.s === 2 && b.w === 1024 && b.h === 768, `2560x1664 at dpr 2: 1024x768 at 2x (${b.w}x${b.h} at ${b.s}x)`);
  check(c.s === 2 && c.w === 1024 && c.h === 1024, `3840x2160 at dpr 2.5: 1024x1024 at 2x (${c.w}x${c.h} at ${c.s}x)`);
}
// the Windows laptop (1920x1080 at 125%): exactly today's 1024x1024 at 1x
{
  const c = chooseTile(1.25, 1920, 1080);
  check(c.s === 1 && c.w === 1024 && c.h === 1024 && !c.manual && !c.refused, `Windows laptop 1920x1080 at 1.25: 1024x1024 at 1x (${JSON.stringify(c)})`);
  check(screenLine(1920, 1080, c) === '1920×1080, tile 1024×1024 at 1×', `its Screen line (${screenLine(1920, 1080, c)})`);
}
// too small even at 1x: no tile
{
  const c = chooseTile(1, 1000, 700);
  check(c.w === 0 && c.s === 1, `1000x700: no 1024-wide tile (${JSON.stringify(c)})`);
  check(screenLine(1000, 700, c) === '1000×700, too small for a 1024-wide tile', `its Screen line as before (${screenLine(1000, 700, c)})`);
  const d = chooseTile(1, 1280, 600);
  check(d.h === 0, `1280x600: no tile height fits (${JSON.stringify(d)})`);
}

// --- the manual scale: used where it fits, else the dpr's choice and the Screen line says so ---
{
  const m = chooseTile(1.25, 3840, 2160, 2);
  check(m.s === 2 && m.h === 1024 && m.manual && !m.refused, `manual 2x on 3840x2160 at 1.25: used (${JSON.stringify(m)})`);
  check(screenLine(3840, 2160, m) === '3840×2160, tile 1024×1024 at 2×, manual', `its Screen line (${screenLine(3840, 2160, m)})`);
  const one = chooseTile(2, 2880, 1800, 1);
  check(one.s === 1 && one.h === 1024 && one.manual, `manual 1x on a Retina: 1024x1024 at 1x (${JSON.stringify(one)})`);
  const r = chooseTile(2, 2880, 1800, 3);
  check(r.s === 2 && r.h === 896 && !r.manual && r.refused === 3, `manual 3x on 2880x1800 does not fit: Auto's 2x, refused 3 (${JSON.stringify(r)})`);
  check(screenLine(2880, 1800, r) === '2880×1800, tile 1024×896 at 2× (3× does not fit)', `its Screen line (${screenLine(2880, 1800, r)})`);
  check(screenLine(2880, 1800, chooseTile(2, 2880, 1800)) === '2880×1800, tile 1024×896 at 2×', 'the Retina Screen line');
  check(parseScale('2') === 2 && parseScale('3') === 3 && parseScale('1') === 1 && parseScale('auto') === 0 && parseScale(null) === 0 && parseScale('7') === 0, 'the remembered choice read back: 1-3, anything else Auto');
}

// --- the display's drawing rate (animation frame times over ~1 s): the lower-quartile interval, so stalls, stutters and the page's own work are not the rate ---
const times = (hz, n, t0 = 0) => Array.from({ length: n }, (_, i) => t0 + (i * 1000) / hz);
check(Math.abs(drawRate(times(60, 61)) - 60) < 0.01, `60 Hz: ${drawRate(times(60, 61)).toFixed(2)}`);
check(Math.abs(drawRate(times(48, 49)) - 48) < 0.01, `48 Hz: ${drawRate(times(48, 49)).toFixed(2)}`);
check(Math.abs(drawRate(times(120, 121)) - 120) < 0.01, `120 Hz: ${drawRate(times(120, 121)).toFixed(2)}`);
{
  // a rAF that skips every other refresh of a 60 Hz display draws at 30
  const skip = []; for (let t = 0; t <= 1000; t += 1000 / 30) skip.push(t);
  check(Math.abs(drawRate(skip) - 30) < 0.01, `every other refresh: ${drawRate(skip).toFixed(2)}`);
  // one 300 ms stall in a 60 Hz second is not a slow display
  const stall = [...times(60, 30), ...times(60, 30, 29 * 1000 / 60 + 300)];
  check(Math.abs(drawRate(stall) - 60) < 0.5, `60 Hz with one 300 ms stall: ${drawRate(stall).toFixed(2)}`);
  check(drawRate([]) === 0 && drawRate([5]) === 0, 'no frames: 0');
  // a stutter (a third of the frames late by 90 ms, a busy page) is not the display's rate: the median interval
  const st = [0]; for (let i = 0; i < 60; i++) st.push(st[st.length - 1] + (i % 3 === 2 ? 90 : 1000 / 60));
  check(Math.abs(drawRate(st) - 60) < 0.5, `60 Hz with a third of the frames 90 ms late: ${drawRate(st).toFixed(2)}`);
  // measured during the countdown on a slow machine: every other frame (the one that builds a frame) runs 50 ms
  // long; the display still refreshes every 16.7 ms (a median would say 30)
  const busy = [0]; for (let i = 0; i < 60; i++) busy.push(busy[busy.length - 1] + (i % 2 ? 50 : 1000 / 60));
  check(Math.abs(drawRate(busy) - 60) < 0.5, `60 Hz, every other frame 50 ms of work: ${drawRate(busy).toFixed(2)}`);
}

// --- the rate the sender sends at: the chosen one unless the screen draws more than 10% slower ---
{
  const a = sendRate(60, 59.9), b = sendRate(60, 55), c = sendRate(60, 48.2), d = sendRate(30, 29.8), e = sendRate(30, 24), f = sendRate(60, 0);
  check(a.fps === 60 && !a.note, `60 on a 60 Hz screen: 60 (${JSON.stringify(a)})`);
  check(b.fps === 60 && !b.note, `60 on a screen at 55 (within 10%): 60 (${JSON.stringify(b)})`);
  check(c.fps === 48 && c.note === 'This screen draws at 48 fps: sending at 48', `60 on a 48 Hz screen: 48 (${JSON.stringify(c)})`);
  check(d.fps === 30 && !d.note, `30 at 29.8: 30 (${JSON.stringify(d)})`);
  check(e.fps === 24 && e.note === 'This screen draws at 24 fps: sending at 24', `30 on a screen at 24: 24 (${JSON.stringify(e)})`);
  check(f.fps === 60 && !f.note, `not measured (a hidden tab): the chosen rate (${JSON.stringify(f)})`);
  check(sendRate(120, 120).fps === 120 && sendRate(15, 60).fps === 15, 'never faster than chosen');
}

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

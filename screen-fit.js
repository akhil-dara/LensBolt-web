// The sender's tile on a screen, apart from the page: how many device pixels each tile pixel takes (the block),
// the tile that fits, the Screen line, the display's drawing rate and the rate the sender then sends at.
// Pure, so node tests it on its own: node web/tests/screen-fit.mjs.

/** The tile is 1024 tile px wide (never wider) and one of these tall: the sizes the receivers try. */
export const TILE_W = 1024;
export const TILE_HS = [1024, 896, 768, 640];
/** A 2 px cell at least this many CSS px (about 0.4 mm at the nominal 96 CSS px per inch): on a dense screen (a
 *  Retina laptop, a 4K panel at 200-250%) a 1:1 tile is so small the phone must come nearer than it can focus. */
export const MIN_CELL_CSS = 1.5;
export const MAX_SCALE = 3;
/** The localStorage key of the Tile scale choice ("1", "2", "3"; absent for Auto). */
export const SCALE_KEY = 'lb-tile-scale';

/** The block for this devicePixelRatio: the smallest whole s with 2 s / dpr >= MIN_CELL_CSS (1 -> 1, 1.25 -> 1,
 *  1.5 -> 2, 2 -> 2, 2.5 -> 2, 3 -> 3). */
export function autoScale(dpr) {
  const s = Math.ceil((MIN_CELL_CSS * (dpr || 1)) / 2 - 1e-9);
  return Math.min(MAX_SCALE, Math.max(1, s));
}

/** The tile at block s in a space of w x h device px: [1024 or 0, the tallest height that fits or 0]. */
export function fitAt(w, h, s) {
  return [w / s >= TILE_W ? TILE_W : 0, TILE_HS.find((t) => t * s <= h) || 0];
}

/** The tile for a space of w x h device px (the screen, or the stage capped by the screen) at devicePixelRatio
 *  dpr: { s, w, h, manual, refused }. `manual` (1-3, 0 for Auto) is used when the tile fits at it; otherwise Auto
 *  decides and `refused` names the manual value. Auto takes autoScale(dpr), else the next smaller block where a
 *  1024-wide tile fits. w = 0 or h = 0: not even 1x fits. */
export function chooseTile(dpr, w, h, manual = 0) {
  if (manual) {
    const [tw, th] = fitAt(w, h, manual);
    if (tw && th) return { s: manual, w: tw, h: th, manual: true, refused: 0 };
  }
  for (let s = autoScale(dpr); s >= 1; s--) {
    const [tw, th] = fitAt(w, h, s);
    if ((tw && th) || s === 1) return { s, w: tw, h: th, manual: false, refused: manual || 0 };
  }
}

/** "2880×1800, tile 1024×896 at 2×" (", manual"; " (3× does not fit)"); a screen with no tile as before. */
export function screenLine(sw, sh, c) {
  const scr = `${Math.round(sw)}×${Math.round(sh)}`;
  if (!c.w || !c.h) return `${scr}, too small for a 1024-wide tile`;
  return `${scr}, tile ${c.w}×${c.h} at ${c.s}×${c.manual ? ', manual' : c.refused ? ` (${c.refused}× does not fit)` : ''}`;
}

/** The remembered Tile scale choice: 1, 2 or 3, else 0 (Auto). */
export function parseScale(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= MAX_SCALE ? n : 0;
}

/** Frames per second from animation frame times (ms): 1000 / the lower-quartile interval. Work on the page (a
 *  frame built in the countdown on a slow machine), a stutter or a stall only lengthens intervals, never shortens
 *  them below the display's refresh, so a median would take a busy page for a slow screen; a display or browser
 *  that really draws slower (a 30 Hz power mode, a rAF that skips every other refresh) has all its intervals long.
 *  0 with fewer than two frames. */
export function drawRate(times) {
  const dts = [];
  for (let i = 1; i < times.length; i++) if (times[i] > times[i - 1]) dts.push(times[i] - times[i - 1]);
  if (!dts.length) return 0;
  dts.sort((a, b) => a - b);
  return 1000 / dts[Math.floor((dts.length - 1) / 4)];
}

/** The rate to send at: the chosen one, unless this screen draws more than 10% slower (a 48 Hz mode, a power
 *  saving mode, a browser that skips frames); then the screen's own rate, said in the panel, so the frame numbers
 *  advance at the rate really shown and the receivers measure that. Not measured (0): the chosen rate. */
export function sendRate(chosen, measured) {
  if (!(measured > 0) || measured >= 0.9 * chosen) return { fps: chosen, note: '' };
  const n = Math.max(1, Math.round(measured));
  return { fps: n, note: `This screen draws at ${n} fps: sending at ${n}` };
}

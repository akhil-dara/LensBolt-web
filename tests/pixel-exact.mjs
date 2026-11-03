// The sender's tile reaches the screen 1:1 on physical pixels, unresampled, at every screen scaling and window
// size. For each devicePixelRatio (1 to 3) a headless Chrome of its own runs with that screen scaling
// (--force-device-scale-factor: whole device pixels per window and fractional CSS sizes, as on a scaled Windows
// display), and its window takes stage sizes odd and even in device pixels (full-screen-like and windowed). In
// each, the page sends a generated file in a 1 px and a 2 px format; the animation is frozen on a data frame (the
// page's later putImageData calls are dropped), that frame is read back from the canvas (getImageData) and
// compared byte for byte with a screenshot in device pixels (Page.captureScreenshot from the surface) at the
// device rectangle the tile's box occupies. A tile on a fractional device pixel, or drawn at another size, is
// resampled or moved and differs. Then the same while sending: the window resized (to a size where the tile
// still fits, and to one where it must be refitted shorter), and the screen scaling changed (page zoom).
// On a dense screen (devicePixelRatio 1.5 and up) each tile pixel is drawn as an s x s block of device pixels
// (web/screen-fit.js picks s): the screenshot is also compared with the frame the page drew, each of its pixels
// expanded to an s x s block, so every cell edge is a hard edge (no resampled, in-between values). Dense screens
// (a 2880x1800 Retina, a 2560x1664 Air, a 3840x2160 panel at 250%) and a move to a monitor of another scaling
// (the tile re-scaled 1x <-> 2x) are checked too.
//
//   python web/serve.py                       (in another shell; port 8765)
//   node web/tests/pixel-exact.mjs            (starts its own headless Chrome on port 9334 per scale, stops it by PID)
//   DPRS=1.25,1.5 QUICK=1 ...                 (some scales, fewer sizes)
//   PAGE=dist/lensbolt.html ...               (the single-file build)
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, inflateSync } from 'node:zlib';

import { tempProfile, ownChrome } from './chrome-profile.mjs';
const PORT = Number(process.env.CDP_PORT || 9334);
const BASE = process.env.BASE || 'http://localhost:8765';
const PAGE = process.env.PAGE || 'index.html';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const CODES = { '1px': 'sardine-berry', '2px': 'satin-swift' };
const DPRS = process.env.DPRS ? process.env.DPRS.split(',').map(Number).filter((d) => d > 0) : [1, 1.25, 1.5, 1.75, 2, 2.25, 3];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- a PNG decoder (8-bit RGB/RGBA, not interlaced: what Chrome's screenshots are), to 32-bit RGBA words ---
function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8), d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9];
      if (d[8] !== 8 || d[12] !== 0 || (ct !== 2 && ct !== 6)) throw new Error(`PNG kind not handled (depth ${d[8]}, colour ${ct}, interlace ${d[12]})`);
    } else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3, stride = w * bpp, raw = inflateSync(Buffer.concat(idat)), out = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[i] = v;
    }
    for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; out[o] = cur[x * bpp]; out[o + 1] = cur[x * bpp + 1]; out[o + 2] = cur[x * bpp + 2]; out[o + 3] = 255; }
    [prev, cur] = [cur, prev];
  }
  return { w, h, rgba: out, px: new Uint32Array(out.buffer) };
}

// differing pixels and the largest channel difference between the tile (tw x th) and the screen at (ox, oy);
// stops counting past `stop`
function compare(screen, tile, tw, th, ox, oy, stop = Infinity) {
  const t32 = new Uint32Array(tile.buffer, tile.byteOffset, tw * th);
  let diff = 0, max = 0;
  for (let y = 0; y < th && diff <= stop; y++) {
    const sy = oy + y;
    for (let x = 0; x < tw; x++) {
      const sx = ox + x, t = y * tw + x;
      if (sx < 0 || sy < 0 || sx >= screen.w || sy >= screen.h) { diff++; max = 255; continue; }
      const s = sy * screen.w + sx;
      if (screen.px[s] === t32[t]) continue;
      diff++;
      for (let k = 0; k < 3; k++) { const m = Math.abs(screen.rgba[s * 4 + k] - tile[t * 4 + k]); if (m > max) max = m; }
    }
  }
  return { diff, max };
}

// --- one Chrome per screen scaling ---
async function launch(dpr, screen = null) {
  try { await fetch(`http://127.0.0.1:${PORT}/json/version`); throw new Error(`port ${PORT} is already in use: stop that browser first`); } catch (e) { if (/in use/.test(e.message)) throw e; }
  const profile = tempProfile('lb-pixel-');
  // a 3840x2160 device-px screen (the page sizes its tile within the screen too; headless reports a tiny one)
  const chrome = ownChrome(spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--hide-scrollbars', '--force-color-profile=srgb', `--force-device-scale-factor=${dpr}`,
    `--screen-info={${screen ? `${Math.round(screen[0] * dpr)}x${Math.round(screen[1] * dpr)}` : `${Math.round(3840 * dpr)}x${Math.round(2160 * dpr)}`}}`, '--window-size=1400,1300',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank'], { stdio: 'ignore' }));
  let wsUrl;
  for (let i = 0; i < 150 && !wsUrl; i++) { try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(200); } }
  if (!wsUrl) { try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} throw new Error('Chrome did not open its debugging port'); }
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  // the browser's own first tab (a tab created later is a background tab: no animation frames)
  const { targetInfos } = await send('Target.getTargets');
  const { sessionId: S } = await send('Target.attachToTarget', { targetId: targetInfos.find((t) => t.type === 'page').targetId, flatten: true });
  await send('Page.enable', {}, S); await send('Runtime.enable', {}, S); await send('Page.bringToFront', {}, S);
  const { windowId } = await send('Browser.getWindowForTarget', {}, S);
  const evaluate = async (expr) => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, S),
      sleep(20000).then(() => { throw new Error(`no answer in 20 s: ${expr.slice(0, 80)}`); })]);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const stop = async () => {
    try { await Promise.race([send('Browser.close'), sleep(3000)]); } catch {}
    for (let i = 0; i < 20 && chrome.exitCode === null; i++) await sleep(100);
    if (chrome.exitCode === null) { try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
    try { ws.close(); } catch {}
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  };
  return { dpr, send, evaluate, S, windowId, stop };
}

const frames = (b, n) => b.evaluate(`new Promise((r) => { const raf = window.__raf || requestAnimationFrame; let k = ${n}; const f = () => (--k <= 0 ? r(true) : raf(f)); raf(f); })`);
// the page's viewport in device px (its CSS size is fractional at a fractional scale)
const viewport = async (b) => JSON.parse(await b.evaluate(`JSON.stringify([visualViewport.width * devicePixelRatio, visualViewport.height * devicePixelRatio])`)).map((v) => Math.round(v));

// the window sized so its viewport is (or is as near as the scale allows) devW x devH device px
async function setViewport(b, devW, devH) {
  let w = Math.round(devW / b.dpr) + 18, h = Math.round(devH / b.dpr) + 95, best = null;
  for (let i = 0; i < 6; i++) {
    await b.send('Browser.setWindowBounds', { windowId: b.windowId, bounds: { width: w, height: h, windowState: 'normal' } });
    await sleep(120); await frames(b, 2);
    const [vw, vh] = await viewport(b), err = Math.abs(vw - devW) + Math.abs(vh - devH);
    if (!best || err < best.err) best = { err, vw, vh, w, h };
    if (!err) break;
    w += Math.sign(devW - vw) * Math.max(1, Math.round(Math.abs(devW - vw) / b.dpr));
    h += Math.sign(devH - vh) * Math.max(1, Math.round(Math.abs(devH - vh) / b.dpr));
  }
  if (best.err) { await b.send('Browser.setWindowBounds', { windowId: b.windowId, bounds: { width: best.w, height: best.h } }); await sleep(120); await frames(b, 2); }
  return viewport(b);
}

async function startSending(b, code) {
  await b.send('Page.navigate', { url: `${BASE}/${PAGE}?testfile=0.3&lead=0` }, b.S);
  await sleep(150);
  for (let i = 0; i < 300 && (await b.evaluate(`document.getElementById('start')?.disabled === false`).catch(() => false)) !== true; i++) await sleep(100);
  // the data format straight away (no calibration carousel), the code typed (it stays once the test file is read)
  for (let i = 0; i < 20; i++) {
    await b.evaluate(`(() => { document.getElementById('calib').checked = false; const c = document.getElementById('code'); c.value = '${code}'; c.dispatchEvent(new Event('input')); return true; })()`);
    await sleep(60);
    if (await b.evaluate(`document.getElementById('code').value === '${code}' && !document.getElementById('start').disabled`)) break;
  }
  // the freeze: once set, the page's frame loop stops (no more animation frames for it; the canvas keeps the
  // frame it shows, and later draws are dropped)
  await b.evaluate(`(() => {
    window.__frozen = false; window.__puts = 0;
    const put = CanvasRenderingContext2D.prototype.putImageData, raf = window.requestAnimationFrame.bind(window);
    window.__raf = raf;
    window.requestAnimationFrame = (cb) => (window.__frozen ? 0 : raf(cb));
    // the frame as the page drew it (tile px; a copy: the page refills its ImageData before each draw)
    CanvasRenderingContext2D.prototype.putImageData = function (...a) { if (window.__frozen) return; window.__puts++; window.__last = { w: a[0].width, h: a[0].height, data: a[0].data.slice() }; return put.apply(this, a); };
    document.getElementById('start').click(); return true;
  })()`);
  for (let i = 0; i < 100 && !(await b.evaluate(`document.getElementById('stage').classList.contains('sending') && window.__puts >= 4`)); i++) await sleep(50);
}

// freeze, capture, compare: the result for one placement
const T = process.env.TIMING ? (what, t) => console.log(`  ${what} ${Date.now() - t} ms`) : () => {};
async function measure(b) {
  let t = Date.now();
  await b.evaluate(`window.__frozen = true`);
  await frames(b, 2);
  const info = await b.evaluate(`(() => {
    const st = document.getElementById('stage'), c = document.getElementById('canvas'), r = c.getBoundingClientRect();
    // the panel sits on the tile in the 'over' layout (by design, a pill that fades): out of the way here
    document.getElementById('panel').style.visibility = st.classList.contains('over') ? 'hidden' : '';
    window.__px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    return { dpr: devicePixelRatio, cw: c.width, ch: c.height, tw: window.__last.w, th: window.__last.h, screenDev: [screen.width * devicePixelRatio, screen.height * devicePixelRatio], left: r.left, top: r.top, width: r.width, height: r.height,
      stage: [st.getBoundingClientRect().width * devicePixelRatio, st.getBoundingClientRect().height * devicePixelRatio], cls: st.className,
      sending: st.classList.contains('sending') };
  })()`);
  // the frame's bytes, gzipped in the page (a few hundred KB instead of 4 MB over the debugging socket)
  const gz = await b.evaluate(`(async () => {
    const z = new Uint8Array(await new Response(new Blob([window.__px]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    let s = ''; for (let i = 0; i < z.length; i += 32768) s += String.fromCharCode.apply(null, z.subarray(i, i + 32768)); return btoa(s);
  })()`);
  const tile = new Uint8Array(gunzipSync(Buffer.from(gz, 'base64')));
  if (tile.length !== info.cw * info.ch * 4) throw new Error(`frame read back: ${tile.length} bytes`);
  const gz1 = await b.evaluate(`(async () => {
    const z = new Uint8Array(await new Response(new Blob([window.__last.data]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    let s = ''; for (let i = 0; i < z.length; i += 32768) s += String.fromCharCode.apply(null, z.subarray(i, i + 32768)); return btoa(s);
  })()`);
  const drawn = new Uint8Array(gunzipSync(Buffer.from(gz1, 'base64')));
  T('read frame', t); t = Date.now();
  await frames(b, 2);
  const shot = await b.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, b.S);
  T('screenshot', t); t = Date.now();
  const screen = decodePng(Buffer.from(shot.data, 'base64'));
  T('decode', t); t = Date.now();
  const d = info.dpr;
  // where the tile must be: its box's origin, a whole device pixel; the box its own size in device px
  const ex = Math.round(info.left * d), ey = Math.round(info.top * d);
  const at = compare(screen, tile, info.cw, info.ch, ex, ey);
  let best = { ...at, x: 0, y: 0 };
  if (at.diff) for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    if (!dx && !dy) continue;
    const c = compare(screen, tile, info.cw, info.ch, ex + dx, ey + dy, best.diff);
    if (c.diff < best.diff) best = { ...c, x: dx, y: dy };
  }
  // the frame the page drew, each tile px an s x s block: a hard edge at every cell boundary on screen
  const s = info.cw / info.tw;
  let blocks = { diff: -1, max: 0 };
  if (Number.isInteger(s) && info.ch === info.th * s && drawn.length === info.tw * info.th * 4) {
    const big = new Uint8Array(info.cw * info.ch * 4), d32 = new Uint32Array(drawn.buffer, drawn.byteOffset, info.tw * info.th), b32 = new Uint32Array(big.buffer);
    for (let y = 0; y < info.ch; y++) for (let x = 0; x < info.cw; x++) b32[y * info.cw + x] = d32[Math.floor(y / s) * info.tw + Math.floor(x / s)];
    blocks = compare(screen, big, info.cw, info.ch, ex, ey);
  }
  T('compare', t);
  return { info, s, blocks, screen: [screen.w, screen.h], at, best, exact: at.diff === 0 && blocks.diff === 0 };
}

const rows = [];
let failed = 0;
const fr = (v) => (Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : v.toFixed(3));
function report(label, r, want = {}) {
  const i = r.info, d = i.dpr;
  const where = `at ${fr(i.left * d)},${fr(i.top * d)} box ${fr(i.width * d)}x${fr(i.height * d)}`;
  const verdict = r.exact ? 'exact'
    : !r.at.diff ? `NOT EXACT: the drawn frame as ${r.s}x blocks differs in ${r.blocks.diff} px (max ${r.blocks.max})`
    : !r.best.diff ? `NOT EXACT: moved ${r.best.x},${r.best.y} dev px from its box (${r.at.diff} px differ there)`
      : `NOT EXACT: ${r.at.diff} px differ (max ${r.at.max}); nearest ${r.best.x},${r.best.y}: ${r.best.diff} (max ${r.best.max})`;
  const sizeOk = (!want.tileH || i.th === want.tileH) && (!want.s || r.s === want.s);
  const ok = r.exact && i.sending && sizeOk;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(50)} stage ${fr(i.stage[0])}x${fr(i.stage[1])} tile ${i.tw}x${i.th} at ${fr(r.s)}x ${where.padEnd(38)} ${i.sending ? '' : '(not sending) '}${sizeOk ? '' : `(tile should be 1024x${want.tileH}${want.s ? ` at ${want.s}x` : ''}) `}${verdict}`);
  if (!ok) failed++;
  rows.push({ label, ok, exact: r.exact, diff: r.at.diff, max: r.at.max });
}

// stage sizes in device px: full-screen-like (1920x1080, 2560x1440, 1366x768 screens) and windows odd and even
const FULL = [[1920, 1080], [2560, 1440], [1366, 768]];
const WINDOWS = [[1301, 1150], [1302, 1151], [1303, 1153], [1300, 1148]];
// dense screens: [dpr, screen width, height (device px), block, tile height]
const DENSE = [[2, 2880, 1800, 2, 896], [2, 2560, 1664, 2, 768], [2.5, 3840, 2160, 2, 1024], [1.25, 1920, 1080, 1, 1024]];
const sizes = process.env.QUICK ? [FULL[0], WINDOWS[0], WINDOWS[2]] : [...FULL, ...WINDOWS];

try {
  for (const d of DPRS) {
    const b = await launch(d);
    try {
      for (const [w, h] of sizes) {
        let t = Date.now();
        const [vw, vh] = await setViewport(b, w, h);
        T('viewport', t);
        for (const [k, code] of Object.entries(CODES)) {
          t = Date.now();
          await startSending(b, code);
          T('start', t);
          report(`dpr ${d} ${FULL.some(([a, c]) => a === w && c === h) ? 'full  ' : 'window'} ${vw}x${vh} dev ${k}`, await measure(b));
        }
      }
      // while sending: the window resized (the tile still fits), resized below the tile (refitted shorter), and
      // grown again (refitted taller: the end of a full-screen animation)
      for (const [from, to, tileH] of [[[1301, 1151], [1287, 1063], 1024], [[1302, 1150], [1331, 1101], 1024], [[1301, 1151], [1301, 1001], 896], [[1301, 1001], [1302, 1151], 1024]]) {
        for (const [k, code] of Object.entries(CODES)) {
          const [fw, fh] = await setViewport(b, ...from);
          await startSending(b, code);
          const [tw, th] = await setViewport(b, ...to);
          await sleep(200); await frames(b, 4);
          report(`dpr ${d} resize ${fw}x${fh} -> ${tw}x${th} dev ${k}`, await measure(b), { tileH });
        }
      }
    } finally { await b.stop(); }
  }
  // dense screens, full screen: the tile drawn in s x s blocks (the screen in device px; the stage the whole screen)
  for (const [d, sw, sh, s, tileH] of (process.env.DENSE === '0' ? [] : DENSE)) {
    const b = await launch(d, [sw, sh]);
    try {
      const [vw, vh] = await setViewport(b, sw, sh);
      for (const [k, code] of Object.entries(CODES)) {
        await startSending(b, code);
        const r = await measure(b);
        report(`dense dpr ${d} screen ${fr(r.info.screenDev[0])}x${fr(r.info.screenDev[1])} (${vw}x${vh}) ${k}`, r, { s, tileH });
      }
    } finally { await b.stop(); }
  }
  // while sending, the window moves to a monitor of another scaling (emulated, as for page zoom below): the tile is
  // placed again and re-scaled, 1x on the first, 2x on the second (a stage of 2400x2100 device px: 1024x1024 at
  // either; offsets whole CSS px at both scales)
  for (const [d0, d1, s1] of [[1, 2, 2], [2, 1, 1]]) {
    const b = await launch(d0);
    try {
      for (const [k, code] of Object.entries(CODES)) {
        await b.send('Emulation.clearDeviceMetricsOverride', {}, b.S);
        const [vw, vh] = await setViewport(b, 2400, 2100);
        await startSending(b, code);
        const s0 = await b.evaluate(`document.getElementById('canvas').width / window.__last.w`);
        await b.send('Emulation.setDeviceMetricsOverride', { width: Math.round(vw / d1), height: Math.round(vh / d1), deviceScaleFactor: d1, mobile: false, screenWidth: Math.round(3840 / d1), screenHeight: Math.round(2160 / d1) }, b.S);
        await sleep(300); await frames(b, 4);
        report(`monitor ${d0} -> ${d1} (${vw}x${vh} dev, ${s0}x before) ${k}`, await measure(b), { s: s1, tileH: 1024 });
      }
    } finally { await b.stop(); }
  }
  // while sending: the screen scaling changes (page zoom or a moved window), the window the same in device px.
  // Emulated: an emulated scale lays out and snaps in CSS px, so it can only be exact where the tile's size and
  // offset are whole CSS px at both scales (scales 1 and 2, a stage of 1600x1200 device px: offset 288,88)
  for (const [d0, d1] of [[1, 2], [2, 1]]) {
    const b = await launch(d0);
    try {
      for (const [k, code] of Object.entries(CODES)) {
        await b.send('Emulation.clearDeviceMetricsOverride', {}, b.S);
        const [vw, vh] = await setViewport(b, 1600, 1200);
        await startSending(b, code);
        await b.send('Emulation.setDeviceMetricsOverride', { width: Math.round(vw / d1), height: Math.round(vh / d1), deviceScaleFactor: d1, mobile: false, screenWidth: Math.round(3840 / d1), screenHeight: Math.round(2160 / d1) }, b.S);
        await sleep(300); await frames(b, 4);
        report(`zoom ${d0} -> ${d1} (${vw}x${vh} dev) ${k}`, await measure(b));
      }
    } finally { await b.stop(); }
  }
} catch (e) {
  console.log('FAIL', e.stack || e); failed++;
}
console.log(`${rows.filter((r) => r.exact).length} of ${rows.length} placements exact`);
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

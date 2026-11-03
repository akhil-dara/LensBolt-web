// The receiver page's reader workers in a real browser, measured: a fake camera playing real LensBolt frames (a
// generated .y4m: the 1024x1024 3 px black/white tile drawn 1:1 into 1920x1080 frames, 60 different frames of a
// 16 MB send, looped) at 30 and 60 fps, read by the single decode worker (?readers=0), by one reader and by the
// device's readers (?readers=R). Prints frames read per second, the camera's measured rate and the frames dropped
// while every reader was busy; checks that the pool reads at least as many frames as the single worker and that the
// readers keep up better than one. Each configuration in a headless Chrome of its own on PORT (default 9361),
// stopped by its PID.
//
//   python web/serve.py 8781 127.0.0.1      (in another shell)
//   BASE=http://127.0.0.1:8781 node web/tests/receiver-pool.mjs [seconds per run, default 15]
//   PAGE=dist/lensbolt-receive.html ...     the single-file receiver
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, openSync, writeSync, closeSync, readFileSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import init, { WebSender } from '../pkg/lensbolt_web.js';

import { tempProfile, ownChrome } from './chrome-profile.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 9361);
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.BASE || 'http://localhost:8765';
const SECONDS = Number(process.argv[2] || 15);
// PAGE=dist/lensbolt-receive.html: the single-file receiver (its workers made from one inlined Blob)
const PAGE = process.env.PAGE || 'receive.html';
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the camera's frames: a 16 MB send's first 60 frames (manifests among them), I420, the tile centred 1:1
await init({ module_or_path: readFileSync(join(HERE, '..', 'pkg', 'lensbolt_web_bg.wasm')) });
const W = 1920, H = 1080, T = 1024, FRAMES = 60;
const data = new Uint8Array(16e6);
for (let i = 0, x = 0x9e3779b9; i < data.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; data[i] = x & 255; }
const sender = new WebSender('pool-test.bin', data, T, T, '', false);
const ys = [];
for (let f = 0; f < FRAMES; f++) {
  const rgba = sender.next_frame_rgba(), y = Buffer.alloc(W * H, 255);
  const x0 = (W - T) >> 1, y0 = (H - T) >> 1;
  for (let r = 0; r < T; r++) for (let c = 0; c < T; c++) {
    const p = (r * T + c) * 4;
    y[(y0 + r) * W + x0 + c] = (77 * rgba[p] + 150 * rgba[p + 1] + 29 * rgba[p + 2]) >> 8;
  }
  ys.push(y);
}
function y4m(fps) {
  const path = join(tmpdir(), `lb-pool-${fps}.y4m`), fd = openSync(path, 'w');
  writeSync(fd, `YUV4MPEG2 W${W} H${H} F${fps}:1 Ip A1:1 C420jpeg\n`);
  const uv = Buffer.alloc((W / 2) * (H / 2) * 2, 128);
  for (const y of ys) { writeSync(fd, 'FRAME\n'); writeSync(fd, y); writeSync(fd, uv); }
  closeSync(fd);
  return path;
}

async function cdp(port) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pend = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
  return { send, evaluate };
}
const DETAILS = `JSON.stringify({ frames: document.getElementById('d-frames').textContent, decode: document.getElementById('d-decode').textContent, cam: document.getElementById('d-camera').textContent, t: performance.now() })`;
const parse = (d) => {
  const [dec, fr] = (d.frames.match(/(\d+) decoded of (\d+)/) || [0, 0, 0]).slice(1).map(Number);
  const drop = d.decode.match(/(\d+) of (\d+) dropped/);
  const fps = d.cam.match(/([\d.]+) fps measured/);
  return { dec, fr, dropped: drop ? +drop[1] : null, offered: drop ? +drop[2] : null, camFps: fps ? +fps[1] : 0, readers: (d.decode.match(/(\d+) readers?/) || [0, 0])[1] | 0, ms: d.decode, t: d.t };
};

// the page asks the camera for 30 fps; for the 60 fps runs every request asks for the file's rate instead
const atRate = (fps) => `(() => { const md = navigator.mediaDevices, gum = md.getUserMedia.bind(md), T = MediaStreamTrack.prototype, ac = T.applyConstraints;
  const fix = (v) => (v && typeof v === 'object' ? { ...v, frameRate: { ideal: ${fps} } } : v);
  md.getUserMedia = (c) => gum({ ...c, video: fix(c.video) });
  T.applyConstraints = function (c) { return ac.call(this, c && (c.width || c.height || c.frameRate) ? fix(c) : c); }; })();`;

async function measure(file, readers, fps) {
  const profile = tempProfile('lb-pool-');
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); await sleep(200); } catch { break; } }
  const chrome = ownChrome(spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${file}`, 'about:blank'], { stdio: 'ignore' }));
  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); up = true; } catch { await sleep(200); } }
    if (!up) throw new Error('Chrome did not open its debugging port');
    const p = await cdp(PORT);
    await p.send('Page.enable');
    await p.send('Page.addScriptToEvaluateOnNewDocument', { source: atRate(fps) });
    await p.send('Page.navigate', { url: `${BASE}/${PAGE}?memory&readers=${readers}` });
    for (let i = 0; i < 100 && (await p.evaluate(`document.readyState === 'complete' && !!document.getElementById('go')`)) !== true; i++) await sleep(100);
    await sleep(500);
    await p.evaluate(`document.getElementById('go').click(), true`);
    // warm: the worker (and the readers) started and frames read for 3 s
    for (let i = 0; i < 150 && !(parse(JSON.parse(await p.evaluate(DETAILS))).fr > 0); i++) await sleep(100);
    await sleep(3000);
    const a = parse(JSON.parse(await p.evaluate(DETAILS)));
    await sleep(SECONDS * 1000);
    const b = parse(JSON.parse(await p.evaluate(DETAILS)));
    const s = (b.t - a.t) / 1000;
    return { readers: b.readers, read: (b.fr - a.fr) / s, decoded: (b.dec - a.dec) / s, camFps: b.camFps,
      drop: b.offered != null && a.offered != null && b.offered > a.offered ? (b.dropped - a.dropped) / (b.offered - a.offered) : null, decode: b.ms };
  } finally {
    try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

const R = Math.max(1, Math.min(4, cpus().length - 2));
const rows = [];
for (const fps of [30, 60]) {
  const file = y4m(fps);
  try {
    for (const n of [0, 1, R]) {
      const m = await measure(file, n, fps);
      rows.push({ fps, n, ...m });
      console.log(`     ${fps} fps camera (measured ${m.camFps.toFixed(1)}), ${n ? `${n} reader${n > 1 ? 's' : ''}` : 'single worker'}: ${m.read.toFixed(1)} frames read/s, ${m.decoded.toFixed(1)} decoded/s` +
        (m.drop != null ? `, ${(m.drop * 100).toFixed(0)}% dropped (readers busy)` : '') + ` · ${m.decode}`);
    }
  } finally { try { rmSync(file, { force: true }); } catch {} }
}
for (const fps of [30, 60]) {
  const [one, single, many] = [1, 0, R].map((n) => rows.find((r) => r.fps === fps && r.n === n));
  check(many.readers === R && many.decoded > 0, `${fps} fps: ${R} readers in use, reading the tile (${many.decoded.toFixed(1)} decoded/s)`);
  check(many.read >= single.read * 0.95, `${fps} fps: ${R} readers read at least as many frames as the single worker (${many.read.toFixed(1)} vs ${single.read.toFixed(1)} per s)`);
  if (R > 1) check(many.read > one.read * 1.3 || many.read >= 0.9 * many.camFps, `${fps} fps: ${R} readers read more than one reader, or keep up with the camera (${many.read.toFixed(1)} vs ${one.read.toFixed(1)} per s; camera ${many.camFps.toFixed(1)})`);
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

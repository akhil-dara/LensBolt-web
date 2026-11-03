// End-to-end window-share test: the sender page in one Chrome window, the receiver page in another reading it
// through screen capture (getDisplayMedia, the window picked automatically by title), the whole decode in the
// receiver's WebAssembly worker. Prints the receiver's progress and the final result; with SNAP=path saves
// the first shared frame the receiver sees as a PNG.
//
//   python -m http.server 8765 --bind 127.0.0.1 --directory web     (in another shell)
//   node web/tests/window-share.mjs [MB] [timeout_s]
//   FILES=200 ...       a batch of 200 generated files instead of one file (the receiver's batch Done screen)
//   HEADLESS=1 ...      no windows on screen: a headless Chrome, the sender's tab shared instead of its window
//   CDP_PORT=9336 ...   the debugging port (default 9333); the browser is stopped by its own PID
//   READERS=N ...       the receiver with N reader workers (?readers=N; 0: the single decode worker); default: the device's
//   DPR=2 SCREEN=2880x1800 HEADLESS=1 ...   the sender at device scale 2 on a 2880x1800 (device px) screen: its tile
//                       drawn in 2x blocks (web/screen-fit.js), read by the receiver through tab capture
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tempProfile, ownChrome } from './chrome-profile.mjs';
const MB = Number(process.argv[2] || 2), TIMEOUT_S = Number(process.argv[3] || 240);
const BASE = process.env.BASE || 'http://localhost:8765';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = Number(process.env.CDP_PORT || 9333), FILES = Number(process.env.FILES || 0), HEADLESS = !!process.env.HEADLESS;
const DPR = Number(process.env.DPR || 1), [SW, SH] = (process.env.SCREEN || '1920x1080').split('x').map(Number);
const profile = tempProfile('lb-chrome-');
const chrome = ownChrome(spawn(CHROME, [
  ...(HEADLESS ? ['--headless=new', '--auto-select-tab-capture-source-by-title=LensBolt Sender', '--window-size=1400,1100', `--screen-info={${SW * DPR}x${SH * DPR}}`, `--force-device-scale-factor=${DPR}`] : ['--auto-select-desktop-capture-source=LensBolt Sender']),
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', `--force-device-scale-factor=${DPR}`, 'about:blank',
], { stdio: 'ignore' }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function browserWs() {
  for (let i = 0; i < 50; i++) {
    try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(200); }
  }
  throw new Error('Chrome did not open its debugging port');
}

const ws = new WebSocket(await browserWs());
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let nextId = 1;
const pending = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});
async function openWindow(url, left, width, height) {
  const { targetId } = await send('Target.createTarget', { url, newWindow: true, left, top: 0, width, height });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  return sessionId;
}
const evaluate = async (s, expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, s)).result.value;

try {
  // the sender's window is big enough to show its 1024 tile 1:1
  // the sender's window stays on screen (a window larger than the screen is captured scaled down)
  const sender = await openWindow(`${BASE}/index.html?${FILES > 1 ? `testfiles=${FILES}` : `testfile=${MB}`}&lead=0`, 0, 1180, 820);
  for (let i = 0; i < 100 && !(await evaluate(sender, `!document.getElementById('start').disabled`)); i++) await sleep(200);
  // the data format straight away (no opening calibration carousel); CAL=1 keeps the carousel
  if (!process.env.CAL) await evaluate(sender, `(() => { const c = document.getElementById('calib'); if (c) c.checked = false; return true; })()`);
  // CODE=<two words> picks the format (e.g. sardine-berry: 1 px black/white at 30 fps)
  if (process.env.CODE) await evaluate(sender, `(() => { const c = document.getElementById('code'); c.value = ${JSON.stringify(process.env.CODE || '')}; c.dispatchEvent(new Event('input')); return true; })()`);
  await evaluate(sender, `document.getElementById('start').click(), true`);
  await sleep(1000);
  console.log('sender:', await evaluate(sender, `JSON.stringify({ title: document.title, stage: document.getElementById('stage').className, canvas: document.getElementById('canvas').width + 'x' + document.getElementById('canvas').height, inner: innerWidth + 'x' + innerHeight, dpr: devicePixelRatio })`));

  const receiver = await openWindow(`${BASE}/receive.html${process.env.READERS ? `?readers=${process.env.READERS}` : ''}`, 1200, 700, 1000);
  // the choices are drawn before the page's script runs: wait until its clicks are wired
  for (let i = 0; i < 50 && !(await evaluate(receiver, `document.documentElement.dataset.ready === 'start' && !document.getElementById('screen').disabled`)); i++) await sleep(200);
  // a real click (getDisplayMedia needs user activation)
  const r = await evaluate(receiver, `(() => { const b = document.getElementById('screen').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 }, receiver);
  await sleep(2500);
  if (process.env.SNAP) {
    const url = await evaluate(receiver, `(() => { const v = document.getElementById('video'); const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0); return c.toDataURL('image/png'); })()`);
    writeFileSync(process.env.SNAP, Buffer.from(url.split(',')[1], 'base64'));
    console.log('saved', process.env.SNAP);
  }

  const t0 = Date.now();
  let last = '';
  while ((Date.now() - t0) / 1000 < TIMEOUT_S) {
    await sleep(2000);
    const s = await evaluate(receiver, `JSON.stringify({ guide: document.getElementById('guide').textContent, name: document.getElementById('fname').textContent,
      got: document.getElementById('got').textContent, rate: document.getElementById('rate').textContent, left: document.getElementById('x').textContent,
      frames: document.getElementById('d-frames').textContent, decode: document.getElementById('d-decode').textContent, format: document.getElementById('d-format').textContent,
      source: document.getElementById('d-camera').textContent, miss: document.getElementById('d-error').textContent, problem: document.getElementById('problem').hidden ? '' : document.getElementById('problem').textContent,
      done: document.getElementById('done').hidden ? '' : document.getElementById('done-meta').textContent + ' · ' + document.getElementById('verified-text').textContent,
      batch: document.getElementById('batch').hidden ? '' : document.getElementById('batch-sum').textContent })`);
    if (s !== last) { console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s ${s}`); last = s; }
    const v = JSON.parse(s);
    if (v.done || v.problem) break;
  }
} finally {
  try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { chrome.kill(); }
  ws.close();
}

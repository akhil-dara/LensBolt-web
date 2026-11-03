// On a dense screen with no margin for the panel (2880x1800 at dpr 2: the 2x tile leaves no side or top margin,
// the panel is the pill on the tile's centre) the phone reads the held manifest during the countdown: the pill
// fades early in the countdown too. The screen is captured (Page.captureScreenshot, device px) every 250 ms while
// counting, and each capture is decoded with the page's own WebReceiver; one of them must give the manifest (the
// file name) before sending starts. Also: the file name stays in the page for screen readers in that layout, and
// Space on the hidden Stop button wakes the pill instead of stopping.
//
//   python web/serve.py                       (in another shell; port 8765)
//   node web/tests/countdown-manifest.mjs     (its own headless Chrome on CDP_PORT, default 9337, stopped by PID)
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tempProfile, ownChrome } from './chrome-profile.mjs';
const PORT = Number(process.env.CDP_PORT || 9337);
const BASE = process.env.BASE || 'http://localhost:8765';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const LEAD = 3, DPR = 2, W = 2880, H = 1800;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

const profile = tempProfile('lb-cdm-');
// headless takes the screen in device px x dpr; the window's chrome is 18 x 95 CSS px
const chrome = ownChrome(spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  `--force-device-scale-factor=${DPR}`, `--screen-info={${W * DPR}x${H * DPR}}`, `--window-size=${W / DPR + 18},${H / DPR + 95}`, '--force-color-profile=srgb', '--hide-scrollbars',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' }));
try {
  let ver = null;
  for (let i = 0; i < 150 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(200); } }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pend = new Map(), errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pend.set(i, (m) => res(m.result)); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const { targetInfos } = await send('Target.getTargets');
  const { sessionId: S } = await send('Target.attachToTarget', { targetId: targetInfos.find((t) => t.type === 'page').targetId, flatten: true });
  await send('Page.enable', {}, S); await send('Runtime.enable', {}, S); await send('Page.bringToFront', {}, S);
  const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, S))?.result?.value;

  await send('Page.navigate', { url: `${BASE}/index.html?testfile=0.3&lead=${LEAD}` }, S);
  for (let i = 0; i < 150 && (await evaluate(`document.getElementById('start')?.disabled === false`)) !== true; i++) await sleep(100);
  await evaluate(`document.getElementById('start').click(), true`);
  const t0 = Date.now(), shots = [];
  for (;;) {
    const st = JSON.parse(await evaluate(`JSON.stringify({ cls: document.getElementById('stage').className, op: getComputedStyle(document.getElementById('panel')).opacity })`));
    if (/sending/.test(st.cls) || Date.now() - t0 > (LEAD + 4) * 1000) break;
    if (/counting/.test(st.cls)) {
      const shot = await send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, S);
      shots.push({ t: Date.now() - t0, cls: st.cls, op: st.op, png: shot.data });
    }
    await sleep(250);
  }
  const layout = (shots.find((s) => /\bover\b/.test(s.cls)) || shots[shots.length - 1] || { cls: '' }).cls;
  check(/\bover\b/.test(layout), `the 2x tile on ${W}x${H} at dpr ${DPR} leaves the panel no margin: the pill on the tile (${layout})`);
  // each capture through the page's own receiver (fresh for each, so one capture alone must give the manifest)
  const read = [];
  for (const s of shots) {
    const r = JSON.parse(await evaluate(`(async () => {
      const m = await import('./pkg/lensbolt_web.js');
      const b = await (await fetch('data:image/png;base64,${s.png}')).blob(), bmp = await createImageBitmap(b);
      const c = new OffscreenCanvas(bmp.width, bmp.height), x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(bmp, 0, 0);
      const rx = new m.WebReceiver(), st = JSON.parse(rx.push(x.getImageData(0, 0, c.width, c.height).data, c.width, c.height, 0));
      return JSON.stringify({ name: st.filename, manifest: st.have_manifest, err: st.last_error, size: c.width + 'x' + c.height });
    })()`));
    read.push(`${(s.t / 1000).toFixed(2)} s pill ${s.op}: ${r.manifest ? r.name : r.err}`);
    s.ok = !!r.manifest && r.name === 'test-0.3MB.bin';
  }
  // a clean capture reads the manifest even under the pill (error correction); a phone's blurred, tilted view
  // has no such margin, so the pill must be gone for part of the countdown, the manifest read in that capture
  check(shots.some((s) => s.ok && s.op === '0'), `the pill fades during the ${LEAD} s countdown and a capture then gives the manifest (${read.join('; ')})`);
  // sending now: the name for screen readers, and Space on the hidden Stop wakes the pill instead of stopping
  for (let i = 0; i < 40 && !(await evaluate(`document.getElementById('stage').classList.contains('quiet')`)); i++) await sleep(250);
  const sr = JSON.parse(await evaluate(`JSON.stringify({ name: document.getElementById('p-file').textContent, shown: getComputedStyle(document.getElementById('p-file')).display, focus: document.activeElement.id, quiet: document.getElementById('stage').classList.contains('quiet') })`));
  check(sr.name.startsWith('test-0.3MB.bin') && sr.shown !== 'none', `the file name stays readable by screen readers in the pill layout ("${sr.name}", display ${sr.shown})`);
  for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: type === 'keyDown' ? ' ' : undefined }, S);
  await sleep(400);
  const after = JSON.parse(await evaluate(`JSON.stringify({ cls: document.getElementById('stage').className, op: getComputedStyle(document.getElementById('panel')).opacity })`));
  check(sr.quiet && sr.focus === 'stop' && /sending/.test(after.cls) && after.op === '1', `Space on the hidden Stop wakes the pill and keeps sending (focus ${sr.focus}; ${after.cls}; opacity ${after.op})`);
  for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: type === 'keyDown' ? ' ' : undefined }, S);
  await sleep(400);
  const stopped = await evaluate(`document.getElementById('stage').classList.contains('on')`);
  check(stopped === false, `Space on the visible Stop stops (stage on=${stopped})`);
  check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  ws.close();
} finally {
  try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

// The sender measures its own display's drawing rate over the countdown's first second (the lower-quartile interval of
// its animation frames) and shows it in Advanced; a screen that draws more than 10% slower than the chosen rate is
// sent to at its own rate, said on the sending screen ("This screen draws at 30 fps: sending at 30"), so the frame
// numbers advance at the rate really shown.
// A 30 Hz display is simulated by delaying every animation frame by one (the page's callbacks run every other
// refresh of headless Chrome's 60 Hz); the frames the page then draws are counted for 2 s.
//
//   python web/serve.py                       (in another shell; port 8765)
//   node web/tests/sender-rate.mjs            (its own headless Chrome on CDP_PORT, default 9336, stopped by PID)
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tempProfile, ownChrome } from './chrome-profile.mjs';
const PORT = Number(process.env.CDP_PORT || 9336);
const BASE = process.env.BASE || 'http://localhost:8765';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

const profile = tempProfile('lb-rate-');
const chrome = ownChrome(spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--force-device-scale-factor=1', '--screen-info={1920x1200}', '--window-size=1400,1250', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' }));
try {
  let ver = null;
  for (let i = 0; i < 100 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(200); } }
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
  await send('Page.enable', {}, S); await send('Runtime.enable', {}, S);
  const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, S))?.result?.value;

  let script = null;
  for (const [hz, fps] of [[60, 60], [30, 60], [30, 30]]) {
    if (script) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: script }, S);
    // the page's animation frames, and every frame it draws counted with its time
    script = (await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const raf = window.requestAnimationFrame.bind(window);
      ${hz === 30 ? 'window.requestAnimationFrame = (cb) => raf(() => raf((t) => cb(t)));' : ''}
      window.__puts = [];
      const put = CanvasRenderingContext2D.prototype.putImageData;
      CanvasRenderingContext2D.prototype.putImageData = function (...a) { window.__puts.push(performance.now()); return put.apply(this, a); };
    })()` }, S)).identifier;
    await send('Page.navigate', { url: `${BASE}/index.html?testfile=0.3&lead=1` }, S);
    for (let i = 0; i < 100 && (await evaluate(`document.getElementById('start')?.disabled === false`)) !== true; i++) await sleep(100);
    await evaluate(`(() => { const s = document.getElementById('fps'); s.value = '${fps}'; s.dispatchEvent(new Event('change')); document.getElementById('start').click(); return true; })()`);
    for (let i = 0; i < 100 && !(await evaluate(`document.getElementById('stage').classList.contains('sending')`)); i++) await sleep(100);
    await sleep(500);
    const r = JSON.parse(await evaluate(`new Promise((res) => { const n0 = window.__puts.length, t0 = performance.now(); setTimeout(() => res(JSON.stringify({
      rate: (window.__puts.length - n0) * 1000 / (performance.now() - t0), note: document.getElementById('p-rate')?.textContent || '', noteShown: document.getElementById('p-rate') ? !document.getElementById('p-rate').hidden : false,
      draws: document.getElementById('draws')?.textContent || '', hud: document.getElementById('hud-fps').textContent })), 2000); })`));
    const label = `a ${hz} Hz display, ${fps} fps chosen`;
    if (hz < 0.9 * fps) {
      check(r.noteShown && r.note === `This screen draws at ${hz} fps: sending at ${hz}`, `${label}: the sending screen says "${r.note}"`);
      check(Math.abs(r.rate - hz) <= 0.15 * hz, `${label}: frames drawn at ${r.rate.toFixed(1)}/s (HUD ${r.hud} fps)`);
    } else {
      check(!r.noteShown, `${label}: no note (${r.note || 'none'})`);
      // 60 frames a second is the machine's work (a frame built per period), not this rule's: shown, not asserted
      if (fps >= 60) console.log(`     ${label}: frames drawn at ${r.rate.toFixed(1)}/s (HUD ${r.hud} fps)`);
      else check(Math.abs(r.rate - fps) <= 0.15 * fps, `${label}: frames drawn at ${r.rate.toFixed(1)}/s (HUD ${r.hud} fps)`);
    }
    check(new RegExp(`^${hz === 60 ? '(5[5-9]|6[0-5])' : '(2[7-9]|3[0-3])'} fps$`).test(r.draws), `${label}: Advanced shows the screen's rate (${r.draws})`);
    await evaluate(`document.getElementById('stop').click(), true`);
  }
  check(errors.length === 0, `no page errors (${errors.join(' | ')})`);
  ws.close();
} finally {
  try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

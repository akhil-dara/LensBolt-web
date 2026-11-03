// The single-file pages from file://, offline: web/dist/lensbolt.html sends a generated test file (the tile drawn
// in 2x blocks on a dense screen, 1x on a 125% one) and web/dist/lensbolt-receive.html loads and its inlined
// decode worker answers; neither page asks the network for anything (only file:, data: and blob: URLs) and
// neither throws (the sender's optional web font aside: offline it falls back to the system font). Each in a headless Chrome of its own (forced device scale), stopped by its PID.
//
//   python web/build.py                       (first: the pages under test)
//   node web/tests/dist-smoke.mjs             (CDP_PORT, default 9335)
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { tempProfile, ownChrome } from './chrome-profile.mjs';
const PORT = Number(process.env.CDP_PORT || 9335);
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

// a Chrome at device scale dpr on a screen of w x h device px (headless takes the screen size in device px x dpr)
async function browser(dpr, w, h) {
  const profile = tempProfile('lb-dist-');
  const chrome = ownChrome(spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    `--force-device-scale-factor=${dpr}`, `--screen-info={${Math.round(w * dpr)}x${Math.round(h * dpr)}}`, `--window-size=${Math.round(w / dpr) + 18},${Math.round(h / dpr) + 95}`,
    '--allow-file-access-from-files', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' }));
  let ver = null;
  for (let i = 0; i < 100 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(200); } }
  if (!ver) throw new Error('Chrome did not open its debugging port');
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pend = new Map(), errors = [], urls = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Network.requestWillBeSent') urls.push(m.params.request.url);
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pend.set(i, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const { targetInfos } = await send('Target.getTargets');
  const { sessionId: S } = await send('Target.attachToTarget', { targetId: targetInfos.find((t) => t.type === 'page').targetId, flatten: true });
  for (const m of ['Page.enable', 'Runtime.enable', 'Network.enable']) await send(m, {}, S);
  const evaluate = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, S); return r.result?.value; };
  const stop = async () => {
    try { await Promise.race([send('Browser.close'), sleep(3000)]); } catch {}
    for (let i = 0; i < 20 && chrome.exitCode === null; i++) await sleep(100);
    if (chrome.exitCode === null) { try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
    try { ws.close(); } catch {}
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  };
  return { send, evaluate, S, errors, urls, stop };
}
// the sender's stylesheet names the Inter web font (it was there before; offline the page falls back to the system
// font): that is the one request allowed
const offline = (urls) => urls.filter((u) => !/^(file|data|blob):/.test(u) && !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u));

// the sender: a test send on a Retina-like screen (2x blocks) and on the Windows laptop (1x)
for (const [dpr, w, h, s, th] of [[2, 2880, 1800, 2, 896], [1.25, 1920, 1080, 1, 1024]]) {
  const b = await browser(dpr, w, h);
  try {
    await b.send('Page.navigate', { url: `${pathToFileURL(join(DIST, 'lensbolt.html')).href}?testfile=0.3&lead=0` }, b.S);
    let ready = false;
    for (let i = 0; i < 150 && !ready; i++) { await sleep(100); ready = (await b.evaluate(`document.getElementById('start')?.disabled === false`)) === true; }
    check(ready, `dpr ${dpr}: the single-file sender loads its module and reads the test file from file://`);
    await b.evaluate(`document.getElementById('start').click(), true`);
    let st = null;
    for (let i = 0; i < 100; i++) {
      await sleep(100);
      st = JSON.parse(await b.evaluate(`JSON.stringify({ cls: document.getElementById('stage').className, cw: document.getElementById('canvas').width, ch: document.getElementById('canvas').height, screen: document.getElementById('screen').textContent, draws: document.getElementById('draws')?.textContent || '', n: +document.getElementById('hud-n').textContent, status: document.getElementById('status').textContent })`));
      if (/sending/.test(st.cls) && st.n >= 10) break;
    }
    check(/sending/.test(st.cls) && st.n >= 10, `dpr ${dpr}: it sends (${st.n} frames shown; ${st.status || st.cls})`);
    check(st.cw === 1024 * s && st.ch === th * s, `dpr ${dpr} on ${w}x${h}: the tile 1024x${th} at ${s}x, canvas ${st.cw}x${st.ch}`);
    // the display's rate: measured at load and over the first second of sending (no countdown here)
    for (let i = 0; i < 30 && !/^\d+ fps$/.test(st.draws); i++) { await sleep(100); st.draws = await b.evaluate(`document.getElementById('draws')?.textContent || ''`); }
    check(st.screen.startsWith(`${w}×${h}, tile 1024×${th} at ${s}×`) && /^\d+ fps$/.test(st.draws), `dpr ${dpr}: Screen ${st.screen}; draws at ${st.draws}`);
    check(offline(b.urls).length === 0, `dpr ${dpr}: no network requests (${offline(b.urls).slice(0, 3).join(', ')})`);
    if (dpr === 2) {
      // a 2x tile on a Retina full screen leaves no margin for the panel: it is the pill on the tile, which fades
      // 2.5 s after sending starts although Stop has the focus (a pill that stayed hid the tile's centre: the
      // receiver read no manifest); a key pressed brings it back for a moment
      await sleep(3500);
      const pill = JSON.parse(await b.evaluate(`JSON.stringify({ cls: document.getElementById('stage').className, op: getComputedStyle(document.getElementById('panel')).opacity, focus: document.activeElement && document.activeElement.id })`));
      check(/\bover\b/.test(pill.cls) && pill.op === '0', `the pill on the tile fades while Stop has the focus (${pill.cls}; opacity ${pill.op}; focus on ${pill.focus})`);
      await b.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, b.S);
      await b.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 }, b.S);
      await sleep(500);
      const woke = await b.evaluate(`getComputedStyle(document.getElementById('panel')).opacity`);
      check(woke === '1', `a key brings the pill back (opacity ${woke})`);
      // the Tile scale override: 1x by hand (it fits), remembered in this browser across a reload; 3x does not fit
      const pick = async (v) => { await b.evaluate(`(() => { document.getElementById('stop').click(); const t = document.getElementById('tscale'); t.value = '${v}'; t.dispatchEvent(new Event('change')); return true; })()`); return b.evaluate(`document.getElementById('screen').textContent`); };
      const one = await pick('1');
      await b.send('Page.reload', {}, b.S);
      let back = null;
      for (let i = 0; i < 150; i++) { await sleep(100); if ((await b.evaluate(`document.getElementById('start')?.disabled === false`)) === true) break; }
      back = JSON.parse(await b.evaluate(`JSON.stringify({ v: document.getElementById('tscale').value, screen: document.getElementById('screen').textContent })`));
      await b.evaluate(`document.getElementById('start').click(), true`);
      let cw = 0;
      for (let i = 0; i < 100; i++) { await sleep(100); const r = JSON.parse(await b.evaluate(`JSON.stringify({ s: document.getElementById('stage').classList.contains('sending'), cw: document.getElementById('canvas').width, ch: document.getElementById('canvas').height })`)); if (r.s) { cw = `${r.cw}x${r.ch}`; break; } }
      check(one === `${w}×${h}, tile 1024×1024 at 1×, manual` && back.v === '1' && back.screen === one && cw === '1024x1024', `manual 1x: "${one}", remembered after a reload (${back.v}: "${back.screen}"), canvas ${cw}`);
      const three = await pick('3');
      check(three === `${w}×${h}, tile 1024×896 at 2× (3× does not fit)`, `manual 3x does not fit: "${three}"`);
      await pick('auto');
      check(JSON.parse(await b.evaluate(`JSON.stringify(localStorage.getItem('lb-tile-scale'))`)) === null, 'Auto again: nothing remembered');
    }
    check(b.errors.length === 0, `dpr ${dpr}: no page errors (${b.errors.join(' | ')})`);
  } finally { await b.stop(); }
}

// the receiver: it loads from file:// and its inlined worker starts the wasm (the camera itself needs https or localhost)
{
  const b = await browser(1, 1400, 1000);
  try {
    await b.send('Page.navigate', { url: pathToFileURL(join(DIST, 'lensbolt-receive.html')).href }, b.S);
    await sleep(2000);
    const r = JSON.parse(await b.evaluate(`(async () => {
      const w = window.lensboltWorker();
      const ready = await new Promise((res) => { w.onmessage = (e) => res(e.data); setTimeout(() => res(null), 8000); w.postMessage({ type: 'init', wasm: window.lensboltWasm }); });
      w.terminate();
      return JSON.stringify({ ready, go: !!document.getElementById('go') });
    })()`));
    check(r.go && r.ready && r.ready.type === 'ready', `the single-file receiver loads from file:// and its worker is ready (${JSON.stringify(r.ready)})`);
    check(offline(b.urls).length === 0, `receiver: no network requests (${offline(b.urls).slice(0, 3).join(', ')})`);
    check(b.errors.length === 0, `receiver: no page errors (${b.errors.join(' | ')})`);
  } finally { await b.stop(); }
}

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

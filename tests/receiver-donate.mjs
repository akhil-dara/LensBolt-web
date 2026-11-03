// The browser receiver's support card in a real (headless) Chrome, through the self-test transfer (?selftest&count:
// a simulated sender whose successes count): shown on the 5th success and every 5th after, never two in a row,
// "Not now" and "Don't ask again", the counts kept across a reload, once per page load without storage; below
// Save, Share and Receive another (never over them), reachable with Tab, the links opening a new tab.
//
//   python web/serve.py                       (in another shell; port 8765)
//   node web/tests/receiver-donate.mjs        (its own headless Chrome on CDP_PORT, default 9334, stopped by its PID)
//   SHOTS=docs/screens/web ...                (also writes screenshots)
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tempProfile, ownChrome } from './chrome-profile.mjs';
const PORT = Number(process.env.CDP_PORT || 9334);
const BASE = process.env.BASE || 'http://localhost:8765';
const PAGE = process.env.RPAGE || 'receive.html';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOTS = process.env.SHOTS || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

try { await fetch(`http://127.0.0.1:${PORT}/json/version`); throw new Error(`port ${PORT} is already in use: stop that browser first`); } catch (e) { if (/in use/.test(e.message)) throw e; }
const profile = tempProfile('lb-donate-');
const chrome = ownChrome(spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-color-profile=srgb', '--window-size=800,1000', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' }));
console.log(`headless Chrome PID ${chrome.pid}`);
const kill = () => { if (chrome.exitCode === null) { try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } };
let ws;
try {
  let wsUrl;
  for (let i = 0; i < 150 && !wsUrl; i++) { try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(200); } }
  if (!wsUrl) throw new Error('Chrome did not open its debugging port');
  ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const { targetInfos } = await send('Target.getTargets');
  const { sessionId: S } = await send('Target.attachToTarget', { targetId: targetInfos.find((t) => t.type === 'page').targetId, flatten: true });
  await send('Page.enable', {}, S); await send('Runtime.enable', {}, S);
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, S);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expr, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await evaluate(expr).catch(() => false)) return true; await sleep(100); } return false; };
  const shot = async (name) => { if (!SHOTS) return; const { data } = await send('Page.captureScreenshot', { format: 'png' }, S); writeFileSync(join(SHOTS, name), Buffer.from(data, 'base64')); console.log('     wrote', join(SHOTS, name)); };
  const key = async (k, code, vk, text) => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, ...(type === 'keyDown' && text ? { text } : {}) }, S); };
  const askShown = () => evaluate(`!document.getElementById('ask').hidden`);
  const active = () => evaluate(`(() => { const a = document.activeElement; return !a || a === document.body ? 'body' : a.id || (a.tagName === 'A' ? a.textContent.trim() : a.tagName); })()`);
  // one successful transfer: the first comes with the page, the next with Receive another
  const success = async (first) => {
    if (!first) {
      await evaluate(`document.getElementById('again').click(), true`);
      // the file was not saved: Receive another asks first (Keep is the default); Discard goes on
      if (!(await until(`document.getElementById('ask-dlg').open`, 3000))) throw new Error('Receive another did not ask before dropping an unsaved file');
      await evaluate(`document.getElementById('ask-dlg-no').click(), true`);
    }
    if (!(await until(`document.getElementById('done').hidden === false`))) throw new Error('the self-test did not complete');
    await sleep(150);
    return askShown();
  };
  const open = async () => { await send('Page.navigate', { url: `${BASE}/${PAGE}?selftest&count` }, S); return success(true); };
  const runs = async (n, startFirst = false) => { const out = []; for (let i = 0; i < n; i++) out.push(await (i === 0 && startFirst ? open() : success(false))); return out; };
  const at = (seq, base = 0) => seq.map((s, i) => (s ? base + i + 1 : 0)).filter(Boolean);

  await send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 2, mobile: true }, S);
  const first = await runs(4, true);
  check(at(first).length === 0 && await evaluate(`!document.getElementById('done-support').hidden`), 'successes 1-4: no card, the small support line');
  check(await success(false), 'the 5th success: the card');
  check(await evaluate(`document.getElementById('ask-text').textContent.trim()`) === 'LensBolt is free. If it helped, you can support it.', 'its words');
  const links = await evaluate(`[...document.querySelectorAll('#ask a')].map((a) => [a.textContent.trim(), a.href, a.target, a.rel].join(' | '))`);
  check(links[0] === 'Buy me a coffee | https://buymeacoffee.com/akhildara1l | _blank | noopener' && links[1] === 'GitHub Sponsors | https://github.com/sponsors/akhil-dara | _blank | noopener', `the two links, opening a new tab: ${links.join('; ')}`);
  check(await evaluate(`document.getElementById('done-support').hidden`), 'the small line gives way to the card (said once)');
  check(await active() === 'save', `Save keeps the focus (${await active()})`);
  const geo = await evaluate(`(() => { const r = (id) => document.getElementById(id).getBoundingClientRect(); const a = r('ask'), acts = document.querySelector('#done .actions').getBoundingClientRect();
    return { askTop: a.top, actsBottom: acts.bottom, saveTop: r('save').top, bottom: a.bottom, vh: innerHeight, region: document.getElementById('ask').tagName + '/' + document.getElementById('ask').getAttribute('aria-labelledby') }; })()`);
  check(geo.askTop >= geo.actsBottom && geo.saveTop >= 0 && geo.bottom <= geo.vh, `below Save, Share and Receive another, all in view (actions end ${Math.round(geo.actsBottom)}, card ${Math.round(geo.askTop)}-${Math.round(geo.bottom)} of ${geo.vh})`);
  check(geo.region === 'SECTION/ask-text', 'a region named by its sentence');
  await shot('receive-donate-phone.png');
  const order = [];
  for (let i = 0; i < 8; i++) { await key('Tab', 'Tab', 9); order.push(await active()); }
  check(['Buy me a coffee', 'GitHub Sponsors', 'ask-later', 'ask-never'].every((x) => order.includes(x)) && order.indexOf('again') < order.indexOf('Buy me a coffee'), `Tab after Save: ${order.join(', ')}`);
  await evaluate(`document.getElementById('ask-later').focus(), true`);
  await key('Enter', 'Enter', 13, String.fromCharCode(13));
  check(!(await askShown()) && await active() === 'save' && await evaluate(`!document.getElementById('done-support').hidden`), 'Not now (Enter): the card goes, the focus back on Save, the small line again');
  check(!(await success(false)), 'the 6th: never two in a row');
  check(await evaluate(`localStorage.getItem('lb-donate-count') + ',' + localStorage.getItem('lb-donate-shown')`) === '6,5', 'the counts in localStorage');

  // a reload keeps the counts: the 10th shows; "Don't ask again" ends it
  const later = await runs(4, true);
  check(JSON.stringify(at(later, 6)) === '[10]', `after a reload: successes 7-10 show it on the ${at(later, 6)}th`);
  await evaluate(`document.getElementById('ask-never').click(), true`);
  check(!(await askShown()) && await evaluate(`localStorage.getItem('lb-donate-never')`) === '1', "Don't ask again: gone, remembered");
  const after = [...await runs(1, true), ...await runs(5)];
  check(at(after).length === 0, 'then never again (a reload and 6 more successes)');
  // a self-test without ?count does not count
  await evaluate(`localStorage.clear(), true`);
  await send('Page.navigate', { url: `${BASE}/${PAGE}?selftest` }, S);
  await until(`document.getElementById('done').hidden === false`);
  check(await evaluate(`localStorage.getItem('lb-donate-count')`) === '0', 'a plain self-test does not count');

  // without storage (it throws): at most once per page load
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('denied', 'SecurityError'); } });` }, S);
  const bare = await runs(11, true);
  check(JSON.stringify(at(bare)) === '[5]', `storage refused: shown once in this page load (${at(bare)})`);
  // a short phone: the card still clears the actions
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 2, mobile: true }, S);
  const short = await runs(5, true);
  const g2 = await evaluate(`(() => { const a = document.getElementById('ask').getBoundingClientRect(), acts = document.querySelector('#done .actions').getBoundingClientRect(), s = document.getElementById('save').getBoundingClientRect(); return { a: a.top, b: acts.bottom, s: s.top }; })()`);
  check(short[4] && g2.a >= g2.b && g2.s >= 0, `360x640: Save in view (top ${Math.round(g2.s)}), the card below the actions`);
  await shot('receive-donate-phone-short.png');
} finally {
  try { await Promise.race([new Promise((r) => { try { ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' })); } catch {} setTimeout(r, 1500); })]); } catch {}
  for (let i = 0; i < 20 && chrome.exitCode === null; i++) await sleep(100);
  kill();
  try { ws && ws.close(); } catch {}
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

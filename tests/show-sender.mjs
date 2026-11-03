// Opens the sender full screen with a generated test file, for live phone tests: CODE=<two words> picks the
// format (default: the page's own speed choice); LEAD=<s> the aiming countdown. Keeps the window open until killed.
//
//   python -m http.server 8765 --bind 127.0.0.1 --directory web     (in another shell)
//   CODE=satin-swift node web/tests/show-sender.mjs [MB]
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tempProfile, ownChrome } from './chrome-profile.mjs';
const MB = Number(process.argv[2] || 8);
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9334;
const profile = tempProfile('lb-chrome-');
// a covered or unfocused window must not be throttled (it would keep showing the same frames)
ownChrome(spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
  '--start-fullscreen', `http://localhost:8765/index.html?testfile=${MB}&lead=${process.env.LEAD || 5}`], { stdio: 'ignore' }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
for (let i = 0; i < 50 && !page; i++) {
  try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch { await sleep(200); }
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let nextId = 1;
const pending = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const evaluate = (expr) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, (m) => resolve(m.result?.result?.value));
  ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }));
});
for (let i = 0; i < 100 && !(await evaluate(`!document.getElementById('start').disabled`)); i++) await sleep(200);
await evaluate(`(() => { const c = document.getElementById('calib'); if (c) c.checked = false; return true; })()`);
// the test file arrives after the button enables and resets the form: set the code until it stays
for (let i = 0; process.env.CODE && i < 20; i++) {
  await evaluate(`(() => { const c = document.getElementById('code'); c.value = ${JSON.stringify(process.env.CODE)}; c.dispatchEvent(new Event('input')); return true; })()`);
  await sleep(500);
  if (await evaluate(`document.getElementById('code').value`) === process.env.CODE) break;
}
await evaluate(`document.getElementById('start').click(), true`);
await sleep(3000);
console.log('sender:', await evaluate(`JSON.stringify({ code: document.getElementById('code').value, canvas: document.getElementById('canvas').width + 'x' + document.getElementById('canvas').height, inner: innerWidth + 'x' + innerHeight, dpr: devicePixelRatio, frame: document.getElementById('hud-n').textContent, pass: document.getElementById('hud-pass').textContent })`));
setInterval(() => {}, 1 << 30);

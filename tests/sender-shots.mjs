// Screenshots of the sender flow in real Chrome windows: the form, the countdown and sending, at a few window
// sizes (the panel moves beside, above or over the tile). Writes PNGs to the directory given.
//
//   python -m http.server 8765 --bind 127.0.0.1 --directory web     (in another shell)
//   node web/tests/sender-shots.mjs <out_dir>
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tempProfile, ownChrome } from './chrome-profile.mjs';
const OUT = process.argv[2] || '.';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9335;
const chrome = ownChrome(spawn(CHROME, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${tempProfile('lb-chrome-')}`, '--no-first-run',
  '--no-default-browser-check', '--force-device-scale-factor=1', '--disable-backgrounding-occluded-windows', 'about:blank'], { stdio: 'ignore' }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl;
for (let i = 0; i < 50 && !wsUrl; i++) { try { wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl; } catch { await sleep(200); } }
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
const evaluate = async (s, expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, s)).result.value;
const shot = async (s, name) => { const { data } = await send('Page.captureScreenshot', { format: 'png' }, s); writeFileSync(join(OUT, name), Buffer.from(data, 'base64')); console.log('wrote', name); };

try {
  for (const [w, h, theme] of [[1700, 1050, 'light'], [1180, 820, 'dark']]) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank', newWindow: true, left: 0, top: 0, width: w, height: h });
    const { sessionId: s } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Runtime.enable', {}, s); await send('Page.enable', {}, s);
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme }] }, s);
    await send('Page.navigate', { url: 'http://localhost:8765/index.html?testfile=8&lead=30' }, s);
    for (let i = 0; i < 100 && !(await evaluate(s, `document.getElementById('start')?.disabled === false`)); i++) await sleep(200);
    await shot(s, `sender-form-${w}-${theme}.png`);
    await evaluate(s, `document.getElementById('start').click(), true`);
    await sleep(1500);
    await shot(s, `sender-count-${w}-${theme}.png`);
    await evaluate(s, `document.getElementById('go-now').click(), true`);
    await sleep(2000);
    await shot(s, `sender-send-${w}-${theme}.png`);
    console.log(w, await evaluate(s, `document.getElementById('stage').className`));
  }
} finally { chrome.kill(); ws.close(); }

// Prints the phone browser receiver's progress during a live test: Chrome on the phone over USB debugging
// (adb forward tcp:9222 localabstract:chrome_devtools_remote), the LensBolt receive page open there.
//
//   node web/tests/watch-phone.mjs [timeout_s]
const TIMEOUT_S = Number(process.argv[2] || 180);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = (await (await fetch('http://127.0.0.1:9222/json/list')).json()).find((t) => t.type === 'page' && /lensbolt-receive|receive\.html/.test(t.url));
if (!page) { console.log('no LensBolt receive page open on the phone'); process.exit(1); }
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
const t0 = Date.now();
let last = '';
while ((Date.now() - t0) / 1000 < TIMEOUT_S) {
  const s = await evaluate(`(() => { const t = (id) => { const e = document.getElementById(id); return e ? (e.hidden ? '' : e.textContent.trim()) : ''; };
    return JSON.stringify({ guide: t('guide'), name: t('fname'), got: t('got'), rate: t('rate'), left: t('x'), frames: t('d-frames'), decode: t('d-decode'),
      format: t('d-format'), source: t('d-camera'), problem: t('problem'), done: t('done-meta') }); })()`);
  if (s && s !== last) { console.log(`${((Date.now() - t0) / 1000).toFixed(0).padStart(4)} s ${s}`); last = s; }
  if (s && JSON.parse(s).done) break;
  await sleep(2000);
}
ws.close();

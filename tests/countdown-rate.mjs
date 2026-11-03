// The sender's countdown shows a new frame number on every displayed frame (the manifest again), so a phone
// measures the sender's frame rate while the user aims. In the sender page at 30 and 60 fps: every frame the
// countdown draws is copied (halved with nearest-neighbour scaling: the 12 px manifest cells stay whole) with the
// time it was drawn, then decoded through the wasm receiver: all of them are the manifest, no data arrives, and
// the receiver reads the chosen rate within the countdown's 2 s.
//
//   python web/serve.py                       (in another shell; port 8765)
//   node web/tests/countdown-rate.mjs         (a test Chrome on port 9334, window at least 1100x1100 so a
//                                              1024 tile fits, e.g. --headless=new --window-size=1400,1200)
const PORT = Number(process.env.CDP_PORT || 9334);
const BASE = process.env.BASE || 'http://localhost:8765';
const LEAD = 2;
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(url) {
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pend = new Map();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const evaluate = (expression) => new Promise((res) => { const i = ++id; pend.set(i, (m) => res(m.result?.result?.value ?? m.result?.exceptionDetails?.exception?.description)); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); });
  const send = (method, params) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  // a screen large enough for the 1024 tile (a headless browser reports 800x600)
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1200, deviceScaleFactor: 1, mobile: false, screenWidth: 1920, screenHeight: 1200 });
  await send('Page.navigate', { url });
  return { evaluate, close: async () => { ws.close(); await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`); } };
}

for (const fps of [30, 60]) {
  const p = await page(`${BASE}/index.html?testfile=0.2&lead=${LEAD}`);
  for (let i = 0; i < 100 && (await p.evaluate(`document.getElementById('start')?.disabled === false`)) !== true; i++) await sleep(100);
  const setup = await p.evaluate(`(() => {
    const sel = document.getElementById('fps'); sel.value = '${fps}'; sel.dispatchEvent(new Event('change'));
    // every frame the page draws while counting: the time and a half-size copy
    window.__shown = [];
    const put = CanvasRenderingContext2D.prototype.putImageData;
    let half = null, hctx = null;
    CanvasRenderingContext2D.prototype.putImageData = function (img, x, y) {
      put.call(this, img, x, y);
      if (!document.getElementById('stage').classList.contains('counting')) return;
      const t = performance.now(), c = this.canvas;
      if (!half) { half = new OffscreenCanvas(c.width / 2, c.height / 2); hctx = half.getContext('2d', { willReadFrequently: true }); hctx.imageSmoothingEnabled = false; }
      hctx.drawImage(c, 0, 0, half.width, half.height);
      window.__shown.push({ t, data: hctx.getImageData(0, 0, half.width, half.height).data, w: half.width, h: half.height });
    };
    document.getElementById('start').click();
    return document.getElementById('stage').className;
  })()`);
  await sleep(LEAD * 1000 + 800);
  const out = JSON.parse(await p.evaluate(`(async () => {
    const m = await import('./pkg/lensbolt_web.js');
    const rx = new m.WebReceiver(), shown = window.__shown;
    let s = null, manifestOnly = true;
    for (const f of shown) {
      s = JSON.parse(rx.push(f.data, f.w, f.h, f.t));
      // the status describes data reads only (manifest reads leave it): a format here means a data frame was read
      if (s.format) manifestOnly = false;
    }
    const span = shown.length > 1 ? shown[shown.length - 1].t - shown[0].t : 0;
    // the rate drawn over the last 1.5 s (the receiver's window): the first frames can wait on the page's setup
    const end = shown.length ? shown[shown.length - 1].t : 0, win = shown.filter((f) => f.t >= end - 1500);
    const recent = win.length > 1 ? (win.length - 1) * 1000 / (end - win[0].t) : 0;
    return JSON.stringify({ n: shown.length, span, recent, stage: document.getElementById('stage').className, manifestOnly, s });
  })()`));
  const s = out.s || {};
  check(/counting/.test(setup), `${fps} fps: the countdown started (${setup})`);
  check(out.n >= fps * LEAD * 0.85, `${fps} fps: the countdown drew a frame per display period (${out.n} frames in ${(out.span / 1000).toFixed(2)} s)`);
  check(s.decoded >= out.n * 0.9, `${fps} fps: the countdown frames decode (${s.decoded} of ${out.n})`);
  check(out.manifestOnly && s.have_manifest, `${fps} fps: every countdown frame is the manifest (data format read: ${s.format}, manifest ${s.have_manifest})`);
  check(s.received_bytes === 0 && !s.receiver_error, `${fps} fps: no data and no receiver error during the countdown (${s.received_bytes} B, ${s.receiver_error})`);
  // the chosen rate, and (closer) the rate the page really drew at lately (a busy headless page can miss a vsync)
  const drawn = out.recent;
  check(Math.abs(s.sender_fps - fps) <= fps * 0.1, `${fps} fps: the receiver reads the sender's rate during the countdown (${s.sender_fps})`);
  check(Math.abs(s.sender_fps - drawn) <= drawn * 0.05, `${fps} fps: ... within 5% of the rate the page drew (${s.sender_fps} against ${drawn.toFixed(1)})`);
  check(/sending/.test(out.stage), `${fps} fps: sending began after the countdown (${out.stage})`);
  await p.close();
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

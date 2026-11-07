// The receiver page's camera control in a real browser, with a fake camera and a scripted decoder: the page's own
// code runs (camera start, Details, zoom, focus, banner, hint, lens switch, wake lock); the decoder worker is
// replaced by one that answers each frame with a status from a simple optical model (the square grows with the
// zoom), and the camera track reports zoom 1-10 and focus modes like a phone's (its own fake device has
// none). The decisions themselves are tested in node (receiver-logic.mjs); this checks the page acts on them.
//
// The camera's size: the page asks for the Full HD class and ends at 2.5 MP or less, also on a camera that
// settles larger. Fake cameras of a fixed size (a generated .y4m: 1920x1080, and 2448x3264 like a phone's
// back camera in portrait), each in a headless Chrome of its own on SIZE_PORT (default CDP_PORT + 7), stopped by
// its PID; the 2448x3264 one also as a camera that ignores the size asked for (it settles at its 8 MP mode).
//
//   python web/serve.py                       (in another shell; port 8765)
//   node web/tests/receiver-camera.mjs        (a test Chrome on port 9334 started with
//        --use-fake-ui-for-media-stream --use-fake-device-for-media-stream)
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempProfile, ownChrome } from './chrome-profile.mjs';
const PORT = Number(process.env.CDP_PORT || 9334);
const SIZE_PORT = Number(process.env.SIZE_PORT || PORT + 7);
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const MAX_PX = 2.5e6;
const BASE = process.env.BASE || 'http://localhost:8765';
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// runs before the page's scripts: a track with zoom and focus, a recorded wake lock, and the scripted decoder
const PRELUDE = `(() => {
  const T = MediaStreamTrack.prototype, caps = T.getCapabilities, settings = T.getSettings;
  window.__applied = []; window.__zoom = new WeakMap(); window.__wake = [];
  const st = (t) => window.__zoom.get(t) || { zoom: 1, focusMode: 'manual' };
  // two back lenses: the fake camera, and the same camera under a second id and label (Chrome's own second fake
  // device freezes any page that reads its frames, the page before this change too)
  try { localStorage.removeItem('lb-lens'); } catch (e) {}
  const md = navigator.mediaDevices, enumerate = md.enumerateDevices.bind(md), gum = md.getUserMedia.bind(md), lensOf = new WeakMap();
  md.enumerateDevices = async () => { const d = await enumerate(), cam = d.find((x) => x.kind === 'videoinput'); return cam ? [...d, { kind: 'videoinput', deviceId: 'lens-b', label: 'test lens b', groupId: 'b' }] : d; };
  md.getUserMedia = async (c) => {
    const want = c && c.video && c.video.deviceId && c.video.deviceId.exact;
    if (want === 'lens-b') { const v = { ...c.video }; delete v.deviceId; const s = await gum({ ...c, video: v }); lensOf.set(s.getVideoTracks()[0], 'lens-b'); return s; }
    return gum(c);
  };
  const label = Object.getOwnPropertyDescriptor(T, 'label').get;
  Object.defineProperty(T, 'label', { get() { return lensOf.get(this) ? 'test lens b' : label.call(this); } });
  T.getCapabilities = function () { return { ...caps.call(this), zoom: { min: 1, max: 10, step: 0.1 }, focusMode: ['manual', 'single-shot', 'continuous'], pointsOfInterest: true }; };
  T.getSettings = function () { return { ...settings.call(this), ...st(this), ...(lensOf.get(this) ? { deviceId: lensOf.get(this) } : {}) }; };
  const apply = T.applyConstraints;
  window.__sized = [];
  T.applyConstraints = async function (c) {
    const a = (c && c.advanced && c.advanced[0]) || {};
    // as the spec has it, every call replaces the track's whole constraint set: the real track gets it (Chrome
    // scales the fake camera; a set without a size lets the camera go back to its own mode), less the zoom and
    // focus this stub plays itself (the fake camera has neither)
    if (c && (c.width || c.height)) window.__sized.push({ width: c.width, height: c.height });
    { const { advanced, ...rest } = c || {}; await apply.call(this, rest); }
    window.__applied.push({ t: performance.now(), ...a });
    window.__zoom.set(this, { ...st(this), ...(a.zoom != null ? { zoom: a.zoom } : {}), ...(a.focusMode ? { focusMode: a.focusMode } : {}) });
  };
  Object.defineProperty(navigator, 'wakeLock', { value: { request: async (k) => { window.__wake.push(k); const s = new EventTarget(); s.release = async () => { window.__wake.push('release'); }; return s; } } });
  // the scene: the square at zoom 1 fills f0 of the short side, centred; cells 1.3 camera px at zoom 1 (2 px b/w);
  // codewords read once the cells are 2.2 px or more; window.__scene changes it (lost, sender rate)
  window.__scene = { f0: 0.4, lost: false, senderFps: 0, extra: {} };
  let n = 0, dec = 0, fail = 0;
  const fake = () => {
    const w = { onmessage: null, terminate() {} };
    w.postMessage = (m) => {
      if (m.frame) m.frame.close();
      if (m.bitmap) m.bitmap.close();
      // window.__scene.extra goes into every status (a receiver error, the storage, a size)
      const reply = (data) => setTimeout(() => w.onmessage && w.onmessage({ data: data.status ? { ...data, status: { ...data.status, ...window.__scene.extra } } : data }), 30);
      if (m.type === 'init' || m.type === 'reset') return reply({ type: 'ready', proto: 2, storage: 'memory' });
      const sc = window.__scene, track = document.getElementById('video').srcObject?.getVideoTracks()[0];
      const z = track ? st(track).zoom : 1, W = 640, H = 480;
      n++;
      if (sc.lost) { fail++; return reply({ type: 'status', status: { frames: n, decoded: dec, failed: fail, last_error: 'NoMarkers', format: '2px bw 1024x1024', cell_px: 0, edges: null, codewords_ok: 0, codewords: 0, sharpness: 3, corners: null, frame: [W, H], sender_fps: sc.senderFps, have_manifest: true, stream_size: 1e6, received_bytes: 0, camera: '640x480 I420' } }); }
      dec++;
      const side = sc.f0 * z * H, cell = 1.3 * z, e = cell / 2;
      const c = [W / 2 - side / 2, H / 2 - side / 2, W / 2 + side / 2, H / 2 - side / 2, W / 2 + side / 2, H / 2 + side / 2, W / 2 - side / 2, H / 2 + side / 2];
      const ok = cell >= 2.2 ? 111 : 4;
      reply({ type: 'status', status: { frames: n, decoded: dec, failed: fail, last_error: null, format: '2px bw 1024x1024', cell_px: cell, edges: [e, e, e, e], codewords_ok: ok, codewords: 111, sharpness: 15, corners: c, frame: [W, H], sender_fps: sc.senderFps, have_manifest: true, filename: 'x.bin', stream_size: 1e6, received_bytes: ok === 111 ? dec * 1000 : 0, camera: '640x480 I420' } });
    };
    return w;
  };
  Object.defineProperty(window, 'lensboltWorker', { get: () => fake, set: () => {}, configurable: false });
})()`;

async function page(url, prelude, port = PORT) {
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pend = new Map(); const errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => {
    const m = await Promise.race([send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }), sleep(10000).then(() => ({ result: { result: { value: 'null' } }, timeout: true }))]);
    if (m.timeout) console.log(`     (no answer in 10 s: ${expression.slice(0, 60)})`);
    return m.result?.result?.value ?? m.result?.exceptionDetails?.exception?.description;
  };
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: prelude });
  await send('Page.navigate', { url });
  // the page's scripts have run (a loaded machine can take longer than a fixed wait)
  for (let i = 0; i < 100 && (await evaluate(`document.readyState === 'complete' && !!document.getElementById('go')`)) !== true; i++) await sleep(100);
  await sleep(500);
  return { evaluate, errors, close: async () => { ws.close(); await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`); } };
}
const text = (id) => `document.getElementById('${id}').textContent`;

{
  // the default page: no auto zoom (a square at 40% stays as the camera gives it; the guidance asks to come
  // closer), and a picture that pauses while receiving plays again (the reads wait on its frames)
  const p = await page(`${BASE}/receive.html`, PRELUDE);
  await p.evaluate(`document.getElementById('go').click(), true`);
  await sleep(3000);
  const d = JSON.parse(await p.evaluate(`JSON.stringify({ zooms: window.__applied.filter((a) => a.zoom != null).map((a) => a.zoom), dzoom: ${text('d-zoom')}, guide: ${text('guide')} })`));
  check(d.zooms.length === 0, `without ?zoom=1 the page never zooms (zoom steps: ${d.zooms.join(', ') || 'none'})`);
  check(/ · auto off$/.test(d.dzoom), `Details says auto zoom is off (${d.dzoom})`);
  check(/^Move closer/.test(d.guide), `a small square: the guidance asks to come closer (${d.guide})`);
  const framesBefore = await p.evaluate(`+(${text('d-frames')}).split(' of ')[1].split(' ')[0]`);
  await p.evaluate(`document.getElementById('video').pause(), true`);
  await sleep(1500);
  const r = JSON.parse(await p.evaluate(`JSON.stringify({ paused: document.getElementById('video').paused, frames: +(${text('d-frames')}).split(' of ')[1].split(' ')[0], dframes: ${text('d-frames')} })`));
  check(!r.paused && r.frames > framesBefore && /picture resumed 1x/.test(r.dframes), `a paused picture plays again and frames keep coming (${framesBefore} -> ${r.frames}; ${r.dframes})`);
  check(p.errors.length === 0, `no page errors (${p.errors.join(' | ')})`);
  await p.close();
}

{
  // a blended screen on a camera with manual exposure: the default page never darkens it with the short exposure
  // trial (manual exposure in Chrome is several times darker than auto at the same time x ISO: the picture dimmed
  // each trial); ?short=1 (lab) still tries it
  const EXPOSURE = PRELUDE + `;(() => { const T = MediaStreamTrack.prototype, caps = T.getCapabilities;
    T.getCapabilities = function () { return { ...caps.call(this), exposureMode: ['manual', 'continuous'], exposureTime: { min: 1, max: 1000, step: 1 }, iso: { min: 50, max: 3200, step: 1 } }; };
    window.__scene.f0 = 0.8; window.__scene.extra = { mix: 0.5 }; })()`;
  const manual = `JSON.stringify(window.__applied.filter((a) => a.exposureMode === 'manual').length)`;
  for (const [q, want] of [['', 0], ['?short=1', 1]]) {
    const p = await page(`${BASE}/receive.html${q}`, EXPOSURE);
    await p.evaluate(`document.getElementById('go').click(), true`);
    await sleep(6000);
    const n = JSON.parse(await p.evaluate(manual));
    check(want ? n >= 1 : n === 0, `${q || 'the default page'}: ${want ? 'tries' : 'never tries'} the short exposure on a blended screen (manual exposure applied ${n}x)`);
    check(p.errors.length === 0, `no page errors (${p.errors.join(' | ')})`);
    await p.close();
  }
}

{
  // the browser opens a virtual camera that spans several lenses: the page reads with the main lens instead (the
  // system swaps lenses inside a virtual one close up), and does not remember it as the user's choice
  const VIRTUAL = PRELUDE + `;(() => { const md = navigator.mediaDevices, enumerate = md.enumerateDevices.bind(md);
    const name = (l) => l === 'test lens b' ? 'Back Camera' : 'Back Triple Camera';
    md.enumerateDevices = async () => (await enumerate()).map((d) => d.kind === 'videoinput' ? { kind: d.kind, deviceId: d.deviceId, groupId: d.groupId, label: name(d.label) } : d);
    const T = MediaStreamTrack.prototype, label = Object.getOwnPropertyDescriptor(T, 'label').get;
    Object.defineProperty(T, 'label', { get() { return name(label.call(this)); } }); })()`;
  const p = await page(`${BASE}/receive.html`, VIRTUAL);
  await p.evaluate(`document.getElementById('go').click(), true`);
  await sleep(3000);
  const v = JSON.parse(await p.evaluate(`JSON.stringify({ lens: ${text('d-lens')}, saved: localStorage.getItem('lb-lens'), frames: +(${text('d-frames')}).split(' of ')[1].split(' ')[0] })`));
  check(v.lens === 'Back Camera' && v.frames > 0, `a virtual "Back Triple Camera": the page reads with "Back Camera" (${v.lens}, ${v.frames} frames)`);
  check(v.saved === null, `the main lens is not remembered as the user's pick (${v.saved})`);
  const btn = await p.evaluate(`document.getElementById('lens').hidden`);
  check(btn === true, `the button does not offer the virtual camera (one single lens: no button, hidden=${btn})`);
  check(p.errors.length === 0, `no page errors (${p.errors.join(' | ')})`);
  await p.close();
}

{
  // too close for the first lens to focus (big cells, a soft border, codewords failing): the page opens the other lens
  // on its own, where the square reads, and stays; no timing restart and no refocus while too close
  const CLOSE = PRELUDE.replace("? 'test lens b' : label.call(this)", "? 'camera 2, facing back' : 'camera 0, facing back'")
    .replace("label: 'test lens b', groupId: 'b'", "label: 'camera 2, facing back', groupId: 'b'")
    .replace('const ok = cell >= 2.2 ? 111 : 4;', "const near = !track || track.label !== 'camera 2, facing back'; const ok = near ? 4 : 111;")
    .replace('f0: 0.4', 'f0: 0.75').replace('cell = 1.3 * z', 'cell = 3.2 * z')
    .replace("sharpness: 15, corners: c,", "sharpness: 15, edge_px: near ? 3.4 : 1.5, corners: c,") + `;(() => { const T = MediaStreamTrack.prototype, gs = T.getSettings, gc = T.getCapabilities, b = (t) => t.label === 'camera 2, facing back';
      // as the phone: the first lens pinned at its closest focus (0.13 m), the other focusing down to 0.04 m
      T.getSettings = function () { return { ...gs.call(this), focusDistance: b(this) ? 0.3 : 0.13 }; };
      T.getCapabilities = function () { return { ...gc.call(this), focusDistance: { min: b(this) ? 0.04 : 0.13, max: 10, step: 0.01 } }; }; })()`;
  const p = await page(`${BASE}/receive.html`, CLOSE);
  await p.evaluate(`document.getElementById('go').click(), true`);
  await sleep(1200);
  const g0 = await p.evaluate(text('guide'));
  await sleep(6000);
  const v = JSON.parse(await p.evaluate(`JSON.stringify({ lens: ${text('d-lens')}, cw: ${text('d-codewords')}, cam: ${text('d-camera')}, shots: window.__applied.filter((a) => a.focusMode === 'single-shot').length, guide: ${text('guide')} })`));
  check(v.lens === 'camera 2, facing back' && /^111 of 111/.test(v.cw), `too close on the first lens: the page opened the other one by itself and reads there (${v.lens}, ${v.cw}; first said "${g0}")`);
  check(!/restarted/.test(v.cam) && v.shots === 0, `no timing restart and no refocus while too close (${v.cam}; refocuses ${v.shots})`);
  check(p.errors.length === 0, `no page errors (${p.errors.join(' | ')})`);
  await p.close();
}

{
  // a computer's webcam and a virtual camera (OBS) listed beside it: the same failing scene never switches the camera
  // on its own (the lens choice is for a phone's back lenses; webcam mode switched to the virtual camera, 2026-11-07)
  const WEBCAM = PRELUDE.replace("? 'test lens b' : label.call(this)", "? 'OBS Virtual Camera' : 'HD Webcam (5986:211b)'")
    .replace("label: 'test lens b', groupId: 'b'", "label: 'OBS Virtual Camera', groupId: 'b'")
    .replace('const ok = cell >= 2.2 ? 111 : 4;', 'const ok = 4;').replace('f0: 0.4', 'f0: 0.75').replace('cell = 1.3 * z', 'cell = 3.2 * z')
    .replace("sharpness: 15, corners: c,", "sharpness: 15, edge_px: 3.4, corners: c,");
  const p = await page(`${BASE}/receive.html`, WEBCAM);
  await p.evaluate(`document.getElementById('go-webcam').click(), true`);
  await sleep(9000);
  const w = JSON.parse(await p.evaluate(`JSON.stringify({ lens: ${text('d-lens')}, btn: !document.getElementById('lens').hidden })`));
  check(w.lens === 'HD Webcam (5986:211b)', `a webcam reading badly for 9 s stays the webcam, never the virtual camera beside it (${w.lens})`);
  check(p.errors.length === 0, `no page errors (${p.errors.join(' | ')})`);
  await p.close();
}

{
  // ?zoom=1 (lab): auto zoom toward a square that fills ~80% of the picture
  const p = await page(`${BASE}/receive.html?zoom=1`, PRELUDE);
  await p.evaluate(`document.getElementById('go').click(), true`);
  await sleep(1200);
  const early = JSON.parse(await p.evaluate(`JSON.stringify({ cam: !document.getElementById('cam').hidden, guide: ${text('guide')}, applied: window.__applied, wake: window.__wake })`));
  check(early.cam, 'the camera screen shows');
  check(early.applied.some((a) => a.focusMode === 'continuous'), `continuous focus is applied at start (${JSON.stringify(early.applied.slice(0, 3))})`);
  check(early.wake.includes('screen'), `the screen is kept on while receiving (${early.wake})`);
  await sleep(3000);
  const z = JSON.parse(await p.evaluate(`JSON.stringify({ zooms: window.__applied.filter((a) => a.zoom != null).map((a) => a.zoom), guide: ${text('guide')}, dzoom: ${text('d-zoom')}, dcam: ${text('d-camera')}, dfocus: ${text('d-focus')}, dcell: ${text('d-cell')}, dcw: ${text('d-codewords')}, lock: document.getElementById('cam').dataset.lock })`));
  const last = z.zooms[z.zooms.length - 1];
  check(z.zooms.length >= 1 && z.zooms.length <= 3 && last >= 1.8 && last <= 2.1, `a square at 40% of the picture is zoomed toward 80%: zoom steps ${z.zooms.join(', ')}`);
  check(/^\d\.\dx of 1-10 · auto 1-3x$/.test(z.dzoom) && z.dzoom.startsWith(last.toFixed(1)), `Details shows the zoom read back from the track and auto zoom's range (${z.dzoom})`);
  check(/^\d+x\d+ · [\d.]+ fps (measured|set)/.test(z.dcam), `Details shows the camera size and frame rate (${z.dcam})`);
  {
    const [w, h] = z.dcam.split(' ')[0].split('x').map(Number);
    check(w * h <= MAX_PX && w >= 1280, `Chrome's fake camera: the Full HD class, at most 2.5 MP (${w}x${h})`);
  }
  check(/^(continuous|single-shot)/.test(z.dfocus), `Details shows the focus mode (${z.dfocus})`);
  check(z.guide === 'Hold steady' && z.lock === 'good', `once the cells read, the guidance says hold steady (${z.guide}, ${z.lock}); cells ${z.dcell}; codewords ${z.dcw}`);
  const focus = JSON.parse(await p.evaluate(`JSON.stringify(window.__applied.filter((a) => a.focusMode === 'single-shot'))`));
  check(focus.length === 0, `no refocus while the square is small (distance, not focus) or reads (${focus.length})`);

  // sender faster than the camera: the banner once that has held 3 s, held 2 s after the condition clears
  await p.evaluate(`window.__scene.senderFps = 60, true`);
  await sleep(1500);
  const b0 = await p.evaluate(`document.getElementById('banner').hidden`);
  check(b0 === true, `no banner while the sender has been faster for under 3 s (hidden=${b0})`);
  await sleep(2300);
  const b1 = JSON.parse(await p.evaluate(`JSON.stringify({ hidden: document.getElementById('banner').hidden, text: ${text('banner-text')}, sender: ${text('d-sender')} })`));
  check(!b1.hidden && /^The sender shows 60 fps; this camera reads \d+\. Set the sender to \d+ fps or keep going: it will take about (twice|[\d.]+ times) as long\.$/.test(b1.text), `a 60 fps sender shows the banner after 3 s (${b1.text})`);
  check(b1.sender === '60.0 fps', `Details shows the sender's rate (${b1.sender})`);
  // (a headless fake camera runs at ~13 fps: a 5 fps sender is slower than it)
  await p.evaluate(`window.__scene.senderFps = 5, true`);
  await sleep(1200);
  const held = await p.evaluate(`document.getElementById('banner').hidden`);
  await sleep(1400);
  const gone = await p.evaluate(`document.getElementById('banner').hidden`);
  check(held === false && gone === true, `the banner holds ~2 s after the sender slows, then goes (after 1.2 s hidden=${held}, after 2.6 s hidden=${gone})`);

  // the lens picker: two fake cameras, the button switches between them and frames keep coming
  const lens = JSON.parse(await p.evaluate(`JSON.stringify({ hidden: document.getElementById('lens').hidden, label: document.getElementById('lens').getAttribute('aria-label'), dlens: ${text('d-lens')} })`));
  check(!lens.hidden && /of 2/.test(lens.label), `with two cameras the switch button shows (${lens.label})`);
  const framesBefore = await p.evaluate(`+(${text('d-frames')}).split(' of ')[1]`);
  const frozen = await p.evaluate(`document.getElementById('lens').click(), !document.getElementById('freeze').hidden`);
  // the frozen picture is cropped and scaled by the page to what the video shows (a browser that does not apply
  // object-fit to a canvas drew the whole frame shrunk into a narrow column: phone screen recording, 2026-11-05)
  const fit = JSON.parse(await p.evaluate(`(() => { const c = document.getElementById('freeze'), v = document.getElementById('video'); return JSON.stringify({ cw: c.width, ch: c.height, bw: Math.round(v.clientWidth * devicePixelRatio), bh: Math.round(v.clientHeight * devicePixelRatio) }); })()`));
  check(fit.cw === fit.bw && fit.ch === fit.bh, `the frozen picture is drawn at the picture's own size on screen (${fit.cw}x${fit.ch} for a ${fit.bw}x${fit.bh} box)`);
  check(frozen === true, `while the other camera opens, the last picture stays on screen (no black: frozen=${frozen})`);
  await sleep(2500);
  check((await p.evaluate(`document.getElementById('freeze').hidden`)) === true, "the new camera's frames take over from the frozen picture");
  const after = JSON.parse(await p.evaluate(`JSON.stringify({ dlens: ${text('d-lens')}, frames: +(${text('d-frames')}).split(' of ')[1], saved: localStorage.getItem('lb-lens') })`));
  // not remembered for the next visit: every visit starts on the main lens (a pick made while trying lenses, kept,
  // started the next transfer on a lens that read worse: phone, 2026-11-05)
  // the other lens plays in a fresh <video>; the page's listeners still answer it (a pause plays again)
  const fresh = JSON.parse(await p.evaluate(`(() => { const v = document.getElementById('video'); v.pause(); return JSON.stringify({ n: document.querySelectorAll('#cam video').length }); })()`));
  await sleep(1500);
  const resumed = await p.evaluate(`!document.getElementById('video').paused`);
  check(fresh.n === 1 && resumed === true, `after the switch: one video element, and a pause plays again (${fresh.n} video, playing=${resumed})`);
  check(after.dlens === 'test lens b' && after.frames > framesBefore && after.saved === null, `switching lens: ${lens.dlens} -> ${after.dlens}, frames ${framesBefore} -> ${after.frames}, not remembered for the next visit (${after.saved})`);

  // the square lost for 2 s: back to the widest view
  await p.evaluate(`window.__scene.lost = true, true`);
  await sleep(3200);
  const lost = JSON.parse(await p.evaluate(`JSON.stringify({ zooms: window.__applied.filter((a) => a.zoom != null).map((a) => a.zoom), guide: ${text('guide')} })`));
  check(lost.zooms[lost.zooms.length - 1] === 1, `lost for 2 s: zoom back to 1 (${lost.zooms.slice(-3).join(', ')})`);
  check(lost.guide === 'Point back at the LensBolt screen', `lost mid-transfer: ${lost.guide}`);
  check(p.errors.length === 0, `no page errors (${p.errors.join(' | ')})`);
  await p.close();
}

{
  // blur: the square fills 75% of the picture with 2.6 px cells and a soft border edge (3.2 camera px), yet its
  // codewords do not read: one single-shot refocus at its centre, no zoom, and never "move closer"
  const p = await page(`${BASE}/receive.html`, PRELUDE.replace('const ok = cell >= 2.2 ? 111 : 4;', 'const ok = 4;').replace('f0: 0.4', 'f0: 0.75').replace('cell = 1.3 * z', 'cell = 2.6 * z').replace('extra: {}', 'extra: { edge_px: 3.2 }'));
  await p.evaluate(`document.getElementById('go').click(), true`);
  await sleep(3500);
  const r = JSON.parse(await p.evaluate(`JSON.stringify({ shots: window.__applied.filter((a) => a.focusMode === 'single-shot'), zooms: window.__applied.filter((a) => a.zoom != null).map((a) => a.zoom), guide: ${text('guide')}, dfocus: ${text('d-focus')} })`));
  const poi = r.shots[0] && r.shots[0].pointsOfInterest;
  check(r.shots.length === 1, `a large square that does not read gets one refocus in 3.5 s (${r.shots.length}; ${r.dfocus})`);
  check(poi && Math.abs(poi[0].x - 0.5) < 0.01 && Math.abs(poi[0].y - 0.5) < 0.01, `... at the square's centre (the camera lists pointsOfInterest) (${JSON.stringify(poi)})`);
  check(r.zooms.every((z) => z === 1), `a square at 75% is not zoomed (${r.zooms})`);
  check(/^Reading…/.test(r.guide) && !/closer/i.test(r.guide), `large cells that do not read: Reading…, never move closer (${r.guide})`);
  await p.close();
}

{
  // nothing in view for 8 s: the hint with concrete advice
  const p = await page(`${BASE}/receive.html`, PRELUDE.replace('lost: false', 'lost: true'));
  await p.evaluate(`document.getElementById('go').click(), true`);
  await sleep(6000);
  const early = await p.evaluate(`document.getElementById('idle').hidden`);
  await sleep(3500);
  const r = JSON.parse(await p.evaluate(`JSON.stringify({ hidden: document.getElementById('idle').hidden, title: ${text('idle-title')}, text: ${text('idle-text')}, guide: ${text('guide')} })`));
  check(early === true && !r.hidden && r.title === 'Nothing yet?' && /brightness/.test(r.text) && /another lens/.test(r.text), `after 8 s with nothing: "${r.title}" ${r.text}`);
  await p.close();
}

{
  // the receiver cannot write (the phone's storage is full): two such statuses stop receiving, in plain words, on
  // the start screen (Start camera tries again); the page never freezes on a failed receiver
  const p = await page(`${BASE}/receive.html`, PRELUDE);
  await p.evaluate(`document.getElementById('go').click(), true`);
  await sleep(1500);
  await p.evaluate(`window.__scene.extra = { receiver_error: 'storage is full' }, true`);
  await sleep(1500);
  const r = JSON.parse(await p.evaluate(`JSON.stringify({ problem: !document.getElementById('problem').hidden, cam: !document.getElementById('cam').hidden, title: ${text('problem-title')}, text: ${text('problem-text')}, go: !document.getElementById('go').disabled })`));
  check(r.problem && !r.cam && r.go && r.title === 'Receiving stopped' && /Start camera to try again/.test(r.text), `a receiver error stops receiving with a way to try again ("${r.title}": ${r.text})`);
  check(p.errors.length === 0, `no page errors (${p.errors.join('; ')})`);
  await p.close();
}

{
  // the manifest names a file larger than the storage this page may use: stop at once, with how much is needed
  const p = await page(`${BASE}/receive.html`, PRELUDE.replace('extra: {}', "extra: { storage: 'opfs', stream_size: 1e15, disk_peak: 2e15, store_bytes: 0 }"));
  await p.evaluate(`document.getElementById('go').click(), true`);
  await sleep(2500);
  const r = JSON.parse(await p.evaluate(`JSON.stringify({ problem: !document.getElementById('problem').hidden, cam: !document.getElementById('cam').hidden, title: ${text('problem-title')}, text: ${text('problem-text')} })`));
  check(r.problem && !r.cam && r.title === 'Not enough space on this phone' && /^[\d,]+ MB free, [\d,]+ MB needed for this file\. Free some space/.test(r.text), `too little space for the announced file stops early ("${r.title}": ${r.text})`);
  check(p.errors.length === 0, `no page errors (${p.errors.join('; ')})`);
  await p.close();
}

// --- the camera's size on fake cameras of a fixed size ---
// a .y4m of w x h (I420), a few frames of a gradient: the fake camera's only mode
function y4m(w, h) {
  const path = join(tmpdir(), `lb-cam-${w}x${h}.y4m`), fd = openSync(path, 'w');
  writeSync(fd, `YUV4MPEG2 W${w} H${h} F30:1 Ip A1:1 C420jpeg\n`);
  const y = Buffer.alloc(w * h), uv = Buffer.alloc((w / 2) * (h / 2) * 2, 128);
  for (let f = 0; f < 3; f++) {
    for (let r = 0; r < h; r++) y.fill((r + f * 40) & 255, r * w, (r + 1) * w);
    writeSync(fd, 'FRAME\n'); writeSync(fd, y); writeSync(fd, uv);
  }
  closeSync(fd);
  return path;
}
async function fakeCamera(w, h, ignoresSize) {
  const profile = tempProfile('lb-cam-'), file = y4m(w, h);
  // the previous camera's Chrome has let go of the port
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${SIZE_PORT}/json/version`); await sleep(200); } catch { break; } }
  const chrome = ownChrome(spawn(CHROME, ['--headless=new', `--remote-debugging-port=${SIZE_PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${file}`, 'about:blank'], { stdio: 'ignore' }));
  try {
    let up = false;
    for (let i = 0; i < 200 && !up; i++) { try { await fetch(`http://127.0.0.1:${SIZE_PORT}/json/version`); up = true; } catch { await sleep(200); } }
    if (!up) throw new Error('Chrome did not open its debugging port');
    // a camera that ignores the size asked for: getUserMedia without width and height (its own mode, 8 MP), and a
    // constraint set without a size (a focus or zoom change alone) puts it back in that mode, as the spec allows
    const strip = ignoresSize ? `(() => { const md = navigator.mediaDevices, gum = md.getUserMedia.bind(md);
      md.getUserMedia = (c) => { const v = { ...(c.video || {}) }; delete v.width; delete v.height; return gum({ ...c, video: v }); };
      const T = MediaStreamTrack.prototype, ac = T.applyConstraints;
      T.applyConstraints = function (c) { return ac.call(this, c && (c.width || c.height) ? c : { ...(c || {}), width: { ideal: 4000 }, height: { ideal: 4000 } }); }; })();` : '';
    const p = await page(`${BASE}/receive.html`, PRELUDE + ';' + strip, SIZE_PORT);
    await p.evaluate(`document.getElementById('go').click(), true`);
    await sleep(3500);
    // the zoom steps and the focus set have run (each a constraint set of its own)
    const zooms = await p.evaluate(`window.__applied.filter((a) => a.zoom != null || a.focusMode).length`);
    const r = JSON.parse(await p.evaluate(`JSON.stringify({ vw: document.getElementById('video').videoWidth, vh: document.getElementById('video').videoHeight,
      st: (() => { const s = document.getElementById('video').srcObject.getVideoTracks()[0].getSettings(); return [s.width, s.height]; })(),
      dcam: ${text('d-camera')}, sized: window.__sized, cam: !document.getElementById('cam').hidden })`));
    const px = r.st[0] * r.st[1];
    check(r.cam && px > 0 && px <= MAX_PX && r.vw * r.vh <= MAX_PX && r.dcam.startsWith(`${r.st[0]}x${r.st[1]}`),
      `a ${w}x${h} camera${ignoresSize ? ' that ignores the size asked for' : ''}: after ${zooms} focus and zoom changes, at ${r.st[0]}x${r.st[1]} (${(px / 1e6).toFixed(2)} MP; video ${r.vw}x${r.vh}; Details "${r.dcam}"; sizes applied ${JSON.stringify(r.sized)})`);
    check(p.errors.length === 0, `no page errors (${p.errors.join(' | ')})`);
    await p.close();
  } finally {
    try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
    await sleep(500);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
    try { rmSync(file, { force: true }); } catch {}
  }
}
for (const [w, h, ignores] of [[1920, 1080, false], [2448, 3264, false], [2448, 3264, true]]) {
  try { await fakeCamera(w, h, ignores); } catch (e) { check(false, `fake camera ${w}x${h}: ${e.stack || e}`); }
}

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

// The receiver page and its decode worker never wait on each other forever: the worker answers every message (an
// unknown one with an error), states its protocol in `ready`, decodes an I420 VideoFrame, and the development
// server forbids caching (a stale cached worker once ignored the page's new frames and froze the receiver).
//
//   python web/serve.py                       (in another shell; port 8765)
//   node web/tests/receiver-worker.mjs        (uses a test Chrome on port 9334, see show-sender.mjs)
const PORT = Number(process.env.CDP_PORT || 9334);
const BASE = process.env.BASE || 'http://localhost:8765';
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

for (const f of ['receive-worker.js', 'receive.html', 'receive-pool.js', 'pkg/lensbolt_web.js', 'pkg/lensbolt_web_bg.wasm']) {
  const r = await fetch(`${BASE}/${f}`, { method: 'HEAD' });
  check(/no-store/.test(r.headers.get('cache-control') || ''), `${f} is served with Cache-Control: no-store`);
}

const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${BASE}/receive.html`, { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pend = new Map();
ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
const evaluate = (expression) => new Promise((res) => { const i = ++id; pend.set(i, (m) => res(m.result?.result?.value ?? JSON.stringify({ exception: m.result?.exceptionDetails?.exception?.description || m.result?.exceptionDetails?.text || m.error }))); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } })); });
await new Promise((r) => setTimeout(r, 3000));
const out = JSON.parse(await evaluate(`(async () => {
  const w = window.lensboltWorker(), out = {};
  const ask = (msg, tr) => new Promise((res) => { w.onmessage = (e) => res(e.data); setTimeout(() => res(null), 4000); w.postMessage(msg, tr || []); });
  out.ready = await ask({ type: 'init', wasm: window.lensboltWasm });
  out.unknown = await ask({ type: 'no-such-message' });
  const W = 640, H = 480, f = new VideoFrame(new Uint8Array(W * H * 3 / 2).fill(128), { format: 'I420', codedWidth: W, codedHeight: H, timestamp: 0 });
  out.frame = await ask({ type: 'vframe', frame: f, t: performance.now() }, [f]);
  // a reader worker: the same frame as a record, which the decode worker (as the collector) takes as its own read
  const r = window.lensboltWorker();
  const askR = (msg, tr) => new Promise((res) => { r.onmessage = (e) => res(e.data); setTimeout(() => res(null), 4000); r.postMessage(msg, tr || []); });
  out.rready = await askR({ type: 'init', role: 'reader', wasm: window.lensboltWasm });
  const g = new VideoFrame(new Uint8Array(W * H * 3 / 2).fill(128), { format: 'I420', codedWidth: W, codedHeight: H, timestamp: 1 });
  const read = await askR({ type: 'vframe', frame: g, t: performance.now(), seq: 7, hint: null }, [g]);
  out.read = read && { type: read.type, seq: read.seq, ok: read.ok, bytes: read.record && read.record.length, magic: read.record && String.fromCharCode(...read.record.slice(0, 4)), camera: read.camera, hint: read.hint };
  out.runknown = await askR({ type: 'no-such-message', seq: 8 });
  out.collected = read && read.record ? await ask({ type: 'read', record: read.record, t: read.t, ms: read.ms, camera: read.camera, frame: read.frame, seq: read.seq }, [read.record.buffer]) : null;
  out.bad = await ask({ type: 'read', record: new Uint8Array([1, 2, 3]), t: performance.now(), ms: 0, camera: 'x', frame: [1, 1], seq: 9 });
  r.terminate();
  w.terminate();
  return JSON.stringify(out);
})()`));
check(out.ready && out.ready.type === 'ready' && out.ready.proto === 2, `ready states protocol 2 (${JSON.stringify(out.ready)})`);
check(out.unknown && out.unknown.type === 'status' && /unknown message/.test(out.unknown.status.error || ''), `an unknown message gets an error reply (${JSON.stringify(out.unknown)})`);
check(out.frame && out.frame.type === 'status' && /I420/.test(out.frame.status.camera || '') && out.frame.status.frames === 1, `an I420 VideoFrame is decoded (${JSON.stringify(out.frame && out.frame.status && { camera: out.frame.status.camera, frames: out.frame.status.frames, err: out.frame.status.last_error })})`);
check(out.frame && out.frame.status && out.frame.status.sender_fps === 0, `the status carries the sender's frame rate, 0 until known (${out.frame && out.frame.status && out.frame.status.sender_fps})`);
{
  const st = out.frame && out.frame.status;
  check(st && (st.storage !== 'opfs' || typeof st.store_bytes === 'number') && 'disk_peak' in st && st.receiver_error === null, `the status carries what the page's stop rules read: store_bytes, disk_peak, receiver_error (${JSON.stringify(st && { storage: st.storage, store_bytes: st.store_bytes, disk_peak: st.disk_peak, receiver_error: st.receiver_error })})`);
}
check(out.rready && out.rready.type === 'ready' && out.rready.role === 'reader' && out.rready.proto === 2, `a reader states its role and protocol (${JSON.stringify(out.rready)})`);
check(out.read && out.read.type === 'read' && out.read.seq === 7 && out.read.ok === false && out.read.magic === 'LBr1' && out.read.bytes > 5 && /I420/.test(out.read.camera) && out.read.hint === null, `a reader answers a frame with its record, under the frame's number (${JSON.stringify(out.read)})`);
check(out.runknown && out.runknown.type === 'read' && out.runknown.seq === 8 && /unknown message/.test(out.runknown.error || ''), `a reader answers an unknown message under its number, with an error (${JSON.stringify(out.runknown)})`);
{
  const st = out.collected && out.collected.status;
  check(st && st.frames === 2 && st.failed === 2 && st.seq === 7 && /I420/.test(st.camera || '') && st.last_error === out.frame.status.last_error, `the collector takes the record as a frame read (${JSON.stringify(st && { frames: st.frames, failed: st.failed, seq: st.seq, err: st.last_error })})`);
  const bad = out.bad && out.bad.status;
  check(bad && bad.frames === 3 && bad.last_error === 'BadRecord', `a damaged record is counted and named, not decoded (${JSON.stringify(bad && { frames: bad.frames, err: bad.last_error })})`);
}
await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`);
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

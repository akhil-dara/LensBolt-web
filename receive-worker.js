// LensBolt receiver worker: camera frames in (VideoFrame, or ImageBitmap where there is none; transferred), decode in WebAssembly, status and the
// verified file out. One frame at a time: the page sends a new frame only after the status of the last one,
// so the camera never queues behind the decoder (frames in between are skipped; the fountain code does not
// mind which arrive).
// Two more roles where the device has cores to spare (web/receive-pool.js): a reader (init with role 'reader') reads
// the frames it is given into compact records (WebReader) and holds no file; the collector (this worker as above)
// takes those records ('read') into the receiver, the same status as reading the frames itself.
import init, { WebReceiver, WebReader, WebSender, WebFiles } from './pkg/lensbolt_web.js';

let rx = null, canvas = null, ctx = null, stores = null, planes = null, reader = null;
// the message protocol between the page and this worker; the page refuses a worker that states another one
const PROTO = 2;

// Large files never sit in memory: the stream and the file go to two Origin Private File System files through
// sync access handles (worker-only, random access), opened before the session so the decoder can write
// synchronously. Browsers without them get the in-memory receiver.
const STORE_NAMES = ['lb-part', 'lb-file'];
// ?memory on the page: no OPFS (the receiver of a browser without it), for tests
let memoryOnly = false;
async function openStores() {
  try {
    if (memoryOnly || !navigator.storage || !navigator.storage.getDirectory) return null;
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('lensbolt', { create: true });
    const files = await Promise.all(STORE_NAMES.map((n) => dir.getFileHandle(n, { create: true })));
    if (!files[0].createSyncAccessHandle) return null;
    const h = await Promise.all(files.map((f) => f.createSyncAccessHandle()));
    self.lbStore = {
      write: (slot, at, data) => { if (h[slot].write(data, { at }) !== data.length) throw 'storage is full'; },
      read: (slot, at, buf) => { if (h[slot].read(buf, { at }) !== buf.length) throw 'short read from storage'; },
      truncate: (slot, len) => h[slot].truncate(len),
    };
    return h;
  } catch (err) { return null; }
}
// bytes the stores hold now (counted in the browser's storage usage; the page's space check reuses them)
function storeBytes() { let n = 0; if (stores) for (const h of stores) { try { n += h.getSize(); } catch (e) {} } return n; }
function closeStores() { if (stores) { for (const h of stores) { try { h.flush(); h.close(); } catch (e) {} } stores = null; } }
// A batch's files, each in an OPFS file of its own (lensbolt/batch/f1, f2, ...) once it is saved: the receiver writes
// it into the second store, and between frames it is copied here (the page reads these files at any time; the stores
// change with every frame, and a browser refuses to read a file that changed after it was opened). In memory without
// OPFS. Emptied when a new transfer starts.
// `gen`: this receiver's run (a new one with every new receiver), on 'ready', 'saved' and 'batch-done': the page ignores a
// message of a run before (a copy finishing after Receive another); it starts anywhere, so two workers never agree by chance
let batchDir = null, seq = 0, batchDone = false, batchComplete = false, lastReceived = -1, copies = [], copying = false, gen = Math.floor(Math.random() * 1e9);
async function newBatchDir() {
  batchDir = null; seq = 0; batchDone = false; batchComplete = false; lastReceived = -1; copies = []; gen++;
  if (!stores) return;
  try {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('lensbolt', { create: true });
    try { await dir.removeEntry('batch', { recursive: true }); } catch (e) {}
    batchDir = await dir.getDirectoryHandle('batch', { create: true });
  } catch (e) { batchDir = null; }
}
// where this receiver keeps the file ('opfs' or 'memory'), as it started: the stores close once the file is delivered,
// and records a reader sent before then are still answered
let storeKind = 'memory';
async function newReceiver() {
  closeStores();
  stores = await openStores();
  storeKind = stores ? 'opfs' : 'memory';
  await newBatchDir();
  return stores ? WebReceiver.with_opfs() : new WebReceiver();
}
const COPY = 1 << 20;
// one saved file out of the second store into its own OPFS file; a large file lets the frames through every 32 MiB
async function copyOut(r, g) {
  const store = `f${++seq}`;
  try {
    if (!batchDir) throw new Error('no device storage');
    const h = await (await batchDir.getFileHandle(store, { create: true })).createSyncAccessHandle();
    try {
      const buf = new Uint8Array(Math.min(COPY, r.size));
      for (let at = 0; at < r.size; at += COPY) {
        if (at && at % (32 * COPY) === 0) await new Promise((res) => setTimeout(res, 0));
        const piece = buf.subarray(0, Math.min(COPY, r.size - at));
        if (stores[1].read(piece, { at: r.at + at }) !== piece.length) throw new Error('short read from storage');
        if (h.write(piece, { at }) !== piece.length) throw new DOMException('storage is full', 'QuotaExceededError');
      }
      h.truncate(r.size); h.flush();
    } finally { h.close(); }
    self.postMessage({ type: 'saved', name: r.name, store, size: r.size, gen: g });
  } catch (err) {
    self.postMessage({ type: 'saved', name: r.name, size: r.size, gen: g, error: err && err.name === 'QuotaExceededError' ? 'storage full' : String(err && err.message || err) });
  }
}
// after each frame of a batch: the files saved by it handed to the page (copied out in the background, between
// frames: a frame's status never waits for them), and the end of the batch said once every file is handed over
function afterPush(status) {
  const b = status.batch;
  if (!b) return;
  if (stores) { copies.push(...JSON.parse(rx.take_regions())); copyAll(); }
  else if (b.received !== lastReceived) {
    lastReceived = b.received;
    for (const [index, name, bytes] of rx.take_received_files()) self.postMessage({ type: 'saved', index, name, size: bytes.length, bytes, gen }, [bytes.buffer]);
  }
  if (status.complete) { batchComplete = true; doneIfCopied(); }
}
function doneIfCopied() { if (batchComplete && !batchDone && !copying && !copies.length) { batchDone = true; self.postMessage({ type: 'batch-done', gen }); } }
async function copyAll() {
  if (copying) return;
  copying = true;
  const g = gen;
  try {
    while (copies.length && g === gen) { const r = copies.shift(); await copyOut(r, g); if (g === gen) rx.release_region(r.name); }
  } finally { copying = false; }
  if (g === gen) doneIfCopied();
}

function deliver(extra) {
  if (stores) {
    const slot = rx.stored_slot();
    if (slot < 0) return;
    const name = rx.stored_name();
    closeStores();
    self.postMessage({ type: 'stored', name, store: STORE_NAMES[slot], ...extra });
  } else {
    const bytes = rx.take_file();
    if (bytes.length) self.postMessage({ type: 'file', name: rx.file_name(), bytes, ...extra }, [bytes.buffer]);
  }
}

// A camera frame's pixels, copied out and the frame closed at once (a frame held through the decode holds one of the
// camera's few capture buffers: R readers holding R of them starve the camera and the preview). The planes in the
// frame's coded orientation, whatever it shows: an Android camera held upright gives a landscape NV12 frame tagged
// `rotation` 90 (Chrome draws it turned, copyTo does not); the decoder reads the tile at any turn, and `rotation` goes
// with the result so the page turns the tile's corners into the picture it shows.
//   I420: copyTo as it is. NV12 (Chrome's camera frames, the fake camera's too): copyTo, the interleaved UV split
//   into U and V behind it (~1 MB). Anything else (RGBA, BGRA...): copyTo as RGBA where the browser converts, else a
//   canvas the size the frame shows (drawImage draws it turned: rotation 0 from there).
let nv = null;
async function framePlanes(f) {
  const w = f.visibleRect ? f.visibleRect.width : f.codedWidth, h = f.visibleRect ? f.visibleRect.height : f.codedHeight;
  const rotation = ((f.rotation || 0) % 360 + 360) % 360, format = f.format;
  try {
    if (format === 'I420' || format === 'I420A') {
      const size = f.allocationSize();
      if (!planes || planes.length < size) planes = new Uint8Array(size);
      const layout = await f.copyTo(planes);
      return { kind: 'i420', buf: planes, w, h, rotation, format, layout: Uint32Array.from(layout.slice(0, 3).flatMap((p) => [p.offset, p.stride])) };
    }
    if (format === 'NV12') {
      const size = f.allocationSize(), cw = (w + 1) >> 1, ch = (h + 1) >> 1;
      if (!planes || planes.length < size + 2 * cw * ch) planes = new Uint8Array(size + 2 * cw * ch);
      const [y, uv] = await f.copyTo(planes);
      f.close();
      const uo = size, vo = size + cw * ch;
      for (let r = 0; r < ch; r++) {
        let s = uv.offset + r * uv.stride, u = uo + r * cw, v = vo + r * cw;
        for (let c = 0; c < cw; c++, s += 2) { planes[u + c] = planes[s]; planes[v + c] = planes[s + 1]; }
      }
      return { kind: 'i420', buf: planes, w, h, rotation, format, layout: Uint32Array.from([y.offset, y.stride, uo, cw, vo, cw]) };
    }
    try {
      const size = f.allocationSize({ format: 'RGBA' });
      if (!rgbaBuf || rgbaBuf.length < size) rgbaBuf = new Uint8Array(size);
      await f.copyTo(rgbaBuf, { format: 'RGBA' });
      return { kind: 'rgba', buf: rgbaBuf.subarray(0, w * h * 4), w, h, rotation, format };
    } catch (e) {
      const dw = f.displayWidth || w, dh = f.displayHeight || h;
      if (!canvas || canvas.width !== dw || canvas.height !== dh) { canvas = new OffscreenCanvas(dw, dh); ctx = canvas.getContext('2d', { willReadFrequently: true }); }
      ctx.drawImage(f, 0, 0, dw, dh);
      return { kind: 'rgba', buf: ctx.getImageData(0, 0, dw, dh).data, w: dw, h: dh, rotation: 0, format };
    }
  } finally { f.close(); }
}
let rgbaBuf = null;
// the frame's record for a reader
async function readFrame(f) {
  const p = await framePlanes(f);
  const t0 = performance.now();
  const record = p.kind === 'i420' ? reader.read_i420(p.buf, p.w, p.h, p.layout) : reader.read_rgba(p.buf, p.w, p.h);
  return { record, ms: performance.now() - t0, camera: `${p.w}x${p.h} ${p.format}${p.rotation ? ` turned ${p.rotation}` : ''}`, frame: [p.w, p.h], rotation: p.rotation };
}
function readBitmap(bmp) {
  const { width, height } = bmp;
  if (!canvas || canvas.width !== width || canvas.height !== height) { canvas = new OffscreenCanvas(width, height); ctx = canvas.getContext('2d', { willReadFrequently: true }); }
  ctx.drawImage(bmp, 0, 0);
  const px = ctx.getImageData(0, 0, width, height).data;
  const t0 = performance.now();
  const record = reader.read_rgba(px, width, height);
  return { record, ms: performance.now() - t0, camera: `${width}x${height}`, frame: [width, height] };
}
// a reader's messages: each frame back as a record, with this reader's geometry when the frame showed the tile
async function onReader(m) {
  if (m.type === 'vframe' || m.type === 'frame') {
    const src = m.frame || m.bitmap;
    let r;
    try {
      if (m.hint === 'clear') reader.clear_hint(); else if (m.hint) reader.set_hint(m.hint);
      r = m.frame ? await readFrame(src) : readBitmap(src);
    } catch (err) {
      self.postMessage({ type: 'read', seq: m.seq, t: m.t, ok: false, error: String(err && err.message || err) });
      return;
    } finally { src.close(); }
    const ok = reader.last_ok();
    // the geometry is copied to the page (it may go on to several readers); the record is handed over
    self.postMessage({ type: 'read', seq: m.seq, t: m.t, ok, hint: ok ? reader.hint() : null, ...r }, [r.record.buffer]);
  } else if (m.type === 'reset') {
    reader.free(); reader = new WebReader();
    self.postMessage({ type: 'ready', proto: PROTO, role: 'reader' });
  } else self.postMessage({ type: 'read', seq: m.seq, ok: false, error: `unknown message: ${m.type}` });
}

self.onmessage = async (event) => {
  const m = event.data;
  if (reader && m.type !== 'init') {
    try { await onReader(m); } catch (err) { self.postMessage({ type: 'read', seq: m.seq, ok: false, error: String(err && err.message || err) }); }
    return;
  }
  try {
    if (m.type === 'init' && m.role === 'reader') {
      await init(m.wasm ? { module_or_path: m.wasm } : undefined);
      reader = new WebReader();
      self.postMessage({ type: 'ready', proto: PROTO, role: 'reader' });
    } else if (m.type === 'read') {
      // a reader's record of a frame: into the receiver, as if this worker had read the frame
      const status = JSON.parse(rx.push_read(m.record, m.t));
      status.decode_ms = m.ms;
      status.camera = m.camera;
      status.frame = m.frame;
      status.rotation = m.rotation || 0;
      status.seq = m.seq;
      status.storage = storeKind; status.store_bytes = storeBytes();
      afterPush(status);
      if (status.complete) deliver({ sha256: status.sha256 });
      self.postMessage({ type: 'status', status });
    } else if (m.type === 'init') {
      await init(m.wasm ? { module_or_path: m.wasm } : undefined);
      memoryOnly = !!m.memory;
      rx = await newReceiver();
      self.postMessage({ type: 'ready', proto: PROTO, storage: stores ? 'opfs' : 'memory', gen });
    } else if (m.type === 'vframe') {
      // the camera's own planes (VideoFrame.copyTo): ~8 ms on a phone where an RGBA readback takes 300+ ms;
      // black/white tiles decode from Y alone, colour frames convert the planes only when they need it
      const p = await framePlanes(m.frame);
      const t0 = performance.now();
      const status = JSON.parse(p.kind === 'i420' ? rx.push_i420(p.buf, p.w, p.h, p.layout, m.t) : rx.push(p.buf, p.w, p.h, m.t));
      status.decode_ms = performance.now() - t0;
      status.camera = `${p.w}x${p.h} ${p.format}${p.rotation ? ` turned ${p.rotation}` : ''}`;
      status.frame = [p.w, p.h];
      status.rotation = p.rotation;
      status.storage = stores ? 'opfs' : 'memory'; status.store_bytes = storeBytes();
      afterPush(status);
      if (status.complete) deliver({ sha256: status.sha256 });
      self.postMessage({ type: 'status', status });
    } else if (m.type === 'frame') {
      const bmp = m.bitmap;
      const { width, height } = bmp;
      if (!canvas || canvas.width !== width || canvas.height !== height) {
        canvas = new OffscreenCanvas(width, height);
        ctx = canvas.getContext('2d', { willReadFrequently: true });
      }
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      const pixels = ctx.getImageData(0, 0, width, height).data;
      const t0 = performance.now();
      const status = JSON.parse(rx.push(pixels, width, height, m.t));
      status.decode_ms = performance.now() - t0;
      status.camera = `${width}x${height}`;
      status.frame = [width, height];
      status.storage = stores ? 'opfs' : 'memory'; status.store_bytes = storeBytes();
      afterPush(status);
      if (status.complete) deliver({ sha256: status.sha256 });
      self.postMessage({ type: 'status', status });
    } else if (m.type === 'page') {
      // a page of the batch's file list, for the rows the page shows
      self.postMessage({ type: 'page', id: m.id, json: rx.batch_page(m.offset, m.count) });
    } else if (m.type === 'selftest') {
      // a simulated sender inside the worker: the page's whole flow and the browser's real decode speed,
      // without a camera (the frames are perfect, so this measures the decoder, not the optics)
      const data = new Uint8Array(m.bytes);
      crypto.getRandomValues(data.subarray(0, Math.min(65536, data.length)));
      for (let i = 65536; i < data.length; i += 65536) data.set(data.subarray(0, Math.min(65536, data.length - i)), i);
      // files > 1: a batch of that many (sizes 0 to ~30 KB, or 600 B past 1,000 files), the bytes taken from `data`
      let sender;
      if (m.files > 1) {
        const fs = new WebFiles(), ids = [];
        for (let i = 0; i < m.files; i++) {
          // small files for a big batch; file 1 empty, file 2 the same name as file 0, file 3 a long name
          const size = i === 1 ? 0 : (i * 7919) % Math.min(m.files > 1000 ? 600 : 30000, data.length - 97);
          const name = i === 2 ? 'photo-0000.jpg' : i === 3 ? 'holiday-photo-from-the-beach-at-sunset-with-everyone-and-the-dog-and-the-cat-in-the-evening-light.jpeg' : `photo-${String(i).padStart(4, '0')}.jpg`;
          const id = fs.begin(name, size); fs.append(id, data.subarray(i % 97, i % 97 + size)); fs.finish(id); ids.push(id);
        }
        sender = WebSender.from_files(fs, Uint32Array.from(ids), 1024, 1024, '', false);
      } else sender = new WebSender('self-test.bin', data, 1024, 1024, '', false);
      const t0 = performance.now();
      for (let n = 0; !rx.is_complete(); n++) {
        const rgba = sender.next_frame_rgba();
        const t = performance.now();
        // the clock is the slower of a 30 fps display and this decoder: the rate shown is one this browser
        // really reaches when every frame arrives (never faster than the display shows frames)
        const status = JSON.parse(rx.push(rgba, 1024, 1024, Math.max(t0 + n * 1000 / 30, performance.now())));
        status.decode_ms = performance.now() - t;
        status.camera = 'self-test (simulated sender, perfect frames)';
        status.frame = [1024, 1024];
        status.storage = stores ? 'opfs' : 'memory'; status.store_bytes = storeBytes();
        afterPush(status);
        if (status.complete) {
          // the page compares the delivered file with what the simulated sender sent
          deliver({ sha256: status.sha256, selftest: { expected: data, wall_ms: performance.now() - t0 } });
        }
        self.postMessage({ type: 'status', status });
        await new Promise((r) => setTimeout(r, 0));
      }
    } else if (m.type !== 'reset') {
      // never leave the page waiting: an unknown message is answered with an error
      self.postMessage({ type: 'status', status: { error: `unknown message: ${m.type}` } });
    } else {
      if (rx) rx.free();
      rx = await newReceiver();
      self.postMessage({ type: 'ready', proto: PROTO, storage: stores ? 'opfs' : 'memory', gen });
    }
  } catch (err) {
    // one bad frame never stops the session: report it and keep going (under a record's number: the page counts it answered)
    self.postMessage({ type: 'status', status: { error: String(err && err.message || err), seq: m.seq } });
  }
};

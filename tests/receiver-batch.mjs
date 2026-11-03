// The browser receiver's batch view in a real (headless) Chrome, through the self-test's simulated sender sending a
// batch (?selftest&files=N): the summary in real numbers, the filters, the list drawing only the rows in view (10,000
// files), full names shortened in the middle only when they do not fit (the extension kept), each file saved as it
// arrives and from the Done screen, Save all into a folder (" (2)" for a name taken there) and as a stored zip (read
// back by Python's zipfile), rows read aloud. Fix round 1: Done counts from the whole list even with a page request in
// flight; "save the files received so far" takes every kept file (past the fetched rows); a stopped run leaves nothing
// behind for the next one (stale messages ignored); a copy that hit a full storage is never "all verified"; keyboard
// focus stays with its file while the list scrolls; a failed folder save leaves no empty file; focus never lands on a
// disabled Save. The page-level cases without a real sender use a scripted worker (?fakebatch).
//
//   python web/serve.py                       (in another shell; port 8765)
//   node web/tests/receiver-batch.mjs         (its own headless Chrome on CDP_PORT, default 9334, stopped by its PID)
//   SHOTS=docs/screens/web ...                (also writes screenshots)   BIG=0 skips the 10,000-file batch
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
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

const PRELUDE = `(() => {
  const q = new URLSearchParams(location.search);
  if (q.has('slowpages')) {
    const pm = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (m, t) { if (m && m.type === 'page' && m.count > 1) { setTimeout(() => pm.call(this, m, t), 6000); return; } return pm.call(this, m, t); };
  }
  if (!q.has('fakebatch')) return;
  const F = window.__fake = { gen: 1, status: null, list: [], collector: null };
  const make = () => {
    const w = { onmessage: null, dead: false, terminate() { w.dead = true; }, addEventListener() {} };
    const reply = (d) => setTimeout(() => { if (!w.dead && w.onmessage) w.onmessage({ data: d }); }, 5);
    w.postMessage = (m) => {
      if (m.frame) m.frame.close();
      if (m.bitmap) m.bitmap.close();
      // a reader that does not start: the page reads with its single worker
      if (m.type === 'init' && m.role === 'reader') return reply({ type: 'ready', proto: 2 });
      if (m.type === 'init' || m.type === 'reset') { F.collector = w; return reply({ type: 'ready', proto: 2, storage: 'opfs', gen: F.gen }); }
      if (m.type === 'page') return reply({ type: 'page', id: m.id, gen: F.gen, json: JSON.stringify({ offset: m.offset, total: F.list.length, files: F.list.slice(m.offset, m.offset + m.count) }) });
      if ((m.type === 'vframe' || m.type === 'frame') && F.status) return reply({ type: 'status', status: { ...F.status } });
    };
    return w;
  };
  F.emit = (d) => F.collector.onmessage({ data: d });
  Object.defineProperty(window, 'lensboltWorker', { get: () => make, set: () => {}, configurable: false });
})()`;

try { await fetch(`http://127.0.0.1:${PORT}/json/version`); throw new Error(`port ${PORT} is already in use: stop that browser first`); } catch (e) { if (/in use/.test(e.message)) throw e; }
const profile = tempProfile('lb-batch-');
const downloads = tempProfile('lb-batch-dl-');
const chrome = ownChrome(spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-color-profile=srgb', '--window-size=800,1000', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', 'about:blank'], { stdio: 'ignore' }));
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
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: false });
  const { targetInfos } = await send('Target.getTargets');
  const { sessionId: S } = await send('Target.attachToTarget', { targetId: targetInfos.find((t) => t.type === 'page').targetId, flatten: true });
  await send('Page.enable', {}, S); await send('Runtime.enable', {}, S);
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, S);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expr, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await evaluate(expr).catch(() => false)) return true; await sleep(100); } return false; };
  const shot = async (name) => { if (!SHOTS) return; const { data } = await send('Page.captureScreenshot', { format: 'png' }, S); writeFileSync(join(SHOTS, name), Buffer.from(data, 'base64')); console.log('     wrote', join(SHOTS, name)); };
  const text = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const shown = (id) => evaluate(`(() => { const e = document.getElementById(${JSON.stringify(id)}); return !e.hidden && e.getClientRects().length > 0; })()`);
  const rows = () => evaluate(`[...document.querySelectorAll('#fspace .frow')].filter((r) => !r.hidden).map((r) => ({ name: r.querySelector('.fname').textContent, title: r.querySelector('.fname').title, meta: r.querySelector('.fmeta').textContent, label: r.getAttribute('aria-label'), save: !r.querySelector('.fsave').hidden, top: parseFloat(r.style.top) }))`);
  const domRows = () => evaluate(`document.querySelectorAll('#fspace .frow').length`);
  const waitFile = async (name, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { const p = join(downloads, name); if (existsSync(p) && !readdirSync(downloads).some((f) => f.endsWith('.crdownload'))) return statSync(p).size; await sleep(100); } return -1; };
  const filter = (f) => evaluate(`document.querySelector('#filters [data-f="${f}"]').click(), true`);

  // before every page: ?slowpages answers the worker's list pages 6 s late (a refresh in flight when the batch ends);
  // ?fakebatch replaces the decode worker with a scripted one the test drives (window.__fake)
  await send('Page.addScriptToEvaluateOnNewDocument', { source: PRELUDE }, S);
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true }, S);
  const key = async (k) => { const code = { Tab: 9, Enter: 13 }[k]; for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, ...(k === 'Enter' && type === 'keyDown' ? { text: '\r' } : {}) }, S); };

  // ---- Done with a list page in flight: the counts from the whole list, Save all enabled ----
  await send('Page.navigate', { url: `${BASE}/${PAGE}?selftest=3&files=40&slowpages` }, S);
  check(await until(`!document.getElementById('batch').hidden`), 'slow list pages: the batch shows');
  await evaluate(`document.getElementById('batch-toggle').click(), true`);
  check(await until(`!document.getElementById('done').hidden`, 90000), 'slow list pages: Done');
  check(await until(`/^40 files · .+ · all verified$/.test(document.getElementById('verified-text').textContent)`, 15000) && !(await evaluate(`document.getElementById('save').disabled`)),
    `slow list pages: Done counts the whole list, Save all enabled ("${await text('verified-text')}", disabled=${await evaluate(`document.getElementById('save').disabled`)})`);

  // ---- the start screen: three equal ways in, each with a picture saying what it shows, and How it works ----
  {
    await send('Page.navigate', { url: `${BASE}/${PAGE}` }, S);
    await until(`!!document.getElementById('go-webcam')`);
    const ways = await evaluate(`[...document.querySelectorAll('.ways .way')].map((b) => ({ id: b.id, name: document.getElementById(b.getAttribute('aria-labelledby')).textContent, alt: b.querySelector('img').alt, w: Math.round(b.getBoundingClientRect().width) }))`);
    check(ways.length === 3 && ways.map((w) => w.name).join('|') === 'Phone camera|Webcam|Share a window' && ways.every((w) => w.alt.length > 20) && new Set(ways.map((w) => w.w)).size === 1,
      `three equal choices with pictures (${ways.map((w) => `${w.id}: ${w.name}, ${w.w}px`).join('; ')})`);
    const how = await evaluate(`(() => { const d = document.getElementById('how'); return { open: d.open, text: d.textContent }; })()`);
    check(!how.open && /Phone camera/.test(how.text) && /Webcam, PC to PC/.test(how.text) && /Share a window, one computer/.test(how.text) && /Fastest/.test(how.text), 'How it works: collapsed, the three flows in words');
    await shot('receive-start-phone.png');
  }

  // ---- 40 files: while receiving, then Done ----

  await send('Page.navigate', { url: `${BASE}/${PAGE}?selftest=3&files=40` }, S);
  check(await until(`!document.getElementById('batch').hidden`), 'a batch: the summary line under the bar');
  const live = await text('batch-sum');
  check(/^(Waiting for the file list|\d+ of 40 files · .+ of .+)$/.test(live), `while receiving: "${live}"`);
  await evaluate(`document.getElementById('batch-toggle').click(), true`);
  check(await shown('files') && await evaluate(`document.getElementById('batch-toggle').getAttribute('aria-expanded')`) === 'true', 'Show files opens the list while receiving');
  check(await until(`!document.getElementById('done').hidden`), 'the batch completes: Done');
  await sleep(300);
  const name = await text('done-name'), verified = await text('verified-text'), meta = await text('done-meta');
  check(name === 'photo-0000.jpg +39 more', `the batch's name in full: ${name}`);
  check(/^40 files · \d+(\.\d)? KB · all verified$/.test(verified), `the summary in real numbers: ${verified}`);
  check(/^\d+(\.\d)? KB in [\d.]+ s · [\d.]+ Mbit\/s$/.test(meta) && meta.split(' in ')[0] === verified.split(' · ')[1], `the size is the files' own, added up: ${meta}`);
  check(await text('save-text') === 'Save all' && await evaluate(`document.activeElement.id`) === 'save' && !(await shown('share')), 'Save all is the first action, focused');
  const tone = await evaluate(`({ warn: document.getElementById('done-title').classList.contains('warn'), icon: document.getElementById('done-icon').getAttribute('href'), guide: document.getElementById('guide').textContent, lock: document.getElementById('cam').dataset.lock })`);
  check(!tone.warn && tone.icon === '#i-check' && tone.guide === 'Received' && tone.lock === 'good', `all verified: the check, green, "Received" (${JSON.stringify(tone)})`);
  {
    await evaluate(`document.getElementById('again').click(), true`);
    check(await until(`document.getElementById('ask-dlg').open`, 3000) && await text('ask-dlg-t') === 'Discard 40 received files?' && await evaluate(`document.activeElement.id`) === 'ask-dlg-yes' && await text('ask-dlg-yes') === 'Keep them',
      `Receive another with files not saved asks first, Keep them focused ("${await text('ask-dlg-t')}")`);
    const order = await evaluate(`[...document.querySelectorAll('#ask-dlg .row button')].map((b) => b.id).join(',')`);
    check(order === 'ask-dlg-no,ask-dlg-yes', `the safe choice last (${order})`);
    await evaluate(`document.getElementById('ask-dlg-yes').click(), true`);
    check(!(await evaluate(`document.getElementById('ask-dlg').open`)) && await shown('done'), 'Keep them: the Done screen stays');
  }
  const counts = await evaluate(`['all', 'received', 'missing', 'failed'].map((k) => document.getElementById('n-' + k).textContent).join(',')`);
  check(await shown('files') && counts === '40,40,0,0', `the list and the filters with their counts, on Done (${counts})`);
  const r40 = await rows();
  check(r40.length > 0 && r40.length < 20 && await domRows() < 20, `only the rows in view exist (${await domRows()} of 40)`);
  const empty = r40.find((r) => r.meta.startsWith('0 B'));
  check(!!empty && empty.meta === '0 B · Received' && empty.save, `a 0-byte file: received, can be saved (${empty && empty.title})`);
  check(r40.every((r) => r.label === `${r.title}, ${r.meta.split(' · ')[0]}, received`), `rows read aloud: "${r40[0].label}"`);
  const bdg = await evaluate(`(() => { const r = [...document.querySelectorAll('#fspace .frow')].find((x) => !x.hidden); const b = r.querySelector('.badge'); return { cls: b.className, icon: b.querySelector('use').getAttribute('href'), text: b.textContent, button: b.closest('button') !== null, labels: [...r.querySelectorAll('button:not([hidden]) span')].map((x) => x.textContent).join(',') }; })()`);
  check(bdg.cls === 'badge ok' && bdg.icon === '#i-check' && bdg.text === 'Received' && !bdg.button && bdg.labels.startsWith('SHA,Save'), `a row: a state badge (icon and words, not a button), its actions labelled (${JSON.stringify(bdg)})`);
  // the long name: whole when it fits two lines, else shortened in the middle with the extension kept
  const longRow = await evaluate(`(async () => { const l = document.getElementById('flist'); for (let i = 0; i < 40; i++) { const r = [...document.querySelectorAll('#fspace .frow')].find((x) => !x.hidden && x.querySelector('.fname').title.startsWith('holiday')); if (r) { const n = r.querySelector('.fname'); return { text: n.textContent, title: n.title, lines: Math.round(n.scrollHeight / parseFloat(getComputedStyle(n).lineHeight)), over: n.scrollHeight > n.clientHeight + 1 }; } l.scrollTop += 200; await new Promise((q) => requestAnimationFrame(() => requestAnimationFrame(q))); } return null; })()`);
  check(!!longRow && longRow.text.endsWith('.jpeg') && longRow.text.includes('…') && longRow.text.startsWith('holiday-photo') && longRow.lines <= 2 && !longRow.over, `a long name: two lines at most, the middle shortened, the extension kept: "${longRow && longRow.text}"`);
  const short = r40.find((r) => r.title === r.name && /^photo-\d{4}\.jpg$/.test(r.title));
  check(!!short, `a name that fits is whole (${short && short.name})`);
  await evaluate(`document.getElementById('flist').scrollTop = 0, true`); await sleep(200);
  await shot('receive-batch-done-phone.png');
  // a short phone: Save all stays on screen, the sheet scrolls to the list
  await send('Emulation.setDeviceMetricsOverride', { width: 360, height: 640, deviceScaleFactor: 2, mobile: true }, S);
  await sleep(300);
  const sp = await evaluate(`(() => { const s = document.getElementById('save').getBoundingClientRect(), sh = document.getElementById('sheet'); return { save: s.top, bottom: s.bottom, vh: innerHeight, scrolls: sh.scrollHeight > sh.clientHeight, sheetTop: sh.getBoundingClientRect().top }; })()`);
  check(sp.save >= 0 && sp.bottom <= sp.vh && sp.sheetTop >= 0, `360x640: Save all in view (${Math.round(sp.save)}-${Math.round(sp.bottom)} of ${sp.vh}), the sheet within the screen${sp.scrolls ? ', scrolling to the list' : ''}`);
  await shot('receive-batch-done-short.png');
  await send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true }, S);
  await sleep(200);
  // filters
  await filter('missing'); await sleep(300);
  check((await rows()).length === 0 && await shown('fnone') && await text('fnone') === 'No file missing.', 'Missing: none, said so');
  await filter('received'); await sleep(300);
  check((await rows()).length > 0 && (await rows()).every((r) => r.meta.endsWith('Received')), 'Received: received files only');
  await filter('all'); await sleep(300);

  // ---- the keyboard: Tab through the rows' Save buttons while the list scrolls; Enter saves the file focused ----
  {
    await evaluate(`document.getElementById('flist').scrollTop = 0, document.getElementById('save').focus(), true`);
    const focusRow = `(() => { const a = document.activeElement, r = a && a.closest('.frow'); return r ? { cls: a.className, name: r.dataset.name, title: r.querySelector('.fname').title } : null; })()`;
    const seen = [], wrong = [];
    for (let i = 0; i < 80 && seen.length < 14; i++) {
      await key('Tab'); await sleep(60);
      const f = await evaluate(focusRow);
      if (!f || f.cls !== 'fsave') continue;
      seen.push(f.title);
      await sleep(150);
      const again = await evaluate(focusRow);
      if (!again || again.title !== f.title || again.name !== f.title) wrong.push(`${f.title} -> ${again && again.title}`);
    }
    const last = seen.at(-1);
    check(seen.length >= 12 && new Set(seen).size === seen.length && wrong.length === 0, `Tab through ${seen.length} rows' Save as the list scrolls: each keeps its file (${wrong.join('; ') || 'no change'}; ${new Set(seen).size} different)`);
    await key('Enter');
    check(!!last && await waitFile(last) >= 0, `Enter on the focused row's Save saves that file (${last})`);
  }
  // ---- a folder save that fails for one file leaves nothing under its name ----
  {
    await evaluate(`(async () => { const root = await navigator.storage.getDirectory(); try { await root.removeEntry('picked3', { recursive: true }); } catch (e) {} const d = await root.getDirectoryHandle('picked3', { create: true });
      window.showDirectoryPicker = async () => ({ name: 'picked3', keys: () => d.keys(), removeEntry: (n) => d.removeEntry(n),
        getFileHandle: async (n, o) => { const h = await d.getFileHandle(n, o); return n === 'photo-0005.jpg' ? { createWritable: async () => { throw new Error('disk error'); } } : h; } }); return true; })()`);
    await evaluate(`document.getElementById('save').click(), true`);
    check(await until(`/^Saved 39 of 40 into picked3\\. Not saved: photo-0005\\.jpg/.test(document.getElementById('save-msg').textContent)`, 30000), `one file fails: said ("${await text('save-msg')}")`);
    const left = await evaluate(`(async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked3'); const n = []; for await (const k of d.keys()) n.push(k); return n; })()`);
    check(left.length === 39 && !left.includes('photo-0005.jpg'), `no empty file left under its name (${left.length} files, photo-0005.jpg ${left.includes('photo-0005.jpg') ? 'present' : 'absent'})`);
  }

  // ---- each file, and Save all ----

  const first = (await rows())[0];
  await evaluate(`[...document.querySelectorAll('#fspace .frow')].find((r) => !r.hidden).querySelector('.fsave').click(), true`);
  const firstSize = await waitFile(first.title);
  check(firstSize === Number(first.meta.split(' ')[0]) || firstSize >= 0, `a file's Save: downloaded as ${first.title} (${firstSize} B)`);
  // into a folder (a stand-in picker: an OPFS folder, where photo-0010.jpg is taken already)
  await evaluate(`(async () => { const root = await navigator.storage.getDirectory(); try { await root.removeEntry('picked', { recursive: true }); } catch (e) {} const d = await root.getDirectoryHandle('picked', { create: true }); const w = await (await d.getFileHandle('photo-0010.jpg', { create: true })).createWritable(); await w.write('mine'); await w.close(); window.showDirectoryPicker = async () => d; return true; })()`);
  await evaluate(`document.getElementById('save').click(), true`);
  check(await until(`/^Saved all 40 files into picked\\.$/.test(document.getElementById('save-msg').textContent)`, 30000), `Save all into a folder: "${await text('save-msg')}"`);
  check(await evaluate(`(() => { const t = document.getElementById('toast'); return !t.hidden && t.classList.contains('ok') && document.getElementById('toast-icon').getAttribute('href') === '#i-check' && document.getElementById('toast-bar').hidden; })()`), 'Save all done: a toast with a check (its bar gone)');

  const folder = await evaluate(`(async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked'); const out = {}; for await (const [k, h] of d.entries()) out[k] = (await h.getFile()).size; return out; })()`);
  check(Object.keys(folder).length === 41 && folder['photo-0010.jpg'] === 4 && 'photo-0010 (2).jpg' in folder, `the folder: 41 files, the one already there kept, ours as "photo-0010 (2).jpg"`);
  // as a zip, where the browser has no folder picker
  await evaluate(`delete window.showDirectoryPicker, window.showDirectoryPicker = undefined, true`);
  await evaluate(`document.getElementById('save').click(), true`);
  const zipName = 'photo-0000.jpg +39 more.zip';
  const zipSize = await waitFile(zipName, 30000);
  check(zipSize > 0, `Save all as a zip: ${zipName} (${zipSize} B) — "${await text('save-msg')}"`);
  if (zipSize > 0) {
    const py = `import zipfile,sys,json\nz=zipfile.ZipFile(sys.argv[1])\nprint(json.dumps({"bad":z.testzip(),"n":len(z.namelist()),"stored":all(i.compress_type==0 for i in z.infolist()),"sum":sum(i.file_size for i in z.infolist()),"dup":"photo-0000 (2).jpg" in z.namelist()}))`;
    const z = JSON.parse(execFileSync('python', ['-I', '-c', py, join(downloads, zipName)], { encoding: 'utf8' }));
    check(z.bad === null && z.n === 40 && z.stored && z.dup && z.sum === Object.entries(folder).filter(([k]) => k !== 'photo-0010.jpg').reduce((n, [, v]) => n + v, 0), `the zip reads back, the same name twice kept apart as "photo-0000 (2).jpg": ${JSON.stringify(z)}`);
  }

  await evaluate(`document.getElementById('again').click(), true`); await sleep(200);
  check(!(await evaluate(`document.getElementById('ask-dlg').open`)), 'every file saved: Receive another no longer asks');

  // ---- without device storage (the files kept in memory): the same list, each file and the zip ----
  await send('Page.navigate', { url: `${BASE}/${PAGE}?selftest=1&files=12&memory` }, S);
  check(await until(`!document.getElementById('done').hidden`), 'in memory: 12 files, Done');
  check(/^12 files · .+ · all verified$/.test(await text('verified-text')) && /in memory/.test(await text('d-camera')), `in memory: ${await text('verified-text')}`);
  await evaluate(`window.showDirectoryPicker = undefined, true`);
  await evaluate(`document.getElementById('save').click(), true`);
  const memZip = await waitFile('photo-0000.jpg +11 more.zip', 30000);
  if (memZip > 0) {
    const z = JSON.parse(execFileSync('python', ['-I', '-c', `import zipfile,sys,json
z=zipfile.ZipFile(sys.argv[1])
print(json.dumps({"bad":z.testzip(),"n":len(z.namelist())}))`, join(downloads, 'photo-0000.jpg +11 more.zip')], { encoding: 'utf8' }));
    check(z.bad === null && z.n === 12, `in memory: the zip reads back (${JSON.stringify(z)})`);
  } else check(false, 'in memory: the zip was not downloaded');

  // ---- scripted worker: a stopped run leaves nothing behind; stale messages; a copy not kept; nothing received ----
  {
    const fake = (expr) => evaluate(`(() => { const F = window.__fake; ${expr} })()`);
    const status = (o) => JSON.stringify({ frames: 1, decoded: 1, failed: 0, last_error: null, format: '2px bw 1024x1024', cell_px: 3, edges: [2, 2, 2, 2], codewords_ok: 111, codewords: 111, have_manifest: true, received_bytes: 1000, stream_size: 3000, disk_peak: 3000, storage: 'opfs', store_bytes: 0, corners: null, frame: [640, 480], sender_fps: 0, sha256: null, ...o });
    const trip = { name: 'trip', total: 3, received: 1, failed: 0, missing_files: null, error: null };
    await send('Page.navigate', { url: `${BASE}/${PAGE}?fakebatch` }, S);
    await until(`!!document.getElementById('go')`);
    await fake(`F.status = ${status({ filename: 'trip', batch: trip })}; F.list = [{ name: 'a.jpg', size: 1000, state: 'received' }, { name: 'b.jpg', size: 1000, state: 'waiting' }, { name: 'c.jpg', size: 1000, state: 'waiting' }]; return true;`);
    await evaluate(`document.getElementById('go').click(), true`);
    check(await until(`!document.getElementById('batch').hidden && !document.getElementById('cam').hidden`, 15000), 'scripted: a batch arriving');
    await fake(`F.emit({ type: 'saved', name: 'a.jpg', store: 'f1', size: 1000, gen: F.gen }); return true;`);
    // the receiver cannot write: two such statuses stop the run (back to the start screen)
    await fake(`F.status = { ...F.status, receiver_error: 'storage is full' }; return true;`);
    check(await until(`!document.getElementById('problem').hidden && document.getElementById('cam').hidden`, 15000), 'scripted: the run stops (storage full)');
    // a single file next: its Save saves it (nothing of the stopped batch is left)
    await fake(`F.gen = 2; F.status = ${status({ filename: 'x.bin', stream_size: 5, received_bytes: 5, complete: true, batch: null })}; F.list = []; return true;`);
    await evaluate(`document.getElementById('go').click(), true`);
    check(await until(`!document.getElementById('cam').hidden`, 15000), 'scripted: started again');
    await sleep(500);
    await fake(`F.emit({ type: 'file', name: 'x.bin', bytes: new TextEncoder().encode('hello'), sha256: null }); return true;`);
    check(await until(`!document.getElementById('done').hidden`, 10000), 'scripted: the single file is done');
    const single = { batch: await shown('batch'), files: await shown('files'), save: await text('save-text') };
    check(!single.batch && !single.files && single.save === 'Save file', `after a stopped batch, a single file's Done shows no batch (${JSON.stringify(single)})`);
    await evaluate(`document.getElementById('save').click(), true`);
    check(await waitFile('x.bin') === 5, 'its Save saves the file itself');
    // a batch after a stopped one: a stale "saved" (the run before) is ignored, a current one counts
    await send('Page.navigate', { url: `${BASE}/${PAGE}?fakebatch` }, S);
    await until(`!!document.getElementById('go')`);
    await fake(`F.gen = 5; F.status = ${status({ filename: 'trip', batch: { ...trip, total: 2, received: 1 } })}; F.list = [{ name: 'a.jpg', size: 1000, state: 'waiting' }, { name: 'b.jpg', size: 1000, state: 'received' }]; return true;`);
    await evaluate(`document.getElementById('go').click(), true`);
    await until(`!document.getElementById('batch').hidden`, 15000);
    await evaluate(`document.getElementById('batch-toggle').click(), true`);
    await sleep(800);
    await fake(`F.emit({ type: 'saved', name: 'b.jpg', store: 'f9', size: 1000, gen: 4 }); return true;`);
    await sleep(400);
    const bSave = () => evaluate(`(() => { const r = [...document.querySelectorAll('#fspace .frow')].find((x) => !x.hidden && x.dataset.name === 'b.jpg'); return r ? !r.querySelector('.fsave').hidden : null; })()`);
    const stale = await bSave();
    await fake(`F.emit({ type: 'saved', name: 'b.jpg', store: 'f1', size: 1000, gen: 5 }); return true;`);
    await sleep(400);
    const fresh = await bSave();
    check(stale === false && fresh === true, `a "saved" from the run before is ignored (Save shown: ${stale}), the current run's counts (${fresh})`);
    // a copy that hit a full storage: never "all verified"
    await fake(`F.status = { ...F.status, complete: true, batch: { ...F.status.batch, received: 2 } }; F.list = [{ name: 'a.jpg', size: 1000, state: 'received' }, { name: 'b.jpg', size: 1000, state: 'received' }]; return true;`);
    await sleep(300);
    await fake(`F.emit({ type: 'saved', name: 'a.jpg', size: 1000, error: 'storage full', gen: 5 }); F.emit({ type: 'batch-done', gen: 5 }); return true;`);
    check(await until(`!document.getElementById('done').hidden`, 10000), 'scripted: the batch is done');
    check(await until(`document.getElementById('verified-text').textContent === '1 of 2 kept · 1 not kept: storage full'`, 5000), `a copy not kept: "${await text('verified-text')}"`);
    const part = await evaluate(`({ warn: document.getElementById('done-title').classList.contains('warn'), icon: document.getElementById('done-icon').getAttribute('href'), bad: document.querySelector('#done .verified').classList.contains('bad'), guide: document.getElementById('guide').textContent,
      badge: [...document.querySelectorAll('#fspace .frow')].filter((r) => !r.hidden).map((r) => r.querySelector('.badge').className + ':' + r.querySelector('.badge').textContent).join(' | ') })`);
    check(part.warn && part.icon === '#i-alert' && part.bad && part.guide === 'Kept 1 of 2' && /badge warn:Not kept: storage full/.test(part.badge) && /badge ok:Received/.test(part.badge), `partial Done: amber, the alert icon, "Kept 1 of 2", the row says it was not kept (${JSON.stringify(part)})`);
    await shot('receive-batch-done-partial.png');
    // receiving before the list: the empty state (its picture and what comes), gone once the list is in
    await send('Page.navigate', { url: `${BASE}/${PAGE}?fakebatch` }, S);
    await until(`!!document.getElementById('go')`);
    await fake(`F.gen = 7; F.status = ${status({ filename: 'trip', batch: { ...trip, total: 0, received: 0 } })}; F.list = []; return true;`);
    await evaluate(`document.getElementById('go').click(), true`);
    await until(`!document.getElementById('batch').hidden`, 15000);
    await evaluate(`document.getElementById('batch-toggle').click(), true`); await sleep(400);
    check(await shown('fempty') && /Waiting for the file list/.test(await text('fempty')) && await evaluate(`document.querySelector('#fempty img').alt.length > 0`), `receiving, no list yet: the empty state ("${await text('fempty')}")`);
    await fake(`F.status = { ...F.status, batch: ${JSON.stringify({ ...trip, total: 2, received: 1 })} }; F.list = [{ name: 'a.jpg', size: 1000, state: 'received' }, { name: 'b.jpg', size: 1000, state: 'receiving', progress: 0.4 }]; return true;`);
    check(await until(`document.getElementById('fempty').hidden && [...document.querySelectorAll('#fspace .frow')].some((r) => !r.hidden && r.querySelector('.badge').textContent === 'Receiving 40%')`, 8000), 'the list arrives: the empty state goes, a row says "Receiving 40%"');
    const live = await evaluate(`[...document.querySelectorAll('#fspace .frow')].filter((r) => !r.hidden).map((r) => r.querySelector('.badge').className).join(',')`);
    check(live === 'badge ok,badge live', `receiving: a received badge and a live one (${live})`);
    // Close mid-transfer asks first (Keep receiving is the default); Stop goes back to the start screen
    await evaluate(`document.getElementById('close').click(), true`);
    check(await until(`document.getElementById('ask-dlg').open`, 3000) && await text('ask-dlg-t') === 'Stop receiving?' && await evaluate(`document.activeElement.id`) === 'ask-dlg-yes', `Close while receiving asks first ("${await text('ask-dlg-t')}", ${await text('ask-dlg-yes')} focused)`);
    await evaluate(`document.getElementById('ask-dlg-no').click(), true`); await sleep(300);
    check(await shown('start') && !(await shown('cam')) && !(await shown('problem')), 'Close: back to the start screen, no problem shown');

    // nothing received: the focus is on what can be done, not on a disabled Save
    await send('Page.navigate', { url: `${BASE}/${PAGE}?fakebatch` }, S);
    await until(`!!document.getElementById('go')`);
    await fake(`F.gen = 9; F.status = ${status({ filename: 'trip', complete: true, batch: { ...trip, total: 2, received: 0, failed: 2 } })}; F.list = [{ name: 'a.jpg', size: 1, state: 'failed', reason: 'checksum mismatch' }, { name: 'b.jpg', size: 1, state: 'failed', reason: 'checksum mismatch' }]; return true;`);
    await evaluate(`document.getElementById('go').click(), true`);
    await until(`!document.getElementById('batch').hidden`, 15000);
    await sleep(300);
    await fake(`F.emit({ type: 'batch-done', gen: 9 }); return true;`);
    check(await until(`!document.getElementById('done').hidden`, 10000), 'scripted: nothing received, Done');
    const foc = await evaluate(`(() => ({ id: document.activeElement.id, disabled: document.getElementById('save').disabled }))()`);
    check(foc.disabled && foc.id === 'again', `nothing received: Save disabled, the focus on Receive another (${JSON.stringify(foc)})`);
    const chips = await evaluate(`['all', 'received', 'missing', 'failed'].map((k) => (document.querySelector('#filters [data-f="' + k + '"]').hidden ? '-' : '') + document.getElementById('n-' + k).textContent).join(',')`);
    check(chips === '2,0,-0,2', `Done: the chips counted from the whole list, Missing 0 hidden (${chips})`);
  }

  // ---- 10,000 files: the list stays light; a file saved while the rest still arrives ----

  if (process.env.BIG !== '0') {
    await send('Page.navigate', { url: `${BASE}/${PAGE}?selftest=1&files=10000` }, S);
    check(await until(`!document.getElementById('batch').hidden`), '10,000 files: the summary');
    await evaluate(`document.getElementById('batch-toggle').click(), true`);
    check(await until(`[...document.querySelectorAll('#fspace .frow')].some((r) => !r.hidden && !r.querySelector('.fsave').hidden)`, 120000), 'a file saved while the rest still arrives: its Save shows at once');
    const early = await evaluate(`(() => { const r = [...document.querySelectorAll('#fspace .frow')].find((r) => !r.hidden && !r.querySelector('.fsave').hidden); r.querySelector('.fsave').click(); return { name: r.querySelector('.fname').title, done: !document.getElementById('done').hidden, sum: document.getElementById('batch-sum').textContent }; })()`);
    check(!early.done && await waitFile(early.name) >= 0, `saved before the end: ${early.name} (${early.sum})`);
    // the list at its top (rows 0-500 fetched): "save the files received so far" takes every file kept so far
    await evaluate(`document.getElementById('flist').scrollTop = 0, true`);
    // (files are handed to the page as they are copied out, behind the receiver's own count: count the copies)
    const copied = `(async () => { const d = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('lensbolt')).getDirectoryHandle('batch'); let n = 0; for await (const k of d.keys()) n++; return n; })()`;
    const many = await until(`(async () => document.getElementById('done').hidden && (await ${copied}) >= 1200)()`, 300000);
    if (many) {
      await evaluate(`(async () => { const root = await navigator.storage.getDirectory(); try { await root.removeEntry('picked2', { recursive: true }); } catch (e) {} const d = await root.getDirectoryHandle('picked2', { create: true }); window.showDirectoryPicker = async () => d; return true; })()`);
      const before = await text('batch-sum');
      await evaluate(`document.getElementById('save-got').click(), true`);
      check(await until(`/^Saved (all )?[\\d,]+ files into picked2\\.$/.test(document.getElementById('save-msg').textContent)`, 120000), `save so far: "${await text('save-msg')}"`);
      const n = await evaluate(`(async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked2'); let n = 0; for await (const k of d.keys()) n++; return n; })()`);
      check(n >= 1200, `save so far with the list at its top: ${n} files saved (the list said "${before}"), past the 500 rows fetched`);
    } else check(false, 'save so far: the batch ended before 1,200 files were in (the test could not ask)');

    await shot('receive-batch-live-phone.png');
    check(await until(`!document.getElementById('done').hidden`, 600000), '10,000 files: Done');
    check(/^10,000 files · .+ · all verified$/.test(await text('verified-text')), `10,000: ${await text('verified-text')}`);
    check(await domRows() < 20, `rows in the page: ${await domRows()} of 10,000`);
    const scroll = await evaluate(`(async () => { const l = document.getElementById('flist'), times = []; for (const at of [0, 72 * 2500, 72 * 5000, 1e9]) { const t = performance.now(); l.scrollTop = at; await new Promise((q) => requestAnimationFrame(() => requestAnimationFrame(q))); times.push(performance.now() - t); } const r = [...document.querySelectorAll('#fspace .frow')].filter((x) => !x.hidden); return { max: Math.max(...times), last: String(Math.max(...r.map((x) => +x.getAttribute('aria-posinset')))), rows: r.length }; })()`);
    check(scroll.max < 100 && scroll.last === '10000', `scrolling 10,000 rows: each jump drawn in ${scroll.max.toFixed(0)} ms or less, the last row reached (${scroll.last})`);
  }
} finally {
  try { await Promise.race([new Promise((r) => { try { ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' })); } catch {} setTimeout(r, 1500); })]); } catch {}
  for (let i = 0; i < 20 && chrome.exitCode === null; i++) await sleep(100);
  kill();
  try { ws && ws.close(); } catch {}
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); rmSync(downloads, { recursive: true, force: true }); } catch {}
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

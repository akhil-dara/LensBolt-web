// The sender's file list in a real (headless) Chrome: files added with Add files (the picker opened from the
// keyboard, files from disk), as many as wanted and the same file twice, a 0-byte file, 200 files at once, removed
// with the keyboard (the focus moves on), dropped with a folder among them (left out, said so); the running total,
// the note past 1.5 GB, a file this browser cannot hold; the flashing notice before the first Start (once per
// browser); finish words for a batch (checked at Start against the batch; the sending panel names the files); one
// file sent exactly as before the list.
//
//   python web/serve.py                       (in another shell; port 8765)
//   node web/tests/sender-files.mjs           (starts its own headless Chrome on port 9334, stops it by its PID;
//                                              CDP_PORT=9336 for another port)
//   SHOTS=docs/screens/web ...                (also writes screenshots of the new states)
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tempProfile, ownChrome } from './chrome-profile.mjs';
const PORT = Number(process.env.CDP_PORT || 9334);
const BASE = process.env.BASE || 'http://localhost:8765';
const PAGE = process.env.PAGE || 'index.html';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOTS = process.env.SHOTS || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

try { await fetch(`http://127.0.0.1:${PORT}/json/version`); throw new Error(`port ${PORT} is already in use: stop that browser first`); } catch (e) { if (/in use/.test(e.message)) throw e; }
const profile = tempProfile('lb-files-');
// files on disk for the picker and the drop: two files and a folder
const disk = tempProfile('lb-files-disk-');
writeFileSync(join(disk, 'notes.txt'), 'notes from disk\n'.repeat(400));
writeFileSync(join(disk, 'zero.bin'), '');
mkdirSync(join(disk, 'Photos'));
writeFileSync(join(disk, 'Photos', 'inside.jpg'), 'x'.repeat(1000));
const chrome = ownChrome(spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-color-profile=srgb', '--force-device-scale-factor=1', '--screen-info={1920x1080}', '--window-size=1440,1000',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank'], { stdio: 'ignore' }));
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
  const pending = new Map(), events = [];
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else if (m.method) events.push(m); });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const { targetInfos } = await send('Target.getTargets');
  const { sessionId: S } = await send('Target.attachToTarget', { targetId: targetInfos.find((t) => t.type === 'page').targetId, flatten: true });
  await send('Page.enable', {}, S); await send('Runtime.enable', {}, S); await send('DOM.enable', {}, S); await send('Page.bringToFront', {}, S);
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, S);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await evaluate(expr).catch(() => false)) return true; await sleep(50); } return false; };
  const size = (width, height, mobile = false) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile }, S);
  const shot = async (name, full = false) => {
    if (!SHOTS) return;
    let clip;
    if (full) { const m = await send('Page.getLayoutMetrics', {}, S); clip = { x: 0, y: 0, width: m.cssContentSize.width, height: m.cssContentSize.height, scale: 1 }; }
    const { data } = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) }, S);
    writeFileSync(join(SHOTS, name), Buffer.from(data, 'base64')); console.log('     wrote', join(SHOTS, name));
  };
  const key = async (k, code, vk, text, modifiers = 0) => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(type === 'keyDown' && text ? { text } : {}) }, S); };
  const tab = () => key('Tab', 'Tab', 9), enter = () => key('Enter', 'Enter', 13, '\r'), esc = () => key('Escape', 'Escape', 27), space = () => key(' ', 'Space', 32, ' ');
  const click = async (sel) => {
    const b = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const t of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type: t, x: b.x, y: b.y, button: 'left', clickCount: 1 }, S);
  };
  const text = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const shown = (id) => evaluate(`(() => { const e = document.getElementById(${JSON.stringify(id)}); return !e.hidden && e.getClientRects().length > 0; })()`);
  const val = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).value`);
  const setField = (id, v) => evaluate(`(() => { const f = document.getElementById(${JSON.stringify(id)}); f.value = ${JSON.stringify(v)}; f.dispatchEvent(new Event('input')); return true; })()`);
  const stageOn = () => evaluate(`document.getElementById('stage').classList.contains('on')`);
  const active = () => evaluate(`(() => { const a = document.activeElement; if (!a) return ''; if (a.id) return a.id; const li = a.closest('.file-row'); return li ? 'rm:' + li.querySelector('.name').title : a.tagName; })()`);
  const rows = () => evaluate(`[...document.querySelectorAll('#list .file-row')].map((li) => li.querySelector('.name').title + ' | ' + li.querySelector('.sub').textContent)`);
  // files made in the page: [name, size, seed]; the same seed makes the same bytes
  const GEN = `(size, seed) => { const d = new Uint8Array(size); let x = seed >>> 0 || 1; for (let i = 0; i < size; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; d[i] = x & 255; } return d; }`;
  const addFiles = (specs) => evaluate(`(() => { const gen = ${GEN}; const dt = new DataTransfer();
    for (const [n, size, seed] of ${JSON.stringify(specs)}) dt.items.add(new File([gen(size, seed)], n, { lastModified: 1 }));
    const f = document.getElementById('file'); f.files = dt.files; f.dispatchEvent(new Event('change')); return true; })()`);
  const held = () => evaluate(`window.__lbFiles()`);
  const startReady = (ms) => until(`!document.getElementById('start').disabled`, ms);
  // the transfer id and parts of these files sent as the page sends them (the same names, bytes and order)
  const contextOf = (specs) => evaluate(`(() => { const gen = ${GEN}; const fs = new LensBolt.WebFiles(), ids = [];
    for (const [n, size, seed] of ${JSON.stringify(specs)}) { const id = fs.begin(n, size); fs.append(id, gen(size, seed)); fs.finish(id); ids.push(id); }
    const s = LensBolt.WebSender.from_files(fs, Uint32Array.from(ids), 1024, 1024, 'satin-swift', false); const c = s.finish_context(); s.free(); fs.free(); return c.split(',').map(Number); })()`);

  await size(1440, 1000);
  await send('Page.navigate', { url: `${BASE}/${PAGE}?lead=0` }, S);
  check(await until(`!!window.LensBolt && !!window.LensBoltList && !!window.LensBoltFinish`), 'the sender loads');
  check(await shown('drop') && !(await shown('files')) && await evaluate(`document.getElementById('start').disabled`), 'no files: the drop area, no list, Start disabled');
  check(await evaluate(`document.getElementById('file').multiple`), 'the picker takes several files');
  await shot('files-empty-desktop-light.png');

  // ---- add files: several at once, a 0-byte one, then the same file again ----
  // c.txt takes the batch past 1 MiB: two parts, so finish words can name one of them
  const A = ['a.jpg', 25000, 1], B = ['b.pdf', 30000, 2], C = ['c.txt', 1480000, 3], E = ['empty.dat', 0, 4];
  await addFiles([A, B, C, E]);
  check(await startReady(), 'four files read: Start enabled');
  check(JSON.stringify(await rows()) === JSON.stringify(['a.jpg | 25 KB', 'b.pdf | 30 KB', 'c.txt | 1.5 MB', 'empty.dat | 0 B']), `the rows: name and size, a 0-byte file too (${(await rows()).join('; ')})`);
  check(await text('total') === '4 files · 1.5 MB' && await shown('files') && !(await shown('drop')), `the running total (${await text('total')})`);
  check(/these 4 files once every/.test(await text('pass')), `the pass line names the files (${await text('pass')})`);
  await addFiles([A]);
  check(await startReady() && (await rows()).filter((r) => r.startsWith('a.jpg |')).length === 2 && await text('total') === '5 files · 1.6 MB', 'the same file again: kept as its own row (duplicates allowed)');
  const h5 = await held();
  check(h5.count === 4 && h5.held === 25000 + 30000 + 1480000, `the same file twice is held once: ${h5.count} files, ${h5.held} bytes for 5 rows`);
  const labels = await evaluate(`[...document.querySelectorAll('#list .rm')].map((b) => b.getAttribute('aria-label'))`);
  check(labels[1] === 'Remove b.pdf' && labels.length === 5, `each Remove names its file (${labels[1]})`);

  // ---- remove with the keyboard: the focus moves to the next row, else the one before ----
  await evaluate(`document.querySelectorAll('#list .rm')[1].focus(), true`);
  await enter();
  check(!(await rows()).some((r) => r.startsWith('b.pdf')) && await active() === 'rm:c.txt', `Enter on Remove b.pdf removes it; the focus goes to the next row (${await active()})`);
  await evaluate(`document.querySelectorAll('#list .rm')[3].focus(), true`);
  await space();
  check((await rows()).length === 3 && await active() === 'rm:empty.dat' && await text('total') === '3 files · 1.5 MB', `Space on the last Remove: the focus goes to the row before (${await active()}, ${await text('total')})`);

  // ---- every action from the keyboard: Tab reaches Add files, Remove all and each Remove; Enter on Add files opens the picker ----
  await evaluate(`document.getElementById('theme').focus(), true`);
  const order = [];
  for (let i = 0; i < 40; i++) { await tab(); const a = await active(); order.push(a); if (a === 'start') break; }
  check(['add', 'clear', 'rm:a.jpg', 'rm:c.txt', 'rm:empty.dat', 'fin', 'start'].every((x) => order.includes(x)) && order.indexOf('add') < order.indexOf('rm:a.jpg'), `Tab order: ${order.join(', ')}`);
  await send('Page.setInterceptFileChooserDialog', { enabled: true }, S);
  events.length = 0;
  await evaluate(`document.getElementById('add').focus(), true`);
  await enter();
  const t0 = Date.now(); while (!events.some((e) => e.method === 'Page.fileChooserOpened') && Date.now() - t0 < 3000) await sleep(50);
  const chooser = events.find((e) => e.method === 'Page.fileChooserOpened');
  check(!!chooser && chooser.params.mode === 'selectMultiple', `Enter on Add files opens the picker for several files (${chooser && chooser.params.mode})`);
  // files from disk through the picker (the page reads them a piece at a time from the disk)
  if (chooser) await send('DOM.setFileInputFiles', { files: [join(disk, 'notes.txt'), join(disk, 'zero.bin')], backendNodeId: chooser.params.backendNodeId }, S);
  check(await until(`document.querySelectorAll('#list .file-row').length === 5`) && await startReady(), 'two files from disk added through the picker');
  check((await rows()).includes('notes.txt | 6 KB') && (await rows()).includes('zero.bin | 0 B'), `from disk: ${(await rows()).slice(3).join('; ')}`);
  await send('Page.setInterceptFileChooserDialog', { enabled: false }, S);
  // the drop area opens the picker from the keyboard too (shown again once the list is emptied)
  await click('#clear');
  check((await rows()).length === 0 && await shown('drop') && await active() === 'drop' && await evaluate(`document.getElementById('start').disabled`), 'Remove all: the drop area again, focused; Start disabled');
  check(JSON.stringify(await held()) === '{"count":0,"held":0}', `Remove all: nothing held (${JSON.stringify(await held())})`);
  // Remove all is never silent: it says how many and offers Undo, which brings the same five files back (read again)
  check(await shown('undo-line') && await text('undo-text') === 'Removed 5 files.', `Remove all: said, with Undo ("${await text('undo-text')}")`);
  await click('#undo');
  check(await until(`document.querySelectorAll('#list .file-row').length === 5`) && await startReady() && !(await shown('undo-line')) && await text('total') === '5 files · 1.5 MB', `Undo: the five files back, Start ready (${await text('total')})`);
  await click('#clear');
  // and the drag feedback says what letting go does
  check(await evaluate(`getComputedStyle(document.querySelector('#drop .when-idle')).display !== 'none' && getComputedStyle(document.querySelector('#drop .when-over')).display === 'none'`), 'the empty state: "No files yet"');

  // ---- a drop with a folder among the files: the files are added, the folder left out and said so ----
  const target = await evaluate(`(() => { const r = document.getElementById('drop').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  const data = { items: [], files: [join(disk, 'notes.txt'), join(disk, 'Photos')], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver']) await send('Input.dispatchDragEvent', { type, x: target.x, y: target.y, data }, S);
  check(await evaluate(`document.getElementById('drop').classList.contains('over')`), 'dragging files over the page marks the drop area');
  check(await evaluate(`getComputedStyle(document.querySelector('#drop .when-over')).display !== 'none' && getComputedStyle(document.querySelector('#drop .when-idle')).display === 'none'`), 'over the drop area: "Let go to add them"');
  await send('Input.dispatchDragEvent', { type: 'drop', x: target.x, y: target.y, data }, S);
  check(await until(`document.querySelectorAll('#list .file-row').length > 0`, 5000), 'the dropped file is added');
  const dropRows = await rows(), msg = await text('list-msg');
  check(dropRows.length === 1 && dropRows[0].startsWith('notes.txt') && /folder was left out/.test(msg), `only the file; the folder left out: ${dropRows.join('; ')} / "${msg}"`);
  await shot('files-folder-desktop-light.png');
  await click('#clear');

  // ---- finish words for a batch: checked at Start against the batch; the panel names the files in the parts ----
  const LIST = [A, C, E, B];
  await addFiles(LIST);
  check(await startReady(), 'four files again (a.jpg, c.txt, empty.dat, b.pdf)');
  await shot('files-list-desktop-light.png');
  const [id, parts] = await contextOf(LIST);
  const words = await evaluate(`LensBolt.finish_code(${id}, ${parts}, Uint32Array.from([0]))`);
  check(!!words && parts === 2, `finish words for the batch's first part of ${parts}: "${words}" (id ${id})`);
  await evaluate(`document.getElementById('fin').focus(), true`);
  await setField('fin', words); await enter();
  check(await text('fin-msg') === 'Start sends only the parts these words name.', `the words accepted before Start (${await text('fin-msg')})`);

  // ---- the flashing notice: before the first Start, once per browser ----
  check(await evaluate(`localStorage.getItem('lb-flash-ok')`) === null, 'a fresh browser has not seen the notice');
  await click('#start');
  check(await shown('flash') && !(await shown('go')) && !(await stageOn()) && await active() === 'flash-ok', `Start shows the notice first, its Start focused (${await active()})`);
  check(/flashes rapidly \(30 times a second\): if flashing light affects you, look away from this screen\./.test(await text('flash-text')), `the notice in one plain sentence: "${await text('flash-text')}"`);
  await shot('files-notice-desktop-light.png');
  await esc();
  check(!(await shown('flash')) && await shown('go') && await active() === 'start' && !(await stageOn()), 'Esc closes the notice; the focus is back on Start; nothing sent');
  await click('#start');
  check(await shown('flash'), 'not acknowledged: shown again');
  await click('#flash-ok');
  check(await until(`document.getElementById('stage').classList.contains('sending')`), "the notice's Start starts sending");
  check(await evaluate(`localStorage.getItem('lb-flash-ok')`) === '1', 'acknowledged: remembered in this browser');
  check(await text('p-file') === '4 files · 1.5 MB', `the panel: ${await text('p-file')}`);
  const FINISHING = 'the parts holding 3 files: a.jpg, b.pdf +1';
  check(await shown('p-fin-state') && await text('p-fin-desc') === FINISHING, `Finishing ${await text('p-fin-desc')}`);
  await shot('files-stage-finishing-desktop.png');
  // a refit (the window got shorter: a new sender at 768 px) shares the files' bytes: nothing more is held
  const before = await held(), h0 = await evaluate(`document.getElementById('canvas').height`);
  await size(1440, 800);
  check(await until(`document.getElementById('canvas').height < ${h0}`, 3000), `the window got shorter: the tile refitted (${h0} -> ${await evaluate(`document.getElementById('canvas').height`)} px)`);
  check(JSON.stringify(await held()) === JSON.stringify(before), `refitted: the same bytes held (${JSON.stringify(await held())})`);
  await size(1440, 1000);
  // the same words typed on the sending screen: what they send, in files
  await key('f', 'KeyF', 70, 'f');
  await setField('p-fin-in', words); await enter();
  check(await shown('p-fin-state') && await text('p-fin-desc') === FINISHING && !(await shown('p-fin')), `typed while sending: Finishing ${await text('p-fin-desc')}`);
  await sleep(600);
  await esc();
  check(!(await stageOn()) && /× the files\)\.$/.test(await text('status')), `Stop: ${await text('status')}`);
  check(await text('fin-msg') === 'Start sends only the parts holding 3 files: a.jpg, b.pdf +1.', `the form says what Start sends: ${await text('fin-msg')}`);
  await shot('files-list-words-desktop-light.png', true);
  await click('#start');
  check(await until(`document.getElementById('stage').classList.contains('sending')`) && !(await shown('flash')), 'the second Start: no notice');
  await esc();

  // words for another list: a file added clears them; one file's words are refused at Start for the batch
  await addFiles([['d.bin', 5000, 9]]);
  check(await startReady() && await val('fin') === '' && await text('fin-msg') === '', 'a file added: the words for the last list are cleared');
  const removeNamed = (n) => evaluate(`(() => { const li = [...document.querySelectorAll('#list .file-row')].find((l) => l.querySelector('.name').title === ${JSON.stringify(n)}); li.querySelector('.rm').click(); return true; })()`);
  await removeNamed('d.bin');
  // the words for c.txt sent on its own (two parts too)
  const [idA, partsA] = await evaluate(`(() => { const gen = ${GEN}; return LensBolt.finish_context('c.txt', gen(1480000, 3)).split(',').map(Number); })()`);
  const wordsA = await evaluate(`LensBolt.finish_code(${idA}, ${partsA}, Uint32Array.from([0]))`);
  check(!!wordsA && partsA === 2, `words for c.txt alone: "${wordsA}"`);
  await evaluate(`document.getElementById('fin').focus(), true`);
  await setField('fin', wordsA); await enter();
  await click('#start');
  await sleep(800);
  check(!(await stageOn()) && await evaluate(`document.getElementById('fin-msg').classList.contains('bad')`) && await val('fin') === wordsA,
    `words for one file are refused at Start for the batch, kept in the field: "${await text('fin-msg')}"`);
  await setField('fin', '');

  // ---- 200 files at once ----
  await click('#clear');
  const many = Array.from({ length: 200 }, (_, i) => [`photo-${String(i + 1).padStart(3, '0')}.jpg`, 1000 + 37 * i, 100 + i]);
  const t1 = Date.now();
  await addFiles(many);
  check(await startReady(30000), `200 files listed and read in ${Date.now() - t1} ms`);
  check(await until(`document.getElementById('list-live').textContent === '200 files read.'`, 3000), `announced at the end: "${await text('list-live')}"`);
  const bytes200 = many.reduce((n, f) => n + f[1], 0);
  check((await rows()).length === 200 && await text('total') === `200 files · ${(bytes200 / 1e3).toFixed(0)} KB`, `200 rows, ${await text('total')}`);
  check(await evaluate(`(() => { const l = document.getElementById('list'); return l.scrollHeight > l.clientHeight + 1000 && l.clientHeight <= 380; })()`), 'the list scrolls in its own box (the page below stays in reach)');
  await shot('files-many-desktop-light.png');
  await click('#start');
  check(await until(`document.getElementById('stage').classList.contains('sending')`) && await text('p-file') === `200 files · ${(bytes200 / 1e3).toFixed(0)} KB`, `200 files sending: ${await text('p-file')}`);
  await esc();

  // ---- 10,000 files at once: listed and read, the time reported ----
  await click('#clear');
  await evaluate(`(() => { const dt = new DataTransfer(), d = new Uint8Array(300);
    for (let i = 0; i < 10000; i++) { d[0] = i & 255; d[1] = i >> 8; dt.items.add(new File([d], 'log-' + i + '.txt', { lastModified: 1 })); }
    window.__dt = dt; return true; })()`);
  const t10 = Date.now();
  await evaluate(`(() => { const f = document.getElementById('file'); f.files = window.__dt.files; f.dispatchEvent(new Event('change')); return true; })()`);
  const listed = Date.now() - t10;
  check(await startReady(120000), `10,000 files: listed in ${listed} ms, all read in ${Date.now() - t10} ms`);
  check((await rows()).length === 10000 && (await held()).count === 10000 && await text('total') === '10000 files · 3.0 MB', `10,000 rows, ${await text('total')}`);
  const tr = Date.now();
  await evaluate(`document.querySelectorAll('#list .rm')[5000].click(), true`);
  check(await text('total') === '9999 files · 3.0 MB', `one removed from 10,000 in ${Date.now() - tr} ms`);
  await click('#clear');
  check(JSON.stringify(await held()) === '{"count":0,"held":0}', 'Remove all of 10,000: nothing held');

  // ---- a 0-byte file alone, and one file sent exactly as before the list ----
  await click('#clear');
  await addFiles([E]);
  check(await startReady(), 'a 0-byte file alone: Start enabled');
  await click('#start');
  check(await until(`document.getElementById('stage').classList.contains('sending')`) && await text('p-file') === 'empty.dat · 0 B', `a 0-byte file sends: ${await text('p-file')}`);
  await esc();
  check(!(await evaluate(`document.getElementById('status').classList.contains('bad')`)), `no error (${await text('status')})`);
  await click('#clear');
  await addFiles([C]);
  check(await startReady() && /this file once every/.test(await text('pass')), `one file: ${await text('pass')}`);
  const same = await evaluate(`(() => { const gen = ${GEN}, d = gen(1480000, 3); const fs = new LensBolt.WebFiles(), id = fs.begin('c.txt', d.length); fs.append(id, d); fs.finish(id);
    const a = new LensBolt.WebSender('c.txt', d, 1024, 1024, 'satin-swift', false), b = LensBolt.WebSender.from_files(fs, Uint32Array.from([id]), 1024, 1024, 'satin-swift', false);
    let equal = a.finish_context() === b.finish_context() && b.name() === 'c.txt' && b.file_count() === 1;
    for (let i = 0; i < 6 && equal; i++) { const x = a.next_frame_rgba(), y = b.next_frame_rgba(); equal = x.length === y.length && x.every((v, k) => v === y[k]); }
    const code = LensBolt.finish_code(...a.finish_context().split(',').map(Number), Uint32Array.from([0])); const desc = b.finish(code);
    a.free(); b.free(); fs.free(); return { equal, desc }; })()`);
  check(same.equal && same.desc === '1 part: 1', `one file from the list sends the frames it sent before the list, the same transfer id; its words read "${same.desc}"`);
  await click('#start');
  check(await until(`document.getElementById('stage').classList.contains('sending')`) && await text('p-file') === 'c.txt · 1.5 MB', `the panel as before: ${await text('p-file')}`);
  await sleep(600);
  await esc();
  check(/× the file\)\.$/.test(await text('status')), `Stop: ${await text('status')}`);

  // ---- dark theme and a phone-width window ----
  await click('#clear');
  await addFiles([A, C, E, B, ['holiday-photo-from-the-beach-at-sunset-with-everyone.jpeg', 52000, 7]]);
  await startReady();
  check(await evaluate(`(() => { const n = [...document.querySelectorAll('#list .file-row')].pop(); return n.querySelector('.ext').textContent === '.jpeg' && n.querySelector('.ext').getBoundingClientRect().right <= n.querySelector('.meta').getBoundingClientRect().right + 0.5; })()`), 'a long name keeps its extension in view');
  await evaluate(`document.documentElement.dataset.theme = 'dark', true`);
  await sleep(400); // the card's colour eases over 150 ms
  await shot('files-list-desktop-dark.png');
  await size(375, 812, true);
  await evaluate(`document.documentElement.dataset.theme = 'light', window.scrollTo(0, 0), true`);
  await sleep(400);
  check(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth`), 'no sideways scrolling at 375 px');
  await shot('files-list-phone-light.png');
  await size(1440, 1000);

  // ---- past 1.5 GB: the note; past what one file can be held as: a row error, Start held ----
  await click('#clear');
  const bigFile = (gb, name) => evaluate(`(() => { const part = new Blob([new Uint8Array(16 << 20)]), n = Math.ceil(${gb} * 1e9 / (16 << 20));
    const dt = new DataTransfer(); dt.items.add(new File(Array(n).fill(part), ${JSON.stringify(name)})); const f = document.getElementById('file'); f.files = dt.files; f.dispatchEvent(new Event('change')); return true; })()`);
  await bigFile(2.2, 'disk-image.iso');
  check(await until(`document.querySelector('#list .sub.bad') !== null`, 10000), 'a 2.2 GB file: refused by this browser, said in its row');
  const DESK = 'The LensBolt desktop app sends any size from disk.';
  check((await rows())[0] === 'disk-image.iso | This browser cannot hold this file in memory.' && await shown('big') && await text('big-text') === `This tab cannot hold every file in memory. ${DESK}` &&
    await evaluate(`document.getElementById('start').disabled`) && /could not be read: remove it/.test(await text('list-msg')),
    `the row, the note (the desktop app named once), Start held: ${(await rows())[0]} / ${await text('big-text')} / ${await text('list-msg')}`);
  check(JSON.stringify(await held()) === '{"count":0,"held":0}', 'refused: nothing held');
  await shot('files-big-desktop-light.png');
  await evaluate(`document.querySelector('#list .rm').click(), true`);
  check(!(await shown('big')) && await text('list-msg') === '', 'removed: the note and the line go');
  // removed while it is read: its memory goes at once
  await bigFile(0.4, 'clip.mp4');
  check(await until(`/reading \\d+%/.test(document.querySelector('#list .sub').textContent)`, 10000), `a 400 MB file being read: ${(await rows())[0]}`);
  check(!(await shown('big')), 'under 1.5 GB read: no note');
  await evaluate(`document.querySelector('#list .rm').click(), true`);
  await sleep(300);
  check(JSON.stringify(await held()) === '{"count":0,"held":0}', `removed while it was read: nothing held (${JSON.stringify(await held())})`);
  // past 1.5 GB read into memory: the note names the desktop app
  await bigFile(1.6, 'video.mp4');
  check(await until(`document.getElementById('big').hidden === false`, 120000) && await text('big-text') === `Over 1.5 GB in all: this tab holds every file in memory while it sends, and may run out. ${DESK}` && /^1 file · 1\.6\d GB$/.test(await text('total')),
    `1.6 GB read: the note (${await text('total')})`);
  check(/Over 1\.5 GB/.test(await text('list-live')) || await until(`/Over 1\\.5 GB/.test(document.getElementById('list-live').textContent)`, 2000), 'the note is announced');
  await evaluate(`document.querySelector('#list .rm').click(), true`);
  check(!(await shown('big')) && JSON.stringify(await held()) === '{"count":0,"held":0}', 'removed: the note goes, nothing held');
} finally {
  try { await Promise.race([new Promise((r) => { try { ws.send(JSON.stringify({ id: 999999, method: 'Browser.close' })); } catch {} setTimeout(r, 1500); })]); } catch {}
  for (let i = 0; i < 20 && chrome.exitCode === null; i++) await sleep(100);
  kill();
  try { ws && ws.close(); } catch {}
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  try { rmSync(disk, { recursive: true, force: true }); } catch {}
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

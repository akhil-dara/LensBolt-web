// Finish words in the pages: the sender's Finish field before Start (Tab completes a word, a refused word is named
// and selected, accepted words say what Start will send, Start applies them) and on the sending screen (F opens the
// field, new words replace the old, Send everything clears them); the receiver shows the words it is given, large,
// with Copy, and hides them once the file is complete. The receiver's decode worker is replaced by a stand-in that
// answers with the statuses this test writes (the words themselves come from the core, tested there).
//
//   python web/serve.py                       (in another shell; port 8765)
//   node web/tests/finish-words.mjs           (starts its own headless Chrome on port 9334, stops it by PID)
//   SHOTS=docs/screens/web node ...           (also saves screenshots there)
//   PAGE=dist/lensbolt.html RPAGE=dist/lensbolt-receive.html node ...   (the single-file builds)
//   HEADED=1 node ...                          (a visible Chrome: Esc in real full screen)
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tempProfile, ownChrome } from './chrome-profile.mjs';
const PORT = Number(process.env.CDP_PORT || 9334);
const BASE = process.env.BASE || 'http://localhost:8765';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SHOTS = process.env.SHOTS || '';
const PAGE = process.env.PAGE || 'index.html', RPAGE = process.env.RPAGE || 'receive.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

try { await fetch(`http://127.0.0.1:${PORT}/json/version`); throw new Error(`port ${PORT} is already in use: stop that browser first`); } catch (e) { if (/in use/.test(e.message)) throw e; }
const profile = tempProfile('lb-finish-');
// HEADED=1: a visible Chrome (real full screen and Keyboard Lock)
const chrome = ownChrome(spawn(CHROME, [...(process.env.HEADED ? [] : ['--headless=new']), `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-color-profile=srgb', '--force-device-scale-factor=1', '--screen-info={1920x1080}', '--window-size=1600,1000',
  '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank'], { stdio: 'ignore' }));
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
  await send('Page.enable', {}, S); await send('Runtime.enable', {}, S); await send('Page.bringToFront', {}, S);
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, S);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expr, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await evaluate(expr).catch(() => false)) return true; await sleep(100); } return false; };
  const size = (width, height, mobile = false) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile }, S);
  const shot = async (name) => { if (!SHOTS) return; const { data } = await send('Page.captureScreenshot', { format: 'png' }, S); writeFileSync(join(SHOTS, name), Buffer.from(data, 'base64')); console.log('     wrote', join(SHOTS, name)); };
  const key = async (k, code, vk, text) => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, ...(type === 'keyDown' && text ? { text } : {}) }, S); };
  const tab = () => key('Tab', 'Tab', 9), enter = () => key('Enter', 'Enter', 13, '\r');
  const type = (t) => send('Input.insertText', { text: t }, S);
  const click = async (sel) => {
    // brought into view first, as a person scrolls to it: a press outside the viewport reaches nothing (the SHA-256
    // line under the file's name puts Start just below a 1000 px window)
    const b = await evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const t of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type: t, x: b.x, y: b.y, button: 'left', clickCount: 1 }, S);
  };
  const text = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const shown = (id) => evaluate(`!document.getElementById(${JSON.stringify(id)}).hidden && document.getElementById(${JSON.stringify(id)}).getClientRects().length > 0`);

  // ---------- the sender ----------
  await size(1600, 1000);
  await send('Page.navigate', { url: `${BASE}/${PAGE}?testfile=20&lead=0` }, S);
  check(await until(`!document.getElementById('start').disabled && !!window.LensBoltFinish`), 'the sender loads a 20 MB test file (2 parts)');
  // the test file's own id and parts (the page's ?testfile bytes, made again here), and codes for part 2 and part 1
  const [id, parts] = await evaluate(`(() => {
    const n = 20e6, d = new Uint8Array(n); let x = 2463534242; for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; d[i] = x & 255; }
    return LensBolt.finish_context('test-20MB.bin', d).split(',').map(Number); })()`);
  check(parts === 2, `the file has 2 parts (${parts}), transfer id ${id}`);
  const code2 = await evaluate(`LensBolt.finish_code(${id}, ${parts}, Uint32Array.from([1]))`), code1 = await evaluate(`LensBolt.finish_code(${id}, ${parts}, Uint32Array.from([0]))`);
  check(!!code2 && !!code1 && code1 !== code2, `codes for part 2 (${code2}) and part 1 (${code1})`);

  const setField = (id, v) => evaluate(`(() => { const f = document.getElementById(${JSON.stringify(id)}); f.value = ${JSON.stringify(v)}; f.dispatchEvent(new Event('input')); return true; })()`);
  const val = (id) => evaluate(`document.getElementById(${JSON.stringify(id)}).value`);
  const active = () => evaluate(`document.activeElement && document.activeElement.id`);
  const stageOn = () => evaluate(`document.getElementById('stage').classList.contains('on')`);

  await evaluate(`document.getElementById('fin').focus(), true`);
  // Tab completes: the rest of the word shows after the letters, Tab takes it; Space would end the word as typed
  await type('river tuli');
  const ghost = await evaluate(`document.querySelector('#fin-ac .ghost b').textContent`);
  check(ghost === 'p' && await evaluate(`document.getElementById('fin-ac').classList.contains('has-rest')`), `"tuli" shows the rest of tulip after it ("${ghost}") with a Tab key`);
  check(await text('fin-sugg') === 'Tab completes tulip.' && await evaluate(`document.getElementById('fin-sugg').getAttribute('aria-live')`) === 'polite', 'the suggestion is announced (a polite live region)');
  if (SHOTS) await shot('finish-sender-complete.png');
  await tab();
  check(await val('fin') === 'river tulip ' && await active() === 'fin', `Tab: the whole word and a space, the focus stays (${JSON.stringify(await val('fin'))})`);
  await setField('fin', 'river att');
  check(await evaluate(`document.querySelector('#fin-ac .ghost b').textContent`) === '', '"att" (one mistake from the start of another word) shows no completion');
  await tab();
  check(await active() !== 'fin', 'Tab with no completion on screen moves the focus as usual');
  await setField('fin', '');
  await evaluate(`document.getElementById('fin').focus(), true`);

  // before Start, Enter checks the spelling and the number of words only: a word not on the list is named and selected
  await type(`${code2.split(' ')[0]} qqqz`); await enter();
  check(/“qqqz” is not one of the words/.test(await text('fin-msg')) && await evaluate(`document.getElementById('fin').getAttribute('aria-invalid')`) === 'true', `a word not on the list is refused by name (${await text('fin-msg')})`);
  const sel = await evaluate(`(() => { const f = document.getElementById('fin'); return f.value.slice(f.selectionStart, f.selectionEnd); })()`);
  check(sel === 'qqqz', `the refused word is selected for typing again (${JSON.stringify(sel)})`);
  await setField('fin', 'tulip walnut lantern tulip walnut'); await enter();
  check(/at most four/.test(await text('fin-msg')), `five words are refused (${await text('fin-msg')})`);
  // another file's words are spelled right: accepted before Start, refused by Start, which returns to the form with
  // the words kept and the problem named
  const other = await evaluate(`LensBolt.finish_code(${id ^ 2}, 2, Uint32Array.from([1]))`);
  await setField('fin', other); await enter();
  check(await text('fin-msg') === 'Start sends only the parts these words name.', `spelled right, before Start: "${await text('fin-msg')}"`);
  await click('#start');
  await sleep(800);
  check(!(await stageOn()) && /another file/.test(await text('fin-msg')) && await val('fin') === other && await evaluate(`document.getElementById('fin').getAttribute('aria-invalid')`) === 'true',
    `Start refuses another file's words: back to the form, words kept (${await val('fin')}), "${await text('fin-msg')}"`);
  // accepted words; typed with a missing letter, they are shown as read, in full
  // one letter left out where the matcher still reads the word meant (a 4-letter word often has no such typo)
  const typo = await evaluate(`${JSON.stringify(code2)}.split(' ').map((w) => { for (let i = 0; i < w.length; i++) { const t = w.slice(0, i) + w.slice(i + 1); try { if (LensBolt.check_finish_words(t) === w) return t; } catch {} } return w; }).join('-').toUpperCase()`);
  await setField('fin', typo); await enter();
  check(await text('fin-msg') === 'Start sends only the parts these words name.' && await val('fin') === code2, `typed as "${typo}", shown as read: "${await val('fin')}" (${await text('fin-msg')}; focus ${await active()})`);
  await evaluate(`document.getElementById('fin').blur(), true`);
  if (SHOTS) await shot('finish-sender-form.png');

  // Start: the sender checks the words against the file and sends only those parts from the first frame
  await click('#start');
  check(await until(`document.getElementById('stage').classList.contains('sending')`), 'Start: sending (no countdown with lead=0)');
  const fullscreen = await evaluate(`!!document.fullscreenElement`);
  check(await shown('p-fin-state') && await text('p-fin-desc') === '1 part: 2' && await shown('p-all'), `the sending screen: Finishing ${await text('p-fin-desc')}, with Send everything (full screen: ${fullscreen})`);
  // F opens the field on the sending screen; new words replace the old
  await evaluate(`document.getElementById('stop').focus(), true`);
  await key('f', 'KeyF', 70, 'f');
  check(await shown('p-fin') && await active() === 'p-fin-in' && await val('p-fin-in') === '' && await shown('p-fin-close'), 'F opens the finish field, empty and focused (the F is not typed), with Close');
  await type(code1.split(' ')[0].slice(0, 3));
  if (SHOTS) await shot('finish-sender-stage-typing.png');
  await setField('p-fin-in', code1);
  await key(' ', 'Space', 32, ' ');
  check(await stageOn(), 'Space in the field types a space (the stage stays)');
  await enter();
  check(!(await shown('p-fin')) && await text('p-fin-desc') === '1 part: 1', `new words replace the old: Finishing ${await text('p-fin-desc')}`);
  if (SHOTS) await shot('finish-sender-stage.png');
  // a refused code on the sending screen changes nothing; Enter on an empty field just closes it
  await key('f', 'KeyF', 70, 'f');
  await type('qqqz'); await enter();
  check(/qqqz/.test(await text('p-fin-msg')) && await text('p-fin-desc') === '1 part: 1', `a refused word on the sending screen: named, the parts unchanged (${await text('p-fin-msg')})`);
  await setField('p-fin-in', ''); await enter();
  check(!(await shown('p-fin')) && await text('p-fin-desc') === '1 part: 1' && await stageOn(), 'Enter on an empty field closes it; the words stay');
  // Esc in the field closes it; Esc with the field open and the focus elsewhere closes it too; Close closes it
  await key('f', 'KeyF', 70, 'f'); await key('Escape', 'Escape', 27);
  check(!(await shown('p-fin')) && await stageOn(), 'Esc in the field closes it; sending goes on');
  await key('f', 'KeyF', 70, 'f'); await evaluate(`document.getElementById('stop').focus(), true`); await key('Escape', 'Escape', 27);
  check(!(await shown('p-fin')) && await stageOn(), 'Esc with the field open and the focus on Stop closes the field, does not stop');
  await key('f', 'KeyF', 70, 'f'); await click('#p-fin-close');
  check(!(await shown('p-fin')) && await stageOn() && await active() === 'p-fin-btn', 'Close closes the field; the focus returns to Finish words');
  // leaving full screen while the field is open (Esc in a browser without Keyboard Lock): the field closes and
  // sending goes on in the window
  if (fullscreen) {
    // Esc in full screen with the field open: the field closes and sending goes on (Keyboard Lock keeps Esc for
    // the page where the browser has it; elsewhere the browser leaves full screen and the page carries on)
    await key('f', 'KeyF', 70, 'f'); await sleep(300);
    const lock = await evaluate(`!!(navigator.keyboard && navigator.keyboard.lock)`);
    await key('Escape', 'Escape', 27); await sleep(600);
    check(!(await shown('p-fin')) && await stageOn(), `Esc in full screen with the field open: the field closes, sending goes on (Keyboard Lock ${lock ? 'offered' : 'absent'}; still full screen: ${await evaluate(`!!document.fullscreenElement`)})`);
    if (!(await evaluate(`!!document.fullscreenElement`))) await evaluate(`document.getElementById('stage').requestFullscreen().then(() => true, () => false)`);
  }
  if (fullscreen && await evaluate(`!!document.fullscreenElement`)) {
    await key('f', 'KeyF', 70, 'f');
    await evaluate(`document.exitFullscreen().then(() => true)`); await sleep(400);
    check(!(await shown('p-fin')) && await stageOn() && !(await evaluate(`!!document.fullscreenElement`)), 'full screen left with the field open: the field closes, sending goes on in the window');
  } else console.log('     (this Chrome did not go full screen: the leave-full-screen case is not exercised here)');
  await click('#p-all');
  check(!(await shown('p-fin-state')) && !(await shown('p-all')) && await val('fin') === '', 'Send everything: back to every part, the words cleared');
  // the centre layout (no margin beside or above the tile): the field opens in a column of its own
  await size(1100, 920);
  await sleep(300);
  await key('f', 'KeyF', 70, 'f');
  const layout = await evaluate(`document.getElementById('stage').className`);
  check(/over|top/.test(layout) && await shown('p-fin'), `in the ${layout.match(/over|top|side/)} layout the field opens too`);
  if (SHOTS) await shot('finish-sender-stage-over.png');
  await key('Escape', 'Escape', 27); await key('Escape', 'Escape', 27);
  check(!(await stageOn()), 'Esc with the field closed stops');

  // the countdown ending while the field is open keeps the focus in the field: the next Space types a space and
  // does not stop the transfer
  await size(1600, 1000);
  await send('Page.navigate', { url: `${BASE}/${PAGE}?testfile=20&lead=2` }, S);
  check(await until(`!document.getElementById('start').disabled && !!window.LensBoltFinish`), 'the sender again, with a 2 s countdown');
  await click('#start');
  check(await until(`document.getElementById('stage').classList.contains('counting') && document.activeElement && document.activeElement.id === 'go-now'`), 'the countdown runs');
  await key('f', 'KeyF', 70, 'f');
  await type('tul');
  check(await until(`document.getElementById('stage').classList.contains('sending')`, 5000), 'the countdown ends while typing');
  await sleep(200);
  check(await active() === 'p-fin-in', `the focus stays in the field when sending begins (${await active()})`);
  await key(' ', 'Space', 32, ' ');
  check(await stageOn() && /tul $/.test(await val('p-fin-in')), `Space then types into the field and the transfer goes on (${JSON.stringify(await val('p-fin-in'))})`);
  await key('Escape', 'Escape', 27); await key('Escape', 'Escape', 27);

  // words stay with their file: words typed for one file are cleared when another file is chosen (checked against
  // it, a wrong code passes 1 time in 64); the same file chosen again (a resume), and words typed before any file, stay
  await send('Page.navigate', { url: `${BASE}/${PAGE}?lead=0` }, S);
  check(await until(`!!window.LensBolt && !!window.LensBoltFinish`), 'the sender, no file chosen');
  const choose = async (name, mb, lm) => {
    await evaluate(`(() => { const n = Math.round(${mb} * 1e6), d = new Uint8Array(n); let x = 2463534242; for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; d[i] = x & 255; }
      // the file chosen in place of the last one: the list emptied, then this file added
      document.getElementById('clear').click();
      const dt = new DataTransfer(); dt.items.add(new File([d], ${JSON.stringify(name)}, { lastModified: ${lm} })); const f = document.getElementById('file'); f.files = dt.files; f.dispatchEvent(new Event('change')); return true; })()`);
    return until(`!document.getElementById('start').disabled && [...document.querySelectorAll('#list .name')].map((n) => n.title).join() === ${JSON.stringify(name)}`);
  };
  const ACCEPTED = 'Start sends only the parts these words name.';
  const focusFin = () => evaluate(`document.getElementById('fin').focus(), true`);
  await focusFin(); await setField('fin', code2); await enter();
  check(await val('fin') === code2 && await text('fin-msg') === ACCEPTED, `words typed before any file are accepted (${await text('fin-msg')})`);
  await choose('test-20MB.bin', 20, 1);
  check(await val('fin') === code2 && await text('fin-msg') === ACCEPTED, 'words typed before any file stay with the file chosen');
  await choose('test-20MB.bin', 20, 1);
  check(await val('fin') === code2 && await text('fin-msg') === ACCEPTED, 'the same file chosen again (a resume): the words stay');
  await choose('other.bin', 2, 5);
  check(await val('fin') === '' && await text('fin-msg') === '' && await evaluate(`!document.getElementById('fin').hasAttribute('aria-invalid')`), `another file chosen: the words for the last one are cleared (${JSON.stringify(await val('fin'))})`);
  await click('#start');
  // the first Start of this browser without ?testfile: the flashing notice, acknowledged with its own Start
  if (await until(`!document.getElementById('flash').hidden`, 1000)) await click('#flash-ok');
  check(await until(`document.getElementById('stage').classList.contains('sending')`), 'Start with the other file');
  check(!(await shown('p-fin-state')) && !(await shown('p-all')), "the other file is sent in full: the first file's words are never applied to it");
  await key('Escape', 'Escape', 27);
  // words typed with a file chosen belong to it: another file clears them too
  await focusFin(); await setField('fin', code2); await enter();
  check(await text('fin-msg') === ACCEPTED, 'words typed with the other file chosen');
  await choose('test-20MB.bin', 20, 1);
  check(await val('fin') === '' && await text('fin-msg') === '', 'words typed for one file are cleared when another is chosen');

  // the named parts sent, the sender goes back to every part by itself and says so; new words name parts again
  await send('Page.navigate', { url: `${BASE}/${PAGE}?testfile=17&lead=0` }, S);
  check(await until(`!document.getElementById('start').disabled && !!window.LensBoltFinish`), 'a 17 MB test file (part 2 is 218 blocks)');
  const code17 = await evaluate(`(() => {
    const n = 17e6, d = new Uint8Array(n); let x = 2463534242; for (let i = 0; i < n; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; d[i] = x & 255; }
    const [id, parts] = LensBolt.finish_context('test-17MB.bin', d).split(',').map(Number); return LensBolt.finish_code(id, parts, Uint32Array.from([1])); })()`);
  await focusFin(); await setField('fin', code17); await enter();
  await click('#start');
  check(await until(`document.getElementById('stage').classList.contains('sending')`) && await text('p-fin-desc') === '1 part: 2', `sending only part 2 (${await text('p-fin-desc')})`);
  const DONE = "Named parts sent; sending everything. Type the phone's new words to finish faster.";
  check(await until(`!document.getElementById('p-fin-done').hidden`, 20000) && await text('p-fin-done') === DONE, `the part sent: "${await text('p-fin-done')}"`);
  check(!(await shown('p-fin-state')) && !(await shown('p-all')) && await evaluate(`document.getElementById('p-fin-done').getAttribute('role')`) === 'status', 'no longer Finishing, no Send everything; the line is a status');
  if (SHOTS) await shot('finish-sender-stage-done.png');
  await key('f', 'KeyF', 70, 'f'); await setField('p-fin-in', code17); await enter();
  check(await shown('p-fin-state') && await text('p-fin-desc') === '1 part: 2' && !(await shown('p-fin-done')), 'new words: Finishing again, the line goes');
  await key('Escape', 'Escape', 27);

  // calibration words and the carousel are lab tools: hidden unless the page is opened with ?lab=1
  await send('Page.navigate', { url: `${BASE}/${PAGE}?testfile=17&lead=0` }, S);
  check(await until(`!document.getElementById('start').disabled && !!window.LensBoltFinish`), 'the sender again');
  await evaluate(`document.querySelector('details.adv').open = true`);
  check(!(await shown('code')) && !(await shown('calib')) && await shown('fps'), 'without ?lab=1: no calibration words field, no carousel; the frame rate stays');
  // calibration words: what they mean next to the field; the frame rate select is not changed while typing, only at Start
  await send('Page.navigate', { url: `${BASE}/${PAGE}?testfile=17&lead=0&lab=1` }, S);
  check(await until(`!document.getElementById('start').disabled && !!window.LensBoltFinish`), 'the sender again, ?lab=1');
  await evaluate(`document.querySelector('details.adv').open = true`);
  check(await shown('code') && await shown('calib'), '?lab=1: the calibration words field and the carousel');
  const fps0 = await val('fps');
  await setField('code', 'song-pretzel');
  check(await text('code-meaning') === '2 px · black and white · 60 fps' && await val('fps') === fps0, `calibration words: "${await text('code-meaning')}", the frame rate select still ${await val('fps')}`);
  if (SHOTS) await shot('finish-sender-calibration.png');
  await setField('code', 'song-pretz');
  check(await text('code-meaning') === '' && await val('fps') === fps0, 'a word being typed: no meaning, the select unchanged');
  await setField('code', 'tofu-studio');
  check(await text('code-meaning') === '3 px · 8 colours · 20 fps' && await val('fps') === fps0, `another code: ${await text('code-meaning')}`);
  await setField('code', 'song-pretzel');
  await evaluate(`document.getElementById('start').scrollIntoView({ block: 'center' }), true`);
  await click('#start');
  check(await until(`document.getElementById('stage').classList.contains('sending')`) && await val('fps') === '60', `Start: the select shows the words' frame rate (${await val('fps')})`);
  await key('Escape', 'Escape', 27);

  // ---------- the receiver ----------
  // a stand-in for the decode worker: 'ready' on init, then the statuses this test pushes
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const fake = () => { const ls = []; const w = { onmessage: null, addEventListener(t, f) { if (t === 'message') ls.push(f); }, terminate() {},
      postMessage(m) { const reply = (d) => setTimeout(() => { const ev = { data: d }; ls.forEach((f) => f(ev)); if (w.onmessage) w.onmessage(ev); }, 5);
        if (m.type === 'init' || m.type === 'reset') reply({ type: 'ready', proto: 2 }); else if (m.type === 'selftest') window.__push = (s) => reply({ type: 'status', status: s }); } };
      return w; };
    Object.defineProperty(window, 'lensboltWorker', { value: fake, writable: false, configurable: false });
  })();` }, S);
  const status = (o) => JSON.stringify({ frames: 1480, decoded: 1466, failed: 14, have_manifest: true, filename: 'site-backup-2026-10.tar', stream_size: 524288000, received_bytes: 497025024,
    mbit_per_s: 21.36, format: '2px bw 1024x1024', cell_px: 3.1, codewords_ok: 83, codewords: 83, sharpness: 9.2, sender_fps: 30, edges: [1, 1, 1, 1], complete: false, finish_words: 'lantern walnut tulip', finish_parts: 'Parts 7, 12–15, 30', ...o });
  for (const [name, w2, h2, mobile] of [['phone', 390, 844, true], ['desktop', 1280, 800, false]]) {
    await size(w2, h2, mobile);
    await send('Page.navigate', { url: `${BASE}/${RPAGE}?selftest=1` }, S);
    check(await until(`typeof window.__push === 'function'`), `${name}: the receiver runs with the stand-in worker`);
    await evaluate(`window.__push(${status({})}), true`);
    await until(`!document.getElementById('finish').hidden`, 3000);
    check(await shown('finish') && await text('finish-words') === 'lantern walnut tulip' && await text('finish-lead') === 'Type these on the sender to finish faster', `${name}: the words under the progress, with the line above them`);
    check(await shown('finish-parts') && await text('finish-parts') === 'Parts 7, 12–15, 30', `${name}: the parts the words send, under them (${await text('finish-parts')})`);
    const look = await evaluate(`(() => { const s = getComputedStyle(document.getElementById('finish-words')); return { size: parseFloat(s.fontSize), select: s.userSelect || s.webkitUserSelect }; })()`);
    check(look.size >= 24 && look.select === 'text', `${name}: large (${look.size}px) and selectable (${look.select})`);
    if (SHOTS) await shot(`finish-receive-${name}.png`);
  }
  await send('Browser.grantPermissions', { origin: BASE, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
  await click('#copy');
  await sleep(200);
  const copied = await text('copy-text');
  const clip = copied === 'Copied' ? await evaluate(`navigator.clipboard.readText().catch(() => '')`) : await evaluate(`getSelection().toString()`);
  check((copied === 'Copied' || copied === 'Selected') && clip === 'lantern walnut tulip', `Copy: ${copied} (${JSON.stringify(clip)})`);
  check(/^Finish words (copied|selected)/.test(await text('copy-say')) && await evaluate(`document.getElementById('copy-say').getAttribute('aria-live')`) === 'polite', `what Copy did is announced (${await text('copy-say')})`);
  await evaluate(`window.__push(${status({ finish_words: 'lantern walnut', finish_parts: null })}), true`); await sleep(100);
  check(await text('finish-words') === 'lantern walnut' && !(await shown('finish-parts')), 'the words follow the receiver as parts finish (a status without parts: no parts line)');
  await evaluate(`window.__push(${status({ finish_words: 'lantern walnut', finish_parts: 'Part 2' })}), true`); await sleep(100);
  check(await text('finish-parts') === 'Part 2' && await shown('finish-parts'), 'the parts line follows the words');
  await evaluate(`window.__push(${status({ finish_words: null })}), true`); await sleep(100);
  check(!(await shown('finish')), 'no words offered: none shown');
  await evaluate(`window.__push(${status({ complete: true, received_bytes: 524288000 })}), true`); await sleep(100);
  check(!(await shown('finish')), 'complete: no words');
  // short phones with a four-word code: the sheet never covers the aiming frame; Copy is its icon
  for (const [w2, h2] of [[360, 640], [375, 667]]) {
    await size(w2, h2, true);
    await send('Page.navigate', { url: `${BASE}/${RPAGE}?selftest=1` }, S);
    await until(`typeof window.__push === 'function'`);
    await evaluate(`window.__push(${status({ finish_words: 'acrobat brownie cabinet whistle' })}), true`);
    await until(`!document.getElementById('finish').hidden`, 3000);
    await sleep(300);
    const g = await evaluate(`(() => { const r = document.querySelector('.reticle').getBoundingClientRect(), sh = document.getElementById('sheet').getBoundingClientRect(), c = document.getElementById('copy').getBoundingClientRect();
      return { frame: Math.round(r.bottom), sheet: Math.round(sh.top), size: parseFloat(getComputedStyle(document.getElementById('finish-words')).fontSize), copyW: Math.round(c.width), label: getComputedStyle(document.getElementById('copy-text')).display }; })()`);
    check(g.frame <= g.sheet, `${w2}x${h2}, four words: the aiming frame ends at ${g.frame} px, the sheet starts at ${g.sheet} px (words ${g.size} px)`);
    check(g.label === 'none' && g.copyW <= 48, `${w2}x${h2}: Copy is its icon (${g.copyW} px wide)`);
    if (SHOTS) await shot(`finish-receive-phone-${w2}x${h2}.png`);
  }
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

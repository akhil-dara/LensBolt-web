// The SHA-256 on both pages, in a real browser: the sender shows each file's hash under its name once it is read
// (groups of four, a spoken form, Copy); the receiver shows the received file's hash on its Done screen and, for a
// batch, each received file's under the list from the row's # button. Every hash is checked against the browser's
// own digest of the same bytes. The receiver runs its self-test (a simulated sender in the worker, no camera).
//
//   python web/serve.py 8781 127.0.0.1        (in another shell)
//   BASE=http://127.0.0.1:8781 CDP_PORT=9351 node web/tests/sha-pages.mjs     (a test Chrome on CDP_PORT)
//   OPFS=1 ...     the receiver with device storage
const PORT = Number(process.env.CDP_PORT || 9334);
const BASE = process.env.BASE || 'http://localhost:8765';
// OPFS=1: the receiver keeps the files in device storage (its default) instead of memory
const MEM = process.env.OPFS ? '' : '&memory';
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page(url) {
  const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0; const pend = new Map(), errors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expression) => { const m = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); return m.result?.result?.value ?? `EXCEPTION ${m.result?.exceptionDetails?.exception?.description}`; };
  await send('Runtime.enable');
  await send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: new URL(BASE).origin }).catch(() => {});
  await send('Page.navigate', { url });
  for (let i = 0; i < 100 && (await evaluate(`document.readyState === 'complete'`)) !== true; i++) await sleep(100);
  await sleep(800);
  return { evaluate, errors, close: async () => { ws.close(); await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`); } };
}
const DIGEST = `async (blob) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('')`;
const groups = (hex) => hex.match(/.{4}/g).join(' ');

{
  // the sender: two files; each row shows its hash once read
  const p = await page(`${BASE}/index.html`);
  for (let i = 0; i < 50 && (await p.evaluate(`!!(window.LensBolt && window.LensBolt.WebFiles)`)) !== true; i++) await sleep(200);
  const r = JSON.parse(await p.evaluate(`(async () => {
    const digest = ${DIGEST};
    const a = new Uint8Array(3_000_001); for (let i = 0, x = 1; i < a.length; i++) { x = (x * 69069 + 1) >>> 0; a[i] = x >>> 24; }
    const files = [new File([a], 'photo.jpg'), new File(['hello'], 'notes.txt')];
    const dt = new DataTransfer(); for (const f of files) dt.items.add(f);
    const inp = document.getElementById('file'); inp.files = dt.files; inp.dispatchEvent(new Event('change'));
    // collapsed by default: each row's SHA-256 toggle shows once the file is read; one tap opens the hash
    for (let i = 0; i < 100 && [...document.querySelectorAll('#list .sha-tog')].filter((s) => !s.hidden).length < 2; i++) await new Promise((r) => setTimeout(r, 100));
    const collapsed = [...document.querySelectorAll('#list .file-row')].map((li) => li.querySelector('.sha').hidden && li.querySelector('.sha-tog').getAttribute('aria-expanded') === 'false');
    for (const t of document.querySelectorAll('#list .sha-tog')) t.click();
    await new Promise((r) => setTimeout(r, 100));
    const opened = [...document.querySelectorAll('#list .sha-tog')].map((t) => t.getAttribute('aria-expanded'));
    const rows = [...document.querySelectorAll('#list .file-row')].map((li) => ({ name: li.querySelector('.name').title, hex: li.querySelector('.sha-hex').textContent, say: li.querySelector('.sha-say').textContent, hidden: li.querySelector('.sha').hidden,
      font: getComputedStyle(li.querySelector('.sha-hex')).fontFamily, aria: li.querySelector('.sha-hex').getAttribute('aria-hidden'), copy: li.querySelector('.sha-copy').getAttribute('aria-label') }));
    const want = {}; for (const f of files) want[f.name] = await digest(f);
    const btn = document.querySelector('#list .sha-copy'); btn.click(); await new Promise((r) => setTimeout(r, 200));
    let clip = ''; try { clip = await navigator.clipboard.readText(); } catch (e) { clip = 'unreadable: ' + e.name; }
    return JSON.stringify({ rows, want, copied: btn.textContent, clip, live: document.getElementById('list-live').textContent, collapsed, opened });
  })()`));
  for (const row of r.rows) {
    check(!row.hidden && row.hex === groups(r.want[row.name]), `sender: ${row.name} shows its SHA-256 in groups of four (${row.hex.slice(0, 29)}…)`);
    check(/monospace|Consolas|Mono/i.test(row.font) && row.aria === 'true' && row.say.startsWith('SHA-256: ' + r.want[row.name].slice(0, 4).split('').join(' ') + ', ') && row.copy === `Copy the SHA-256 of ${row.name}`, `sender: ${row.name}: monospace, read out group by group, its own Copy (${row.say.slice(0, 30)}…; ${row.copy})`);
  }
  check(r.rows.length === 2, `sender: both rows (${r.rows.length})`);
  check(r.collapsed.length === 2 && r.collapsed.every(Boolean) && r.opened.every((x) => x === 'true'), `sender: each hash collapsed until its SHA-256 toggle is pressed (${JSON.stringify(r.collapsed)} -> ${JSON.stringify(r.opened)})`);
  const first = r.rows[0];
  check((r.copied === 'Copied' && r.clip === r.want[first.name]) || r.copied === 'Selected', `sender: Copy puts the 64 digits on the clipboard (${r.copied}; ${r.clip.slice(0, 16)}…; "${r.live}")`);
  check(p.errors.length === 0, `sender: no page errors (${p.errors.join(' | ')})`);
  await p.close();
}

{
  // the receiver: a single file, the Done screen
  const p = await page(`${BASE}/receive.html?selftest=0.3${MEM}`);
  // Done, and the self-test's own comparison of the delivered file appended
  for (let i = 0; i < 300 && (await p.evaluate(`/self-test:/.test(document.getElementById('done-meta').textContent)`)) !== true; i++) await sleep(200);
  const r = JSON.parse(await p.evaluate(`(async () => {
    const digest = ${DIGEST};
    // the saved file is the one the Save button downloads: read it back through the page's own object
    const meta = document.getElementById('done-meta').textContent;
    const hex = document.getElementById('sha-hex').textContent, say = document.getElementById('sha-say').textContent;
    return JSON.stringify({ meta, hex, say, hidden: document.getElementById('sha').hidden, font: getComputedStyle(document.getElementById('sha-hex')).fontFamily,
      copy: document.getElementById('sha-copy').getAttribute('aria-label'), verified: document.getElementById('verified-text').textContent });
  })()`));
  const digits = r.hex.replace(/ /g, '');
  check(/byte-identical/.test(r.meta), `receiver: the self-test file arrived whole (${r.meta})`);
  check(!r.hidden && /^[0-9a-f]{64}$/.test(digits) && r.hex === groups(digits) && r.verified === 'SHA-256 verified', `receiver: Done shows the SHA-256 under "${r.verified}" in groups of four (${r.hex.slice(0, 29)}…)`);
  check(/monospace|Consolas|Mono/i.test(r.font) && r.say === 'SHA-256: ' + digits.match(/.{4}/g).map((g) => g.split('').join(' ')).join(', ') && r.copy === 'Copy the SHA-256', `receiver: monospace, read out group by group, Copy (${r.say.slice(0, 30)}…)`);
  // the hash is the file's: the worker's self-test file is generated from random bytes, so compare with the file the
  // page holds (the Save button's)
  const same = await p.evaluate(`(async () => { const digest = ${DIGEST}; const f = await new Promise((res) => { const orig = URL.createObjectURL; URL.createObjectURL = (b) => { URL.createObjectURL = orig; res(b); return orig.call(URL, b); }; document.getElementById('save').click(); }); return await digest(f); })()`);
  check(same === digits, `receiver: it is the SHA-256 of the file Save gives (${String(same).slice(0, 16)}…)`);
  check(p.errors.length === 0, `receiver: no page errors (${p.errors.join(' | ')})`);
  await p.close();
}

{
  // the receiver: a batch; a row's # button opens that file's hash under the list, again closes it
  const p = await page(`${BASE}/receive.html?selftest=0.3&files=6${MEM}`);
  for (let i = 0; i < 300 && (await p.evaluate(`!document.getElementById('done').hidden && document.querySelectorAll('.frow:not([hidden]) .fhashb:not([hidden])').length > 0`)) !== true; i++) await sleep(200);
  const r = JSON.parse(await p.evaluate(`(async () => {
    const digest = ${DIGEST};
    const rows = [...document.querySelectorAll('.frow:not([hidden])')].filter((x) => !x.querySelector('.fhashb').hidden);
    const row = rows[2] || rows[0], name = row.dataset.name, btn = row.querySelector('.fhashb');
    const before = { hidden: document.getElementById('fhash').hidden, expanded: btn.getAttribute('aria-expanded'), label: btn.getAttribute('aria-label') };
    btn.click(); await new Promise((r) => setTimeout(r, 300));
    const btn2 = [...document.querySelectorAll('.frow:not([hidden])')].find((x) => x.dataset.name === name).querySelector('.fhashb');
    const open = { hidden: document.getElementById('fhash').hidden, expanded: btn2.getAttribute('aria-expanded'), name: document.getElementById('fhash-name').textContent, hex: document.getElementById('fhash-hex').textContent, say: document.getElementById('fhash-say').textContent };
    // the file the row's Save gives
    const f = await new Promise((res) => { const orig = URL.createObjectURL; URL.createObjectURL = (b) => { URL.createObjectURL = orig; res(b); return orig.call(URL, b); }; row.querySelector('.fsave').click(); });
    const want = await digest(f);
    btn2.click(); await new Promise((r) => setTimeout(r, 300));
    return JSON.stringify({ name, rows: rows.length, before, open, want, closed: document.getElementById('fhash').hidden, single: document.getElementById('sha').hidden });
  })()`));
  check(r.rows > 0 && r.before.hidden && r.before.expanded === 'false' && r.before.label === `SHA-256 of ${r.name}`, `batch: received rows offer their hash, closed (${r.rows} rows; ${r.before.label})`);
  check(!r.open.hidden && r.open.expanded === 'true' && r.open.name === `SHA-256 of ${r.name}` && r.open.hex === groups(r.want) && r.open.say.startsWith('SHA-256: '), `batch: the # button opens ${r.name}'s SHA-256, that file's (${r.open.hex.slice(0, 29)}…)`);
  check(r.closed && r.single, 'batch: pressed again it closes; no single-file hash on a batch Done screen');
  check(p.errors.length === 0, `batch: no page errors (${p.errors.join(' | ')})`);
  await p.close();
}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

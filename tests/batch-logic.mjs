// The browser receiver's batch view on its own (web/batch-logic.js): the summary in real numbers, each file's state
// in plain words, the filters, which rows a scrolled list draws, names shortened in the middle only when they do not
// fit (the extension kept), names made free in a folder, and the stored zip Save all writes (checked by Python's
// zipfile). No browser, no wasm.
//
//   node web/tests/batch-logic.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { human, count, summaryLive, summaryDone, stateText, rowLabel, FILTERS, filterCounts, inFilter, visibleRows, splitName, middleFit, freeName, crc32, zipParts, keptInOrder, Announcer, rowPlan, batchNeed, badge, doneState, discardAsk, filterCountsOf } from '../batch-logic.js';

import { tempProfile } from './chrome-profile.mjs';
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const MB = 1048576;

// --- the summary, in real numbers ---
check(human(0) === '0 B' && human(3440) === '3 KB' && human(2.2 * MB) === '2.2 MB' && human(3 * 1073741824) === '3.00 GB', 'sizes as the receiver shows them');
check(summaryLive({ total: 0, received: 0, failed: 0, error: null }, 0, 64 * MB) === 'Waiting for the file list', 'before the list');
check(summaryLive({ total: 40, received: 12, failed: 0, error: null }, 18 * MB, 64 * MB) === '12 of 40 files · 18.0 MB of 64.0 MB', 'receiving');
check(summaryLive({ total: 40, received: 12, failed: 2, error: null }, 18 * MB, 64 * MB) === '12 of 40 files · 2 failed · 18.0 MB of 64.0 MB', 'receiving with failures');
check(summaryLive({ total: 1, received: 0, failed: 0, error: null }, 0, 10) === '0 of 1 file · 0 B of 10 B', 'one file');
check(summaryLive({ total: 3, received: 0, failed: 0, error: 'checksum mismatch' }, 0, 10) === 'The file list did not verify: no file can be saved.', 'a refused list');
check(summaryDone({ total: 3, received: 3, failed: 0, error: null }, 2.2 * MB) === '3 files · 2.2 MB · all verified', 'done: all verified, the size the files add up to');
check(summaryDone({ total: 40, received: 38, failed: 2, error: null }, 2.1 * MB) === '38 of 40 files · 2.1 MB · 2 failed', 'done with failures');
check(summaryDone({ total: 1, received: 1, failed: 0, error: null }, 0) === '1 file · 0 B · verified', 'one empty file');
// a file received and verified but not kept on the device (its copy hit a full storage): never "all verified"
check(summaryDone({ total: 40, received: 40, failed: 0, error: null }, 2 * MB, 2, 'storage full') === '38 of 40 kept · 2 not kept: storage full', `done, two copies not kept (${summaryDone({ total: 40, received: 40, failed: 0, error: null }, 2 * MB, 2, 'storage full')})`);
check(summaryDone({ total: 40, received: 39, failed: 1, error: null }, 2 * MB, 1, 'storage full') === '38 of 40 kept · 1 not kept: storage full · 1 failed', 'done, one not kept and one failed');
check(!/verified/.test(summaryDone({ total: 1, received: 1, failed: 0, error: null }, 0, 1, 'storage full')), 'one file not kept: not "verified"');
check(count(7) === '7' && count(10000) === '10,000' && count(1234567) === '1,234,567' && summaryLive({ total: 10000, received: 1650, failed: 0, error: null }, 0, 0) === '1,650 of 10,000 files · 0 B of 0 B', 'counts with thousands separated');

// --- a file's state, in plain words; a row as a screen reader reads it ---
check(stateText({ state: 'waiting' }) === 'Waiting' && stateText({ state: 'receiving', progress: 0.404 }) === 'Receiving 40%' && stateText({ state: 'received' }) === 'Received', 'waiting, receiving, received');
check(stateText({ state: 'failed', reason: 'storage full' }) === 'Failed: storage full' && stateText({ state: 'failed', reason: 'checksum mismatch' }) === 'Failed: its bytes did not verify', 'failed, with the reason in plain words');
check(rowLabel({ name: 'photo.jpg', size: 2.1 * MB, state: 'received' }) === 'photo.jpg, 2.1 MB, received', 'a row read aloud');

// --- filters: Missing is every file neither received nor failed ---
check(eq(FILTERS, ['all', 'received', 'missing', 'failed']), 'All, Received, Missing, Failed');
check(eq(filterCounts({ total: 40, received: 12, failed: 2 }), { all: 40, received: 12, missing: 26, failed: 2 }), 'their counts');
check(['waiting', 'receiving'].every((s) => inFilter(s, 'missing')) && !inFilter('received', 'missing') && !inFilter('failed', 'missing') && inFilter('failed', 'all') && inFilter('received', 'received'), 'which files each shows');

// --- a long list draws only the rows in view (and a few around them) ---
check(eq(visibleRows(0, 400, 72, 10000, 4), [0, 10]) && eq(visibleRows(72 * 5000, 400, 72, 10000, 4), [4996, 5010]) && eq(visibleRows(72 * 9999, 400, 72, 10000, 4), [9995, 10000]) && eq(visibleRows(0, 400, 72, 3, 4), [0, 3]), 'the rows to draw: those in view and 4 either side');

// --- names: whole when they fit, else shortened in the middle with the extension kept ---
check(eq(splitName('photo.jpeg'), ['photo', '.jpeg']) && eq(splitName('.bashrc'), ['.bashrc', '']) && eq(splitName('archive.tar.gz'), ['archive.tar', '.gz']), 'stem and extension');
const fitsIn = (n) => (t) => t.length <= n;
check(middleFit('holiday.jpg', fitsIn(40)) === 'holiday.jpg', 'a name that fits is whole');
const long = 'holiday-photo-from-the-beach-at-sunset-with-everyone.jpeg';
const cut = middleFit(long, fitsIn(30));
check(cut.length === 30 && cut.endsWith('.jpeg') && cut.startsWith('holiday-photo') && cut.includes('…'), `shortened in the middle, the extension kept: ${cut}`);
check(middleFit('x'.repeat(50), fitsIn(9)).length === 9, 'no extension: still within');
check(middleFit(long, fitsIn(3)).endsWith('.jpeg'), 'never drops the extension');

// --- a name made free in a folder (the receiver's own rule: " (2)" before the extension) ---
const taken = new Set(['photo.jpg', 'photo (2).jpg', 'readme']);
check(freeName('photo.jpg', (n) => taken.has(n)) === 'photo (3).jpg' && freeName('readme', (n) => taken.has(n)) === 'readme (2)' && freeName('new.txt', (n) => taken.has(n)) === 'new.txt', 'a taken name gets the next free number');

// --- CRC-32 and the stored zip, read back by Python's zipfile ---
check(crc32(new TextEncoder().encode('123456789')) === 0xCBF43926, 'CRC-32 check value');
const parts = new TextEncoder().encode('12345'), rest = new TextEncoder().encode('6789');
check(crc32(rest, crc32(parts)) === 0xCBF43926, 'CRC-32 in pieces');
const dir = tempProfile('lb-zip-');
const files = [['a.txt', 'hello\n'], ['photo (2).jpg', 'x'.repeat(70000)], ['empty.dat', ''], ['naïve – ünïcode.txt', 'utf-8 name\n']].map(([name, text]) => {
  const data = new TextEncoder().encode(text);
  return { name, size: data.length, crc: crc32(data), data };
});
for (const zip64 of [false, true]) {
  const bytes = Buffer.concat(zipParts(files, { zip64, date: new Date(2026, 9, 30, 21, 15, 30) }).map((p) => Buffer.from(p)));
  const path = join(dir, `t${zip64 ? 64 : 32}.zip`);
  writeFileSync(path, bytes);
  const py = `import zipfile,sys,json\nz=zipfile.ZipFile(sys.argv[1])\nprint(json.dumps({"bad":z.testzip(),"names":z.namelist(),"sizes":[i.file_size for i in z.infolist()],"stored":all(i.compress_type==0 for i in z.infolist()),"date":list(z.infolist()[0].date_time),"text":z.read("a.txt").decode()}))`;
  const out = JSON.parse(execFileSync('python', ['-I', '-c', py, path], { encoding: 'utf8' }));
  check(out.bad === null && eq(out.names, files.map((f) => f.name)) && eq(out.sizes, files.map((f) => f.size)) && out.stored && out.text === 'hello\n' && eq(out.date, [2026, 10, 30, 21, 15, 30]),
    `${zip64 ? 'zip64' : 'zip'}: Python reads every file back, stored, with UTF-8 names (${JSON.stringify(out)})`);
}
rmSync(dir, { recursive: true, force: true });
const many = Array.from({ length: 70000 }, (_, i) => ({ name: `f${i}`, size: 0, crc: 0, data: new Uint8Array(0) }));
const tail = zipParts(many, { date: new Date(2026, 0, 1) }).at(-1);
check(tail.length === 56 + 20 + 22, 'more than 65,535 files: zip64 on its own (its end records)');

// --- Save the files received so far: every file kept (not only the rows fetched), in the list's order ---
{
  const saved = new Map([['c.jpg', { store: 'f3' }], ['a.jpg', { store: 'f1' }], ['bad.jpg', { error: 'storage full' }], ['z.jpg', { store: 'f9' }]]);
  const idx = new Map([['a.jpg', 0], ['bad.jpg', 1], ['c.jpg', 700]]);
  check(eq(keptInOrder(saved, (n) => idx.get(n)), ['a.jpg', 'c.jpg', 'z.jpg']), `kept files by their place in the list, past the fetched rows too; one not kept left out; an unknown place last (${keptInOrder(saved, (n) => idx.get(n))})`);
}

// --- what a screen reader hears of the batch: the counts when they change, at most every 5 s ---
{
  const a = new Announcer(5000);
  const b = (received, failed = 0, total = 40) => ({ total, received, failed, error: null });
  check(a.update(b(0, 0, 0), 'Waiting for the file list', 0) === '', 'nothing before the list');
  check(a.update(b(0), '0 of 40 files', 100) === '0 of 40 files', 'the list arrives: said once');
  check(a.update(b(0), '0 of 40 files · 1 MB', 200) === '', 'bytes moving alone: not said');
  check(a.update(b(1), '1 of 40 files', 300) === '' && a.update(b(5), '5 of 40 files', 4000) === '', 'counts changing within 5 s: not said yet');
  check(a.update(b(6), '6 of 40 files', 5200) === '6 of 40 files', 'after 5 s: the latest counts');
  check(a.update(b(6), '6 of 40 files', 20000) === '', 'nothing new: nothing said');
  check(a.update(b(6, 1), '6 of 40 files · 1 failed', 20100) === '6 of 40 files · 1 failed', 'a failure is said at once');
}

// --- rows tied to files: a row keeps its file while it is in view; the focused row is never handed to another ---
{
  const plan = rowPlan(new Map([[0, 'r0'], [1, 'r1'], [2, 'r2']]), [1, 2, 3], null);
  check(eq([...plan.keep], [[1, 'r1'], [2, 'r2']]) && eq(plan.free, ['r0']) && eq(plan.need, [3]), `rows for files still in view stay; the others are free (${JSON.stringify({ keep: [...plan.keep], free: plan.free, need: plan.need })})`);
  const f = rowPlan(new Map([[0, 'r0'], [1, 'r1']]), [5, 6], 0);
  check(eq([...f.keep], [[0, 'r0']]) && eq(f.free, ['r1']) && eq(f.need, [5, 6]), 'the row holding the focus stays with its file, out of view');
}

// --- the space a batch needs: the receiver's peak and the largest file's extra copy on its way to a file of its own ---
check(batchNeed(100, 30) === 130 && batchNeed(100, 0) === 100 && batchNeed(0, 30) === 0, 'peak + the largest file (nothing before the peak is known)');

// --- state badges (not buttons): an icon and words for each state, never colour alone; Missing once the batch is done ---
{
  const f = (o) => ({ name: 'a.jpg', size: 10, state: 'waiting', ...o });
  check(eq(badge(f({ state: 'received' }), false, null), { tone: 'ok', icon: 'check', text: 'Received' }), 'received: a check and "Received"');
  check(eq(badge(f({ state: 'receiving', progress: 0.4 }), false, null), { tone: 'live', icon: 'down', text: 'Receiving 40%' }), 'receiving: its percent');
  check(eq(badge(f({}), false, null), { tone: 'wait', icon: 'clock', text: 'Waiting' }) && eq(badge(f({}), true, null), { tone: 'warn', icon: 'alert', text: 'Missing' }), "waiting while receiving, Missing once done (the filter's word)");
  check(eq(badge(f({ state: 'failed', reason: 'checksum mismatch' }), true, null), { tone: 'warn', icon: 'alert', text: 'Failed: its bytes did not verify' }), 'failed: why, in amber with an alert icon');
  check(eq(badge(f({ state: 'received' }), true, { error: 'storage full' }), { tone: 'warn', icon: 'alert', text: 'Not kept: storage full' }), 'received but not kept on this device: said');
  check([badge(f({ state: 'received' }), false, null), badge(f({}), true, null), badge(f({ state: 'failed' }), true, null)].every((b) => b.icon && b.text), 'every badge has an icon and words');
}
// --- the batch Done screen: all verified (good) or partial (amber), the guide pill's words ---
{
  check(eq(doneState({ total: 40, received: 40, failed: 0 }, 0), { tone: 'ok', guide: 'Received' }), 'all verified: the good tone, "Received"');
  check(eq(doneState({ total: 40, received: 38, failed: 2 }, 0), { tone: 'warn', guide: 'Received 38 of 40' }), 'two failed: amber, "Received 38 of 40"');
  check(eq(doneState({ total: 40, received: 40, failed: 0 }, 2), { tone: 'warn', guide: 'Kept 38 of 40' }), 'two not kept (storage full): amber');
  check(doneState({ total: 3, received: 0, failed: 0, error: 'x' }, 0).tone === 'warn', 'a refused list: amber');
  check(eq(filterCountsOf([{ state: 'received' }, { state: 'failed' }, { state: 'waiting' }, null, { state: 'receiving' }]), { all: 5, received: 1, missing: 3, failed: 1 }), 'the filters counted from the whole list on Done (a missing entry counts as missing)');
}
// --- Receive another with files not saved: asks first, Keep is the safe default ---
{
  const a = discardAsk({ batch: true, received: 40, name: 'trip' });
  check(a.title === 'Discard 40 received files?' && /not saved/.test(a.text) && a.discard === 'Discard' && a.keep === 'Keep them', `a batch: "${a.title}" ${a.text}`);
  check(discardAsk({ batch: true, received: 1 }).title === 'Discard 1 received file?' && discardAsk({ batch: false, name: 'photo.jpg' }).title === 'Discard photo.jpg?', 'one file, and a single transfer by its name');
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);

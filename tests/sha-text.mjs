// A file's SHA-256 as the pages show it (web/sha-text.js), and the sender's file store computing it as a file is
// read (WebFiles.sha256, the wasm in web/pkg, run in node): the same digest as node's own, whatever the pieces.
//
//   python web/build.py        (first: web/pkg)
//   node web/tests/sha-text.mjs
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shaGroups, shaShown, shaSpoken, shaRows } from '../sha-text.js';
import init, { WebFiles, WebSender } from '../pkg/lensbolt_web.js';

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const sha = (b) => createHash('sha256').update(b).digest('hex');

const abc = sha(Buffer.from('abc'));
check(abc === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'node: the SHA-256 of "abc"');
check(shaGroups(abc).length === 16 && shaGroups(abc)[0] === 'ba78' && shaGroups(abc)[15] === '15ad', 'sixteen groups of four');
check(shaShown(abc.toUpperCase()) === 'ba78 16bf 8f01 cfea 4141 40de 5dae 2223 b003 61a3 9617 7a9c b410 ff61 f200 15ad', `shown in lower case, a space between groups (${shaShown(abc)})`);
check(shaSpoken(abc).startsWith('SHA-256: b a 7 8, 1 6 b f, ') && shaSpoken(abc).endsWith(', 1 5 a d'), `spoken group by group, each character apart (${shaSpoken(abc).slice(0, 40)}…)`);
const rows = shaRows(abc);
check(rows.length === 2 && rows.every((l) => l.length === 2) && rows[0][0] === 'ba78 16bf 8f01 cfea' && rows[1][1] === 'b410 ff61 f200 15ad' && rows.flat().join(' ') === shaShown(abc), `two lines of eight, in quarters of four (${JSON.stringify(rows[0])})`);
check(shaRows('abc').length === 0, 'no rows for anything else');
check([undefined, null, '', 'abc', abc.slice(1), abc + '0', abc.replace('b', 'g')].every((x) => shaGroups(x).length === 0 && shaShown(x) === '' && shaSpoken(x) === ''), 'anything that is not 64 hex digits shows nothing');

await init({ module_or_path: readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'pkg', 'lensbolt_web_bg.wasm')) });
const fs = new WebFiles();
const data = new Uint8Array(5_000_003);
for (let i = 0, x = 7; i < data.length; i++) { x = (x * 1103515245 + 12345) >>> 0; data[i] = x >>> 24; }
const id = fs.begin('big.bin', data.length);
check(fs.sha256(id) === '', 'no hash while the file is read');
const t0 = performance.now();
for (let at = 0, k = 1; at < data.length; at += k * 65537, k++) fs.append(id, data.subarray(at, Math.min(data.length, at + k * 65537)));
check(fs.sha256(id) === '', 'no hash before the file is finished');
fs.finish(id);
const ms = performance.now() - t0;
check(fs.sha256(id) === sha(data), `read in uneven pieces: the file's SHA-256 (${fs.sha256(id).slice(0, 16)}…), read and hashed at ${(data.length / 1e6 / (ms / 1000)).toFixed(0)} MB/s`);
const empty = fs.begin('empty.txt', 0); fs.finish(empty);
check(fs.sha256(empty) === sha(Buffer.alloc(0)), 'an empty file: the hash of nothing');
check(fs.sha256(999) === '', 'an id not held: nothing');
// Start: a sender made from the list takes the hashes computed while reading (the file is not read again)
{
  const big = new Uint8Array(96 << 20); big.set(data.subarray(0, 1 << 20)); for (let at = 1 << 20; at < big.length; at <<= 1) big.copyWithin(at, 0, Math.min(at, big.length - at));
  const bid = fs.begin('big2.bin', big.length);
  for (let at = 0; at < big.length; at += 8 << 20) fs.append(bid, big.subarray(at, at + (8 << 20)));
  fs.finish(bid);
  let t = performance.now();
  const fromList = WebSender.from_files(fs, Uint32Array.of(bid), 1024, 1024, '', false);
  const listMs = performance.now() - t;
  t = performance.now();
  const hashing = new WebSender('big2.bin', big, 1024, 1024, '', false);
  const hashMs = performance.now() - t;
  console.log(`     Start with a 96 MiB file: ${listMs.toFixed(0)} ms from the list (hashed while read), ${hashMs.toFixed(0)} ms hashing it again`);
  check(fromList.finish_context() === hashing.finish_context(), 'the sender from the list is the same transfer (its id comes from the manifest, hashes included)');
  check(listMs < hashMs / 3, `Start does not hash the file again (${listMs.toFixed(0)} vs ${hashMs.toFixed(0)} ms)`);
  fromList.free(); hashing.free(); fs.remove(bid);
}
fs.remove(id);
check(fs.sha256(id) === '', 'a removed file: nothing');

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

// The sender's file store (WebFiles) in a WebAssembly memory capped at 256 MiB, under node: a file is taken only when
// the module keeps room to make a sender and draw frames from it afterwards (WebFiles::begin's headroom). Without that
// room, making the sender at Start ran out of memory inside WebAssembly: a trap ("unreachable"), after which the
// module may be left broken. Each case runs in a fresh module (a child process), as a page just loaded:
//   - the largest file begin takes: a sender is then made from it and draws frames, with no trap;
//   - a few MiB more: refused when begun, in plain words, nothing held;
//   - files taken, removed and taken again in one module: sent each time, nothing held after removal.
//
//   node web/tests/files-memory.mjs           (builds web/src for node, memory capped, into web/target/wasm-cap)
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const WEB = join(dirname(SELF), '..');
const CAP = 256 << 20, MiB = 1 << 20;
const OUT = join(WEB, 'target', 'wasm-cap');

// ---- a child: one case in a fresh module, its result as JSON on stdout ----
if (process.env.CASE) {
  const lb = createRequire(import.meta.url)(join(OUT, 'pkg', 'lensbolt_web.js'));
  const piece = new Uint8Array(8 * MiB).fill(7);
  const fs = new lb.WebFiles();
  const attempt = (size) => {
    let id;
    try { id = fs.begin('big.bin', size); } catch (e) { return { result: 'refused', why: String(e) }; }
    try {
      for (let at = 0; at < size; at += piece.length) fs.append(id, piece.subarray(0, Math.min(piece.length, size - at)));
      fs.finish(id);
      const s = lb.WebSender.from_files(fs, Uint32Array.from([id]), 1024, 1024, 'satin-swift', false);
      for (let i = 0; i < 4; i++) s.next_frame_rgba();
      s.free();
      return { result: 'sent', id };
    } catch (e) { return { result: e instanceof WebAssembly.RuntimeError ? `trap: ${e.message}` : `error: ${e}`, id }; }
  };
  const size = Number(process.env.SIZE) * MiB;
  let out;
  if (process.env.CASE === 'take') { try { fs.begin('x', size); out = { result: 'taken' }; } catch { out = { result: 'refused' }; } }
  else if (process.env.CASE === 'send') { const r = attempt(size); out = { ...r, count: fs.count(), held: fs.bytes_held() }; }
  else {
    const runs = [];
    for (const mb of [48, 32, 48]) { const r = attempt(mb * MiB); if (r.id) fs.remove(r.id); runs.push({ mb, result: r.result, count: fs.count(), held: fs.bytes_held() }); }
    out = { runs };
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
if (!process.env.NO_BUILD) {
  const env = { ...process.env, CARGO_TARGET_DIR: join(OUT, 'target'), RUSTFLAGS: `-C target-feature=+simd128 -C link-arg=--max-memory=${CAP}` };
  execFileSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown'], { cwd: WEB, env, stdio: 'inherit' });
  execFileSync('wasm-bindgen', ['--target', 'nodejs', '--out-dir', join(OUT, 'pkg'), join(OUT, 'target', 'wasm32-unknown-unknown', 'release', 'lensbolt_web.wasm')], { stdio: 'inherit' });
}
const run = (env) => JSON.parse(execFileSync(process.execPath, [SELF], { env: { ...process.env, ...env }, encoding: 'utf8' }));

// the largest file a fresh module takes, to 1 MiB
let lo = 0, hi = CAP / MiB;
while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (run({ CASE: 'take', SIZE: mid }).result === 'taken') lo = mid; else hi = mid - 1; }
console.log(`     the largest file a fresh module's store takes in a 256 MiB memory: ${lo} MiB`);
const big = run({ CASE: 'send', SIZE: lo });
check(big.result === 'sent', `${lo} MiB, the largest taken: a sender made and frames drawn, no trap (${big.result})`);
const over = run({ CASE: 'send', SIZE: lo + 4 });
check(over.result === 'refused' && /cannot hold this file in memory./.test(over.why) && over.count === 0 && over.held === 0, `${lo + 4} MiB: refused when begun, in plain words, nothing held (${over.result}: ${over.why})`);
const cycle = run({ CASE: 'cycle' });
check(cycle.runs.every((r) => r.result === 'sent' && r.count === 0 && r.held === 0), `taken, sent and removed in turn: ${cycle.runs.map((r) => `${r.mb} MiB ${r.result}, then ${r.count} held`).join('; ')}`);

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

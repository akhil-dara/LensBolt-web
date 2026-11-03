// The browser receiver's reader pool on its own (web/receive-pool.js): how many readers a device gets, each camera
// frame to the first idle reader (none idle: dropped and counted, never queued), the reader results to the collector
// with the records waiting for it bounded, the freshest geometry handed to a reader whose own is older, a reader
// that never answers or dies given up on, and the fallback to the single worker. A simulated stall (one decode of
// 2 s among 50 ms ones) measures the two ways results reach the collector: as they finish, or held for frame order.
// No browser, no wasm.
//
//   node web/tests/receive-pool.mjs
import { readerCount, ReaderPool, READERS_MAX } from '../receive-pool.js';

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- how many readers ---
check(READERS_MAX === 4, 'at most 4 readers');
{ // a re-anchor: every reader gets 'clear' in place of hint bytes with its next frame, once; a fresh read's geometry then spreads
  const p = new ReaderPool(2, { busyMs: 100 }); p.ready(0); p.ready(1);
  const a = p.offer(0); p.done(a.reader, a.seq, { ok: true, ms: 10, hint: new Uint8Array([1]) }, 10);
  const a2 = p.offer(11); p.done(a2.reader, a2.seq, { ok: true, ms: 10, hint: new Uint8Array([1]) }, 20);
  p.reanchor();
  const b = p.offer(30), c = p.offer(31);
  check(b.hint === 'clear' && c.hint === 'clear', `after reanchor() both readers get 'clear' (${b.hint}, ${c.hint})`);
  p.done(b.reader, b.seq, { ok: true, ms: 10, hint: new Uint8Array([2]) }, 40); p.done(c.reader, c.seq, { ok: true, ms: 10, hint: new Uint8Array([3]) }, 41);
  const d = p.offer(50), e = p.offer(51);
  check(![d.hint, e.hint].includes('clear'), 'no second clear');
  p.done(d.reader, d.seq, { ok: true, ms: 10, hint: new Uint8Array([4]) }, 60); p.done(e.reader, e.seq, { ok: true, ms: 10, hint: new Uint8Array([5]) }, 61);
  const f = p.offer(70);
  check(f.hint instanceof Uint8Array || f.hint === null, `a fresh geometry spreads as bytes afterwards (${f.hint})`);
}
check([1, 2, 3].every((c) => readerCount(c) === 0) && readerCount(undefined) === 0 && readerCount(0) === 0, 'three cores or fewer (or unknown): the single worker (one reader beside the collector is no faster)');
check(readerCount(4) === 2 && readerCount(5) === 3 && readerCount(6) === 4 && readerCount(8) === 4 && readerCount(12) === 4, 'cores - 2, from 2 to 4 (4 -> 2, 5 -> 3, 6 -> 4, 12 -> 4)');
check(readerCount(8, NaN, 4) === 2 && readerCount(8, NaN, 2) === 2 && readerCount(8, NaN, 8) === 4 && readerCount(8, NaN, 0) === 4 && readerCount(4, NaN, 4) === 2 && readerCount(3, NaN, 4) === 0, '4 GB or less: at most 2 readers (memory unknown: the cores decide)');
check(readerCount(8, 4, 2) === 4, 'a forced count wins over the memory rule');
{
  // a reader's turn decides how many readers take frames: (turn / frame interval) + 1, once 10 frames are read
  // each frame offered at k * 500 and answered `ms` later (its turn: copy, decode, messages)
  const fitAt = (ms, n = 4) => { const p = new ReaderPool(n); for (let i = 0; i < n; i++) p.ready(i); const cap0 = p.fit(33);
    for (let k = 0; k < 12; k++) { const o = p.offer(k * 500); p.done(o.reader, o.seq, { seq: o.seq, ok: true, ms: ms / 2 }, k * 500 + ms); } return [cap0, p.fit(33), p]; };
  const [c0, c20] = fitAt(20), [, c50] = fitAt(50), [, c100] = fitAt(100), [, c400] = fitAt(400);
  check(c0 === 4 && c20 === 1 && c50 === 2 && c100 === 4 && c400 === 4, `readers taking frames by their turn at 30 fps: all until measured, 20 ms -> 1, 50 -> 2, 100 -> 4, 400 -> 4 (all there are) (${[c0, c20, c50, c100, c400]})`);
  const [, , p] = fitAt(20);
  const a = p.offer(9000), b = p.offer(9001);
  check(a && a.reader === 0 && b === null, 'past the cap the frame is dropped while the readers taking frames are busy (the others stay idle)');
  check(p.stats().taking === 1 && p.stats().readers === 4, 'stats: 1 of 4 readers taking frames');
  const q = new ReaderPool(3); q.ready(0); q.ready(1); q.ready(2); q.failed(0);
  for (let k = 0; k < 12; k++) { const o = q.offer(k * 500); q.done(o.reader, o.seq, { seq: o.seq, ok: true, ms: 10 }, k * 500 + 20); }
  check(q.fit(33) === 2 && q.offer(9000).reader === 1, 'a dead reader is not counted: the cap reaches the first live one');
}
check(readerCount(12, 0) === 0 && readerCount(12, 1) === 1 && readerCount(2, 3) === 3 && readerCount(12, 99) === 8 && readerCount(12, NaN) === 4 && readerCount(12, -1) === 4, 'a forced count (?readers=N) wins: 0 is the single worker, at most 8; not a count: the device rule');

// --- dispatch: the first idle reader, none idle = dropped ---
{
  const p = new ReaderPool(3);
  check(p.offer(0) === null && p.dropped === 0 && !p.active, 'no reader ready yet: not active, the frame is not a busy drop (the page sends it to the single worker)');
  p.ready(0); p.ready(1); p.ready(2);
  check(p.active && p.live === 3, 'three readers ready: active');
  const a = p.offer(10), b = p.offer(11), c = p.offer(12);
  check(a.reader === 0 && b.reader === 1 && c.reader === 2 && eq([a.seq, b.seq, c.seq], [1, 2, 3]), `each frame to the first idle reader, numbered in order (${JSON.stringify([a, b, c])})`);
  check(p.offer(13) === null && p.dropped === 1 && p.offered === 4 && p.inFlight === 3, 'every reader busy: dropped and counted, at most 3 frames in flight (no queue)');
  check(eq(p.done(1, 2, { seq: 2, ok: true, ms: 40 }, 50).map((r) => r.seq), [2]), 'a result goes to the collector as it finishes');
  const d = p.offer(51);
  check(d && d.reader === 1 && d.seq === 4, `the reader that finished is the idle one now (${JSON.stringify(d)})`);
  check(eq(p.done(0, 1, { seq: 1, ok: true, ms: 44 }, 55).map((r) => r.seq), [1]), 'an earlier frame finishing later goes too (the collector takes late records)');
  p.done(2, 3, { seq: 3, ok: false, ms: 30 }, 60); p.done(1, 4, { seq: 4, ok: true, ms: 36 }, 70);
  const st = p.stats();
  check(st.readers === 3 && st.dropped === 1 && st.offered === 5 && st.ms.length === 3 && Math.abs(st.ms[1] - 38) < 3 && st.ms[0] === 44, `stats: readers, busy drops, decode ms per reader (${JSON.stringify(st)})`);
}

// --- in frame order (order: true) ---
{
  const p = new ReaderPool(3, { order: true });
  p.ready(0); p.ready(1); p.ready(2);
  p.offer(0); p.offer(1); p.offer(2);
  check(eq(p.done(1, 2, { seq: 2, ok: true }, 5), []) && p.waiting === 1, 'held for order: a later frame waits for the earlier one, and counts as waiting');
  check(eq(p.done(0, 1, { seq: 1, ok: true }, 6).map((r) => r.seq), [1, 2]), 'frame 1 in: frames 1 and 2 go, in order');
}

// --- the freshest geometry to a reader whose own is older ---
{
  const p = new ReaderPool(2);
  p.ready(0); p.ready(1);
  const a = p.offer(0), b = p.offer(1);
  check(a.hint === null && b.hint === null, 'no geometry yet: no hint');
  p.done(0, a.seq, { seq: a.seq, ok: true, ms: 40, hint: 'H1' }, 40);
  const c = p.offer(41);
  check(c.reader === 0 && c.hint === null, 'reader 0 read frame 1 itself: its own geometry is the freshest, no hint sent');
  p.done(1, b.seq, { seq: b.seq, ok: true, ms: 40, hint: 'H2' }, 42);
  p.done(0, c.seq, { seq: c.seq, ok: false, ms: 20 }, 60);
  const d = p.offer(61);
  check(d.reader === 0 && d.hint === 'H2', `reader 0 lost the tile on frame 3; frame 2's geometry (reader 1) is handed to it (${JSON.stringify(d)})`);
  p.done(0, d.seq, { seq: d.seq, ok: false, ms: 20 }, 70);
  const e = p.offer(71);
  check(e.reader === 0 && e.hint === null, 'the same geometry is handed over once');
  const q = new ReaderPool(2); q.ready(0); q.ready(1);
  const f1 = q.offer(0), f2 = q.offer(1);
  q.done(1, f2.seq, { seq: f2.seq, ok: true, ms: 30, hint: 'new' }, 30);
  q.done(0, f1.seq, { seq: f1.seq, ok: true, ms: 50, hint: 'old' }, 50);
  check(q.hint.bytes === 'new' && q.hint.seq === f2.seq, 'a read of an older frame that ends later does not replace the fresher geometry');
}

// --- a reader that never answers, or dies holding a frame ---
for (const order of [false, true]) {
  const p = new ReaderPool(2, { busyMs: 1000, order });
  p.ready(0); p.ready(1);
  const a = p.offer(0), b = p.offer(10);
  p.done(1, b.seq, { seq: b.seq, ok: true, ms: 5 }, 20);
  check(p.expire(500).stalled === 0, `order ${order}: under the limit, nothing given up`);
  const y = p.expire(1001);
  check(y.stalled === 1 && p.waiting === 0 && p.inFlight === 0, `order ${order}: reader 0 silent past the limit: given up on, nothing left waiting (${JSON.stringify(y)})`);
  check(p.offer(1002) && p.inFlight === 1, `order ${order}: the silent reader is offered frames again`);
  check(eq(p.done(0, a.seq, { seq: a.seq, ok: true, ms: 1100 }, 1100).map((r) => r.seq), [a.seq]), `order ${order}: its answer, when it comes after all, still goes to the collector`);
  // a reader that dies holding a frame: its slot never sticks the order, the others go on
  const q = new ReaderPool(3, { order });
  q.ready(0); q.ready(1); q.ready(2);
  const f1 = q.offer(0); q.offer(1); const f3 = q.offer(2);
  q.done(2, f3.seq, { seq: f3.seq, ok: true }, 5);
  const gone = q.failed(0);
  check(!gone.fallback && q.live === 2 && q.inFlight === 1 && f1.reader === 0, `order ${order}: a busy reader dies: left out, the others go on`);
  q.done(1, 2, { seq: 2, ok: true }, 9);
  let delivered = gone.deliver.length + (order ? 0 : 0);
  for (let t = 10; t < 2000; t += 33) { const o = q.offer(t); if (o) delivered += q.done(o.reader, o.seq, { seq: o.seq, ok: true }, t + 20).length; }
  check(q.waiting === 0 && q.held.size === 0 && delivered > 50, `order ${order}: nothing held behind the dead reader's frame (${delivered} delivered after, ${q.held.size} held)`);
}

// --- what waits for the collector is bounded ---
{
  const p = new ReaderPool(2, { backlog: 2 });
  p.ready(0); p.ready(1);
  p.toCollector(2);
  check(p.offer(0) === null && p.dropped === 1, 'the collector two records behind: the frame is dropped');
  p.answered();
  check(p.offer(1) !== null, 'one answered: frames flow again');
  const q = new ReaderPool(3, { order: true, backlog: 3 });
  q.ready(0); q.ready(1); q.ready(2);
  q.offer(0); q.offer(1); q.offer(2);
  q.done(1, 2, { seq: 2 }, 5); q.done(2, 3, { seq: 3 }, 6);
  check(q.offer(7) === null && q.waiting === 2, 'held for order and being read count too: two held and one read, the frame is dropped');
}

// --- a page hidden and shown again ---
{
  const p = new ReaderPool(2, { busyMs: 1000 });
  p.ready(0); p.ready(1);
  p.offer(0);
  p.resume(30000);
  check(p.expire(30500).stalled === 0 && p.expire(31001).stalled === 1, 'frames in flight are timed from when the page shows again');
}

// --- the fallback to the single worker ---
{
  const p = new ReaderPool(3);
  p.ready(0);
  check(p.failed(1).fallback === false && p.active, 'a reader that fails to start while another runs: the pool goes on');
  const q = new ReaderPool(2);
  check(q.failed(0).fallback === false && !q.active, 'one fails to start, another still starting: wait for it');
  check(q.failed(1).fallback === true, 'none started, none starting: the single worker');
  const r = new ReaderPool(2);
  r.ready(0); r.ready(1);
  r.failed(0);
  check(r.offer(0).reader === 1, 'frames go to the reader left');
  check(r.failed(1).fallback === true && !r.active, 'the last reader gone: the single worker');
}

// --- a stall, measured: 4 readers at 50 ms a frame, one decode of 2 s, a 30 fps camera for 6 s, a collector that
// answers each record 5 ms after it gets it; 2.9 MB a record (1 px) ---
function stall(order) {
  const p = new ReaderPool(4, { order });
  for (let i = 0; i < 4; i++) p.ready(i);
  const busyUntil = [], toColl = [];
  let delivered = 0, peak = 0, n = 0;
  for (let t = 0; t < 6000; t += 1) {
    for (let i = 0; i < 4; i++) {
      const b = busyUntil[i];
      if (b && b.at <= t) { busyUntil[i] = null; for (const r of p.done(i, b.seq, { seq: b.seq, ok: true, ms: b.ms }, t)) { p.toCollector(); toColl.push(t + 5); } }
    }
    while (toColl.length && toColl[0] <= t) { toColl.shift(); p.answered(); delivered++; }
    if (t % 33 === 0) {
      const o = p.offer(t);
      if (o) { n++; const ms = n === 20 ? 2000 : 50; busyUntil[o.reader] = { at: t + ms, seq: o.seq, ms }; }
    }
    peak = Math.max(peak, p.waiting);
  }
  return { delivered, peak, dropped: p.dropped, offered: p.offered };
}
const asDone = stall(false), inOrder = stall(true);
console.log(`     stall, results as they finish: ${asDone.delivered} records to the collector, ${asDone.dropped} of ${asDone.offered} dropped, at most ${asDone.peak} waiting (${(asDone.peak * 2.9).toFixed(0)} MB at 1 px)`);
console.log(`     stall, held for frame order:  ${inOrder.delivered} records to the collector, ${inOrder.dropped} of ${inOrder.offered} dropped, at most ${inOrder.peak} waiting (${(inOrder.peak * 2.9).toFixed(0)} MB at 1 px)`);
check(inOrder.peak <= 8 && asDone.peak <= 8, `either way at most 2R = 8 records wait (${asDone.peak}, ${inOrder.peak})`);
check(asDone.delivered > inOrder.delivered, `results as they finish read more frames through a stall (${asDone.delivered} vs ${inOrder.delivered}): the default`);
check(new ReaderPool(1).order === false, 'the page\'s pool sends results as they finish');

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

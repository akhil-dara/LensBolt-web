// A Chrome profile folder for one test run that never outlives the run. tempProfile() makes the lb-* folder in
// %TEMP%, ownChrome() names the browser that uses it; when the process ends (a normal end, a thrown error,
// process.exit, Ctrl+C) the browser is stopped by its PID and the folder removed, retrying while Windows still
// holds its files. A test's own rmSync in a finally stays harmless: whatever it could not remove goes here.
//
//   import { tempProfile, ownChrome } from './chrome-profile.mjs';
//   const profile = tempProfile('lb-batch-');
//   const chrome = ownChrome(spawn(CHROME, [`--user-data-dir=${profile}`, ...]));
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const folders = new Set(), browsers = new Set();
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function tempProfile(prefix = 'lb-chrome-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  folders.add(dir);
  return dir;
}

export function ownChrome(child) {
  browsers.add(child);
  return child;
}

export function stopChrome(child) {
  browsers.delete(child);
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); return; } catch {}
  }
  try { child.kill('SIGKILL'); } catch {}
}

export function removeProfile(dir) {
  for (let i = 0; i < 20 && existsSync(dir); i++) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { pause(250); }
  }
  if (!existsSync(dir)) folders.delete(dir);
  return !existsSync(dir);
}

function cleanUp() {
  for (const child of [...browsers]) stopChrome(child);
  for (const dir of [...folders]) {
    if (!removeProfile(dir)) console.error(`chrome-profile: could not remove ${dir}`);
  }
}

process.on('exit', cleanUp);
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try { process.on(signal, () => process.exit(130)); } catch {}
}

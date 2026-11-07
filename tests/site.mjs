// lensbolt.com, the static site web/site.py builds into site/ for Cloudflare Pages (free tier: files, _headers,
// _redirects; nothing that runs on the server). Builds the site, then checks it:
//
// web/dist: site.py refuses offline pages older than their sources (web/dist/stamp.json from web/build.py), and
// the stamp matches today's sources.
// on disk: every link and import resolves to a file in site/ the way Pages serves it; nothing in site/, the
// offline pages included, names another site but the repository, the two donation pages and the Play listing;
// the manifest is linked from /send only; the worker is registered from /send and /receive only and precaches
// exactly the two pages, every file under a/ and the app icon, versioned by their hash and its own code; _headers
// gives the pages and the worker no-store, hashed files a long cache, a CSP whose hashes match every inline
// script and style block (no 'unsafe-inline', no style attributes left), nosniff and camera=(self), no COOP/COEP,
// no line of 2000 characters; the landing's way names are the receiver's own; without an APK or --play-live the
// landing says "Coming to Google Play" and /receive has no app banner; the free tier's file limits.
// in a headless Chrome (its own PID, a free port) against a local server that answers like Pages, _headers
// applied: /send sends a test file at dpr 2 and 1.25 (dist-smoke's checks) with no CSP violation; on a desktop the
// manifest loads; the worker installs and, with the server stopped, /send and /receive still load; /receive's
// decode worker answers and its CSP is enforced; on Android neither page offers an install.
// in a copy of web/ (built into a temp folder): --play-live and the Android banner (Hide remembered; a tablet
// asking for desktop pages still counts as Android); an APK and its SHA-256 note; an update: v1 -> v2 online
// gives the v2 page and files, offline the cache's, closing the tab drops v1's cache, and a v3 whose file 404s
// leaves v2 in charge and working offline.
// Screenshots of the landing at phone and desktop widths, light and dark: docs/screens/web/site-landing-*.png.
//
//   python web/build.py        (first: web/pkg and web/dist)
//   node web/tests/site.mjs    (SHOTS=0 skips the screenshots)
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tempProfile, ownChrome } from './chrome-profile.mjs';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'screens');
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PYTHON = process.env.PYTHON || 'python';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const DESKTOP_LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const GITHUB = 'https://github.com/akhil-dara/lensbolt-web';
const APK_RELEASES = 'https://github.com/akhil-dara/lensbolt-android/releases/latest';
const PLAY = 'https://play.google.com/store/apps/details?id=com.lensbolt.app';
// the author's profile and the two other repositories (the footer, How it works, the structured data); the
// structured data's vocabulary and licence are names, not links a visitor follows
const ALLOWED = [GITHUB, `${GITHUB}/issues`, APK_RELEASES, 'https://buymeacoffee.com/akhildara1l', 'https://github.com/sponsors/akhil-dara', PLAY,
  'https://github.com/akhil-dara', 'https://github.com/akhil-dara/lensbolt-core', 'https://github.com/akhil-dara/lensbolt-android',
  'https://schema.org', 'https://www.gnu.org/licenses/agpl-3.0.html', 'http://www.sitemaps.org/schemas/sitemap/0.9'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const tmp = tempProfile('lb-site-');

// ---- building, and the site under test ----
function runSite(root, args = [], env = {}) {
  const r = spawnSync(PYTHON, [join(root, 'web', 'site.py'), ...args], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}
let SITE = '', files = [], fileSet = new Set(), redirects = [], headerRules = [];
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const read = (p) => readFileSync(join(SITE, p.slice(1)));
const text = (p) => read(p).toString('utf8');
function load(dir) {
  SITE = dir;
  files = walk(SITE).map((f) => '/' + relative(SITE, f).split(sep).join('/'));
  fileSet = new Set(files);
  redirects = fileSet.has('/_redirects') ? text('/_redirects').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.split(/\s+/)) : [];
  // _headers: a path line, then indented "Name: value" lines; a header named by several matching rules is joined
  // with ", " (as Pages does: two Cache-Control or CSP rules on one path would break it, so the test sees them)
  headerRules = [];
  let cur = null;
  for (const line of fileSet.has('/_headers') ? text('/_headers').split('\n') : []) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) { cur = { re: new RegExp('^' + line.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/:\w+/g, '[^/]+') + '$'), headers: [] }; headerRules.push(cur); continue; }
    const m = line.trim().match(/^([^:]+):\s*(.*)$/);
    if (m && cur) cur.headers.push([m[1].toLowerCase(), m[2]]);
  }
}
// how Cloudflare Pages answers a path (the parts this site uses): _redirects first, then clean URLs
function route(path) {
  for (const [from, to, code] of redirects) if (from === path) return { status: Number(code || 302), location: to };
  if (path.endsWith('.html')) {
    if (path === '/index.html') return { status: 308, location: '/' };
    if (path.endsWith('/index.html') && fileSet.has(path)) return { status: 308, location: path.slice(0, -10) };
    if (fileSet.has(path)) return { status: 308, location: path.slice(0, -5) };
  }
  if (path.endsWith('/') && fileSet.has(path + 'index.html')) return { status: 200, file: path + 'index.html' };
  if (!path.endsWith('/') && !path.endsWith('.html') && fileSet.has(path)) return { status: 200, file: path };
  if (fileSet.has(path + '.html')) return { status: 200, file: path + '.html' };
  if (fileSet.has(path + '/index.html')) return { status: 308, location: path + '/' };
  return { status: 404, file: fileSet.has('/404.html') ? '/404.html' : null };
}
function served(path) {
  for (let i = 0; i < 5; i++) { const r = route(path); if (r.location) { path = r.location; continue; } return r.status === 200 ? r.file : null; }
  return null;
}
function headersFor(path) {
  const out = {};
  for (const r of headerRules) if (r.re.test(path)) for (const [k, v] of r.headers) out[k] = out[k] ? `${out[k]}, ${v}` : v;
  return out;
}
const pageText = (p) => text(served(p));
const swList = (name) => JSON.parse(text('/sw.js').match(new RegExp(`const ${name} = (\\[[^\\]]*\\]);`))?.[1] || '[]');
const swVersion = () => text('/sw.js').match(/const VERSION = "([0-9a-f]+)";/)?.[1];

// ---- web/dist: current, or refused ----
let r = runSite(ROOT);
const distCurrent = r.status === 0;
check(distCurrent, `web/dist matches its sources (web/dist/stamp.json)${distCurrent ? '' : `: ${r.out.split('\n').pop()}`}`);
const STALE = distCurrent ? [] : ['--allow-stale-dist'];
if (!distCurrent) {
  check(/run python web\/build\.py first/.test(r.out), 'site.py refuses the stale offline pages and says to run web/build.py');
  r = runSite(ROOT, STALE);
}
check(r.status === 0, `web/site.py built site/ (${r.out.split('\n').pop()})`);
{
  const bad = join(tmp, 'stamp.json');
  writeFileSync(bad, JSON.stringify({ inputs: '0'.repeat(64), 'lensbolt.html': '0', 'lensbolt-receive.html': '0' }));
  const rb = runSite(ROOT, [], { LENSBOLT_DIST_STAMP: bad });
  check(rb.status !== 0 && /built from older sources/.test(rb.out) && /run python web\/build\.py first/.test(rb.out), `a stamp that does not match the sources: site.py refuses (${rb.out.split('\n').pop()})`);
  check(existsSync(join(ROOT, 'public', 'index.html')), 'a refused build leaves public/ as it was');
}
load(join(ROOT, 'public'));

// ---- on disk ----
const pages = ['/', '/send', '/receive', '/privacy', '/downloads/'];
for (const p of pages) check(served(p) !== null, `${p} is served (${served(p)})`);
const html = Object.fromEntries(pages.map((p) => [p, served(p) ? pageText(p) : '']));

const refsIn = (src) => {
  const out = [];
  for (const m of src.matchAll(/\s(?:href|src)="([^"]*)"/g)) out.push(m[1]);
  for (const m of src.matchAll(/\ssrcset="([^"]*)"/g)) for (const part of m[1].split(',')) out.push(part.trim().split(/\s+/)[0]);
  for (const m of src.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  for (const m of src.matchAll(/new URL\(\s*['"`]([^'"`]+)['"`]\s*,\s*import\.meta\.url\s*\)/g)) out.push(m[1]);
  for (const m of src.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) out.push(m[1]);
  return out;
};
const internal = (u) => !/^(https?:|mailto:|data:|blob:|#|javascript:)/.test(u) && u !== '';
const textFiles = files.filter((f) => /\.(html|js|css|webmanifest)$/.test(f));
const single = (f) => /^\/downloads\/lensbolt[\w-]*\.html$/.test(f);
function linkCheck() {
  const broken = [];
  let n = 0;
  // the offline pages' own links are for a USB stick (scanned below for other sites only)
  for (const f of textFiles.filter((g) => !single(g))) {
    const base = f.endsWith('/index.html') ? f.slice(0, -10) : f;
    for (const u of refsIn(text(f))) {
      if (!internal(u)) continue;
      n++;
      const url = new URL(u, 'https://lensbolt.com' + base);
      if (url.origin !== 'https://lensbolt.com' || !served(url.pathname)) broken.push(`${f}: ${u}`);
    }
  }
  const man = fileSet.has('/manifest.webmanifest') ? JSON.parse(text('/manifest.webmanifest')) : null;
  for (const i of man?.icons || []) { n++; if (!served(new URL(i.src, 'https://lensbolt.com/').pathname)) broken.push(`manifest icon ${i.src}`); }
  for (const u of [...swList('PAGES'), ...swList('HASHED')]) { n++; if (!served(u)) broken.push(`precache ${u}`); }
  return { broken, n };
}
{
  const { broken, n } = linkCheck();
  check(broken.length === 0 && n > 30, `every link resolves inside site/ (${n} references; broken: ${broken.slice(0, 5).join(' | ')})`);
}
// other sites: only the repository, the two donation pages and the Play listing (and lensbolt.com itself), in the
// offline pages too
function offSiteNames() {
  const bad = [];
  for (const f of textFiles) for (const m of text(f).matchAll(/https?:\/\/[A-Za-z0-9._~:/?#@!$&*+,;=%-]+/g)) {
    const u = m[0].replace(/[.,;:]+$/, '');
    if (!ALLOWED.includes(u) && !/^https:\/\/lensbolt\.com(\/|$)/.test(u)) bad.push(`${f}: ${u}`);
  }
  return bad;
}
{
  const bad = offSiteNames();
  check(bad.length === 0, `site/ names no other site but the repository, the donation pages and the Play listing, offline pages included (${[...new Set(bad)].slice(0, 4).join(' | ')})`);
}

const manifest = fileSet.has('/manifest.webmanifest') ? JSON.parse(text('/manifest.webmanifest')) : null;
check(!!manifest && manifest.name === 'LensBolt' && manifest.start_url === '/send' && manifest.display === 'standalone' && manifest.icons?.some((i) => i.sizes === '192x192') && manifest.icons?.some((i) => i.sizes === '512x512'),
  `the manifest names LensBolt, starts at /send, standalone, icons 192 and 512 (${JSON.stringify(manifest && { name: manifest.name, start: manifest.start_url, display: manifest.display })})`);
const linksManifest = (h) => /manifest\.webmanifest/.test(h);
check(linksManifest(html['/send']) && pages.filter((p) => p !== '/send').every((p) => !linksManifest(html[p])), `the manifest is linked from /send only (${pages.filter((p) => linksManifest(html[p])).join(', ')})`);
check(!/rel=["']?manifest/.test(html['/receive']), 'the receiver has no manifest link');
check(!/Faster in the LensBolt app|id="lb-app"/.test(html['/receive']), 'no APK and no --play-live: /receive has no app banner');
check(/id="play-soon"[^>]*>Coming to Google Play</.test(html['/']) && !textFiles.filter((f) => !single(f)).some((f) => text(f).includes('play.google.com')), 'no APK and no --play-live: the landing says "Coming to Google Play" and nothing links the listing');

// the landing's way names are the ones the receiver shows (read from web/receive.html now)
{
  const src = readFileSync(join(ROOT, 'web', 'receive.html'), 'utf8');
  const theirs = ['phone', 'webcam', 'share'].map((k) => src.match(new RegExp(`id="w-${k}"[^>]*>([^<]+)<`))?.[1]?.trim());
  const ours = [...html['/'].matchAll(/<b data-way>([^<]+)<\/b>/g)].map((m) => m[1].trim());
  check(theirs.every(Boolean) && JSON.stringify(ours) === JSON.stringify(theirs), `the landing names the receiver's ways as it does (${ours.join(', ')} / ${theirs.join(', ')})`);
  check(/On an iPhone, open lensbolt\.com\/receive in Safari/.test(html['/']), 'the landing tells iPhone users to use Safari');
  check(/<main\b[\s\S]*id="ways-title"[\s\S]*id="offline-title"[\s\S]*<\/main>/.test(html['/']), 'the landing\'s sections are inside <main>');
  // search engines' icon crawlers also fetch /favicon.ico: there, at a fixed address, a 192 px icon (a multiple of 48)
  const ico = fileSet.has('/favicon.ico') ? read('/favicon.ico') : null;
  check(ico && ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) === 1 && ico[6] === 192 && ico.subarray(22, 26).toString('latin1') === '\x89PNG', 'the root favicon.ico holds the 192 px icon');
}

// the service worker
const registers = (h) => /serviceWorker\.register\(\s*['"]\/sw\.js['"]/.test(h);
// the landing registers it too: a visit to lensbolt.com alone made nothing work offline (2026-11-07)
check(['/', '/send', '/receive', '/privacy'].every((p) => registers(html[p])) && !registers(html['/downloads/']), `the worker is registered from /, /send, /receive and /privacy (${pages.filter((p) => registers(html[p])).join(', ')})`);
function precacheCheck(label) {
  const pagesList = swList('PAGES'), hashed = swList('HASHED');
  const appFiles = files.filter((f) => f.startsWith('/a/'));
  const icon = files.filter((f) => /^\/i\//.test(f));
  const want = [...appFiles, ...icon].sort();
  check(JSON.stringify(pagesList) === '["/","/privacy","/receive","/send"]' && JSON.stringify([...hashed].sort()) === JSON.stringify(want) && appFiles.length >= 8 && icon.length >= 8,
    `${label}: the worker precaches /, /privacy, /send, /receive, the ${appFiles.length} files under a/ and the ${icon.length} under i/ (${hashed.length} hashed)`);
  const h = createHash('sha256').update(readFileSync(join(SITE, '..', 'web', 'site', 'sw.js'), 'utf8').replace(/\r\n/g, '\n'));
  for (const u of ['/', '/privacy', '/receive', '/send', ...want].sort()) { h.update(u + '\n'); h.update(read(served(u))); }
  check(swVersion() === h.digest('hex').slice(0, 16), `${label}: the worker's version is the hash of its code and the files it precaches (${swVersion()})`);
  check(appFiles.every((f) => /\.[0-9a-f]{10}\.\w+$/.test(f) && sha256(read(f)).startsWith(f.match(/\.([0-9a-f]{10})\.\w+$/)[1])), `${label}: every a/ name carries its bytes' hash`);
  return { appFiles, want };
}
const { appFiles } = precacheCheck('public/');
check(appFiles.some((f) => f.endsWith('.wasm')) && appFiles.some((f) => /\/receive-worker\.[0-9a-f]+\.js$/.test(f)), 'the wasm and the decode worker are among them');

// _headers
const b64 = (s) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;
for (const p of pages) {
  const hd = headersFor(p);
  const csp = hd['content-security-policy'] || '';
  const scripts = [...html[p].matchAll(/<script\b(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const styles = [...html[p].matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  const missing = [...scripts, ...styles].filter((s) => !csp.includes(b64(s)));
  check(hd['cache-control'] === 'no-store', `${p}: Cache-Control ${hd['cache-control']}`);
  check(csp && !csp.includes(',') && /default-src 'none'/.test(csp) && /frame-ancestors 'none'/.test(csp) && !/'unsafe-inline'/.test(csp) && missing.length === 0 && !/\sstyle="/.test(html[p]),
    `${p}: one strict CSP, no 'unsafe-inline', a hash for each of its ${scripts.length} inline scripts and ${styles.length} style blocks (${missing.length} missing), no style attributes`);
  check(hd['x-content-type-options'] === 'nosniff' && /camera=\(self\)/.test(hd['permissions-policy'] || ''), `${p}: nosniff, Permissions-Policy ${hd['permissions-policy']}`);
  check(!hd['cross-origin-opener-policy'] && !hd['cross-origin-embedder-policy'], `${p}: no COOP/COEP (not needed)`);
}
{
  const sendCsp = headersFor('/send')['content-security-policy'] || '';
  check(/'wasm-unsafe-eval'/.test(sendCsp) && /worker-src 'self'/.test(headersFor('/receive')['content-security-policy'] || '') && /img-src 'self' blob:;/.test(sendCsp), 'the app pages\' CSP allows the wasm and the workers; images from the site and blob: only');
  check(!/id="loader"/.test(html['/send']), 'the single file\'s empty loader script is not in /send');
  const long = text('/_headers').split('\n').filter((l) => l.length >= 2000);
  check(long.length === 0, `no _headers line reaches Pages' 2000-character limit (longest ${Math.max(...text('/_headers').split('\n').map((l) => l.length))})`);
}
check(headersFor('/sw.js')['cache-control'] === 'no-store', `/sw.js: Cache-Control ${headersFor('/sw.js')['cache-control']}`);
check(appFiles.every((f) => headersFor(f)['cache-control'] === 'public, max-age=31536000, immutable'), `a/*: ${headersFor(appFiles[0] || '/a/x')['cache-control']}`);
const sab = files.filter((f) => /\.(html|js)$/.test(f) && /SharedArrayBuffer|crossOriginIsolated/.test(text(f)));
check(sab.length === 0, `nothing uses SharedArrayBuffer, so no cross-origin isolation is needed (${sab.join(', ')})`);
for (const [from, to, code] of [['/send.html', '/send', 308], ['/receive.html', '/receive', 308], ['/lensbolt.html', '/downloads/lensbolt', 301], ['/lensbolt-receive.html', '/downloads/lensbolt-receive', 301]]) {
  const rr = route(from);
  check(rr.location === to && rr.status === code, `${from} -> ${rr.status} ${rr.location}`);
}
check(!redirects.some(([from]) => /^\/(send|receive|privacy|index)\.html$/.test(from)), '_redirects leaves the .html pages to Pages');
for (const d of ['/downloads/lensbolt.html', '/downloads/lensbolt-receive.html']) {
  check(fileSet.has(d) && read(d).equals(readFileSync(join(ROOT, 'web', 'dist', d.split('/').pop()))), `${d} is web/dist's single-file page`);
  check(/attachment/.test(headersFor(d.slice(0, -5))['content-disposition'] || ''), `${d.slice(0, -5)} downloads as a file (${headersFor(d.slice(0, -5))['content-disposition']})`);
}
const sizes = files.map((f) => [f, statSync(join(SITE, f.slice(1))).size]);
check(sizes.every(([, s]) => s < 25 * 1024 * 1024) && files.length < 20000, `free tier: ${files.length} files, the largest ${Math.max(...sizes.map(([, s]) => s)) >> 10} KB (none at 25 MiB)`);
const heroes = files.filter((f) => /^\/i\/hero(-light)?\.[0-9a-f]+\.webp$/.test(f));
check(heroes.length === 2 && heroes.every((f) => read(f).length <= 200 * 1024), `the landing's heroes are at most 200 KB (${heroes.map((f) => read(f).length >> 10).join(', ')} KB)`);
for (const [what, re] of [['Send a file -> /send', /<a[^>]+href="\/send"[^>]*>[^<]*Send a file/], ['Receive -> /receive', /<a[^>]+href="\/receive"[^>]*>[^<]*Receive/], ['Get the Android app', /Get the Android app/],
  ['the offline builds', /href="\/downloads\/lensbolt"/], ['Privacy', /href="\/privacy"/], ['GitHub', /github\.com\/akhil-dara\/lensbolt-web"/], ['Buy me a coffee', /buymeacoffee\.com\/akhildara1l/], ['GitHub Sponsors', /github\.com\/sponsors\/akhil-dara/]])
  check(re.test(html['/']), `the landing has ${what}`);
check(!/id="apk-sha"/.test(html['/']), 'no APK: no checksum note');

// ---- a local server that answers like Pages, _headers applied (whatever site load() picked) ----
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json', '.apk': 'application/vnd.android.package-archive', '.svg': 'image/svg+xml' };
const freePort = () => new Promise((res) => { const s = netServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
let server = null, ORIGIN = '';
async function startServer(port) {
  server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const rr = route(path);
    const hd = headersFor(path);
    if (rr.location) { res.writeHead(rr.status, { ...hd, location: rr.location }); res.end(); return; }
    if (!rr.file || !existsSync(join(SITE, rr.file.slice(1)))) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(rr.status, { ...hd, 'content-type': TYPES[extname(rr.file)] || 'application/octet-stream' });
    res.end(read(rr.file));
  });
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok));
  ORIGIN = `http://127.0.0.1:${port}`;
}
async function stopServer() { if (!server) return; server.closeAllConnections(); await new Promise((ok) => server.close(ok)); server = null; }
const sitePort = await freePort();
await startServer(sitePort);

// ---- headless Chrome (its own profile, a free port, stopped by its PID) ----
async function browser(dpr, w, h) {
  const port = await freePort();
  const profile = tempProfile('lb-site-chrome-');
  const chrome = ownChrome(spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    `--force-device-scale-factor=${dpr}`, `--screen-info={${Math.round(w * dpr)}x${Math.round(h * dpr)}}`, `--window-size=${Math.round(w / dpr) + 18},${Math.round(h / dpr) + 95}`,
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank'], { stdio: 'ignore' }));
  let ver = null;
  for (let i = 0; i < 100 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(200); } }
  if (!ver) throw new Error('Chrome did not open its debugging port');
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((ok) => ws.addEventListener('open', ok, { once: true }));
  let id = 0; const pend = new Map(), errors = [], urls = [], logs = [], docs = {}, responses = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Network.requestWillBeSent') urls.push(m.params.request.url);
    if (m.method === 'Network.responseReceived') {
      responses.push({ url: m.params.response.url, sw: !!m.params.response.fromServiceWorker, status: m.params.response.status });
      if (m.params.type === 'Document') docs[new URL(m.params.response.url).pathname] = Object.fromEntries(Object.entries(m.params.response.headers).map(([k, v]) => [k.toLowerCase(), v]));
    }
    if (m.method === 'Log.entryAdded') logs.push(`${m.params.entry.source}/${m.params.entry.level}: ${m.params.entry.text}`);
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pend.set(i, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result))); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  async function attach(targetId) {
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    for (const m of ['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable']) await send(m, {}, sessionId);
    // CSP violations, as the page sees them
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + (e.blockedURI || 'inline')));` }, sessionId);
    const evaluate = async (expr) => { const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId); return res.result?.value; };
    const go = async (url) => { await send('Page.navigate', { url }, sessionId); for (let i = 0; i < 100; i++) { await sleep(100); if ((await evaluate(`location.href === ${JSON.stringify(url)} && document.readyState === 'complete'`).catch(() => false)) === true) break; } };
    return { S: sessionId, targetId, evaluate, go };
  }
  const { targetInfos } = await send('Target.getTargets');
  const first = await attach(targetInfos.find((t) => t.type === 'page').targetId);
  const newTab = async (url) => { const { targetId } = await send('Target.createTarget', { url: 'about:blank' }); const p = await attach(targetId); await p.go(url); return p; };
  const csp = async (p = first) => [...((await p.evaluate('window.__csp || []')) || []), ...logs.filter((l) => /Content Security Policy|Refused to/.test(l))];
  const stop = async () => {
    try { await Promise.race([send('Browser.close'), sleep(3000)]); } catch {}
    for (let i = 0; i < 20 && chrome.exitCode === null; i++) await sleep(100);
    if (chrome.exitCode === null) { try { execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
    try { ws.close(); } catch {}
    await sleep(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch {}
  };
  return { send, ...first, attach, newTab, csp, errors, urls, logs, docs, responses, stop };
}
// this lab machine's antivirus injects a script of its own into plain-http pages (not into https, and not the site's
// doing): its host is left out here, and /receive's CSP check below proves the policy still reaches the page
const offSite = (urls) => urls.filter((u) => !u.startsWith(ORIGIN) && !/^(data|blob|chrome-extension):/.test(u) && !/^https?:\/\/[\w.-]*kaspersky-labs\.com\//.test(u));
const until = async (p, expr, ms = 15000) => { for (let t = 0; t < ms; t += 100) { if ((await p.evaluate(expr).catch(() => false)) === true) return true; await sleep(100); } return false; };
const SW_READY = `(window.__swr ??= navigator.serviceWorker.ready.then(() => (window.__swok = true)), window.__swok === true)`;
const sendReady = `document.getElementById('start')?.disabled === false`;

// /send: dist-smoke's test send at dpr 2 (a Retina-like screen, 2x blocks) and 1.25 (the Windows laptop, 1x)
for (const [dpr, w, hgt, s, th] of [[2, 2880, 1800, 2, 896], [1.25, 1920, 1080, 1, 1024]]) {
  const b = await browser(dpr, w, hgt);
  try {
    await b.go(`${ORIGIN}/send?testfile=0.3&lead=0`);
    check(await until(b, sendReady), `dpr ${dpr}: /send loads its wasm from a/ and reads the test file`);
    await b.evaluate(`document.getElementById('start').click(), true`);
    let st = null;
    for (let i = 0; i < 100; i++) {
      await sleep(100);
      st = JSON.parse(await b.evaluate(`JSON.stringify({ cls: document.getElementById('stage').className, cw: document.getElementById('canvas').width, ch: document.getElementById('canvas').height, screen: document.getElementById('screen').textContent, n: +document.getElementById('hud-n').textContent, status: document.getElementById('status').textContent })`));
      if (/sending/.test(st.cls) && st.n >= 10) break;
    }
    check(/sending/.test(st.cls) && st.n >= 10, `dpr ${dpr}: it sends (${st.n} frames shown; ${st.status || st.cls})`);
    check(st.cw === 1024 * s && st.ch === th * s && st.screen.startsWith(`${w}×${hgt}, tile 1024×${th} at ${s}×`), `dpr ${dpr}: the tile 1024x${th} at ${s}x, canvas ${st.cw}x${st.ch} (${st.screen})`);
    check(offSite(b.urls).length === 0, `dpr ${dpr}: no request off the site (${offSite(b.urls).slice(0, 3).join(', ')})`);
    if (dpr === 2) {
      const man = await b.send('Page.getAppManifest', {}, b.S);
      check(/\/manifest\.webmanifest$/.test(man.url) && (man.errors || []).length === 0, `desktop /send links the manifest (${man.url}; errors ${JSON.stringify(man.errors)})`);
      const ready = await until(b, SW_READY, 20000);
      const cached = JSON.parse(await b.evaluate(`(async () => { const k = (await caches.keys()).find((k) => k.startsWith('lensbolt-')); if (!k) return '[]'; const c = await caches.open(k); return JSON.stringify((await c.keys()).map((r) => new URL(r.url).pathname)); })()`) || '[]');
      const want = [...swList('PAGES'), ...swList('HASHED')].sort();
      check(ready && JSON.stringify([...cached].sort()) === JSON.stringify(want), `the service worker is active and its cache holds the precache list (${cached.length} of ${want.length})`);
      await stopServer();
      b.errors.length = 0;
      await b.send('Page.reload', {}, b.S);
      await sleep(500);
      check(await until(b, `${sendReady} && !!navigator.serviceWorker.controller`), '/send works offline after a reload (the server stopped)');
      await b.go(`${ORIGIN}/receive`);
      check(await until(b, `!!document.getElementById('go') && typeof window.lensboltWorker === 'function'`), '/receive loads offline too');
      await b.go(`${ORIGIN}/`);
      check(await until(b, `!!document.getElementById('ways-title') && [...document.images].every((i) => i.complete && i.naturalWidth > 0)`), 'the landing loads offline too, its images with it');
      check(b.errors.length === 0, `offline: no page errors (${b.errors.join(' | ')})`);
      await startServer(sitePort);
    }
    const v = await b.csp();
    check(v.length === 0, `dpr ${dpr}: no CSP violations (${v.slice(0, 3).join(' | ')})`);
    check(b.errors.length === 0, `dpr ${dpr}: no page errors (${b.errors.join(' | ')})`);
  } finally { await b.stop(); }
}

// /receive on a desktop: its decode worker (a module worker from a/) loads the wasm and answers; the CSP is enforced
{
  const b = await browser(1, 1400, 1000);
  try {
    await b.go(`${ORIGIN}/receive`);
    const rr = JSON.parse(await b.evaluate(`(async () => {
      const w = window.lensboltWorker();
      const ready = await new Promise((res) => { w.onmessage = (e) => res(e.data); w.onerror = (e) => res({ error: e.message || 'worker error' }); setTimeout(() => res(null), 10000); w.postMessage({ type: 'init', wasm: window.lensboltWasm }); });
      w.terminate();
      return JSON.stringify({ ready, go: !!document.getElementById('go'), manifest: !!document.querySelector('link[rel=manifest]') });
    })()`));
    check(rr.go && rr.ready && rr.ready.type === 'ready', `/receive: its decode worker loads the wasm and is ready (${JSON.stringify(rr.ready)})`);
    check(!rr.manifest, '/receive on a desktop: no manifest');
    // the antivirus above also adds its own host to the header's directives: those additions are left out
    const policy = (v) => JSON.stringify(Object.fromEntries((v || '').split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...t]) => [k, t.filter((x) => !/kaspersky-labs\.com/.test(x)).sort()]).filter(([k, t]) => k && t.length).sort()));
    check(policy(b.docs['/receive']?.['content-security-policy']) === policy(headersFor('/receive')['content-security-policy']), `/receive arrives with its CSP, enforced as written (${(b.docs['/receive']?.['content-security-policy'] || 'none').slice(0, 40)}...)`);
    const ctl = JSON.parse(await b.evaluate(`(async () => { const n = window.__csp.length; const s = document.createElement('script'); s.textContent = 'window.__inl = 1'; document.head.appendChild(s); const st = document.createElement('style'); st.textContent = '#go { outline: 9px solid red; }'; document.head.appendChild(st); await new Promise((r) => setTimeout(r, 300)); const v = window.__csp.splice(n); return JSON.stringify({ ran: window.__inl === 1, styled: getComputedStyle(document.getElementById('go')).outlineWidth === '9px', v }); })()`));
    check(!ctl.ran && !ctl.styled && ctl.v.length === 2, `/receive: the CSP blocks an inline script and a style block it has no hash for (${JSON.stringify(ctl)})`);
    b.logs.splice(0, b.logs.length, ...b.logs.filter((l) => !(/inline (script|style)/i.test(l) && (l.includes(b64('window.__inl = 1').slice(1, -1)) || l.includes(b64('#go { outline: 9px solid red; }').slice(1, -1))))));
    check(await until(b, `!!navigator.serviceWorker.controller || ${SW_READY}`, 20000), '/receive registers the service worker');
    const v = await b.csp();
    check(v.length === 0, `/receive: no CSP violations (${v.slice(0, 3).join(' | ')})`);
    check(offSite(b.urls).length === 0, `/receive: no request off the site (${offSite(b.urls).slice(0, 3).join(', ')})`);
    check(b.errors.length === 0, `/receive: no page errors (${b.errors.join(' | ')})`);
  } finally { await b.stop(); }
}

// Android (no app to offer yet): neither page offers an install, and the receiver shows no banner
{
  const b = await browser(1, 1400, 1000);
  try {
    await b.send('Emulation.setUserAgentOverride', { userAgent: ANDROID_UA, platform: 'Linux armv8l' }, b.S);
    await b.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2.6, mobile: true }, b.S);
    await b.go(`${ORIGIN}/receive`);
    const man = await b.send('Page.getAppManifest', {}, b.S);
    check(!(await b.evaluate(`!!document.querySelector('link[rel=manifest]') || !!document.getElementById('lb-app')`)) && !man.url, `Android /receive: no manifest and no banner (${man.url || 'none'})`);
    await b.go(`${ORIGIN}/send`);
    await sleep(500);
    check(!(await b.evaluate(`!!document.querySelector('link[rel=manifest]')`)), 'Android /send: no manifest (install is for desktops)');
    const v = await b.csp();
    check(v.length === 0 && b.errors.length === 0, `Android: no CSP violations, no page errors (${[...v, ...b.errors].slice(0, 3).join(' | ')})`);
  } finally { await b.stop(); }
}

// the landing, /privacy and /downloads/: load clean; the landing's screenshots
{
  const b = await browser(1, 1440, 900);
  try {
    for (const p of ['/privacy', '/downloads/', '/']) {
      b.errors.length = 0;
      await b.go(ORIGIN + p);
      await sleep(300);
      const rr = JSON.parse(await b.evaluate(`JSON.stringify({ h1: document.querySelector('h1')?.textContent || '', imgs: [...document.images].filter((i) => i.loading !== 'lazy' && (!i.complete || i.naturalWidth === 0)).map((i) => i.src) })`));
      const v = await b.csp();
      check(rr.h1 && rr.imgs.length === 0 && v.length === 0 && b.errors.length === 0, `${p}: "${rr.h1}", every image loads, no CSP violations, no errors (${[...rr.imgs, ...v, ...b.errors].slice(0, 3).join(' | ')})`);
    }
    check(offSite(b.urls).length === 0, `the landing, /privacy and /downloads/ ask nothing off the site (${offSite(b.urls).slice(0, 3).join(', ')})`);
    for (const [name, wd, ht, mobile] of [['phone', 390, 844, true], ['desktop', 1440, 900, false]]) {
      await b.send('Emulation.setDeviceMetricsOverride', { width: wd, height: ht, deviceScaleFactor: mobile ? 2 : 1, mobile }, b.S);
      for (const scheme of ['light', 'dark']) {
        await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, b.S);
        await b.go(`${ORIGIN}/`);
        await b.evaluate(`Promise.all([...document.images].map((i) => { i.loading = 'eager'; return i.decode().catch(() => {}); })).then(() => true)`);
        await sleep(300);
        const over = await b.evaluate(`document.documentElement.scrollWidth - innerWidth`);
        check(over <= 0, `landing ${name} ${scheme}: no sideways scroll (${over} px over)`);
        if (process.env.SHOTS !== '0') {
          mkdirSync(SHOTS, { recursive: true });
          const { data } = await b.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: wd, height: await b.evaluate('document.documentElement.scrollHeight'), scale: 1 } }, b.S);
          writeFileSync(join(SHOTS, `site-landing-${name}-${scheme}.png`), Buffer.from(data, 'base64'));
        }
      }
    }
  } finally { await b.stop(); }
}

// ---- a copy of web/ built into a temp folder: the Play listing live, an APK, an update ----
const COPY = join(tmp, 'repo');
mkdirSync(join(COPY, 'docs'), { recursive: true });
cpSync(join(ROOT, 'docs', 'PRIVACY.md'), join(COPY, 'docs', 'PRIVACY.md'));
cpSync(join(ROOT, 'web'), join(COPY, 'web'), { recursive: true, filter: (src) => {
  const rel = relative(join(ROOT, 'web'), src).split(sep);
  return rel[0] === '' || (rel.length === 1 && /\.(html|js|py)$/.test(rel[0])) || ['pkg', 'assets', 'dist', 'site'].includes(rel[0]);
} });
const buildCopy = (args = []) => { const rr = runSite(COPY, [...STALE, ...args]); check(rr.status === 0, `the copy builds (${[...STALE, ...args].join(' ') || 'no options'}): ${rr.out.split('\n').pop()}`); load(join(COPY, 'site')); return rr; };

// the Play listing live: the landing links it, and Android's /receive offers the app; Hide is remembered
buildCopy(['--play-live']);
check(pageText('/').includes(`href="${PLAY}"`) && /Get it on Google Play/.test(pageText('/')) && !/play-soon/.test(pageText('/')), '--play-live: the landing links the Play listing');
check(pageText('/receive').includes(`href="${PLAY}"`) && /Faster in the LensBolt app/.test(pageText('/receive')), '--play-live: /receive carries the app banner with the Play link');
{
  const b = await browser(1, 1400, 1000);
  try {
    await b.send('Emulation.setUserAgentOverride', { userAgent: ANDROID_UA, platform: 'Linux armv8l' }, b.S);
    await b.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2.6, mobile: true }, b.S);
    await b.go(`${ORIGIN}/receive`);
    const shown = `!!document.getElementById('lb-app') && getComputedStyle(document.getElementById('lb-app')).display !== 'none'`;
    const rr = JSON.parse(await b.evaluate(`JSON.stringify({ shown: ${shown}, text: document.getElementById('lb-app')?.innerText || '', href: document.querySelector('#lb-app a')?.getAttribute('href') || '', manifest: !!document.querySelector('link[rel=manifest]') })`));
    check(rr.shown && /Faster in the LensBolt app/.test(rr.text) && rr.href === PLAY && !rr.manifest, `Android /receive shows "Faster in the LensBolt app" with the Play link, no manifest (${rr.href})`);
    if (process.env.SHOTS !== '0') { const { data } = await b.send('Page.captureScreenshot', { format: 'png' }, b.S); writeFileSync(join(SHOTS, 'site-receive-android.png'), Buffer.from(data, 'base64')); }
    await b.evaluate(`document.getElementById('lb-app-x').click(), true`);
    await b.send('Page.reload', {}, b.S);
    await sleep(800);
    check(!(await b.evaluate(shown)) && (await b.evaluate(`localStorage.getItem('lb-app-hidden')`)) === '1', 'Hide is remembered: after a reload the banner stays hidden');
    const v = await b.csp();
    check(v.length === 0 && b.errors.length === 0, `Android banner: no CSP violations, no page errors (${[...v, ...b.errors].slice(0, 3).join(' | ')})`);
  } finally { await b.stop(); }
}
// an Android tablet asking for desktop pages: a Linux desktop user agent, but userAgentData says Android
{
  const b = await browser(1, 1400, 1000);
  try {
    await b.send('Emulation.setUserAgentOverride', { userAgent: DESKTOP_LINUX_UA, platform: 'Linux x86_64', userAgentMetadata: { platform: 'Android', platformVersion: '14', architecture: '', model: '', mobile: false, brands: [{ brand: 'Chromium', version: '130' }] } }, b.S);
    await b.go(`${ORIGIN}/receive`);
    check(await until(b, `!!document.getElementById('lb-app') && getComputedStyle(document.getElementById('lb-app')).display !== 'none'`, 3000), 'an Android tablet in desktop mode: /receive shows the app banner');
    await b.go(`${ORIGIN}/send`);
    await sleep(500);
    check(!(await b.evaluate(`!!document.querySelector('link[rel=manifest]')`)), 'an Android tablet in desktop mode: /send links no manifest');
  } finally { await b.stop(); }
}

// an APK: the landing offers it with its SHA-256, the banner links it, /downloads/ lists it
{
  const apk = join(tmp, 'app-release.apk');
  writeFileSync(apk, createHash('sha256').update('not a real app').digest());
  buildCopy(['--apk', apk]);
  const sum = sha256(readFileSync(apk));
  check(new RegExp(`id="apk-sha"[\\s\\S]*?<code[^>]*>${sum}</code>`).test(pageText('/')) && /href="\/downloads\/lensbolt\.apk"/.test(pageText('/')), `an APK: the landing links it and its checksum note shows its SHA-256 (${sum.slice(0, 12)}...)`);
  check(/href="\/downloads\/lensbolt\.apk"/.test(pageText('/receive')) && pageText('/downloads/').includes(sum), 'an APK: the banner links it and /downloads/ lists it with its SHA-256');
  rmSync(join(COPY, 'site', 'downloads', 'lensbolt.apk'));
}

// an update: v1 -> v2 (one a/ file changed) online, offline, after the tab closes; then a v3 that cannot install
{
  const shaText = join(COPY, 'web', 'sha-text.js');
  const bump = (tag) => writeFileSync(shaText, readFileSync(shaText, 'utf8') + `\n// ${tag}\n`);
  buildCopy();
  const v1 = { version: swVersion(), a: new Set(files.filter((f) => f.startsWith('/a/'))) };
  const b = await browser(1, 1400, 1000);
  try {
    await b.go(`${ORIGIN}/send?testfile=0.3&lead=0`);
    check(await until(b, sendReady) && await until(b, SW_READY, 20000), 'update: v1 loads and its worker is active');
    bump('v2');
    buildCopy(['--allow-stale-dist']);  // the bump changed an input of web/dist: the offline pages are older on purpose
    const v2 = { version: swVersion(), a: new Set(files.filter((f) => f.startsWith('/a/'))) };
    const changed = [...v2.a].filter((f) => !v1.a.has(f));
    check(v2.version !== v1.version && changed.length === 1 && /\/sha-text\./.test(changed[0]), `update: v2 has a new worker version and one new a/ file (${changed.join(', ')})`);
    const aLoaded = () => b.evaluate(`JSON.stringify(performance.getEntriesByType('resource').map((e) => new URL(e.name).pathname).filter((p) => p.startsWith('/a/')))`).then(JSON.parse);
    await b.send('Page.reload', {}, b.S);
    await sleep(500);
    const onlineOk = await until(b, sendReady);
    const online = await aLoaded();
    check(onlineOk && online.includes(changed[0]) && online.every((f) => v2.a.has(f)), `update: reloaded online, the page and every a/ file are v2 (${online.length} a/ files)`);
    check(await until(b, `navigator.serviceWorker.getRegistration().then((r) => !!(r && r.waiting))`, 20000), 'update: v2\'s worker installed and waits for v1\'s page to close');
    await stopServer();
    b.responses.length = 0;
    await b.send('Page.reload', {}, b.S);
    await sleep(500);
    const offOk = await until(b, sendReady);
    const offA = b.responses.filter((x) => new URL(x.url).pathname.startsWith('/a/'));
    const offNames = offA.map((x) => new URL(x.url).pathname);
    check(offOk && offA.length > 0 && offA.every((x) => x.sw && x.status === 200) && (offNames.every((f) => v1.a.has(f)) || offNames.every((f) => v2.a.has(f))),
      `update: offline, the page and its ${offA.length} a/ files come from the worker's cache, all of one version`);
    await startServer(sitePort);
    // closing v1's last page lets v2 take over and drop v1's cache
    await b.send('Target.closeTarget', { targetId: b.targetId });
    await sleep(1500);
    const t = await b.newTab(`${ORIGIN}/privacy`);
    const keys = `caches.keys().then((k) => JSON.stringify(k.filter((x) => x.startsWith('lensbolt-'))))`;
    check(await until(t, `${keys}.then((k) => k === JSON.stringify(['lensbolt-${v2.version}']))`, 15000), `update: with v1's tab closed, v2 is active and v1's cache is gone (${await t.evaluate(keys)})`);
    // v3: one of its files is missing on the server, so its worker cannot install; v2 stays in charge
    bump('v3');
    buildCopy(['--allow-stale-dist']);  // the bump changed an input of web/dist: the offline pages are older on purpose
    const v3 = { version: swVersion(), a: new Set(files.filter((f) => f.startsWith('/a/'))) };
    const missing = [...v3.a].find((f) => !v2.a.has(f));
    rmSync(join(SITE, missing.slice(1)));
    load(SITE);
    await t.evaluate(`navigator.serviceWorker.getRegistration().then((r) => r.update()).catch(() => {}).then(() => true)`);
    check(await until(t, `navigator.serviceWorker.getRegistration().then((r) => !r.installing && !r.waiting && !!r.active)`, 20000) && await until(t, `${keys}.then((k) => k === JSON.stringify(['lensbolt-${v2.version}']))`, 10000),
      `update: v3 (${missing} 404s) does not install; v2 stays active and v3's partial cache is gone (${await t.evaluate(keys)})`);
    await stopServer();
    b.responses.length = 0;
    await t.go(`${ORIGIN}/send?testfile=0.3&lead=0`);
    const v2Ok = await until(t, sendReady);
    const names = b.responses.filter((x) => new URL(x.url).pathname.startsWith('/a/')).map((x) => new URL(x.url).pathname);
    check(v2Ok && names.length > 0 && names.every((f) => v2.a.has(f)), `update: offline, v2 still serves /send and its ${names.length} a/ files`);
    await startServer(sitePort);
  } finally { await b.stop(); }
}

await stopServer();
try { rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);

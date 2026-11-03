// LensBolt's service worker, written by web/site.py. It keeps /send, /receive and the files they load (site/a/,
// and the app icon: each named by its content hash) so both pages open with no connection after the first visit.
//
// The version is a hash of every file below and of this code, so any change to a page, a file or the worker makes
// a new worker with a new cache. A page always comes from the network when there is one; offline it comes from
// this worker's own cache, together with the exact files that page was built with (the hashed names cannot mix
// versions: an old page can never meet a new decode worker). A new worker waits until no page of the old one is
// open (no skipWaiting), then deletes the old caches. An install that cannot fetch every file fails and removes
// its partial cache; the worker before it stays in charge.
const VERSION = "{{version}}";
const PAGES = {{pages}};
const HASHED = {{hashed}};
const CACHE = "lensbolt-" + VERSION;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => Promise.all([
    // the pages are no-store; a hashed file never changes, so the HTTP cache may serve it
    cache.addAll(PAGES.map((url) => new Request(url, { cache: "reload" }))),
    cache.addAll(HASHED),
  ])).catch((err) => caches.delete(CACHE).then(() => { throw err; })));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("lensbolt-") && k !== CACHE).map((k) => caches.delete(k)))));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.mode === "navigate" && PAGES.includes(url.pathname)) {
    // the network first; this worker's own copy when offline
    event.respondWith(fetch(request, { cache: "no-store" }).catch(() =>
      caches.open(CACHE).then((cache) => cache.match(url.pathname)).then((hit) => hit || Response.error())));
    return;
  }
  if (url.pathname.startsWith("/a/") || url.pathname.startsWith("/i/")) {
    // hashed files never change: any LensBolt cache that holds one serves it, else the network
    event.respondWith(caches.match(request, { ignoreSearch: true }).then((hit) => hit || fetch(request)));
  }
});

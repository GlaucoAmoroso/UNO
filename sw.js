// Service worker: makes the local (Pass & Play) mode work offline.
// It only handles same-origin files. The PeerJS script on the CDN is never touched,
// so online mode always uses the real network.
//
// >>> BUMP CACHE_VERSION ON EVERY DELIVERY <<<  (a new name = a fresh cache for everybody)
const CACHE_VERSION = 'colorrush-2026-11-13-v3';

const PRECACHE = [
  './',
  './index.html',
  './css/app.css',
  './manifest.webmanifest',
  './src/app.js',
  './src/engine.js',
  './src/protocol.js',
  './src/store.js',
  './src/transport.js',
  './src/ui.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      // cache:'reload' skips the HTTP cache so a new deploy never precaches stale files
      .then((cache) => cache.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never intercept the CDN / PeerJS broker

  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
      }
      return res;
    }).catch(() => (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()))),
  );
});

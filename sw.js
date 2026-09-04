// GITATO service worker — bump VERSION on every deploy (PWA rule for all gitato sites).
const VERSION = 'gitato-game-v20';
const SHELL = [
  './',
  './index.html',
  './ds.css',
  './icons.svg',
  './style.css',
  './app.bundle.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './assets/logo_gitato_t.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Shell: network-first (so a deploy with a bumped VERSION heals fast).
// Big media (tracks, textures): cache-first after first fetch.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return;
  const isMedia = url.pathname.includes('/assets/');
  if (isMedia) {
    e.respondWith(
      caches.open(VERSION).then(async (c) => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) c.put(e.request, res.clone());
        return res;
      })
    );
  } else {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          // clone BEFORE the response is handed back — once it has been
          // returned the body stream is locked and the put() fails silently
          // (the 1.7 MB APK is a download, not shell: keep it out of the cache)
          if (res.ok && !url.pathname.endsWith('.apk')) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
          return res;
        })
        // offline: a navigation with a query string (?utm_source=…) must still
        // find the cached shell, and fall back to index.html
        .catch(() => caches.match(e.request, { ignoreSearch: true })
          .then((hit) => hit || (e.request.mode === 'navigate' ? caches.match('./index.html') : undefined)))
    );
  }
});

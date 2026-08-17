const CACHE = 'sitewipe-synthetic-worker-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add('/fixture-worker-payload.txt')));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname !== '/fixture-worker-payload.txt') return;
  event.respondWith(caches.match(event.request).then((response) => response || fetch(event.request)));
});

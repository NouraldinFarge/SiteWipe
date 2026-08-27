const fixtureNamespace = new URL(self.location.href).searchParams.get('fixture');
if (!fixtureNamespace?.startsWith('sitewipe-synthetic-v1:')) {
  throw new Error('Synthetic fixture worker has no exact cache namespace.');
}
const CACHE = `${fixtureNamespace}:cache`;
const WORKER_PAYLOAD_URL = new URL('/fixture-worker-payload.txt', self.location.origin).href;
const WORKER_PAYLOAD = 'sitewipe-synthetic-v1-worker-cache';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        cache.put(
          WORKER_PAYLOAD_URL,
          new Response(WORKER_PAYLOAD, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
        )
      )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname !== '/fixture-worker-payload.txt') return;
  event.respondWith(
    caches
      .open(CACHE)
      .then((cache) => cache.match(event.request))
      .then((response) => response || fetch(event.request))
  );
});

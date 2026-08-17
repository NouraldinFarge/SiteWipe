const VERSION = 'sitewipe-synthetic-v1';
const SCALE_COUNTS = Object.freeze({ small: 8, medium: 64, large: 256 });
const params = new URLSearchParams(location.search);
const scale = Object.hasOwn(SCALE_COUNTS, params.get('scale')) ? params.get('scale') : 'small';
const count = SCALE_COUNTS[scale];
const prefix = `${VERSION}:${location.hostname}:${location.port || 'default'}`;
const result = document.querySelector('#result');

document.querySelector('#identity').textContent =
  `${VERSION} · ${location.origin} · ${scale} (${count} records per bounded store)`;
document.querySelector('#seed').addEventListener('click', run(seedFixture));
document.querySelector('#snapshot').addEventListener('click', run(snapshotFixture));
document.querySelector('#reset').addEventListener('click', run(resetFixture));

if (params.get('embed') === '1' && location.hostname !== 'chips.localhost') {
  const section = document.querySelector('#partitionFixture');
  section.hidden = false;
  document.querySelector('#partitionFrame').src =
    `http://chips.localhost:${location.port}/?scale=${encodeURIComponent(scale)}&autoseed=1&thirdparty=1`;
}
if (params.get('autoseed') === '1') run(seedFixture)();

window.sitewipeFixture = Object.freeze({ seedFixture, snapshotFixture, resetFixture, version: VERSION, scale });

function run(operation) {
  return async () => {
    result.textContent = 'Working…';
    try {
      result.textContent = JSON.stringify(await operation(), null, 2);
    } catch (error) {
      result.textContent = JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2);
    }
  };
}

async function seedFixture() {
  for (let index = 0; index < count; index += 1) {
    localStorage.setItem(`${prefix}:local:${index}`, `${prefix}:value:${index}`);
    sessionStorage.setItem(`${prefix}:session:${index}`, `${prefix}:value:${index}`);
  }
  await seedIndexedDb();
  await seedCacheStorage();
  await seedServiceWorker();
  await seedOpfs();
  await seedStorageBucket();
  await fetch('/seed-cookies', { credentials: 'include' });
  return snapshotFixture();
}

async function snapshotFixture() {
  const registrations = navigator.serviceWorker?.getRegistrations
    ? await navigator.serviceWorker.getRegistrations()
    : [];
  const cacheNames = globalThis.caches ? await caches.keys() : [];
  return {
    ok: true,
    fixtureVersion: VERSION,
    origin: location.origin,
    scale,
    localStorageKeys: matchingStorageKeys(localStorage).length,
    sessionStorageKeys: matchingStorageKeys(sessionStorage).length,
    indexedDbDatabases: indexedDB.databases
      ? (await indexedDB.databases()).filter((item) => item.name === databaseName()).length
      : 'unknown',
    matchingCaches: cacheNames.filter((name) => name.startsWith(prefix)).length,
    matchingServiceWorkers: registrations.filter((registration) => registration.scope.startsWith(location.origin))
      .length,
    cookieNames: document.cookie
      .split(';')
      .map((item) => item.trim().split('=')[0])
      .filter((name) => name.startsWith('sitewipe_')),
    storageBucketsSupported: Boolean(navigator.storageBuckets),
    opfsSupported: Boolean(navigator.storage?.getDirectory)
  };
}

async function resetFixture() {
  for (const key of matchingStorageKeys(localStorage)) localStorage.removeItem(key);
  for (const key of matchingStorageKeys(sessionStorage)) sessionStorage.removeItem(key);
  await requestResult(indexedDB.deleteDatabase(databaseName()));
  if (globalThis.caches) {
    for (const name of await caches.keys()) if (name.startsWith(prefix)) await caches.delete(name);
  }
  if (navigator.serviceWorker?.getRegistrations) {
    for (const registration of await navigator.serviceWorker.getRegistrations()) {
      if (registration.scope.startsWith(location.origin)) await registration.unregister();
    }
  }
  await clearOpfs();
  if (navigator.storageBuckets?.keys && navigator.storageBuckets?.delete) {
    for (const name of await navigator.storageBuckets.keys()) {
      if (name.startsWith('sitewipe-fixture-')) await navigator.storageBuckets.delete(name);
    }
  }
  await fetch('/clear-cookies', { credentials: 'include' });
  return snapshotFixture();
}

async function seedIndexedDb() {
  const database = await requestResult(indexedDB.open(databaseName(), 1), (event) => {
    event.target.result.createObjectStore('records', { keyPath: 'id' });
  });
  const transaction = database.transaction('records', 'readwrite');
  const store = transaction.objectStore('records');
  for (let index = 0; index < count; index += 1) store.put({ id: index, value: `${prefix}:idb:${index}` });
  await transactionDone(transaction);
  database.close();
}

async function seedCacheStorage() {
  if (!globalThis.caches) return;
  const cache = await caches.open(`${prefix}:cache`);
  for (let index = 0; index < count; index += 1) {
    await cache.put(`/synthetic-cache/${index}`, new Response(`${prefix}:cache:${index}`));
  }
}

async function seedServiceWorker() {
  if (!navigator.serviceWorker?.register) return;
  await navigator.serviceWorker.register(`/fixture-sw.js?fixture=${encodeURIComponent(prefix)}`, { scope: '/' });
}

async function seedOpfs() {
  if (!navigator.storage?.getDirectory) return;
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle('sitewipe-fixture', { create: true });
  const maximum = Math.min(count, 16);
  for (let index = 0; index < maximum; index += 1) {
    const handle = await directory.getFileHandle(`synthetic-${index}.txt`, { create: true });
    const writable = await handle.createWritable();
    await writable.write(`${prefix}:opfs:${index}`);
    await writable.close();
  }
}

async function seedStorageBucket() {
  if (!navigator.storageBuckets?.open) return;
  const bucket = await navigator.storageBuckets.open(`sitewipe-fixture-${scale}`);
  if (!bucket.caches) return;
  const cache = await bucket.caches.open('synthetic');
  await cache.put('/bucket-value', new Response(prefix));
}

async function clearOpfs() {
  if (!navigator.storage?.getDirectory) return;
  const root = await navigator.storage.getDirectory();
  try {
    await root.removeEntry('sitewipe-fixture', { recursive: true });
  } catch (error) {
    if (error?.name !== 'NotFoundError') throw error;
  }
}

function matchingStorageKeys(storage) {
  const keys = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

function databaseName() {
  return `${prefix}:indexeddb`;
}

function requestResult(request, upgrade) {
  return new Promise((resolve, reject) => {
    if (upgrade) request.onupgradeneeded = upgrade;
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
    request.onblocked = () => reject(new Error('IndexedDB request was blocked.'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction was aborted.'));
  });
}

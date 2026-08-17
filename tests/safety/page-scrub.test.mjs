import test from 'node:test';
import assert from 'node:assert/strict';

import { pageVisibleStorageScrubber } from '../../src/background/page-scrub.js';

async function withLocation(locationValue, callback) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: locationValue
  });
  try {
    return await callback();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'location', descriptor);
    else delete globalThis.location;
  }
}

test('live-page scrub rejects a sibling private tenant even when the selected tenant begins with www', async () => {
  const result = await withLocation(
    {
      hostname: 'alice.blogspot.com',
      origin: 'https://alice.blogspot.com',
      pathname: '/synthetic-canary'
    },
    () => pageVisibleStorageScrubber([{ matchMode: 'registrable_domain', domain: 'www.blogspot.com' }])
  );

  assert.equal(result.matched, false);
  assert.equal(result.localStorageCleared, 0);
  assert.deepEqual(result.errors, []);
});

test('live-page scrub exact-origin guard retains scheme and explicit port', async () => {
  const scope = [{ matchMode: 'exact_origin', exactOrigin: 'http://localhost:4317' }];

  const wrongScheme = await withLocation(
    { hostname: 'localhost', origin: 'https://localhost:4317', pathname: '/' },
    () => pageVisibleStorageScrubber(scope)
  );
  const wrongPort = await withLocation({ hostname: 'localhost', origin: 'http://localhost:4318', pathname: '/' }, () =>
    pageVisibleStorageScrubber(scope)
  );

  assert.equal(wrongScheme.matched, false);
  assert.equal(wrongPort.matched, false);
});

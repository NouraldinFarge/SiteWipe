import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCookieDiscoveryQueries,
  buildPartitionRemovalKeys,
  cookieKey,
  MAX_COOKIE_DISCOVERY_QUERIES,
  normalizeCookiePath,
  safeGetCookies,
  safeGetCookieStores
} from '../../src/background/cookies.js';
import { normalizeSiteInput } from '../../src/background/domain.js';

async function withChrome(chromeValue, callback) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: chromeValue });
  try {
    return await callback();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'chrome', descriptor);
    else delete globalThis.chrome;
  }
}

test('cookie discovery retains reviewed queries while bounding expert partition expansion', () => {
  const normalized = normalizeSiteInput('alice.blogspot.com');
  assert.equal(normalized.ok, true);
  const origins = Array.from({ length: 80 }, (_, index) => `https://n${index}.alice.blogspot.com`);
  const embeddingSites = Array.from({ length: 50 }, (_, index) => `https://embed${index}.example.com`);
  const queries = buildCookieDiscoveryQueries(normalized.target, '0', origins, embeddingSites, {
    exhaustiveCookieStoreScan: true,
    probePartitionedCookiesWithEmbeddingSites: true
  });

  assert.equal(queries.length, MAX_COOKIE_DISCOVERY_QUERIES);
  assert.ok(queries.some((query) => query.details.url === 'https://alice.blogspot.com/'));
  assert.ok(queries.some((query) => query.details.domain === 'alice.blogspot.com'));
  assert.ok(queries.every((query) => query.details.storeId === '0'));
  assert.ok(queries.every((query) => !String(query.details.url || '').includes('bob.blogspot.com')));
});

test('cookie identity includes store and partition metadata', () => {
  const base = { name: 'session', domain: '.synthetic.example', path: '/', partitionKey: null };
  assert.notEqual(cookieKey(base, '0'), cookieKey(base, '1'));
  assert.notEqual(
    cookieKey(base, '0'),
    cookieKey({ ...base, partitionKey: { topLevelSite: 'https://embed.example' } }, '0')
  );
});

test('partition removal tries legacy and cross-site variants without dropping the original key', () => {
  const original = { topLevelSite: 'https://embed.example' };
  const variants = buildPartitionRemovalKeys(original);
  assert.deepEqual(variants, [
    original,
    { ...original, hasCrossSiteAncestor: false },
    { ...original, hasCrossSiteAncestor: true }
  ]);
  assert.deepEqual(buildPartitionRemovalKeys(null), [null]);
});

test('cookie paths are normalized without accepting an authority or query as a path', () => {
  assert.equal(normalizeCookiePath('account/settings?token=canary'), '/account/settings');
  assert.equal(normalizeCookiePath('https://attacker.example/x'), '/https://attacker.example/x');
});

test('cookie read adapters distinguish success, missing APIs, and exceptions', async () => {
  const success = await withChrome(
    {
      cookies: {
        getAllCookieStores: async () => [{ id: '0', tabIds: [] }],
        getAll: async () => [{ name: 'a' }]
      }
    },
    async () => ({ stores: await safeGetCookieStores(), cookies: await safeGetCookies({ storeId: '0' }) })
  );
  assert.equal(success.stores.ok, true);
  assert.equal(success.cookies.ok, true);

  const missing = await withChrome({}, async () => ({
    stores: await safeGetCookieStores(),
    cookies: await safeGetCookies({})
  }));
  assert.equal(missing.stores.ok, false);
  assert.equal(missing.cookies.ok, false);

  const failed = await withChrome(
    {
      cookies: {
        getAllCookieStores: async () => {
          throw new Error('synthetic store failure');
        },
        getAll: async () => {
          throw new Error('synthetic cookie failure');
        }
      }
    },
    async () => ({ stores: await safeGetCookieStores(), cookies: await safeGetCookies({}) })
  );
  assert.match(failed.stores.error, /synthetic store failure/);
  assert.match(failed.cookies.error, /synthetic cookie failure/);
});

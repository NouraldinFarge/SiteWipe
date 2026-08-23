import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCookieDiscoveryQueries,
  buildPartitionRemovalKeys,
  classifyCookieStorePrivateScope,
  cookieKey,
  discoverCookiesOnly,
  MAX_COOKIE_DISCOVERY_QUERIES,
  normalizeCookiePath,
  removeCookies,
  safeGetCookies,
  safeGetCookieStores
} from '../../src/background/cookies.js';
import { normalizeSiteInput } from '../../src/background/domain.js';
import { createReport } from '../../src/background/report.js';
import { discoverCleanupScope } from '../../src/background/scope-discovery.js';

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

test('an example.com partition key never brings a chips.localhost cookie into the reviewed cookie scope', async () => {
  const normalized = normalizeSiteInput('example.com');
  assert.equal(normalized.ok, true);
  const partitionKey = { topLevelSite: 'https://example.com' };
  const targetCookie = {
    name: 'sitewipe_partitioned',
    domain: '.selected.example.com',
    path: '/',
    secure: true,
    partitionKey
  };
  const preservedCookie = {
    name: 'sitewipe_partitioned',
    domain: 'chips.localhost',
    path: '/',
    secure: true,
    partitionKey
  };
  const cookieJar = [targetCookie, preservedCookie];
  const removalCalls = [];
  let exhaustiveQueries = 0;

  await withChrome(
    {
      tabs: {
        query: async () => [],
        get: async (tabId) => ({ id: tabId, incognito: false })
      },
      cookies: {
        getAllCookieStores: async () => [{ id: 'regular', tabIds: [1] }],
        getAll: async (details) => {
          if (details.storeId === 'regular' && Object.keys(details).length === 1) {
            exhaustiveQueries += 1;
            return cookieJar;
          }
          return [];
        },
        remove: async (details) => {
          removalCalls.push(structuredClone(details));
          const host = new URL(details.url).hostname;
          const index = cookieJar.findIndex(
            (cookie) => cookie.name === details.name && cookie.domain.replace(/^\./, '') === host
          );
          if (index < 0) return null;
          cookieJar.splice(index, 1);
          return { name: details.name, url: details.url };
        }
      }
    },
    async () => {
      const report = createReport(normalized.target, normalized.input);
      const context = await discoverCleanupScope(normalized.target, report, {
        incognitoAccess: false,
        exhaustiveCookieStoreScan: true
      });

      assert.equal(exhaustiveQueries, 1);
      assert.deepEqual(
        context.cookieCandidates.map(({ cookie }) => cookie.domain),
        ['.selected.example.com']
      );

      await removeCookies(normalized.target, report, false, context, { aggressiveCookieSweep: false });

      assert.equal(report.summary.partitionedCookiesAttempted, 1);
      assert.equal(report.summary.partitionedCookiesRemoved, 1);
      assert.deepEqual(
        removalCalls.map(({ url }) => new URL(url).hostname),
        ['selected.example.com']
      );
      assert.equal(
        removalCalls.some(({ url }) => new URL(url).hostname === 'chips.localhost'),
        false,
        'the out-of-scope chips.localhost cookie must be preserved'
      );
      assert.deepEqual(
        cookieJar.map(({ domain }) => domain),
        ['chips.localhost']
      );
    }
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

test('normal-only cookie discovery skips private and ambiguous stores', async () => {
  const normalized = normalizeSiteInput('example.com');
  assert.equal(normalized.ok, true);
  const queriedStores = new Set();
  const chromeValue = {
    tabs: {
      get: async (tabId) => {
        if (tabId === 1) return { id: 1, incognito: false };
        if (tabId === 2) return { id: 2, incognito: true };
        throw new Error('tab closed');
      }
    },
    cookies: {
      getAllCookieStores: async () => [
        { id: 'regular', tabIds: [1] },
        { id: 'private', tabIds: [2] },
        { id: 'closed-private', tabIds: [3] },
        { id: 'empty', tabIds: [] }
      ],
      getAll: async ({ storeId }) => {
        queriedStores.add(storeId);
        return [];
      }
    }
  };

  await withChrome(chromeValue, () => discoverCookiesOnly(normalized.target, false));
  assert.deepEqual([...queriedStores], ['regular']);
  await withChrome(chromeValue, () =>
    assert.rejects(
      discoverCookiesOnly(normalized.target, false, { strict: true }),
      /private scope could not be verified/i
    )
  );
});

test('cookie-store classification never converts failed tab inspection into regular scope', async () => {
  await withChrome(
    {
      tabs: {
        get: async () => {
          throw new Error('tab closed');
        }
      }
    },
    async () => {
      assert.equal(await classifyCookieStorePrivateScope({ id: 'a', tabIds: [] }), 'unknown');
      assert.equal(await classifyCookieStorePrivateScope({ id: 'b', tabIds: [4] }), 'unknown');
      assert.equal(
        await classifyCookieStorePrivateScope(
          { id: 'c', tabIds: [5] },
          {
            shouldCancel: async () => false
          }
        ),
        'unknown'
      );
    }
  );
});

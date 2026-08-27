import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCookieDiscoveryQueries,
  buildPartitionRemovalKeys,
  classifyCookieStorePrivateScope,
  cookieKey,
  cookieRemovalUrlHost,
  describeCookieDiscoveryQueryDemand,
  discoverCookiesOnly,
  MAX_COOKIE_DISCOVERY_QUERIES,
  normalizeCookiePath,
  removeCookie,
  removeCookies,
  safeGetCookies,
  safeGetCookieStores
} from '../../src/background/cookies.js';
import { normalizeSiteInput } from '../../src/background/domain.js';
import {
  assertCleanupQueryCapacity,
  buildCleanupCapacityObservationFromContext,
  buildCleanupQueryCapacityPlan,
  capCleanupQueryCapacityToReviewedAllocation
} from '../../src/background/cleanup-capacity.js';
import { createReport } from '../../src/background/report.js';
import { discoverCleanupScope, inspectCleanupImpact } from '../../src/background/scope-discovery.js';
import { verifyExposedResidue } from '../../src/background/verification.js';

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
  const demand = describeCookieDiscoveryQueryDemand(normalized.target, origins, embeddingSites, {
    exhaustiveCookieStoreScan: true,
    probePartitionedCookiesWithEmbeddingSites: true
  });

  assert.equal(queries.length, MAX_COOKIE_DISCOVERY_QUERIES);
  assert.equal(demand.hardCappedRequestedQueries, queries.length);
  assert.equal(demand.hardCap, MAX_COOKIE_DISCOVERY_QUERIES);
  assert.ok(demand.uncappedRequestedQueries > demand.hardCappedRequestedQueries);
  assert.equal(demand.hardCapOmittedQueries, demand.uncappedRequestedQueries - demand.hardCappedRequestedQueries);
  assert.equal(demand.requiredQueries + demand.optionalPartitionQueries, demand.uncappedRequestedQueries);
  assert.ok(queries.some((query) => query.details.url === 'https://alice.blogspot.com/'));
  assert.ok(queries.some((query) => query.details.domain === 'alice.blogspot.com'));
  assert.ok(queries.every((query) => query.details.storeId === '0'));
  assert.ok(queries.every((query) => !String(query.details.url || '').includes('bob.blogspot.com')));
});

test('cookie query demand stays arithmetically exact while consuming only bounded discovery inputs', () => {
  const normalized = normalizeSiteInput('example.com');
  assert.equal(normalized.ok, true);

  let demandOriginsRead = 0;
  let demandPartitionSitesRead = 0;
  const demand = describeCookieDiscoveryQueryDemand(
    normalized.target,
    countedValues('https://discovered-origin-', 10_000, () => {
      demandOriginsRead += 1;
    }),
    countedValues('https://embedding-site-', 10_000, () => {
      demandPartitionSitesRead += 1;
    }),
    {
      exhaustiveCookieStoreScan: true,
      probePartitionedCookiesWithEmbeddingSites: true
    }
  );

  let builderOriginsRead = 0;
  let builderPartitionSitesRead = 0;
  const queries = buildCookieDiscoveryQueries(
    normalized.target,
    'regular',
    countedValues('https://discovered-origin-', 10_000, () => {
      builderOriginsRead += 1;
    }),
    countedValues('https://embedding-site-', 10_000, () => {
      builderPartitionSitesRead += 1;
    }),
    {
      exhaustiveCookieStoreScan: true,
      probePartitionedCookiesWithEmbeddingSites: true
    }
  );

  assert.equal(demand.hardCappedRequestedQueries, queries.length);
  assert.equal(demand.uncappedRequestedQueries, demand.requiredQueries + demand.optionalPartitionQueries);
  assert.ok(demand.uncappedRequestedQueries > demand.hardCappedRequestedQueries);
  assert.equal(demandOriginsRead, 80);
  assert.equal(builderOriginsRead, 80);
  assert.ok(demandPartitionSitesRead <= 50);
  assert.ok(builderPartitionSitesRead <= 50);
});

test('cleanup scope executes only the reviewed optional probe allocation and reports exact probed sites', async () => {
  const normalized = normalizeSiteInput('https://www.reddit.com/');
  assert.equal(normalized.ok, true);
  const observedEmbeddingSites = Array.from(
    { length: 50 },
    (_, index) => `https://embed-${String(index).padStart(2, '0')}.example`
  );
  const target = { ...normalized.target, partitionTopLevelSites: observedEmbeddingSites };
  const settings = {
    cleanupMode: 'expert',
    probePartitionedCookiesWithEmbeddingSites: true,
    verificationPass: true,
    resetZoom: true,
    progressOverlay: true,
    overlayScope: 'target_tabs',
    pageScriptScrub: false,
    incognitoAccess: false
  };
  const reviewedPlan = buildCleanupQueryCapacityPlan(target, settings, {
    matchingTabCount: 10,
    matchingDownloadCount: 0,
    approvedDownloadFileCount: 0,
    cookieStoreCount: 1,
    overlayEligibleTabCount: 10,
    observationComplete: true
  });
  const requestedQueriesPerStore = buildCookieDiscoveryQueries(
    target,
    'regular',
    target.baseOrigins,
    target.partitionTopLevelSites,
    settings
  ).length;
  const uncappedDemandPerStore = describeCookieDiscoveryQueryDemand(
    target,
    target.baseOrigins,
    target.partitionTopLevelSites,
    settings
  );
  const cookieQueryDetails = [];

  await withChrome(
    {
      tabs: {
        query: async () => [
          {
            id: 1,
            windowId: 1,
            incognito: false,
            discarded: false,
            url: 'https://www.reddit.com/'
          }
        ]
      },
      history: { search: async () => [] },
      downloads: { search: async () => [] },
      cookies: {
        getAllCookieStores: async () => [{ id: 'regular', tabIds: [1] }],
        getAll: async (details) => {
          cookieQueryDetails.push(structuredClone(details));
          return [];
        }
      }
    },
    async () => {
      const report = createReport(target, normalized.input);
      let cleanupStartPlan;
      const context = await discoverCleanupScope(target, report, {
        ...settings,
        onCapacityObservation(observedContext) {
          cleanupStartPlan = capCleanupQueryCapacityToReviewedAllocation(
            assertCleanupQueryCapacity(
              target,
              settings,
              buildCleanupCapacityObservationFromContext(observedContext, settings)
            ),
            reviewedPlan
          );
          return cleanupStartPlan;
        }
      });
      const exactExecutedSites = [
        ...new Set(cookieQueryDetails.map((details) => details.partitionKey?.topLevelSite).filter(Boolean))
      ].sort();

      assert.equal(reviewedPlan.admitted, true);
      assert.equal(
        cleanupStartPlan.scopeCookieQueriesAllocatedPerStore,
        reviewedPlan.scopeCookieQueriesAllocatedPerStore
      );
      assert.equal(cookieQueryDetails.length, reviewedPlan.scopeCookieQueriesAllocatedPerStore);
      assert.equal(context.discoveryEvidence.cookies.queriesRequested, requestedQueriesPerStore);
      assert.equal(
        context.discoveryEvidence.cookies.queriesUncappedRequested,
        uncappedDemandPerStore.uncappedRequestedQueries
      );
      assert.equal(
        context.discoveryEvidence.cookies.hardCapOmittedQueries,
        uncappedDemandPerStore.hardCapOmittedQueries
      );
      assert.equal(context.discoveryEvidence.cookies.queriesAllocated, cookieQueryDetails.length);
      assert.equal(context.discoveryEvidence.cookies.queriesPlanned, cookieQueryDetails.length);
      assert.equal(
        context.discoveryEvidence.cookies.allocationOmittedQueries,
        requestedQueriesPerStore - cookieQueryDetails.length
      );
      assert.equal(
        context.discoveryEvidence.cookies.queriesOmitted,
        requestedQueriesPerStore - cookieQueryDetails.length
      );
      assert.equal(
        context.discoveryEvidence.cookies.totalOmittedQueries,
        uncappedDemandPerStore.uncappedRequestedQueries - cookieQueryDetails.length
      );
      assert.equal(
        context.discoveryEvidence.cookies.hardCapTruncated,
        uncappedDemandPerStore.hardCapOmittedQueries > 0
      );
      assert.equal(context.discoveryEvidence.cookies.allocationTruncated, true);
      assert.equal(context.discoveryEvidence.cookies.queryCapReached, true);
      assert.deepEqual(context.probedPartitionTopLevelSites, exactExecutedSites);
      assert.ok(exactExecutedSites.length > 0);
      assert.ok(exactExecutedSites.length < observedEmbeddingSites.length);
      assert.equal(report.summary.partitionTopLevelSitesProbed, exactExecutedSites.length);
      const scopeSection = report.sections.find((section) => section.key === 'scopeDiscovery');
      assert.equal(scopeSection.status, 'partial');
      assert.deepEqual(scopeSection.details.partitionTopLevelSites, exactExecutedSites);
      assert.equal(scopeSection.details.partitionTopLevelSiteCount, exactExecutedSites.length);
      assert.equal(scopeSection.details.partitionTopLevelSitesObservedCount, observedEmbeddingSites.length + 1);
      assert.equal(
        scopeSection.details.cookieQueriesUncappedRequested,
        uncappedDemandPerStore.uncappedRequestedQueries
      );
      assert.equal(scopeSection.details.cookieQueriesAllocated, cookieQueryDetails.length);
      assert.equal(scopeSection.details.cookieQueriesRun, cookieQueryDetails.length);
      assert.equal(
        scopeSection.details.cookieQueriesTotalOmitted,
        uncappedDemandPerStore.uncappedRequestedQueries - cookieQueryDetails.length
      );
      assert.equal(report.summary.cookieQueriesUncappedRequested, uncappedDemandPerStore.uncappedRequestedQueries);
      assert.equal(report.summary.cookieQueriesHardCapOmitted, uncappedDemandPerStore.hardCapOmittedQueries);
      assert.equal(report.summary.cookieQueriesAllocated, cookieQueryDetails.length);
      assert.equal(report.summary.cookieQueriesAllocationOmitted, requestedQueriesPerStore - cookieQueryDetails.length);
      assert.equal(
        report.summary.cookieQueriesTotalOmitted,
        uncappedDemandPerStore.uncappedRequestedQueries - cookieQueryDetails.length
      );
      assert.equal(report.summary.cookieQueriesRun, cookieQueryDetails.length);
      assert.match(report.unavailable.map((item) => item.reason).join(' '), /optional cookie probe quer/i);

      await removeCookies(target, report, false, context, { aggressiveCookieSweep: false });
      assert.equal(report.summary.partitionTopLevelSitesProbed, exactExecutedSites.length);
      const cookieSection = report.sections.find((section) => section.key === 'cookies');
      assert.deepEqual(cookieSection.details.probedPartitionTopLevelSites, exactExecutedSites);
    }
  );
});

test('cookie query evidence totals the same reviewed allocation across normal and private stores', async () => {
  const normalized = normalizeSiteInput('example.com');
  assert.equal(normalized.ok, true);
  const target = {
    ...normalized.target,
    partitionTopLevelSites: Array.from({ length: 50 }, (_, index) => `https://embed-${index}.example`)
  };
  const settings = {
    cleanupMode: 'expert',
    probePartitionedCookiesWithEmbeddingSites: true,
    verificationPass: false,
    incognitoAccess: true,
    progressOverlay: false,
    resetZoom: false,
    pageScriptScrub: false
  };
  const reviewedPlan = buildCleanupQueryCapacityPlan(target, settings, {
    matchingTabCount: 2,
    matchingDownloadCount: 0,
    approvedDownloadFileCount: 0,
    cookieStoreCount: 2,
    overlayEligibleTabCount: 0,
    observationComplete: true
  });
  const perStoreDemand = describeCookieDiscoveryQueryDemand(
    target,
    target.baseOrigins,
    target.partitionTopLevelSites,
    settings
  );
  const queriesByStore = new Map();

  await withChrome(
    {
      tabs: {
        query: async () => [
          { id: 1, incognito: false, discarded: false, url: 'https://example.com/' },
          { id: 2, incognito: true, discarded: false, url: 'https://www.example.com/' }
        ]
      },
      history: { search: async () => [] },
      downloads: { search: async () => [] },
      cookies: {
        getAllCookieStores: async () => [
          { id: 'regular', tabIds: [1] },
          { id: 'private', tabIds: [2] }
        ],
        getAll: async (details) => {
          queriesByStore.set(details.storeId, (queriesByStore.get(details.storeId) || 0) + 1);
          return [];
        }
      }
    },
    async () => {
      const report = createReport(target, normalized.input);
      const context = await discoverCleanupScope(target, report, {
        ...settings,
        onCapacityObservation(observedContext) {
          return capCleanupQueryCapacityToReviewedAllocation(
            assertCleanupQueryCapacity(
              target,
              settings,
              buildCleanupCapacityObservationFromContext(observedContext, settings)
            ),
            reviewedPlan
          );
        }
      });
      const allocatedPerStore = reviewedPlan.scopeCookieQueriesAllocatedPerStore;
      const allocationOmittedPerStore = perStoreDemand.hardCappedRequestedQueries - allocatedPerStore;
      const totalOmittedPerStore = perStoreDemand.uncappedRequestedQueries - allocatedPerStore;

      assert.equal(reviewedPlan.admitted, true);
      assert.deepEqual([...queriesByStore.entries()].sort(), [
        ['private', allocatedPerStore],
        ['regular', allocatedPerStore]
      ]);
      assert.equal(
        context.discoveryEvidence.cookies.queriesUncappedRequested,
        perStoreDemand.uncappedRequestedQueries * 2
      );
      assert.equal(context.discoveryEvidence.cookies.hardCapOmittedQueries, perStoreDemand.hardCapOmittedQueries * 2);
      assert.equal(context.discoveryEvidence.cookies.queriesAllocated, allocatedPerStore * 2);
      assert.equal(context.discoveryEvidence.cookies.allocationOmittedQueries, allocationOmittedPerStore * 2);
      assert.equal(context.discoveryEvidence.cookies.totalOmittedQueries, totalOmittedPerStore * 2);
      assert.equal(context.discoveryEvidence.cookies.queriesRun, allocatedPerStore * 2);
      assert.equal(report.summary.cookieQueriesUncappedRequested, perStoreDemand.uncappedRequestedQueries * 2);
      assert.equal(report.summary.cookieQueriesHardCapOmitted, perStoreDemand.hardCapOmittedQueries * 2);
      assert.equal(report.summary.cookieQueriesAllocated, allocatedPerStore * 2);
      assert.equal(report.summary.cookieQueriesAllocationOmitted, allocationOmittedPerStore * 2);
      assert.equal(report.summary.cookieQueriesTotalOmitted, totalOmittedPerStore * 2);
      assert.equal(report.summary.cookieQueriesRun, allocatedPerStore * 2);
      assert.equal(report.summary.incognitoScopeObserved, true);
    }
  );
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
        query: async () => [{ id: 1, incognito: false, url: 'https://selected.example.com/' }]
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

  const malformed = await withChrome(
    {
      cookies: {
        getAllCookieStores: async () => null,
        getAll: async () => ({})
      }
    },
    async () => ({ stores: await safeGetCookieStores(), cookies: await safeGetCookies({}) })
  );
  assert.deepEqual(malformed.stores.stores, []);
  assert.equal(malformed.stores.ok, false);
  assert.match(malformed.stores.error, /non-array result/i);
  assert.deepEqual(malformed.cookies.cookies, []);
  assert.equal(malformed.cookies.ok, false);
  assert.match(malformed.cookies.error, /non-array result/i);
});

test('cookie removal counts only a matching structured browser confirmation', async () => {
  const cookie = { name: 'session', domain: '.example.com', path: '/', secure: true };
  const expectedUrl = 'https://example.com/';
  for (const result of [
    true,
    1,
    {},
    [],
    { name: 'other', url: expectedUrl },
    { name: 'session', url: 'https://other.example/' }
  ]) {
    const stats = await withChrome({ cookies: { remove: async () => result } }, () => removeCookie(cookie, '0', null));
    assert.equal(stats.removed, false);
    assert.equal(stats.failures, 1);
  }

  const confirmed = await withChrome(
    { cookies: { remove: async () => ({ name: 'session', url: expectedUrl, storeId: '0' }) } },
    () => removeCookie(cookie, '0', null)
  );
  assert.equal(confirmed.removed, true);
  assert.equal(confirmed.failures, 0);
});

test('cookie removal brackets IPv6 authorities without double-bracketing browser variants', async () => {
  for (const domain of ['::1', '[::1]', '2001:db8::5', '[2001:db8::5]']) {
    const expectedHost = domain.includes('2001:db8') ? '[2001:db8::5]' : '[::1]';
    const expectedUrl = `https://${expectedHost}/session`;
    const calls = [];
    const cookie = { name: 'session', domain, path: '/session', secure: true };

    assert.equal(cookieRemovalUrlHost(cookie), expectedHost);
    const stats = await withChrome(
      {
        cookies: {
          async remove(details) {
            calls.push(details);
            return { name: details.name, url: details.url, storeId: details.storeId };
          }
        }
      },
      () => removeCookie(cookie, '0', null)
    );

    assert.equal(stats.removed, true);
    assert.deepEqual(calls, [{ url: expectedUrl, name: 'session', storeId: '0' }]);
  }
});

test('malformed resolved cookie values keep preflight incomplete and verification out of verified zero', async () => {
  const normalized = normalizeSiteInput('example.com');
  assert.equal(normalized.ok, true);

  await withChrome(
    {
      tabs: { query: async () => [] },
      cookies: {
        getAllCookieStores: async () => null,
        getAll: async () => ({})
      },
      history: { search: async () => [] },
      downloads: { search: async () => [] }
    },
    async () => {
      const impact = await inspectCleanupImpact(normalized.target);
      assert.equal(impact.cookieStoreCount, null);
      assert.equal(impact.cookieStoreEnumerationComplete, false);
      assert.match(impact.limitations.join(' '), /getAllCookieStores returned a non-array result/i);

      for (const malformedCase of [
        { getAllCookieStores: async () => null, getAll: async () => [] },
        {
          getAllCookieStores: async () => [{ id: 'regular', tabIds: [1] }],
          getAll: async () => ({})
        }
      ]) {
        globalThis.chrome.cookies = malformedCase;
        const report = createReport(normalized.target, normalized.input);
        await verifyExposedResidue(
          normalized.target,
          report,
          { verificationTimeoutMs: 100, tabPrivateScopeById: new Map([[1, false]]) },
          {
            discoverCookies: discoverCookiesOnly,
            discoverHistory: async () => [],
            discoverDownloads: async () => []
          }
        );
        assert.equal(report.summary.verificationCategories.cookies.state, 'failed');
        assert.equal(report.summary.verificationCategories.cookies.count, null);
        assert.equal(report.summary.verificationStatus, 'incomplete');
        assert.equal(report.summary.verificationAllRequiredChecksSucceeded, false);
        assert.equal(report.summary.verificationNoExposedResidueFound, false);
        assert.equal(report.summary.verificationRemainingTotal, null);
      }
    }
  );
});

test('normal-only cookie discovery skips private and ambiguous stores', async () => {
  const normalized = normalizeSiteInput('example.com');
  assert.equal(normalized.ok, true);
  const queriedStores = new Set();
  const chromeValue = {
    tabs: {
      query: async () => [
        { id: 1, incognito: false },
        { id: 2, incognito: true }
      ]
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

test('cookie-store classification never converts a missing tab snapshot into regular scope', async () => {
  assert.equal(await classifyCookieStorePrivateScope({ id: 'a', tabIds: [] }), 'unknown');
  assert.equal(await classifyCookieStorePrivateScope({ id: 'b', tabIds: [4] }), 'unknown');
  assert.equal(
    await classifyCookieStorePrivateScope(
      { id: 'c', tabIds: [5] },
      {
        shouldCancel: async () => false,
        tabPrivateScopeById: new Map([[5, false]])
      }
    ),
    'regular'
  );
  assert.equal(
    await classifyCookieStorePrivateScope({ id: 'd', tabIds: [6] }, { tabPrivateScopeById: new Map([[6, true]]) }),
    'incognito'
  );
});

test('verification cookie discovery reuses the cleanup-start private-scope snapshot without another tab query', async () => {
  const normalized = normalizeSiteInput('example.com');
  assert.equal(normalized.ok, true);
  const queryClaims = [];
  let tabQueries = 0;
  const expectedCookieQueries = buildCookieDiscoveryQueries(
    normalized.target,
    'regular',
    normalized.target.baseOrigins,
    [],
    { probePartitionedCookiesWithEmbeddingSites: false }
  ).length;

  await withChrome(
    {
      tabs: {
        query: async () => {
          tabQueries += 1;
          throw new Error('the supplied cleanup-start snapshot should prevent this query');
        }
      },
      cookies: {
        getAllCookieStores: async () => [{ id: 'regular', tabIds: [1] }],
        getAll: async () => []
      }
    },
    () =>
      discoverCookiesOnly(normalized.target, false, {
        strict: true,
        tabPrivateScopeById: new Map([[1, false]]),
        operationBudget: {
          claimQuery(label) {
            queryClaims.push(label);
          },
          check() {},
          observeRecords() {}
        }
      })
  );

  assert.equal(tabQueries, 0);
  assert.equal(queryClaims.filter((label) => label === 'cookie-store tab snapshot').length, 0);
  assert.equal(queryClaims.filter((label) => label === 'cookie-store discovery').length, 1);
  assert.equal(queryClaims.filter((label) => label === 'cookie discovery').length, expectedCookieQueries);
});

function* countedValues(prefix, count, onRead) {
  for (let index = 0; index < count; index += 1) {
    onRead();
    yield `${prefix}${index}.invalid`;
  }
}

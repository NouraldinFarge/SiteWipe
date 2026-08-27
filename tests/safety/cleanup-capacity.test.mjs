import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertCleanupQueryCapacity,
  assertCleanupQueryStructure,
  buildCleanupCapacityObservationFromImpact,
  buildCleanupQueryCapacityPlan,
  capCleanupQueryCapacityToReviewedAllocation,
  CLEANUP_OPERATION_MAX_QUERIES,
  CLEANUP_OPERATION_QUERY_RESERVE,
  MAX_PROGRESS_OVERLAY_SHOW_UPDATES
} from '../../src/background/cleanup-capacity.js';
import { prepareCleanupReviewRequest } from '../../src/background/cleanup-preflight.js';
import { normalizeSiteInput } from '../../src/background/domain.js';
import { runDeepClean } from '../../src/background/cleanup.js';
import { createReport } from '../../src/background/report.js';

const target = normalizeSiteInput('example.com').target;

function observed(overrides = {}) {
  return {
    matchingTabCount: 0,
    matchingDownloadCount: 0,
    approvedDownloadFileCount: 0,
    cookieStoreCount: 1,
    overlayEligibleTabCount: 0,
    observationComplete: true,
    ...overrides
  };
}

function plan(settings = {}, overrides = {}) {
  return buildCleanupQueryCapacityPlan(
    target,
    {
      verificationPass: true,
      resetZoom: true,
      progressOverlay: false,
      pageScriptScrub: false,
      ...settings
    },
    observed(overrides)
  );
}

function targetWithAssociatedCount(count) {
  return {
    ...target,
    associatedTargets: Array.from({ length: count }, (_, index) => {
      const normalized = normalizeSiteInput(`sitewipe-capacity-${index}.com`);
      assert.equal(normalized.ok, true);
      return normalized.target;
    })
  };
}

function sessionStorageFixture() {
  const values = {};
  return {
    values,
    async get(keys) {
      const result = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (Object.prototype.hasOwnProperty.call(values, key)) result[key] = structuredClone(values[key]);
      }
      return result;
    },
    async set(patch) {
      Object.assign(values, structuredClone(patch));
    },
    async remove(key) {
      delete values[key];
    }
  };
}

test('capacity binds worst-case live-origin expansion and the observed cookie-store count', () => {
  const fiveStores = plan({}, { cookieStoreCount: 5 });
  const fiveStoresWithShieldDiagnostics = plan({ incognitoAccess: true }, { cookieStoreCount: 5 });
  const sixStores = plan({}, { cookieStoreCount: 6 });

  assert.equal(fiveStores.scopeAdditionalOriginAllowance, 80);
  assert.equal(fiveStores.scopeCookieQueriesPerStore, 172);
  assert.equal(fiveStores.verificationCookieQueriesPerStore, 12);
  assert.equal(fiveStores.cleanupPlannedQueries, 948);
  assert.equal(fiveStores.admitted, true);
  assert.equal(fiveStoresWithShieldDiagnostics.dnrDiagnosticQueries, 1);
  assert.equal(fiveStoresWithShieldDiagnostics.cleanupPlannedQueries, 949);
  assert.equal(fiveStoresWithShieldDiagnostics.admitted, true);
  assert.equal(sixStores.cleanupPlannedQueries, 1132);
  assert.equal(sixStores.admitted, false);
  assert.equal(fiveStores.cleanupAdmissionLimit, CLEANUP_OPERATION_MAX_QUERIES - CLEANUP_OPERATION_QUERY_RESERVE);
});

test('associated-target expansion has an exact maximum admitted plan and first rejected boundary', () => {
  const settings = {
    verificationPass: true,
    resetZoom: true,
    progressOverlay: false,
    pageScriptScrub: false
  };
  const admittedTarget = targetWithAssociatedCount(23);
  const rejectedTarget = targetWithAssociatedCount(24);
  const admitted = buildCleanupQueryCapacityPlan(admittedTarget, settings, observed());
  const rejected = buildCleanupQueryCapacityPlan(rejectedTarget, settings, observed());

  assert.equal(admitted.associatedTargetCount, 23);
  assert.equal(admitted.recordSearchTerms, 144);
  assert.equal(admitted.cleanupPlannedQueries, 948);
  assert.equal(admitted.admitted, true);
  assert.equal(rejected.associatedTargetCount, 24);
  assert.equal(rejected.recordSearchTerms, 150);
  assert.equal(rejected.cleanupPlannedQueries, 980);
  assert.equal(rejected.admitted, false);
  assert.doesNotThrow(() => assertCleanupQueryStructure(admittedTarget, settings));
  assert.throws(() => assertCleanupQueryStructure(rejectedTarget, settings), /too large.*operation budget/i);
});

test('fixed progress-overlay snapshot has an exact admitted and first-rejected tab boundary', () => {
  const admitted = plan({ progressOverlay: true }, { matchingTabCount: 23, overlayEligibleTabCount: 23 });
  const rejected = plan({ progressOverlay: true }, { matchingTabCount: 24, overlayEligibleTabCount: 24 });

  assert.equal(admitted.overlayShowUpdateAllowance, MAX_PROGRESS_OVERLAY_SHOW_UPDATES);
  assert.equal(admitted.progressOverlayQueries, 23 * MAX_PROGRESS_OVERLAY_SHOW_UPDATES * 2);
  assert.equal(admitted.cleanupPlannedQueries, 948);
  assert.equal(admitted.admitted, true);
  assert.equal(rejected.cleanupPlannedQueries, 980);
  assert.equal(rejected.admitted, false);
});

test('uncapped close revalidation is admitted through its exact maximum and rejected at the next tab', () => {
  const hundred = plan({}, { matchingTabCount: 100 });
  const admitted = plan({}, { matchingTabCount: 238 });
  const rejected = plan({}, { matchingTabCount: 239 });

  assert.equal(hundred.tabAuditQueries, 500);
  assert.equal(hundred.tabCloseQueries, 100);
  assert.equal(hundred.cleanupPlannedQueries, 812);
  assert.equal(admitted.cleanupPlannedQueries, 950);
  assert.equal(admitted.admitted, true);
  assert.equal(rejected.cleanupPlannedQueries, 951);
  assert.equal(rejected.admitted, false);
});

test('download record and approved file revalidation have exact first-rejected boundaries', () => {
  const recordAdmitted = plan({}, { matchingDownloadCount: 738 });
  const recordRejected = plan({}, { matchingDownloadCount: 739 });
  const fileAdmitted = plan(
    { deleteDownloadedFiles: true },
    { matchingDownloadCount: 369, approvedDownloadFileCount: 369 }
  );
  const fileRejected = plan(
    { deleteDownloadedFiles: true },
    { matchingDownloadCount: 370, approvedDownloadFileCount: 370 }
  );

  assert.equal(recordAdmitted.cleanupPlannedQueries, 950);
  assert.equal(recordAdmitted.admitted, true);
  assert.equal(recordRejected.admitted, false);
  assert.equal(fileAdmitted.downloadRevalidationQueries, 738);
  assert.equal(fileAdmitted.cleanupPlannedQueries, 950);
  assert.equal(fileAdmitted.admitted, true);
  assert.equal(fileRejected.admitted, false);
});

test('an incomplete 1,000-result download window budgets only retained matches but remains explicitly incomplete', () => {
  const observation = buildCleanupCapacityObservationFromImpact(
    {
      matchingTabs: 0,
      tabEnumerationComplete: true,
      matchingDownloadRecords: null,
      matchingDownloadRecordsLowerBound: 1,
      matchedCompletedFileIds: null,
      cookieStoreCount: 1,
      cookieStoreEnumerationComplete: true,
      overlayEligibleTabs: 0,
      discoveryEvidence: {
        downloads: { complete: false, queryResultCapReached: true }
      }
    },
    {}
  );
  const result = buildCleanupQueryCapacityPlan(target, { verificationPass: true }, observation);

  assert.equal(observation.observationComplete, true);
  assert.equal(observation.matchingDownloadCount, 1);
  assert.equal(result.downloadRevalidationQueries, 1);
  assert.equal(result.admitted, true);
});

test('Expert partition probes use the remaining reviewed allocation and disclose worst-case truncation', async () => {
  const expertSettings = {
    cleanupMode: 'expert',
    probePartitionedCookiesWithEmbeddingSites: true,
    verificationPass: true
  };
  const structural = buildCleanupQueryCapacityPlan(target, expertSettings, observed());
  assert.equal(structural.scopePartitionTopLevelSiteAllowance, 50);
  assert.equal(structural.scopeCookieQueriesUncappedRequestedPerStore, 12_922);
  assert.equal(structural.scopeCookieQueryHardCapPerStore, 1_500);
  assert.equal(structural.scopeCookieQueriesHardCappedRequestedPerStore, 1_500);
  assert.equal(structural.scopeCookieQueriesRequestedPerStore, 1500);
  assert.equal(structural.scopeCookieQueriesHardCapOmittedPerStore, 11_422);
  assert.equal(structural.scopeCookieQueriesRequiredUncappedPerStore, 172);
  assert.equal(structural.scopeCookieQueriesRequiredPerStore, 172);
  assert.equal(structural.scopeCookieQueriesRequiredHardCapOmittedPerStore, 0);
  assert.equal(structural.scopeCookieQueryCapacityPerStore, 910);
  assert.equal(structural.scopeCookieQueriesAllocatedPerStore, 910);
  assert.equal(structural.scopeCookieQueriesAllocationOmittedPerStore, 590);
  assert.equal(structural.scopeCookieQueriesOmittedPerStore, 590);
  assert.equal(structural.scopeCookieQueriesTotalOmittedPerStore, 12_012);
  assert.equal(structural.scopeCookieQueriesHardCapTruncated, true);
  assert.equal(structural.scopeCookieQueriesAllocationTruncated, true);
  assert.equal(structural.scopeCookieQueriesTruncated, true);
  assert.equal(structural.scopeCookieQueriesPerStore, 910);
  assert.equal(structural.cleanupPlannedQueries, structural.cleanupAdmissionLimit);
  assert.equal(structural.admitted, true);
  assert.doesNotThrow(() => assertCleanupQueryStructure(target, expertSettings));
  assert.doesNotThrow(() => assertCleanupQueryCapacity(target, expertSettings, observed()));

  const storageSession = sessionStorageFixture();
  let impactInspected = false;
  const prepared = await prepareCleanupReviewRequest(
    { input: 'example.com', sourceWindowId: 41, sourceIncognito: false },
    {
      getSettings: async () => expertSettings,
      isIncognitoAllowed: async () => false,
      inspectSourceWindow: async () => ({ sourceWindowId: 41, sourceIncognito: false }),
      hasHostPermissions: async () => true,
      inspectImpact: async () => {
        impactInspected = true;
        return completeImpact();
      },
      storageSession,
      storageLocal: storageSession,
      preparationContextId: 'capacity-test-popup',
      createToken: async () => 'capacity-test-review-token',
      createPopupPreparationCapability: async () => 'a'.repeat(64),
      now: () => Date.parse('2026-08-24T12:00:00.000Z')
    }
  );

  assert.equal(impactInspected, true);
  assert.equal(prepared.review.effects.operationCapacity.scopeCookieQueriesAllocatedPerStore, 910);
  assert.match(prepared.review.previewLimitations.join(' '), /uncapped worst-case demand of 12922/i);
  assert.match(prepared.review.previewLimitations.join(' '), /hard cap omits 11422/i);
  assert.match(prepared.review.previewLimitations.join(' '), /omits 590 more \(12012 total/i);
  assert.ok(Object.keys(storageSession.values).length > 0);
});

test('cleanup-start state shrink cannot broaden optional probes beyond the reviewed allocation', () => {
  const settings = {
    cleanupMode: 'expert',
    probePartitionedCookiesWithEmbeddingSites: true,
    embeddedFrameDiscovery: true,
    verificationPass: true,
    progressOverlay: true,
    overlayScope: 'target_tabs',
    resetZoom: true
  };
  const reviewed = buildCleanupQueryCapacityPlan(
    target,
    settings,
    observed({ matchingTabCount: 8, overlayEligibleTabCount: 8 })
  );
  const cleanupStart = buildCleanupQueryCapacityPlan(target, settings, observed());
  const bound = capCleanupQueryCapacityToReviewedAllocation(cleanupStart, reviewed);

  assert.equal(reviewed.admitted, true);
  assert.ok(cleanupStart.scopeCookieQueriesAllocatedPerStore > reviewed.scopeCookieQueriesAllocatedPerStore);
  assert.equal(bound.scopeCookieQueriesAllocatedPerStore, reviewed.scopeCookieQueriesAllocatedPerStore);
  assert.equal(bound.scopeCookieQueriesPerStore, reviewed.scopeCookieQueriesAllocatedPerStore);
  assert.equal(
    bound.scopeCookieQueriesAllocationOmittedPerStore,
    bound.scopeCookieQueriesRequestedPerStore - reviewed.scopeCookieQueriesAllocatedPerStore
  );
  assert.equal(
    bound.scopeCookieQueriesOmittedPerStore,
    bound.scopeCookieQueriesRequestedPerStore - reviewed.scopeCookieQueriesAllocatedPerStore
  );
  assert.equal(
    bound.scopeCookieQueriesTotalOmittedPerStore,
    bound.scopeCookieQueriesUncappedRequestedPerStore - reviewed.scopeCookieQueriesAllocatedPerStore
  );
  assert.equal(bound.cleanupPlannedQueries < cleanupStart.cleanupPlannedQueries, true);
  assert.equal(bound.admitted, true);
});

test('saved Expert partition-plus-embedded one-tab combination remains admitted before mutation', () => {
  const reddit = normalizeSiteInput('https://www.reddit.com/').target;
  const result = buildCleanupQueryCapacityPlan(
    reddit,
    {
      cleanupMode: 'expert',
      skipCleanupReview: true,
      embeddedFrameDiscovery: true,
      probePartitionedCookiesWithEmbeddingSites: true,
      exhaustiveCookieStoreScan: true,
      verificationPass: true,
      resetZoom: true,
      progressOverlay: false,
      pageScriptScrub: false
    },
    {
      matchingTabCount: 1,
      matchingDownloadCount: 0,
      approvedDownloadFileCount: 0,
      cookieStoreCount: 1,
      overlayEligibleTabCount: 0,
      observationComplete: true
    }
  );

  assert.equal(result.scopeCookieQueriesTruncated, true);
  assert.ok(result.scopeCookieQueriesAllocatedPerStore >= result.scopeCookieQueriesRequiredPerStore);
  assert.ok(result.cleanupPlannedQueries <= result.cleanupAdmissionLimit);
  assert.equal(result.admitted, true);
});

function completeImpact(overrides = {}) {
  return {
    matchingTabs: 0,
    matchingPrivateTabs: 0,
    tabEnumerationComplete: true,
    matchingHistoryEntries: 0,
    matchingHistoryEntriesLowerBound: 0,
    matchingDownloadRecords: 0,
    matchingDownloadRecordsLowerBound: 0,
    matchedCompletedFileCount: 0,
    matchedCompletedFileIds: [],
    cookieStoreCount: 1,
    cookieStoreEnumerationComplete: true,
    overlayEligibleTabs: 0,
    discoveryEvidence: {
      history: completeDiscoveryEvidence('history'),
      downloads: completeDiscoveryEvidence('downloads')
    },
    limitations: [],
    ...overrides
  };
}

function completeDiscoveryEvidence(kind) {
  return {
    kind,
    queriesPlanned: 1,
    queriesRun: 1,
    recordsObserved: 0,
    matches: 0,
    cappedQueries: 0,
    queryResultCapReached: false,
    matchCapReached: false,
    queryFailures: 0,
    complete: true,
    truncated: false,
    limitations: []
  };
}

test('cleanup-start first-rejected overlay boundary stops before cookie queries, shielding, or mutation', async (t) => {
  const previousChrome = globalThis.chrome;
  const matchingTabs = Array.from({ length: 24 }, (_, index) => ({
    id: index + 1,
    windowId: 9,
    url: `https://selected.example.com/${index}`,
    incognito: false,
    discarded: false,
    mutedInfo: { muted: false },
    pinned: false
  }));
  const mutationCalls = [];
  let cookieQueries = 0;
  globalThis.chrome = {
    tabs: {
      query: async () => structuredClone(matchingTabs),
      get: async () => {
        mutationCalls.push('tabs.get-after-capacity');
        return null;
      },
      remove: async () => mutationCalls.push('tabs.remove'),
      update: async () => mutationCalls.push('tabs.update'),
      setZoom: async () => mutationCalls.push('tabs.setZoom')
    },
    history: {
      search: async () => [],
      deleteUrl: async () => mutationCalls.push('history.deleteUrl')
    },
    downloads: {
      search: async () => [],
      erase: async () => mutationCalls.push('downloads.erase'),
      removeFile: async () => mutationCalls.push('downloads.removeFile')
    },
    cookies: {
      getAllCookieStores: async () => [{ id: 'regular', tabIds: [1] }],
      getAll: async () => {
        cookieQueries += 1;
        return [];
      },
      remove: async () => mutationCalls.push('cookies.remove')
    },
    declarativeNetRequest: {
      getDynamicRules: async () => [],
      updateDynamicRules: async () => mutationCalls.push('dnr.updateDynamicRules')
    },
    scripting: {
      executeScript: async () => mutationCalls.push('scripting.executeScript')
    },
    browsingData: {
      remove: async () => mutationCalls.push('browsingData.remove')
    }
  };
  t.after(() => {
    globalThis.chrome = previousChrome;
  });
  const report = createReport(target, 'example.com');

  await assert.rejects(
    runDeepClean(target, report, {
      progressOverlay: true,
      overlayScope: 'target_tabs',
      resetZoom: true,
      verificationPass: true,
      pageScriptScrub: false,
      temporaryDnrShield: true,
      incognitoAccess: false
    }),
    (error) => error?.name === 'OperationCapacityExceededError' && /too large/i.test(error.message)
  );

  assert.equal(cookieQueries, 0, 'cookie discovery must not begin after the count-only plan is rejected');
  assert.deepEqual(mutationCalls, []);
});

test('failed or malformed cleanup-start tab enumeration can never authorize zero-tab mutation', async (t) => {
  const previousChrome = globalThis.chrome;
  t.after(() => {
    globalThis.chrome = previousChrome;
  });

  for (const [label, queryTabs] of [
    ['failed', async () => Promise.reject(new Error('Synthetic tabs.query failure.'))],
    ['malformed', async () => ({ 0: { id: 1, url: 'https://example.com/' } })]
  ]) {
    const mutations = [];
    let cookieQueries = 0;
    globalThis.chrome = {
      tabs: {
        query: queryTabs,
        get: async () => mutations.push('tabs.get'),
        remove: async () => mutations.push('tabs.remove')
      },
      history: { search: async () => [], deleteUrl: async () => mutations.push('history.deleteUrl') },
      downloads: { search: async () => [], erase: async () => mutations.push('downloads.erase') },
      cookies: {
        getAllCookieStores: async () => [{ id: 'regular', tabIds: [1] }],
        getAll: async () => {
          cookieQueries += 1;
          return [];
        },
        remove: async () => mutations.push('cookies.remove')
      },
      declarativeNetRequest: {
        getDynamicRules: async () => [],
        updateDynamicRules: async () => mutations.push('dnr.updateDynamicRules')
      },
      scripting: { executeScript: async () => mutations.push('scripting.executeScript') },
      browsingData: { remove: async () => mutations.push('browsingData.remove') }
    };

    await assert.rejects(
      runDeepClean(target, createReport(target, 'example.com'), {
        progressOverlay: false,
        resetZoom: true,
        verificationPass: true,
        temporaryDnrShield: true,
        incognitoAccess: false
      }),
      (error) => error?.name === 'OperationCapacityExceededError' && /observation.*incomplete/i.test(error.message),
      label
    );
    assert.equal(cookieQueries, 0, `${label} tab enumeration must stop before cookie fan-out`);
    assert.deepEqual(mutations, [], `${label} tab enumeration must stop before mutation`);
  }
});

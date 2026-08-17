import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { normalizeSiteInput } from '../../src/background/domain.js';
import { boundCleanupOrigins, inspectCleanupImpact } from '../../src/background/cleanup.js';
import {
  CLEANUP_REVIEW_SCHEMA_VERSION,
  CLEANUP_REVIEW_STORAGE_KEY,
  cancelCleanupReviewRequest,
  clearCleanupReviewState,
  clearExpiredCleanupReview,
  consumeCleanupReviewRequest,
  prepareCleanupReviewRequest
} from '../../src/background/cleanup-preflight.js';

function createSessionStorage() {
  const values = {};
  const area = {
    values,
    async get(keys) {
      const result = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (Object.prototype.hasOwnProperty.call(values, key)) result[key] = values[key];
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
  Object.defineProperty(area, 'durable', { value: area });
  return area;
}

function mutationTrap(calls, name) {
  return async () => {
    calls.push(name);
    throw new Error(`Unexpected destructive call: ${name}`);
  };
}

test('impact inspection uses only read APIs before approval', async () => {
  const originalChrome = globalThis.chrome;
  const mutations = [];
  globalThis.chrome = {
    tabs: {
      query: async () => [
        { id: 1, url: 'https://alice.blogspot.com/account', incognito: false },
        { id: 2, url: 'https://bob.blogspot.com/account', incognito: true }
      ],
      remove: mutationTrap(mutations, 'tabs.remove'),
      update: mutationTrap(mutations, 'tabs.update'),
      setZoom: mutationTrap(mutations, 'tabs.setZoom')
    },
    history: {
      search: async () => [{ url: 'https://alice.blogspot.com/old' }, { url: 'https://bob.blogspot.com/old' }],
      deleteUrl: mutationTrap(mutations, 'history.deleteUrl')
    },
    downloads: {
      search: async () => [
        {
          id: 7,
          state: 'complete',
          exists: true,
          url: 'https://alice.blogspot.com/archive.zip'
        },
        {
          id: 8,
          state: 'complete',
          exists: true,
          url: 'https://bob.blogspot.com/archive.zip'
        }
      ],
      erase: mutationTrap(mutations, 'downloads.erase'),
      removeFile: mutationTrap(mutations, 'downloads.removeFile')
    },
    browsingData: { remove: mutationTrap(mutations, 'browsingData.remove') },
    cookies: { remove: mutationTrap(mutations, 'cookies.remove') },
    scripting: {
      executeScript: mutationTrap(mutations, 'scripting.executeScript')
    },
    declarativeNetRequest: {
      updateSessionRules: mutationTrap(mutations, 'declarativeNetRequest.updateSessionRules')
    }
  };

  try {
    const normalized = normalizeSiteInput('https://alice.blogspot.com/private');
    assert.equal(normalized.ok, true, normalized.error);
    const impact = await inspectCleanupImpact(normalized.target, {
      downloadRecentFallback: false
    });
    assert.equal(impact.matchingTabs, 1);
    assert.equal(impact.matchingPrivateTabs, 0);
    assert.equal(impact.matchingHistoryEntries, 1);
    assert.equal(impact.matchingDownloadRecords, 1);
    assert.deepEqual(impact.matchedCompletedFileIds, ['7']);
    assert.deepEqual(mutations, []);
  } finally {
    globalThis.chrome = originalChrome;
  }
});

test('discovery caps never discard explicit primary or reviewed associated origins', () => {
  const explicit = Array.from({ length: 480 }, (_, index) => `https://reviewed-${index}.example`);
  const discovered = [...explicit, ...Array.from({ length: 500 }, (_, index) => `https://discovered-${index}.example`)];
  const bounded = boundCleanupOrigins(explicit, discovered, 300);
  assert.equal(bounded.explicitOrigins.length, 480);
  assert.equal(bounded.additionalOrigins.length, 300);
  assert.equal(bounded.omittedAdditionalOriginCount, 200);
  assert.equal(bounded.origins.length, 780);
  for (const origin of explicit) assert.equal(bounded.origins.includes(origin), true, origin);
});

test('prepare and cancel create no cleanup job or DNR residue and retain no raw path/query', async () => {
  const session = createSessionStorage();
  const mutations = [];
  const dependencies = {
    getSettings: async () => ({
      cleanupMode: 'expert',
      associatedDomainGroups: 'alice.blogspot.com => accounts.example.net',
      blockOnAssociatedGroupErrors: true,
      allowLocalTargets: false,
      deleteDownloadedFiles: true,
      includeProtectedWebOrigins: false,
      latestReportRetentionMinutes: 30,
      redactReports: true
    }),
    isIncognitoAllowed: async () => false,
    hasHostPermissions: async () => true,
    inspectImpact: async () => ({
      matchingTabs: 1,
      matchingPrivateTabs: 0,
      matchingHistoryEntries: 2,
      matchingDownloadRecords: 1,
      matchedCompletedFileIds: ['7'],
      matchedCompletedFileCount: 1,
      limitations: []
    }),
    storageSession: session,
    now: () => Date.parse('2026-08-16T12:00:00.000Z'),
    createToken: async () => 'one-time-token'
  };

  const prepared = await prepareCleanupReviewRequest(
    {
      input: 'https://alice.blogspot.com/private?secret=canary',
      sourceWindowId: 42,
      sourceIncognito: false
    },
    dependencies
  );

  assert.equal(prepared.review.approvalToken, 'one-time-token');
  assert.equal(prepared.review.associatedTargets.length, 1);
  assert.equal(prepared.review.requiredFileConfirmation, 'DELETE 1 FILE FOR alice.blogspot.com');
  assert.ok(session.values[CLEANUP_REVIEW_STORAGE_KEY]);
  assert.equal(JSON.stringify(session.values).includes('/private?secret=canary'), false);
  assert.deepEqual(mutations, []);

  const canceled = await cancelCleanupReviewRequest({ approvalToken: 'one-time-token' }, { storageSession: session });
  assert.equal(canceled.canceled, true);
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY], undefined);
  assert.deepEqual(mutations, []);
});

test('review remains read-only and defers withheld target host access to final approval', async () => {
  const session = createSessionStorage();
  const prepared = await prepareCleanupReviewRequest(
    {
      input: 'https://alice.blogspot.com/private?secret=canary',
      sourceWindowId: 42,
      sourceIncognito: false
    },
    {
      getSettings: async () => ({
        cleanupMode: 'standard',
        latestReportRetentionMinutes: 30,
        redactReports: true
      }),
      isIncognitoAllowed: async () => false,
      hasHostPermissions: async () => false,
      inspectImpact: async () => ({
        matchingTabs: null,
        matchingPrivateTabs: null,
        matchingHistoryEntries: 0,
        matchingDownloadRecords: 0,
        matchedCompletedFileIds: [],
        matchedCompletedFileCount: 0,
        limitations: ['Tab URLs are unavailable until target access is granted.']
      }),
      storageSession: session,
      now: () => Date.parse('2026-08-16T12:00:00.000Z'),
      createToken: async () => 'withheld-host-token'
    }
  );

  assert.equal(prepared.review.hostPermissionsGranted, false);
  assert.equal(prepared.review.readyForApproval, true);
  assert.deepEqual(prepared.review.requiredHostPermissionOrigins, [
    'http://alice.blogspot.com/*',
    'https://alice.blogspot.com/*',
    'http://*.alice.blogspot.com/*',
    'https://*.alice.blogspot.com/*'
  ]);
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY].hostPermissionsGranted, false);
  assert.equal(JSON.stringify(session.values).includes('/private?secret=canary'), false);
});

test('preflight aborts when pre-existing host access cannot be classified safely', async () => {
  const session = createSessionStorage();
  let impactInspected = false;

  await assert.rejects(
    prepareCleanupReviewRequest(
      { input: 'example.com', sourceWindowId: 2, sourceIncognito: false },
      {
        getSettings: async () => ({ cleanupMode: 'standard', redactReports: true }),
        isIncognitoAllowed: async () => false,
        hasHostPermissions: async () => false,
        containsHostPermissions: async () => {
          throw new Error('permissions API unavailable');
        },
        releaseHostPermissions: async () => true,
        inspectImpact: async () => {
          impactInspected = true;
          return { matchedCompletedFileIds: [] };
        },
        storageSession: session,
        storageLocal: session,
        now: () => 1_000,
        createToken: async () => 'permission-inspection-token'
      }
    ),
    /Target site-access inspection failed/
  );

  assert.equal(impactInspected, false);
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY], undefined);
});

test('a live review cannot be overwritten by another popup window', async () => {
  const session = createSessionStorage();
  const dependencies = {
    getSettings: async () => ({ cleanupMode: 'standard', redactReports: true }),
    isIncognitoAllowed: async () => false,
    hasHostPermissions: async () => false,
    inspectImpact: async () => ({ matchedCompletedFileIds: [] }),
    storageSession: session,
    now: () => 1_000,
    createToken: async () => 'first-window-review-token'
  };
  await prepareCleanupReviewRequest(
    { input: 'alice.blogspot.com', sourceWindowId: 5, sourceIncognito: false },
    dependencies
  );

  await assert.rejects(
    prepareCleanupReviewRequest(
      { input: 'bob.blogspot.com', sourceWindowId: 6, sourceIncognito: false },
      { ...dependencies, createToken: async () => 'second-window-review-token' }
    ),
    /Another cleanup review is active/
  );
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY].token, 'first-window-review-token');
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY].target.domain, 'alice.blogspot.com');
});

test('extension-local reset clears an active review and only its temporary origin access', async () => {
  const session = createSessionStorage();
  const preexistingOrigin = 'https://alice.blogspot.com/*';
  const temporaryOrigin = 'http://alice.blogspot.com/*';
  const granted = new Set([preexistingOrigin]);
  const dependencies = {
    getSettings: async () => ({ cleanupMode: 'standard', redactReports: true }),
    isIncognitoAllowed: async () => false,
    hasHostPermissions: async (origins) => origins.every((origin) => granted.has(origin)),
    releaseHostPermissions: async (origins) => {
      for (const origin of origins) granted.delete(origin);
      return true;
    },
    inspectImpact: async () => ({ matchedCompletedFileIds: [] }),
    storageSession: session,
    now: () => 1_000,
    createToken: async () => 'reset-review-state-token'
  };
  await prepareCleanupReviewRequest(
    { input: 'alice.blogspot.com', sourceWindowId: 5, sourceIncognito: false },
    dependencies
  );
  granted.add(temporaryOrigin);

  const result = await clearCleanupReviewState(session, dependencies);

  assert.equal(result.cleared, true);
  assert.equal(result.hostPermissionCleanup.released, true);
  assert.deepEqual(granted, new Set([preexistingOrigin]));
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY], undefined);
});

test('cancel, expiry, and invalid approval revoke access that was absent before review', async () => {
  for (const terminalPath of ['cancel', 'expire', 'invalid-context']) {
    const session = createSessionStorage();
    let granted = false;
    const releasedOrigins = [];
    const dependencies = {
      getSettings: async () => ({
        cleanupMode: 'standard',
        latestReportRetentionMinutes: 30,
        redactReports: true
      }),
      isIncognitoAllowed: async () => false,
      hasHostPermissions: async () => granted,
      releaseHostPermissions: async (origins) => {
        releasedOrigins.push(...origins);
        granted = false;
        return true;
      },
      inspectImpact: async () => ({ matchedCompletedFileIds: [] }),
      storageSession: session,
      now: () => 1_000,
      createToken: async () => `temporary-${terminalPath}`
    };
    await prepareCleanupReviewRequest(
      { input: 'alice.blogspot.com', sourceWindowId: 5, sourceIncognito: false },
      dependencies
    );
    granted = true;

    if (terminalPath === 'cancel') {
      const result = await cancelCleanupReviewRequest({ approvalToken: `temporary-${terminalPath}` }, dependencies);
      assert.equal(result.hostPermissionCleanup.released, true);
    } else if (terminalPath === 'expire') {
      const result = await clearExpiredCleanupReview(session, 1_000 + 5 * 60 * 1000 + 1, dependencies);
      assert.equal(result.hostPermissionCleanup.released, true);
    } else {
      await assert.rejects(
        consumeCleanupReviewRequest(
          {
            approvalToken: `temporary-${terminalPath}`,
            sourceWindowId: 6,
            sourceIncognito: false,
            approval: {
              reviewedScope: true,
              associatedTargets: false,
              localOrIpTarget: false,
              protectedWebOrigins: false,
              fileConfirmationText: ''
            }
          },
          dependencies
        ),
        /context changed/i
      );
    }

    assert.equal(granted, false);
    assert.equal(releasedOrigins.length, 4);
    assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY], undefined);
  }
});

test('review cleanup preserves origin patterns that were granted before a partial access request', async () => {
  const session = createSessionStorage();
  const preexisting = new Set(['https://alice.blogspot.com/*', 'https://*.alice.blogspot.com/*']);
  const granted = new Set(preexisting);
  const releasedOrigins = [];
  const dependencies = {
    getSettings: async () => ({ cleanupMode: 'standard', redactReports: true }),
    isIncognitoAllowed: async () => false,
    hasHostPermissions: async (origins) => origins.every((origin) => granted.has(origin)),
    releaseHostPermissions: async (origins) => {
      releasedOrigins.push(...origins);
      for (const origin of origins) granted.delete(origin);
      return true;
    },
    inspectImpact: async () => ({ matchedCompletedFileIds: [] }),
    storageSession: session,
    now: () => 1_000,
    createToken: async () => 'partial-permission-token'
  };

  const prepared = await prepareCleanupReviewRequest(
    { input: 'alice.blogspot.com', sourceWindowId: 5, sourceIncognito: false },
    dependencies
  );
  assert.equal(prepared.review.hostPermissionsGranted, false);
  assert.deepEqual(session.values[CLEANUP_REVIEW_STORAGE_KEY].preexistingHostPermissionOrigins, [...preexisting]);

  granted.add('http://alice.blogspot.com/*');
  const result = await cancelCleanupReviewRequest({ approvalToken: 'partial-permission-token' }, dependencies);

  assert.equal(result.hostPermissionCleanup.released, true);
  assert.deepEqual(releasedOrigins, ['http://alice.blogspot.com/*']);
  assert.deepEqual(new Set(granted), preexisting);
});

test('approval is single-use, context-bound, and validated before execution data is returned', async () => {
  const session = createSessionStorage();
  const common = {
    getSettings: async () => ({
      cleanupMode: 'standard',
      latestReportRetentionMinutes: 30,
      redactReports: true
    }),
    isIncognitoAllowed: async () => false,
    hasHostPermissions: async () => true,
    inspectImpact: async () => ({ matchedCompletedFileIds: [] }),
    storageSession: session,
    now: () => 1_000,
    createToken: async () => 'context-token'
  };
  await prepareCleanupReviewRequest({ input: 'example.com', sourceWindowId: 5, sourceIncognito: false }, common);

  await assert.rejects(
    consumeCleanupReviewRequest(
      {
        approvalToken: 'context-token',
        sourceWindowId: 6,
        sourceIncognito: false,
        approval: { reviewedScope: true }
      },
      { storageSession: session, now: () => 1_001 }
    ),
    /context changed/
  );
  assert.equal(
    session.values[CLEANUP_REVIEW_STORAGE_KEY],
    undefined,
    'a failed approval attempt still consumes the token'
  );

  await prepareCleanupReviewRequest({ input: 'example.com', sourceWindowId: 5, sourceIncognito: false }, common);
  const approved = await consumeCleanupReviewRequest(
    {
      approvalToken: 'context-token',
      sourceWindowId: 5,
      sourceIncognito: false,
      approval: { reviewedScope: true }
    },
    { storageSession: session, now: () => 1_001 }
  );
  assert.equal(approved.target.domain, 'example.com');
  assert.deepEqual(approved.approvedDownloadFileIds, []);
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY], undefined);

  await assert.rejects(
    consumeCleanupReviewRequest(
      {
        approvalToken: 'context-token',
        sourceWindowId: 5,
        sourceIncognito: false,
        approval: { reviewedScope: true }
      },
      { storageSession: session, now: () => 1_002 }
    ),
    /missing, expired, or has already been used/
  );
});

test('background strips the retired bypass setting and requires reviewed Standard approval', async () => {
  const session = createSessionStorage();
  const dependencies = {
    getSettings: async () => ({
      cleanupMode: 'standard',
      skipCleanupReview: true,
      latestReportRetentionMinutes: 30,
      redactReports: true
    }),
    isIncognitoAllowed: async () => false,
    hasHostPermissions: async () => true,
    inspectImpact: async () => ({
      matchingTabs: 1,
      matchingPrivateTabs: 0,
      matchingHistoryEntries: 2,
      matchingDownloadRecords: 0,
      matchedCompletedFileCount: 0,
      matchedCompletedFileIds: [],
      limitations: []
    }),
    storageSession: session,
    now: () => 1_000,
    createToken: async () => 'quick-preflight-token'
  };

  const prepared = await prepareCleanupReviewRequest(
    { input: 'example.com', sourceWindowId: 5, sourceIncognito: false },
    dependencies
  );
  assert.equal(Object.hasOwn(prepared.review, 'quickCleanupAllowed'), false);
  assert.equal(Object.hasOwn(session.values[CLEANUP_REVIEW_STORAGE_KEY], 'quickCleanupAllowed'), false);
  assert.equal(Object.hasOwn(session.values[CLEANUP_REVIEW_STORAGE_KEY].settings, 'skipCleanupReview'), false);
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY].schemaVersion, CLEANUP_REVIEW_SCHEMA_VERSION);

  const approved = await consumeCleanupReviewRequest(
    {
      approvalToken: 'quick-preflight-token',
      sourceWindowId: 5,
      sourceIncognito: false,
      approval: {
        approvalMode: 'detailed_review',
        reviewedScope: true,
        associatedTargets: false,
        localOrIpTarget: false,
        protectedWebOrigins: false,
        fileConfirmationText: ''
      }
    },
    { storageSession: session, now: () => 1_001 }
  );
  assert.equal(approved.approvalMode, 'detailed_review');
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY], undefined);
});

test('background requires complete reviewed approval for elevated and uncertain Expert scope', async () => {
  const session = createSessionStorage();
  const dependencies = {
    getSettings: async () => ({
      cleanupMode: 'expert',
      associatedDomainGroups: 'example.com => accounts.example.net',
      storageBucketScrub: true,
      opfsScrub: true,
      includeProtectedWebOrigins: true,
      deleteDownloadedFiles: true,
      postWipeSessionBlock: true,
      latestReportRetentionMinutes: 30,
      redactReports: true
    }),
    isIncognitoAllowed: async () => true,
    hasHostPermissions: async () => false,
    inspectImpact: async () => ({
      matchingTabs: 1,
      matchingPrivateTabs: 0,
      matchingHistoryEntries: 2,
      matchingDownloadRecords: 0,
      matchedCompletedFileCount: 1,
      matchedCompletedFileIds: ['17'],
      limitations: ['One impact adapter returned an uncertain count.']
    }),
    storageSession: session,
    now: () => 2_000,
    createToken: async () => 'expert-quick-preflight-token'
  };

  const prepared = await prepareCleanupReviewRequest(
    { input: 'example.com', sourceWindowId: 6, sourceIncognito: false },
    dependencies
  );
  assert.equal(prepared.review.settingsSnapshot.cleanupMode, 'expert');
  assert.equal(prepared.review.hostPermissionsGranted, false);
  assert.equal(prepared.review.privateWindowScope.included, true);
  assert.equal(prepared.review.requirements.associatedTargets, true);
  assert.equal(prepared.review.requirements.protectedWebOrigins, true);
  assert.equal(prepared.review.requirements.downloadedFiles, true);
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY].settings.cleanupMode, 'expert');

  const approved = await consumeCleanupReviewRequest(
    {
      approvalToken: 'expert-quick-preflight-token',
      sourceWindowId: 6,
      sourceIncognito: false,
      approval: {
        approvalMode: 'detailed_review',
        reviewedScope: true,
        associatedTargets: true,
        localOrIpTarget: false,
        protectedWebOrigins: true,
        fileConfirmationText: prepared.review.requiredFileConfirmation
      }
    },
    { storageSession: session, now: () => 2_001 }
  );
  assert.equal(approved.settings.cleanupMode, 'expert');
  assert.equal(approved.approvalMode, 'detailed_review');
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY], undefined);
});

test('background rejects every forged quick approval even when a legacy profile opted in', async () => {
  const session = createSessionStorage();
  await prepareCleanupReviewRequest(
    { input: 'example.com', sourceWindowId: 5, sourceIncognito: false },
    {
      getSettings: async () => ({ cleanupMode: 'standard', skipCleanupReview: true }),
      isIncognitoAllowed: async () => false,
      hasHostPermissions: async () => true,
      inspectImpact: async () => ({
        matchingTabs: 0,
        matchingPrivateTabs: 0,
        matchingHistoryEntries: 0,
        matchingDownloadRecords: 0,
        matchedCompletedFileIds: [],
        limitations: []
      }),
      storageSession: session,
      now: () => 1_000,
      createToken: async () => 'forged-quick-token'
    }
  );

  await assert.rejects(
    consumeCleanupReviewRequest(
      {
        approvalToken: 'forged-quick-token',
        sourceWindowId: 5,
        sourceIncognito: false,
        approval: { approvalMode: 'quick' }
      },
      { storageSession: session, now: () => 1_001 }
    ),
    /complete per-run cleanup review is required/i
  );
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY], undefined);
});

test('schema-2 approvals from the retired bypass era are invalidated and discarded', async () => {
  const session = createSessionStorage();
  await prepareCleanupReviewRequest(
    { input: 'example.com', sourceWindowId: 5, sourceIncognito: false },
    {
      getSettings: async () => ({ cleanupMode: 'standard' }),
      isIncognitoAllowed: async () => false,
      hasHostPermissions: async () => true,
      inspectImpact: async () => ({ matchedCompletedFileIds: [], limitations: [] }),
      storageSession: session,
      now: () => 1_000,
      createToken: async () => 'legacy-schema-token'
    }
  );
  session.values[CLEANUP_REVIEW_STORAGE_KEY].schemaVersion = 2;
  session.values[CLEANUP_REVIEW_STORAGE_KEY].quickCleanupAllowed = true;

  await assert.rejects(
    consumeCleanupReviewRequest(
      {
        approvalToken: 'legacy-schema-token',
        sourceWindowId: 5,
        sourceIncognito: false,
        approval: {
          approvalMode: 'detailed_review',
          reviewedScope: true,
          associatedTargets: false,
          localOrIpTarget: false,
          protectedWebOrigins: false,
          fileConfirmationText: ''
        }
      },
      { storageSession: session, now: () => 1_001 }
    ),
    /failed integrity validation/i
  );
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY], undefined);
});

test('tampered session approval state is discarded before it can broaden scope or weaken confirmation', async () => {
  const session = createSessionStorage();
  const dependencies = {
    getSettings: async () => ({ cleanupMode: 'expert', deleteDownloadedFiles: true, redactReports: true }),
    isIncognitoAllowed: async () => false,
    hasHostPermissions: async () => true,
    inspectImpact: async () => ({ matchedCompletedFileIds: ['7'], limitations: [] }),
    storageSession: session,
    now: () => Date.parse('2026-08-16T12:00:00.000Z'),
    createToken: async () => 'tamper-proof-review-token'
  };

  await prepareCleanupReviewRequest(
    { input: 'alice.blogspot.com', sourceWindowId: 9, sourceIncognito: false },
    dependencies
  );
  const stored = session.values[CLEANUP_REVIEW_STORAGE_KEY];
  stored.target.domain = 'example.com';
  stored.requirements.downloadedFiles = false;

  await assert.rejects(
    consumeCleanupReviewRequest(
      {
        approvalToken: 'tamper-proof-review-token',
        sourceWindowId: 9,
        sourceIncognito: false,
        approval: {
          approvalMode: 'detailed_review',
          reviewedScope: true,
          associatedTargets: true,
          localOrIpTarget: true,
          protectedWebOrigins: true,
          fileConfirmationText: ''
        }
      },
      { storageSession: session }
    ),
    /failed integrity validation/i
  );
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY], undefined);
});

test('service-worker routing keeps all cleanup mutations behind token consumption', async () => {
  const source = await readFile(new URL('../../src/background/service-worker.js', import.meta.url), 'utf8');
  const prepareStart = source.indexOf('case MESSAGE_TYPES.prepareCleanupReview:');
  const cancelStart = source.indexOf('case MESSAGE_TYPES.cancelCleanupReview:');
  const runStart = source.indexOf('case MESSAGE_TYPES.runDeepClean:');
  const runEnd = source.indexOf('case MESSAGE_TYPES.getReport:');
  assert.ok(prepareStart >= 0 && cancelStart > prepareStart && runStart > cancelStart && runEnd > runStart);

  const beforeApproval = source.slice(prepareStart, runStart);
  for (const forbidden of [
    'runDeepClean(',
    'repairSiteWipeRuntime(',
    'setActiveJob(',
    'setActiveShield(',
    'clearSiteWipeDnrRules(',
    'chrome.browsingData.remove(',
    'chrome.cookies.remove(',
    'chrome.tabs.remove(',
    'chrome.history.deleteUrl(',
    'chrome.downloads.erase(',
    'chrome.downloads.removeFile(',
    'chrome.scripting.executeScript(',
    'chrome.declarativeNetRequest.updateSessionRules('
  ]) {
    assert.equal(beforeApproval.includes(forbidden), false, `${forbidden} must not occur in prepare/cancel routing`);
  }

  const runRoute = source.slice(runStart, runEnd);
  const consumedAt = runRoute.indexOf('consumeCleanupReviewRequest(');
  assert.ok(consumedAt >= 0);
  for (const mutationGate of ['repairSiteWipeRuntime(', 'setActiveJob(', 'runDeepClean(']) {
    assert.ok(runRoute.indexOf(mutationGate) > consumedAt, `${mutationGate} must remain after approval consumption`);
  }
});

test('popup requests missing host access only from the final cleanup approval gesture', async () => {
  const source = await readFile(new URL('../../src/popup/popup.js', import.meta.url), 'utf8');
  const handlerStart = source.indexOf('async function runApprovedCleanup()');
  const handlerEnd = source.indexOf('function renderCleanupReview', handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);
  const permissionRequest = handler.indexOf('chrome.permissions.request');
  const cleanupRequest = handler.indexOf('sendMessage(MESSAGE_TYPES.runDeepClean');

  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  assert.ok(permissionRequest >= 0 && cleanupRequest > permissionRequest);
  assert.doesNotMatch(source, /grantReviewedHostAccess/);
});

test('popup has no direct cleanup path from the initial submit and always renders the review', async () => {
  const source = await readFile(new URL('../../src/popup/popup.js', import.meta.url), 'utf8');
  const submitStart = source.indexOf('async function onSubmit(event)');
  const submitEnd = source.indexOf('async function runApprovedCleanup()', submitStart);
  const submitHandler = source.slice(submitStart, submitEnd);

  assert.ok(submitStart >= 0 && submitEnd > submitStart);
  assert.match(submitHandler, /sendMessage\(MESSAGE_TYPES\.prepareCleanupReview/);
  assert.match(submitHandler, /renderCleanupReview\(cleanupReview\)/);
  assert.doesNotMatch(submitHandler, /MESSAGE_TYPES\.runDeepClean|chrome\.permissions\.request/);
  assert.doesNotMatch(source, /runPreparedQuickCleanup|prepareOneClickCleanup|isQuickCleanupSettingActive/);
  assert.doesNotMatch(source, /approvalMode: 'quick'/);
  assert.match(source, /return 'Review cleanup'/);
});

test('retired bypass state is absent from runtime settings and Expert-mode options', async () => {
  const [constants, storage, optionsHtml, optionsJs] = await Promise.all([
    readFile(new URL('../../src/shared/constants.js', import.meta.url), 'utf8'),
    readFile(new URL('../../src/shared/storage.js', import.meta.url), 'utf8'),
    readFile(new URL('../../src/options/options.html', import.meta.url), 'utf8'),
    readFile(new URL('../../src/options/options.js', import.meta.url), 'utf8')
  ]);
  for (const source of [constants, storage, optionsHtml, optionsJs]) {
    assert.doesNotMatch(source, /skipCleanupReview/);
  }
  assert.match(optionsHtml, /Cleanup review is always required/);
  assert.match(optionsHtml, /Standard and Expert cleanup both show a fresh, read-only summary/);
  assert.match(optionsJs, /Every run still requires a fresh detailed scope and impact review/);
});

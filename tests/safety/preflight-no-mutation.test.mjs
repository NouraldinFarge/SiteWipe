import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { normalizeSiteInput } from '../../src/background/domain.js';
import { boundCleanupOrigins, inspectCleanupImpact } from '../../src/background/cleanup.js';
import {
  CLEANUP_REVIEW_SCHEMA_VERSION,
  CLEANUP_REVIEW_STORAGE_KEY,
  CLEANUP_REVIEW_TTL_MS,
  armCleanupReviewApprovalRequest,
  cancelCleanupReviewRequest,
  clearCleanupReviewState,
  clearExpiredCleanupReview,
  consumeCleanupReviewRequest as consumeCleanupReviewRequestImpl,
  finalizeArmedCleanupReviewAdmission,
  getReadyArmedCleanupReview,
  normalizeCleanupReviewRecord,
  stageCleanupReviewApprovalRequest,
  prepareCleanupReviewRequest as prepareCleanupReviewRequestImpl
} from '../../src/background/cleanup-preflight.js';

function withVerifiedSourceWindow(payload, dependencies = {}) {
  return {
    inspectSourceWindow: async (sourceWindowId) => ({
      sourceWindowId,
      sourceIncognito: payload.sourceIncognito
    }),
    preparationContextId: 'popup-context-unit-test',
    promptContextId: 'popup-context-unit-test',
    ...dependencies
  };
}

function prepareCleanupReviewRequest(payload, dependencies) {
  return prepareCleanupReviewRequestImpl(payload, withVerifiedSourceWindow(payload, dependencies));
}

function consumeCleanupReviewRequest(payload, dependencies) {
  return consumeCleanupReviewRequestImpl(payload, withVerifiedSourceWindow(payload, dependencies));
}

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

function detailedApproval(overrides = {}) {
  return {
    approvalMode: 'detailed_review',
    reviewedScope: true,
    associatedTargets: false,
    localOrIpTarget: false,
    protectedWebOrigins: false,
    fileConfirmationText: '',
    ...overrides
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
          incognito: false,
          state: 'complete',
          exists: true,
          url: 'https://alice.blogspot.com/archive.zip'
        },
        {
          id: 8,
          incognito: true,
          state: 'complete',
          exists: true,
          url: 'https://alice.blogspot.com/private-archive.zip'
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
    const impactWithPrivateAccess = await inspectCleanupImpact(normalized.target, {
      downloadRecentFallback: false,
      incognitoAccess: true
    });
    assert.equal(impactWithPrivateAccess.matchingDownloadRecords, 2);
    assert.deepEqual(impactWithPrivateAccess.matchedCompletedFileIds.sort(), ['7', '8']);
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

test('preflight fails closed when authoritative source-window inspection is unavailable or mismatched', async () => {
  for (const inspectSourceWindow of [
    undefined,
    async (sourceWindowId) => ({ sourceWindowId, sourceIncognito: true })
  ]) {
    const session = createSessionStorage();
    let impactInspected = false;
    const dependencies = {
      getSettings: async () => ({ cleanupMode: 'standard', redactReports: true }),
      isIncognitoAllowed: async () => false,
      hasHostPermissions: async () => true,
      inspectImpact: async () => {
        impactInspected = true;
        return {};
      },
      storageSession: session,
      storageLocal: session,
      ...(inspectSourceWindow ? { inspectSourceWindow } : {})
    };

    await assert.rejects(
      prepareCleanupReviewRequestImpl(
        { input: 'example.com', sourceWindowId: 4, sourceIncognito: false },
        dependencies
      ),
      /source-window|source window|inspectSourceWindow/i
    );
    assert.equal(impactInspected, false);
    assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY], undefined);
  }
});

test('approval consumption re-inspects the source window and consumes the token on a private-state mismatch', async () => {
  const session = createSessionStorage();
  const payload = { input: 'example.com', sourceWindowId: 4, sourceIncognito: false };
  const dependencies = {
    getSettings: async () => ({ cleanupMode: 'standard', redactReports: true }),
    isIncognitoAllowed: async () => false,
    hasHostPermissions: async () => true,
    inspectImpact: async () => ({
      matchingTabs: 0,
      matchingPrivateTabs: 0,
      matchingHistoryEntries: 0,
      matchingDownloadRecords: 0,
      matchedCompletedFileIds: [],
      matchedCompletedFileCount: 0,
      limitations: []
    }),
    storageSession: session,
    storageLocal: session,
    now: () => 1_000,
    createToken: async () => 'source-window-recheck-token'
  };
  await prepareCleanupReviewRequest(payload, dependencies);

  await assert.rejects(
    consumeCleanupReviewRequestImpl(
      {
        approvalToken: 'source-window-recheck-token',
        sourceWindowId: 4,
        sourceIncognito: false,
        approval: detailedApproval()
      },
      {
        ...dependencies,
        inspectSourceWindow: async (sourceWindowId) => ({
          sourceWindowId,
          sourceIncognito: true
        })
      }
    ),
    /private-window state changed/i
  );
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY], undefined);
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

test('an equivalent same-context retry rotates popup authority without extending the direct review', async () => {
  const session = createSessionStorage();
  let impactInspections = 0;
  let tokenCreations = 0;
  const dependencies = {
    getSettings: async () => ({ cleanupMode: 'standard', skipCleanupReview: true, redactReports: true }),
    isIncognitoAllowed: async () => false,
    hasHostPermissions: async () => false,
    inspectImpact: async () => {
      impactInspections += 1;
      return { matchingTabs: 1, matchedCompletedFileIds: [] };
    },
    storageSession: session,
    now: () => 1_000,
    createToken: async () => {
      tokenCreations += 1;
      return 'resumable-direct-review-token';
    }
  };
  const payload = { input: 'https://example.com/path', sourceWindowId: 5, sourceIncognito: false };
  const first = await prepareCleanupReviewRequest(payload, dependencies);
  const storedBefore = structuredClone(session.values[CLEANUP_REVIEW_STORAGE_KEY]);

  const reopened = await prepareCleanupReviewRequest(payload, dependencies);

  assert.equal(reopened.resumed, true);
  assert.equal(reopened.review.approvalMode, 'settings_direct');
  assert.equal(reopened.review.approvalToken, first.review.approvalToken);
  assert.equal(reopened.review.expiresAt, first.review.expiresAt);
  assert.equal(reopened.review.permissionLeaseId, first.review.permissionLeaseId);
  assert.equal(reopened.review.enteredTarget, payload.input);
  const storedAfter = session.values[CLEANUP_REVIEW_STORAGE_KEY];
  assert.notEqual(storedAfter.popupPreparationCapabilityDigest, storedBefore.popupPreparationCapabilityDigest);
  assert.deepEqual(
    { ...storedAfter, popupPreparationCapabilityDigest: storedBefore.popupPreparationCapabilityDigest },
    storedBefore
  );
  assert.notEqual(reopened.popupPreparationCapability, first.popupPreparationCapability);
  assert.equal(impactInspections, 1);
  assert.equal(tokenCreations, 1);
});

test('a retired pregranted popup context rebinds with rotated one-use authority', async () => {
  const session = createSessionStorage();
  const payload = { input: 'example.com', sourceWindowId: 5, sourceIncognito: false };
  const exactOrigins = [
    'http://example.com/*',
    'https://example.com/*',
    'http://*.example.com/*',
    'https://*.example.com/*'
  ];
  const common = {
    getSettings: async () => ({ cleanupMode: 'standard', skipCleanupReview: true, redactReports: true }),
    isIncognitoAllowed: async () => false,
    hasHostPermissions: async () => true,
    getAllHostPermissions: async () => ({ origins: exactOrigins }),
    inspectImpact: async () => ({ matchingTabs: 0, matchedCompletedFileIds: [] }),
    storageSession: session,
    now: () => 1_000,
    createToken: async () => 'pregranted-rebind-review-token'
  };
  const first = await prepareCleanupReviewRequest(payload, {
    ...common,
    preparationContextId: 'retired pregranted/context #A'
  });
  assert.equal(first.review.permissionLeaseId, null);

  const rebound = await prepareCleanupReviewRequest(payload, {
    ...common,
    preparationContextId: 'replacement pregranted/context #B',
    isPreparationContextActive: async (contextId) => {
      assert.equal(contextId, first.popupContextId);
      return false;
    }
  });
  assert.equal(rebound.resumed, true);
  assert.equal(rebound.review.approvalToken, first.review.approvalToken);
  assert.equal(rebound.popupContextId, 'replacement pregranted/context #B');
  assert.notEqual(rebound.popupPreparationCapability, first.popupPreparationCapability);
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY].preparationContextId, rebound.popupContextId);

  await assert.rejects(
    cancelCleanupReviewRequest(
      {
        approvalToken: rebound.review.approvalToken,
        popupContextId: rebound.popupContextId,
        popupPreparationCapability: first.popupPreparationCapability,
        promptNotStarted: true
      },
      { ...common, requirePopupPreparationCapability: true }
    ),
    /no longer owns/i
  );
  const canceled = await cancelCleanupReviewRequest(
    {
      approvalToken: rebound.review.approvalToken,
      popupContextId: rebound.popupContextId,
      popupPreparationCapability: rebound.popupPreparationCapability,
      promptNotStarted: true
    },
    { ...common, requirePopupPreparationCapability: true }
  );
  assert.equal(canceled.canceled, true);
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY], undefined);
});

test('an armed final approval remains worker-owned after popup loss and is consumed exactly once', async () => {
  const session = createSessionStorage();
  const exactGrantedOrigins = new Set();
  let impactInspections = 0;
  const dependencies = {
    getSettings: async () => ({ cleanupMode: 'standard', skipCleanupReview: false, redactReports: true }),
    isIncognitoAllowed: async () => false,
    hasHostPermissions: async (origins) => origins.every((origin) => exactGrantedOrigins.has(origin)),
    getAllHostPermissions: async () => ({ origins: [...exactGrantedOrigins] }),
    inspectImpact: async () => {
      impactInspections += 1;
      return { matchingTabs: 1, matchedCompletedFileIds: [] };
    },
    storageSession: session,
    now: () => 1_000,
    createToken: async () => 'prompt-granted-reopen-token',
    createHandoffNonce: async () => 'prompt-granted-handoff-nonce'
  };
  const payload = { input: 'example.com', sourceWindowId: 5, sourceIncognito: false };
  const first = await prepareCleanupReviewRequest(payload, dependencies);
  const preparedLease = structuredClone(session.values['sitewipe.permissionLease.v1']);
  assert.equal(preparedLease.status, 'prompt_pending');
  const armed = await armCleanupReviewApprovalRequest(
    {
      approvalToken: first.review.approvalToken,
      handoffNonce: first.review.approvalHandoffNonce,
      sourceWindowId: 5,
      sourceIncognito: false,
      approval: detailedApproval()
    },
    withVerifiedSourceWindow(payload, dependencies)
  );
  assert.equal(armed.handoffNonce, first.review.approvalHandoffNonce);
  const lease = structuredClone(session.values['sitewipe.permissionLease.v1']);
  assert.equal(lease.status, 'prompt_pending');
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY].approvalHandoff.status, 'armed');
  for (const origin of lease.temporaryOrigins) exactGrantedOrigins.add(origin);

  await assert.rejects(prepareCleanupReviewRequest(payload, dependencies), /another cleanup review is active/i);
  assert.deepEqual(session.values['sitewipe.permissionLease.v1'], lease);
  assert.equal(impactInspections, 1);

  const ready = await getReadyArmedCleanupReview(dependencies);
  assert.equal(ready.handoffNonce, armed.handoffNonce);

  const consumed = await consumeCleanupReviewRequest(ready.payload, {
    ...dependencies,
    expectedApprovalHandoffNonce: ready.handoffNonce
  });
  assert.equal(consumed.permissionLeaseId, lease.id);
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY].approvalHandoff.status, 'admitting');
  assert.equal(session.values['sitewipe.permissionLease.v1'].status, 'active_cleanup');
  assert.equal(await getReadyArmedCleanupReview(dependencies), null, 'admitting is a permanent no-retry barrier');
  await finalizeArmedCleanupReviewAdmission(
    { approvalToken: consumed.token, handoffNonce: consumed.approvalHandoffNonce },
    session
  );
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY], undefined);
  await assert.rejects(
    consumeCleanupReviewRequest(
      {
        approvalToken: first.review.approvalToken,
        sourceWindowId: 5,
        sourceIncognito: false,
        approval: detailedApproval()
      },
      dependencies
    ),
    /missing, expired, or has already been used/i
  );
});

test('a final-click marker first observed after expiry retains exact native-prompt settlement ownership', async () => {
  const session = createSessionStorage();
  let nowMs = 1_000;
  const payload = { input: 'example.com', sourceWindowId: 5, sourceIncognito: false };
  const dependencies = {
    getSettings: async () => ({ cleanupMode: 'standard', skipCleanupReview: false, redactReports: true }),
    isIncognitoAllowed: async () => false,
    hasHostPermissions: async () => false,
    getAllHostPermissions: async () => ({ origins: [] }),
    inspectImpact: async () => ({ matchingTabs: 1, matchedCompletedFileIds: [] }),
    storageSession: session,
    now: () => nowMs,
    createToken: async () => 'expired-first-arm-review-token',
    createHandoffNonce: async () => 'expired-first-arm-handoff-nonce'
  };
  const prepared = await prepareCleanupReviewRequest(payload, dependencies);
  const lease = structuredClone(session.values['sitewipe.permissionLease.v1']);
  nowMs += CLEANUP_REVIEW_TTL_MS + 1;

  await assert.rejects(
    stageCleanupReviewApprovalRequest(
      {
        approvalToken: prepared.review.approvalToken,
        handoffNonce: prepared.review.approvalHandoffNonce,
        sourceWindowId: 5,
        sourceIncognito: false,
        approval: detailedApproval()
      },
      withVerifiedSourceWindow(payload, dependencies)
    ),
    /expired/i
  );

  const retained = normalizeCleanupReviewRecord(session.values[CLEANUP_REVIEW_STORAGE_KEY]);
  assert.equal(retained.approvalHandoff.status, 'prompt_tombstone');
  assert.equal(retained.approvalHandoff.nonce, prepared.review.approvalHandoffNonce);
  assert.equal(retained.approvalHandoff.promptContextId, 'popup-context-unit-test');
  assert.deepEqual(retained.approvalHandoff.approval, detailedApproval());
  assert.deepEqual(session.values['sitewipe.permissionLease.v1'], lease);
});

test('popup reopen blocks changed authority while preserving the active review, lease, and external broad grant', async () => {
  const session = createSessionStorage();
  let broadGrant = false;
  const dependencies = {
    getSettings: async () => ({ cleanupMode: 'standard', skipCleanupReview: true, redactReports: true }),
    isIncognitoAllowed: async () => false,
    hasHostPermissions: async () => broadGrant,
    getAllHostPermissions: async () => ({ origins: broadGrant ? ['<all_urls>'] : [] }),
    inspectImpact: async () => ({ matchingTabs: 1, matchedCompletedFileIds: [] }),
    storageSession: session,
    now: () => 1_000,
    createToken: async () => 'broad-grant-reopen-token'
  };
  const payload = { input: 'example.com', sourceWindowId: 5, sourceIncognito: false };
  await prepareCleanupReviewRequest(payload, dependencies);
  const storedReview = structuredClone(session.values[CLEANUP_REVIEW_STORAGE_KEY]);
  const storedLease = structuredClone(session.values['sitewipe.permissionLease.v1']);
  broadGrant = true;

  await assert.rejects(prepareCleanupReviewRequest(payload, dependencies), /another cleanup review is active/i);
  assert.deepEqual(session.values[CLEANUP_REVIEW_STORAGE_KEY], storedReview);
  assert.deepEqual(session.values['sitewipe.permissionLease.v1'], storedLease);
  assert.equal(broadGrant, true);
});

test('extension-local reset abandons an unarmed lease without removing externally changed access', async () => {
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
  assert.equal(result.hostPermissionCleanup.released, false);
  assert.equal(result.hostPermissionCleanup.recordRetained, true);
  assert.equal(result.hostPermissionCleanup.reason, 'permission_prompt_pending');
  assert.deepEqual(granted, new Set([preexistingOrigin, temporaryOrigin]));
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY], undefined);
});

test('cancel and invalid approval revoke transaction-temporary drift while passive expiry retains prompt recovery', async () => {
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
      assert.equal(result.hostPermissionCleanup.released, false);
      assert.equal(result.hostPermissionCleanup.recordRetained, true);
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

    assert.equal(granted, terminalPath === 'expire');
    assert.equal(releasedOrigins.length, terminalPath === 'expire' ? 0 : 4);
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
      approval: { approvalMode: 'detailed_review', reviewedScope: true }
    },
    { ...common, now: () => 1_001 }
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
        approval: { approvalMode: 'detailed_review', reviewedScope: true }
      },
      { ...common, now: () => 1_002 }
    ),
    /missing, expired, or has already been used/
  );
});

test('background binds explicit settings-direct Standard authorization', async () => {
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
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY].settings.skipCleanupReview, true);
  assert.equal(prepared.review.approvalMode, 'settings_direct');
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY].schemaVersion, CLEANUP_REVIEW_SCHEMA_VERSION);

  const approved = await consumeCleanupReviewRequest(
    {
      approvalToken: 'quick-preflight-token',
      sourceWindowId: 5,
      sourceIncognito: false,
      approval: {
        approvalMode: 'settings_direct',
        reviewedScope: false,
        associatedTargets: false,
        localOrIpTarget: false,
        protectedWebOrigins: false,
        fileConfirmationText: ''
      }
    },
    { ...dependencies, now: () => 1_001 }
  );
  assert.equal(approved.approvalMode, 'settings_direct');
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY], undefined);
});

test('background requires complete reviewed approval for elevated and uncertain Expert scope', async () => {
  const session = createSessionStorage();
  const grantedOrigins = new Set();
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
    hasHostPermissions: async (origins) => origins.every((origin) => grantedOrigins.has(origin)),
    getAllHostPermissions: async () => ({ origins: [...grantedOrigins] }),
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

  const approval = {
    approvalMode: 'detailed_review',
    reviewedScope: true,
    associatedTargets: true,
    localOrIpTarget: false,
    protectedWebOrigins: true,
    fileConfirmationText: prepared.review.requiredFileConfirmation
  };
  const armed = await armCleanupReviewApprovalRequest(
    {
      approvalToken: 'expert-quick-preflight-token',
      handoffNonce: prepared.review.approvalHandoffNonce,
      sourceWindowId: 6,
      sourceIncognito: false,
      approval
    },
    withVerifiedSourceWindow({ sourceWindowId: 6, sourceIncognito: false }, { ...dependencies, now: () => 2_001 })
  );
  for (const origin of session.values['sitewipe.permissionLease.v1'].temporaryOrigins) grantedOrigins.add(origin);
  const ready = await getReadyArmedCleanupReview({ ...dependencies, now: () => 2_002 });
  assert.equal(ready.handoffNonce, armed.handoffNonce);
  const approved = await consumeCleanupReviewRequest(ready.payload, {
    ...dependencies,
    now: () => 2_003,
    expectedApprovalHandoffNonce: ready.handoffNonce
  });
  assert.equal(approved.settings.cleanupMode, 'expert');
  assert.equal(approved.approvalMode, 'detailed_review');
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY].approvalHandoff.status, 'admitting');
});

test('background rejects every forged quick approval when settings-direct is enabled', async () => {
  const session = createSessionStorage();
  const dependencies = {
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
  };
  await prepareCleanupReviewRequest({ input: 'example.com', sourceWindowId: 5, sourceIncognito: false }, dependencies);

  await assert.rejects(
    consumeCleanupReviewRequest(
      {
        approvalToken: 'forged-quick-token',
        sourceWindowId: 5,
        sourceIncognito: false,
        approval: { approvalMode: 'quick' }
      },
      { ...dependencies, now: () => 1_001 }
    ),
    /complete per-run cleanup review is required/i
  );
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY], undefined);
});

test('approval fails closed when Expert cleanup settings changed after review', async () => {
  const session = createSessionStorage();
  let settings = {
    cleanupMode: 'expert',
    deleteDownloadedFiles: true,
    includeProtectedWebOrigins: true,
    redactReports: true
  };
  let granted = false;
  const released = [];
  const dependencies = {
    getSettings: async () => settings,
    isIncognitoAllowed: async () => false,
    hasHostPermissions: async () => granted,
    releaseHostPermissions: async (origins) => {
      released.push(...origins);
      granted = false;
      return true;
    },
    inspectImpact: async () => ({ matchedCompletedFileIds: ['91'], limitations: [] }),
    storageSession: session,
    now: () => 5_000,
    createToken: async () => 'settings-freshness-token'
  };
  const prepared = await prepareCleanupReviewRequest(
    { input: 'example.com', sourceWindowId: 4, sourceIncognito: false },
    dependencies
  );
  granted = true;
  settings = { cleanupMode: 'standard', deleteDownloadedFiles: false, redactReports: true };

  await assert.rejects(
    consumeCleanupReviewRequest(
      {
        approvalToken: 'settings-freshness-token',
        sourceWindowId: 4,
        sourceIncognito: false,
        approval: detailedApproval({
          protectedWebOrigins: true,
          fileConfirmationText: prepared.review.requiredFileConfirmation
        })
      },
      { ...dependencies, now: () => 5_001 }
    ),
    /settings or target scope changed after review/i
  );
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY], undefined);
  assert.equal(granted, false);
  assert.equal(released.length, 4);
});

test('approval rejects both private-access expansion and revocation after review', async () => {
  for (const [reviewedAccess, currentAccess] of [
    [false, true],
    [true, false]
  ]) {
    const session = createSessionStorage();
    let incognitoAccess = reviewedAccess;
    const dependencies = {
      getSettings: async () => ({ cleanupMode: 'standard', redactReports: true }),
      isIncognitoAllowed: async () => incognitoAccess,
      hasHostPermissions: async () => true,
      inspectImpact: async () => ({ matchedCompletedFileIds: [], limitations: [] }),
      storageSession: session,
      now: () => 7_000,
      createToken: async () => `private-scope-${reviewedAccess ? 'on' : 'off'}-token`
    };
    const token = await dependencies.createToken();
    await prepareCleanupReviewRequest(
      { input: 'example.com', sourceWindowId: 8, sourceIncognito: false },
      dependencies
    );
    incognitoAccess = currentAccess;

    await assert.rejects(
      consumeCleanupReviewRequest(
        {
          approvalToken: token,
          sourceWindowId: 8,
          sourceIncognito: false,
          approval: detailedApproval()
        },
        { ...dependencies, now: () => 7_001 }
      ),
      /private-window access changed after review/i
    );
    assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY], undefined);
  }
});

test('private-window preflight refuses to durably lease a private target pattern', async () => {
  const session = createSessionStorage();
  let impactInspected = false;
  await assert.rejects(
    prepareCleanupReviewRequest(
      { input: 'private-fixture.blogspot.com', sourceWindowId: 12, sourceIncognito: true },
      {
        getSettings: async () => ({ cleanupMode: 'standard' }),
        isIncognitoAllowed: async () => true,
        hasHostPermissions: async () => false,
        inspectImpact: async () => {
          impactInspected = true;
          return { matchedCompletedFileIds: [] };
        },
        storageSession: session,
        now: () => 9_000,
        createToken: async () => 'private-durable-lease-token'
      }
    ),
    /requires the exact reviewed target site access to be granted before preflight/i
  );
  assert.equal(impactInspected, false);
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY], undefined);
  assert.equal(session.values['sitewipe.permissionLease.v1'], undefined);
  assert.equal(JSON.stringify(session.values).includes('private-fixture.blogspot.com'), false);
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

test('tampered displayed impact is discarded instead of authorizing a different review', async () => {
  const session = createSessionStorage();
  await prepareCleanupReviewRequest(
    { input: 'alice.blogspot.com', sourceWindowId: 9, sourceIncognito: false },
    {
      getSettings: async () => ({ cleanupMode: 'standard', redactReports: true }),
      isIncognitoAllowed: async () => false,
      hasHostPermissions: async () => true,
      inspectImpact: async () => ({
        matchingTabs: 3,
        matchingPrivateTabs: 0,
        matchingHistoryEntries: 5,
        matchingDownloadRecords: 2,
        matchedCompletedFileIds: [],
        limitations: ['Synthetic count is bounded to the preflight snapshot.']
      }),
      storageSession: session,
      now: () => Date.parse('2026-08-16T12:00:00.000Z'),
      createToken: async () => 'impact-bound-review-token'
    }
  );

  session.values[CLEANUP_REVIEW_STORAGE_KEY].reviewSnapshot.effects.closeTabs.matchingCount = 0;

  await assert.rejects(
    consumeCleanupReviewRequest(
      {
        approvalToken: 'impact-bound-review-token',
        sourceWindowId: 9,
        sourceIncognito: false,
        approval: { approvalMode: 'detailed_review', reviewedScope: true }
      },
      { storageSession: session }
    ),
    /failed integrity validation/i
  );
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY], undefined);
});

test('tampered displayed overlay scope is discarded instead of authorizing a different cross-tab effect', async () => {
  const session = createSessionStorage();
  const dependencies = {
    getSettings: async () => ({
      cleanupMode: 'expert',
      progressOverlay: true,
      progressOverlayCancelButton: true,
      overlayScope: 'all_tabs',
      redactReports: true
    }),
    isIncognitoAllowed: async () => false,
    hasHostPermissions: async () => true,
    inspectImpact: async () => ({ matchedCompletedFileIds: [], limitations: [] }),
    storageSession: session,
    now: () => Date.parse('2026-08-16T12:00:00.000Z'),
    createToken: async () => 'overlay-scope-review-token'
  };
  await prepareCleanupReviewRequest({ input: 'example.com', sourceWindowId: 9, sourceIncognito: false }, dependencies);

  session.values[CLEANUP_REVIEW_STORAGE_KEY].reviewSnapshot.effects.progressOverlay.scope = 'target_tabs';
  session.values[CLEANUP_REVIEW_STORAGE_KEY].reviewSnapshot.effects.progressOverlay.scopeDescription =
    'matching accessible HTTP(S) target tabs only';

  await assert.rejects(
    consumeCleanupReviewRequest(
      {
        approvalToken: 'overlay-scope-review-token',
        sourceWindowId: 9,
        sourceIncognito: false,
        approval: detailedApproval()
      },
      dependencies
    ),
    /failed integrity validation/i
  );
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY], undefined);
});

test('preflight inventories broad access separately, binds it to the review, and never leases it for removal', async () => {
  const session = createSessionStorage();
  const releaseCalls = [];
  const settings = { cleanupMode: 'standard', redactReports: true };
  const dependencies = {
    getSettings: async () => settings,
    isIncognitoAllowed: async () => false,
    hasHostPermissions: async () => true,
    containsHostPermissions: async () => true,
    getAllHostPermissions: async () => ({
      permissions: ['tabs'],
      origins: ['HTTPS://*/*', 'http://*/*', 'https://unrelated.example/*', 'https://*.private-canary.invalid/*']
    }),
    releaseHostPermissions: async (origins) => {
      releaseCalls.push(origins);
      return true;
    },
    inspectImpact: async () => ({ matchedCompletedFileIds: [], limitations: [] }),
    storageSession: session,
    storageLocal: session,
    now: () => 1_000,
    createToken: async () => 'broad-permission-review-token'
  };

  const prepared = await prepareCleanupReviewRequest(
    { input: 'example.com', sourceWindowId: 5, sourceIncognito: false },
    dependencies
  );
  const inventory = prepared.review.hostPermissionInventory;
  assert.equal(prepared.review.hostPermissionsGranted, true);
  assert.deepEqual(inventory.broadGrantedHostPermissionOrigins, ['http://*/*', 'https://*/*']);
  assert.deepEqual(inventory.exactRequiredHostPermissionOrigins, []);
  assert.equal(inventory.requiredCoveredByBroadHostPermissionOrigins.length, 4);
  assert.equal(inventory.allSitesAccessGranted, true);
  assert.equal(JSON.stringify(prepared.review).includes('unrelated.example'), false);
  assert.equal(JSON.stringify(prepared.review).includes('private-canary.invalid'), false);
  assert.equal(JSON.stringify(session.values).includes('unrelated.example'), false);
  assert.equal(JSON.stringify(session.values).includes('private-canary.invalid'), false);
  assert.deepEqual(prepared.review.temporaryHostPermissionOrigins, []);
  assert.equal(session.values[CLEANUP_REVIEW_STORAGE_KEY].permissionLeaseId, null);

  const canceled = await cancelCleanupReviewRequest({ approvalToken: 'broad-permission-review-token' }, dependencies);
  assert.equal(canceled.canceled, true);
  assert.deepEqual(releaseCalls, [], 'broad user-controlled grants must never enter a removal call');
});

test('installed-shaped Expert review with private access and broad host grants survives storage integrity validation', async () => {
  const session = createSessionStorage();
  const settings = {
    cleanupMode: 'expert',
    includeProtectedWebOrigins: true,
    progressOverlay: true,
    progressOverlayCancelButton: true,
    overlayScope: 'target_tabs',
    temporaryDnrShield: true,
    redactReports: true
  };
  const dependencies = {
    getSettings: async () => settings,
    isIncognitoAllowed: async () => true,
    hasHostPermissions: async () => true,
    containsHostPermissions: async () => true,
    getAllHostPermissions: async () => ({
      permissions: ['tabs'],
      origins: ['http://*/*', 'https://*/*']
    }),
    releaseHostPermissions: async () => true,
    inspectImpact: async () => ({
      matchingTabs: 1,
      matchingPrivateTabs: 0,
      matchingHistoryEntries: 0,
      matchingDownloadRecords: 0,
      matchedCompletedFileIds: [],
      limitations: []
    }),
    storageSession: session,
    storageLocal: session,
    now: () => Date.parse('2026-08-20T20:03:45.000Z'),
    createToken: async () => 'installed-shaped-review-token'
  };

  await prepareCleanupReviewRequest(
    { input: 'https://www.reddit.com/', sourceWindowId: 91, sourceIncognito: false },
    dependencies
  );
  const stored = session.values[CLEANUP_REVIEW_STORAGE_KEY];
  assert.ok(normalizeCleanupReviewRecord(stored), 'a freshly prepared review must normalize after storage');

  const consumed = await consumeCleanupReviewRequest(
    {
      approvalToken: 'installed-shaped-review-token',
      sourceWindowId: 91,
      sourceIncognito: false,
      approval: detailedApproval({ protectedWebOrigins: true })
    },
    dependencies
  );
  assert.equal(consumed.target.domain, 'reddit.com');
  assert.equal(consumed.incognitoAccess, true);
  assert.equal(consumed.hostPermissionInventory.broadGrantedHostPermissionOrigins.length, 2);
});

test('tampering with the bound broad-permission inventory invalidates the single-use review', async () => {
  const session = createSessionStorage();
  const dependencies = {
    getSettings: async () => ({ cleanupMode: 'standard', redactReports: true }),
    isIncognitoAllowed: async () => false,
    hasHostPermissions: async () => true,
    containsHostPermissions: async () => true,
    getAllHostPermissions: async () => ({ origins: ['<all_urls>'] }),
    inspectImpact: async () => ({ matchedCompletedFileIds: [], limitations: [] }),
    storageSession: session,
    storageLocal: session,
    now: () => 1_000,
    createToken: async () => 'inventory-tamper-review-token'
  };
  await prepareCleanupReviewRequest({ input: 'example.com', sourceWindowId: 5, sourceIncognito: false }, dependencies);
  session.values[CLEANUP_REVIEW_STORAGE_KEY].hostPermissionInventory.allSitesAccessGranted = false;

  await assert.rejects(
    consumeCleanupReviewRequest(
      {
        approvalToken: 'inventory-tamper-review-token',
        sourceWindowId: 5,
        sourceIncognito: false,
        approval: detailedApproval()
      },
      dependencies
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

  assert.match(
    source,
    /if \(!current \|\| current\.id !== jobId \|\| current\.status !== 'running'\) return true;/,
    'missing or replaced durable job authority must cancel the in-flight cleanup'
  );
  assert.doesNotMatch(
    source.slice(source.indexOf('async function isIncognitoAllowed()'), source.indexOf('async function openSidePanel')),
    /catch\s*\{\s*return false;/s,
    'incognito inspection uncertainty must not become a reviewed false value'
  );
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

test('popup leaves every granted handoff error to worker-owned reconciliation', async () => {
  const source = await readFile(new URL('../../src/popup/popup.js', import.meta.url), 'utf8');
  const handlerStart = source.indexOf('async function runApprovedCleanup()');
  const handlerEnd = source.indexOf('function renderCleanupReview', handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  assert.match(handler, /permissionRequestGranted = granted === true/);
  assert.match(handler, /handedOffPromptIsWorkerOwned/);
  assert.match(handler, /!reviewStillUsable && !handedOffPromptIsWorkerOwned/);
  assert.doesNotMatch(
    handler,
    /releaseTemporaryReviewHostPermissions|cleanupRequestRejectedBeforeJob|chrome\.permissions\.remove/
  );
});

test('popup keeps default review preparation and uses only a pre-armed direct cleanup from submit', async () => {
  const source = await readFile(new URL('../../src/popup/popup.js', import.meta.url), 'utf8');
  const submitStart = source.indexOf('async function onSubmit(event)');
  const submitEnd = source.indexOf('async function runApprovedCleanup()', submitStart);
  const submitHandler = source.slice(submitStart, submitEnd);

  assert.ok(submitStart >= 0 && submitEnd > submitStart);
  assert.match(submitHandler, /sendMessage\(MESSAGE_TYPES\.prepareCleanupReview/);
  assert.match(submitHandler, /renderCleanupReview\(cleanupReview\)/);
  assert.match(submitHandler, /runPreparedDirectCleanup\(\)/);
  assert.doesNotMatch(submitHandler, /MESSAGE_TYPES\.runDeepClean|chrome\.permissions\.request/);
  assert.match(source, /async function prepareDirectCleanup\(input\)/);
  assert.match(source, /return directCleanupEnabled\(\) \? 'Clean now' : 'Review cleanup'/);
  assert.doesNotMatch(source, /approvalMode: 'quick'/);
});

test('direct cleanup setting is present in runtime settings and Expert-mode options', async () => {
  const [constants, storage, optionsHtml, optionsJs] = await Promise.all([
    readFile(new URL('../../src/shared/constants.js', import.meta.url), 'utf8'),
    readFile(new URL('../../src/shared/storage.js', import.meta.url), 'utf8'),
    readFile(new URL('../../src/options/options.html', import.meta.url), 'utf8'),
    readFile(new URL('../../src/options/options.js', import.meta.url), 'utf8')
  ]);
  for (const source of [constants, storage, optionsHtml, optionsJs]) {
    assert.match(source, /skipCleanupReview/);
  }
  assert.match(optionsHtml, /Skip detailed cleanup review completely/);
  assert.match(optionsHtml, /starts the current target directly/i);
  assert.match(optionsJs, /skipCleanupReview: isChecked\('skipCleanupReview'\)/);
});

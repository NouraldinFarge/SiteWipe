import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { initializeReviewedCleanupReport } from '../../src/background/cleanup-authorization.js';
import { STORAGE_KEYS } from '../../src/shared/constants.js';
import {
  CLEANUP_REVIEW_SCHEMA_VERSION,
  CLEANUP_REVIEW_STORAGE_KEY,
  CLEANUP_REVIEW_TTL_MS,
  clearCleanupReviewState,
  consumeCleanupReviewRequest,
  normalizeCleanupReviewRecord,
  prepareCleanupReviewRequest
} from '../../src/background/cleanup-preflight.js';
import { getPermissionLease, reconcilePermissionLease } from '../../src/background/permission-leases.js';

const DIRECT_MODE = 'settings_direct';
const DETAILED_MODE = 'detailed_review';

test('preflight derives direct-cleanup authority only from the current strict opt-in', async () => {
  const detailedHarness = createHarness({ skipCleanupReview: false }, { token: 'a'.repeat(48) });
  const detailed = await detailedHarness.prepare();
  const detailedRecord = detailedHarness.record();

  assert.equal(detailed.review.approvalMode, DETAILED_MODE);
  assert.equal(detailed.review.settingsSnapshot.skipCleanupReview, false);
  assert.equal(detailedRecord.approvalMode, DETAILED_MODE);
  assert.equal(normalizeCleanupReviewRecord(detailedRecord)?.approvalMode, DETAILED_MODE);

  const directHarness = createHarness({ skipCleanupReview: true }, { token: 'b'.repeat(48) });
  const direct = await directHarness.prepare();
  const directRecord = directHarness.record();

  assert.equal(direct.review.approvalMode, DIRECT_MODE);
  assert.equal(direct.review.settingsSnapshot.skipCleanupReview, true);
  assert.equal(directRecord.settings.skipCleanupReview, true);
  assert.equal(directRecord.approvalMode, DIRECT_MODE);
  assert.equal(directRecord.schemaVersion, CLEANUP_REVIEW_SCHEMA_VERSION);
  assert.equal(normalizeCleanupReviewRecord(directRecord)?.approvalMode, DIRECT_MODE);

  const truthyHarness = createHarness({ skipCleanupReview: 'true' }, { token: 'c'.repeat(48) });
  const truthy = await truthyHarness.prepare();
  assert.equal(truthy.review.approvalMode, DETAILED_MODE, 'truthy non-booleans must not opt into direct cleanup');
});

test('forged direct mode fails closed when the prepared or current setting did not authorize it', async () => {
  const forgedHarness = createHarness({ skipCleanupReview: false }, { token: 'd'.repeat(48) });
  await forgedHarness.prepare();

  await assert.rejects(
    forgedHarness.consume(directApproval()),
    /prepared settings-direct authorization mode matches|authorization mode does not match/i
  );
  assert.equal(forgedHarness.record(), undefined, 'a forged attempt must consume the single-use token');

  const revokedHarness = createHarness({ skipCleanupReview: true }, { token: 'e'.repeat(48) });
  await revokedHarness.prepare();
  revokedHarness.settings.skipCleanupReview = false;

  await assert.rejects(
    revokedHarness.consume(directApproval()),
    /settings or target scope changed|direct cleanup is no longer enabled/i
  );
  assert.equal(revokedHarness.record(), undefined, 'revoked authority must not remain replayable');

  const staleSettingsHarness = createHarness(
    { cleanupMode: 'expert', skipCleanupReview: true, deleteDownloadedFiles: false },
    { token: 'e0'.repeat(24) }
  );
  await staleSettingsHarness.prepare();
  staleSettingsHarness.settings.deleteDownloadedFiles = true;
  await assert.rejects(staleSettingsHarness.consume(directApproval()), /settings or target scope changed/i);
  assert.equal(staleSettingsHarness.record(), undefined, 'any changed cleanup effect must stale direct authority');

  const falseClaimHarness = createHarness({ skipCleanupReview: true }, { token: 'a0'.repeat(24) });
  await falseClaimHarness.prepare();
  await assert.rejects(
    falseClaimHarness.consume(directApproval({ reviewedScope: true })),
    /must not claim that per-run acknowledgements occurred/i
  );
  assert.equal(falseClaimHarness.record(), undefined, 'a false acknowledgement claim must consume the token');
});

test('detailed review remains acknowledgement-bound when the direct setting is off', async () => {
  const incompleteHarness = createHarness({ skipCleanupReview: false }, { token: 'f'.repeat(48) });
  await incompleteHarness.prepare();
  await assert.rejects(
    incompleteHarness.consume(detailedApproval({ reviewedScope: false })),
    /review and acknowledge the displayed cleanup scope/i
  );

  const completeHarness = createHarness({ skipCleanupReview: false }, { token: '1'.repeat(48) });
  await completeHarness.prepare();
  const consumed = await completeHarness.consume(detailedApproval());
  assert.equal(consumed.approvalMode, DETAILED_MODE);
});

test('direct mode, its settings snapshot, target, and impact are integrity-bound and single-use', async () => {
  const harness = createHarness(
    { skipCleanupReview: true },
    {
      token: '2'.repeat(48),
      impact: {
        matchingTabs: 2,
        matchingPrivateTabs: 0,
        matchingHistoryEntries: 3,
        matchingDownloadRecords: 1,
        matchedCompletedFileIds: ['17'],
        limitations: []
      }
    }
  );
  await harness.prepare();
  const record = structuredClone(harness.record());

  assert.ok(normalizeCleanupReviewRecord(record));

  const modeTamper = structuredClone(record);
  modeTamper.approvalMode = DETAILED_MODE;
  assert.equal(normalizeCleanupReviewRecord(modeTamper), null);

  const snapshotTamper = structuredClone(record);
  snapshotTamper.reviewSnapshot.approvalMode = DETAILED_MODE;
  assert.equal(normalizeCleanupReviewRecord(snapshotTamper), null);

  const targetTamper = structuredClone(record);
  targetTamper.canonicalInput = 'attacker.example';
  assert.equal(normalizeCleanupReviewRecord(targetTamper), null);

  const impactTamper = structuredClone(record);
  impactTamper.approvedDownloadFileIds = ['999'];
  assert.equal(normalizeCleanupReviewRecord(impactTamper), null);

  const consumed = await harness.consume(directApproval());
  assert.equal(consumed.approvalMode, DIRECT_MODE);
  assert.deepEqual(consumed.approvedDownloadFileIds, ['17']);

  await assert.rejects(harness.consume(directApproval()), /missing, expired, or has already been used/i);
});

test('an expired direct token is consumed without returning cleanup authority', async () => {
  const harness = createHarness({ skipCleanupReview: true }, { token: '3'.repeat(48), now: 10_000 });
  await harness.prepare();
  harness.clock.value = 10_000 + CLEANUP_REVIEW_TTL_MS + 1;

  await assert.rejects(harness.consume(directApproval()), /approval expired/i);
  assert.equal(harness.record(), undefined);
});

test('direct authority fails closed on stale source-window and private-access state', async (t) => {
  await t.test('source window identity changed', async () => {
    const harness = createHarness({ skipCleanupReview: true }, { token: '4'.repeat(48), sourceWindowId: 7 });
    await harness.prepare();
    harness.source.windowId = 8;

    await assert.rejects(harness.consume(directApproval()), /cleanup context changed/i);
    assert.equal(harness.record(), undefined);
  });

  await t.test('source window private state changed', async () => {
    const harness = createHarness({ skipCleanupReview: true }, { token: '5'.repeat(48), sourceIncognito: false });
    await harness.prepare();
    harness.source.incognito = true;

    await assert.rejects(harness.consume(directApproval()), /cleanup context changed/i);
    assert.equal(harness.record(), undefined);
  });

  await t.test('extension private access changed', async () => {
    const harness = createHarness({ skipCleanupReview: true }, { token: '6'.repeat(48), incognitoAccess: false });
    await harness.prepare();
    harness.privateAccess.allowed = true;

    await assert.rejects(harness.consume(directApproval()), /private-window access changed/i);
    assert.equal(harness.record(), undefined);
  });
});

test('private-source direct cleanup preserves the exact-host pregrant policy', async () => {
  let impactInspected = false;
  const missingAccess = createHarness(
    { skipCleanupReview: true },
    {
      token: '7'.repeat(48),
      sourceIncognito: true,
      incognitoAccess: true,
      hostPermissionsGranted: false,
      inspectImpact: async () => {
        impactInspected = true;
        return emptyImpact();
      }
    }
  );

  await assert.rejects(missingAccess.prepare(), /requires the exact reviewed target site access/i);
  assert.equal(impactInspected, false);
  assert.equal(missingAccess.record(), undefined);

  const pregranted = createHarness(
    { skipCleanupReview: true },
    {
      token: '8'.repeat(48),
      sourceIncognito: true,
      incognitoAccess: true,
      hostPermissionsGranted: true
    }
  );
  const prepared = await pregranted.prepare();
  assert.equal(prepared.review.privateWindowScope.sourceIncognito, true);
  assert.equal(prepared.review.hostPermissionsGranted, true);

  const consumed = await pregranted.consume(directApproval());
  assert.equal(consumed.sourceIncognito, true);
  assert.equal(consumed.incognitoAccess, true);
});

test('Expert direct cleanup keeps file deletion preflight-bound and reports that no detailed review occurred', async () => {
  const harness = createHarness(
    {
      cleanupMode: 'expert',
      skipCleanupReview: true,
      deleteDownloadedFiles: true,
      includeProtectedWebOrigins: true
    },
    {
      token: '9'.repeat(48),
      impact: {
        matchingTabs: 1,
        matchingPrivateTabs: 0,
        matchingHistoryEntries: 2,
        matchingDownloadRecords: 2,
        matchedCompletedFileIds: ['41', '42'],
        limitations: []
      }
    }
  );
  const prepared = await harness.prepare();

  assert.equal(prepared.review.approvalMode, DIRECT_MODE);
  assert.equal(prepared.review.requirements.downloadedFiles, true);
  assert.deepEqual(harness.record().approvedDownloadFileIds, ['41', '42']);

  const approval = await harness.consume(directApproval());
  assert.deepEqual(approval.approvedDownloadFileIds, ['41', '42']);

  const { report } = initializeReviewedCleanupReport({
    approval,
    settings: approval.settings,
    repair: { repaired: false, staleJobRecovered: false },
    now: () => harness.clock.value + 1
  });
  const authorizationSection = report.sections.find((section) => section.key === 'cleanupReview');

  assert.equal(report.summary.cleanupMode, 'expert');
  assert.equal(report.summary.cleanupApprovalMode, DIRECT_MODE);
  assert.equal(report.summary.scopeReviewApproved, false);
  assert.equal(report.summary.settingsDirectCleanupAuthorized, true);
  assert.equal(report.summary.scopeReviewCreatedAt, null);
  assert.equal(report.summary.scopeReviewApprovedFileCandidates, 0);
  assert.equal(report.summary.preflightBoundFileCandidates, 2);
  assert.equal(authorizationSection.details.reviewedAt, null);
  assert.ok(authorizationSection.details.directlyAuthorizedAt);
  assert.match(authorizationSection.label, /saved direct authorization/i);
  assert.doesNotMatch(authorizationSection.label, /reviewed and approved/i);
});

test('settings invalidation cannot orphan an exact host grant while a native permission prompt may settle late', async () => {
  const harness = createHarness(
    { skipCleanupReview: true },
    { token: '0'.repeat(48), hostPermissionsGranted: false, now: 20_000 }
  );
  await harness.prepare();
  const record = harness.record();
  assert.ok(record.permissionLeaseId);

  const promptLease = await getPermissionLease(harness.storage);
  assert.equal(promptLease.status, 'prompt_pending');
  assert.ok(Date.parse(promptLease.promptPendingUntil) > harness.clock.value);

  let grantedOrigins = [...record.target.hostPermissionOrigins];
  const removed = [];
  const leaseAdapters = {
    containsHostPermissions: async (origins) => origins.every((origin) => grantedOrigins.includes(origin)),
    getAllHostPermissions: async () => ({ origins: [...grantedOrigins] }),
    releaseHostPermissions: async (origins) => {
      removed.push(...origins);
      grantedOrigins = grantedOrigins.filter((origin) => !origins.includes(origin));
      return true;
    },
    now: () => harness.clock.value
  };

  const invalidated = await clearCleanupReviewState(harness.storage, {
    ...leaseAdapters,
    storageLocal: harness.storage
  });
  assert.equal(invalidated.cleared, true);
  assert.equal(invalidated.hostPermissionCleanup.reason, 'permission_prompt_pending');
  assert.equal(invalidated.hostPermissionCleanup.recordRetained, true);
  assert.deepEqual(removed, [], 'invalidation must not race an unsettled browser permission prompt');
  assert.equal((await getPermissionLease(harness.storage)).status, 'prompt_pending');

  const settled = await reconcilePermissionLease(
    harness.storage,
    {
      ...leaseAdapters,
      forcePromptSettlement: true,
      promptSettlementOnly: true
    },
    record.permissionLeaseId
  );
  assert.equal(settled.released, true);
  assert.deepEqual(new Set(removed), new Set(record.target.hostPermissionOrigins));
  assert.deepEqual(grantedOrigins, []);
  assert.equal(await getPermissionLease(harness.storage), null);
});

test('direct consume rejects a valid-looking lease that no longer matches the preflight authority', async () => {
  const harness = createHarness(
    { skipCleanupReview: true },
    { token: 'f0'.repeat(24), hostPermissionsGranted: false, now: 30_000 }
  );
  await harness.prepare();
  const record = harness.record();
  const corruptedLease = structuredClone(harness.storage.values[STORAGE_KEYS.permissionLease]);
  corruptedLease.requestedOrigins = ['http://example.net/*', 'https://example.net/*'];
  corruptedLease.preexistingOrigins = [];
  corruptedLease.temporaryOrigins = [...corruptedLease.requestedOrigins];
  harness.storage.values[STORAGE_KEYS.permissionLease] = corruptedLease;

  await assert.rejects(harness.consume(directApproval()), /durable target-access lease changed after preflight/i);
  assert.equal(harness.record(), undefined, 'the mismatched authority token must still be consumed');

  const retained = await getPermissionLease(harness.storage);
  assert.equal(retained.id, record.permissionLeaseId);
  assert.deepEqual(retained.requestedOrigins, corruptedLease.requestedOrigins);
  assert.equal(retained.status, 'prompt_pending', 'a mismatched lease must be retained for manual recovery');
});

test('popup one-click routing keeps hidden preflight, activation ordering, invalidation, and duplicate guards fail-closed', async () => {
  const source = await readFile(new URL('../../src/popup/popup.js', import.meta.url), 'utf8');
  const prepareStart = source.indexOf('async function prepareDirectCleanup(input)');
  const prepareEnd = source.indexOf('function directPreparationIsCurrent', prepareStart);
  const preparation = source.slice(prepareStart, prepareEnd);
  const directStart = source.indexOf('async function runPreparedDirectCleanup()');
  const sharedStart = source.indexOf('async function runPreparedCleanup(', directStart);
  const sharedEnd = source.indexOf('function renderCleanupReview', sharedStart);
  const directHandler = source.slice(directStart, sharedStart);
  const sharedHandler = source.slice(sharedStart, sharedEnd);
  const executableSharedHandler = sharedHandler.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const submitStart = source.indexOf('async function onSubmit(event)');
  const submitEnd = source.indexOf('async function runApprovedCleanup()', submitStart);
  const submitHandler = source.slice(submitStart, submitEnd);

  assert.ok(prepareStart >= 0 && prepareEnd > prepareStart);
  assert.match(preparation, /sendMessage\(MESSAGE_TYPES\.prepareCleanupReview/);
  assert.doesNotMatch(preparation, /renderCleanupReview|MESSAGE_TYPES\.runDeepClean/);
  assert.match(preparation, /preparedReview\?\.approvalMode !== 'settings_direct'/);
  assert.match(preparation, /busy \|\|[\s\S]*directPreparationPending \|\|/);
  assert.match(submitHandler, /!directCleanupReview \|\| directPreparedInput !== input \|\| directPreparationPending/);

  assert.match(directHandler, /if \(!directCleanupReview \|\| busy \|\| directPreparationPending\) return;/);
  assert.match(directHandler, /approvalMode: 'settings_direct'/);
  for (const field of ['reviewedScope', 'associatedTargets', 'localOrIpTarget', 'protectedWebOrigins']) {
    assert.match(directHandler, new RegExp(`${field}: false`));
  }
  assert.match(directHandler, /fileConfirmationText: ''/);

  const armDispatchAt = executableSharedHandler.indexOf(
    'approvalHandoffPromise = sendMessage(MESSAGE_TYPES.armCleanupApproval'
  );
  const permissionRequestAt = executableSharedHandler.indexOf(
    'permissionRequest = chrome.permissions.request({ origins })'
  );
  const permissionRequestAwaitAt = executableSharedHandler.indexOf('await permissionRequest');
  const firstAwaitAt = executableSharedHandler.indexOf('await ');
  const runMessageAt = sharedHandler.indexOf('sendMessage(MESSAGE_TYPES.runDeepClean');
  const resumeMessageAt = sharedHandler.indexOf('sendMessage(MESSAGE_TYPES.resumeArmedCleanup');
  const identityCheckAt = sharedHandler.indexOf('(direct ? directCleanupReview : cleanupReview) !== review');
  assert.ok(permissionRequestAt >= 0, 'missing access must use the native permission API');
  assert.ok(armDispatchAt > permissionRequestAt && armDispatchAt < permissionRequestAwaitAt);
  assert.doesNotMatch(
    executableSharedHandler.slice(permissionRequestAt, armDispatchAt),
    /\bawait\b/,
    'the native request and non-awaited worker marker must remain in one activation task'
  );
  assert.equal(firstAwaitAt, permissionRequestAwaitAt, 'the native prompt must be the first awaited grant result');
  assert.ok(identityCheckAt > permissionRequestAt);
  assert.ok(resumeMessageAt > identityCheckAt && runMessageAt > identityCheckAt);
  assert.ok(sharedHandler.indexOf('busy = true') < permissionRequestAt, 'duplicate clicks must lock synchronously');
  assert.match(
    sharedHandler,
    /permissionPromptInFlight = true;[\s\S]*permissionRequest = chrome\.permissions\.request[\s\S]*armCleanupApproval[\s\S]*granted = await permissionRequest/
  );

  const inputHandler = source.slice(
    source.indexOf("qs('#targetInput').addEventListener('input'"),
    source.indexOf("qs('#targetInput').addEventListener('input', debounce", source.indexOf("qs('#targetInput')"))
  );
  assert.match(inputHandler, /discardDirectCleanupPreparation\(\{ settleLease: !permissionPromptInFlight \}\)/);

  const settingsStart = source.indexOf('async function handleStoredSettingsChange(settings)');
  const settingsEnd = source.indexOf('function renderIncognito', settingsStart);
  const settingsHandler = source.slice(settingsStart, settingsEnd);
  assert.match(settingsHandler, /directInvalidatedBySettings = true/);
  assert.match(settingsHandler, /discardDirectCleanupPreparation\(\{ settleLease: !permissionPromptInFlight \}\)/);

  const primaryStart = source.indexOf('function updatePrimaryAction()');
  const primaryEnd = source.indexOf('function directCleanupEnabled', primaryStart);
  const primaryHandler = source.slice(primaryStart, primaryEnd);
  assert.match(
    primaryHandler,
    /directPreparationPending \|\|[\s\S]*!directCleanupReview \|\|[\s\S]*Boolean\(directCleanupReview\.approvalHandoffStatus\) \|\|[\s\S]*!normalized\?\.ok/
  );

  const activeJobStart = source.indexOf('function renderActiveJob(job)');
  const activeJobEnd = source.indexOf('async function hydrateActiveTabTarget', activeJobStart);
  const activeJobHandler = source.slice(activeJobStart, activeJobEnd);
  assert.match(
    activeJobHandler,
    /job\.status === 'running'[\s\S]*directCleanupReview = null;[\s\S]*directPreparedInput = '';[\s\S]*directPreparationGeneration \+= 1;/,
    "another popup starting a job must invalidate this popup's cached direct token without settling the active lease"
  );
  assert.doesNotMatch(activeJobHandler, /cancelCleanupReviewToken|settleCleanupPermissionPrompt/);
});

function createHarness(settingsOverrides = {}, options = {}) {
  const storage = createStorageArea();
  const clock = { value: options.now ?? 1_000 };
  const source = {
    windowId: options.sourceWindowId ?? 7,
    incognito: options.sourceIncognito ?? false
  };
  const privateAccess = { allowed: options.incognitoAccess ?? false };
  const settings = {
    cleanupMode: 'standard',
    skipCleanupReview: false,
    latestReportRetentionMinutes: 30,
    redactReports: true,
    ...settingsOverrides
  };
  const token = options.token || 'a'.repeat(48);
  const hostPermissions = { granted: options.hostPermissionsGranted ?? true };
  const inspectImpact = options.inspectImpact || (async () => structuredClone(options.impact || emptyImpact()));

  const dependencies = {
    getSettings: async () => structuredClone(settings),
    isIncognitoAllowed: async () => privateAccess.allowed,
    inspectSourceWindow: async (windowId) => ({
      sourceWindowId: windowId,
      sourceIncognito: source.incognito
    }),
    hasHostPermissions: async () => hostPermissions.granted,
    inspectImpact,
    storageSession: storage,
    storageLocal: storage,
    preparationContextId: 'direct-cleanup-unit-popup-context',
    promptContextId: 'direct-cleanup-unit-popup-context',
    now: () => clock.value,
    createToken: async () => token
  };

  return {
    storage,
    settings,
    clock,
    source,
    privateAccess,
    hostPermissions,
    record: () => storage.values[CLEANUP_REVIEW_STORAGE_KEY],
    prepare: () =>
      prepareCleanupReviewRequest(
        {
          input: options.input || 'example.com',
          sourceWindowId: options.sourceWindowId ?? 7,
          sourceIncognito: options.sourceIncognito ?? false
        },
        dependencies
      ),
    consume: (approval) =>
      consumeCleanupReviewRequest(
        {
          approvalToken: token,
          approval,
          sourceWindowId: source.windowId,
          sourceIncognito: source.incognito
        },
        dependencies
      )
  };
}

function directApproval(overrides = {}) {
  return {
    approvalMode: DIRECT_MODE,
    // Direct cleanup deliberately records that no detailed scope screen was reviewed.
    reviewedScope: false,
    associatedTargets: false,
    localOrIpTarget: false,
    protectedWebOrigins: false,
    fileConfirmationText: '',
    ...overrides
  };
}

function detailedApproval(overrides = {}) {
  return {
    approvalMode: DETAILED_MODE,
    reviewedScope: true,
    associatedTargets: false,
    localOrIpTarget: false,
    protectedWebOrigins: false,
    fileConfirmationText: '',
    ...overrides
  };
}

function emptyImpact() {
  return {
    matchingTabs: 0,
    matchingPrivateTabs: 0,
    matchingHistoryEntries: 0,
    matchingDownloadRecords: 0,
    matchedCompletedFileIds: [],
    limitations: []
  };
}

function createStorageArea() {
  const values = {};
  const storage = {
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
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    }
  };
  Object.defineProperty(storage, 'durable', { value: storage });
  return storage;
}

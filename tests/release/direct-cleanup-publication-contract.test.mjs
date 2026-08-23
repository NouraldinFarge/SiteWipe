import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Linter } from 'eslint';

import {
  DIRECT_CLEANUP_OWNER_AMENDMENT_FINDING,
  DIRECT_CLEANUP_CONTRACT_FILES,
  findDirectCleanupPublicationContractFindings
} from '../../scripts/direct-cleanup-publication-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const testParser = new Linter({ configType: 'flat' });

test('publication contract accepts the exact owner-amended source-candidate design', async () => {
  const fixture = await currentFixture();
  assert.deepEqual(findDirectCleanupPublicationContractFindings(fixture), []);
});

test('publication contract rejects an incomplete or stale one-versus-two activation owner amendment', async (t) => {
  const cases = [
    ['stale reviewed version', (decision) => (decision.reviewedVersion = '1.11.55')],
    [
      'missing-access path reduced to one activation',
      (decision) => (decision.activationContract.missingNormalWindowAccessSiteWipeActivations = 1)
    ],
    [
      'first activation requests browser access',
      (decision) => (decision.activationContract.firstActivationRequestsBrowserPermission = true)
    ],
    [
      'first activation starts cleanup',
      (decision) => (decision.activationContract.firstActivationStartsCleanup = true)
    ],
    [
      'second activation no longer requests exact preflight-bound missing patterns first',
      (decision) =>
        (decision.activationContract.secondActivationRequestsPreflightBoundExactMissingPatternsFirst = false)
    ],
    [
      'second activation skips grant revalidation',
      (decision) => (decision.activationContract.secondActivationRunsOnlyAfterExactGrantAndFullRevalidation = false)
    ],
    [
      'second activation no longer authenticates prompt invocation',
      (decision) =>
        (decision.activationContract.secondActivationAuthenticatesPromptInvocationWithHandoffCapability = false)
    ],
    [
      'second activation no longer begins with authenticated non-runnable intent',
      (decision) =>
        (decision.activationContract.secondActivationDispatchesAuthenticatedNonRunnableIntentBeforePermissionRequest = false)
    ],
    [
      'second activation no longer starts its pre-request permission inventory synchronously',
      (decision) =>
        (decision.activationContract.secondActivationStartsPreRequestInventorySynchronouslyBeforePermissionRequest = false)
    ],
    [
      'second activation no longer invokes browser request before confirmation',
      (decision) =>
        (decision.activationContract.secondActivationSynchronouslyInvokesPermissionRequestBeforeInvocationConfirmation = false)
    ],
    [
      'confirmation awaits native result before dispatch',
      (decision) =>
        (decision.activationContract.secondActivationDispatchesConfirmationWithoutAwaitingNativeResult = false)
    ],
    [
      'worker does not durably record exact post-begin grant observation',
      (decision) => (decision.activationContract.workerDurablyRecordsExactPostBeginGrantObservation = false)
    ],
    [
      'handoff no longer reports the resolved-true result with its capability',
      (decision) =>
        (decision.activationContract.secondActivationReportsResolvedTrueOutcomeWithHandoffCapability = false)
    ],
    [
      'popup outcome accepts a truthy non-boolean grant result',
      (decision) => (decision.activationContract.grantOutcomeRequiresLiteralBooleanTrue = false)
    ],
    [
      'popup outcome omits pre-request temporary-origin absence',
      (decision) => (decision.activationContract.grantOutcomeRequiresPreRequestTemporaryOriginsAbsent = false)
    ],
    [
      'invalid or covered pre-request inventory may create outcome authority',
      (decision) => (decision.activationContract.invalidMalformedOrCoveredPreRequestInventoryMayRecordOutcome = true)
    ],
    [
      'worker no longer durably records the authenticated resolved-true result',
      (decision) => (decision.activationContract.workerDurablyRecordsAuthenticatedResolvedTrueGrantOutcome = false)
    ],
    [
      'cleanup no longer requires complete exact grant observation',
      (decision) => (decision.activationContract.cleanupRequiresCompleteExactGrantObservation = false)
    ],
    [
      'cleanup no longer requires authenticated resolved-true outcome',
      (decision) => (decision.activationContract.cleanupRequiresAuthenticatedResolvedTrueGrantOutcome = false)
    ],
    [
      'permission removal no longer requires authenticated resolved-true outcome',
      (decision) => (decision.activationContract.permissionRemovalRequiresAuthenticatedResolvedTrueGrantOutcome = false)
    ],
    [
      'permission events may synthesize grant outcome',
      (decision) => (decision.activationContract.permissionEventsMaySynthesizeGrantOutcome = true)
    ],
    [
      'handoff outcome may synthesize grant observation',
      (decision) => (decision.activationContract.handoffOutcomeMaySynthesizeGrantObservation = true)
    ],
    [
      'handoff page loss before grant outcome may revoke access',
      (decision) => (decision.activationContract.handoffPageLossBeforeGrantOutcomePreservesGrant = false)
    ],
    [
      'authenticated resume may discard a live true-only partial proof',
      (decision) => (decision.activationContract.authenticatedResumeDiscardsUnobservedGrantAsExternal = true)
    ],
    [
      'true-only proof no longer remains pending through its live window',
      (decision) => (decision.activationContract.trueOutcomeWithoutGrantEventRemainsPendingThroughLiveWindow = false)
    ],
    [
      'resume retry exhaustion may discard true-only proof',
      (decision) => (decision.activationContract.resumeRetryExhaustionMayDiscardTrueOnlyProof = true)
    ],
    [
      'late exact grant event may not complete retained true-only proof',
      (decision) => (decision.activationContract.lateExactGrantEventMayCompleteTrueOnlyProof = false)
    ],
    [
      'terminal incomplete proof may revoke access',
      (decision) => (decision.activationContract.terminalIncompleteProofPreservesAccess = false)
    ],
    [
      'expired prompt terminal result may be lost across service-worker restart',
      (decision) => (decision.activationContract.expiredPromptTerminalResultSurvivesServiceWorkerRestart = false)
    ],
    [
      'owned review and lease may retire before terminal cancellation is durable',
      (decision) => (decision.activationContract.terminalResultRecordedBeforeOwnedReviewAndLeaseRetirement = false)
    ],
    [
      'permission lease ownership schema is stale',
      (decision) => (decision.activationContract.permissionLeaseSchemaVersion = 2)
    ],
    [
      'reviewed prompt ownership may be recorded without complete handoff proof',
      (decision) => (decision.activationContract.reviewedPromptGrantOwnershipRequiresCompleteHandoffProof = false)
    ],
    [
      'active cleanup may be created without reviewed prompt ownership',
      (decision) => (decision.activationContract.activeCleanupOwnershipRequiresReviewedPromptGrantProof = false)
    ],
    [
      'release pending may drop ownership provenance',
      (decision) => (decision.activationContract.releasePendingRetainsOwnershipProof = false)
    ],
    [
      'startup may remove proofless access',
      (decision) => (decision.activationContract.startupMayRemoveOnlyReviewedOrAdmittedOwnedAccess = false)
    ],
    [
      'legacy proofless lease may revoke access',
      (decision) => (decision.activationContract.legacyProoflessOrRevokedLeasePreservesAccess = false)
    ],
    [
      'intersecting permission removal does not revoke ownership',
      (decision) => (decision.activationContract.intersectingPermissionRemovalRevokesOwnership = false)
    ],
    [
      'permission removal does not invalidate pending review authority',
      (decision) => (decision.activationContract.permissionRemovalInvalidatesPendingReviewAuthority = false)
    ],
    [
      'later manual regrant may reuse revoked ownership proof',
      (decision) => (decision.activationContract.laterManualRegrantMayReuseRevokedOwnership = true)
    ],
    [
      'prompt intent confirmation grace is stale',
      (decision) => (decision.activationContract.promptIntentConfirmationGraceSeconds = 0)
    ],
    [
      'confirmation alarm aliases review expiry',
      (decision) => (decision.activationContract.confirmationAlarmIsSeparateFromReviewExpiry = false)
    ],
    [
      'unconfirmed intent tombstone is runnable',
      (decision) => (decision.activationContract.unconfirmedIntentTombstoneIsNonRunnable = false)
    ],
    [
      'worker may re-drive before durable prompt invocation',
      (decision) => (decision.activationContract.workerPersistsPromptInvocationBeforeRedrive = false)
    ],
    [
      'admission no longer requires prompt invocation',
      (decision) => (decision.activationContract.promptInvocationRequiredForAdmission = false)
    ],
    [
      'resume may synthesize prompt invocation',
      (decision) => (decision.activationContract.resumeMaySynthesizePromptInvocation = true)
    ],
    [
      'uninvoked manual grant may start cleanup',
      (decision) => (decision.activationContract.uninvokedOrManualGrantMayStartCleanup = true)
    ],
    [
      'uninvoked manual grant may be automatically removed',
      (decision) => (decision.activationContract.uninvokedOrManualGrantMayBeAutomaticallyRemoved = true)
    ],
    [
      'replacement handoff may continue the document-bound approval',
      (decision) =>
        (decision.activationContract.directOpenDuplicateReloadNavigationOrReplacementHandoffMayContinue = true)
    ],
    ['raw cleanup route authorized', (decision) => (decision.rawCleanupRouteAuthorized = true)]
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const fixture = await currentFixture();
      mutate(fixture.decision);
      assert.ok(findDirectCleanupPublicationContractFindings(fixture).includes(DIRECT_CLEANUP_OWNER_AMENDMENT_FINDING));
    });
  }
});

test('publication contract rejects a default-on setting or incomplete owner decision', async () => {
  const fixture = await currentFixture();
  fixture.sources['src/shared/constants.js'] = fixture.sources['src/shared/constants.js'].replace(
    'skipCleanupReview: false',
    'skipCleanupReview: true'
  );
  fixture.decision.defaultEnabled = true;
  const findings = findDirectCleanupPublicationContractFindings(fixture);
  assert.ok(findings.some((finding) => finding.includes('default-off')));
  assert.ok(findings.some((finding) => finding.includes('owner decision')));
});

test('publication contract rejects removal of explicit settings confirmation', async () => {
  const fixture = await currentFixture();
  fixture.sources['src/options/options.js'] = fixture.sources['src/options/options.js'].replace(
    'control.checked && !confirmSkipCleanupReview()',
    'false'
  );
  assert.ok(
    findDirectCleanupPublicationContractFindings(fixture).some((finding) =>
      finding.includes('explicit Settings confirmation')
    )
  );
});

test('publication contract rejects an upgrade that preserves direct cleanup without the selected-site disclosure', async () => {
  const fixture = await currentFixture();
  fixture.sources['src/background/service-worker.js'] = fixture.sources['src/background/service-worker.js'].replace(
    'if (needsStoragePartitionDisclosure) {',
    'if (false && needsStoragePartitionDisclosure) {'
  );
  assert.ok(
    findDirectCleanupPublicationContractFindings(fixture).some((finding) =>
      finding.includes('worker-load migration must disable an older direct-cleanup opt-in')
    )
  );

  const installedFixture = await currentFixture();
  installedFixture.sources['src/background/service-worker.js'] = installedFixture.sources[
    'src/background/service-worker.js'
  ].replace('if (!settings.storagePartitionDisclosureAppliedAt) {', 'if (false) {');
  assert.ok(
    findDirectCleanupPublicationContractFindings(installedFixture).some((finding) =>
      finding.includes('install/update migration must disable an older direct-cleanup opt-in')
    )
  );
});

test('publication contract rejects a raw cleanup route that no longer consumes prepared authority first', async () => {
  const fixture = await currentFixture();
  fixture.sources['src/background/service-worker.js'] = fixture.sources['src/background/service-worker.js'].replace(
    'consumeCleanupReviewRequest(payload',
    'consumeRemovedApproval(payload'
  );
  assert.ok(
    findDirectCleanupPublicationContractFindings(fixture).some((finding) =>
      finding.includes('consume prepared authority before runDeepClean')
    )
  );
});

test('publication contract rejects caller-controlled skip and raw cleanup-authority fields', async () => {
  const fixture = await currentFixture();
  const source = fixture.sources['src/shared/message-contracts.js'];
  const runRouteAt = source.indexOf('case MESSAGE_TYPES.runDeepClean:');
  const nextRouteAt = source.indexOf('case MESSAGE_TYPES.validateAssociatedGroups:', runRouteAt);
  const runRoute = source.slice(runRouteAt, nextRouteAt);
  const mutatedRunRoute = runRoute.replace(
    "              'popupPreparationCapability'\n            ]",
    [
      "              'popupPreparationCapability',",
      "              'skipCleanupReview',",
      "              'target',",
      "              'settings',",
      "              'approvedDownloadFileIds'",
      '            ]'
    ].join('\n')
  );
  assert.notEqual(mutatedRunRoute, runRoute, 'the external runDeepClean allowlist fixture must be changed');
  fixture.sources['src/shared/message-contracts.js'] =
    source.slice(0, runRouteAt) + mutatedRunRoute + source.slice(nextRouteAt);

  assert.ok(
    findDirectCleanupPublicationContractFindings(fixture).some((finding) =>
      finding.includes('only prepared approval/context fields plus required worker-minted popup binding credentials')
    )
  );
});

test('publication contract rejects an optional, caller-created, or raw-persisted popup binding', async () => {
  const fixture = await currentFixture();
  const messageContractBefore = fixture.sources['src/shared/message-contracts.js'];
  fixture.sources['src/shared/message-contracts.js'] = messageContractBefore.replace(
    'if (validationOptions.allowInternalArmedCleanup !== true) assertPopupPreparationBinding(payload);',
    'void validationOptions;'
  );
  assert.notEqual(fixture.sources['src/shared/message-contracts.js'], messageContractBefore);

  const preflightBefore = fixture.sources['src/background/cleanup-preflight.js'];
  fixture.sources['src/background/cleanup-preflight.js'] = preflightBefore
    .replace('const bytes = new Uint8Array(32);', 'const bytes = new Uint8Array(16);')
    .replace(
      '    popupPreparationCapabilityDigest,\n    incognitoAccess,',
      '    popupPreparationCapabilityDigest,\n    popupPreparationCapability: dependencies.popupPreparationCapability,\n    incognitoAccess,'
    );
  assert.notEqual(fixture.sources['src/background/cleanup-preflight.js'], preflightBefore);

  const workerBefore = fixture.sources['src/background/service-worker.js'];
  fixture.sources['src/background/service-worker.js'] = workerBefore.replace(
    'requirePopupPreparationCapability: !trustedInternalArmedCleanup',
    'requirePopupPreparationCapability: false'
  );
  assert.notEqual(fixture.sources['src/background/service-worker.js'], workerBefore);

  const stateSchemaBefore = fixture.sources['src/shared/state-schema.js'];
  fixture.sources['src/shared/state-schema.js'] = stateSchemaBefore.replace(
    '    output.popupPreparationCapabilityDigest = value.popupPreparationCapabilityDigest;',
    '    output.popupPreparationCapabilityDigest = value.popupPreparationCapabilityDigest;\n    output.popupPreparationCapability = value.popupPreparationCapability;'
  );
  assert.notEqual(fixture.sources['src/shared/state-schema.js'], stateSchemaBefore);

  const findings = findDirectCleanupPublicationContractFindings(fixture);
  assert.ok(
    findings.some((finding) =>
      finding.includes('only prepared approval/context fields plus required worker-minted popup binding credentials')
    )
  );
  assert.ok(findings.some((finding) => finding.includes('256 bits of randomness')));
  assert.ok(findings.some((finding) => finding.includes('again at atomic approval consumption')));
  assert.ok(findings.some((finding) => finding.includes('raw popup preparation capability must never be persisted')));
});

test('publication contract rejects untruthful direct report evidence', async () => {
  const fixture = await currentFixture();
  fixture.sources['src/background/cleanup-authorization.js'] = fixture.sources[
    'src/background/cleanup-authorization.js'
  ].replace('report.summary.scopeReviewApproved = usedDetailedReview;', 'report.summary.scopeReviewApproved = true;');
  assert.ok(
    findDirectCleanupPublicationContractFindings(fixture).some((finding) =>
      finding.includes('scopeReviewApproved = usedDetailedReview')
    )
  );
});

test('publication contract preserves the private-source and pending installed-evidence limits', async () => {
  const fixture = await currentFixture();
  fixture.decision.incognitoRequirements.privateSourceRequiresPreexistingExactTargetAccess = false;
  fixture.decision.installedBrowserEvidence = 'passed';
  assert.ok(
    findDirectCleanupPublicationContractFindings(fixture).some((finding) =>
      finding.includes('pending installed-evidence state')
    )
  );
});

test('publication contract catches semantic direct-cleanup safety mutations', async (t) => {
  const baseline = await currentFixture();
  const cases = [
    {
      name: 'durable arm dispatch is not awaited',
      path: 'src/popup/popup.js',
      mutate: (source) =>
        source.replace(
          'armed = await sendMessage(MESSAGE_TYPES.armCleanupApproval, {',
          'armed = sendMessage(MESSAGE_TYPES.armCleanupApproval, {'
        ),
      finding: 'await and verify the exact durable first-activation arm acknowledgement'
    },
    {
      name: 'durable arm acknowledgement no longer requires approvalArmed true',
      path: 'src/popup/popup.js',
      mutate: (source) => source.replace('armed?.approvalArmed !== true ||', 'false ||'),
      finding: 'await and verify the exact durable first-activation arm acknowledgement'
    },
    {
      name: 'local armed helper trusts status without the strict boolean marker',
      path: 'src/popup/popup.js',
      mutate: (source) =>
        replaceNamedFunctionBody(
          source,
          'cleanupApprovalHandoffIsArmed',
          "{ return review?.approvalHandoffStatus === 'armed'; }"
        ),
      finding: 'immutable strict-local armed flag'
    },
    {
      name: 'first approval activation falls through after arming',
      path: 'src/popup/popup.js',
      mutate: removeFirstActivationArmReturn,
      finding: 'open the exact persistent handoff after arming'
    },
    {
      name: 'fresh grant activation awaits before permissions.request',
      path: 'src/handoff/handoff.js',
      mutate: insertAwaitBeforePermissionRequest,
      finding: 'activation two must begin without await'
    },
    {
      name: 'second activation omits the synchronous pre-request permission inventory',
      path: 'src/handoff/handoff.js',
      mutate: (source) =>
        source.replace(
          'snapshotPromise = chrome.permissions.getAll();',
          'snapshotPromise = Promise.resolve({ origins: [] });'
        ),
      finding: 'synchronously inventory immediately before requesting access'
    },
    {
      name: 'second activation starts the pre-request permission inventory after requesting access',
      path: 'src/handoff/handoff.js',
      mutate: (source) =>
        source.replace(
          'snapshotPromise = chrome.permissions.getAll();\n    permissionRequest = chrome.permissions.request({ origins: handoff.origins });',
          'permissionRequest = chrome.permissions.request({ origins: handoff.origins });\n    snapshotPromise = chrome.permissions.getAll();'
        ),
      finding: 'synchronously inventory immediately before requesting access'
    },
    {
      name: 'second activation awaits the pre-request permission inventory before requesting access',
      path: 'src/handoff/handoff.js',
      mutate: (source) =>
        source.replace(
          'snapshotPromise = chrome.permissions.getAll();',
          'snapshotPromise = await chrome.permissions.getAll();'
        ),
      finding: 'synchronously inventory immediately before requesting access'
    },
    {
      name: 'pre-request inventory no longer rejects broad target coverage',
      path: 'src/handoff/handoff.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'temporaryHostAccessWasAbsent',
          'inventory.broadGrantedHostPermissionOrigins.length === 0',
          'true'
        ),
      finding: 'synchronously inventory immediately before requesting access'
    },
    {
      name: 'second activation omits its authenticated prompt invocation',
      path: 'src/handoff/handoff.js',
      mutate: (source) =>
        source.replace(
          'sendMessage(MESSAGE_TYPES.beginCleanupPermissionHandoff, authority)',
          'sendMessage(MESSAGE_TYPES.resumeCleanupPermissionHandoff, authority)'
        ),
      finding: 'activation two must begin without await'
    },
    {
      name: 'second activation confirms prompt invocation before browser request acceptance',
      path: 'src/handoff/handoff.js',
      mutate: movePromptInvocationBeforePermissionRequest,
      finding: 'activation two must begin without await'
    },
    {
      name: 'synchronous request-throw path dispatches prompt ownership',
      path: 'src/handoff/handoff.js',
      mutate: movePromptInvocationIntoSynchronousThrowCatch,
      finding: 'activation two must begin without await'
    },
    {
      name: 'persistent handoff tab is created outside the reviewed source window',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'openCleanupPermissionHandoff',
          "chrome.tabs.create({ windowId: reviewedWindowId, url: 'about:blank', active: true })",
          "chrome.tabs.create({ url: 'about:blank', active: true })"
        ),
      finding: 'persistent handoff must be a worker-created normal tab'
    },
    {
      name: 'persistent handoff aliases runtime context identity to optional documentId',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'claimCleanupPermissionHandoff',
          'const contextId = senderBinding.contextId;',
          'const contextId = senderBinding.documentId;'
        ),
      finding: 'persistent handoff must be a worker-created normal tab'
    },
    {
      name: 'persistent handoff requires optional sender documentId',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'inspectExactPermissionHandoffSender',
          'const senderDocumentId = sender?.documentId == null ? null : normalizeRuntimePopupContextId(sender.documentId);',
          'const senderDocumentId = normalizeRuntimePopupContextId(sender.documentId);'
        ),
      finding: 'persistent handoff must be a worker-created normal tab'
    },
    {
      name: 'persistent handoff runtime query permits private contexts',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'inspectExactPermissionHandoffRuntimeContext',
          '        incognito: false',
          '        incognito: true'
        ),
      finding: 'persistent handoff must be a worker-created normal tab'
    },
    {
      name: 'persistent handoff accepts ambiguous runtime contexts',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'inspectExactPermissionHandoffRuntimeContext',
          'contexts.length !== 1',
          'contexts.length < 1'
        ),
      finding: 'persistent handoff must be a worker-created normal tab'
    },
    {
      name: 'persistent handoff requires optional runtime document origin',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'inspectExactPermissionHandoffRuntimeContext',
          "    (context?.documentOrigin != null &&\n      (typeof context.documentOrigin !== 'string' || context.documentOrigin !== extensionOrigin)) ||",
          "    (typeof context.documentOrigin !== 'string' || context.documentOrigin !== extensionOrigin) ||"
        ),
      finding: 'persistent handoff must be a worker-created normal tab'
    },
    {
      name: 'persistent handoff capability digest check is bypassed',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'assertCleanupPermissionHandoffBinding',
          'if (!constantTimeHexEqual(record.capabilityDigest, actualDigest)) {',
          'if (false) {'
        ),
      finding: 'persistent handoff must be a worker-created normal tab'
    },
    {
      name: 'invalid review session marker is removed before durable lease neutralization',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'discardInvalidCleanupReview',
          'const neutralized = await discardInvalidReviewPermissionLease(storageLocal);',
          'await storageSession.remove(CLEANUP_REVIEW_STORAGE_KEY);\n    const neutralized = await discardInvalidReviewPermissionLease(storageLocal);'
        ),
      finding: 'every invalid cleanup review must neutralize non-admitted lease bookkeeping before session removal'
    },
    {
      name: 'invalid review migration retains admitted ownership only while active',
      path: 'src/background/permission-leases.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'discardInvalidReviewPermissionLease',
          "if (lease?.ownershipProof === 'admitted_cleanup') {",
          "if (lease?.status === 'active_cleanup' && lease.ownershipProof === 'admitted_cleanup') {"
        ),
      finding: 'every invalid cleanup review must neutralize non-admitted lease bookkeeping before session removal'
    },
    {
      name: 'invalid review lease removal no longer proves its durable commit',
      path: 'src/background/permission-leases.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'discardInvalidReviewPermissionLease',
          'postRemoval = await storageLocal.get([STORAGE_KEYS.permissionLease]);',
          'postRemoval = {};'
        ),
      finding: 'every invalid cleanup review must neutralize non-admitted lease bookkeeping before session removal'
    },
    {
      name: 'maintenance no longer short-circuits an uncertain invalid-review neutralization',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'runMaintenanceCycle',
          'invalidReviewNeutralizationIsPending(cleanupReviewExpiration)',
          'false'
        ),
      finding: 'every invalid cleanup review must neutralize non-admitted lease bookkeeping before session removal'
    },
    {
      name: 'begin prompt message accepts caller approval authority',
      path: 'src/shared/message-contracts.js',
      mutate: (source) =>
        source.replace(
          "assertKeys(payload, ['handoffNonce', 'handoffCapability']);",
          "assertKeys(payload, ['handoffNonce', 'handoffCapability', 'approval']);"
        ),
      finding: 'every persistent-handoff authority message must require only its exact nonce'
    },
    {
      name: 'second activation does not await durable prompt-marker acknowledgement',
      path: 'src/handoff/handoff.js',
      mutate: (source) => source.replace('    invocationPromise,\n', '    Promise.resolve({ ok: true }),\n'),
      finding: 'activation two must begin without await'
    },
    {
      name: 'second activation omits the authenticated resolved-true grant outcome',
      path: 'src/handoff/handoff.js',
      mutate: (source) =>
        source.replace(
          'sendMessage(MESSAGE_TYPES.confirmCleanupPermissionHandoffGrant, {',
          'sendMessage(MESSAGE_TYPES.resumeCleanupPermissionHandoff, {'
        ),
      finding: 'report literal true only with valid pre-request absence'
    },
    {
      name: 'resolved-true grant outcome acknowledgement is not awaited',
      path: 'src/handoff/handoff.js',
      mutate: (source) => source.replace('const result = await sendMessage(', 'const result = sendMessage('),
      finding: 'report literal true only with valid pre-request absence'
    },
    {
      name: 'resolved-true grant outcome acknowledgement is not verified',
      path: 'src/handoff/handoff.js',
      mutate: (source) => source.replace('renderOutcome(result);', 'void result;'),
      finding: 'report literal true only with valid pre-request absence'
    },
    {
      name: 'grant-outcome takeover message loses the long-running timeout',
      path: 'src/shared/messaging.js',
      mutate: (source) =>
        source.replace('    type === MESSAGE_TYPES.confirmCleanupPermissionHandoffGrant ||\n', '    false ||\n'),
      finding: 'persistent-handoff grant and resume messages must share the long-running cleanup timeout'
    },
    {
      name: 'truthy non-boolean permission result may create popup outcome',
      path: 'src/handoff/handoff.js',
      mutate: (source) => source.replace('if (request.value !== true) {', 'if (!request.value) {'),
      finding: 'report literal true only with valid pre-request absence'
    },
    {
      name: 'invalid or covered pre-request inventory may flow to popup outcome',
      path: 'src/handoff/handoff.js',
      mutate: (source) => source.replace(' || !preRequestTemporaryOriginsAbsent', ''),
      finding: 'report literal true only with valid pre-request absence'
    },
    {
      name: 'popup grant outcome omits the pre-request absence attestation',
      path: 'src/handoff/handoff.js',
      mutate: (source) => source.replace('      preRequestTemporaryOriginsAbsent: true\n', ''),
      finding: 'report literal true only with valid pre-request absence'
    },
    {
      name: 'grant-outcome message accepts a missing pre-request absence attestation',
      path: 'src/shared/message-contracts.js',
      mutate: (source) =>
        source.replace(
          "['handoffNonce', 'handoffCapability', 'preRequestTemporaryOriginsAbsent']",
          "['handoffNonce', 'handoffCapability']"
        ),
      finding: 'every persistent-handoff authority message must require only its exact nonce'
    },
    {
      name: 'grant-outcome message accepts a false pre-request absence attestation',
      path: 'src/shared/message-contracts.js',
      mutate: (source) =>
        source.replace(
          'if (payload.preRequestTemporaryOriginsAbsent !== true) {',
          'if (payload.preRequestTemporaryOriginsAbsent !== false) {'
        ),
      finding: 'every persistent-handoff authority message must require only its exact nonce'
    },
    {
      name: 'prompt intent persistence is not awaited',
      path: 'src/background/cleanup-preflight.js',
      mutate: makeDurablePromptIntentWriteUnawaited,
      finding: 'schema-3 begin and confirm must durably record'
    },
    {
      name: 'prompt invocation persistence is not awaited',
      path: 'src/background/cleanup-preflight.js',
      mutate: makeDurablePromptInvocationWriteUnawaited,
      finding: 'schema-3 begin and confirm must durably record'
    },
    {
      name: 'resolved-true grant outcome persistence is not awaited',
      path: 'src/background/cleanup-preflight.js',
      mutate: makeDurableGrantOutcomeWriteUnawaited,
      finding: 'only the initiating popup may durably record literal true with pre-request temporary-origin absence'
    },
    {
      name: 'worker grant outcome does not require popup-attested pre-request absence',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'recordCleanupPermissionGrantOutcome',
          'payload.preRequestTemporaryOriginsAbsent !== true',
          'false'
        ),
      finding: 'only the initiating popup may durably record literal true with pre-request temporary-origin absence'
    },
    {
      name: 'normalized grant outcome does not require pre-request absence',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'normalizeCleanupApprovalHandoff',
          'value.promptGrantOutcome.preRequestTemporaryOriginsAbsent !== true ||',
          'false ||'
        ),
      finding: 'schema-3 begin and confirm must durably record'
    },
    {
      name: 'named-permission onAdded events may create grant proof',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'recordCleanupPermissionGrantObservation',
          'rawNamedPermissions.length > 0',
          'false'
        ),
      finding: 'only durable exact post-begin permissions.onAdded observations'
    },
    {
      name: 'partial broad or unrelated onAdded origins may create grant proof',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'recordCleanupPermissionGrantObservation',
          'if (!jsonEquivalent(addedOrigins, canonicalizeHostPermissionOrigins(temporaryOrigins)))',
          'if (false && !jsonEquivalent(addedOrigins, canonicalizeHostPermissionOrigins(temporaryOrigins)))'
        ),
      finding: 'only durable exact post-begin permissions.onAdded observations'
    },
    {
      name: 'stored prompt invocation can change popup context',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        replaceNthWithinNamedFunction(
          source,
          'normalizeCleanupApprovalHandoff',
          'popupContextId !== promptContextId ||',
          'false ||',
          2
        ),
      finding: 'schema-3 begin and confirm must durably record'
    },
    {
      name: 'prompt-grant normalization wrongly requires observation after confirmation',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'normalizeCleanupApprovalHandoff',
          'recordedAtMs < promptIntent.recordedAtMs ||\n      (!revokedTombstone',
          'recordedAtMs < (promptInvocation || promptIntent).recordedAtMs ||\n      (!revokedTombstone'
        ),
      finding: 'schema-3 begin and confirm must durably record'
    },
    {
      name: 'armed readiness no longer requires prompt invocation',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        replaceWithinNamedFunction(source, 'getReadyArmedCleanupReview', '    !handoff.promptInvocation ||\n', ''),
      finding: 'readiness and atomic consumption must require'
    },
    {
      name: 'atomic handoff consumption no longer requires prompt invocation',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) => source.replace('        !record.approvalHandoff.promptInvocation ||\n', ''),
      finding: 'readiness and atomic consumption must require'
    },
    {
      name: 'armed readiness no longer requires authenticated resolved-true outcome',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'getReadyArmedCleanupReview',
          '    handoff.promptGrantOutcome?.granted !== true ||\n',
          ''
        ),
      finding: 'readiness and atomic consumption must require'
    },
    {
      name: 'armed readiness no longer requires pre-request absence',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'getReadyArmedCleanupReview',
          '    handoff.promptGrantOutcome.preRequestTemporaryOriginsAbsent !== true\n',
          '    false\n'
        ),
      finding: 'readiness and atomic consumption must require'
    },
    {
      name: 'atomic handoff consumption no longer requires authenticated resolved-true outcome',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        source.replace('        record.approvalHandoff.promptGrantOutcome?.granted !== true ||\n', ''),
      finding: 'readiness and atomic consumption must require'
    },
    {
      name: 'atomic handoff consumption no longer requires pre-request absence',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'consumeCleanupReviewRequest',
          '        record.approvalHandoff.promptGrantOutcome.preRequestTemporaryOriginsAbsent !== true ||\n',
          ''
        ),
      finding: 'readiness and atomic consumption must require'
    },
    {
      name: 'atomic handoff consumption no longer requires exact event proof',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) => source.replace('        record.approvalHandoff.promptGrant?.complete !== true ||\n', ''),
      finding: 'readiness and atomic consumption must require'
    },
    {
      name: 'worker re-drive is launched before durable prompt invocation settles',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        source.replace(
          'const invocation = await serializeCleanupReviewStateMutation(async () =>',
          'const invocation = serializeCleanupReviewStateMutation(async () =>'
        ),
      finding: 'invocation must persist without re-drive'
    },
    {
      name: 'worker re-drive is launched before durable resolved-true outcome settles',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        source.replace(
          'const outcome = await serializeCleanupReviewStateMutation(async () =>',
          'const outcome = serializeCleanupReviewStateMutation(async () =>'
        ),
      finding: 'only authenticated literal-true outcome may re-drive its nonce'
    },
    {
      name: 'permissions.onAdded synthesizes popup grant outcome',
      path: 'src/background/service-worker.js',
      mutate: synthesizeGrantOutcomeFromOnAdded,
      finding: 'persistent resume and permissions.onAdded may not synthesize prompt proof'
    },
    {
      name: 'resume route synthesizes prompt invocation',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        source.replace(
          'case MESSAGE_TYPES.resumeCleanupPermissionHandoff: {',
          'case MESSAGE_TYPES.resumeCleanupPermissionHandoff: {\n      void recordCleanupPermissionPromptInvocation(payload);'
        ),
      finding: 'persistent resume and permissions.onAdded may not synthesize prompt proof'
    },
    {
      name: 'uninvoked lease removal revokes a manual grant',
      path: 'src/background/permission-leases.js',
      mutate: (source) =>
        insertAtNamedFunctionStart(
          source,
          'discardUninvokedPermissionLease',
          'await chrome.permissions.remove({ origins: [] });'
        ),
      finding: 'uninvoked or manual grant must never run cleanup or be removed'
    },
    {
      name: 'ordinary permission release no longer requires authenticated resolved-true outcome',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'releaseTemporaryReviewAccess',
          '      record.approvalHandoff?.promptGrantOutcome?.granted !== true ||\n',
          ''
        ),
      finding: 'uninvoked or manual grant must never run cleanup or be removed'
    },
    {
      name: 'ordinary permission release no longer requires pre-request absence',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'releaseTemporaryReviewAccess',
          '      record.approvalHandoff.promptGrantOutcome.preRequestTemporaryOriginsAbsent !== true\n',
          '      false\n'
        ),
      finding: 'uninvoked or manual grant must never run cleanup or be removed'
    },
    {
      name: 'prompt tombstone removal no longer requires authenticated resolved-true outcome',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'settleOwnedCleanupPromptTombstone',
          '      review.approvalHandoff.promptGrantOutcome?.granted !== true ||\n',
          ''
        ),
      finding: 'only exact terminal handoff settlement or a real browser-session boundary'
    },
    {
      name: 'prompt tombstone removal no longer requires pre-request absence',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'settleOwnedCleanupPromptTombstone',
          '      review.approvalHandoff.promptGrantOutcome?.preRequestTemporaryOriginsAbsent !== true) &&\n',
          '      false) &&\n'
        ),
      finding: 'only exact terminal handoff settlement or a real browser-session boundary'
    },
    {
      name: 'ordinary late-grant reconciliation may discard an unobserved invoked prompt',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'reconcileLateCleanupPermissionGrant',
          'allowUnobservedPromptDiscard: false',
          'allowUnobservedPromptDiscard: true'
        ),
      finding: 'ordinary expiry and late-grant recovery must retain an unobserved invoked prompt'
    },
    {
      name: 'ordinary maintenance may discard an unobserved invoked prompt',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'runMaintenanceCycle',
          'allowUnobservedPromptDiscard: false',
          'allowUnobservedPromptDiscard: true'
        ),
      finding: 'ordinary expiry and late-grant recovery must retain an unobserved invoked prompt'
    },
    {
      name: 'ordinary maintenance no longer requires exact late-grant inventory',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'runMaintenanceCycle',
          'requireExactGrant: true',
          'requireExactGrant: false'
        ),
      finding: 'ordinary expiry and late-grant recovery must retain an unobserved invoked prompt'
    },
    {
      name: 'browser-session boundary no longer owns the sole unobserved discard exception',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'settleCleanupPromptAtBrowserSessionBoundary',
          'allowUnobservedPromptDiscard: true',
          'allowUnobservedPromptDiscard: false'
        ),
      finding: 'only exact terminal handoff settlement or a real browser-session boundary'
    },
    {
      name: 'settled prompt review may retire before exact access reconciliation and terminal replay',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'removeReviewAndReleaseUnlessPromptOwnerArrived',
          'const retireReviewAfterSettledRelease = dependencies.promptSettled === true;',
          'const retireReviewAfterSettledRelease = false;'
        ),
      finding: 'prompt expiry terminal cancellation must be durably recorded'
    },
    {
      name: 'permission lease may retire before the prompt terminal finalizer',
      path: 'src/background/permission-leases.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'reconcilePermissionLease',
          'await dependencies.beforeLeaseRemoval(settlement);',
          'await Promise.resolve(settlement);'
        ),
      finding: 'prompt expiry terminal cancellation must be durably recorded'
    },
    {
      name: 'ordinary prompt settlement omits the nonce-bound durable terminal result',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'settleOwnedCleanupPromptTombstone',
          'terminalHandoffNonce: permissionHandoff?.handoffNonce || null',
          'terminalHandoffNonce: null'
        ),
      finding: 'prompt expiry terminal cancellation must be durably recorded'
    },
    {
      name: 'missing terminal handoff record may be ignored after reconciliation',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'rememberCleanupPermissionHandoffTerminalResult',
          "throw new Error('The canceled target-access handoff has no matching consumed persistent record.');",
          'return false;'
        ),
      finding: 'prompt expiry terminal cancellation must be durably recorded'
    },
    {
      name: 'finite resume retry exhaustion may immediately settle a live true-only proof',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'reconcileLateCleanupPermissionGrant',
          "if (initialHandoff?.status !== 'prompt_tombstone' && !expiredFinalClick) return null;",
          "if (initialHandoff?.status !== 'prompt_tombstone' && !expiredFinalClick && initialHandoff?.promptGrantOutcome?.granted !== true) return null;"
        ),
      finding: 'ordinary expiry and late-grant recovery must retain an unobserved invoked prompt'
    },
    {
      name: 'late exact grant event cannot complete a retained true-only tombstone',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'recordCleanupPermissionGrantObservation',
          "['armed', 'prompt_intent_tombstone', 'prompt_tombstone'].includes(handoff.status)",
          "['armed', 'prompt_intent_tombstone'].includes(handoff.status)"
        ),
      finding: 'only durable exact post-begin permissions.onAdded observations'
    },
    {
      name: 'permission lease ownership schema is downgraded',
      path: 'src/background/permission-leases.js',
      mutate: (source) =>
        source.replace(
          'export const PERMISSION_LEASE_SCHEMA_VERSION = 3;',
          'export const PERMISSION_LEASE_SCHEMA_VERSION = 2;'
        ),
      finding: 'schema-3 ownership provenance must progress'
    },
    {
      name: 'reviewed prompt ownership accepts revoked or unrelated provenance',
      path: 'src/background/permission-leases.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'markPermissionLeasePromptGrantOwned',
          "![null, 'reviewed_prompt_grant'].includes(lease.ownershipProof) ||",
          'false ||'
        ),
      finding: 'schema-3 ownership provenance must progress'
    },
    {
      name: 'active cleanup no longer requires reviewed prompt ownership',
      path: 'src/background/permission-leases.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'markPermissionLeaseActive',
          "lease.ownershipProof !== 'reviewed_prompt_grant' ||",
          'false ||'
        ),
      finding: 'schema-3 ownership provenance must progress'
    },
    {
      name: 'release-pending transition drops durable ownership provenance',
      path: 'src/background/permission-leases.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'retainLease',
          "    status: 'release_pending',\n",
          "    status: 'release_pending',\n    ownershipProof: null,\n"
        ),
      finding: 'schema-3 ownership provenance must progress'
    },
    {
      name: 'reviewed prompt ownership may persist without exact event proof',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'persistCleanupPermissionLeaseOwnership',
          '    handoff.promptGrant?.complete !== true ||\n',
          ''
        ),
      finding: 'reviewed_prompt_grant ownership must be persisted only after'
    },
    {
      name: 'startup permission reconciliation may remove proofless access',
      path: 'src/background/permission-leases.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'reconcilePermissionLease',
          'if (lease.ownershipProof == null) {',
          'if (false && lease.ownershipProof == null) {'
        ),
      finding: 'revoked, proofless, and legacy leases must preserve access'
    },
    {
      name: 'permission ownership revocation ignores intersecting temporary origins',
      path: 'src/background/permission-leases.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'revokePermissionLeaseOwnership',
          'lease.temporaryOrigins.some((origin) => removed.has(origin))',
          'false'
        ),
      finding: 'intersecting onRemoved must serially revoke proof'
    },
    {
      name: 'permissions.onRemoved listener no longer serializes ownership invalidation',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        source.replace(
          'chrome.permissions?.onRemoved?.addListener?.((removedPermissions) => {',
          'chrome.permissions?.onAdded?.addListener?.((removedPermissions) => {'
        ),
      finding: 'intersecting onRemoved must serially revoke proof'
    },
    {
      name: 'permission removal no longer invalidates pending session authority',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'invalidateRemovedCleanupReviewAuthority',
          'const intersects = temporaryOrigins.some((origin) => removedOrigins.includes(origin));',
          'const intersects = false;'
        ),
      finding: 'intersecting onRemoved must serially revoke proof'
    },
    {
      name: 'onRemoved no longer installs poison before serialized invalidation',
      path: 'src/background/service-worker.js',
      mutate: removeOnRemovedPoisonBeforeQueue,
      finding: 'intersecting onRemoved must serially revoke proof'
    },
    {
      name: 'onRemoved no longer reserves external invalidation before serialized recovery',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        source.replace('  reserveExternalCleanupPermissionInvalidation(externalRemovedOrigins);\n', ''),
      finding: 'intersecting onRemoved must serially revoke proof'
    },
    {
      name: 'temporary permission release no longer rereads durable lease authority before native removal',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'releaseTemporaryHostPermissions',
          'const durableLease = await getPermissionLease(options.storageLocal || chrome.storage.local);',
          'const durableLease = null;'
        ),
      finding: 'intersecting onRemoved must serially revoke proof'
    },
    {
      name: 'an unrelated live review can authenticate an ambiguous reviewed prompt grant',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'recoverTemporaryPermissionLease',
          '!leaseMatchesPreservedCleanupReview &&',
          '!preservedCleanupReview &&'
        ),
      finding: 'intersecting onRemoved must serially revoke proof'
    },
    {
      name: 'removed session and local authority are no longer invalidated independently',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'invalidateRemovedCleanupPermissionOwnership',
          'invalidateRemovedPermissionLeaseAuthority(removedOrigins)',
          'Promise.resolve({ settled: true, revoked: false })'
        ),
      finding: 'intersecting onRemoved must serially revoke proof'
    },
    {
      name: 'live handoff binding ignores synchronous permission-removal poison',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'permissionLeaseMatchesLiveCleanupReview',
          '  if (cleanupPermissionRemovalPoisonIntersects(lease.temporaryOrigins || [])) return false;\n',
          ''
        ),
      finding: 'intersecting onRemoved must serially revoke proof'
    },
    {
      name: 'onAdded may reuse a grant after an observed owned-origin removal',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        source.replace(
          '      if (reservation.observedOrigins.has(origin)) reservation.regrantedOrigins.add(origin);',
          '      void reservation;'
        ),
      finding: 'intersecting onRemoved must serially revoke proof'
    },
    {
      name: 'restart preserves stale ownership when an exact temporary origin is absent',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        replaceWithinNamedFunction(
          source,
          'recoverTemporaryPermissionLease',
          'if (missingTemporaryOrigins.length) {',
          'if (false && missingTemporaryOrigins.length) {'
        ),
      finding: 'intersecting onRemoved must serially revoke proof'
    },
    {
      name: 'restart missing-access tombstone loses its stable recovery reason',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        source.replace(
          "const MISSING_OWNED_ACCESS_TOMBSTONE_REASON = 'owned_exact_access_missing_on_recovery';",
          "const MISSING_OWNED_ACCESS_TOMBSTONE_REASON = 'stale';"
        ),
      finding: 'intersecting onRemoved must serially revoke proof'
    },
    {
      name: 'replacement popup treats prompt-pending access as locally resumable',
      path: 'src/popup/popup.js',
      mutate: (source) =>
        replaceNamedFunctionBody(
          source,
          'temporaryHostAccessNeedsRecovery',
          "{ if (!access || access.state === 'none') return false; return access.state !== 'prompt_pending'; }"
        ),
      finding: 'a replacement popup must recovery-lock every durable temporary-access obligation'
    },
    {
      name: 'replacement popup primary action ignores recovery lock',
      path: 'src/popup/popup.js',
      mutate: (source) => source.replace('if (cleanupReview || permissionRecoveryPending) {', 'if (cleanupReview) {'),
      finding: 'a replacement popup must recovery-lock every durable temporary-access obligation'
    },
    {
      name: 'armed acknowledgement races ahead of durable session persistence',
      path: 'src/background/cleanup-preflight.js',
      mutate: makeDurableArmWriteUnawaited,
      finding: 'exact armed acknowledgement must be returned only after durable armed-state persistence'
    },
    {
      name: 'permissive assertKeys helper',
      path: 'src/shared/message-contracts.js',
      mutate: (source) => replaceNamedFunctionBody(source, 'assertKeys', '{ void value; void allowedKeys; }'),
      finding: 'assertKeys must reject every unknown own payload key'
    },
    {
      name: 'no-op exact-popup sender helper',
      path: 'src/background/service-worker.js',
      mutate: (source) => replaceNamedFunctionBody(source, 'assertExactPopupSender', '{ void sender; void action; }'),
      finding: 'assertExactPopupSender must actively reject'
    },
    {
      name: 'Chrome action-popup sentinel guard restored to the incompatible negative-id rejection',
      path: 'src/background/service-worker.js',
      mutate: (source) => source.replace('context?.windowId !== -1 ||', 'context?.windowId < 0 ||'),
      finding: 'runtime.getContexts popup validation must require Chrome action-popup sentinel ids'
    },
    {
      name: 'cleanup preparation falls back to optional sender documentId',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        source.replace(
          'const popupContext = await inspectExactPreparingPopupContext();',
          'const popupContext = { contextId: sender.documentId };'
        ),
      finding: 'cleanup preparation must bind only the worker-resolved popup contextId'
    },
    {
      name: 'popup context query drops the exact POPUP type filter',
      path: 'src/background/service-worker.js',
      mutate: (source) => source.replace("        contextTypes: ['POPUP'],\n", ''),
      finding: 'popup inspection must query exactly one exact-URL POPUP context'
    },
    {
      name: 'popup context query accepts more than one exact match',
      path: 'src/background/service-worker.js',
      mutate: (source) => source.replace('  if (contexts.length !== 1) {', '  if (contexts.length < 1) {'),
      finding: 'popup inspection must query exactly one exact-URL POPUP context'
    },
    {
      name: 'popup context query returns an unvalidated context id',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        source.replace(
          '  return validateRuntimePopupContext(contexts[0]);',
          '  return { contextId: contexts[0].contextId };'
        ),
      finding: 'popup inspection must query exactly one exact-URL POPUP context'
    },
    {
      name: 'popup context liveness skips complete context revalidation',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        source.replace(
          '  validateRuntimePopupContext(contexts[0], { expectedContextId: normalizedContextId });',
          '  void contexts[0];'
        ),
      finding: 'popup-context liveness must query the exact contextId'
    },
    {
      name: 'no-op popup binding helper',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        replaceNamedFunctionBody(
          source,
          'assertCleanupReviewPopupBinding',
          '{ void record; void payload; return true; }'
        ),
      finding: 'assertCleanupReviewPopupBinding must compare exact context'
    },
    {
      name: 'deterministic zero-filled capability',
      path: 'src/background/cleanup-preflight.js',
      mutate: replaceCryptoCapabilityFillWithZeros,
      finding: 'filled by crypto.getRandomValues before encoding'
    },
    {
      name: 'raw worker-minted capability persisted by preflight',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        insertBeforeRawCapabilityReturn(
          source,
          'await storageLocal.set({ leakedPopupCapability: popupPreparationCapability });'
        ),
      finding: 'must not enter extension storage, jobs, reports, debug logs'
    },
    {
      name: 'raw popup capability persisted from popup memory',
      path: 'src/popup/popup.js',
      mutate: (source) =>
        insertAfterPopupBindingSet(
          source,
          'void chrome.storage.local.set({ leakedPopupCapability: popupPreparationCapability });'
        ),
      finding: 'must not enter extension storage, jobs, reports, debug logs'
    },
    {
      name: 'payload-selectable internal continuation through Reflect.get alias',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        addCallerPayloadBypass(
          source,
          "const callerPayload = Reflect.get(message || {}, 'pay' + 'load') || {};",
          "callerPayload.approval?.approvalMode === 'settings_direct' && sender?.id === chrome.runtime.id"
        ),
      finding: 'internal armed cleanup selection must be an exact worker-only conjunction'
    },
    {
      name: 'payload-selectable internal continuation through computed destructuring',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        addCallerPayloadBypass(
          source,
          "const { ['pay' + 'load']: callerPayload = {} } = message || {};",
          "callerPayload.approval?.approvalMode === 'settings_direct' && sender?.id === chrome.runtime.id"
        ),
      finding: 'internal armed cleanup selection must be an exact worker-only conjunction'
    },
    {
      name: 'dead pre-reservation popup check',
      path: 'src/background/service-worker.js',
      mutate: disableExternalPopupGuard,
      finding: 'external popup checks must be live, dominate cleanup reservation'
    },
    {
      name: 'disabled consume recheck with a dead safe marker',
      path: 'src/background/service-worker.js',
      mutate: disableCapabilityConsumeRecheck,
      finding: 'external popup checks must be live, dominate cleanup reservation'
    },
    {
      name: 'raw capability sent to a computed diagnostic sink',
      path: 'src/background/service-worker.js',
      mutate: (source) =>
        insertIntoRunDeepCleanRoute(
          source,
          "console['de' + 'bug']({ leakedPopupCapability: payload['popup' + 'PreparationCapability'] });"
        ),
      finding: 'must not enter extension storage, jobs, reports, debug logs'
    },
    {
      name: 'computed destructured popup capability persisted through an alias',
      path: 'src/popup/popup.js',
      mutate: (source) =>
        insertAfterPopupBindingSet(
          source,
          "const { ['popup' + 'PreparationCapability']: rawAlias } = response;\n  void chrome.storage.local.set({ rawAlias });"
        ),
      finding: 'must not enter extension storage, jobs, reports, debug logs'
    },
    {
      name: 'Reflect.get popup capability persisted through an alias',
      path: 'src/popup/popup.js',
      mutate: (source) =>
        insertAfterPopupBindingSet(
          source,
          "const rawAlias = Reflect.get(response, 'popup' + 'PreparationCapability');\n  void chrome.storage.local.set({ rawAlias });"
        ),
      finding: 'must not enter extension storage, jobs, reports, debug logs'
    },
    {
      name: 'raw capability object container persisted by preflight',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        insertBeforeRawCapabilityReturn(
          source,
          'const leakContainer = { value: popupPreparationCapability };\n  await storageLocal.set(leakContainer);'
        ),
      finding: 'must not enter extension storage, jobs, reports, debug logs'
    },
    {
      name: 'raw capability passed through a bound storage sink alias',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        insertBeforeRawCapabilityReturn(
          source,
          'const persistRaw = storageLocal.set.bind(storageLocal);\n  await persistRaw({ value: popupPreparationCapability });'
        ),
      finding: 'must not enter extension storage, jobs, reports, debug logs'
    },
    {
      name: 'exact sender rejection weakened from OR to AND',
      path: 'src/background/service-worker.js',
      mutate: weakenExactSenderFirstDisjunction,
      finding: 'assertExactPopupSender must actively reject'
    },
    {
      name: 'popup context rejection weakened from OR to AND',
      path: 'src/background/cleanup-preflight.js',
      mutate: weakenPopupBindingContextDisjunction,
      finding: 'assertCleanupReviewPopupBinding must compare exact context'
    },
    {
      name: 'constant-time digest difference reset after comparison loop',
      path: 'src/background/cleanup-preflight.js',
      mutate: resetDigestDifferenceAfterLoop,
      finding: 'assertCleanupReviewPopupBinding must compare exact context'
    },
    {
      name: 'cryptographically filled capability replaced at return',
      path: 'src/background/cleanup-preflight.js',
      mutate: returnDeterministicCapabilityAfterCryptoFill,
      finding: 'filled by crypto.getRandomValues before encoding'
    },
    {
      name: 'runDeepClean message allowlist bypassed by an early return',
      path: 'src/shared/message-contracts.js',
      mutate: insertRunDeepCleanContractEarlyReturn,
      finding: 'runDeepClean must actively enforce its exact external/internal allowlists'
    },
    {
      name: 'assertKeys bypassed by an early return',
      path: 'src/shared/message-contracts.js',
      mutate: (source) => insertAtNamedFunctionStart(source, 'assertKeys', 'if (value.approvalToken) return;'),
      finding: 'assertKeys must reject every unknown own payload key'
    },
    {
      name: 'popup binding bypassed by a forged-capability early success',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        insertAtNamedFunctionStart(
          source,
          'assertCleanupReviewPopupBinding',
          "if (payload.popupPreparationCapability === '0'.repeat(64)) return true;"
        ),
      finding: 'assertCleanupReviewPopupBinding must compare exact context'
    },
    {
      name: 'message envelope disconnects active payload validation',
      path: 'src/shared/message-contracts.js',
      mutate: disableEnvelopePayloadValidation,
      finding: 'runDeepClean must actively enforce its exact external/internal allowlists'
    },
    {
      name: 'trusted internal assignment becomes caller-payload selectable',
      path: 'src/background/service-worker.js',
      mutate: makeTrustedInternalAssignmentPayloadSelectable,
      finding: 'internal armed cleanup selection must be an exact worker-only conjunction'
    },
    {
      name: 'message envelope hardcodes the internal validation exception',
      path: 'src/background/service-worker.js',
      mutate: hardcodeInternalEnvelopeValidation,
      finding: 'internal armed cleanup selection must be an exact worker-only conjunction'
    },
    {
      name: 'atomic consume reverses the required capability condition',
      path: 'src/background/cleanup-preflight.js',
      mutate: reverseConsumeCapabilityGuard,
      finding: 'atomic cleanup consumption must enforce popup binding'
    },
    {
      name: 'capability digest helper returns one constant digest',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        replaceNamedFunctionBody(
          source,
          'digestCleanupPopupPreparationCapability',
          "{ void value; return '0'.repeat(64); }"
        ),
      finding: 'must be validated and reduced only through SHA-256'
    },
    {
      name: 'popup context normalizer collapses all contexts',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        replaceNamedFunctionBody(source, 'normalizePopupContextId', "{ void value; return 'shared-popup-context'; }"),
      finding: 'must preserve the exact opaque nonempty Chrome context ID'
    },
    {
      name: 'capability digest helper returns the raw capability',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        replaceNamedFunctionBody(source, 'digestCleanupPopupPreparationCapability', '{ return String(value); }'),
      finding: 'must be validated and reduced only through SHA-256'
    },
    {
      name: 'runDeepClean skips binding validation after its allowlist',
      path: 'src/shared/message-contracts.js',
      mutate: insertRunDeepCleanPostAllowlistEarlyReturn,
      finding: 'runDeepClean must actively enforce its exact external/internal allowlists'
    },
    {
      name: 'validatePayload bypasses the runDeepClean switch case',
      path: 'src/shared/message-contracts.js',
      mutate: (source) =>
        insertAtNamedFunctionStart(source, 'validatePayload', 'if (type === MESSAGE_TYPES.runDeepClean) return;'),
      finding: 'runDeepClean must actively enforce its exact external/internal allowlists'
    },
    {
      name: 'message validation failure helper becomes a no-op',
      path: 'src/shared/message-contracts.js',
      mutate: (source) => replaceNamedFunctionBody(source, 'fail', '{ void message; }'),
      finding: 'assertKeys must reject every unknown own payload key'
    },
    {
      name: 'raw capability persisted through a one-hop arrow wrapper',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        insertBeforeRawCapabilityReturn(
          source,
          'const persistRaw = (value) => storageLocal.set(value);\n  await persistRaw({ value: popupPreparationCapability });'
        ),
      finding: 'must not enter extension storage, jobs, reports, debug logs'
    },
    {
      name: 'raw capability persisted through a one-hop declared wrapper',
      path: 'src/background/cleanup-preflight.js',
      mutate: (source) =>
        insertBeforeRawCapabilityReturn(
          source,
          'function persistRaw(value) { return storageLocal.set(value); }\n  await persistRaw({ value: popupPreparationCapability });'
        ),
      finding: 'must not enter extension storage, jobs, reports, debug logs'
    }
  ];

  for (const mutation of cases) {
    await t.test(mutation.name, () => {
      const fixture = {
        sources: { ...baseline.sources },
        decision: structuredClone(baseline.decision),
        version: baseline.version
      };
      const before = fixture.sources[mutation.path];
      const after = mutation.mutate(before);
      assert.notEqual(after, before, `${mutation.name} must alter its fixture structurally`);
      fixture.sources[mutation.path] = after;
      const findings = findDirectCleanupPublicationContractFindings(fixture);
      assert.ok(
        findings.some((finding) => finding.includes(mutation.finding)),
        `${mutation.name} must be detected; findings were:\n${findings.join('\n')}`
      );
    });
  }
});

async function currentFixture() {
  const sources = Object.fromEntries(
    await Promise.all(
      DIRECT_CLEANUP_CONTRACT_FILES.map(async (path) => [path, await readFile(resolve(root, path), 'utf8')])
    )
  );
  const decision = JSON.parse(
    await readFile(resolve(root, 'docs/decisions/direct-cleanup-owner-decision.json'), 'utf8')
  );
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  return { sources, decision, version: pkg.version };
}

function parseSource(source) {
  let ast = null;
  const captureAstRule = {
    create() {
      return {
        Program(node) {
          ast = node;
        }
      };
    }
  };
  const messages = testParser.verify(source, {
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { mutation: { rules: { 'capture-ast': captureAstRule } } },
    rules: { 'mutation/capture-ast': 'error' }
  });
  assert.ok(ast && !messages.some((message) => message.fatal), 'mutation fixture must parse');
  return ast;
}

function replaceNamedFunctionBody(source, name, replacement) {
  const functionNode = findNode(
    parseSource(source),
    (node) => node.type === 'FunctionDeclaration' && node.id?.name === name
  );
  assert.ok(functionNode?.body, `${name} fixture function must exist`);
  return replaceRanges(source, [[functionNode.body.start, functionNode.body.end, replacement]]);
}

function replaceWithinNamedFunction(source, name, before, after) {
  const functionNode = findNamedFunction(source, name);
  const functionSource = source.slice(functionNode.start, functionNode.end);
  const mutatedFunction = functionSource.replace(before, after);
  assert.notEqual(mutatedFunction, functionSource, `${name} fixture text must exist`);
  return replaceRanges(source, [[functionNode.start, functionNode.end, mutatedFunction]]);
}

function replaceNthWithinNamedFunction(source, name, before, after, occurrence) {
  const functionNode = findNamedFunction(source, name);
  const functionSource = source.slice(functionNode.start, functionNode.end);
  let matchAt = -1;
  let searchAt = 0;
  for (let index = 0; index < occurrence; index += 1) {
    matchAt = functionSource.indexOf(before, searchAt);
    assert.ok(matchAt >= 0, `${name} fixture occurrence ${occurrence} must exist`);
    searchAt = matchAt + before.length;
  }
  const mutatedFunction = functionSource.slice(0, matchAt) + after + functionSource.slice(matchAt + before.length);
  return replaceRanges(source, [[functionNode.start, functionNode.end, mutatedFunction]]);
}

function removeFirstActivationArmReturn(source) {
  const runFunction = findNamedFunction(source, 'runPreparedCleanup');
  const openCall = findNode(
    runFunction.body,
    (node) =>
      node.type === 'CallExpression' &&
      memberPath(node.callee) === 'sendMessage' &&
      source.slice(node.arguments?.[0]?.start, node.arguments?.[0]?.end) ===
        'MESSAGE_TYPES.openCleanupPermissionHandoff'
  );
  const terminalReturn = findNode(
    runFunction.body,
    (node) => node.type === 'ReturnStatement' && node.start > openCall?.end
  );
  assert.equal(terminalReturn?.type, 'ReturnStatement', 'popup handoff branch must end with a return fixture');
  return replaceRanges(source, [[terminalReturn.start, terminalReturn.end, 'void 0;']]);
}

function insertAwaitBeforePermissionRequest(source) {
  const runFunction = findNamedFunction(source, 'runReviewedPermissionHandoff');
  const permissionStatement = findNode(
    runFunction.body,
    (node) =>
      node.type === 'ExpressionStatement' &&
      node.expression?.type === 'AssignmentExpression' &&
      memberPath(node.expression.left) === 'permissionRequest' &&
      node.expression.right?.type === 'CallExpression' &&
      memberPath(node.expression.right.callee) === 'chrome.permissions.request'
  );
  assert.ok(permissionStatement, 'fresh permission request fixture statement must exist');
  return replaceRanges(source, [
    [permissionStatement.start, permissionStatement.start, 'await Promise.resolve();\n    ']
  ]);
}

function movePromptInvocationBeforePermissionRequest(source) {
  const runFunction = findNamedFunction(source, 'runReviewedPermissionHandoff');
  const promptDeclaration = findNode(
    runFunction.body,
    (node) =>
      node.type === 'VariableDeclaration' &&
      node.declarations.some(
        (declaration) => declaration.id?.type === 'Identifier' && declaration.id.name === 'invocationPromise'
      )
  );
  const permissionTry = findNode(
    runFunction.body,
    (node) =>
      node.type === 'TryStatement' &&
      Boolean(
        findNode(
          node.block,
          (candidate) =>
            candidate.type === 'CallExpression' && memberPath(candidate.callee) === 'chrome.permissions.request'
        )
      )
  );
  assert.ok(promptDeclaration && permissionTry, 'activation-two order fixtures must exist');
  const promptText = source.slice(promptDeclaration.start, promptDeclaration.end);
  return replaceRanges(source, [
    [promptDeclaration.start, promptDeclaration.end, ''],
    [permissionTry.start, permissionTry.start, `${promptText}\n  `]
  ]);
}

function movePromptInvocationIntoSynchronousThrowCatch(source) {
  const runFunction = findNamedFunction(source, 'runReviewedPermissionHandoff');
  const promptDeclaration = findNode(
    runFunction.body,
    (node) =>
      node.type === 'VariableDeclaration' &&
      node.declarations.some(
        (declaration) => declaration.id?.type === 'Identifier' && declaration.id.name === 'invocationPromise'
      )
  );
  const permissionTry = findNode(
    runFunction.body,
    (node) =>
      node.type === 'TryStatement' &&
      Boolean(
        findNode(
          node.block,
          (candidate) =>
            candidate.type === 'CallExpression' && memberPath(candidate.callee) === 'chrome.permissions.request'
        )
      )
  );
  assert.ok(promptDeclaration && permissionTry?.handler?.body, 'synchronous permission catch fixture must exist');
  const promptText = source.slice(promptDeclaration.start, promptDeclaration.end);
  return replaceRanges(source, [
    [promptDeclaration.start, promptDeclaration.end, ''],
    [permissionTry.handler.body.start + 1, permissionTry.handler.body.start + 1, `\n    ${promptText}`]
  ]);
}

function synthesizeGrantOutcomeFromOnAdded(source) {
  const listener = findChromePermissionListener(source, 'onAdded');
  const parameterName = listener.params?.[0]?.type === 'Identifier' ? listener.params[0].name : null;
  assert.ok(parameterName, 'permissions.onAdded listener parameter fixture must exist');
  return replaceRanges(source, [
    [
      listener.body.start + 1,
      listener.body.start + 1,
      `\n  void recordCleanupPermissionGrantOutcome(${parameterName});`
    ]
  ]);
}

function removeOnRemovedPoisonBeforeQueue(source) {
  const listener = findChromePermissionListener(source, 'onRemoved');
  const poisonStatement = findNode(
    listener.body,
    (node) =>
      node.type === 'ExpressionStatement' &&
      node.expression?.type === 'CallExpression' &&
      memberPath(node.expression.callee) === 'rememberRemovedCleanupPermissionOrigins'
  );
  const queueCall = findNode(
    listener.body,
    (node) => node.type === 'CallExpression' && memberPath(node.callee) === 'serializeCleanupReviewStateMutation'
  );
  assert.ok(poisonStatement, 'permissions.onRemoved poison fixture statement must exist');
  assert.ok(queueCall, 'permissions.onRemoved serialized invalidation fixture must exist');
  assert.ok(poisonStatement.end <= queueCall.start, 'permissions.onRemoved poison must precede its queue fixture');
  return replaceRanges(source, [[poisonStatement.start, poisonStatement.end, '']]);
}

function findChromePermissionListener(source, eventName) {
  const registration = findNode(
    parseSource(source),
    (node) =>
      node.type === 'CallExpression' && memberPath(node.callee) === `chrome.permissions.${eventName}.addListener`
  );
  const listener = registration?.arguments?.[0];
  assert.equal(listener?.type, 'ArrowFunctionExpression', `permissions.${eventName} listener fixture must exist`);
  assert.equal(listener.body?.type, 'BlockStatement', `permissions.${eventName} listener block fixture must exist`);
  return listener;
}

function makeDurableArmWriteUnawaited(source) {
  const armFunction = findNamedFunction(source, 'armCleanupReviewApprovalRequest');
  const durableWrite = findNode(
    armFunction.body,
    (node) =>
      node.type === 'AwaitExpression' &&
      node.argument?.type === 'CallExpression' &&
      memberPath(node.argument.callee) === 'storageSession.set' &&
      source.slice(node.argument.arguments?.[0]?.start, node.argument.arguments?.[0]?.end).includes('approvalHandoff')
  );
  assert.ok(durableWrite, 'durable armed-session write fixture must exist');
  return replaceRanges(source, [
    [durableWrite.start, durableWrite.end, source.slice(durableWrite.argument.start, durableWrite.argument.end)]
  ]);
}

function makeDurablePromptIntentWriteUnawaited(source) {
  const recordFunction = findNamedFunction(source, 'recordCleanupPermissionPromptIntent');
  const promptDeclaration = findNode(
    recordFunction.body,
    (node) => node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.id.name === 'promptIntent'
  );
  const durableWrite = findNode(
    recordFunction.body,
    (node) =>
      node.type === 'AwaitExpression' &&
      node.argument?.type === 'CallExpression' &&
      memberPath(node.argument.callee) === 'storageSession.set' &&
      node.start > promptDeclaration.end
  );
  assert.ok(durableWrite, 'durable promptIntent write fixture must exist');
  return replaceRanges(source, [
    [durableWrite.start, durableWrite.end, source.slice(durableWrite.argument.start, durableWrite.argument.end)]
  ]);
}

function makeDurablePromptInvocationWriteUnawaited(source) {
  const recordFunction = findNamedFunction(source, 'recordCleanupPermissionPromptInvocation');
  const promptDeclaration = findNode(
    recordFunction.body,
    (node) =>
      node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.id.name === 'promptInvocation'
  );
  const durableWrite = findNode(
    recordFunction.body,
    (node) =>
      node.type === 'AwaitExpression' &&
      node.argument?.type === 'CallExpression' &&
      memberPath(node.argument.callee) === 'storageSession.set' &&
      node.start > promptDeclaration.end &&
      source.slice(node.argument.arguments?.[0]?.start, node.argument.arguments?.[0]?.end).includes('promptInvocation')
  );
  assert.ok(durableWrite, 'durable promptInvocation write fixture must exist');
  return replaceRanges(source, [
    [durableWrite.start, durableWrite.end, source.slice(durableWrite.argument.start, durableWrite.argument.end)]
  ]);
}

function makeDurableGrantOutcomeWriteUnawaited(source) {
  const recordFunction = findNamedFunction(source, 'recordCleanupPermissionGrantOutcome');
  const promptDeclaration = findNode(
    recordFunction.body,
    (node) =>
      node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.id.name === 'promptGrantOutcome'
  );
  assert.ok(promptDeclaration, 'durable promptGrantOutcome declaration fixture must exist');
  const durableWrite = findNode(
    recordFunction.body,
    (node) =>
      node.type === 'AwaitExpression' &&
      node.argument?.type === 'CallExpression' &&
      memberPath(node.argument.callee) === 'storageSession.set' &&
      node.start > promptDeclaration.end
  );
  assert.ok(durableWrite, 'durable promptGrantOutcome write fixture must exist');
  return replaceRanges(source, [
    [durableWrite.start, durableWrite.end, source.slice(durableWrite.argument.start, durableWrite.argument.end)]
  ]);
}

function replaceCryptoCapabilityFillWithZeros(source) {
  const functionNode = findNamedFunction(source, 'randomPopupPreparationCapability');
  const call = findNode(
    functionNode,
    (node) => node.type === 'CallExpression' && memberPath(node.callee) === 'globalThis.crypto.getRandomValues'
  );
  assert.ok(call, 'capability crypto-fill fixture call must exist');
  return replaceRanges(source, [[call.start, call.end, 'bytes.fill(0)']]);
}

function insertBeforeRawCapabilityReturn(source, statement) {
  const functionNode = findNamedFunction(source, 'prepareCleanupReviewRequest');
  const returnNode = findNode(
    functionNode.body,
    (node) =>
      node.type === 'ReturnStatement' &&
      node.argument?.type === 'ObjectExpression' &&
      node.argument.properties.some(
        (property) => property.type === 'Property' && propertyName(property.key) === 'popupPreparationCapability'
      )
  );
  assert.ok(returnNode, 'prepare response carrying the transient raw capability must exist');
  return replaceRanges(source, [[returnNode.start, returnNode.start, `${statement}\n  `]]);
}

function insertAfterPopupBindingSet(source, statement) {
  const ast = parseSource(source);
  const expressionStatement = findNode(
    ast,
    (node) =>
      node.type === 'ExpressionStatement' &&
      node.expression?.type === 'CallExpression' &&
      memberPath(node.expression.callee) === 'popupPreparationBindings.set'
  );
  assert.ok(expressionStatement, 'popup in-memory binding fixture call must exist');
  return replaceRanges(source, [[expressionStatement.end, expressionStatement.end, `\n  ${statement}`]]);
}

function addCallerPayloadBypass(source, declaration, bypassExpression) {
  const functionNode = findNamedFunction(source, 'isTrustedInternalArmedCleanup');
  const returnNode = functionNode.body.body.find((statement) => statement.type === 'ReturnStatement');
  const booleanCall = returnNode?.argument;
  assert.equal(booleanCall?.type, 'CallExpression');
  assert.equal(memberPath(booleanCall.callee), 'Boolean');
  const originalAuthority = source.slice(booleanCall.arguments[0].start, booleanCall.arguments[0].end);
  return replaceRanges(source, [
    [returnNode.start, returnNode.start, `${declaration}\n  `],
    [booleanCall.arguments[0].start, booleanCall.arguments[0].end, `(${originalAuthority}) || (${bypassExpression})`]
  ]);
}

function disableExternalPopupGuard(source) {
  const runCase = findRunDeepCleanCase(source);
  const guard = findNode(
    runCase,
    (node) =>
      node.type === 'IfStatement' &&
      node.test?.type === 'UnaryExpression' &&
      node.test.operator === '!' &&
      node.test.argument?.name === 'trustedInternalArmedCleanup'
  );
  assert.ok(guard, 'external popup guard fixture must exist');
  const original = source.slice(guard.test.start, guard.test.end);
  return replaceRanges(source, [[guard.test.start, guard.test.end, `false && (${original})`]]);
}

function disableCapabilityConsumeRecheck(source) {
  const runCase = findRunDeepCleanCase(source);
  const consumeCall = findNode(
    runCase,
    (node) => node.type === 'CallExpression' && memberPath(node.callee) === 'consumeCleanupReviewRequest'
  );
  const options = consumeCall?.arguments?.[1];
  const property = options?.properties?.find(
    (candidate) => candidate.type === 'Property' && propertyName(candidate.key) === 'requirePopupPreparationCapability'
  );
  assert.ok(property, 'atomic capability recheck fixture property must exist');
  const originalValue = source.slice(property.value.start, property.value.end);
  const replacement = [
    'requirePopupPreparationCapability: false,',
    `...(false ? { requirePopupPreparationCapability: ${originalValue} } : {})`
  ].join(' ');
  return replaceRanges(source, [[property.start, property.end, replacement]]);
}

function insertIntoRunDeepCleanRoute(source, statement) {
  const runCase = findRunDeepCleanCase(source);
  const block = runCase.consequent.find((node) => node.type === 'BlockStatement');
  assert.ok(block, 'runDeepClean route block fixture must exist');
  return replaceRanges(source, [[block.start + 1, block.start + 1, `\n      ${statement}`]]);
}

function weakenExactSenderFirstDisjunction(source) {
  const functionNode = findNamedFunction(source, 'assertExactPopupSender');
  const guard = findNode(
    functionNode.body,
    (node) => node.type === 'IfStatement' && source.slice(node.test.start, node.test.end).includes('sender?.id')
  );
  assert.ok(guard, 'exact-popup sender rejection guard must exist');
  const operatorAt = source.indexOf('||', guard.test.start);
  assert.ok(operatorAt >= guard.test.start && operatorAt < guard.test.end, 'sender rejection disjunction must exist');
  return replaceRanges(source, [[operatorAt, operatorAt + 2, '&&']]);
}

function weakenPopupBindingContextDisjunction(source) {
  const functionNode = findNamedFunction(source, 'assertCleanupReviewPopupBinding');
  const guard = findNode(
    functionNode.body,
    (node) =>
      node.type === 'IfStatement' &&
      source.slice(node.test.start, node.test.end).includes('popupContextId !== record.preparationContextId')
  );
  const finalDisjunction = findNode(
    guard?.test,
    (node) =>
      node.type === 'LogicalExpression' &&
      node.operator === '||' &&
      node.right?.type === 'UnaryExpression' &&
      node.right.operator === '!' &&
      node.right.argument?.name === 'expectedDigest'
  );
  assert.ok(finalDisjunction, 'popup binding context disjunction must exist');
  const between = source.slice(finalDisjunction.left.end, finalDisjunction.right.start);
  assert.match(between, /\|\|/);
  return replaceRanges(source, [
    [finalDisjunction.left.end, finalDisjunction.right.start, between.replace('||', '&&')]
  ]);
}

function resetDigestDifferenceAfterLoop(source) {
  const functionNode = findNamedFunction(source, 'assertCleanupReviewPopupBinding');
  const loop = findNode(functionNode.body, (node) => node.type === 'ForStatement');
  assert.ok(loop, 'constant-time digest loop must exist');
  return replaceRanges(source, [[loop.end, loop.end, '\n  difference = 0;']]);
}

function returnDeterministicCapabilityAfterCryptoFill(source) {
  const functionNode = findNamedFunction(source, 'randomPopupPreparationCapability');
  const returnNode = findNode(functionNode.body, (node) => node.type === 'ReturnStatement');
  assert.ok(returnNode?.argument, 'capability encoding return must exist');
  const original = source.slice(returnNode.argument.start, returnNode.argument.end);
  return replaceRanges(source, [
    [returnNode.argument.start, returnNode.argument.end, `bytes.length === -1 ? (${original}) : '0'.repeat(64)`]
  ]);
}

function insertRunDeepCleanContractEarlyReturn(source) {
  const runCase = findRunDeepCleanCase(source);
  const firstStatement = runCase.consequent[0];
  assert.ok(firstStatement, 'runDeepClean message contract must contain validation statements');
  return replaceRanges(source, [
    [firstStatement.start, firstStatement.start, 'if (payload.approvalToken) return;\n      ']
  ]);
}

function insertRunDeepCleanPostAllowlistEarlyReturn(source) {
  const runCase = findRunDeepCleanCase(source);
  const assertKeysStatement = runCase.consequent[0];
  assert.ok(assertKeysStatement, 'runDeepClean allowlist statement must exist');
  return replaceRanges(source, [
    [assertKeysStatement.end, assertKeysStatement.end, '\n      if (payload.approvalToken) return;']
  ]);
}

function disableEnvelopePayloadValidation(source) {
  const functionNode = findNamedFunction(source, 'validateMessageEnvelope');
  const validationStatement = functionNode.body.body.find(
    (statement) =>
      statement.type === 'ExpressionStatement' &&
      statement.expression?.type === 'CallExpression' &&
      memberPath(statement.expression.callee) === 'validatePayload'
  );
  assert.ok(validationStatement, 'active envelope payload validation call must exist');
  return replaceRanges(source, [[validationStatement.start, validationStatement.end, 'void validationOptions;']]);
}

function makeTrustedInternalAssignmentPayloadSelectable(source) {
  const functionNode = findNamedFunction(source, 'handleMessage');
  const declaration = findNode(
    functionNode.body,
    (node) => node.type === 'VariableDeclarator' && node.id?.name === 'trustedInternalArmedCleanup'
  );
  assert.ok(declaration?.init, 'trusted internal cleanup assignment must exist');
  const original = source.slice(declaration.init.start, declaration.init.end);
  return replaceRanges(source, [
    [
      declaration.init.start,
      declaration.init.end,
      `${original} || message?.payload?.approval?.approvalMode === 'settings_direct'`
    ]
  ]);
}

function hardcodeInternalEnvelopeValidation(source) {
  const functionNode = findNamedFunction(source, 'handleMessage');
  const envelope = findNode(
    functionNode.body,
    (node) => node.type === 'VariableDeclarator' && node.id?.name === 'envelope'
  );
  const options = envelope?.init?.arguments?.[3];
  const property = options?.properties?.find(
    (candidate) => candidate.type === 'Property' && propertyName(candidate.key) === 'allowInternalArmedCleanup'
  );
  assert.ok(property?.value, 'envelope internal-validation option must exist');
  return replaceRanges(source, [[property.value.start, property.value.end, 'true']]);
}

function reverseConsumeCapabilityGuard(source) {
  const functionNode = findNamedFunction(source, 'consumeCleanupReviewRequest');
  const guard = findNode(
    functionNode.body,
    (node) =>
      node.type === 'IfStatement' &&
      node.test?.type === 'BinaryExpression' &&
      memberPath(node.test.left) === 'dependencies.requirePopupPreparationCapability'
  );
  assert.equal(guard?.test?.right?.value, true, 'atomic consume capability guard must require true');
  return replaceRanges(source, [[guard.test.right.start, guard.test.right.end, 'false']]);
}

function insertAtNamedFunctionStart(source, name, statement) {
  const functionNode = findNamedFunction(source, name);
  return replaceRanges(source, [[functionNode.body.start + 1, functionNode.body.start + 1, `\n  ${statement}`]]);
}

function findNamedFunction(source, name) {
  const functionNode = findNode(
    parseSource(source),
    (node) => node.type === 'FunctionDeclaration' && node.id?.name === name
  );
  assert.ok(functionNode, `${name} fixture function must exist`);
  return functionNode;
}

function findRunDeepCleanCase(source) {
  const runCase = findNode(
    parseSource(source),
    (node) => node.type === 'SwitchCase' && memberPath(node.test) === 'MESSAGE_TYPES.runDeepClean'
  );
  assert.ok(runCase, 'runDeepClean route fixture must exist');
  return runCase;
}

function replaceRanges(source, replacements) {
  let result = source;
  for (const [start, end, value] of [...replacements].sort((left, right) => right[0] - left[0])) {
    result = result.slice(0, start) + value + result.slice(end);
  }
  return result;
}

function findNode(node, predicate) {
  if (!node || typeof node !== 'object') return null;
  if (typeof node.type === 'string' && predicate(node)) return node;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'range' || key === 'parent' || key === 'comments' || key === 'tokens') continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        const found = findNode(child, predicate);
        if (found) return found;
      }
    } else {
      const found = findNode(value, predicate);
      if (found) return found;
    }
  }
  return null;
}

function memberPath(node) {
  if (!node) return '';
  if (node.type === 'ChainExpression') return memberPath(node.expression);
  if (node.type === 'Identifier') return node.name;
  if (node.type !== 'MemberExpression') return '';
  const object = memberPath(node.object);
  const property = propertyName(node.property);
  return object && property ? `${object}.${property}` : '';
}

function propertyName(node) {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'Literal') return String(node.value);
  return '';
}

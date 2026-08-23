import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLEANUP_APPROVAL_HANDOFF_SCHEMA_VERSION,
  CLEANUP_REVIEW_STORAGE_KEY,
  clearExpiredCleanupReview,
  recordCleanupPermissionGrantOutcome
} from '../../src/background/cleanup-preflight.js';
import { DEFAULT_SETTINGS, MESSAGE_TYPES, STORAGE_KEYS } from '../../src/shared/constants.js';
import { createChromeMock, createEvent, dispatchRuntimeMessage } from '../helpers/chrome-mock.mjs';

const PERMISSION_HANDOFF_STORAGE_KEY = 'sitewipe.cleanupPermissionHandoff.v1';

test('persistent exact-context handoff survives action-popup teardown and starts exactly one Standard cleanup', async () => {
  const fixture = await createHandoffFixture();
  const { chrome } = fixture;
  try {
    const { prepared, claimed, sender } = await fixture.openAndClaim({
      omitDocumentIds: true,
      omitContextOrigin: true
    });
    const authority = handoffAuthority(prepared, claimed);
    const persistedClaim = chrome.__state.session[PERMISSION_HANDOFF_STORAGE_KEY];

    assert.equal(persistedClaim.status, 'claimed');
    assert.equal(persistedClaim.contextId, 'persistent-handoff-context');
    assert.equal(persistedClaim.documentId, null);
    assert.match(persistedClaim.capabilityDigest, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(chrome.__state.session).includes(claimed.handoffCapability), false);
    assert.equal(
      chrome.__state.runtimeContexts.some((context) => context.contextType === 'POPUP'),
      false,
      'the action popup must be gone before the permission handoff continues'
    );

    const intent = await fixture.dispatch(MESSAGE_TYPES.beginCleanupPermissionHandoff, authority, sender);
    assert.equal(intent.ok, true, intent.error);
    assert.equal(intent.promptIntentRecorded, true);

    const preRequestSnapshot = await chrome.permissions.getAll();
    assert.deepEqual(preRequestSnapshot.origins, []);
    const granted = await chrome.permissions.request({ origins: claimed.temporaryHostPermissionOrigins });
    assert.equal(granted, true);

    const invocation = await fixture.dispatch(
      MESSAGE_TYPES.confirmCleanupPermissionHandoffInvocation,
      authority,
      sender
    );
    assert.equal(invocation.ok, true, invocation.error);
    assert.equal(invocation.promptInvocationRecorded, true);
    await waitFor(
      () => chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY]?.approvalHandoff?.promptGrant?.complete === true,
      2_000
    );

    const completed = await fixture.dispatch(
      MESSAGE_TYPES.confirmCleanupPermissionHandoffGrant,
      { ...authority, preRequestTemporaryOriginsAbsent: true },
      sender
    );
    assert.equal(completed.ok, true, completed.error);
    assert.ok(completed.report || completed.cleanupStarted || completed.resumedCompletedResult);
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob]?.status, 'completed');
    assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
    assert.equal(chrome.__state.session[PERMISSION_HANDOFF_STORAGE_KEY]?.status, 'used');
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
    assert.deepEqual(chrome.__state.originPermissions, new Set());

    const cleanupJobIds = new Set(
      chrome.__calls
        .filter((call) => call.api === 'storage.local.set')
        .map((call) => call.args[0]?.[STORAGE_KEYS.activeJob]?.id)
        .filter(Boolean)
    );
    assert.equal(cleanupJobIds.size, 1, 'only one cleanup job may be reserved');
    assert.ok(chrome.__calls.some((call) => call.api === 'browsingData.remove'));
    assert.equal(
      chrome.__calls.some((call) => call.api === 'downloads.removeFile'),
      false
    );
    assert.ok(
      chrome.__calls.some(
        (call) =>
          call.api === 'permissions.remove' &&
          call.args[0]?.origins?.length === claimed.temporaryHostPermissionOrigins.length &&
          claimed.temporaryHostPermissionOrigins.every((origin) => call.args[0].origins.includes(origin))
      ),
      'the exact temporary access must be released'
    );

    const resumed = await fixture.dispatch(MESSAGE_TYPES.resumeCleanupPermissionHandoff, authority, sender);
    assert.equal(resumed.ok, true, resumed.error);
    assert.equal(resumed.resumedTerminalResult, true);
    assert.equal(resumed.report.id, chrome.__state.local[STORAGE_KEYS.activeJob].id);

    const mutationCount = cleanupMutationCount(chrome);
    const replay = await fixture.dispatch(
      MESSAGE_TYPES.confirmCleanupPermissionHandoffGrant,
      { ...authority, preRequestTemporaryOriginsAbsent: true },
      sender
    );
    assert.equal(replay.ok, false);
    assert.equal(cleanupMutationCount(chrome), mutationCount, 'capability replay must not start another cleanup');

    const retiredPopupRoute = await fixture.dispatch(
      MESSAGE_TYPES.confirmCleanupPermissionGrantOutcome,
      {
        handoffNonce: prepared.review.approvalHandoffNonce,
        preRequestTemporaryOriginsAbsent: true,
        popupContextId: prepared.popupContextId,
        popupPreparationCapability: prepared.popupPreparationCapability
      },
      fixture.popupSender
    );
    assert.equal(retiredPopupRoute.ok, false);
    assert.match(retiredPopupRoute.error, /popup target-access continuation is retired/i);
    fixture.closeTab(chrome.__state.session[PERMISSION_HANDOFF_STORAGE_KEY].tabId);
    await waitFor(() => chrome.__state.session[PERMISSION_HANDOFF_STORAGE_KEY] === undefined);
  } finally {
    fixture.dispose();
  }
});

test('an invoked native prompt that outlives review expiry retains ownership and reconciles a later grant without cleanup', async () => {
  const fixture = await createHandoffFixture();
  const { chrome } = fixture;
  const originalDateNow = Date.now;
  try {
    const { prepared, claimed, sender } = await fixture.openAndClaim({ omitDocumentIds: true });
    const authority = handoffAuthority(prepared, claimed);
    const intent = await fixture.dispatch(MESSAGE_TYPES.beginCleanupPermissionHandoff, authority, sender);
    assert.equal(intent.ok, true, intent.error);
    assert.deepEqual((await chrome.permissions.getAll()).origins, []);
    const invocation = await fixture.dispatch(
      MESSAGE_TYPES.confirmCleanupPermissionHandoffInvocation,
      authority,
      sender
    );
    assert.equal(invocation.ok, true, invocation.error);

    const liveReview = chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY];
    assert.ok(liveReview.approvalHandoff.promptInvocation);
    assert.equal(liveReview.approvalHandoff.promptGrant, null);
    assert.equal(liveReview.approvalHandoff.promptGrantOutcome, null);
    const expiredNow = liveReview.expiresAtMs + 1;
    Date.now = () => expiredNow;

    await chrome.__events.alarm.emitAsync({ name: 'sitewipe.reviewExpiry' });
    await waitFor(
      () => chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY]?.approvalHandoff?.status === 'prompt_tombstone',
      2_000
    );
    const expiredReview = chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY];
    assert.equal(
      expiredReview.approvalHandoff.promptInvocation.popupContextId,
      expiredReview.approvalHandoff.promptContextId
    );
    assert.equal(expiredReview.approvalHandoff.promptGrant, null);
    assert.equal(expiredReview.approvalHandoff.promptGrantOutcome, null);
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease]?.status, 'prompt_pending');
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease]?.ownershipProof, null);
    assert.deepEqual(chrome.__state.originPermissions, new Set());
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeReport], undefined);
    assert.equal(cleanupMutationCount(chrome), 0);

    // The real browser observation remained at this expired, unresolved
    // prompt for several minutes. Let the expiry maintenance generation and
    // its wake-only readiness signal finish before the late native outcome.
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    assert.equal(await chrome.permissions.request({ origins: claimed.temporaryHostPermissionOrigins }), true);
    await waitFor(
      () => chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY]?.approvalHandoff?.promptGrant?.complete === true,
      2_000
    );

    // Chrome's exact onAdded event alone does not prove that an unresolved
    // native prompt is safe to forget while the handoff document is about to
    // record its independent literal-true outcome.
    const eventOnlyTombstone = chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY];
    assert.equal(eventOnlyTombstone.approvalHandoff.status, 'prompt_tombstone');
    assert.equal(eventOnlyTombstone.approvalHandoff.promptGrant.complete, true);
    assert.equal(eventOnlyTombstone.approvalHandoff.promptGrantOutcome, null);
    assert.deepEqual(chrome.__state.originPermissions, new Set(claimed.temporaryHostPermissionOrigins));

    const outcome = await fixture.dispatch(
      MESSAGE_TYPES.confirmCleanupPermissionHandoffGrant,
      { ...authority, preRequestTemporaryOriginsAbsent: true },
      sender
    );
    assert.equal(outcome.ok, true, outcome.error);
    assert.equal(outcome.promptGrantOutcomeRecorded, true);
    assert.equal(outcome.approvalHandoffCanceled, true);
    assert.equal(outcome.cleanupStarted, false);
    assert.equal(outcome.temporaryAccessReleased, true);
    await waitFor(() => chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY] === undefined, 2_000);
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
    assert.deepEqual(chrome.__state.originPermissions, new Set());
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeReport], undefined);
    assert.equal(cleanupJobReservationCount(chrome), 0);
    assert.equal(cleanupMutationCount(chrome), 0);
    assert.equal(
      chrome.__calls.some((call) => call.api === 'downloads.removeFile'),
      false
    );
    assert.ok(
      chrome.__calls.some(
        (call) =>
          call.api === 'permissions.remove' &&
          call.args[0]?.origins?.length === claimed.temporaryHostPermissionOrigins.length &&
          claimed.temporaryHostPermissionOrigins.every((origin) => call.args[0].origins.includes(origin))
      ),
      'only the exact late-granted temporary patterns must be reconciled'
    );
    const terminalResult = chrome.__state.session[PERMISSION_HANDOFF_STORAGE_KEY]?.terminalResult;
    assert.equal(terminalResult?.status, 'canceled');
    assert.equal(terminalResult?.cleanupStarted, false);
    assert.equal(terminalResult?.temporaryAccessReleased, true);
    assert.equal(terminalResult?.externalAccessPreserved, false);
    assert.ok(Number.isSafeInteger(terminalResult?.settledAtMs));

    const permissionRemoveCount = chrome.__calls.filter((call) => call.api === 'permissions.remove').length;
    for (let replayIndex = 0; replayIndex < 2; replayIndex += 1) {
      const replay = await fixture.dispatch(MESSAGE_TYPES.resumeCleanupPermissionHandoff, authority, sender);
      assert.equal(replay.ok, true, replay.error);
      assert.equal(replay.reason, 'durable-handoff-terminal-result');
      assert.equal(replay.approvalHandoffCanceled, true);
      assert.equal(replay.cleanupStarted, false);
      assert.equal(replay.temporaryAccessReleased, true);
    }
    assert.equal(chrome.__calls.filter((call) => call.api === 'permissions.remove').length, permissionRemoveCount);
    assert.equal(cleanupJobReservationCount(chrome), 0);
    assert.equal(cleanupMutationCount(chrome), 0);
  } finally {
    Date.now = originalDateNow;
    fixture.dispose();
  }
});

test('service-worker-load maintenance durably replays a fully proved expired prompt cancellation', async () => {
  const fixture = await createHandoffFixture();
  const { chrome } = fixture;
  const originalDateNow = Date.now;
  let restartedChrome = null;
  try {
    const { prepared, claimed, sender } = await fixture.openAndClaim({ omitDocumentIds: true });
    const authority = handoffAuthority(prepared, claimed);
    assert.equal((await fixture.dispatch(MESSAGE_TYPES.beginCleanupPermissionHandoff, authority, sender)).ok, true);
    assert.equal(
      (await fixture.dispatch(MESSAGE_TYPES.confirmCleanupPermissionHandoffInvocation, authority, sender)).ok,
      true
    );

    const liveReview = chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY];
    const expiredNow = liveReview.expiresAtMs + 1;
    Date.now = () => expiredNow;
    await chrome.__events.alarm.emitAsync({ name: 'sitewipe.reviewExpiry' });
    await waitFor(
      () => chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY]?.approvalHandoff?.status === 'prompt_tombstone',
      2_000
    );

    assert.equal(await chrome.permissions.request({ origins: claimed.temporaryHostPermissionOrigins }), true);
    await waitFor(
      () => chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY]?.approvalHandoff?.promptGrant?.complete === true,
      2_000
    );
    const outcome = await recordCleanupPermissionGrantOutcome(
      {
        handoffNonce: prepared.review.approvalHandoffNonce,
        popupContextId: chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY].approvalHandoff.promptContextId,
        preRequestTemporaryOriginsAbsent: true
      },
      {
        storageSession: chrome.storage.session,
        storageLocal: chrome.storage.local,
        now: () => expiredNow + 1
      }
    );
    assert.equal(outcome.promptGrantOutcomeRecorded, true);
    assert.equal(chrome.__state.session[PERMISSION_HANDOFF_STORAGE_KEY]?.terminalResult, null);

    const restartLocalState = structuredClone(chrome.__state.local);
    const restartSessionState = structuredClone(chrome.__state.session);
    const restartTabs = [...chrome.__state.tabs.values()].map((tab) => structuredClone(tab));
    const restartContexts = structuredClone(chrome.__state.runtimeContexts);
    const restartOrigins = [...chrome.__state.originPermissions];
    fixture.dispose();

    restartedChrome = await createChromeMock({
      localState: restartLocalState,
      sessionState: restartSessionState,
      tabs: restartTabs,
      runtimeContexts: restartContexts,
      originPermissions: restartOrigins
    });
    restartedChrome.tabs.onRemoved = createEvent();
    globalThis.chrome = restartedChrome;
    await import(
      `../../src/background/service-worker.js?expired-prompt-terminal-restart=${Date.now()}-${Math.random()}`
    );
    await waitFor(
      () =>
        restartedChrome.__state.session[PERMISSION_HANDOFF_STORAGE_KEY]?.terminalResult?.status === 'canceled' &&
        restartedChrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY] === undefined &&
        restartedChrome.__state.local[STORAGE_KEYS.permissionLease] === undefined,
      5_000
    );

    const terminalResult = restartedChrome.__state.session[PERMISSION_HANDOFF_STORAGE_KEY].terminalResult;
    assert.equal(terminalResult.cleanupStarted, false);
    assert.equal(terminalResult.temporaryAccessReleased, true);
    assert.equal(terminalResult.externalAccessPreserved, false);
    assert.deepEqual(restartedChrome.__state.originPermissions, new Set());
    assert.equal(restartedChrome.__state.local[STORAGE_KEYS.activeJob], undefined);
    assert.equal(restartedChrome.__state.local[STORAGE_KEYS.activeReport], undefined);
    assert.equal(cleanupJobReservationCount(restartedChrome), 0);
    assert.equal(cleanupMutationCount(restartedChrome), 0);
    assert.equal(
      restartedChrome.__calls.some((call) => call.api === 'downloads.removeFile'),
      false
    );

    const resumed = await dispatchRuntimeMessage(
      restartedChrome,
      { type: MESSAGE_TYPES.resumeCleanupPermissionHandoff, payload: authority },
      sender
    );
    assert.equal(resumed.ok, true, resumed.error);
    assert.equal(resumed.reason, 'durable-handoff-terminal-result');
    assert.equal(resumed.approvalHandoffCanceled, true);
    assert.equal(resumed.cleanupStarted, false);
    assert.equal(resumed.temporaryAccessReleased, true);
    assert.equal(cleanupJobReservationCount(restartedChrome), 0);
    assert.equal(cleanupMutationCount(restartedChrome), 0);
  } finally {
    Date.now = originalDateNow;
    fixture.dispose();
    delete globalThis.chrome;
  }
});

test('terminal cancellation storage failures never retire the owned review and lease before durable replay', async (t) => {
  for (const mode of ['reject-before-commit', 'commit-then-reject']) {
    await t.test(mode, async () => {
      const fixture = await createHandoffFixture();
      const { chrome } = fixture;
      const originalDateNow = Date.now;
      const originalSessionSet = chrome.storage.session.set.bind(chrome.storage.session);
      try {
        const { prepared, claimed, sender } = await fixture.openAndClaim({ omitDocumentIds: true });
        const authority = handoffAuthority(prepared, claimed);
        assert.equal((await fixture.dispatch(MESSAGE_TYPES.beginCleanupPermissionHandoff, authority, sender)).ok, true);
        assert.equal(
          (await fixture.dispatch(MESSAGE_TYPES.confirmCleanupPermissionHandoffInvocation, authority, sender)).ok,
          true
        );
        const liveReview = chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY];
        const expiredNow = liveReview.expiresAtMs + 1;
        Date.now = () => expiredNow;
        await chrome.__events.alarm.emitAsync({ name: 'sitewipe.reviewExpiry' });
        await waitFor(
          () => chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY]?.approvalHandoff?.status === 'prompt_tombstone',
          2_000
        );
        assert.equal(await chrome.permissions.request({ origins: claimed.temporaryHostPermissionOrigins }), true);
        await waitFor(
          () => chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY]?.approvalHandoff?.promptGrant?.complete === true,
          2_000
        );
        await recordCleanupPermissionGrantOutcome(
          {
            handoffNonce: prepared.review.approvalHandoffNonce,
            popupContextId: chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY].approvalHandoff.promptContextId,
            preRequestTemporaryOriginsAbsent: true
          },
          {
            storageSession: chrome.storage.session,
            storageLocal: chrome.storage.local,
            now: () => expiredNow + 1
          }
        );

        let terminalWriteInjected = false;
        chrome.storage.session.set = async (values) => {
          if (
            !terminalWriteInjected &&
            values?.[PERMISSION_HANDOFF_STORAGE_KEY]?.terminalResult?.status === 'canceled'
          ) {
            terminalWriteInjected = true;
            if (mode === 'commit-then-reject') await originalSessionSet(values);
            throw new Error(`Injected ${mode} terminal-result storage failure`);
          }
          return originalSessionSet(values);
        };

        await chrome.__events.alarm.emitAsync({ name: 'sitewipe.maintenance' });
        await waitFor(() => terminalWriteInjected, 2_000);
        assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
        assert.equal(chrome.__state.local[STORAGE_KEYS.activeReport], undefined);
        assert.equal(cleanupJobReservationCount(chrome), 0);
        assert.equal(cleanupMutationCount(chrome), 0);
        assert.equal(
          chrome.__calls.some((call) => call.api === 'downloads.removeFile'),
          false
        );

        if (mode === 'reject-before-commit') {
          assert.equal(chrome.__state.session[PERMISSION_HANDOFF_STORAGE_KEY]?.terminalResult, null);
          assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY]?.approvalHandoff?.status, 'prompt_tombstone');
          assert.ok(chrome.__state.local[STORAGE_KEYS.permissionLease]);
          assert.deepEqual(chrome.__state.originPermissions, new Set());
          chrome.storage.session.set = originalSessionSet;
          await chrome.__events.alarm.emitAsync({ name: 'sitewipe.maintenance' });
        }

        await waitFor(
          () =>
            chrome.__state.session[PERMISSION_HANDOFF_STORAGE_KEY]?.terminalResult?.status === 'canceled' &&
            chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY] === undefined &&
            chrome.__state.local[STORAGE_KEYS.permissionLease] === undefined,
          3_000
        );
        assert.deepEqual(chrome.__state.originPermissions, new Set());
        assert.equal(
          chrome.__calls.filter((call) => call.api === 'permissions.remove').length,
          1,
          'a retried terminal write must not repeat the already completed exact permission removal'
        );
        assert.equal(cleanupJobReservationCount(chrome), 0);
        assert.equal(cleanupMutationCount(chrome), 0);
      } finally {
        Date.now = originalDateNow;
        chrome.storage.session.set = originalSessionSet;
        fixture.dispose();
      }
    });
  }
});

test('lost confirm response retains authenticated resume for the exact terminal outcome without duplicate cleanup', async () => {
  const fixture = await createHandoffFixture();
  const { chrome } = fixture;
  const adapterEntered = deferred();
  const releaseAdapter = deferred();
  try {
    const { prepared, claimed, sender } = await fixture.openAndClaim({ omitDocumentIds: true });
    const authority = handoffAuthority(prepared, claimed);
    const intent = await fixture.dispatch(MESSAGE_TYPES.beginCleanupPermissionHandoff, authority, sender);
    assert.equal(intent.ok, true, intent.error);
    await chrome.permissions.getAll();
    assert.equal(await chrome.permissions.request({ origins: claimed.temporaryHostPermissionOrigins }), true);
    const invocation = await fixture.dispatch(
      MESSAGE_TYPES.confirmCleanupPermissionHandoffInvocation,
      authority,
      sender
    );
    assert.equal(invocation.ok, true, invocation.error);
    await waitFor(
      () => chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY]?.approvalHandoff?.promptGrant?.complete === true,
      2_000
    );

    const originalBrowsingDataRemove = chrome.browsingData.remove;
    let firstAdapter = true;
    chrome.browsingData.remove = async (...args) => {
      if (firstAdapter) {
        firstAdapter = false;
        adapterEntered.resolve();
        await releaseAdapter.promise;
      }
      return originalBrowsingDataRemove(...args);
    };

    await assert.rejects(
      dispatchWithLostPort(
        chrome,
        {
          type: MESSAGE_TYPES.confirmCleanupPermissionHandoffGrant,
          payload: { ...authority, preRequestTemporaryOriginsAbsent: true }
        },
        sender
      ),
      /message port closed/i
    );
    await adapterEntered.promise;
    await waitFor(
      () =>
        chrome.__state.local[STORAGE_KEYS.activeJob]?.status === 'running' &&
        chrome.__state.local[STORAGE_KEYS.activeJob]?.admissionPhase === 'admitted',
      2_000
    );
    assert.equal(chrome.__state.session[PERMISSION_HANDOFF_STORAGE_KEY]?.status, 'used');
    const cleanupJobId = chrome.__state.local[STORAGE_KEYS.activeJob].id;
    let immediateResumeSettled = false;
    const immediateResumePromise = fixture
      .dispatch(MESSAGE_TYPES.resumeCleanupPermissionHandoff, authority, sender)
      .then((result) => {
        immediateResumeSettled = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      immediateResumeSettled,
      false,
      'an authenticated resume must wait truthfully for the same in-flight cleanup'
    );
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob].id, cleanupJobId);
    assert.equal(cleanupJobReservationCount(chrome), 1);

    releaseAdapter.resolve();
    const immediateResume = await immediateResumePromise;
    assert.equal(immediateResume.ok, true, immediateResume.error);
    assert.equal(immediateResume.resumedTerminalResult, true);
    assert.equal(immediateResume.report.id, cleanupJobId);
    await waitFor(() => chrome.__state.local[STORAGE_KEYS.activeJob]?.status === 'completed', 4_000);
    const mutationCount = cleanupMutationCount(chrome);

    const laterResume = await fixture.dispatch(MESSAGE_TYPES.resumeCleanupPermissionHandoff, authority, sender);
    assert.equal(laterResume.ok, true, laterResume.error);
    assert.equal(laterResume.resumedTerminalResult, true);
    assert.equal(laterResume.report.id, cleanupJobId);
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob].id, cleanupJobId);
    assert.equal(cleanupJobReservationCount(chrome), 1);
    assert.equal(cleanupMutationCount(chrome), mutationCount);
    assert.equal(
      chrome.__calls.some((call) => call.api === 'downloads.removeFile'),
      false
    );
  } finally {
    releaseAdapter.resolve();
    fixture.dispose();
  }
});

test('external removal invalidation preserves a later manual regrant across in-flight recovery and worker restart', async () => {
  const fixture = await createHandoffFixture();
  const { chrome } = fixture;
  const releaseBlockedInventory = deferred();
  let restartedChrome = null;
  try {
    const { prepared, claimed, sender } = await fixture.openAndClaim({ omitDocumentIds: true });
    const authority = handoffAuthority(prepared, claimed);
    assert.equal((await fixture.dispatch(MESSAGE_TYPES.beginCleanupPermissionHandoff, authority, sender)).ok, true);
    await chrome.permissions.getAll();
    assert.equal(await chrome.permissions.request({ origins: claimed.temporaryHostPermissionOrigins }), true);
    assert.equal(
      (await fixture.dispatch(MESSAGE_TYPES.confirmCleanupPermissionHandoffInvocation, authority, sender)).ok,
      true
    );
    await waitFor(
      () => chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY]?.approvalHandoff?.promptGrant?.complete === true,
      2_000
    );

    const originalGetAll = chrome.permissions.getAll;
    let blockNextInventory = true;
    let blockedInventoryStarted = false;
    chrome.permissions.getAll = async (...args) => {
      if (blockNextInventory) {
        blockNextInventory = false;
        blockedInventoryStarted = true;
        await releaseBlockedInventory.promise;
      }
      return originalGetAll(...args);
    };

    const outcome = fixture.dispatch(
      MESSAGE_TYPES.confirmCleanupPermissionHandoffGrant,
      { ...authority, preRequestTemporaryOriginsAbsent: true },
      sender
    );
    await waitFor(() => blockedInventoryStarted, 2_000);
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease]?.ownershipProof, 'reviewed_prompt_grant');

    const originalLocalSet = chrome.storage.local.set.bind(chrome.storage.local);
    const originalLocalRemove = chrome.storage.local.remove.bind(chrome.storage.local);
    let revocationWriteFailures = 0;
    let leaseDiscardFailures = 0;
    chrome.storage.local.set = async (values) => {
      if (values?.[STORAGE_KEYS.permissionLease]?.ownershipProof === 'revoked') {
        revocationWriteFailures += 1;
        throw new Error('Injected persistent local lease revocation write failure');
      }
      return originalLocalSet(values);
    };
    chrome.storage.local.remove = async (keys) => {
      if (
        keys === STORAGE_KEYS.permissionLease ||
        (Array.isArray(keys) && keys.includes(STORAGE_KEYS.permissionLease))
      ) {
        leaseDiscardFailures += 1;
        throw new Error('Injected persistent local lease discard failure');
      }
      return originalLocalRemove(keys);
    };

    const removedOrigin = claimed.temporaryHostPermissionOrigins[0];
    chrome.__state.originPermissions.delete(removedOrigin);
    chrome.__events.permissionRemoved.emit({
      origins: ['<all_urls>', removedOrigin, removedOrigin, 'malformed pattern'],
      permissions: ['tabs']
    });
    await waitFor(() => chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY] === undefined, 3_000);

    for (const origin of claimed.temporaryHostPermissionOrigins) chrome.__state.originPermissions.add(origin);
    chrome.__events.permissionAdded.emit({ origins: claimed.temporaryHostPermissionOrigins });
    await waitFor(() => revocationWriteFailures >= 4 && leaseDiscardFailures >= 4, 3_000);

    releaseBlockedInventory.resolve();
    const outcomeResponse = await outcome;
    assert.equal(outcomeResponse.ok, true, outcomeResponse.error);
    assert.equal(outcomeResponse.promptGrantOutcomeRecorded, true);
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(chrome.__state.originPermissions, new Set(claimed.temporaryHostPermissionOrigins));
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease]?.ownershipProof, 'reviewed_prompt_grant');
    assert.equal(
      chrome.__calls.some((call) => call.api === 'permissions.remove'),
      false,
      'an in-flight recovery must abort after the synchronous external-removal reservation'
    );
    assert.equal(cleanupMutationCount(chrome), 0);

    const restartLocalState = structuredClone(chrome.__state.local);
    const restartSessionState = structuredClone(chrome.__state.session);
    fixture.dispose();
    restartedChrome = await createChromeMock({
      localState: restartLocalState,
      sessionState: restartSessionState,
      originPermissions: claimed.temporaryHostPermissionOrigins
    });
    globalThis.chrome = restartedChrome;
    await import(`../../src/background/service-worker.js?external-removal-restart=${Date.now()}-${Math.random()}`);
    await waitFor(() => restartedChrome.__state.local[STORAGE_KEYS.permissionLease] === undefined, 5_000);

    assert.deepEqual(
      restartedChrome.__state.originPermissions,
      new Set(claimed.temporaryHostPermissionOrigins),
      'generic restart recovery must preserve an ambiguous pre-admission manual regrant'
    );
    assert.equal(restartedChrome.__state.local[STORAGE_KEYS.activeJob], undefined);
    assert.equal(
      restartedChrome.__calls.some((call) => call.api === 'permissions.remove'),
      false
    );
    assert.equal(cleanupMutationCount(restartedChrome), 0);
    assert.equal(
      restartedChrome.__calls.some((call) => call.api === 'downloads.removeFile'),
      false
    );
  } finally {
    releaseBlockedInventory.resolve();
    fixture.dispose();
    delete globalThis.chrome;
  }
});

test('an unrelated valid live review cannot authorize removal of an ambiguous reviewed prompt grant', async () => {
  const fixture = await createHandoffFixture();
  const { chrome } = fixture;
  try {
    const { prepared } = await fixture.prepareAndArm();
    const reviewedOrigins = prepared.review.temporaryHostPermissionOrigins;
    const unrelatedReviewedGrant = structuredClone(chrome.__state.local[STORAGE_KEYS.permissionLease]);
    unrelatedReviewedGrant.id = 'lease-reviewed-mismatch-000000000000000001';
    unrelatedReviewedGrant.status = 'prompt_pending';
    unrelatedReviewedGrant.promptPendingUntil = new Date(
      Date.parse(unrelatedReviewedGrant.updatedAt) + 30_000
    ).toISOString();
    unrelatedReviewedGrant.ownershipProof = 'reviewed_prompt_grant';
    unrelatedReviewedGrant.ownershipRevokedAt = null;
    chrome.__state.local[STORAGE_KEYS.permissionLease] = unrelatedReviewedGrant;
    for (const origin of reviewedOrigins) chrome.__state.originPermissions.add(origin);
    chrome.__calls.length = 0;

    await chrome.__events.alarm.emitAsync({ name: 'sitewipe.maintenance' });
    await waitFor(() => chrome.__state.local[STORAGE_KEYS.permissionLease] === undefined, 3_000);

    assert.deepEqual(chrome.__state.originPermissions, new Set(reviewedOrigins));
    assert.equal(
      chrome.__calls.some((call) => call.api === 'permissions.remove'),
      false,
      'only the exact matching normalized review may authenticate pre-admission prompt ownership'
    );
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
    assert.equal(cleanupMutationCount(chrome), 0);
    assert.equal(
      chrome.__calls.some((call) => call.api === 'downloads.removeFile'),
      false
    );
  } finally {
    fixture.dispose();
  }
});

test('closing the persistent handoff tab before admission fails closed without permission or cleanup mutation', async () => {
  const fixture = await createHandoffFixture();
  const { chrome } = fixture;
  try {
    const { tabId } = await fixture.openAndClaim({ omitDocumentIds: true });
    fixture.closeTab(tabId);
    await waitFor(
      () =>
        chrome.__state.session[PERMISSION_HANDOFF_STORAGE_KEY] === undefined &&
        chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY] === undefined &&
        chrome.__state.local[STORAGE_KEYS.permissionLease] === undefined,
      2_000
    );

    assert.deepEqual(chrome.__state.originPermissions, new Set());
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
    assert.equal(
      chrome.__calls.some((call) => call.api === 'permissions.request'),
      false
    );
    assert.equal(
      chrome.__calls.some((call) => call.api === 'permissions.remove'),
      false
    );
    assert.equal(
      chrome.__calls.some((call) => call.api === 'browsingData.remove'),
      false
    );
    assert.equal(
      chrome.__calls.some((call) => call.api === 'downloads.removeFile'),
      false
    );
  } finally {
    fixture.dispose();
  }
});

test('an exact permission event before authenticated handoff begin remains proofless and is preserved', async () => {
  const fixture = await createHandoffFixture();
  const { chrome } = fixture;
  try {
    const { prepared, claimed, sender } = await fixture.openAndClaim({ omitDocumentIds: true });
    const origins = claimed.temporaryHostPermissionOrigins;
    for (const origin of origins) chrome.__state.originPermissions.add(origin);
    chrome.__events.permissionAdded.emit({ origins });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY].approvalHandoff.promptGrant, null);

    const authority = handoffAuthority(prepared, claimed);
    const intent = await fixture.dispatch(MESSAGE_TYPES.beginCleanupPermissionHandoff, authority, sender);
    assert.equal(intent.ok, true, intent.error);
    const invocation = await fixture.dispatch(
      MESSAGE_TYPES.confirmCleanupPermissionHandoffInvocation,
      authority,
      sender
    );
    assert.equal(invocation.ok, true, invocation.error);
    assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY].approvalHandoff.promptGrant, null);

    const settled = await fixture.dispatch(
      MESSAGE_TYPES.settleCleanupPermissionHandoff,
      { ...authority, outcome: 'abandoned' },
      sender
    );
    assert.equal(settled.ok, true, settled.error);
    assert.deepEqual(chrome.__state.originPermissions, new Set(origins));
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
    assert.equal(
      chrome.__calls.some((call) => call.api === 'permissions.remove'),
      false
    );
    assert.equal(
      chrome.__calls.some((call) => call.api === 'browsingData.remove'),
      false
    );
  } finally {
    fixture.dispose();
  }
});

test('capability consumption remains fail-closed when the durable used write commits then rejects', async () => {
  const fixture = await createHandoffFixture();
  const { chrome } = fixture;
  try {
    const { prepared, claimed, sender } = await fixture.openAndClaim({ omitDocumentIds: true });
    const authority = handoffAuthority(prepared, claimed);
    const originalSet = chrome.storage.session.set;
    let injected = false;
    chrome.storage.session.set = async (values) => {
      if (!injected && values?.[PERMISSION_HANDOFF_STORAGE_KEY]?.status === 'used') {
        injected = true;
        await originalSet(values);
        throw new Error('Injected uncertain used-capability write');
      }
      return originalSet(values);
    };

    const uncertain = await fixture.dispatch(MESSAGE_TYPES.beginCleanupPermissionHandoff, authority, sender);
    assert.equal(uncertain.ok, false);
    assert.match(uncertain.error, /uncertain used-capability write/i);
    assert.equal(chrome.__state.session[PERMISSION_HANDOFF_STORAGE_KEY].status, 'used');
    assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY].approvalHandoff.promptIntent, null);

    const replay = await fixture.dispatch(MESSAGE_TYPES.beginCleanupPermissionHandoff, authority, sender);
    assert.equal(replay.ok, false);
    assert.match(replay.error, /already been used/i);
    assert.equal(
      chrome.__calls.some((call) => call.api === 'permissions.request'),
      false
    );
    assert.equal(
      chrome.__calls.some((call) => call.api === 'browsingData.remove'),
      false
    );
    assert.equal(
      chrome.__calls.some((call) => call.api === 'downloads.removeFile'),
      false
    );
  } finally {
    fixture.dispose();
  }
});

test('handoff context binding rejects ambiguity, malformed document ids, and same-URL reloads', async (t) => {
  await t.test('ambiguous runtime contexts', async () => {
    const fixture = await createHandoffFixture();
    try {
      const opened = await fixture.openOnly();
      fixture.installHandoffContexts(opened.tabId, [
        handoffContext(opened.tabId, 'ambiguous-context-a'),
        handoffContext(opened.tabId, 'ambiguous-context-b')
      ]);
      const claimed = await fixture.dispatch(
        MESSAGE_TYPES.claimCleanupPermissionHandoff,
        {},
        fixture.handoffSender(opened.tabId)
      );
      assert.equal(claimed.ok, false);
      assert.match(claimed.error, /exactly one/i);
    } finally {
      fixture.dispose();
    }
  });

  await t.test('present malformed sender document id', async () => {
    const fixture = await createHandoffFixture();
    try {
      const opened = await fixture.openOnly();
      fixture.installHandoffContexts(opened.tabId, [handoffContext(opened.tabId, 'malformed-id-context')]);
      const sender = fixture.handoffSender(opened.tabId, { documentId: ' ' });
      const claimed = await fixture.dispatch(MESSAGE_TYPES.claimCleanupPermissionHandoff, {}, sender);
      assert.equal(claimed.ok, false);
      assert.match(claimed.error, /exact sitewipe handoff document/i);
    } finally {
      fixture.dispose();
    }
  });

  await t.test('same URL with a replacement runtime context', async () => {
    const fixture = await createHandoffFixture();
    const { chrome } = fixture;
    try {
      const claimed = await fixture.openAndClaim({ contextId: 'original-handoff-context', omitDocumentIds: true });
      const createdBefore = chrome.__calls.filter((call) => call.api === 'tabs.create').length;
      chrome.__state.runtimeContexts.splice(
        0,
        chrome.__state.runtimeContexts.length,
        fixture.popupContext,
        handoffContext(claimed.tabId, 'replacement-handoff-context')
      );
      const focused = await fixture.dispatch(
        MESSAGE_TYPES.openCleanupPermissionHandoff,
        {
          approvalToken: claimed.prepared.review.approvalToken,
          handoffNonce: claimed.prepared.review.approvalHandoffNonce,
          popupContextId: claimed.prepared.popupContextId,
          popupPreparationCapability: claimed.prepared.popupPreparationCapability
        },
        fixture.popupSender
      );
      assert.equal(focused.ok, false);
      assert.match(focused.error, /no longer available|fresh review/i);
      assert.equal(chrome.__calls.filter((call) => call.api === 'tabs.create').length, createdBefore);
      assert.equal(chrome.__state.session[PERMISSION_HANDOFF_STORAGE_KEY].contextId, 'original-handoff-context');
    } finally {
      fixture.dispose();
    }
  });
});

test('schema-2 popup handoffs are neutralized in every unadmitted phase without removing ambiguous access', async (t) => {
  const fixture = await createHandoffFixture();
  const { chrome } = fixture;
  try {
    const { prepared } = await fixture.prepareAndArm();
    assert.equal(CLEANUP_APPROVAL_HANDOFF_SCHEMA_VERSION, 3);
    const baselineReview = structuredClone(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY]);
    const baselineLease = structuredClone(chrome.__state.local[STORAGE_KEYS.permissionLease]);
    const origins = prepared.review.temporaryHostPermissionOrigins;
    const phases = [
      ['armed', {}],
      [
        'intent',
        {
          promptIntent: {
            popupContextId: baselineReview.approvalHandoff.promptContextId,
            recordedAtMs: baselineReview.approvalHandoff.armedAtMs,
            confirmationDeadlineMs: baselineReview.approvalHandoff.armedAtMs + 30_000
          }
        }
      ],
      [
        'invocation-event',
        {
          promptIntent: legacyIntent(baselineReview),
          promptInvocation: legacyInvocation(baselineReview),
          promptGrant: {
            observedOrigins: origins,
            complete: true,
            recordedAtMs: baselineReview.approvalHandoff.armedAtMs
          }
        }
      ],
      [
        'literal-true-only-malformed',
        {
          promptGrantOutcome: {
            popupContextId: baselineReview.approvalHandoff.promptContextId,
            granted: true,
            preRequestTemporaryOriginsAbsent: true,
            recordedAtMs: baselineReview.approvalHandoff.armedAtMs
          }
        }
      ],
      [
        'complete-proof',
        {
          promptIntent: legacyIntent(baselineReview),
          promptInvocation: legacyInvocation(baselineReview),
          promptGrant: {
            observedOrigins: origins,
            complete: true,
            recordedAtMs: baselineReview.approvalHandoff.armedAtMs
          },
          promptGrantOutcome: {
            popupContextId: baselineReview.approvalHandoff.promptContextId,
            granted: true,
            preRequestTemporaryOriginsAbsent: true,
            recordedAtMs: baselineReview.approvalHandoff.armedAtMs
          }
        }
      ]
    ];

    for (const [name, phase] of phases) {
      await t.test(name, async () => {
        chrome.__calls.length = 0;
        chrome.__state.originPermissions.clear();
        for (const origin of origins) chrome.__state.originPermissions.add(origin);
        const legacyReview = structuredClone(baselineReview);
        legacyReview.approvalHandoff = {
          ...legacyReview.approvalHandoff,
          schemaVersion: 2,
          ...phase
        };
        const legacyLease = structuredClone(baselineLease);
        legacyLease.status = 'prompt_pending';
        legacyLease.promptPendingUntil ||= new Date(Date.now() + 30 * 60_000).toISOString();
        legacyLease.ownershipProof = name === 'armed' || name === 'intent' ? null : 'reviewed_prompt_grant';
        legacyLease.ownershipRevokedAt = null;
        chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY] = legacyReview;
        chrome.__state.local[STORAGE_KEYS.permissionLease] = legacyLease;

        const recovered = await clearExpiredCleanupReview(chrome.storage.session, Date.now(), {
          storageLocal: chrome.storage.local
        });
        assert.equal(recovered.invalidReviewDiscarded, true);
        assert.equal(recovered.hostPermissionCleanup.reason, 'invalid_review_lease_discarded');
        assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
        assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
        assert.deepEqual(chrome.__state.originPermissions, new Set(origins));
        assert.equal(chrome.__state.session[PERMISSION_HANDOFF_STORAGE_KEY], undefined);
        assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
        assert.equal(
          chrome.__calls.some((call) => call.api === 'permissions.remove'),
          false
        );
        assert.equal(
          chrome.__calls.some((call) => call.api === 'browsingData.remove'),
          false
        );
        assert.equal(
          chrome.__calls.some((call) => call.api === 'downloads.removeFile'),
          false
        );
      });
    }

    await t.test('admitted cleanup lease remains for ordinary recovery', async () => {
      const legacyReview = structuredClone(baselineReview);
      legacyReview.approvalHandoff.schemaVersion = 2;
      const admittedLease = {
        ...structuredClone(baselineLease),
        status: 'active_cleanup',
        promptPendingUntil: null,
        ownershipProof: 'admitted_cleanup',
        ownershipRevokedAt: null
      };
      chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY] = legacyReview;
      chrome.__state.local[STORAGE_KEYS.permissionLease] = admittedLease;
      const recovered = await clearExpiredCleanupReview(chrome.storage.session, Date.now(), {
        storageLocal: chrome.storage.local
      });
      assert.equal(recovered.hostPermissionCleanup.reason, 'admitted_cleanup_recovery_retained');
      assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
      assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease].ownershipProof, 'admitted_cleanup');
      assert.equal(
        chrome.__calls.some((call) => call.api === 'permissions.remove'),
        false
      );
    });

    await t.test('local read uncertainty retains the non-runnable schema-2 migration marker', async () => {
      restoreLegacyOwnedState(chrome, baselineReview, baselineLease);
      const originalGet = chrome.storage.local.get;
      chrome.storage.local.get = async () => {
        throw new Error('Injected legacy local read uncertainty');
      };
      try {
        const recovered = await clearExpiredCleanupReview(chrome.storage.session, Date.now(), {
          storageLocal: chrome.storage.local
        });
        assert.equal(recovered.hostPermissionCleanup.recordRetained, true);
        assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY].approvalHandoff.schemaVersion, 2);
        assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease].ownershipProof, 'reviewed_prompt_grant');
        assertNoMigrationMutation(chrome);
      } finally {
        chrome.storage.local.get = originalGet;
      }
    });

    for (const commitBeforeReject of [false, true]) {
      await t.test(`local lease removal rejection ${commitBeforeReject ? 'after' : 'before'} commit`, async () => {
        restoreLegacyOwnedState(chrome, baselineReview, baselineLease);
        const originalRemove = chrome.storage.local.remove;
        chrome.storage.local.remove = async (keys) => {
          if (commitBeforeReject) await originalRemove(keys);
          throw new Error('Injected legacy local removal uncertainty');
        };
        try {
          const recovered = await clearExpiredCleanupReview(chrome.storage.session, Date.now(), {
            storageLocal: chrome.storage.local
          });
          if (commitBeforeReject) {
            assert.equal(recovered.hostPermissionCleanup.reason, 'invalid_review_lease_discarded');
            assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
            assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
          } else {
            assert.equal(recovered.hostPermissionCleanup.reason, 'invalid_review_lease_neutralization_unproven');
            assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY].approvalHandoff.schemaVersion, 2);
            assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease].ownershipProof, 'reviewed_prompt_grant');
          }
          assertNoMigrationMutation(chrome);
        } finally {
          chrome.storage.local.remove = originalRemove;
        }
      });
    }

    for (const commitBeforeReject of [false, true]) {
      await t.test(`session marker removal rejection ${commitBeforeReject ? 'after' : 'before'} commit`, async () => {
        restoreLegacyOwnedState(chrome, baselineReview, baselineLease);
        const originalRemove = chrome.storage.session.remove;
        chrome.storage.session.remove = async (keys) => {
          if (commitBeforeReject) await originalRemove(keys);
          throw new Error('Injected legacy session removal uncertainty');
        };
        try {
          const recovered = await clearExpiredCleanupReview(chrome.storage.session, Date.now(), {
            storageLocal: chrome.storage.local
          });
          assert.equal(recovered.hostPermissionCleanup.recordRetained, !commitBeforeReject);
          assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
          if (commitBeforeReject) assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
          else assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY].approvalHandoff.schemaVersion, 2);
          assertNoMigrationMutation(chrome);
        } finally {
          chrome.storage.session.remove = originalRemove;
        }
      });
    }
  } finally {
    fixture.dispose();
  }
});

test('every malformed current review neutralizes ambiguous lease bookkeeping before maintenance can remove access', async (t) => {
  const fixture = await createHandoffFixture();
  const { chrome } = fixture;
  try {
    const { prepared } = await fixture.prepareAndArm();
    const baselineReview = structuredClone(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY]);
    const baselineLease = structuredClone(chrome.__state.local[STORAGE_KEYS.permissionLease]);
    const origins = prepared.review.temporaryHostPermissionOrigins;

    for (const leaseStatus of ['prompt_pending', 'release_pending']) {
      await t.test(`${leaseStatus} reviewed grant is neutralized before the invalid marker`, async () => {
        restoreInvalidCurrentReviewState(chrome, baselineReview, baselineLease, origins, leaseStatus);
        const recovered = await clearExpiredCleanupReview(chrome.storage.session, Date.now(), {
          storageLocal: chrome.storage.local
        });
        assert.equal(recovered.invalidReviewDiscarded, true);
        assert.equal(recovered.hostPermissionCleanup.reason, 'invalid_review_lease_discarded');
        assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
        assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);

        await chrome.__events.alarm.emitAsync({ name: 'sitewipe.maintenance' });
        assert.deepEqual(chrome.__state.originPermissions, new Set(origins));
        assertNoMigrationMutation(chrome);
      });
    }

    await t.test('invalid durable lease bytes are discarded without touching matching browser access', async () => {
      restoreInvalidCurrentReviewState(chrome, baselineReview, baselineLease, origins, 'prompt_pending');
      chrome.__state.local[STORAGE_KEYS.permissionLease].schemaVersion = -1;
      chrome.__state.local[STORAGE_KEYS.permissionLease].id = { forged: true };
      const recovered = await clearExpiredCleanupReview(chrome.storage.session, Date.now(), {
        storageLocal: chrome.storage.local
      });
      assert.equal(recovered.hostPermissionCleanup.reason, 'invalid_review_lease_discarded');
      assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
      assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
      assert.deepEqual(chrome.__state.originPermissions, new Set(origins));
      assertNoMigrationMutation(chrome);
    });

    await t.test(
      'local read uncertainty retains the malformed current-review marker through maintenance and startup',
      async () => {
        restoreInvalidCurrentReviewState(chrome, baselineReview, baselineLease, origins, 'prompt_pending');
        const originalGet = chrome.storage.local.get;
        chrome.storage.local.get = async (keys) => {
          const readsLease =
            keys === STORAGE_KEYS.permissionLease ||
            (Array.isArray(keys) && keys.includes(STORAGE_KEYS.permissionLease));
          if (readsLease) throw new Error('Injected current-review local read uncertainty');
          return originalGet(keys);
        };
        try {
          const recovered = await clearExpiredCleanupReview(chrome.storage.session, Date.now(), {
            storageLocal: chrome.storage.local
          });
          assert.equal(recovered.hostPermissionCleanup.recordRetained, true);
          await chrome.__events.alarm.emitAsync({ name: 'sitewipe.maintenance' });
          await chrome.__events.runtimeStartup.emitAsync();
          assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease].ownershipProof, 'reviewed_prompt_grant');
          assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY].approvalHandoff.schemaVersion, 3);
          assert.deepEqual(chrome.__state.originPermissions, new Set(origins));
          assertNoMigrationMutation(chrome);
        } finally {
          chrome.storage.local.get = originalGet;
        }
        await chrome.__events.alarm.emitAsync({ name: 'sitewipe.maintenance' });
        assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
        assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
        assert.deepEqual(chrome.__state.originPermissions, new Set(origins));
        assertNoMigrationMutation(chrome);
      }
    );

    for (const leaseStatus of ['prompt_pending', 'release_pending']) {
      for (const commitBeforeReject of [false, true]) {
        await t.test(
          `${leaseStatus} local neutralization rejection ${commitBeforeReject ? 'after' : 'before'} commit`,
          async () => {
            restoreInvalidCurrentReviewState(chrome, baselineReview, baselineLease, origins, leaseStatus);
            const originalRemove = chrome.storage.local.remove;
            chrome.storage.local.remove = async (keys) => {
              const removesLease =
                keys === STORAGE_KEYS.permissionLease ||
                (Array.isArray(keys) && keys.includes(STORAGE_KEYS.permissionLease));
              if (!removesLease) return originalRemove(keys);
              if (commitBeforeReject) await originalRemove(keys);
              throw new Error('Injected current-review local removal uncertainty');
            };
            try {
              const recovered = await clearExpiredCleanupReview(chrome.storage.session, Date.now(), {
                storageLocal: chrome.storage.local
              });
              if (commitBeforeReject) {
                assert.equal(recovered.hostPermissionCleanup.reason, 'invalid_review_lease_discarded');
                assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
                assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
              } else {
                assert.equal(recovered.hostPermissionCleanup.reason, 'invalid_review_lease_neutralization_unproven');
                assert.equal(
                  chrome.__state.local[STORAGE_KEYS.permissionLease].ownershipProof,
                  'reviewed_prompt_grant'
                );
                assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY].approvalHandoff.schemaVersion, 3);
                await chrome.__events.alarm.emitAsync({ name: 'sitewipe.maintenance' });
                await chrome.__events.runtimeStartup.emitAsync();
                assert.equal(
                  chrome.__state.local[STORAGE_KEYS.permissionLease].ownershipProof,
                  'reviewed_prompt_grant'
                );
                assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY].approvalHandoff.schemaVersion, 3);
              }
              assert.deepEqual(chrome.__state.originPermissions, new Set(origins));
              assertNoMigrationMutation(chrome);
            } finally {
              chrome.storage.local.remove = originalRemove;
            }

            await chrome.__events.alarm.emitAsync({ name: 'sitewipe.maintenance' });
            assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
            assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
            assert.deepEqual(chrome.__state.originPermissions, new Set(origins));
            assertNoMigrationMutation(chrome);
          }
        );
      }
    }

    await t.test('release-pending admitted cleanup ownership remains available for ordinary recovery', async () => {
      restoreInvalidCurrentReviewState(chrome, baselineReview, baselineLease, origins, 'release_pending', {
        ownershipProof: 'admitted_cleanup'
      });
      const recovered = await clearExpiredCleanupReview(chrome.storage.session, Date.now(), {
        storageLocal: chrome.storage.local
      });
      assert.equal(recovered.hostPermissionCleanup.reason, 'admitted_cleanup_recovery_retained');
      assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
      assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease].status, 'release_pending');
      assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease].ownershipProof, 'admitted_cleanup');
      assert.equal(
        chrome.__calls.some((call) => call.api === 'permissions.remove'),
        false
      );
    });
  } finally {
    fixture.dispose();
  }
});

async function createHandoffFixture() {
  const now = new Date().toISOString();
  const chrome = await createChromeMock({
    localState: {
      [STORAGE_KEYS.settings]: {
        ...DEFAULT_SETTINGS,
        cleanupMode: 'standard',
        progressOverlay: false,
        pageScriptScrub: false,
        temporaryDnrShield: false,
        verificationPass: false,
        aggressiveCookieSweep: false,
        deleteDownloadedFiles: false,
        redactReports: false,
        keepHistory: false,
        createdAt: now,
        updatedAt: now,
        stabilityDefaultsAppliedAt: now,
        performanceDefaultsAppliedAt: now,
        privacyDefaultsAppliedAt: now
      }
    }
  });
  chrome.tabs.onRemoved = createEvent();
  let nextTabId = 80;
  chrome.tabs.create = async (properties) => {
    chrome.__calls.push({ api: 'tabs.create', args: [structuredClone(properties)] });
    const tab = {
      id: nextTabId,
      windowId: properties.windowId,
      active: properties.active === true,
      incognito: false,
      url: properties.url
    };
    nextTabId += 1;
    chrome.__state.tabs.set(tab.id, structuredClone(tab));
    return structuredClone(tab);
  };

  globalThis.chrome = chrome;
  await import(`../../src/background/service-worker.js?persistent-permission-handoff=${Date.now()}-${Math.random()}`);
  await waitFor(() => chrome.__state.alarms.has('sitewipe.maintenance'), 2_000);

  const popupContext = structuredClone(chrome.__state.runtimeContexts[0]);
  const popupSender = {
    id: chrome.runtime.id,
    url: chrome.runtime.getURL('popup/popup.html'),
    documentUrl: chrome.runtime.getURL('popup/popup.html'),
    origin: chrome.runtime.getURL('').replace(/\/$/, ''),
    frameId: 0
  };

  const dispatch = (type, payload, sender = popupSender) => dispatchRuntimeMessage(chrome, { type, payload }, sender);

  async function prepareAndArm() {
    const prepared = await dispatch(MESSAGE_TYPES.prepareCleanupReview, {
      input: 'example.com',
      sourceWindowId: 1,
      sourceIncognito: false
    });
    assert.equal(prepared.ok, true, prepared.error);
    const armed = await dispatch(MESSAGE_TYPES.armCleanupApproval, {
      approvalToken: prepared.review.approvalToken,
      handoffNonce: prepared.review.approvalHandoffNonce,
      approval: completeApproval(),
      sourceWindowId: 1,
      sourceIncognito: false,
      popupContextId: prepared.popupContextId,
      popupPreparationCapability: prepared.popupPreparationCapability
    });
    assert.equal(armed.ok, true, armed.error);
    assert.equal(armed.approvalArmed, true);
    return { prepared, armed };
  }

  async function openOnly() {
    const { prepared, armed } = await prepareAndArm();
    const opened = await dispatch(MESSAGE_TYPES.openCleanupPermissionHandoff, {
      approvalToken: prepared.review.approvalToken,
      handoffNonce: prepared.review.approvalHandoffNonce,
      popupContextId: prepared.popupContextId,
      popupPreparationCapability: prepared.popupPreparationCapability
    });
    assert.equal(opened.ok, true, opened.error);
    assert.equal(opened.handoffOpened, true);
    const created = chrome.__calls.find((call) => call.api === 'tabs.create');
    assert.deepEqual(created.args[0], { windowId: 1, url: 'about:blank', active: true });
    assert.equal(chrome.__state.tabs.get(opened.tabId).url, chrome.runtime.getURL('handoff/handoff.html'));
    return { prepared, armed, tabId: opened.tabId };
  }

  function installHandoffContexts(tabId, contexts) {
    chrome.__state.runtimeContexts.splice(0, chrome.__state.runtimeContexts.length, ...contexts);
  }

  function handoffSender(tabId, overrides = {}) {
    const url = chrome.runtime.getURL('handoff/handoff.html');
    return {
      id: chrome.runtime.id,
      url,
      documentUrl: url,
      origin: chrome.runtime.getURL('').replace(/\/$/, ''),
      frameId: 0,
      tab: { id: tabId, windowId: 1, incognito: false, url },
      ...overrides
    };
  }

  async function openAndClaim(options = {}) {
    const opened = await openOnly();
    const contextId = options.contextId || 'persistent-handoff-context';
    const context = handoffContext(opened.tabId, contextId, {
      ...(options.omitDocumentIds ? { documentId: undefined } : {}),
      ...(options.omitContextOrigin ? { documentOrigin: undefined } : {})
    });
    installHandoffContexts(opened.tabId, [context]);
    const sender = handoffSender(opened.tabId, options.omitDocumentIds ? {} : { documentId: context.documentId });
    const claimed = await dispatch(MESSAGE_TYPES.claimCleanupPermissionHandoff, {}, sender);
    assert.equal(claimed.ok, true, claimed.error);
    assert.equal(claimed.handoffClaimed, true);
    return { ...opened, claimed, sender };
  }

  function closeTab(tabId) {
    chrome.__state.tabs.delete(tabId);
    chrome.tabs.onRemoved.emit(tabId, { windowId: 1, isWindowClosing: false });
  }

  return {
    chrome,
    popupContext,
    popupSender,
    dispatch,
    prepareAndArm,
    openOnly,
    openAndClaim,
    installHandoffContexts,
    handoffSender,
    closeTab,
    dispose() {
      delete globalThis.chrome;
    }
  };
}

function handoffContext(tabId, contextId, overrides = {}) {
  return {
    contextId,
    contextType: 'TAB',
    documentId: `${contextId}-document`,
    documentOrigin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    documentUrl: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/handoff/handoff.html',
    frameId: 0,
    tabId,
    windowId: 1,
    incognito: false,
    ...overrides
  };
}

function handoffAuthority(prepared, claimed) {
  return {
    handoffNonce: prepared.review.approvalHandoffNonce,
    handoffCapability: claimed.handoffCapability
  };
}

function completeApproval() {
  return {
    approvalMode: 'detailed_review',
    reviewedScope: true,
    associatedTargets: false,
    localOrIpTarget: false,
    protectedWebOrigins: false,
    fileConfirmationText: ''
  };
}

function legacyIntent(review) {
  return {
    popupContextId: review.approvalHandoff.promptContextId,
    recordedAtMs: review.approvalHandoff.armedAtMs,
    confirmationDeadlineMs: review.approvalHandoff.armedAtMs + 30_000
  };
}

function legacyInvocation(review) {
  return {
    popupContextId: review.approvalHandoff.promptContextId,
    recordedAtMs: review.approvalHandoff.armedAtMs
  };
}

function restoreLegacyOwnedState(chrome, baselineReview, baselineLease) {
  chrome.__calls.length = 0;
  const legacyReview = structuredClone(baselineReview);
  legacyReview.approvalHandoff.schemaVersion = 2;
  const legacyLease = structuredClone(baselineLease);
  legacyLease.status = 'prompt_pending';
  legacyLease.promptPendingUntil ||= new Date(Date.now() + 30 * 60_000).toISOString();
  legacyLease.ownershipProof = 'reviewed_prompt_grant';
  legacyLease.ownershipRevokedAt = null;
  chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY] = legacyReview;
  chrome.__state.local[STORAGE_KEYS.permissionLease] = legacyLease;
}

function restoreInvalidCurrentReviewState(
  chrome,
  baselineReview,
  baselineLease,
  origins,
  leaseStatus,
  { ownershipProof = 'reviewed_prompt_grant' } = {}
) {
  chrome.__calls.length = 0;
  chrome.__state.originPermissions.clear();
  for (const origin of origins) chrome.__state.originPermissions.add(origin);
  const invalidReview = structuredClone(baselineReview);
  invalidReview.expiresAtMs += 1;
  const lease = structuredClone(baselineLease);
  lease.status = leaseStatus;
  lease.promptPendingUntil =
    leaseStatus === 'prompt_pending' ? new Date(Date.parse(lease.updatedAt) + 30_000).toISOString() : null;
  lease.ownershipProof = ownershipProof;
  lease.ownershipRevokedAt = null;
  lease.lastError = leaseStatus === 'release_pending' ? 'Retained for recovery.' : null;
  chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY] = invalidReview;
  chrome.__state.local[STORAGE_KEYS.permissionLease] = lease;
}

function assertNoMigrationMutation(chrome) {
  assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
  assert.equal(
    chrome.__calls.some((call) => call.api === 'permissions.remove'),
    false
  );
  assert.equal(
    chrome.__calls.some((call) => call.api === 'browsingData.remove'),
    false
  );
  assert.equal(
    chrome.__calls.some((call) => call.api === 'downloads.removeFile'),
    false
  );
}

function cleanupMutationCount(chrome) {
  return chrome.__calls.filter((call) =>
    [
      'browsingData.remove',
      'cookies.remove',
      'tabs.remove',
      'history.deleteUrl',
      'downloads.erase',
      'downloads.removeFile',
      'scripting.executeScript'
    ].includes(call.api)
  ).length;
}

function cleanupJobReservationCount(chrome) {
  return new Set(
    chrome.__calls
      .filter((call) => call.api === 'storage.local.set')
      .map((call) => call.args[0]?.[STORAGE_KEYS.activeJob]?.id)
      .filter(Boolean)
  ).size;
}

function dispatchWithLostPort(chrome, message, sender) {
  chrome.runtime.onMessage.emit(message, sender, () => {});
  return Promise.reject(new Error('The message port closed before a response was received.'));
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const startedAt = performance.now();
  while (!predicate()) {
    if (performance.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for handoff state.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

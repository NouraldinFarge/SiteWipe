import test from 'node:test';
import assert from 'node:assert/strict';
import { createChromeMock, createEvent } from '../helpers/chrome-mock.mjs';
import { DEFAULT_SETTINGS, MESSAGE_TYPES, STORAGE_KEYS } from '../../src/shared/constants.js';
import { normalizeCleanupReviewRecord } from '../../src/background/cleanup-preflight.js';
import { getPermissionLease } from '../../src/background/permission-leases.js';

test('abandoned permission-prompt rollback holds the sole lifecycle reservation through host-access settlement', async () => {
  const chrome = await createReadyChromeMock();
  globalThis.chrome = chrome;
  const releaseStarted = deferred();
  const releasePermissionRemoval = deferred();
  const originalPermissionRemove = chrome.permissions.remove;
  const originalPermissionRemovedEmit = chrome.__events.permissionRemoved.emit;
  const delayedSelfRemovalEvents = [];
  const originalGetWindow = chrome.windows.get;
  let reviewWindowInspections = 0;
  const startupRetryTimer = parkFirstLoadReadinessArmedCleanupRetry();
  try {
    await import(`../../src/background/service-worker.js?prompt-settlement-reservation=${uniqueImportKey()}`);
    await withTimeout(startupRetryTimer.parked, 'load-readiness armed-cleanup retry to park');
    startupRetryTimer.restore();
    assert.equal(
      startupRetryTimer.suppressed(),
      true,
      'the settlement-reservation test must park the load-readiness armed-cleanup retry'
    );
    const initiatingSender = popupSender(chrome, 'popup-document-abandoned-prompt');
    const { handoff } = await establishSyntheticOwnedPromptGrant(chrome, initiatingSender);
    chrome.permissions.remove = async (...args) => {
      releaseStarted.resolve();
      await releasePermissionRemoval.promise;
      chrome.__events.permissionRemoved.emit = (...eventArgs) => {
        delayedSelfRemovalEvents.push(structuredClone(eventArgs));
        return [];
      };
      try {
        return await originalPermissionRemove(...args);
      } finally {
        chrome.__events.permissionRemoved.emit = originalPermissionRemovedEmit;
      }
    };
    chrome.windows.get = async (...args) => {
      reviewWindowInspections += 1;
      return originalGetWindow(...args);
    };

    const settlementPromise = dispatchRuntimeMessageWithoutTimer(
      chrome,
      {
        type: MESSAGE_TYPES.settleCleanupPermissionHandoff,
        payload: {
          ...handoff.authority,
          outcome: 'abandoned'
        }
      },
      handoff.sender
    );
    await withTimeout(releaseStarted.promise, 'temporary permission release to start');
    const conflict = await dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    assert.equal(conflict.ok, false);
    assert.equal(conflict.errorCode, 'sitewipe_action_failed');
    assert.match(conflict.error, /settle target site access/i);
    assert.equal(reviewWindowInspections, 0);

    releasePermissionRemoval.resolve();
    const settled = await withTimeout(settlementPromise, 'permission-prompt settlement to finish');
    assert.equal(settled.ok, true, settled.error);
    assert.equal(settled.settlement.released, true);
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
    assert.equal(chrome.__state.session['sitewipe.cleanupReview.v1'], undefined);
    assert.equal(delayedSelfRemovalEvents.length, 1, 'the mock must retain exactly one delayed self-removal event');

    const inventoriesBeforeDelayedEvent = permissionInventoryCallCount(chrome);
    const [delayedRemoval] = delayedSelfRemovalEvents.shift();
    chrome.__events.permissionRemoved.emit({
      ...delayedRemoval,
      origins: [...delayedRemoval.origins, 'https://unrelated.invalid/*']
    });
    await waitFor(
      () => permissionInventoryCallCount(chrome) > inventoriesBeforeDelayedEvent,
      'the delayed self-removal event to trigger exact inventory reconciliation'
    );
    await flushMicrotasks();

    const recovered = await dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    assert.equal(recovered.ok, true, recovered.error);
    assert.equal(reviewWindowInspections, 1);
    assert.equal(cleanupMutationCallCount(chrome), 0);

    const secondApprovalTimer = suppressUndelayedTimeouts();
    let rearmed;
    try {
      rearmed = await dispatchRuntimeMessageWithoutTimer(
        chrome,
        armPreparedReviewMessage(recovered),
        popupSender(chrome)
      );
    } finally {
      secondApprovalTimer.restore();
    }
    assert.equal(rearmed.ok, true, rearmed.error);
    const secondHandoff = await openAndClaimPersistentPermissionHandoff(chrome, recovered, popupSender(chrome));
    const secondIntent = await dispatchRuntimeMessageWithoutTimer(
      chrome,
      { type: MESSAGE_TYPES.beginCleanupPermissionHandoff, payload: secondHandoff.authority },
      secondHandoff.sender
    );
    assert.equal(secondIntent.ok, true, secondIntent.error);

    const secondOrigins = [...recovered.review.temporaryHostPermissionOrigins];
    for (const origin of secondOrigins) chrome.__state.originPermissions.add(origin);
    chrome.__events.permissionAdded.emit({ origins: secondOrigins });
    const manuallyRemovedOrigin = secondOrigins[0];
    chrome.__state.originPermissions.delete(manuallyRemovedOrigin);
    chrome.__events.permissionRemoved.emit({ origins: [manuallyRemovedOrigin] });
    await waitFor(
      () => chrome.__state.session['sitewipe.cleanupReview.v1'] === undefined,
      'a later manual removal to invalidate the new reviewed authority'
    );
    assert.equal(
      chrome.__state.local[STORAGE_KEYS.permissionLease],
      undefined,
      'a later manual removal must be classified as external and discard its intersecting lease'
    );
  } finally {
    startupRetryTimer.restore();
    releasePermissionRemoval.resolve();
    chrome.__events.permissionRemoved.emit = originalPermissionRemovedEmit;
    delete globalThis.chrome;
  }
});

test('an undelivered self-removal event cannot absorb a later manual permission removal', async () => {
  const chrome = await createReadyChromeMock();
  globalThis.chrome = chrome;
  const originalPermissionRemove = chrome.permissions.remove;
  const originalPermissionRemovedEmit = chrome.__events.permissionRemoved.emit;
  const delayedSelfRemovalEvents = [];
  const startupRetryTimer = parkFirstLoadReadinessArmedCleanupRetry();
  try {
    await import(`../../src/background/service-worker.js?missing-self-removal-event=${uniqueImportKey()}`);
    await withTimeout(startupRetryTimer.parked, 'load-readiness armed-cleanup retry to park');
    startupRetryTimer.restore();
    assert.equal(startupRetryTimer.suppressed(), true);

    const initiatingSender = popupSender(chrome, 'popup-document-undelivered-self-removal');
    const { handoff } = await establishSyntheticOwnedPromptGrant(chrome, initiatingSender);
    chrome.permissions.remove = async (...args) => {
      chrome.__events.permissionRemoved.emit = (...eventArgs) => {
        delayedSelfRemovalEvents.push(structuredClone(eventArgs));
        return [];
      };
      try {
        return await originalPermissionRemove(...args);
      } finally {
        chrome.__events.permissionRemoved.emit = originalPermissionRemovedEmit;
      }
    };

    const settled = await dispatchRuntimeMessageWithoutTimer(
      chrome,
      {
        type: MESSAGE_TYPES.settleCleanupPermissionHandoff,
        payload: { ...handoff.authority, outcome: 'abandoned' }
      },
      handoff.sender
    );
    assert.equal(settled.ok, true, settled.error);
    assert.equal(settled.settlement.released, true);
    assert.equal(delayedSelfRemovalEvents.length, 1, 'the original self-removal event must remain undelivered');

    const recovered = await dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    assert.equal(recovered.ok, true, recovered.error);
    await armAndBeginPromptIntent(chrome, recovered, popupSender(chrome));

    const secondOrigins = [...recovered.review.temporaryHostPermissionOrigins];
    for (const origin of secondOrigins) chrome.__state.originPermissions.add(origin);
    chrome.__events.permissionAdded.emit({ origins: secondOrigins });
    const manuallyRemovedOrigin = secondOrigins[0];
    chrome.__state.originPermissions.delete(manuallyRemovedOrigin);
    chrome.__events.permissionRemoved.emit({ origins: [manuallyRemovedOrigin] });
    await waitFor(
      () => chrome.__state.session['sitewipe.cleanupReview.v1'] === undefined,
      'the later manual removal to invalidate the newly armed review'
    );
    assert.equal(
      chrome.__state.local[STORAGE_KEYS.permissionLease],
      undefined,
      'the later manual removal must be external even though the original self-removal event never arrived'
    );
    assert.equal(delayedSelfRemovalEvents.length, 1, 'the test must not consume the held self-removal event');
  } finally {
    startupRetryTimer.restore();
    chrome.__events.permissionRemoved.emit = originalPermissionRemovedEmit;
    delete globalThis.chrome;
  }
});

test('an unresolved removal generation blocks a same-origin successor and cannot transfer its event', async () => {
  const chrome = await createReadyChromeMock();
  globalThis.chrome = chrome;
  const originalPermissionRemove = chrome.permissions.remove;
  const originalPermissionRemovedEmit = chrome.__events.permissionRemoved.emit;
  const delayedSelfRemovalEvents = [];
  const startupRetryTimer = parkFirstLoadReadinessArmedCleanupRetry();
  try {
    await import(`../../src/background/service-worker.js?overlapping-self-removal-generation=${uniqueImportKey()}`);
    await withTimeout(startupRetryTimer.parked, 'load-readiness armed-cleanup retry to park');
    startupRetryTimer.restore();
    assert.equal(startupRetryTimer.suppressed(), true);

    const initiatingSender = popupSender(chrome, 'popup-document-removal-generation-a');
    const generationA = await establishSyntheticOwnedPromptGrant(chrome, initiatingSender);
    chrome.permissions.remove = async (...args) => {
      chrome.__events.permissionRemoved.emit = (...eventArgs) => {
        delayedSelfRemovalEvents.push(structuredClone(eventArgs));
        return [];
      };
      try {
        return await originalPermissionRemove(...args);
      } finally {
        chrome.__events.permissionRemoved.emit = originalPermissionRemovedEmit;
      }
    };
    const settledA = await dispatchRuntimeMessageWithoutTimer(
      chrome,
      {
        type: MESSAGE_TYPES.settleCleanupPermissionHandoff,
        payload: { ...generationA.handoff.authority, outcome: 'abandoned' }
      },
      generationA.handoff.sender
    );
    assert.equal(settledA.ok, true, settledA.error);
    assert.equal(settledA.settlement.released, true);
    assert.equal(delayedSelfRemovalEvents.length, 1);

    const recovered = await dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    assert.equal(recovered.ok, true, recovered.error);
    const generationB = await establishSyntheticOwnedPromptGrant(chrome, popupSender(chrome), recovered);
    const generationBOrigins = [...recovered.review.temporaryHostPermissionOrigins];
    chrome.__events.permissionAdded.emit({ origins: generationBOrigins });
    const removalsBeforeB = permissionRemovalCallCount(chrome);
    const settledB = await dispatchRuntimeMessageWithoutTimer(
      chrome,
      {
        type: MESSAGE_TYPES.settleCleanupPermissionHandoff,
        payload: { ...generationB.handoff.authority, outcome: 'abandoned' }
      },
      generationB.handoff.sender
    );
    assert.equal(permissionRemovalCallCount(chrome), removalsBeforeB, 'generation B must not start browser removal');
    assert.notEqual(settledB.settlement?.released, true);
    assert.ok(
      await getPermissionLease(chrome.storage.local),
      'generation B must retain its unreleased recovery record'
    );

    chrome.__events.permissionRemoved.emit(...delayedSelfRemovalEvents.shift());
    await waitFor(
      () =>
        chrome.__state.session['sitewipe.cleanupReview.v1'] === undefined &&
        chrome.__state.local[STORAGE_KEYS.permissionLease] === undefined,
      "generation A's delayed event to invalidate rather than transfer into generation B"
    );
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
    assert.deepEqual(
      chrome.__state.originPermissions,
      new Set(generationBOrigins),
      'an ambiguous old event must preserve the later externally regranted access'
    );
  } finally {
    startupRetryTimer.restore();
    chrome.__events.permissionRemoved.emit = originalPermissionRemovedEmit;
    delete globalThis.chrome;
  }
});

async function createReadyChromeMock() {
  const now = new Date().toISOString();
  return createChromeMock({
    localState: {
      [STORAGE_KEYS.settings]: readySettings(now)
    }
  });
}

let nextPermissionHandoffTabId = 60_000;
let nextPermissionHandoffContextId = 1;

async function establishSyntheticOwnedPromptGrant(chrome, initiatingSender, existingPrepared = null) {
  const prepared =
    existingPrepared || (await dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), initiatingSender));
  assert.equal(prepared.ok, true, prepared.error);
  const { handoff } = await armAndBeginPromptIntent(chrome, prepared, initiatingSender);
  const invocation = await dispatchRuntimeMessageWithoutTimer(
    chrome,
    { type: MESSAGE_TYPES.confirmCleanupPermissionHandoffInvocation, payload: handoff.authority },
    handoff.sender
  );
  assert.equal(invocation.ok, true, invocation.error);
  const armedRecord = chrome.__state.session['sitewipe.cleanupReview.v1'];
  const recordedAtMs = Math.max(
    Date.now(),
    armedRecord.approvalHandoff.armedAtMs,
    armedRecord.approvalHandoff.promptInvocation.recordedAtMs
  );
  const temporaryOrigins = [...armedRecord.hostPermissionInventory.requiredHostPermissionOrigins];
  chrome.__state.session['sitewipe.cleanupReview.v1'] = {
    ...armedRecord,
    approvalHandoff: {
      ...armedRecord.approvalHandoff,
      updatedAtMs: recordedAtMs,
      promptGrant: {
        observedOrigins: temporaryOrigins,
        complete: true,
        recordedAtMs
      },
      promptGrantOutcome: {
        popupContextId: handoff.contextId,
        granted: true,
        preRequestTemporaryOriginsAbsent: true,
        recordedAtMs
      }
    }
  };
  const lease = chrome.__state.local[STORAGE_KEYS.permissionLease];
  chrome.__state.local[STORAGE_KEYS.permissionLease] = {
    ...lease,
    ownershipProof: 'reviewed_prompt_grant',
    ownershipRevokedAt: null,
    updatedAt: new Date(recordedAtMs).toISOString()
  };
  assert.ok(
    normalizeCleanupReviewRecord(chrome.__state.session['sitewipe.cleanupReview.v1']),
    'the synthetic review must retain a valid complete prompt proof'
  );
  assert.ok(
    await getPermissionLease(chrome.storage.local),
    'the synthetic lease must retain valid reviewed-prompt ownership'
  );
  for (const origin of lease.temporaryOrigins) chrome.__state.originPermissions.add(origin);
  return { prepared, handoff, lease };
}

async function armAndBeginPromptIntent(chrome, prepared, initiatingSender) {
  const approvalTimer = suppressUndelayedTimeouts();
  let armed;
  try {
    armed = await dispatchRuntimeMessageWithoutTimer(chrome, armPreparedReviewMessage(prepared), initiatingSender);
  } finally {
    approvalTimer.restore();
  }
  assert.equal(approvalTimer.suppressed(), true, 'the settlement-reservation test must hold the automatic arm wake');
  assert.equal(armed.ok, true, armed.error);
  const handoff = await openAndClaimPersistentPermissionHandoff(chrome, prepared, initiatingSender);
  const intent = await dispatchRuntimeMessageWithoutTimer(
    chrome,
    { type: MESSAGE_TYPES.beginCleanupPermissionHandoff, payload: handoff.authority },
    handoff.sender
  );
  assert.equal(intent.ok, true, intent.error);
  return { armed, handoff };
}

function installPersistentPermissionHandoffTabSupport(chrome) {
  chrome.tabs.onRemoved ||= createEvent();
  chrome.tabs.create ||= async (properties) => {
    while (chrome.__state.tabs.has(nextPermissionHandoffTabId)) nextPermissionHandoffTabId += 1;
    const tab = {
      id: nextPermissionHandoffTabId,
      windowId: properties.windowId,
      active: properties.active === true,
      incognito: false,
      url: properties.url
    };
    nextPermissionHandoffTabId += 1;
    chrome.__calls.push({ api: 'tabs.create', args: [structuredClone(properties)] });
    chrome.__state.tabs.set(tab.id, structuredClone(tab));
    return structuredClone(tab);
  };
}

async function openAndClaimPersistentPermissionHandoff(chrome, prepared, initiatingSender) {
  installPersistentPermissionHandoffTabSupport(chrome);
  const opened = await dispatchRuntimeMessageWithoutTimer(
    chrome,
    {
      type: MESSAGE_TYPES.openCleanupPermissionHandoff,
      payload: {
        approvalToken: prepared.review.approvalToken,
        handoffNonce: prepared.review.approvalHandoffNonce,
        ...popupPreparationBinding(prepared)
      }
    },
    initiatingSender
  );
  assert.equal(opened.ok, true, opened.error);

  const tab = chrome.__state.tabs.get(opened.tabId);
  assert.ok(tab, 'the worker-created permission handoff tab must exist');
  const handoffUrl = chrome.runtime.getURL('handoff/handoff.html');
  const contextId = `settlement-permission-handoff-context-${nextPermissionHandoffContextId++}`;
  const documentId = `${contextId}-document`;
  chrome.__state.runtimeContexts.push({
    contextId,
    contextType: 'TAB',
    documentId,
    documentOrigin: chrome.runtime.getURL('').replace(/\/$/, ''),
    documentUrl: handoffUrl,
    frameId: 0,
    tabId: tab.id,
    windowId: tab.windowId,
    incognito: false
  });
  const sender = {
    id: chrome.runtime.id,
    url: handoffUrl,
    documentUrl: handoffUrl,
    documentId,
    origin: chrome.runtime.getURL('').replace(/\/$/, ''),
    frameId: 0,
    tab: { id: tab.id, windowId: tab.windowId, incognito: false, url: handoffUrl }
  };
  const claimed = await dispatchRuntimeMessageWithoutTimer(
    chrome,
    { type: MESSAGE_TYPES.claimCleanupPermissionHandoff, payload: {} },
    sender
  );
  assert.equal(claimed.ok, true, claimed.error);
  return {
    contextId,
    sender,
    authority: {
      handoffNonce: prepared.review.approvalHandoffNonce,
      handoffCapability: claimed.handoffCapability
    }
  };
}

function readySettings(now) {
  return {
    ...DEFAULT_SETTINGS,
    createdAt: now,
    updatedAt: now,
    stabilityDefaultsAppliedAt: now,
    performanceDefaultsAppliedAt: now,
    privacyDefaultsAppliedAt: now
  };
}

function prepareReviewMessage() {
  return {
    type: MESSAGE_TYPES.prepareCleanupReview,
    payload: {
      input: 'example.com',
      sourceWindowId: 1,
      sourceIncognito: false
    }
  };
}

function popupSender(chrome, documentId = null) {
  const sender = {
    id: chrome.runtime.id,
    url: chrome.runtime.getURL('popup/popup.html')
  };
  if (documentId) sender.documentId = documentId;
  return sender;
}

function armPreparedReviewMessage(prepared) {
  return {
    type: MESSAGE_TYPES.armCleanupApproval,
    payload: {
      approvalToken: prepared.review.approvalToken,
      handoffNonce: prepared.review.approvalHandoffNonce,
      approval: completeApproval(),
      ...popupPreparationBinding(prepared),
      sourceWindowId: 1,
      sourceIncognito: false
    }
  };
}

function popupPreparationBinding(prepared) {
  return {
    popupContextId: prepared.popupContextId,
    popupPreparationCapability: prepared.popupPreparationCapability
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

function dispatchRuntimeMessageWithoutTimer(chrome, message, sender) {
  return new Promise((resolve) => {
    const keepAlive = chrome.runtime.onMessage.emit(message, sender, resolve);
    assert.deepEqual(keepAlive, [true]);
  });
}

function cleanupMutationCallCount(chrome) {
  return chrome.__calls.filter((call) =>
    [
      'permissions.request',
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

function permissionInventoryCallCount(chrome) {
  return chrome.__calls.filter((call) => call.api === 'permissions.getAll').length;
}

function permissionRemovalCallCount(chrome) {
  return chrome.__calls.filter((call) => call.api === 'permissions.remove').length;
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function withTimeout(promise, label, timeoutMs = 10_000) {
  let timerId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timerId = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timerId !== undefined) clearTimeout(timerId);
  }
}

async function waitFor(predicate, label, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function flushMicrotasks(turns = 20) {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
}

function suppressUndelayedTimeouts() {
  const originalSetTimeout = globalThis.setTimeout;
  let didSuppress = false;
  globalThis.setTimeout = (callback, delay, ...args) => {
    // The arm wake is intentionally undelayed. Suppress every undelayed timer
    // scheduled during this narrowly scoped arm call so coverage/runtime
    // bookkeeping cannot consume a "next timer" interception first and let
    // the real wake race this settlement-reservation assertion.
    if (delay === undefined) {
      didSuppress = true;
      return 0;
    }
    return originalSetTimeout(callback, delay, ...args);
  };
  return {
    restore() {
      globalThis.setTimeout = originalSetTimeout;
    },
    suppressed() {
      return didSuppress;
    }
  };
}

function parkFirstLoadReadinessArmedCleanupRetry() {
  const originalSetTimeout = globalThis.setTimeout;
  const parked = deferred();
  let didSuppress = false;
  const interceptedSetTimeout = (callback, delay, ...args) => {
    const stack = new Error().stack || '';
    const isArmedCleanupRetry =
      delay === 40 &&
      stack.includes('resumeArmedCleanupAfterGrant') &&
      /[/\\]src[/\\]background[/\\]service-worker\.js(?:[?:]|$)/.test(stack);
    if (!didSuppress && isArmedCleanupRetry) {
      didSuppress = true;
      parked.resolve();
      return 0;
    }
    return originalSetTimeout(callback, delay, ...args);
  };
  globalThis.setTimeout = interceptedSetTimeout;
  return {
    parked: parked.promise,
    restore() {
      if (globalThis.setTimeout === interceptedSetTimeout) globalThis.setTimeout = originalSetTimeout;
    },
    suppressed() {
      return didSuppress;
    }
  };
}

function uniqueImportKey() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

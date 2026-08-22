import test from 'node:test';
import assert from 'node:assert/strict';
import { createChromeMock } from '../helpers/chrome-mock.mjs';
import { DEFAULT_SETTINGS, MESSAGE_TYPES, STORAGE_KEYS } from '../../src/shared/constants.js';
import {
  armCleanupReviewApprovalRequest,
  prepareCleanupReviewRequest
} from '../../src/background/cleanup-preflight.js';

test('immediate onInstalled maintenance forces a safety-proof generation before review', async () => {
  const chrome = await createReadyChromeMock();
  const installLeaseReadStarted = deferred();
  const releaseInstallLeaseRead = deferred();
  const originalLocalGet = chrome.storage.local.get;
  const originalAddInstalledListener = chrome.runtime.onInstalled.addListener;
  const originalGetWindow = chrome.windows.get;
  const originalGetSessionRules = chrome.declarativeNetRequest.getSessionRules;
  let blockedLeaseRead = false;
  let dnrReadCount = 0;
  let reviewWindowInspections = 0;
  chrome.storage.local.get = async (keys) => {
    if (!blockedLeaseRead && Array.isArray(keys) && keys.includes(STORAGE_KEYS.permissionLease)) {
      blockedLeaseRead = true;
      installLeaseReadStarted.resolve();
      await releaseInstallLeaseRead.promise;
    }
    return originalLocalGet(keys);
  };
  chrome.runtime.onInstalled.addListener = (listener) => {
    originalAddInstalledListener(listener);
    void listener({ reason: 'update' });
  };
  chrome.declarativeNetRequest.getSessionRules = async (...args) => {
    dnrReadCount += 1;
    return originalGetSessionRules(...args);
  };
  chrome.windows.get = async (...args) => {
    reviewWindowInspections += 1;
    return originalGetWindow(...args);
  };

  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?deferred-load-readiness=${uniqueImportKey()}`);
    await installLeaseReadStarted.promise;
    const reviewPromise = dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    await flushMicrotasks();
    assert.equal(reviewWindowInspections, 0);

    releaseInstallLeaseRead.resolve();
    const response = await reviewPromise;
    assert.equal(response.ok, true, response.error);
    assert.equal(reviewWindowInspections, 1);
    assert.ok(dnrReadCount >= 2, 'immediate install/update work must be followed by a complete safety proof');
    assert.equal(cleanupMutationCallCount(chrome), 0);
  } finally {
    releaseInstallLeaseRead.resolve();
    delete globalThis.chrome;
  }
});

test('an immediate review waits for delayed load recovery and wins before repeated wake maintenance', async () => {
  const chrome = await createReadyChromeMock();
  const firstDnrReadStarted = deferred();
  const releaseFirstDnrRead = deferred();
  const originalGetSessionRules = chrome.declarativeNetRequest.getSessionRules;
  const originalGetWindow = chrome.windows.get;
  const events = [];
  let dnrReadCount = 0;
  let dnrReadCountAtReview = 0;
  let reviewWindowInspections = 0;

  chrome.declarativeNetRequest.getSessionRules = async () => {
    dnrReadCount += 1;
    if (dnrReadCount === 1) {
      events.push('load-read-started');
      firstDnrReadStarted.resolve();
      await releaseFirstDnrRead.promise;
      events.push('load-read-settled');
    } else {
      events.push(`dnr-read-${dnrReadCount}`);
    }
    return originalGetSessionRules();
  };
  chrome.windows.get = async (...args) => {
    reviewWindowInspections += 1;
    dnrReadCountAtReview = dnrReadCount;
    events.push('review-window-inspection');
    return originalGetWindow(...args);
  };

  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?delayed-load-review=${uniqueImportKey()}`);
    await firstDnrReadStarted.promise;
    await chrome.storage.local.set({
      [STORAGE_KEYS.settings]: {
        ...chrome.__state.local[STORAGE_KEYS.settings],
        keepHistory: true,
        performanceDefaultsAppliedAt: null
      }
    });
    await chrome.__events.runtimeInstalled.emitAsync({ reason: 'update' });
    await chrome.__events.runtimeStartup.emitAsync();
    await chrome.__events.runtimeStartup.emitAsync();

    const reviewPromise = dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    await flushMicrotasks();
    assert.equal(reviewWindowInspections, 0, 'review work must not overlap service-worker-load maintenance');

    releaseFirstDnrRead.resolve();
    const response = await reviewPromise;
    assert.equal(response.ok, true, response.error);
    assert.equal(response.review.normalizedTarget, 'example.com');
    // A maintenance cycle performs its initial session-boundary rule read and
    // a final rule-set safety proof. Waiting for both ensures the deferred
    // replay has reached its synchronous settlement tail rather than merely
    // started its first DNR inspection.
    await waitForMicrotasks(() => dnrReadCount >= dnrReadCountAtReview + 2, 1_000);
    await flushMicrotasks(40);

    assert.ok(events.indexOf('load-read-settled') < events.indexOf('review-window-inspection'));
    assert.ok(events.indexOf('review-window-inspection') < events.indexOf(`dnr-read-${dnrReadCountAtReview + 1}`));
    assert.equal(chrome.__state.local[STORAGE_KEYS.settings].keepHistory, false);
    assert.ok(chrome.__state.local[STORAGE_KEYS.settings].performanceDefaultsAppliedAt);
    assert.equal(cleanupMutationCallCount(chrome), 0);
  } finally {
    releaseFirstDnrRead.resolve();
    delete globalThis.chrome;
  }
});

test('a deferred onInstalled migration failure remains queued and must succeed before retry admission', async () => {
  const chrome = await createReadyChromeMock();
  const loadReadStarted = deferred();
  const releaseLoadRead = deferred();
  const originalGetSessionRules = chrome.declarativeNetRequest.getSessionRules;
  const originalLocalSet = chrome.storage.local.set;
  const originalGetWindow = chrome.windows.get;
  let dnrReads = 0;
  let failMigrationWrite = true;
  let migrationWriteAttempts = 0;
  let reviewWindowInspections = 0;
  chrome.declarativeNetRequest.getSessionRules = async (...args) => {
    dnrReads += 1;
    if (dnrReads === 1) {
      loadReadStarted.resolve();
      await releaseLoadRead.promise;
    }
    return originalGetSessionRules(...args);
  };
  chrome.storage.local.set = async (values) => {
    if (values?.[STORAGE_KEYS.settings]?.performanceDefaultsAppliedAt) {
      migrationWriteAttempts += 1;
      if (failMigrationWrite) {
        failMigrationWrite = false;
        throw new Error('synthetic deferred update migration failure');
      }
    }
    return originalLocalSet(values);
  };
  chrome.windows.get = async (...args) => {
    reviewWindowInspections += 1;
    return originalGetWindow(...args);
  };

  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?retained-deferred-install=${uniqueImportKey()}`);
    await loadReadStarted.promise;
    await originalLocalSet({
      [STORAGE_KEYS.settings]: {
        ...chrome.__state.local[STORAGE_KEYS.settings],
        keepHistory: true,
        performanceDefaultsAppliedAt: null
      }
    });
    await chrome.__events.runtimeInstalled.emitAsync({ reason: 'update' });
    const firstReviewPromise = dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    releaseLoadRead.resolve();
    const firstReview = await firstReviewPromise;
    assert.equal(firstReview.ok, false);
    assert.equal(firstReview.errorCode, 'lifecycle_not_ready');
    assert.equal(reviewWindowInspections, 0);
    assert.equal(chrome.__state.local[STORAGE_KEYS.settings].keepHistory, true);

    const retry = await dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    assert.equal(retry.ok, true, retry.error);
    assert.equal(reviewWindowInspections, 1);
    assert.equal(migrationWriteAttempts, 2, 'the failed install migration must remain queued for the retry');
    assert.equal(chrome.__state.local[STORAGE_KEYS.settings].keepHistory, false);
    assert.ok(chrome.__state.local[STORAGE_KEYS.settings].performanceDefaultsAppliedAt);
    assert.equal(cleanupMutationCallCount(chrome), 0);
  } finally {
    releaseLoadRead.resolve();
    delete globalThis.chrome;
  }
});

test('a fresh worker reconstructs lost update migration intent from durable missing markers', async () => {
  const firstChrome = await createReadyChromeMock();
  globalThis.chrome = firstChrome;
  try {
    await import(`../../src/background/service-worker.js?failed-update-before-restart=${uniqueImportKey()}`);
    const prepared = await dispatchRuntimeMessageWithoutTimer(
      firstChrome,
      prepareReviewMessage(),
      popupSender(firstChrome)
    );
    assert.equal(prepared.ok, true, prepared.error);
    const canceled = await dispatchRuntimeMessageWithoutTimer(
      firstChrome,
      {
        type: MESSAGE_TYPES.cancelCleanupReview,
        payload: {
          approvalToken: prepared.review.approvalToken,
          ...popupPreparationBinding(prepared),
          promptNotStarted: true
        }
      },
      popupSender(firstChrome)
    );
    assert.equal(canceled.ok, true, canceled.error);

    const originalFirstSet = firstChrome.storage.local.set;
    await originalFirstSet({
      [STORAGE_KEYS.settings]: {
        ...firstChrome.__state.local[STORAGE_KEYS.settings],
        keepHistory: true,
        includeProtectedWebOrigins: true,
        mainWorldPageScrub: true,
        storageBucketScrub: true,
        exhaustiveCookieStoreScan: true,
        stabilityDefaultsAppliedAt: null,
        performanceDefaultsAppliedAt: null
      }
    });
    let failedMigrationWrites = 0;
    firstChrome.storage.local.set = async (values) => {
      const settings = values?.[STORAGE_KEYS.settings];
      if (settings?.stabilityDefaultsAppliedAt && settings?.performanceDefaultsAppliedAt) {
        failedMigrationWrites += 1;
        throw new Error('synthetic update migration write failure before worker restart');
      }
      return originalFirstSet(values);
    };
    await firstChrome.__events.runtimeInstalled.emitAsync({ reason: 'update' });
    assert.equal(failedMigrationWrites, 1);
    assert.equal(firstChrome.__state.local[STORAGE_KEYS.settings].stabilityDefaultsAppliedAt, null);
    assert.equal(firstChrome.__state.local[STORAGE_KEYS.settings].performanceDefaultsAppliedAt, null);
  } finally {
    delete globalThis.chrome;
  }

  const restartedChrome = await createChromeMock({
    localState: structuredClone(firstChrome.__state.local),
    sessionState: structuredClone(firstChrome.__state.session)
  });
  const migrationWriteStarted = deferred();
  const releaseMigrationWrite = deferred();
  const originalRestartedSet = restartedChrome.storage.local.set;
  const originalGetWindow = restartedChrome.windows.get;
  let reviewWindowInspections = 0;
  restartedChrome.storage.local.set = async (values) => {
    const settings = values?.[STORAGE_KEYS.settings];
    if (settings?.stabilityDefaultsAppliedAt && settings?.performanceDefaultsAppliedAt) {
      migrationWriteStarted.resolve();
      await releaseMigrationWrite.promise;
    }
    return originalRestartedSet(values);
  };
  restartedChrome.windows.get = async (...args) => {
    reviewWindowInspections += 1;
    return originalGetWindow(...args);
  };

  globalThis.chrome = restartedChrome;
  try {
    await import(`../../src/background/service-worker.js?restart-reconstructs-update=${uniqueImportKey()}`);
    await migrationWriteStarted.promise;
    const reviewPromise = dispatchRuntimeMessageWithoutTimer(
      restartedChrome,
      prepareReviewMessage(),
      popupSender(restartedChrome)
    );
    await flushMicrotasks();
    assert.equal(reviewWindowInspections, 0, 'review must wait until both durable migration markers are saved');

    releaseMigrationWrite.resolve();
    const review = await reviewPromise;
    assert.equal(review.ok, true, review.error);
    assert.equal(reviewWindowInspections, 1);
    const settings = restartedChrome.__state.local[STORAGE_KEYS.settings];
    assert.ok(settings.stabilityDefaultsAppliedAt);
    assert.ok(settings.performanceDefaultsAppliedAt);
    assert.equal(settings.keepHistory, false);
    assert.equal(settings.includeProtectedWebOrigins, false);
    assert.equal(settings.mainWorldPageScrub, false);
    assert.equal(settings.storageBucketScrub, false);
    assert.equal(settings.exhaustiveCookieStoreScan, false);
    assert.equal(cleanupMutationCallCount(restartedChrome), 0);
  } finally {
    releaseMigrationWrite.resolve();
    delete globalThis.chrome;
  }
});

for (const candidate of [
  {
    name: 'local report-expiration read',
    installHang(chrome, started) {
      const original = chrome.storage.local.get;
      let blocked = false;
      chrome.storage.local.get = async (keys) => {
        if (
          !blocked &&
          Array.isArray(keys) &&
          keys.includes(STORAGE_KEYS.activeReport) &&
          keys.includes(STORAGE_KEYS.settings)
        ) {
          blocked = true;
          started.resolve();
          return new Promise(() => {});
        }
        return original(keys);
      };
    }
  },
  {
    name: 'session storage read',
    installHang(chrome, started) {
      const original = chrome.storage.session.get;
      let calls = 0;
      chrome.storage.session.get = async (...args) => {
        calls += 1;
        if (calls === 1) {
          started.resolve();
          return new Promise(() => {});
        }
        return original(...args);
      };
    }
  },
  {
    name: 'DNR diagnostics read',
    installHang(chrome, started) {
      const original = chrome.declarativeNetRequest.getSessionRules;
      let calls = 0;
      chrome.declarativeNetRequest.getSessionRules = async (...args) => {
        calls += 1;
        if (calls === 1) {
          started.resolve();
          return new Promise(() => {});
        }
        return original(...args);
      };
    }
  }
]) {
  test(`a never-settling ${candidate.name} fails readiness truthfully and a fresh generation is required`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const chrome = await createReadyChromeMock();
    const candidateStarted = deferred();
    candidate.installHang(chrome, candidateStarted);
    const originalGetWindow = chrome.windows.get;
    let reviewWindowInspections = 0;
    chrome.windows.get = async (...args) => {
      reviewWindowInspections += 1;
      return originalGetWindow(...args);
    };

    globalThis.chrome = chrome;
    try {
      await import(
        `../../src/background/service-worker.js?never-settling-${slug(candidate.name)}=${uniqueImportKey()}`
      );
      await candidateStarted.promise;
      const firstAttemptPromise = dispatchRuntimeMessageWithoutTimer(
        chrome,
        prepareReviewMessage(),
        popupSender(chrome)
      );
      let firstAttempt = null;
      void firstAttemptPromise.then((response) => {
        firstAttempt = response;
      });
      await flushMicrotasks();
      assert.equal(reviewWindowInspections, 0);

      t.mock.timers.tick(5_000);
      await flushMicrotasks(40);
      assert.ok(firstAttempt, 'the bounded startup candidate must settle the waiting review');
      assert.equal(firstAttempt.ok, false);
      assert.equal(firstAttempt.errorCode, 'lifecycle_not_ready');
      assert.equal(firstAttempt.retryable, true);
      assert.match(firstAttempt.error, /no cleanup was admitted/i);
      assert.equal(reviewWindowInspections, 0, 'failed readiness must not admit the first review');
      if (candidate.name === 'session storage read') {
        assert.equal(
          chrome.__calls.filter((call) => call.api === 'declarativeNetRequest.updateSessionRules').length,
          0,
          'an unknown session-marker read must fail before any DNR mutation starts'
        );
      }

      await flushMicrotasks(20);
      const retryPromise = dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
      let retry = null;
      void retryPromise.then((response) => {
        retry = response;
      });
      await driveZeroDelayTimers(t, () => Boolean(retry));
      assert.ok(retry, 'the fresh readiness generation and original retry must settle');
      assert.equal(retry.ok, true, retry.error);
      assert.equal(reviewWindowInspections, 1, 'a successful fresh recovery generation admits the retry once');
      assert.equal(cleanupMutationCallCount(chrome), 0);
    } finally {
      delete globalThis.chrome;
    }
  });
}

test('a never-settling stale-job mutation reread is bounded before any recovery write or cleanup admission', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const now = new Date().toISOString();
  const runningJob = {
    id: 'bounded-stale-job-reread',
    status: 'running',
    targetDomain: '[redacted-target]',
    startedAt: now,
    updatedAt: now,
    percent: 20,
    phase: 'synthetic-running',
    label: 'Synthetic running cleanup',
    detail: '',
    cancelRequested: false
  };
  const chrome = await createChromeMock({
    localState: {
      [STORAGE_KEYS.settings]: readySettings(now),
      [STORAGE_KEYS.activeJob]: runningJob
    }
  });
  const mutationReadStarted = deferred();
  const originalLocalGet = chrome.storage.local.get;
  let activeJobReadCount = 0;
  chrome.storage.local.get = async (keys) => {
    if (Array.isArray(keys) && keys.length === 1 && keys[0] === STORAGE_KEYS.activeJob) {
      activeJobReadCount += 1;
      // The first read belongs to shield expiration, the second to stale-job
      // inspection, and the third is the serialized pre-write/CAS reread.
      if (activeJobReadCount === 3) {
        mutationReadStarted.resolve();
        return new Promise(() => {});
      }
    }
    return originalLocalGet(keys);
  };
  const originalGetWindow = chrome.windows.get;
  let reviewWindowInspections = 0;
  chrome.windows.get = async (...args) => {
    reviewWindowInspections += 1;
    return originalGetWindow(...args);
  };

  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?bounded-active-job-reread=${uniqueImportKey()}`);
    await mutationReadStarted.promise;
    const reviewPromise = dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    let response = null;
    void reviewPromise.then((value) => {
      response = value;
    });

    t.mock.timers.tick(5_000);
    await flushMicrotasks(50);
    assert.ok(response, 'the bounded mutation reread must release startup readiness');
    assert.equal(response.ok, false);
    assert.equal(response.errorCode, 'lifecycle_not_ready');
    assert.match(response.error, /stale-job-recovery|no cleanup was admitted/i);
    assert.equal(reviewWindowInspections, 0);
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob].status, 'running');
    assert.equal(cleanupMutationCallCount(chrome), 0);
  } finally {
    delete globalThis.chrome;
  }
});

test('a successful readiness retry re-drives an already granted armed handoff without another popup action', async (t) => {
  const fixture = await createArmedHandoffFixture('readiness-retry-resume');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const chrome = await createChromeMock({
    localState: fixture.localState,
    sessionState: fixture.sessionState,
    originPermissions: fixture.temporaryOrigins
  });
  const firstSessionReadStarted = deferred();
  const originalSessionGet = chrome.storage.session.get;
  let sessionReadCount = 0;
  chrome.storage.session.get = async (...args) => {
    sessionReadCount += 1;
    if (sessionReadCount === 1) {
      firstSessionReadStarted.resolve();
      return new Promise(() => {});
    }
    return originalSessionGet(...args);
  };
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?readiness-retry-resume=${uniqueImportKey()}`);
    await firstSessionReadStarted.promise;
    const firstAttemptPromise = dispatchRuntimeMessageWithoutTimer(
      chrome,
      prepareReviewMessage(),
      popupSender(chrome, 'popup-document-readiness-first-attempt')
    );
    let firstAttempt = null;
    void firstAttemptPromise.then((value) => {
      firstAttempt = value;
    });
    t.mock.timers.tick(5_000);
    await flushMicrotasks(50);
    assert.ok(firstAttempt);
    assert.equal(firstAttempt.ok, false);
    assert.equal(firstAttempt.errorCode, 'lifecycle_not_ready');

    // No new onAdded event and no resumeArmedCleanup message are emitted. This
    // ordinary popup retry only causes a fresh readiness generation; that
    // generation must wake the already durable one-click handoff itself.
    t.mock.timers.reset();
    const retryPromise = dispatchRuntimeMessageWithoutTimer(
      chrome,
      prepareReviewMessage(),
      popupSender(chrome, 'popup-document-readiness-retry')
    );
    const retryResponse = await retryPromise;
    await waitForWallClock(
      () =>
        ['completed', 'failed', 'cancelled', 'interrupted'].includes(
          chrome.__state.local[STORAGE_KEYS.activeJob]?.status
        ),
      5_000
    );

    // The automatic cleanup and the retry are both admitted immediately after
    // the fresh proof. If cleanup wins, the retry can truthfully prepare a new
    // read-only review after completion; clear only that test artifact.
    const remainingReview = chrome.__state.session['sitewipe.cleanupReview.v1'];
    if (remainingReview && remainingReview.token !== fixture.sessionState['sitewipe.cleanupReview.v1'].token) {
      const canceledRetryReview = await dispatchRuntimeMessageWithoutTimer(
        chrome,
        {
          type: MESSAGE_TYPES.cancelCleanupReview,
          payload: {
            approvalToken: remainingReview.token,
            ...popupPreparationBinding(retryResponse),
            promptNotStarted: true
          }
        },
        popupSender(chrome, 'popup-document-readiness-retry')
      );
      assert.equal(canceledRetryReview.ok, true, canceledRetryReview.error);
    }

    assert.ok(retryResponse, 'the popup retry must settle after the fresh readiness proof');
    assert.equal(
      chrome.__state.local[STORAGE_KEYS.activeJob]?.status,
      'completed',
      retryResponse?.error || 'the durable handoff was not resumed after readiness recovered'
    );
    assert.equal(chrome.__state.session['sitewipe.cleanupReview.v1'], undefined);
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
    assert.deepEqual(chrome.__state.originPermissions, new Set());
    assert.equal(
      chrome.__calls.some((call) => call.api === 'downloads.removeFile'),
      false
    );
  } finally {
    delete globalThis.chrome;
  }
});

test('a final click stages before slow early maintenance and completes once after settlement', async (t) => {
  const chrome = await createReadyChromeMock();
  const maintenanceReadStarted = deferred();
  const releaseMaintenanceRead = deferred();
  const originalGetSessionRules = chrome.declarativeNetRequest.getSessionRules;
  let holdMaintenanceRead = false;
  chrome.declarativeNetRequest.getSessionRules = async (...args) => {
    if (holdMaintenanceRead) {
      holdMaintenanceRead = false;
      maintenanceReadStarted.resolve();
      await releaseMaintenanceRead.promise;
    }
    return originalGetSessionRules(...args);
  };

  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?ordinary-maintenance-peer=${uniqueImportKey()}`);
    const initialReview = await dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    assert.equal(initialReview.ok, true, initialReview.error);
    const canceled = await dispatchRuntimeMessageWithoutTimer(
      chrome,
      {
        type: MESSAGE_TYPES.cancelCleanupReview,
        payload: {
          approvalToken: initialReview.review.approvalToken,
          ...popupPreparationBinding(initialReview),
          promptNotStarted: true
        }
      },
      popupSender(chrome)
    );
    assert.equal(canceled.ok, true, canceled.error);

    const sender = popupSender(chrome, 'popup-document-slow-pre-arm-owner');
    const prepared = await dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), sender);
    assert.equal(prepared.ok, true, prepared.error);
    holdMaintenanceRead = true;
    const maintenance = chrome.__events.alarm.emitAsync({ name: 'sitewipe.maintenance' });
    await maintenanceReadStarted.promise;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const permissionRequest = chrome.permissions.request({
      origins: prepared.review.temporaryHostPermissionOrigins
    });
    const armPromise = dispatchRuntimeMessageWithoutTimer(
      chrome,
      {
        type: MESSAGE_TYPES.armCleanupApproval,
        payload: {
          approvalToken: prepared.review.approvalToken,
          handoffNonce: prepared.review.approvalHandoffNonce,
          approval: completeApproval(),
          ...popupPreparationBinding(prepared),
          sourceWindowId: 1,
          sourceIncognito: false
        }
      },
      sender
    );
    let armResponse = null;
    void armPromise.then((response) => {
      armResponse = response;
    });
    await driveZeroDelayTimers(
      t,
      () => chrome.__state.session['sitewipe.cleanupReview.v1']?.approvalHandoff?.status === 'arming',
      500
    );

    const duplicateDocument = await dispatchRuntimeMessageWithoutTimer(
      chrome,
      {
        type: MESSAGE_TYPES.armCleanupApproval,
        payload: {
          approvalToken: prepared.review.approvalToken,
          handoffNonce: prepared.review.approvalHandoffNonce,
          approval: completeApproval(),
          ...popupPreparationBinding(prepared),
          sourceWindowId: 1,
          sourceIncognito: false
        }
      },
      popupSender(chrome, 'popup-document-slow-pre-arm-duplicate')
    );
    assert.equal(duplicateDocument.ok, false);
    assert.match(duplicateDocument.error, /already continuing|no longer matches/i);

    await flushMicrotasks(50);
    t.mock.timers.tick(8_000);
    await flushMicrotasks(50);
    assert.ok(armResponse, 'the bounded arm handoff must return after its peer wait expires');
    assert.equal(armResponse.ok, false);
    assert.equal(armResponse.errorCode, 'lifecycle_not_ready');
    assert.equal(chrome.__state.session['sitewipe.cleanupReview.v1']?.approvalHandoff?.status, 'arming');
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease]?.status, 'prompt_pending');
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);

    t.mock.timers.reset();
    releaseMaintenanceRead.resolve();
    assert.equal(await permissionRequest, true);
    await maintenance;
    await waitForWallClock(
      () =>
        ['completed', 'failed', 'cancelled', 'interrupted'].includes(
          chrome.__state.local[STORAGE_KEYS.activeJob]?.status
        ),
      5_000
    );

    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob]?.status, 'completed');
    assert.equal(
      chrome.__state.local[STORAGE_KEYS.activeJob]?.approvalHandoffNonce,
      prepared.review.approvalHandoffNonce
    );
    assert.equal(chrome.__state.session['sitewipe.cleanupReview.v1'], undefined);
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
    assert.deepEqual(chrome.__state.originPermissions, new Set());
    assert.equal(
      chrome.__calls.filter((call) => call.api === 'browsingData.remove').length,
      2,
      'one Standard cleanup uses the two reviewed origin-data removal batches'
    );
    assert.equal(
      chrome.__calls.some((call) => call.api === 'downloads.removeFile'),
      false
    );
  } finally {
    t.mock.timers.reset();
    releaseMaintenanceRead.resolve();
    delete globalThis.chrome;
  }
});

test('a conclusive native denial clears a staged arm after its lifecycle handoff times out', async (t) => {
  const chrome = await createReadyChromeMock();
  const maintenanceReadStarted = deferred();
  const releaseMaintenanceRead = deferred();
  const originalGetSessionRules = chrome.declarativeNetRequest.getSessionRules;
  let holdMaintenanceRead = false;
  chrome.declarativeNetRequest.getSessionRules = async (...args) => {
    if (holdMaintenanceRead) {
      holdMaintenanceRead = false;
      maintenanceReadStarted.resolve();
      await releaseMaintenanceRead.promise;
    }
    return originalGetSessionRules(...args);
  };

  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?denied-slow-arm-peer=${uniqueImportKey()}`);
    const initialSender = popupSender(chrome, 'popup-document-denied-initial');
    const initialReview = await dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), initialSender);
    assert.equal(initialReview.ok, true, initialReview.error);
    const canceled = await dispatchRuntimeMessageWithoutTimer(
      chrome,
      {
        type: MESSAGE_TYPES.cancelCleanupReview,
        payload: {
          approvalToken: initialReview.review.approvalToken,
          ...popupPreparationBinding(initialReview),
          promptNotStarted: true
        }
      },
      initialSender
    );
    assert.equal(canceled.ok, true, canceled.error);

    const sender = popupSender(chrome, 'popup-document-denied-slow-arm');
    const prepared = await dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), sender);
    assert.equal(prepared.ok, true, prepared.error);
    holdMaintenanceRead = true;
    const maintenance = chrome.__events.alarm.emitAsync({ name: 'sitewipe.maintenance' });
    await maintenanceReadStarted.promise;

    t.mock.timers.enable({ apis: ['setTimeout'] });
    const armPromise = dispatchRuntimeMessageWithoutTimer(
      chrome,
      {
        type: MESSAGE_TYPES.armCleanupApproval,
        payload: {
          approvalToken: prepared.review.approvalToken,
          handoffNonce: prepared.review.approvalHandoffNonce,
          approval: completeApproval(),
          ...popupPreparationBinding(prepared),
          sourceWindowId: 1,
          sourceIncognito: false
        }
      },
      sender
    );
    await driveZeroDelayTimers(
      t,
      () => chrome.__state.session['sitewipe.cleanupReview.v1']?.approvalHandoff?.status === 'arming',
      500
    );

    // This is the service-worker half of Chrome resolving the popup's native
    // permissions.request promise to false. No onAdded event or grant exists.
    const denialPromise = dispatchRuntimeMessageWithoutTimer(
      chrome,
      {
        type: MESSAGE_TYPES.settleCleanupPermissionPrompt,
        payload: {
          approvalToken: prepared.review.approvalToken,
          handoffNonce: prepared.review.approvalHandoffNonce,
          permissionLeaseId: prepared.review.permissionLeaseId,
          ...popupPreparationBinding(prepared),
          outcome: 'denied'
        }
      },
      sender
    );
    let armResponse = null;
    let denialResponse = null;
    void armPromise.then((response) => {
      armResponse = response;
    });
    void denialPromise.then((response) => {
      denialResponse = response;
    });
    await flushMicrotasks(50);
    t.mock.timers.tick(8_000);
    await flushMicrotasks(80);
    assert.equal(armResponse?.ok, false);
    assert.equal(armResponse?.errorCode, 'lifecycle_not_ready');
    assert.equal(denialResponse?.ok, false);
    assert.equal(denialResponse?.errorCode, 'lifecycle_not_ready');
    assert.equal(chrome.__state.session['sitewipe.cleanupReview.v1']?.approvalHandoff?.status, 'arming');
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease]?.status, 'prompt_pending');

    t.mock.timers.reset();
    releaseMaintenanceRead.resolve();
    await maintenance;
    await waitForWallClock(
      () =>
        chrome.__state.session['sitewipe.cleanupReview.v1'] === undefined &&
        chrome.__state.local[STORAGE_KEYS.permissionLease] === undefined,
      5_000
    );

    assert.deepEqual(chrome.__state.originPermissions, new Set());
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
    assert.equal(cleanupMutationCallCount(chrome), 0);
    assert.equal(
      chrome.__calls.some((call) => call.api === 'downloads.removeFile'),
      false
    );
  } finally {
    t.mock.timers.reset();
    releaseMaintenanceRead.resolve();
    delete globalThis.chrome;
  }
});

test('a staged final click waits for an exact administrative peer and auto-runs after release', async () => {
  const chrome = await createReadyChromeMock();
  const adminWriteStarted = deferred();
  const releaseAdminWrite = deferred();
  const originalLocalSet = chrome.storage.local.set;
  let holdDebugClear = false;
  chrome.storage.local.set = async (patch) => {
    if (holdDebugClear && Array.isArray(patch?.[STORAGE_KEYS.debugLog])) {
      holdDebugClear = false;
      adminWriteStarted.resolve();
      await releaseAdminWrite.promise;
    }
    return originalLocalSet(patch);
  };

  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?staged-admin-peer=${uniqueImportKey()}`);
    const sender = popupSender(chrome, 'popup-document-staged-admin-peer');
    const prepared = await dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), sender);
    assert.equal(prepared.ok, true, prepared.error);

    holdDebugClear = true;
    const adminPromise = dispatchRuntimeMessageWithoutTimer(
      chrome,
      { type: MESSAGE_TYPES.clearDebugLog, payload: {} },
      optionsSender(chrome)
    );
    await adminWriteStarted.promise;

    const permissionRequest = chrome.permissions.request({
      origins: prepared.review.temporaryHostPermissionOrigins
    });
    const armPromise = dispatchRuntimeMessageWithoutTimer(
      chrome,
      {
        type: MESSAGE_TYPES.armCleanupApproval,
        payload: {
          approvalToken: prepared.review.approvalToken,
          handoffNonce: prepared.review.approvalHandoffNonce,
          approval: completeApproval(),
          ...popupPreparationBinding(prepared),
          sourceWindowId: 1,
          sourceIncognito: false
        }
      },
      sender
    );
    await waitForWallClock(
      () => chrome.__state.session['sitewipe.cleanupReview.v1']?.approvalHandoff?.status === 'arming',
      500
    );
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);

    releaseAdminWrite.resolve();
    const [adminResponse, granted, armed] = await Promise.all([adminPromise, permissionRequest, armPromise]);
    assert.equal(adminResponse.ok, true, adminResponse.error);
    assert.equal(granted, true);
    assert.equal(armed.ok, true, armed.error);
    await waitForWallClock(() => chrome.__state.local[STORAGE_KEYS.activeJob]?.status === 'completed', 5_000);

    assert.equal(
      chrome.__state.local[STORAGE_KEYS.activeJob]?.approvalHandoffNonce,
      prepared.review.approvalHandoffNonce
    );
    assert.equal(chrome.__state.session['sitewipe.cleanupReview.v1'], undefined);
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
    assert.deepEqual(chrome.__state.originPermissions, new Set());
    assert.equal(chrome.__calls.filter((call) => call.api === 'browsingData.remove').length, 2);
    assert.equal(
      chrome.__calls.some((call) => call.api === 'downloads.removeFile'),
      false
    );
  } finally {
    releaseAdminWrite.resolve();
    delete globalThis.chrome;
  }
});

test('a never-settling alarm mutation is detached from readiness and serializes every later deadline', async () => {
  const chrome = await createReadyChromeMock();
  const firstAlarmStarted = deferred();
  const releaseFirstAlarm = deferred();
  const originalCreateAlarm = chrome.alarms.create;
  const events = [];
  let createCalls = 0;
  chrome.alarms.create = async (...args) => {
    createCalls += 1;
    events.push(`alarm-${createCalls}-started`);
    if (createCalls === 1) {
      firstAlarmStarted.resolve();
      await releaseFirstAlarm.promise;
      events.push('alarm-1-settled');
    }
    return originalCreateAlarm(...args);
  };

  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?detached-alarm-queue=${uniqueImportKey()}`);
    await firstAlarmStarted.promise;
    const response = await dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    assert.equal(response.ok, true, response.error);
    assert.equal(createCalls, 1, 'a newer alarm deadline must remain queued behind the unresolved mutation');
    assert.equal(cleanupMutationCallCount(chrome), 0);

    releaseFirstAlarm.resolve();
    await waitForMicrotasks(() => createCalls >= 2);
    assert.ok(events.indexOf('alarm-1-settled') < events.indexOf('alarm-2-started'));
  } finally {
    releaseFirstAlarm.resolve();
    delete globalThis.chrome;
  }
});

test('a never-settling permissions.remove is absent from load readiness and cannot block review', async () => {
  const chrome = await createReadyChromeMock();
  let permissionRemovalCalls = 0;
  chrome.permissions.remove = async () => {
    permissionRemovalCalls += 1;
    return new Promise(() => {});
  };
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?permission-remove-off-load-path=${uniqueImportKey()}`);
    const response = await dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    assert.equal(response.ok, true, response.error);
    assert.equal(permissionRemovalCalls, 0);
    assert.equal(cleanupMutationCallCount(chrome), 0);
  } finally {
    delete globalThis.chrome;
  }
});

test('persistent owned DNR recovery failure keeps readiness poisoned and never admits review', async () => {
  const now = new Date().toISOString();
  const chrome = await createChromeMock({
    dnrRules: [syntheticDnrRule(730000, '||persistent.example^')],
    localState: {
      [STORAGE_KEYS.settings]: readySettings(now),
      [STORAGE_KEYS.activeShield]: {
        domain: 'persistent.example',
        displayName: 'persistent.example',
        associatedTargets: [],
        ruleIds: [730000],
        urlFilters: ['||persistent.example^'],
        mode: 'cleanup-only',
        lifecycle: 'unknown',
        pendingMutation: false,
        expiresAt: null,
        startedAt: now,
        jobId: 'persistent-shield-job'
      }
    }
  });
  const originalGetWindow = chrome.windows.get;
  let reviewWindowInspections = 0;
  let dnrMutationCalls = 0;
  chrome.declarativeNetRequest.updateSessionRules = async (details) => {
    dnrMutationCalls += 1;
    chrome.__calls.push({ api: 'declarativeNetRequest.updateSessionRules', args: [structuredClone(details)] });
    // Chrome settles but deliberately leaves the owned rule installed.
  };
  chrome.windows.get = async (...args) => {
    reviewWindowInspections += 1;
    return originalGetWindow(...args);
  };

  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?persistent-dnr-failure=${uniqueImportKey()}`);
    const response = await dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    assert.equal(response.ok, false);
    assert.equal(response.errorCode, 'lifecycle_not_ready');
    assert.match(response.error, /safety-proof/i);
    assert.equal(reviewWindowInspections, 0);
    await flushMicrotasks(20);
    const retry = await dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    assert.equal(retry.ok, false);
    assert.equal(retry.errorCode, 'lifecycle_not_ready');
    assert.ok(dnrMutationCalls >= 2, 'the explicit retry must perform a fresh recovery proof');
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeShield].lifecycle, 'unknown');
    assert.equal(cleanupMutationCallCount(chrome), 0);
  } finally {
    delete globalThis.chrome;
  }
});

test('manual shield repair bypasses failed readiness without overlapping cleanup and then proves review safe', async () => {
  const now = new Date().toISOString();
  const chrome = await createChromeMock({
    dnrRules: [syntheticDnrRule(730000, '||manual-repair.example^')],
    localState: {
      [STORAGE_KEYS.settings]: {
        ...readySettings(now),
        autoRepairOrphanedShields: false
      }
    }
  });
  const mutationStarted = deferred();
  const releaseMutation = deferred();
  const originalUpdateRules = chrome.declarativeNetRequest.updateSessionRules;
  let delayRepairMutation = false;
  chrome.declarativeNetRequest.updateSessionRules = async (...args) => {
    if (delayRepairMutation) {
      delayRepairMutation = false;
      mutationStarted.resolve();
      await releaseMutation.promise;
    }
    return originalUpdateRules(...args);
  };

  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?manual-repair-bypass=${uniqueImportKey()}`);
    const blocked = await dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.errorCode, 'lifecycle_not_ready');
    assert.equal(chrome.__state.dnrRules.length, 1);

    delayRepairMutation = true;
    const repairPromise = dispatchRuntimeMessageWithoutTimer(
      chrome,
      { type: MESSAGE_TYPES.repairActiveShield, payload: {} },
      optionsSender(chrome)
    );
    await mutationStarted.promise;
    const conflictingCleanup = await dispatchRuntimeMessageWithoutTimer(
      chrome,
      prepareReviewMessage(),
      popupSender(chrome)
    );
    assert.equal(conflictingCleanup.ok, false);
    assert.match(conflictingCleanup.error, /still trying to repair the request shield/i);
    assert.equal(cleanupMutationCallCount(chrome), 0);

    releaseMutation.resolve();
    const repaired = await repairPromise;
    assert.equal(repaired.ok, true, repaired.error);
    assert.equal(repaired.repaired, true);
    assert.equal(chrome.__state.dnrRules.length, 0);

    const review = await dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    assert.equal(review.ok, true, review.error);
  } finally {
    releaseMutation.resolve();
    delete globalThis.chrome;
  }
});

for (const recoveryAction of [
  {
    label: 'manual maintenance',
    type: MESSAGE_TYPES.runMaintenanceNow
  },
  {
    label: 'local-state reset',
    type: MESSAGE_TYPES.resetExtensionLocalState
  }
]) {
  test(`${recoveryAction.label} can clear an orphan shield when automatic repair is disabled`, async () => {
    const now = new Date().toISOString();
    const chrome = await createChromeMock({
      dnrRules: [syntheticDnrRule(730000, '||recovery-action.example^')],
      localState: {
        [STORAGE_KEYS.settings]: {
          ...readySettings(now),
          autoRepairOrphanedShields: false
        }
      }
    });
    globalThis.chrome = chrome;
    try {
      await import(`../../src/background/service-worker.js?recovery-action-${uniqueImportKey()}`);
      const blocked = await dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
      assert.equal(blocked.ok, false);
      assert.equal(blocked.errorCode, 'lifecycle_not_ready');

      const recovered = await dispatchRuntimeMessageWithoutTimer(
        chrome,
        { type: recoveryAction.type, payload: {} },
        optionsSender(chrome)
      );
      assert.equal(recovered.ok, true, recovered.error);
      assert.equal(chrome.__state.dnrRules.length, 0);
      const review = await dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
      assert.equal(review.ok, true, review.error);
    } finally {
      delete globalThis.chrome;
    }
  });
}

test('an incomplete administrative DNR repair poisons a previously ready generation', async () => {
  const chrome = await createChromeMock({
    originPermissions: ['<all_urls>'],
    localState: {
      [STORAGE_KEYS.settings]: readySettings(new Date().toISOString())
    }
  });
  const originalGetWindow = chrome.windows.get;
  let reviewWindowInspections = 0;
  let dnrMutationCalls = 0;
  chrome.windows.get = async (...args) => {
    reviewWindowInspections += 1;
    return originalGetWindow(...args);
  };
  chrome.declarativeNetRequest.updateSessionRules = async (details) => {
    dnrMutationCalls += 1;
    chrome.__calls.push({ api: 'declarativeNetRequest.updateSessionRules', args: [structuredClone(details)] });
    // Settle without changing the owned range so reconciliation is truthful
    // but incomplete.
  };

  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?incomplete-admin-repair=${uniqueImportKey()}`);
    const initialReview = await dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    assert.equal(initialReview.ok, true, initialReview.error);
    assert.equal(reviewWindowInspections, 1);

    chrome.__state.dnrRules.push(syntheticDnrRule(730000, '||late-orphan.example^'));
    const repair = await dispatchRuntimeMessageWithoutTimer(
      chrome,
      { type: MESSAGE_TYPES.repairActiveShield, payload: {} },
      optionsSender(chrome)
    );
    assert.equal(repair.ok, false);
    assert.equal(repair.errorCode, 'sitewipe_action_failed');
    assert.ok(dnrMutationCalls >= 2, 'the recovery action and its fresh proof must both attempt reconciliation');

    const blockedReview = await dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    assert.equal(blockedReview.ok, false);
    assert.equal(blockedReview.errorCode, 'lifecycle_not_ready');
    assert.equal(reviewWindowInspections, 1, 'failed administrative recovery must not reuse stale ready admission');
    assert.equal(chrome.__state.dnrRules.length, 1);
  } finally {
    delete globalThis.chrome;
  }
});

test('a later safety-maintenance rejection poisons previously ready admission until a fresh proof succeeds', async () => {
  const chrome = await createChromeMock({
    originPermissions: ['<all_urls>'],
    localState: {
      [STORAGE_KEYS.settings]: readySettings(new Date().toISOString())
    }
  });
  const originalGetSessionRules = chrome.declarativeNetRequest.getSessionRules;
  const originalGetWindow = chrome.windows.get;
  let failDnrInspection = false;
  let dnrReadCount = 0;
  let dnrReadsAtReview = 0;
  chrome.declarativeNetRequest.getSessionRules = async (...args) => {
    dnrReadCount += 1;
    if (failDnrInspection) throw new Error('synthetic later DNR inspection failure');
    return originalGetSessionRules(...args);
  };
  chrome.windows.get = async (...args) => {
    dnrReadsAtReview = dnrReadCount;
    return originalGetWindow(...args);
  };

  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?later-maintenance-poison=${uniqueImportKey()}`);
    const initial = await dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    assert.equal(initial.ok, true, initial.error);
    const readsAfterInitialReadiness = dnrReadCount;
    failDnrInspection = true;
    await chrome.__events.alarm.emitAsync({ name: 'sitewipe.maintenance' });
    failDnrInspection = false;

    const recovered = await dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    assert.equal(recovered.ok, true, recovered.error);
    assert.ok(
      dnrReadsAtReview > readsAfterInitialReadiness,
      'the next interactive request must run a fresh DNR safety proof after later maintenance fails'
    );
    assert.equal(cleanupMutationCallCount(chrome), 0);
  } finally {
    delete globalThis.chrome;
  }
});

test('a retained temporary-host lease poisons readiness until exact access absence is proved', async () => {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const origins = ['https://example.com/*', 'https://*.example.com/*'];
  const lease = {
    schemaVersion: 2,
    id: 'lease-release-pending-000000000000000000000001',
    status: 'release_pending',
    requestedOrigins: origins,
    preexistingOrigins: [],
    temporaryOrigins: origins,
    createdAt: new Date(nowMs - 60_000).toISOString(),
    updatedAt: now,
    reviewExpiresAt: new Date(nowMs + 5 * 60_000).toISOString(),
    promptPendingUntil: null,
    releaseAttemptCount: 0,
    lastReleaseAttemptAt: null,
    lastError: null
  };
  const chrome = await createChromeMock({
    originPermissions: origins,
    localState: {
      [STORAGE_KEYS.settings]: readySettings(now),
      [STORAGE_KEYS.permissionLease]: lease
    }
  });
  const originalGetWindow = chrome.windows.get;
  let reviewWindowInspections = 0;
  let removalCalls = 0;
  chrome.permissions.remove = async (request) => {
    removalCalls += 1;
    chrome.__calls.push({ api: 'permissions.remove', args: [structuredClone(request)] });
    return false;
  };
  chrome.windows.get = async (...args) => {
    reviewWindowInspections += 1;
    return originalGetWindow(...args);
  };

  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?retained-permission-lease=${uniqueImportKey()}`);
    const response = await dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    assert.equal(response.ok, false);
    assert.equal(response.errorCode, 'lifecycle_not_ready');
    assert.match(response.error, /permission-lease-recovery|safety-proof/i);
    assert.equal(reviewWindowInspections, 0);
    await flushMicrotasks(20);
    const retry = await dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    assert.equal(retry.ok, false);
    assert.equal(retry.errorCode, 'lifecycle_not_ready');
    assert.ok(
      removalCalls >= 2,
      `the retry must reattempt the retained exact temporary lease (calls=${removalCalls}, error=${retry.error})`
    );
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease].status, 'release_pending');
    assert.equal(cleanupMutationCallCount(chrome), 0);
  } finally {
    delete globalThis.chrome;
  }
});

test('a definitive native denial settles the old prompt lease and a worker wake can prepare fresh authority', async () => {
  const firstChrome = await createReadyChromeMock();
  globalThis.chrome = firstChrome;
  let prepared;
  try {
    await import(`../../src/background/service-worker.js?prepare-reopen-review=${uniqueImportKey()}`);
    const initiatingSender = popupSender(firstChrome, 'popup-document-native-denial');
    prepared = await dispatchRuntimeMessageWithoutTimer(firstChrome, prepareReviewMessage(), initiatingSender);
    assert.equal(prepared.ok, true, prepared.error);
    assert.ok(prepared.review.permissionLeaseId);
    assert.equal(firstChrome.__state.local[STORAGE_KEYS.permissionLease].status, 'prompt_pending');
    const armed = await dispatchRuntimeMessageWithoutTimer(
      firstChrome,
      armPreparedReviewMessage(prepared),
      initiatingSender
    );
    assert.equal(armed.ok, true, armed.error);
    const permissionRemovalsBeforeDenial = firstChrome.__calls.filter(
      (call) => call.api === 'permissions.remove'
    ).length;
    const denied = await dispatchRuntimeMessageWithoutTimer(
      firstChrome,
      {
        type: MESSAGE_TYPES.settleCleanupPermissionPrompt,
        payload: {
          approvalToken: prepared.review.approvalToken,
          handoffNonce: prepared.review.approvalHandoffNonce,
          permissionLeaseId: prepared.review.permissionLeaseId,
          ...popupPreparationBinding(prepared),
          outcome: 'denied'
        }
      },
      initiatingSender
    );
    assert.equal(denied.ok, true, denied.error);
    assert.equal(denied.settlement.released, true);
    assert.equal(denied.settlement.recordRetained, false);
    assert.equal(
      firstChrome.__calls.filter((call) => call.api === 'permissions.remove').length,
      permissionRemovalsBeforeDenial,
      'a native denial with no grant needs no host-permission removal call'
    );
    assert.equal(firstChrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
    assert.equal(firstChrome.__state.session['sitewipe.cleanupReview.v1'], undefined);
    await flushMicrotasks(30);
  } finally {
    delete globalThis.chrome;
  }

  const reopenedChrome = await createChromeMock({
    localState: structuredClone(firstChrome.__state.local),
    sessionState: structuredClone(firstChrome.__state.session)
  });
  globalThis.chrome = reopenedChrome;
  try {
    await import(`../../src/background/service-worker.js?reopen-live-review=${uniqueImportKey()}`);
    const reopened = await dispatchRuntimeMessageWithoutTimer(
      reopenedChrome,
      prepareReviewMessage(),
      popupSender(reopenedChrome)
    );
    assert.equal(reopened.ok, true, reopened.error);
    assert.notEqual(reopened.review.approvalToken, prepared.review.approvalToken);
    assert.ok(reopened.review.permissionLeaseId);
    assert.equal(cleanupMutationCallCount(reopenedChrome), 0);
  } finally {
    delete globalThis.chrome;
  }
});

test('abandoned permission-prompt rollback holds the sole lifecycle reservation through host-access settlement', async () => {
  const chrome = await createReadyChromeMock();
  globalThis.chrome = chrome;
  const releaseStarted = deferred();
  const releasePermissionRemoval = deferred();
  const originalPermissionRemove = chrome.permissions.remove;
  const originalGetWindow = chrome.windows.get;
  let reviewWindowInspections = 0;
  try {
    await import(`../../src/background/service-worker.js?prompt-settlement-reservation=${uniqueImportKey()}`);
    const initiatingSender = popupSender(chrome, 'popup-document-abandoned-prompt');
    const prepared = await dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), initiatingSender);
    assert.equal(prepared.ok, true, prepared.error);
    const armed = await dispatchRuntimeMessageWithoutTimer(
      chrome,
      armPreparedReviewMessage(prepared),
      initiatingSender
    );
    assert.equal(armed.ok, true, armed.error);
    const lease = chrome.__state.local[STORAGE_KEYS.permissionLease];
    for (const origin of lease.temporaryOrigins) chrome.__state.originPermissions.add(origin);
    chrome.permissions.remove = async (...args) => {
      releaseStarted.resolve();
      await releasePermissionRemoval.promise;
      return originalPermissionRemove(...args);
    };
    chrome.windows.get = async (...args) => {
      reviewWindowInspections += 1;
      return originalGetWindow(...args);
    };

    const settlementPromise = dispatchRuntimeMessageWithoutTimer(
      chrome,
      {
        type: MESSAGE_TYPES.settleCleanupPermissionPrompt,
        payload: {
          approvalToken: prepared.review.approvalToken,
          handoffNonce: prepared.review.approvalHandoffNonce,
          permissionLeaseId: lease.id,
          ...popupPreparationBinding(prepared),
          outcome: 'abandoned'
        }
      },
      initiatingSender
    );
    await releaseStarted.promise;
    const conflict = await dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    assert.equal(conflict.ok, false);
    assert.equal(conflict.errorCode, 'sitewipe_action_failed');
    assert.match(conflict.error, /settle target site access/i);
    assert.equal(reviewWindowInspections, 0);

    releasePermissionRemoval.resolve();
    const settled = await settlementPromise;
    assert.equal(settled.ok, true, settled.error);
    assert.equal(settled.settlement.released, true);
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
    assert.equal(chrome.__state.session['sitewipe.cleanupReview.v1'], undefined);

    const recovered = await dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    assert.equal(recovered.ok, true, recovered.error);
    assert.equal(reviewWindowInspections, 1);
    assert.equal(cleanupMutationCallCount(chrome), 0);
  } finally {
    releasePermissionRemoval.resolve();
    delete globalThis.chrome;
  }
});

test('worker-load recovery tombstones orphan arming and fully reconciles orphan admission boundaries', async (t) => {
  await t.test('orphan arming becomes a non-runnable prompt tombstone', async () => {
    const fixture = await createArmedHandoffFixture('orphan-arming');
    fixture.sessionState['sitewipe.cleanupReview.v1'].approvalHandoff.status = 'arming';
    const chrome = await createChromeMock({
      localState: fixture.localState,
      sessionState: fixture.sessionState
    });
    globalThis.chrome = chrome;
    try {
      await import(`../../src/background/service-worker.js?orphan-arming=${uniqueImportKey()}`);
      const ready = await dispatchRuntimeMessageWithoutTimer(
        chrome,
        { type: MESSAGE_TYPES.runMaintenanceNow, payload: {} },
        popupSender(chrome)
      );
      assert.equal(ready.ok, true, ready.error);
      assert.equal(chrome.__state.session['sitewipe.cleanupReview.v1'].approvalHandoff.status, 'prompt_tombstone');
      assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease].status, 'prompt_pending');
      assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
      assert.equal(cleanupMutationCallCount(chrome), 0);
    } finally {
      delete globalThis.chrome;
    }
  });

  await t.test('orphan admitting with no job removes exact access and cannot replay', async () => {
    const fixture = await createArmedHandoffFixture('orphan-admitting');
    fixture.sessionState['sitewipe.cleanupReview.v1'].approvalHandoff.status = 'admitting';
    fixture.localState[STORAGE_KEYS.permissionLease].status = 'active_cleanup';
    fixture.localState[STORAGE_KEYS.permissionLease].promptPendingUntil = null;
    const chrome = await createChromeMock({
      localState: fixture.localState,
      sessionState: fixture.sessionState,
      originPermissions: fixture.temporaryOrigins
    });
    globalThis.chrome = chrome;
    try {
      await import(`../../src/background/service-worker.js?orphan-admitting=${uniqueImportKey()}`);
      const ready = await dispatchRuntimeMessageWithoutTimer(
        chrome,
        { type: MESSAGE_TYPES.runMaintenanceNow, payload: {} },
        popupSender(chrome)
      );
      assert.equal(ready.ok, true, ready.error);
      assert.equal(chrome.__state.session['sitewipe.cleanupReview.v1'], undefined);
      assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
      assert.deepEqual(chrome.__state.originPermissions, new Set());
      assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
      assert.equal(cleanupMutationCallCount(chrome), 0);
    } finally {
      delete globalThis.chrome;
    }
  });

  await t.test('a matching handoff-admitting job is interrupted and reconciled, never re-admitted', async () => {
    const fixture = await createArmedHandoffFixture('correlated-admission');
    const record = fixture.sessionState['sitewipe.cleanupReview.v1'];
    record.approvalHandoff.status = 'admitting';
    fixture.localState[STORAGE_KEYS.permissionLease].status = 'active_cleanup';
    fixture.localState[STORAGE_KEYS.permissionLease].promptPendingUntil = null;
    const now = new Date().toISOString();
    fixture.localState[STORAGE_KEYS.activeJob] = {
      id: 'correlated-handoff-admitting-job',
      status: 'running',
      targetDomain: '[redacted-target]',
      startedAt: now,
      updatedAt: now,
      percent: 0,
      phase: 'handoff-admitting',
      label: 'Cleanup admission in progress',
      detail: '',
      cancelRequested: false,
      approvalHandoffNonce: record.approvalHandoff.nonce,
      popupContextId: record.preparationContextId,
      popupPreparationCapabilityDigest: record.popupPreparationCapabilityDigest,
      admissionPhase: 'handoff_admitting'
    };
    const chrome = await createChromeMock({
      localState: fixture.localState,
      sessionState: fixture.sessionState,
      originPermissions: fixture.temporaryOrigins
    });
    globalThis.chrome = chrome;
    try {
      await import(`../../src/background/service-worker.js?correlated-admission=${uniqueImportKey()}`);
      const ready = await dispatchRuntimeMessageWithoutTimer(
        chrome,
        { type: MESSAGE_TYPES.runMaintenanceNow, payload: {} },
        popupSender(chrome)
      );
      assert.equal(ready.ok, true, ready.error);
      assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob].status, 'interrupted');
      assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob].admissionPhase, 'handoff_admitting');
      assert.equal(chrome.__state.session['sitewipe.cleanupReview.v1'], undefined);
      assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
      assert.deepEqual(chrome.__state.originPermissions, new Set());
      assert.equal(cleanupMutationCallCount(chrome), 0);

      await chrome.__events.runtimeStartup.emitAsync();
      await flushMicrotasks(30);
      assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob].status, 'interrupted');
      assert.equal(cleanupMutationCallCount(chrome), 0, 'a second startup must never replay interrupted admission');
    } finally {
      delete globalThis.chrome;
    }
  });
});

test('a real browser-session startup boundary settles unexpired final-click authority', async () => {
  const fixture = await createArmedHandoffFixture('startup-boundary');
  const chrome = await createChromeMock({
    localState: fixture.localState,
    sessionState: fixture.sessionState
  });
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?startup-armed-boundary=${uniqueImportKey()}`);
    const initiallyReady = await dispatchRuntimeMessageWithoutTimer(
      chrome,
      { type: MESSAGE_TYPES.runMaintenanceNow, payload: {} },
      popupSender(chrome)
    );
    assert.equal(initiallyReady.ok, true, initiallyReady.error);
    assert.equal(chrome.__state.session['sitewipe.cleanupReview.v1'].approvalHandoff.status, 'armed');

    await chrome.__events.runtimeStartup.emitAsync();
    await waitForWallClock(
      () =>
        chrome.__state.session['sitewipe.cleanupReview.v1'] === undefined &&
        chrome.__state.local[STORAGE_KEYS.permissionLease] === undefined
    );
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
    assert.equal(cleanupMutationCallCount(chrome), 0);
  } finally {
    delete globalThis.chrome;
  }
});

test('a startup boundary emitted behind a held maintenance reservation is preserved through replay', async () => {
  const fixture = await createArmedHandoffFixture('deferred-startup-boundary');
  const chrome = await createChromeMock({
    localState: fixture.localState,
    sessionState: fixture.sessionState
  });
  const loadReadStarted = deferred();
  const releaseLoadRead = deferred();
  const originalGetSessionRules = chrome.declarativeNetRequest.getSessionRules;
  let reads = 0;
  chrome.declarativeNetRequest.getSessionRules = async (...args) => {
    reads += 1;
    if (reads === 1) {
      loadReadStarted.resolve();
      await releaseLoadRead.promise;
    }
    return originalGetSessionRules(...args);
  };
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?deferred-startup-boundary=${uniqueImportKey()}`);
    await loadReadStarted.promise;
    await chrome.__events.runtimeStartup.emitAsync();
    assert.equal(
      chrome.__state.session['sitewipe.cleanupReview.v1'].approvalHandoff.status,
      'armed',
      'the boundary must wait for the held safety reservation'
    );

    releaseLoadRead.resolve();
    await waitForWallClock(
      () =>
        chrome.__state.session['sitewipe.cleanupReview.v1'] === undefined &&
        chrome.__state.local[STORAGE_KEYS.permissionLease] === undefined,
      400
    );
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
    assert.equal(cleanupMutationCallCount(chrome), 0);
  } finally {
    releaseLoadRead.resolve();
    delete globalThis.chrome;
  }
});

test('an accepted report-expiry write keeps the reservation until storage settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const now = new Date().toISOString();
  const chrome = await createChromeMock({
    localState: {
      [STORAGE_KEYS.settings]: readySettings(now),
      [STORAGE_KEYS.activeReport]: {
        id: 'expired-synthetic-report',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:01:00.000Z'
      }
    }
  });
  const reportWriteStarted = deferred();
  const releaseReportWrite = deferred();
  const originalLocalSet = chrome.storage.local.set;
  const originalGetWindow = chrome.windows.get;
  let reviewWindowInspections = 0;
  chrome.storage.local.set = async (values) => {
    if (values?.[STORAGE_KEYS.activeReport] === null) {
      reportWriteStarted.resolve();
      await releaseReportWrite.promise;
    }
    return originalLocalSet(values);
  };
  chrome.windows.get = async (...args) => {
    reviewWindowInspections += 1;
    return originalGetWindow(...args);
  };

  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?delayed-report-expiry-write=${uniqueImportKey()}`);
    await reportWriteStarted.promise;
    const waitingReviewPromise = dispatchRuntimeMessageWithoutTimer(
      chrome,
      prepareReviewMessage(),
      popupSender(chrome)
    );
    let waitingReview = null;
    void waitingReviewPromise.then((response) => {
      waitingReview = response;
    });
    t.mock.timers.tick(8_000);
    await flushMicrotasks(30);
    assert.ok(waitingReview);
    assert.equal(waitingReview.ok, false);
    assert.equal(waitingReview.errorCode, 'lifecycle_not_ready');
    assert.equal(reviewWindowInspections, 0);
    assert.ok(chrome.__state.local[STORAGE_KEYS.activeReport]);

    releaseReportWrite.resolve();
    await flushMicrotasks(60);
    const recoveredReviewPromise = dispatchRuntimeMessageWithoutTimer(
      chrome,
      prepareReviewMessage(),
      popupSender(chrome)
    );
    let recoveredReview = null;
    void recoveredReviewPromise.then((response) => {
      recoveredReview = response;
    });
    await driveZeroDelayTimers(t, () => Boolean(recoveredReview));
    assert.equal(recoveredReview.ok, true, recoveredReview.error);
    assert.equal(reviewWindowInspections, 1);
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeReport], null);
    assert.equal(cleanupMutationCallCount(chrome), 0);
  } finally {
    releaseReportWrite.resolve();
    delete globalThis.chrome;
  }
});

test('a timed-out startup safety mutation remains serialized and blocks review until its late settlement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const now = new Date().toISOString();
  const shield = {
    domain: 'stale.example',
    displayName: 'stale.example',
    associatedTargets: [],
    ruleIds: [730000],
    urlFilters: ['||stale.example^'],
    mode: 'cleanup-only',
    lifecycle: 'active',
    pendingMutation: false,
    expiresAt: '2026-01-01T00:00:00.000Z',
    startedAt: now,
    jobId: 'stale-shield-job'
  };
  const chrome = await createChromeMock({
    dnrRules: [
      {
        id: 730000,
        priority: 1,
        action: { type: 'block' },
        condition: { urlFilter: '||stale.example^', resourceTypes: ['main_frame'] }
      }
    ],
    localState: {
      [STORAGE_KEYS.settings]: readySettings(now),
      [STORAGE_KEYS.activeShield]: shield
    }
  });
  const firstMutationStarted = deferred();
  const releaseFirstMutation = deferred();
  const originalUpdateRules = chrome.declarativeNetRequest.updateSessionRules;
  const originalGetWindow = chrome.windows.get;
  const events = [];
  let mutationCount = 0;
  let reviewWindowInspections = 0;
  chrome.declarativeNetRequest.updateSessionRules = async (...args) => {
    mutationCount += 1;
    events.push(`dnr-mutation-${mutationCount}-started`);
    if (mutationCount === 1) {
      firstMutationStarted.resolve();
      await releaseFirstMutation.promise;
      events.push('first-dnr-mutation-settled');
    }
    return originalUpdateRules(...args);
  };
  chrome.windows.get = async (...args) => {
    reviewWindowInspections += 1;
    events.push('review-window-inspection');
    return originalGetWindow(...args);
  };

  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?late-startup-dnr=${uniqueImportKey()}`);
    await firstMutationStarted.promise;
    const waitingReviewPromise = dispatchRuntimeMessageWithoutTimer(
      chrome,
      prepareReviewMessage(),
      popupSender(chrome)
    );

    t.mock.timers.tick(8_000);
    await flushMicrotasks(30);
    const waitingReview = await waitingReviewPromise;
    assert.equal(waitingReview.ok, false);
    assert.equal(waitingReview.errorCode, 'lifecycle_not_ready');
    assert.equal(reviewWindowInspections, 0);
    assert.equal(mutationCount, 1, 'no second safety mutation may overlap the unresolved first call');

    t.mock.timers.tick(7_000);
    await flushMicrotasks(60);
    assert.equal(mutationCount, 1, 'orphan recovery must not overlap a timed-out DNR mutation');
    const blockedByPendingMutation = await dispatchRuntimeMessageWithoutTimer(
      chrome,
      prepareReviewMessage(),
      popupSender(chrome)
    );
    assert.equal(blockedByPendingMutation.ok, false);
    assert.equal(blockedByPendingMutation.errorCode, 'lifecycle_not_ready');
    assert.match(blockedByPendingMutation.error, /safety-proof/i);
    assert.equal(reviewWindowInspections, 0);

    releaseFirstMutation.resolve();
    await flushMicrotasks(60);
    const recoveredReviewPromise = dispatchRuntimeMessageWithoutTimer(
      chrome,
      prepareReviewMessage(),
      popupSender(chrome)
    );
    let recoveredReview = null;
    void recoveredReviewPromise.then((response) => {
      recoveredReview = response;
    });
    await driveZeroDelayTimers(t, () => Boolean(recoveredReview));
    assert.equal(recoveredReview.ok, true, recoveredReview.error);
    assert.equal(reviewWindowInspections, 1);
    assert.ok(events.indexOf('first-dnr-mutation-settled') < events.indexOf('review-window-inspection'));
    assert.equal(cleanupMutationCallCount(chrome), 0);
  } finally {
    releaseFirstMutation.resolve();
    delete globalThis.chrome;
  }
});

test('a failed deferred DNR settlement is replayed by the next readiness proof without replacing job identity', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const now = new Date().toISOString();
  const chrome = await createChromeMock({
    incognitoAllowed: true,
    originPermissions: ['<all_urls>'],
    localState: {
      [STORAGE_KEYS.settings]: {
        ...readySettings(now),
        progressOverlay: false,
        pageScriptScrub: false,
        temporaryDnrShield: true,
        verificationPass: false,
        aggressiveCookieSweep: false,
        resetZoom: false
      }
    }
  });
  const delayedClearStarted = deferred();
  const releaseDelayedClear = deferred();
  const originalUpdateRules = chrome.declarativeNetRequest.updateSessionRules;
  const originalLocalSet = chrome.storage.local.set;
  let dnrMutationCalls = 0;
  let delayedClearObserved = false;
  let failNextSettlementWrite = false;
  let settlementWriteAttempts = 0;
  chrome.declarativeNetRequest.updateSessionRules = async (...args) => {
    dnrMutationCalls += 1;
    if (dnrMutationCalls === 2) {
      delayedClearObserved = true;
      delayedClearStarted.resolve();
      await releaseDelayedClear.promise;
    }
    return originalUpdateRules(...args);
  };
  chrome.storage.local.set = async (values) => {
    const shield = values?.[STORAGE_KEYS.activeShield];
    if (shield?.lifecycle === 'unknown' && shield?.pendingMutation === false) {
      settlementWriteAttempts += 1;
      if (failNextSettlementWrite) {
        failNextSettlementWrite = false;
        throw new Error('synthetic markDnrMutationSettled write failure');
      }
    }
    return originalLocalSet(values);
  };

  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?deferred-dnr-replay=${uniqueImportKey()}`);
    const preparedPromise = dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    let prepared = null;
    void preparedPromise.then((response) => {
      prepared = response;
    });
    await driveZeroDelayTimers(t, () => Boolean(prepared));
    assert.equal(prepared.ok, true, prepared.error);
    const runPromise = dispatchRuntimeMessageWithoutTimer(
      chrome,
      {
        type: MESSAGE_TYPES.runDeepClean,
        payload: {
          approvalToken: prepared.review.approvalToken,
          sourceWindowId: 1,
          sourceIncognito: false,
          ...popupPreparationBinding(prepared),
          approval: completeApproval()
        }
      },
      popupSender(chrome)
    );
    let runResponse = null;
    void runPromise.then((response) => {
      runResponse = response;
    });

    await driveZeroDelayTimers(t, () => delayedClearObserved);
    await delayedClearStarted.promise;
    assert.ok(
      chrome.__state.local['sitewipe.dnrPendingMutation.v1'],
      'the final removal must persist its durable marker before updateSessionRules starts'
    );
    assert.ok(
      chrome.__state.session['sitewipe.dnrPendingMutation.session.v1'],
      'the final removal must persist its browser-session marker before updateSessionRules starts'
    );
    failNextSettlementWrite = true;
    t.mock.timers.tick(15_000);
    await flushMicrotasks(60);
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeShield].pendingMutation, true);

    releaseDelayedClear.resolve();
    await flushMicrotasks(60);
    t.mock.timers.tick(450);
    await driveZeroDelayTimers(t, () => Boolean(runResponse));
    assert.equal(runResponse.ok, true, runResponse.error);
    await waitForMicrotasks(() => settlementWriteAttempts === 1);
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeShield].pendingMutation, true);

    const replacementJob = {
      ...chrome.__state.local[STORAGE_KEYS.activeJob],
      id: 'replacement-terminal-job',
      status: 'completed',
      phase: 'replacement',
      label: 'Replacement terminal job',
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString()
    };
    await originalLocalSet({ [STORAGE_KEYS.activeJob]: replacementJob });

    const reviewPromise = dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    let review = null;
    void reviewPromise.then((response) => {
      review = response;
    });
    await driveZeroDelayTimers(t, () => Boolean(review));
    assert.equal(review.ok, true, review.error);
    assert.ok(settlementWriteAttempts >= 2, 'fresh readiness must retry the retained exact DNR settlement');
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeShield], null);
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob].id, replacementJob.id);
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob].phase, replacementJob.phase);
  } finally {
    releaseDelayedClear.resolve();
    delete globalThis.chrome;
  }
});

test('a partial DNR session-marker write starts no browser mutation and cannot masquerade as a restart', async () => {
  const now = new Date().toISOString();
  const chrome = await createChromeMock({
    incognitoAllowed: true,
    originPermissions: ['<all_urls>'],
    localState: {
      [STORAGE_KEYS.settings]: {
        ...readySettings(now),
        progressOverlay: false,
        pageScriptScrub: false,
        temporaryDnrShield: true,
        verificationPass: false,
        aggressiveCookieSweep: false,
        resetZoom: false
      }
    }
  });
  const originalSessionSet = chrome.storage.session.set;
  let failNextMarkerSessionWrite = false;
  let postFailureDnrCalls = 0;
  const originalUpdateRules = chrome.declarativeNetRequest.updateSessionRules;
  chrome.storage.session.set = async (values) => {
    if (failNextMarkerSessionWrite && values?.['sitewipe.dnrPendingMutation.session.v1']) {
      failNextMarkerSessionWrite = false;
      throw new Error('synthetic browser-session marker write failure');
    }
    return originalSessionSet(values);
  };
  chrome.declarativeNetRequest.updateSessionRules = async (...args) => {
    postFailureDnrCalls += 1;
    return originalUpdateRules(...args);
  };

  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?partial-marker-precondition=${uniqueImportKey()}`);
    const prepared = await dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    assert.equal(prepared.ok, true, prepared.error);

    // Ignore load-readiness reconciliation and fail only the marker write that
    // guards the cleanup's install call.
    postFailureDnrCalls = 0;
    failNextMarkerSessionWrite = true;
    const run = await dispatchRuntimeMessageWithoutTimer(
      chrome,
      {
        type: MESSAGE_TYPES.runDeepClean,
        payload: {
          approvalToken: prepared.review.approvalToken,
          sourceWindowId: 1,
          sourceIncognito: false,
          ...popupPreparationBinding(prepared),
          approval: completeApproval()
        }
      },
      popupSender(chrome)
    );
    assert.equal(run.ok, true, run.error);
    assert.equal(postFailureDnrCalls, 0, 'no DNR API call may follow a failed marker precondition');

    const partialMarker = chrome.__state.local['sitewipe.dnrPendingMutation.v1'];
    assert.equal(partialMarker?.sessionBinding, 'binding');
    assert.equal(chrome.__state.session['sitewipe.dnrPendingMutation.session.v1'], undefined);
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeShield].pendingMutation, true);

    const sameSessionRetry = await dispatchRuntimeMessageWithoutTimer(
      chrome,
      prepareReviewMessage(),
      popupSender(chrome)
    );
    assert.equal(sameSessionRetry.ok, false);
    assert.equal(sameSessionRetry.errorCode, 'lifecycle_not_ready');
    assert.match(sameSessionRetry.error, /request-shield-session-boundary/i);
    assert.equal(postFailureDnrCalls, 0, 'rebinding quarantine must not issue a speculative DNR clear');
    const reboundLocal = chrome.__state.local['sitewipe.dnrPendingMutation.v1'];
    const reboundSession = chrome.__state.session['sitewipe.dnrPendingMutation.session.v1'];
    assert.equal(reboundLocal?.sessionBinding, 'bound');
    assert.equal(reboundSession?.sessionBinding, 'bound');
    assert.equal(reboundLocal?.mutationId, reboundSession?.mutationId);
    assert.notEqual(reboundLocal?.mutationId, partialMarker?.mutationId);
  } finally {
    delete globalThis.chrome;
  }

  const restartedChrome = await createChromeMock({
    dnrRules: [],
    localState: structuredClone(chrome.__state.local),
    sessionState: {}
  });
  globalThis.chrome = restartedChrome;
  try {
    await import(`../../src/background/service-worker.js?partial-marker-after-restart=${uniqueImportKey()}`);
    const recovered = await dispatchRuntimeMessageWithoutTimer(
      restartedChrome,
      prepareReviewMessage(),
      popupSender(restartedChrome)
    );
    assert.equal(recovered.ok, true, recovered.error);
    assert.equal(restartedChrome.__state.local[STORAGE_KEYS.activeShield], null);
    assert.equal(restartedChrome.__state.local['sitewipe.dnrPendingMutation.v1'], undefined);
  } finally {
    delete globalThis.chrome;
  }
});

test('a lost-worker DNR marker stays blocked in-session and clears only after a proven browser-session boundary', async () => {
  const now = new Date().toISOString();
  const pendingShield = {
    domain: 'lost-worker.example',
    displayName: 'lost-worker.example',
    associatedTargets: [],
    ruleIds: [730000],
    urlFilters: ['||lost-worker.example^'],
    mode: 'cleanup-only',
    lifecycle: 'unknown',
    pendingMutation: true,
    expiresAt: null,
    startedAt: now,
    jobId: 'lost-worker-shield-job'
  };
  const replacementJob = {
    id: 'replacement-terminal-job-after-worker-loss',
    status: 'completed',
    targetDomain: '[redacted-target]',
    startedAt: now,
    updatedAt: now,
    completedAt: now,
    percent: 100,
    phase: 'replacement',
    label: 'Replacement terminal job',
    detail: '',
    cancelRequested: false
  };
  const sameSessionChrome = await createChromeMock({
    dnrRules: [syntheticDnrRule(730000, '||lost-worker.example^')],
    localState: {
      [STORAGE_KEYS.settings]: readySettings(now),
      [STORAGE_KEYS.activeShield]: pendingShield,
      [STORAGE_KEYS.activeJob]: replacementJob
    }
  });
  globalThis.chrome = sameSessionChrome;
  try {
    await import(`../../src/background/service-worker.js?lost-worker-same-session=${uniqueImportKey()}`);
    const blockedReview = await dispatchRuntimeMessageWithoutTimer(
      sameSessionChrome,
      prepareReviewMessage(),
      popupSender(sameSessionChrome)
    );
    assert.equal(blockedReview.ok, false);
    assert.equal(blockedReview.errorCode, 'lifecycle_not_ready');
    assert.match(blockedReview.error, /request-shield-session-boundary/i);
    assert.ok(sameSessionChrome.__state.local['sitewipe.dnrPendingMutation.v1']);
    assert.ok(sameSessionChrome.__state.session['sitewipe.dnrPendingMutation.session.v1']);

    const manualRepair = await dispatchRuntimeMessageWithoutTimer(
      sameSessionChrome,
      { type: MESSAGE_TYPES.repairActiveShield, payload: {} },
      optionsSender(sameSessionChrome)
    );
    assert.equal(manualRepair.ok, false);
    assert.equal(manualRepair.errorCode, 'sitewipe_action_failed');
    assert.match(manualRepair.error, /restart the browser/i);
    assert.equal(
      sameSessionChrome.__calls.filter((call) => call.api === 'declarativeNetRequest.updateSessionRules').length,
      0,
      'same-session recovery must not overlap an old browser operation with a speculative clear'
    );
    assert.equal(sameSessionChrome.__state.local[STORAGE_KEYS.activeShield].jobId, pendingShield.jobId);
    assert.equal(sameSessionChrome.__state.local[STORAGE_KEYS.activeJob].id, replacementJob.id);

    const settingsBeforeReset = structuredClone(sameSessionChrome.__state.local[STORAGE_KEYS.settings]);
    const localMarkerBeforeReset = structuredClone(sameSessionChrome.__state.local['sitewipe.dnrPendingMutation.v1']);
    const sessionMarkerBeforeReset = structuredClone(
      sameSessionChrome.__state.session['sitewipe.dnrPendingMutation.session.v1']
    );
    const reset = await dispatchRuntimeMessageWithoutTimer(
      sameSessionChrome,
      { type: MESSAGE_TYPES.resetExtensionLocalState, payload: {} },
      optionsSender(sameSessionChrome)
    );
    assert.equal(reset.ok, false);
    assert.equal(reset.errorCode, 'sitewipe_action_failed');
    assert.match(reset.error, /restart the browser/i);
    assert.equal(
      sameSessionChrome.__calls.filter((call) => call.api === 'declarativeNetRequest.updateSessionRules').length,
      0,
      'reset must not begin while a same-session DNR mutation remains quarantined'
    );
    assert.equal(sameSessionChrome.__state.local[STORAGE_KEYS.activeShield].jobId, pendingShield.jobId);
    assert.equal(sameSessionChrome.__state.local[STORAGE_KEYS.activeJob].id, replacementJob.id);
    assert.deepEqual(sameSessionChrome.__state.local[STORAGE_KEYS.settings], settingsBeforeReset);
    assert.deepEqual(sameSessionChrome.__state.local['sitewipe.dnrPendingMutation.v1'], localMarkerBeforeReset);
    assert.deepEqual(
      sameSessionChrome.__state.session['sitewipe.dnrPendingMutation.session.v1'],
      sessionMarkerBeforeReset
    );
  } finally {
    delete globalThis.chrome;
  }

  // chrome.storage.session and DNR session rules are both absent after the
  // observable browser-session boundary; durable local state survives.
  const restartedChrome = await createChromeMock({
    dnrRules: [],
    localState: structuredClone(sameSessionChrome.__state.local),
    sessionState: {}
  });
  globalThis.chrome = restartedChrome;
  try {
    await import(`../../src/background/service-worker.js?lost-worker-after-browser-restart=${uniqueImportKey()}`);
    const recoveredReview = await dispatchRuntimeMessageWithoutTimer(
      restartedChrome,
      prepareReviewMessage(),
      popupSender(restartedChrome)
    );
    assert.equal(recoveredReview.ok, true, recoveredReview.error);
    assert.equal(restartedChrome.__state.local[STORAGE_KEYS.activeShield], null);
    assert.equal(restartedChrome.__state.local['sitewipe.dnrPendingMutation.v1'], undefined);
    assert.equal(restartedChrome.__state.local[STORAGE_KEYS.activeJob].id, replacementJob.id);
    assert.equal(restartedChrome.__state.local[STORAGE_KEYS.activeJob].phase, replacementJob.phase);
  } finally {
    delete globalThis.chrome;
  }
});

test('a worker lost immediately after final-clear admission remains quarantined until browser restart', async () => {
  const now = new Date().toISOString();
  const activeShield = {
    domain: 'final-clear-loss.example',
    displayName: 'final-clear-loss.example',
    associatedTargets: [],
    ruleIds: [730000],
    urlFilters: ['||final-clear-loss.example^'],
    mode: 'cleanup-only',
    lifecycle: 'active',
    pendingMutation: false,
    expiresAt: null,
    startedAt: now,
    jobId: 'final-clear-loss-job'
  };
  const marker = {
    schemaVersion: 1,
    mutationId: 'dnr-final-clear-loss-0001',
    sessionBinding: 'bound',
    jobId: activeShield.jobId,
    shieldStartedAt: activeShield.startedAt,
    recordedAt: now
  };
  const sameSessionChrome = await createChromeMock({
    dnrRules: [syntheticDnrRule(730000, '||final-clear-loss.example^')],
    localState: {
      [STORAGE_KEYS.settings]: readySettings(now),
      [STORAGE_KEYS.activeShield]: activeShield,
      'sitewipe.dnrPendingMutation.v1': marker
    },
    sessionState: {
      'sitewipe.dnrPendingMutation.session.v1': marker
    }
  });
  globalThis.chrome = sameSessionChrome;
  try {
    await import(`../../src/background/service-worker.js?final-clear-loss-same-session=${uniqueImportKey()}`);
    const blocked = await dispatchRuntimeMessageWithoutTimer(
      sameSessionChrome,
      prepareReviewMessage(),
      popupSender(sameSessionChrome)
    );
    assert.equal(blocked.ok, false);
    assert.equal(blocked.errorCode, 'lifecycle_not_ready');
    assert.match(blocked.error, /request-shield-session-boundary/i);
    assert.equal(
      sameSessionChrome.__calls.filter((call) => call.api === 'declarativeNetRequest.updateSessionRules').length,
      0,
      'the new worker must not race the abandoned final clear with another DNR mutation'
    );
    assert.deepEqual(sameSessionChrome.__state.local['sitewipe.dnrPendingMutation.v1'], marker);
    assert.deepEqual(sameSessionChrome.__state.session['sitewipe.dnrPendingMutation.session.v1'], marker);
    assert.equal(sameSessionChrome.__state.local[STORAGE_KEYS.activeShield].jobId, activeShield.jobId);
  } finally {
    delete globalThis.chrome;
  }

  const restartedChrome = await createChromeMock({
    dnrRules: [],
    localState: structuredClone(sameSessionChrome.__state.local),
    sessionState: {}
  });
  globalThis.chrome = restartedChrome;
  try {
    await import(`../../src/background/service-worker.js?final-clear-loss-after-restart=${uniqueImportKey()}`);
    const recovered = await dispatchRuntimeMessageWithoutTimer(
      restartedChrome,
      prepareReviewMessage(),
      popupSender(restartedChrome)
    );
    assert.equal(recovered.ok, true, recovered.error);
    assert.equal(restartedChrome.__state.local[STORAGE_KEYS.activeShield], null);
    assert.equal(restartedChrome.__state.local['sitewipe.dnrPendingMutation.v1'], undefined);
  } finally {
    delete globalThis.chrome;
  }
});

test('a missing privacy marker with a hung migration read remains fail-closed under the reservation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const now = new Date().toISOString();
  const chrome = await createChromeMock({
    localState: {
      [STORAGE_KEYS.settings]: {
        ...DEFAULT_SETTINGS,
        createdAt: now,
        updatedAt: now,
        stabilityDefaultsAppliedAt: now,
        performanceDefaultsAppliedAt: now,
        privacyDefaultsAppliedAt: null
      }
    }
  });
  const migrationReadStarted = deferred();
  const originalLocalGet = chrome.storage.local.get;
  const originalGetWindow = chrome.windows.get;
  let reviewWindowInspections = 0;
  chrome.storage.local.get = async (keys) => {
    if (
      Array.isArray(keys) &&
      keys.includes(STORAGE_KEYS.activeReport) &&
      keys.includes(STORAGE_KEYS.reports) &&
      keys.includes(STORAGE_KEYS.debugLog)
    ) {
      migrationReadStarted.resolve();
      return new Promise(() => {});
    }
    return originalLocalGet(keys);
  };
  chrome.windows.get = async (...args) => {
    reviewWindowInspections += 1;
    return originalGetWindow(...args);
  };

  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?hung-privacy-migration=${uniqueImportKey()}`);
    await migrationReadStarted.promise;
    const reviewPromise = dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    let response = null;
    void reviewPromise.then((value) => {
      response = value;
    });
    t.mock.timers.tick(8_000);
    await flushMicrotasks(30);
    assert.ok(response);
    assert.equal(response.ok, false);
    assert.equal(response.errorCode, 'lifecycle_not_ready');
    assert.equal(reviewWindowInspections, 0);
    assert.equal(chrome.__state.local[STORAGE_KEYS.settings].privacyDefaultsAppliedAt, null);
    assert.equal(cleanupMutationCallCount(chrome), 0);
  } finally {
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

async function createArmedHandoffFixture(label) {
  const chrome = await createReadyChromeMock();
  const payload = prepareReviewMessage().payload;
  const promptContextId = `popup-context-${label}`;
  const dependencies = {
    getSettings: async () => chrome.__state.local[STORAGE_KEYS.settings],
    isIncognitoAllowed: async () => false,
    inspectSourceWindow: async (sourceWindowId) => ({ sourceWindowId, sourceIncognito: false }),
    hasHostPermissions: async (origins) => origins.every((origin) => chrome.__state.originPermissions.has(origin)),
    containsHostPermissions: async (origins) => origins.every((origin) => chrome.__state.originPermissions.has(origin)),
    getAllHostPermissions: async () => ({ origins: [...chrome.__state.originPermissions] }),
    inspectImpact: async () => ({ matchingTabs: 0, matchedCompletedFileIds: [] }),
    storageSession: chrome.storage.session,
    storageLocal: chrome.storage.local,
    preparationContextId: promptContextId,
    createToken: async () => 'a'.repeat(48),
    createHandoffNonce: async () => 'b'.repeat(48)
  };
  const prepared = await prepareCleanupReviewRequest(payload, dependencies);
  assert.ok(prepared.review.permissionLeaseId);
  const armed = await armCleanupReviewApprovalRequest(
    {
      ...armPreparedReviewMessage(prepared).payload
    },
    { ...dependencies, promptContextId }
  );
  assert.equal(armed.handoffNonce, prepared.review.approvalHandoffNonce);
  return {
    localState: structuredClone(chrome.__state.local),
    sessionState: structuredClone(chrome.__state.session),
    temporaryOrigins: [...prepared.review.temporaryHostPermissionOrigins]
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

function optionsSender(chrome) {
  return {
    id: chrome.runtime.id,
    documentUrl: chrome.runtime.getURL('options/options.html')
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

function syntheticDnrRule(id, urlFilter) {
  return {
    id,
    priority: 1,
    action: { type: 'block' },
    condition: { urlFilter, resourceTypes: ['main_frame'] }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function flushMicrotasks(count = 12) {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

async function waitForMicrotasks(predicate, iterations = 200) {
  for (let index = 0; index < iterations; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Timed out while waiting for the expected lifecycle microtask.');
}

async function waitForWallClock(predicate, iterations = 200) {
  for (let index = 0; index < iterations; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out while waiting for the expected lifecycle state.');
}

async function driveZeroDelayTimers(testContext, predicate, iterations = 100) {
  for (let index = 0; index < iterations; index += 1) {
    if (predicate()) return;
    testContext.mock.timers.tick(0);
    await flushMicrotasks();
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out while driving zero-delay lifecycle work.');
}

function uniqueImportKey() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-');
}

test('a timed-out privacy-migration read releases startup readiness for a fresh successful generation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const now = new Date().toISOString();
  const chrome = await createChromeMock({
    localState: {
      [STORAGE_KEYS.settings]: {
        ...readySettings(now),
        privacyDefaultsAppliedAt: null
      }
    }
  });
  const migrationReadStarted = deferred();
  const releaseMigrationRead = deferred();
  const originalLocalGet = chrome.storage.local.get;
  const originalGetWindow = chrome.windows.get;
  let blocked = false;
  let reviewWindowInspections = 0;
  chrome.storage.local.get = async (keys) => {
    if (
      !blocked &&
      Array.isArray(keys) &&
      keys.includes(STORAGE_KEYS.activeReport) &&
      keys.includes(STORAGE_KEYS.reports) &&
      keys.includes(STORAGE_KEYS.debugLog)
    ) {
      blocked = true;
      migrationReadStarted.resolve();
      await releaseMigrationRead.promise;
    }
    return originalLocalGet(keys);
  };
  chrome.windows.get = async (...args) => {
    reviewWindowInspections += 1;
    return originalGetWindow(...args);
  };

  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?bounded-privacy-retry=${uniqueImportKey()}`);
    await migrationReadStarted.promise;
    const firstReviewPromise = dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    let firstReview = null;
    void firstReviewPromise.then((response) => {
      firstReview = response;
    });
    t.mock.timers.tick(8_000);
    await flushMicrotasks(60);
    assert.ok(firstReview, 'the bounded privacy read must settle the waiting request');
    assert.equal(firstReview.ok, false);
    assert.equal(firstReview.errorCode, 'lifecycle_not_ready');
    assert.equal(reviewWindowInspections, 0);
    assert.equal(chrome.__state.local[STORAGE_KEYS.settings].privacyDefaultsAppliedAt, null);

    releaseMigrationRead.resolve();
    await flushMicrotasks(60);
    const retryPromise = dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    let retry = null;
    void retryPromise.then((response) => {
      retry = response;
    });
    await driveZeroDelayTimers(t, () => Boolean(retry));
    assert.equal(retry.ok, true, retry.error);
    assert.equal(reviewWindowInspections, 1);
    assert.ok(chrome.__state.local[STORAGE_KEYS.settings].privacyDefaultsAppliedAt);
    assert.equal(cleanupMutationCallCount(chrome), 0);
  } finally {
    releaseMigrationRead.resolve();
    delete globalThis.chrome;
  }
});

test('a timed-out proven-empty shield CAS read releases startup readiness and retries without worker restart', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const now = new Date().toISOString();
  const shield = {
    domain: 'bounded-shield.example',
    displayName: 'bounded-shield.example',
    associatedTargets: [],
    ruleIds: [730000],
    urlFilters: ['||bounded-shield.example^'],
    mode: 'cleanup-only',
    lifecycle: 'active',
    pendingMutation: false,
    expiresAt: null,
    startedAt: now,
    jobId: 'bounded-shield-recovery-job'
  };
  const chrome = await createChromeMock({
    dnrRules: [],
    localState: {
      [STORAGE_KEYS.settings]: readySettings(now),
      [STORAGE_KEYS.activeShield]: shield
    }
  });
  const shieldCasReadStarted = deferred();
  const releaseShieldCasRead = deferred();
  const originalLocalGet = chrome.storage.local.get;
  const originalUpdateRules = chrome.declarativeNetRequest.updateSessionRules;
  const originalGetWindow = chrome.windows.get;
  let recoveryClearObserved = false;
  let blocked = false;
  let reviewWindowInspections = 0;
  chrome.declarativeNetRequest.updateSessionRules = async (...args) => {
    const result = await originalUpdateRules(...args);
    recoveryClearObserved = true;
    return result;
  };
  chrome.storage.local.get = async (keys) => {
    if (
      !blocked &&
      recoveryClearObserved &&
      Array.isArray(keys) &&
      keys.length === 1 &&
      keys[0] === STORAGE_KEYS.activeShield
    ) {
      blocked = true;
      shieldCasReadStarted.resolve();
      await releaseShieldCasRead.promise;
    }
    return originalLocalGet(keys);
  };
  chrome.windows.get = async (...args) => {
    reviewWindowInspections += 1;
    return originalGetWindow(...args);
  };

  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?bounded-shield-cas-retry=${uniqueImportKey()}`);
    await shieldCasReadStarted.promise;
    const firstReviewPromise = dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    let firstReview = null;
    void firstReviewPromise.then((response) => {
      firstReview = response;
    });
    t.mock.timers.tick(8_000);
    await flushMicrotasks(60);
    assert.ok(firstReview, 'the bounded shield CAS read must settle the waiting request');
    assert.equal(firstReview.ok, false);
    assert.equal(firstReview.errorCode, 'lifecycle_not_ready');
    assert.equal(reviewWindowInspections, 0);
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeShield].jobId, shield.jobId);

    releaseShieldCasRead.resolve();
    await flushMicrotasks(60);
    const retryPromise = dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    let retry = null;
    void retryPromise.then((response) => {
      retry = response;
    });
    await driveZeroDelayTimers(t, () => Boolean(retry));
    assert.equal(retry.ok, true, retry.error);
    assert.equal(reviewWindowInspections, 1);
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeShield], null);
    assert.equal(cleanupMutationCallCount(chrome), 0);
  } finally {
    releaseShieldCasRead.resolve();
    delete globalThis.chrome;
  }
});

test('a timed-out browser-session shield CAS read preserves its marker and succeeds in a fresh generation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const now = new Date().toISOString();
  const shield = {
    domain: 'bounded-boundary.example',
    displayName: 'bounded-boundary.example',
    associatedTargets: [],
    ruleIds: [730001],
    urlFilters: ['||bounded-boundary.example^'],
    mode: 'cleanup-only',
    lifecycle: 'unknown',
    pendingMutation: true,
    expiresAt: null,
    startedAt: now,
    jobId: 'bounded-boundary-shield-job'
  };
  const marker = {
    schemaVersion: 1,
    mutationId: 'dnr-bounded-boundary-marker',
    sessionBinding: 'bound',
    jobId: shield.jobId,
    shieldStartedAt: shield.startedAt,
    recordedAt: now
  };
  const chrome = await createChromeMock({
    dnrRules: [],
    localState: {
      [STORAGE_KEYS.settings]: readySettings(now),
      [STORAGE_KEYS.activeShield]: shield,
      'sitewipe.dnrPendingMutation.v1': marker
    },
    sessionState: {}
  });
  const shieldCasReadStarted = deferred();
  const releaseShieldCasRead = deferred();
  const originalLocalGet = chrome.storage.local.get;
  const originalGetSessionRules = chrome.declarativeNetRequest.getSessionRules;
  const originalGetWindow = chrome.windows.get;
  let boundaryDiagnosticsObserved = false;
  let blocked = false;
  let reviewWindowInspections = 0;
  chrome.declarativeNetRequest.getSessionRules = async (...args) => {
    const result = await originalGetSessionRules(...args);
    boundaryDiagnosticsObserved = true;
    return result;
  };
  chrome.storage.local.get = async (keys) => {
    if (
      !blocked &&
      boundaryDiagnosticsObserved &&
      Array.isArray(keys) &&
      keys.length === 1 &&
      keys[0] === STORAGE_KEYS.activeShield
    ) {
      blocked = true;
      shieldCasReadStarted.resolve();
      await releaseShieldCasRead.promise;
    }
    return originalLocalGet(keys);
  };
  chrome.windows.get = async (...args) => {
    reviewWindowInspections += 1;
    return originalGetWindow(...args);
  };

  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?bounded-boundary-cas-retry=${uniqueImportKey()}`);
    await shieldCasReadStarted.promise;
    const firstReviewPromise = dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    let firstReview = null;
    void firstReviewPromise.then((response) => {
      firstReview = response;
    });
    t.mock.timers.tick(8_000);
    await flushMicrotasks(60);
    assert.ok(firstReview, 'the bounded browser-session CAS read must settle the waiting request');
    assert.equal(firstReview.ok, false);
    assert.equal(firstReview.errorCode, 'lifecycle_not_ready');
    assert.equal(reviewWindowInspections, 0);
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeShield].jobId, shield.jobId);
    assert.deepEqual(chrome.__state.local['sitewipe.dnrPendingMutation.v1'], marker);

    releaseShieldCasRead.resolve();
    await flushMicrotasks(60);
    const retryPromise = dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
    let retry = null;
    void retryPromise.then((response) => {
      retry = response;
    });
    await driveZeroDelayTimers(t, () => Boolean(retry));
    assert.equal(retry.ok, true, retry.error);
    assert.equal(reviewWindowInspections, 1);
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeShield], null);
    assert.equal(chrome.__state.local['sitewipe.dnrPendingMutation.v1'], undefined);
    assert.equal(cleanupMutationCallCount(chrome), 0);
  } finally {
    releaseShieldCasRead.resolve();
    delete globalThis.chrome;
  }
});

for (const candidate of [
  { name: 'legacy-setting read', hangAtSettingsRead: 1 },
  { name: 'update settings inspection', hangAtSettingsRead: 2 },
  { name: 'settings CAS reread', hangAtSettingsRead: 3 }
]) {
  test(`a timed-out ${candidate.name} releases update maintenance for an exact fresh replay`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const now = new Date().toISOString();
    const chrome = await createChromeMock({
      localState: {
        [STORAGE_KEYS.settings]: readySettings(now)
      }
    });
    const originalGetWindow = chrome.windows.get;
    let reviewWindowInspections = 0;
    chrome.windows.get = async (...args) => {
      reviewWindowInspections += 1;
      return originalGetWindow(...args);
    };

    globalThis.chrome = chrome;
    const releaseSettingsRead = deferred();
    try {
      await import(
        `../../src/background/service-worker.js?bounded-update-${slug(candidate.name)}=${uniqueImportKey()}`
      );
      const initialReviewPromise = dispatchRuntimeMessageWithoutTimer(
        chrome,
        prepareReviewMessage(),
        popupSender(chrome)
      );
      let initialReview = null;
      void initialReviewPromise.then((response) => {
        initialReview = response;
      });
      await driveZeroDelayTimers(t, () => Boolean(initialReview));
      assert.equal(initialReview.ok, true, initialReview.error);
      const canceled = await dispatchRuntimeMessageWithoutTimer(
        chrome,
        {
          type: MESSAGE_TYPES.cancelCleanupReview,
          payload: {
            approvalToken: initialReview.review.approvalToken,
            ...popupPreparationBinding(initialReview),
            promptNotStarted: true
          }
        },
        popupSender(chrome)
      );
      assert.equal(canceled.ok, true, canceled.error);
      const inspectionsBeforeUpdate = reviewWindowInspections;

      const originalLocalGet = chrome.storage.local.get;
      const originalLocalSet = chrome.storage.local.set;
      await originalLocalSet({
        [STORAGE_KEYS.settings]: {
          ...chrome.__state.local[STORAGE_KEYS.settings],
          contentSettingReset: true,
          keepHistory: true,
          performanceDefaultsAppliedAt: null
        }
      });
      const settingsReadStarted = deferred();
      let settingsReads = 0;
      let blocked = false;
      chrome.storage.local.get = async (keys) => {
        if (Array.isArray(keys) && keys.length === 1 && keys[0] === STORAGE_KEYS.settings) {
          settingsReads += 1;
          if (!blocked && settingsReads === candidate.hangAtSettingsRead) {
            blocked = true;
            settingsReadStarted.resolve();
            await releaseSettingsRead.promise;
          }
        }
        return originalLocalGet(keys);
      };

      const updatePromise = chrome.__events.runtimeInstalled.emitAsync({ reason: 'update' });
      void updatePromise.catch(() => {});
      await settingsReadStarted.promise;
      const firstReviewPromise = dispatchRuntimeMessageWithoutTimer(
        chrome,
        prepareReviewMessage(),
        popupSender(chrome)
      );
      let firstReview = null;
      void firstReviewPromise.then((response) => {
        firstReview = response;
      });
      t.mock.timers.tick(8_000);
      await flushMicrotasks(60);
      assert.ok(firstReview, `the bounded ${candidate.name} must settle the waiting request`);
      assert.equal(firstReview.ok, false);
      assert.equal(firstReview.errorCode, 'lifecycle_not_ready');
      assert.equal(reviewWindowInspections, inspectionsBeforeUpdate);

      releaseSettingsRead.resolve();
      await updatePromise;
      await flushMicrotasks(60);
      const retryPromise = dispatchRuntimeMessageWithoutTimer(chrome, prepareReviewMessage(), popupSender(chrome));
      let retry = null;
      void retryPromise.then((response) => {
        retry = response;
      });
      await driveZeroDelayTimers(t, () => Boolean(retry));
      assert.equal(retry.ok, true, retry.error);
      assert.equal(reviewWindowInspections, inspectionsBeforeUpdate + 1);
      assert.equal(chrome.__state.local[STORAGE_KEYS.settings].keepHistory, false);
      assert.ok(chrome.__state.local[STORAGE_KEYS.settings].performanceDefaultsAppliedAt);
      assert.equal(Object.hasOwn(chrome.__state.local[STORAGE_KEYS.settings], 'contentSettingReset'), false);
      assert.equal(cleanupMutationCallCount(chrome), 0);
    } finally {
      releaseSettingsRead.resolve();
      delete globalThis.chrome;
    }
  });
}

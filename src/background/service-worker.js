import { DEFAULT_SETTINGS, MESSAGE_PROTOCOL_VERSION, MESSAGE_TYPES, STORAGE_KEYS } from '../shared/constants.js';
import {
  getSettings,
  saveSettings,
  resetSettings,
  getReports,
  getLastReport,
  saveReport,
  clearReports,
  clearReportHistory,
  clearDebugLog,
  appendDebug,
  getDebugLog,
  getActiveJob,
  setActiveJob,
  mutateActiveJob,
  clearActiveJob,
  getActiveShield,
  setActiveShield,
  mutateActiveShield,
  forgetLatestReport,
  getLatestReportExpiration,
  getLastMaintenance,
  setLastMaintenance,
  clearLastMaintenance,
  migrateStoredReportsToPrivacyDefaults,
  normalizeStoredSettings,
  withStorageMutation
} from '../shared/storage.js';
import { normalizeSiteInput, validateAssociatedDomainGroups, runDomainSelfTests } from './domain.js';
import { addError, addSection, finishReport } from './report.js';
import { initializeReviewedCleanupReport, isCleanupCancellationError } from './cleanup-authorization.js';
import { runDeepClean, getSiteWipeDnrDiagnostics, inspectCleanupImpact } from './cleanup.js';
import { reconcileOwnedShieldState } from './shield-recovery.js';
import { findProtectedBrowserServiceTargets } from '../shared/safety.js';
import { getEffectiveCleanupSettings } from '../shared/cleanup-mode.js';
import {
  prepareCleanupReviewRequest,
  stageCleanupReviewApprovalRequest,
  armCleanupReviewApprovalRequest,
  getReadyArmedCleanupReview,
  finalizeArmedCleanupReviewAdmission,
  cancelCleanupReviewRequest,
  consumeCleanupReviewRequest,
  clearExpiredCleanupReview,
  clearCleanupReviewState,
  CLEANUP_REVIEW_STORAGE_KEY,
  normalizeCleanupReviewRecord,
  getTemporaryReviewHostPermissionOrigins,
  getGrantedHostPermissionOrigins,
  assertLeaseOwnedCleanupPermissionInventory,
  assertCleanupReviewPopupBinding
} from './cleanup-preflight.js';
import { validateMessageEnvelope } from '../shared/message-contracts.js';
import { redactReport } from '../shared/report-redaction.js';
import { getPermissionLease, reconcilePermissionLease } from './permission-leases.js';
import { buildHostPermissionInventory, isBroadHostPermissionOrigin } from '../shared/host-permissions.js';
import { withTimeoutReject } from './operation-control.js';
import { hasPendingSiteWipeDnrMutation } from './dnr-shield.js';
import {
  createSidePanelReportBinding,
  getSidePanelReportBindingStorageKey,
  normalizeSidePanelReportBinding
} from '../shared/side-panel-report-binding.js';

let cleanInProgress = false;
let cleanupReviewPreparationInProgress = false;
let cleanupLifecycleReservation = null;
let interactiveMaintenanceWaiters = 0;
let serviceWorkerLoadReadinessState = Object.freeze({
  status: 'idle',
  generation: 0,
  promise: Promise.resolve()
});
let deferredMaintenanceFlushScheduled = false;
let deferredMaintenanceRetryBlocked = false;
let deferredMaintenanceRevision = 0;
const deferredMaintenanceRequests = new Map();
let privacyMigrationPromise = null;
let permissionLeaseRecoveryPromise = Promise.resolve();
let armedCleanupResumePromise = null;
let armedCleanupResumeRevision = 0;
let armedCleanupResumeProcessedRevision = 0;
const armedCleanupResumeSignals = [];
const armedCleanupResumeWaiters = [];
const pendingCleanupApprovalArms = new Map();
const cleanupApprovalArmContinuations = new Map();
const cleanupPromptSettlementContinuations = new Map();
let cleanupReviewStateMutationPromise = Promise.resolve();
let alarmMutationPromise = Promise.resolve();
let maintenanceAlarmRefreshQueued = false;
let maintenanceAlarmRefreshRequested = false;
const ACTIVE_JOB_STALE_MS = 2 * 60 * 60 * 1000;
const PERMISSION_INSPECTION_TIMEOUT_MS = 5_000;
const MAINTENANCE_READ_TIMEOUT_MS = 5_000;
const MAINTENANCE_HANDOFF_TIMEOUT_MS = 8_000;
const REPORT_STATE_MAINTENANCE_MUTATION = 'sitewipe.report-state';
const DNR_PENDING_MUTATION_LOCAL_KEY = 'sitewipe.dnrPendingMutation.v1';
const DNR_PENDING_MUTATION_SESSION_KEY = 'sitewipe.dnrPendingMutation.session.v1';
const ALARMS = Object.freeze({
  maintenance: 'sitewipe.maintenance',
  shieldExpiry: 'sitewipe.shieldExpiry',
  reportExpiry: 'sitewipe.reportExpiry',
  staleJob: 'sitewipe.staleJob',
  reviewExpiry: 'sitewipe.reviewExpiry'
});

chrome.runtime.onInstalled.addListener(({ reason }) =>
  requestInstalledLifecycleMaintenance(reason).catch((error) =>
    appendDebug({
      level: 'error',
      message: 'Install/update maintenance failed',
      stack: error?.stack
    }).catch(() => {})
  )
);

chrome.runtime.onStartup?.addListener?.(() =>
  requestLifecycleMaintenance('startup', {
    ensurePrivacyDefaults: true,
    forceStaleJobRecovery: true,
    browserSessionBoundary: true,
    record: false
  }).catch((error) =>
    appendDebug({
      level: 'error',
      message: 'Startup maintenance failed',
      stack: error?.stack
    }).catch(() => {})
  )
);

const serviceWorkerLoadReadinessPromise = startServiceWorkerLoadReadinessMaintenance('service-worker-load');
serviceWorkerLoadReadinessPromise.catch((error) =>
  appendDebug({
    level: 'error',
    message: 'Service-worker-load maintenance failed',
    stack: error?.stack
  }).catch(() => {})
);

chrome.alarms?.onAlarm?.addListener?.((alarm) =>
  handleMaintenanceAlarm(alarm).catch((error) =>
    appendDebug({
      level: 'error',
      message: 'Maintenance alarm failed',
      alarm: alarm?.name,
      stack: error?.stack
    }).catch(() => {})
  )
);

chrome.permissions?.onAdded?.addListener?.(() => {
  void queueArmedCleanupResume('permissions-added').catch((error) =>
    appendDebug({
      level: 'error',
      message: 'Armed cleanup permission handoff did not settle',
      errorName: error?.name || 'Error'
    }).catch(() => {})
  );
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) =>
      sendResponse({
        ...result,
        protocolVersion: MESSAGE_PROTOCOL_VERSION,
        requestId: safeResponseRequestId(message),
        ok: true
      })
    )
    .catch((error) => {
      if (error?.name !== 'MessageValidationError') {
        appendDebug({
          level: 'error',
          message: error?.message || String(error),
          stack: error?.stack
        }).catch(() => {});
      }
      const classification = classifyResponseError(error);
      sendResponse({
        ...classification,
        protocolVersion: MESSAGE_PROTOCOL_VERSION,
        requestId: safeResponseRequestId(message),
        ok: false,
        error: error?.message || String(error)
      });
    });
  return true;
});

function safeResponseRequestId(message) {
  return typeof message?.requestId === 'string' ? message.requestId : `legacy:${String(message?.type || 'unknown')}`;
}

function serializeCleanupReviewStateMutation(operation) {
  const queued = cleanupReviewStateMutationPromise.catch(() => {}).then(operation);
  cleanupReviewStateMutationPromise = queued.catch(() => {});
  return queued;
}

function getPendingCleanupApprovalPromptContextId(record) {
  const nonce = String(record?.approvalHandoffNonce || '');
  const owner = pendingCleanupApprovalArms.get(nonce);
  return owner?.approvalToken === record?.token && owner.handoffNonce === nonce ? owner.promptContextId : null;
}

function requeueRestoredCleanupPromptTombstone(handoffNonce) {
  const nonce = String(handoffNonce || '');
  if (!nonce) return;
  void queueArmedCleanupResume('prompt-owner-restored-after-invalidation', nonce).catch(() => {});
}

async function completeStagedCleanupApproval(payload, promptContextId) {
  while (true) {
    const peerReservation = cleanupLifecycleReservation;
    if (!peerReservation || peerReservation.kind === 'cleanup') break;
    let settlement;
    try {
      settlement = await withTimeoutReject(
        peerReservation.settled,
        MAINTENANCE_HANDOFF_TIMEOUT_MS,
        'Staged cleanup approval peer handoff'
      );
    } catch (error) {
      if (error?.name !== 'OperationTimeoutError') throw error;
      throw new LifecycleNotReadyError(peerReservation.action, 'settlement-wait', { peerReservation });
    }
    if (settlement?.status !== 'fulfilled') {
      throw new LifecycleNotReadyError(peerReservation.action, settlement?.stage || 'maintenance', {
        peerReservation
      });
    }
  }
  const armed = await withCleanupLifecycleReservation('review', 'arm a cleanup approval', async () => {
    if (cleanInProgress || isActiveRunningJob(await getActiveJob())) {
      throw new Error('A SiteWipe cleanup is already running. Wait for it to finish.');
    }
    await assertNoPendingDnrInstallMutation('arm another cleanup approval');
    return serializeCleanupReviewStateMutation(() =>
      armCleanupReviewApprovalRequest(payload, {
        storageSession: chrome.storage.session,
        storageLocal: chrome.storage.local,
        getSettings: getPermissionAwareSettings,
        isIncognitoAllowed,
        inspectSourceWindow,
        promptContextId,
        requirePopupPreparationCapability: true
      })
    );
  });
  queueAlarmAt(ALARMS.reviewExpiry, armed.expiresAt);
  setTimeout(() => void queueArmedCleanupResume('approval-armed', armed.handoffNonce).catch(() => {}));
  return armed;
}

async function tombstoneStagedCleanupApproval(payload, reason) {
  return serializeCleanupReviewStateMutation(() =>
    cancelCleanupReviewRequest(
      { approvalToken: payload.approvalToken },
      {
        storageSession: chrome.storage.session,
        storageLocal: chrome.storage.local,
        containsHostPermissions: containsHostPermissionsStrict,
        getAllHostPermissions: getAllHostPermissionsStrict,
        releaseHostPermissions: releaseTemporaryHostPermissions,
        retainPreparedPromptOwnership: true,
        getPendingPromptContextId: getPendingCleanupApprovalPromptContextId,
        onPromptTombstoneRestored: requeueRestoredCleanupPromptTombstone,
        tombstoneReason: reason || 'approval_authority_rejected'
      }
    )
  );
}

function scheduleStagedCleanupApprovalContinuation(payload, promptContextId, peerReservation, owner) {
  const nonce = String(payload.handoffNonce || '');
  if (!nonce || cleanupApprovalArmContinuations.has(nonce)) return;
  const continuation = Promise.resolve(peerReservation?.settled)
    .catch(() => null)
    .then(() => completeStagedCleanupApproval(payload, promptContextId))
    .catch(async (error) => {
      await tombstoneStagedCleanupApproval(payload, 'approval_continuation_rejected').catch(() => {});
      void queueArmedCleanupResume('approval-continuation-rejected', nonce).catch(() => {});
      await appendDebug({
        level: 'error',
        message: 'Staged cleanup approval could not finish after lifecycle settlement',
        errorName: error?.name || 'Error'
      }).catch(() => {});
    })
    .finally(() => {
      if (pendingCleanupApprovalArms.get(nonce) === owner) pendingCleanupApprovalArms.delete(nonce);
      cleanupApprovalArmContinuations.delete(nonce);
    });
  cleanupApprovalArmContinuations.set(nonce, continuation);
  void continuation;
}

async function performPopupCleanupPromptSettlement(payload, promptContextId) {
  while (true) {
    const peerReservation = cleanupLifecycleReservation;
    if (!peerReservation || peerReservation.kind === 'cleanup') break;
    try {
      await withTimeoutReject(
        peerReservation.settled,
        MAINTENANCE_HANDOFF_TIMEOUT_MS,
        'Native cleanup prompt settlement peer handoff'
      );
    } catch (error) {
      if (error?.name !== 'OperationTimeoutError') throw error;
      throw new LifecycleNotReadyError(peerReservation.action, 'settlement-wait', { peerReservation });
    }
  }
  return runPermissionPromptSettlementLifecycleAction('settle target site access', async () => {
    const settlement = await serializeCleanupReviewStateMutation(() =>
      settleCleanupPermissionPromptByLeaseId(payload.permissionLeaseId, {
        storageSession: chrome.storage.session,
        storageLocal: chrome.storage.local,
        expectedApprovalToken: payload.approvalToken,
        expectedHandoffNonce: payload.handoffNonce,
        expectedPromptContextId: promptContextId,
        popupContextId: payload.popupContextId,
        popupPreparationCapability: payload.popupPreparationCapability,
        expectedOutcome: payload.outcome
      })
    );
    return { settlement, outcome: payload.outcome };
  });
}

function schedulePopupCleanupPromptSettlementContinuation(payload, promptContextId, peerReservation) {
  const key = `${payload.permissionLeaseId}:${payload.handoffNonce}:${promptContextId}`;
  if (cleanupPromptSettlementContinuations.has(key)) return;
  const continuation = (async () => {
    let peer = peerReservation;
    while (peer) {
      await peer.settled.catch(() => null);
      try {
        return await performPopupCleanupPromptSettlement(payload, promptContextId);
      } catch (error) {
        if (error?.name !== 'LifecycleNotReadyError' || !error.peerReservation) throw error;
        peer = error.peerReservation;
      }
    }
    return null;
  })()
    .catch((error) =>
      appendDebug({
        level: 'error',
        message: 'Native cleanup prompt settlement could not finish after lifecycle settlement',
        errorName: error?.name || 'Error'
      }).catch(() => {})
    )
    .finally(() => cleanupPromptSettlementContinuations.delete(key));
  cleanupPromptSettlementContinuations.set(key, continuation);
  void continuation;
}

function queueArmedCleanupResume(reason, expectedNonce = null) {
  const revision = ++armedCleanupResumeRevision;
  armedCleanupResumeSignals.push({
    revision,
    reason: String(reason || 'unknown'),
    expectedNonce: expectedNonce ? String(expectedNonce) : null
  });
  const result = new Promise((resolve, reject) => {
    armedCleanupResumeWaiters.push({ revision, resolve, reject });
  });
  ensureArmedCleanupResumeDrain();
  return result;
}

function ensureArmedCleanupResumeDrain() {
  if (armedCleanupResumePromise) return;
  const resume = drainArmedCleanupResumeSignals();
  const trackedResume = resume.finally(() => {
    if (armedCleanupResumePromise !== trackedResume) return;
    armedCleanupResumePromise = null;
    if (armedCleanupResumeProcessedRevision < armedCleanupResumeRevision) ensureArmedCleanupResumeDrain();
  });
  void trackedResume.catch(() => {});
  armedCleanupResumePromise = trackedResume;
}

async function drainArmedCleanupResumeSignals() {
  while (armedCleanupResumeProcessedRevision < armedCleanupResumeRevision) {
    const pendingSignals = armedCleanupResumeSignals.filter(
      (signal) => signal.revision > armedCleanupResumeProcessedRevision
    );
    let expectedNonce = pendingSignals[0]?.expectedNonce || null;
    let targetRevision = pendingSignals[0]?.revision || armedCleanupResumeProcessedRevision;
    let reason = pendingSignals[0]?.reason || 'unknown';
    // A pass may coalesce only consecutive signals with the same identity:
    // wake-only signals with wake-only signals, or one explicit nonce with
    // repetitions of that nonce. Mixing null and explicit signals can let a
    // stale popup consume Chrome's sole onAdded wake for the current approval.
    for (const signal of pendingSignals.slice(1)) {
      if ((signal.expectedNonce || null) !== expectedNonce) break;
      targetRevision = signal.revision;
      reason = signal.reason;
    }
    try {
      const result = await resumeArmedCleanupAfterGrant(reason, expectedNonce);
      if (armedCleanupResumeResultIsImmutable(result, expectedNonce)) {
        // Same-nonce signals that arrived while this pass was in flight are
        // continuations of this immutable proof. Share it before a conclusive
        // cancellation removes its review/lease identity. Pending, uncertain,
        // running, errored, wake-only, or different-nonce signals always get a
        // fresh pass so a later grant/peer settlement cannot be swallowed.
        targetRevision = extendArmedCleanupResumeTargetRevision(targetRevision, expectedNonce);
      }
      armedCleanupResumeProcessedRevision = targetRevision;
      settleArmedCleanupResumeWaiters(targetRevision, { result });
    } catch (error) {
      armedCleanupResumeProcessedRevision = targetRevision;
      settleArmedCleanupResumeWaiters(targetRevision, { error });
    }
    while (armedCleanupResumeSignals[0]?.revision <= armedCleanupResumeProcessedRevision) {
      armedCleanupResumeSignals.shift();
    }
  }
}

function armedCleanupResumeResultIsImmutable(result, expectedNonce) {
  if (!expectedNonce || result?.approvalHandoffNonce !== expectedNonce) return false;
  if (result.report && typeof result.report === 'object') return true;
  return Boolean(
    result.approvalHandoffCanceled === true &&
    result.cleanupStarted === false &&
    result.temporaryAccessReleased === true &&
    result.settlement?.released === true &&
    result.settlement.accessRemains === false &&
    result.settlement.recordRetained === false
  );
}

function extendArmedCleanupResumeTargetRevision(targetRevision, expectedNonce) {
  let extendedRevision = targetRevision;
  for (const signal of armedCleanupResumeSignals) {
    if (signal.revision <= targetRevision) continue;
    if ((signal.expectedNonce || null) !== expectedNonce) break;
    extendedRevision = signal.revision;
  }
  return extendedRevision;
}

function settleArmedCleanupResumeWaiters(maxRevision, { result, error }) {
  for (let index = armedCleanupResumeWaiters.length - 1; index >= 0; index -= 1) {
    const waiter = armedCleanupResumeWaiters[index];
    if (waiter.revision > maxRevision) continue;
    armedCleanupResumeWaiters.splice(index, 1);
    if (error) waiter.reject(error);
    else waiter.resolve(result);
  }
}

async function resumeArmedCleanupAfterGrant(reason, expectedNonce = null) {
  const retryDelays = [0, 40, 120, 240, 480];
  let ready;
  let lastError;
  // A readiness generation can settle while the interactive request that
  // triggered it is about to acquire a short review/admin reservation. Do not
  // consume the sole durable wake by racing that peer. Wait for its exact
  // settlement, then repeat the strict review + permission-inventory proof.
  // Once the final check observes no peer, handleMessage synchronously claims
  // cleanup admission before this task can yield again.
  while (true) {
    ready = null;
    lastError = null;
    for (const delayMs of retryDelays) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        ready = await getReadyArmedCleanupReview({
          storageSession: chrome.storage.session,
          storageLocal: chrome.storage.local,
          containsHostPermissions: containsHostPermissionsStrict,
          getAllHostPermissions: getAllHostPermissionsStrict
        });
        if (ready) break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!ready) break;
    if (expectedNonce && ready.handoffNonce !== expectedNonce) {
      throw new Error('The armed cleanup handoff changed before Chrome target access settled.');
    }
    const peerReservation = cleanupLifecycleReservation;
    if (!peerReservation || peerReservation.kind === 'cleanup') break;
    try {
      await withTimeoutReject(
        peerReservation.settled,
        MAINTENANCE_HANDOFF_TIMEOUT_MS,
        'Armed cleanup peer reservation handoff'
      );
    } catch (error) {
      if (error?.name === 'OperationTimeoutError') {
        // The durable armed record remains authoritative, but this queue pass
        // is about to settle. Preserve the sole wake across a slow peer by
        // attaching a one-shot continuation to that exact reservation rather
        // than polling or accepting stale authority.
        void peerReservation.settled
          .then(() => queueArmedCleanupResume(`${reason}:peer-settled`, expectedNonce))
          .catch(() => {});
      }
      throw error;
    }
  }
  if (!ready) {
    const peerReservation = cleanupLifecycleReservation;
    if (peerReservation && peerReservation.kind !== 'cleanup') {
      try {
        await withTimeoutReject(
          peerReservation.settled,
          MAINTENANCE_HANDOFF_TIMEOUT_MS,
          'Cleanup approval settlement peer handoff'
        );
      } catch (error) {
        if (error?.name === 'OperationTimeoutError') {
          void peerReservation.settled
            .then(() => queueArmedCleanupResume(`${reason}:settlement-peer-settled`, expectedNonce))
            .catch(() => {});
        }
        throw error;
      }
      return resumeArmedCleanupAfterGrant(`${reason}:settlement-peer-settled`, expectedNonce);
    }
    const runningResult = expectedNonce ? await getRunningArmedCleanupResult(expectedNonce) : null;
    if (runningResult) return runningResult;
    const completedResult = expectedNonce ? await getCompletedArmedCleanupResult(expectedNonce) : null;
    if (completedResult) return completedResult;
    const latePromptSettlement = await reconcileLateCleanupPermissionGrant(reason, expectedNonce);
    if (latePromptSettlement?.settled) {
      return {
        approvalHandoffPending: false,
        approvalHandoffCanceled: true,
        cleanupStarted: false,
        temporaryAccessReleased: true,
        ...(expectedNonce ? { approvalHandoffNonce: expectedNonce } : {}),
        reason,
        settlement: latePromptSettlement.settlement
      };
    }
    if (expectedNonce) {
      return {
        approvalHandoffPending: true,
        approvalHandoffUncertain: true,
        cleanupStarted: null,
        temporaryAccessReleased: null,
        approvalHandoffNonce: expectedNonce,
        reason,
        warning:
          lastError?.message ||
          'SiteWipe could not yet prove whether the nonce-bound cleanup started or whether temporary target access was released.'
      };
    }
    return { approvalHandoffPending: true, reason };
  }
  const result = await handleMessage(
    {
      protocolVersion: MESSAGE_PROTOCOL_VERSION,
      requestId: `handoff-${ready.handoffNonce}`,
      type: MESSAGE_TYPES.runDeepClean,
      payload: ready.payload
    },
    {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('background/service-worker.js')
    },
    { expectedApprovalHandoffNonce: ready.handoffNonce }
  );
  return { ...result, approvalHandoffNonce: ready.handoffNonce };
}

async function getRunningArmedCleanupResult(expectedNonce) {
  const activeJob = await getActiveJob();
  if (
    activeJob?.status !== 'running' ||
    activeJob.admissionPhase !== 'admitted' ||
    activeJob.approvalHandoffNonce !== expectedNonce
  ) {
    return null;
  }
  return {
    approvalHandoffPending: false,
    approvalHandoffRunning: true,
    cleanupStarted: true,
    temporaryAccessReleased: false,
    approvalHandoffNonce: expectedNonce,
    activeJob
  };
}

async function getCompletedArmedCleanupResult(expectedNonce) {
  const activeJob = await getActiveJob();
  if (
    !['completed', 'failed', 'cancelled', 'interrupted'].includes(activeJob?.status) ||
    activeJob.approvalHandoffNonce !== expectedNonce ||
    (activeJob.status === 'completed' && activeJob.admissionPhase !== 'admitted')
  ) {
    return null;
  }
  const storedReport = await getLastReport();
  const report = storedReport?.id === activeJob.id ? storedReport : createRecoveredArmedCleanupReport(activeJob);
  return {
    report,
    reportPersisted: storedReport?.id === activeJob.id,
    completionWarnings: getRecoveredArmedCleanupWarnings(report, activeJob),
    approvalHandoffNonce: expectedNonce,
    resumedCompletedResult: activeJob.status === 'completed',
    resumedTerminalResult: true
  };
}

function createRecoveredArmedCleanupReport(job) {
  const completedWithWarnings = job.status === 'completed' && /warning/i.test(`${job.label || ''} ${job.detail || ''}`);
  const status = completedWithWarnings ? 'completed_with_warnings' : job.status;
  const message =
    job.detail ||
    (status === 'completed'
      ? 'Cleanup finished, but its detailed transient report is no longer available.'
      : status === 'completed_with_warnings'
        ? 'Cleanup finished with warnings, but its detailed transient report is no longer available.'
        : status === 'cancelled'
          ? 'Cleanup was cancelled before it could finish.'
          : status === 'failed'
            ? 'Cleanup failed before it could finish.'
            : 'Cleanup was interrupted before it could finish.');
  const finishedAt =
    job.completedAt || job.failedAt || job.canceledAt || job.interruptedAt || job.updatedAt || new Date().toISOString();
  const errors = ['failed', 'completed_with_warnings'].includes(status)
    ? [{ label: job.label || 'Cleanup outcome', message }]
    : [];
  const skipped = status === 'cancelled' ? [{ label: job.label || 'Cleanup cancelled', reason: message }] : [];
  const unavailable =
    status === 'interrupted'
      ? [{ label: job.label || 'Cleanup interrupted', reason: message }]
      : [
          {
            label: 'Detailed cleanup report',
            reason: 'The original transient report was not persisted or is no longer retained.'
          }
        ];
  return {
    id: job.id,
    appVersion: String(chrome.runtime.getManifest()?.version || 'unknown'),
    input: '[redacted]',
    targetDomain: '[redacted-target]',
    startedAt: job.startedAt,
    finishedAt,
    status,
    redacted: true,
    summary: {
      verificationStatus: 'unknown',
      verificationRemainingTotal: null,
      cleanupConfidenceLabel: 'Unavailable',
      note: message
    },
    sections: [],
    errors,
    skipped,
    unavailable,
    integrity: null
  };
}

function getRecoveredArmedCleanupWarnings(report, job) {
  if (report.status !== 'completed_with_warnings') return [];
  const warnings = (report.errors || [])
    .map((entry) => entry?.message || entry?.reason || entry?.label)
    .filter((message) => typeof message === 'string' && message.trim());
  return warnings.length
    ? warnings
    : [job.detail || job.label || 'Cleanup finished with warnings; review the recovered terminal result.'];
}

async function reconcileLateCleanupPermissionGrant(reason, expectedNonce = null) {
  const initial = await readCleanupReviewRecord(chrome.storage.session);
  const initialHandoff = initial?.approvalHandoff;
  const expiredFinalClick = Boolean(
    ['arming', 'armed'].includes(initialHandoff?.status) &&
    Number.isFinite(initial?.expiresAtMs) &&
    Date.now() > initial.expiresAtMs
  );
  if (initialHandoff?.status !== 'prompt_tombstone' && !expiredFinalClick) return null;
  if (expectedNonce && initialHandoff?.nonce !== expectedNonce) {
    throw new Error('The cleanup permission handoff changed before Chrome target access settled.');
  }

  return runPermissionPromptSettlementLifecycleAction(`reconcile ${reason} target site access`, () =>
    serializeCleanupReviewStateMutation(async () => {
      let review = await readCleanupReviewRecord(chrome.storage.session);
      if (!review?.approvalHandoff) return null;
      if (expectedNonce && review.approvalHandoff.nonce !== expectedNonce) {
        throw new Error('The cleanup permission handoff changed before Chrome target access settled.');
      }
      if (
        ['arming', 'armed'].includes(review.approvalHandoff.status) &&
        Number.isFinite(review.expiresAtMs) &&
        Date.now() > review.expiresAtMs
      ) {
        await cancelCleanupReviewRequest(
          { approvalToken: review.token },
          {
            storageSession: chrome.storage.session,
            storageLocal: chrome.storage.local,
            containsHostPermissions: containsHostPermissionsStrict,
            getAllHostPermissions: getAllHostPermissionsStrict,
            releaseHostPermissions: releaseTemporaryHostPermissions,
            retainPreparedPromptOwnership: true,
            getPendingPromptContextId: getPendingCleanupApprovalPromptContextId,
            onPromptTombstoneRestored: requeueRestoredCleanupPromptTombstone,
            tombstoneReason: 'cleanup_review_expired'
          }
        );
        review = await readCleanupReviewRecord(chrome.storage.session);
      }
      if (review?.approvalHandoff?.status !== 'prompt_tombstone') return null;
      return settleOwnedCleanupPromptTombstone({
        expectedNonce,
        requireExactGrant: true,
        storageSession: chrome.storage.session,
        storageLocal: chrome.storage.local
      });
    })
  );
}

function classifyResponseError(error) {
  if (error?.name === 'MessageValidationError') return { errorCode: 'invalid_message', retryable: false };
  if (error?.name === 'AbortError') return { errorCode: 'cleanup_cancelled', retryable: false };
  if (error?.name === 'LifecycleNotReadyError') return { errorCode: 'lifecycle_not_ready', retryable: true };
  if (error?.name === 'OperationBudgetExceededError')
    return { errorCode: 'operation_budget_exhausted', retryable: true };
  if (error?.name === 'OperationTimeoutError') return { errorCode: 'browser_operation_unknown', retryable: false };
  return { errorCode: 'sitewipe_action_failed', retryable: false };
}

class LifecycleNotReadyError extends Error {
  constructor(action, stage = 'maintenance', options = {}) {
    const recoveryHint =
      stage === 'request-shield-session-boundary'
        ? ' Restart the browser, then reopen SiteWipe to complete request-shield recovery.'
        : '';
    super(
      `SiteWipe could not finish ${action} before the bounded ${stage} handoff ended. No cleanup was admitted. Try again.${recoveryHint}`
    );
    this.name = 'LifecycleNotReadyError';
    this.lifecycleStage = stage;
    this.peerReservation = options.peerReservation || null;
  }
}

class LifecycleMaintenanceStageError extends Error {
  constructor(reason, stage, cause) {
    const recoveryHint =
      stage === 'request-shield-session-boundary'
        ? ' Restart the browser, then reopen SiteWipe to complete request-shield recovery.'
        : '';
    super(`SiteWipe ${reason} maintenance could not complete the ${stage} stage.${recoveryHint}`, { cause });
    this.name = 'LifecycleMaintenanceStageError';
    this.lifecycleStage = stage;
    this.maintenanceReason = reason;
  }
}

async function handleMessage(message, sender, internalContext = {}) {
  const trustedInternalArmedCleanup = isTrustedInternalArmedCleanup(message, sender, internalContext);
  const expectedApprovalHandoffNonce = trustedInternalArmedCleanup
    ? String(internalContext.expectedApprovalHandoffNonce)
    : null;
  const envelope = validateMessageEnvelope(message, sender, chrome.runtime.id, {
    allowInternalArmedCleanup: trustedInternalArmedCleanup
  });
  const { type, payload } = envelope;

  switch (type) {
    case MESSAGE_TYPES.normalizeTarget: {
      const settings = await getSettings();
      return {
        normalized: normalizeSiteInput(payload.input, {
          allowLocalTargets: settings.allowLocalTargets
        })
      };
    }
    case MESSAGE_TYPES.getActiveTabTarget: {
      return { activeTab: await getActiveTabTarget() };
    }
    case MESSAGE_TYPES.validateAssociatedGroups: {
      const settings = await getSettings();
      return {
        validation: validateAssociatedDomainGroups(payload.groupsText ?? settings.associatedDomainGroups, {
          allowLocalTargets: settings.allowLocalTargets
        })
      };
    }
    case MESSAGE_TYPES.getSelfTestResults: {
      return { selfTests: runDomainSelfTests() };
    }
    case MESSAGE_TYPES.getIncognitoStatus: {
      return { incognitoAccess: await isIncognitoAllowed() };
    }
    case MESSAGE_TYPES.getState: {
      const [settings, report, reports, incognitoAccess, debugLog, activeJob, activeShield] = await Promise.all([
        getSettings(),
        getLastReport(),
        getReports(),
        isIncognitoAllowed(),
        getDebugLog(),
        getActiveJob(),
        getActiveShield()
      ]);
      const shieldDiagnostics = await getSiteWipeDnrDiagnostics(activeShield);
      const maintenanceStatus = await getMaintenanceStatusSnapshot({
        settings,
        activeShield,
        activeJob,
        shieldDiagnostics
      });
      return {
        settings,
        report,
        reports,
        incognitoAccess,
        debugLog,
        activeJob,
        activeShield,
        shieldDiagnostics,
        maintenanceStatus
      };
    }
    case MESSAGE_TYPES.getPopupState: {
      const [settings, report, incognitoAccess, activeJob] = await Promise.all([
        getSettings(),
        getLastReport(),
        isIncognitoAllowed(),
        getActiveJob()
      ]);
      return { settings, report, incognitoAccess, activeJob };
    }
    case MESSAGE_TYPES.getReportState: {
      await assertBoundSidePanelReport(payload, sender);
      const [settings, report] = await Promise.all([getSettings(), getLastReport()]);
      if (!report || report.id !== payload.reportId) {
        throw new Error('The report bound to this side panel is no longer the latest stored report.');
      }
      const reports = await getReports();
      return { settings, report, reports };
    }
    case MESSAGE_TYPES.getOptionsState: {
      const [settings, incognitoAccess, debugLog, activeJob, activeShield] = await Promise.all([
        getSettings(),
        isIncognitoAllowed(),
        getDebugLog(),
        getActiveJob(),
        getActiveShield()
      ]);
      const shieldDiagnostics = await getSiteWipeDnrDiagnostics(activeShield);
      return {
        settings,
        incognitoAccess,
        debugLog,
        activeJob,
        activeShield,
        shieldDiagnostics,
        maintenanceStatus: await getMaintenanceStatusSnapshot({
          settings,
          activeShield,
          activeJob,
          shieldDiagnostics
        })
      };
    }
    case MESSAGE_TYPES.prepareCleanupReview: {
      assertExactPopupSender(sender, 'prepare a cleanup review');
      return withCleanupLifecycleReservation('review', 'prepare a cleanup review', async () => {
        if (cleanInProgress)
          throw new Error(
            'A SiteWipe cleanup is already running. Wait for it to finish before reviewing another cleanup.'
          );
        const activeJob = await getActiveJob();
        if (isActiveRunningJob(activeJob))
          throw new Error(
            'A SiteWipe cleanup is already running. Wait for it to finish before reviewing another cleanup.'
          );
        await assertNoPendingDnrInstallMutation('prepare another cleanup review');
        if (cleanupReviewPreparationInProgress)
          throw new Error('Another cleanup review is being prepared. Wait for it to finish before trying again.');
        cleanupReviewPreparationInProgress = true;
        try {
          const popupContext = await inspectExactPreparingPopupContext();
          const prepared = await serializeCleanupReviewStateMutation(() =>
            prepareCleanupReviewRequest(payload, {
              getSettings: getPermissionAwareSettings,
              isIncognitoAllowed,
              inspectSourceWindow,
              hasHostPermissions,
              containsHostPermissions: containsHostPermissionsStrict,
              getAllHostPermissions: getAllHostPermissionsStrict,
              inspectImpact: inspectCleanupImpact,
              releaseHostPermissions: releaseTemporaryHostPermissions,
              storageSession: chrome.storage.session,
              storageLocal: chrome.storage.local,
              preparationContextId: popupContext.contextId,
              isPreparationContextActive: inspectPreparationContextActive,
              retainPreparedPromptOwnership: true,
              getPendingPromptContextId: getPendingCleanupApprovalPromptContextId,
              onPromptTombstoneRestored: requeueRestoredCleanupPromptTombstone
            })
          );
          queueAlarmAt(ALARMS.reviewExpiry, prepared.review.expiresAt);
          return prepared;
        } finally {
          cleanupReviewPreparationInProgress = false;
        }
      });
    }
    case MESSAGE_TYPES.cancelCleanupReview: {
      assertExactPopupSender(sender, 'cancel a cleanup review');
      return runAdministrativeLifecycleAction('cancel a cleanup review', async () => {
        const promptNotStartedContextId = payload.promptNotStarted === true ? payload.popupContextId : null;
        const canceled = await serializeCleanupReviewStateMutation(() =>
          cancelCleanupReviewRequest(payload, {
            storageSession: chrome.storage.session,
            hasHostPermissions,
            containsHostPermissions: containsHostPermissionsStrict,
            getAllHostPermissions: getAllHostPermissionsStrict,
            storageLocal: chrome.storage.local,
            releaseHostPermissions: releaseTemporaryHostPermissions,
            promptNotStartedContextId,
            requirePopupPreparationCapability: true,
            retainPreparedPromptOwnership: true,
            getPendingPromptContextId: getPendingCleanupApprovalPromptContextId,
            onPromptTombstoneRestored: requeueRestoredCleanupPromptTombstone
          })
        );
        if (canceled.canceled) queueAlarmClear(ALARMS.reviewExpiry);
        return canceled;
      });
    }
    case MESSAGE_TYPES.armCleanupApproval: {
      assertExactPopupSender(sender, 'arm a cleanup approval handoff');
      const promptContextId = payload.popupContextId;
      const handoffNonce = String(payload.handoffNonce || '');
      const existingOwner = pendingCleanupApprovalArms.get(handoffNonce);
      const ownsPendingArm = !existingOwner;
      const armOwner =
        existingOwner ||
        Object.freeze({
          approvalToken: String(payload.approvalToken || ''),
          handoffNonce,
          promptContextId,
          marker: Symbol(handoffNonce)
        });
      if (!existingOwner) pendingCleanupApprovalArms.set(handoffNonce, armOwner);
      let staged = false;
      let continuationScheduled = false;
      try {
        await serializeCleanupReviewStateMutation(() =>
          stageCleanupReviewApprovalRequest(payload, {
            storageSession: chrome.storage.session,
            storageLocal: chrome.storage.local,
            promptContextId,
            requirePopupPreparationCapability: true
          })
        );
        staged = true;
        if (existingOwner) {
          throw new Error('This cleanup approval is already continuing from its initiating popup context.');
        }
        return await completeStagedCleanupApproval(payload, promptContextId);
      } catch (error) {
        const peerReservation = error?.peerReservation || cleanupLifecycleReservation;
        const retryAfterPeer = Boolean(
          staged && error?.name === 'LifecycleNotReadyError' && peerReservation && peerReservation.kind !== 'cleanup'
        );
        if (ownsPendingArm && staged && !retryAfterPeer) {
          await tombstoneStagedCleanupApproval(payload, 'approval_authority_rejected').catch(() => {});
        }
        // onAdded may have fired while the review was still prepared/arming.
        // Re-drive the nonce after every arm rejection so an expired or
        // authority-rejected tombstone reconciles an already-settled grant
        // without requiring another browser event or popup action.
        void queueArmedCleanupResume('approval-arm-rejected', handoffNonce).catch(() => {});
        if (retryAfterPeer) {
          continuationScheduled = true;
          scheduleStagedCleanupApprovalContinuation(payload, promptContextId, peerReservation, armOwner);
        }
        throw error;
      } finally {
        if (ownsPendingArm && !continuationScheduled && pendingCleanupApprovalArms.get(handoffNonce) === armOwner) {
          pendingCleanupApprovalArms.delete(handoffNonce);
        }
      }
    }
    case MESSAGE_TYPES.resumeArmedCleanup: {
      assertExactPopupSender(sender, 'resume an armed cleanup approval');
      let authenticatedResume;
      await serializeCleanupReviewStateMutation(async () => {
        const review = await readCleanupReviewRecord(chrome.storage.session);
        const activeJob = review ? null : await getActiveJob();
        const popupBindingOwner =
          review ||
          (activeJob?.approvalHandoffNonce === payload.handoffNonce
            ? {
                preparationContextId: activeJob.popupContextId,
                popupPreparationCapabilityDigest: activeJob.popupPreparationCapabilityDigest
              }
            : null);
        if (!popupBindingOwner || (review && review.approvalHandoffNonce !== payload.handoffNonce)) {
          throw new Error('The armed cleanup approval is missing or no longer matches this popup.');
        }
        await assertCleanupReviewPopupBinding(popupBindingOwner, payload);
        // Register the exact-nonce waiter before releasing the authenticated
        // review read. Otherwise a peer wake can erase the conclusive
        // cancellation proof in the microtask gap before this handler queues.
        authenticatedResume = queueArmedCleanupResume('popup-grant-continuation', payload.handoffNonce);
      });
      return authenticatedResume;
    }
    case MESSAGE_TYPES.settleCleanupPermissionPrompt: {
      assertExactPopupSender(sender, 'settle a Chrome target-access prompt');
      const promptContextId = payload.popupContextId;
      try {
        return await performPopupCleanupPromptSettlement(payload, promptContextId);
      } catch (error) {
        if (error?.name === 'LifecycleNotReadyError' && error.peerReservation) {
          schedulePopupCleanupPromptSettlementContinuation(payload, promptContextId, error.peerReservation);
        }
        throw error;
      }
    }
    case MESSAGE_TYPES.runDeepClean: {
      if (!trustedInternalArmedCleanup) {
        assertExactPopupSender(sender, 'run a prepared cleanup');
        const review = await readCleanupReviewRecord(chrome.storage.session);
        if (!review || review.token !== payload.approvalToken || review.approvalHandoff) {
          throw new Error(
            'This cleanup approval is missing, expired, or has already been used. Start the cleanup again.'
          );
        }
        await assertCleanupReviewPopupBinding(review, payload);
      }
      return withCleanupLifecycleReservation('cleanup', 'run a cleanup', async () => {
        if (cleanInProgress)
          throw new Error(
            'A SiteWipe cleanup is already running. Wait for it to finish before starting another cleanup.'
          );
        cleanInProgress = true;
        let job = null;
        let report = null;
        let settings;
        let approval = null;
        let hostPermissionsFinalized = false;
        let browserCleanupFinished = false;
        let armedCleanupReviewFinalized = false;
        try {
          await assertNoPendingDnrInstallMutation('start another cleanup');
          approval = await serializeCleanupReviewStateMutation(() =>
            consumeCleanupReviewRequest(payload, {
              storageSession: chrome.storage.session,
              getSettings: getPermissionAwareSettings,
              isIncognitoAllowed,
              inspectSourceWindow,
              hasHostPermissions,
              containsHostPermissions: containsHostPermissionsStrict,
              getAllHostPermissions: getAllHostPermissionsStrict,
              storageLocal: chrome.storage.local,
              releaseHostPermissions: releaseTemporaryHostPermissions,
              expectedApprovalHandoffNonce,
              requirePopupPreparationCapability: !trustedInternalArmedCleanup
            })
          );
          queueAlarmClear(ALARMS.reviewExpiry);
          settings = getEffectiveCleanupSettings(approval.settings || {});
          const target = approval.target;
          const protectedTargets = findProtectedBrowserServiceTargets(target);
          if (protectedTargets.length) {
            throw new Error(
              `Cleanup is blocked for ${protectedTargets[0].targetHost} to protect browser Sync and browser-account state. SiteWipe never cleans browser-service targets.`
            );
          }
          const incognitoAccess = approval.incognitoAccess === true;
          const hostPermissionsGranted = approval.approvalHandoffNonce
            ? Boolean(
                await assertLeaseOwnedCleanupPermissionInventory(
                  approval,
                  {
                    storageLocal: chrome.storage.local,
                    containsHostPermissions: containsHostPermissionsStrict,
                    getAllHostPermissions: getAllHostPermissionsStrict
                  },
                  { allowedLeaseStatuses: ['active_cleanup'] }
                )
              )
            : await hasHostPermissions(target.hostPermissionOrigins);
          if (!hostPermissionsGranted)
            throw new Error(
              'The preflight-bound target site access is not available. Start again and approve only the exact target patterns if Chrome/Brave asks.'
            );
          const repair = await repairSiteWipeRuntime('pre-cleanup', {
            forceRecoverRunningJob: true
          });
          const storedJob = await getActiveJob();
          if (isActiveRunningJob(storedJob))
            throw new Error(
              'A SiteWipe cleanup is already running. Wait for it to finish before starting another cleanup.'
            );
          ({ report } = initializeReviewedCleanupReport({ approval, settings, repair }));
          job = {
            id: report.id,
            status: 'running',
            targetDomain: target.displayName || target.domain,
            startedAt: report.startedAt,
            updatedAt: new Date().toISOString(),
            percent: 0,
            phase: 'created',
            label: 'Queued',
            detail: 'Cleanup job created.',
            ...(approval.approvalHandoffNonce
              ? {
                  approvalHandoffNonce: approval.approvalHandoffNonce,
                  admissionPhase: 'handoff_admitting',
                  popupContextId: approval.preparationContextId,
                  popupPreparationCapabilityDigest: approval.popupPreparationCapabilityDigest
                }
              : {})
          };
          await setActiveJob(job);
          if (approval.approvalHandoffNonce) {
            await serializeCleanupReviewStateMutation(() =>
              finalizeArmedCleanupReviewAdmission(
                {
                  approvalToken: approval.token,
                  handoffNonce: approval.approvalHandoffNonce
                },
                chrome.storage.session
              )
            );
            armedCleanupReviewFinalized = true;
            let admissionFinalized = false;
            const admittedJob = await mutateActiveJob((currentJob) => {
              if (
                currentJob?.id !== job.id ||
                currentJob.status !== 'running' ||
                currentJob.approvalHandoffNonce !== approval.approvalHandoffNonce ||
                currentJob.admissionPhase !== 'handoff_admitting'
              ) {
                return undefined;
              }
              admissionFinalized = true;
              return {
                ...currentJob,
                admissionPhase: 'admitted',
                updatedAt: new Date().toISOString()
              };
            });
            if (!admissionFinalized) {
              throw new Error('The durable cleanup job changed before approval admission completed.');
            }
            job = admittedJob;
            queueAlarmClear(ALARMS.reviewExpiry);
          }
          if (approval.approvalHandoffNonce) {
            // Re-prove exact lease-owned authority immediately after durable
            // admission and before any UI/log claims that cleanup started.
            await assertLeaseOwnedCleanupPermissionInventory(
              approval,
              {
                storageLocal: chrome.storage.local,
                containsHostPermissions: containsHostPermissionsStrict,
                getAllHostPermissions: getAllHostPermissionsStrict
              },
              { allowedLeaseStatuses: ['active_cleanup'] }
            );
          }
          await setActionBadgeForJob(job);
          queueMaintenanceAlarmRefresh();
          await appendDebug({
            level: 'info',
            message: 'Deep Clean started',
            target: target.displayName || target.domain,
            jobId: job.id
          });
          if (approval.approvalHandoffNonce) {
            // Badge/debug persistence can yield to permission changes. Repeat
            // the same exact-inventory proof as the final awaited boundary
            // before invoking the browser-data cleanup adapter.
            await assertLeaseOwnedCleanupPermissionInventory(
              approval,
              {
                storageLocal: chrome.storage.local,
                containsHostPermissions: containsHostPermissionsStrict,
                getAllHostPermissions: getAllHostPermissionsStrict
              },
              { allowedLeaseStatuses: ['active_cleanup'] }
            );
          }
          const finished = await runDeepClean(target, report, {
            incognitoAccess,
            hostPermissionsGranted,
            aggressiveCookieSweep: settings.aggressiveCookieSweep,
            includeProtectedWebOrigins: settings.includeProtectedWebOrigins,
            pageScriptScrub: settings.pageScriptScrub,
            storageBucketScrub: settings.storageBucketScrub,
            embeddedFrameDiscovery: settings.embeddedFrameDiscovery,
            probePartitionedCookiesWithEmbeddingSites: settings.probePartitionedCookiesWithEmbeddingSites,
            exhaustiveCookieStoreScan: settings.exhaustiveCookieStoreScan,
            downloadRecentFallback: settings.downloadRecentFallback,
            broadDiscoveryFallback: settings.broadDiscoveryFallback,
            deleteDownloadedFiles: settings.deleteDownloadedFiles,
            approvedDownloadFileIds: approval.approvedDownloadFileIds || [],
            temporaryDnrShield: settings.temporaryDnrShield,
            progressOverlay: settings.progressOverlay,
            progressOverlayCancelButton: settings.progressOverlayCancelButton,
            overlayScope: settings.overlayScope,
            sourceWindowId: Number.isInteger(approval.sourceWindowId) ? approval.sourceWindowId : null,
            postWipeSessionBlock: settings.postWipeSessionBlock,
            postWipeShieldExpiresMinutes: settings.postWipeShieldExpiresMinutes,
            resetZoom: settings.resetZoom,
            resetMutedTabs: settings.resetMutedTabs,
            unpinTargetTabs: settings.unpinTargetTabs,
            opfsScrub: settings.opfsScrub,
            serviceWorkerExtraScrub: settings.serviceWorkerExtraScrub,
            appBadgeClear: settings.appBadgeClear,
            permissionAudit: settings.permissionAudit,
            verificationPass: settings.verificationPass,
            shieldJobId: job.id,
            shouldCancel: () => shouldCancelJob(job.id),
            onProgress: (progress) => updateJobProgress(job.id, target.displayName || target.domain, progress),
            onShieldPrepared: async (shield) => {
              await setActiveShield({ ...shield, jobId: job.id });
              await beginDnrPendingMutationMarker({ ...shield, jobId: job.id }, { boundedReads: true });
              queueMaintenanceAlarmRefresh();
            },
            onShieldInstalled: async (shield) => {
              await setActiveShield({ ...shield, jobId: job.id });
              await clearDnrPendingMutationMarker({ jobId: job.id }, { boundedReads: true });
              queueMaintenanceAlarmRefresh();
            },
            onShieldRemovalPrepared: async () => {
              const currentShield = await withMaintenanceReadTimeout(
                getActiveShield(),
                'request-shield removal marker binding'
              );
              if (!currentShield || currentShield.jobId !== job.id) {
                throw new Error('SiteWipe could not bind request-shield removal to the active cleanup job.');
              }
              await beginDnrPendingMutationMarker(currentShield, { boundedReads: true });
            },
            onShieldUncertain: async (patch) => {
              const nextShield = await mutateActiveShield((currentShield) =>
                currentShield?.jobId === job.id
                  ? {
                      ...currentShield,
                      ...patch,
                      jobId: job.id
                    }
                  : undefined
              );
              if (nextShield?.pendingMutation === true) {
                await ensureDnrPendingMutationMarkerBinding(nextShield, { boundedReads: true });
              } else {
                await clearDnrPendingMutationMarker({ jobId: job.id }, { boundedReads: true });
              }
              queueMaintenanceAlarmRefresh();
            },
            onShieldCleared: async () => {
              await mutateActiveShield((currentShield) => (currentShield?.jobId === job.id ? null : undefined));
              await clearDnrPendingMutationMarker({ jobId: job.id }, { boundedReads: true });
              queueMaintenanceAlarmRefresh();
            },
            onShieldMutationSettled: async () => {
              await requestLifecycleMaintenance('dnr-rule-mutation-settled', {
                settledDnrJobId: job.id,
                record: false
              });
            }
          });
          browserCleanupFinished = true;

          const completion = await completeSuccessfulCleanup({
            target,
            finished,
            settings,
            job,
            approval
          });
          hostPermissionsFinalized = completion.hostPermissionsFinalized;
          return {
            report: completion.responseReport,
            reportPersisted: completion.reportPersisted,
            completionWarnings: completion.warnings
          };
        } catch (error) {
          if (browserCleanupFinished && report && job) {
            recordCompletionWarning(report, 'Finalize completed cleanup', error, []);
            report.privateContextTouched = Boolean(
              report.incognitoAccess || report.sourceIncognito || report.summary?.incognitoScopeObserved
            );
            await finishReportSafely(report, []);
            const completedAt = new Date().toISOString();
            const fallbackJob = {
              ...job,
              status: 'completed',
              percent: 100,
              phase: 'complete',
              label: 'Cleanup finished with warnings',
              detail: 'Browser cleanup finished, but SiteWipe could not complete every reporting step.',
              updatedAt: completedAt,
              completedAt
            };
            await setActiveJob(fallbackJob).catch(() => {});
            await setActionBadgeForJob(fallbackJob).catch(() => {});
            if (approval?.permissionLeaseId) {
              const recovery = await recoverTemporaryPermissionLease(
                'cleanup-completion-emergency',
                approval.permissionLeaseId
              ).catch(() => null);
              hostPermissionsFinalized = Boolean(recovery && (recovery.released || recovery.recordRetained));
            }
            return {
              report: createMinimalCompletionReport(report, [error?.message || String(error)]),
              reportPersisted: false,
              completionWarnings: [error?.message || String(error)]
            };
          }
          const canceled = isCleanupCancellationError(error);
          if (report && job) {
            const failureCompletion = await completeFailedCleanup({
              error,
              canceled,
              report,
              job,
              settings,
              approval,
              hostPermissionsFinalized
            });
            hostPermissionsFinalized = failureCompletion.hostPermissionsFinalized;
          }
          throw error;
        } finally {
          if (approval?.approvalHandoffNonce && !armedCleanupReviewFinalized) {
            await serializeCleanupReviewStateMutation(() =>
              cancelCleanupReviewRequest(
                { approvalToken: approval.token },
                {
                  storageSession: chrome.storage.session,
                  storageLocal: chrome.storage.local,
                  containsHostPermissions: containsHostPermissionsStrict,
                  getAllHostPermissions: getAllHostPermissionsStrict,
                  releaseHostPermissions: releaseTemporaryHostPermissions,
                  retainPreparedPromptOwnership: true,
                  getPendingPromptContextId: getPendingCleanupApprovalPromptContextId,
                  onPromptTombstoneRestored: requeueRestoredCleanupPromptTombstone
                }
              )
            ).catch(() => {});
          }
          if (approval && !hostPermissionsFinalized) {
            if (approval.permissionLeaseId) {
              await recoverTemporaryPermissionLease('cleanup-finally', approval.permissionLeaseId).catch(() => {});
            } else {
              await releaseTemporaryHostPermissions(getTemporaryReviewHostPermissionOrigins(approval)).catch(() => {});
            }
          }
          // Completion/failure can change the durable job, shield, review, and
          // permission-lease boundary. Never let the next interactive action
          // reuse the proof captured before this cleanup attempt.
          poisonServiceWorkerLoadReadiness('cleanup-settlement');
          cleanInProgress = false;
        }
      });
    }
    case MESSAGE_TYPES.getReport: {
      return { report: await getLastReport() };
    }
    case MESSAGE_TYPES.getHistory: {
      return { reports: await getReports() };
    }
    case MESSAGE_TYPES.clearHistory: {
      return runAdministrativeLifecycleAction('clear cleanup report history', async () => {
        await clearReportHistory();
        return { reports: [] };
      });
    }
    case MESSAGE_TYPES.getSettings: {
      return { settings: await getSettings(), debugLog: await getDebugLog() };
    }
    case MESSAGE_TYPES.saveSettings: {
      return runAdministrativeLifecycleAction('change settings', async () => {
        await invalidatePendingCleanupReview();
        const currentSettings = await getSettings();
        const permissionAwarePatch = { ...(payload.settings || {}) };
        const requestedSettings = getEffectiveCleanupSettings({ ...currentSettings, ...permissionAwarePatch });
        const enteringExpertMode =
          currentSettings.cleanupMode !== 'expert' && requestedSettings.cleanupMode === 'expert';
        // Standard mode must release the optional permission and persist the
        // feature as off. Entering Expert mode also starts it off so changing
        // modes or importing a stale full-form snapshot cannot silently revive
        // an earlier grant; the user must enable the feature in a later gesture.
        if (!requestedSettings.embeddedFrameDiscovery || enteringExpertMode) {
          permissionAwarePatch.embeddedFrameDiscovery = false;
        } else if (!(await hasNamedPermission('webNavigation'))) {
          permissionAwarePatch.embeddedFrameDiscovery = false;
        }
        const settings = await saveSettings(permissionAwarePatch);
        if (!getEffectiveCleanupSettings(settings).embeddedFrameDiscovery) {
          await removeNamedPermission('webNavigation');
        }
        queueMaintenanceAlarmRefresh();
        return { settings };
      });
    }
    case MESSAGE_TYPES.resetSettings: {
      return runAdministrativeLifecycleAction('reset settings', async () => {
        await invalidatePendingCleanupReview();
        const settings = await resetSettings();
        await removeNamedPermission('webNavigation');
        queueMaintenanceAlarmRefresh();
        return { settings };
      });
    }
    case MESSAGE_TYPES.clearDebugLog: {
      return runAdministrativeLifecycleAction('clear the debug log', async () => {
        await clearDebugLog();
        return { debugLog: [] };
      });
    }
    case MESSAGE_TYPES.openSidePanel: {
      return bindSidePanelReport(payload, sender);
    }
    case MESSAGE_TYPES.clearActiveShield: {
      return runRecoveryAdministrativeLifecycleAction('clear the request shield', async () => {
        const result = await reconcileOwnedShieldStateWithSettlement();
        queueMaintenanceAlarmRefresh();
        const shield = await getActiveShield();
        return {
          cleared: Boolean(result.cleared),
          shield,
          result,
          shieldDiagnostics: result.diagnostics || (await getSiteWipeDnrDiagnostics(shield))
        };
      });
    }
    case MESSAGE_TYPES.repairActiveShield: {
      return runRecoveryAdministrativeLifecycleAction('repair the request shield', async () => {
        const before = await getSiteWipeDnrDiagnostics(await getActiveShield());
        const result = await reconcileOwnedShieldStateWithSettlement();
        queueMaintenanceAlarmRefresh();
        const shield = await getActiveShield();
        const after = result.diagnostics || (await getSiteWipeDnrDiagnostics(shield));
        await appendDebug({
          level: result.cleared ? 'info' : 'error',
          message: result.cleared
            ? 'Shield state repaired'
            : 'Shield repair remains incomplete; recovery state retained',
          beforeRules: before.siteWipeRuleCount,
          cleared: result.cleared
        });
        return {
          repaired: Boolean(result.cleared),
          result,
          before,
          after,
          shield,
          shieldDiagnostics: after
        };
      });
    }
    case MESSAGE_TYPES.getShieldDiagnostics: {
      const shield = await getActiveShield();
      return {
        activeShield: shield,
        shieldDiagnostics: await getSiteWipeDnrDiagnostics(shield)
      };
    }
    case MESSAGE_TYPES.cancelActiveJob: {
      let canceled = false;
      const next = await mutateActiveJob((activeJob) => {
        if (!activeJob || activeJob.status !== 'running') return undefined;
        canceled = true;
        return {
          ...activeJob,
          cancelRequested: true,
          label: 'Cancel requested',
          detail: 'SiteWipe will stop before the next safe operation batch.',
          updatedAt: new Date().toISOString()
        };
      });
      if (!canceled) return { activeJob: next, canceled: false };
      await setActionBadgeForJob(next);
      return { activeJob: next, canceled };
    }
    case MESSAGE_TYPES.clearActiveJobRecord: {
      return runAdministrativeLifecycleAction('clear the local cleanup job record', async () => {
        const activeJob = await getActiveJob();
        if (activeJob?.status === 'running' && isActiveRunningJob(activeJob)) {
          throw new Error(
            'A cleanup is still running. Request cancel first, or wait until the job is interrupted/stopped before clearing the local job record.'
          );
        }
        await clearActiveJob();
        await clearActionBadge();
        queueMaintenanceAlarmRefresh();
        return { activeJob: null, cleared: Boolean(activeJob) };
      });
    }
    case MESSAGE_TYPES.expireActiveShield: {
      return runRecoveryAdministrativeLifecycleAction('expire the request shield', async () => {
        const expired = await expireActiveShieldIfNeeded(true);
        queueMaintenanceAlarmRefresh();
        return {
          expired,
          activeShield: await getActiveShield(),
          shieldDiagnostics: await getSiteWipeDnrDiagnostics(await getActiveShield())
        };
      });
    }
    case MESSAGE_TYPES.forgetLatestReport: {
      return runAdministrativeLifecycleAction('forget the latest cleanup report', async () => {
        const result = await forgetLatestReport(payload.reportId);
        queueMaintenanceAlarmRefresh();
        return { report: null, ...result };
      });
    }
    case MESSAGE_TYPES.getActiveJob: {
      const activeShield = await getActiveShield();
      return {
        activeJob: await getActiveJob(),
        activeShield,
        shieldDiagnostics: await getSiteWipeDnrDiagnostics(activeShield)
      };
    }
    case MESSAGE_TYPES.getMaintenanceStatus: {
      return { maintenanceStatus: await getMaintenanceStatusSnapshot() };
    }
    case MESSAGE_TYPES.runMaintenanceNow: {
      return runRecoveryAdministrativeLifecycleAction('run manual maintenance', async () => {
        try {
          const result = await runMaintenanceCycle('manual', { forceOrphanShieldRepair: true });
          queueMaintenanceAlarmRefresh();
          return {
            maintenance: result,
            maintenanceStatus: await getMaintenanceStatusSnapshot()
          };
        } catch (error) {
          poisonServiceWorkerLoadReadiness(error?.lifecycleStage || 'manual-maintenance');
          throw error;
        }
      });
    }
    case MESSAGE_TYPES.resetExtensionLocalState: {
      return runRecoveryAdministrativeLifecycleAction('reset SiteWipe local state', async () => {
        const result = await resetExtensionLocalState();
        return {
          reset: result,
          settings: await getSettings(),
          maintenanceStatus: await getMaintenanceStatusSnapshot()
        };
      });
    }
    default:
      throw new Error(`Unknown message type: ${type}`);
  }
}

async function completeSuccessfulCleanup({ target, finished, settings, job, approval }) {
  const warnings = [];
  let hostPermissionsFinalized = false;
  try {
    await finalizeRunHostPermissions(
      target.hostPermissionOrigins,
      finished,
      approval.preexistingHostPermissionOrigins,
      approval.permissionLeaseId,
      approval.hostPermissionInventory
    );
    hostPermissionsFinalized = true;
  } catch (error) {
    recordCompletionWarning(finished, 'Finalize temporary target site access', error, warnings);
    if (approval.permissionLeaseId) {
      const recovery = await recoverTemporaryPermissionLease(
        'cleanup-completion-fallback',
        approval.permissionLeaseId
      ).catch(() => null);
      hostPermissionsFinalized = Boolean(recovery && (recovery.released || recovery.recordRetained));
    }
  }

  finished.privateContextTouched = Boolean(
    finished.incognitoAccess || finished.sourceIncognito || finished.summary?.incognitoScopeObserved
  );

  let completedJob = {
    ...job,
    status: 'completed',
    percent: 100,
    phase: 'complete',
    label: warnings.length ? 'Cleanup finished with warnings' : 'Cleanup finished',
    detail: finished.privateContextTouched
      ? 'Cleanup finished. The private cleanup report was not persisted.'
      : 'Cleanup finished. Report persistence is being finalized.',
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  };
  try {
    completedJob = await setActiveJob(completedJob);
  } catch (error) {
    recordCompletionWarning(finished, 'Persist terminal cleanup job state', error, warnings);
  }

  // Terminal job persistence can add a report warning. Seal integrity only
  // after every pre-persistence completion step has had a chance to report.
  await finishReportSafely(finished, warnings);

  let responseReport;
  let reportPersisted = false;
  try {
    responseReport = finished.privateContextTouched
      ? settings.redactReports !== false
        ? await redactReport(finished, { profile: 'private-session-response' })
        : finished
      : await saveReport(finished, settings);
    reportPersisted = !finished.privateContextTouched;
  } catch (error) {
    recordCompletionWarning(finished, 'Persist cleanup report', error, warnings);
    await finishReportSafely(finished, warnings);
    try {
      responseReport =
        settings.redactReports !== false
          ? await redactReport(finished, { profile: 'report-persistence-fallback' })
          : finished;
    } catch (redactionError) {
      warnings.push(`Prepare transient report: ${redactionError?.message || String(redactionError)}`);
      responseReport = createMinimalCompletionReport(finished, warnings);
    }
  }

  if (warnings.length) {
    completedJob = {
      ...completedJob,
      status: 'completed',
      label: 'Cleanup finished with warnings',
      detail: 'Browser cleanup finished, but one or more reporting or extension-state steps need attention.',
      updatedAt: new Date().toISOString()
    };
    await setActiveJob(completedJob).catch(() => {});
  } else if (!finished.privateContextTouched) {
    completedJob = {
      ...completedJob,
      detail:
        settings.redactReports !== false
          ? 'Cleanup finished. The redacted report was saved temporarily under the reviewed privacy setting.'
          : 'Cleanup finished. The full report was saved temporarily under the reviewed privacy setting.',
      updatedAt: new Date().toISOString()
    };
    await setActiveJob(completedJob).catch(() => {});
  }

  await setActionBadgeForJob(completedJob).catch(() => {});
  clearActionBadgeSoon(completedJob.id);
  queueMaintenanceAlarmRefresh();
  await appendDebug({
    level: warnings.length ? 'error' : 'info',
    message: warnings.length ? 'Deep Clean completed with reporting warnings' : 'Deep Clean completed',
    target: target.displayName || target.domain,
    status: finished.status,
    hostAccessMode: finished.hostAccessMode,
    jobId: job.id,
    completionWarningCount: warnings.length
  }).catch(() => {});
  return { responseReport, reportPersisted, warnings, hostPermissionsFinalized };
}

async function completeFailedCleanup({ error, canceled, report, job, settings, approval, hostPermissionsFinalized }) {
  const warnings = [];
  report.status = canceled ? 'cancelled' : 'failed';
  report.finishedAt = new Date().toISOString();
  addSection(
    report,
    canceled ? 'cleanupCancelled' : 'cleanupFailed',
    canceled ? 'Cleanup canceled' : 'Cleanup failed',
    canceled ? 'skipped' : 'error',
    { message: error?.message || String(error) }
  );
  if (!canceled) addError(report, 'Cleanup failed', error);

  if (approval && !hostPermissionsFinalized) {
    try {
      await finalizeRunHostPermissions(
        approval.target?.hostPermissionOrigins || [],
        report,
        approval.preexistingHostPermissionOrigins,
        approval.permissionLeaseId,
        approval.hostPermissionInventory
      );
      hostPermissionsFinalized = true;
    } catch (releaseError) {
      recordCompletionWarning(report, 'Finalize temporary target site access', releaseError, warnings);
    }
  }

  const now = new Date().toISOString();
  const failedJob = {
    ...job,
    status: canceled ? 'cancelled' : 'failed',
    label: canceled ? 'Cleanup canceled' : 'Cleanup failed',
    detail: error?.message || String(error),
    updatedAt: now,
    failedAt: canceled ? undefined : now,
    canceledAt: canceled ? now : undefined
  };
  await setActiveJob(failedJob).catch((jobError) => {
    recordCompletionWarning(report, 'Persist terminal cleanup job state', jobError, warnings);
  });
  await setActionBadgeForJob(failedJob).catch(() => {});
  clearActionBadgeSoon(failedJob.id);

  report.privateContextTouched = Boolean(
    report.incognitoAccess || report.sourceIncognito || report.summary?.incognitoScopeObserved
  );
  await finishReportSafely(report, warnings);
  if (!report.privateContextTouched) {
    try {
      await saveReport(report, settings);
    } catch (saveError) {
      recordCompletionWarning(report, 'Persist failed cleanup report', saveError, warnings);
      await finishReportSafely(report, warnings);
    }
  }
  queueMaintenanceAlarmRefresh();
  await appendDebug({
    level: 'error',
    message: canceled ? 'Deep Clean canceled' : 'Deep Clean failed',
    jobId: job.id,
    completionWarningCount: warnings.length,
    stack: canceled ? undefined : error?.stack
  }).catch(() => {});
  return { warnings, hostPermissionsFinalized };
}

function recordCompletionWarning(report, label, error, warnings) {
  const message = error?.message || String(error);
  warnings.push(`${label}: ${message}`);
  if (!['failed', 'cancelled', 'interrupted'].includes(report.status)) report.status = 'completed_with_warnings';
  addError(report, label, error);
}

async function finishReportSafely(report, warnings) {
  try {
    await finishReport(report);
  } catch (error) {
    warnings.push(`Finalize report integrity: ${error?.message || String(error)}`);
    report.finishedAt ||= new Date().toISOString();
    if (!['failed', 'cancelled', 'interrupted'].includes(report.status)) report.status = 'completed_with_warnings';
  }
  return report;
}

function createMinimalCompletionReport(report, warnings) {
  return {
    id: report.id,
    appVersion: report.appVersion,
    input: '[redacted]',
    targetDomain: '[redacted]',
    startedAt: report.startedAt,
    finishedAt: report.finishedAt || new Date().toISOString(),
    status: 'completed_with_warnings',
    redacted: true,
    summary: {
      cleanupMode: report.summary?.cleanupMode || 'standard',
      reportingWarnings: warnings.length,
      note: 'Browser cleanup finished, but SiteWipe could not prepare the full report.'
    },
    sections: [],
    errors: warnings.map((message) => ({ label: 'Completion warning', message })),
    skipped: [],
    unavailable: [],
    integrity: null
  };
}

function ensurePrivacyDefaults() {
  if (privacyMigrationPromise) return privacyMigrationPromise;
  privacyMigrationPromise = (async () => {
    const storageLocal = createMaintenanceReadBoundStorageArea(chrome.storage.local, 'privacy-default local state');
    const settings = await getSettings({ storageLocal });
    // Do not put optional-permission revocation on the service-worker-load
    // readiness path. A browser that never settles permissions.remove would
    // otherwise block every popup action. Standard/Expert transitions, reset,
    // and explicit feature disable still revoke webNavigation while holding an
    // admitted administrative reservation; a dormant grant is never treated
    // as enabling frame discovery because the stored setting remains false.
    const needsStabilityDefaults = !settings.stabilityDefaultsAppliedAt;
    const needsPerformanceDefaults = !settings.performanceDefaultsAppliedAt;
    const needsPrivacyDefaults = !settings.privacyDefaultsAppliedAt;
    let migration = {};
    let migrated = false;
    if (needsStabilityDefaults || needsPerformanceDefaults || needsPrivacyDefaults) {
      const cleanupReviewRecovery = await invalidatePendingCleanupReview({ boundedReads: true });
      const preservedCleanupReview = await inspectLiveCleanupReview(
        createMaintenanceReadBoundStorageArea(chrome.storage.session, 'privacy-default cleanup-review state')
      );
      const permissionLeaseRecovery = await recoverTemporaryPermissionLease('privacy-defaults', null, {
        storageLocal: createMaintenanceReadBoundStorageArea(
          chrome.storage.local,
          'privacy-default permission-lease state'
        ),
        boundedReads: true,
        preservedCleanupReview,
        forcePromptSettlement: !preservedCleanupReview
      });
      assertCleanupReviewAndPermissionRecoveryProven(
        cleanupReviewRecovery,
        permissionLeaseRecovery,
        preservedCleanupReview,
        'runtime-default migration'
      );
      const now = new Date().toISOString();
      const patch = {};
      if (needsStabilityDefaults) {
        // A failed/lost onInstalled event must not leave an older settings
        // shape authoritative after the worker is restarted. This read/write
        // migration remains reservation-held because a late settings mutation
        // cannot safely overlap review or cleanup admission.
        await removeLegacyContentSettingPreference({ storageLocal });
        Object.assign(patch, {
          includeProtectedWebOrigins: false,
          mainWorldPageScrub: false,
          storageBucketScrub: false,
          exhaustiveCookieStoreScan: false,
          stabilityDefaultsAppliedAt: now
        });
      }
      if (needsPerformanceDefaults) {
        Object.assign(patch, {
          keepHistory: false,
          embeddedFrameDiscovery: false,
          probePartitionedCookiesWithEmbeddingSites: false,
          downloadRecentFallback: false,
          mainWorldPageScrub: false,
          storageBucketScrub: false,
          includeProtectedWebOrigins: false,
          exhaustiveCookieStoreScan: false,
          performanceDefaultsAppliedAt: now
        });
      }
      if (needsPrivacyDefaults) {
        migration = await migrateStoredReportsToPrivacyDefaults(Date.now(), { storageLocal });
        Object.assign(patch, {
          redactReports: true,
          latestReportRetentionMinutes: 30,
          privacyDefaultsAppliedAt: now
        });
      }
      await saveSettings(patch, { storageLocal });
      migrated = true;
    }
    const reportExpired = await expireLatestReportIfNeededWithBoundedRead();
    return { migrated, reportExpired, ...migration };
  })().then(
    (result) => {
      privacyMigrationPromise = null;
      return result;
    },
    (error) => {
      privacyMigrationPromise = null;
      throw error;
    }
  );
  return privacyMigrationPromise;
}

async function runInstalledMaintenance(reason) {
  const storageLocal = createMaintenanceReadBoundStorageArea(chrome.storage.local, 'installed local state');
  const cleanupReviewRecovery = await invalidatePendingCleanupReview({ boundedReads: true });
  const preservedCleanupReview = await inspectLiveCleanupReview(
    createMaintenanceReadBoundStorageArea(chrome.storage.session, 'installed cleanup-review state')
  );
  const permissionLeaseRecovery = await recoverTemporaryPermissionLease(`runtime:${reason}`, null, {
    storageLocal,
    boundedReads: true,
    preservedCleanupReview,
    forcePromptSettlement: !preservedCleanupReview
  });
  assertCleanupReviewAndPermissionRecoveryProven(
    cleanupReviewRecovery,
    permissionLeaseRecovery,
    preservedCleanupReview,
    `${reason || 'install/update'} migration`
  );
  const now = new Date().toISOString();
  if (reason === 'install') {
    await storageLocal.set({
      [STORAGE_KEYS.settings]: {
        ...DEFAULT_SETTINGS,
        createdAt: now,
        updatedAt: now,
        stabilityDefaultsAppliedAt: now,
        performanceDefaultsAppliedAt: now,
        privacyDefaultsAppliedAt: now
      }
    });
    return;
  }

  if (reason === 'update') {
    await removeLegacyContentSettingPreference({ storageLocal });
    const settings = await getSettings({ storageLocal });
    const patch = {};
    if (!settings.stabilityDefaultsAppliedAt) {
      Object.assign(patch, {
        includeProtectedWebOrigins: false,
        mainWorldPageScrub: false,
        storageBucketScrub: false,
        exhaustiveCookieStoreScan: false,
        stabilityDefaultsAppliedAt: now
      });
    }
    if (!settings.performanceDefaultsAppliedAt) {
      Object.assign(patch, {
        keepHistory: false,
        embeddedFrameDiscovery: false,
        probePartitionedCookiesWithEmbeddingSites: false,
        downloadRecentFallback: false,
        mainWorldPageScrub: false,
        storageBucketScrub: false,
        includeProtectedWebOrigins: false,
        exhaustiveCookieStoreScan: false,
        performanceDefaultsAppliedAt: now
      });
    }
    if (!settings.privacyDefaultsAppliedAt) {
      await migrateStoredReportsToPrivacyDefaults(Date.now(), { storageLocal });
      Object.assign(patch, {
        redactReports: true,
        latestReportRetentionMinutes: 30,
        privacyDefaultsAppliedAt: now
      });
    }
    await saveSettings(patch, { storageLocal });
  }
  await expireLatestReportIfNeededWithBoundedRead();
}

async function requestInstalledLifecycleMaintenance(reason) {
  const action = `run ${reason || 'install/update'} maintenance`;
  const reservation = tryAcquireCleanupLifecycleReservation('maintenance', action);
  if (!reservation) {
    deferMaintenanceRequest(`runtime:${reason || 'unknown'}`, {
      installedReason: reason || 'unknown',
      runMaintenanceCycle: false
    });
    return { deferred: true };
  }
  let settlement = { status: 'rejected', stage: 'installed-maintenance' };
  let result;
  try {
    await runLifecycleMaintenanceStage(reason || 'install/update', 'installed-state', () =>
      runInstalledMaintenance(reason)
    );
    settlement = { status: 'fulfilled' };
    result = { deferred: false };
  } catch (error) {
    settlement = maintenanceSettlementFromError(error, 'installed-maintenance');
    retainFailedInstalledMaintenanceRequest(reason);
    poisonServiceWorkerLoadReadiness(settlement.stage);
    throw error;
  } finally {
    reservation.release(settlement);
    queueMaintenanceAlarmRefresh();
  }
  poisonServiceWorkerLoadReadiness('installed-maintenance-proof-required');
  startServiceWorkerLoadReadinessMaintenance(`runtime:${reason || 'unknown'}:safety-proof`).catch((error) =>
    appendDebug({
      level: 'error',
      message: 'Post-install/update safety proof failed',
      errorName: error?.name || 'Error'
    }).catch(() => {})
  );
  return result;
}

function poisonServiceWorkerLoadReadiness(stage = 'maintenance') {
  const generation = serviceWorkerLoadReadinessState.generation + 1;
  serviceWorkerLoadReadinessState = Object.freeze({
    status: 'failed',
    generation,
    promise: Promise.resolve(),
    failedStage: String(stage || 'maintenance')
  });
}

function startServiceWorkerLoadReadinessMaintenance(reason = 'service-worker-load-retry') {
  const generation = serviceWorkerLoadReadinessState.generation + 1;
  const promise = requestLifecycleMaintenance(reason, {
    ensurePrivacyDefaults: true,
    forceStaleJobRecovery: true,
    record: false,
    readinessGeneration: generation
  }).then((result) => {
    if (!result?.deferred) return result;
    throw new LifecycleMaintenanceStageError(
      reason,
      'reservation-admission',
      new Error('Load readiness maintenance was deferred before recovery started.')
    );
  });
  serviceWorkerLoadReadinessState = Object.freeze({ status: 'pending', generation, promise });
  void promise.then(
    () => {
      if (serviceWorkerLoadReadinessState.generation !== generation) return;
      serviceWorkerLoadReadinessState = Object.freeze({
        status: 'ready',
        generation,
        promise: Promise.resolve()
      });
      // Every successful generation, including an interactive retry after a
      // transient load failure, must re-drive durable armed authority. Chrome
      // may already have emitted its sole onAdded event while the failed
      // generation was holding admission closed.
      void queueArmedCleanupResume(`${reason}:readiness-ready`).catch(() => {});
    },
    () => {
      if (serviceWorkerLoadReadinessState.generation !== generation) return;
      serviceWorkerLoadReadinessState = Object.freeze({
        status: 'failed',
        generation,
        promise: Promise.resolve()
      });
    }
  );
  // Callers that wait on the reservation settlement do not directly await
  // this promise, so attach a rejection handler without changing its outcome.
  void promise.catch(() => {});
  return promise;
}

async function requestLifecycleMaintenance(reason, options = {}) {
  const reservation = tryAcquireCleanupLifecycleReservation('maintenance', `run ${reason} maintenance`, {
    readinessGeneration: options.readinessGeneration
  });
  if (!reservation) {
    deferMaintenanceRequest(reason, { ...options, runMaintenanceCycle: true });
    return { deferred: true, reason };
  }
  let settlement = { status: 'rejected', stage: 'maintenance' };
  let result;
  let deferredReplay = null;
  try {
    await runLifecycleMaintenanceStage(reason, 'deferred-install-migrations', runDeferredInstalledMaintenanceRequests);
    deferredReplay = captureDeferredMaintenanceReplay({ replayBlockedSafetyIntents: deferredMaintenanceRetryBlocked });
    const settledDnrJobIds = [
      ...new Set([options.settledDnrJobId, ...deferredReplay.settledDnrJobIds].filter(Boolean))
    ];
    for (const jobId of settledDnrJobIds) {
      await runLifecycleMaintenanceStage(reason, 'request-shield-settlement', () => markDnrMutationSettled(jobId));
    }
    await runLifecycleMaintenanceStage(reason, 'privacy-readiness', ensurePrivacyDefaults);
    result = await runLifecycleMaintenanceStage(reason, 'state-recovery', () =>
      runMaintenanceCycle(reason, {
        ...options,
        forceShieldExpiry: Boolean(options.forceShieldExpiry || deferredReplay.forceShieldExpiry),
        forceStaleJobRecovery: Boolean(options.forceStaleJobRecovery || deferredReplay.forceStaleJobRecovery),
        browserSessionBoundary: Boolean(options.browserSessionBoundary || deferredReplay.browserSessionBoundary),
        record: Boolean(options.record !== false || deferredReplay.record)
      })
    );
    completeDeferredMaintenanceReplay(deferredReplay);
    deferredMaintenanceRetryBlocked = false;
    settlement = {
      status: 'fulfilled',
      readinessGeneration: options.readinessGeneration || null
    };
  } catch (error) {
    settlement = {
      ...maintenanceSettlementFromError(error),
      readinessGeneration: options.readinessGeneration || null
    };
    if (deferredReplay?.entries?.length) deferredMaintenanceRetryBlocked = true;
    if (!Number.isSafeInteger(options.readinessGeneration)) {
      poisonServiceWorkerLoadReadiness(settlement.stage);
    }
    throw error;
  } finally {
    reservation.release(settlement);
    queueMaintenanceAlarmRefresh();
  }
  return { ...result, alarmsScheduled: 'queued', deferred: false };
}

function captureDeferredMaintenanceReplay(options = {}) {
  const entries = options.replayBlockedSafetyIntents
    ? [...deferredMaintenanceRequests.entries()].filter(([, deferred]) => !deferred.installedReason)
    : [];
  return {
    entries,
    forceShieldExpiry: entries.some(([, options]) => options.forceShieldExpiry),
    forceStaleJobRecovery: entries.some(([, options]) => options.forceStaleJobRecovery),
    browserSessionBoundary: entries.some(([, options]) => options.browserSessionBoundary),
    record: entries.some(([, options]) => options.record),
    settledDnrJobIds: [...new Set(entries.flatMap(([, options]) => options.settledDnrJobIds || []).filter(Boolean))]
  };
}

function completeDeferredMaintenanceReplay(replay) {
  for (const [deferredReason, options] of replay?.entries || []) {
    const current = deferredMaintenanceRequests.get(deferredReason);
    if (current?.revision === options.revision) deferredMaintenanceRequests.delete(deferredReason);
  }
}

async function runLifecycleMaintenanceStage(reason, stage, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error?.name === 'LifecycleMaintenanceStageError') throw error;
    appendDebug({
      level: 'error',
      message: 'Lifecycle maintenance stage failed',
      reason: String(reason || 'maintenance'),
      stage,
      errorName: error?.name || 'Error'
    }).catch(() => {});
    throw new LifecycleMaintenanceStageError(String(reason || 'maintenance'), stage, error);
  }
}

function maintenanceSettlementFromError(error, fallbackStage = 'maintenance') {
  return {
    status: 'rejected',
    stage: String(error?.lifecycleStage || fallbackStage)
  };
}

function withMaintenanceReadTimeout(promise, label) {
  return withTimeoutReject(promise, MAINTENANCE_READ_TIMEOUT_MS, `Maintenance ${label}`);
}

async function appendLifecycleDebug(entry, options = {}) {
  const write = appendDebug(entry);
  if (options.boundedReads) {
    // Debug history is diagnostic only. A suspended or never-settling storage
    // read must not keep startup readiness reserved after all safety-bearing
    // recovery has settled. Its eventual write is extension-local and does not
    // grant cleanup authority or mutate browser data.
    write.catch(() => {});
    return;
  }
  await write;
}

function createMaintenanceReadBoundStorageArea(area, label) {
  return Object.freeze({
    get: (...args) => withMaintenanceReadTimeout(area.get(...args), label),
    set: (...args) => area.set(...args),
    remove: (...args) => area.remove(...args)
  });
}

function getSiteWipeDnrDiagnosticsBounded(activeShield = null) {
  return withMaintenanceReadTimeout(getSiteWipeDnrDiagnostics(activeShield), 'request-shield diagnostics inspection');
}

async function expireLatestReportIfNeededWithBoundedRead(now = Date.now()) {
  return withStorageMutation(REPORT_STATE_MAINTENANCE_MUTATION, async () => {
    const data = await withMaintenanceReadTimeout(
      chrome.storage.local.get([STORAGE_KEYS.activeReport, STORAGE_KEYS.settings]),
      'latest-report expiration state'
    );
    const settings = normalizeStoredSettings(data[STORAGE_KEYS.settings]);
    const activeReport = data[STORAGE_KEYS.activeReport];
    if (!latestReportIsExpired(activeReport, settings.latestReportRetentionMinutes, now)) return false;
    // The mutation itself is intentionally not timed out. If Chrome has
    // accepted a write but not settled it, the lifecycle reservation remains
    // held so no later action can overlap an unknown extension-state change.
    await chrome.storage.local.set({ [STORAGE_KEYS.activeReport]: null });
    return true;
  });
}

function createDnrPendingMutationMarker(activeShield = null) {
  const randomId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return Object.freeze({
    schemaVersion: 1,
    mutationId: `dnr-${randomId}`,
    sessionBinding: 'binding',
    jobId: typeof activeShield?.jobId === 'string' && activeShield.jobId ? activeShield.jobId : null,
    shieldStartedAt:
      typeof activeShield?.startedAt === 'string' && Number.isFinite(Date.parse(activeShield.startedAt))
        ? new Date(activeShield.startedAt).toISOString()
        : null,
    recordedAt: new Date().toISOString()
  });
}

function normalizeDnrPendingMutationMarker(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1) return null;
  const mutationId = typeof value.mutationId === 'string' ? value.mutationId : '';
  const sessionBinding =
    value.sessionBinding === 'binding' || value.sessionBinding === 'bound' ? value.sessionBinding : '';
  const recordedAt = typeof value.recordedAt === 'string' ? Date.parse(value.recordedAt) : Number.NaN;
  const jobId = value.jobId == null ? null : typeof value.jobId === 'string' ? value.jobId : undefined;
  const shieldStartedAt =
    value.shieldStartedAt == null
      ? null
      : typeof value.shieldStartedAt === 'string' && Number.isFinite(Date.parse(value.shieldStartedAt))
        ? new Date(value.shieldStartedAt).toISOString()
        : undefined;
  if (
    !/^dnr-[a-z0-9-]{8,160}$/i.test(mutationId) ||
    !sessionBinding ||
    !Number.isFinite(recordedAt) ||
    jobId === undefined ||
    (typeof jobId === 'string' && (!jobId || jobId.length > 160)) ||
    shieldStartedAt === undefined
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: 1,
    mutationId,
    sessionBinding,
    jobId,
    shieldStartedAt,
    recordedAt: new Date(recordedAt).toISOString()
  });
}

function dnrMutationMarkersFormBoundPair(local, session) {
  return Boolean(
    local &&
    session &&
    local.sessionBinding === 'bound' &&
    session.sessionBinding === 'bound' &&
    local.mutationId === session.mutationId &&
    local.jobId === session.jobId &&
    local.shieldStartedAt === session.shieldStartedAt &&
    local.recordedAt === session.recordedAt
  );
}

async function persistBoundDnrPendingMutationMarker(activeShield = null) {
  const binding = createDnrPendingMutationMarker(activeShield);
  // The local `binding` phase is deliberately not browser-bound evidence. A
  // failed session write must never look like a browser restart on the next
  // worker wake. Only the final local `bound` phase, written after the matching
  // session marker exists, may later prove that session storage was cleared.
  await chrome.storage.local.set({ [DNR_PENDING_MUTATION_LOCAL_KEY]: binding });
  const bound = Object.freeze({ ...binding, sessionBinding: 'bound' });
  await chrome.storage.session.set({ [DNR_PENDING_MUTATION_SESSION_KEY]: bound });
  await chrome.storage.local.set({ [DNR_PENDING_MUTATION_LOCAL_KEY]: bound });
  return bound;
}

async function readDnrPendingMutationMarkers(options = {}) {
  const localRead = chrome.storage.local.get([DNR_PENDING_MUTATION_LOCAL_KEY]);
  const sessionRead = chrome.storage.session.get([DNR_PENDING_MUTATION_SESSION_KEY]);
  const [localData, sessionData] = options.boundedReads
    ? await Promise.all([
        withMaintenanceReadTimeout(localRead, 'durable DNR mutation marker'),
        withMaintenanceReadTimeout(sessionRead, 'browser-session DNR mutation marker')
      ])
    : await Promise.all([localRead, sessionRead]);
  const localRaw = localData?.[DNR_PENDING_MUTATION_LOCAL_KEY];
  const sessionRaw = sessionData?.[DNR_PENDING_MUTATION_SESSION_KEY];
  const local = normalizeDnrPendingMutationMarker(localRaw);
  const session = normalizeDnrPendingMutationMarker(sessionRaw);
  return {
    local,
    session,
    localInvalid: localRaw != null && !local,
    sessionInvalid: sessionRaw != null && !session
  };
}

function dnrMutationMarkerMatchesShield(marker, activeShield) {
  if (!marker || !activeShield) return false;
  if (marker.jobId) return activeShield.jobId === marker.jobId;
  if (marker.shieldStartedAt) {
    return activeShield.jobId == null && activeShield.startedAt === marker.shieldStartedAt;
  }
  return activeShield.jobId == null;
}

function dnrMutationMarkerMatchesExpected(marker, expected = {}) {
  if (!marker) return false;
  if (expected.mutationId) return marker.mutationId === expected.mutationId;
  if (expected.jobId) return marker.jobId === expected.jobId;
  return false;
}

async function beginDnrPendingMutationMarker(activeShield = null, options = {}) {
  const existing = await readDnrPendingMutationMarkers(options);
  if (existing.localInvalid || existing.sessionInvalid) {
    throw new Error('SiteWipe found an invalid request-shield mutation marker. Restart the browser before cleanup.');
  }
  if (existing.local || existing.session) {
    if (
      dnrMutationMarkersFormBoundPair(existing.local, existing.session) &&
      (!activeShield || dnrMutationMarkerMatchesShield(existing.local, activeShield))
    ) {
      return existing.local;
    }
    throw new Error(
      'A SiteWipe request-shield browser operation from this browser session is unresolved. Restart the browser before retrying recovery.'
    );
  }
  return persistBoundDnrPendingMutationMarker(activeShield);
}

async function ensureDnrPendingMutationMarkerBinding(activeShield, options = {}) {
  const markers = await readDnrPendingMutationMarkers(options);
  if (markers.localInvalid || markers.sessionInvalid) {
    throw new Error('SiteWipe found an invalid request-shield mutation marker. Restart the browser before cleanup.');
  }
  if (!markers.local && !markers.session) return persistBoundDnrPendingMutationMarker(activeShield);
  if (
    dnrMutationMarkersFormBoundPair(markers.local, markers.session) &&
    dnrMutationMarkerMatchesShield(markers.local, activeShield)
  ) {
    return markers.local;
  }
  throw new Error(
    'SiteWipe could not prove that its request-shield mutation marker was fully bound to this browser session. Restart the browser before cleanup.'
  );
}

async function clearDnrPendingMutationMarker(expected = {}, options = {}) {
  const markers = await readDnrPendingMutationMarkers(options);
  if (dnrMutationMarkerMatchesExpected(markers.local, expected)) {
    await chrome.storage.local.remove(DNR_PENDING_MUTATION_LOCAL_KEY);
  }
  if (dnrMutationMarkerMatchesExpected(markers.session, expected)) {
    await chrome.storage.session.remove(DNR_PENDING_MUTATION_SESSION_KEY);
  }
}

async function reconcileDnrMutationSessionBoundary(reason, options = {}) {
  const shieldStorageLocal = options.boundedReads
    ? createMaintenanceReadBoundStorageArea(chrome.storage.local, 'request-shield session-boundary state')
    : chrome.storage.local;
  let activeShield =
    options.activeShield === undefined
      ? options.boundedReads
        ? await withMaintenanceReadTimeout(getActiveShield(), 'active shield for DNR session recovery')
        : await getActiveShield()
      : options.activeShield;
  let markers = await readDnrPendingMutationMarkers(options);
  const durableShieldUncertainty = Boolean(
    activeShield?.pendingMutation === true || activeShield?.lifecycle === 'installing'
  );
  if (markers.localInvalid || markers.sessionInvalid) {
    await persistBoundDnrPendingMutationMarker(activeShield);
    throw new Error(
      'SiteWipe quarantined an invalid request-shield mutation marker. Restart the browser, then reopen SiteWipe to complete recovery.'
    );
  }
  if (!markers.local && !markers.session && !durableShieldUncertainty) return { recovered: false };

  if (!markers.local && !markers.session && durableShieldUncertainty) {
    // Legacy/partially-written pending state has no trustworthy session epoch.
    // Quarantine it through one observable browser-session boundary instead of
    // treating a point-in-time empty diagnostic as proof that an old call can
    // no longer settle later.
    await persistBoundDnrPendingMutationMarker(activeShield);
    throw new Error(
      'SiteWipe found a request-shield operation without a browser-session recovery marker. Restart the browser, then reopen SiteWipe to complete recovery.'
    );
  }

  if (dnrMutationMarkersFormBoundPair(markers.local, markers.session)) {
    throw new Error(
      'A SiteWipe request-shield browser operation from this browser session may still settle. Restart the browser, then reopen SiteWipe to complete recovery.'
    );
  }

  const provenPriorSessionBinding = Boolean(
    markers.local?.sessionBinding === 'bound' && !markers.session && !markers.sessionInvalid
  );
  if (!provenPriorSessionBinding) {
    // Local `binding`, session-only, and conflicting marker states do not prove
    // a boundary. Establish a new, fully bound quarantine epoch in this
    // session, then require the next real browser-session boundary.
    await persistBoundDnrPendingMutationMarker(activeShield);
    throw new Error(
      'SiteWipe quarantined an incomplete or conflicting request-shield session marker. Restart the browser, then reopen SiteWipe to complete recovery.'
    );
  }

  if (!markers.local || hasPendingSiteWipeDnrMutation()) {
    throw new Error(`SiteWipe ${reason} recovery could not prove its request-shield mutation session closed.`);
  }

  const diagnostics = options.boundedReads
    ? await getSiteWipeDnrDiagnosticsBounded(activeShield)
    : await getSiteWipeDnrDiagnostics(activeShield);
  if (diagnostics?.available !== true || diagnostics?.error || diagnostics.activeRuleIds?.length) {
    throw new Error(
      `SiteWipe ${reason} recovery observed a browser-session boundary but could not prove the owned request-shield range empty.`
    );
  }

  if (activeShield && dnrMutationMarkerMatchesShield(markers.local, activeShield)) {
    let clearedMatchingShield = false;
    await mutateActiveShield(
      (currentShield) => {
        if (!currentShield || !dnrMutationMarkerMatchesShield(markers.local, currentShield)) return undefined;
        clearedMatchingShield = true;
        return null;
      },
      { storageLocal: shieldStorageLocal }
    );
    if (!clearedMatchingShield) {
      throw new Error(`SiteWipe ${reason} recovery found that the request-shield identity changed during proof.`);
    }
    activeShield = null;
  }
  await clearDnrPendingMutationMarker({ mutationId: markers.local.mutationId }, options);
  return { recovered: true, activeShield, diagnostics };
}

function latestReportIsExpired(report, retentionMinutes, now) {
  if (!report) return false;
  const minutes = Number(retentionMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) return false;
  const timestamp = Date.parse(report?.finishedAt || report?.startedAt || '');
  if (!Number.isFinite(timestamp)) return true;
  return Number(now) - timestamp > minutes * 60 * 1000;
}

async function markDnrMutationSettled(jobId) {
  // Settlement callbacks remove their own operation from the worker-local set
  // before arriving here. If another tracked operation remains, this job's
  // durable marker represents the whole unresolved group and must stay intact.
  // Losing the worker between the first and last settlement then remains
  // fail-closed behind the browser-session marker.
  if (hasPendingSiteWipeDnrMutation()) return { retained: true, pendingGroup: true };
  await mutateActiveShield((activeShield) => {
    if (!activeShield || activeShield.jobId !== jobId || activeShield.pendingMutation !== true) return undefined;
    return {
      ...activeShield,
      lifecycle: 'unknown',
      pendingMutation: false
    };
  });
  await clearDnrPendingMutationMarker({ jobId }, { boundedReads: true });
  return { retained: false, pendingGroup: false };
}

async function reconcileOwnedShieldStateWithSettlement(options = {}) {
  const shieldStorageLocal = options.boundedReads
    ? createMaintenanceReadBoundStorageArea(chrome.storage.local, 'request-shield recovery state')
    : chrome.storage.local;
  let activeShield =
    options.activeShield === undefined
      ? options.boundedReads
        ? await withMaintenanceReadTimeout(getActiveShield(), 'active request-shield state')
        : await getActiveShield()
      : options.activeShield;
  const sessionRecovery = await reconcileDnrMutationSessionBoundary('request-shield reconciliation', {
    activeShield,
    boundedReads: Boolean(options.boundedReads)
  });
  if (sessionRecovery?.recovered) activeShield = sessionRecovery.activeShield;
  const markerReadOptions = { boundedReads: Boolean(options.boundedReads) };
  const mutationMarker = await beginDnrPendingMutationMarker(activeShield, markerReadOptions);
  const onMutationSettled = async () => {
    try {
      if (hasPendingSiteWipeDnrMutation()) {
        // Another DNR promise in this logical recovery group can still mutate
        // the shared rule range. The final settlement callback (or a browser
        // session boundary after worker loss) owns demotion and reconciliation.
        return;
      }
      // The pending-operation set is released only after Chrome settles. Keep
      // this storage update identity-conditional so an old clear callback can
      // never alter a replacement job's shield record.
      await mutateActiveShield(
        (currentShield) => {
          if (!currentShield || currentShield.pendingMutation !== true) return undefined;
          const sameRecordedShield = activeShield?.jobId
            ? currentShield.jobId === activeShield.jobId
            : activeShield?.startedAt
              ? currentShield.startedAt === activeShield.startedAt && currentShield.jobId === activeShield.jobId
              : currentShield.jobId === null && currentShield.lifecycle === 'unknown';
          if (!sameRecordedShield) return undefined;
          return {
            ...currentShield,
            lifecycle: 'unknown',
            pendingMutation: false
          };
        },
        { storageLocal: shieldStorageLocal }
      );
      await clearDnrPendingMutationMarker({ mutationId: mutationMarker.mutationId }, { boundedReads: true });
      await requestLifecycleMaintenance('dnr-clear-settled', { record: false });
    } catch {
      // The durable local+session marker remains the recovery authority if a
      // settlement callback cannot finish its identity-bound storage update.
    }
  };

  try {
    const result = await reconcileOwnedShieldState({
      diagnose: (shield) => getSiteWipeDnrDiagnosticsBounded(shield),
      ...options,
      activeShield,
      forget: () => mutateActiveShield(() => null, { storageLocal: shieldStorageLocal }),
      retain: (recoveryRecord) => mutateActiveShield(() => recoveryRecord, { storageLocal: shieldStorageLocal }),
      onMutationSettled
    });
    if (hasPendingSiteWipeDnrMutation()) {
      await ensureDnrPendingMutationMarkerBinding(result.recoveryRecord || activeShield, markerReadOptions);
    } else if (result.pendingMutation !== true) {
      await clearDnrPendingMutationMarker({ mutationId: mutationMarker.mutationId }, markerReadOptions);
    }
    return result;
  } catch (error) {
    if (!hasPendingSiteWipeDnrMutation()) {
      await clearDnrPendingMutationMarker({ mutationId: mutationMarker.mutationId }, markerReadOptions).catch(() => {});
    }
    throw error;
  }
}

async function handleMaintenanceAlarm(alarm) {
  const name = alarm?.name || ALARMS.maintenance;
  if (
    ![ALARMS.maintenance, ALARMS.shieldExpiry, ALARMS.reportExpiry, ALARMS.staleJob, ALARMS.reviewExpiry].includes(name)
  )
    return;
  const result = await requestLifecycleMaintenance(`alarm:${name}`, {
    forceShieldExpiry: name === ALARMS.shieldExpiry
  });
  if (
    !result.deferred &&
    (result.shieldExpired || result.reportExpired || result.orphanShieldRepaired || result.staleJobRecovered)
  ) {
    await appendDebug({
      level: 'info',
      message: 'Scheduled maintenance completed',
      alarm: name,
      ...result
    });
  }
}

async function runMaintenanceCycle(reason = 'manual', options = {}) {
  const forceShieldExpiry = Boolean(options.forceShieldExpiry);
  // Run the safety-bearing stages sequentially. A sibling read timing out must
  // never make Promise.all release the lifecycle reservation while a request-
  // shield mutation is still executing.
  const dnrSessionRecovery = await runLifecycleMaintenanceStage(reason, 'request-shield-session-boundary', () =>
    reconcileDnrMutationSessionBoundary(reason, { boundedReads: true })
  );
  const shieldExpired = await runLifecycleMaintenanceStage(reason, 'request-shield-expiration', () =>
    expireActiveShieldIfNeeded(forceShieldExpiry, { boundedReads: true })
  );
  const reportExpired = await runLifecycleMaintenanceStage(
    reason,
    'report-expiration',
    expireLatestReportIfNeededWithBoundedRead
  );
  const staleJobRecovered = await runLifecycleMaintenanceStage(reason, 'stale-job-recovery', () =>
    recoverStaleJob(reason, {
      force: Boolean(options.forceStaleJobRecovery),
      boundedReads: true
    })
  );
  const orphanedApprovalHandoffRecovered = await runLifecycleMaintenanceStage(
    reason,
    'cleanup-approval-handoff-recovery',
    () => serializeCleanupReviewStateMutation(recoverOrphanedNonResumableCleanupHandoff)
  );
  const browserSessionPromptSettled = options.browserSessionBoundary
    ? await runLifecycleMaintenanceStage(reason, 'browser-session-permission-prompt-settlement', () =>
        serializeCleanupReviewStateMutation(() =>
          settleCleanupPromptAtBrowserSessionBoundary({
            storageSession: createMaintenanceReadBoundStorageArea(
              chrome.storage.session,
              'browser-session prompt tombstone'
            ),
            storageLocal: createMaintenanceReadBoundStorageArea(
              chrome.storage.local,
              'browser-session permission lease'
            )
          })
        )
      )
    : null;
  const orphanShieldRepaired = await runLifecycleMaintenanceStage(reason, 'orphan-shield-recovery', () =>
    repairOrphanedShieldIfAllowed(reason, {
      boundedReads: true,
      force: Boolean(options.forceOrphanShieldRepair)
    })
  );
  const maintenanceSessionStorage = createMaintenanceReadBoundStorageArea(
    chrome.storage.session,
    'cleanup-review state'
  );
  const maintenanceLocalStorage = createMaintenanceReadBoundStorageArea(chrome.storage.local, 'permission-lease state');
  let cleanupReviewExpiration = await runLifecycleMaintenanceStage(reason, 'cleanup-review-expiration', () =>
    serializeCleanupReviewStateMutation(() =>
      clearExpiredCleanupReview(maintenanceSessionStorage, Date.now(), {
        hasHostPermissions,
        containsHostPermissions: containsHostPermissionsStrict,
        getAllHostPermissions: getAllHostPermissionsStrict,
        releaseHostPermissions: releaseTemporaryHostPermissions,
        storageLocal: maintenanceLocalStorage,
        preserveLivePrepared: true,
        retainPreparedPromptOwnership: true,
        getPendingPromptContextId: getPendingCleanupApprovalPromptContextId,
        onPromptTombstoneRestored: requeueRestoredCleanupPromptTombstone
      })
    )
  );
  const grantedPromptTombstoneSettled = await runLifecycleMaintenanceStage(
    reason,
    'granted-permission-prompt-settlement',
    () =>
      serializeCleanupReviewStateMutation(() =>
        settleOwnedCleanupPromptTombstone({
          requireExactGrant: true,
          storageSession: maintenanceSessionStorage,
          storageLocal: maintenanceLocalStorage
        })
      )
  );
  if (grantedPromptTombstoneSettled?.settled && cleanupReviewExpiration?.hostPermissionCleanup?.recordRetained) {
    cleanupReviewExpiration = {
      ...cleanupReviewExpiration,
      hostPermissionCleanup: grantedPromptTombstoneSettled.settlement
    };
  }
  let preservedCleanupReview = await runLifecycleMaintenanceStage(reason, 'cleanup-review-readiness', () =>
    inspectLiveCleanupReview(maintenanceSessionStorage)
  );
  let permissionLeaseRecovery = await runLifecycleMaintenanceStage(reason, 'permission-lease-recovery', () =>
    recoverTemporaryPermissionLease(`maintenance:${reason}`, null, {
      storageLocal: maintenanceLocalStorage,
      boundedReads: true,
      preservedCleanupReview,
      forcePromptSettlement: !preservedCleanupReview
    })
  );
  if (preservedCleanupReview?.permissionLeaseId && permissionLeaseRecovery?.livePreparedAuthority !== true) {
    if (preservedCleanupReview.approvalHandoff?.status === 'prompt_tombstone') {
      throw new Error(
        'SiteWipe retained a native-prompt settlement tombstone without its exact temporary target-access lease.'
      );
    }
    cleanupReviewExpiration = await runLifecycleMaintenanceStage(reason, 'orphan-cleanup-review-recovery', () =>
      serializeCleanupReviewStateMutation(() =>
        clearCleanupReviewState(maintenanceSessionStorage, {
          hasHostPermissions,
          containsHostPermissions: containsHostPermissionsStrict,
          getAllHostPermissions: getAllHostPermissionsStrict,
          releaseHostPermissions: releaseTemporaryHostPermissions,
          storageLocal: maintenanceLocalStorage,
          forcePromptSettlement: true,
          retainPreparedPromptOwnership: true,
          getPendingPromptContextId: getPendingCleanupApprovalPromptContextId,
          onPromptTombstoneRestored: requeueRestoredCleanupPromptTombstone
        })
      )
    );
    if (cleanupReviewExpiration?.hostPermissionCleanup) {
      permissionLeaseRecovery = {
        reason: `orphan-review:${reason}`,
        ...cleanupReviewExpiration.hostPermissionCleanup
      };
    }
    preservedCleanupReview = null;
    queueAlarmClear(ALARMS.reviewExpiry);
  }
  await runLifecycleMaintenanceStage(reason, 'safety-proof', () =>
    assertMaintenanceSafetyProven(reason, {
      cleanupReviewExpiration,
      permissionLeaseRecovery,
      preservedCleanupReview
    })
  );
  const snapshot = {
    reason,
    at: new Date().toISOString(),
    dnrSessionBoundaryRecovered: Boolean(dnrSessionRecovery?.recovered),
    shieldExpired: Boolean(shieldExpired),
    reportExpired: Boolean(reportExpired),
    staleJobRecovered: Boolean(staleJobRecovered),
    orphanedApprovalHandoffRecovered: Boolean(orphanedApprovalHandoffRecovered),
    browserSessionPromptSettled: Boolean(browserSessionPromptSettled?.settled),
    grantedPromptTombstoneSettled: Boolean(grantedPromptTombstoneSettled?.settled),
    orphanShieldRepaired: Boolean(orphanShieldRepaired),
    cleanupReviewExpired: Boolean(cleanupReviewExpiration?.expired),
    temporaryHostAccessReleased: Boolean(permissionLeaseRecovery?.released),
    temporaryHostAccessRecoveryPending: Boolean(permissionLeaseRecovery?.recordRetained)
  };
  if (options.record !== false) await setLastMaintenance(snapshot).catch(() => {});
  return snapshot;
}

async function inspectLiveCleanupReview(storageSession, now = Date.now()) {
  const review = await readCleanupReviewRecord(storageSession);
  if (!review) return null;
  if (review.approvalHandoff?.status === 'prompt_tombstone') return review;
  return Number.isFinite(review.expiresAtMs) && Number(now) <= review.expiresAtMs ? review : null;
}

async function readCleanupReviewRecord(storageSession) {
  const data = await storageSession.get([CLEANUP_REVIEW_STORAGE_KEY]);
  return normalizeCleanupReviewRecord(data?.[CLEANUP_REVIEW_STORAGE_KEY]);
}

async function settleOwnedCleanupPromptTombstone(options = {}) {
  const storageSession = options.storageSession || chrome.storage.session;
  const storageLocal = options.storageLocal || chrome.storage.local;
  const review = await readCleanupReviewRecord(storageSession);
  if (review?.approvalHandoff?.status !== 'prompt_tombstone') return { found: false, settled: false };
  if (options.expectedNonce && review.approvalHandoff.nonce !== options.expectedNonce) {
    throw new Error('The cleanup permission handoff changed before prompt settlement.');
  }

  const lease = await getPermissionLease(storageLocal);
  if (!lease || !permissionLeaseMatchesLiveCleanupReview(lease, review)) {
    throw new Error('The prompt-settlement tombstone no longer matches its exact temporary target-access lease.');
  }
  if (options.requireExactGrant === true) {
    const grantedSnapshot = await getAllHostPermissionsStrict();
    const inventory = buildHostPermissionInventory({
      requiredOrigins: lease.temporaryOrigins,
      coveredRequiredOrigins: lease.temporaryOrigins,
      grantedOrigins: grantedSnapshot.origins
    });
    if (inventory.exactRequiredHostPermissionOrigins.length !== lease.temporaryOrigins.length) {
      return {
        found: true,
        settled: false,
        promptSettlementPending: true,
        leaseId: lease.id
      };
    }
  }

  const settlement = await settleCleanupPermissionPromptByLeaseId(lease.id, {
    storageSession,
    storageLocal,
    trustedWorkerSettlement: true
  });
  return { found: true, settled: true, settlement };
}

async function settleCleanupPromptAtBrowserSessionBoundary(options = {}) {
  const storageSession = options.storageSession || chrome.storage.session;
  const storageLocal = options.storageLocal || chrome.storage.local;
  let review = await readCleanupReviewRecord(storageSession);
  if (!review?.approvalHandoff || !['arming', 'armed', 'prompt_tombstone'].includes(review.approvalHandoff.status)) {
    return { found: false, settled: false };
  }
  if (review.approvalHandoff.status !== 'prompt_tombstone') {
    await cancelCleanupReviewRequest(
      { approvalToken: review.token },
      {
        storageSession,
        storageLocal,
        containsHostPermissions: containsHostPermissionsStrict,
        getAllHostPermissions: getAllHostPermissionsStrict,
        releaseHostPermissions: releaseTemporaryHostPermissions,
        retainPreparedPromptOwnership: true,
        getPendingPromptContextId: getPendingCleanupApprovalPromptContextId,
        onPromptTombstoneRestored: requeueRestoredCleanupPromptTombstone,
        tombstoneReason: 'browser_session_ended'
      }
    );
    review = await readCleanupReviewRecord(storageSession);
  }
  if (review?.approvalHandoff?.status !== 'prompt_tombstone') {
    throw new Error('The browser-session cleanup prompt boundary could not retain settlement ownership.');
  }
  return settleOwnedCleanupPromptTombstone({
    requireExactGrant: false,
    storageSession,
    storageLocal
  });
}

async function settleCleanupPermissionPromptByLeaseId(permissionLeaseId, options = {}) {
  const storageSession = options.storageSession || chrome.storage.session;
  const storageLocal = options.storageLocal || chrome.storage.local;
  const review = await readCleanupReviewRecord(storageSession);
  const pendingPromptContextId = review ? getPendingCleanupApprovalPromptContextId(review) : null;
  if (!options.trustedWorkerSettlement) {
    if (!review) throw new Error('The target-access prompt no longer has a prepared popup owner.');
    await assertCleanupReviewPopupBinding(review, options);
  }
  const pendingDeniedSettlement = Boolean(
    !options.trustedWorkerSettlement &&
    options.expectedOutcome === 'denied' &&
    review &&
    !review.approvalHandoff &&
    review.token === options.expectedApprovalToken &&
    review.approvalHandoffNonce === options.expectedHandoffNonce &&
    pendingPromptContextId === options.expectedPromptContextId
  );
  if (!options.trustedWorkerSettlement) {
    if (
      !pendingDeniedSettlement &&
      (!review?.approvalHandoff ||
        review.token !== options.expectedApprovalToken ||
        review.approvalHandoff.nonce !== options.expectedHandoffNonce ||
        review.approvalHandoff.promptContextId !== options.expectedPromptContextId)
    ) {
      throw new Error('Only the initiating popup context can settle this Chrome target-access prompt.');
    }
  }
  if (review && review.permissionLeaseId !== permissionLeaseId) {
    throw new Error('The target-access prompt no longer matches the prepared cleanup review.');
  }
  const lease = await getPermissionLease(storageLocal);
  if (
    !lease ||
    lease.id !== permissionLeaseId ||
    !['prepared', 'prompt_pending', 'release_pending'].includes(lease.status)
  ) {
    throw new Error('The target-access prompt could not be safely reconciled. Start again.');
  }

  const settlement = review
    ? (
        await cancelCleanupReviewRequest(
          { approvalToken: review.token },
          {
            storageSession,
            storageLocal,
            containsHostPermissions: containsHostPermissionsStrict,
            getAllHostPermissions: getAllHostPermissionsStrict,
            releaseHostPermissions: releaseTemporaryHostPermissions,
            retainPreparedPromptOwnership: true,
            getPendingPromptContextId: getPendingCleanupApprovalPromptContextId,
            onPromptTombstoneRestored: requeueRestoredCleanupPromptTombstone,
            promptSettled: true,
            forcePromptSettlement: true
          }
        )
      ).hostPermissionCleanup
    : await reconcilePermissionLease(
        storageLocal,
        {
          containsHostPermissions: containsHostPermissionsStrict,
          getAllHostPermissions: getAllHostPermissionsStrict,
          releaseHostPermissions: releaseTemporaryHostPermissions,
          forcePromptSettlement: true
        },
        permissionLeaseId
      );
  if (settlement?.released !== true || settlement?.accessRemains !== false || settlement?.recordRetained !== false) {
    throw new Error(
      'Chrome did not prove temporary target site access reconciled. No cleanup was admitted; review extension site-access controls.'
    );
  }
  queueAlarmClear(ALARMS.reviewExpiry);
  return settlement;
}

async function recoverOrphanedNonResumableCleanupHandoff() {
  const storageSession = createMaintenanceReadBoundStorageArea(
    chrome.storage.session,
    'cleanup approval handoff inspection'
  );
  const storageLocal = createMaintenanceReadBoundStorageArea(
    chrome.storage.local,
    'cleanup approval handoff permission lease'
  );
  const data = await storageSession.get([CLEANUP_REVIEW_STORAGE_KEY]);
  const review = normalizeCleanupReviewRecord(data?.[CLEANUP_REVIEW_STORAGE_KEY]);
  if (!review || !['arming', 'admitting'].includes(review.approvalHandoff?.status)) return false;
  const handoffStatus = review.approvalHandoff.status;
  const pendingArmOwner = pendingCleanupApprovalArms.get(review.approvalHandoff.nonce);
  if (handoffStatus === 'arming' && pendingArmOwner?.promptContextId === review.approvalHandoff.promptContextId) {
    // A final-click handler in this live worker staged the non-runnable marker
    // before waiting for this maintenance reservation. Its exact continuation
    // owns revalidation after settlement. A restarted worker has no owner and
    // therefore takes the orphan-to-tombstone recovery path below.
    return false;
  }
  const activeJob = await withMaintenanceReadTimeout(getActiveJob(), 'cleanup approval handoff active-job inspection');
  if (activeJob?.status === 'running' && activeJob.approvalHandoffNonce === review.approvalHandoff.nonce) {
    // Stale-job recovery owns this correlated boundary. If it deliberately
    // retained a live runner, the final maintenance proof remains blocked.
    return false;
  }
  const canceled = await cancelCleanupReviewRequest(
    { approvalToken: review.token },
    {
      storageSession,
      storageLocal,
      containsHostPermissions: containsHostPermissionsStrict,
      getAllHostPermissions: getAllHostPermissionsStrict,
      releaseHostPermissions: releaseTemporaryHostPermissions,
      retainPreparedPromptOwnership: true,
      getPendingPromptContextId: getPendingCleanupApprovalPromptContextId,
      onPromptTombstoneRestored: requeueRestoredCleanupPromptTombstone
    }
  );
  const armingBecameSettlementTombstone = Boolean(
    handoffStatus === 'arming' &&
    canceled.canceled === true &&
    canceled.promptTombstoneRetained === true &&
    canceled.hostPermissionCleanup?.recordRetained === true
  );
  const admittingWasFullyReconciled = Boolean(
    handoffStatus === 'admitting' &&
    canceled.canceled === true &&
    canceled.hostPermissionCleanup?.recordRetained !== true &&
    canceled.hostPermissionCleanup?.accessRemains !== true
  );
  if (!armingBecameSettlementTombstone && !admittingWasFullyReconciled) {
    throw new Error('A non-resumable cleanup approval handoff could not prove temporary target access reconciled.');
  }
  queueAlarmClear(ALARMS.reviewExpiry);
  return true;
}

async function assertMaintenanceSafetyProven(
  reason,
  { cleanupReviewExpiration, permissionLeaseRecovery, preservedCleanupReview }
) {
  const activeJob = await withMaintenanceReadTimeout(getActiveJob(), 'final active-job safety proof');
  if (activeJob?.status === 'running') {
    throw new Error(`SiteWipe ${reason} maintenance retained a running cleanup recovery obligation.`);
  }

  const activeShield = await withMaintenanceReadTimeout(getActiveShield(), 'final request-shield safety proof');
  const diagnostics = await getSiteWipeDnrDiagnosticsBounded(activeShield);
  const activeRuleIds = [...new Set((diagnostics?.activeRuleIds || []).filter(Number.isInteger))];
  const trackedRuleIds = [...new Set((activeShield?.ruleIds || []).filter(Number.isInteger))];
  const exactRuleSet =
    activeRuleIds.length === trackedRuleIds.length && activeRuleIds.every((ruleId) => trackedRuleIds.includes(ruleId));
  const shieldExpiresAt = Date.parse(activeShield?.expiresAt || '');
  const intentionallyLivePostWipeShield = Boolean(
    activeShield &&
    activeShield.mode === 'post-wipe-session' &&
    activeShield.lifecycle === 'active' &&
    activeShield.pendingMutation !== true &&
    Number.isFinite(shieldExpiresAt) &&
    Date.now() < shieldExpiresAt &&
    diagnostics?.healthy === true &&
    trackedRuleIds.length > 0 &&
    exactRuleSet
  );
  const provenEmpty = Boolean(!activeShield && activeRuleIds.length === 0 && diagnostics?.healthy === true);
  if (
    hasPendingSiteWipeDnrMutation() ||
    activeShield?.pendingMutation === true ||
    activeShield?.lifecycle === 'installing' ||
    activeShield?.lifecycle === 'unknown' ||
    diagnostics?.available !== true ||
    diagnostics?.error ||
    (!provenEmpty && !intentionallyLivePostWipeShield)
  ) {
    throw new Error(`SiteWipe ${reason} maintenance could not prove its owned request-shield state safe.`);
  }

  assertCleanupReviewAndPermissionRecoveryProven(
    cleanupReviewExpiration,
    permissionLeaseRecovery,
    preservedCleanupReview,
    `${reason} maintenance`
  );
}

function assertCleanupReviewAndPermissionRecoveryProven(
  cleanupReviewRecovery,
  permissionLeaseRecovery,
  preservedCleanupReview,
  label
) {
  const exactLivePreparedAuthority = Boolean(
    preservedCleanupReview && permissionLeaseRecovery?.livePreparedAuthority === true
  );
  if (preservedCleanupReview?.permissionLeaseId && !exactLivePreparedAuthority) {
    throw new Error(`SiteWipe ${label} retained cleanup-review authority without its exact live permission lease.`);
  }
  const permissionRecoveryProven = Boolean(
    exactLivePreparedAuthority ||
    (permissionLeaseRecovery?.released === true &&
      permissionLeaseRecovery?.accessRemains === false &&
      permissionLeaseRecovery?.recordRetained !== true)
  );
  if (!permissionRecoveryProven) {
    throw new Error(`SiteWipe ${label} retained an unresolved temporary target-access obligation.`);
  }

  const cleanup = cleanupReviewRecovery?.hostPermissionCleanup;
  if (!cleanup || cleanup.reason === 'preexisting_access_preserved') return;
  const cleanupProven = Boolean(
    (cleanup.released === true && cleanup.accessRemains === false && cleanup.recordRetained !== true) ||
    (exactLivePreparedAuthority && cleanup.leaseId === permissionLeaseRecovery?.leaseId) ||
    (cleanup.leaseId &&
      cleanup.leaseId === permissionLeaseRecovery?.leaseId &&
      permissionLeaseRecovery.released === true &&
      permissionLeaseRecovery.accessRemains === false &&
      permissionLeaseRecovery.recordRetained !== true)
  );
  if (!cleanupProven) {
    throw new Error(`SiteWipe ${label} could not prove cleanup-review target access reconciled.`);
  }
}

function permissionLeaseMatchesLiveCleanupReview(lease, review, now = Date.now()) {
  if (!lease || !review || lease.id !== review.permissionLeaseId) return false;
  const handoffStatus = review.approvalHandoff?.status || null;
  const pendingArmOwner = review.approvalHandoff?.nonce
    ? pendingCleanupApprovalArms.get(review.approvalHandoff.nonce)
    : null;
  const liveSameWorkerArming = Boolean(
    handoffStatus === 'arming' &&
    pendingArmOwner &&
    pendingArmOwner.promptContextId === review.approvalHandoff.promptContextId
  );
  if (handoffStatus && !['armed', 'prompt_tombstone'].includes(handoffStatus) && !liveSameWorkerArming) return false;
  if (lease.status !== 'prompt_pending') return false;
  const settlementTombstone = handoffStatus === 'prompt_tombstone';
  if (
    !settlementTombstone &&
    (!Number.isFinite(review.expiresAtMs) ||
      Number(now) > review.expiresAtMs ||
      Number(now) > Date.parse(lease.promptPendingUntil || ''))
  ) {
    return false;
  }
  const requestedOrigins = Array.isArray(review.target?.hostPermissionOrigins)
    ? review.target.hostPermissionOrigins.map(String)
    : [];
  const preexistingOrigins = Array.isArray(review.preexistingHostPermissionOrigins)
    ? review.preexistingHostPermissionOrigins.map(String)
    : [];
  const preexistingSet = new Set(preexistingOrigins);
  const temporaryOrigins = requestedOrigins.filter((origin) => !preexistingSet.has(origin));
  return (
    stringArraysEqual(lease.requestedOrigins, requestedOrigins) &&
    stringArraysEqual(lease.preexistingOrigins, preexistingOrigins) &&
    stringArraysEqual(lease.temporaryOrigins, temporaryOrigins) &&
    lease.reviewExpiresAt === new Date(review.expiresAtMs).toISOString()
  );
}

function stringArraysEqual(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

async function repairOrphanedShieldIfAllowed(reason, options = {}) {
  const settings = options.boundedReads
    ? await withMaintenanceReadTimeout(getSettings(), 'settings inspection for request-shield recovery')
    : await getSettings();
  if (settings.autoRepairOrphanedShields === false && !options.force) return false;
  // A shield rule can exist for a few milliseconds before its matching local
  // record is saved. Never classify that normal install window as an orphan
  // while a live cleanup job is making progress.
  const activeJob = options.boundedReads
    ? await withMaintenanceReadTimeout(getActiveJob(), 'active-job inspection for request-shield recovery')
    : await getActiveJob();
  if (isActiveRunningJob(activeJob)) return false;
  const activeShield = options.boundedReads
    ? await withMaintenanceReadTimeout(getActiveShield(), 'active request-shield inspection')
    : await getActiveShield();
  if (hasPendingSiteWipeDnrMutation() || activeShield?.pendingMutation === true) {
    // A timed-out browser rule call may still settle later. Do not schedule a
    // second recovery mutation that could overlap or be overwritten; the
    // settlement callback queues the next maintenance generation.
    return false;
  }
  const diagnostics = options.boundedReads
    ? await getSiteWipeDnrDiagnosticsBounded(activeShield)
    : await getSiteWipeDnrDiagnostics(activeShield);
  const incompleteTrackedShield = Boolean(
    activeShield &&
    (activeShield.lifecycle === 'unknown' ||
      diagnostics.missingTrackedRuleIds?.length ||
      diagnostics.orphanRuleIds?.length)
  );
  if (!incompleteTrackedShield && !diagnostics.orphanRuleIds?.length) return false;
  try {
    const reconciliation = await reconcileOwnedShieldStateWithSettlement({
      activeShield,
      boundedReads: Boolean(options.boundedReads)
    });
    await appendLifecycleDebug(
      {
        level: reconciliation.cleared ? 'info' : 'error',
        message: reconciliation.cleared
          ? incompleteTrackedShield
            ? 'Cleared incomplete SiteWipe DNR shield state'
            : 'Auto-repaired orphan SiteWipe DNR shield rules'
          : 'SiteWipe DNR recovery remains incomplete; recovery state retained',
        reason,
        orphanRuleCount: diagnostics.orphanRuleIds.length,
        missingRuleCount: diagnostics.missingTrackedRuleIds?.length || 0,
        activeRuleCountAfter: reconciliation.diagnostics?.activeRuleIds?.length || 0,
        recoveryRecordRetained: reconciliation.recordRetained
      },
      options
    );
    return reconciliation.cleared;
  } catch (error) {
    await appendLifecycleDebug(
      {
        level: 'error',
        message: 'Failed to auto-repair orphan SiteWipe DNR shield rules',
        reason,
        stack: error?.stack
      },
      options
    );
    return false;
  }
}

async function getMaintenanceStatusSnapshot(prefetched = {}) {
  const [settings, activeShield, activeJob, reportExpiresAt, lastMaintenance, permissionLeaseState] = await Promise.all(
    [
      prefetched.settings ? Promise.resolve(prefetched.settings) : getSettings(),
      prefetched.activeShield !== undefined ? Promise.resolve(prefetched.activeShield) : getActiveShield(),
      prefetched.activeJob !== undefined ? Promise.resolve(prefetched.activeJob) : getActiveJob(),
      getLatestReportExpiration(),
      getLastMaintenance(),
      inspectPermissionLeaseStatus()
    ]
  );
  let alarms;
  try {
    alarms = chrome.alarms?.getAll ? await chrome.alarms.getAll() : [];
  } catch {
    alarms = [];
  }
  const shieldDiagnostics = prefetched.shieldDiagnostics || (await getSiteWipeDnrDiagnostics(activeShield));
  return {
    at: new Date().toISOString(),
    alarmsAvailable: Boolean(chrome.alarms?.create),
    alarms: alarms.map((alarm) => ({
      name: alarm.name,
      scheduledTime: alarm.scheduledTime ? new Date(alarm.scheduledTime).toISOString() : null,
      periodInMinutes: alarm.periodInMinutes || null
    })),
    activeShieldExpiresAt: activeShield?.expiresAt || null,
    latestReportExpiresAt: reportExpiresAt,
    activeJobStatus: activeJob?.status || null,
    activeJobUpdatedAt: activeJob?.updatedAt || activeJob?.startedAt || null,
    activeJobAgeMs:
      activeJob?.updatedAt || activeJob?.startedAt
        ? Math.max(0, Date.now() - Date.parse(activeJob.updatedAt || activeJob.startedAt || ''))
        : null,
    lastMaintenance,
    autoRepairOrphanedShields: settings.autoRepairOrphanedShields !== false,
    temporaryHostAccess: permissionLeaseState,
    shieldDiagnostics
  };
}

async function resetExtensionLocalState() {
  const shieldClear = await reconcileOwnedShieldStateWithSettlement();
  const cleanupReview = await serializeCleanupReviewStateMutation(() =>
    clearCleanupReviewState(chrome.storage.session, {
      hasHostPermissions,
      containsHostPermissions: containsHostPermissionsStrict,
      getAllHostPermissions: getAllHostPermissionsStrict,
      releaseHostPermissions: releaseTemporaryHostPermissions,
      storageLocal: chrome.storage.local,
      preserveLivePrepared: true,
      retainPreparedPromptOwnership: true,
      getPendingPromptContextId: getPendingCleanupApprovalPromptContextId,
      onPromptTombstoneRestored: requeueRestoredCleanupPromptTombstone
    })
  );
  const preservedCleanupReview = await inspectLiveCleanupReview(chrome.storage.session);
  const permissionLeaseRecovery = await recoverTemporaryPermissionLease('local-state-reset', null, {
    preservedCleanupReview,
    forcePromptSettlement: !preservedCleanupReview
  });
  queueAlarmClear(ALARMS.reviewExpiry);
  const optionalFramePermissionRemoved = await removeNamedPermission('webNavigation');
  const resetSteps = [
    ['reports and current report', clearReports()],
    ['debug log', clearDebugLog()],
    ['active job', clearActiveJob()],
    ['maintenance snapshot', clearLastMaintenance()],
    ['toolbar badge', clearActionBadge()],
    ['settings', resetSettings()]
  ];
  const resetSettlements = await Promise.allSettled(resetSteps.map(([, operation]) => operation));
  const resetFailures = resetSettlements
    .map((settlement, index) =>
      settlement.status === 'rejected'
        ? {
            step: resetSteps[index][0],
            message: settlement.reason?.message || String(settlement.reason)
          }
        : null
    )
    .filter(Boolean);
  queueMaintenanceAlarmRefresh();
  await appendDebug({
    level: 'info',
    message: 'Extension-local SiteWipe state reset by user request'
  }).catch(() => {});
  return {
    at: new Date().toISOString(),
    browserWebsiteDataChanged: false,
    dnrRulesCleared: Boolean(shieldClear.cleared),
    cleanupReviewCleared: Boolean(cleanupReview.cleared),
    cleanupReviewHostAccessReleased: Boolean(cleanupReview.hostPermissionCleanup?.released),
    temporaryHostAccessRecoveryPending: Boolean(permissionLeaseRecovery?.recordRetained),
    optionalFramePermissionRemoved,
    localStateResetComplete: resetFailures.length === 0,
    resetFailures,
    shieldRecoveryRecordRetained: Boolean(!shieldClear.cleared && shieldClear.recordRetained),
    note: resetFailures.length
      ? `Some extension-local reset steps failed (${resetFailures.map((item) => item.step).join(', ')}). SiteWipe retained any permission or request-shield recovery obligation whose absence was not proved. Website data was not deleted.`
      : shieldClear.cleared && !permissionLeaseRecovery?.recordRetained
        ? 'Cleared SiteWipe-local reports, latest report, debug log, active job/shield records, toolbar badge, and settings. It did not delete website data.'
        : 'Cleared other SiteWipe-local state, but retained a permission or request-shield recovery obligation because the browser did not prove it empty. It did not delete website data.'
  };
}

function serializeAlarmMutation(operation) {
  const queued = alarmMutationPromise.catch(() => {}).then(operation);
  alarmMutationPromise = queued.catch(() => {});
  return queued;
}

function scheduleMaintenanceAlarms(options = {}) {
  return serializeAlarmMutation(() => performMaintenanceAlarmSchedule(options));
}

async function performMaintenanceAlarmSchedule(options = {}) {
  if (!chrome.alarms?.create) return false;
  try {
    // Alarm clear/create calls mutate browser scheduler state. Never timeout-
    // release one: a late clear could otherwise remove a newer deadline. The
    // serialized queue is detached from cleanup readiness, so a stalled alarm
    // API cannot block review or cleanup admission.
    await chrome.alarms.create(ALARMS.maintenance, { periodInMinutes: 15 });
    const [shield, reportExpiresAt, job] = await Promise.all([
      withMaintenanceReadTimeout(getActiveShield(), 'request-shield alarm inspection'),
      withMaintenanceReadTimeout(getLatestReportExpiration(), 'report-expiration alarm inspection'),
      withMaintenanceReadTimeout(getActiveJob(), 'stale-job alarm inspection')
    ]);
    await performAlarmScheduleAt(ALARMS.shieldExpiry, shield?.expiresAt);
    await performAlarmScheduleAt(ALARMS.reportExpiry, reportExpiresAt);
    const jobUpdated = Date.parse(job?.updatedAt || job?.startedAt || '');
    const jobExpires =
      job?.status === 'running' && Number.isFinite(jobUpdated)
        ? new Date(jobUpdated + ACTIVE_JOB_STALE_MS).toISOString()
        : null;
    await performAlarmScheduleAt(ALARMS.staleJob, jobExpires);
    return true;
  } catch (error) {
    if (options.strict) throw error;
    await appendDebug({
      level: 'error',
      message: 'Failed to schedule maintenance alarms',
      stack: error?.stack
    });
    return false;
  }
}

function scheduleAlarmAt(name, isoTime) {
  return serializeAlarmMutation(() => performAlarmScheduleAt(name, isoTime));
}

async function performAlarmScheduleAt(name, isoTime) {
  if (!chrome.alarms?.clear || !chrome.alarms?.create) return;
  await chrome.alarms.clear(name);
  const when = Date.parse(isoTime || '');
  if (Number.isFinite(when) && when > Date.now()) {
    await chrome.alarms.create(name, { when });
  }
}

function clearAlarmSafe(name) {
  return serializeAlarmMutation(async () => {
    try {
      await chrome.alarms?.clear?.(name);
    } catch {
      // Alarm cleanup is best-effort; session-record expiry remains authoritative.
    }
  });
}

function queueMaintenanceAlarmRefresh() {
  maintenanceAlarmRefreshRequested = true;
  if (maintenanceAlarmRefreshQueued) return;
  maintenanceAlarmRefreshQueued = true;
  maintenanceAlarmRefreshRequested = false;
  scheduleMaintenanceAlarms({ strict: true })
    .catch((error) =>
      appendDebug({
        level: 'error',
        message: 'Detached maintenance-alarm refresh failed',
        errorName: error?.name || 'Error'
      }).catch(() => {})
    )
    .finally(() => {
      maintenanceAlarmRefreshQueued = false;
      if (maintenanceAlarmRefreshRequested) queueMaintenanceAlarmRefresh();
    });
}

function queueAlarmAt(name, isoTime) {
  scheduleAlarmAt(name, isoTime).catch(() => {});
}

function queueAlarmClear(name) {
  clearAlarmSafe(name).catch(() => {});
}

async function setActionBadgeForJob(job) {
  if (!chrome.action?.setBadgeText) return;
  const status = job?.status || '';
  let text = '';
  let color = '#2563eb';
  if (status === 'running') {
    text = job.cancelRequested ? 'Stop' : `${Math.max(0, Math.min(99, Math.round(Number(job.percent) || 0)))}%`;
    color = job.cancelRequested ? '#d97706' : '#2563eb';
  } else if (status === 'completed') {
    text = 'Done';
    color = '#16a34a';
  } else if (status === 'cancelled') {
    text = 'Stop';
    color = '#d97706';
  } else if (status === 'failed' || status === 'interrupted') {
    text = 'Err';
    color = '#dc2626';
  }
  try {
    await chrome.action.setBadgeBackgroundColor?.({ color });
    await chrome.action.setBadgeText({ text });
  } catch {
    // Badge state is helpful but never required.
  }
}

async function clearActionBadge() {
  try {
    await chrome.action?.setBadgeText?.({ text: '' });
  } catch {
    // Ignore badge cleanup failures.
  }
}

function clearActionBadgeSoon(expectedJobId) {
  setTimeout(async () => {
    const activeJob = await getActiveJob().catch(() => null);
    if (activeJob?.id !== expectedJobId || activeJob.status === 'running') return;
    await clearActionBadge();
  }, 2500);
}

function isActiveRunningJob(job) {
  if (!job || job.status !== 'running') return false;
  const updated = Date.parse(job.updatedAt || job.startedAt || '');
  if (!Number.isFinite(updated)) return true;
  return Date.now() - updated < ACTIVE_JOB_STALE_MS;
}

async function assertNoLiveCleanup(action) {
  const activeJob = await getActiveJob();
  if (!cleanInProgress && !isActiveRunningJob(activeJob)) return;
  throw new Error(`A cleanup is still running. Cancel it or wait for it to finish before you ${action}.`);
}

async function assertNoPendingDnrInstallMutation(action) {
  const activeShield = await getActiveShield();
  if (
    !hasPendingSiteWipeDnrMutation() &&
    activeShield?.pendingMutation !== true &&
    activeShield?.lifecycle !== 'installing'
  ) {
    return;
  }
  throw new Error(
    `A previous request-shield rule update is still settling. SiteWipe must reconcile its owned browser rules before it can ${action}. Wait for maintenance to finish and try again.`
  );
}

async function runAdministrativeLifecycleAction(action, operation) {
  return withCleanupLifecycleReservation('administration', action, async () => {
    await assertNoLiveCleanup(action);
    try {
      return await operation();
    } finally {
      // Administrative mutations may invalidate review/lease/shield state even
      // when their final API call rejects. Set the failed barrier before the
      // reservation releases; the next interactive action must prove safety.
      poisonServiceWorkerLoadReadiness('administrative-mutation');
    }
  });
}

async function runRecoveryAdministrativeLifecycleAction(action, operation) {
  const reservation = await acquireRecoveryLifecycleReservation(action, 'Recovery action handoff');
  let result;
  let operationError = null;
  let operationStarted = false;
  let settlement = { status: 'rejected', stage: 'administrative-recovery' };
  try {
    await assertNoLiveCleanup(action);
    operationStarted = true;
    result = await operation();
    settlement = { status: 'fulfilled' };
  } catch (error) {
    operationError = error;
  } finally {
    if (operationStarted) poisonServiceWorkerLoadReadiness('administrative-recovery');
    reservation.release(settlement);
    queueMaintenanceAlarmRefresh();
  }

  if (!operationStarted) throw operationError;

  // A recovery command may intentionally run while readiness is failed by the
  // state it repairs. Never reuse an older successful generation afterward:
  // require a complete new proof before reporting the repair as finished.
  let proofError = null;
  try {
    await startServiceWorkerLoadReadinessMaintenance('administrative-recovery-proof');
  } catch (error) {
    proofError = error;
  }
  if (operationError) throw operationError;
  if (proofError) throw proofError;
  return result;
}

async function runPermissionPromptSettlementLifecycleAction(action, operation, options = {}) {
  const mutating = options.mutating !== false;
  const reservation = await acquirePermissionPromptSettlementReservation(action);
  let result;
  let operationStarted = false;
  let settlement = { status: 'rejected', stage: 'permission-prompt-settlement' };
  try {
    await assertNoLiveCleanup(action);
    operationStarted = true;
    result = await operation();
    settlement = { status: 'fulfilled' };
  } catch (error) {
    // A guard rejection did not touch durable state. Poisoning readiness here
    // would make the next administrative message run startup recovery and could
    // incorrectly interrupt the cleanup that the guard just protected.
    if (mutating && operationStarted) poisonServiceWorkerLoadReadiness('permission-prompt-settlement');
    throw error;
  } finally {
    reservation.release(settlement);
    queueMaintenanceAlarmRefresh();
  }
  if (mutating && operationStarted) {
    poisonServiceWorkerLoadReadiness('permission-prompt-settlement');
    startServiceWorkerLoadReadinessMaintenance('permission-prompt-settlement').catch((error) =>
      appendDebug({
        level: 'error',
        message: 'Permission-prompt settlement recovery failed',
        errorName: error?.name || 'Error'
      }).catch(() => {})
    );
  }
  return result;
}

async function acquirePermissionPromptSettlementReservation(action) {
  return acquireRecoveryLifecycleReservation(action, 'Permission-prompt repair handoff');
}

async function acquireRecoveryLifecycleReservation(action, handoffLabel) {
  while (true) {
    const existing = cleanupLifecycleReservation;
    if (!existing) return acquireCleanupLifecycleReservation('administration', action);
    if (existing.kind !== 'maintenance') return acquireCleanupLifecycleReservation('administration', action);
    try {
      await withTimeoutReject(existing.settled, MAINTENANCE_HANDOFF_TIMEOUT_MS, handoffLabel);
    } catch (error) {
      if (error?.name !== 'OperationTimeoutError') throw error;
      throw new LifecycleNotReadyError(existing.action, 'settlement-wait', { peerReservation: existing });
    }
    // A failed readiness generation may be waiting specifically on this prompt
    // lease. Once the sole maintenance reservation releases, the exact lease-
    // bound settlement route may repair it while all cleanup/admin peers remain
    // excluded by the same synchronous reservation.
  }
}

async function withCleanupLifecycleReservation(kind, action, operation) {
  const reservation = await acquireInteractiveCleanupLifecycleReservation(kind, action);
  try {
    await ensurePrivacyDefaults();
    return await operation();
  } finally {
    reservation.release();
  }
}

async function acquireInteractiveCleanupLifecycleReservation(kind, action) {
  interactiveMaintenanceWaiters += 1;
  try {
    while (true) {
      const existing = cleanupLifecycleReservation;
      if (!existing) {
        if (hasDeferredInstalledMaintenanceRequests()) {
          try {
            await withTimeoutReject(
              runCriticalDeferredInstalledMaintenanceHandoff(),
              MAINTENANCE_HANDOFF_TIMEOUT_MS,
              'Deferred install/update maintenance handoff'
            );
          } catch (error) {
            const stage =
              error?.name === 'LifecycleMaintenanceStageError'
                ? error.lifecycleStage || 'deferred-install-migrations'
                : 'deferred-install-migrations';
            throw new LifecycleNotReadyError('finish install/update maintenance', stage);
          }
          continue;
        }
        if (serviceWorkerLoadReadinessState.status === 'ready') {
          // JavaScript runs this synchronous check-and-set without an
          // intervening await. The first admitted waiter owns the lifecycle;
          // concurrent user actions recheck and fail closed.
          return acquireCleanupLifecycleReservation(kind, action);
        }
        if (serviceWorkerLoadReadinessState.status === 'failed') {
          startServiceWorkerLoadReadinessMaintenance('service-worker-load-retry');
          continue;
        }
        if (serviceWorkerLoadReadinessState.status === 'pending') {
          try {
            await withTimeoutReject(
              serviceWorkerLoadReadinessState.promise,
              MAINTENANCE_HANDOFF_TIMEOUT_MS,
              'Service-worker-load readiness'
            );
          } catch (error) {
            const stage =
              error?.name === 'LifecycleMaintenanceStageError'
                ? error.lifecycleStage || 'maintenance'
                : 'settlement-wait';
            throw new LifecycleNotReadyError('run service-worker-load maintenance', stage);
          }
          continue;
        }
        startServiceWorkerLoadReadinessMaintenance('service-worker-load-retry');
        continue;
      }

      if (existing.kind !== 'maintenance') {
        return acquireCleanupLifecycleReservation(kind, action);
      }

      let settlement;
      try {
        settlement = await withTimeoutReject(
          existing.settled,
          MAINTENANCE_HANDOFF_TIMEOUT_MS,
          'Lifecycle maintenance handoff'
        );
      } catch (error) {
        if (error?.name !== 'OperationTimeoutError') throw error;
        appendDebug({
          level: 'error',
          message: 'Interactive lifecycle handoff timed out',
          waitingAction: action,
          maintenanceAction: existing.action,
          stage: 'settlement-wait'
        }).catch(() => {});
        throw new LifecycleNotReadyError(existing.action, 'settlement-wait', { peerReservation: existing });
      }

      if (settlement?.status !== 'fulfilled') {
        appendDebug({
          level: 'error',
          message: 'Interactive lifecycle handoff observed failed maintenance',
          waitingAction: action,
          maintenanceAction: existing.action,
          stage: settlement?.stage || 'maintenance'
        }).catch(() => {});
        throw new LifecycleNotReadyError(existing.action, settlement?.stage || 'maintenance');
      }

      if (
        Number.isSafeInteger(existing.readinessGeneration) &&
        existing.readinessGeneration === serviceWorkerLoadReadinessState.generation
      ) {
        serviceWorkerLoadReadinessState = Object.freeze({
          status: 'ready',
          generation: existing.readinessGeneration,
          promise: Promise.resolve()
        });
      }
      // Recheck atomically on the next loop. If this was unrelated maintenance
      // and load readiness is still failed, the same original user request
      // starts and waits for a fresh recovery generation instead of bypassing
      // the failed startup barrier.
    }
  } finally {
    interactiveMaintenanceWaiters = Math.max(0, interactiveMaintenanceWaiters - 1);
    scheduleDeferredMaintenanceFlush();
  }
}

function acquireCleanupLifecycleReservation(kind, action, metadata = {}) {
  const existing = cleanupLifecycleReservation;
  if (existing) {
    const message =
      existing.kind === 'cleanup'
        ? `A cleanup is still running. Cancel it or wait for it to finish before you ${action}.`
        : kind === 'cleanup'
          ? `SiteWipe cannot start cleanup while it is still trying to ${existing.action}. Wait for that action to finish and review again.`
          : `SiteWipe is still trying to ${existing.action}. Wait for that action to finish before you ${action}.`;
    throw new Error(message);
  }

  const token = Symbol(kind);
  let settleReservation;
  const settled = new Promise((resolve) => {
    settleReservation = resolve;
  });
  cleanupLifecycleReservation = Object.freeze({
    token,
    kind,
    action,
    settled,
    readinessGeneration: Number.isSafeInteger(metadata.readinessGeneration) ? metadata.readinessGeneration : null
  });
  let released = false;
  return {
    release(outcome = { status: 'fulfilled' }) {
      if (released) return;
      released = true;
      if (cleanupLifecycleReservation?.token === token) {
        cleanupLifecycleReservation = null;
        settleReservation(
          Object.freeze({
            status: outcome?.status === 'rejected' ? 'rejected' : 'fulfilled',
            stage: outcome?.stage ? String(outcome.stage) : null,
            readinessGeneration: Number.isSafeInteger(outcome?.readinessGeneration) ? outcome.readinessGeneration : null
          })
        );
      }
      // Promise reactions for admitted interactive waiters are queued by the
      // settlement above before any deferred-maintenance microtask. This keeps
      // recurring alarms from repeatedly winning the reservation.
      scheduleDeferredMaintenanceFlush();
    }
  };
}

function tryAcquireCleanupLifecycleReservation(kind, action, metadata = {}) {
  if (cleanupLifecycleReservation) return null;
  return acquireCleanupLifecycleReservation(kind, action, metadata);
}

function deferMaintenanceRequest(reason, options = {}) {
  const existing = deferredMaintenanceRequests.get(reason) || {};
  const retryAfterFailure = options.retryAfterFailure === true;
  deferredMaintenanceRequests.set(reason, {
    revision: (deferredMaintenanceRevision += 1),
    forceShieldExpiry: Boolean(existing.forceShieldExpiry || options.forceShieldExpiry),
    forceStaleJobRecovery: Boolean(existing.forceStaleJobRecovery || options.forceStaleJobRecovery),
    browserSessionBoundary: Boolean(existing.browserSessionBoundary || options.browserSessionBoundary),
    ensurePrivacyDefaults: Boolean(existing.ensurePrivacyDefaults || options.ensurePrivacyDefaults),
    runMaintenanceCycle: Boolean(existing.runMaintenanceCycle || options.runMaintenanceCycle !== false),
    record: Boolean(existing.record || options.record !== false),
    installedReason: existing.installedReason || options.installedReason || null,
    settledDnrJobIds: [...new Set([...(existing.settledDnrJobIds || []), options.settledDnrJobId].filter(Boolean))]
  });
  if (retryAfterFailure) {
    deferredMaintenanceRetryBlocked = true;
  } else {
    deferredMaintenanceRetryBlocked = false;
    scheduleDeferredMaintenanceFlush();
  }
}

function retainFailedInstalledMaintenanceRequest(reason) {
  deferMaintenanceRequest(`runtime:${reason || 'unknown'}`, {
    installedReason: reason || 'unknown',
    runMaintenanceCycle: false,
    retryAfterFailure: true
  });
}

function hasDeferredInstalledMaintenanceRequests() {
  return [...deferredMaintenanceRequests.values()].some((options) => Boolean(options.installedReason));
}

async function runDeferredInstalledMaintenanceRequests(entries = [...deferredMaintenanceRequests.entries()]) {
  for (const [deferredReason, options] of entries) {
    if (!options.installedReason) continue;
    try {
      await runInstalledMaintenance(options.installedReason);
    } catch (error) {
      deferredMaintenanceRetryBlocked = true;
      throw error;
    }
    const current = deferredMaintenanceRequests.get(deferredReason);
    if (current?.revision === options.revision) deferredMaintenanceRequests.delete(deferredReason);
  }
}

async function runCriticalDeferredInstalledMaintenanceHandoff() {
  if (!hasDeferredInstalledMaintenanceRequests()) return { deferred: false };
  const reservation = tryAcquireCleanupLifecycleReservation(
    'maintenance',
    'finish deferred install/update maintenance'
  );
  if (!reservation) return { deferred: true };
  let settlement = { status: 'rejected', stage: 'deferred-install-migrations' };
  let result;
  try {
    await runLifecycleMaintenanceStage(
      'deferred-install/update',
      'deferred-install-migrations',
      runDeferredInstalledMaintenanceRequests
    );
    settlement = { status: 'fulfilled' };
    deferredMaintenanceRetryBlocked = false;
    result = { deferred: false };
  } catch (error) {
    settlement = maintenanceSettlementFromError(error, 'deferred-install-migrations');
    deferredMaintenanceRetryBlocked = true;
    poisonServiceWorkerLoadReadiness(settlement.stage);
    throw error;
  } finally {
    reservation.release(settlement);
    queueMaintenanceAlarmRefresh();
  }
  poisonServiceWorkerLoadReadiness('deferred-install-proof-required');
  startServiceWorkerLoadReadinessMaintenance('deferred-install-safety-proof').catch((error) =>
    appendDebug({
      level: 'error',
      message: 'Deferred install/update safety proof failed',
      errorName: error?.name || 'Error'
    }).catch(() => {})
  );
  return result;
}

function scheduleDeferredMaintenanceFlush() {
  if (
    deferredMaintenanceFlushScheduled ||
    deferredMaintenanceRetryBlocked ||
    cleanupLifecycleReservation ||
    interactiveMaintenanceWaiters > 0 ||
    deferredMaintenanceRequests.size === 0
  ) {
    return;
  }
  deferredMaintenanceFlushScheduled = true;
  queueMicrotask(() => {
    deferredMaintenanceFlushScheduled = false;
    flushDeferredMaintenanceRequests().catch((error) =>
      appendDebug({
        level: 'error',
        message: 'Deferred maintenance failed',
        stack: error?.stack
      }).catch(() => {})
    );
  });
}

async function flushDeferredMaintenanceRequests() {
  const reservation = tryAcquireCleanupLifecycleReservation('maintenance', 'run deferred maintenance');
  if (!reservation) return;
  const requests = [...deferredMaintenanceRequests.entries()];
  let settlement = { status: 'rejected', stage: 'deferred-maintenance' };
  try {
    const forceShieldExpiry = requests.some(([, options]) => options.forceShieldExpiry);
    const forceStaleJobRecovery = requests.some(([, options]) => options.forceStaleJobRecovery);
    const browserSessionBoundary = requests.some(([, options]) => options.browserSessionBoundary);
    const shouldEnsurePrivacyDefaults = requests.some(([, options]) => options.ensurePrivacyDefaults);
    const shouldRunMaintenanceCycle = requests.some(([, options]) => options.runMaintenanceCycle);
    const shouldRecordMaintenance = requests.some(([, options]) => options.record);
    const settledDnrJobIds = [
      ...new Set(requests.flatMap(([, options]) => options.settledDnrJobIds || []).filter(Boolean))
    ];
    const reasons = requests.map(([reason]) => reason);
    await runDeferredInstalledMaintenanceRequests(requests);
    for (const jobId of settledDnrJobIds) await markDnrMutationSettled(jobId);
    if (shouldEnsurePrivacyDefaults || shouldRunMaintenanceCycle) await ensurePrivacyDefaults();
    const result = shouldRunMaintenanceCycle
      ? await runMaintenanceCycle(`deferred:${reasons.join(',') || 'maintenance'}`, {
          forceShieldExpiry,
          forceStaleJobRecovery,
          browserSessionBoundary,
          record: shouldRecordMaintenance
        })
      : {
          reason: `deferred:${reasons.join(',') || 'maintenance'}`,
          at: new Date().toISOString()
        };
    for (const [deferredReason, options] of requests) {
      const current = deferredMaintenanceRequests.get(deferredReason);
      if (current?.revision === options.revision) deferredMaintenanceRequests.delete(deferredReason);
    }
    appendDebug({
      level: 'info',
      message: 'Deferred maintenance completed after a SiteWipe lifecycle action finished',
      deferredReasons: reasons,
      ...result
    }).catch(() => {});
    settlement = { status: 'fulfilled' };
    deferredMaintenanceRetryBlocked = false;
  } catch (error) {
    settlement = maintenanceSettlementFromError(error, 'deferred-maintenance');
    deferredMaintenanceRetryBlocked = true;
    poisonServiceWorkerLoadReadiness(settlement.stage);
    throw error;
  } finally {
    reservation.release(settlement);
    queueMaintenanceAlarmRefresh();
  }
}

async function updateJobProgress(jobId, targetDomain, progress) {
  let updated = false;
  const next = await mutateActiveJob((current) => {
    if (!current || current.id !== jobId || current.status !== 'running') return undefined;
    updated = true;
    return {
      ...current,
      targetDomain,
      percent: Math.max(0, Math.min(100, Number(progress?.percent) || 0)),
      phase: progress?.phase || current.phase || 'running',
      label: current.cancelRequested ? 'Cancel requested' : progress?.label || current.label || 'Running',
      detail: current.cancelRequested
        ? 'SiteWipe will stop before the next safe operation batch.'
        : progress?.detail || current.detail || '',
      updatedAt: progress?.at || new Date().toISOString()
    };
  });
  if (!updated || !next) return;
  await setActionBadgeForJob(next);
}

async function shouldCancelJob(jobId) {
  const current = await getActiveJob();
  // The durable job record is part of the running cleanup's authority. If it
  // disappears, changes identity, or becomes terminal, later destructive
  // phases must stop instead of treating the lost control state as approval.
  if (!current || current.id !== jobId || current.status !== 'running') return true;
  return current.cancelRequested === true;
}

async function recoverStaleJob(reason, options = {}) {
  const job = options.boundedReads
    ? await withMaintenanceReadTimeout(getActiveJob(), 'active-job inspection for stale recovery')
    : await getActiveJob();
  if (!job || job.status !== 'running') return false;
  const updated = Date.parse(job.updatedAt || job.startedAt || '');
  const stale = !Number.isFinite(updated) || Date.now() - updated >= ACTIVE_JOB_STALE_MS;
  const forceRecovery = Boolean(options.force) || reason === 'startup' || reason === 'service-worker-load';
  if (!stale && !forceRecovery) return false;
  const shield = options.boundedReads
    ? await withMaintenanceReadTimeout(getActiveShield(), 'request-shield inspection for stale recovery')
    : await getActiveShield();
  let shieldReconciled = true;
  if (shield?.mode !== 'post-wipe-session') {
    try {
      const reconciliation = await reconcileOwnedShieldStateWithSettlement({
        activeShield: shield,
        boundedReads: Boolean(options.boundedReads)
      });
      shieldReconciled = reconciliation.cleared;
      if (!reconciliation.cleared) {
        await appendLifecycleDebug(
          {
            level: 'error',
            message: 'Stale-job request-shield recovery remains incomplete; recovery state retained',
            activeRuleCount: reconciliation.diagnostics?.activeRuleIds?.length || 0,
            recoveryRecordRetained: reconciliation.recordRetained
          },
          options
        );
      }
    } catch (error) {
      shieldReconciled = false;
      await appendLifecycleDebug(
        {
          level: 'error',
          message: 'Failed to clear stale DNR shield',
          stack: error?.stack
        },
        options
      );
    }
  }
  const interruptedJob = {
    ...job,
    status: 'interrupted',
    label: 'Cleanup interrupted',
    detail: shieldReconciled
      ? 'The browser stopped the extension service worker before the cleanup could report completion. The temporary request-shield range was verified empty unless a post-wipe shield was active.'
      : 'The browser stopped the extension service worker before completion. Request-shield recovery remains tracked because Chrome did not prove the owned rule range empty.',
    updatedAt: new Date().toISOString(),
    interruptedAt: new Date().toISOString(),
    recoveryReason: reason
  };
  let recovered = false;
  const persistedJob = await mutateActiveJob(
    (currentJob) => {
      if (!currentJob || currentJob.id !== job.id || currentJob.status !== 'running') return undefined;
      recovered = true;
      return interruptedJob;
    },
    options.boundedReads
      ? {
          storageLocal: createMaintenanceReadBoundStorageArea(
            chrome.storage.local,
            'active-job mutation pre-write inspection for stale recovery'
          )
        }
      : undefined
  );
  if (!recovered) return false;
  await reconcileInterruptedApprovalAdmission(persistedJob, options);
  await setActionBadgeForJob(persistedJob);
  clearActionBadgeSoon(persistedJob.id);
  return true;
}

async function reconcileInterruptedApprovalAdmission(job, options = {}) {
  if (!job?.approvalHandoffNonce) return false;
  const storageSession = options.boundedReads
    ? createMaintenanceReadBoundStorageArea(chrome.storage.session, 'interrupted cleanup handoff state')
    : chrome.storage.session;
  const storageLocal = options.boundedReads
    ? createMaintenanceReadBoundStorageArea(chrome.storage.local, 'interrupted cleanup permission lease')
    : chrome.storage.local;
  const data = await storageSession.get([CLEANUP_REVIEW_STORAGE_KEY]);
  const review = normalizeCleanupReviewRecord(data?.[CLEANUP_REVIEW_STORAGE_KEY]);
  if (!review?.approvalHandoff || review.approvalHandoff.nonce !== job.approvalHandoffNonce) return false;
  const canceled = await serializeCleanupReviewStateMutation(() =>
    cancelCleanupReviewRequest(
      { approvalToken: review.token },
      {
        storageSession,
        storageLocal,
        containsHostPermissions: containsHostPermissionsStrict,
        getAllHostPermissions: getAllHostPermissionsStrict,
        releaseHostPermissions: releaseTemporaryHostPermissions,
        retainPreparedPromptOwnership: true,
        getPendingPromptContextId: getPendingCleanupApprovalPromptContextId,
        onPromptTombstoneRestored: requeueRestoredCleanupPromptTombstone
      }
    )
  );
  if (
    canceled.canceled !== true ||
    canceled.hostPermissionCleanup?.recordRetained === true ||
    canceled.hostPermissionCleanup?.accessRemains === true
  ) {
    throw new Error('Interrupted cleanup admission could not prove its temporary target access reconciled.');
  }
  return true;
}

async function expireActiveShieldIfNeeded(force = false, options = {}) {
  const activeJob = options.boundedReads
    ? await withMaintenanceReadTimeout(getActiveJob(), 'active-job inspection for shield expiration')
    : await getActiveJob();
  if (isActiveRunningJob(activeJob)) return false;
  const shield = options.boundedReads
    ? await withMaintenanceReadTimeout(getActiveShield(), 'active request-shield inspection for expiration')
    : await getActiveShield();
  if (!shield) return false;
  const expiresAt = Date.parse(shield.expiresAt || '');
  if (!force && (!Number.isFinite(expiresAt) || Date.now() < expiresAt)) return false;
  try {
    const reconciliation = await reconcileOwnedShieldStateWithSettlement({
      activeShield: shield,
      boundedReads: Boolean(options.boundedReads)
    });
    if (!reconciliation.cleared) {
      await appendLifecycleDebug(
        {
          level: 'error',
          message: 'Expired active shield could not be proven cleared; recovery state retained',
          target: shield.domain || shield.displayName || '',
          activeRuleCount: reconciliation.diagnostics?.activeRuleIds?.length || 0,
          recoveryRecordRetained: reconciliation.recordRetained
        },
        options
      );
      return false;
    }
    await appendLifecycleDebug(
      {
        level: 'info',
        message: force ? 'Active shield cleared by request' : 'Active shield expired and was cleared',
        target: shield.domain || shield.displayName || ''
      },
      options
    );
    return true;
  } catch (error) {
    await appendLifecycleDebug(
      {
        level: 'error',
        message: 'Failed to clear expired active shield',
        stack: error?.stack
      },
      options
    );
    return false;
  }
}

async function hasHostPermissions(origins) {
  try {
    return await containsHostPermissionsStrict(origins);
  } catch {
    return false;
  }
}

async function containsHostPermissionsStrict(origins) {
  if (!chrome.permissions?.contains) throw new Error('Host-permission inspection is unavailable.');
  return Boolean(
    await withTimeoutReject(
      chrome.permissions.contains({ origins }),
      PERMISSION_INSPECTION_TIMEOUT_MS,
      'Host-permission inspection'
    )
  );
}

async function getAllHostPermissionsStrict() {
  if (!chrome.permissions?.getAll) throw new Error('Host-permission inventory is unavailable.');
  const snapshot = await withTimeoutReject(
    chrome.permissions.getAll(),
    PERMISSION_INSPECTION_TIMEOUT_MS,
    'Host-permission inventory'
  );
  if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.origins)) {
    throw new Error('Host-permission inventory returned an invalid response.');
  }
  return snapshot;
}

async function hasNamedPermission(permission) {
  try {
    return await containsNamedPermissionStrict(permission);
  } catch {
    return false;
  }
}

async function containsNamedPermissionStrict(permission) {
  if (!chrome.permissions?.contains) throw new Error(`${permission} permission inspection is unavailable.`);
  return Boolean(
    await withTimeoutReject(
      chrome.permissions.contains({ permissions: [permission] }),
      PERMISSION_INSPECTION_TIMEOUT_MS,
      `${permission} permission inspection`
    )
  );
}

async function removeNamedPermissionStrict(permission) {
  if (!chrome.permissions?.remove) throw new Error(`${permission} permission removal is unavailable.`);
  return Boolean(await chrome.permissions.remove({ permissions: [permission] }));
}

async function removeNamedPermission(permission) {
  try {
    return await removeNamedPermissionStrict(permission);
  } catch {
    return false;
  }
}

async function getPermissionAwareSettings() {
  const settings = await getSettings();
  if (settings.embeddedFrameDiscovery && !(await hasNamedPermission('webNavigation'))) {
    return { ...settings, embeddedFrameDiscovery: false };
  }
  return settings;
}

async function invalidatePendingCleanupReview(options = {}) {
  const storageSession = options.boundedReads
    ? createMaintenanceReadBoundStorageArea(chrome.storage.session, 'pending cleanup-review state')
    : chrome.storage.session;
  const storageLocal = options.boundedReads
    ? createMaintenanceReadBoundStorageArea(chrome.storage.local, 'pending cleanup-review lease state')
    : chrome.storage.local;
  const result = await serializeCleanupReviewStateMutation(() =>
    clearCleanupReviewState(storageSession, {
      hasHostPermissions,
      containsHostPermissions: containsHostPermissionsStrict,
      getAllHostPermissions: getAllHostPermissionsStrict,
      releaseHostPermissions: releaseTemporaryHostPermissions,
      storageLocal,
      preserveLivePrepared: true,
      retainPreparedPromptOwnership: true,
      getPendingPromptContextId: getPendingCleanupApprovalPromptContextId,
      onPromptTombstoneRestored: requeueRestoredCleanupPromptTombstone
    })
  );
  queueAlarmClear(ALARMS.reviewExpiry);
  return result;
}

async function finalizeRunHostPermissions(
  origins,
  report,
  preexistingOrigins = [],
  permissionLeaseId = null,
  reviewedPermissionInventory = null
) {
  const requestedOrigins = [...new Set((origins || []).map(String).filter(Boolean))];
  const preservedOriginSet = new Set((preexistingOrigins || []).map(String).filter(Boolean));
  const preservedOrigins = requestedOrigins.filter((origin) => preservedOriginSet.has(origin));
  const temporaryOrigins = requestedOrigins.filter(
    (origin) => !preservedOriginSet.has(origin) && !isBroadHostPermissionOrigin(origin)
  );
  const reviewedInventory = buildHostPermissionInventory({
    requiredOrigins: requestedOrigins,
    coveredRequiredOrigins: preexistingOrigins,
    grantedOrigins: reviewedPermissionInventory?.grantedHostPermissionOrigins || preexistingOrigins
  });
  const releaseAfterRun = temporaryOrigins.length > 0;
  let targetAllowedBeforeRelease = null;
  let permissionInventoryBeforeRelease = null;
  let permissionInventoryAfterRelease = null;
  try {
    const targetOriginsGrantedBeforeRelease = await getGrantedHostPermissionOrigins(
      requestedOrigins,
      hasHostPermissions
    );
    const grantedPermissionsBeforeRelease = await getAllHostPermissionsStrict();
    permissionInventoryBeforeRelease = buildHostPermissionInventory({
      requiredOrigins: requestedOrigins,
      coveredRequiredOrigins: targetOriginsGrantedBeforeRelease,
      grantedOrigins: grantedPermissionsBeforeRelease.origins
    });
    targetAllowedBeforeRelease =
      requestedOrigins.length > 0 && targetOriginsGrantedBeforeRelease.length === requestedOrigins.length;
    const temporaryOriginsGrantedBeforeRelease = releaseAfterRun
      ? temporaryOrigins.filter((origin) =>
          permissionInventoryBeforeRelease.exactGrantedHostPermissionOrigins.includes(origin)
        )
      : [];
    let permissionLeaseRecovery = null;
    let released = false;
    if (permissionLeaseId) {
      permissionLeaseRecovery = await recoverTemporaryPermissionLease(
        'cleanup-host-permission-finalization',
        permissionLeaseId
      );
      released = permissionLeaseRecovery.released === true;
    } else if (temporaryOriginsGrantedBeforeRelease.length) {
      released = await releaseTemporaryHostPermissions(temporaryOriginsGrantedBeforeRelease);
    }
    const targetOriginsGrantedAfterRelease = await getGrantedHostPermissionOrigins(
      requestedOrigins,
      hasHostPermissions
    );
    const grantedPermissionsAfterRelease = await getAllHostPermissionsStrict();
    permissionInventoryAfterRelease = buildHostPermissionInventory({
      requiredOrigins: requestedOrigins,
      coveredRequiredOrigins: targetOriginsGrantedAfterRelease,
      grantedOrigins: grantedPermissionsAfterRelease.origins
    });
    const temporaryOriginsGrantedAfterRelease = releaseAfterRun
      ? temporaryOrigins.filter((origin) =>
          permissionInventoryAfterRelease.exactGrantedHostPermissionOrigins.includes(origin)
        )
      : [];
    const temporaryAccessRemains = temporaryOriginsGrantedAfterRelease.length > 0;
    const targetAllowedAfterRelease =
      requestedOrigins.length > 0 && targetOriginsGrantedAfterRelease.length === requestedOrigins.length;
    const releaseFailed = Boolean(
      releaseAfterRun &&
      (temporaryAccessRemains ||
        permissionLeaseRecovery?.recordRetained ||
        permissionLeaseRecovery?.reason === 'lease_mismatch')
    );
    const mixedAccess = preservedOrigins.length > 0 && temporaryOrigins.length > 0;
    report.hostPermissionsGranted = Boolean(targetAllowedBeforeRelease);
    report.hostPermissionsReleased = Boolean(releaseAfterRun && !temporaryAccessRemains);
    report.hostPermissionInventory = {
      reviewedPreflight: reviewedInventory,
      beforeRelease: permissionInventoryBeforeRelease,
      afterRelease: permissionInventoryAfterRelease
    };
    report.hostAccessMode = mixedAccess
      ? 'mixed_preserved_and_temporary_preflight_bound_origins'
      : releaseAfterRun
        ? 'temporary_preflight_bound_origins'
        : 'preexisting_preflight_bound_origins';
    report.summary.targetSiteAccessGranted = Boolean(targetAllowedBeforeRelease);
    report.summary.allSitesAccessGranted = permissionInventoryAfterRelease.allSitesAccessGranted;
    report.summary.broadHostPermissionOriginsGranted =
      permissionInventoryAfterRelease.broadGrantedHostPermissionOrigins.length;
    report.summary.exactRequiredHostPermissionOriginsGranted =
      permissionInventoryAfterRelease.exactGrantedHostPermissionOrigins.length;
    report.summary.hostPermissionsReleased = report.hostPermissionsReleased;
    report.summary.hostAccessMode = mixedAccess
      ? 'Pre-existing access preserved; temporary preflight-bound access released'
      : releaseAfterRun
        ? 'Temporary preflight-bound target access'
        : 'Pre-existing preflight-bound target access';
    addSection(
      report,
      'hostPermissions',
      releaseFailed
        ? 'Temporary target site access could not be released'
        : releaseAfterRun
          ? 'Temporary target site access released'
          : 'Pre-existing target site access preserved',
      releaseFailed ? 'partial' : 'success',
      {
        origins: requestedOrigins,
        preservedOrigins,
        temporaryOrigins,
        targetOriginsGrantedBeforeRelease,
        targetOriginsGrantedAfterRelease,
        targetAllowedBeforeRelease,
        temporaryOriginsGrantedBeforeRelease,
        temporaryOriginsGrantedAfterRelease,
        targetAllowedAfterRelease,
        reviewedPermissionInventory: reviewedInventory,
        permissionInventoryBeforeRelease,
        permissionInventoryAfterRelease,
        temporaryAccessRemains,
        released,
        permissionLeaseId: permissionLeaseId || null,
        permissionLeaseRecovery,
        releaseAfterRun,
        note: releaseFailed
          ? 'Chrome still reports access to one or more preflight-bound target patterns. Review extension site-access settings if you want to revoke it manually.'
          : releaseAfterRun
            ? 'Only exact target-specific host access absent before this review was released after browser cleanup and verification finished. Every broader or pre-existing user-controlled grant was preserved.'
            : 'Site access already existed before the review, so SiteWipe preserved every exact and broader user-controlled permission.'
      }
    );
    if (releaseFailed)
      addError(
        report,
        'Release temporary target site access',
        new Error('Chrome did not release every preflight-bound target origin permission.')
      );
    return {
      granted: targetAllowedBeforeRelease,
      released: report.hostPermissionsReleased,
      releaseFailed
    };
  } catch (error) {
    report.hostPermissionsGranted = targetAllowedBeforeRelease === true;
    report.hostPermissionsReleased = false;
    report.hostPermissionInventory = {
      reviewedPreflight: reviewedInventory,
      beforeRelease: permissionInventoryBeforeRelease,
      afterRelease: permissionInventoryAfterRelease
    };
    report.hostAccessMode =
      preservedOrigins.length && temporaryOrigins.length
        ? 'mixed_preserved_and_temporary_preflight_bound_origins'
        : releaseAfterRun
          ? 'temporary_preflight_bound_origins'
          : 'preexisting_preflight_bound_origins';
    report.summary.targetSiteAccessGranted = targetAllowedBeforeRelease;
    report.summary.allSitesAccessGranted = null;
    report.summary.broadHostPermissionOriginsGranted = null;
    report.summary.exactRequiredHostPermissionOriginsGranted = null;
    report.summary.hostPermissionsReleased = false;
    report.summary.hostAccessMode =
      preservedOrigins.length && temporaryOrigins.length
        ? 'Pre-existing access preserved; temporary preflight-bound access release uncertain'
        : releaseAfterRun
          ? 'Temporary preflight-bound target access'
          : 'Pre-existing preflight-bound target access';
    report.status = 'completed_with_warnings';
    addError(report, 'Finalize preflight-bound target site access', error);
    return {
      granted: targetAllowedBeforeRelease === true,
      released: false,
      releaseFailed: Boolean(releaseAfterRun)
    };
  }
}

async function recoverTemporaryPermissionLease(reason, expectedLeaseId = null, options = {}) {
  const storageLocal = options.storageLocal || chrome.storage.local;
  const recovery = permissionLeaseRecoveryPromise
    .catch(() => {})
    .then(async () => {
      const lease = await getPermissionLease(storageLocal);
      if (!lease) {
        return {
          reason,
          found: false,
          released: true,
          accessRemains: false,
          recordRetained: false
        };
      }

      if (!expectedLeaseId && lease.status === 'active_cleanup' && reason.startsWith('maintenance:')) {
        const activeJob = options.boundedReads
          ? await withMaintenanceReadTimeout(getActiveJob(), 'active-job inspection for permission recovery')
          : await getActiveJob();
        if (isActiveRunningJob(activeJob)) {
          return {
            reason,
            found: true,
            released: false,
            accessRemains: null,
            recordRetained: true,
            deferred: true,
            leaseId: lease.id
          };
        }
      }

      if (!expectedLeaseId && permissionLeaseMatchesLiveCleanupReview(lease, options.preservedCleanupReview)) {
        return {
          reason,
          found: true,
          released: false,
          accessRemains: null,
          recordRetained: true,
          deferred: true,
          deferReason: 'prepared_review_window',
          leaseId: lease.id,
          reviewExpiresAt: lease.reviewExpiresAt,
          leaseStatus: lease.status,
          livePreparedAuthority: true
        };
      }

      const result = await reconcilePermissionLease(
        storageLocal,
        {
          containsHostPermissions: containsHostPermissionsStrict,
          getAllHostPermissions: getAllHostPermissionsStrict,
          releaseHostPermissions: releaseTemporaryHostPermissions,
          forcePromptSettlement: options.forcePromptSettlement === true
        },
        expectedLeaseId
      );
      if (result.found && !result.deferred) {
        await appendDebug({
          level: result.released ? 'info' : 'error',
          message: result.released
            ? 'Temporary target site access reconciled'
            : 'Temporary target site access recovery remains pending',
          reason,
          permissionLeaseId: result.leaseId || lease.id,
          recordRetained: Boolean(result.recordRetained),
          accessRemains: result.accessRemains
        }).catch(() => {});
      }
      return { reason, ...result };
    });
  permissionLeaseRecoveryPromise = recovery.catch(() => {});
  return recovery;
}

async function inspectPermissionLeaseStatus() {
  try {
    const lease = await getPermissionLease(chrome.storage.local);
    if (!lease) return { state: 'none', recoveryPending: false };
    return {
      state: lease.status,
      recoveryPending: lease.status === 'release_pending',
      reviewExpiresAt: lease.reviewExpiresAt,
      temporaryOriginCount: lease.temporaryOrigins.length,
      releaseAttemptCount: lease.releaseAttemptCount,
      lastReleaseAttemptAt: lease.lastReleaseAttemptAt,
      lastError: lease.lastError
    };
  } catch (error) {
    return {
      state: 'invalid_record',
      recoveryPending: true,
      error: error?.message || String(error)
    };
  }
}

async function releaseTemporaryHostPermissions(origins) {
  if (!Array.isArray(origins) || !origins.length || !chrome.permissions?.remove) return false;
  const exactTargetOrigins = [...new Set(origins.map(String).filter((origin) => !isBroadHostPermissionOrigin(origin)))];
  if (!exactTargetOrigins.length) return false;
  return Boolean(await chrome.permissions.remove({ origins: exactTargetOrigins }));
}

async function getActiveTabTarget() {
  let tabs;
  try {
    tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch {
    tabs = [];
  }
  if (!tabs.length) {
    try {
      tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    } catch {
      tabs = [];
    }
  }

  const tab = tabs[0];
  if (!tab) {
    return {
      ok: false,
      supported: false,
      reason: 'No active tab was detected in the current window.'
    };
  }

  const settings = await getSettings();
  const activeUrl = tab.pendingUrl || tab.url || '';
  const normalized = normalizeSiteInput(activeUrl, {
    allowLocalTargets: settings.allowLocalTargets
  });
  return {
    ok: normalized.ok,
    supported: normalized.ok,
    reason: normalized.ok ? '' : normalized.error,
    tab: {
      id: tab.id,
      windowId: Number.isInteger(tab.windowId) ? tab.windowId : null,
      title: tab.title || '',
      url: activeUrl,
      favIconUrl: tab.favIconUrl || '',
      incognito: typeof tab.incognito === 'boolean' ? tab.incognito : null
    },
    normalized
  };
}

async function isIncognitoAllowed() {
  const inspect = chrome.extension?.isAllowedIncognitoAccess;
  if (typeof inspect !== 'function') {
    throw new Error('Private-window access state could not be inspected. Start the cleanup again.');
  }
  try {
    const inspection = new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback) => (value) => {
        if (settled) return;
        settled = true;
        callback(value);
      };
      const resolveOnce = finish((allowed) => resolve(Boolean(allowed)));
      const rejectOnce = finish(reject);
      const callback = (allowed) => {
        const lastError = chrome.runtime?.lastError;
        if (lastError) {
          rejectOnce(new Error(lastError.message || 'Private-window access inspection failed.'));
          return;
        }
        resolveOnce(allowed);
      };
      const result = inspect.call(chrome.extension, callback);
      if (result && typeof result.then === 'function') result.then(resolveOnce, rejectOnce);
      else if (typeof result === 'boolean') resolveOnce(result);
    });
    return await withTimeoutReject(inspection, PERMISSION_INSPECTION_TIMEOUT_MS, 'Private-window access inspection');
  } catch (error) {
    throw new Error('Private-window access state could not be verified. Start the cleanup again.', {
      cause: error
    });
  }
}

async function inspectSourceWindow(windowId) {
  if (!Number.isInteger(windowId) || windowId < 0 || typeof chrome.windows?.get !== 'function') {
    throw new Error('Source-window inspection is unavailable.');
  }
  const inspected = await withTimeoutReject(
    chrome.windows.get(windowId),
    PERMISSION_INSPECTION_TIMEOUT_MS,
    'Source-window inspection'
  );
  if (!inspected || inspected.id !== windowId || typeof inspected.incognito !== 'boolean') {
    throw new Error('Source-window inspection returned an invalid window context.');
  }
  return {
    sourceWindowId: inspected.id,
    sourceIncognito: inspected.incognito
  };
}

async function bindSidePanelReport(payload, sender) {
  if (getExtensionSenderUrl(sender) !== chrome.runtime.getURL('popup/popup.html')) {
    throw new Error('Only the SiteWipe popup can bind a stored report to the side panel.');
  }
  const windowId = payload.windowId;
  const [inspectedWindow, activeTabs] = await Promise.all([
    chrome.windows.get(windowId),
    chrome.tabs.query({ active: true, windowId })
  ]);
  const activeTab = activeTabs?.[0];
  if (
    !inspectedWindow ||
    inspectedWindow.id !== windowId ||
    typeof inspectedWindow.incognito !== 'boolean' ||
    !activeTab ||
    activeTab.windowId !== windowId
  ) {
    throw new Error('The popup browser window changed before the full report could be bound.');
  }
  const report = await getLastReport();
  if (!report || report.id !== payload.reportId) {
    throw new Error('The displayed report is no longer the latest stored report. Nothing was bound.');
  }
  const binding = createSidePanelReportBinding(report.id, windowId);
  const storageKey = getSidePanelReportBindingStorageKey(windowId);
  await chrome.storage.session.set({ [storageKey]: binding });
  return {
    reportId: binding.reportId,
    windowId: binding.windowId,
    expiresAt: binding.expiresAt
  };
}

async function assertBoundSidePanelReport(payload, sender) {
  if (getExtensionSenderUrl(sender) !== chrome.runtime.getURL('sidepanel/sidepanel.html')) {
    throw new Error('Only the SiteWipe side panel can read a popup-bound full report.');
  }
  const storageKey = getSidePanelReportBindingStorageKey(payload.windowId);
  const data = await chrome.storage.session.get([storageKey]);
  const binding = normalizeSidePanelReportBinding(data?.[storageKey], payload.windowId);
  if (!binding || binding.reportId !== payload.reportId) {
    throw new Error('The full-report binding is missing, expired, or does not match this browser window.');
  }
}

function getExtensionSenderUrl(sender) {
  return String(sender?.documentUrl || sender?.url || '');
}

function isTrustedInternalArmedCleanup(message, sender, internalContext) {
  const expectedApprovalHandoffNonce = String(internalContext?.expectedApprovalHandoffNonce || '');
  return Boolean(
    message?.type === MESSAGE_TYPES.runDeepClean &&
    /^[a-f0-9]{48}$/.test(expectedApprovalHandoffNonce) &&
    sender?.id === chrome.runtime.id &&
    sender?.tab == null &&
    getExtensionSenderUrl(sender) === chrome.runtime.getURL('background/service-worker.js')
  );
}

function assertExactPopupSender(sender, action) {
  const popupUrl = chrome.runtime.getURL('popup/popup.html');
  const extensionOrigin = chrome.runtime.getURL('').replace(/\/$/, '');
  const reportedUrls = [sender?.documentUrl, sender?.url].filter(
    (value) => typeof value === 'string' && value.length > 0
  );
  if (
    sender?.id !== chrome.runtime.id ||
    sender?.tab != null ||
    (sender?.origin != null && sender.origin !== extensionOrigin) ||
    reportedUrls.length === 0 ||
    reportedUrls.some((value) => value !== popupUrl)
  ) {
    throw new Error(`Only the exact SiteWipe popup can ${action}.`);
  }
}

function normalizeRuntimePopupContextId(value) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > 256) return null;
  return value;
}

function validateRuntimePopupContext(context, { expectedContextId = null } = {}) {
  const popupUrl = chrome.runtime.getURL('popup/popup.html');
  const contextId = normalizeRuntimePopupContextId(context?.contextId);
  const sharedExtensionProfile = chrome.runtime.getManifest()?.incognito !== 'split';
  if (
    !contextId ||
    (expectedContextId && contextId !== expectedContextId) ||
    context?.contextType !== 'POPUP' ||
    context?.documentUrl !== popupUrl ||
    context?.tabId !== -1 ||
    context?.windowId !== -1 ||
    typeof context?.incognito !== 'boolean' ||
    (sharedExtensionProfile && context.incognito)
  ) {
    throw new Error('Chrome returned a malformed or mismatched SiteWipe popup context. Reopen SiteWipe.');
  }
  return { contextId, windowId: context.windowId, incognito: context.incognito };
}

async function inspectExactPreparingPopupContext() {
  if (typeof chrome.runtime.getContexts !== 'function') {
    throw new Error('Chrome cannot verify the SiteWipe popup context. Reopen SiteWipe.');
  }
  const popupUrl = chrome.runtime.getURL('popup/popup.html');
  const contexts = await withTimeoutReject(
    Promise.resolve(
      chrome.runtime.getContexts({
        contextTypes: ['POPUP'],
        documentUrls: [popupUrl]
      })
    ),
    PERMISSION_INSPECTION_TIMEOUT_MS,
    'Cleanup popup context inspection'
  );
  if (!Array.isArray(contexts)) throw new Error('Chrome returned an invalid extension-context inspection.');
  if (contexts.length !== 1) {
    throw new Error(
      'Chrome could not identify exactly one SiteWipe popup context. Close duplicate popups and reopen SiteWipe.'
    );
  }
  return validateRuntimePopupContext(contexts[0]);
}

async function inspectPreparationContextActive(contextId) {
  const normalizedContextId = normalizeRuntimePopupContextId(contextId);
  if (!normalizedContextId || typeof chrome.runtime.getContexts !== 'function') {
    throw new Error('Chrome cannot prove whether the previous SiteWipe popup context is still active.');
  }
  const contexts = await withTimeoutReject(
    Promise.resolve(chrome.runtime.getContexts({ contextIds: [normalizedContextId] })),
    PERMISSION_INSPECTION_TIMEOUT_MS,
    'Previous cleanup popup context inspection'
  );
  if (!Array.isArray(contexts)) throw new Error('Chrome returned an invalid extension-context inspection.');
  if (contexts.length === 0) return false;
  if (contexts.length !== 1) throw new Error('Chrome returned multiple matches for one popup context id.');
  validateRuntimePopupContext(contexts[0], { expectedContextId: normalizedContextId });
  return true;
}

async function removeLegacyContentSettingPreference(options = {}) {
  const storageLocal = options.storageLocal || chrome.storage.local;
  const data = await storageLocal.get([STORAGE_KEYS.settings]);
  const stored = data[STORAGE_KEYS.settings];
  if (!stored || typeof stored !== 'object' || !Object.prototype.hasOwnProperty.call(stored, 'contentSettingReset'))
    return;
  const { contentSettingReset: _legacy, ...next } = stored;
  await storageLocal.set({ [STORAGE_KEYS.settings]: next });
}

async function repairSiteWipeRuntime(reason, options = {}) {
  const staleJobRecovered = await recoverStaleJob(reason, {
    force: Boolean(options.forceRecoverRunningJob)
  });
  const shieldExpired = await expireActiveShieldIfNeeded();
  let partialShieldCleared = false;
  const activeShield = await getActiveShield();
  const diagnostics = await getSiteWipeDnrDiagnostics(activeShield);
  const ownedStateMayRemain = Boolean(
    activeShield ||
    !diagnostics.available ||
    diagnostics.error ||
    diagnostics.activeRuleIds?.length ||
    diagnostics.orphanRuleIds?.length ||
    diagnostics.missingTrackedRuleIds?.length
  );
  let orphanShieldRepaired = false;
  if (ownedStateMayRemain) {
    const reconciliation = await reconcileOwnedShieldStateWithSettlement({ activeShield });
    partialShieldCleared = Boolean(activeShield && reconciliation.cleared);
    orphanShieldRepaired = Boolean(!activeShield && diagnostics.activeRuleIds?.length && reconciliation.cleared);
    if (!reconciliation.cleared) {
      const error = new Error(
        'Chrome did not prove the SiteWipe-owned request-shield range empty; recovery state was retained. Cleanup was stopped before browser-data mutation.'
      );
      await appendDebug({
        level: 'error',
        message: 'SiteWipe pre-cleanup repair could not clear incomplete shield state',
        reason,
        stack: error.stack
      }).catch(() => {});
      throw error;
    }
    await appendDebug({
      level: 'info',
      message: 'Cleared SiteWipe request-shield state before a new cleanup',
      reason,
      missingRuleCount: diagnostics.missingTrackedRuleIds?.length || 0,
      orphanRuleCount: diagnostics.orphanRuleIds?.length || 0
    });
  }
  return {
    reason,
    staleJobRecovered,
    shieldExpired,
    partialShieldCleared,
    orphanShieldRepaired,
    repaired: Boolean(staleJobRecovered || shieldExpired || partialShieldCleared || orphanShieldRepaired),
    repairError: null
  };
}

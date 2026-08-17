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
  clearActiveShieldRecord,
  forgetLatestReport,
  expireLatestReportIfNeeded,
  getLatestReportExpiration,
  getLastMaintenance,
  setLastMaintenance,
  clearLastMaintenance,
  migrateStoredReportsToPrivacyDefaults
} from '../shared/storage.js';
import { normalizeSiteInput, validateAssociatedDomainGroups, runDomainSelfTests } from './domain.js';
import { addError, addSection, finishReport } from './report.js';
import { initializeReviewedCleanupReport } from './cleanup-authorization.js';
import { runDeepClean, getSiteWipeDnrDiagnostics, inspectCleanupImpact } from './cleanup.js';
import { reconcileOwnedShieldState } from './shield-recovery.js';
import { findProtectedBrowserServiceTargets } from '../shared/safety.js';
import { getEffectiveCleanupSettings } from '../shared/cleanup-mode.js';
import {
  prepareCleanupReviewRequest,
  cancelCleanupReviewRequest,
  consumeCleanupReviewRequest,
  clearExpiredCleanupReview,
  clearCleanupReviewState,
  getTemporaryReviewHostPermissionOrigins,
  getGrantedHostPermissionOrigins
} from './cleanup-preflight.js';
import { validateMessageEnvelope } from '../shared/message-contracts.js';
import { redactReport } from '../shared/report-redaction.js';
import { getPermissionLease, isPreparedPermissionLeaseLive, reconcilePermissionLease } from './permission-leases.js';

let cleanInProgress = false;
let cleanupReviewPreparationInProgress = false;
let privacyMigrationPromise = null;
let permissionLeaseRecoveryPromise = Promise.resolve();
const ACTIVE_JOB_STALE_MS = 2 * 60 * 60 * 1000;
const ALARMS = Object.freeze({
  maintenance: 'sitewipe.maintenance',
  shieldExpiry: 'sitewipe.shieldExpiry',
  reportExpiry: 'sitewipe.reportExpiry',
  staleJob: 'sitewipe.staleJob',
  reviewExpiry: 'sitewipe.reviewExpiry'
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  try {
    await recoverTemporaryPermissionLease(`runtime:${reason}`);
    const now = new Date().toISOString();
    if (reason === 'install') {
      await chrome.storage.local.set({
        [STORAGE_KEYS.settings]: {
          ...DEFAULT_SETTINGS,
          createdAt: now,
          updatedAt: now,
          stabilityDefaultsAppliedAt: now,
          performanceDefaultsAppliedAt: now,
          privacyDefaultsAppliedAt: now
        }
      });
      await scheduleMaintenanceAlarms();
      return;
    }

    if (reason === 'update') {
      await removeLegacyContentSettingPreference();
      const settings = await getSettings();
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
        await migrateStoredReportsToPrivacyDefaults();
        Object.assign(patch, {
          redactReports: true,
          latestReportRetentionMinutes: 30,
          privacyDefaultsAppliedAt: now
        });
      }
      await saveSettings(patch);
    }
    await expireLatestReportIfNeeded();
    await scheduleMaintenanceAlarms();
  } catch (error) {
    await appendDebug({
      level: 'error',
      message: 'Install/update maintenance failed',
      stack: error?.stack
    }).catch(() => {});
  }
});

chrome.runtime.onStartup?.addListener?.(() => {
  recoverTemporaryPermissionLease('startup').catch((error) =>
    appendDebug({
      level: 'error',
      message: 'Temporary target-access recovery failed',
      stack: error?.stack
    }).catch(() => {})
  );
  ensurePrivacyDefaults().catch((error) =>
    appendDebug({
      level: 'error',
      message: 'Privacy-default migration failed',
      stack: error?.stack
    }).catch(() => {})
  );
  expireActiveShieldIfNeeded().catch((error) =>
    appendDebug({
      level: 'error',
      message: 'Active-shield expiration check failed',
      stack: error?.stack
    }).catch(() => {})
  );
  recoverStaleJob('startup').catch((error) =>
    appendDebug({
      level: 'error',
      message: 'Stale-job recovery failed',
      stack: error?.stack
    }).catch(() => {})
  );
  scheduleMaintenanceAlarms().catch((error) =>
    appendDebug({
      level: 'error',
      message: 'Maintenance alarm scheduling failed',
      stack: error?.stack
    }).catch(() => {})
  );
});

expireActiveShieldIfNeeded().catch((error) =>
  appendDebug({
    level: 'error',
    message: 'Active-shield expiration check failed',
    stack: error?.stack
  }).catch(() => {})
);
ensurePrivacyDefaults().catch((error) =>
  appendDebug({
    level: 'error',
    message: 'Privacy-default migration failed',
    stack: error?.stack
  }).catch(() => {})
);
recoverStaleJob('service-worker-load').catch((error) =>
  appendDebug({
    level: 'error',
    message: 'Stale-job recovery failed',
    stack: error?.stack
  }).catch(() => {})
);
scheduleMaintenanceAlarms().catch((error) =>
  appendDebug({
    level: 'error',
    message: 'Maintenance alarm scheduling failed',
    stack: error?.stack
  }).catch(() => {})
);
recoverTemporaryPermissionLease('service-worker-load').catch((error) =>
  appendDebug({
    level: 'error',
    message: 'Temporary target-access recovery failed',
    stack: error?.stack
  }).catch(() => {})
);
clearExpiredCleanupReview(chrome.storage.session, Date.now(), {
  hasHostPermissions,
  containsHostPermissions: containsHostPermissionsStrict,
  releaseHostPermissions: releaseTemporaryHostPermissions,
  storageLocal: chrome.storage.local
}).catch(() => {});

chrome.alarms?.onAlarm?.addListener?.((alarm) => {
  handleMaintenanceAlarm(alarm).catch((error) =>
    appendDebug({
      level: 'error',
      message: 'Maintenance alarm failed',
      alarm: alarm?.name,
      stack: error?.stack
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

function classifyResponseError(error) {
  if (error?.name === 'MessageValidationError') return { errorCode: 'invalid_message', retryable: false };
  if (error?.name === 'AbortError') return { errorCode: 'cleanup_cancelled', retryable: false };
  if (error?.name === 'OperationBudgetExceededError')
    return { errorCode: 'operation_budget_exhausted', retryable: true };
  if (error?.name === 'OperationTimeoutError') return { errorCode: 'browser_operation_unknown', retryable: false };
  return { errorCode: 'sitewipe_action_failed', retryable: false };
}

async function handleMessage(message, sender) {
  const envelope = validateMessageEnvelope(message, sender, chrome.runtime.id);
  await ensurePrivacyDefaults();
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
      const [settings, report, reports] = await Promise.all([getSettings(), getLastReport(), getReports()]);
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
      if (cleanInProgress)
        throw new Error(
          'A SiteWipe cleanup is already running. Wait for it to finish before reviewing another cleanup.'
        );
      const activeJob = await getActiveJob();
      if (isActiveRunningJob(activeJob))
        throw new Error(
          'A SiteWipe cleanup is already running. Wait for it to finish before reviewing another cleanup.'
        );
      if (cleanupReviewPreparationInProgress)
        throw new Error('Another cleanup review is being prepared. Wait for it to finish before trying again.');
      cleanupReviewPreparationInProgress = true;
      try {
        const prepared = await prepareCleanupReviewRequest(payload, {
          getSettings: getPermissionAwareSettings,
          isIncognitoAllowed,
          hasHostPermissions,
          containsHostPermissions: containsHostPermissionsStrict,
          inspectImpact: inspectCleanupImpact,
          releaseHostPermissions: releaseTemporaryHostPermissions,
          storageSession: chrome.storage.session,
          storageLocal: chrome.storage.local
        });
        await scheduleAlarmAt(ALARMS.reviewExpiry, prepared.review.expiresAt).catch(() => {});
        return prepared;
      } finally {
        cleanupReviewPreparationInProgress = false;
      }
    }
    case MESSAGE_TYPES.cancelCleanupReview: {
      const canceled = await cancelCleanupReviewRequest(payload, {
        storageSession: chrome.storage.session,
        hasHostPermissions,
        containsHostPermissions: containsHostPermissionsStrict,
        storageLocal: chrome.storage.local,
        releaseHostPermissions: releaseTemporaryHostPermissions
      });
      if (canceled.canceled) await clearAlarmSafe(ALARMS.reviewExpiry);
      return canceled;
    }
    case MESSAGE_TYPES.runDeepClean: {
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
      try {
        approval = await consumeCleanupReviewRequest(payload, {
          storageSession: chrome.storage.session,
          hasHostPermissions,
          containsHostPermissions: containsHostPermissionsStrict,
          storageLocal: chrome.storage.local,
          releaseHostPermissions: releaseTemporaryHostPermissions
        });
        await clearAlarmSafe(ALARMS.reviewExpiry);
        settings = getEffectiveCleanupSettings(approval.settings || {});
        const target = approval.target;
        const protectedTargets = findProtectedBrowserServiceTargets(target);
        if (protectedTargets.length) {
          throw new Error(
            `Cleanup is blocked for ${protectedTargets[0].targetHost} to protect browser Sync and browser-account state. SiteWipe never cleans browser-service targets.`
          );
        }
        const incognitoAccess = await isIncognitoAllowed();
        if (approval.sourceIncognito && !incognitoAccess) {
          throw new Error(
            'Private-window cleanup requires Allow in incognito to be enabled for SiteWipe in chrome://extensions or brave://extensions. Chrome/Brave keep this permission under user control.'
          );
        }
        const hostPermissionsGranted = await hasHostPermissions(target.hostPermissionOrigins);
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
          detail: 'Cleanup job created.'
        };
        await setActiveJob(job);
        await setActionBadgeForJob(job);
        await scheduleMaintenanceAlarms();
        await appendDebug({
          level: 'info',
          message: 'Deep Clean started',
          target: target.displayName || target.domain,
          jobId: job.id
        });
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
          shouldCancel: () => shouldCancelJob(job.id),
          onProgress: (progress) => updateJobProgress(job.id, target.displayName || target.domain, progress),
          onShieldPrepared: async (shield) => {
            await setActiveShield({ ...shield, jobId: job.id });
            await scheduleMaintenanceAlarms().catch(() => {});
          },
          onShieldInstalled: async (shield) => {
            await setActiveShield({ ...shield, jobId: job.id });
            await scheduleMaintenanceAlarms().catch(() => {});
          },
          onShieldUncertain: async (patch) => {
            await mutateActiveShield((currentShield) =>
              currentShield
                ? {
                    ...currentShield,
                    ...patch,
                    jobId: job.id
                  }
                : null
            );
            await scheduleMaintenanceAlarms().catch(() => {});
          },
          onShieldCleared: async () => {
            await clearActiveShieldRecord();
            await scheduleMaintenanceAlarms().catch(() => {});
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
        return { report: completion.responseReport, completionWarnings: completion.warnings };
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
            completionWarnings: [error?.message || String(error)]
          };
        }
        const canceled = error?.name === 'AbortError' || /canceled/i.test(error?.message || '');
        if (report && job) {
          const failureCompletion = await completeFailedCleanup({
            error,
            canceled,
            report,
            job,
            approval,
            hostPermissionsFinalized
          });
          hostPermissionsFinalized = failureCompletion.hostPermissionsFinalized;
        }
        throw error;
      } finally {
        if (approval && !hostPermissionsFinalized) {
          if (approval.permissionLeaseId) {
            await recoverTemporaryPermissionLease('cleanup-finally', approval.permissionLeaseId).catch(() => {});
          } else {
            await releaseTemporaryHostPermissions(getTemporaryReviewHostPermissionOrigins(approval)).catch(() => {});
          }
        }
        cleanInProgress = false;
      }
    }
    case MESSAGE_TYPES.getReport: {
      return { report: await getLastReport() };
    }
    case MESSAGE_TYPES.getHistory: {
      return { reports: await getReports() };
    }
    case MESSAGE_TYPES.clearHistory: {
      await clearReportHistory();
      return { reports: [] };
    }
    case MESSAGE_TYPES.getSettings: {
      return { settings: await getSettings(), debugLog: await getDebugLog() };
    }
    case MESSAGE_TYPES.saveSettings: {
      const permissionAwarePatch = { ...(payload.settings || {}) };
      if (permissionAwarePatch.embeddedFrameDiscovery === true && !(await hasNamedPermission('webNavigation'))) {
        permissionAwarePatch.embeddedFrameDiscovery = false;
      }
      const settings = await saveSettings(permissionAwarePatch);
      if (!settings.embeddedFrameDiscovery) await removeNamedPermission('webNavigation');
      await scheduleMaintenanceAlarms();
      return { settings };
    }
    case MESSAGE_TYPES.resetSettings: {
      const settings = await resetSettings();
      await removeNamedPermission('webNavigation');
      await scheduleMaintenanceAlarms();
      return { settings };
    }
    case MESSAGE_TYPES.clearDebugLog: {
      await clearDebugLog();
      return { debugLog: [] };
    }
    case MESSAGE_TYPES.openSidePanel: {
      await openSidePanel(sender);
      return {};
    }
    case MESSAGE_TYPES.clearActiveShield: {
      const result = await reconcileOwnedShieldState();
      await scheduleMaintenanceAlarms();
      const shield = await getActiveShield();
      return {
        cleared: Boolean(result.cleared),
        shield,
        result,
        shieldDiagnostics: result.diagnostics || (await getSiteWipeDnrDiagnostics(shield))
      };
    }
    case MESSAGE_TYPES.repairActiveShield: {
      const before = await getSiteWipeDnrDiagnostics(await getActiveShield());
      const result = await reconcileOwnedShieldState();
      await scheduleMaintenanceAlarms();
      const shield = await getActiveShield();
      const after = result.diagnostics || (await getSiteWipeDnrDiagnostics(shield));
      await appendDebug({
        level: result.cleared ? 'info' : 'error',
        message: result.cleared ? 'Shield state repaired' : 'Shield repair remains incomplete; recovery state retained',
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
    }
    case MESSAGE_TYPES.getShieldDiagnostics: {
      await expireActiveShieldIfNeeded();
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
      const activeJob = await getActiveJob();
      if (activeJob?.status === 'running' && isActiveRunningJob(activeJob)) {
        throw new Error(
          'A cleanup is still running. Request cancel first, or wait until the job is interrupted/stopped before clearing the local job record.'
        );
      }
      await clearActiveJob();
      await clearActionBadge();
      await scheduleMaintenanceAlarms();
      return { activeJob: null, cleared: Boolean(activeJob) };
    }
    case MESSAGE_TYPES.expireActiveShield: {
      const expired = await expireActiveShieldIfNeeded(true);
      await scheduleMaintenanceAlarms();
      return {
        expired,
        activeShield: await getActiveShield(),
        shieldDiagnostics: await getSiteWipeDnrDiagnostics(await getActiveShield())
      };
    }
    case MESSAGE_TYPES.forgetLatestReport: {
      const result = await forgetLatestReport();
      await scheduleMaintenanceAlarms();
      return { report: null, ...result };
    }
    case MESSAGE_TYPES.getActiveJob: {
      await expireActiveShieldIfNeeded();
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
      const result = await runMaintenanceCycle('manual');
      await scheduleMaintenanceAlarms();
      return {
        maintenance: result,
        maintenanceStatus: await getMaintenanceStatusSnapshot()
      };
    }
    case MESSAGE_TYPES.resetExtensionLocalState: {
      const result = await resetExtensionLocalState();
      return {
        reset: result,
        settings: await getSettings(),
        maintenanceStatus: await getMaintenanceStatusSnapshot()
      };
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
      approval.permissionLeaseId
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
  try {
    responseReport = finished.privateContextTouched
      ? settings.redactReports !== false
        ? await redactReport(finished, { profile: 'private-session-response' })
        : finished
      : await saveReport(finished);
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
      detail: 'Cleanup finished. The redacted report was saved temporarily.',
      updatedAt: new Date().toISOString()
    };
    await setActiveJob(completedJob).catch(() => {});
  }

  await setActionBadgeForJob(completedJob).catch(() => {});
  clearActionBadgeSoon();
  await scheduleMaintenanceAlarms().catch(() => {});
  await appendDebug({
    level: warnings.length ? 'error' : 'info',
    message: warnings.length ? 'Deep Clean completed with reporting warnings' : 'Deep Clean completed',
    target: target.displayName || target.domain,
    status: finished.status,
    hostAccessMode: finished.hostAccessMode,
    jobId: job.id,
    completionWarningCount: warnings.length
  }).catch(() => {});
  return { responseReport, warnings, hostPermissionsFinalized };
}

async function completeFailedCleanup({ error, canceled, report, job, approval, hostPermissionsFinalized }) {
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
        approval.permissionLeaseId
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
  clearActionBadgeSoon();

  report.privateContextTouched = Boolean(
    report.incognitoAccess || report.sourceIncognito || report.summary?.incognitoScopeObserved
  );
  await finishReportSafely(report, warnings);
  if (!report.privateContextTouched) {
    try {
      await saveReport(report);
    } catch (saveError) {
      recordCompletionWarning(report, 'Persist failed cleanup report', saveError, warnings);
      await finishReportSafely(report, warnings);
    }
  }
  await scheduleMaintenanceAlarms().catch(() => {});
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
    const settings = await getSettings();
    if (!settings.embeddedFrameDiscovery) await removeNamedPermission('webNavigation');
    let migration = {};
    let migrated = false;
    if (!settings.privacyDefaultsAppliedAt) {
      migration = await migrateStoredReportsToPrivacyDefaults();
      const now = new Date().toISOString();
      await saveSettings({
        redactReports: true,
        latestReportRetentionMinutes: 30,
        privacyDefaultsAppliedAt: now
      });
      migrated = true;
    }
    const reportExpired = await expireLatestReportIfNeeded();
    return { migrated, reportExpired, ...migration };
  })().catch((error) => {
    privacyMigrationPromise = null;
    throw error;
  });
  return privacyMigrationPromise;
}

async function handleMaintenanceAlarm(alarm) {
  const name = alarm?.name || ALARMS.maintenance;
  if (
    ![ALARMS.maintenance, ALARMS.shieldExpiry, ALARMS.reportExpiry, ALARMS.staleJob, ALARMS.reviewExpiry].includes(name)
  )
    return;
  const result = await runMaintenanceCycle(`alarm:${name}`, {
    forceShieldExpiry: name === ALARMS.shieldExpiry
  });
  await scheduleMaintenanceAlarms();
  if (result.shieldExpired || result.reportExpired || result.orphanShieldRepaired || result.staleJobRecovered) {
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
  const [shieldExpired, reportExpired] = await Promise.all([
    expireActiveShieldIfNeeded(forceShieldExpiry),
    expireLatestReportIfNeeded()
  ]);
  const staleJobRecovered = await recoverStaleJob(reason);
  const orphanShieldRepaired = await repairOrphanedShieldIfAllowed(reason);
  const cleanupReviewExpiration = await clearExpiredCleanupReview(chrome.storage.session, Date.now(), {
    hasHostPermissions,
    containsHostPermissions: containsHostPermissionsStrict,
    releaseHostPermissions: releaseTemporaryHostPermissions,
    storageLocal: chrome.storage.local
  });
  const permissionLeaseRecovery = await recoverTemporaryPermissionLease(`maintenance:${reason}`);
  const snapshot = {
    reason,
    at: new Date().toISOString(),
    shieldExpired: Boolean(shieldExpired),
    reportExpired: Boolean(reportExpired),
    staleJobRecovered: Boolean(staleJobRecovered),
    orphanShieldRepaired: Boolean(orphanShieldRepaired),
    cleanupReviewExpired: Boolean(cleanupReviewExpiration?.expired),
    temporaryHostAccessReleased: Boolean(permissionLeaseRecovery?.released),
    temporaryHostAccessRecoveryPending: Boolean(permissionLeaseRecovery?.recordRetained)
  };
  if (options.record !== false) await setLastMaintenance(snapshot).catch(() => {});
  return snapshot;
}

async function repairOrphanedShieldIfAllowed(reason, options = {}) {
  const settings = await getSettings();
  if (settings.autoRepairOrphanedShields === false && !options.force) return false;
  // A shield rule can exist for a few milliseconds before its matching local
  // record is saved. Never classify that normal install window as an orphan
  // while a live cleanup job is making progress.
  const activeJob = await getActiveJob();
  if (isActiveRunningJob(activeJob)) return false;
  const activeShield = await getActiveShield();
  const diagnostics = await getSiteWipeDnrDiagnostics(activeShield);
  const incompleteTrackedShield = Boolean(
    activeShield && (diagnostics.missingTrackedRuleIds?.length || diagnostics.orphanRuleIds?.length)
  );
  if (!incompleteTrackedShield && !diagnostics.orphanRuleIds?.length) return false;
  try {
    const reconciliation = await reconcileOwnedShieldState({ activeShield });
    await appendDebug({
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
    });
    return reconciliation.cleared;
  } catch (error) {
    await appendDebug({
      level: 'error',
      message: 'Failed to auto-repair orphan SiteWipe DNR shield rules',
      reason,
      stack: error?.stack
    });
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
  const shieldClear = await reconcileOwnedShieldState();
  const cleanupReview = await clearCleanupReviewState(chrome.storage.session, {
    hasHostPermissions,
    containsHostPermissions: containsHostPermissionsStrict,
    releaseHostPermissions: releaseTemporaryHostPermissions,
    storageLocal: chrome.storage.local
  });
  const permissionLeaseRecovery = await recoverTemporaryPermissionLease('local-state-reset');
  await clearAlarmSafe(ALARMS.reviewExpiry);
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
  await scheduleMaintenanceAlarms();
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

async function scheduleMaintenanceAlarms() {
  if (!chrome.alarms?.create) return;
  try {
    await chrome.alarms.create(ALARMS.maintenance, { periodInMinutes: 15 });
    const [shield, reportExpiresAt, job] = await Promise.all([
      getActiveShield(),
      getLatestReportExpiration(),
      getActiveJob()
    ]);
    await scheduleAlarmAt(ALARMS.shieldExpiry, shield?.expiresAt);
    await scheduleAlarmAt(ALARMS.reportExpiry, reportExpiresAt);
    const jobUpdated = Date.parse(job?.updatedAt || job?.startedAt || '');
    const jobExpires =
      job?.status === 'running' && Number.isFinite(jobUpdated)
        ? new Date(jobUpdated + ACTIVE_JOB_STALE_MS).toISOString()
        : null;
    await scheduleAlarmAt(ALARMS.staleJob, jobExpires);
  } catch (error) {
    await appendDebug({
      level: 'error',
      message: 'Failed to schedule maintenance alarms',
      stack: error?.stack
    });
  }
}

async function scheduleAlarmAt(name, isoTime) {
  if (!chrome.alarms?.clear || !chrome.alarms?.create) return;
  await chrome.alarms.clear(name);
  const when = Date.parse(isoTime || '');
  if (Number.isFinite(when) && when > Date.now()) {
    await chrome.alarms.create(name, { when });
  }
}

async function clearAlarmSafe(name) {
  try {
    await chrome.alarms?.clear?.(name);
  } catch {
    // Alarm cleanup is best-effort; session-record expiry remains authoritative.
  }
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

function clearActionBadgeSoon() {
  setTimeout(() => clearActionBadge(), 2500);
}

function isActiveRunningJob(job) {
  if (!job || job.status !== 'running') return false;
  const updated = Date.parse(job.updatedAt || job.startedAt || '');
  if (!Number.isFinite(updated)) return true;
  return Date.now() - updated < ACTIVE_JOB_STALE_MS;
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
  return Boolean(current && current.id === jobId && current.cancelRequested);
}

async function recoverStaleJob(reason, options = {}) {
  const job = await getActiveJob();
  if (!job || job.status !== 'running') return false;
  const updated = Date.parse(job.updatedAt || job.startedAt || '');
  const stale = !Number.isFinite(updated) || Date.now() - updated >= ACTIVE_JOB_STALE_MS;
  const forceRecovery = Boolean(options.force) || reason === 'startup' || reason === 'service-worker-load';
  if (!stale && !forceRecovery) return false;
  const shield = await getActiveShield();
  let shieldReconciled = true;
  if (shield?.mode !== 'post-wipe-session') {
    try {
      const reconciliation = await reconcileOwnedShieldState({ activeShield: shield });
      shieldReconciled = reconciliation.cleared;
      if (!reconciliation.cleared) {
        await appendDebug({
          level: 'error',
          message: 'Stale-job request-shield recovery remains incomplete; recovery state retained',
          activeRuleCount: reconciliation.diagnostics?.activeRuleIds?.length || 0,
          recoveryRecordRetained: reconciliation.recordRetained
        });
      }
    } catch (error) {
      shieldReconciled = false;
      await appendDebug({
        level: 'error',
        message: 'Failed to clear stale DNR shield',
        stack: error?.stack
      });
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
  await setActiveJob(interruptedJob);
  await setActionBadgeForJob(interruptedJob);
  clearActionBadgeSoon();
  return true;
}

async function expireActiveShieldIfNeeded(force = false) {
  const shield = await getActiveShield();
  if (!shield) return false;
  const expiresAt = Date.parse(shield.expiresAt || '');
  if (!force && (!Number.isFinite(expiresAt) || Date.now() < expiresAt)) return false;
  try {
    const reconciliation = await reconcileOwnedShieldState({ activeShield: shield });
    if (!reconciliation.cleared) {
      await appendDebug({
        level: 'error',
        message: 'Expired active shield could not be proven cleared; recovery state retained',
        target: shield.domain || shield.displayName || '',
        activeRuleCount: reconciliation.diagnostics?.activeRuleIds?.length || 0,
        recoveryRecordRetained: reconciliation.recordRetained
      });
      return false;
    }
    await appendDebug({
      level: 'info',
      message: force ? 'Active shield cleared by request' : 'Active shield expired and was cleared',
      target: shield.domain || shield.displayName || ''
    });
    return true;
  } catch (error) {
    await appendDebug({
      level: 'error',
      message: 'Failed to clear expired active shield',
      stack: error?.stack
    });
    return false;
  }
}

async function hasHostPermissions(origins) {
  try {
    return Boolean(await chrome.permissions.contains({ origins }));
  } catch {
    return false;
  }
}

async function containsHostPermissionsStrict(origins) {
  if (!chrome.permissions?.contains) throw new Error('Host-permission inspection is unavailable.');
  return Boolean(await chrome.permissions.contains({ origins }));
}

async function hasNamedPermission(permission) {
  try {
    return Boolean(await chrome.permissions.contains({ permissions: [permission] }));
  } catch {
    return false;
  }
}

async function removeNamedPermission(permission) {
  try {
    if (!chrome.permissions?.remove) return false;
    return Boolean(await chrome.permissions.remove({ permissions: [permission] }));
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

async function finalizeRunHostPermissions(origins, report, preexistingOrigins = [], permissionLeaseId = null) {
  const requestedOrigins = [...new Set((origins || []).map(String).filter(Boolean))];
  const preservedOriginSet = new Set((preexistingOrigins || []).map(String).filter(Boolean));
  const preservedOrigins = requestedOrigins.filter((origin) => preservedOriginSet.has(origin));
  const temporaryOrigins = requestedOrigins.filter((origin) => !preservedOriginSet.has(origin));
  const releaseAfterRun = temporaryOrigins.length > 0;
  try {
    const targetOriginsGrantedBeforeRelease = await getGrantedHostPermissionOrigins(
      requestedOrigins,
      hasHostPermissions
    );
    const targetAllowedBeforeRelease =
      requestedOrigins.length > 0 && targetOriginsGrantedBeforeRelease.length === requestedOrigins.length;
    const temporaryOriginsGrantedBeforeRelease = releaseAfterRun
      ? await getGrantedHostPermissionOrigins(temporaryOrigins, hasHostPermissions)
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
    const temporaryOriginsGrantedAfterRelease = releaseAfterRun
      ? await getGrantedHostPermissionOrigins(temporaryOrigins, hasHostPermissions)
      : [];
    const targetOriginsGrantedAfterRelease = await getGrantedHostPermissionOrigins(
      requestedOrigins,
      hasHostPermissions
    );
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
    report.hostAccessMode = mixedAccess
      ? 'mixed_preserved_and_temporary_preflight_bound_origins'
      : releaseAfterRun
        ? 'temporary_preflight_bound_origins'
        : 'preexisting_preflight_bound_origins';
    report.summary.targetSiteAccessGranted = Boolean(targetAllowedBeforeRelease);
    report.summary.allSitesAccessGranted = false;
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
        temporaryAccessRemains,
        released,
        permissionLeaseId: permissionLeaseId || null,
        permissionLeaseRecovery,
        releaseAfterRun,
        note: releaseFailed
          ? 'Chrome still reports access to one or more preflight-bound target patterns. Review extension site-access settings if you want to revoke it manually.'
          : releaseAfterRun
            ? 'Only target-specific host access absent before this review was released after browser cleanup and verification finished; any pre-existing target patterns were preserved.'
            : 'Site access already existed before the review, so SiteWipe preserved that user-controlled permission.'
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
    report.hostPermissionsGranted = false;
    report.hostPermissionsReleased = false;
    report.hostAccessMode =
      preservedOrigins.length && temporaryOrigins.length
        ? 'mixed_preserved_and_temporary_preflight_bound_origins'
        : releaseAfterRun
          ? 'temporary_preflight_bound_origins'
          : 'preexisting_preflight_bound_origins';
    report.summary.targetSiteAccessGranted = false;
    report.summary.allSitesAccessGranted = false;
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
      granted: false,
      released: false,
      releaseFailed: Boolean(releaseAfterRun)
    };
  }
}

async function recoverTemporaryPermissionLease(reason, expectedLeaseId = null) {
  const recovery = permissionLeaseRecoveryPromise
    .catch(() => {})
    .then(async () => {
      const lease = await getPermissionLease(chrome.storage.local);
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
        const activeJob = await getActiveJob();
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

      if (!expectedLeaseId && isPreparedPermissionLeaseLive(lease)) {
        return {
          reason,
          found: true,
          released: false,
          accessRemains: null,
          recordRetained: true,
          deferred: true,
          deferReason: 'prepared_review_window',
          leaseId: lease.id,
          reviewExpiresAt: lease.reviewExpiresAt
        };
      }

      const result = await reconcilePermissionLease(
        chrome.storage.local,
        {
          containsHostPermissions: containsHostPermissionsStrict,
          releaseHostPermissions: releaseTemporaryHostPermissions
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
  return Boolean(await chrome.permissions.remove({ origins }));
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
      title: tab.title || '',
      url: activeUrl,
      favIconUrl: tab.favIconUrl || '',
      incognito: Boolean(tab.incognito)
    },
    normalized
  };
}

async function isIncognitoAllowed() {
  try {
    const result = chrome.extension?.isAllowedIncognitoAccess?.();
    if (result && typeof result.then === 'function') return Boolean(await result);
    return await new Promise((resolve) =>
      chrome.extension.isAllowedIncognitoAccess((allowed) => resolve(Boolean(allowed)))
    );
  } catch {
    return false;
  }
}

async function openSidePanel(sender) {
  if (!chrome.sidePanel?.open) return;
  const windowId = sender?.tab?.windowId || (await chrome.windows?.getCurrent?.())?.id;
  if (windowId) {
    await chrome.sidePanel.open({ windowId });
  }
}

async function removeLegacyContentSettingPreference() {
  const data = await chrome.storage.local.get([STORAGE_KEYS.settings]);
  const stored = data[STORAGE_KEYS.settings];
  if (!stored || typeof stored !== 'object' || !Object.prototype.hasOwnProperty.call(stored, 'contentSettingReset'))
    return;
  const { contentSettingReset: _legacy, ...next } = stored;
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
}

async function repairSiteWipeRuntime(reason, options = {}) {
  const staleJobRecovered = await recoverStaleJob(reason, {
    force: Boolean(options.forceRecoverRunningJob)
  });
  const shieldExpired = await expireActiveShieldIfNeeded();
  let partialShieldCleared = false;
  let repairError = null;
  try {
    const activeShield = await getActiveShield();
    const diagnostics = await getSiteWipeDnrDiagnostics(activeShield);
    if (activeShield && (diagnostics.missingTrackedRuleIds?.length || diagnostics.orphanRuleIds?.length)) {
      const reconciliation = await reconcileOwnedShieldState({ activeShield });
      partialShieldCleared = reconciliation.cleared;
      if (!reconciliation.cleared) {
        throw new Error(
          'Chrome did not prove the SiteWipe-owned request-shield range empty; recovery state was retained.'
        );
      }
      await appendDebug({
        level: 'info',
        message: 'Cleared incomplete SiteWipe request shield before a new cleanup',
        reason,
        missingRuleCount: diagnostics.missingTrackedRuleIds?.length || 0,
        orphanRuleCount: diagnostics.orphanRuleIds?.length || 0
      });
    }
  } catch (error) {
    repairError = error?.message || String(error);
    await appendDebug({
      level: 'error',
      message: 'SiteWipe pre-cleanup repair could not clear incomplete shield state',
      reason,
      stack: error?.stack
    }).catch(() => {});
  }
  const orphanShieldRepaired = await repairOrphanedShieldIfAllowed(reason, {
    force: true
  });
  return {
    reason,
    staleJobRecovered,
    shieldExpired,
    partialShieldCleared,
    orphanShieldRepaired,
    repaired: Boolean(staleJobRecovered || shieldExpired || partialShieldCleared || orphanShieldRepaired),
    repairError
  };
}

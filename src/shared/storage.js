import { APP, DEFAULT_SETTINGS, STORAGE_KEYS } from './constants.js';
import { redactReport, redactSensitiveValue } from './report-redaction.js';
import { refreshReportIntegrity } from './report-integrity.js';
import {
  assertCleanupJobTransition,
  isStoredReport,
  normalizeActiveShield,
  normalizeCleanupJob,
  normalizeMaintenanceSnapshot
} from './state-schema.js';

const storageMutationQueues = new Map();
const REPORT_STATE_MUTATION = 'sitewipe.report-state';

export async function withStorageMutation(key, operation) {
  const queueKey = String(key);
  const previous = storageMutationQueues.get(queueKey) || Promise.resolve();
  const scheduled = previous.catch(() => {}).then(operation);
  storageMutationQueues.set(queueKey, scheduled);
  try {
    return await scheduled;
  } finally {
    if (storageMutationQueues.get(queueKey) === scheduled) storageMutationQueues.delete(queueKey);
  }
}

export async function getFromArea(area, keys) {
  return chrome.storage[area].get(keys);
}

export async function setInArea(area, value) {
  await chrome.storage[area].set(value);
}

export async function getSettings(options = {}) {
  const storageLocal = options.storageLocal || chrome.storage.local;
  const data = await storageLocal.get([STORAGE_KEYS.settings]);
  return normalizeStoredSettings(data[STORAGE_KEYS.settings]);
}

export async function saveSettings(patch, options = {}) {
  const storageLocal = options.storageLocal || chrome.storage.local;
  return withStorageMutation(STORAGE_KEYS.settings, async () => {
    const data = await storageLocal.get([STORAGE_KEYS.settings]);
    const current = normalizeStoredSettings(data[STORAGE_KEYS.settings]);
    const cleanPatch = sanitizeSettingsPatch(patch);
    const next = {
      ...current,
      ...cleanPatch,
      updatedAt: new Date().toISOString()
    };
    await storageLocal.set({ [STORAGE_KEYS.settings]: next });
    return next;
  });
}

export function sanitizeSettingsPatch(patch) {
  const input = patch && typeof patch === 'object' ? patch : {};
  const booleanKeys = [
    'skipCleanupReview',
    'keepHistory',
    'reducedMotion',
    'highContrast',
    'debugLog',
    'aggressiveCookieSweep',
    'includeProtectedWebOrigins',
    'pageScriptScrub',
    'mainWorldPageScrub',
    'storageBucketScrub',
    'embeddedFrameDiscovery',
    'probePartitionedCookiesWithEmbeddingSites',
    'exhaustiveCookieStoreScan',
    'downloadRecentFallback',
    'deleteDownloadedFiles',
    'temporaryDnrShield',
    'progressOverlay',
    'progressOverlayCancelButton',
    'postWipeSessionBlock',
    'autoRepairOrphanedShields',
    'resetZoom',
    'resetMutedTabs',
    'unpinTargetTabs',
    'opfsScrub',
    'serviceWorkerExtraScrub',
    'appBadgeClear',
    'permissionAudit',
    'redactReports',
    'verificationPass',
    'allowLocalTargets',
    'blockOnAssociatedGroupErrors',
    'broadDiscoveryFallback'
  ];
  const output = {};
  for (const key of booleanKeys) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    if (key === 'skipCleanupReview') {
      // This high-impact opt-in must never be activated by truthy strings or
      // other legacy/imported values. Options and backup validation emit a
      // real boolean after their explicit warning flows.
      if (typeof input[key] === 'boolean') output[key] = input[key];
      continue;
    }
    const coerced = sanitizeBoolean(input[key]);
    if (coerced !== undefined) output[key] = coerced;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'overlayScope')) {
    const scope = String(input.overlayScope || 'target_tabs');
    output.overlayScope = ['all_tabs', 'current_window', 'target_tabs'].includes(scope) ? scope : 'target_tabs';
  }
  if (Object.prototype.hasOwnProperty.call(input, 'cleanupMode')) {
    output.cleanupMode = input.cleanupMode === 'expert' ? 'expert' : 'standard';
  }
  if (Object.prototype.hasOwnProperty.call(input, 'associatedDomainGroups')) {
    output.associatedDomainGroups = sanitizeAssociatedDomainGroups(input.associatedDomainGroups);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'reportRetentionDays')) {
    output.reportRetentionDays = sanitizeReportRetentionDays(input.reportRetentionDays);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'latestReportRetentionMinutes')) {
    output.latestReportRetentionMinutes = sanitizeLatestReportRetentionMinutes(input.latestReportRetentionMinutes);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'postWipeShieldExpiresMinutes')) {
    output.postWipeShieldExpiresMinutes = sanitizePostWipeShieldExpiresMinutes(input.postWipeShieldExpiresMinutes);
  }
  for (const key of ['stabilityDefaultsAppliedAt', 'performanceDefaultsAppliedAt', 'privacyDefaultsAppliedAt']) {
    const timestamp = sanitizeTimestamp(input[key], true);
    if (timestamp !== undefined) output[key] = timestamp;
  }
  return output;
}

export function normalizeStoredSettings(value, now = new Date().toISOString()) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const sanitized = sanitizeSettingsPatch(input);
  return {
    ...DEFAULT_SETTINGS,
    ...sanitized,
    createdAt: sanitizeTimestamp(input.createdAt) || now,
    updatedAt: sanitizeTimestamp(input.updatedAt) || sanitizeTimestamp(input.createdAt) || now
  };
}

function sanitizeBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return undefined;
}

function sanitizeTimestamp(value, allowNull = false) {
  if (value === null && allowNull) return null;
  if (typeof value !== 'string') return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function sanitizeAssociatedDomainGroups(value) {
  const text = String(value || '').replace(/\r\n?/g, '\n');
  return text
    .split('\n')
    .slice(0, 50)
    .map((line) => line.slice(0, 500))
    .join('\n')
    .trim();
}

function sanitizeReportRetentionDays(value) {
  const numeric = Number(value);
  const allowed = [0, 1, 7, 30, 90];
  return allowed.includes(numeric) ? numeric : 7;
}

function sanitizeLatestReportRetentionMinutes(value) {
  const numeric = Number(value);
  const allowed = [0, 15, 30, 60, 240, 1440];
  return allowed.includes(numeric) ? numeric : 30;
}

function sanitizePostWipeShieldExpiresMinutes(value) {
  const numeric = Number(value);
  const allowed = [0, 15, 60, 240, 1440];
  return allowed.includes(numeric) ? numeric : 0;
}

function activeReportExpired(report, minutes, now = Date.now()) {
  const retentionMinutes = sanitizeLatestReportRetentionMinutes(minutes);
  if (!retentionMinutes) return false;
  const timestamp = Date.parse(report?.finishedAt || report?.startedAt || '');
  if (!Number.isFinite(timestamp)) return true;
  return Number(now) - timestamp > retentionMinutes * 60 * 1000;
}

export async function resetSettings() {
  return withStorageMutation(STORAGE_KEYS.settings, async () => {
    const now = new Date().toISOString();
    const next = { ...DEFAULT_SETTINGS, createdAt: now, updatedAt: now };
    await setInArea('local', { [STORAGE_KEYS.settings]: next });
    return next;
  });
}

export async function getReports() {
  return withStorageMutation(REPORT_STATE_MUTATION, async () => {
    const data = await getFromArea('local', [STORAGE_KEYS.reports, STORAGE_KEYS.settings]);
    const rawReports = Array.isArray(data[STORAGE_KEYS.reports]) ? data[STORAGE_KEYS.reports] : [];
    const reports = rawReports.filter(isStoredReport);
    const settings = normalizeStoredSettings(data[STORAGE_KEYS.settings]);
    const pruned = pruneReportsByRetention(reports, settings.reportRetentionDays);
    if (pruned.length !== rawReports.length) {
      await setInArea('local', { [STORAGE_KEYS.reports]: pruned });
    }
    return pruned;
  });
}

export async function getLastReport(now = Date.now()) {
  return withStorageMutation(REPORT_STATE_MUTATION, async () => {
    const data = await getFromArea('local', [STORAGE_KEYS.activeReport, STORAGE_KEYS.reports, STORAGE_KEYS.settings]);
    const settings = normalizeStoredSettings(data[STORAGE_KEYS.settings]);
    const rawActive = data[STORAGE_KEYS.activeReport];
    const active = isStoredReport(rawActive) ? rawActive : null;
    if (active && !activeReportExpired(active, settings.latestReportRetentionMinutes, now)) return active;

    const rawReports = Array.isArray(data[STORAGE_KEYS.reports]) ? data[STORAGE_KEYS.reports] : [];
    const reports = pruneReportsByRetention(rawReports.filter(isStoredReport), settings.reportRetentionDays, now);
    const update = {};
    if (rawActive) update[STORAGE_KEYS.activeReport] = null;
    if (reports.length !== rawReports.length) update[STORAGE_KEYS.reports] = reports;
    if (Object.keys(update).length) await setInArea('local', update);
    return reports[0] || null;
  });
}

export async function expireLatestReportIfNeeded(now = Date.now()) {
  return withStorageMutation(REPORT_STATE_MUTATION, async () => {
    const data = await getFromArea('local', [STORAGE_KEYS.activeReport, STORAGE_KEYS.settings]);
    const settings = normalizeStoredSettings(data[STORAGE_KEYS.settings]);
    const active = data[STORAGE_KEYS.activeReport];
    if (active && activeReportExpired(active, settings.latestReportRetentionMinutes, now)) {
      await setInArea('local', { [STORAGE_KEYS.activeReport]: null });
      return true;
    }
    return false;
  });
}

export async function getLatestReportExpiration() {
  const data = await getFromArea('local', [STORAGE_KEYS.activeReport, STORAGE_KEYS.settings]);
  const settings = normalizeStoredSettings(data[STORAGE_KEYS.settings]);
  const retentionMinutes = sanitizeLatestReportRetentionMinutes(settings.latestReportRetentionMinutes);
  const active = data[STORAGE_KEYS.activeReport];
  if (!active || !retentionMinutes) return null;
  const timestamp = Date.parse(active?.finishedAt || active?.startedAt || '');
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp + retentionMinutes * 60 * 1000).toISOString();
}

export async function saveReport(report, approvedSettings = null) {
  if (!isStoredReport(report)) throw new Error('Refusing to persist an invalid cleanup report.');
  if (
    report.privateContextTouched ||
    report.incognitoAccess ||
    report.sourceIncognito ||
    report.summary?.incognitoScopeObserved
  ) {
    throw new Error('Refusing to persist a cleanup report that may include private-window scope.');
  }
  return withStorageMutation(REPORT_STATE_MUTATION, async () => {
    const data = await getFromArea('local', [STORAGE_KEYS.settings, STORAGE_KEYS.reports]);
    const settings = approvedSettings
      ? normalizeStoredSettings(approvedSettings, report.finishedAt || report.startedAt)
      : normalizeStoredSettings(data[STORAGE_KEYS.settings]);
    const storedReport = settings.redactReports
      ? await redactReport(report, { profile: 'storage' })
      : JSON.parse(JSON.stringify(report));
    if (!settings.redactReports) await refreshReportIntegrity(storedReport);
    if (!isStoredReport(storedReport)) throw new Error('Refusing to persist an invalid transformed cleanup report.');
    const list = Array.isArray(data[STORAGE_KEYS.reports]) ? data[STORAGE_KEYS.reports].filter(isStoredReport) : [];
    const retained = pruneReportsByRetention(list, settings.reportRetentionDays);
    const next = settings.keepHistory
      ? [storedReport, ...retained.filter((item) => item.id !== storedReport.id)].slice(0, APP.maxReports)
      : [];
    await setInArea('local', {
      [STORAGE_KEYS.activeReport]: storedReport,
      [STORAGE_KEYS.reports]: next
    });
    return storedReport;
  });
}

function pruneReportsByRetention(reports, days, now = Date.now()) {
  const retentionDays = sanitizeReportRetentionDays(days);
  if (!retentionDays) return reports;
  const cutoff = Number(now) - retentionDays * 24 * 60 * 60 * 1000;
  return reports.filter((report) => {
    const timestamp = Date.parse(report?.finishedAt || report?.startedAt || '');
    return Number.isFinite(timestamp) && timestamp >= cutoff;
  });
}

export async function clearReports() {
  await withStorageMutation(REPORT_STATE_MUTATION, () =>
    setInArea('local', {
      [STORAGE_KEYS.reports]: [],
      [STORAGE_KEYS.activeReport]: null
    })
  );
}

export async function clearReportHistory() {
  await withStorageMutation(REPORT_STATE_MUTATION, () =>
    setInArea('local', {
      [STORAGE_KEYS.reports]: []
    })
  );
}

export async function appendDebug(entry) {
  const settings = await getSettings();
  if (!settings.debugLog) return;
  const safeEntry = redactSensitiveValue({
    at: new Date().toISOString(),
    ...entry
  });
  await withStorageMutation(STORAGE_KEYS.debugLog, async () => {
    const data = await getFromArea('local', [STORAGE_KEYS.debugLog]);
    const current = Array.isArray(data[STORAGE_KEYS.debugLog]) ? data[STORAGE_KEYS.debugLog] : [];
    const next = [safeEntry, ...current.map((item) => redactSensitiveValue(item))].slice(0, 100);
    await setInArea('local', { [STORAGE_KEYS.debugLog]: next });
  });
}

export async function migrateStoredReportsToPrivacyDefaults(now = Date.now(), options = {}) {
  const storageLocal = options.storageLocal || chrome.storage.local;
  return withStorageMutation(REPORT_STATE_MUTATION, async () =>
    withStorageMutation(STORAGE_KEYS.debugLog, async () => {
      const data = await storageLocal.get([
        STORAGE_KEYS.activeReport,
        STORAGE_KEYS.reports,
        STORAGE_KEYS.debugLog,
        STORAGE_KEYS.settings
      ]);
      const settings = normalizeStoredSettings(data[STORAGE_KEYS.settings]);
      const active = isStoredReport(data[STORAGE_KEYS.activeReport]) ? data[STORAGE_KEYS.activeReport] : null;
      const reports = pruneReportsByRetention(
        Array.isArray(data[STORAGE_KEYS.reports]) ? data[STORAGE_KEYS.reports].filter(isStoredReport) : [],
        settings.reportRetentionDays,
        now
      );
      const debugLog = Array.isArray(data[STORAGE_KEYS.debugLog]) ? data[STORAGE_KEYS.debugLog] : [];
      const retainedActive =
        active && !activeReportExpired(active, settings.latestReportRetentionMinutes, now) ? active : null;
      const redactedActive = retainedActive
        ? await redactReport(retainedActive, { profile: 'privacy-migration' })
        : null;
      const redactedReports = await Promise.all(
        reports.map((report) => redactReport(report, { profile: 'privacy-migration' }))
      );
      await storageLocal.set({
        [STORAGE_KEYS.activeReport]: redactedActive,
        [STORAGE_KEYS.reports]: redactedReports,
        [STORAGE_KEYS.debugLog]: debugLog.map((entry) => redactSensitiveValue(entry))
      });
      return {
        activeReportMigrated: Boolean(active),
        historyReportsMigrated: redactedReports.length,
        debugEntriesMigrated: debugLog.length
      };
    })
  );
}

export async function getDebugLog() {
  const data = await getFromArea('local', [STORAGE_KEYS.debugLog]);
  return Array.isArray(data[STORAGE_KEYS.debugLog]) ? data[STORAGE_KEYS.debugLog] : [];
}

export async function clearDebugLog() {
  await withStorageMutation(STORAGE_KEYS.debugLog, () => setInArea('local', { [STORAGE_KEYS.debugLog]: [] }));
}

export async function getActiveJob() {
  const data = await getFromArea('local', [STORAGE_KEYS.activeJob]);
  return normalizeCleanupJob(data[STORAGE_KEYS.activeJob]);
}

export async function setActiveJob(job) {
  return mutateActiveJob(() => job);
}

export async function mutateActiveJob(mutator, options = {}) {
  const storageLocal = options.storageLocal || chrome.storage.local;
  return withStorageMutation(STORAGE_KEYS.activeJob, async () => {
    const data = await storageLocal.get([STORAGE_KEYS.activeJob]);
    const current = normalizeCleanupJob(data[STORAGE_KEYS.activeJob]);
    const candidate = await mutator(current);
    if (candidate === undefined) return current;
    const monotonicCandidate =
      current?.cancelRequested === true && candidate && current.id === candidate.id
        ? {
            ...candidate,
            cancelRequested: true
          }
        : candidate;
    const normalized = assertCleanupJobTransition(current, monotonicCandidate);
    const safeJob = redactSensitiveValue(normalized);
    // Reads may be wrapped with the bounded startup adapter. Writes remain
    // untimed while the lifecycle reservation is held so an acknowledged-but-
    // unresolved persistence operation cannot be mistaken for a safe failure.
    await storageLocal.set({ [STORAGE_KEYS.activeJob]: safeJob });
    return safeJob;
  });
}

export async function clearActiveJob() {
  await withStorageMutation(STORAGE_KEYS.activeJob, () => setInArea('local', { [STORAGE_KEYS.activeJob]: null }));
}

export async function getActiveShield() {
  const data = await getFromArea('local', [STORAGE_KEYS.activeShield]);
  return normalizeActiveShield(data[STORAGE_KEYS.activeShield]);
}

export async function setActiveShield(shield, options = {}) {
  return mutateActiveShield(() => shield, options);
}

export async function mutateActiveShield(mutator, options = {}) {
  const storageLocal = options.storageLocal || chrome.storage.local;
  return withStorageMutation(STORAGE_KEYS.activeShield, async () => {
    const data = await storageLocal.get([STORAGE_KEYS.activeShield]);
    const current = normalizeActiveShield(data[STORAGE_KEYS.activeShield]);
    const candidate = await mutator(current);
    if (candidate === undefined) return current;
    if (candidate === null) {
      await storageLocal.set({ [STORAGE_KEYS.activeShield]: null });
      return null;
    }
    const normalized = normalizeActiveShield(candidate);
    if (!normalized) throw new Error('Refusing to persist invalid request-shield state.');
    const safeShield = redactSensitiveValue(normalized);
    await storageLocal.set({ [STORAGE_KEYS.activeShield]: safeShield });
    return safeShield;
  });
}

export async function clearActiveShieldRecord(options = {}) {
  await mutateActiveShield(() => null, options);
}

export async function forgetLatestReport(expectedReportId) {
  return withStorageMutation(REPORT_STATE_MUTATION, async () => {
    const data = await getFromArea('local', [STORAGE_KEYS.activeReport, STORAGE_KEYS.reports]);
    const active = isStoredReport(data[STORAGE_KEYS.activeReport]) ? data[STORAGE_KEYS.activeReport] : null;
    const reports = Array.isArray(data[STORAGE_KEYS.reports]) ? data[STORAGE_KEYS.reports].filter(isStoredReport) : [];
    const reportId = active?.id || reports[0]?.id || null;
    if (!reportId || reportId !== expectedReportId) {
      throw new Error('The displayed report is no longer the latest stored report. No report was removed.');
    }
    const retainedReports = reportId ? reports.filter((report) => report.id !== reportId) : reports;
    await setInArea('local', {
      [STORAGE_KEYS.activeReport]: null,
      [STORAGE_KEYS.reports]: retainedReports
    });
    return { forgottenReportId: reportId, remainingHistoryCount: retainedReports.length };
  });
}

export async function getLastMaintenance() {
  const data = await getFromArea('local', [STORAGE_KEYS.lastMaintenance]);
  return normalizeMaintenanceSnapshot(data[STORAGE_KEYS.lastMaintenance]);
}

export async function setLastMaintenance(snapshot) {
  const normalized = normalizeMaintenanceSnapshot(snapshot);
  if (!normalized) throw new Error('Refusing to persist invalid maintenance state.');
  const safeSnapshot = redactSensitiveValue(normalized);
  return withStorageMutation(STORAGE_KEYS.lastMaintenance, async () => {
    await setInArea('local', { [STORAGE_KEYS.lastMaintenance]: safeSnapshot });
    return safeSnapshot;
  });
}

export async function clearLastMaintenance() {
  await withStorageMutation(STORAGE_KEYS.lastMaintenance, () =>
    setInArea('local', { [STORAGE_KEYS.lastMaintenance]: null })
  );
}

import { APP } from '../shared/constants.js';
import { refreshReportIntegrity } from '../shared/report-integrity.js';

export function createReport(target, _input) {
  const now = new Date().toISOString();
  const canonicalInput = target?.matchMode === 'exact_origin' ? target.exactOrigin : target?.domain;
  return {
    id: `sitewipe-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    appVersion: APP.version,
    input: canonicalInput || '[unavailable]',
    submittedInputRetained: false,
    targetDomain: target.domain,
    startedAt: now,
    finishedAt: null,
    incognitoAccess: false,
    hostPermissionsGranted: false,
    hostPermissionsReleased: false,
    hostAccessMode: 'preflight_bound_target_origins',
    status: 'running',
    phaseTimings: {},
    redacted: false,
    summary: {
      cleanupMode: 'standard',
      normalTabsClosed: 0,
      incognitoTabsClosed: 0,
      incognitoScopeObserved: false,
      targetTabsAudited: 0,
      siteZoomStatesRead: 0,
      siteZoomStatesReset: 0,
      mutedTargetTabs: 0,
      mutedTargetTabsReset: 0,
      pinnedTargetTabs: 0,
      pinnedTargetTabsReset: 0,
      groupedTargetTabs: 0,
      discardedTargetTabs: 0,
      frozenTargetTabs: 0,
      targetTabsWithOpener: 0,
      targetTabsInSplitView: 0,
      targetTabsWithFavicon: 0,
      matchingFramesDiscovered: 0,
      pageScriptTabsAttempted: 0,
      pageScriptFramesMatched: 0,
      pageScriptLocalStorageCleared: 0,
      pageScriptSessionStorageCleared: 0,
      pageScriptIndexedDBDeleted: 0,
      pageScriptCachesDeleted: 0,
      pageScriptServiceWorkersUnregistered: 0,
      pageScriptPushSubscriptionsUnsubscribed: 0,
      pageScriptBackgroundSyncTagsObserved: 0,
      pageScriptBackgroundSyncTagsUnregistered: 0,
      pageScriptPeriodicSyncTagsUnregistered: 0,
      pageScriptStorageBucketsDeleted: 0,
      pageScriptOPFSEntriesDeleted: 0,
      pageScriptOPFSFilesDeleted: 0,
      pageScriptOPFSDirectoriesDeleted: 0,
      pageScriptAppBadgeCleared: 0,
      pageScriptPersistentStorageBefore: null,
      pageScriptStorageEstimateBeforeUsage: null,
      pageScriptStorageEstimateAfterUsage: null,
      pageScriptCookiesExpired: 0,
      pageScriptWorldsAttempted: '',
      cookiesRemoved: 0,
      partitionedCookiesAttempted: 0,
      partitionedCookiesRemoved: 0,
      partitionTopLevelSitesProbed: 0,
      browserCookieSweepAttempted: false,
      browserCookieSweepBatches: 0,
      browserCookieSweepSucceeded: false,
      storageCleanupAttempted: false,
      cacheCleanupAttempted: false,
      serviceWorkersCleared: false,
      protectedWebCleanupAttempted: false,
      originStorageTypesSucceeded: 0,
      originStorageTypesFailed: 0,
      historyEntriesRemoved: 0,
      downloadHistoryEntriesRemoved: 0,
      downloadedFilesRemoved: 0,
      downloadedFileRemovalFailures: 0,
      sitePermissionSettingsPreserved: true,
      temporaryDnrShieldInstalled: false,
      temporaryDnrShieldRemoved: false,
      postWipeSessionBlockKept: false,
      progressOverlayEnabled: false,
      progressOverlayUpdates: 0,
      progressOverlayTabsShown: 0,
      progressOverlayTabsHidden: 0,
      progressOverlayInjectionErrors: 0,
      activeJobPersistent: false,
      staleJobRecovered: false,
      extensionStatePreflightRan: false,
      extensionStateRepaired: false,
      protectedBrowserDataGuardActive: true,
      verificationPassEnabled: false,
      verificationCookiesRemaining: null,
      verificationTabsRemaining: null,
      verificationHistoryRemaining: null,
      verificationDownloadsRemaining: null,
      verificationAllRequiredChecksSucceeded: false,
      verificationNoExposedResidueFound: false,
      verificationCategories: {},
      cancelRequested: false,
      discoveredOrigins: 0,
      discoveredCookieHosts: 0,
      hostPermissionsReleased: false,
      hostAccessMode: 'Preflight-bound target access',
      targetSiteAccessGranted: false,
      allSitesAccessGranted: false,
      associatedTargetsIncluded: 0,
      skippedForSafety: 0,
      unavailable: 0,
      errors: 0,
      browserOperationEventCount: 0,
      totalBrowserVisibleChanges: null,
      verificationRemainingTotal: null,
      verificationStatus: 'not_attempted',
      cleanupConfidenceScore: null,
      cleanupConfidenceLabel: 'not evaluated',
      cleanupConfidenceReasons: [],
      totalDurationMs: 0,
      slowestPhase: 'N/A'
    },
    sections: [],
    errors: [],
    skipped: [],
    unavailable: [],
    integrity: null
  };
}

export function addSection(report, key, label, status, details = {}) {
  const section = {
    key,
    label,
    status,
    details: compactDetails(details),
    at: new Date().toISOString()
  };
  report.sections.push(section);
  return section;
}

export function createAdapterOutcome({
  attempted = 0,
  succeeded = 0,
  failed = 0,
  timedOut = 0,
  unknown = 0,
  skipped = 0,
  capped = false
} = {}) {
  const counts = {
    attempted: nonNegativeCount(attempted),
    succeeded: nonNegativeCount(succeeded),
    failed: nonNegativeCount(failed),
    timedOut: nonNegativeCount(timedOut),
    unknown: nonNegativeCount(unknown),
    skipped: nonNegativeCount(skipped)
  };
  const incomplete = Boolean(counts.failed || counts.timedOut || counts.unknown || capped);
  const status = incomplete
    ? counts.succeeded
      ? 'partial'
      : 'unknown'
    : !counts.attempted && counts.skipped
      ? 'skipped'
      : 'complete';
  return {
    schemaVersion: 1,
    status,
    complete: !incomplete,
    capped: Boolean(capped),
    ...counts
  };
}

const DETAIL_ARRAY_LIMIT = 60;
const DETAIL_STRING_LIMIT = 1600;
const DETAIL_DEPTH_LIMIT = 4;

function compactDetails(value, depth = 0) {
  if (depth > DETAIL_DEPTH_LIMIT) return '[truncated-depth]';
  if (Array.isArray(value)) {
    const truncated = value.length > DETAIL_ARRAY_LIMIT;
    const items = value.slice(0, DETAIL_ARRAY_LIMIT).map((item) => compactDetails(item, depth + 1));
    if (truncated)
      items.push({
        truncated: true,
        omitted: value.length - DETAIL_ARRAY_LIMIT
      });
    return items;
  }
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) output[key] = compactDetails(item, depth + 1);
    return output;
  }
  if (typeof value === 'string' && value.length > DETAIL_STRING_LIMIT)
    return `${value.slice(0, DETAIL_STRING_LIMIT)}… [truncated]`;
  return value;
}

export function addError(report, label, error) {
  const message = readableError(error);
  report.errors.push({ label, message, at: new Date().toISOString() });
  report.summary.errors = report.errors.length;
  addSection(report, `error-${report.errors.length}`, label, 'error', {
    message
  });
}

export function addSkipped(report, label, reason) {
  report.skipped.push({ label, reason, at: new Date().toISOString() });
  report.summary.skippedForSafety = report.skipped.length;
}

export function addUnavailable(report, label, reason) {
  report.unavailable.push({ label, reason, at: new Date().toISOString() });
  report.summary.unavailable = report.unavailable.length;
}

export async function finishReport(report) {
  report.finishedAt = new Date().toISOString();
  if (!['cancelled', 'failed', 'interrupted'].includes(report.status)) {
    report.status = report.errors.length ? 'completed_with_warnings' : 'completed';
  }
  await summarizeReport(report);
  return report;
}

async function summarizeReport(report) {
  const s = report.summary || {};
  const keys = [
    'normalTabsClosed',
    'incognitoTabsClosed',
    'siteZoomStatesReset',
    'mutedTargetTabsReset',
    'pinnedTargetTabsReset',
    'pageScriptLocalStorageCleared',
    'pageScriptSessionStorageCleared',
    'pageScriptIndexedDBDeleted',
    'pageScriptCachesDeleted',
    'pageScriptServiceWorkersUnregistered',
    'pageScriptPushSubscriptionsUnsubscribed',
    'pageScriptPeriodicSyncTagsUnregistered',
    'pageScriptStorageBucketsDeleted',
    'pageScriptOPFSEntriesDeleted',
    'pageScriptAppBadgeCleared',
    'pageScriptCookiesExpired',
    'cookiesRemoved',
    'partitionedCookiesRemoved',
    'originStorageTypesSucceeded',
    'historyEntriesRemoved',
    'downloadHistoryEntriesRemoved',
    'downloadedFilesRemoved'
  ];
  s.browserOperationEventCount = keys.reduce((total, key) => total + safeCount(s[key]), 0);
  // This legacy field used to sum unlike, potentially overlapping units and
  // was therefore not a count of unique browser changes. Keep it null so old
  // readers do not mistake an event counter for a deduplicated result.
  s.totalBrowserVisibleChanges = null;
  s.verificationRemainingTotal = s.verificationAllRequiredChecksSucceeded
    ? safeCount(s.verificationCookiesRemaining) +
      safeCount(s.verificationTabsRemaining) +
      safeCount(s.verificationHistoryRemaining) +
      safeCount(s.verificationDownloadsRemaining)
    : null;
  s.errors = Array.isArray(report.errors) ? report.errors.length : safeCount(s.errors);
  s.unavailable = Array.isArray(report.unavailable) ? report.unavailable.length : safeCount(s.unavailable);
  s.skippedForSafety = Array.isArray(report.skipped) ? report.skipped.length : safeCount(s.skippedForSafety);
  const started = Date.parse(report.startedAt || '');
  const finished = Date.parse(report.finishedAt || '');
  s.totalDurationMs = Number.isFinite(started) && Number.isFinite(finished) ? Math.max(0, finished - started) : 0;
  s.slowestPhase = getSlowestPhase(report.phaseTimings);
  Object.assign(s, buildCleanupConfidence(report, s));
  report.summary = s;
  await refreshReportIntegrity(report);
}

function getSlowestPhase(phaseTimings) {
  const entries = Object.entries(phaseTimings || {}).filter(([, value]) => Number.isFinite(Number(value)));
  if (!entries.length) return 'N/A';
  entries.sort((a, b) => Number(b[1]) - Number(a[1]));
  const [name, ms] = entries[0];
  return `${name} (${Math.round(Number(ms))}ms)`;
}

function buildCleanupConfidence(report, summary) {
  let score = 100;
  const reasons = [];
  const verificationStatus = String(summary.verificationStatus || 'unknown');
  const remaining = summary.verificationRemainingTotal == null ? null : safeCount(summary.verificationRemainingTotal);
  const knownResidue = Object.values(summary.verificationCategories || {}).reduce(
    (total, evidence) => (evidence?.state === 'residue_found' ? total + safeCount(evidence.count) : total),
    0
  );
  const verificationComplete = summary.verificationAllRequiredChecksSucceeded === true;
  if (verificationStatus === 'verified_zero' && verificationComplete) {
    reasons.push('All required exposed-browser verification checks completed and returned zero residue.');
  } else if (verificationStatus === 'residue_found') {
    const residueCount = remaining ?? knownResidue;
    const penalty = Math.min(45, residueCount * 6);
    score -= penalty;
    reasons.push(`${residueCount} exposed residue item(s) were found in completed checks (-${penalty}).`);
    if (!verificationComplete) {
      score = Math.min(score, 65);
      const incomplete = Object.entries(summary.verificationCategories || {})
        .filter(([, evidence]) => !['verified_zero', 'residue_found'].includes(evidence?.state))
        .map(([name, evidence]) => `${name}:${evidence?.state || 'unknown'}`)
        .join(', ');
      reasons.push(
        `Residue was found, but other verification evidence is incomplete${incomplete ? ` (${incomplete})` : ''}; the residue total is not a complete count.`
      );
    }
  } else if (verificationStatus === 'not_attempted') {
    score = Math.min(score - 25, 60);
    reasons.push('Post-clean verification was not attempted; cleanup outcome is not independently verified.');
  } else {
    score = Math.min(score - 25, 65);
    const incomplete = Object.entries(summary.verificationCategories || {})
      .filter(([, evidence]) => !['verified_zero', 'residue_found'].includes(evidence?.state))
      .map(([name, evidence]) => `${name}:${evidence?.state || 'unknown'}`)
      .join(', ');
    reasons.push(
      `Verification evidence is incomplete${incomplete ? ` (${incomplete})` : ''}; unknown checks are not treated as zero.`
    );
  }
  const originFailures = safeCount(summary.originStorageTypesFailed);
  if (originFailures) {
    const penalty = Math.min(25, originFailures * 8);
    score -= penalty;
    score = Math.min(score, 85);
    reasons.push(`${originFailures} origin cleanup plan(s) failed or were partial (-${penalty}).`);
  }
  const errors = Array.isArray(report.errors) ? report.errors.length : safeCount(summary.errors);
  if (errors) {
    const penalty = Math.min(30, errors * 10);
    score -= penalty;
    score = Math.min(score, 85);
    reasons.push(`${errors} runtime error(s) were recorded (-${penalty}).`);
  }
  if (!report.hostPermissionsGranted) {
    score -= 20;
    reasons.push('Preflight-bound target host access was unavailable or withheld (-20).');
  }
  if (!report.incognitoAccess) {
    score -= 5;
    reasons.push('Incognito/private windows were not accessible to the extension (-5).');
  }
  if (summary.browserCookieSweepAttempted && !summary.browserCookieSweepSucceeded) {
    score -= 5;
    reasons.push('Browser cookie sweep was attempted but not fully successful (-5).');
  }
  const partialSections = Array.isArray(report.sections)
    ? report.sections.filter((section) => ['partial', 'error'].includes(section?.status))
    : [];
  const evidenceLimitReached = Boolean(
    summary.operationBudgetExhausted ||
    summary.historyDeleteTimeouts ||
    summary.cookieRemoveTimeouts ||
    summary.downloadedFileRemovalFailures ||
    partialSections.length
  );
  if (evidenceLimitReached) {
    score = Math.min(score, 69);
    reasons.push(
      `${partialSections.length} report section(s) were partial or failed, or an operation outcome remained capped, timed out, or unknown.`
    );
  }
  if (report.status === 'failed' || report.status === 'interrupted') {
    score = Math.min(score, 35);
    reasons.push(`Cleanup ended with status ${report.status}.`);
  } else if (report.status === 'cancelled') {
    score = Math.min(score, 45);
    reasons.push('Cleanup was canceled before completion.');
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  let label = 'High';
  if (score < 50) label = 'Low';
  else if (score < 70) label = 'Partial';
  else if (score < 90) label = 'Good';
  if (
    label === 'High' &&
    (!verificationComplete ||
      verificationStatus !== 'verified_zero' ||
      errors > 0 ||
      originFailures > 0 ||
      report.status !== 'completed')
  ) {
    label = 'Good';
  }
  if (!reasons.length) reasons.push('No major report-level problems were detected in exposed browser surfaces.');
  return {
    cleanupConfidenceScore: score,
    cleanupConfidenceLabel: label,
    cleanupConfidenceReasons: reasons.slice(0, 8)
  };
}

function safeCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function nonNegativeCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

export function readableError(error) {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  if (error.message) return error.message;
  if (typeof chrome !== 'undefined' && chrome?.runtime?.lastError?.message) return chrome.runtime.lastError.message;
  return String(error);
}

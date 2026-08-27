import { buildHostPermissionInventory } from './host-permissions.js';
import { PROGRESS_OVERLAY_MAX_TABS } from './constants.js';
import {
  EXACT_ORIGIN_BROWSER_STORAGE_LIMITATION,
  SELECTED_SITE_PARTITION_STORAGE_DISCLOSURE,
  classifyBrowserStorageScope
} from './storage-partition-policy.js';

const PROTECTED_CATEGORIES = Object.freeze([
  'Saved passwords, passkeys, and other credentials',
  'Bookmarks',
  'Autofill profiles, payment methods, and browser form data',
  'Browser Sync and browser-account data',
  'Data and request rules owned by other extensions'
]);

const UNAVAILABLE_CATEGORIES = Object.freeze([
  'Target-specific browser permission and content-setting reset (manage this in browser site settings)',
  'HSTS, DNS, TLS, socket pools, Alt-Svc, and other browser network internals',
  'Favicon, Top Sites, and omnibox caches',
  'Protocol handlers and browser-managed hardware or file-system grants',
  'Website-server, ISP, router, VPN, operating-system, security-product, and enterprise logs'
]);

/**
 * @param {{
 *   enteredTarget?: unknown,
 *   target?: Record<string, any>,
 *   settings?: Record<string, any>,
 *   sourceWindowId?: number | null,
 *   sourceIncognito?: boolean,
 *   incognitoAccess?: boolean,
 *   hostPermissionsGranted?: boolean,
 *   hostPermissionInventory?: Record<string, any>,
 *   impact?: Record<string, any>,
 *   approvalToken?: string,
 *   createdAt?: string,
 *   expiresAt?: string
 * }} input
 */
export function buildCleanupReview({
  enteredTarget,
  target,
  settings = {},
  sourceWindowId = null,
  sourceIncognito = false,
  incognitoAccess = false,
  hostPermissionsGranted = false,
  hostPermissionInventory = {},
  impact = {},
  approvalToken,
  createdAt,
  expiresAt
}) {
  const primary = describeScopeTarget(target);
  const requiredHostPermissionOrigins = [...new Set((target?.hostPermissionOrigins || []).map(String))];
  const permissionInventory = buildHostPermissionInventory({
    requiredOrigins: requiredHostPermissionOrigins,
    coveredRequiredOrigins: Array.isArray(hostPermissionInventory.coveredRequiredHostPermissionOrigins)
      ? hostPermissionInventory.coveredRequiredHostPermissionOrigins
      : hostPermissionsGranted
        ? requiredHostPermissionOrigins
        : [],
    grantedOrigins: Array.isArray(hostPermissionInventory.grantedHostPermissionOrigins)
      ? hostPermissionInventory.grantedHostPermissionOrigins
      : hostPermissionsGranted
        ? requiredHostPermissionOrigins
        : []
  });
  const associatedTargets = (target?.associatedTargets || []).map(describeScopeTarget);
  const completedFileIds = uniqueIds(impact.matchedCompletedFileIds);
  const fileCandidateCount = Number.isInteger(impact.matchedCompletedFileCount)
    ? impact.matchedCompletedFileCount
    : completedFileIds.length;
  const canBindFileCandidates = Array.isArray(impact.matchedCompletedFileIds);
  const willRemoveFiles = Boolean(
    settings.deleteDownloadedFiles && canBindFileCandidates && completedFileIds.length > 0
  );
  const downloadRecordErasurePolicy = settings.deleteDownloadedFiles
    ? !canBindFileCandidates
      ? 'none_incomplete_file_inventory'
      : willRemoveFiles
        ? 'approved_file_removal_only'
        : 'none_no_approved_files'
    : 'all_matching_records';
  const requiredFileConfirmation = willRemoveFiles
    ? buildFileDeletionConfirmation(primary.normalizedTarget, completedFileIds.length)
    : '';
  const matchingPrivateTabs = finiteCount(impact.matchingPrivateTabs);
  const matchingHistoryLowerBound = finiteCount(impact.matchingHistoryEntriesLowerBound);
  const matchingDownloadLowerBound = finiteCount(impact.matchingDownloadRecordsLowerBound);
  const historyCountComplete = impact.discoveryEvidence?.history
    ? impact.discoveryEvidence.history.complete === true
    : finiteCount(impact.matchingHistoryEntries) !== null;
  const downloadCountComplete = impact.discoveryEvidence?.downloads
    ? impact.discoveryEvidence.downloads.complete === true
    : finiteCount(impact.matchingDownloadRecords) !== null;
  const privateDataObserved = Boolean(sourceIncognito || (matchingPrivateTabs !== null && matchingPrivateTabs > 0));
  const requestShieldRequested = settings.temporaryDnrShield !== false || settings.postWipeSessionBlock === true;
  // Session DNR rules are shared across the extension's spanning profile
  // context and cannot be constrained to a reviewed normal-window-only scope.
  // Only install them when private scope is explicitly included in this review.
  const requestShieldEnabled = requestShieldRequested && incognitoAccess === true;
  const requestShieldDisabledReason =
    requestShieldRequested && !requestShieldEnabled
      ? 'Skipped for normal-only safety: SiteWipe cannot constrain shared DNR session rules to normal windows, so no target request block will be installed.'
      : null;
  const progressOverlay = describeProgressOverlayEffect(settings, sourceWindowId);
  const configuredCleanup = describeConfiguredCleanupEffects(settings);
  const browserStorageScope = classifyBrowserStorageScope(target);

  const categoriesAttempted = [
    requestShieldEnabled ? 'Temporary target request shield' : null,
    settings.pageScriptScrub !== false ? 'Live page-visible storage and worker registrations' : null,
    'Open matching tabs',
    settings.resetZoom !== false ? 'Target-tab zoom state' : null,
    settings.resetMutedTabs ? 'Target-tab mute state' : null,
    settings.unpinTargetTabs ? 'Target-tab pinned state' : null,
    'Unpartitioned and exposed partitioned cookies',
    browserStorageScope.selectedSitePartitionDisclosureRequired
      ? 'Selected-site storage, caches, file-system data, and service workers, including embedded third-party partitions under that site'
      : null,
    'Matching browsing-history entries',
    downloadRecordErasurePolicy === 'all_matching_records'
      ? 'Matching download-history records'
      : downloadRecordErasurePolicy === 'approved_file_removal_only'
        ? 'Preflight-approved download-history records, only after the corresponding on-disk file is removed successfully'
        : null,
    willRemoveFiles ? 'Preflight-bound completed downloaded files on disk' : null,
    settings.permissionAudit !== false ? 'Live permission-state audit (read-only)' : null,
    settings.verificationPass !== false ? 'Post-clean residue verification (read-only)' : null
  ].filter(Boolean);

  const reportRetention = describeReportRetention({
    settings,
    sourceIncognito,
    incognitoAccess,
    privateDataObserved
  });
  const requirements = {
    reviewedScope: true,
    associatedTargets: associatedTargets.length > 0,
    localOrIpTarget: primary.scopeKind === 'exact_origin' && isLocalOrIpTarget(target),
    protectedWebOrigins: Boolean(settings.includeProtectedWebOrigins),
    downloadedFiles: willRemoveFiles,
    fileConfirmationText: requiredFileConfirmation
  };

  const warnings = [
    'Approved cleanup removes matching browser data. Completed changes cannot be undone by SiteWipe.',
    'Expected counts are a read-only preflight snapshot. Matching tabs, history, and download records may change before cleanup starts; on-disk file removal remains limited to the separately confirmed preflight-bound file IDs.',
    finiteCount(impact.matchingTabs) > 0
      ? `${impact.matchingTabs} currently matching tab(s) will be closed; additional matching tabs present when cleanup starts may also close.`
      : 'Any matching tabs present when cleanup starts will be closed.',
    !historyCountComplete && impact.discoveryEvidence?.history
      ? matchingHistoryLowerBound > 0
        ? `History discovery was incomplete; at least ${matchingHistoryLowerBound} matching history item(s) were observed, and preflight cannot claim an exact count.`
        : 'History discovery was incomplete; the browser result limit prevented preflight from proving an exact count or zero matches.'
      : null,
    !downloadCountComplete && impact.discoveryEvidence?.downloads
      ? matchingDownloadLowerBound > 0
        ? settings.deleteDownloadedFiles
          ? `Download discovery was incomplete; at least ${matchingDownloadLowerBound} matching download record(s) were observed. No on-disk file deletion or matching download-record erasure is authorized by this review.`
          : `Download discovery was incomplete; at least ${matchingDownloadLowerBound} matching download record(s) were observed. Only positively discovered matching records may be erased, and no on-disk files will be removed.`
        : settings.deleteDownloadedFiles
          ? 'Download discovery was incomplete; the browser result limit prevented preflight from proving an exact count or zero matches. No on-disk file deletion or matching download-record erasure is authorized by this review.'
          : 'Download discovery was incomplete; the browser result limit prevented preflight from proving an exact count or zero matches. Only positively discovered matching records may be erased, no zero-match claim is made, and no on-disk files will be removed.'
      : null,
    associatedTargets.length ? 'Associated targets expand the cleanup beyond the primary normalized target.' : null,
    browserStorageScope.selectedSitePartitionDisclosureRequired ? SELECTED_SITE_PARTITION_STORAGE_DISCLOSURE : null,
    browserStorageScope.exactOriginLimitationRequired ? EXACT_ORIGIN_BROWSER_STORAGE_LIMITATION : null,
    requirements.localOrIpTarget
      ? 'Localhost and IP cleanup uses exact origin scope for tabs, live-page storage, history, and download URLs; cookies remain host-scoped because browser cookies are not port-scoped.'
      : null,
    requirements.protectedWebOrigins ? 'Installed/protected web-app origin data is enabled for this cleanup.' : null,
    willRemoveFiles
      ? `${completedFileIds.length} preflight-bound completed downloaded file(s) will be removed from disk. SiteWipe cannot undo this.`
      : null,
    willRemoveFiles
      ? 'When downloaded-file deletion is enabled, SiteWipe erases a preflight-approved download record only after its corresponding file deletion succeeds. Unapproved or failed file candidates keep their records for recovery.'
      : null,
    settings.deleteDownloadedFiles && !willRemoveFiles && !canBindFileCandidates
      ? 'Downloaded-file matching could not be completed during preflight, so this approval authorizes no on-disk file removal or matching download-record erasure.'
      : null,
    settings.deleteDownloadedFiles && !willRemoveFiles && canBindFileCandidates
      ? 'No completed downloaded files matched during preflight, so this approval authorizes no on-disk file removal or matching download-record erasure.'
      : null,
    requestShieldEnabled && settings.postWipeSessionBlock
      ? 'The target request shield will remain active after cleanup until its configured expiration or browser restart.'
      : null,
    requestShieldDisabledReason
      ? `${requestShieldDisabledReason} The target may recreate browser data while cleanup runs.`
      : null,
    ...progressOverlay.warnings,
    permissionInventory.broadGrantedHostPermissionOrigins.length
      ? `SiteWipe already has ${permissionInventory.broadGrantedHostPermissionOrigins.length} broader user-controlled host permission pattern(s). They are displayed separately, never requested by this cleanup, and preserved.`
      : null,
    hostPermissionsGranted
      ? permissionInventory.requiredCoveredByBroadHostPermissionOrigins.length
        ? 'The preflight-bound target site access is available partly or entirely through broader pre-existing access. That user-controlled access will be preserved.'
        : 'The preflight-bound target site access was already available as exact grants and will be preserved.'
      : 'Chrome/Brave may show its own target-specific site-access prompt after Clean now. Access newly granted for this cleanup is durably tracked and release is retried until the browser proves it absent.'
  ].filter(Boolean);

  const review = {
    schemaVersion: 1,
    approvalMode:
      settings.skipCleanupReview === true
        ? CLEANUP_APPROVAL_MODES.settingsDirect
        : CLEANUP_APPROVAL_MODES.detailedReview,
    approvalToken,
    createdAt,
    expiresAt,
    enteredTarget: String(enteredTarget || ''),
    normalizedTarget: primary.normalizedTarget,
    primaryTarget: primary,
    scopeKind: primary.scopeKind,
    scopeLabel: primary.scopeLabel,
    includesSubdomains: primary.includesSubdomains,
    associatedTargets,
    normalWindowScope: {
      included: true,
      summary: 'Matching data exposed in normal browser windows is included.'
    },
    privateWindowScope: {
      included: Boolean(incognitoAccess),
      sourceIncognito: Boolean(sourceIncognito),
      matchingTabs: matchingPrivateTabs,
      summary: incognitoAccess
        ? 'Matching data exposed in private windows is included. Chrome/Brave may expose less private data than normal-profile data.'
        : 'Private-window data is not accessible because private-window access is not enabled.'
    },
    categoriesAttempted,
    categoriesProtected: [...PROTECTED_CATEGORIES],
    categoriesUnavailable: [
      ...UNAVAILABLE_CATEGORIES,
      browserStorageScope.exactOriginLimitationRequired
        ? 'Browser-level closed-page storage and cache cleanup for exact-origin-only scope (skipped to preserve the reviewed port boundary)'
        : null
    ].filter(Boolean),
    effects: {
      browserLevelStorage: {
        selectedSiteCleanupEnabled: browserStorageScope.selectedSitePartitionDisclosureRequired,
        selectedSitePartitionSemantics: browserStorageScope.selectedSitePartitionDisclosureRequired
          ? SELECTED_SITE_PARTITION_STORAGE_DISCLOSURE
          : null,
        exactOriginOnlyCleanupSkipped: browserStorageScope.exactOriginLimitationRequired,
        exactOriginLimitation: browserStorageScope.exactOriginLimitationRequired
          ? EXACT_ORIGIN_BROWSER_STORAGE_LIMITATION
          : null
      },
      closeTabs: {
        enabled: true,
        matchingCount: finiteCount(impact.matchingTabs)
      },
      removeHistory: {
        enabled: true,
        matchingCount: finiteCount(impact.matchingHistoryEntries),
        matchingCountLowerBound: matchingHistoryLowerBound,
        countComplete: historyCountComplete
      },
      removeDownloadRecords: {
        enabled: downloadRecordErasurePolicy === 'all_matching_records' || willRemoveFiles,
        matchingCount: finiteCount(impact.matchingDownloadRecords),
        matchingCountLowerBound: matchingDownloadLowerBound,
        countComplete: downloadCountComplete,
        erasurePolicy: downloadRecordErasurePolicy,
        conditionalOnSuccessfulFileRemoval: Boolean(settings.deleteDownloadedFiles),
        approvedFileCandidateCount: canBindFileCandidates ? completedFileIds.length : null,
        preservesUnapprovedOrFailedFileRecords: Boolean(settings.deleteDownloadedFiles)
      },
      removeDownloadedFiles: {
        settingEnabled: Boolean(settings.deleteDownloadedFiles),
        enabled: willRemoveFiles,
        matchingCompletedFileCount: canBindFileCandidates ? completedFileIds.length : fileCandidateCount,
        candidateReviewComplete: canBindFileCandidates,
        authorizationBoundToReviewedCandidates: true
      },
      requestShield: {
        requested: requestShieldRequested,
        enabled: requestShieldEnabled,
        disabledForNormalOnlyReview: Boolean(requestShieldDisabledReason),
        disabledReason: requestShieldDisabledReason,
        remainsAfterCleanup: Boolean(requestShieldEnabled && settings.postWipeSessionBlock),
        expiresMinutes:
          requestShieldEnabled && settings.postWipeSessionBlock
            ? normalizedShieldExpiryMinutes(settings.postWipeShieldExpiresMinutes)
            : null
      },
      progressOverlay,
      configuredCleanup,
      operationCapacity: impact.queryCapacityPlan || null,
      verification: { enabled: settings.verificationPass !== false },
      localReport: reportRetention
    },
    settingsSnapshot: {
      cleanupMode: settings.cleanupMode === 'expert' ? 'expert' : 'standard',
      skipCleanupReview: settings.skipCleanupReview === true,
      includeProtectedWebOrigins: Boolean(settings.includeProtectedWebOrigins),
      deleteDownloadedFiles: Boolean(settings.deleteDownloadedFiles),
      reportRedaction: settings.redactReports !== false,
      latestReportRetentionMinutes: normalizedRetentionMinutes(settings.latestReportRetentionMinutes),
      historyEnabled: Boolean(settings.keepHistory)
    },
    sourceWindowId: Number.isInteger(sourceWindowId) ? sourceWindowId : null,
    hostPermissionsGranted: Boolean(hostPermissionsGranted),
    requiredHostPermissionOrigins,
    hostPermissionInventory: permissionInventory,
    previewLimitations: Array.isArray(impact.limitations) ? impact.limitations.map(String) : [],
    warnings,
    requirements,
    requiredFileConfirmation,
    readyForApproval: true
  };
  return review;
}

function describeProgressOverlayEffect(settings, sourceWindowId) {
  const enabled = settings.progressOverlay === true;
  const scope = normalizeOverlayScope(settings.overlayScope, sourceWindowId);
  const scopeDescription =
    scope === 'all_tabs'
      ? 'all accessible HTTP(S) tabs across browser windows'
      : scope === 'current_window'
        ? 'accessible HTTP(S) tabs in this popup/source window'
        : 'matching accessible HTTP(S) target tabs only';
  const cancelButtonEnabled = enabled && settings.progressOverlayCancelButton === true;
  const warnings = enabled
    ? [
        `A temporary cleanup progress overlay will be shown in ${scopeDescription}, capped at ${PROGRESS_OVERLAY_MAX_TABS} tabs per update.${scope === 'target_tabs' ? '' : ' This can visibly change unrelated pages.'}`,
        `The in-page cancel button is ${cancelButtonEnabled ? 'enabled' : 'disabled'}. Restricted, inaccessible, discarded, or out-of-reviewed-private-scope tabs are skipped. Tab eligibility can change between updates, so a stale overlay may remain until the approximately 15-second watchdog removes its UI and listener; the ${PROGRESS_OVERLAY_MAX_TABS}-tab per-update cap is not a guaranteed simultaneous-visible total.`
      ]
    : [];
  return {
    enabled,
    scope,
    scopeDescription,
    sourceWindowId: scope === 'current_window' && Number.isInteger(sourceWindowId) ? sourceWindowId : null,
    cancelButtonEnabled,
    maxTabsPerUpdate: PROGRESS_OVERLAY_MAX_TABS,
    capAppliesPerUpdate: true,
    simultaneousVisibleLimitGuaranteed: false,
    temporary: enabled,
    watchdogMs: 15_000,
    warnings
  };
}

function describeConfiguredCleanupEffects(settings) {
  const livePageScrubEnabled = settings.pageScriptScrub !== false;
  return {
    livePageScrub: {
      enabled: livePageScrubEnabled,
      storageBuckets: livePageScrubEnabled && settings.storageBucketScrub === true,
      opfs: livePageScrubEnabled && settings.opfsScrub === true,
      serviceWorkerExtras: livePageScrubEnabled && settings.serviceWorkerExtraScrub === true,
      appBadgeClear: livePageScrubEnabled && settings.appBadgeClear === true
    },
    embeddedFrameDiscovery: settings.embeddedFrameDiscovery === true,
    cookies: {
      browserCookieSweep: settings.aggressiveCookieSweep !== false,
      partitionedEmbeddingSiteProbes: settings.probePartitionedCookiesWithEmbeddingSites === true,
      exhaustiveAccessibleStoreScan: settings.exhaustiveCookieStoreScan === true
    },
    recordDiscovery: {
      broadSearchTermFallback: settings.broadDiscoveryFallback === true,
      recentDownloadFallback: settings.downloadRecentFallback === true
    },
    targetTabState: {
      resetZoom: settings.resetZoom !== false,
      resetMutedTabs: settings.resetMutedTabs === true,
      unpinTabs: settings.unpinTargetTabs === true
    },
    protectedWebOrigins: settings.includeProtectedWebOrigins === true
  };
}

function normalizeOverlayScope(value, sourceWindowId) {
  if (!['all_tabs', 'current_window', 'target_tabs'].includes(value)) return 'target_tabs';
  return value === 'current_window' && !Number.isInteger(sourceWindowId) ? 'target_tabs' : value;
}

function normalizedShieldExpiryMinutes(value) {
  const numeric = Number(value);
  return [0, 15, 60, 240, 1440].includes(numeric) ? numeric : 0;
}

export const CLEANUP_APPROVAL_MODES = Object.freeze({
  detailedReview: 'detailed_review',
  settingsDirect: 'settings_direct'
});

/**
 * @param {Record<string, any>} requirements
 * @param {Record<string, any>} approval
 * @param {'detailed_review' | 'settings_direct'} expectedApprovalMode
 */
export function validateCleanupReviewApproval(
  requirements = {},
  approval = {},
  expectedApprovalMode = CLEANUP_APPROVAL_MODES.detailedReview
) {
  const errors = [];
  const approvalMode = approval.approvalMode;
  if (!Object.values(CLEANUP_APPROVAL_MODES).includes(expectedApprovalMode) || approvalMode !== expectedApprovalMode) {
    errors.push(
      'A complete per-run cleanup review is required unless the prepared settings-direct authorization mode matches. Start again.'
    );
    return { ok: false, errors, approvalMode };
  }
  if (approvalMode === CLEANUP_APPROVAL_MODES.settingsDirect) {
    for (const key of ['reviewedScope', 'associatedTargets', 'localOrIpTarget', 'protectedWebOrigins']) {
      if (approval[key] !== false) {
        errors.push('Direct-cleanup authorization must not claim that per-run acknowledgements occurred. Start again.');
        break;
      }
    }
    if (String(approval.fileConfirmationText || '') !== '') {
      errors.push('Direct-cleanup authorization must not claim that the per-run file phrase was entered. Start again.');
    }
    return { ok: errors.length === 0, errors, approvalMode };
  }
  if (approval.reviewedScope !== true) errors.push('Review and acknowledge the displayed cleanup scope.');
  if (requirements.associatedTargets && approval.associatedTargets !== true) {
    errors.push('Acknowledge every associated target included in this cleanup.');
  }
  if (requirements.localOrIpTarget && approval.localOrIpTarget !== true) {
    errors.push('Acknowledge the exact-origin localhost or IP scope.');
  }
  if (requirements.protectedWebOrigins && approval.protectedWebOrigins !== true) {
    errors.push('Acknowledge cleanup of installed/protected web-app origin data.');
  }
  if (requirements.downloadedFiles) {
    const actual = String(approval.fileConfirmationText || '').trim();
    if (actual !== requirements.fileConfirmationText) {
      errors.push(`Type exactly: ${requirements.fileConfirmationText}`);
    }
  }
  return { ok: errors.length === 0, errors, approvalMode };
}

export function buildFileDeletionConfirmation(normalizedTarget, count) {
  const safeCount = Math.max(0, Number.parseInt(count, 10) || 0);
  const noun = safeCount === 1 ? 'FILE' : 'FILES';
  return `DELETE ${safeCount} ${noun} FOR ${String(normalizedTarget || '').trim()}`;
}

export function describeReviewedRecordEffect(effect) {
  if (effect?.erasurePolicy === 'approved_file_removal_only') {
    const count = Number.isInteger(effect.approvedFileCandidateCount) ? effect.approvedFileCandidateCount : 0;
    return `up to ${count} preflight-approved entr${count === 1 ? 'y is' : 'ies are'} removed only after the corresponding file deletion succeeds; unapproved or failed file records are preserved.`;
  }
  if (effect?.erasurePolicy === 'none_incomplete_file_inventory') {
    return 'not removed; download discovery was incomplete, so no file or matching record erasure is authorized.';
  }
  if (effect?.erasurePolicy === 'none_no_approved_files') {
    return 'not removed; no completed file was approved and matching records are preserved.';
  }
  if (effect?.enabled !== true) return 'not removed.';
  if (effect.countComplete === false) {
    const lowerBound = Number.isInteger(effect.matchingCountLowerBound) ? effect.matchingCountLowerBound : null;
    return lowerBound === null
      ? 'positively discovered matching entries are removed; preflight did not prove a full count or zero matches.'
      : `positively discovered matching entries are removed; preflight found at least ${lowerBound} and did not prove a full count.`;
  }
  if (!Number.isInteger(effect.matchingCount)) return 'matching entries removed; preflight count unavailable.';
  return `matching entries removed; ${effect.matchingCount} found in preflight.`;
}

export function reviewedFileIds(items = []) {
  return uniqueIds(
    (items || []).filter((item) => item?.state === 'complete' && item?.exists !== false).map((item) => item.id)
  );
}

export function isReviewedFileRemovalCandidate(item, approvedIds = []) {
  if (!item || item.state !== 'complete' || item.exists === false) return false;
  return new Set(uniqueIds(approvedIds)).has(String(item.id));
}

function describeScopeTarget(target = {}) {
  const matchMode = String(target.matchMode || 'registrable_domain');
  if (matchMode === 'exact_origin') {
    return {
      normalizedTarget: String(target.exactOrigin || target.displayName || target.domain || ''),
      scopeKind: 'exact_origin',
      scopeLabel: 'Exact origin (scheme, host, and port)',
      includesSubdomains: false
    };
  }
  if (matchMode === 'exact_host') {
    return {
      normalizedTarget: String(target.exactHost || target.displayName || target.domain || ''),
      scopeKind: 'exact_host',
      scopeLabel: 'Exact host',
      includesSubdomains: false
    };
  }
  return {
    normalizedTarget: String(target.domain || target.displayName || ''),
    scopeKind: 'registrable_site',
    scopeLabel: 'Registrable site',
    includesSubdomains: true
  };
}

function describeReportRetention({ settings, sourceIncognito, incognitoAccess, privateDataObserved }) {
  const minutes = normalizedRetentionMinutes(settings.latestReportRetentionMinutes);
  if (sourceIncognito || incognitoAccess || privateDataObserved) {
    return {
      retained: false,
      conditional: false,
      redacted: settings.redactReports !== false,
      historyEnabled: false,
      retentionMinutes: 0,
      summary:
        'No report will be persisted because private-window access is enabled or this review already observes a private-window context; affected private scope cannot be proven absent.'
    };
  }
  return {
    retained: true,
    conditional: false,
    redacted: settings.redactReports !== false,
    historyEnabled: Boolean(settings.keepHistory),
    retentionMinutes: minutes,
    summary: `A ${settings.redactReports === false ? 'full' : 'redacted'} latest report is retained locally ${retentionWindowText(minutes)}. ${settings.keepHistory ? 'Report history is enabled.' : 'Report history is disabled.'}`
  };
}

function normalizedRetentionMinutes(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 30;
}

function retentionWindowText(minutes) {
  return minutes === 0 ? 'indefinitely by explicit privacy opt-in' : `for up to ${minutes} minutes`;
}

function isLocalOrIpTarget(target = {}) {
  const host = String(target.exactHost || target.domain || '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  return (
    host === 'localhost' || host.endsWith('.localhost') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')
  );
}

function uniqueIds(values) {
  return [
    ...new Set((values || []).filter((value) => value !== null && value !== undefined).map((value) => String(value)))
  ];
}

function finiteCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

import { describeCookieDiscoveryQueryDemand, MAX_COOKIE_DISCOVERY_QUERIES, MAX_COOKIE_STORES } from './cookies.js';
import { discoverySearchTerms } from './record-discovery.js';
import { PROGRESS_OVERLAY_MAX_TABS } from '../shared/constants.js';

export const PREFLIGHT_OPERATION_MAX_QUERIES = 750;
export const CLEANUP_OPERATION_MAX_QUERIES = 1000;
export const CLEANUP_OPERATION_QUERY_RESERVE = 50;
export const MAX_SUPPORTED_COOKIE_STORES = MAX_COOKIE_STORES;
export const MAX_TAB_STATE_AUDIT_TABS = 100;
export const MAX_PAGE_SCRIPT_TABS = 25;
export const MAX_PROGRESS_OVERLAY_TABS = PROGRESS_OVERLAY_MAX_TABS;
export const MAX_PROGRESS_OVERLAY_SHOW_UPDATES = 13;
export const MAX_DOWNLOAD_DISCOVERY_MATCHES = 1000;

export const MAX_EMBEDDED_FRAME_DISCOVERY_QUERIES = 60;
const MAX_COOKIE_URL_PROBE_ORIGINS = 80;
const MAX_PARTITION_TOP_LEVEL_SITES = 50;

/**
 * Build a conservative query upper bound for one reviewed cleanup.
 *
 * The observation is deliberately count-only. Preflight and cleanup-start
 * discovery provide browser-observed counts without persisting tab URLs or
 * cookie-store identifiers in the approval. Every state-dependent read that
 * claims the cleanup operation budget is included here before mutation.
 */
export function buildCleanupQueryCapacityPlan(target, settings = {}, observation = {}) {
  const counts = normalizeCapacityObservation(observation, settings);
  const recordSearchTerms = discoverySearchTerms(target, settings).length;
  const downloadQueriesPerPass = recordSearchTerms + (settings.downloadRecentFallback === true ? 1 : 0);
  const recordQueriesPerPass = recordSearchTerms + downloadQueriesPerPass;
  const scopeCookieInputs = maximumScopeCookieInputs(target, settings);
  const scopeCookieDemand = describeCookieDiscoveryQueryDemand(
    target,
    scopeCookieInputs.origins,
    scopeCookieInputs.partitionTopLevelSites,
    settings
  );
  const requiredScopeCookieDemand = describeCookieDiscoveryQueryDemand(
    target,
    scopeCookieInputs.origins,
    scopeCookieInputs.partitionTopLevelSites,
    { ...settings, probePartitionedCookiesWithEmbeddingSites: false }
  );
  const scopeCookieQueriesUncappedRequestedPerStore = scopeCookieDemand.uncappedRequestedQueries;
  const scopeCookieQueriesHardCappedRequestedPerStore = scopeCookieDemand.hardCappedRequestedQueries;
  const scopeCookieQueriesRequestedPerStore = scopeCookieQueriesHardCappedRequestedPerStore;
  const scopeCookieQueriesHardCapOmittedPerStore = scopeCookieDemand.hardCapOmittedQueries;
  const scopeCookieQueriesRequiredUncappedPerStore = requiredScopeCookieDemand.requiredQueries;
  const scopeCookieQueriesRequiredPerStore = requiredScopeCookieDemand.hardCappedRequestedQueries;
  const scopeCookieQueriesRequiredHardCapOmittedPerStore = requiredScopeCookieDemand.hardCapOmittedQueries;
  const verificationEnabled = settings.verificationPass !== false;
  const verificationCookieQueriesPerStore = verificationEnabled
    ? describeCookieDiscoveryQueryDemand(target, target?.baseOrigins || [], target?.partitionTopLevelSites || [], {
        probePartitionedCookiesWithEmbeddingSites: false
      }).hardCappedRequestedQueries
    : 0;

  const preflightPlannedQueries = 2 + recordQueriesPerPass;
  const scopeNonCookieQueries =
    1 +
    (settings.embeddedFrameDiscovery === true ? MAX_EMBEDDED_FRAME_DISCOVERY_QUERIES : 0) +
    recordQueriesPerPass +
    1;
  const verificationPlannedQueries = verificationEnabled
    ? 1 + recordQueriesPerPass + 1 + verificationCookieQueriesPerStore * counts.cookieStoreCount
    : 0;

  const tabAuditQueriesPerTab =
    4 +
    (settings.resetZoom === false ? 0 : 1) +
    (settings.resetMutedTabs === true ? 1 : 0) +
    (settings.unpinTargetTabs === true ? 1 : 0);
  const tabAuditTabCount = Math.min(counts.matchingTabCount, MAX_TAB_STATE_AUDIT_TABS);
  const tabAuditQueries = tabAuditTabCount * tabAuditQueriesPerTab;
  const pageScrubTabCount =
    settings.pageScriptScrub === true
      ? settings.embeddedFrameDiscovery === true
        ? MAX_PAGE_SCRIPT_TABS
        : Math.min(counts.matchingTabCount, MAX_PAGE_SCRIPT_TABS)
      : 0;
  const pageScrubQueries = pageScrubTabCount;
  const tabCloseQueries = counts.matchingTabCount;
  const downloadRevalidationQueries =
    settings.deleteDownloadedFiles === true ? counts.approvedDownloadFileCount * 2 : counts.matchingDownloadCount;
  const dnrDiagnosticQueries =
    settings.incognitoAccess === true &&
    (settings.temporaryDnrShield !== false || settings.postWipeSessionBlock === true)
      ? 1
      : 0;
  const overlayTabCount =
    settings.progressOverlay === true ? Math.min(counts.overlayEligibleTabCount, MAX_PROGRESS_OVERLAY_TABS) : 0;
  // One live tabs.get before each update, a second revalidation when an
  // installed receiver disappears, and one final hide read are bounded by
  // two reads per show round. The implementation uses a fixed cleanup-start
  // snapshot, so new tabs can never expand this set after admission.
  const progressOverlayQueries =
    settings.progressOverlay === true ? overlayTabCount * MAX_PROGRESS_OVERLAY_SHOW_UPDATES * 2 : 0;
  const dynamicQueries =
    tabAuditQueries +
    pageScrubQueries +
    tabCloseQueries +
    downloadRevalidationQueries +
    dnrDiagnosticQueries +
    progressOverlayQueries;
  const cleanupAdmissionLimit = CLEANUP_OPERATION_MAX_QUERIES - CLEANUP_OPERATION_QUERY_RESERVE;
  const cleanupQueriesOutsideScopeCookies = scopeNonCookieQueries + verificationPlannedQueries + dynamicQueries;
  const scopeCookieQueryCapacityPerStore =
    counts.cookieStoreCount > 0
      ? Math.floor(Math.max(0, cleanupAdmissionLimit - cleanupQueriesOutsideScopeCookies) / counts.cookieStoreCount)
      : scopeCookieQueriesRequestedPerStore;
  // Required origin/domain queries stay intact. Optional embedding-site
  // partition probes consume only the capacity left after every other
  // pre-mutation operation is bounded. If even the required base cannot fit,
  // retain the requested count so admission rejects instead of silently
  // dropping required discovery.
  const scopeCookieQueriesAllocatedPerStore =
    scopeCookieQueriesUncappedRequestedPerStore > scopeCookieQueriesRequiredUncappedPerStore &&
    scopeCookieQueryCapacityPerStore >= scopeCookieQueriesRequiredPerStore
      ? Math.min(scopeCookieQueriesRequestedPerStore, scopeCookieQueryCapacityPerStore)
      : scopeCookieQueriesRequestedPerStore;
  const scopeCookieQueriesHardCapTruncated = scopeCookieQueriesHardCapOmittedPerStore > 0;
  const scopeCookieQueriesAllocationTruncated =
    counts.cookieStoreCount > 0 && scopeCookieQueriesAllocatedPerStore < scopeCookieQueriesRequestedPerStore;
  const scopeCookieQueriesAllocationOmittedPerStore = Math.max(
    0,
    scopeCookieQueriesRequestedPerStore - scopeCookieQueriesAllocatedPerStore
  );
  const scopeCookieQueriesOmittedPerStore = scopeCookieQueriesAllocationOmittedPerStore;
  const scopeCookieQueriesTotalOmittedPerStore = Math.max(
    0,
    scopeCookieQueriesUncappedRequestedPerStore - scopeCookieQueriesAllocatedPerStore
  );
  const scopeCookieQueriesTruncated = scopeCookieQueriesHardCapTruncated || scopeCookieQueriesAllocationTruncated;
  const scopeCookieQueriesPerStore = scopeCookieQueriesAllocatedPerStore;
  const scopePlannedQueries = scopeNonCookieQueries + scopeCookieQueriesPerStore * counts.cookieStoreCount;
  const cleanupPlannedQueries = scopePlannedQueries + verificationPlannedQueries + dynamicQueries;
  const observationFits =
    counts.observationComplete &&
    counts.cookieStoreCount <= MAX_SUPPORTED_COOKIE_STORES &&
    counts.approvedDownloadFileCount <= counts.matchingDownloadCount &&
    scopeCookieQueriesRequiredHardCapOmittedPerStore === 0;
  const preflightFits = preflightPlannedQueries <= PREFLIGHT_OPERATION_MAX_QUERIES;
  const cleanupFits = cleanupPlannedQueries <= cleanupAdmissionLimit;

  return {
    associatedTargetCount: Array.isArray(target?.associatedTargets) ? target.associatedTargets.length : 0,
    totalTargetCount: 1 + (Array.isArray(target?.associatedTargets) ? target.associatedTargets.length : 0),
    recordSearchTerms,
    downloadQueriesPerPass,
    cookieStoreCount: counts.cookieStoreCount,
    cookieStoreLimit: MAX_SUPPORTED_COOKIE_STORES,
    matchingTabCount: counts.matchingTabCount,
    matchingDownloadCount: counts.matchingDownloadCount,
    approvedDownloadFileCount: counts.approvedDownloadFileCount,
    overlayEligibleTabCount: counts.overlayEligibleTabCount,
    scopeAdditionalOriginAllowance: scopeCookieInputs.additionalOriginAllowance,
    scopePartitionTopLevelSiteAllowance: scopeCookieInputs.partitionTopLevelSiteAllowance,
    scopeCookieQueriesUncappedRequestedPerStore,
    scopeCookieQueryHardCapPerStore: MAX_COOKIE_DISCOVERY_QUERIES,
    scopeCookieQueriesHardCappedRequestedPerStore,
    scopeCookieQueriesRequestedPerStore,
    scopeCookieQueriesHardCapOmittedPerStore,
    scopeCookieQueriesRequiredUncappedPerStore,
    scopeCookieQueriesRequiredPerStore,
    scopeCookieQueriesRequiredHardCapOmittedPerStore,
    scopeCookieQueryCapacityPerStore,
    scopeCookieQueriesAllocatedPerStore,
    scopeCookieQueriesAllocationOmittedPerStore,
    scopeCookieQueriesOmittedPerStore,
    scopeCookieQueriesTotalOmittedPerStore,
    scopeCookieQueriesHardCapTruncated,
    scopeCookieQueriesAllocationTruncated,
    scopeCookieQueriesTruncated,
    scopeCookieQueriesPerStore,
    verificationCookieQueriesPerStore,
    verificationEnabled,
    embeddedFrameQueryAllowance: settings.embeddedFrameDiscovery === true ? MAX_EMBEDDED_FRAME_DISCOVERY_QUERIES : 0,
    tabAuditTabCount,
    tabAuditQueriesPerTab,
    tabAuditQueries,
    pageScrubTabCount,
    pageScrubQueries,
    tabCloseQueries,
    downloadRevalidationQueries,
    dnrDiagnosticQueries,
    overlayTabCount,
    overlayShowUpdateAllowance: settings.progressOverlay === true ? MAX_PROGRESS_OVERLAY_SHOW_UPDATES : 0,
    progressOverlayQueries,
    dynamicQueries,
    preflightPlannedQueries,
    preflightQueryLimit: PREFLIGHT_OPERATION_MAX_QUERIES,
    cleanupPlannedQueries,
    cleanupQueryLimit: CLEANUP_OPERATION_MAX_QUERIES,
    cleanupQueryReserve: CLEANUP_OPERATION_QUERY_RESERVE,
    cleanupAdmissionLimit,
    observationComplete: counts.observationComplete,
    observationFits,
    preflightFits,
    cleanupFits,
    admitted: observationFits && preflightFits && cleanupFits
  };
}

export function buildCleanupCapacityObservationFromImpact(impact = {}, settings = {}) {
  const downloadsComplete = impact?.discoveryEvidence?.downloads?.complete === true;
  const matchingDownloadCount = downloadsComplete
    ? nonNegativeInteger(impact.matchingDownloadRecords)
    : nonNegativeInteger(impact.matchingDownloadRecordsLowerBound);
  const approvedDownloadFileCount =
    settings.deleteDownloadedFiles === true && Array.isArray(impact.matchedCompletedFileIds)
      ? impact.matchedCompletedFileIds.length
      : 0;
  const matchingTabCount = nonNegativeInteger(impact.matchingTabs);
  const cookieStoreCount = nonNegativeInteger(impact.cookieStoreCount);
  const overlayEligibleTabCount = nonNegativeInteger(impact.overlayEligibleTabs);
  return {
    matchingTabCount: matchingTabCount ?? 0,
    matchingDownloadCount: matchingDownloadCount ?? 0,
    approvedDownloadFileCount,
    cookieStoreCount: cookieStoreCount ?? 0,
    overlayEligibleTabCount: overlayEligibleTabCount ?? 0,
    observationComplete:
      matchingTabCount !== null &&
      impact.tabEnumerationComplete === true &&
      cookieStoreCount !== null &&
      impact.cookieStoreEnumerationComplete === true &&
      overlayEligibleTabCount !== null &&
      typeof impact?.discoveryEvidence?.downloads?.complete === 'boolean'
  };
}

export function capCleanupQueryCapacityToReviewedAllocation(plan, reviewedPlan) {
  if (reviewedPlan == null) return plan;
  const reviewedLimit = reviewedPlan?.scopeCookieQueriesAllocatedPerStore;
  if (reviewedPlan?.admitted !== true || !Number.isSafeInteger(reviewedLimit) || reviewedLimit < 0) {
    const error = new Error('The approved cleanup lacks a valid reviewed cookie-query allocation.');
    error.name = 'OperationCapacityExceededError';
    throw error;
  }
  if (
    !Number.isSafeInteger(plan?.scopeCookieQueriesAllocatedPerStore) ||
    !Number.isSafeInteger(plan?.scopeCookieQueriesRequiredPerStore) ||
    !Number.isSafeInteger(plan?.scopeCookieQueriesRequestedPerStore) ||
    !Number.isSafeInteger(plan?.cookieStoreCount)
  ) {
    const error = new Error('Cleanup-start capacity lacks a valid cookie-query allocation.');
    error.name = 'OperationCapacityExceededError';
    throw error;
  }
  const allocated = Math.min(plan.scopeCookieQueriesAllocatedPerStore, reviewedLimit);
  if (allocated < plan.scopeCookieQueriesRequiredPerStore) {
    const error = new Error(
      'The reviewed cookie-query allocation no longer contains every required origin/domain query.'
    );
    error.name = 'OperationCapacityExceededError';
    throw error;
  }
  if (allocated === plan.scopeCookieQueriesAllocatedPerStore) return plan;
  const reductionPerStore = plan.scopeCookieQueriesAllocatedPerStore - allocated;
  const cleanupPlannedQueries = plan.cleanupPlannedQueries - reductionPerStore * plan.cookieStoreCount;
  const cleanupFits = cleanupPlannedQueries <= plan.cleanupAdmissionLimit;
  return {
    ...plan,
    scopeCookieQueriesAllocatedPerStore: allocated,
    scopeCookieQueriesAllocationOmittedPerStore: Math.max(0, plan.scopeCookieQueriesRequestedPerStore - allocated),
    scopeCookieQueriesOmittedPerStore: Math.max(0, plan.scopeCookieQueriesRequestedPerStore - allocated),
    scopeCookieQueriesTotalOmittedPerStore: Math.max(0, plan.scopeCookieQueriesUncappedRequestedPerStore - allocated),
    scopeCookieQueriesAllocationTruncated: allocated < plan.scopeCookieQueriesRequestedPerStore,
    scopeCookieQueriesTruncated:
      plan.scopeCookieQueriesHardCapTruncated || allocated < plan.scopeCookieQueriesRequestedPerStore,
    scopeCookieQueriesPerStore: allocated,
    cleanupPlannedQueries,
    cleanupFits,
    admitted: plan.observationFits && plan.preflightFits && cleanupFits
  };
}

export function buildCleanupCapacityObservationFromContext(context = {}, settings = {}) {
  const matchingDownloads = Array.isArray(context.matchingDownloads) ? context.matchingDownloads : [];
  const approvedIds = new Set(
    Array.isArray(settings.approvedDownloadFileIds) ? settings.approvedDownloadFileIds.map(String) : []
  );
  const approvedDownloadFileCount =
    settings.deleteDownloadedFiles === true
      ? matchingDownloads.filter((item) => approvedIds.has(String(item?.id))).length
      : 0;
  return {
    matchingTabCount: Array.isArray(context.matchingTabs) ? context.matchingTabs.length : 0,
    matchingDownloadCount: matchingDownloads.length,
    approvedDownloadFileCount,
    cookieStoreCount: Array.isArray(context.cookieStores) ? context.cookieStores.length : 0,
    overlayEligibleTabCount: countOverlayEligibleTabs(context, settings),
    observationComplete:
      Array.isArray(context.matchingTabs) &&
      context.tabEnumerationComplete === true &&
      Array.isArray(context.matchingDownloads) &&
      Array.isArray(context.cookieStores) &&
      context.cookieStoreEnumerationComplete === true &&
      Array.isArray(context.allTabs) &&
      typeof context?.discoveryEvidence?.downloads?.complete === 'boolean'
  };
}

export function assertCleanupQueryStructure(target, settings = {}) {
  const plan = buildCleanupQueryCapacityPlan(target, settings, {
    matchingTabCount: 0,
    matchingDownloadCount: 0,
    approvedDownloadFileCount: 0,
    cookieStoreCount: 1,
    overlayEligibleTabCount: 0,
    observationComplete: true
  });
  if (plan.preflightFits && plan.cleanupFits) return plan;
  throw capacityError(plan, { structural: true });
}

export function assertCleanupQueryCapacity(target, settings = {}, observation = {}) {
  const plan = buildCleanupQueryCapacityPlan(target, settings, observation);
  if (plan.admitted) return plan;
  throw capacityError(plan);
}

function capacityError(plan, { structural = false } = {}) {
  const reasons = [];
  if (!plan.preflightFits) {
    reasons.push(
      `the read-only preflight needs at least ${plan.preflightPlannedQueries} browser queries but its limit is ${plan.preflightQueryLimit}`
    );
  }
  if (!plan.observationComplete && !structural) {
    reasons.push(
      'the read-only browser observation needed to bound tabs, downloads, overlay scope, and cookie stores is incomplete'
    );
  }
  if (plan.cookieStoreCount > plan.cookieStoreLimit) {
    reasons.push(
      `The browser exposed ${plan.cookieStoreCount} cookie stores but the supported bound is ${plan.cookieStoreLimit}`
    );
  }
  if (plan.approvedDownloadFileCount > plan.matchingDownloadCount) {
    reasons.push('the approved downloaded-file count exceeds the observed matching download count');
  }
  if (plan.scopeCookieQueriesRequiredHardCapOmittedPerStore > 0) {
    reasons.push(
      `required origin/domain cookie discovery has an uncapped demand of ${plan.scopeCookieQueriesRequiredUncappedPerStore} queries per store, exceeding the independent ${plan.scopeCookieQueryHardCapPerStore}-query per-store hard cap`
    );
  }
  if (!plan.cleanupFits) {
    if (
      plan.scopeCookieQueriesRequestedPerStore > plan.scopeCookieQueriesRequiredPerStore &&
      plan.scopeCookieQueryCapacityPerStore < plan.scopeCookieQueriesRequiredPerStore
    ) {
      reasons.push(
        `partitioned embedding-site cookie probing requested ${plan.scopeCookieQueriesRequestedPerStore} queries per cookie store, but even the ${plan.scopeCookieQueriesRequiredPerStore} required origin/domain queries per store do not fit the remaining operation capacity`
      );
    }
    reasons.push(
      `${plan.verificationEnabled ? 'cleanup and verification have' : 'cleanup has'} a conservative upper bound of ${plan.cleanupPlannedQueries} browser queries, above the ${plan.cleanupAdmissionLimit}-query pre-mutation admission limit before the safety reserve`
    );
  }
  const error = Object.assign(
    new Error(
      `This cleanup is too large to review safely in one run. SiteWipe's operation budget stopped it before any cleanup could start. Close some matching tabs or downloads, or turn off optional Expert discovery features, then review again. Technical details: ${reasons.join(
        '; '
      )}.`
    ),
    { capacityPlan: plan }
  );
  error.name = 'OperationCapacityExceededError';
  return error;
}

export function cleanupCapacityPreviewLimitations(plan) {
  if (plan?.scopeCookieQueriesTruncated !== true) return [];
  const hardCapOmitted = nonNegativeInteger(plan.scopeCookieQueriesHardCapOmittedPerStore) ?? 0;
  const allocationOmitted = nonNegativeInteger(plan.scopeCookieQueriesAllocationOmittedPerStore) ?? 0;
  const totalOmitted = nonNegativeInteger(plan.scopeCookieQueriesTotalOmittedPerStore) ?? 0;
  return [
    `Optional partitioned-cookie embedding-site discovery has an uncapped worst-case demand of ${plan.scopeCookieQueriesUncappedRequestedPerStore} queries per exposed store. The independent ${plan.scopeCookieQueryHardCapPerStore}-query per-store hard cap omits ${hardCapOmitted}; the reviewed operation allocation then permits at most ${plan.scopeCookieQueriesAllocatedPerStore} queries per store and omits ${allocationOmitted} more (${totalOmitted} total worst-case omissions) so the operation stays within its ${plan.cleanupAdmissionLimit}-query pre-mutation admission limit. Required origin/domain cookie discovery remains included; the actual run may observe fewer origins or partition sites and therefore need fewer optional probes.`
  ];
}

function normalizeCapacityObservation(value, settings) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    matchingTabCount: nonNegativeInteger(input.matchingTabCount) ?? 0,
    matchingDownloadCount: nonNegativeInteger(input.matchingDownloadCount) ?? 0,
    approvedDownloadFileCount:
      settings.deleteDownloadedFiles === true ? (nonNegativeInteger(input.approvedDownloadFileCount) ?? 0) : 0,
    cookieStoreCount: nonNegativeInteger(input.cookieStoreCount) ?? 0,
    overlayEligibleTabCount: nonNegativeInteger(input.overlayEligibleTabCount) ?? 0,
    observationComplete: input.observationComplete === true
  };
}

function maximumScopeCookieInputs(target, settings) {
  const explicitOrigins = [...new Set((target?.baseOrigins || []).filter(Boolean))];
  const explicitPartitionSites = [...new Set((target?.partitionTopLevelSites || []).filter(Boolean))];
  const additionalOriginAllowance = MAX_COOKIE_URL_PROBE_ORIGINS;
  const partitionTopLevelSiteAllowance =
    settings.probePartitionedCookiesWithEmbeddingSites === true ? MAX_PARTITION_TOP_LEVEL_SITES : 0;
  return {
    origins: [
      ...explicitOrigins,
      ...Array.from({ length: additionalOriginAllowance }, (_, index) => `https://capacity-origin-${index}.invalid`)
    ],
    partitionTopLevelSites: [
      ...explicitPartitionSites,
      ...Array.from(
        { length: partitionTopLevelSiteAllowance },
        (_, index) => `https://capacity-partition-${index}.invalid`
      )
    ],
    additionalOriginAllowance,
    partitionTopLevelSiteAllowance
  };
}

function countOverlayEligibleTabs(context, settings) {
  if (settings.progressOverlay !== true) return 0;
  const allTabs = Array.isArray(context.allTabs) ? context.allTabs : [];
  const matchingIds = new Set(
    (Array.isArray(context.matchingTabs) ? context.matchingTabs : [])
      .map((tab) => tab?.id)
      .filter((id) => Number.isInteger(id))
  );
  return allTabs.filter((tab) => {
    if (!Number.isInteger(tab?.id) || tab.discarded) return false;
    if (!String(tab.url || '').match(/^https?:\/\//)) return false;
    if (settings.overlayScope === 'all_tabs') return true;
    if (settings.overlayScope === 'current_window') {
      return Number.isInteger(settings.sourceWindowId) && tab.windowId === settings.sourceWindowId;
    }
    return matchingIds.has(tab.id);
  }).length;
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

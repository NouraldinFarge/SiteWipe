import { urlMatchesTarget } from './domain.js';
import { reviewedFileIds } from '../shared/cleanup-review.js';
import {
  matchingOriginFromUrl,
  matchingOriginsForHost,
  tabMatchesReviewedCleanupTarget,
  tabIsWithinReviewedPrivateScope
} from '../shared/target-scope.js';
import {
  buildCookieDiscoveryQueries,
  cookieHost,
  cookieKey,
  cookieMatchesTarget,
  describeCookieDiscoveryQueryDemand,
  MAX_COOKIE_DISCOVERY_QUERIES,
  safeGetCookies,
  safeGetCookieStores,
  classifyCookieStorePrivateScope
} from './cookies.js';
import {
  createOperationBudget,
  mapWithConcurrency,
  readableMessage,
  sampleArray,
  throwIfCancellationRequested,
  yieldEvery
} from './operation-control.js';
import { discoverMatchingDownloadsWithEvidence, discoverMatchingHistoryWithEvidence } from './record-discovery.js';
import {
  MAX_EMBEDDED_FRAME_DISCOVERY_QUERIES,
  MAX_SUPPORTED_COOKIE_STORES,
  PREFLIGHT_OPERATION_MAX_QUERIES
} from './cleanup-capacity.js';
import { addError, addSection, addUnavailable } from './report.js';

const MAX_ADDITIONAL_DISCOVERED_ORIGINS = 300;
const MAX_PARTITION_TOP_LEVEL_SITES = 50;
const MAX_FRAME_DISCOVERY_TABS = MAX_EMBEDDED_FRAME_DISCOVERY_QUERIES;
const MAX_MATCHING_FRAMES = 100;
const COOKIE_DISCOVERY_CONCURRENCY = 6;
const FRAME_DISCOVERY_CONCURRENCY = 4;
const OPERATION_YIELD_EVERY = 10;
const REPORT_SAMPLE_LIMIT = 50;

export async function inspectCleanupImpact(target, options = {}) {
  const operationBudget =
    options.operationBudget ||
    createOperationBudget({
      label: 'cleanup preflight',
      maxDurationMs: 45_000,
      maxQueries: PREFLIGHT_OPERATION_MAX_QUERIES,
      maxRecords: 100_000
    });
  options = { ...options, operationBudget };
  const discoveryEvidence = { history: null, downloads: null };
  options = { ...options, discoveryEvidence };
  const impact = {
    matchingTabs: null,
    matchingPrivateTabs: null,
    tabEnumerationComplete: false,
    matchingHistoryEntries: null,
    matchingHistoryEntriesLowerBound: null,
    matchingDownloadRecords: null,
    matchingDownloadRecordsLowerBound: null,
    matchedCompletedFileCount: null,
    matchedCompletedFileIds: null,
    cookieStoreCount: null,
    cookieStoreEnumerationComplete: false,
    overlayEligibleTabs: null,
    discoveryEvidence,
    limitations: []
  };

  const tasks = [];
  if (chrome.tabs?.query) {
    tasks.push(
      (async () => {
        try {
          operationBudget.claimQuery('preflight tab discovery');
          const tabs = await chrome.tabs.query({});
          if (!Array.isArray(tabs)) throw new Error('chrome.tabs.query returned a malformed tab list.');
          operationBudget.observeRecords(tabs?.length || 0, 'preflight tab discovery results');
          const reviewedTabs = (tabs || []).filter((tab) =>
            tabIsWithinReviewedPrivateScope(tab, options.incognitoAccess === true)
          );
          const matching = reviewedTabs.filter(
            (tab) =>
              Number.isInteger(tab?.id) &&
              tabMatchesReviewedCleanupTarget(tab, target, options.incognitoAccess === true)
          );
          impact.matchingTabs = matching.length;
          impact.matchingPrivateTabs = matching.filter((tab) => tab.incognito).length;
          impact.overlayEligibleTabs = countOverlayEligibleTabs(reviewedTabs, matching, options);
          impact.tabEnumerationComplete = true;
        } catch (error) {
          impact.limitations.push(`Open-tab impact could not be counted: ${readableMessage(error)}`);
        }
      })()
    );
  } else {
    impact.limitations.push('Open-tab impact could not be counted because chrome.tabs.query is unavailable.');
  }

  if (chrome.cookies?.getAllCookieStores) {
    tasks.push(
      (async () => {
        try {
          operationBudget.claimQuery('preflight cookie-store discovery');
          const result = await safeGetCookieStores();
          operationBudget.observeRecords(result.stores.length, 'preflight cookie-store discovery results');
          if (!result.ok) throw new Error(result.error || 'Cookie stores could not be enumerated.');
          impact.cookieStoreCount = result.stores.length;
          impact.cookieStoreEnumerationComplete = true;
        } catch (error) {
          impact.limitations.push(`Cookie-store impact could not be counted: ${readableMessage(error)}`);
        }
      })()
    );
  } else {
    impact.cookieStoreCount = 0;
    impact.cookieStoreEnumerationComplete = true;
    impact.limitations.push('Cookie-store impact is zero because chrome.cookies.getAllCookieStores is unavailable.');
  }

  if (chrome.history?.search) {
    tasks.push(
      (async () => {
        try {
          const result = await discoverMatchingHistoryWithEvidence(target, options);
          impact.discoveryEvidence.history = result.evidence;
          impact.matchingHistoryEntriesLowerBound = result.items.length;
          impact.matchingHistoryEntries = result.evidence.complete ? result.items.length : null;
          if (!result.evidence.complete) impact.limitations.push(...result.evidence.limitations);
        } catch (error) {
          if (error?.discoveryEvidence) impact.discoveryEvidence.history = error.discoveryEvidence;
          impact.limitations.push(`History impact could not be counted: ${readableMessage(error)}`);
        }
      })()
    );
  } else {
    impact.limitations.push('History impact could not be counted because chrome.history.search is unavailable.');
  }

  if (chrome.downloads?.search) {
    tasks.push(
      (async () => {
        try {
          const result = await discoverMatchingDownloadsWithEvidence(target, options);
          const fileIds = reviewedFileIds(result.items);
          impact.discoveryEvidence.downloads = result.evidence;
          impact.matchingDownloadRecordsLowerBound = result.items.length;
          impact.matchingDownloadRecords = result.evidence.complete ? result.items.length : null;
          // An incomplete download search cannot bind a complete candidate set
          // for irreversible on-disk deletion. Record cleanup remains limited
          // to the positively discovered matches at execution time.
          impact.matchedCompletedFileIds = result.evidence.complete ? fileIds : null;
          impact.matchedCompletedFileCount = result.evidence.complete ? fileIds.length : null;
          if (!result.evidence.complete) impact.limitations.push(...result.evidence.limitations);
        } catch (error) {
          if (error?.discoveryEvidence) impact.discoveryEvidence.downloads = error.discoveryEvidence;
          impact.limitations.push(`Download impact could not be counted: ${readableMessage(error)}`);
        }
      })()
    );
  } else {
    impact.limitations.push(
      'Download impact could not be counted because chrome.downloads.search is unavailable. No on-disk file removal will be authorized.'
    );
  }

  await Promise.all(tasks);
  impact.operationBudget = operationBudget.snapshot();
  return impact;
}

export function boundCleanupOrigins(
  explicitValues = [],
  discoveredValues = [],
  additionalLimit = MAX_ADDITIONAL_DISCOVERED_ORIGINS
) {
  const explicitOrigins = [...new Set((explicitValues || []).filter(Boolean))].sort();
  const explicitOriginSet = new Set(explicitOrigins);
  const additionalOrigins = [...new Set((discoveredValues || []).filter(Boolean))]
    .filter((origin) => !explicitOriginSet.has(origin))
    .sort();
  const safeLimit = Math.max(0, Number.parseInt(additionalLimit, 10) || 0);
  const cappedAdditionalOrigins = additionalOrigins.slice(0, safeLimit);
  return {
    origins: [...explicitOrigins, ...cappedAdditionalOrigins],
    explicitOrigins,
    additionalOrigins: cappedAdditionalOrigins,
    omittedAdditionalOriginCount: Math.max(0, additionalOrigins.length - cappedAdditionalOrigins.length),
    additionalLimit: safeLimit
  };
}

export async function discoverCleanupScope(target, report, options = {}) {
  const discoveryEvidence = {
    history: null,
    downloads: null,
    frames: {
      tabsAvailable: 0,
      tabsInspected: 0,
      tabsOmitted: 0,
      framesObserved: 0,
      matchesOmitted: 0,
      capReached: false,
      failures: 0
    },
    cookies: {
      queriesUncappedRequested: 0,
      queryHardCapPerStore: MAX_COOKIE_DISCOVERY_QUERIES,
      hardCapOmittedQueries: 0,
      queriesRequested: 0,
      queriesAllocated: 0,
      allocationOmittedQueries: 0,
      totalOmittedQueries: 0,
      requiredQueriesUncapped: 0,
      requiredQueriesPlanned: 0,
      queriesPlanned: 0,
      queriesRun: 0,
      queriesOmitted: 0,
      recordsObserved: 0,
      queryCapReached: false,
      hardCapTruncated: false,
      allocationTruncated: false
    }
  };
  options = { ...options, discoveryEvidence };
  const origins = new Set(target.baseOrigins);
  const cookieHosts = new Set();
  const partitionTopLevelSites = new Set(target.partitionTopLevelSites || []);
  const probedPartitionTopLevelSites = new Set();
  const cookieCandidates = [];
  const cookieQueryFailures = [];
  const storeStats = [];
  let cookieStores = [];
  let cookieStoreEnumerationComplete = !chrome.cookies;
  let allTabs = [];
  let tabEnumerationComplete = false;
  let tabPrivateScopeById = new Map();
  let matchingTabs = [];
  let matchingFrames = [];
  let matchingHistory = [];
  let matchingDownloads = [];
  let queryCapacityPlan = null;
  let capacityObservationEmitted = false;

  try {
    await throwIfCancellationRequested(options.shouldCancel, 'tab discovery');
    options.operationBudget?.claimQuery('tab discovery');
    const queriedTabs = await chrome.tabs.query({});
    if (!Array.isArray(queriedTabs)) throw new Error('chrome.tabs.query returned a malformed tab list.');
    options.operationBudget?.observeRecords(queriedTabs?.length || 0, 'tab discovery results');
    tabEnumerationComplete = true;
    tabPrivateScopeById = new Map(
      (queriedTabs || []).filter((tab) => Number.isInteger(tab?.id)).map((tab) => [tab.id, tab.incognito === true])
    );
    allTabs = (queriedTabs || []).filter((tab) =>
      tabIsWithinReviewedPrivateScope(tab, options.incognitoAccess === true)
    );
    matchingTabs = allTabs.filter(
      (tab) => tab.id && tabMatchesReviewedCleanupTarget(tab, target, options.incognitoAccess === true)
    );
    for (const tab of matchingTabs) {
      addOriginFromUrl(origins, tab.url, target);
      addPartitionTopLevelSiteFromUrl(partitionTopLevelSites, tab.url);
    }
  } catch (error) {
    rethrowControlError(error);
    addError(report, 'Discover matching open tabs', error);
  }

  if (options.embeddedFrameDiscovery === true && chrome.webNavigation?.getAllFrames && allTabs.length) {
    try {
      matchingFrames = await discoverMatchingFrames(
        target,
        allTabs,
        options.incognitoAccess,
        discoveryEvidence.frames,
        options
      );
      for (const frame of matchingFrames) {
        addOriginFromUrl(origins, frame.url, target);
        addPartitionTopLevelSiteFromUrl(partitionTopLevelSites, frame.tabUrl);
      }
    } catch (error) {
      rethrowControlError(error);
      addError(report, 'Discover matching embedded frames', error);
    }
  }

  if (chrome.history) {
    try {
      const result = await discoverMatchingHistoryWithEvidence(target, options);
      matchingHistory = result.items;
      discoveryEvidence.history = result.evidence;
      for (const item of matchingHistory) addOriginFromUrl(origins, item.url, target);
    } catch (error) {
      if (error?.discoveryEvidence) discoveryEvidence.history = error.discoveryEvidence;
      rethrowControlError(error);
      addError(report, 'Discover matching history URLs', error);
    }
  }

  if (chrome.downloads) {
    try {
      const result = await discoverMatchingDownloadsWithEvidence(target, options);
      matchingDownloads = result.items;
      discoveryEvidence.downloads = result.evidence;
      for (const item of matchingDownloads) {
        addOriginFromUrl(origins, item.url, target);
        addOriginFromUrl(origins, item.finalUrl, target);
        addOriginFromUrl(origins, item.referrer, target);
        addPartitionTopLevelSiteFromUrl(partitionTopLevelSites, item.referrer);
      }
    } catch (error) {
      if (error?.discoveryEvidence) discoveryEvidence.downloads = error.discoveryEvidence;
      rethrowControlError(error);
      addError(report, 'Discover matching download URLs', error);
    }
  }

  // The sessions permission is intentionally absent. Recently closed metadata
  // has no targeted forget API and does not justify default history visibility.
  const matchingRecentlyClosed = [];

  if (chrome.cookies) {
    try {
      await throwIfCancellationRequested(options.shouldCancel, 'cookie-store discovery');
      options.operationBudget?.claimQuery('cookie-store discovery');
      const storesResult = await safeGetCookieStores();
      options.operationBudget?.observeRecords(storesResult.stores.length, 'cookie-store discovery results');
      if (!storesResult.ok) {
        cookieQueryFailures.push({
          source: 'cookie-stores',
          storeId: null,
          message: storesResult.error
        });
      }
      cookieStores = storesResult.stores;
      cookieStoreEnumerationComplete = storesResult.ok;
      queryCapacityPlan = await emitCapacityObservation();
      if (cookieStores.length > MAX_SUPPORTED_COOKIE_STORES) {
        cookieQueryFailures.push({
          source: 'cookie-stores-capacity',
          storeId: null,
          message: `The browser exposed ${cookieStores.length} cookie stores, exceeding SiteWipe's reviewed bound of ${MAX_SUPPORTED_COOKIE_STORES}. Cookie discovery was not started.`
        });
      }
      for (const store of cookieStores.slice(0, MAX_SUPPORTED_COOKIE_STORES)) {
        await throwIfCancellationRequested(options.shouldCancel, 'the next cookie store');
        options.operationBudget?.check('the next cookie store');
        const privateScope = await classifyCookieStorePrivateScope(store, {
          ...options,
          tabPrivateScopeById
        });
        const isIncognitoStore = privateScope === 'incognito';
        const storeInfo = {
          storeId: store.id,
          incognito: isIncognitoStore,
          privateScope,
          tabIds: store.tabIds?.length || 0,
          candidates: 0
        };
        storeStats.push(storeInfo);
        if (!options.incognitoAccess && privateScope !== 'regular') {
          if (privateScope === 'unknown') {
            cookieQueryFailures.push({
              source: 'cookie-store-private-scope',
              storeId: store.id,
              message: 'Cookie-store private scope could not be verified, so the store was skipped.'
            });
          }
          continue;
        }

        const queryDemand = describeCookieDiscoveryQueryDemand(target, origins, partitionTopLevelSites, options);
        const requestedQueries = buildCookieDiscoveryQueries(
          target,
          store.id,
          origins,
          partitionTopLevelSites,
          options
        );
        const requiredDemand = describeCookieDiscoveryQueryDemand(target, origins, partitionTopLevelSites, {
          ...options,
          probePartitionedCookiesWithEmbeddingSites: false
        });
        const requiredQueries = buildCookieDiscoveryQueries(target, store.id, origins, partitionTopLevelSites, {
          ...options,
          probePartitionedCookiesWithEmbeddingSites: false
        });
        if (
          requestedQueries.length !== queryDemand.hardCappedRequestedQueries ||
          requiredQueries.length !== requiredDemand.hardCappedRequestedQueries
        ) {
          throw new Error('Cookie-query demand metadata no longer matches the bounded executable query list.');
        }
        const admittedPerStore = queryCapacityPlan?.scopeCookieQueriesAllocatedPerStore;
        if (admittedPerStore != null && (!Number.isSafeInteger(admittedPerStore) || admittedPerStore < 0)) {
          throw new Error('Cleanup-start capacity returned a malformed cookie-query allocation.');
        }
        if (
          requestedQueries.length > requiredQueries.length &&
          admittedPerStore != null &&
          admittedPerStore < requiredQueries.length
        ) {
          throw new Error('Cleanup-start capacity would truncate required origin/domain cookie discovery.');
        }
        const queryLimit =
          admittedPerStore == null ? requestedQueries.length : Math.min(requestedQueries.length, admittedPerStore);
        const queries = requestedQueries.slice(0, queryLimit);
        const allocationOmittedQueries = requestedQueries.length - queries.length;
        const totalOmittedQueries = queryDemand.hardCapOmittedQueries + allocationOmittedQueries;
        discoveryEvidence.cookies.queriesUncappedRequested += queryDemand.uncappedRequestedQueries;
        discoveryEvidence.cookies.hardCapOmittedQueries += queryDemand.hardCapOmittedQueries;
        discoveryEvidence.cookies.queriesRequested += requestedQueries.length;
        discoveryEvidence.cookies.queriesAllocated += queries.length;
        discoveryEvidence.cookies.allocationOmittedQueries += allocationOmittedQueries;
        discoveryEvidence.cookies.totalOmittedQueries += totalOmittedQueries;
        discoveryEvidence.cookies.requiredQueriesUncapped += requiredDemand.requiredQueries;
        discoveryEvidence.cookies.requiredQueriesPlanned += requiredQueries.length;
        discoveryEvidence.cookies.queriesPlanned += queries.length;
        // Legacy alias retained for existing report consumers; unlike
        // totalOmittedQueries, this is only the operation-allocation omission.
        discoveryEvidence.cookies.queriesOmitted += allocationOmittedQueries;
        if (queryDemand.hardCapOmittedQueries > 0) discoveryEvidence.cookies.hardCapTruncated = true;
        if (allocationOmittedQueries > 0) discoveryEvidence.cookies.allocationTruncated = true;
        if (queryDemand.hardCapOmittedQueries > 0 || allocationOmittedQueries > 0) {
          discoveryEvidence.cookies.queryCapReached = true;
        }
        const seen = new Set();
        await mapWithConcurrency(queries, COOKIE_DISCOVERY_CONCURRENCY, async (query, queryIndex) => {
          await yieldEvery(queryIndex, OPERATION_YIELD_EVERY);
          await throwIfCancellationRequested(options.shouldCancel, 'the next cookie discovery query');
          options.operationBudget?.claimQuery('cookie discovery');
          const probedTopLevelSite = query.details?.partitionKey?.topLevelSite;
          if (typeof probedTopLevelSite === 'string' && probedTopLevelSite) {
            probedPartitionTopLevelSites.add(probedTopLevelSite);
          }
          const result = await safeGetCookies(query.details);
          discoveryEvidence.cookies.queriesRun += 1;
          if (!result.ok) {
            cookieQueryFailures.push({
              source: query.source,
              storeId: store.id,
              message: result.error
            });
            return;
          }
          options.operationBudget?.observeRecords(result.cookies.length, 'cookie discovery results');
          discoveryEvidence.cookies.recordsObserved += result.cookies.length;
          for (const cookie of result.cookies) {
            if (!cookieMatchesTarget(cookie, target)) continue;
            const key = cookieKey(cookie, store.id);
            if (seen.has(key)) continue;
            seen.add(key);
            cookieCandidates.push({
              cookie,
              storeId: store.id,
              source: query.source
            });
            storeInfo.candidates += 1;
            const host = cookieHost(cookie);
            if (host) {
              cookieHosts.add(host);
              addOriginsForHost(origins, host, target);
            }
            if (cookie.partitionKey?.topLevelSite) {
              addOriginFromTopLevelSite(origins, cookie.partitionKey.topLevelSite, target);
              partitionTopLevelSites.add(cookie.partitionKey.topLevelSite);
            }
          }
        });
      }
    } catch (error) {
      rethrowControlError(error);
      addError(report, 'Discover matching cookies', error);
    }
  }

  if (!capacityObservationEmitted) queryCapacityPlan = await emitCapacityObservation();

  // Explicit origins come from the primary and every configured, preflight-bound
  // associated target. The cap applies only to browser-discovered additions.
  const boundedOrigins = boundCleanupOrigins(target.baseOrigins, [...origins], MAX_ADDITIONAL_DISCOVERED_ORIGINS);
  const explicitOrigins = boundedOrigins.explicitOrigins;
  const cappedAdditionalOrigins = boundedOrigins.additionalOrigins;
  const cappedOrigins = boundedOrigins.origins;
  const wasCapped = boundedOrigins.omittedAdditionalOriginCount > 0;
  const exactProbedPartitionTopLevelSites = [...probedPartitionTopLevelSites].sort();
  discoveryEvidence.cookies.partitionTopLevelSitesProbed = exactProbedPartitionTopLevelSites;
  report.summary.discoveredOrigins = cappedOrigins.length;
  report.summary.discoveredCookieHosts = cookieHosts.size;
  report.summary.matchingFramesDiscovered = matchingFrames.length;
  report.summary.partitionTopLevelSitesProbed = exactProbedPartitionTopLevelSites.length;
  report.summary.cookieQueriesUncappedRequested = discoveryEvidence.cookies.queriesUncappedRequested;
  report.summary.cookieQueriesHardCapOmitted = discoveryEvidence.cookies.hardCapOmittedQueries;
  report.summary.cookieQueriesAllocated = discoveryEvidence.cookies.queriesAllocated;
  report.summary.cookieQueriesAllocationOmitted = discoveryEvidence.cookies.allocationOmittedQueries;
  report.summary.cookieQueriesTotalOmitted = discoveryEvidence.cookies.totalOmittedQueries;
  report.summary.cookieQueriesRun = discoveryEvidence.cookies.queriesRun;
  report.summary.incognitoScopeObserved = Boolean(
    matchingTabs.some((tab) => tab.incognito) ||
    matchingFrames.some((frame) => frame.tabIncognito) ||
    storeStats.some((store) => store.incognito && store.candidates > 0)
  );

  const discoveryPartial = Boolean(
    wasCapped ||
    cookieQueryFailures.length ||
    discoveryEvidence.cookies.hardCapTruncated ||
    discoveryEvidence.cookies.allocationTruncated ||
    discoveryEvidence.history?.complete !== true ||
    discoveryEvidence.downloads?.complete !== true ||
    discoveryEvidence.frames.capReached ||
    discoveryEvidence.frames.failures
  );
  addSection(report, 'scopeDiscovery', 'Target scope discovered', discoveryPartial ? 'partial' : 'success', {
    targetDomain: target.domain,
    matchMode: target.matchMode || 'registrable_domain',
    exactOrigin: target.exactOrigin || null,
    origins: sampleArray(cappedOrigins),
    originCount: cappedOrigins.length,
    explicitReviewedOriginCount: explicitOrigins.length,
    additionalDiscoveredOriginCount: cappedAdditionalOrigins.length,
    additionalDiscoveryLimit: MAX_ADDITIONAL_DISCOVERED_ORIGINS,
    originsTruncated: cappedOrigins.length > REPORT_SAMPLE_LIMIT,
    originLimitReached: wasCapped,
    matchingTabs: matchingTabs.length,
    matchingFrames: matchingFrames.length,
    matchingHistoryUrls: matchingHistory.length,
    matchingHistoryCountComplete: discoveryEvidence.history?.complete === true,
    matchingDownloadRecords: matchingDownloads.length,
    matchingDownloadCountComplete: discoveryEvidence.downloads?.complete === true,
    matchingRecentlyClosedSessions: matchingRecentlyClosed.length,
    matchingCookieCandidates: cookieCandidates.length,
    cookieQueriesUncappedRequested: discoveryEvidence.cookies.queriesUncappedRequested,
    cookieQueryHardCapPerStore: discoveryEvidence.cookies.queryHardCapPerStore,
    cookieQueriesHardCapOmitted: discoveryEvidence.cookies.hardCapOmittedQueries,
    cookieQueriesRequested: discoveryEvidence.cookies.queriesRequested,
    cookieQueriesAllocated: discoveryEvidence.cookies.queriesAllocated,
    cookieQueriesAllocationOmitted: discoveryEvidence.cookies.allocationOmittedQueries,
    cookieQueriesTotalOmitted: discoveryEvidence.cookies.totalOmittedQueries,
    cookieRequiredQueriesUncapped: discoveryEvidence.cookies.requiredQueriesUncapped,
    cookieRequiredQueriesPlanned: discoveryEvidence.cookies.requiredQueriesPlanned,
    cookieQueriesPlanned: discoveryEvidence.cookies.queriesPlanned,
    cookieQueriesRun: discoveryEvidence.cookies.queriesRun,
    cookieQueriesOmitted: discoveryEvidence.cookies.queriesOmitted,
    cookieQueryHardCapTruncated: discoveryEvidence.cookies.hardCapTruncated,
    cookieQueryAllocationTruncated: discoveryEvidence.cookies.allocationTruncated,
    matchingCookieHosts: sampleArray([...cookieHosts].sort()),
    matchingCookieHostsTruncated: cookieHosts.size > REPORT_SAMPLE_LIMIT,
    partitionTopLevelSites: sampleArray(exactProbedPartitionTopLevelSites),
    partitionTopLevelSiteCount: exactProbedPartitionTopLevelSites.length,
    partitionTopLevelSitesObserved: sampleArray(
      [...partitionTopLevelSites].sort().slice(0, MAX_PARTITION_TOP_LEVEL_SITES)
    ),
    partitionTopLevelSitesObservedCount: partitionTopLevelSites.size,
    cookieQueryFailures: cookieQueryFailures.slice(0, 20),
    discoveryEvidence,
    note: 'Every explicit origin from the primary and configured, preflight-bound associated targets is retained. Required origin/domain cookie discovery is retained. Optional partitioned-cookie embedding-site probes first use the independent 1,500-query per-store hard cap and then only their pre-mutation operation allocation; uncapped demand, hard-cap omissions, allocation omissions, total omissions, and executed allocation are reported separately. Additional discovery from matching tabs, optional embedded frames, history URLs, download URLs, cookie-host URL probes, cookie hosts, and optional embedding top-level sites is bounded to keep the browser responsive. Recently closed metadata is not read because the sessions permission is not requested.'
  });

  if (discoveryEvidence.cookies.hardCapTruncated) {
    addUnavailable(
      report,
      'Optional partitioned-cookie probe hard cap',
      `${discoveryEvidence.cookies.hardCapOmittedQueries} optional cookie probe quer${
        discoveryEvidence.cookies.hardCapOmittedQueries === 1 ? 'y was' : 'ies were'
      } omitted by the independent ${MAX_COOKIE_DISCOVERY_QUERIES}-query per-store hard cap before operation-budget allocation. The uncapped bounded-input demand was ${discoveryEvidence.cookies.queriesUncappedRequested}; ${discoveryEvidence.cookies.queriesRequested} hard-capped queries remained eligible for allocation.`
    );
  }

  if (discoveryEvidence.cookies.allocationTruncated) {
    addUnavailable(
      report,
      'Optional partitioned-cookie embedding-site probes',
      `${discoveryEvidence.cookies.allocationOmittedQueries} optional cookie probe quer${
        discoveryEvidence.cookies.allocationOmittedQueries === 1 ? 'y was' : 'ies were'
      } omitted by the reviewed pre-mutation allocation. All ${
        discoveryEvidence.cookies.requiredQueriesPlanned
      } required origin/domain cookie queries remained included. Across the independent per-store hard cap and operation allocation, ${discoveryEvidence.cookies.totalOmittedQueries} worst-case query combinations were omitted.`
    );
  }

  if (wasCapped) {
    addUnavailable(
      report,
      'Additional discovered origins',
      `More than ${MAX_ADDITIONAL_DISCOVERED_ORIGINS} extra matching origins were found beyond the explicit preflight-bound target origins. Extra discovery was capped; every explicit preflight-bound origin remained included.`
    );
  }

  return {
    origins: cappedOrigins,
    matchingTabs,
    matchingFrames,
    matchingHistory,
    matchingDownloads,
    matchingRecentlyClosed,
    cookieCandidates,
    cookieStores,
    cookieStoreEnumerationComplete,
    tabEnumerationComplete,
    allTabs,
    tabPrivateScopeById,
    partitionTopLevelSites: [...partitionTopLevelSites].sort().slice(0, MAX_PARTITION_TOP_LEVEL_SITES),
    probedPartitionTopLevelSites: exactProbedPartitionTopLevelSites,
    storeStats,
    discoveryEvidence,
    queryCapacityPlan
  };

  async function emitCapacityObservation() {
    if (capacityObservationEmitted) return queryCapacityPlan;
    capacityObservationEmitted = true;
    if (typeof options.onCapacityObservation !== 'function') return null;
    return options.onCapacityObservation({
      matchingTabs,
      matchingDownloads,
      cookieStores,
      cookieStoreEnumerationComplete,
      tabEnumerationComplete,
      allTabs,
      discoveryEvidence
    });
  }
}

function countOverlayEligibleTabs(allTabs, matchingTabs, options) {
  if (options.progressOverlay !== true) return 0;
  const matchingIds = new Set((matchingTabs || []).map((tab) => tab?.id).filter((id) => Number.isInteger(id)));
  return (allTabs || []).filter((tab) => {
    if (!Number.isInteger(tab?.id) || tab.discarded) return false;
    if (!/^https?:\/\//.test(String(tab.url || ''))) return false;
    if (options.overlayScope === 'all_tabs') return true;
    if (options.overlayScope === 'current_window' && Number.isInteger(options.sourceWindowId)) {
      return tab.windowId === options.sourceWindowId;
    }
    return matchingIds.has(tab.id);
  }).length;
}

async function discoverMatchingFrames(target, tabs, incognitoAccess, evidence, options = {}) {
  const matches = [];
  const availableTabs = (tabs || []).filter((tab) => Number.isInteger(tab.id) && (!tab.incognito || incognitoAccess));
  const inspectableTabs = availableTabs.slice(0, MAX_FRAME_DISCOVERY_TABS);
  evidence.tabsAvailable = availableTabs.length;
  evidence.tabsInspected = inspectableTabs.length;
  evidence.tabsOmitted = Math.max(0, availableTabs.length - inspectableTabs.length);
  if (evidence.tabsOmitted) evidence.capReached = true;

  await mapWithConcurrency(inspectableTabs, FRAME_DISCOVERY_CONCURRENCY, async (tab, index) => {
    if (matches.length >= MAX_MATCHING_FRAMES) {
      evidence.capReached = true;
      return;
    }
    await yieldEvery(index, OPERATION_YIELD_EVERY);
    await throwIfCancellationRequested(options.shouldCancel, 'the next embedded-frame discovery query');
    try {
      options.operationBudget?.claimQuery('embedded-frame discovery');
      const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
      options.operationBudget?.observeRecords(frames?.length || 0, 'embedded-frame discovery results');
      evidence.framesObserved += frames?.length || 0;
      for (const frame of frames || []) {
        if (matches.length >= MAX_MATCHING_FRAMES) {
          evidence.capReached = true;
          evidence.matchesOmitted += 1;
          continue;
        }
        if (!frame?.url || !urlMatchesTarget(frame.url, target)) continue;
        matches.push({
          tabId: tab.id,
          frameId: frame.frameId,
          parentFrameId: frame.parentFrameId,
          url: frame.url,
          tabUrl: tab.url || '',
          tabIncognito: Boolean(tab.incognito)
        });
      }
    } catch (error) {
      if (error?.name === 'OperationBudgetExceededError' || error?.name === 'AbortError') throw error;
      evidence.failures += 1;
      // Restricted, closed, or browser-internal tabs are not inspectable.
    }
  });

  return matches.slice(0, MAX_MATCHING_FRAMES);
}

function rethrowControlError(error) {
  if (
    error?.name === 'OperationBudgetExceededError' ||
    error?.name === 'OperationCapacityExceededError' ||
    error?.name === 'AbortError'
  ) {
    throw error;
  }
}

function addOriginFromUrl(origins, urlValue, target) {
  const origin = matchingOriginFromUrl(urlValue, target);
  if (origin) origins.add(origin);
}

function addOriginFromTopLevelSite(origins, topLevelSite, target) {
  const origin = matchingOriginFromUrl(topLevelSite, target);
  if (origin) origins.add(origin);
}

function addPartitionTopLevelSiteFromUrl(partitionTopLevelSites, urlValue) {
  if (!urlValue) return;
  try {
    const url = new URL(urlValue);
    if (!['http:', 'https:'].includes(url.protocol)) return;
    partitionTopLevelSites.add(url.origin);
  } catch {
    // Ignore invalid or browser-internal URLs.
  }
}

function addOriginsForHost(origins, hostname, target) {
  for (const origin of matchingOriginsForHost(hostname, target)) origins.add(origin);
}

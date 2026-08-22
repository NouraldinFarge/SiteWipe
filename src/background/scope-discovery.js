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
import { discoverMatchingDownloads, discoverMatchingHistory } from './record-discovery.js';
import { addError, addSection, addUnavailable } from './report.js';

const MAX_ADDITIONAL_DISCOVERED_ORIGINS = 300;
const MAX_PARTITION_TOP_LEVEL_SITES = 50;
const MAX_FRAME_DISCOVERY_TABS = 60;
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
      maxQueries: 750,
      maxRecords: 100_000
    });
  options = { ...options, operationBudget };
  const impact = {
    matchingTabs: null,
    matchingPrivateTabs: null,
    matchingHistoryEntries: null,
    matchingDownloadRecords: null,
    matchedCompletedFileCount: null,
    matchedCompletedFileIds: null,
    limitations: []
  };

  const tasks = [];
  if (chrome.tabs?.query) {
    tasks.push(
      (async () => {
        try {
          operationBudget.claimQuery('preflight tab discovery');
          const tabs = await chrome.tabs.query({});
          operationBudget.observeRecords(tabs?.length || 0, 'preflight tab discovery results');
          const matching = (tabs || []).filter(
            (tab) =>
              Number.isInteger(tab?.id) &&
              tabMatchesReviewedCleanupTarget(tab, target, options.incognitoAccess === true)
          );
          impact.matchingTabs = matching.length;
          impact.matchingPrivateTabs = matching.filter((tab) => tab.incognito).length;
        } catch (error) {
          impact.limitations.push(`Open-tab impact could not be counted: ${readableMessage(error)}`);
        }
      })()
    );
  } else {
    impact.limitations.push('Open-tab impact could not be counted because chrome.tabs.query is unavailable.');
  }

  if (chrome.history?.search) {
    tasks.push(
      (async () => {
        try {
          impact.matchingHistoryEntries = (await discoverMatchingHistory(target, options)).length;
        } catch (error) {
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
          const downloads = await discoverMatchingDownloads(target, options);
          const fileIds = reviewedFileIds(downloads);
          impact.matchingDownloadRecords = downloads.length;
          impact.matchedCompletedFileIds = fileIds;
          impact.matchedCompletedFileCount = fileIds.length;
        } catch (error) {
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
      queriesPlanned: 0,
      queriesRun: 0,
      recordsObserved: 0,
      queryCapReached: false
    }
  };
  options = { ...options, discoveryEvidence };
  const origins = new Set(target.baseOrigins);
  const cookieHosts = new Set();
  const partitionTopLevelSites = new Set(target.partitionTopLevelSites || []);
  const cookieCandidates = [];
  const cookieQueryFailures = [];
  const storeStats = [];
  let cookieStores = [];
  let allTabs = [];
  let matchingTabs = [];
  let matchingFrames = [];
  let matchingHistory = [];
  let matchingDownloads = [];

  try {
    await throwIfCancellationRequested(options.shouldCancel, 'tab discovery');
    options.operationBudget?.claimQuery('tab discovery');
    const queriedTabs = await chrome.tabs.query({});
    options.operationBudget?.observeRecords(queriedTabs?.length || 0, 'tab discovery results');
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
      matchingHistory = await discoverMatchingHistory(target, options);
      for (const item of matchingHistory) addOriginFromUrl(origins, item.url, target);
    } catch (error) {
      rethrowControlError(error);
      addError(report, 'Discover matching history URLs', error);
    }
  }

  if (chrome.downloads) {
    try {
      matchingDownloads = await discoverMatchingDownloads(target, options);
      for (const item of matchingDownloads) {
        addOriginFromUrl(origins, item.url, target);
        addOriginFromUrl(origins, item.finalUrl, target);
        addOriginFromUrl(origins, item.referrer, target);
        addPartitionTopLevelSiteFromUrl(partitionTopLevelSites, item.referrer);
      }
    } catch (error) {
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
      for (const store of cookieStores) {
        await throwIfCancellationRequested(options.shouldCancel, 'the next cookie store');
        options.operationBudget?.check('the next cookie store');
        const privateScope = await classifyCookieStorePrivateScope(store, options);
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

        const queries = buildCookieDiscoveryQueries(target, store.id, origins, partitionTopLevelSites, options);
        discoveryEvidence.cookies.queriesPlanned += queries.length;
        if (queries.length >= MAX_COOKIE_DISCOVERY_QUERIES) discoveryEvidence.cookies.queryCapReached = true;
        const seen = new Set();
        await mapWithConcurrency(queries, COOKIE_DISCOVERY_CONCURRENCY, async (query, queryIndex) => {
          await yieldEvery(queryIndex, OPERATION_YIELD_EVERY);
          await throwIfCancellationRequested(options.shouldCancel, 'the next cookie discovery query');
          options.operationBudget?.claimQuery('cookie discovery');
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

  // Explicit origins come from the primary and every configured, preflight-bound
  // associated target. The cap applies only to browser-discovered additions.
  const boundedOrigins = boundCleanupOrigins(target.baseOrigins, [...origins], MAX_ADDITIONAL_DISCOVERED_ORIGINS);
  const explicitOrigins = boundedOrigins.explicitOrigins;
  const cappedAdditionalOrigins = boundedOrigins.additionalOrigins;
  const cappedOrigins = boundedOrigins.origins;
  const wasCapped = boundedOrigins.omittedAdditionalOriginCount > 0;
  report.summary.discoveredOrigins = cappedOrigins.length;
  report.summary.discoveredCookieHosts = cookieHosts.size;
  report.summary.matchingFramesDiscovered = matchingFrames.length;
  report.summary.partitionTopLevelSitesProbed = Math.min(partitionTopLevelSites.size, MAX_PARTITION_TOP_LEVEL_SITES);
  report.summary.incognitoScopeObserved = Boolean(
    matchingTabs.some((tab) => tab.incognito) ||
    matchingFrames.some((frame) => frame.tabIncognito) ||
    storeStats.some((store) => store.incognito && store.candidates > 0)
  );

  const discoveryPartial = Boolean(
    wasCapped ||
    cookieQueryFailures.length ||
    discoveryEvidence.history?.queryResultCapReached ||
    discoveryEvidence.history?.matchCapReached ||
    discoveryEvidence.downloads?.queryResultCapReached ||
    discoveryEvidence.downloads?.matchCapReached ||
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
    matchingDownloadRecords: matchingDownloads.length,
    matchingRecentlyClosedSessions: matchingRecentlyClosed.length,
    matchingCookieCandidates: cookieCandidates.length,
    matchingCookieHosts: sampleArray([...cookieHosts].sort()),
    matchingCookieHostsTruncated: cookieHosts.size > REPORT_SAMPLE_LIMIT,
    partitionTopLevelSites: sampleArray([...partitionTopLevelSites].sort().slice(0, MAX_PARTITION_TOP_LEVEL_SITES)),
    partitionTopLevelSiteCount: partitionTopLevelSites.size,
    cookieQueryFailures: cookieQueryFailures.slice(0, 20),
    discoveryEvidence,
    note: 'Every explicit origin from the primary and configured, preflight-bound associated targets is retained. Additional discovery from matching tabs, optional embedded frames, history URLs, download URLs, cookie-host URL probes, cookie hosts, and optional embedding top-level sites is bounded to keep Chrome responsive. Recently closed metadata is not read because the sessions permission is not requested.'
  });

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
    partitionTopLevelSites: [...partitionTopLevelSites].sort().slice(0, MAX_PARTITION_TOP_LEVEL_SITES),
    storeStats
  };
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
  if (error?.name === 'OperationBudgetExceededError' || error?.name === 'AbortError') throw error;
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

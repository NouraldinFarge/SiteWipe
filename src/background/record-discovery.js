import {
  downloadMatchesReviewedCleanupTarget,
  historyItemMatchesCleanupTarget,
  listCleanupTargets
} from '../shared/target-scope.js';
import { yieldEvery } from './operation-control.js';

const MAX_DISCOVERY_QUERY_RESULTS = 5000;
const MAX_HISTORY_MATCHES = 5000;
const MAX_DOWNLOAD_DISCOVERY_RESULTS = 1000;
const MAX_DOWNLOAD_RECENT_FALLBACK_RESULTS = 500;
const MAX_DOWNLOAD_MATCHES = 1000;

export async function discoverMatchingHistory(target, options = {}) {
  return (await discoverMatchingHistoryWithEvidence(target, options)).items;
}

export async function discoverMatchingHistoryWithEvidence(target, options = {}) {
  const seen = new Map();
  const terms = discoverySearchTerms(target, options);
  const evidence = ensureDiscoveryEvidence(options);
  evidence.history = createDiscoveryEvidence('history');
  evidence.history.queriesPlanned = terms.length;
  for (let termIndex = 0; termIndex < terms.length; termIndex += 1) {
    await yieldEvery(termIndex, 1);
    await throwIfCanceled(options, 'history discovery');
    options.operationBudget?.claimQuery('history discovery');
    try {
      const results = await chrome.history.search({
        text: terms[termIndex],
        startTime: 0,
        maxResults: MAX_DISCOVERY_QUERY_RESULTS
      });
      if (!Array.isArray(results)) throw new TypeError('chrome.history.search returned a non-array result.');
      options.operationBudget?.observeRecords(results.length, 'history discovery results');
      evidence.history.queries += 1;
      evidence.history.recordsObserved += results.length;
      if (results.length >= MAX_DISCOVERY_QUERY_RESULTS) {
        evidence.history.queryResultCapReached = true;
        evidence.history.cappedQueries += 1;
      }
      for (const item of results) {
        if (!historyItemMatchesCleanupTarget(item, target)) continue;
        seen.set(item.url, item);
        if (seen.size >= MAX_HISTORY_MATCHES) {
          evidence.history.matchCapReached = true;
          return discoveryResult([...seen.values()], finalizeDiscoveryEvidence(evidence.history, seen.size, 'history'));
        }
      }
    } catch (error) {
      evidence.history.queryFailures += 1;
      throw attachDiscoveryEvidence(error, finalizeDiscoveryEvidence(evidence.history, seen.size, 'history'));
    }
  }
  return discoveryResult([...seen.values()], finalizeDiscoveryEvidence(evidence.history, seen.size, 'history'));
}

export async function discoverMatchingDownloads(target, options = {}) {
  return (await discoverMatchingDownloadsWithEvidence(target, options)).items;
}

export async function discoverMatchingDownloadsWithEvidence(target, options = {}) {
  const seen = new Map();
  const evidence = ensureDiscoveryEvidence(options);
  evidence.downloads = createDiscoveryEvidence('downloads');
  /** @type {Array<Record<string, any>>} */
  const queries = discoverySearchTerms(target, options).map((term) => ({
    query: [term],
    limit: MAX_DOWNLOAD_DISCOVERY_RESULTS,
    orderBy: ['-startTime']
  }));
  if (options.downloadRecentFallback === true) {
    queries.push({ limit: MAX_DOWNLOAD_RECENT_FALLBACK_RESULTS, orderBy: ['-startTime'] });
  }
  evidence.downloads.queriesPlanned = queries.length;
  for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
    await yieldEvery(queryIndex, 1);
    await throwIfCanceled(options, 'download discovery');
    options.operationBudget?.claimQuery('download discovery');
    try {
      const results = await chrome.downloads.search(queries[queryIndex]);
      if (!Array.isArray(results)) throw new TypeError('chrome.downloads.search returned a non-array result.');
      options.operationBudget?.observeRecords(results.length, 'download discovery results');
      evidence.downloads.queries += 1;
      evidence.downloads.recordsObserved += results.length;
      if (results.length >= Number(queries[queryIndex].limit || 0)) {
        evidence.downloads.queryResultCapReached = true;
        evidence.downloads.cappedQueries += 1;
      }
      for (const item of results) {
        if (!downloadMatchesReviewedCleanupTarget(item, target, options.incognitoAccess === true)) continue;
        seen.set(String(item.id), item);
        if (seen.size >= MAX_DOWNLOAD_MATCHES) {
          evidence.downloads.matchCapReached = true;
          return discoveryResult(
            [...seen.values()],
            finalizeDiscoveryEvidence(evidence.downloads, seen.size, 'downloads')
          );
        }
      }
    } catch (error) {
      evidence.downloads.queryFailures += 1;
      throw attachDiscoveryEvidence(error, finalizeDiscoveryEvidence(evidence.downloads, seen.size, 'downloads'));
    }
  }
  return discoveryResult([...seen.values()], finalizeDiscoveryEvidence(evidence.downloads, seen.size, 'downloads'));
}

export function discoverySearchTerms(target, options = {}) {
  const terms = [];
  for (const item of listCleanupTargets(target)) {
    if (item.matchMode === 'exact_origin') {
      const origin = String(item.exactOrigin || '')
        .toLowerCase()
        .replace(/\/$/, '');
      const host = String(item.domain || item.exactHost || '').toLowerCase();
      terms.push(origin, `${origin}/`, host);
      continue;
    }
    const domain = String(item.domain || '').toLowerCase();
    const labels = domain.split('.').filter(Boolean);
    const registrableLabel = labels[0] || domain;
    const precise = [domain, `www.${domain}`, `https://${domain}`, `http://${domain}`, `${domain}/`, `.${domain}`];
    const broadFallback =
      options.broadDiscoveryFallback && registrableLabel && registrableLabel.length >= 4 ? [registrableLabel] : [];
    terms.push(...precise, ...broadFallback);
  }
  return [...new Set(terms.filter(Boolean))];
}

function ensureDiscoveryEvidence(options) {
  const evidence = options.discoveryEvidence || {};
  return evidence;
}

function createDiscoveryEvidence(kind) {
  return {
    kind,
    queriesPlanned: 0,
    queries: 0,
    recordsObserved: 0,
    matches: 0,
    cappedQueries: 0,
    queryResultCapReached: false,
    matchCapReached: false,
    queryFailures: 0,
    complete: true,
    truncated: false,
    limitations: []
  };
}

function finalizeDiscoveryEvidence(evidence, matches, kind) {
  evidence.matches = matches;
  evidence.complete = !(
    evidence.queryResultCapReached ||
    evidence.matchCapReached ||
    evidence.queryFailures > 0 ||
    evidence.queries < evidence.queriesPlanned
  );
  evidence.truncated = !evidence.complete;
  const label = kind === 'history' ? 'History' : 'Download';
  evidence.limitations = [
    evidence.queryResultCapReached
      ? `${label} discovery reached a browser query-result limit; the observed matches are a lower bound.`
      : null,
    evidence.matchCapReached
      ? `${label} discovery reached SiteWipe's retained-match limit; the observed matches are a lower bound.`
      : null,
    evidence.queryFailures > 0 ? `${label} discovery did not complete every browser query.` : null,
    evidence.queries < evidence.queriesPlanned && evidence.queryFailures === 0
      ? `${label} discovery stopped before every planned browser query completed.`
      : null
  ].filter(Boolean);
  return snapshotDiscoveryEvidence(evidence);
}

function snapshotDiscoveryEvidence(evidence) {
  return {
    kind: evidence.kind,
    queriesPlanned: evidence.queriesPlanned,
    queriesRun: evidence.queries,
    recordsObserved: evidence.recordsObserved,
    matches: evidence.matches,
    cappedQueries: evidence.cappedQueries,
    queryResultCapReached: evidence.queryResultCapReached,
    matchCapReached: evidence.matchCapReached,
    queryFailures: evidence.queryFailures,
    complete: evidence.complete,
    truncated: evidence.truncated,
    limitations: [...evidence.limitations]
  };
}

function discoveryResult(items, evidence) {
  return { items, evidence };
}

function attachDiscoveryEvidence(error, evidence) {
  if (error && typeof error === 'object') {
    try {
      Object.defineProperty(error, 'discoveryEvidence', {
        configurable: true,
        enumerable: false,
        value: evidence
      });
    } catch {
      // The original browser error remains authoritative when it is not extensible.
    }
  }
  return error;
}

async function throwIfCanceled(options, phase) {
  if (typeof options.shouldCancel !== 'function') return;
  if (await options.shouldCancel()) {
    const error = new Error(`SiteWipe cleanup canceled during ${phase}.`);
    error.name = 'AbortError';
    throw error;
  }
}

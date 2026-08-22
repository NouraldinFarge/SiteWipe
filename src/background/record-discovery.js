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
  const seen = new Map();
  const terms = discoverySearchTerms(target, options);
  const evidence = ensureDiscoveryEvidence(options);
  for (let termIndex = 0; termIndex < terms.length; termIndex += 1) {
    await yieldEvery(termIndex, 1);
    await throwIfCanceled(options, 'history discovery');
    options.operationBudget?.claimQuery('history discovery');
    const results = await chrome.history.search({
      text: terms[termIndex],
      startTime: 0,
      maxResults: MAX_DISCOVERY_QUERY_RESULTS
    });
    options.operationBudget?.observeRecords(results.length, 'history discovery results');
    evidence.history.queries += 1;
    evidence.history.recordsObserved += results.length;
    if (results.length >= MAX_DISCOVERY_QUERY_RESULTS) evidence.history.queryResultCapReached = true;
    for (const item of results) {
      if (!historyItemMatchesCleanupTarget(item, target)) continue;
      seen.set(item.url, item);
      if (seen.size >= MAX_HISTORY_MATCHES) {
        evidence.history.matchCapReached = true;
        evidence.history.matches = seen.size;
        return [...seen.values()];
      }
    }
  }
  evidence.history.matches = seen.size;
  return [...seen.values()];
}

export async function discoverMatchingDownloads(target, options = {}) {
  const seen = new Map();
  const evidence = ensureDiscoveryEvidence(options);
  /** @type {Array<Record<string, any>>} */
  const queries = discoverySearchTerms(target, options).map((term) => ({
    query: [term],
    limit: MAX_DOWNLOAD_DISCOVERY_RESULTS,
    orderBy: ['-startTime']
  }));
  if (options.downloadRecentFallback === true) {
    queries.push({ limit: MAX_DOWNLOAD_RECENT_FALLBACK_RESULTS, orderBy: ['-startTime'] });
  }
  for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
    await yieldEvery(queryIndex, 1);
    await throwIfCanceled(options, 'download discovery');
    options.operationBudget?.claimQuery('download discovery');
    const results = await chrome.downloads.search(queries[queryIndex]);
    options.operationBudget?.observeRecords(results.length, 'download discovery results');
    evidence.downloads.queries += 1;
    evidence.downloads.recordsObserved += results.length;
    if (results.length >= Number(queries[queryIndex].limit || 0)) evidence.downloads.queryResultCapReached = true;
    for (const item of results) {
      if (!downloadMatchesReviewedCleanupTarget(item, target, options.incognitoAccess === true)) continue;
      seen.set(String(item.id), item);
      if (seen.size >= MAX_DOWNLOAD_MATCHES) {
        evidence.downloads.matchCapReached = true;
        evidence.downloads.matches = seen.size;
        return [...seen.values()];
      }
    }
  }
  evidence.downloads.matches = seen.size;
  return [...seen.values()];
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
  evidence.history ||= {
    queries: 0,
    recordsObserved: 0,
    matches: 0,
    queryResultCapReached: false,
    matchCapReached: false
  };
  evidence.downloads ||= {
    queries: 0,
    recordsObserved: 0,
    matches: 0,
    queryResultCapReached: false,
    matchCapReached: false
  };
  return evidence;
}

async function throwIfCanceled(options, phase) {
  if (typeof options.shouldCancel !== 'function') return;
  if (await options.shouldCancel()) {
    const error = new Error(`SiteWipe cleanup canceled during ${phase}.`);
    error.name = 'AbortError';
    throw error;
  }
}

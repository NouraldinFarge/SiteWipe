import { cookieMatchesCleanupTarget, listCleanupTargets } from '../shared/target-scope.js';
import { addError, addSection, addUnavailable, createAdapterOutcome } from './report.js';
import {
  mapWithConcurrency,
  OPERATION_TIMEOUT,
  throwIfCancellationRequested,
  withTimeoutValue,
  yieldEvery
} from './operation-control.js';
import { runOriginCookieSweep } from './origin-storage.js';

const MAX_COOKIE_URL_PROBE_ORIGINS = 80;
const MAX_PARTITION_TOP_LEVEL_SITES = 50;
export const MAX_COOKIE_DISCOVERY_QUERIES = 1_500;
const OPERATION_YIELD_EVERY = 10;
const COOKIE_DISCOVERY_CONCURRENCY = 6;
const COOKIE_REMOVE_CONCURRENCY = 8;
const COOKIE_GET_STORES_TIMEOUT_MS = 8_000;
const COOKIE_GET_TIMEOUT_MS = 8_000;
const COOKIE_REMOVE_TIMEOUT_MS = 8_000;

export async function removeCookies(target, report, incognitoAccess, context, options = {}) {
  if (!chrome.cookies) {
    addUnavailable(report, 'Cookies', 'chrome.cookies is unavailable in this browser context.');
    return;
  }

  const seen = new Set();
  let removed = 0;
  let partitionedAttempted = 0;
  let partitionedRemoved = 0;
  let cookieRemoveTimeouts = 0;
  let cookieRemoveFailures = 0;
  let cookieCandidatesUnremoved = 0;

  async function cookiePhaseProgress(percent, detail) {
    if (typeof options.onProgress !== 'function') return;
    try {
      await options.onProgress({
        percent,
        label: 'Removing cookies…',
        detail,
        phase: 'removing-cookies',
        at: new Date().toISOString()
      });
    } catch {
      // Progress persistence must never block cookie cleanup.
    }
  }

  try {
    const candidates = Array.isArray(context?.cookieCandidates)
      ? context.cookieCandidates
      : await discoverCookiesOnly(target, incognitoAccess);
    const uniqueCandidates = [];
    for (const item of candidates) {
      const { cookie, storeId } = item;
      const key = cookieKey(cookie, storeId);
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueCandidates.push(item);
      if (cookie.partitionKey) partitionedAttempted += 1;
    }

    await cookiePhaseProgress(
      63,
      `Found ${uniqueCandidates.length} unique cookie candidate(s); removing them with per-call timeouts.`
    );

    const removalResults = await mapWithConcurrency(
      uniqueCandidates,
      COOKIE_REMOVE_CONCURRENCY,
      async (item, index) => {
        await yieldEvery(index, OPERATION_YIELD_EVERY);
        await throwIfCancellationRequested(options.shouldCancel, 'the next cookie removal batch');
        options.operationBudget?.check('the next cookie removal');
        const result = await removeCookie(item.cookie, item.storeId, item.cookie.partitionKey, options);
        return { ...result, partitioned: Boolean(item.cookie.partitionKey) };
      }
    );
    for (const result of removalResults) {
      if (result?.removed) {
        removed += 1;
        if (result.partitioned) partitionedRemoved += 1;
      }
      cookieRemoveTimeouts += result?.timeouts || 0;
      cookieRemoveFailures += result?.failures || 0;
      if (!result?.removed) cookieCandidatesUnremoved += 1;
    }

    await cookiePhaseProgress(67, `Removed ${removed} cookie(s); starting the browser cookie sweep.`);

    const sweep =
      options.aggressiveCookieSweep === true
        ? await runOriginCookieSweep(
            target,
            context?.origins || target.baseOrigins,
            options.includeProtectedWebOrigins === true,
            options
          )
        : {
            attempted: false,
            batches: 0,
            ok: false,
            skipped: 'Disabled in settings.'
          };

    await cookiePhaseProgress(
      70,
      sweep.attempted
        ? `Browser cookie sweep finished after ${sweep.batches || 0} batch(es).`
        : 'Browser cookie sweep skipped.'
    );

    report.summary.cookiesRemoved = removed;
    report.summary.cookieRemoveTimeouts = cookieRemoveTimeouts;
    report.summary.cookieRemoveFailures = cookieRemoveFailures;
    report.summary.cookieCandidatesUnremoved = cookieCandidatesUnremoved;
    report.summary.partitionedCookiesAttempted = partitionedAttempted;
    report.summary.partitionedCookiesRemoved = partitionedRemoved;
    report.summary.browserCookieSweepAttempted = Boolean(sweep.attempted);
    report.summary.browserCookieSweepBatches = sweep.batches || 0;
    report.summary.browserCookieSweepSucceeded = Boolean(sweep.ok);
    report.summary.partitionTopLevelSitesProbed = Array.isArray(context?.partitionTopLevelSites)
      ? context.partitionTopLevelSites.length
      : report.summary.partitionTopLevelSitesProbed || 0;
    const partial = Boolean(
      cookieCandidatesUnremoved || cookieRemoveTimeouts || cookieRemoveFailures || (sweep.attempted && !sweep.ok)
    );
    addSection(report, 'cookies', 'Cookies removed', partial ? 'partial' : 'success', {
      removed,
      candidates: candidates.length,
      uniqueCandidates: uniqueCandidates.length,
      partitionedAttempted,
      partitionedRemoved,
      cookieRemoveTimeouts,
      cookieRemoveFailures,
      cookieCandidatesUnremoved,
      outcome: createAdapterOutcome({
        attempted: uniqueCandidates.length,
        succeeded: removed,
        failed: cookieCandidatesUnremoved && !cookieRemoveTimeouts ? cookieCandidatesUnremoved : 0,
        timedOut: cookieRemoveTimeouts,
        unknown: cookieCandidatesUnremoved
      }),
      stores: context?.storeStats || [],
      partitionTopLevelSitesProbed: Array.isArray(context?.partitionTopLevelSites)
        ? context.partitionTopLevelSites.length
        : 0,
      perCallTimeoutMs: COOKIE_REMOVE_TIMEOUT_MS,
      browserCookieSweep: sweep
    });
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'OperationBudgetExceededError') throw error;
    addError(report, 'Cookies', error);
  }
}

export async function discoverCookiesOnly(target, incognitoAccess, options = {}) {
  await throwIfCancellationRequested(options.shouldCancel, 'cookie-store discovery');
  options.operationBudget?.claimQuery('cookie-store discovery');
  const storesResult = await safeGetCookieStores();
  options.operationBudget?.observeRecords(storesResult.stores.length, 'cookie-store discovery results');
  if (!storesResult.ok && options.strict) {
    throw new Error(storesResult.error || 'Cookie stores could not be enumerated.');
  }
  const stores = storesResult.ok ? storesResult.stores : [];
  const candidates = [];
  for (const store of stores) {
    await throwIfCancellationRequested(options.shouldCancel, 'the next cookie store');
    options.operationBudget?.check('the next cookie store');
    const isIncognitoStore = await storeLooksIncognito(store, options);
    if (isIncognitoStore && !incognitoAccess) continue;
    const queries = buildCookieDiscoveryQueries(
      target,
      store.id,
      target.baseOrigins,
      target.partitionTopLevelSites || [],
      { probePartitionedCookiesWithEmbeddingSites: false }
    );
    const seen = new Set();
    await mapWithConcurrency(queries, COOKIE_DISCOVERY_CONCURRENCY, async (query, queryIndex) => {
      await yieldEvery(queryIndex, OPERATION_YIELD_EVERY);
      await throwIfCancellationRequested(options.shouldCancel, 'the next cookie discovery query');
      options.operationBudget?.claimQuery('cookie discovery');
      const result = await safeGetCookies(query.details);
      if (!result.ok) {
        if (options.strict) throw new Error(result.error || 'Cookie verification query failed.');
        return;
      }
      options.operationBudget?.observeRecords(result.cookies.length, 'cookie discovery results');
      for (const cookie of result.cookies) {
        if (!cookieMatchesTarget(cookie, target)) continue;
        const key = cookieKey(cookie, store.id);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ cookie, storeId: store.id, source: query.source });
      }
    });
  }
  return candidates;
}

export function buildCookieDiscoveryQueries(target, storeId, origins = [], partitionTopLevelSites = [], options = {}) {
  const queries = [];
  const explicitOrigins = [...new Set((target.baseOrigins || []).filter(Boolean))];
  const explicitOriginSet = new Set(explicitOrigins);
  const additionalOrigins = [...new Set(origins || [])].filter((origin) => origin && !explicitOriginSet.has(origin));
  const originList = [...explicitOrigins, ...additionalOrigins.slice(0, MAX_COOKIE_URL_PROBE_ORIGINS)];
  const domains = cookieDiscoveryDomains(target);
  const exactTargets = listCleanupTargets(target).filter((item) => item.matchMode === 'exact_origin');

  for (const origin of originList) {
    queries.push({
      source: `url:${origin}`,
      details: { url: `${origin}/`, storeId }
    });
    queries.push({
      source: `partition-any-url:${origin}`,
      details: { url: `${origin}/`, storeId, partitionKey: {} }
    });
  }

  for (const item of exactTargets) {
    if (item.exactOrigin) {
      const origin = String(item.exactOrigin).replace(/\/$/, '');
      queries.push({
        source: `exact-origin-url:${origin}`,
        details: { url: `${origin}/`, storeId }
      });
      queries.push({
        source: `partition-any-exact-origin-url:${origin}`,
        details: { url: `${origin}/`, storeId, partitionKey: {} }
      });
    }
  }

  for (const domain of domains) {
    queries.push({
      source: `domain-filter:${domain}`,
      details: { domain, storeId }
    });
    queries.push({
      source: `partition-any-domain-filter:${domain}`,
      details: { domain, storeId, partitionKey: {} }
    });
    if (!domain.startsWith('.')) {
      queries.push({
        source: `domain-filter:.${domain}`,
        details: { domain: `.${domain}`, storeId }
      });
      queries.push({
        source: `partition-any-domain-filter:.${domain}`,
        details: { domain: `.${domain}`, storeId, partitionKey: {} }
      });
    }
  }

  if (options.exhaustiveCookieStoreScan === true) {
    queries.push({
      source: 'all-accessible-store-cookies',
      details: { storeId }
    });
    queries.push({
      source: 'partition-any-accessible-store-cookies',
      details: { storeId, partitionKey: {} }
    });
  }

  if (options.probePartitionedCookiesWithEmbeddingSites === true) {
    const topLevelSites = [
      ...new Set([...(target.partitionTopLevelSites || []), ...(partitionTopLevelSites || [])])
    ].slice(0, MAX_PARTITION_TOP_LEVEL_SITES);
    for (const topLevelSite of topLevelSites) {
      for (const origin of originList) {
        queries.push({
          source: `partition-url:${topLevelSite}`,
          details: {
            url: `${origin}/`,
            storeId,
            partitionKey: { topLevelSite }
          }
        });
        queries.push({
          source: `partition-url-crosssite:${topLevelSite}`,
          details: {
            url: `${origin}/`,
            storeId,
            partitionKey: { topLevelSite, hasCrossSiteAncestor: true }
          }
        });
        queries.push({
          source: `partition-url-samesite:${topLevelSite}`,
          details: {
            url: `${origin}/`,
            storeId,
            partitionKey: { topLevelSite, hasCrossSiteAncestor: false }
          }
        });
      }
      for (const domain of domains) {
        queries.push({
          source: `partition-domain:${domain}:${topLevelSite}`,
          details: { domain, storeId, partitionKey: { topLevelSite } }
        });
        queries.push({
          source: `partition-domain-crosssite:${domain}:${topLevelSite}`,
          details: {
            domain,
            storeId,
            partitionKey: { topLevelSite, hasCrossSiteAncestor: true }
          }
        });
        queries.push({
          source: `partition-domain-samesite:${domain}:${topLevelSite}`,
          details: {
            domain,
            storeId,
            partitionKey: { topLevelSite, hasCrossSiteAncestor: false }
          }
        });
      }
    }
  }
  // Preserve the reviewed origin/domain queries at the front and bound the
  // optional embedding-site expansion. Expert discovery must not generate an
  // unbounded service-worker workload.
  return queries.slice(0, MAX_COOKIE_DISCOVERY_QUERIES);
}

export async function storeLooksIncognito(store, options = {}) {
  if (!Array.isArray(store.tabIds) || store.tabIds.length === 0) return false;
  for (const tabId of store.tabIds) {
    await throwIfCancellationRequested(options.shouldCancel, 'cookie-store tab inspection');
    options.operationBudget?.claimQuery('cookie-store tab inspection');
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.incognito) return true;
    } catch {
      // The tab may have closed. Ignore.
    }
  }
  return false;
}

export async function safeGetCookieStores() {
  try {
    const stores = await withTimeoutValue(
      chrome.cookies.getAllCookieStores(),
      COOKIE_GET_STORES_TIMEOUT_MS,
      OPERATION_TIMEOUT
    );
    if (stores === OPERATION_TIMEOUT) {
      return {
        ok: false,
        stores: [],
        error: `cookies.getAllCookieStores timed out after ${COOKIE_GET_STORES_TIMEOUT_MS}ms`
      };
    }
    return { ok: true, stores: Array.isArray(stores) ? stores : [] };
  } catch (error) {
    return { ok: false, stores: [], error: error?.message || String(error) };
  }
}

export async function safeGetCookies(details) {
  try {
    const cookies = await withTimeoutValue(chrome.cookies.getAll(details), COOKIE_GET_TIMEOUT_MS, OPERATION_TIMEOUT);
    if (cookies === OPERATION_TIMEOUT) {
      return {
        ok: false,
        cookies: [],
        error: `cookies.getAll timed out after ${COOKIE_GET_TIMEOUT_MS}ms`
      };
    }
    return { ok: true, cookies: Array.isArray(cookies) ? cookies : [] };
  } catch (error) {
    return { ok: false, cookies: [], error: error?.message || String(error) };
  }
}

export function cookieMatchesTarget(cookie, target) {
  return cookieMatchesCleanupTarget(cookie, target);
}

export function cookieHost(cookie) {
  return String(cookie?.domain || '')
    .replace(/^\./, '')
    .toLowerCase()
    .replace(/\.$/, '');
}

export function cookieKey(cookie, storeId) {
  return JSON.stringify({
    storeId,
    name: cookie.name,
    domain: cookie.domain,
    path: cookie.path,
    partitionKey: cookie.partitionKey || null
  });
}

export async function removeCookie(cookie, storeId, partitionKey, options = {}) {
  const host = cookieHost(cookie);
  const stats = { removed: false, attempts: 0, timeouts: 0, failures: 0 };
  if (!host) return stats;
  const path = normalizeCookiePath(cookie.path);
  const schemes = cookie.secure ? ['https'] : ['http', 'https'];
  const partitionKeys = buildPartitionRemovalKeys(partitionKey || cookie.partitionKey);

  for (const scheme of schemes) {
    for (const pk of partitionKeys) {
      await throwIfCancellationRequested(options.shouldCancel, 'the next cookie removal variant');
      options.operationBudget?.check('the next cookie removal variant');
      const details = {
        url: `${scheme}://${host}${path}`,
        name: cookie.name,
        storeId
      };
      if (pk) details.partitionKey = pk;
      stats.attempts += 1;
      try {
        const result = await withTimeoutValue(
          chrome.cookies.remove(details),
          COOKIE_REMOVE_TIMEOUT_MS,
          OPERATION_TIMEOUT
        );
        if (result === OPERATION_TIMEOUT) {
          stats.timeouts += 1;
          continue;
        }
        if (result) {
          stats.removed = true;
          return stats;
        }
      } catch {
        stats.failures += 1;
        // Try the next scheme/partition variant. Cookie metadata can be browser-specific.
      }
    }
  }
  return stats;
}

export function buildPartitionRemovalKeys(partitionKey) {
  if (!partitionKey) return [null];
  const keys = [partitionKey];
  if (partitionKey.topLevelSite && partitionKey.hasCrossSiteAncestor === undefined) {
    keys.push({ ...partitionKey, hasCrossSiteAncestor: false });
    keys.push({ ...partitionKey, hasCrossSiteAncestor: true });
  }
  return keys;
}

export function normalizeCookiePath(path) {
  const raw = String(path || '/');
  const prefixed = raw.startsWith('/') ? raw : `/${raw}`;
  try {
    return new URL(`https://example.test${prefixed}`).pathname || '/';
  } catch {
    return '/';
  }
}

function cookieDiscoveryDomains(target) {
  const domains = [];
  for (const item of listCleanupTargets(target)) {
    if (item.matchMode === 'exact_origin') {
      const host = String(item.exactHost || item.domain || '').toLowerCase();
      if (host && !host.includes(':')) domains.push(host);
      continue;
    }
    if (item.domain) domains.push(String(item.domain).toLowerCase());
  }
  return [...new Set(domains.filter(Boolean))];
}

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
export const MAX_COOKIE_STORES = 8;
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
    const probedPartitionTopLevelSites = Array.isArray(context?.probedPartitionTopLevelSites)
      ? [...new Set(context.probedPartitionTopLevelSites.filter((site) => typeof site === 'string' && site))]
      : [];
    report.summary.partitionTopLevelSitesProbed = probedPartitionTopLevelSites.length;
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
      partitionTopLevelSitesProbed: probedPartitionTopLevelSites.length,
      probedPartitionTopLevelSites,
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
  const maxCookieStores = Number.isSafeInteger(options.maxCookieStores)
    ? Math.max(0, options.maxCookieStores)
    : MAX_COOKIE_STORES;
  if (stores.length > maxCookieStores) {
    throw new Error(
      `The browser exposed ${stores.length} cookie stores, exceeding SiteWipe's reviewed bound of ${maxCookieStores}.`
    );
  }
  const tabPrivateScopeById = await resolveTabPrivateScopeSnapshot(options);
  const candidates = [];
  for (const store of stores) {
    await throwIfCancellationRequested(options.shouldCancel, 'the next cookie store');
    options.operationBudget?.check('the next cookie store');
    const privateScope = await classifyCookieStorePrivateScope(store, {
      ...options,
      tabPrivateScopeById
    });
    if (!incognitoAccess && privateScope !== 'regular') {
      if (options.strict && privateScope === 'unknown') {
        throw new Error('Cookie-store private scope could not be verified.');
      }
      continue;
    }
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

/**
 * Counts the complete bounded-input query matrix without materializing its
 * optional cross product. The executable query builder applies the independent
 * per-store hard cap after this count is established, so review/report evidence
 * can distinguish hard-cap omissions from the later operation-budget
 * allocation.
 */
export function describeCookieDiscoveryQueryDemand(target, origins = [], partitionTopLevelSites = [], options = {}) {
  const inputs = normalizeCookieDiscoveryInputs(target, origins, partitionTopLevelSites, options);
  const requiredQueries =
    inputs.originList.length * 2 +
    inputs.exactTargetsWithOrigin.length * 2 +
    inputs.domains.reduce((total, domain) => total + (domain.startsWith('.') ? 2 : 4), 0) +
    (options.exhaustiveCookieStoreScan === true ? 2 : 0);
  const optionalPartitionQueries =
    options.probePartitionedCookiesWithEmbeddingSites === true
      ? inputs.topLevelSites.length * (inputs.originList.length * 3 + inputs.domains.length * 3)
      : 0;
  const uncappedRequestedQueries = requiredQueries + optionalPartitionQueries;
  const hardCappedRequestedQueries = Math.min(uncappedRequestedQueries, MAX_COOKIE_DISCOVERY_QUERIES);
  return {
    uncappedRequestedQueries,
    hardCappedRequestedQueries,
    hardCap: MAX_COOKIE_DISCOVERY_QUERIES,
    hardCapOmittedQueries: Math.max(0, uncappedRequestedQueries - hardCappedRequestedQueries),
    requiredQueries,
    optionalPartitionQueries,
    originCount: inputs.originList.length,
    domainCount: inputs.domains.length,
    exactOriginTargetCount: inputs.exactTargetsWithOrigin.length,
    partitionTopLevelSiteCount: inputs.topLevelSites.length
  };
}

export function buildCookieDiscoveryQueries(target, storeId, origins = [], partitionTopLevelSites = [], options = {}) {
  const queries = [];
  const { originList, domains, exactTargetsWithOrigin, topLevelSites } = normalizeCookieDiscoveryInputs(
    target,
    origins,
    partitionTopLevelSites,
    options
  );

  function append(query) {
    if (queries.length >= MAX_COOKIE_DISCOVERY_QUERIES) return false;
    queries.push(query);
    return true;
  }

  for (const origin of originList) {
    if (
      !append({
        source: `url:${origin}`,
        details: { url: `${origin}/`, storeId }
      })
    )
      return queries;
    if (
      !append({
        source: `partition-any-url:${origin}`,
        details: { url: `${origin}/`, storeId, partitionKey: {} }
      })
    )
      return queries;
  }

  for (const item of exactTargetsWithOrigin) {
    const origin = String(item.exactOrigin).replace(/\/$/, '');
    if (
      !append({
        source: `exact-origin-url:${origin}`,
        details: { url: `${origin}/`, storeId }
      })
    )
      return queries;
    if (
      !append({
        source: `partition-any-exact-origin-url:${origin}`,
        details: { url: `${origin}/`, storeId, partitionKey: {} }
      })
    )
      return queries;
  }

  for (const domain of domains) {
    if (
      !append({
        source: `domain-filter:${domain}`,
        details: { domain, storeId }
      })
    )
      return queries;
    if (
      !append({
        source: `partition-any-domain-filter:${domain}`,
        details: { domain, storeId, partitionKey: {} }
      })
    )
      return queries;
    if (!domain.startsWith('.')) {
      if (
        !append({
          source: `domain-filter:.${domain}`,
          details: { domain: `.${domain}`, storeId }
        })
      )
        return queries;
      if (
        !append({
          source: `partition-any-domain-filter:.${domain}`,
          details: { domain: `.${domain}`, storeId, partitionKey: {} }
        })
      )
        return queries;
    }
  }

  if (options.exhaustiveCookieStoreScan === true) {
    if (
      !append({
        source: 'all-accessible-store-cookies',
        details: { storeId }
      })
    )
      return queries;
    if (
      !append({
        source: 'partition-any-accessible-store-cookies',
        details: { storeId, partitionKey: {} }
      })
    )
      return queries;
  }

  if (options.probePartitionedCookiesWithEmbeddingSites === true) {
    for (const topLevelSite of topLevelSites) {
      for (const origin of originList) {
        if (
          !append({
            source: `partition-url:${topLevelSite}`,
            details: {
              url: `${origin}/`,
              storeId,
              partitionKey: { topLevelSite }
            }
          })
        )
          return queries;
        if (
          !append({
            source: `partition-url-crosssite:${topLevelSite}`,
            details: {
              url: `${origin}/`,
              storeId,
              partitionKey: { topLevelSite, hasCrossSiteAncestor: true }
            }
          })
        )
          return queries;
        if (
          !append({
            source: `partition-url-samesite:${topLevelSite}`,
            details: {
              url: `${origin}/`,
              storeId,
              partitionKey: { topLevelSite, hasCrossSiteAncestor: false }
            }
          })
        )
          return queries;
      }
      for (const domain of domains) {
        if (
          !append({
            source: `partition-domain:${domain}:${topLevelSite}`,
            details: { domain, storeId, partitionKey: { topLevelSite } }
          })
        )
          return queries;
        if (
          !append({
            source: `partition-domain-crosssite:${domain}:${topLevelSite}`,
            details: {
              domain,
              storeId,
              partitionKey: { topLevelSite, hasCrossSiteAncestor: true }
            }
          })
        )
          return queries;
        if (
          !append({
            source: `partition-domain-samesite:${domain}:${topLevelSite}`,
            details: {
              domain,
              storeId,
              partitionKey: { topLevelSite, hasCrossSiteAncestor: false }
            }
          })
        )
          return queries;
      }
    }
  }
  return queries;
}

function normalizeCookieDiscoveryInputs(target, origins, partitionTopLevelSites, options) {
  const explicitOrigins = boundedUniqueValues(target?.baseOrigins, Number.POSITIVE_INFINITY);
  const explicitOriginSet = new Set(explicitOrigins);
  const additionalOrigins = [];
  const additionalOriginSet = new Set();
  for (const origin of iterableValues(origins)) {
    if (!origin || explicitOriginSet.has(origin) || additionalOriginSet.has(origin)) continue;
    additionalOriginSet.add(origin);
    additionalOrigins.push(origin);
    if (additionalOrigins.length >= MAX_COOKIE_URL_PROBE_ORIGINS) break;
  }
  const originList = [...explicitOrigins, ...additionalOrigins];
  const domains = cookieDiscoveryDomains(target);
  const exactTargetsWithOrigin = listCleanupTargets(target).filter(
    (item) => item.matchMode === 'exact_origin' && item.exactOrigin
  );
  const topLevelSites =
    options.probePartitionedCookiesWithEmbeddingSites === true
      ? boundedUniqueValuesFromSources(
          [target?.partitionTopLevelSites, partitionTopLevelSites],
          MAX_PARTITION_TOP_LEVEL_SITES
        )
      : [];
  return { originList, domains, exactTargetsWithOrigin, topLevelSites };
}

function boundedUniqueValues(values, limit) {
  const result = [];
  const seen = new Set();
  const safeLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : Number.POSITIVE_INFINITY;
  if (safeLimit === 0) return result;
  for (const value of iterableValues(values)) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= safeLimit) break;
  }
  return result;
}

function boundedUniqueValuesFromSources(sources, limit) {
  const result = [];
  const seen = new Set();
  const safeLimit = Math.max(0, Math.floor(Number(limit) || 0));
  if (safeLimit === 0) return result;
  for (const source of sources) {
    for (const value of iterableValues(source)) {
      if (!value || seen.has(value)) continue;
      seen.add(value);
      result.push(value);
      if (result.length >= safeLimit) return result;
    }
  }
  return result;
}

function iterableValues(value) {
  return value != null && typeof value !== 'string' && typeof value[Symbol.iterator] === 'function' ? value : [];
}

export async function classifyCookieStorePrivateScope(store, options = {}) {
  if (!Array.isArray(store?.tabIds) || store.tabIds.length === 0) return 'unknown';
  const tabPrivateScopeById = normalizeTabPrivateScopeSnapshot(options.tabPrivateScopeById);
  let inspectedTabs = 0;
  for (const tabId of store.tabIds) {
    await throwIfCancellationRequested(options.shouldCancel, 'cookie-store tab inspection');
    if (!tabPrivateScopeById.has(tabId)) continue;
    inspectedTabs += 1;
    if (tabPrivateScopeById.get(tabId) === true) return 'incognito';
  }
  return inspectedTabs > 0 ? 'regular' : 'unknown';
}

async function resolveTabPrivateScopeSnapshot(options) {
  const provided = normalizeTabPrivateScopeSnapshot(options.tabPrivateScopeById);
  if (provided.size || options.tabPrivateScopeById) return provided;
  if (typeof chrome.tabs?.query !== 'function') return provided;
  await throwIfCancellationRequested(options.shouldCancel, 'cookie-store tab snapshot');
  options.operationBudget?.claimQuery('cookie-store tab snapshot');
  const tabs = await chrome.tabs.query({});
  options.operationBudget?.observeRecords(tabs?.length || 0, 'cookie-store tab snapshot results');
  return new Map(
    (tabs || []).filter((tab) => Number.isInteger(tab?.id)).map((tab) => [tab.id, tab.incognito === true])
  );
}

function normalizeTabPrivateScopeSnapshot(value) {
  if (value instanceof Map) return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new Map();
  const snapshot = new Map();
  for (const [id, incognito] of Object.entries(value)) {
    const numericId = Number(id);
    if (Number.isInteger(numericId)) snapshot.set(numericId, incognito === true);
  }
  return snapshot;
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
    if (!Array.isArray(stores)) {
      return {
        ok: false,
        stores: [],
        error: 'cookies.getAllCookieStores returned a non-array result.'
      };
    }
    return { ok: true, stores };
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
    if (!Array.isArray(cookies)) {
      return {
        ok: false,
        cookies: [],
        error: 'cookies.getAll returned a non-array result.'
      };
    }
    return { ok: true, cookies };
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
        if (isConfirmedCookieRemoval(result, details)) {
          stats.removed = true;
          return stats;
        }
        if (result !== null && result !== undefined) stats.failures += 1;
      } catch {
        stats.failures += 1;
        // Try the next scheme/partition variant. Cookie metadata can be browser-specific.
      }
    }
  }
  return stats;
}

function isConfirmedCookieRemoval(result, expected) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  if (result.name !== expected.name || typeof result.url !== 'string') return false;
  if (result.storeId !== undefined && String(result.storeId) !== String(expected.storeId)) return false;
  try {
    const actualUrl = new URL(result.url);
    const expectedUrl = new URL(expected.url);
    return (
      actualUrl.protocol === expectedUrl.protocol &&
      actualUrl.host === expectedUrl.host &&
      normalizeCookiePath(actualUrl.pathname) === normalizeCookiePath(expectedUrl.pathname)
    );
  } catch {
    return false;
  }
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

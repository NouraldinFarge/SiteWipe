export const SAFE_ORIGIN_SCOPED_DATA_TYPES = Object.freeze([
  'cache',
  'cacheStorage',
  'cookies',
  'fileSystems',
  'indexedDB',
  'localStorage',
  'serviceWorkers',
  'webSQL'
]);

export const PROTECTED_BROWSER_SERVICE_DOMAINS = Object.freeze([
  'accounts.google.com',
  'chrome.google.com',
  'clients.google.com',
  'clients2.google.com',
  'clients4.google.com',
  'sync.google.com',
  'account.brave.com',
  'accounts.brave.com',
  'sync.brave.com'
]);

const SAFE_DATA_TYPE_SET = new Set(SAFE_ORIGIN_SCOPED_DATA_TYPES);
const SAFE_ORIGIN_TYPE_SET = new Set(['unprotectedWeb', 'protectedWeb']);

export function assertSafeOriginScopedRemoval(options, dataTypes, reviewedTarget = null) {
  const origins = Array.isArray(options?.origins)
    ? [...new Set(options.origins.map((origin) => String(origin || '')))]
    : [];
  if (!origins.length) throw new Error('Safety guard rejected browsing-data removal without explicit target origins.');
  if (Object.prototype.hasOwnProperty.call(options || {}, 'since'))
    throw new Error('Safety guard rejected time-based browsing-data removal.');
  for (const origin of origins) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`Safety guard rejected invalid cleanup origin: ${origin}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error(`Safety guard rejected non-web or non-origin cleanup target: ${origin}`);
    }
    if (reviewedTarget && !originMatchesReviewedTarget(parsed, reviewedTarget)) {
      throw new Error(`Safety guard rejected an origin outside the preflight-bound cleanup target: ${origin}`);
    }
  }

  const originTypes = options?.originTypes && typeof options.originTypes === 'object' ? options.originTypes : {};
  const enabledOriginTypes = Object.entries(originTypes)
    .filter(([, enabled]) => enabled)
    .map(([key]) => key);
  if (!enabledOriginTypes.length || enabledOriginTypes.some((key) => !SAFE_ORIGIN_TYPE_SET.has(key))) {
    throw new Error('Safety guard rejected an unsafe browsing-data origin type.');
  }

  const enabledDataTypes = Object.entries(dataTypes || {})
    .filter(([, enabled]) => enabled)
    .map(([key]) => key);
  if (!enabledDataTypes.length || enabledDataTypes.some((key) => !SAFE_DATA_TYPE_SET.has(key))) {
    throw new Error('Safety guard rejected a data type outside the SiteWipe allowlist.');
  }

  return {
    options: {
      origins,
      originTypes: Object.fromEntries(enabledOriginTypes.map((key) => [key, true]))
    },
    dataTypes: Object.fromEntries(enabledDataTypes.map((key) => [key, true]))
  };
}

export function findProtectedBrowserServiceTargets(target) {
  const matches = [];
  const seen = new Set();
  visitTarget(target, (targetHost) => {
    for (const serviceHost of PROTECTED_BROWSER_SERVICE_DOMAINS) {
      if (serviceHost === targetHost || serviceHost.endsWith(`.${targetHost}`)) {
        const key = `${targetHost}|${serviceHost}`;
        if (!seen.has(key)) {
          seen.add(key);
          matches.push({ targetHost, serviceHost });
        }
      }
    }
  });
  return matches;
}

function visitTarget(target, callback, visited = new Set()) {
  if (!target || typeof target !== 'object' || visited.has(target)) return;
  visited.add(target);
  const host = String(target.matchMode === 'exact_origin' ? target.exactHost : target.domain || '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (host) callback(host);
  for (const associated of target.associatedTargets || []) visitTarget(associated, callback, visited);
}

function originMatchesReviewedTarget(originUrl, target) {
  if (!target || typeof target !== 'object') return false;
  const primaryMatches =
    target.matchMode === 'exact_origin'
      ? originUrl.origin.toLowerCase() === String(target.exactOrigin || '').toLowerCase()
      : hostMatchesDomain(originUrl.hostname, target.domain);
  if (primaryMatches) return true;
  return (target.associatedTargets || []).some((associated) => originMatchesReviewedTarget(originUrl, associated));
}

function hostMatchesDomain(hostname, domainValue) {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/\.$/, '');
  const domain = String(domainValue || '')
    .toLowerCase()
    .replace(/\.$/, '');
  return Boolean(host && domain && (host === domain || host.endsWith(`.${domain}`)));
}

export const SELECTED_SITE_PARTITION_STORAGE_DISCLOSURE =
  'Chrome/Brave treat browser-level origin-list storage cleanup as selected-top-level-site cleanup for partitioned storage. LocalStorage, IndexedDB, Cache Storage, file-system data, service workers, and related data owned by embedded third parties but partitioned under a selected site may also be deleted. Their partitions under other top-level sites are not included; the selected origin’s partitions under unrelated top-level sites may remain.';

export const EXACT_ORIGIN_BROWSER_STORAGE_LIMITATION =
  'Chrome/Brave key partitioned storage by schemeful top-level site and do not preserve port boundaries in the public browsing-data API. SiteWipe therefore skips browser-level storage/cache deletion for exact-origin-only scope. Exact live-page cleanup still runs, while closed-page LocalStorage, IndexedDB, Cache Storage, file-system data, service workers, and related storage may remain.';

export function classifyBrowserStorageScope(target = {}) {
  const targets = listTargets(target);
  const registrableScopes = targets.filter(
    (item) => item?.matchMode === 'registrable_domain' && normalizeHost(item.domain)
  );
  const uncoveredExactTargets = targets.filter(
    (item) => item?.matchMode === 'exact_origin' && !exactTargetCoveredByRegistrableScope(item, registrableScopes)
  );
  return {
    registrableScopeCount: registrableScopes.length,
    uncoveredExactOriginCount: uncoveredExactTargets.length,
    selectedSitePartitionDisclosureRequired: registrableScopes.length > 0,
    exactOriginLimitationRequired: uncoveredExactTargets.length > 0
  };
}

export function selectBrowserLevelStorageOrigins(target, origins = []) {
  const reviewedOrigins = [...new Set((Array.isArray(origins) ? origins : []).filter(Boolean).map(String))];
  const registrableScopes = listTargets(target).filter(
    (item) => item?.matchMode === 'registrable_domain' && normalizeHost(item.domain)
  );
  const browserOrigins = [];
  const skippedExactOrigins = [];

  for (const origin of reviewedOrigins) {
    let url;
    try {
      url = new URL(origin);
    } catch {
      skippedExactOrigins.push(origin);
      continue;
    }
    if (registrableScopes.some((scope) => domainMatchesHost(url.hostname, scope.domain))) {
      browserOrigins.push(origin);
    } else {
      skippedExactOrigins.push(origin);
    }
  }

  return {
    reviewedOrigins,
    browserOrigins,
    skippedExactOrigins,
    registrableScopeCount: registrableScopes.length
  };
}

function exactTargetCoveredByRegistrableScope(target, registrableScopes) {
  let hostname = normalizeHost(target.exactHost);
  if (!hostname && target.exactOrigin) {
    try {
      hostname = normalizeHost(new URL(target.exactOrigin).hostname);
    } catch {
      return false;
    }
  }
  return Boolean(hostname && registrableScopes.some((scope) => domainMatchesHost(hostname, scope.domain)));
}

function listTargets(target) {
  return [target, ...(target?.associatedTargets || [])].filter(Boolean);
}

function domainMatchesHost(hostname, registrableDomain) {
  const host = normalizeHost(hostname);
  const domain = normalizeHost(registrableDomain);
  return Boolean(host && domain && (host === domain || host.endsWith(`.${domain}`)));
}

function normalizeHost(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '');
}

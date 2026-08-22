import { domainMatchesHost, urlMatchesTarget } from '../background/domain.js';

export function listCleanupTargets(target) {
  return [target, ...(target?.associatedTargets || [])].filter(Boolean);
}

/**
 * Returns a source-window context only when its identity and private state are
 * explicit. The active-tab fallback is accepted only with its own concrete
 * window id; an absent/partial observation must never silently become a
 * normal-window cleanup authority.
 */
export function resolveReviewedSourceContext(currentWindow, fallbackTab = null) {
  if (Number.isInteger(currentWindow?.id) && currentWindow.id >= 0 && typeof currentWindow.incognito === 'boolean') {
    return {
      sourceWindowId: currentWindow.id,
      sourceIncognito: currentWindow.incognito
    };
  }
  if (
    Number.isInteger(fallbackTab?.windowId) &&
    fallbackTab.windowId >= 0 &&
    typeof fallbackTab.incognito === 'boolean'
  ) {
    return {
      sourceWindowId: fallbackTab.windowId,
      sourceIncognito: fallbackTab.incognito
    };
  }
  throw new Error(
    'SiteWipe could not verify this popup window and its private-window state. No cleanup review was created; reopen the popup and try again.'
  );
}

export function buildPageScrubScope(target) {
  const seen = new Set();
  const scope = [];
  for (const item of listCleanupTargets(target)) {
    const entry =
      item.matchMode === 'exact_origin'
        ? {
            matchMode: 'exact_origin',
            exactOrigin: String(item.exactOrigin || '')
              .toLowerCase()
              .replace(/\/$/, '')
          }
        : {
            matchMode: 'registrable_domain',
            domain: normalizeHost(item.domain)
          };
    const value = entry.exactOrigin || entry.domain;
    if (!value) continue;
    const key = `${entry.matchMode}:${value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    scope.push(entry);
  }
  return scope;
}

export function matchingOriginFromUrl(urlValue, target) {
  if (!urlValue) return null;
  try {
    const url = new URL(urlValue);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return urlMatchesTarget(url.href, target) ? url.origin : null;
  } catch {
    return null;
  }
}

export function matchingOriginsForHost(hostname, target) {
  const host = normalizeHost(hostname);
  if (!host) return [];
  const origins = new Set();
  for (const item of listCleanupTargets(target)) {
    if (item.matchMode === 'exact_origin') {
      if (host === normalizeHost(item.exactHost || item.domain) && item.exactOrigin) {
        origins.add(String(item.exactOrigin).toLowerCase().replace(/\/$/, ''));
      }
      continue;
    }
    // Match this scope entry only. Calling targetMatchesHost() here would also
    // recurse through the primary target's associated targets and could turn an
    // exact-origin association into broad http/https host origins.
    if (!domainMatchesHost(host, item.domain)) continue;
    origins.add(`http://${host}`);
    origins.add(`https://${host}`);
  }
  return [...origins];
}

export function tabMatchesCleanupTarget(tab, target) {
  return [tab?.url, tab?.pendingUrl].some((url) => Boolean(url && urlMatchesTarget(url, target)));
}

export function tabIsWithinReviewedPrivateScope(tab, incognitoAccess = false) {
  return Boolean(tab) && (!tab.incognito || incognitoAccess === true);
}

export function tabMatchesReviewedCleanupTarget(tab, target, incognitoAccess = false) {
  return tabIsWithinReviewedPrivateScope(tab, incognitoAccess) && tabMatchesCleanupTarget(tab, target);
}

export function frameMatchesCleanupTarget(frame, target) {
  return Boolean(frame?.url && urlMatchesTarget(frame.url, target));
}

export function cookieMatchesCleanupTarget(cookie, target) {
  const host = String(cookie?.domain || cookie?.host || '')
    .replace(/^\./, '')
    .toLowerCase()
    .replace(/\.$/, '');
  return Boolean(
    host &&
    listCleanupTargets(target).some((item) => {
      if (item.matchMode === 'exact_origin') {
        return host === normalizeHost(item.exactHost || item.domain);
      }
      return domainMatchesHost(host, item.domain);
    })
  );
}

export function historyItemMatchesCleanupTarget(item, target) {
  return Boolean(item?.url && urlMatchesTarget(item.url, target));
}

export function downloadMatchReasons(item, target) {
  const reasons = [];
  if (item?.url && urlMatchesTarget(item.url, target)) reasons.push('url');
  if (item?.finalUrl && urlMatchesTarget(item.finalUrl, target)) reasons.push('finalUrl');
  if (item?.referrer && urlMatchesTarget(item.referrer, target)) reasons.push('referrer');
  return reasons;
}

export function downloadMatchesCleanupTarget(item, target, options = {}) {
  const reasons = downloadMatchReasons(item, target);
  return options.allowReferrer === false ? reasons.some((reason) => reason !== 'referrer') : reasons.length > 0;
}

export function downloadIsWithinReviewedPrivateScope(item, incognitoAccess = false) {
  return Boolean(item) && (!item.incognito || incognitoAccess === true);
}

export function downloadMatchesReviewedCleanupTarget(item, target, incognitoAccess = false, options = {}) {
  return (
    downloadIsWithinReviewedPrivateScope(item, incognitoAccess) && downloadMatchesCleanupTarget(item, target, options)
  );
}

function normalizeHost(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '');
}

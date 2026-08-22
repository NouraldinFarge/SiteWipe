const HOST_PERMISSION_INVENTORY_SCHEMA_VERSION = 1;
const BROAD_WEB_ORIGINS = new Set(['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*']);
const MATCH_PATTERN = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/i;

/**
 * Canonicalizes a Chrome host-permission match pattern without broadening it.
 * Invalid or non-host permission strings are rejected instead of being
 * silently included in review authority or release operations.
 */
export function canonicalizeHostPermissionOrigin(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  if (trimmed.toLowerCase() === '<all_urls>') return '<all_urls>';

  const match = trimmed.match(MATCH_PATTERN);
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  const host = match[2].toLowerCase();
  const path = match[3];
  if (scheme !== 'file' && !host) return null;
  if (host.includes('@') || /[?#]/.test(host) || /[?#]/.test(path)) return null;
  if (host.includes('*') && host !== '*' && (!host.startsWith('*.') || host.slice(2).includes('*'))) return null;
  return `${scheme}://${host}${path}`;
}

export function canonicalizeHostPermissionOrigins(values, { sort = true } = {}) {
  if (!Array.isArray(values)) return [];
  const canonical = [
    ...new Set(values.map(canonicalizeHostPermissionOrigin).filter((origin) => typeof origin === 'string'))
  ];
  return sort ? canonical.sort(compareStrings) : canonical;
}

export function isBroadHostPermissionOrigin(value) {
  const canonical = canonicalizeHostPermissionOrigin(value);
  return canonical ? BROAD_WEB_ORIGINS.has(canonical) : false;
}

export function buildHostPermissionInventory({
  requiredOrigins = [],
  coveredRequiredOrigins = [],
  grantedOrigins = []
} = {}) {
  const requiredHostPermissionOrigins = canonicalizeHostPermissionOrigins(requiredOrigins);
  const requiredSet = new Set(requiredHostPermissionOrigins);
  const coveredRequiredHostPermissionOrigins = canonicalizeHostPermissionOrigins(coveredRequiredOrigins).filter(
    (origin) => requiredSet.has(origin)
  );
  const reportedGrantedOrigins = canonicalizeHostPermissionOrigins(grantedOrigins);
  const exactGrantedHostPermissionOrigins = reportedGrantedOrigins.filter((origin) => requiredSet.has(origin));
  const broadGrantedHostPermissionOrigins = reportedGrantedOrigins.filter(
    (origin) =>
      !requiredSet.has(origin) &&
      requiredHostPermissionOrigins.some((requiredOrigin) => hostPermissionPatternCovers(origin, requiredOrigin))
  );
  // Minimize the durable/session snapshot: unrelated hostnames are neither
  // cleanup authority nor useful disclosure for this target.
  const grantedHostPermissionOrigins = canonicalizeHostPermissionOrigins([
    ...exactGrantedHostPermissionOrigins,
    ...broadGrantedHostPermissionOrigins
  ]);
  const exactGrantedSet = new Set(exactGrantedHostPermissionOrigins);
  const exactRequiredHostPermissionOrigins = requiredHostPermissionOrigins.filter((origin) =>
    exactGrantedSet.has(origin)
  );
  const requiredCoveredByBroadHostPermissionOrigins = coveredRequiredHostPermissionOrigins.filter(
    (origin) => !exactGrantedSet.has(origin)
  );

  return {
    schemaVersion: HOST_PERMISSION_INVENTORY_SCHEMA_VERSION,
    requiredHostPermissionOrigins,
    coveredRequiredHostPermissionOrigins,
    exactRequiredHostPermissionOrigins,
    requiredCoveredByBroadHostPermissionOrigins,
    grantedHostPermissionOrigins,
    exactGrantedHostPermissionOrigins,
    broadGrantedHostPermissionOrigins,
    allSitesAccessGranted: grantsAllWebSites(broadGrantedHostPermissionOrigins)
  };
}

export function hostPermissionPatternCovers(grantedValue, requiredValue) {
  const granted = parseHostPermissionPattern(grantedValue);
  const required = parseHostPermissionPattern(requiredValue);
  if (!granted || !required) return false;
  if (granted.allUrls) return true;
  if (required.allUrls) return false;
  if (!schemeCovers(granted.scheme, required.scheme)) return false;
  if (!hostCovers(granted.host, required.host)) return false;
  return granted.path === '/*' || granted.path === required.path;
}

export function normalizeHostPermissionInventory(value, { requiredOrigins = [], coveredRequiredOrigins = [] } = {}) {
  if (!isPlainObject(value) || value.schemaVersion !== HOST_PERMISSION_INVENTORY_SCHEMA_VERSION) return null;
  if (!isExactStringArray(value.grantedHostPermissionOrigins)) return null;
  const normalized = buildHostPermissionInventory({
    requiredOrigins,
    coveredRequiredOrigins,
    grantedOrigins: value.grantedHostPermissionOrigins
  });
  return jsonEquivalent(value, normalized) ? normalized : null;
}

function grantsAllWebSites(broadOrigins) {
  const origins = new Set(broadOrigins);
  return (
    origins.has('<all_urls>') || origins.has('*://*/*') || (origins.has('http://*/*') && origins.has('https://*/*'))
  );
}

function parseHostPermissionPattern(value) {
  const canonical = canonicalizeHostPermissionOrigin(value);
  if (!canonical) return null;
  if (canonical === '<all_urls>') return { allUrls: true };
  const match = canonical.match(MATCH_PATTERN);
  if (!match) return null;
  return {
    allUrls: false,
    scheme: match[1],
    host: match[2],
    path: match[3]
  };
}

function schemeCovers(granted, required) {
  if (granted === required) return true;
  return granted === '*' && (required === 'http' || required === 'https');
}

function hostCovers(granted, required) {
  if (granted === '*') return true;
  const grantedWildcardBase = granted.startsWith('*.') ? granted.slice(2) : null;
  const requiredWildcardBase = required.startsWith('*.') ? required.slice(2) : null;
  if (!grantedWildcardBase) return !requiredWildcardBase && granted === required;
  const requiredBase = requiredWildcardBase || required;
  return requiredBase === grantedWildcardBase || requiredBase.endsWith(`.${grantedWildcardBase}`);
}

function isExactStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function jsonEquivalent(left, right) {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])])
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

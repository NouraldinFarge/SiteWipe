import { refreshReportIntegrity } from './report-integrity.js';

const REDACTED = '[redacted]';
const REDACTED_TARGET = '[redacted-target]';
const SENSITIVE_KEY =
  /(?:^|_)(?:input|target|targetdomain|domain|hostname|host|url|uri|origin|path|filepath|file|filename|destination|downloaddestination|download_destination|pattern|referrer|referer|toplevelsite|associatedtargets?|associateddisplaynames?|user|username|user_name|userid|user_id|credential|authorization|cookie|password|secret|sessionid|session_id|token|apikey|api_key)(?:$|_)/i;
const FREE_FORM_KEY = /^(?:label|message|reason|note|source|stack|error|details?)$/i;

const DETECTORS = Object.freeze([
  {
    name: 'URL',
    pattern: /\b(?:https?|file|ftp|chrome-extension|chrome|edge|brave):\/\/[^\s<>"'`)}\]]+/gi
  },
  { name: 'Windows path', pattern: /\b[A-Za-z]:\\[^\r\n<>"'`]+/g },
  { name: 'UNC path', pattern: /\\\\[^\s\\/]+[\\/][^\r\n<>"'`]+/g },
  { name: 'user-home path', pattern: /\/(?:Users|home)\/[^\s<>"'`]+/g },
  {
    name: 'POSIX absolute path',
    pattern: /(?:\/[a-z0-9._~-]+){2,}/gi
  },
  { name: 'extension ID', pattern: /\b[a-p]{32}\b/g },
  {
    name: 'email address',
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/gi
  },
  {
    name: 'localhost',
    pattern: /\b(?:[a-z0-9-]+\.)*localhost(?::\d{1,5})?\b/gi
  },
  {
    name: 'bracketed IPv6 address',
    pattern: /\[[0-9a-f:.%]+\](?::\d{1,5})?/gi
  },
  {
    name: 'IPv6 address',
    pattern: /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b/gi
  },
  { name: 'IPv4 address', pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g },
  {
    name: 'domain name',
    pattern: /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})\b/gi
  },
  {
    name: 'sensitive parameter',
    pattern:
      /\b(?:access[_-]?token|api[_-]?key|auth|authorization|code|key|password|secret|session|token)\s*[:=]\s*([^&\s,;]+)/gi
  },
  {
    name: 'authorization credential',
    pattern: /\b(?:Basic|Bearer)\s+[A-Z0-9._~+/-]+=*/gi
  },
  {
    name: 'probable filename',
    pattern: /\b[^\s\\/<>:"'`|?*]+\.[a-z][a-z0-9]{0,11}\b/gi
  }
]);

/**
 * Produces a redacted, checksum-refreshed report suitable for local storage,
 * export, troubleshooting, or support. Stable target hashes are deliberately
 * avoided because low-entropy domain hashes are vulnerable to dictionary
 * attacks.
 */
export async function redactReport(report, options = {}) {
  const copy = cloneSerializable(report || {});
  const transformed = redactSensitiveValue(copy);
  transformed.redacted = true;
  transformed.redactionProfile = String(options.profile || 'report');
  if (options.forExport) transformed.redactedForExport = true;
  await refreshReportIntegrity(transformed);
  if (options.assertSafe !== false) assertRedactedSerializationSafe(transformed, options);
  return transformed;
}

export async function prepareReportForExport(report, options = {}) {
  if (options.redacted !== false) {
    return redactReport(report, {
      ...options,
      profile: 'export',
      forExport: true
    });
  }
  const copy = cloneSerializable(report || {});
  copy.redactedForExport = false;
  await refreshReportIntegrity(copy);
  return copy;
}

/** Redacts arbitrary debug/support payloads without adding report metadata. */
export function redactSensitiveValue(value) {
  return transform(value, '', []);
}

export function scrubSensitiveText(value) {
  let output = String(value ?? '');
  for (const detector of DETECTORS) output = output.replace(detector.pattern, REDACTED);
  return output;
}

export function findSensitiveLeaks(value, options = {}) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  const leaks = [];
  for (const detector of DETECTORS) {
    detector.pattern.lastIndex = 0;
    if (detector.pattern.test(serialized)) leaks.push(detector.name);
    detector.pattern.lastIndex = 0;
  }
  for (const canary of options.canaries || []) {
    if (canary && serialized.includes(String(canary))) leaks.push(`canary:${canary}`);
  }
  return [...new Set(leaks)];
}

export function assertRedactedSerializationSafe(value, options = {}) {
  const leaks = findSensitiveLeaks(value, options);
  if (leaks.length) throw new Error(`Redacted serialization still contains sensitive patterns: ${leaks.join(', ')}`);
  return true;
}

function transform(value, key, path) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (path.length === 1 && key === 'targetDomain') return value ? REDACTED_TARGET : value;
    if (isSensitiveKey(key)) return value ? REDACTED : value;
    return scrubSensitiveText(value);
  }
  if (Array.isArray(value)) {
    if (isSensitiveKey(key)) return value.map((item) => scalarShape(item));
    return value.map((item, index) => transform(item, String(index), [...path, index]));
  }
  if (typeof value !== 'object') return REDACTED;

  const output = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (childKey === 'integrity') continue;
    output[childKey] = transform(childValue, childKey, [...path, childKey]);
  }
  return output;
}

function isSensitiveKey(key) {
  const normalized = String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-z0-9]+/gi, '_')
    .toLowerCase();
  return SENSITIVE_KEY.test(normalized) && !FREE_FORM_KEY.test(normalized);
}

function scalarShape(value) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(scalarShape);
  if (typeof value === 'object') return redactSensitiveValue(value);
  return REDACTED;
}

function cloneSerializable(value) {
  return JSON.parse(JSON.stringify(value));
}

import {
  PUBLIC_SUFFIX_METADATA,
  ICANN_EXACT_RULES,
  ICANN_WILDCARD_RULES,
  ICANN_EXCEPTION_RULES,
  PRIVATE_EXACT_RULES,
  PRIVATE_WILDCARD_RULES,
  PRIVATE_EXCEPTION_RULES
} from './public-suffix-data.js';

const RULES = Object.freeze({
  icann: Object.freeze({
    exact: new Set(ICANN_EXACT_RULES),
    wildcard: new Set(ICANN_WILDCARD_RULES),
    exception: new Set(ICANN_EXCEPTION_RULES)
  }),
  private: Object.freeze({
    exact: new Set(PRIVATE_EXACT_RULES),
    wildcard: new Set(PRIVATE_WILDCARD_RULES),
    exception: new Set(PRIVATE_EXCEPTION_RULES)
  })
});

export { PUBLIC_SUFFIX_METADATA };

/**
 * Resolves a hostname using the bundled Public Suffix List snapshot.
 *
 * Product safety callers should leave allowDefaultRule disabled. The default
 * PSL `*` rule is useful for conformance testing, but it is not a sufficiently
 * reviewed boundary for destructive cleanup under an unknown suffix.
 */
export function resolvePublicSuffix(hostname, options = {}) {
  const normalized = normalizePslHostname(hostname);
  if (!normalized.ok) {
    return {
      ok: false,
      hostname: normalized.hostname || '',
      publicSuffix: null,
      registrableDomain: null,
      knownRule: false,
      rule: null,
      ruleType: null,
      ruleSection: null,
      error: normalized.error
    };
  }

  const labels = normalized.hostname.split('.');
  const exception = findExceptionRule(labels);
  if (exception) return buildResolution(labels, exception);

  const prevailing = findPrevailingRule(labels);
  if (prevailing) return buildResolution(labels, prevailing);

  if (!options.allowDefaultRule) {
    return {
      ok: false,
      hostname: normalized.hostname,
      publicSuffix: null,
      registrableDomain: null,
      knownRule: false,
      rule: '*',
      ruleType: 'default',
      ruleSection: null,
      error: 'No reviewed rule for this suffix exists in the bundled Public Suffix List snapshot.'
    };
  }

  return buildResolution(labels, {
    rule: '*',
    type: 'default',
    section: null,
    suffixLabelCount: 1,
    knownRule: false
  });
}

export function getRegistrableDomain(hostname, options = {}) {
  return resolvePublicSuffix(hostname, options).registrableDomain;
}

export function normalizePslHostname(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return { ok: false, hostname: '', error: 'Hostname is empty.' };
  if (raw.startsWith('.'))
    return {
      ok: false,
      hostname: '',
      error: 'Leading dots are not valid hostnames.'
    };
  if (raw.endsWith('..'))
    return {
      ok: false,
      hostname: '',
      error: 'Multiple trailing dots are not valid.'
    };

  let parsed;
  try {
    parsed = new URL(`http://${raw}`);
  } catch {
    return {
      ok: false,
      hostname: '',
      error: 'Hostname could not be converted to its canonical ASCII form.'
    };
  }

  if (parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return {
      ok: false,
      hostname: '',
      error: 'Expected a hostname without credentials, port, path, query, or fragment.'
    };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname.length > 253) return { ok: false, hostname, error: 'Hostname length is invalid.' };
  if (hostname.includes(':') || isIpv4(hostname))
    return {
      ok: false,
      hostname,
      error: 'IP addresses do not have public suffixes.'
    };

  const labels = hostname.split('.');
  const valid = labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      !label.startsWith('-') &&
      !label.endsWith('-') &&
      /^[a-z0-9-]+$/.test(label)
  );
  if (!valid)
    return {
      ok: false,
      hostname,
      error: 'Hostname contains an invalid DNS label.'
    };
  return { ok: true, hostname };
}

function findExceptionRule(labels) {
  for (let index = 0; index < labels.length; index += 1) {
    const candidate = labels.slice(index).join('.');
    const section = sectionContaining('exception', candidate);
    if (!section) continue;
    return {
      rule: `!${candidate}`,
      type: 'exception',
      section,
      suffixLabelCount: labels.length - index - 1,
      knownRule: true
    };
  }
  return null;
}

function findPrevailingRule(labels) {
  let best = null;
  for (let index = 0; index < labels.length; index += 1) {
    const exactCandidate = labels.slice(index).join('.');
    const exactSection = sectionContaining('exact', exactCandidate);
    if (exactSection) {
      best = chooseLonger(best, {
        rule: exactCandidate,
        type: 'exact',
        section: exactSection,
        suffixLabelCount: labels.length - index,
        knownRule: true
      });
    }

    if (index >= labels.length - 1) continue;
    const wildcardBase = labels.slice(index + 1).join('.');
    const wildcardSection = sectionContaining('wildcard', wildcardBase);
    if (!wildcardSection) continue;
    best = chooseLonger(best, {
      rule: `*.${wildcardBase}`,
      type: 'wildcard',
      section: wildcardSection,
      suffixLabelCount: labels.length - index,
      knownRule: true
    });
  }
  return best;
}

function buildResolution(labels, match) {
  const suffixLabelCount = Math.max(0, match.suffixLabelCount);
  const publicSuffix = suffixLabelCount > 0 ? labels.slice(-suffixLabelCount).join('.') : null;
  const registrableDomain =
    suffixLabelCount > 0 && labels.length > suffixLabelCount ? labels.slice(-(suffixLabelCount + 1)).join('.') : null;
  return {
    ok: true,
    hostname: labels.join('.'),
    publicSuffix,
    registrableDomain,
    knownRule: match.knownRule,
    rule: match.rule,
    ruleType: match.type,
    ruleSection: match.section,
    error: null
  };
}

function sectionContaining(type, value) {
  if (RULES.private[type].has(value)) return 'PRIVATE';
  if (RULES.icann[type].has(value)) return 'ICANN';
  return null;
}

function chooseLonger(current, candidate) {
  if (!current || candidate.suffixLabelCount > current.suffixLabelCount) return candidate;
  return current;
}

function isIpv4(hostname) {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(hostname)) return false;
  return hostname.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255);
}

import { PUBLIC_SUFFIX_METADATA, resolvePublicSuffix } from '../shared/public-suffix.js';

const MAX_ASSOCIATED_GROUP_LINES = 50;
const MAX_ASSOCIATED_TARGETS_PER_GROUP = 12;
const MAX_ASSOCIATED_TOTAL_TARGETS = 120;

const DANGEROUS_SCHEMES = new Set([
  'chrome:',
  'chrome-extension:',
  'edge:',
  'brave:',
  'about:',
  'file:',
  'data:',
  'javascript:',
  'blob:',
  'filesystem:',
  'view-source:'
]);

export function normalizeSiteInput(input, options = {}) {
  const raw = String(input || '').trim();
  if (!raw) return fail('Enter a domain or URL.');
  if (/^\*+$/.test(raw) || raw.includes('*')) return fail('Wildcards are not allowed. Enter one website domain.');
  if (/\s/.test(raw)) return fail('Spaces are not valid in a domain or URL.');

  let candidate = raw;
  let url;
  try {
    if (!hasExplicitUrlScheme(candidate)) candidate = `https://${candidate}`;
    url = new URL(candidate);
  } catch {
    return fail('This does not look like a valid URL or domain.');
  }

  if (DANGEROUS_SCHEMES.has(url.protocol) || !['http:', 'https:'].includes(url.protocol)) {
    return fail(`Unsupported scheme ${url.protocol}. Use http or https domains only.`);
  }
  if (url.username || url.password)
    return fail('URLs with embedded usernames or passwords are not accepted. Enter only the website domain or URL.');

  const host = normalizeHostname(url.hostname);
  const observedHost = host;

  const localLike = isLocalHostname(host) || isIpAddress(host);
  if (localLike) {
    if (!options.allowLocalTargets) {
      return fail(
        'Localhost and IP-address cleanup are disabled by default. Enable Advanced → Allow exact-origin localhost/IP cleanup, then enter a full http/https origin such as http://localhost:3000.'
      );
    }
    return {
      ok: true,
      input: raw,
      host,
      registrableDomain: url.host.toLowerCase(),
      target: buildExactOriginTarget(url)
    };
  }

  if (!host) return fail('Enter a registrable website domain.');
  if (!isValidHostname(host)) return fail('The domain contains invalid characters or labels.');

  const labels = host.split('.');
  if (labels.length < 2) return fail('Enter a registrable domain, not a top-level domain.');

  const boundary = resolvePublicSuffix(host, { allowDefaultRule: false });
  if (!boundary.ok || !boundary.knownRule) {
    return fail(
      `Cleanup is blocked because ${host} does not have a reviewed boundary in the bundled Public Suffix List snapshot.`
    );
  }
  if (!boundary.registrableDomain) return fail(`${host} is a public suffix, not a registrable website domain.`);
  const registrableDomain = boundary.registrableDomain;

  return {
    ok: true,
    input: raw,
    host,
    registrableDomain,
    target: buildTarget(registrableDomain, observedHost, boundary)
  };
}

export function applyAssociatedDomainGroups(primaryTarget, groupsText, options = {}) {
  const parsed = parseAssociatedDomainGroups(groupsText, options);
  if (!primaryTarget || !parsed.groups.length) {
    return {
      target: primaryTarget,
      applied: [],
      errors: parsed.errors,
      warnings: parsed.warnings || []
    };
  }

  const primaryKeys = targetIdentityKeys(primaryTarget);
  const associatedTargets = [];
  const applied = [];
  const seen = new Set(targetIdentityKeys(primaryTarget));

  for (const group of parsed.groups) {
    const groupMatches = [...group.keys].some((key) => primaryKeys.has(key));
    if (!groupMatches) continue;
    for (const target of group.associatedTargets) {
      const keys = targetIdentityKeys(target);
      if ([...keys].some((key) => seen.has(key))) continue;
      for (const key of keys) seen.add(key);
      associatedTargets.push(target);
      applied.push({
        input: target.displayName || target.domain,
        matchMode: target.matchMode || 'registrable_domain',
        exactOrigin: target.exactOrigin || null
      });
    }
  }

  if (!associatedTargets.length)
    return {
      target: primaryTarget,
      applied,
      errors: parsed.errors,
      warnings: parsed.warnings || []
    };
  return {
    target: mergeAssociatedTargets(primaryTarget, associatedTargets),
    applied,
    errors: parsed.errors,
    warnings: parsed.warnings || []
  };
}

export function parseAssociatedDomainGroups(groupsText, options = {}) {
  const text = String(groupsText || '').replace(/\r\n?/g, '\n');
  const allLines = text.split('\n');
  const lines = allLines.slice(0, MAX_ASSOCIATED_GROUP_LINES);
  const groups = [];
  const errors = [];
  const warnings = [];
  let totalAssociatedTargets = 0;

  if (allLines.length > MAX_ASSOCIATED_GROUP_LINES) {
    warnings.push({
      message: `Only the first ${MAX_ASSOCIATED_GROUP_LINES} associated-domain group line(s) are used; ${allLines.length - MAX_ASSOCIATED_GROUP_LINES} line(s) were ignored.`
    });
  }

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index].trim();
    if (!rawLine || rawLine.startsWith('#')) continue;
    const parts = rawLine.split('=>');
    if (parts.length !== 2) {
      errors.push({
        line: index + 1,
        message: 'Use: primary.example => related.example, cdn.example'
      });
      continue;
    }
    const primaryInput = parts[0].trim();
    const rawRelatedInputs = parts[1]
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    const relatedInputs = rawRelatedInputs.slice(0, MAX_ASSOCIATED_TARGETS_PER_GROUP);
    if (rawRelatedInputs.length > MAX_ASSOCIATED_TARGETS_PER_GROUP) {
      warnings.push({
        line: index + 1,
        message: `Only the first ${MAX_ASSOCIATED_TARGETS_PER_GROUP} related target(s) on this line are used.`
      });
    }
    if (!primaryInput || !relatedInputs.length) {
      errors.push({
        line: index + 1,
        message: 'Associated-domain group must include one primary target and at least one related target.'
      });
      continue;
    }

    const primary = normalizeSiteInput(primaryInput, options);
    if (!primary.ok) {
      errors.push({
        line: index + 1,
        input: primaryInput,
        message: primary.error
      });
      continue;
    }

    const primaryKeys = targetIdentityKeys(primary.target);
    const associatedTargets = [];
    const localErrors = [];
    const localWarnings = [];
    const seenRelatedKeys = new Set(primaryKeys);
    for (const relatedInput of relatedInputs) {
      if (totalAssociatedTargets >= MAX_ASSOCIATED_TOTAL_TARGETS) {
        localWarnings.push({
          input: relatedInput,
          message: `Global associated-target cap of ${MAX_ASSOCIATED_TOTAL_TARGETS} reached; remaining related targets were ignored.`
        });
        break;
      }
      const related = normalizeSiteInput(relatedInput, options);
      if (!related.ok) {
        localErrors.push({ input: relatedInput, message: related.error });
        continue;
      }
      const relatedKeys = targetIdentityKeys(related.target);
      if ([...relatedKeys].some((key) => primaryKeys.has(key))) {
        localWarnings.push({
          input: relatedInput,
          message: 'Ignored because the related target is the same as the primary target.'
        });
        continue;
      }
      if ([...relatedKeys].some((key) => seenRelatedKeys.has(key))) {
        localWarnings.push({
          input: relatedInput,
          message: 'Ignored duplicate related target.'
        });
        continue;
      }
      for (const key of relatedKeys) seenRelatedKeys.add(key);
      associatedTargets.push(related.target);
      totalAssociatedTargets += 1;
    }
    if (localErrors.length)
      errors.push({
        line: index + 1,
        message: 'Some related targets were ignored.',
        relatedErrors: localErrors
      });
    if (localWarnings.length)
      warnings.push({
        line: index + 1,
        message: 'Some related targets were skipped safely.',
        relatedWarnings: localWarnings
      });
    if (!associatedTargets.length) continue;
    groups.push({
      primary: primary.target,
      keys: targetIdentityKeys(primary.target),
      associatedTargets
    });
  }

  return {
    groups,
    errors,
    warnings,
    lineCount: allLines.length,
    usedLineCount: lines.length,
    totalAssociatedTargets
  };
}

export function validateAssociatedDomainGroups(groupsText, options = {}) {
  const parsed = parseAssociatedDomainGroups(groupsText, options);
  return {
    ok: parsed.errors.length === 0,
    groupCount: parsed.groups.length,
    associatedTargetCount: parsed.totalAssociatedTargets,
    lineCount: parsed.lineCount,
    usedLineCount: parsed.usedLineCount,
    errors: parsed.errors,
    warnings: parsed.warnings,
    groups: parsed.groups.map((group) => ({
      primary: group.primary.displayName || group.primary.domain,
      primaryMode: group.primary.matchMode || 'registrable_domain',
      associated: group.associatedTargets.map((target) => ({
        target: target.displayName || target.domain,
        matchMode: target.matchMode || 'registrable_domain',
        exactOrigin: target.exactOrigin || null
      }))
    }))
  };
}

function mergeAssociatedTargets(primaryTarget, associatedTargets) {
  const associated = associatedTargets.map((target) => ({
    ...target,
    associatedTargets: []
  }));
  const baseOrigins = unique([
    ...(primaryTarget.baseOrigins || []),
    ...associated.flatMap((item) => item.baseOrigins || [])
  ]);
  const hostPermissionOrigins = unique([
    ...(primaryTarget.hostPermissionOrigins || []),
    ...associated.flatMap((item) => item.hostPermissionOrigins || [])
  ]);
  const partitionTopLevelSites = unique([
    ...(primaryTarget.partitionTopLevelSites || []),
    ...associated.flatMap((item) => item.partitionTopLevelSites || [])
  ]);
  return {
    ...primaryTarget,
    baseOrigins,
    hostPermissionOrigins,
    partitionTopLevelSites,
    associatedTargets: associated,
    associatedDomainCount: associated.length,
    associatedDisplayNames: associated.map((item) => item.displayName || item.domain),
    displayName: `${primaryTarget.displayName || primaryTarget.domain} + ${associated.length} associated`
  };
}

function targetIdentityKeys(target) {
  const keys = new Set();
  if (!target) return keys;
  if (target.matchMode === 'exact_origin') {
    if (target.exactOrigin) keys.add(String(target.exactOrigin).toLowerCase().replace(/\/$/, ''));
  } else {
    if (target.domain) keys.add(String(target.domain).toLowerCase());
  }
  return keys;
}

export function buildTarget(registrableDomain, observedHost = '', boundary = {}) {
  const domain = registrableDomain.toLowerCase();
  const observed = String(observedHost || '')
    .toLowerCase()
    .replace(/\.$/, '');
  // `www` is only a conventional label, not a safe normalization rule. On a
  // PRIVATE suffix such as blogspot.com, www.blogspot.com is itself a tenant;
  // removing that label would introduce the platform root into cleanup scope.
  const originHosts = unique([domain, `www.${domain}`, observed].filter(Boolean));
  const baseOrigins = originHosts.flatMap((originHost) => [`http://${originHost}`, `https://${originHost}`]);
  const hostPermissionOrigins = [
    `http://${domain}/*`,
    `https://${domain}/*`,
    `http://*.${domain}/*`,
    `https://*.${domain}/*`
  ];
  return {
    domain,
    displayName: domain,
    matchMode: 'registrable_domain',
    publicSuffix: boundary.publicSuffix || '',
    publicSuffixRule: boundary.rule || '',
    publicSuffixRuleType: boundary.ruleType || '',
    publicSuffixRuleSection: boundary.ruleSection || '',
    publicSuffixSnapshot: PUBLIC_SUFFIX_METADATA.version,
    publicSuffixCommit: PUBLIC_SUFFIX_METADATA.commit,
    baseOrigins,
    hostPermissionOrigins,
    partitionTopLevelSites: baseOrigins
  };
}

export function buildExactOriginTarget(url) {
  const parsed = typeof url === 'string' ? new URL(url) : url;
  const origin = parsed.origin.toLowerCase();
  const host = normalizeHostname(parsed.hostname);
  const displayName = parsed.host.toLowerCase();
  return {
    domain: displayName,
    displayName,
    matchMode: 'exact_origin',
    exactOrigin: origin,
    exactHost: host,
    exactScheme: parsed.protocol.replace(':', ''),
    exactPort: parsed.port || defaultPortForProtocol(parsed.protocol),
    publicSuffix: '',
    baseOrigins: [origin],
    hostPermissionOrigins: [`${origin}/*`],
    partitionTopLevelSites: [origin]
  };
}

export function domainMatchesHost(hostname, registrableDomain) {
  if (!hostname || !registrableDomain) return false;
  const host = normalizeHostname(hostname);
  const domain = String(registrableDomain || '').toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

export function targetMatchesHost(hostname, target) {
  if (!hostname || !target) return false;
  const host = normalizeHostname(hostname);
  const primaryMatches =
    target.matchMode === 'exact_origin'
      ? host === normalizeHostname(target.exactHost || target.domain)
      : domainMatchesHost(host, target.domain);
  if (primaryMatches) return true;
  return (target.associatedTargets || []).some((item) => targetMatchesHost(host, item));
}

export function urlMatchesTarget(urlValue, target) {
  try {
    const url = new URL(urlValue);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    const primaryMatches =
      target?.matchMode === 'exact_origin'
        ? url.origin.toLowerCase() === String(target.exactOrigin || '').toLowerCase()
        : domainMatchesHost(url.hostname, target.domain);
    if (primaryMatches) return true;
    return (target?.associatedTargets || []).some((item) => urlMatchesTarget(url.href, item));
  } catch {
    return false;
  }
}

export function describeTargetMode(target) {
  const suffix = target?.associatedTargets?.length
    ? ` ${target.associatedTargets.length} configured, preflight-bound associated target(s) are included in this cleanup.`
    : '';
  if (target?.matchMode === 'exact_origin') {
    return `Exact-origin developer target. Tabs/storage/history/download URLs must match the exact scheme, host, and port. Cookies remain host-scoped because browser cookies are not port-scoped.${suffix}`;
  }
  return `Registrable-domain target resolved with the bundled Public Suffix List. The preflight-bound registrable domain and its subdomains are included; sibling tenants and lookalike domains are excluded.${suffix}`;
}

export function runDomainSelfTests() {
  const tests = [];
  const add = (name, pass, details = {}) => tests.push({ name, pass: Boolean(pass), details });

  const ex = normalizeSiteInput('https://www.example.com/path');
  add('normalizes www to registrable domain', ex.ok && ex.target.domain === 'example.com', {
    value: ex.target?.domain,
    error: ex.error
  });
  add('matches target subdomain URL', ex.ok && urlMatchesTarget('https://app.example.com/a', ex.target), {});
  add('rejects lookalike domain', ex.ok && !urlMatchesTarget('https://badexample.com/a', ex.target), {});
  const uk = normalizeSiteInput('https://shop.example.co.uk');
  add('handles common multi-part suffix', uk.ok && uk.target.domain === 'example.co.uk', {
    value: uk.target?.domain,
    error: uk.error
  });
  const tenant = normalizeSiteInput('https://alice.blogspot.com/path');
  add('keeps private-suffix tenants isolated', tenant.ok && tenant.target.domain === 'alice.blogspot.com', {
    value: tenant.target?.domain,
    error: tenant.error
  });
  const exception = normalizeSiteInput('https://city.kawasaki.jp');
  add('handles PSL exception rules', exception.ok && exception.target.domain === 'city.kawasaki.jp', {
    value: exception.target?.domain,
    error: exception.error
  });
  const pub = normalizeSiteInput('co.uk');
  add('rejects public suffix input', !pub.ok, { error: pub.error });
  const localBlocked = normalizeSiteInput('http://localhost:3000');
  add('blocks localhost by default', !localBlocked.ok, {
    error: localBlocked.error
  });
  const localAllowed = normalizeSiteInput('http://localhost:3000', {
    allowLocalTargets: true
  });
  add(
    'allows exact-origin localhost when enabled',
    localAllowed.ok &&
      localAllowed.target.matchMode === 'exact_origin' &&
      localAllowed.target.exactOrigin === 'http://localhost:3000',
    { value: localAllowed.target?.exactOrigin, error: localAllowed.error }
  );
  const assoc = validateAssociatedDomainGroups(
    'example.com => cdn.example.com, login.example.net\n# comment\nlocalhost:3000 => 127.0.0.1:5173',
    { allowLocalTargets: true }
  );
  add(
    'validates associated-domain groups with local targets enabled',
    assoc.errors.length === 0 && assoc.groupCount === 2 && assoc.associatedTargetCount === 2,
    { errors: assoc.errors, count: assoc.associatedTargetCount }
  );
  const badAssoc = validateAssociatedDomainGroups('example.com => example.com\ninvalid line', {
    allowLocalTargets: false
  });
  add(
    'reports associated-domain parser errors/warnings',
    badAssoc.errors.length >= 1 && badAssoc.warnings.length >= 1,
    { errors: badAssoc.errors, warnings: badAssoc.warnings }
  );

  const failed = tests.filter((test) => !test.pass);
  return {
    ok: failed.length === 0,
    passed: tests.length - failed.length,
    failed: failed.length,
    tests
  };
}

function unique(values) {
  return [...new Set(values)];
}

function hasExplicitUrlScheme(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

function normalizeHostname(hostname) {
  return String(hostname || '')
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '');
}

function defaultPortForProtocol(protocol) {
  if (protocol === 'http:') return '80';
  if (protocol === 'https:') return '443';
  return '';
}

function isLocalHostname(host) {
  const clean = normalizeHostname(host);
  return clean === 'localhost' || clean.endsWith('.localhost');
}

function isIpAddress(host) {
  const clean = normalizeHostname(host);
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(clean)) {
    return clean.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255);
  }
  return clean.includes(':');
}

function isValidHostname(host) {
  if (host.length > 253) return false;
  const labels = host.split('.');
  return labels.every((label) => {
    if (!label || label.length > 63) return false;
    if (label.startsWith('-') || label.endsWith('-')) return false;
    return /^[a-z0-9-]+$/.test(label);
  });
}

function fail(message) {
  return { ok: false, error: message };
}

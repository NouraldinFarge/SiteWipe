import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyAssociatedDomainGroups,
  domainMatchesHost,
  normalizeSiteInput,
  targetMatchesHost,
  urlMatchesTarget
} from '../../src/background/domain.js';
import { buildTemporaryDnrShieldRules } from '../../src/background/cleanup.js';
import {
  buildPageScrubScope,
  cookieMatchesCleanupTarget,
  downloadMatchReasons,
  historyItemMatchesCleanupTarget,
  matchingOriginsForHost,
  tabMatchesCleanupTarget
} from '../../src/shared/target-scope.js';

const hostedTenantCases = [
  ['alice.blogspot.com', 'alice.blogspot.com', 'bob.blogspot.com'],
  ['store.myshopify.com', 'store.myshopify.com', 'other.myshopify.com'],
  ['project.web.app', 'project.web.app', 'sibling.web.app'],
  ['tenant.azurewebsites.net', 'tenant.azurewebsites.net', 'other.azurewebsites.net'],
  ['user.github.io', 'user.github.io', 'other.github.io'],
  ['foo.pages.dev', 'foo.pages.dev', 'bar.pages.dev'],
  ['example.appspot.com', 'example.appspot.com', 'other.appspot.com']
];

test('private-suffix tenants normalize to isolated registrable domains', () => {
  for (const [input, expected, sibling] of hostedTenantCases) {
    const normalized = normalizeSiteInput(`https://${input}/private?secret=canary`);
    assert.equal(normalized.ok, true, normalized.error);
    assert.equal(normalized.target.domain, expected);
    assert.equal(targetMatchesHost(input, normalized.target), true);
    assert.equal(targetMatchesHost(sibling, normalized.target), false);
    assert.equal(urlMatchesTarget(`https://${sibling}/data`, normalized.target), false);
    assert.equal(domainMatchesHost(sibling, normalized.target.domain), false);
    assert.deepEqual(matchingOriginsForHost(sibling, normalized.target), []);
    assert.deepEqual(buildPageScrubScope(normalized.target), [{ matchMode: 'registrable_domain', domain: expected }]);
  }
});

test('a PRIVATE-suffix tenant literally named www retains its full boundary', () => {
  const normalized = normalizeSiteInput('https://www.blogspot.com/private');
  assert.equal(normalized.ok, true, normalized.error);
  const target = normalized.target;
  const selectedUrl = 'https://www.blogspot.com/account';
  const platformRootUrl = 'https://blogspot.com/account';
  const siblingUrl = 'https://alice.blogspot.com/account';

  assert.equal(target.domain, 'www.blogspot.com');
  assert.deepEqual(target.baseOrigins.sort(), [
    'http://www.blogspot.com',
    'http://www.www.blogspot.com',
    'https://www.blogspot.com',
    'https://www.www.blogspot.com'
  ]);
  assert.equal(
    target.baseOrigins.some((origin) => new URL(origin).hostname === 'blogspot.com'),
    false
  );
  assert.equal(urlMatchesTarget(selectedUrl, target), true);
  assert.equal(urlMatchesTarget(platformRootUrl, target), false);
  assert.equal(urlMatchesTarget(siblingUrl, target), false);
  assert.equal(tabMatchesCleanupTarget({ url: selectedUrl }, target), true);
  assert.equal(cookieMatchesCleanupTarget({ domain: '.www.blogspot.com' }, target), true);
  assert.equal(historyItemMatchesCleanupTarget({ url: selectedUrl }, target), true);
  assert.deepEqual(downloadMatchReasons({ url: selectedUrl }, target), ['url']);
  assert.deepEqual(matchingOriginsForHost('www.blogspot.com', target).sort(), [
    'http://www.blogspot.com',
    'https://www.blogspot.com'
  ]);
  assert.deepEqual(matchingOriginsForHost('blogspot.com', target), []);
  assert.deepEqual(matchingOriginsForHost('alice.blogspot.com', target), []);

  const shield = buildTemporaryDnrShieldRules(target);
  assert.deepEqual(shield.urlFilters, ['||www.blogspot.com^']);
  assert.equal(shield.urlFilters.includes('||blogspot.com^'), false);
});

test('ICANN multi-label, wildcard, and exception rules produce safe boundaries', () => {
  const cases = [
    ['school.district.k12.ca.us', 'district.k12.ca.us'],
    ['city.kawasaki.jp', 'city.kawasaki.jp'],
    ['www.city.kawasaki.jp', 'city.kawasaki.jp'],
    ['shop.example.com.bd', 'example.com.bd'],
    ['shop.example.co.uk', 'example.co.uk']
  ];
  for (const [input, expected] of cases) {
    const normalized = normalizeSiteInput(input);
    assert.equal(normalized.ok, true, normalized.error);
    assert.equal(normalized.target.domain, expected);
  }
});

test('rejects unsafe or ambiguous inputs and fails closed for unknown suffixes', () => {
  const rejected = [
    'https://user:password@example.com/',
    'javascript:alert(1)',
    'file:///C:/private.txt',
    'chrome://settings',
    '*.example.com',
    '.example.com',
    'example.unknown-suffix',
    'com',
    'co.uk'
  ];
  for (const input of rejected) {
    assert.equal(normalizeSiteInput(input).ok, false, `Expected rejection: ${input}`);
  }
});

test('accepts canonical Unicode, punycode, mixed case, and trailing-dot forms', () => {
  const values = ['HTTPS://WWW.食狮.COM.CN./path', 'www.xn--85x722f.com.cn', 'www.xn--85x722f.com.cn.'];
  for (const input of values) {
    const normalized = normalizeSiteInput(input);
    assert.equal(normalized.ok, true, normalized.error);
    assert.equal(normalized.target.domain, 'xn--85x722f.com.cn');
  }
});

test('localhost, IPv4, and bracketed IPv6 require opt-in and retain exact origin', () => {
  const cases = [
    ['http://localhost:3000/path', 'http://localhost:3000'],
    ['https://127.0.0.1:8443/path', 'https://127.0.0.1:8443'],
    ['http://[::1]:5173/path', 'http://[::1]:5173']
  ];
  for (const [input, expectedOrigin] of cases) {
    assert.equal(normalizeSiteInput(input).ok, false);
    const allowed = normalizeSiteInput(input, { allowLocalTargets: true });
    assert.equal(allowed.ok, true, allowed.error);
    assert.equal(allowed.target.matchMode, 'exact_origin');
    assert.equal(allowed.target.exactOrigin, expectedOrigin);
  }
});

test('associated exact origins never match across scheme or port', () => {
  const primary = normalizeSiteInput('http://localhost:3000', {
    allowLocalTargets: true
  });
  assert.equal(primary.ok, true);
  const applied = applyAssociatedDomainGroups(primary.target, 'http://localhost:4000 => unrelated.example.com', {
    allowLocalTargets: true
  });
  assert.equal(applied.errors.length, 0);
  assert.deepEqual(applied.applied, []);
  assert.equal(applied.target.associatedTargets?.length || 0, 0);
});

test('a sibling private tenant never enters any pure destructive or verification scope', () => {
  const normalized = normalizeSiteInput('https://alice.blogspot.com/account');
  assert.equal(normalized.ok, true, normalized.error);
  const target = normalized.target;
  const siblingUrl = 'https://bob.blogspot.com/private';

  assert.equal(target.domain, 'alice.blogspot.com');
  assert.deepEqual(target.baseOrigins, [
    'http://alice.blogspot.com',
    'https://alice.blogspot.com',
    'http://www.alice.blogspot.com',
    'https://www.alice.blogspot.com'
  ]);
  assert.deepEqual(target.hostPermissionOrigins, [
    'http://alice.blogspot.com/*',
    'https://alice.blogspot.com/*',
    'http://*.alice.blogspot.com/*',
    'https://*.alice.blogspot.com/*'
  ]);
  assert.equal(tabMatchesCleanupTarget({ url: siblingUrl }, target), false);
  assert.equal(tabMatchesCleanupTarget({ url: 'https://unrelated.example/', pendingUrl: siblingUrl }, target), false);
  assert.equal(
    tabMatchesCleanupTarget(
      { url: 'https://unrelated.example/', pendingUrl: 'https://sub.alice.blogspot.com/loading' },
      target
    ),
    true
  );
  assert.equal(cookieMatchesCleanupTarget({ domain: '.bob.blogspot.com' }, target), false);
  assert.equal(historyItemMatchesCleanupTarget({ url: siblingUrl }, target), false);
  assert.deepEqual(
    downloadMatchReasons(
      {
        url: `${siblingUrl}/download`,
        finalUrl: `${siblingUrl}/final`,
        referrer: siblingUrl
      },
      target
    ),
    []
  );
  assert.deepEqual(matchingOriginsForHost('bob.blogspot.com', target), []);
  assert.deepEqual(buildPageScrubScope(target), [{ matchMode: 'registrable_domain', domain: 'alice.blogspot.com' }]);

  const shield = buildTemporaryDnrShieldRules(target);
  assert.deepEqual(shield.urlFilters, ['||alice.blogspot.com^']);
  assert.equal(shield.urlFilters.includes('||blogspot.com^'), false);
});

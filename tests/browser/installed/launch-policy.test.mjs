import assert from 'node:assert/strict';
import test from 'node:test';

import { assertSupportedUrlRestrictions } from 'puppeteer-core/internal/common/BrowserConnector.js';
import { URLPattern } from 'puppeteer-core/lib/third_party/urlpattern-polyfill/urlpattern-polyfill.js';

import { SYNTHETIC_FIXTURE_HOSTS } from '../fixture-server.mjs';

import {
  INSTALLED_RUNTIME_LAUNCH_POLICY,
  INSTALLED_RUNTIME_LAUNCH_POLICY_SHA256,
  LOOPBACK_HOST_RESOLVER_RULES,
  RUNTIME_NETWORK_ALLOWLIST,
  validateRuntimeProxyBinding
} from './launch-policy.mjs';

test('installed launch policy is headful, pipe-only, non-maximized, proxy-bound, and incognito-off', () => {
  assert.equal(INSTALLED_RUNTIME_LAUNCH_POLICY.headless, false);
  assert.equal(INSTALLED_RUNTIME_LAUNCH_POLICY.pipe, true);
  assert.equal(INSTALLED_RUNTIME_LAUNCH_POLICY.remoteDebuggingPort, null);
  assert.equal(INSTALLED_RUNTIME_LAUNCH_POLICY.existingProfile, false);
  assert.equal(INSTALLED_RUNTIME_LAUNCH_POLICY.incognitoExtensionAccess, false);
  assert.deepEqual(INSTALLED_RUNTIME_LAUNCH_POLICY.window, {
    x: 1281,
    y: 0,
    width: 1279,
    height: 720,
    maximized: false
  });
  assert.equal(INSTALLED_RUNTIME_LAUNCH_POLICY.proxy.connectAllowed, false);
  assert.equal(INSTALLED_RUNTIME_LAUNCH_POLICY.proxy.bypassList, '<-loopback>');
  assert.match(INSTALLED_RUNTIME_LAUNCH_POLICY_SHA256, /^[A-F0-9]{64}$/);
  assert.match(LOOPBACK_HOST_RESOLVER_RULES, /MAP \* ~NOTFOUND/);
  assert.equal(
    RUNTIME_NETWORK_ALLOWLIST.some((value) => value.startsWith('https:')),
    false
  );
});

test('runtime allowlist is accepted by pinned Puppeteer and matches only the IPv6 loopback fixture', () => {
  assert.doesNotThrow(() =>
    assertSupportedUrlRestrictions({
      protocol: 'cdp',
      allowlist: [...RUNTIME_NETWORK_ALLOWLIST]
    })
  );
  assert.throws(
    () =>
      assertSupportedUrlRestrictions({
        protocol: 'cdp',
        allowlist: ['http://[::1]:*/*']
      }),
    /invalid hostname pattern/
  );

  const ipv6Rule = RUNTIME_NETWORK_ALLOWLIST.find((value) => value.includes('\\:\\:1'));
  assert.equal(ipv6Rule, 'http://[\\:\\:1]:*/*');
  assert.equal(RUNTIME_NETWORK_ALLOWLIST.includes('http://[::1]:*/*'), false);
  const ipv6Pattern = new URLPattern(ipv6Rule);
  assert.equal(ipv6Pattern.test('http://[::1]:43822/health'), true);
  assert.equal(ipv6Pattern.test('http://[::1]:43822/health?probe=1'), true);
  assert.equal(ipv6Pattern.test('http://127.0.0.1:43822/health'), false);
  assert.equal(ipv6Pattern.test('http://[::2]:43822/health'), false);
  assert.equal(ipv6Pattern.test('https://[::1]:43822/health'), false);
  assert.equal(ipv6Pattern.test('http://example.com:43822/health'), false);

  const httpPatterns = RUNTIME_NETWORK_ALLOWLIST.filter((value) => value.startsWith('http:')).map(
    (value) => new URLPattern(value)
  );
  for (const host of SYNTHETIC_FIXTURE_HOSTS) {
    const authority = host === '::1' ? '[::1]' : host;
    const fixtureUrl = `http://${authority}:43822/health?probe=1`;
    assert.equal(
      httpPatterns.filter((pattern) => pattern.test(fixtureUrl)).length,
      1,
      `expected one exact allowlist match for ${host}`
    );
  }
  assert.equal(
    httpPatterns.some((pattern) => pattern.test('http://example.com:43822/health')),
    false
  );
});

test('runtime proxy binding accepts only an exact generated loopback listener', () => {
  const proxy = { schema: 'sitewipe.loopback-deny-proxy.v1', host: '127.0.0.1', port: 43822 };
  assert.equal(validateRuntimeProxyBinding(proxy), proxy);
  for (const changed of [
    { ...proxy, host: '0.0.0.0' },
    { ...proxy, port: 0 },
    { ...proxy, connectAllowed: false }
  ]) {
    assert.throws(() => validateRuntimeProxyBinding(changed), /differs from the exact/);
  }
});

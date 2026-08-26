import assert from 'node:assert/strict';
import test from 'node:test';

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

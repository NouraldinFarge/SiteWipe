import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

import { SYNTHETIC_FIXTURE_HOSTS } from '../fixture-server.mjs';
import { LOOPBACK_DENY_PROXY_SCHEMA } from './loopback-deny-proxy.mjs';

const mappedFixtureHosts = SYNTHETIC_FIXTURE_HOSTS.filter((host) => isIP(host) === 0 && host !== 'localhost').sort();

export const LOOPBACK_HOST_RESOLVER_RULES = Object.freeze([
  ...mappedFixtureHosts.map((host) => `MAP ${host} 127.0.0.1`),
  'MAP * ~NOTFOUND',
  'EXCLUDE localhost'
]).join(',');

export const RUNTIME_NETWORK_ALLOWLIST = Object.freeze([
  'chrome-extension://*/*',
  ...SYNTHETIC_FIXTURE_HOSTS.map((host) => {
    const authority = host === '::1' ? '[::1]' : host;
    return `http://${authority}:*/*`;
  }).sort()
]);

export const INSTALLED_RUNTIME_LAUNCH_POLICY = deepFreeze({
  schema: 'sitewipe.installed-runtime-launch-policy.v2',
  puppeteerBrowser: 'chrome',
  protocol: 'cdp',
  headless: false,
  pipe: true,
  attachToExistingBrowser: false,
  remoteDebuggingPort: null,
  existingProfile: false,
  enableOnlySiteWipeExtension: true,
  incognitoExtensionAccess: false,
  acceptInsecureCertificates: false,
  locale: 'en-US',
  window: { x: 1281, y: 0, width: 1279, height: 720, maximized: false },
  hostResolverRules: LOOPBACK_HOST_RESOLVER_RULES,
  networkAllowlist: [...RUNTIME_NETWORK_ALLOWLIST],
  proxy: {
    schema: LOOPBACK_DENY_PROXY_SCHEMA,
    host: '127.0.0.1',
    portGeneratedAfterApproval: true,
    connectAllowed: false,
    bypassList: '<-loopback>',
    requestLedgerRequired: true
  },
  downloads: {
    policy: 'allow',
    ownedDirectoryOnly: true,
    automaticDeletion: false
  },
  environmentVariableNames: ['SystemRoot', 'TEMP', 'TMP', 'WINDIR'],
  launchTimeoutMs: 30_000,
  protocolTimeoutMs: 30_000,
  argumentTemplates: [
    '--disable-background-networking',
    '--disable-breakpad',
    '--disable-component-update',
    '--disable-crash-reporter',
    '--disable-default-apps',
    '--disable-domain-reliability',
    '--disable-quic',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-default-browser-check',
    '--no-first-run',
    '--proxy-server=http://127.0.0.1:<generated-port>',
    '--proxy-bypass-list=<-loopback>',
    '--lang=en-US',
    '--window-position=1281,0',
    '--window-size=1279,720',
    `--host-resolver-rules=${LOOPBACK_HOST_RESOLVER_RULES}`
  ],
  unsupportedSemanticsRemainNotRun: true
});

export const INSTALLED_RUNTIME_LAUNCH_POLICY_SHA256 = sha256(canonicalJsonBytes(INSTALLED_RUNTIME_LAUNCH_POLICY));

export function validateRuntimeProxyBinding(proxy) {
  const expectedKeys = ['host', 'port', 'schema'];
  if (
    !proxy ||
    typeof proxy !== 'object' ||
    Array.isArray(proxy) ||
    JSON.stringify(Object.keys(proxy).sort()) !== JSON.stringify(expectedKeys) ||
    proxy.schema !== LOOPBACK_DENY_PROXY_SCHEMA ||
    proxy.host !== INSTALLED_RUNTIME_LAUNCH_POLICY.proxy.host ||
    !Number.isInteger(proxy.port) ||
    proxy.port < 1 ||
    proxy.port > 65535
  ) {
    throw new Error('Installed browser proxy binding differs from the exact post-approval loopback policy.');
  }
  return proxy;
}

function canonicalJsonBytes(value) {
  return Buffer.from(`${stableJson(value)}\n`, 'utf8');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

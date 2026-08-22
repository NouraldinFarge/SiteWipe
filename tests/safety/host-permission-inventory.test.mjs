import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildHostPermissionInventory,
  canonicalizeHostPermissionOrigin,
  canonicalizeHostPermissionOrigins,
  hostPermissionPatternCovers,
  isBroadHostPermissionOrigin,
  normalizeHostPermissionInventory
} from '../../src/shared/host-permissions.js';

const requiredOrigins = [
  'http://example.com/*',
  'https://example.com/*',
  'http://*.example.com/*',
  'https://*.example.com/*'
];

test('host-permission patterns are canonicalized, deduplicated, and classified without broadening', () => {
  assert.equal(canonicalizeHostPermissionOrigin(' HTTPS://EXAMPLE.COM/* '), 'https://example.com/*');
  assert.equal(canonicalizeHostPermissionOrigin(' <ALL_URLS> '), '<all_urls>');
  assert.equal(canonicalizeHostPermissionOrigin('not a match pattern'), null);
  assert.deepEqual(canonicalizeHostPermissionOrigins(['HTTPS://EXAMPLE.COM/*', 'https://example.com/*']), [
    'https://example.com/*'
  ]);
  for (const origin of ['<all_urls>', '*://*/*', 'http://*/*', 'https://*/*']) {
    assert.equal(isBroadHostPermissionOrigin(origin), true, origin);
  }
  assert.equal(isBroadHostPermissionOrigin('https://*.example.com/*'), false);
});

test('inventory distinguishes exact grants, broader coverage, and truthful all-site access', () => {
  const inventory = buildHostPermissionInventory({
    requiredOrigins,
    coveredRequiredOrigins: requiredOrigins,
    grantedOrigins: [
      'https://example.com/*',
      'https://other.example/*',
      'https://*.unrelated.example/*',
      '*://*.example.com/*',
      'HTTPS://*/*',
      'http://*/*'
    ]
  });

  assert.deepEqual(inventory.exactRequiredHostPermissionOrigins, ['https://example.com/*']);
  assert.deepEqual(inventory.requiredCoveredByBroadHostPermissionOrigins, [
    'http://*.example.com/*',
    'http://example.com/*',
    'https://*.example.com/*'
  ]);
  assert.deepEqual(inventory.broadGrantedHostPermissionOrigins, ['*://*.example.com/*', 'http://*/*', 'https://*/*']);
  assert.deepEqual(inventory.exactGrantedHostPermissionOrigins, ['https://example.com/*']);
  assert.equal(JSON.stringify(inventory).includes('other.example'), false);
  assert.equal(JSON.stringify(inventory).includes('unrelated.example'), false);
  assert.equal(inventory.allSitesAccessGranted, true);
});

test('only wildcard patterns that cover the reviewed target survive inventory minimization', () => {
  assert.equal(hostPermissionPatternCovers('*://*.example.com/*', 'https://account.example.com/*'), true);
  assert.equal(hostPermissionPatternCovers('https://*.example.com/*', 'https://*.account.example.com/*'), true);
  assert.equal(hostPermissionPatternCovers('http://*.example.com/*', 'https://example.com/*'), false);
  assert.equal(hostPermissionPatternCovers('https://*.unrelated.example/*', 'https://example.com/*'), false);
});

test('a single scheme-wide grant is disclosed as broad without claiming all-site access', () => {
  const inventory = buildHostPermissionInventory({
    requiredOrigins: ['https://example.com/*'],
    coveredRequiredOrigins: ['https://example.com/*'],
    grantedOrigins: ['https://*/*']
  });
  assert.deepEqual(inventory.broadGrantedHostPermissionOrigins, ['https://*/*']);
  assert.equal(inventory.allSitesAccessGranted, false);
});

test('stored inventory normalization rejects derived-field and broad-grant tampering', () => {
  const inventory = buildHostPermissionInventory({
    requiredOrigins,
    coveredRequiredOrigins: requiredOrigins,
    grantedOrigins: ['<all_urls>']
  });
  assert.deepEqual(
    normalizeHostPermissionInventory(inventory, {
      requiredOrigins,
      coveredRequiredOrigins: requiredOrigins
    }),
    inventory
  );

  const forgedBoolean = structuredClone(inventory);
  forgedBoolean.allSitesAccessGranted = false;
  assert.equal(
    normalizeHostPermissionInventory(forgedBoolean, {
      requiredOrigins,
      coveredRequiredOrigins: requiredOrigins
    }),
    null
  );

  const forgedBroadGrant = structuredClone(inventory);
  forgedBroadGrant.broadGrantedHostPermissionOrigins = [];
  assert.equal(
    normalizeHostPermissionInventory(forgedBroadGrant, {
      requiredOrigins,
      coveredRequiredOrigins: requiredOrigins
    }),
    null
  );
});

test('stored inventory normalization ignores dictionary key order without ignoring semantic forgery', () => {
  const inventory = buildHostPermissionInventory({
    requiredOrigins,
    coveredRequiredOrigins: requiredOrigins,
    grantedOrigins: ['http://*/*', 'https://*/*']
  });
  const reordered = canonicalizeDictionaryKeyOrder(inventory);
  assert.notDeepEqual(Object.keys(reordered), Object.keys(inventory));
  assert.deepEqual(
    normalizeHostPermissionInventory(reordered, {
      requiredOrigins,
      coveredRequiredOrigins: requiredOrigins
    }),
    inventory
  );

  const reorderedArray = canonicalizeDictionaryKeyOrder(inventory);
  reorderedArray.grantedHostPermissionOrigins.reverse();
  assert.equal(
    normalizeHostPermissionInventory(reorderedArray, {
      requiredOrigins,
      coveredRequiredOrigins: requiredOrigins
    }),
    null
  );

  const forged = canonicalizeDictionaryKeyOrder(inventory);
  forged.requiredCoveredByBroadHostPermissionOrigins = [];
  assert.equal(
    normalizeHostPermissionInventory(forged, {
      requiredOrigins,
      coveredRequiredOrigins: requiredOrigins
    }),
    null
  );
});

function canonicalizeDictionaryKeyOrder(value) {
  if (Array.isArray(value)) return value.map(canonicalizeDictionaryKeyOrder);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalizeDictionaryKeyOrder(value[key])])
  );
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  observeOptionalPermission,
  reconcileNewOptionalPermissionGrant,
  requestOptionalPermissionWithProvenance
} from '../../src/options/permission-lifecycle.js';

test('optional permission request is the first browser API call in the user-gesture path', async () => {
  const granted = new Set();
  const calls = [];
  const permissions = createPermissionsAdapter(granted, calls);

  const result = await requestOptionalPermissionWithProvenance('webNavigation', {
    observedBeforeGesture: false,
    permissionsApi: permissions
  });

  assert.deepEqual(result, {
    permission: 'webNavigation',
    granted: true,
    observedBeforeGesture: false,
    grantProvenance: 'unknown'
  });
  assert.deepEqual(calls, ['request']);
});

test('request helper source never awaits contains before the native permission prompt', async () => {
  const source = await readFile(new URL('../../src/options/permission-lifecycle.js', import.meta.url), 'utf8');
  const requestStart = source.indexOf('export async function requestOptionalPermissionWithProvenance');
  const reconcileStart = source.indexOf('export async function reconcileNewOptionalPermissionGrant', requestStart);
  const requestBody = source.slice(requestStart, reconcileStart);

  assert.ok(requestStart >= 0 && reconcileStart > requestStart);
  assert.match(requestBody, /await permissionsApi\.request\(request\)/);
  assert.doesNotMatch(requestBody, /permissionsApi\.contains\(request\)/);
});

test('a preloaded positive observation preserves known pre-existing access without another inspection', async () => {
  const granted = new Set(['webNavigation']);
  const calls = [];
  const permissions = createPermissionsAdapter(granted, calls);

  const result = await requestOptionalPermissionWithProvenance('webNavigation', {
    observedBeforeGesture: true,
    permissionsApi: permissions
  });

  assert.equal(result.grantProvenance, 'preexisting_observed');
  assert.deepEqual(calls, ['request']);

  const reconciliation = await reconcileNewOptionalPermissionGrant(
    {
      ...result,
      authoritativeStateKnown: true,
      authoritativeFeatureEnabled: false
    },
    permissions
  );
  assert.equal(reconciliation.reason, 'preexisting_observed');
  assert.equal(reconciliation.preserved, true);
  assert.deepEqual(calls, ['request']);
});

test('permission observation happens outside request and returns null when inspection is unavailable', async () => {
  const granted = new Set(['webNavigation']);
  const calls = [];
  assert.equal(await observeOptionalPermission('webNavigation', createPermissionsAdapter(granted, calls)), true);
  assert.deepEqual(calls, ['contains']);
  assert.equal(await observeOptionalPermission('webNavigation', {}), null);
});

test('an ambiguous successful request is preserved when authoritative settings are off', async () => {
  for (const observedBeforeGesture of [false, null]) {
    const granted = new Set(['webNavigation']);
    const calls = [];
    const result = await reconcileNewOptionalPermissionGrant(
      {
        permission: 'webNavigation',
        granted: true,
        grantProvenance: 'unknown',
        observedBeforeGesture,
        authoritativeStateKnown: true,
        authoritativeFeatureEnabled: false
      },
      createPermissionsAdapter(granted, calls)
    );
    assert.equal(result.reason, 'grant_provenance_unknown');
    assert.equal(result.preserved, true);
    assert.equal(granted.has('webNavigation'), true);
    assert.deepEqual(calls, []);
  }
});

test('authoritative enablement preserves an optional grant after a response race', async () => {
  const granted = new Set(['webNavigation']);
  const calls = [];
  const result = await reconcileNewOptionalPermissionGrant(
    {
      permission: 'webNavigation',
      granted: true,
      grantProvenance: 'unknown',
      authoritativeStateKnown: true,
      authoritativeFeatureEnabled: true
    },
    createPermissionsAdapter(granted, calls)
  );

  assert.equal(result.preserved, true);
  assert.equal(result.reason, 'authoritative_feature_enabled');
  assert.equal(granted.has('webNavigation'), true);
  assert.deepEqual(calls, []);
});

test('only independently proven new access can be rolled back after authoritative disablement', async () => {
  const granted = new Set(['webNavigation']);
  const calls = [];
  const result = await reconcileNewOptionalPermissionGrant(
    {
      permission: 'webNavigation',
      granted: true,
      grantProvenance: 'newly_granted',
      authoritativeStateKnown: true,
      authoritativeFeatureEnabled: false
    },
    createPermissionsAdapter(granted, calls)
  );

  assert.equal(result.released, true);
  assert.equal(result.reason, 'absence_proved');
  assert.equal(granted.has('webNavigation'), false);
  assert.deepEqual(calls, ['contains', 'remove', 'contains']);
});

test('unknown authoritative state preserves even independently proven new access', async () => {
  const granted = new Set(['webNavigation']);
  const calls = [];
  const result = await reconcileNewOptionalPermissionGrant(
    {
      permission: 'webNavigation',
      granted: true,
      grantProvenance: 'newly_granted',
      authoritativeStateKnown: false,
      authoritativeFeatureEnabled: false
    },
    createPermissionsAdapter(granted, calls)
  );

  assert.equal(result.reason, 'authoritative_state_unknown');
  assert.equal(result.preserved, true);
  assert.equal(granted.has('webNavigation'), true);
  assert.deepEqual(calls, []);
});

test('failed revocation remains explicitly uncertain instead of claiming release', async () => {
  const granted = new Set(['webNavigation']);
  const calls = [];
  const permissions = createPermissionsAdapter(granted, calls, { retainOnRemove: true });
  const result = await reconcileNewOptionalPermissionGrant(
    {
      permission: 'webNavigation',
      granted: true,
      grantProvenance: 'newly_granted',
      authoritativeStateKnown: true,
      authoritativeFeatureEnabled: false
    },
    permissions
  );

  assert.equal(result.released, false);
  assert.equal(result.preserved, true);
  assert.equal(result.reason, 'release_not_confirmed');
  assert.equal(granted.has('webNavigation'), true);
});

function createPermissionsAdapter(granted, calls, { retainOnRemove = false, requestResult = true } = {}) {
  return {
    async contains({ permissions }) {
      calls.push('contains');
      return permissions.every((permission) => granted.has(permission));
    },
    async request({ permissions }) {
      calls.push('request');
      if (!requestResult) return false;
      for (const permission of permissions) granted.add(permission);
      return true;
    },
    async remove({ permissions }) {
      calls.push('remove');
      if (!retainOnRemove) {
        for (const permission of permissions) granted.delete(permission);
      }
      return true;
    }
  };
}

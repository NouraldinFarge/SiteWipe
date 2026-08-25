import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  observeOptionalPermission,
  removeOptionalPermission,
  requestOptionalPermission
} from '../../src/options/permission-lifecycle.js';

test('optional permission request is the first asynchronous browser API call in its dedicated action', async () => {
  const granted = new Set();
  const calls = [];
  const result = await requestOptionalPermission('webNavigation', createPermissionsAdapter(granted, calls));

  assert.deepEqual(result, { permission: 'webNavigation', granted: true });
  assert.deepEqual(calls, ['request']);
  assert.equal(granted.has('webNavigation'), true);
});

test('request source never inspects state, infers ownership, subscribes to events, or removes access', async () => {
  const source = await readFile(new URL('../../src/options/permission-lifecycle.js', import.meta.url), 'utf8');
  const requestStart = source.indexOf('export async function requestOptionalPermission');
  const removeStart = source.indexOf('export async function removeOptionalPermission', requestStart);
  const requestEnd = source.indexOf('\n}\n', requestStart) + 2;
  const requestBody = source.slice(requestStart, requestEnd);

  assert.ok(requestStart >= 0 && requestEnd > requestStart && removeStart > requestEnd);
  assert.match(requestBody, /await permissionsApi\.request\(request\)/);
  assert.doesNotMatch(requestBody, /permissionsApi\.(?:contains|remove)\(request\)/);
  assert.doesNotMatch(requestBody, /onAdded|addListener|removeListener|newly_granted|provenance|ownership/i);
});

test('only a literal-true browser request result is treated as granted', async () => {
  const result = await requestOptionalPermission('webNavigation', { request: async () => 1 });
  assert.deepEqual(result, { permission: 'webNavigation', granted: false });
});

test('permission observation is separate and returns null when inspection is unavailable', async () => {
  const granted = new Set(['webNavigation']);
  const calls = [];
  assert.equal(await observeOptionalPermission('webNavigation', createPermissionsAdapter(granted, calls)), true);
  assert.deepEqual(calls, ['contains']);
  assert.equal(await observeOptionalPermission('webNavigation', {}), null);
});

test('explicit removal calls remove directly without an ownership or presence inference', async () => {
  const granted = new Set(['webNavigation']);
  const calls = [];
  const result = await removeOptionalPermission('webNavigation', createPermissionsAdapter(granted, calls));

  assert.deepEqual(result, { permission: 'webNavigation', removed: true });
  assert.deepEqual(calls, ['remove']);
  assert.equal(granted.has('webNavigation'), false);
});

test('only a literal-true browser removal result is treated as removed', async () => {
  const result = await removeOptionalPermission('webNavigation', { remove: async () => 1 });
  assert.deepEqual(result, { permission: 'webNavigation', removed: false });
});

function createPermissionsAdapter(granted, calls, { requestResult = true, removeResult = true } = {}) {
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
      if (!removeResult) return false;
      for (const permission of permissions) granted.delete(permission);
      return true;
    }
  };
}

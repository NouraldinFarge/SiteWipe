import assert from 'node:assert/strict';
import test from 'node:test';

import { STORAGE_KEYS } from '../../src/shared/constants.js';
import {
  discardUninvokedPermissionLease,
  getPermissionLease,
  isPreparedPermissionLeaseLive,
  markPermissionLeaseActive,
  markPermissionLeasePromptGrantOwned,
  markPermissionLeasePromptPending,
  PERMISSION_LEASE_SCHEMA_VERSION,
  preparePermissionLease,
  reconcilePermissionLease,
  revokePermissionLeaseOwnership
} from '../../src/background/permission-leases.js';

const PRIMARY = 'https://example.com/*';
const SUBDOMAINS = 'https://*.example.com/*';

test('durable permission leases preserve pre-existing patterns and release only temporary access', async () => {
  const storage = createStorageArea();
  const granted = new Set([PRIMARY, SUBDOMAINS]);
  const released = [];
  const lease = await preparePermissionLease(storage, {
    requestedOrigins: [PRIMARY, SUBDOMAINS],
    preexistingOrigins: [PRIMARY],
    reviewExpiresAt: '2026-08-16T12:05:00.000Z',
    now: () => Date.parse('2026-08-16T12:00:00.000Z'),
    createId: () => 'lease-0001'
  });

  assert.deepEqual(lease.preexistingOrigins, [PRIMARY]);
  assert.deepEqual(lease.temporaryOrigins, [SUBDOMAINS]);
  await markPermissionLeasePromptPending(storage, lease.id, () => Date.parse('2026-08-16T12:00:30.000Z'));
  const binding = permissionLeaseBinding(lease);
  const ownedLease = await markPermissionLeasePromptGrantOwned(
    storage,
    lease.id,
    () => Date.parse('2026-08-16T12:00:45.000Z'),
    binding
  );
  assert.equal(ownedLease.ownershipProof, 'reviewed_prompt_grant');
  const activeLease = await markPermissionLeaseActive(storage, lease.id, () => Date.parse('2026-08-16T12:01:00.000Z'), {
    ...binding
  });
  assert.equal(activeLease.status, 'active_cleanup');
  assert.equal(activeLease.ownershipProof, 'admitted_cleanup');

  const result = await reconcilePermissionLease(storage, {
    containsHostPermissions: async ([origin]) => granted.has(origin),
    releaseHostPermissions: async (origins) => {
      released.push(...origins);
      for (const origin of origins) granted.delete(origin);
      return true;
    }
  });

  assert.deepEqual(released, [SUBDOMAINS]);
  assert.equal(granted.has(PRIMARY), true);
  assert.equal(result.released, true);
  assert.equal(result.recordRetained, false);
  assert.equal(await getPermissionLease(storage), null);
});

test('lease activation atomically requires prompt-pending status and the exact review binding', async () => {
  const storage = createStorageArea();
  const lease = await preparePermissionLease(storage, {
    requestedOrigins: [PRIMARY, SUBDOMAINS],
    preexistingOrigins: [PRIMARY],
    reviewExpiresAt: '2026-08-16T12:05:00.000Z',
    now: () => Date.parse('2026-08-16T12:00:00.000Z'),
    createId: () => 'lease-bound-activation'
  });
  const exactBinding = {
    requestedOrigins: lease.requestedOrigins,
    preexistingOrigins: lease.preexistingOrigins,
    temporaryOrigins: lease.temporaryOrigins,
    reviewExpiresAt: lease.reviewExpiresAt
  };

  assert.equal(
    await markPermissionLeaseActive(storage, lease.id, () => Date.parse('2026-08-16T12:00:15.000Z'), exactBinding),
    null
  );
  assert.equal((await getPermissionLease(storage)).status, 'prepared');

  await markPermissionLeasePromptPending(storage, lease.id, () => Date.parse('2026-08-16T12:00:30.000Z'));
  assert.equal(
    await markPermissionLeaseActive(storage, lease.id, () => Date.parse('2026-08-16T12:00:45.000Z'), {
      ...exactBinding,
      reviewExpiresAt: '2026-08-16T12:06:00.000Z'
    }),
    null
  );
  assert.equal((await getPermissionLease(storage)).status, 'prompt_pending');

  assert.equal(
    await markPermissionLeasePromptGrantOwned(storage, lease.id, () => Date.parse('2026-08-16T12:00:50.000Z'), {
      ...exactBinding,
      reviewExpiresAt: '2026-08-16T12:06:00.000Z'
    }),
    null
  );
  const owned = await markPermissionLeasePromptGrantOwned(
    storage,
    lease.id,
    () => Date.parse('2026-08-16T12:00:55.000Z'),
    exactBinding
  );
  assert.equal(owned.ownershipProof, 'reviewed_prompt_grant');

  const active = await markPermissionLeaseActive(
    storage,
    lease.id,
    () => Date.parse('2026-08-16T12:01:00.000Z'),
    exactBinding
  );
  assert.equal(active.status, 'active_cleanup');
  assert.equal(active.ownershipProof, 'admitted_cleanup');
  assert.equal(
    await markPermissionLeaseActive(storage, lease.id, () => Date.parse('2026-08-16T12:01:15.000Z'), exactBinding),
    null
  );
});

test('a proofless lease is discarded without inspecting or removing browser access', async () => {
  const storage = createStorageArea();
  await preparePermissionLease(storage, {
    requestedOrigins: [PRIMARY],
    preexistingOrigins: [],
    reviewExpiresAt: '2026-08-16T12:05:00.000Z',
    now: () => Date.parse('2026-08-16T12:00:00.000Z'),
    createId: () => 'lease-0002'
  });

  let permissionApiCalls = 0;
  const result = await reconcilePermissionLease(storage, {
    containsHostPermissions: async () => {
      permissionApiCalls += 1;
      return true;
    },
    releaseHostPermissions: async () => {
      permissionApiCalls += 1;
      return false;
    },
    now: () => Date.parse('2026-08-16T12:02:00.000Z')
  });

  assert.equal(result.released, false);
  assert.equal(result.permissionsPreserved, true);
  assert.equal(result.recordRetained, false);
  assert.equal(result.reason, 'proofless_ownership_discarded');
  assert.equal(permissionApiCalls, 0);
  assert.equal(await getPermissionLease(storage), null);
});

test('a failed or unverifiable owned permission release retains the recovery obligation', async () => {
  const storage = createStorageArea();
  const lease = await preparePermissionLease(storage, {
    requestedOrigins: [PRIMARY],
    preexistingOrigins: [],
    reviewExpiresAt: '2026-08-16T12:05:00.000Z',
    now: () => Date.parse('2026-08-16T12:00:00.000Z'),
    createId: () => 'lease-owned-release-failure'
  });
  await ownAndActivateLease(storage, lease);

  let containsCalls = 0;
  const result = await reconcilePermissionLease(storage, {
    containsHostPermissions: async () => {
      containsCalls += 1;
      if (containsCalls > 1) {
        throw new Error(
          'permission state unavailable at C:\\Users\\Private\\lease.txt for https://example.com/private'
        );
      }
      return true;
    },
    releaseHostPermissions: async () => false,
    now: () => Date.parse('2026-08-16T12:02:00.000Z')
  });

  assert.equal(result.released, false);
  assert.equal(result.recordRetained, true);
  const retained = await getPermissionLease(storage);
  assert.equal(retained.status, 'release_pending');
  assert.equal(retained.ownershipProof, 'admitted_cleanup');
  assert.equal(retained.releaseAttemptCount, 1);
  assert.match(retained.lastError, /could not be verified/i);
  assert.doesNotMatch(retained.lastError, /C:\\Users|https:\/\/example\.com/);
  assert.doesNotMatch(result.error, /C:\\Users|https:\/\/example\.com/);
});

test('restart recovery proves absence before forgetting a durable lease', async () => {
  const storage = createStorageArea();
  const lease = await preparePermissionLease(storage, {
    requestedOrigins: [PRIMARY],
    preexistingOrigins: [],
    reviewExpiresAt: '2026-08-16T12:05:00.000Z',
    now: () => Date.parse('2026-08-16T12:00:00.000Z'),
    createId: () => 'lease-0003'
  });
  assert.equal(isPreparedPermissionLeaseLive(lease, Date.parse('2026-08-16T12:04:59.000Z')), true);
  assert.equal(isPreparedPermissionLeaseLive(lease, Date.parse('2026-08-16T12:05:01.000Z')), false);
  await ownAndActivateLease(storage, lease);

  const result = await reconcilePermissionLease(storage, {
    containsHostPermissions: async () => false,
    releaseHostPermissions: async () => {
      throw new Error('release should not run when access is already absent');
    }
  });
  assert.equal(result.reason, 'already_absent');
  assert.equal(await getPermissionLease(storage), null);
});

test('exact inventory proof clears a lease while preserving a later broad user grant', async () => {
  const storage = createStorageArea();
  const granted = new Set([PRIMARY, '<all_urls>']);
  const released = [];
  let containsCalls = 0;
  const lease = await preparePermissionLease(storage, {
    requestedOrigins: [PRIMARY],
    preexistingOrigins: [],
    reviewExpiresAt: '2026-08-16T12:05:00.000Z',
    now: () => Date.parse('2026-08-16T12:00:00.000Z'),
    createId: () => 'lease-broad-after-review'
  });
  await ownAndActivateLease(storage, lease);

  const result = await reconcilePermissionLease(storage, {
    containsHostPermissions: async () => {
      containsCalls += 1;
      return true;
    },
    getAllHostPermissions: async () => ({ origins: [...granted] }),
    releaseHostPermissions: async (origins) => {
      released.push(...origins);
      for (const origin of origins) granted.delete(origin);
      return true;
    }
  });

  assert.equal(containsCalls, 0, 'production-style reconciliation must use exact inventory membership');
  assert.deepEqual(released, [PRIMARY]);
  assert.deepEqual([...granted], ['<all_urls>']);
  assert.equal(result.released, true);
  assert.equal(result.recordRetained, false);
  assert.equal(await getPermissionLease(storage), null);
});

test('invalid durable lease data fails closed without removing any permission', async () => {
  const storage = createStorageArea({
    [STORAGE_KEYS.permissionLease]: {
      schemaVersion: 1,
      id: 'lease-0004',
      status: 'release_pending',
      requestedOrigins: ['<all_urls>'],
      preexistingOrigins: [],
      temporaryOrigins: ['<all_urls>']
    }
  });
  let removeCalled = false;

  await assert.rejects(
    reconcilePermissionLease(storage, {
      containsHostPermissions: async () => true,
      releaseHostPermissions: async () => {
        removeCalled = true;
        return true;
      }
    }),
    /durable target-access lease is invalid/i
  );
  assert.equal(removeCalled, false);
  assert.ok(storage.state[STORAGE_KEYS.permissionLease]);
});

test('valid-looking lease corruption cannot remove broad or inconsistently classified access', async () => {
  const timestamp = '2026-08-16T12:00:00.000Z';
  const records = [
    {
      schemaVersion: 1,
      id: 'lease-0005',
      status: 'release_pending',
      requestedOrigins: ['https://*/*'],
      preexistingOrigins: [],
      temporaryOrigins: ['https://*/*'],
      createdAt: timestamp,
      updatedAt: timestamp,
      reviewExpiresAt: '2026-08-16T12:05:00.000Z',
      releaseAttemptCount: 0,
      lastReleaseAttemptAt: null,
      lastError: null
    },
    {
      schemaVersion: 1,
      id: 'lease-0006',
      status: 'release_pending',
      requestedOrigins: [PRIMARY, SUBDOMAINS],
      preexistingOrigins: [PRIMARY],
      temporaryOrigins: [PRIMARY],
      createdAt: timestamp,
      updatedAt: timestamp,
      reviewExpiresAt: '2026-08-16T12:05:00.000Z',
      releaseAttemptCount: 0,
      lastReleaseAttemptAt: null,
      lastError: null
    },
    {
      schemaVersion: 1,
      id: 'lease-0007',
      status: 'release_pending',
      requestedOrigins: [PRIMARY, PRIMARY],
      preexistingOrigins: [],
      temporaryOrigins: [PRIMARY],
      createdAt: timestamp,
      updatedAt: timestamp,
      reviewExpiresAt: '2026-08-16T12:05:00.000Z',
      releaseAttemptCount: 0,
      lastReleaseAttemptAt: null,
      lastError: null
    },
    {
      schemaVersion: 1,
      id: 'lease-0008',
      status: 'release_pending',
      requestedOrigins: [PRIMARY],
      preexistingOrigins: [],
      temporaryOrigins: [PRIMARY],
      createdAt: timestamp,
      updatedAt: '2026-08-16T11:59:59.000Z',
      reviewExpiresAt: '2026-08-16T12:05:00.000Z',
      releaseAttemptCount: 1,
      lastReleaseAttemptAt: null,
      lastError: null
    }
  ];

  for (const record of records) {
    const storage = createStorageArea({ [STORAGE_KEYS.permissionLease]: record });
    let permissionApiCalled = false;
    await assert.rejects(
      reconcilePermissionLease(storage, {
        containsHostPermissions: async () => {
          permissionApiCalled = true;
          return true;
        },
        releaseHostPermissions: async () => {
          permissionApiCalled = true;
          return true;
        }
      }),
      /durable target-access lease is invalid/i
    );
    assert.equal(permissionApiCalled, false);
    assert.ok(storage.state[STORAGE_KEYS.permissionLease]);
  }
});

test('a lease is never persisted without a future review expiration', async () => {
  const storage = createStorageArea();
  await assert.rejects(
    preparePermissionLease(storage, {
      requestedOrigins: [PRIMARY],
      preexistingOrigins: [],
      reviewExpiresAt: '2026-08-16T12:00:00.000Z',
      now: () => Date.parse('2026-08-16T12:00:00.000Z'),
      createId: () => 'lease-0009'
    }),
    /review expiration is invalid/i
  );
  assert.equal(await getPermissionLease(storage), null);
});

test('reviewed prompt ownership cannot be recorded at or after the prompt lease deadline', async () => {
  const storage = createStorageArea();
  const lease = await preparePermissionLease(storage, {
    requestedOrigins: [PRIMARY],
    preexistingOrigins: [],
    reviewExpiresAt: '2026-08-16T12:05:00.000Z',
    now: () => Date.parse('2026-08-16T12:00:00.000Z'),
    createId: () => 'lease-expired-prompt-marker'
  });
  const pending = await markPermissionLeasePromptPending(storage, lease.id, () =>
    Date.parse('2026-08-16T12:00:30.000Z')
  );
  assert.equal(
    await markPermissionLeasePromptGrantOwned(
      storage,
      lease.id,
      () => Date.parse(pending.promptPendingUntil),
      permissionLeaseBinding(lease)
    ),
    null
  );
  const retained = await getPermissionLease(storage);
  assert.equal(retained.status, 'prompt_pending');
  assert.equal(retained.ownershipProof, null);
  assert.ok(Date.parse(retained.promptPendingUntil) > Date.parse(retained.updatedAt));
});

test('owned prompt leases cannot be discarded as uninvoked and remain recoverable across restart', async () => {
  const storage = createStorageArea();
  const granted = new Set([PRIMARY]);
  const lease = await preparePermissionLease(storage, {
    requestedOrigins: [PRIMARY],
    preexistingOrigins: [],
    reviewExpiresAt: '2026-08-16T12:05:00.000Z',
    now: () => Date.parse('2026-08-16T12:00:00.000Z'),
    createId: () => 'lease-owned-prompt-restart'
  });
  await markPermissionLeasePromptPending(storage, lease.id, () => Date.parse('2026-08-16T12:00:10.000Z'));
  const owned = await markPermissionLeasePromptGrantOwned(
    storage,
    lease.id,
    () => Date.parse('2026-08-16T12:00:20.000Z'),
    permissionLeaseBinding(lease)
  );
  assert.equal(owned.schemaVersion, PERMISSION_LEASE_SCHEMA_VERSION);
  assert.equal(owned.ownershipProof, 'reviewed_prompt_grant');

  const discard = await discardUninvokedPermissionLease(storage, lease.id);
  assert.equal(discard.recordRetained, true);
  assert.equal(discard.reason, 'lease_not_proofless');

  const released = [];
  const recovery = await reconcilePermissionLease(
    storage,
    {
      forcePromptSettlement: true,
      getAllHostPermissions: async () => ({ origins: [...granted] }),
      releaseHostPermissions: async (origins) => {
        released.push(...origins);
        for (const origin of origins) granted.delete(origin);
        return true;
      }
    },
    lease.id
  );
  assert.equal(recovery.released, true);
  assert.deepEqual(released, [PRIMARY]);
  assert.equal(await getPermissionLease(storage), null);
});

test('release-pending ownership provenance survives a failed attempt and drives a later exact retry', async () => {
  const storage = createStorageArea();
  const granted = new Set([PRIMARY]);
  const lease = await preparePermissionLease(storage, {
    requestedOrigins: [PRIMARY],
    preexistingOrigins: [],
    reviewExpiresAt: '2026-08-16T12:05:00.000Z',
    now: () => Date.parse('2026-08-16T12:00:00.000Z'),
    createId: () => 'lease-owned-release-retry'
  });
  await ownAndActivateLease(storage, lease);

  const first = await reconcilePermissionLease(storage, {
    getAllHostPermissions: async () => ({ origins: [...granted] }),
    releaseHostPermissions: async () => false,
    now: () => Date.parse('2026-08-16T12:01:00.000Z')
  });
  assert.equal(first.recordRetained, true);
  const retained = await getPermissionLease(storage);
  assert.equal(retained.status, 'release_pending');
  assert.equal(retained.ownershipProof, 'admitted_cleanup');

  const second = await reconcilePermissionLease(storage, {
    getAllHostPermissions: async () => ({ origins: [...granted] }),
    releaseHostPermissions: async (origins) => {
      for (const origin of origins) granted.delete(origin);
      return true;
    },
    now: () => Date.parse('2026-08-16T12:02:00.000Z')
  });
  assert.equal(second.released, true);
  assert.equal(second.recordRetained, false);
  assert.equal(await getPermissionLease(storage), null);
});

test('revoked ownership is discarded without removing a later manual regrant', async () => {
  const storage = createStorageArea();
  const lease = await preparePermissionLease(storage, {
    requestedOrigins: [PRIMARY],
    preexistingOrigins: [],
    reviewExpiresAt: '2026-08-16T12:05:00.000Z',
    now: () => Date.parse('2026-08-16T12:00:00.000Z'),
    createId: () => 'lease-revoked-manual-regrant'
  });
  await markPermissionLeasePromptPending(storage, lease.id, () => Date.parse('2026-08-16T12:00:10.000Z'));
  await markPermissionLeasePromptGrantOwned(
    storage,
    lease.id,
    () => Date.parse('2026-08-16T12:00:20.000Z'),
    permissionLeaseBinding(lease)
  );
  const revocation = await revokePermissionLeaseOwnership(
    storage,
    ['<all_urls>', PRIMARY, PRIMARY, 'malformed pattern'],
    () => Date.parse('2026-08-16T12:00:30.000Z')
  );
  assert.equal(revocation.revoked, true);
  assert.equal(revocation.lease.ownershipProof, 'revoked');
  assert.equal(revocation.lease.status, 'prompt_pending');

  let permissionApiCalls = 0;
  const result = await reconcilePermissionLease(storage, {
    getAllHostPermissions: async () => {
      permissionApiCalls += 1;
      return { origins: [PRIMARY] };
    },
    releaseHostPermissions: async () => {
      permissionApiCalls += 1;
      return true;
    }
  });
  assert.equal(result.reason, 'revoked_ownership_discarded');
  assert.equal(result.permissionsPreserved, true);
  assert.equal(permissionApiCalls, 0);
  assert.equal(await getPermissionLease(storage), null);
});

test('revocation after the prompt TTL creates a valid non-runnable release record', async () => {
  const storage = createStorageArea();
  const lease = await preparePermissionLease(storage, {
    requestedOrigins: [PRIMARY],
    preexistingOrigins: [],
    reviewExpiresAt: '2026-08-16T12:05:00.000Z',
    now: () => Date.parse('2026-08-16T12:00:00.000Z'),
    createId: () => 'lease-revoked-after-prompt-ttl'
  });
  await markPermissionLeasePromptPending(storage, lease.id, () => Date.parse('2026-08-16T12:00:10.000Z'));
  await markPermissionLeasePromptGrantOwned(
    storage,
    lease.id,
    () => Date.parse('2026-08-16T12:00:20.000Z'),
    permissionLeaseBinding(lease)
  );
  const revocation = await revokePermissionLeaseOwnership(storage, [PRIMARY], () =>
    Date.parse('2026-08-16T12:31:00.000Z')
  );
  assert.equal(revocation.revoked, true);
  const retained = await getPermissionLease(storage);
  assert.equal(retained.status, 'release_pending');
  assert.equal(retained.promptPendingUntil, null);
  assert.equal(retained.ownershipProof, 'revoked');
  assert.equal(retained.ownershipRevokedAt, '2026-08-16T12:31:00.000Z');
});

test('legacy provenance-free lease bookkeeping is discarded while browser access remains untouched', async () => {
  const timestamp = '2026-08-16T12:00:00.000Z';
  const storage = createStorageArea({
    [STORAGE_KEYS.permissionLease]: {
      schemaVersion: 2,
      id: 'lease-legacy-provenance-free',
      status: 'release_pending',
      requestedOrigins: [PRIMARY],
      preexistingOrigins: [],
      temporaryOrigins: [PRIMARY],
      createdAt: timestamp,
      updatedAt: timestamp,
      reviewExpiresAt: '2026-08-16T12:05:00.000Z',
      promptPendingUntil: null,
      releaseAttemptCount: 0,
      lastReleaseAttemptAt: null,
      lastError: null
    }
  });
  const result = await discardUninvokedPermissionLease(storage, 'lease-legacy-provenance-free');
  assert.equal(result.reason, 'invalid_proofless_lease_discarded');
  assert.equal(result.permissionsPreserved, true);
  assert.equal(result.recordRetained, false);
  assert.equal(storage.state[STORAGE_KEYS.permissionLease], undefined);
});

function permissionLeaseBinding(lease) {
  return {
    requestedOrigins: lease.requestedOrigins,
    preexistingOrigins: lease.preexistingOrigins,
    temporaryOrigins: lease.temporaryOrigins,
    reviewExpiresAt: lease.reviewExpiresAt
  };
}

async function ownAndActivateLease(storage, lease) {
  await markPermissionLeasePromptPending(storage, lease.id, () => Date.parse('2026-08-16T12:00:10.000Z'));
  const owned = await markPermissionLeasePromptGrantOwned(
    storage,
    lease.id,
    () => Date.parse('2026-08-16T12:00:20.000Z'),
    permissionLeaseBinding(lease)
  );
  assert.equal(owned?.ownershipProof, 'reviewed_prompt_grant');
  const active = await markPermissionLeaseActive(
    storage,
    lease.id,
    () => Date.parse('2026-08-16T12:00:30.000Z'),
    permissionLeaseBinding(lease)
  );
  assert.equal(active?.ownershipProof, 'admitted_cleanup');
  return active;
}

function createStorageArea(initial = {}) {
  const state = structuredClone(initial);
  return {
    state,
    async get(keys) {
      const requested = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(requested.filter((key) => Object.hasOwn(state, key)).map((key) => [key, state[key]]));
    },
    async set(values) {
      Object.assign(state, structuredClone(values));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    }
  };
}

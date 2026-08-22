import test from 'node:test';
import assert from 'node:assert/strict';

import { clearSiteWipeDnrRules, hasPendingSiteWipeDnrMutation } from '../../src/background/dnr-shield.js';
import { reconcileOwnedShieldState } from '../../src/background/shield-recovery.js';

const trackedShield = Object.freeze({
  domain: 'synthetic.example',
  displayName: 'synthetic.example',
  associatedTargets: [],
  ruleIds: [730000],
  urlFilters: ['||synthetic.example^'],
  mode: 'cleanup-only',
  lifecycle: 'active',
  expiresAt: null,
  startedAt: '2026-08-16T00:00:00.000Z',
  jobId: 'job-synthetic'
});

test('recovery record is forgotten only after diagnostics prove the owned range empty', async () => {
  let forgotten = 0;
  let retained = 0;
  const result = await reconcileOwnedShieldState({
    activeShield: trackedShield,
    clearRules: async () => ({ ok: true, ruleIds: [730000] }),
    diagnose: async () => ({ available: true, error: null, activeRuleIds: [] }),
    forget: async () => {
      forgotten += 1;
    },
    retain: async () => {
      retained += 1;
    }
  });

  assert.equal(result.cleared, true);
  assert.equal(forgotten, 1);
  assert.equal(retained, 0);
});

test('API unavailability retains a tracked recovery record as unknown', async () => {
  let forgotten = 0;
  let retainedRecord = null;
  const result = await reconcileOwnedShieldState({
    activeShield: trackedShield,
    clearRules: async () => ({ ok: false, reason: 'unavailable' }),
    diagnose: async () => ({ available: false, error: null, activeRuleIds: [] }),
    forget: async () => {
      forgotten += 1;
    },
    retain: async (record) => {
      retainedRecord = record;
      return record;
    }
  });

  assert.equal(result.cleared, false);
  assert.equal(result.recordRetained, true);
  assert.equal(retainedRecord.lifecycle, 'unknown');
  assert.deepEqual(retainedRecord.ruleIds, [730000]);
  assert.equal(forgotten, 0);
});

test('a timed-out clear cannot erase recovery state while a rule remains', async () => {
  let forgotten = 0;
  let retainedRecord = null;
  const result = await reconcileOwnedShieldState({
    activeShield: trackedShield,
    clearRules: async () => {
      throw new Error('DNR shield clear timed out');
    },
    diagnose: async () => ({ available: true, error: null, activeRuleIds: [730000] }),
    forget: async () => {
      forgotten += 1;
    },
    retain: async (record) => {
      retainedRecord = record;
      return record;
    }
  });

  assert.equal(result.cleared, false);
  assert.match(result.clearError, /timed out/);
  assert.equal(retainedRecord.lifecycle, 'unknown');
  assert.equal(forgotten, 0);
});

test('a provisionally empty range cannot erase recovery intent while a timed-out clear can still settle', async () => {
  let settleClear;
  const pendingClear = new Promise((resolve) => {
    settleClear = resolve;
  });
  globalThis.chrome = {
    declarativeNetRequest: {
      updateSessionRules: () => pendingClear
    }
  };
  let forgotten = 0;
  let retainedRecord = null;
  const result = await reconcileOwnedShieldState({
    activeShield: trackedShield,
    clearRules: (_ruleIds, options) => clearSiteWipeDnrRules([730000], { ...options, timeoutMs: 1 }),
    diagnose: async () => ({ available: true, error: null, activeRuleIds: [] }),
    forget: async () => {
      forgotten += 1;
    },
    retain: async (record) => {
      retainedRecord = record;
      return record;
    }
  });

  assert.equal(result.cleared, false);
  assert.equal(result.pointInTimeRangeEmpty, true);
  assert.equal(result.pendingMutation, true);
  assert.equal(forgotten, 0);
  assert.equal(retainedRecord.pendingMutation, true);
  assert.equal(hasPendingSiteWipeDnrMutation(), true);

  settleClear();
  await pendingClear;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(hasPendingSiteWipeDnrMutation(), false);
});

test('an orphan active rule reconstructs a persistent recovery record', async () => {
  let retainedRecord = null;
  const result = await reconcileOwnedShieldState({
    activeShield: null,
    clearRules: async () => ({ ok: false, reason: 'synthetic failure' }),
    diagnose: async () => ({ available: true, error: null, activeRuleIds: [730011] }),
    forget: async () => assert.fail('orphan rule must not be forgotten'),
    retain: async (record) => {
      retainedRecord = record;
      return record;
    }
  });

  assert.equal(result.cleared, false);
  assert.equal(result.recordRetained, true);
  assert.equal(retainedRecord.lifecycle, 'unknown');
  assert.deepEqual(retainedRecord.ruleIds, [730011]);
  assert.equal(retainedRecord.mode, 'cleanup-only');
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertCleanupJobTransition,
  isStoredReport,
  normalizeActiveShield,
  normalizeCleanupJob,
  normalizeMaintenanceSnapshot
} from '../../src/shared/state-schema.js';
import { createReport, finishReport } from '../../src/background/report.js';

const startedAt = '2026-08-16T12:00:00.000Z';
const updatedAt = '2026-08-16T12:00:01.000Z';

function job(status = 'running', overrides = {}) {
  return {
    id: 'sitewipe-1-abc',
    status,
    targetDomain: 'example.com',
    startedAt,
    updatedAt,
    percent: status === 'completed' ? 100 : 10,
    phase: 'test',
    label: 'Test',
    detail: 'Test detail',
    ...overrides
  };
}

test('cleanup job schema rejects malformed records and clamps untrusted scalar fields', () => {
  assert.equal(normalizeCleanupJob(null), null);
  assert.equal(normalizeCleanupJob({ status: 'running' }), null);
  assert.equal(normalizeCleanupJob(job('invented')), null);
  const normalized = normalizeCleanupJob(job('running', { percent: 900, detail: 'x'.repeat(2000) }));
  assert.equal(normalized.percent, 100);
  assert.equal(normalized.detail.length, 1600);
});

test('cleanup job state machine allows only explicit transitions', () => {
  assert.equal(assertCleanupJobTransition(null, job('running')).status, 'running');
  for (const status of ['running', 'completed', 'failed', 'cancelled', 'interrupted']) {
    assert.equal(assertCleanupJobTransition(job('running'), job(status)).status, status);
  }
  assert.throws(() => assertCleanupJobTransition(null, job('completed')), /must begin in the running state/);
  assert.throws(() => assertCleanupJobTransition(job('completed'), job('running')), /Invalid cleanup job transition/);
  assert.throws(
    () => assertCleanupJobTransition(job('running'), job('failed', { id: 'sitewipe-other' })),
    /replacement cleanup job must begin in the running state/
  );
});

test('active shield schema accepts only SiteWipe-owned rule IDs and valid modes/timestamps', () => {
  const shield = normalizeActiveShield({
    domain: 'example.com',
    displayName: 'example.com',
    associatedTargets: [],
    ruleIds: [729999, 730000, 730000, 730499, 730500],
    urlFilters: ['||example.com^'],
    mode: 'cleanup-only',
    lifecycle: 'installing',
    expiresAt: null,
    startedAt,
    jobId: 'sitewipe-1-abc'
  });
  assert.deepEqual(shield.ruleIds, [730000, 730499]);
  assert.equal(shield.lifecycle, 'installing');
  assert.equal(normalizeActiveShield({ ...shield, lifecycle: 'invented' }), null);
  assert.equal(normalizeActiveShield({ ...shield, mode: 'unknown' }), null);
  assert.equal(normalizeActiveShield({ ...shield, ruleIds: [1, 2] }), null);
  assert.equal(normalizeActiveShield({ ...shield, startedAt: 'not-a-date' }), null);
});

test('stored report and maintenance schemas reject malformed or oversized data', async () => {
  const report = await finishReport(
    createReport({ domain: 'example.com', matchMode: 'registrable_domain' }, 'example.com')
  );
  assert.equal(isStoredReport(report), true);
  assert.equal(isStoredReport({ ...report, status: 'invented' }), false);
  assert.equal(isStoredReport({ ...report, sections: {} }), false);
  assert.equal(isStoredReport({ ...report, huge: 'x'.repeat(2 * 1024 * 1024) }), false);
  assert.deepEqual(
    normalizeMaintenanceSnapshot({
      reason: 'manual',
      at: updatedAt,
      shieldExpired: true,
      reportExpired: false,
      staleJobRecovered: false,
      orphanShieldRepaired: true,
      cleanupReviewExpired: true,
      unexpected: 'discarded'
    }),
    {
      reason: 'manual',
      at: updatedAt,
      shieldExpired: true,
      reportExpired: false,
      staleJobRecovered: false,
      orphanShieldRepaired: true,
      cleanupReviewExpired: true,
      temporaryHostAccessReleased: false,
      temporaryHostAccessRecoveryPending: false
    }
  );
});

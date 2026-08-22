import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { createReport, finishReport } from '../../src/background/report.js';
import { DEFAULT_SETTINGS, STORAGE_KEYS } from '../../src/shared/constants.js';
import { verifyReportIntegrity } from '../../src/shared/report-integrity.js';

const state = new Map();
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const output = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) output[key] = state.get(key);
        return output;
      },
      async set(values) {
        for (const [key, value] of Object.entries(values)) state.set(key, structuredClone(value));
      },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) state.delete(key);
      }
    }
  }
};

const storage = await import('../../src/shared/storage.js');
const NOW_MS = Date.parse('2026-08-17T12:00:00.000Z');

test.beforeEach(() => {
  state.clear();
  state.set(STORAGE_KEYS.settings, {
    ...DEFAULT_SETTINGS,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
});

test('saveReport persists only a redacted active report under safe defaults', async () => {
  const canary = 'save-report-canary.example';
  const report = await finishReport(
    createReport({ domain: canary, matchMode: 'registrable_domain' }, `https://${canary}/private`)
  );
  const returned = await storage.saveReport(report);

  const stored = state.get(STORAGE_KEYS.activeReport);
  assert.equal(stored.redacted, true);
  assert.equal(JSON.stringify(stored).includes(canary), false);
  assert.equal(await verifyReportIntegrity(stored), true);
  assert.deepEqual(returned, stored);
  assert.equal(JSON.stringify(returned).includes(canary), false);
  assert.deepEqual(state.get(STORAGE_KEYS.reports), []);
});

test('saveReport uses the reviewed privacy policy even if stored settings changed during completion', async () => {
  const canary = 'reviewed-policy-canary.example';
  const report = await finishReport(
    createReport({ domain: canary, matchMode: 'registrable_domain' }, `https://${canary}/private`)
  );
  state.set(STORAGE_KEYS.settings, {
    ...DEFAULT_SETTINGS,
    redactReports: false,
    keepHistory: true,
    reportRetentionDays: 90,
    createdAt: '2026-08-20T12:00:00.000Z',
    updatedAt: '2026-08-20T12:01:00.000Z'
  });

  const stored = await storage.saveReport(report, {
    ...DEFAULT_SETTINGS,
    redactReports: true,
    keepHistory: false,
    reportRetentionDays: 0,
    createdAt: '2026-08-20T12:00:00.000Z',
    updatedAt: '2026-08-20T12:00:00.000Z'
  });

  assert.equal(stored.redacted, true);
  assert.equal(JSON.stringify(stored).includes(canary), false);
  assert.deepEqual(state.get(STORAGE_KEYS.reports), []);
});

test('on-read expiration forgets a report older than the 30-minute default', async () => {
  const report = await finishReport(
    createReport({ domain: 'expiry-canary.example', matchMode: 'registrable_domain' }, 'expiry-canary.example')
  );
  report.finishedAt = new Date(NOW_MS - 31 * 60 * 1000).toISOString();
  state.set(STORAGE_KEYS.activeReport, report);

  assert.equal(await storage.getLastReport(NOW_MS), null);
  assert.equal(state.get(STORAGE_KEYS.activeReport), null);
});

test('latest-report expiration uses the exact configured boundary and is deterministic', async () => {
  const report = await finishReport(
    createReport({ domain: 'boundary.example', matchMode: 'registrable_domain' }, 'boundary.example')
  );
  report.finishedAt = new Date(NOW_MS - 30 * 60 * 1000).toISOString();
  state.set(STORAGE_KEYS.activeReport, report);

  assert.equal(await storage.expireLatestReportIfNeeded(NOW_MS), false);
  assert.ok(state.get(STORAGE_KEYS.activeReport));
  assert.equal(await storage.expireLatestReportIfNeeded(NOW_MS + 1), true);
  assert.equal(state.get(STORAGE_KEYS.activeReport), null);
});

test('privacy migration redacts existing active, history, and debug records', async () => {
  const canary = 'migration-canary.example';
  const report = await finishReport(createReport({ domain: canary, matchMode: 'registrable_domain' }, canary));
  report.errors.push({
    label: `Failure at https://${canary}/private`,
    message: 'C:\\Users\\Private\\secret.txt'
  });
  state.set(STORAGE_KEYS.activeReport, report);
  state.set(STORAGE_KEYS.reports, [report]);
  state.set(STORAGE_KEYS.debugLog, [{ target: canary, message: `Failed at https://${canary}/private` }]);

  const result = await storage.migrateStoredReportsToPrivacyDefaults();
  assert.deepEqual(result, {
    activeReportMigrated: true,
    historyReportsMigrated: 1,
    debugEntriesMigrated: 1
  });
  for (const key of [STORAGE_KEYS.activeReport, STORAGE_KEYS.reports, STORAGE_KEYS.debugLog]) {
    assert.equal(JSON.stringify(state.get(key)).includes(canary), false, `Migration leak in ${key}`);
  }
  assert.equal(await verifyReportIntegrity(state.get(STORAGE_KEYS.activeReport)), true);
});

test('privacy migration removes expired latest and bounded-history records', async () => {
  const latest = await finishReport(
    createReport({ domain: 'expired-latest.example', matchMode: 'registrable_domain' }, 'expired-latest.example')
  );
  latest.finishedAt = new Date(NOW_MS - 31 * 60 * 1000).toISOString();
  const expiredHistory = await finishReport(
    createReport({ domain: 'expired-history.example', matchMode: 'registrable_domain' }, 'expired-history.example')
  );
  expiredHistory.finishedAt = new Date(NOW_MS - 8 * 24 * 60 * 60 * 1000).toISOString();
  state.set(STORAGE_KEYS.activeReport, latest);
  state.set(STORAGE_KEYS.reports, [expiredHistory]);

  await storage.migrateStoredReportsToPrivacyDefaults(NOW_MS);

  assert.equal(state.get(STORAGE_KEYS.activeReport), null);
  assert.deepEqual(state.get(STORAGE_KEYS.reports), []);
});

test('storage preserves the explicit cleanup-review preference and defaults it off', () => {
  const normalized = storage.normalizeStoredSettings(
    {
      cleanupMode: 'expert',
      skipCleanupReview: true,
      createdAt: '2026-08-16T12:00:00.000Z',
      updatedAt: '2026-08-16T12:00:00.000Z'
    },
    '2026-08-17T12:00:00.000Z'
  );
  const defaults = storage.normalizeStoredSettings({}, '2026-08-17T12:00:00.000Z');
  const unsafeString = storage.normalizeStoredSettings({ skipCleanupReview: 'true' }, '2026-08-17T12:00:00.000Z');
  assert.equal(normalized.cleanupMode, 'expert');
  assert.equal(normalized.skipCleanupReview, true);
  assert.equal(defaults.skipCleanupReview, false);
  assert.equal(unsafeString.skipCleanupReview, false);
});

test('the storage layer refuses to persist reports that may include private-window scope', async () => {
  const report = createReport(
    { domain: 'private-scope.example', matchMode: 'registrable_domain' },
    'private-scope.example'
  );
  report.incognitoAccess = true;
  const finished = await finishReport(report);

  await assert.rejects(storage.saveReport(finished), /private-window scope/i);
  assert.equal(state.has(STORAGE_KEYS.activeReport), false);
  assert.equal(state.has(STORAGE_KEYS.reports), false);
});

test('service-worker startup and load readiness invoke bounded privacy expiration maintenance', async () => {
  const source = await readFile(new URL('../../src/background/service-worker.js', import.meta.url), 'utf8');
  const ensureStart = source.indexOf('function ensurePrivacyDefaults()');
  const ensureEnd = source.indexOf('async function handleMaintenanceAlarm', ensureStart);
  const ensure = source.slice(ensureStart, ensureEnd);
  assert.ok(ensureStart >= 0 && ensureEnd > ensureStart);
  assert.match(ensure, /expireLatestReportIfNeededWithBoundedRead\(\)/);
  assert.match(
    source,
    /chrome\.runtime\.onStartup[\s\S]*?requestLifecycleMaintenance\('startup',[\s\S]*?ensurePrivacyDefaults: true/
  );
  assert.match(source, /startServiceWorkerLoadReadinessMaintenance\('service-worker-load'\)/);
  assert.match(
    source,
    /function startServiceWorkerLoadReadinessMaintenance[\s\S]*?requestLifecycleMaintenance\(reason,[\s\S]*?ensurePrivacyDefaults: true/
  );
  assert.match(
    source,
    /async function requestLifecycleMaintenance[\s\S]*?runLifecycleMaintenanceStage\(reason, 'privacy-readiness', ensurePrivacyDefaults\)/
  );
});

test('forget report removes the current report from both active storage and optional history', async () => {
  const current = await finishReport(
    createReport({ domain: 'current.example', matchMode: 'registrable_domain' }, 'current.example')
  );
  const older = await finishReport(
    createReport({ domain: 'older.example', matchMode: 'registrable_domain' }, 'older.example')
  );
  state.set(STORAGE_KEYS.activeReport, current);
  state.set(STORAGE_KEYS.reports, [current, older]);

  const result = await storage.forgetLatestReport(current.id);

  assert.equal(result.forgottenReportId, current.id);
  assert.equal(result.remainingHistoryCount, 1);
  assert.equal(state.get(STORAGE_KEYS.activeReport), null);
  assert.deepEqual(
    state.get(STORAGE_KEYS.reports).map((report) => report.id),
    [older.id]
  );
});

test('forget report rejects a stale displayed ID without removing the newer stored report', async () => {
  const current = await finishReport(
    createReport({ domain: 'current.example', matchMode: 'registrable_domain' }, 'current.example')
  );
  const stale = await finishReport(
    createReport({ domain: 'stale.example', matchMode: 'registrable_domain' }, 'stale.example')
  );
  state.set(STORAGE_KEYS.activeReport, current);
  state.set(STORAGE_KEYS.reports, [current, stale]);

  await assert.rejects(storage.forgetLatestReport(stale.id), /no longer the latest stored report/i);

  assert.equal(state.get(STORAGE_KEYS.activeReport).id, current.id);
  assert.deepEqual(
    state.get(STORAGE_KEYS.reports).map((report) => report.id),
    [current.id, stale.id]
  );
});

test('concurrent settings mutations do not lose independent fields', async () => {
  await Promise.all([
    storage.saveSettings({ keepHistory: true }),
    storage.saveSettings({ debugLog: true }),
    storage.saveSettings({ reducedMotion: true })
  ]);

  const settings = await storage.getSettings();
  assert.equal(settings.keepHistory, true);
  assert.equal(settings.debugLog, true);
  assert.equal(settings.reducedMotion, true);
});

test('a cancellation request remains monotonic across concurrent progress updates', async () => {
  const startedAt = '2026-08-16T12:00:00.000Z';
  await storage.setActiveJob({
    id: 'sitewipe-storage-race',
    status: 'running',
    targetDomain: 'example.com',
    startedAt,
    updatedAt: startedAt,
    percent: 10,
    phase: 'cleanup',
    label: 'Cleaning',
    detail: 'In progress',
    cancelRequested: false
  });

  await Promise.all([
    storage.mutateActiveJob((current) => ({
      ...current,
      cancelRequested: true,
      label: 'Cancellation requested',
      updatedAt: '2026-08-16T12:00:01.000Z'
    })),
    storage.mutateActiveJob((current) => ({
      ...current,
      cancelRequested: false,
      percent: 20,
      updatedAt: '2026-08-16T12:00:02.000Z'
    }))
  ]);

  const job = await storage.getActiveJob();
  assert.equal(job.cancelRequested, true);
  assert.equal(job.percent, 20);
});

test('a cancellation request is never inherited by a replacement cleanup job', async () => {
  const startedAt = '2026-08-20T12:00:00.000Z';
  await storage.setActiveJob({
    id: 'sitewipe-cancelled-job-a',
    status: 'running',
    targetDomain: 'first.example',
    startedAt,
    updatedAt: startedAt,
    percent: 30,
    phase: 'cleanup',
    label: 'Cancel requested',
    detail: 'Stopping',
    cancelRequested: true
  });

  await storage.setActiveJob({
    id: 'sitewipe-new-job-b',
    status: 'running',
    targetDomain: 'second.example',
    startedAt: '2026-08-20T12:01:00.000Z',
    updatedAt: '2026-08-20T12:01:00.000Z',
    percent: 0,
    phase: 'created',
    label: 'Queued',
    detail: 'New cleanup',
    cancelRequested: false
  });

  const replacement = await storage.getActiveJob();
  assert.equal(replacement.id, 'sitewipe-new-job-b');
  assert.equal(replacement.cancelRequested, false);
});

test('a stale shield callback cannot clear a newer job shield by returning undefined', async () => {
  const startedAt = '2026-08-20T12:00:00.000Z';
  await storage.setActiveShield({
    domain: 'second.example',
    displayName: 'second.example',
    associatedTargets: [],
    ruleIds: [730000],
    urlFilters: ['||second.example^'],
    mode: 'cleanup-only',
    lifecycle: 'active',
    pendingMutation: false,
    expiresAt: null,
    startedAt,
    jobId: 'cleanup-b'
  });

  await storage.mutateActiveShield((current) => (current?.jobId === 'cleanup-a' ? null : undefined));

  const shield = await storage.getActiveShield();
  assert.equal(shield.jobId, 'cleanup-b');
  assert.equal(shield.lifecycle, 'active');
  assert.equal(shield.ruleIds[0], 730000);
});

test('deleting report history preserves the active latest report', async () => {
  const active = await finishReport(
    createReport({ domain: 'active.example', matchMode: 'registrable_domain' }, 'active.example')
  );
  const older = await finishReport(
    createReport({ domain: 'older.example', matchMode: 'registrable_domain' }, 'older.example')
  );
  state.set(STORAGE_KEYS.activeReport, active);
  state.set(STORAGE_KEYS.reports, [active, older]);

  await storage.clearReportHistory();

  assert.deepEqual(state.get(STORAGE_KEYS.activeReport), active);
  assert.deepEqual(state.get(STORAGE_KEYS.reports), []);
});

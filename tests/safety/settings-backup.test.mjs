import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { DEFAULT_SETTINGS } from '../../src/shared/constants.js';
import {
  SETTINGS_BACKUP_MAX_BYTES,
  SETTINGS_BACKUP_SCHEMA,
  SETTINGS_BACKUP_SCHEMA_VERSION,
  SETTINGS_BACKUP_USER_KEYS,
  assertSettingsBackupFileSize,
  buildSettingsImportCandidate,
  buildSettingsImportConfirmation,
  createSettingsBackup,
  getSettingsImportRisks,
  parseSettingsBackupText,
  validateSettingsBackup
} from '../../src/shared/settings-backup.js';

function backup(overrides = {}, wrapper = {}) {
  return {
    schema: SETTINGS_BACKUP_SCHEMA,
    schemaVersion: SETTINGS_BACKUP_SCHEMA_VERSION,
    app: 'SiteWipe',
    appVersion: '1.11.4',
    exportedAt: '2026-08-20T00:00:00.000Z',
    settings: {
      cleanupMode: 'standard',
      redactReports: true,
      latestReportRetentionMinutes: 30,
      ...overrides
    },
    ...wrapper
  };
}

test('settings export contains only explicit user-controlled fields in a versioned SiteWipe envelope', () => {
  const payload = createSettingsBackup(
    {
      ...DEFAULT_SETTINGS,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
      stabilityDefaultsAppliedAt: '2026-01-01T00:00:00.000Z',
      performanceDefaultsAppliedAt: '2026-01-01T00:00:00.000Z',
      privacyDefaultsAppliedAt: '2026-01-01T00:00:00.000Z',
      mainWorldPageScrub: true,
      arbitraryInternalState: 'do not export'
    },
    { appVersion: '1.11.4', exportedAt: '2026-08-20T00:00:00.000Z' }
  );

  assert.equal(payload.schema, SETTINGS_BACKUP_SCHEMA);
  assert.equal(payload.schemaVersion, SETTINGS_BACKUP_SCHEMA_VERSION);
  assert.equal(payload.app, 'SiteWipe');
  assert.equal(payload.appVersion, '1.11.4');
  assert.deepEqual(Object.keys(payload.settings).sort(), [...SETTINGS_BACKUP_USER_KEYS].sort());
  for (const key of [
    'createdAt',
    'updatedAt',
    'stabilityDefaultsAppliedAt',
    'performanceDefaultsAppliedAt',
    'privacyDefaultsAppliedAt',
    'mainWorldPageScrub',
    'arbitraryInternalState'
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(payload.settings, key), false, key);
  }
});

test('settings import accepts recognized fields, filters unknown fields, and remains a background-sanitizer patch', () => {
  const parsed = validateSettingsBackup(
    backup({ skipCleanupReview: true, keepHistory: false, associatedDomainGroups: '', unknownSetting: 'ignored' })
  );
  assert.deepEqual(parsed.settings, {
    skipCleanupReview: true,
    keepHistory: false,
    redactReports: true,
    cleanupMode: 'standard',
    latestReportRetentionMinutes: 30,
    associatedDomainGroups: ''
  });
  assert.equal(parsed.unknownKeyCount, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.settings, 'unknownSetting'), false);
});

test('settings import rejects unrelated, malformed, unknown-only, invalid, and future-schema files', () => {
  assert.throws(() => validateSettingsBackup(null), /not a SiteWipe settings backup/);
  assert.throws(() => validateSettingsBackup(backup({}, { app: 'OtherApp' })), /not created for SiteWipe/);
  assert.throws(() => validateSettingsBackup(backup({}, { schema: 'other.schema' })), /unrecognized settings schema/);
  assert.throws(
    () => validateSettingsBackup(backup({}, { schemaVersion: SETTINGS_BACKUP_SCHEMA_VERSION + 1 })),
    /newer schema/
  );
  assert.throws(() => validateSettingsBackup(backup({}, { schemaVersion: 0 })), /not supported/);
  assert.throws(() => validateSettingsBackup(backup({}, { appVersion: '' })), /no valid SiteWipe version/);
  assert.throws(() => validateSettingsBackup(backup({}, { appVersion: '1.11' })), /no valid SiteWipe version/);
  assert.throws(() => validateSettingsBackup(backup({}, { appVersion: '1.011.4' })), /no valid SiteWipe version/);
  assert.throws(() => validateSettingsBackup({ ...backup(), settings: { madeUp: true } }), /no recognized/);
  assert.throws(() => validateSettingsBackup(backup({ keepHistory: 'true' })), /invalid values for: keepHistory/);
  assert.throws(
    () => validateSettingsBackup(backup({ skipCleanupReview: 'true' })),
    /invalid values for: skipCleanupReview/
  );
  assert.throws(() => validateSettingsBackup(backup({ reportRetentionDays: 365 })), /reportRetentionDays/);
  assert.throws(() => parseSettingsBackupText('{not json'), /not valid JSON/);
});

test('settings files are bounded before and after text decoding', () => {
  assert.throws(() => assertSettingsBackupFileSize({ size: 0 }), /empty/);
  assert.throws(() => assertSettingsBackupFileSize({}), /could not be verified/);
  assert.throws(() => assertSettingsBackupFileSize({ size: SETTINGS_BACKUP_MAX_BYTES + 1 }), /limited to 128 KiB/);
  assert.doesNotThrow(() => assertSettingsBackupFileSize({ size: SETTINGS_BACKUP_MAX_BYTES }));
  assert.throws(() => parseSettingsBackupText('x'.repeat(SETTINGS_BACKUP_MAX_BYTES + 1)), /too large/);
});

test('settings import confirmation previews retention, full-report, history, and destructive Expert risks', () => {
  const parsed = validateSettingsBackup(
    backup({
      cleanupMode: 'expert',
      skipCleanupReview: true,
      redactReports: false,
      latestReportRetentionMinutes: 0,
      keepHistory: true,
      reportRetentionDays: 0,
      debugLog: true,
      includeProtectedWebOrigins: true,
      deleteDownloadedFiles: true,
      postWipeSessionBlock: true,
      postWipeShieldExpiresMinutes: 0,
      associatedDomainGroups: 'example.net, example.org'
    })
  );
  const preview = buildSettingsImportConfirmation(parsed);

  assert.match(preview, /full, unredacted cleanup reports/i);
  assert.match(preview, /latest cleanup report until it is manually deleted/i);
  assert.match(preview, /report history/i);
  assert.match(preview, /no automatic age-based expiration/i);
  assert.match(preview, /Expert mode/i);
  assert.match(preview, /Skip detailed cleanup review completely/i);
  assert.match(preview, /private-window data/i);
  assert.match(preview, /browser permission prompts may still appear/i);
  assert.match(preview, /protected browser-service web origins/i);
  assert.match(preview, /delete approved downloaded files from disk/i);
  assert.match(preview, /keep a target request block after cleanup/i);
  assert.match(preview, /post-clean target request block until browser restart/i);
  assert.match(preview, /associated domains/i);
  assert.match(preview, /cleanup can start directly/i);
  assert.match(preview, /Cancel to keep every current setting unchanged/i);
});

test('settings import also discloses latent Expert options stored while Standard mode is active', () => {
  const parsed = validateSettingsBackup(backup({ cleanupMode: 'standard', deleteDownloadedFiles: true }));
  const preview = buildSettingsImportConfirmation(parsed);
  assert.match(
    preview,
    /Stored Expert option \(inactive in Standard mode\): delete approved downloaded files from disk/i
  );
});

test('partial import preview includes current settings that become active after entering Expert mode', () => {
  const parsed = validateSettingsBackup(backup({ cleanupMode: 'expert' }));
  const candidate = buildSettingsImportCandidate(
    {
      ...DEFAULT_SETTINGS,
      cleanupMode: 'standard',
      deleteDownloadedFiles: true,
      progressOverlay: true,
      progressOverlayCancelButton: true,
      overlayScope: 'all_tabs',
      embeddedFrameDiscovery: true
    },
    parsed.settings
  );
  const preview = buildSettingsImportConfirmation({
    ...parsed,
    risks: getSettingsImportRisks(candidate)
  });

  assert.equal(candidate.embeddedFrameDiscovery, false);
  assert.match(preview, /delete approved downloaded files from disk/i);
  assert.match(preview, /progress overlays across all accessible tabs/i);
  assert.match(preview, /cleanup-cancel control inside injected progress overlays/i);
});

test('Options checks file size and approval before calling the background settings sanitizer', async () => {
  const source = await readFile(new URL('../../src/options/options.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function importSettingsBackup(event)');
  const end = source.indexOf('function confirmSensitiveReportStorage()', start);
  const handler = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.ok(handler.indexOf('assertSettingsBackupFileSize(file)') < handler.indexOf('await file.text()'));
  assert.ok(handler.indexOf('parseSettingsBackupText(text)') < handler.indexOf('globalThis.confirm(preview)'));
  assert.match(handler, /buildSettingsImportCandidate\(currentSettings \|\| \{\}, backup\.settings\)/);
  assert.match(handler, /getSettingsImportRisks\(candidateSettings\)/);
  assert.ok(handler.indexOf('globalThis.confirm(preview)') < handler.indexOf('sendMessage(MESSAGE_TYPES.saveSettings'));
  assert.match(handler, /settings: backup\.settings/);
  assert.match(handler, /Every current setting remains unchanged/);
});

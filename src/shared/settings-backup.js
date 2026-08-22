import { EXPERT_ONLY_CLEANUP_SETTINGS } from './cleanup-mode.js';

export const SETTINGS_BACKUP_SCHEMA = 'sitewipe.settings.backup';
export const SETTINGS_BACKUP_SCHEMA_VERSION = 1;
export const SETTINGS_BACKUP_MAX_BYTES = 128 * 1024;

const BOOLEAN_SETTING_KEYS = Object.freeze([
  'skipCleanupReview',
  'keepHistory',
  'reducedMotion',
  'highContrast',
  'debugLog',
  'aggressiveCookieSweep',
  'includeProtectedWebOrigins',
  'pageScriptScrub',
  'storageBucketScrub',
  'embeddedFrameDiscovery',
  'probePartitionedCookiesWithEmbeddingSites',
  'exhaustiveCookieStoreScan',
  'downloadRecentFallback',
  'deleteDownloadedFiles',
  'temporaryDnrShield',
  'progressOverlay',
  'progressOverlayCancelButton',
  'postWipeSessionBlock',
  'autoRepairOrphanedShields',
  'resetZoom',
  'resetMutedTabs',
  'unpinTargetTabs',
  'opfsScrub',
  'serviceWorkerExtraScrub',
  'appBadgeClear',
  'permissionAudit',
  'redactReports',
  'verificationPass',
  'allowLocalTargets',
  'blockOnAssociatedGroupErrors',
  'broadDiscoveryFallback'
]);

const ENUM_SETTING_VALUES = Object.freeze({
  cleanupMode: Object.freeze(['standard', 'expert']),
  overlayScope: Object.freeze(['all_tabs', 'current_window', 'target_tabs'])
});

const NUMBER_SETTING_VALUES = Object.freeze({
  reportRetentionDays: Object.freeze([0, 1, 7, 30, 90]),
  latestReportRetentionMinutes: Object.freeze([0, 15, 30, 60, 240, 1440]),
  postWipeShieldExpiresMinutes: Object.freeze([0, 15, 60, 240, 1440])
});

const STRING_SETTING_KEYS = Object.freeze(['associatedDomainGroups']);

export const SETTINGS_BACKUP_USER_KEYS = Object.freeze([
  ...BOOLEAN_SETTING_KEYS,
  ...Object.keys(ENUM_SETTING_VALUES),
  ...Object.keys(NUMBER_SETTING_VALUES),
  ...STRING_SETTING_KEYS
]);

const USER_KEY_SET = new Set(SETTINGS_BACKUP_USER_KEYS);
const BOOLEAN_KEY_SET = new Set(BOOLEAN_SETTING_KEYS);
const STRING_KEY_SET = new Set(STRING_SETTING_KEYS);

const EXPERT_RISK_LABELS = Object.freeze({
  includeProtectedWebOrigins: 'include normally protected browser-service web origins',
  storageBucketScrub: 'attempt Storage Buckets cleanup in matching pages',
  embeddedFrameDiscovery: 'discover matching embedded frames',
  probePartitionedCookiesWithEmbeddingSites: 'probe partitioned cookies with discovered embedding sites',
  exhaustiveCookieStoreScan: 'scan every exposed cookie store',
  downloadRecentFallback: 'scan a bounded set of recent download records when URL search is incomplete',
  broadDiscoveryFallback: 'use broader bounded discovery fallbacks',
  allowLocalTargets: 'allow local-network or single-label targets',
  deleteDownloadedFiles: 'delete approved downloaded files from disk',
  postWipeSessionBlock: 'keep a target request block after cleanup',
  resetMutedTabs: 'change mute state on matching tabs',
  unpinTargetTabs: 'change pinned state on matching tabs',
  opfsScrub: 'attempt Origin Private File System cleanup in matching pages'
});

export function createSettingsBackup(settings, { appVersion, exportedAt = new Date().toISOString() } = {}) {
  const version = String(appVersion || '').trim();
  if (!isSemanticVersion(version)) {
    throw new Error('A valid SiteWipe major.minor.patch app version is required to create a settings backup.');
  }
  const selectedSettings = selectRecognizedSettings(settings, { validate: true });
  if (!Object.keys(selectedSettings).length)
    throw new Error('No user-controlled SiteWipe settings are available to export.');
  return {
    schema: SETTINGS_BACKUP_SCHEMA,
    schemaVersion: SETTINGS_BACKUP_SCHEMA_VERSION,
    app: 'SiteWipe',
    appVersion: version,
    exportedAt,
    note: 'Contains SiteWipe user settings only. It does not include reports, logs, jobs, shields, browser data, or internal migration metadata.',
    settings: selectedSettings
  };
}

export function assertSettingsBackupFileSize(file) {
  const size = Number(file?.size);
  if (!Number.isFinite(size) || size < 0) throw new Error('The selected settings file size could not be verified.');
  if (size === 0) throw new Error('The selected settings file is empty.');
  if (size > SETTINGS_BACKUP_MAX_BYTES) {
    throw new Error(`The selected settings file is too large. SiteWipe backups are limited to ${formatByteLimit()}.`);
  }
}

export function parseSettingsBackupText(text) {
  if (typeof text !== 'string') throw new Error('The selected settings file could not be read as text.');
  if (new TextEncoder().encode(text).byteLength > SETTINGS_BACKUP_MAX_BYTES) {
    throw new Error(`The selected settings file is too large. SiteWipe backups are limited to ${formatByteLimit()}.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('The selected file is not valid JSON.');
  }
  return validateSettingsBackup(parsed);
}

export function validateSettingsBackup(value) {
  if (!isRecord(value)) throw new Error('The selected file is not a SiteWipe settings backup.');
  if (value.app !== 'SiteWipe') throw new Error('The selected backup was not created for SiteWipe.');
  if (value.schema !== SETTINGS_BACKUP_SCHEMA)
    throw new Error('The selected file uses an unrecognized settings schema.');
  if (!Number.isInteger(value.schemaVersion)) throw new Error('The selected backup has no valid schema version.');
  if (value.schemaVersion > SETTINGS_BACKUP_SCHEMA_VERSION) {
    throw new Error('This settings backup was created with a newer schema. Update SiteWipe before importing it.');
  }
  if (value.schemaVersion !== SETTINGS_BACKUP_SCHEMA_VERSION) {
    throw new Error('This SiteWipe settings backup schema version is not supported.');
  }
  if (typeof value.appVersion !== 'string' || !isSemanticVersion(value.appVersion)) {
    throw new Error('The selected backup has no valid SiteWipe version.');
  }
  if (!isRecord(value.settings)) throw new Error('The selected backup does not contain a settings object.');

  const recognizedKeys = Object.keys(value.settings).filter((key) => USER_KEY_SET.has(key));
  if (!recognizedKeys.length) throw new Error('The selected backup contains no recognized SiteWipe settings.');
  const invalidKeys = recognizedKeys.filter((key) => !validSettingValue(key, value.settings[key]));
  if (invalidKeys.length) {
    throw new Error(`The selected backup has invalid values for: ${invalidKeys.sort().join(', ')}.`);
  }

  const settings = selectRecognizedSettings(value.settings);
  const unknownKeyCount = Object.keys(value.settings).length - recognizedKeys.length;
  return {
    settings,
    recognizedKeys: recognizedKeys.sort(),
    unknownKeyCount,
    risks: getSettingsImportRisks(settings)
  };
}

export function getSettingsImportRisks(settings) {
  const risks = [];
  if (settings.skipCleanupReview === true) {
    risks.push(
      'Skip detailed cleanup review completely: cleanup can start directly in Standard or Expert mode; enabled Expert actions and private-window data can be affected without a per-run detail screen, while browser permission prompts may still appear.'
    );
  }
  if (settings.redactReports === false) {
    risks.push('Store full, unredacted cleanup reports that can contain domains, URLs, filenames, paths, and errors.');
  }
  if (settings.latestReportRetentionMinutes === 0) {
    risks.push('Keep the latest cleanup report until it is manually deleted.');
  }
  if (settings.keepHistory === true) {
    risks.push('Keep cleanup report history in extension-local storage.');
  }
  if (settings.reportRetentionDays === 0) {
    risks.push('Give report history no automatic age-based expiration if history storage is enabled.');
  }
  if (settings.debugLog === true) {
    risks.push('Store an extension-local diagnostic log.');
  }
  const expertMode = settings.cleanupMode === 'expert';
  if (expertMode) {
    risks.push('Enable Expert mode, which exposes expanded and destructive cleanup settings.');
  }
  for (const key of EXPERT_ONLY_CLEANUP_SETTINGS) {
    if (settings[key] !== true) continue;
    const state = expertMode ? 'Enabled Expert option' : 'Stored Expert option (inactive in Standard mode)';
    risks.push(`${state}: ${EXPERT_RISK_LABELS[key] || key}.`);
  }
  if (settings.postWipeSessionBlock === true && settings.postWipeShieldExpiresMinutes === 0) {
    risks.push('Expert retention: keep the post-clean target request block until browser restart.');
  }
  if (String(settings.associatedDomainGroups || '').trim()) {
    const state = expertMode ? 'Enabled Expert option' : 'Stored Expert option (inactive in Standard mode)';
    risks.push(`${state}: include configured associated domains in the reviewed target scope.`);
  }
  if (settings.progressOverlay === true && settings.overlayScope && settings.overlayScope !== 'target_tabs') {
    const scope = settings.overlayScope === 'all_tabs' ? 'all accessible tabs' : 'the current window';
    const state = expertMode ? 'Enabled Expert option' : 'Stored Expert option (inactive in Standard mode)';
    risks.push(`${state}: show cleanup progress overlays across ${scope}, beyond matching target tabs.`);
  }
  if (settings.progressOverlay === true && settings.progressOverlayCancelButton === true) {
    risks.push('Show a cleanup-cancel control inside injected progress overlays.');
  }
  return risks;
}

export function buildSettingsImportCandidate(currentSettings, importedSettings) {
  const current = selectRecognizedSettings(currentSettings);
  const imported = selectRecognizedSettings(importedSettings);
  const candidate = { ...current, ...imported };
  if (current.cleanupMode !== 'expert' && candidate.cleanupMode === 'expert') {
    // The background requires a later explicit gesture before this optional
    // capability can become active when entering Expert mode.
    candidate.embeddedFrameDiscovery = false;
  }
  return candidate;
}

export function buildSettingsImportConfirmation({ recognizedKeys, unknownKeyCount = 0, risks = [] }) {
  const lines = [
    'Import this SiteWipe settings backup?',
    '',
    `${recognizedKeys.length} recognized setting${recognizedKeys.length === 1 ? '' : 's'} will be sent to SiteWipe's background sanitizer.`
  ];
  if (unknownKeyCount > 0) {
    lines.push(`${unknownKeyCount} unknown field${unknownKeyCount === 1 ? '' : 's'} will be ignored.`);
  }
  lines.push(
    'Reports, logs, active jobs, shields, and browser website data are not imported.',
    'If “Skip detailed cleanup review completely” is enabled after import, cleanup can start directly; Chrome or Brave permission prompts may still appear.',
    '',
    'Privacy and expanded-scope preview:'
  );
  if (risks.length) {
    for (const risk of risks) lines.push(`- ${risk}`);
  } else {
    lines.push('- No sensitive-retention or expanded Expert settings were detected.');
  }
  lines.push('', 'Choose OK to apply these settings, or Cancel to keep every current setting unchanged.');
  return lines.join('\n');
}

function selectRecognizedSettings(settings, { validate = false } = {}) {
  if (!isRecord(settings)) return {};
  const selected = {};
  for (const key of SETTINGS_BACKUP_USER_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(settings, key)) continue;
    if (validate && !validSettingValue(key, settings[key])) continue;
    selected[key] = settings[key];
  }
  return selected;
}

function validSettingValue(key, value) {
  if (BOOLEAN_KEY_SET.has(key)) return typeof value === 'boolean';
  if (STRING_KEY_SET.has(key)) return typeof value === 'string';
  if (Object.prototype.hasOwnProperty.call(ENUM_SETTING_VALUES, key)) {
    return ENUM_SETTING_VALUES[key].includes(value);
  }
  if (Object.prototype.hasOwnProperty.call(NUMBER_SETTING_VALUES, key)) {
    return typeof value === 'number' && NUMBER_SETTING_VALUES[key].includes(value);
  }
  return false;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSemanticVersion(value) {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(String(value));
}

function formatByteLimit() {
  return `${SETTINGS_BACKUP_MAX_BYTES / 1024} KiB`;
}

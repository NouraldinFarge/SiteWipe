import { APP, MESSAGE_TYPES, STORAGE_KEYS } from '../shared/constants.js';
import { sendMessage, formatError, onceDomReady, onStorageChange } from '../shared/messaging.js';
import { isExpertCleanupMode } from '../shared/cleanup-mode.js';

let currentSettings = null;

const EXPERT_CONTROL_IDS = Object.freeze([
  'includeProtectedWebOrigins',
  'storageBucketScrub',
  'embeddedFrameDiscovery',
  'probePartitionedCookiesWithEmbeddingSites',
  'exhaustiveCookieStoreScan',
  'downloadRecentFallback',
  'broadDiscoveryFallback',
  'postWipeSessionBlock',
  'postWipeShieldExpiresMinutes',
  'resetMutedTabs',
  'unpinTargetTabs',
  'opfsScrub',
  'deleteDownloadedFiles',
  'allowLocalTargets',
  'associatedDomainGroups'
]);

const SETTING_DEPENDENCIES = Object.freeze({
  keepHistory: ['reportRetentionDays'],
  pageScriptScrub: ['storageBucketScrub', 'opfsScrub', 'serviceWorkerExtraScrub', 'appBadgeClear', 'permissionAudit'],
  progressOverlay: ['progressOverlayCancelButton', 'overlayScope'],
  postWipeSessionBlock: ['postWipeShieldExpiresMinutes']
});

const REFRESH_STORAGE_KEYS = new Set(Object.values(STORAGE_KEYS));
const refreshFromStorage = debounce(() => refresh(), 80);

const PERMISSIONS = [
  [
    'scripting',
    'Runs live page-visible storage scrubs with tighter performance caps in matching open pages and optional frames, and draws the optional cross-tab progress overlay in accessible web tabs during cleanup.'
  ],
  [
    'webNavigation (optional)',
    'Requested only when Expert embedded-frame discovery is enabled; released when that feature is disabled.'
  ],
  [
    'browsingData',
    'Origin-scoped deletion for site storage, cache, Cache Storage, IndexedDB, LocalStorage, File Systems, Service Workers, WebSQL, and cookies across discovered matching origins where Chrome exposes origin targeting.'
  ],
  [
    'cookies',
    'Enumerates and removes cookies for the selected registrable domain and subdomains, including partitioned-cookie attempts with discovered embedding-site partition keys where Chrome exposes them.'
  ],
  ['tabs', 'Finds and closes only tabs whose URL host exactly matches the target domain or one of its subdomains.'],
  [
    'history',
    'Searches bounded browser history candidates, filters by exact domain/subdomain matching, and deletes matching URLs with small concurrency limits.'
  ],
  [
    'downloads',
    'Searches bounded download-record queries, optionally uses a capped recent-record fallback, filters by source/final/referrer URL, erases matching download history records with small concurrency limits, and can optionally remove matched completed files from disk.'
  ],
  [
    'storage',
    'Stores SiteWipe settings, optional local cleanup reports, and optional debug logs in chrome.storage.local.'
  ],
  [
    'declarativeNetRequest',
    'Installs temporary session rules to block the target while cleanup runs, and optionally keeps a post-wipe target block until browser restart.'
  ],
  ['sidePanel', 'Opens the detailed report workspace from the popup.'],
  [
    'Target-specific host access (optional)',
    'Requested from the final reviewed approval for only the preflight-bound primary and configured associated target patterns. Chrome/Brave controls its own permission prompt. Newly granted access is durably tracked until Chrome/Brave proves it has been released; pre-existing access is preserved.'
  ]
];

onceDomReady(init);

async function init() {
  wireSettingAccessibility();
  bindControls();
  renderPermissionCards();
  await refresh();
  onStorageChange((changes, area) => {
    if (area !== 'local') return;
    if (Object.keys(changes || {}).some((key) => REFRESH_STORAGE_KEYS.has(key))) refreshFromStorage();
  });
}

function wireSettingAccessibility() {
  for (const row of document.querySelectorAll('.setting-row')) {
    const control = row.querySelector('input, select, textarea');
    const title = row.querySelector('strong');
    if (!control?.id || !title) continue;
    const labelId = `${control.id}Label`;
    title.id ||= labelId;
    control.setAttribute('aria-labelledby', title.id);

    const help = row.querySelector('p');
    if (help) {
      const helpId = `${control.id}Help`;
      help.id ||= helpId;
      const describedBy = new Set(
        String(control.getAttribute('aria-describedby') || '')
          .split(/\s+/)
          .filter(Boolean)
      );
      describedBy.add(help.id);
      control.setAttribute('aria-describedby', [...describedBy].join(' '));
    }
  }
}

function bindControls() {
  for (const id of [
    'keepHistory',
    'aggressiveCookieSweep',
    'includeProtectedWebOrigins',
    'pageScriptScrub',
    'storageBucketScrub',
    'embeddedFrameDiscovery',
    'probePartitionedCookiesWithEmbeddingSites',
    'exhaustiveCookieStoreScan',
    'downloadRecentFallback',
    'broadDiscoveryFallback',
    'verificationPass',
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
    'deleteDownloadedFiles',
    'allowLocalTargets',
    'blockOnAssociatedGroupErrors',
    'reducedMotion',
    'highContrast',
    'debugLog'
  ]) {
    document.querySelector(`#${id}`).addEventListener('change', saveFromForm);
  }
  document.querySelector('#redactReports').addEventListener('change', async (event) => {
    const control = event.currentTarget;
    if (!control.checked && !confirmSensitiveReportStorage()) {
      control.checked = true;
      toast('Report redaction remains enabled.', 'info');
      return;
    }
    await saveFromForm();
  });
  document.querySelector('#overlayScope').addEventListener('change', saveFromForm);
  document.querySelector('#reportRetentionDays').addEventListener('change', saveFromForm);
  document.querySelector('#latestReportRetentionMinutes').addEventListener('change', async (event) => {
    const control = event.currentTarget;
    if (Number(control.value) === 0 && !confirmSensitiveReportStorage()) {
      control.value = String(currentSettings?.latestReportRetentionMinutes ?? 30);
      toast('The latest report will still expire automatically.', 'info');
      return;
    }
    await saveFromForm();
  });
  document.querySelector('#postWipeShieldExpiresMinutes').addEventListener('change', saveFromForm);
  document.querySelector('#cleanupMode').addEventListener('change', async () => {
    applyCleanupMode(valueOf('cleanupMode'));
    await saveFromForm();
  });
  document.querySelector('#associatedDomainGroups').addEventListener('input', debounce(validateAssociatedGroups, 300));
  document.querySelector('#associatedDomainGroups').addEventListener('change', async () => {
    await saveFromForm();
    await validateAssociatedGroups();
  });
  document.querySelector('#clearReports').addEventListener('click', clearReports);
  document.querySelector('#clearShield').addEventListener('click', clearActiveShield);
  document.querySelector('#repairShield').addEventListener('click', repairActiveShield);
  document.querySelector('#clearActiveJob').addEventListener('click', clearActiveJobRecord);
  document.querySelector('#runMaintenanceNow').addEventListener('click', runMaintenanceNow);
  document.querySelector('#resetExtensionState').addEventListener('click', resetExtensionState);
  document.querySelector('#clearDebug').addEventListener('click', clearDebugLog);
  document.querySelector('#runSelfTests').addEventListener('click', runSelfTests);
  document.querySelector('#exportSettings').addEventListener('click', exportSettingsBackup);
  document
    .querySelector('#importSettings')
    .addEventListener('click', () => document.querySelector('#settingsImportFile').click());
  document.querySelector('#settingsImportFile').addEventListener('change', importSettingsBackup);
  document.querySelector('#copySettingsSummary').addEventListener('click', copySettingsSummary);
  document.querySelector('#resetSettings').addEventListener('click', resetSettings);
}

async function refresh() {
  try {
    const state = await sendMessage(MESSAGE_TYPES.getOptionsState);
    renderSettings(state.settings || {});
    renderIncognito(state.incognitoAccess);
    renderDebug(state.debugLog || []);
    renderActiveShield(state.activeShield, state.shieldDiagnostics);
    renderActiveJob(state.activeJob);
    renderMaintenanceStatus(state.maintenanceStatus);
    await validateAssociatedGroups();
  } catch (error) {
    toast(formatError(error), 'error');
  }
}

function renderSettings(settings) {
  currentSettings = settings || {};
  setValue('cleanupMode', settings.cleanupMode || 'standard');
  setChecked('keepHistory', settings.keepHistory);
  setValue('reportRetentionDays', String(settings.reportRetentionDays ?? 7));
  setValue('latestReportRetentionMinutes', String(settings.latestReportRetentionMinutes ?? 0));
  setChecked('aggressiveCookieSweep', settings.aggressiveCookieSweep);
  setChecked('includeProtectedWebOrigins', settings.includeProtectedWebOrigins);
  setChecked('pageScriptScrub', settings.pageScriptScrub);
  setChecked('storageBucketScrub', settings.storageBucketScrub);
  setChecked('embeddedFrameDiscovery', settings.embeddedFrameDiscovery);
  setChecked('probePartitionedCookiesWithEmbeddingSites', settings.probePartitionedCookiesWithEmbeddingSites);
  setChecked('exhaustiveCookieStoreScan', settings.exhaustiveCookieStoreScan);
  setChecked('downloadRecentFallback', settings.downloadRecentFallback);
  setChecked('broadDiscoveryFallback', settings.broadDiscoveryFallback);
  setChecked('verificationPass', settings.verificationPass);
  setChecked('temporaryDnrShield', settings.temporaryDnrShield);
  setChecked('progressOverlay', settings.progressOverlay);
  setChecked('progressOverlayCancelButton', settings.progressOverlayCancelButton);
  setValue('overlayScope', settings.overlayScope || 'target_tabs');
  setChecked('postWipeSessionBlock', settings.postWipeSessionBlock);
  setValue('postWipeShieldExpiresMinutes', String(settings.postWipeShieldExpiresMinutes ?? 0));
  setChecked('autoRepairOrphanedShields', settings.autoRepairOrphanedShields !== false);
  setChecked('resetZoom', settings.resetZoom);
  setChecked('resetMutedTabs', settings.resetMutedTabs);
  setChecked('unpinTargetTabs', settings.unpinTargetTabs);
  setChecked('opfsScrub', settings.opfsScrub);
  setChecked('serviceWorkerExtraScrub', settings.serviceWorkerExtraScrub);
  setChecked('appBadgeClear', settings.appBadgeClear);
  setChecked('permissionAudit', settings.permissionAudit);
  setChecked('redactReports', settings.redactReports);
  setChecked('deleteDownloadedFiles', settings.deleteDownloadedFiles);
  setChecked('allowLocalTargets', settings.allowLocalTargets);
  setChecked('blockOnAssociatedGroupErrors', settings.blockOnAssociatedGroupErrors);
  setValue('associatedDomainGroups', settings.associatedDomainGroups || '');
  setChecked('reducedMotion', settings.reducedMotion);
  setChecked('highContrast', settings.highContrast);
  setChecked('debugLog', settings.debugLog);
  document.body.classList.toggle('reduced-motion', Boolean(settings.reducedMotion));
  document.body.classList.toggle('high-contrast', Boolean(settings.highContrast));
  applyCleanupMode(settings.cleanupMode);
}

function renderIncognito(allowed) {
  const badge = document.querySelector('#incognitoBadge');
  badge.textContent = allowed ? 'Private: enabled' : 'Private: not enabled';
  badge.className = `badge ${allowed ? 'success' : 'warning'}`;
}

function renderPermissionCards() {
  const root = document.querySelector('#permissionCards');
  root.innerHTML = PERMISSIONS.map(
    ([title, body]) => `
    <article class="permission-card">
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(body)}</p>
    </article>
  `
  ).join('');
}

function renderDebug(entries) {
  const output = document.querySelector('#debugOutput');
  if (!entries.length) {
    output.textContent = 'No debug events stored.';
    return;
  }
  output.textContent = entries
    .map((entry) => {
      const at = entry.at || '';
      const level = entry.level || 'info';
      const message = entry.message || JSON.stringify(entry);
      const target = entry.target ? ` target=${entry.target}` : '';
      return `[${at}] ${level}: ${message}${target}`;
    })
    .join('\n');
}

async function saveFromForm() {
  applySettingDependencies();
  const settings = {
    cleanupMode: valueOf('cleanupMode'),
    keepHistory: isChecked('keepHistory'),
    reportRetentionDays: valueOf('reportRetentionDays'),
    latestReportRetentionMinutes: valueOf('latestReportRetentionMinutes'),
    aggressiveCookieSweep: isChecked('aggressiveCookieSweep'),
    includeProtectedWebOrigins: isChecked('includeProtectedWebOrigins'),
    pageScriptScrub: isChecked('pageScriptScrub'),
    storageBucketScrub: isChecked('storageBucketScrub'),
    embeddedFrameDiscovery: isChecked('embeddedFrameDiscovery'),
    probePartitionedCookiesWithEmbeddingSites: isChecked('probePartitionedCookiesWithEmbeddingSites'),
    exhaustiveCookieStoreScan: isChecked('exhaustiveCookieStoreScan'),
    downloadRecentFallback: isChecked('downloadRecentFallback'),
    broadDiscoveryFallback: isChecked('broadDiscoveryFallback'),
    verificationPass: isChecked('verificationPass'),
    temporaryDnrShield: isChecked('temporaryDnrShield'),
    progressOverlay: isChecked('progressOverlay'),
    progressOverlayCancelButton: isChecked('progressOverlayCancelButton'),
    overlayScope: valueOf('overlayScope'),
    postWipeSessionBlock: isChecked('postWipeSessionBlock'),
    postWipeShieldExpiresMinutes: valueOf('postWipeShieldExpiresMinutes'),
    autoRepairOrphanedShields: isChecked('autoRepairOrphanedShields'),
    resetZoom: isChecked('resetZoom'),
    resetMutedTabs: isChecked('resetMutedTabs'),
    unpinTargetTabs: isChecked('unpinTargetTabs'),
    opfsScrub: isChecked('opfsScrub'),
    serviceWorkerExtraScrub: isChecked('serviceWorkerExtraScrub'),
    appBadgeClear: isChecked('appBadgeClear'),
    permissionAudit: isChecked('permissionAudit'),
    redactReports: isChecked('redactReports'),
    deleteDownloadedFiles: isChecked('deleteDownloadedFiles'),
    allowLocalTargets: isChecked('allowLocalTargets'),
    blockOnAssociatedGroupErrors: isChecked('blockOnAssociatedGroupErrors'),
    associatedDomainGroups: valueOf('associatedDomainGroups'),
    reducedMotion: isChecked('reducedMotion'),
    highContrast: isChecked('highContrast'),
    debugLog: isChecked('debugLog')
  };
  try {
    if (settings.embeddedFrameDiscovery) {
      const granted = await chrome.permissions.request({
        permissions: ['webNavigation']
      });
      if (!granted) {
        settings.embeddedFrameDiscovery = false;
        setChecked('embeddedFrameDiscovery', false);
        toast('Embedded-frame discovery remains off because optional webNavigation access was not granted.', 'info');
      }
    }
    const response = await sendMessage(MESSAGE_TYPES.saveSettings, { settings });
    if (!settings.embeddedFrameDiscovery) {
      await chrome.permissions.remove({ permissions: ['webNavigation'] }).catch(() => false);
    }
    renderSettings(response.settings || settings);
    toast('Settings saved.', 'success');
  } catch (error) {
    toast(formatError(error), 'error');
  }
}

function renderActiveShield(shield, diagnostics = null) {
  const text = document.querySelector('#activeShieldText');
  const clearButton = document.querySelector('#clearShield');
  const repairButton = document.querySelector('#repairShield');
  const actualRules = diagnostics?.siteWipeRuleCount || 0;
  const orphanRules = diagnostics?.orphanRuleIds?.length || 0;
  const missingRules = diagnostics?.missingTrackedRuleIds?.length || 0;
  if (!shield && !actualRules) {
    text.textContent =
      'No active SiteWipe request shield is recorded, and no SiteWipe session DNR rules are currently installed.';
    clearButton.disabled = true;
    repairButton.disabled = true;
    return;
  }
  const expiry = shield?.expiresAt ? ` Expires: ${formatDateTime(shield.expiresAt)}.` : '';
  const shieldText = shield
    ? `${shield.domain || 'Target'} is blocked by ${shield.mode || 'session'} shield rules (${(shield.ruleIds || []).join(', ') || 'unknown ids'}).${expiry}`
    : 'No active shield record exists.';
  const diagText = diagnostics
    ? ` Installed SiteWipe DNR rules: ${actualRules}. Orphan rules: ${orphanRules}. Missing tracked rules: ${missingRules}. ${diagnostics.note || ''}`
    : '';
  text.textContent = `${shieldText}${diagText}`;
  clearButton.disabled = !shield && !actualRules;
  repairButton.disabled = diagnostics ? diagnostics.healthy && !actualRules : false;
}

function renderActiveJob(job) {
  const text = document.querySelector('#activeJobText');
  const button = document.querySelector('#clearActiveJob');
  if (!job) {
    text.textContent = 'No active or interrupted SiteWipe cleanup job is recorded.';
    button.disabled = true;
    return;
  }
  const status = job.status || 'unknown';
  const percent = Number.isFinite(Number(job.percent)) ? `${Math.round(Number(job.percent))}%` : 'unknown progress';
  const target = job.targetDomain || 'target';
  text.textContent = `${target}: ${status} · ${percent} · ${job.label || job.phase || 'No phase'}${job.updatedAt ? ` · updated ${job.updatedAt}` : ''}`;
  button.disabled = status === 'running';
}

function renderMaintenanceStatus(status) {
  const text = document.querySelector('#maintenanceText');
  if (!text) return;
  if (!status) {
    text.textContent = 'Maintenance status is unavailable.';
    return;
  }
  const alarms =
    (status.alarms || [])
      .map((alarm) => `${alarm.name}: ${alarm.scheduledTime ? formatDateTime(alarm.scheduledTime) : 'not scheduled'}`)
      .join(' · ') || 'No Chrome alarms are currently scheduled.';
  const orphanRules = status.shieldDiagnostics?.orphanRuleIds?.length || 0;
  const latestReport = status.latestReportExpiresAt
    ? ` Latest report auto-forgets at ${formatDateTime(status.latestReportExpiresAt)}.`
    : ' Latest report auto-forget is not scheduled.';
  const shieldExpiry = status.activeShieldExpiresAt
    ? ` Active shield expires at ${formatDateTime(status.activeShieldExpiresAt)}.`
    : ' No timed shield expiration is scheduled.';
  const last = status.lastMaintenance
    ? ` Last maintenance: ${status.lastMaintenance.reason || 'unknown'} at ${formatDateTime(status.lastMaintenance.at)} (shield expired: ${status.lastMaintenance.shieldExpired ? 'yes' : 'no'}, report expired: ${status.lastMaintenance.reportExpired ? 'yes' : 'no'}, abandoned review expired: ${status.lastMaintenance.cleanupReviewExpired ? 'yes' : 'no'}, stale job recovered: ${status.lastMaintenance.staleJobRecovered ? 'yes' : 'no'}, orphan repair: ${status.lastMaintenance.orphanShieldRepaired ? 'yes' : 'no'}).`
    : ' No maintenance run has been recorded yet.';
  const jobAge = Number.isFinite(Number(status.activeJobAgeMs))
    ? ` Active job age: ${Math.round(Number(status.activeJobAgeMs) / 1000)}s.`
    : '';
  const targetAccess = status.temporaryHostAccess || { state: 'none', recoveryPending: false };
  const targetAccessText =
    targetAccess.state === 'none'
      ? ' No temporary target-access lease is recorded.'
      : ` Temporary target access: ${targetAccess.state}; ${Number(targetAccess.temporaryOriginCount) || 0} pattern(s); recovery ${targetAccess.recoveryPending ? 'pending' : 'not pending'}.${targetAccess.reviewExpiresAt ? ` Review window ends ${formatDateTime(targetAccess.reviewExpiresAt)}.` : ''}${targetAccess.lastError ? ` Last recovery error: ${targetAccess.lastError}` : ''}`;
  text.textContent = `${status.alarmsAvailable ? 'Chrome alarms available.' : 'Chrome alarms unavailable.'} Auto-repair orphan shields: ${status.autoRepairOrphanedShields ? 'on' : 'off'}. Orphan shield rules: ${orphanRules}.${targetAccessText} ${shieldExpiry}${latestReport}${last} ${jobAge} Alarms: ${alarms}`;
}

async function runMaintenanceNow() {
  try {
    const response = await sendMessage(MESSAGE_TYPES.runMaintenanceNow);
    renderMaintenanceStatus(response.maintenanceStatus);
    toast('Maintenance completed.', 'success');
    await refresh();
  } catch (error) {
    toast(formatError(error), 'error');
  }
}

async function resetExtensionState() {
  if (
    !globalThis.confirm(
      'Reset all SiteWipe-local state? This permanently deletes local reports, debug logs, job status, settings, and any active SiteWipe request shield. It does not restore or delete website data.'
    )
  )
    return;
  try {
    await sendMessage(MESSAGE_TYPES.resetExtensionLocalState);
    toast('SiteWipe local state reset.', 'success');
    await refresh();
  } catch (error) {
    toast(formatError(error), 'error');
  }
}

async function clearActiveJobRecord() {
  try {
    const response = await sendMessage(MESSAGE_TYPES.clearActiveJobRecord);
    renderActiveJob(response.activeJob || null);
    toast(
      response.cleared ? 'Stale job status cleared.' : 'No stale job status was recorded.',
      response.cleared ? 'success' : 'info'
    );
  } catch (error) {
    toast(formatError(error), 'error');
  }
}

async function validateAssociatedGroups() {
  const diagnostics = document.querySelector('#associatedGroupsDiagnostics');
  if (!diagnostics) return;
  const groupsText = valueOf('associatedDomainGroups');
  if (!groupsText.trim()) {
    diagnostics.textContent = 'No associated-domain groups configured.';
    diagnostics.className = 'diagnostic-box';
    document.querySelector('#associatedDomainGroups').setAttribute('aria-invalid', 'false');
    return;
  }
  try {
    const response = await sendMessage(MESSAGE_TYPES.validateAssociatedGroups, {
      groupsText
    });
    const validation = response.validation || {};
    const lines = [];
    lines.push(
      `${validation.groupCount || 0} group(s), ${validation.associatedTargetCount || 0} related target(s) accepted.`
    );
    if ((validation.errors || []).length)
      lines.push('Cleanup gate: errors will block cleanup while the safety toggle is enabled.');
    for (const group of (validation.groups || []).slice(0, 6)) {
      lines.push(`• ${group.primary}: ${group.associated.map((item) => item.target).join(', ')}`);
    }
    if ((validation.groups || []).length > 6) lines.push(`• +${validation.groups.length - 6} more group(s)`);
    for (const warning of (validation.warnings || []).slice(0, 6)) {
      lines.push(`Warning${warning.line ? ` line ${warning.line}` : ''}: ${warning.message}`);
      for (const related of warning.relatedWarnings || []) lines.push(`  - ${related.input}: ${related.message}`);
    }
    for (const error of (validation.errors || []).slice(0, 6)) {
      lines.push(
        `Error${error.line ? ` line ${error.line}` : ''}: ${error.input ? `${error.input}: ` : ''}${error.message}`
      );
      for (const related of error.relatedErrors || []) lines.push(`  - ${related.input}: ${related.message}`);
    }
    if ((validation.errors || []).length > 6) lines.push(`+${validation.errors.length - 6} more error(s)`);
    diagnostics.textContent = lines.join('\n');
    diagnostics.className = `diagnostic-box ${(validation.errors || []).length ? 'error' : (validation.warnings || []).length ? 'warn' : 'good'}`;
    document
      .querySelector('#associatedDomainGroups')
      .setAttribute('aria-invalid', (validation.errors || []).length ? 'true' : 'false');
  } catch (error) {
    diagnostics.textContent = formatError(error);
    diagnostics.className = 'diagnostic-box error';
    document.querySelector('#associatedDomainGroups').setAttribute('aria-invalid', 'true');
  }
}

async function clearActiveShield() {
  try {
    const response = await sendMessage(MESSAGE_TYPES.clearActiveShield);
    renderActiveShield(response.shield || null, response.shieldDiagnostics || null);
    toast(
      response.cleared ? 'Active request shield cleared.' : 'No active request shield was cleared.',
      response.cleared ? 'success' : 'info'
    );
  } catch (error) {
    toast(formatError(error), 'error');
  }
}

async function repairActiveShield() {
  try {
    const response = await sendMessage(MESSAGE_TYPES.repairActiveShield);
    renderActiveShield(response.shield || null, response.shieldDiagnostics || response.after || null);
    toast(
      response.repaired ? 'SiteWipe shield state repaired.' : 'Shield repair did not complete.',
      response.repaired ? 'success' : 'error'
    );
  } catch (error) {
    toast(formatError(error), 'error');
  }
}

async function clearReports() {
  if (
    !globalThis.confirm(
      'Delete all extension-local cleanup reports? This removes the latest report and optional report history and cannot be undone.'
    )
  )
    return;
  try {
    await sendMessage(MESSAGE_TYPES.clearHistory);
    toast('All extension-local reports deleted.', 'success');
  } catch (error) {
    toast(formatError(error), 'error');
  }
}

async function runSelfTests() {
  const output = document.querySelector('#selfTestOutput');
  output.textContent = 'Running self-tests…';
  try {
    const response = await sendMessage(MESSAGE_TYPES.getSelfTestResults);
    const result = response.selfTests || {};
    const lines = [`${result.passed || 0}/${(result.passed || 0) + (result.failed || 0)} self-test(s) passed.`];
    for (const test of result.tests || []) {
      lines.push(`${test.pass ? '✓' : '✗'} ${test.name}`);
      if (!test.pass && test.details) lines.push(`  ${JSON.stringify(test.details)}`);
    }
    output.textContent = lines.join('\n');
    toast(result.ok ? 'Self-tests passed.' : 'Some self-tests failed.', result.ok ? 'success' : 'error');
  } catch (error) {
    output.textContent = formatError(error);
    toast(formatError(error), 'error');
  }
}

function exportSettingsBackup() {
  const settings = currentSettings || {};
  const payload = {
    schema: 'sitewipe.settings.export.v1',
    app: 'SiteWipe',
    appVersion: APP.version,
    exportedAt: new Date().toISOString(),
    note: 'Contains SiteWipe extension settings only. It does not include cleanup reports, debug logs, active jobs, shields, bookmarks, passwords, or browser website data.',
    settings
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json'
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sitewipe-settings-${Date.now()}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  const output = document.querySelector('#settingsPortabilityOutput');
  if (output) output.textContent = `Settings exported at ${payload.exportedAt}.`;
  toast('Settings exported.', 'success');
}

async function importSettingsBackup(event) {
  const input = event?.target;
  const file = input?.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    const settings = parsed?.settings && typeof parsed.settings === 'object' ? parsed.settings : parsed;
    if (!settings || typeof settings !== 'object' || Array.isArray(settings))
      throw new Error('The selected file does not contain a settings object.');
    const keys = Object.keys(settings).filter(
      (key) => !['schema', 'app', 'appVersion', 'exportedAt', 'note'].includes(key)
    );
    if (!keys.length) throw new Error('No settings keys were found in the selected file.');
    const importsUnredactedReports =
      settings.redactReports === false || String(settings.redactReports).trim().toLowerCase() === 'false';
    const importsIndefiniteLatestReport = Number(settings.latestReportRetentionMinutes) === 0;
    if ((importsUnredactedReports || importsIndefiniteLatestReport) && !confirmSensitiveReportStorage()) {
      toast('Settings import canceled; privacy-safe report settings were not changed.', 'info');
      return;
    }
    const response = await sendMessage(MESSAGE_TYPES.saveSettings, {
      settings
    });
    renderSettings(response.settings || {});
    await validateAssociatedGroups();
    const output = document.querySelector('#settingsPortabilityOutput');
    if (output)
      output.textContent = `Imported settings from ${file.name} at ${new Date().toISOString()}. Unknown keys, invalid values, and unsafe types were ignored by the background sanitizer.`;
    toast('Settings imported and sanitized.', 'success');
    await refresh();
  } catch (error) {
    const output = document.querySelector('#settingsPortabilityOutput');
    if (output) output.textContent = formatError(error);
    toast(formatError(error), 'error');
  } finally {
    if (input) input.value = '';
  }
}

function confirmSensitiveReportStorage() {
  return globalThis.confirm(
    'Store sensitive cleanup report details? Full unredacted reports can contain browsing domains, URLs, filenames, local paths, and browser error details; indefinite retention keeps the latest report until you delete it. Choose Cancel to keep the current privacy-safe settings.'
  );
}

async function copySettingsSummary() {
  const s = currentSettings || {};
  const lines = [
    'SiteWipe settings summary',
    `Generated: ${new Date().toISOString()}`,
    `Keep history: ${Boolean(s.keepHistory)}`,
    `Redact stored reports: ${Boolean(s.redactReports)}`,
    `Cleanup mode: ${s.cleanupMode || 'standard'}`,
    'Detailed per-run cleanup review: always required',
    `Verification pass: ${Boolean(s.verificationPass)}`,
    `Temporary request shield: ${Boolean(s.temporaryDnrShield)}`,
    `Post-wipe session block: ${Boolean(s.postWipeSessionBlock)}`,
    `Overlay scope: ${s.overlayScope || 'target_tabs'}`,
    `Allow local targets: ${Boolean(s.allowLocalTargets)}`,
    `Associated groups configured: ${String(s.associatedDomainGroups || '').trim() ? 'yes' : 'no'}`,
    `Delete downloaded files: ${Boolean(s.deleteDownloadedFiles)}`,
    'Autofill and payment methods: protected',
    `Include protected web origins: ${Boolean(s.includeProtectedWebOrigins)}`,
    `Auto-repair orphan shields: ${s.autoRepairOrphanedShields !== false}`
  ];
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
  } catch {
    const area = document.createElement('textarea');
    area.value = lines.join('\n');
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  const output = document.querySelector('#settingsPortabilityOutput');
  if (output) output.textContent = lines.join('\n');
  toast('Settings summary copied.', 'success');
}

async function clearDebugLog() {
  try {
    const response = await sendMessage(MESSAGE_TYPES.clearDebugLog);
    renderDebug(response.debugLog || []);
    toast('Debug log cleared.', 'success');
  } catch (error) {
    toast(formatError(error), 'error');
  }
}

async function resetSettings() {
  if (
    !globalThis.confirm(
      'Reset SiteWipe settings to the privacy-safe defaults? Your current settings cannot be restored.'
    )
  )
    return;
  try {
    const response = await sendMessage(MESSAGE_TYPES.resetSettings);
    renderSettings(response.settings || {});
    toast('Settings reset.', 'success');
  } catch (error) {
    toast(formatError(error), 'error');
  }
}

function isChecked(id) {
  return Boolean(document.querySelector(`#${id}`).checked);
}

function setChecked(id, value) {
  document.querySelector(`#${id}`).checked = Boolean(value);
}

function valueOf(id) {
  return document.querySelector(`#${id}`).value;
}

function setValue(id, value) {
  document.querySelector(`#${id}`).value = value;
}

function applyCleanupMode(mode) {
  const expert = isExpertCleanupMode(mode);
  for (const id of EXPERT_CONTROL_IDS) {
    const control = document.querySelector(`#${id}`);
    if (!control) continue;
    control.disabled = !expert;
    control.closest('.setting-row')?.classList.toggle('expert-disabled', !expert);
  }
  const help = document.querySelector('#cleanupModeHelp');
  if (help) {
    help.textContent = expert
      ? 'Expert mode enables expanded and destructive options. Every run still requires a fresh detailed scope and impact review before cleanup can start.'
      : 'Standard mode keeps cleanup targeted to the selected site. Expanded, heavy, and destructive options are disabled until you choose Expert mode.';
  }
  applySettingDependencies();
}

function applySettingDependencies() {
  const expert = isExpertCleanupMode(valueOf('cleanupMode'));
  for (const [parentId, childIds] of Object.entries(SETTING_DEPENDENCIES)) {
    const parent = document.querySelector(`#${parentId}`);
    const parentEnabled = Boolean(parent?.checked) && !parent?.disabled;
    for (const childId of childIds) {
      const control = document.querySelector(`#${childId}`);
      if (!control) continue;
      const expertOnly = EXPERT_CONTROL_IDS.includes(childId);
      const disabled = !parentEnabled || (expertOnly && !expert);
      control.disabled = disabled;
      control.closest('.setting-row')?.classList.toggle('dependency-disabled', !parentEnabled);
      control.setAttribute('aria-disabled', String(disabled));
    }
  }
}

function toast(message, tone = 'info') {
  const el = document.querySelector('#toast');
  el.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  el.setAttribute('aria-live', tone === 'error' ? 'assertive' : 'polite');
  el.className = `toast ${tone}`;
  el.hidden = false;
  el.textContent = '';
  requestAnimationFrame(() => {
    el.textContent = message;
  });
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    el.hidden = true;
  }, 2600);
}

function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(value || 'unknown');
}

function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
      })[char]
  );
}

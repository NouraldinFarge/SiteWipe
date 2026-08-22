import { APP, MESSAGE_TYPES, STORAGE_KEYS } from '../shared/constants.js';
import { sendMessage, formatError, onceDomReady, onStorageChange } from '../shared/messaging.js';
import { isExpertCleanupMode } from '../shared/cleanup-mode.js';
import {
  assertSettingsBackupFileSize,
  buildSettingsImportCandidate,
  buildSettingsImportConfirmation,
  createSettingsBackup,
  getSettingsImportRisks,
  parseSettingsBackupText
} from '../shared/settings-backup.js';
import {
  observeOptionalPermission,
  reconcileNewOptionalPermissionGrant,
  requestOptionalPermissionWithProvenance
} from './permission-lifecycle.js';

let currentSettings = null;
let webNavigationPermissionObservation = null;
let cleanupJobRunning = false;
let activeJobCanClear = false;
let authoritativeStateReady = false;
let shieldControlAvailability = Object.freeze({ clear: false, repair: false });

const AUTHORITATIVE_CONTROL_SELECTOR = [
  '#mainContent input',
  '#mainContent select',
  '#mainContent textarea',
  '#mainContent button'
].join(', ');

const JOB_GUARDED_CONTROL_IDS = Object.freeze([
  'skipCleanupReview',
  'importSettings',
  'clearShield',
  'repairShield',
  'runMaintenanceNow',
  'resetExtensionState',
  'resetSettings'
]);

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
  'overlayScope',
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
let pendingSettingsPanelRefresh = false;
const refreshFromStorage = debounce(() => {
  const renderSettingsPanel = pendingSettingsPanelRefresh;
  pendingSettingsPanelRefresh = false;
  void refresh({ renderSettingsPanel });
}, 80);

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
    'alarms',
    'Schedules extension-local maintenance for abandoned reviews, stale cleanup-job recovery, temporary report expiry, and timed request-shield expiry. It does not schedule website-data cleanup.'
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
  setupSectionNavigation();
  wireSettingAccessibility();
  setOptionsLoading();
  bindControls();
  renderPermissionCards();
  const initialState = await refresh();
  if (initialState) setOptionsReady();
  onStorageChange((changes, area) => {
    if (area !== 'local') return;
    const changedKeys = Object.keys(changes || {}).filter((key) => REFRESH_STORAGE_KEYS.has(key));
    if (!changedKeys.length) return;
    pendingSettingsPanelRefresh ||= changedKeys.includes(STORAGE_KEYS.settings);
    refreshFromStorage();
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
  document.querySelector('#retryOptionsLoad').addEventListener('click', retryOptionsLoad);
  document.querySelector('#skipCleanupReview').addEventListener('change', async (event) => {
    if (!requireAuthoritativeState()) return;
    const control = event.currentTarget;
    if (cleanupJobRunning) {
      control.checked = currentSettings?.skipCleanupReview === true;
      document.querySelector('#activeJobText').focus();
      toast('The cleanup-review preference cannot change while a cleanup job is running.', 'info');
      return;
    }
    if (control.checked && !confirmSkipCleanupReview()) {
      control.checked = false;
      toast('Detailed cleanup review remains enabled.', 'info');
      return;
    }
    await saveFromForm(event);
  });
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
    if (!requireAuthoritativeState()) return;
    const control = event.currentTarget;
    if (!control.checked && !confirmSensitiveReportStorage()) {
      control.checked = true;
      toast('Report redaction remains enabled.', 'info');
      return;
    }
    await saveFromForm(event);
  });
  document.querySelector('#overlayScope').addEventListener('change', saveFromForm);
  document.querySelector('#reportRetentionDays').addEventListener('change', saveFromForm);
  document.querySelector('#latestReportRetentionMinutes').addEventListener('change', async (event) => {
    if (!requireAuthoritativeState()) return;
    const control = event.currentTarget;
    if (Number(control.value) === 0 && !confirmSensitiveReportStorage()) {
      control.value = String(currentSettings?.latestReportRetentionMinutes ?? 30);
      toast('The latest report will still expire automatically.', 'info');
      return;
    }
    await saveFromForm(event);
  });
  document.querySelector('#postWipeShieldExpiresMinutes').addEventListener('change', saveFromForm);
  document.querySelector('#cleanupMode').addEventListener('change', async (event) => {
    if (!requireAuthoritativeState()) return;
    applyCleanupMode(valueOf('cleanupMode'));
    if (isExpertCleanupMode(valueOf('cleanupMode'))) {
      document.querySelector('#advancedCleanupGroup').open = true;
    }
    await saveFromForm(event);
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
  document.querySelector('#importSettings').addEventListener('click', () => {
    if (!requireAuthoritativeState()) return;
    document.querySelector('#settingsImportFile').click();
  });
  document.querySelector('#settingsImportFile').addEventListener('change', importSettingsBackup);
  document.querySelector('#copySettingsSummary').addEventListener('click', copySettingsSummary);
  document.querySelector('#resetSettings').addEventListener('click', resetSettings);
}

async function refresh({ renderSettingsPanel = true } = {}) {
  try {
    const [state, permissionObservation] = await Promise.all([
      sendMessage(MESSAGE_TYPES.getOptionsState),
      observeOptionalPermission('webNavigation')
    ]);
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new Error('SiteWipe did not return its authoritative Options state.');
    }
    if (!state.settings || typeof state.settings !== 'object' || Array.isArray(state.settings)) {
      throw new Error('SiteWipe did not return authoritative settings.');
    }
    if (typeof state.incognitoAccess !== 'boolean') {
      throw new Error('SiteWipe could not verify private-window access.');
    }
    if (typeof permissionObservation !== 'boolean') {
      throw new Error('SiteWipe could not verify optional browser-permission state.');
    }
    webNavigationPermissionObservation = permissionObservation;
    if (renderSettingsPanel) renderSettings(state.settings);
    renderIncognito(state.incognitoAccess);
    renderDebug(state.debugLog || []);
    renderActiveShield(state.activeShield, state.shieldDiagnostics);
    renderActiveJob(state.activeJob);
    renderMaintenanceStatus(state.maintenanceStatus);
    await validateAssociatedGroups();
    return state;
  } catch (error) {
    const message = formatError(error);
    setOptionsLoadFailed(message);
    toast(message, 'error');
    return null;
  }
}

function renderSettings(settings) {
  currentSettings = settings || {};
  setValue('cleanupMode', settings.cleanupMode || 'standard');
  setChecked('skipCleanupReview', settings.skipCleanupReview);
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
  renderSettingsSummary(settings);
}

function renderSettingsSummary(settings) {
  const mode = isExpertCleanupMode(settings?.cleanupMode) ? 'Expert' : 'Standard';
  const modeBadge = document.querySelector('#cleanupModeBadge');
  modeBadge.textContent = `Mode: ${mode}`;
  modeBadge.className = `badge ${mode === 'Expert' ? 'warning' : 'success'}`;

  const direct = settings?.skipCleanupReview === true;
  const reviewBadge = document.querySelector('#reviewModeBadge');
  reviewBadge.textContent = direct ? 'Review: skipped by setting' : 'Review: required';
  reviewBadge.className = `badge ${direct ? 'warning' : 'success'}`;
}

function setOptionsLoading({ afterFailure = false } = {}) {
  authoritativeStateReady = false;
  document.body.classList.add('options-loading');
  document.body.classList.remove('options-load-failed');
  document.querySelector('#mainContent').setAttribute('aria-busy', 'true');
  setAuthoritativeControlsLocked(true);
  const region = document.querySelector('#optionsLoadError');
  const title = document.querySelector('#optionsLoadErrorTitle');
  const detail = document.querySelector('#optionsLoadErrorDetail');
  const retry = document.querySelector('#retryOptionsLoad');
  region.hidden = !afterFailure;
  if (afterFailure) {
    title.textContent = 'Trying to load settings again…';
    detail.textContent = 'Settings and actions remain locked until SiteWipe verifies current browser state.';
  }
  retry.disabled = true;
  retry.setAttribute('aria-disabled', 'true');
  setSettingsState(afterFailure ? 'Retrying… · controls locked' : 'Loading settings…', 'working');
}

function setOptionsLoadFailed(message) {
  authoritativeStateReady = false;
  document.body.classList.remove('options-loading');
  document.body.classList.add('options-load-failed');
  document.querySelector('#mainContent').setAttribute('aria-busy', 'false');
  setAuthoritativeControlsLocked(true);
  const region = document.querySelector('#optionsLoadError');
  const title = document.querySelector('#optionsLoadErrorTitle');
  const detail = document.querySelector('#optionsLoadErrorDetail');
  const retry = document.querySelector('#retryOptionsLoad');
  title.textContent = 'Settings could not be loaded';
  detail.textContent = `SiteWipe kept every setting and action locked because the current browser state could not be verified. ${message}`;
  region.hidden = false;
  retry.disabled = false;
  retry.setAttribute('aria-disabled', 'false');
  renderUnavailableOptionsStatus();
  setSettingsState('Load failed · controls locked', 'error');
}

function renderUnavailableOptionsStatus() {
  for (const [id, label] of [
    ['cleanupModeBadge', 'Mode: unavailable'],
    ['reviewModeBadge', 'Review: unavailable'],
    ['incognitoBadge', 'Private: unavailable']
  ]) {
    const badge = document.querySelector(`#${id}`);
    badge.textContent = label;
    badge.className = 'badge danger';
  }
  document.querySelector('#activeShieldText').textContent = 'Shield state is unavailable until settings reload.';
  document.querySelector('#maintenanceText').textContent = 'Maintenance state is unavailable until settings reload.';
  document.querySelector('#activeJobText').textContent = 'Cleanup-job state is unavailable until settings reload.';
}

function setOptionsReady({ afterRetry = false } = {}) {
  authoritativeStateReady = true;
  document.body.classList.remove('options-loading', 'options-load-failed');
  document.querySelector('#mainContent').setAttribute('aria-busy', 'false');
  document.querySelector('#optionsLoadError').hidden = true;
  setAuthoritativeControlsLocked(false);
  setSettingsState('Settings ready', 'ready');
  if (afterRetry) {
    toast('Settings loaded. Options controls are ready.', 'success');
    document.querySelector('#mainContent').focus();
  }
}

async function retryOptionsLoad() {
  setOptionsLoading({ afterFailure: true });
  const state = await refresh();
  if (state) setOptionsReady({ afterRetry: true });
}

function setAuthoritativeControlsLocked(locked) {
  for (const control of document.querySelectorAll(AUTHORITATIVE_CONTROL_SELECTOR)) {
    if (control.id === 'retryOptionsLoad') continue;
    control.disabled = locked;
    control.setAttribute('aria-disabled', String(locked));
  }
  if (!locked) {
    applyCleanupMode(currentSettings?.cleanupMode);
    applyCleanupJobControlState();
  }
}

function requireAuthoritativeState() {
  if (authoritativeStateReady && currentSettings) return true;
  toast('Settings and actions stay locked until SiteWipe can verify the current browser state.', 'error');
  document.querySelector('#retryOptionsLoad')?.focus();
  return false;
}

function setSettingsState(label, tone = 'ready') {
  const badge = document.querySelector('#settingsStateBadge');
  if (!badge) return;
  badge.textContent = label;
  badge.className = `badge ${tone === 'success' || tone === 'ready' ? 'success' : tone === 'error' ? 'danger' : ''}`;
}

function setupSectionNavigation() {
  const links = [...document.querySelectorAll('.rail-nav a[href^="#"]')];
  const sections = [...document.querySelectorAll('[data-options-section]')];
  let explicitSectionId = null;
  let explicitSectionSeen = false;
  const setCurrent = (id) => {
    for (const link of links) {
      const active = link.getAttribute('href') === `#${id}`;
      if (active) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  };
  const activateExplicitSection = (id) => {
    if (explicitSectionId !== id) explicitSectionSeen = false;
    explicitSectionId = id;
    setCurrent(id);
  };
  const explicitSectionIsVisible = () => {
    if (!explicitSectionId) return false;
    const section = document.getElementById(explicitSectionId);
    if (!section) return false;
    const rect = section.getBoundingClientRect();
    const viewportHeight = globalThis.innerHeight || document.documentElement.clientHeight;
    return rect.bottom > 68 && rect.top < viewportHeight;
  };
  const revealHashTarget = () => {
    const id = globalThis.location?.hash?.slice(1);
    const target = id ? document.getElementById(id) : null;
    if (!target) return;
    target.closest('details')?.setAttribute('open', '');
    const section = target.matches('[data-options-section]') ? target : target.closest('[data-options-section]');
    if (section?.id) activateExplicitSection(section.id);
  };
  for (const link of links) {
    link.addEventListener('click', () => {
      const id = link.getAttribute('href').slice(1);
      activateExplicitSection(id);
    });
  }
  globalThis.addEventListener?.('hashchange', revealHashTarget);
  revealHashTarget();
  if (typeof IntersectionObserver !== 'function') return;
  const observer = new IntersectionObserver(
    (entries) => {
      if (explicitSectionId) {
        if (explicitSectionIsVisible()) {
          explicitSectionSeen = true;
          setCurrent(explicitSectionId);
          return;
        }
        if (!explicitSectionSeen) {
          setCurrent(explicitSectionId);
          return;
        }
        explicitSectionId = null;
        explicitSectionSeen = false;
      }
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (visible?.target?.id) setCurrent(visible.target.id);
    },
    { rootMargin: '-18% 0px -68% 0px', threshold: [0.01, 0.2, 0.5] }
  );
  for (const section of sections) observer.observe(section);
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
    <details class="permission-card">
      <summary><strong>${escapeHtml(title)}</strong><span aria-hidden="true"></span></summary>
      <p>${escapeHtml(body)}</p>
    </details>
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

async function saveFromForm(event) {
  if (!requireAuthoritativeState()) return;
  const changedControlId = event?.currentTarget?.id || '';
  applySettingDependencies();
  setSettingsState('Saving…', 'working');
  const settings = {
    cleanupMode: valueOf('cleanupMode'),
    skipCleanupReview: isChecked('skipCleanupReview'),
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
  let framePermissionDenied = false;
  let framePermissionGrant = null;
  try {
    if (!isExpertCleanupMode(settings.cleanupMode)) {
      settings.embeddedFrameDiscovery = false;
      setChecked('embeddedFrameDiscovery', false);
    }
    const explicitlyEnablingFrameDiscovery =
      settings.embeddedFrameDiscovery && currentSettings?.embeddedFrameDiscovery !== true;
    if (explicitlyEnablingFrameDiscovery) {
      framePermissionGrant = await requestOptionalPermissionWithProvenance('webNavigation', {
        observedBeforeGesture: webNavigationPermissionObservation
      });
      if (!framePermissionGrant.granted) {
        framePermissionDenied = true;
        settings.embeddedFrameDiscovery = false;
        setChecked('embeddedFrameDiscovery', false);
        document.querySelector('#embeddedFrameDiscovery').focus();
      }
    }
    const response = await sendMessage(MESSAGE_TYPES.saveSettings, { settings });
    const authoritativeSettings = response.settings || null;
    webNavigationPermissionObservation = await observeOptionalPermission('webNavigation');
    const framePermissionReconciliation = await reconcileNewOptionalPermissionGrant({
      permission: 'webNavigation',
      granted: framePermissionGrant?.granted === true && webNavigationPermissionObservation !== false,
      grantProvenance: framePermissionGrant?.grantProvenance,
      authoritativeStateKnown: Boolean(authoritativeSettings),
      authoritativeFeatureEnabled: authoritativeFrameDiscoveryEnabled(authoritativeSettings)
    });
    renderSettings(response.settings || settings);
    const permissionWarning = optionalPermissionReconciliationNeedsAttention(framePermissionReconciliation)
      ? ' Optional webNavigation access could not be reconciled automatically; review SiteWipe extension permissions.'
      : '';
    toast(
      framePermissionDenied
        ? 'Settings saved. Embedded-frame discovery remains off because optional webNavigation access was not granted.'
        : `Settings saved.${permissionWarning}`,
      framePermissionDenied || permissionWarning ? 'info' : 'success'
    );
    setSettingsState(framePermissionDenied || permissionWarning ? 'Saved · check access' : 'Saved', 'success');
  } catch (error) {
    const refreshedState = await refresh();
    const framePermissionReconciliation = await reconcileNewOptionalPermissionGrant({
      permission: 'webNavigation',
      granted: framePermissionGrant?.granted === true && webNavigationPermissionObservation !== false,
      grantProvenance: framePermissionGrant?.grantProvenance,
      authoritativeStateKnown: Boolean(refreshedState?.settings),
      authoritativeFeatureEnabled: authoritativeFrameDiscoveryEnabled(refreshedState?.settings)
    });
    const permissionWarning = optionalPermissionReconciliationNeedsAttention(framePermissionReconciliation)
      ? ' Optional webNavigation access was preserved because Chrome does not prove whether this request created the grant; review extension permissions if the feature remains off.'
      : '';
    toast(`${formatError(error)}${permissionWarning}`, 'error');
    setSettingsState('Save needs attention', 'error');
    if (changedControlId) document.querySelector(`#${changedControlId}`)?.focus();
  }
}

function authoritativeFrameDiscoveryEnabled(settings) {
  return Boolean(isExpertCleanupMode(settings?.cleanupMode) && settings?.embeddedFrameDiscovery === true);
}

function optionalPermissionReconciliationNeedsAttention(result) {
  return [
    'authoritative_state_unknown',
    'grant_provenance_unknown',
    'release_not_confirmed',
    'release_uncertain'
  ].includes(result?.reason);
}

function renderActiveShield(shield, diagnostics = null) {
  const text = document.querySelector('#activeShieldText');
  const actualRules = diagnostics?.siteWipeRuleCount || 0;
  const orphanRules = diagnostics?.orphanRuleIds?.length || 0;
  const missingRules = diagnostics?.missingTrackedRuleIds?.length || 0;
  if (!shield && !actualRules) {
    text.textContent =
      'No active SiteWipe request shield is recorded, and no SiteWipe session DNR rules are currently installed.';
    shieldControlAvailability = Object.freeze({ clear: false, repair: false });
    applyCleanupJobControlState();
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
  shieldControlAvailability = Object.freeze({
    clear: Boolean(shield || actualRules),
    repair: diagnostics ? !(diagnostics.healthy && !actualRules) : true
  });
  applyCleanupJobControlState();
}

function renderActiveJob(job) {
  const text = document.querySelector('#activeJobText');
  cleanupJobRunning = job?.status === 'running';
  activeJobCanClear = Boolean(job && !cleanupJobRunning);
  applyCleanupJobControlState();
  if (!job) {
    text.textContent = 'No active or interrupted SiteWipe cleanup job is recorded.';
    delete text.dataset.state;
    return;
  }
  const status = job.status || 'unknown';
  const percent = Number.isFinite(Number(job.percent)) ? `${Math.round(Number(job.percent))}%` : 'unknown progress';
  const target = job.targetDomain || 'target';
  const detail = job.detail ? ` ${job.detail}` : '';
  const safeguards = cleanupJobRunning
    ? ' Cleanup-review changes, settings import/reset, local-state reset, request-shield changes, and manual maintenance are disabled until this cleanup stops.'
    : '';
  text.textContent = `${target}: ${status} · ${percent} · ${job.label || job.phase || 'No phase'}.${detail}${job.updatedAt ? ` Updated ${formatDateTime(job.updatedAt)}.` : ''}${safeguards}`;
  text.dataset.state = status;
}

function applyCleanupJobControlState() {
  const focusedControlIsGuarded = JOB_GUARDED_CONTROL_IDS.some(
    (id) => document.activeElement === document.querySelector(`#${id}`)
  );
  const stateLocked = !authoritativeStateReady;
  document.querySelector('#clearShield').disabled =
    stateLocked || cleanupJobRunning || !shieldControlAvailability.clear;
  document.querySelector('#repairShield').disabled =
    stateLocked || cleanupJobRunning || !shieldControlAvailability.repair;
  document.querySelector('#clearActiveJob').disabled = stateLocked || !activeJobCanClear;
  for (const id of [
    'skipCleanupReview',
    'importSettings',
    'runMaintenanceNow',
    'resetExtensionState',
    'resetSettings'
  ]) {
    const control = document.querySelector(`#${id}`);
    control.disabled = stateLocked || cleanupJobRunning;
    control.setAttribute('aria-disabled', String(control.disabled));
  }
  for (const id of ['clearShield', 'repairShield', 'clearActiveJob']) {
    const control = document.querySelector(`#${id}`);
    control.setAttribute('aria-disabled', String(control.disabled));
  }
  if (cleanupJobRunning && focusedControlIsGuarded) document.querySelector('#activeJobText').focus();
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
  if (!requireAuthoritativeState()) return;
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
  if (!requireAuthoritativeState()) return;
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
  if (!requireAuthoritativeState()) return;
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
  if (!requireAuthoritativeState()) return;
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
  if (!requireAuthoritativeState()) return;
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
  if (!requireAuthoritativeState()) return;
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
  if (!requireAuthoritativeState()) return;
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
  if (!requireAuthoritativeState()) return;
  try {
    const payload = createSettingsBackup(currentSettings || {}, { appVersion: APP.version });
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
  } catch (error) {
    const output = document.querySelector('#settingsPortabilityOutput');
    if (output) output.textContent = formatError(error);
    toast(formatError(error), 'error');
  }
}

async function importSettingsBackup(event) {
  const input = event?.target;
  if (!requireAuthoritativeState()) {
    if (input) input.value = '';
    return;
  }
  const file = input?.files?.[0];
  if (!file) return;
  if (cleanupJobRunning) {
    input.value = '';
    document.querySelector('#activeJobText').focus();
    toast('Settings cannot be imported while a cleanup job is running.', 'info');
    return;
  }
  try {
    assertSettingsBackupFileSize(file);
    const text = await file.text();
    const backup = parseSettingsBackupText(text);
    const candidateSettings = buildSettingsImportCandidate(currentSettings || {}, backup.settings);
    const preview = buildSettingsImportConfirmation({
      ...backup,
      risks: getSettingsImportRisks(candidateSettings)
    });
    if (!globalThis.confirm(preview)) {
      const output = document.querySelector('#settingsPortabilityOutput');
      if (output) output.textContent = 'Settings import canceled. Every current setting remains unchanged.';
      toast('Settings import canceled; current settings were not changed.', 'info');
      return;
    }
    const response = await sendMessage(MESSAGE_TYPES.saveSettings, {
      settings: backup.settings
    });
    renderSettings(response.settings || {});
    await validateAssociatedGroups();
    const output = document.querySelector('#settingsPortabilityOutput');
    if (output)
      output.textContent = `Imported ${backup.recognizedKeys.length} recognized setting${backup.recognizedKeys.length === 1 ? '' : 's'} from ${file.name} at ${new Date().toISOString()}. ${backup.unknownKeyCount} unknown field${backup.unknownKeyCount === 1 ? ' was' : 's were'} ignored. Values also passed through the background sanitizer.`;
    toast('Settings imported, confirmed, and sanitized.', 'success');
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

function confirmSkipCleanupReview() {
  return globalThis.confirm(
    'Skip the detailed cleanup review completely for future cleanups? This applies in Standard and Expert mode. One popup cleanup action can immediately begin all currently enabled cleanup effects. Expert options can delete matched downloaded files or affect broader site data, and private-window data can be included when incognito access is enabled. Chrome or Brave may still require its own permission prompt. Choose Cancel to keep detailed review enabled.'
  );
}

async function copySettingsSummary() {
  if (!requireAuthoritativeState()) return;
  const s = currentSettings || {};
  const lines = [
    'SiteWipe settings summary',
    `Generated: ${new Date().toISOString()}`,
    `Keep history: ${Boolean(s.keepHistory)}`,
    `Redact stored reports: ${Boolean(s.redactReports)}`,
    `Cleanup mode: ${s.cleanupMode || 'standard'}`,
    `Skip detailed cleanup review completely: ${Boolean(s.skipCleanupReview)}`,
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
  if (!requireAuthoritativeState()) return;
  try {
    const response = await sendMessage(MESSAGE_TYPES.clearDebugLog);
    renderDebug(response.debugLog || []);
    toast('Debug log cleared.', 'success');
  } catch (error) {
    toast(formatError(error), 'error');
  }
}

async function resetSettings() {
  if (!requireAuthoritativeState()) return;
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
  if (!expert) {
    setChecked('embeddedFrameDiscovery', false);
    setValue('overlayScope', 'target_tabs');
  }
  for (const id of EXPERT_CONTROL_IDS) {
    const control = document.querySelector(`#${id}`);
    if (!control) continue;
    control.disabled = !authoritativeStateReady || !expert;
    control.setAttribute('aria-disabled', String(control.disabled));
    control.closest('.setting-row')?.classList.toggle('expert-disabled', !expert);
  }
  const help = document.querySelector('#cleanupModeHelp');
  if (help) {
    help.textContent = expert
      ? 'Expert mode enables expanded and destructive options. The separate cleanup-review setting remains available and controls whether the detailed per-run screen is shown.'
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
      const disabled = !authoritativeStateReady || !parentEnabled || (expertOnly && !expert);
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

export const APP = Object.freeze({
  name: 'SiteWipe',
  version: '1.11.21',
  maxReports: 10
});

export const MESSAGE_PROTOCOL_VERSION = 1;

export const STORAGE_KEYS = Object.freeze({
  settings: 'sitewipe.settings.v1',
  reports: 'sitewipe.reports.v1',
  activeReport: 'sitewipe.activeReport.v1',
  debugLog: 'sitewipe.debugLog.v1',
  activeJob: 'sitewipe.activeJob.v1',
  activeShield: 'sitewipe.activeShield.v1',
  lastMaintenance: 'sitewipe.lastMaintenance.v1',
  permissionLease: 'sitewipe.permissionLease.v1'
});

export const MESSAGE_TYPES = Object.freeze({
  normalizeTarget: 'sitewipe.normalizeTarget',
  getActiveTabTarget: 'sitewipe.getActiveTabTarget',
  getState: 'sitewipe.getState',
  getPopupState: 'sitewipe.getPopupState',
  getOptionsState: 'sitewipe.getOptionsState',
  getReportState: 'sitewipe.getReportState',
  prepareCleanupReview: 'sitewipe.prepareCleanupReview',
  cancelCleanupReview: 'sitewipe.cancelCleanupReview',
  runDeepClean: 'sitewipe.runDeepClean',
  getReport: 'sitewipe.getReport',
  getHistory: 'sitewipe.getHistory',
  clearHistory: 'sitewipe.clearHistory',
  getSettings: 'sitewipe.getSettings',
  saveSettings: 'sitewipe.saveSettings',
  resetSettings: 'sitewipe.resetSettings',
  clearDebugLog: 'sitewipe.clearDebugLog',
  getIncognitoStatus: 'sitewipe.getIncognitoStatus',
  openSidePanel: 'sitewipe.openSidePanel',
  clearActiveShield: 'sitewipe.clearActiveShield',
  repairActiveShield: 'sitewipe.repairActiveShield',
  getShieldDiagnostics: 'sitewipe.getShieldDiagnostics',
  expireActiveShield: 'sitewipe.expireActiveShield',
  forgetLatestReport: 'sitewipe.forgetLatestReport',
  getActiveJob: 'sitewipe.getActiveJob',
  cancelActiveJob: 'sitewipe.cancelActiveJob',
  clearActiveJobRecord: 'sitewipe.clearActiveJobRecord',
  validateAssociatedGroups: 'sitewipe.validateAssociatedGroups',
  getSelfTestResults: 'sitewipe.getSelfTestResults',
  getMaintenanceStatus: 'sitewipe.getMaintenanceStatus',
  runMaintenanceNow: 'sitewipe.runMaintenanceNow',
  resetExtensionLocalState: 'sitewipe.resetExtensionLocalState'
});

export const DEFAULT_SETTINGS = Object.freeze({
  keepHistory: false,
  reducedMotion: false,
  highContrast: false,
  debugLog: false,
  aggressiveCookieSweep: true,
  includeProtectedWebOrigins: false,
  pageScriptScrub: true,
  mainWorldPageScrub: false,
  storageBucketScrub: false,
  embeddedFrameDiscovery: false,
  probePartitionedCookiesWithEmbeddingSites: false,
  exhaustiveCookieStoreScan: false,
  downloadRecentFallback: false,
  stabilityDefaultsAppliedAt: null,
  performanceDefaultsAppliedAt: null,
  privacyDefaultsAppliedAt: null,
  deleteDownloadedFiles: false,
  temporaryDnrShield: true,
  progressOverlay: true,
  progressOverlayCancelButton: true,
  overlayScope: 'target_tabs',
  postWipeSessionBlock: false,
  postWipeShieldExpiresMinutes: 0,
  autoRepairOrphanedShields: true,
  latestReportRetentionMinutes: 30,
  resetZoom: true,
  resetMutedTabs: false,
  unpinTargetTabs: false,
  opfsScrub: true,
  serviceWorkerExtraScrub: true,
  appBadgeClear: true,
  permissionAudit: true,
  redactReports: true,
  verificationPass: true,
  allowLocalTargets: false,
  blockOnAssociatedGroupErrors: true,
  broadDiscoveryFallback: false,
  cleanupMode: 'standard',
  associatedDomainGroups: '',
  reportRetentionDays: 7,
  createdAt: null,
  updatedAt: null
});

const CLEANUP_MATRIX_IMPLEMENTATION = Object.freeze([
  {
    type: 'Persistent cleanup jobs and recovery',
    api: 'chrome.storage.local active job state + recovery finalizer',
    targeted:
      'Tracks active cleanup phase/progress across popup closure and marks stale jobs interrupted on service-worker restart',
    incognito: 'N/A',
    status: 'fully supported'
  },
  {
    type: 'Mandatory cleanup review',
    api: 'Read-only impact preflight + session-scoped single-use reviewed approval',
    targeted:
      'Every Standard and Expert cleanup displays the normalized scope, associated/private effects, attempted and protected categories, impact counts, limitations, and any file deletion before a final explicit approval',
    incognito: 'Required when private-window access is enabled; private reports remain transient',
    status: 'fully supported'
  },
  {
    type: 'Protected browser data guard',
    api: 'Origin-scoped allowlist + protected browser-service target block',
    targeted:
      'Rejects passwords, form-data/autofill, bookmarks, browser Sync/account targets, extension origins, and every unapproved global/time-based deletion before cleanup begins',
    incognito: 'Same guard applies',
    status: 'fully supported'
  },
  {
    type: 'Repeat-run self-repair',
    api: 'SiteWipe-owned active job/shield state + DNR diagnostics',
    targeted:
      'Before cleanup and during maintenance, clears interrupted jobs and stale, orphaned, or inconsistent SiteWipe request-shield state without changing browser internals',
    incognito: 'N/A',
    status: 'fully supported'
  },
  {
    type: 'Post-clean verification pass',
    api: 'chrome.tabs, chrome.cookies, chrome.history, chrome.downloads',
    targeted:
      'Best-effort re-check of exposed cookies, matching tabs, history URLs, and download records after cleanup',
    incognito: 'Browser-limited; reported honestly',
    status: 'partially supported'
  },
  {
    type: 'Cancelable cleanup jobs',
    api: 'chrome.storage.local cancel flag checked between major phases',
    targeted:
      'User can request cancellation; SiteWipe stops before the next major destructive phase and saves a partial report',
    incognito: 'N/A',
    status: 'partially supported'
  },
  {
    type: 'Temporary request shield',
    api: 'chrome.declarativeNetRequest session rules',
    targeted: 'Yes, target domain URL filter during cleanup; optional keep-until-browser-restart shield',
    incognito: 'Network rules apply at browser level while active',
    status: 'fully supported'
  },
  {
    type: 'Request-shield diagnostics and repair',
    api: 'chrome.declarativeNetRequest.getSessionRules/updateSessionRules',
    targeted:
      'Audits SiteWipe-owned session DNR rules, detects orphan/missing shield rules, and can clear the complete SiteWipe rule range without touching unrelated extension rules',
    incognito: 'N/A',
    status: 'fully supported'
  },
  {
    type: 'Report filtering, exports, and checksums',
    api: 'Extension-local report post-processing',
    targeted:
      'Adds browser-visible change totals, searchable side-panel sections, privacy-gated exports, and a local SHA-256 content checksum so reports are easier to review and compare',
    incognito: 'N/A',
    status: 'fully supported'
  },
  {
    type: 'Redacted report sharing',
    api: 'Side-panel local export redaction',
    targeted: 'Exports redacted JSON and text reports with domains/URLs/paths replaced before download or sharing',
    incognito: 'N/A',
    status: 'fully supported'
  },
  {
    type: 'Report checksum verification',
    api: 'Web Crypto SHA-256 local content checksum',
    targeted:
      'Recomputes the stored report checksum so users can detect content mismatch. The checksum is not a signature and does not authenticate a report or its author',
    incognito: 'N/A',
    status: 'fully supported'
  },

  {
    type: 'Verification evidence confidence summary',
    api: 'Local report scoring',
    targeted:
      'Adds a conservative confidence label and reasons based on exposed verification residue, errors, failed origin cleanup plans, host access, and private-access availability',
    incognito: 'N/A',
    status: 'fully supported'
  },
  {
    type: 'Report history filtering and bulk export',
    api: 'Side-panel local report tools',
    targeted:
      'Filters local report history and exports full or redacted report-history bundles for offline review without changing browser data',
    incognito: 'N/A',
    status: 'fully supported'
  },
  {
    type: 'Settings backup and restore',
    api: 'Options page local JSON import/export + sanitized settings writes',
    targeted:
      'Exports SiteWipe settings to a local JSON file and imports only known sanitized settings keys selected by the user',
    incognito: 'N/A',
    status: 'fully supported'
  },
  {
    type: 'Cross-tab cleanup progress overlay',
    api: 'chrome.tabs.query + chrome.scripting.executeScript',
    targeted:
      'Shows cleanup progress in the bottom-right of accessible http/https tabs during a run, supports all-tabs/current-window/target-tabs scope, uses a watchdog self-removal timer, then removes itself',
    incognito: 'Yes, only if incognito access is allowed; chrome:// and other restricted pages cannot be injected',
    status: 'fully supported'
  },
  {
    type: 'Overlay cancel control',
    api: 'Injected isolated-world overlay + chrome.runtime messaging',
    targeted:
      'Optional cancel button inside the in-page progress overlay requests cancellation and SiteWipe stops before the next major phase',
    incognito: 'Yes, only where the overlay itself can be injected',
    status: 'partially supported'
  },
  {
    type: 'Scheduled maintenance alarms',
    api: 'chrome.alarms + chrome.storage.local',
    targeted:
      'Wakes the service worker to expire timed shields, auto-forget latest reports, and mark stale jobs even when Options is not open',
    incognito: 'N/A',
    status: 'fully supported'
  },
  {
    type: 'Maintenance run history',
    api: 'chrome.storage.local last-maintenance snapshot',
    targeted:
      'Stores the most recent scheduled/manual maintenance result locally and shows it in Options for auditability',
    incognito: 'N/A',
    status: 'fully supported'
  },
  {
    type: 'Manual maintenance and local-state reset',
    api: 'Options page + background maintenance endpoint',
    targeted:
      'Shows next scheduled maintenance, runs maintenance on demand, and can reset SiteWipe-local reports/jobs/shields/settings without touching browser website data',
    incognito: 'N/A',
    status: 'fully supported'
  },
  {
    type: 'Orphan shield auto-repair',
    api: 'chrome.declarativeNetRequest diagnostics + scheduled maintenance',
    targeted:
      'Optionally clears SiteWipe-owned DNR session rules when no active shield record exists, preventing stale local request blocks',
    incognito: 'N/A',
    status: 'fully supported'
  },
  {
    type: 'Browser-action progress badge',
    api: 'chrome.action.setBadgeText',
    targeted:
      'Shows current cleanup percentage, cancel request, completion, or error state on the extension toolbar icon while a job is active',
    incognito: 'N/A',
    status: 'fully supported'
  },
  {
    type: 'Localhost/IP exact-origin cleanup',
    api: 'Exact-origin URL matching + normal Chrome cleanup APIs',
    targeted:
      'Optional advanced developer mode for localhost, loopback, LAN IP, and bracketed IPv6 origins; storage/tabs/history/downloads are exact-origin, cookies are host-scoped because browsers do not scope cookies by port',
    incognito: 'Yes, only if allowed',
    status: 'advanced opt-in'
  },
  {
    type: 'Associated-domain cleanup groups',
    api: 'Configured, preflight-bound target expansion + existing cleanup APIs',
    targeted:
      'Optional; when a configured primary target is cleaned, preflight-bound related domains/origins are included in discovery, cookies, storage, history, downloads, and request shielding after browser-service safety checks',
    incognito: 'Yes, only if allowed',
    status: 'advanced opt-in'
  },
  {
    type: 'Associated-domain validation',
    api: 'Options diagnostics + background parser',
    targeted:
      'Validates group syntax, duplicate/self references, local-target policy, and per-line caps before cleanup uses a group',
    incognito: 'N/A',
    status: 'fully supported'
  },
  {
    type: 'Associated-domain error gate',
    api: 'Preflight parser validation before cleanup mutation',
    targeted:
      'Optional safety gate blocks cleanup when associated-domain groups contain syntax or target errors, preventing partial surprises',
    incognito: 'N/A',
    status: 'fully supported'
  },
  {
    type: 'Broad discovery fallback control',
    api: 'Bounded chrome.history/chrome.downloads query term strategy',
    targeted:
      'Optional; first-label broad searches are disabled by default and can be enabled only when precise domain searches miss old records',
    incognito: 'N/A',
    status: 'fully supported'
  },
  {
    type: 'Source-window overlay targeting',
    api: 'chrome.windows + chrome.tabs query by sender windowId',
    targeted:
      'Current-window progress overlay scope uses the popup/source window when available instead of an ambiguous service-worker current window',
    incognito: 'Yes, only if allowed',
    status: 'fully supported'
  },
  {
    type: 'Stale-job recovery controls',
    api: 'chrome.storage.local active job record + manual clear',
    targeted:
      'Shows interrupted/canceled/failed job state and lets the user clear stale local job status without touching browser data',
    incognito: 'N/A',
    status: 'fully supported'
  },
  {
    type: 'Report retention controls',
    api: 'chrome.storage.local pruning before report save/read',
    targeted: 'Extension-local reports can be kept for a limited number of days or not stored in history at all',
    incognito: 'N/A',
    status: 'fully supported'
  },
  {
    type: 'Latest-report auto-forget',
    api: 'chrome.storage.local active-report expiration',
    targeted:
      'Optional timer removes the latest in-panel report after a short local retention window without changing browser data',
    incognito: 'N/A',
    status: 'fully supported'
  },
  {
    type: 'Post-wipe shield expiration',
    api: 'chrome.declarativeNetRequest session rules + stored expiration metadata',
    targeted:
      'Optional time limit clears SiteWipe-owned post-wipe DNR shield rules after the configured window when the extension wakes or options are opened',
    incognito: 'N/A',
    status: 'fully supported'
  },
  {
    type: 'Tabs',
    api: 'chrome.tabs.query/remove',
    targeted: 'Yes, exact host/domain match',
    incognito: 'Yes, only if allowed',
    status: 'fully supported'
  },
  {
    type: 'Site zoom state',
    api: 'chrome.tabs.getZoom/getZoomSettings/setZoom',
    targeted: 'Yes, open target tabs; resets per-origin zoom where Chrome applies it',
    incognito: 'Yes, only if allowed',
    status: 'fully supported'
  },
  {
    type: 'Tab mute/pin/group/window UI state',
    api: 'chrome.tabs + chrome.windows',
    targeted: 'Audits open target tabs; mute/pin resets are opt-in',
    incognito: 'Yes, only if allowed',
    status: 'partially supported'
  },
  {
    type: 'Embedded target frames',
    api: 'chrome.webNavigation.getAllFrames',
    targeted: 'Optional; discovers target subframes inside other pages',
    incognito: 'Yes, only if allowed and exposed',
    status: 'partially supported'
  },
  {
    type: 'Live page-visible storage',
    api: 'chrome.scripting.executeScript in the ISOLATED extension world',
    targeted:
      'Yes, matching open pages/frames before tab close; MAIN-world execution is intentionally prohibited because page code can replace browser APIs and falsify evidence',
    incognito: 'Yes, only if allowed',
    status: 'partially supported'
  },
  {
    type: 'Unpartitioned cookies',
    api: 'chrome.cookies.getAll/remove + browsingData cookie sweep',
    targeted: 'Yes, registrable domain and subdomains',
    incognito: 'Yes, separate cookie stores if allowed',
    status: 'fully supported'
  },
  {
    type: 'Partitioned cookies / CHIPS',
    api: 'chrome.cookies partitionKey + partition probes',
    targeted: 'Partially; exposed or probeable partition keys',
    incognito: 'Yes, if store is visible',
    status: 'partially supported'
  },
  {
    type: 'LocalStorage',
    api: 'chrome.browsingData.remove origins + page scrub',
    targeted: 'Yes, discovered matching origins and open frames',
    incognito: 'Browser-limited; reported honestly',
    status: 'fully supported'
  },
  {
    type: 'IndexedDB',
    api: 'chrome.browsingData.remove origins + live page deletion',
    targeted: 'Yes, origin-scoped plus open-frame direct delete',
    incognito: 'Browser-limited; reported honestly',
    status: 'fully supported'
  },
  {
    type: 'Storage Buckets API data',
    api: 'navigator.storageBuckets.delete in live pages',
    targeted: 'Yes, matching open pages/frames where the web API exists',
    incognito: 'Yes, only if allowed',
    status: 'partially supported'
  },
  {
    type: 'Origin Private File System / OPFS',
    api: 'navigator.storage.getDirectory in live pages + browsingData fileSystems',
    targeted: 'Yes, matching open pages/frames where the web API exists; capped for performance',
    incognito: 'Yes, only if allowed',
    status: 'partially supported'
  },
  {
    type: 'Cache Storage',
    api: 'chrome.browsingData.remove origins',
    targeted: 'Yes, origin-scoped',
    incognito: 'Browser-limited; reported honestly',
    status: 'fully supported'
  },
  {
    type: 'Service Workers',
    api: 'chrome.browsingData.remove origins + page unregister',
    targeted: 'Yes, discovered matching origins and open frames',
    incognito: 'Browser-limited; reported honestly',
    status: 'fully supported'
  },
  {
    type: 'Push subscriptions / Background Sync / Periodic Sync',
    api: 'serviceWorker registration APIs in live pages',
    targeted:
      'Best-effort push unsubscribe and periodic-sync unregister; one-off Background Sync tags are observed because no tag-level unregister API exists; owning service-worker unregister is attempted',
    incognito: 'Yes, only if allowed',
    status: 'partially supported'
  },
  {
    type: 'PWA/app badge',
    api: 'navigator.clearAppBadge in live pages',
    targeted: 'Best-effort for matching open pages where supported',
    incognito: 'Yes, only if allowed',
    status: 'partially supported'
  },
  {
    type: 'WebSQL',
    api: 'chrome.browsingData.remove origins',
    targeted: 'Yes, where browser still supports it',
    incognito: 'Browser-limited; reported honestly',
    status: 'partially supported'
  },
  {
    type: 'File System storage',
    api: 'chrome.browsingData.remove origins',
    targeted: 'Yes, origin-scoped',
    incognito: 'Browser-limited; reported honestly',
    status: 'fully supported'
  },
  {
    type: 'HTTP cache',
    api: 'chrome.browsingData.remove origins',
    targeted: 'Yes, origin-scoped where supported',
    incognito: 'Browser-limited; reported honestly',
    status: 'partially supported'
  },
  {
    type: 'Installed/protected web app data',
    api: 'chrome.browsingData originTypes.protectedWeb',
    targeted: 'Yes, target origins only when enabled',
    incognito: 'Browser-limited; reported honestly',
    status: 'partially supported'
  },
  {
    type: 'Recently closed session metadata',
    api: 'Not requested',
    targeted:
      'Preserved; Chrome has no targeted forget API, and SiteWipe does not request the sessions permission merely for extra discovery',
    incognito: 'No persistent incognito session list exposed',
    status: 'unavailable through extension APIs'
  },
  {
    type: 'AppCache',
    api: 'chrome.browsingData appcache',
    targeted: 'No reliable origin-scoped support',
    incognito: 'No reliable support',
    status: 'unavailable through extension APIs'
  },
  {
    type: 'Browsing history',
    api: 'chrome.history.search/deleteUrl',
    targeted: 'Yes, bounded multi-query enumerate and filter URLs',
    incognito: 'No persistent incognito history exposed',
    status: 'fully supported'
  },
  {
    type: 'Download history',
    api: 'chrome.downloads.search/erase',
    targeted: 'Yes, bounded multi-query enumerate and optional recent fallback',
    incognito: 'Limited to exposed download records',
    status: 'fully supported'
  },
  {
    type: 'Downloaded files on disk',
    api: 'chrome.downloads.removeFile',
    targeted: 'Optional, matched download records only',
    incognito: 'Limited to exposed download records',
    status: 'optional destructive cleanup'
  },
  {
    type: 'Browser permission and content-setting rules',
    api: 'Chrome site-settings UI',
    targeted:
      'Preserved: MV3 cannot safely delete arbitrary user- or other-extension-managed rules for one target without adding new controlling rules',
    incognito: 'Manage manually in Chrome/Brave',
    status: 'manual-only for safety'
  },
  {
    type: 'Live permission states',
    api: 'navigator.permissions.query in live pages',
    targeted: 'Audit only; web API query support varies by permission and browser',
    incognito: 'Yes, only if allowed',
    status: 'partially supported'
  },
  {
    type: 'Protocol handlers',
    api: 'navigator.registerProtocolHandler browser UI',
    targeted: 'No safe target-domain removal API exposed to extensions',
    incognito: 'N/A',
    status: 'unavailable through extension APIs'
  },
  {
    type: 'Favicon cache / Top Sites / Omnibox suggestions',
    api: 'Browser UI/cache internals',
    targeted: 'History/open-tab cleanup helps, but no complete target-safe deletion API',
    incognito: 'N/A',
    status: 'unavailable through extension APIs'
  },
  {
    type: 'HSTS / Alt-Svc / DNS / TLS / socket pools / NEL',
    api: 'Browser network stack internals',
    targeted: 'No safe target-domain cleanup API exposed to MV3 extensions',
    incognito: 'N/A',
    status: 'unavailable through extension APIs'
  },
  {
    type: 'FedCM / Storage Access / Private State Tokens',
    api: 'Browser identity/privacy APIs',
    targeted: 'Reported or manual-only where Chrome exposes no target-domain extension API',
    incognito: 'N/A',
    status: 'partially supported'
  },
  {
    type: 'USB / Bluetooth / Serial / HID / local fonts / File System Access handles',
    api: 'Browser device/site settings',
    targeted: 'Reported/manual-only where no extension revocation API exists',
    incognito: 'N/A',
    status: 'unavailable through extension APIs'
  },
  {
    type: 'Passkeys / WebAuthn credentials',
    api: 'N/A',
    targeted: 'Credential material is intentionally excluded',
    incognito: 'N/A',
    status: 'skipped for safety'
  },
  {
    type: 'Saved passwords',
    api: 'N/A',
    targeted: 'Not available and never requested',
    incognito: 'N/A',
    status: 'skipped for safety'
  },
  {
    type: 'Bookmarks',
    api: 'N/A',
    targeted: 'Not requested',
    incognito: 'N/A',
    status: 'skipped for safety'
  },
  {
    type: 'Autofill profiles / payment methods',
    api: 'N/A',
    targeted:
      'Protected because Chrome couples global form-data removal with saved autofill profiles and payment cards; SiteWipe never calls that global removal path',
    incognito: 'N/A',
    status: 'skipped for safety'
  },
  {
    type: 'Remote website, ISP, DNS, OS, VPN, firewall, enterprise logs',
    api: 'N/A',
    targeted: 'Outside browser extension APIs',
    incognito: 'N/A',
    status: 'unavailable through extension APIs'
  }
]);

export const CLEANUP_MATRIX = Object.freeze(
  CLEANUP_MATRIX_IMPLEMENTATION.map((item) =>
    Object.freeze({
      ...item,
      status: pendingBrowserEvidenceStatus(item.status)
    })
  )
);

function pendingBrowserEvidenceStatus(status) {
  if (status === 'fully supported') return 'implemented; browser validation pending';
  if (status === 'partially supported') return 'partial implementation; browser validation pending';
  if (status === 'advanced opt-in') return 'advanced opt-in; browser validation pending';
  if (status === 'optional destructive cleanup') return 'optional destructive cleanup; browser validation pending';
  return status;
}

export const EXPERT_ONLY_CLEANUP_SETTINGS = Object.freeze([
  'includeProtectedWebOrigins',
  'storageBucketScrub',
  'embeddedFrameDiscovery',
  'probePartitionedCookiesWithEmbeddingSites',
  'exhaustiveCookieStoreScan',
  'downloadRecentFallback',
  'broadDiscoveryFallback',
  'allowLocalTargets',
  'deleteDownloadedFiles',
  'postWipeSessionBlock',
  'resetMutedTabs',
  'unpinTargetTabs',
  'opfsScrub'
]);

export function normalizeCleanupMode(value) {
  return value === 'expert' ? 'expert' : 'standard';
}

export function isExpertCleanupMode(value) {
  return normalizeCleanupMode(value) === 'expert';
}

/**
 * Applies the Standard/Expert cleanup policy and parent-child dependencies.
 * @param {Record<string, any>} settings
 * @returns {Record<string, any>}
 */
export function getEffectiveCleanupSettings(settings = {}) {
  const cleanupMode = normalizeCleanupMode(settings.cleanupMode);
  // Never execute destructive storage code in the page's MAIN world. Page code
  // can replace the web APIs that a MAIN-world script calls and falsify its
  // results. Keep the legacy setting normalized to false so existing profiles
  // cannot reactivate the retired behavior.
  /** @type {Record<string, any>} */
  const effective = {
    ...settings,
    cleanupMode,
    mainWorldPageScrub: false,
    // The review preference is mode-independent and deliberately strict: only
    // the sanitized boolean true opts into the direct cleanup path.
    skipCleanupReview: settings.skipCleanupReview === true
  };
  if (cleanupMode !== 'expert') {
    for (const key of EXPERT_ONLY_CLEANUP_SETTINGS) effective[key] = false;
    effective.associatedDomainGroups = '';
    effective.overlayScope = 'target_tabs';
  }

  // Parent-off dependencies are part of effective policy, not merely visual
  // disabling in Options. This keeps review claims and runtime behavior in
  // lockstep even for imports, migrations, stale forms, or direct storage.
  if (effective.pageScriptScrub !== true) {
    effective.storageBucketScrub = false;
    effective.opfsScrub = false;
    effective.serviceWorkerExtraScrub = false;
    effective.appBadgeClear = false;
    effective.permissionAudit = false;
  }
  if (effective.progressOverlay !== true) {
    effective.progressOverlayCancelButton = false;
    effective.overlayScope = 'target_tabs';
  }
  if (effective.postWipeSessionBlock !== true) effective.postWipeShieldExpiresMinutes = 0;
  return effective;
}

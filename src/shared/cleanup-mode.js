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
 * Applies the non-bypassable Standard/Expert safety policy.
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
  const effective = { ...settings, cleanupMode, mainWorldPageScrub: false };
  // Defense in depth for legacy profiles and imported backups: the retired
  // review-bypass field is removed even if a caller skipped storage sanitation.
  delete effective.skipCleanupReview;
  // Expert mode may expand the cleanup scope, but it never relaxes the required
  // per-run review or the background's single-use authorization checks.
  if (cleanupMode === 'expert') return effective;
  for (const key of EXPERT_ONLY_CLEANUP_SETTINGS) effective[key] = false;
  effective.associatedDomainGroups = '';
  effective.postWipeShieldExpiresMinutes = 0;
  effective.overlayScope = 'target_tabs';
  return effective;
}

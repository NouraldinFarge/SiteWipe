import { createHash } from 'node:crypto';

import { DEFAULT_SETTINGS } from '../../../src/shared/constants.js';

export const BROWSER_MATRIX_VERSION = 'sitewipe.installed-browser-matrix.v1';
export const REQUIRED_BROWSERS = Object.freeze(['brave', 'chrome']);

export const VISIBLE_SETTINGS = Object.freeze([
  'cleanupMode',
  'skipCleanupReview',
  'keepHistory',
  'reportRetentionDays',
  'latestReportRetentionMinutes',
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
  'overlayScope',
  'postWipeSessionBlock',
  'postWipeShieldExpiresMinutes',
  'autoRepairOrphanedShields',
  'resetZoom',
  'resetMutedTabs',
  'unpinTargetTabs',
  'opfsScrub',
  'serviceWorkerExtraScrub',
  'appBadgeClear',
  'permissionAudit',
  'redactReports',
  'deleteDownloadedFiles',
  'allowLocalTargets',
  'blockOnAssociatedGroupErrors',
  'associatedDomainGroups',
  'reducedMotion',
  'highContrast',
  'debugLog'
]);

export const INTERNAL_SETTINGS = Object.freeze([
  'mainWorldPageScrub',
  'stabilityDefaultsAppliedAt',
  'performanceDefaultsAppliedAt',
  'privacyDefaultsAppliedAt',
  'storagePartitionDisclosureAppliedAt',
  'createdAt',
  'updatedAt'
]);

assertSettingsInventory();

export const SETTINGS_DEFAULTS = deepFreeze(structuredClone(DEFAULT_SETTINGS));

const settingAssertions = [...VISIBLE_SETTINGS, ...INTERNAL_SETTINGS].map((key) => `setting.${key}`);

export const CANONICAL_BROWSER_MATRIX = deepFreeze([
  scenario('ART-01', 'Exact source and runtime artifact binding', [
    'source.exact_head',
    'artifact.version_manifest_hash',
    'artifact.source_runtime_parity',
    'artifact.stale_ignored_candidate_rejected'
  ]),
  scenario('SMOKE-01', 'Fresh-install safe-default smoke test', [
    'install.fresh_profile',
    'defaults.safe',
    'surfaces.popup_options_sidepanel',
    'load.no_permission_or_cleanup'
  ]),
  scenario('UPG-01', 'Pinned prior-version upgrade migration', [
    'upgrade.trusted_baseline',
    'upgrade.same_profile_and_extension_identity',
    'upgrade.settings_and_schema_migrated',
    'upgrade.no_stale_authority_or_cleanup'
  ]),
  scenario('REV-01', 'Detailed Standard and Expert review', [
    'review.standard_complete',
    'review.expert_complete',
    'review.acknowledgements_required',
    'review.cancel_no_mutation'
  ]),
  scenario('PERM-01', 'Host-permission lifecycle and preservation', [
    'host_prompt.allow',
    'host_prompt.deny',
    'host_prompt.dismiss',
    'host_prompt.timeout',
    'host_access.preexisting_exact_preserved',
    'host_access.preexisting_broad_preserved',
    'host_access.temporary_exact_released',
    'host_access.unrelated_canary_preserved'
  ]),
  scenario('WEBNAV-01', 'Optional webNavigation permission lifecycle', [
    'web_navigation.allow',
    'web_navigation.deny',
    'web_navigation.dismiss',
    'web_navigation.provenance_and_reconciliation'
  ]),
  scenario('HANDOFF-01', 'Permission handoff context and replay binding', [
    'handoff.exact_context',
    'handoff.reload_navigation_replacement_rejected',
    'handoff.replay_rejected',
    'handoff.popup_or_page_loss_fails_closed'
  ]),
  scenario('SW036-01', 'Manifest V3 action sender without document identity', [
    'sender.legitimate_action_without_document_id',
    'sender.negative_tab_and_window_ids',
    'sender.zero_multiple_malformed_context_rejected'
  ]),
  scenario('DIRECT-01', 'Saved direct-cleanup authorization', [
    'direct.default_off',
    'direct.confirm_cancel_and_accept',
    'direct.pregranted_one_activation',
    'direct.missing_access_two_activation',
    'direct.stale_or_retargeted_authority_rejected',
    'direct.report_truthful'
  ]),
  scenario('SCOPE-01', 'Registrable, associated, protected, and lookalike scope', [
    'scope.registrable_and_subdomain',
    'scope.private_suffix_siblings',
    'scope.lookalike_rejected',
    'scope.associated_targets_explicit',
    'scope.protected_and_unrelated_preserved'
  ]),
  scenario('IPV6-01', 'IPv6 cookie-removal URL construction and loopback behavior', [
    'ipv6.loopback_fixture_exact',
    'ipv6.literal_target_normalized',
    'ipv6.cookie_remove_url_bracketed_authority',
    'ipv6.cookie_remove_actual_behavior_or_explicit_limit',
    'ipv6.unrelated_state_preserved'
  ]),
  scenario('PART-01', 'Partition and exact-origin cleanup boundaries', [
    'partition.selected_top_level_cleared',
    'partition.unrelated_top_level_preserved',
    'partition.chips_out_of_domain_preserved',
    'partition.session_storage_separate',
    'exact_origin.other_port_preserved',
    'exact_origin.browser_level_skip_disclosed'
  ]),
  scenario('PRIV-01', 'Private-window scope and storage behavior', [
    'private.disabled_fails_closed',
    'private.enabled_spanning',
    'private.normal_only_never_expands',
    'private.direct_requires_preexisting_access',
    'private.report_transient'
  ]),
  scenario(
    'SETTINGS-01',
    'Every visible and internal settings contract',
    [
      ...settingAssertions,
      'settings.select_options_and_bounds',
      'settings.dependencies_and_expert_gating',
      'settings.persistence_and_reset',
      'settings.import_export',
      'settings.sensitive_confirm_cancel_and_accept',
      'settings.malformed_associated_groups'
    ],
    {
      settings: {
        visible: VISIBLE_SETTINGS,
        internal: INTERNAL_SETTINGS,
        defaults: SETTINGS_DEFAULTS
      }
    }
  ),
  scenario('DATA-01', 'Browser-data surface behavior and honest limits', [
    'data.cookies_and_chips',
    'data.storage_surfaces',
    'data.history_and_download_records',
    'data.tabs_zoom_mute_pin',
    'data.overlays_badges_and_dnr',
    'data.unavailable_reported_not_zero'
  ]),
  scenario('FILE-01', 'Owned downloaded-file deletion safety', [
    'file.default_off_preserves_bytes',
    'file.typed_confirmation_required',
    'file.only_owned_canary_removed',
    'file.identity_uncertainty_fails_closed'
  ]),
  scenario('LIFE-01', 'Worker, browser, expiry, and recovery lifecycle', [
    'lifecycle.worker_suspension_and_termination',
    'lifecycle.popup_closure',
    'lifecycle.browser_restart_same_profile',
    'lifecycle.event_outcome_orders',
    'lifecycle.late_expiry',
    'lifecycle.orphan_authority_recovered'
  ]),
  scenario('FAIL-01', 'Bounded failure and timeout behavior', [
    'failure.browser_api_partial',
    'failure.fixture_transport',
    'failure.permission_release_uncertain',
    'failure.no_false_success'
  ]),
  scenario('REPEAT-01', 'Repeated-run isolation and idempotence', [
    'repeat.ten_unique_runs',
    'repeat.no_state_accumulation',
    'repeat.no_process_or_file_leak'
  ]),
  scenario('A11Y-01', 'Rendered accessibility and keyboard behavior', [
    'accessibility.axe',
    'accessibility.keyboard_and_focus',
    'accessibility.ax_tree_and_live_regions',
    'accessibility.native_prompt_uia_tree',
    'accessibility.audible_reader_limit_explicit'
  ]),
  scenario('VIS-01', 'Browser-specific visual and reflow regression', [
    'visual.popup_and_direct_tab',
    'visual.width_and_zoom_matrix',
    'visual.forced_colors_and_reduced_motion',
    'visual.long_strings',
    'visual.actual_and_diff_retained'
  ]),
  scenario('PERF-01', 'Repeated performance distributions', [
    'performance.cold_and_warm',
    'performance.scale_matrix',
    'performance.mode_and_context_matrix',
    'performance.threshold_policy_versioned'
  ]),
  scenario('NETWORK-01', 'Loopback-only exact fixture transport', [
    'network.host_route_method_allowlist',
    'network.per_run_token',
    'network.outbound_blocked',
    'network.request_ledger_complete'
  ]),
  scenario('TEARDOWN-01', 'Owned process and workspace teardown', [
    'teardown.process_tree_exited',
    'teardown.profile_runtime_download_identity',
    'teardown.permissions_rules_jobs_leases_reconciled',
    'teardown.cleanup_or_quarantine_receipt',
    'teardown.evidence_complete'
  ])
]);

export const CANONICAL_BROWSER_MATRIX_IDS = Object.freeze(CANONICAL_BROWSER_MATRIX.map(({ id }) => id));
export const CANONICAL_BROWSER_MATRIX_SHA256 = sha256(stableJson(CANONICAL_BROWSER_MATRIX));

const expectedIds = [
  'ART-01',
  'SMOKE-01',
  'UPG-01',
  'REV-01',
  'PERM-01',
  'WEBNAV-01',
  'HANDOFF-01',
  'SW036-01',
  'DIRECT-01',
  'SCOPE-01',
  'IPV6-01',
  'PART-01',
  'PRIV-01',
  'SETTINGS-01',
  'DATA-01',
  'FILE-01',
  'LIFE-01',
  'FAIL-01',
  'REPEAT-01',
  'A11Y-01',
  'VIS-01',
  'PERF-01',
  'NETWORK-01',
  'TEARDOWN-01'
];

if (JSON.stringify(CANONICAL_BROWSER_MATRIX_IDS) !== JSON.stringify(expectedIds)) {
  throw new Error('The installed-browser matrix must retain exactly the approved 24 stable IDs in order.');
}

export function assertExactCanonicalMatrix(ids) {
  if (JSON.stringify(ids) !== JSON.stringify(CANONICAL_BROWSER_MATRIX_IDS)) {
    throw new Error('The browser-test plan does not bind the exact canonical 24-ID matrix.');
  }
  return CANONICAL_BROWSER_MATRIX_IDS;
}

export function canonicalScenario(id) {
  const entry = CANONICAL_BROWSER_MATRIX.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Unknown canonical installed-browser scenario: ${String(id)}.`);
  return entry;
}

function scenario(id, title, requiredAssertions, extra = {}) {
  if (!/^[A-Z0-9]+-01$/.test(id) || typeof title !== 'string' || !title.trim()) {
    throw new Error('Canonical installed-browser scenarios require a stable ID and title.');
  }
  if (
    !Array.isArray(requiredAssertions) ||
    !requiredAssertions.length ||
    requiredAssertions.some((value) => typeof value !== 'string' || !value.trim()) ||
    new Set(requiredAssertions).size !== requiredAssertions.length
  ) {
    throw new Error(`Canonical scenario ${id} has an invalid assertion inventory.`);
  }
  return { id, title, requiredBrowsers: REQUIRED_BROWSERS, requiredAssertions, ...extra };
}

function assertSettingsInventory() {
  if (VISIBLE_SETTINGS.length !== 37 || INTERNAL_SETTINGS.length !== 7) {
    throw new Error('The canonical settings contract must classify exactly 37 visible and 7 internal settings.');
  }
  const categorized = [...VISIBLE_SETTINGS, ...INTERNAL_SETTINGS].sort();
  const production = Object.keys(DEFAULT_SETTINGS).sort();
  if (new Set(categorized).size !== categorized.length || JSON.stringify(categorized) !== JSON.stringify(production)) {
    throw new Error('The canonical settings contract no longer matches every production DEFAULT_SETTINGS key.');
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

import { createHash } from 'node:crypto';

import {
  BROWSER_MATRIX_VERSION,
  CANONICAL_BROWSER_MATRIX,
  CANONICAL_BROWSER_MATRIX_SHA256,
  INTERNAL_SETTINGS,
  REQUIRED_BROWSERS,
  SETTINGS_DEFAULTS,
  VISIBLE_SETTINGS,
  canonicalScenario
} from './canonical-matrix.mjs';
import { FIXTURE_ALLOWED_METHODS, FIXTURE_ALLOWED_ROUTES, SYNTHETIC_FIXTURE_HOSTS } from '../fixture-server.mjs';
import { PINNED_PUPPETEER_CORE_VERSION } from './toolchain-closure.mjs';
import {
  EXACT_ORIGIN_BROWSER_STORAGE_LIMITATION,
  SELECTED_SITE_PARTITION_STORAGE_DISCLOSURE
} from '../../../src/shared/storage-partition-policy.js';

export const SEMANTIC_VALIDATOR_MANIFEST_SCHEMA = 'sitewipe.installed-browser-semantic-validator-manifest.v1';
export const SEMANTIC_OBSERVATION_SCHEMA = 'sitewipe.installed-browser-semantic-observation.v1';
export const SEMANTIC_OBSERVATION_MEDIA_TYPE = 'application/vnd.sitewipe.semantic-observation+json';
export const SEMANTIC_RAW_EVIDENCE_SCHEMA = 'sitewipe.installed-browser-raw-evidence.v1';
export const SEMANTIC_VALIDATOR_IMPLEMENTATION_STATES = Object.freeze(['implemented', 'not_implemented']);

const MAX_OBSERVATION_BYTES = 256 * 1024;
const MAX_OBSERVATION_BASE64_CHARACTERS = Math.ceil(MAX_OBSERVATION_BYTES / 3) * 4;
const SMOKE_MINIMUM_SEEDED_FIXTURE_ENTRIES = 24;
const SMOKE_MINIMUM_SEEDED_STORAGE_KINDS = 3;
const FIXED_FIXTURE_BIND_ADDRESSES = Object.freeze(['127.0.0.1', '::1']);
const REVIEWED_EXAMPLE_PERMISSION_PATTERNS = Object.freeze([
  'http://*.example.com/*',
  'http://example.com/*',
  'https://*.example.com/*',
  'https://example.com/*'
]);
const ALLOWED_URL_LIKE_STRINGS = new Set(REVIEWED_EXAMPLE_PERMISSION_PATTERNS);
const IDENTITY_KEYS = Object.freeze([
  'artifactBytes',
  'artifactSha256',
  'artifactVersion',
  'browserRuntimeSetSha256',
  'gitExecutableSha256',
  'harnessManifestSha256',
  'launchPolicySha256',
  'nativeHelperSha256',
  'nodeExecutableSha256',
  'nodeRuntimeVersion',
  'packageLockSha256',
  'powerShellExecutableSha256',
  'processObserverHelperSha256',
  'releaseInputFingerprintSha256',
  'runtimeFingerprintSha256',
  'sourceCommitSha',
  'sourceTreeSha',
  'toolchainBytes',
  'toolchainFileCount',
  'toolchainPackageCount',
  'toolchainPuppeteerVersion',
  'toolchainSetSha256'
]);
const OBSERVATION_KEYS = Object.freeze([
  'assertionId',
  'browser',
  'capturedAt',
  'identity',
  'kind',
  'matrixSha256',
  'matrixVersion',
  'observationId',
  'payload',
  'payloadSchema',
  'planSha256',
  'runId',
  'scenarioId',
  'schema',
  'sequence',
  'source',
  'validatorManifestSha256'
]);
const RAW_EVIDENCE_KEYS = Object.freeze(['bytes', 'contentBase64', 'id', 'mediaType', 'schema', 'sha256']);

const REVIEW_STANDARD_DISPLAY_KEYS = Object.freeze([
  'attempted',
  'effects',
  'hostPermissions',
  'normalizedTarget',
  'protected',
  'scope',
  'unavailable',
  'warnings',
  'windowScope'
]);
const REVIEW_EXPERT_DISPLAY_KEYS = Object.freeze([
  'associatedTargets',
  'attempted',
  'downloadedFiles',
  'effects',
  'hostPermissions',
  'localTarget',
  'normalizedTarget',
  'privateScope',
  'protectedOrigins',
  'requestShield',
  'scope',
  'storageBoundary',
  'unavailable',
  'warnings'
]);

const SETTINGS_SELECT_OPTIONS = deepFreeze({
  cleanupMode: ['standard', 'expert'],
  reportRetentionDays: ['1', '7', '30', '90', '0'],
  latestReportRetentionMinutes: ['15', '30', '60', '240', '1440', '0'],
  overlayScope: ['target_tabs', 'current_window', 'all_tabs'],
  postWipeShieldExpiresMinutes: ['0', '15', '60', '240', '1440']
});
const SETTINGS_EXERCISE_VALUES = deepFreeze({
  cleanupMode: 'expert',
  skipCleanupReview: true,
  keepHistory: true,
  reportRetentionDays: 30,
  latestReportRetentionMinutes: 0,
  aggressiveCookieSweep: false,
  includeProtectedWebOrigins: true,
  pageScriptScrub: false,
  storageBucketScrub: true,
  embeddedFrameDiscovery: true,
  probePartitionedCookiesWithEmbeddingSites: true,
  exhaustiveCookieStoreScan: true,
  downloadRecentFallback: true,
  broadDiscoveryFallback: true,
  verificationPass: false,
  temporaryDnrShield: false,
  progressOverlay: false,
  progressOverlayCancelButton: false,
  overlayScope: 'all_tabs',
  postWipeSessionBlock: true,
  postWipeShieldExpiresMinutes: 60,
  autoRepairOrphanedShields: false,
  resetZoom: false,
  resetMutedTabs: true,
  unpinTargetTabs: true,
  opfsScrub: false,
  serviceWorkerExtraScrub: false,
  appBadgeClear: false,
  permissionAudit: false,
  redactReports: false,
  deleteDownloadedFiles: true,
  allowLocalTargets: true,
  blockOnAssociatedGroupErrors: false,
  associatedDomainGroups: 'example.com => cdn.example.com, login.example.com',
  reducedMotion: true,
  highContrast: true,
  debugLog: true
});
const SETTINGS_EXPERT_CONTROL_IDS = Object.freeze([
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
const SETTINGS_INITIAL_DISABLED_IDS = Object.freeze([...SETTINGS_EXPERT_CONTROL_IDS, 'reportRetentionDays']);
const SETTINGS_DEPENDENCY_GROUPS = deepFreeze({
  keepHistory: ['reportRetentionDays'],
  pageScriptScrub: ['storageBucketScrub', 'opfsScrub', 'serviceWorkerExtraScrub', 'appBadgeClear', 'permissionAudit'],
  progressOverlay: ['progressOverlayCancelButton', 'overlayScope'],
  postWipeSessionBlock: ['postWipeShieldExpiresMinutes']
});
const SETTINGS_TIMESTAMP_KEYS = new Set([
  'createdAt',
  'updatedAt',
  'stabilityDefaultsAppliedAt',
  'performanceDefaultsAppliedAt',
  'privacyDefaultsAppliedAt',
  'storagePartitionDisclosureAppliedAt'
]);
const SETTINGS_MIGRATION_TIMESTAMP_KEYS = new Set([
  'stabilityDefaultsAppliedAt',
  'performanceDefaultsAppliedAt',
  'privacyDefaultsAppliedAt',
  'storagePartitionDisclosureAppliedAt'
]);
const SETTINGS_REQUIRED_EXTENSION_PERMISSIONS = Object.freeze(
  [
    'alarms',
    'browsingData',
    'cookies',
    'declarativeNetRequest',
    'downloads',
    'history',
    'scripting',
    'sidePanel',
    'storage',
    'tabs'
  ].sort()
);

export const SETTINGS_SEMANTIC_CONTRACT = deepFreeze({
  visibleSettings: [...VISIBLE_SETTINGS],
  internalSettings: [...INTERNAL_SETTINGS],
  exerciseValues: structuredClone(SETTINGS_EXERCISE_VALUES),
  selectOptions: structuredClone(SETTINGS_SELECT_OPTIONS),
  expertControlIds: [...SETTINGS_EXPERT_CONTROL_IDS],
  initialDisabledIds: [...SETTINGS_INITIAL_DISABLED_IDS],
  dependencyGroups: structuredClone(SETTINGS_DEPENDENCY_GROUPS)
});

const IMPLEMENTED = new Map([
  implemented(
    'ART-01',
    'source.exact_head',
    'artifact.source-head.v1',
    'artifact.source-head.v1',
    'coordinator',
    validateExactHead
  ),
  implemented(
    'ART-01',
    'artifact.version_manifest_hash',
    'artifact.version-manifest.v1',
    'artifact.version-manifest.v1',
    'artifact_verifier',
    validateArtifactVersionManifest
  ),
  implemented(
    'ART-01',
    'artifact.source_runtime_parity',
    'artifact.source-runtime-parity.v1',
    'artifact.source-runtime-parity.v1',
    'artifact_verifier',
    validateSourceRuntimeParity
  ),
  implemented(
    'ART-01',
    'artifact.stale_ignored_candidate_rejected',
    'artifact.noncanonical-rejection.v1',
    'artifact.noncanonical-rejection.v1',
    'artifact_verifier',
    validateNoncanonicalCandidateRejection
  ),
  implemented(
    'SMOKE-01',
    'install.fresh_profile',
    'smoke.fresh-profile.v1',
    'smoke.fresh-profile.v1',
    'installed_browser',
    validateFreshProfile
  ),
  implemented(
    'SMOKE-01',
    'defaults.safe',
    'smoke.safe-defaults.v1',
    'smoke.safe-defaults.v1',
    'installed_browser',
    validateSafeDefaults
  ),
  implemented(
    'SMOKE-01',
    'surfaces.popup_options_sidepanel',
    'smoke.installed-surfaces.v1',
    'smoke.installed-surfaces.v1',
    'installed_browser',
    validateInstalledSurfaces
  ),
  implemented(
    'SMOKE-01',
    'load.no_permission_or_cleanup',
    'smoke.no-authority-or-mutation.v4',
    'smoke.no-authority-or-mutation.v4',
    'installed_browser',
    validateNoAuthorityOrMutation,
    4
  ),
  implemented(
    'REV-01',
    'review.standard_complete',
    'review.standard.v1',
    'review.standard.v1',
    'installed_browser',
    validateStandardReview
  ),
  implemented(
    'REV-01',
    'review.expert_complete',
    'review.expert.v1',
    'review.expert.v1',
    'installed_browser',
    validateExpertReview
  ),
  implemented(
    'REV-01',
    'review.acknowledgements_required',
    'review.acknowledgements.v1',
    'review.acknowledgements.v1',
    'installed_browser',
    validateReviewAcknowledgements
  ),
  implemented(
    'REV-01',
    'review.cancel_no_mutation',
    'review.cancel-no-mutation.v1',
    'review.cancel-no-mutation.v1',
    'installed_browser',
    validateReviewCancel
  ),
  implemented(
    'SW036-01',
    'sender.legitimate_action_without_document_id',
    'sender.action-without-document-id.v1',
    'sender.action-without-document-id.v1',
    'installed_browser',
    validateLegitimateActionSender
  ),
  ...settingsImplementedEntries(),
  implemented(
    'NETWORK-01',
    'network.host_route_method_allowlist',
    'network.allowlist.v1',
    'network.allowlist.v1',
    'transport_monitor',
    validateNetworkAllowlist
  ),
  implemented(
    'NETWORK-01',
    'network.per_run_token',
    'network.per-run-secret.v1',
    'network.per-run-secret.v1',
    'transport_monitor',
    validatePerRunSecret
  ),
  implemented(
    'NETWORK-01',
    'network.outbound_blocked',
    'network.outbound-block.v1',
    'network.outbound-block.v1',
    'transport_monitor',
    validateOutboundBlock
  ),
  implemented(
    'NETWORK-01',
    'network.request_ledger_complete',
    'network.ledger-reconciliation.v1',
    'network.ledger-reconciliation.v1',
    'transport_monitor',
    validateNetworkLedger
  ),
  implemented(
    'TEARDOWN-01',
    'teardown.process_tree_exited',
    'teardown.process-tree.v1',
    'teardown.process-tree.v1',
    'teardown_coordinator',
    validateProcessTreeExited
  ),
  implemented(
    'TEARDOWN-01',
    'teardown.profile_runtime_download_identity',
    'teardown.owned-identities.v1',
    'teardown.owned-identities.v1',
    'teardown_coordinator',
    validateOwnedIdentities
  ),
  implemented(
    'TEARDOWN-01',
    'teardown.permissions_rules_jobs_leases_reconciled',
    'teardown.reconciliation.v1',
    'teardown.reconciliation.v1',
    'teardown_coordinator',
    validateTeardownReconciliation
  ),
  implemented(
    'TEARDOWN-01',
    'teardown.cleanup_or_quarantine_receipt',
    'teardown.receipt.v1',
    'teardown.receipt.v1',
    'teardown_coordinator',
    validateTeardownReceipt
  ),
  implemented(
    'TEARDOWN-01',
    'teardown.evidence_complete',
    'teardown.evidence-completeness.v1',
    'teardown.evidence-completeness.v1',
    'teardown_coordinator',
    validateEvidenceCompleteness
  )
]);

assertImplementedInventory();

const manifestEntries = [];
const registry = new Map();
for (const scenario of CANONICAL_BROWSER_MATRIX) {
  for (const assertionId of scenario.requiredAssertions) {
    const key = registryKey(scenario.id, assertionId);
    const config = IMPLEMENTED.get(key) || notImplemented(scenario.id, assertionId);
    registry.set(key, config);
    manifestEntries.push({
      scenarioId: scenario.id,
      assertionId,
      status: config.status,
      validatorId: config.validatorId,
      validatorVersion: config.validatorVersion,
      observationKind: config.kind,
      payloadSchema: config.payloadSchema,
      source: config.source
    });
  }
}

export const SEMANTIC_VALIDATOR_MANIFEST = deepFreeze({
  schema: SEMANTIC_VALIDATOR_MANIFEST_SCHEMA,
  version: 1,
  matrixVersion: BROWSER_MATRIX_VERSION,
  matrixSha256: CANONICAL_BROWSER_MATRIX_SHA256,
  entries: manifestEntries
});
export const SEMANTIC_VALIDATOR_MANIFEST_SHA256 = sha256(canonicalJsonBytes(SEMANTIC_VALIDATOR_MANIFEST));

export function semanticValidatorEntry(scenarioId, assertionId) {
  canonicalScenario(scenarioId);
  const entry = SEMANTIC_VALIDATOR_MANIFEST.entries.find(
    (candidate) => candidate.scenarioId === scenarioId && candidate.assertionId === assertionId
  );
  if (!entry) throw new Error(`Unknown canonical semantic assertion: ${scenarioId}/${assertionId}.`);
  return entry;
}

export function semanticScenarioImplementationStatus(scenarioId) {
  const scenario = canonicalScenario(scenarioId);
  const statuses = scenario.requiredAssertions.map(
    (assertionId) => semanticValidatorEntry(scenarioId, assertionId).status
  );
  if (statuses.every((status) => status === 'implemented')) return 'implemented';
  if (statuses.every((status) => status === 'not_implemented')) return 'not_implemented';
  return 'partial';
}

export function semanticBindingFromScenarioResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Semantic replay requires one installed-browser scenario result object.');
  }
  const scenario = canonicalScenario(result.scenarioId);
  const binding = {
    scenarioId: scenario.id,
    browser: pathFreeBrowserIdentity(result.browser),
    runId: result.runId,
    planSha256: result.planSha256,
    identity: structuredClone(result.identity),
    startedAt: result.startedAt,
    completedAt: result.completedAt
  };
  validateBinding(binding);
  return deepFreeze(binding);
}

export function createSemanticObservation({ binding, assertionId, observationId, payload, capturedAt, sequence = 0 }) {
  validateBinding(binding);
  const config = implementedConfig(binding.scenarioId, assertionId);
  const observation = {
    schema: SEMANTIC_OBSERVATION_SCHEMA,
    matrixVersion: BROWSER_MATRIX_VERSION,
    matrixSha256: CANONICAL_BROWSER_MATRIX_SHA256,
    validatorManifestSha256: SEMANTIC_VALIDATOR_MANIFEST_SHA256,
    runId: binding.runId,
    planSha256: binding.planSha256,
    scenarioId: binding.scenarioId,
    assertionId,
    observationId,
    sequence,
    capturedAt,
    browser: structuredClone(binding.browser),
    identity: structuredClone(binding.identity),
    kind: config.kind,
    payloadSchema: config.payloadSchema,
    source: config.source,
    payload: structuredClone(payload)
  };
  validateSemanticObservation(observation, { binding, expectedEvidenceId: observationId });
  return deepFreeze(observation);
}

export function createSemanticObservationEvidence(options) {
  const observation = createSemanticObservation(options);
  const bytes = canonicalJsonBytes(observation);
  return deepFreeze({
    schema: SEMANTIC_RAW_EVIDENCE_SCHEMA,
    id: observation.observationId,
    mediaType: SEMANTIC_OBSERVATION_MEDIA_TYPE,
    bytes: bytes.length,
    sha256: sha256(bytes),
    contentBase64: bytes.toString('base64')
  });
}

export function decodeSemanticObservationEvidence(rawEvidence, { binding }) {
  assertExactKeys(rawEvidence, RAW_EVIDENCE_KEYS, 'Semantic raw evidence');
  if (
    rawEvidence.schema !== SEMANTIC_RAW_EVIDENCE_SCHEMA ||
    rawEvidence.mediaType !== SEMANTIC_OBSERVATION_MEDIA_TYPE ||
    !isStableId(rawEvidence.id) ||
    !Number.isInteger(rawEvidence.bytes) ||
    rawEvidence.bytes <= 0 ||
    rawEvidence.bytes > MAX_OBSERVATION_BYTES ||
    !isSha256(rawEvidence.sha256) ||
    typeof rawEvidence.contentBase64 !== 'string' ||
    rawEvidence.contentBase64.length > MAX_OBSERVATION_BASE64_CHARACTERS
  ) {
    throw new Error('Semantic raw evidence wrapper is malformed or outside its bounded size.');
  }
  const bytes = decodeExactBase64(rawEvidence.contentBase64);
  if (bytes.length !== rawEvidence.bytes || sha256(bytes) !== rawEvidence.sha256) {
    throw new Error('Semantic raw evidence bytes or SHA-256 changed.');
  }
  let observation;
  try {
    observation = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error('Semantic raw evidence is not exact UTF-8 JSON.', { cause: error });
  }
  if (!bytes.equals(canonicalJsonBytes(observation))) {
    throw new Error('Semantic raw evidence is not canonical JSON.');
  }
  validateSemanticObservation(observation, { binding, expectedEvidenceId: rawEvidence.id });
  return deepFreeze(observation);
}

export function validateSemanticObservation(observation, { binding, expectedEvidenceId = null }) {
  validateBinding(binding);
  assertExactKeys(observation, OBSERVATION_KEYS, 'Semantic observation');
  if (
    observation.schema !== SEMANTIC_OBSERVATION_SCHEMA ||
    observation.matrixVersion !== BROWSER_MATRIX_VERSION ||
    observation.matrixSha256 !== CANONICAL_BROWSER_MATRIX_SHA256 ||
    observation.validatorManifestSha256 !== SEMANTIC_VALIDATOR_MANIFEST_SHA256 ||
    observation.runId !== binding.runId ||
    observation.planSha256 !== binding.planSha256 ||
    observation.scenarioId !== binding.scenarioId ||
    !isStableId(observation.observationId) ||
    (expectedEvidenceId !== null && observation.observationId !== expectedEvidenceId) ||
    !Number.isInteger(observation.sequence) ||
    observation.sequence < 0
  ) {
    throw new Error('Semantic observation is not bound to the exact matrix, validator, run, plan, or evidence ID.');
  }
  assertIsoTimestamp(observation.capturedAt, 'Semantic observation capturedAt');
  if (
    Date.parse(observation.capturedAt) < Date.parse(binding.startedAt) ||
    Date.parse(observation.capturedAt) > Date.parse(binding.completedAt)
  ) {
    throw new Error('Semantic observation timestamp falls outside its scenario execution interval.');
  }
  if (stableJson(observation.browser) !== stableJson(binding.browser)) {
    throw new Error('Semantic observation browser identity crosses its scenario boundary.');
  }
  validateIdentity(observation.identity);
  if (stableJson(observation.identity) !== stableJson(binding.identity)) {
    throw new Error('Semantic observation source/artifact identity crosses its scenario boundary.');
  }
  const config = implementedConfig(observation.scenarioId, observation.assertionId);
  if (
    observation.kind !== config.kind ||
    observation.payloadSchema !== config.payloadSchema ||
    observation.source !== config.source
  ) {
    throw new Error('Semantic observation kind, payload schema, or source differs from its canonical validator.');
  }
  assertPathFreePrivateSafeValue(observation.payload, 'payload');
  config.validate(observation.payload, binding);
  return observation;
}

export function deriveSemanticScenarioAssertions({ result, evidence = result?.evidence }) {
  const binding = semanticBindingFromScenarioResult(result);
  if (!Array.isArray(evidence)) throw new Error('Semantic replay evidence must be an array.');
  const observations = evidence
    .filter((entry) => entry?.mediaType === SEMANTIC_OBSERVATION_MEDIA_TYPE)
    .map((entry) => ({ evidenceId: entry.id, value: decodeSemanticObservationEvidence(entry, { binding }) }));
  const scenario = canonicalScenario(binding.scenarioId);
  const assertions = scenario.requiredAssertions.map((assertionId) => {
    const config = registry.get(registryKey(scenario.id, assertionId));
    if (config.status === 'not_implemented') {
      return {
        id: assertionId,
        state: 'not_run',
        evidenceIds: [],
        detail: 'The canonical semantic validator for this assertion is explicitly not implemented.',
        validatorId: null
      };
    }
    const matches = observations.filter(({ value }) => value.assertionId === assertionId);
    if (matches.length === 0) {
      return {
        id: assertionId,
        state: 'not_run',
        evidenceIds: [],
        detail: 'No exact typed semantic observation was retained.',
        validatorId: config.validatorId
      };
    }
    if (matches.length !== 1) {
      return {
        id: assertionId,
        state: 'failed',
        evidenceIds: matches.map(({ evidenceId }) => evidenceId),
        detail: `Expected exactly one typed semantic observation; observed ${matches.length}.`,
        validatorId: config.validatorId
      };
    }
    const [{ evidenceId, value }] = matches;
    const passed = config.validate(value.payload, binding) === true;
    return {
      id: assertionId,
      state: passed ? 'passed' : 'failed',
      evidenceIds: [evidenceId],
      detail: passed
        ? 'Passed by mechanical replay of the exact typed observation.'
        : 'The exact typed observation did not satisfy the canonical semantic predicate.',
      validatorId: config.validatorId
    };
  });
  return deepFreeze({
    scenarioId: scenario.id,
    implementationStatus: semanticScenarioImplementationStatus(scenario.id),
    manifestSha256: SEMANTIC_VALIDATOR_MANIFEST_SHA256,
    state: aggregateAssertionStates(assertions.map(({ state }) => state)),
    assertions
  });
}

export function deriveSemanticAssertion({ result, evidence = result?.evidence, assertionId }) {
  const derived = deriveSemanticScenarioAssertions({ result, evidence });
  const assertion = derived.assertions.find((entry) => entry.id === assertionId);
  if (!assertion) throw new Error(`Unknown assertion for ${derived.scenarioId}: ${assertionId}.`);
  return assertion;
}

function implemented(scenarioId, assertionId, kind, payloadSchema, source, validate, validatorVersion = 1) {
  if (!Number.isInteger(validatorVersion) || validatorVersion < 1) {
    throw new Error('Implemented semantic validator version must be a positive integer.');
  }
  return [
    registryKey(scenarioId, assertionId),
    Object.freeze({
      scenarioId,
      assertionId,
      status: 'implemented',
      validatorId: `sitewipe.semantic.${scenarioId.toLowerCase()}.${assertionId}.v${validatorVersion}`,
      validatorVersion,
      kind,
      payloadSchema,
      source,
      validate
    })
  ];
}

function notImplemented(scenarioId, assertionId) {
  return Object.freeze({
    scenarioId,
    assertionId,
    status: 'not_implemented',
    validatorId: null,
    validatorVersion: 0,
    kind: null,
    payloadSchema: null,
    source: null,
    validate: null
  });
}

function implementedConfig(scenarioId, assertionId) {
  const config = registry.get(registryKey(scenarioId, assertionId));
  if (!config) throw new Error(`Unknown canonical semantic assertion: ${scenarioId}/${assertionId}.`);
  if (config.status !== 'implemented') {
    throw new Error(`The canonical semantic validator is explicitly not implemented: ${scenarioId}/${assertionId}.`);
  }
  return config;
}

function settingsImplementedEntries() {
  return [
    ...VISIBLE_SETTINGS.map((key) =>
      implemented(
        'SETTINGS-01',
        `setting.${key}`,
        'settings.visible-setting.v2',
        'settings.visible-setting.v2',
        'installed_options',
        (value) => validateVisibleSetting(value, key),
        2
      )
    ),
    ...INTERNAL_SETTINGS.map((key) =>
      implemented(
        'SETTINGS-01',
        `setting.${key}`,
        'settings.internal-setting.v1',
        'settings.internal-setting.v1',
        'installed_options',
        (value) => validateInternalSetting(value, key)
      )
    ),
    implemented(
      'SETTINGS-01',
      'settings.select_options_and_bounds',
      'settings.select-options-bounds.v1',
      'settings.select-options-bounds.v1',
      'installed_options',
      validateSettingsSelectOptionsAndBounds
    ),
    implemented(
      'SETTINGS-01',
      'settings.dependencies_and_expert_gating',
      'settings.dependencies-expert-gating.v3',
      'settings.dependencies-expert-gating.v3',
      'installed_options',
      validateSettingsDependenciesAndExpertGating,
      3
    ),
    implemented(
      'SETTINGS-01',
      'settings.persistence_and_reset',
      'settings.persistence-reset.v3',
      'settings.persistence-reset.v3',
      'installed_options',
      validateSettingsPersistenceAndReset,
      3
    ),
    implemented(
      'SETTINGS-01',
      'settings.import_export',
      'settings.import-export.v3',
      'settings.import-export.v3',
      'installed_options',
      validateSettingsImportExport,
      3
    ),
    implemented(
      'SETTINGS-01',
      'settings.sensitive_confirm_cancel_and_accept',
      'settings.sensitive-confirmations.v3',
      'settings.sensitive-confirmations.v3',
      'installed_options',
      validateSettingsSensitiveConfirmations,
      3
    ),
    implemented(
      'SETTINGS-01',
      'settings.malformed_associated_groups',
      'settings.malformed-associated-groups.v3',
      'settings.malformed-associated-groups.v3',
      'installed_options',
      validateSettingsMalformedAssociatedGroups,
      3
    )
  ];
}

function validateVisibleSetting(value, expectedKey) {
  assertExactKeys(
    value,
    ['classification', 'control', 'exercise', 'initialValue', 'key', 'productionDefault', 'resetValue'],
    'Visible-setting payload'
  );
  if (value.classification !== 'visible' || value.key !== expectedKey) return false;
  const expectedDefault = SETTINGS_DEFAULTS[expectedKey];
  if (
    stableJson(value.productionDefault) !== stableJson(expectedDefault) ||
    stableJson(value.initialValue) !== stableJson(expectedDefault) ||
    stableJson(value.resetValue) !== stableJson(expectedDefault)
  ) {
    return false;
  }
  assertExactKeys(
    value.control,
    [
      'ariaDescribedByBound',
      'ariaLabelledByBound',
      'initialEnabled',
      'inputType',
      'optionValues',
      'present',
      'tagName'
    ],
    'Visible-setting control payload'
  );
  assertBooleans(
    value.control,
    ['ariaDescribedByBound', 'ariaLabelledByBound', 'initialEnabled', 'present'],
    'Visible-setting control payload'
  );
  assertExactStringArray(value.control.optionValues, 'Visible-setting option values');
  const isSelect = Object.hasOwn(SETTINGS_SELECT_OPTIONS, expectedKey);
  const isTextarea = expectedKey === 'associatedDomainGroups';
  const expectedTag = isSelect ? 'SELECT' : isTextarea ? 'TEXTAREA' : 'INPUT';
  const expectedType = isSelect ? 'select-one' : isTextarea ? 'textarea' : 'checkbox';
  if (
    value.control.present !== true ||
    value.control.tagName !== expectedTag ||
    value.control.inputType !== expectedType ||
    value.control.ariaLabelledByBound !== true ||
    value.control.ariaDescribedByBound !== true ||
    value.control.initialEnabled !== !SETTINGS_INITIAL_DISABLED_IDS.includes(expectedKey) ||
    !exactArray(value.control.optionValues, SETTINGS_SELECT_OPTIONS[expectedKey] || [])
  ) {
    return false;
  }
  assertExactKeys(
    value.exercise,
    ['attemptedValue', 'observedAfterSave', 'persistedAfterReload', 'saveOutcome', 'storageRoundTripObserved'],
    'Visible-setting exercise payload'
  );
  assertBooleans(value.exercise, ['storageRoundTripObserved'], 'Visible-setting exercise payload');
  const attempted = SETTINGS_EXERCISE_VALUES[expectedKey];
  const expectedObserved = expectedKey === 'embeddedFrameDiscovery' ? false : attempted;
  const expectedOutcome = expectedKey === 'embeddedFrameDiscovery' ? 'remained_off' : 'saved';
  return (
    stableJson(value.exercise.attemptedValue) === stableJson(attempted) &&
    stableJson(value.exercise.observedAfterSave) === stableJson(expectedObserved) &&
    stableJson(value.exercise.persistedAfterReload) === stableJson(expectedObserved) &&
    value.exercise.saveOutcome === expectedOutcome &&
    value.exercise.storageRoundTripObserved === true
  );
}

function validateInternalSetting(value, expectedKey) {
  assertExactKeys(
    value,
    [
      'afterExerciseState',
      'classification',
      'controlAbsent',
      'initialState',
      'key',
      'preservedAcrossVisibleSaves',
      'productionDefault',
      'resetState',
      'resetValueChanged'
    ],
    'Internal-setting payload'
  );
  assertBooleans(
    value,
    ['controlAbsent', 'preservedAcrossVisibleSaves', 'resetValueChanged'],
    'Internal-setting payload'
  );
  if (
    value.classification !== 'internal' ||
    value.key !== expectedKey ||
    value.controlAbsent !== true ||
    stableJson(value.productionDefault) !== stableJson(SETTINGS_DEFAULTS[expectedKey])
  ) {
    return false;
  }
  if (expectedKey === 'mainWorldPageScrub') {
    return (
      value.initialState === 'false' &&
      value.afterExerciseState === 'false' &&
      value.resetState === 'false' &&
      value.preservedAcrossVisibleSaves === true &&
      value.resetValueChanged === false
    );
  }
  if (!SETTINGS_TIMESTAMP_KEYS.has(expectedKey)) return false;
  if (value.initialState !== 'timestamp' || value.afterExerciseState !== 'timestamp') return false;
  if (value.preservedAcrossVisibleSaves !== (expectedKey !== 'updatedAt') || value.resetValueChanged !== true) {
    return false;
  }
  if (SETTINGS_MIGRATION_TIMESTAMP_KEYS.has(expectedKey)) {
    return value.resetState === 'null' || value.resetState === 'timestamp';
  }
  return value.resetState === 'timestamp';
}

function validateSettingsSelectOptionsAndBounds(value) {
  assertExactKeys(
    value,
    ['controls', 'invalidPatchResult', 'productionDefaultsMatched'],
    'Settings select/bounds payload'
  );
  assertBooleans(value, ['productionDefaultsMatched'], 'Settings select/bounds payload');
  if (!Array.isArray(value.controls) || value.controls.length !== Object.keys(SETTINGS_SELECT_OPTIONS).length) {
    throw new Error('Settings select/bounds payload requires every exact select control.');
  }
  const expectedControls = Object.entries(SETTINGS_SELECT_OPTIONS).map(([id, optionValues]) => ({ id, optionValues }));
  for (const control of value.controls) {
    assertExactKeys(control, ['id', 'optionValues'], 'Settings select control');
    assertExactStringArray(control.optionValues, 'Settings select option values');
  }
  assertExactKeys(
    value.invalidPatchResult,
    [
      'cleanupMode',
      'latestReportRetentionMinutes',
      'overlayScope',
      'postWipeShieldExpiresMinutes',
      'reportRetentionDays'
    ],
    'Settings invalid-patch result'
  );
  return (
    stableJson(value.controls) === stableJson(expectedControls) &&
    value.productionDefaultsMatched === true &&
    stableJson(value.invalidPatchResult) ===
      stableJson({
        cleanupMode: 'standard',
        latestReportRetentionMinutes: 30,
        overlayScope: 'target_tabs',
        postWipeShieldExpiresMinutes: 0,
        reportRetentionDays: 7
      })
  );
}

function validateSettingsDependenciesAndExpertGating(value) {
  assertExactKeys(
    value,
    [
      'expertEnabledControlIds',
      'parentOffDisabledControlIds',
      'safetyBoundary',
      'standardDisabledControlIds',
      'standardForcedValues'
    ],
    'Settings dependencies/gating payload'
  );
  assertExactStringArray(value.expertEnabledControlIds, 'Expert-enabled setting controls');
  assertExactStringArray(value.standardDisabledControlIds, 'Standard-disabled setting controls');
  assertExactKeys(
    value.parentOffDisabledControlIds,
    Object.keys(SETTINGS_DEPENDENCY_GROUPS),
    'Parent-off dependency observations'
  );
  for (const [parent, expectedChildren] of Object.entries(SETTINGS_DEPENDENCY_GROUPS)) {
    assertExactStringArray(value.parentOffDisabledControlIds[parent], `Dependency children for ${parent}`);
    if (!exactArray(value.parentOffDisabledControlIds[parent], expectedChildren)) return false;
  }
  assertExactKeys(value.standardForcedValues, ['embeddedFrameDiscovery', 'overlayScope'], 'Standard forced values');
  return (
    exactArray(value.standardDisabledControlIds, SETTINGS_EXPERT_CONTROL_IDS) &&
    exactArray(value.expertEnabledControlIds, SETTINGS_EXPERT_CONTROL_IDS) &&
    value.standardForcedValues.embeddedFrameDiscovery === false &&
    value.standardForcedValues.overlayScope === 'target_tabs' &&
    validateSettingsSafetyBoundary(value.safetyBoundary)
  );
}

function validateSettingsPersistenceAndReset(value) {
  assertExactKeys(
    value,
    [
      'exercisedVisibleSettingCount',
      'internalSettingCount',
      'persistedVisibleSettingCount',
      'reloadRenderedVisibleSettingCount',
      'resetAcceptRestoredSettingCount',
      'resetCancelPreserved',
      'safetyBoundary',
      'visibleSettingCount'
    ],
    'Settings persistence/reset payload'
  );
  assertNonNegativeIntegers(
    value,
    [
      'exercisedVisibleSettingCount',
      'internalSettingCount',
      'persistedVisibleSettingCount',
      'reloadRenderedVisibleSettingCount',
      'resetAcceptRestoredSettingCount',
      'visibleSettingCount'
    ],
    'Settings persistence/reset payload'
  );
  assertBooleans(value, ['resetCancelPreserved'], 'Settings persistence/reset payload');
  return (
    value.visibleSettingCount === VISIBLE_SETTINGS.length &&
    value.internalSettingCount === INTERNAL_SETTINGS.length &&
    value.exercisedVisibleSettingCount === VISIBLE_SETTINGS.length &&
    value.persistedVisibleSettingCount === VISIBLE_SETTINGS.length &&
    value.reloadRenderedVisibleSettingCount === VISIBLE_SETTINGS.length &&
    value.resetAcceptRestoredSettingCount === VISIBLE_SETTINGS.length + INTERNAL_SETTINGS.length &&
    value.resetCancelPreserved === true &&
    validateSettingsSafetyBoundary(value.safetyBoundary)
  );
}

function validateSettingsImportExport(value, binding) {
  assertExactKeys(
    value,
    [
      'exportBytes',
      'downloadSafety',
      'exportDownloadEntryCountAdded',
      'exportSchema',
      'exportSchemaVersion',
      'exportSettingsSha256',
      'exportUserSettingCount',
      'exported',
      'importAcceptApplied',
      'importCancelPreserved',
      'importRecognizedSettingCount',
      'importUnknownIgnoredCount',
      'ownedSyntheticImportUsed'
    ],
    'Settings import/export payload'
  );
  assertBooleans(
    value,
    ['exported', 'importAcceptApplied', 'importCancelPreserved', 'ownedSyntheticImportUsed'],
    'Settings import/export payload'
  );
  assertPositiveInteger(value.exportBytes, 'Settings export bytes');
  assertNonNegativeIntegers(
    value,
    [
      'exportDownloadEntryCountAdded',
      'exportSchemaVersion',
      'exportUserSettingCount',
      'importRecognizedSettingCount',
      'importUnknownIgnoredCount'
    ],
    'Settings import/export payload'
  );
  assertSha256(value.exportSettingsSha256, 'Settings export setting-set SHA-256');
  return (
    value.exported === true &&
    value.exportBytes <= 128 * 1024 &&
    value.exportDownloadEntryCountAdded === 1 &&
    value.exportSchema === 'sitewipe.settings.backup' &&
    value.exportSchemaVersion === 1 &&
    value.exportUserSettingCount === VISIBLE_SETTINGS.length &&
    value.importCancelPreserved === true &&
    value.importAcceptApplied === true &&
    value.importRecognizedSettingCount === VISIBLE_SETTINGS.length &&
    value.importUnknownIgnoredCount === 1 &&
    value.ownedSyntheticImportUsed === true &&
    validateSettingsOwnedDownloadSafety(value.downloadSafety, value.exportBytes) &&
    binding.identity.artifactVersion.length > 0
  );
}

function validateSettingsSensitiveConfirmations(value) {
  assertExactKeys(value, ['cases', 'safetyBoundary'], 'Sensitive settings payload');
  if (!Array.isArray(value.cases) || value.cases.length !== 4) {
    throw new Error('Sensitive settings payload requires exactly four confirmation cases.');
  }
  const expectedHashes = sensitiveSettingsPromptHashes();
  for (const [index, expectedId] of [
    'skipCleanupReview',
    'redactReports',
    'latestReportRetentionMinutes',
    'resetSettings'
  ].entries()) {
    const item = value.cases[index];
    assertExactKeys(
      item,
      ['acceptObserved', 'cancelObserved', 'changedAfterAccept', 'id', 'promptSha256', 'unchangedAfterCancel'],
      'Sensitive setting confirmation case'
    );
    assertBooleans(
      item,
      ['acceptObserved', 'cancelObserved', 'changedAfterAccept', 'unchangedAfterCancel'],
      'Sensitive setting confirmation case'
    );
    assertSha256(item.promptSha256, 'Sensitive setting confirmation prompt SHA-256');
    if (
      item.id !== expectedId ||
      item.promptSha256 !== expectedHashes[expectedId] ||
      item.cancelObserved !== true ||
      item.acceptObserved !== true ||
      item.unchangedAfterCancel !== true ||
      item.changedAfterAccept !== true
    ) {
      return false;
    }
  }
  return validateSettingsSafetyBoundary(value.safetyBoundary);
}

function validateSettingsMalformedAssociatedGroups(value) {
  assertExactKeys(
    value,
    ['safetyBoundary', 'safetyToggleExercised', 'storageBounds', 'syntax'],
    'Malformed associated-groups payload'
  );
  assertBooleans(value, ['safetyToggleExercised'], 'Malformed associated-groups payload');
  assertExactKeys(
    value.syntax,
    ['ariaInvalid', 'diagnosticErrorTone', 'errorCount', 'storedInputBounded'],
    'Malformed associated-groups syntax payload'
  );
  assertBooleans(
    value.syntax,
    ['ariaInvalid', 'diagnosticErrorTone', 'storedInputBounded'],
    'Malformed associated-groups syntax payload'
  );
  assertNonNegativeIntegers(value.syntax, ['errorCount'], 'Malformed associated-groups syntax payload');
  assertExactKeys(
    value.storageBounds,
    [
      'diagnosticBoundReported',
      'ignoredLineCount',
      'inputLineCount',
      'maxStoredLineCharacters',
      'retainedLineCount',
      'shortenedLineCount'
    ],
    'Associated-groups storage-bounds payload'
  );
  assertBooleans(value.storageBounds, ['diagnosticBoundReported'], 'Associated-groups storage-bounds payload');
  assertNonNegativeIntegers(
    value.storageBounds,
    ['ignoredLineCount', 'inputLineCount', 'maxStoredLineCharacters', 'retainedLineCount', 'shortenedLineCount'],
    'Associated-groups storage-bounds payload'
  );
  return (
    value.syntax.ariaInvalid === true &&
    value.syntax.diagnosticErrorTone === true &&
    value.syntax.errorCount > 0 &&
    value.syntax.storedInputBounded === true &&
    value.storageBounds.inputLineCount === 51 &&
    value.storageBounds.retainedLineCount === 50 &&
    value.storageBounds.ignoredLineCount === 1 &&
    value.storageBounds.shortenedLineCount === 50 &&
    value.storageBounds.maxStoredLineCharacters === 500 &&
    value.storageBounds.diagnosticBoundReported === true &&
    value.safetyToggleExercised === true &&
    validateSettingsSafetyBoundary(value.safetyBoundary)
  );
}

function validateSettingsSafetyBoundary(value) {
  const exactKeys = [
    'authorityStorageChangeCount',
    'automaticDownloadDeletionPerformed',
    'automaticProfileDeletionPerformed',
    'closeCanaryPreserved',
    'closeObservationStatus',
    'closeResidueCount',
    'dnrPollCountAfter',
    'dnrPollCountBefore',
    'dnrPollErrorCount',
    'dnrPollIntervalMs',
    'dnrPollMaxGapMs',
    'dnrPollNonemptyCount',
    'dynamicRuleCountAfter',
    'dynamicRuleCountBefore',
    'dynamicRulesAfterSha256',
    'dynamicRulesBeforeSha256',
    'incognitoAllowedAfter',
    'incognitoAllowedBefore',
    'localAuthorityAfterSha256',
    'localAuthorityBeforeSha256',
    'localAuthorityEntryCountAfter',
    'localAuthorityEntryCountBefore',
    'monitoredLocalAuthorityKeys',
    'monitoredSessionAuthorityKeys',
    'nativeControlledStopObserved',
    'nativeObservationScheduleId',
    'nativeObservationSettledBeforeFinalCapture',
    'nativeObservationStatus',
    'nativeReadinessStatus',
    'observationScope',
    'permissionAddedEventCount',
    'permissionApiCountAfter',
    'permissionApiCountBefore',
    'permissionApis',
    'permissionOriginCountAfter',
    'permissionOriginCountBefore',
    'permissionRemovedEventCount',
    'permissionsAfterSha256',
    'permissionsBeforeSha256',
    'schema',
    'preloadDocumentReadyCountAfter',
    'preloadDocumentReadyCountBefore',
    'sessionAuthorityAfterSha256',
    'sessionAuthorityBeforeSha256',
    'sessionAuthorityEntryCountAfter',
    'sessionAuthorityEntryCountBefore',
    'sessionRuleCountAfter',
    'sessionRuleCountBefore',
    'sessionRulesAfterSha256',
    'sessionRulesBeforeSha256'
  ];
  assertExactKeys(value, exactKeys, 'Settings safety-boundary payload');
  assertBooleans(
    value,
    [
      'automaticDownloadDeletionPerformed',
      'automaticProfileDeletionPerformed',
      'closeCanaryPreserved',
      'incognitoAllowedAfter',
      'incognitoAllowedBefore',
      'nativeControlledStopObserved',
      'nativeObservationSettledBeforeFinalCapture'
    ],
    'Settings safety-boundary payload'
  );
  assertNonNegativeIntegers(
    value,
    [
      'authorityStorageChangeCount',
      'closeResidueCount',
      'dnrPollCountAfter',
      'dnrPollCountBefore',
      'dnrPollErrorCount',
      'dnrPollIntervalMs',
      'dnrPollMaxGapMs',
      'dnrPollNonemptyCount',
      'dynamicRuleCountAfter',
      'dynamicRuleCountBefore',
      'localAuthorityEntryCountAfter',
      'localAuthorityEntryCountBefore',
      'permissionAddedEventCount',
      'permissionApiCountAfter',
      'permissionApiCountBefore',
      'permissionOriginCountAfter',
      'permissionOriginCountBefore',
      'permissionRemovedEventCount',
      'preloadDocumentReadyCountAfter',
      'preloadDocumentReadyCountBefore',
      'sessionAuthorityEntryCountAfter',
      'sessionAuthorityEntryCountBefore',
      'sessionRuleCountAfter',
      'sessionRuleCountBefore'
    ],
    'Settings safety-boundary payload'
  );
  for (const key of exactKeys.filter((key) => key.endsWith('Sha256'))) {
    assertSha256(value[key], `Settings safety-boundary ${key}`);
  }
  assertExactStringArray(value.permissionApis, 'Settings safety-boundary permission APIs');
  assertExactStringArray(value.monitoredLocalAuthorityKeys, 'Settings monitored local-authority keys');
  assertExactStringArray(value.monitoredSessionAuthorityKeys, 'Settings monitored session-authority keys');
  const emptyObjectSha256 = sha256(canonicalJsonBytes({}));
  const emptyArraySha256 = sha256(canonicalJsonBytes([]));
  const permissionSha256 = sha256(
    canonicalJsonBytes({ origins: [], permissions: SETTINGS_REQUIRED_EXTENSION_PERMISSIONS })
  );
  const expectedLocalAuthorityKeys = [
    'sitewipe.activeJob.v1',
    'sitewipe.activeShield.v1',
    'sitewipe.permissionLease.v1',
    'sitewipe.activeReport.v1',
    'sitewipe.reports.v1',
    'sitewipe.dnrPendingMutation.v1'
  ];
  const expectedSessionAuthorityKeys = [
    'sitewipe.cleanupReview.v1',
    'sitewipe.cleanupPermissionHandoff.v1',
    'sitewipe.dnrPendingMutation.session.v1'
  ];
  return (
    value.schema === 'sitewipe.settings-safety-boundary.v2' &&
    value.observationScope === 'bounded_preload_monitoring' &&
    value.localAuthorityBeforeSha256 === emptyObjectSha256 &&
    value.localAuthorityAfterSha256 === emptyObjectSha256 &&
    value.localAuthorityEntryCountBefore === 0 &&
    value.localAuthorityEntryCountAfter === 0 &&
    value.sessionAuthorityBeforeSha256 === emptyObjectSha256 &&
    value.sessionAuthorityAfterSha256 === emptyObjectSha256 &&
    value.sessionAuthorityEntryCountBefore === 0 &&
    value.sessionAuthorityEntryCountAfter === 0 &&
    value.dynamicRulesBeforeSha256 === emptyArraySha256 &&
    value.dynamicRulesAfterSha256 === emptyArraySha256 &&
    value.dynamicRuleCountBefore === 0 &&
    value.dynamicRuleCountAfter === 0 &&
    value.sessionRulesBeforeSha256 === emptyArraySha256 &&
    value.sessionRulesAfterSha256 === emptyArraySha256 &&
    value.sessionRuleCountBefore === 0 &&
    value.sessionRuleCountAfter === 0 &&
    exactArray(value.permissionApis, SETTINGS_REQUIRED_EXTENSION_PERMISSIONS) &&
    value.permissionsBeforeSha256 === permissionSha256 &&
    value.permissionsAfterSha256 === permissionSha256 &&
    value.permissionOriginCountBefore === 0 &&
    value.permissionOriginCountAfter === 0 &&
    value.permissionApiCountBefore === SETTINGS_REQUIRED_EXTENSION_PERMISSIONS.length &&
    value.permissionApiCountAfter === SETTINGS_REQUIRED_EXTENSION_PERMISSIONS.length &&
    value.permissionAddedEventCount === 0 &&
    value.permissionRemovedEventCount === 0 &&
    value.authorityStorageChangeCount === 0 &&
    exactArray(value.monitoredLocalAuthorityKeys, expectedLocalAuthorityKeys) &&
    exactArray(value.monitoredSessionAuthorityKeys, expectedSessionAuthorityKeys) &&
    value.preloadDocumentReadyCountBefore >= 1 &&
    value.preloadDocumentReadyCountAfter >= value.preloadDocumentReadyCountBefore &&
    value.dnrPollIntervalMs === 100 &&
    value.dnrPollCountBefore >= 1 &&
    value.dnrPollCountAfter >= value.dnrPollCountBefore &&
    value.dnrPollMaxGapMs <= 5_000 &&
    value.dnrPollNonemptyCount === 0 &&
    value.dnrPollErrorCount === 0 &&
    value.incognitoAllowedBefore === false &&
    value.incognitoAllowedAfter === false &&
    value.nativeObservationScheduleId === 'SETTINGS-01.observe-none' &&
    value.nativeObservationStatus === 'no_prompt_observed' &&
    value.nativeReadinessStatus === 'ready' &&
    value.nativeControlledStopObserved === true &&
    value.nativeObservationSettledBeforeFinalCapture === true &&
    value.closeObservationStatus === 'clean' &&
    value.closeResidueCount === 0 &&
    value.closeCanaryPreserved === true &&
    value.automaticProfileDeletionPerformed === false &&
    value.automaticDownloadDeletionPerformed === false
  );
}

function validateSettingsOwnedDownloadSafety(value, exportBytes) {
  assertExactKeys(
    value,
    [
      'automaticDownloadDeletionPerformed',
      'browserDownloadCreatedEventCount',
      'browserDownloadErasedEventCount',
      'browserExport',
      'browserRecordCountAfter',
      'browserRecordCountBefore',
      'canaryPreservedAfterClose',
      'canarySha256',
      'parentIdentityMatchedThroughClose',
      'exportFileSha256',
      'exportPhysicalIdentityRetained',
      'foreignEntryCount',
      'importFileSha256',
      'importPhysicalIdentityRetained',
      'ownedParentIdentitySha256',
      'ownedEntryNamesAfterClose',
      'ownedEntryNamesBefore',
      'ownedEntryNamesBeforeClose',
      'ownedSetAfterCloseSha256',
      'ownedSetBeforeCloseSha256',
      'ownedSetBeforeSha256',
      'precloseAndPostcloseOwnedSetMatched',
      'schema',
      'scopeBoundary'
    ],
    'Settings owned-download safety payload'
  );
  assertBooleans(
    value,
    [
      'automaticDownloadDeletionPerformed',
      'canaryPreservedAfterClose',
      'parentIdentityMatchedThroughClose',
      'exportPhysicalIdentityRetained',
      'importPhysicalIdentityRetained',
      'precloseAndPostcloseOwnedSetMatched'
    ],
    'Settings owned-download safety payload'
  );
  assertNonNegativeIntegers(
    value,
    [
      'browserDownloadCreatedEventCount',
      'browserDownloadErasedEventCount',
      'browserRecordCountAfter',
      'browserRecordCountBefore',
      'foreignEntryCount'
    ],
    'Settings owned-download safety payload'
  );
  for (const key of [
    'canarySha256',
    'exportFileSha256',
    'importFileSha256',
    'ownedParentIdentitySha256',
    'ownedSetAfterCloseSha256',
    'ownedSetBeforeCloseSha256',
    'ownedSetBeforeSha256'
  ]) {
    assertSha256(value[key], `Settings owned-download ${key}`);
  }
  for (const key of ['ownedEntryNamesAfterClose', 'ownedEntryNamesBefore', 'ownedEntryNamesBeforeClose']) {
    assertExactStringArray(value[key], `Settings owned-download ${key}`);
  }
  assertExactKeys(
    value.browserExport,
    ['bytesReceived', 'danger', 'exists', 'namePatternMatched', 'paused', 'state', 'totalBytes'],
    'Settings browser export payload'
  );
  assertBooleans(value.browserExport, ['exists', 'namePatternMatched', 'paused'], 'Settings browser export payload');
  assertNonNegativeIntegers(value.browserExport, ['bytesReceived', 'totalBytes'], 'Settings browser export payload');
  const before = ['.sitewipe-must-preserve-download.bin', '.sitewipe-owned-browser-directory.json'].sort();
  const exportNames = value.ownedEntryNamesBeforeClose.filter((name) => /^sitewipe-settings-\d+\.json$/u.test(name));
  if (exportNames.length !== 1) return false;
  const expectedAfter = [...before, '.sitewipe-owned-settings-import.json', exportNames[0]].sort();
  return (
    value.schema === 'sitewipe.settings-owned-download-safety.v2' &&
    value.scopeBoundary === 'owned_disposable_cell_only' &&
    exactArray(value.ownedEntryNamesBefore, before) &&
    exactArray(value.ownedEntryNamesBeforeClose, expectedAfter) &&
    exactArray(value.ownedEntryNamesAfterClose, expectedAfter) &&
    value.ownedSetBeforeCloseSha256 === value.ownedSetAfterCloseSha256 &&
    value.precloseAndPostcloseOwnedSetMatched === true &&
    value.parentIdentityMatchedThroughClose === true &&
    value.exportPhysicalIdentityRetained === true &&
    value.importPhysicalIdentityRetained === true &&
    value.browserRecordCountBefore === 0 &&
    value.browserRecordCountAfter === 1 &&
    value.browserDownloadCreatedEventCount === 1 &&
    value.browserDownloadErasedEventCount === 0 &&
    value.foreignEntryCount === 0 &&
    value.browserExport.bytesReceived === exportBytes &&
    value.browserExport.totalBytes === exportBytes &&
    value.browserExport.danger === 'safe' &&
    value.browserExport.exists === true &&
    value.browserExport.namePatternMatched === true &&
    value.browserExport.paused === false &&
    value.browserExport.state === 'complete' &&
    value.canaryPreservedAfterClose === true &&
    value.automaticDownloadDeletionPerformed === false
  );
}

function sensitiveSettingsPromptHashes() {
  const sensitiveReportPrompt =
    'Store sensitive cleanup report details? Full unredacted reports can contain browsing domains, URLs, filenames, local paths, and browser error details; indefinite retention keeps the latest report until you delete it. Choose Cancel to keep the current privacy-safe settings.';
  const skipReviewPrompt = `Skip the detailed cleanup review completely for future cleanups? This applies in Standard and Expert mode. One popup cleanup action can immediately begin all currently enabled cleanup effects. ${SELECTED_SITE_PARTITION_STORAGE_DISCLOSURE} ${EXACT_ORIGIN_BROWSER_STORAGE_LIMITATION} Expert options can delete matched downloaded files or affect broader site data, and private-window data can be included when incognito access is enabled. Chrome or Brave may still require its own permission prompt. Choose Cancel to keep detailed review enabled.`;
  const resetPrompt = 'Reset SiteWipe settings to the privacy-safe defaults? Your current settings cannot be restored.';
  return {
    skipCleanupReview: sha256(skipReviewPrompt),
    redactReports: sha256(sensitiveReportPrompt),
    latestReportRetentionMinutes: sha256(sensitiveReportPrompt),
    resetSettings: sha256(resetPrompt)
  };
}

function validateExactHead(value, binding) {
  assertExactKeys(
    value,
    ['clean', 'commitSha', 'indexDeltaCount', 'treeSha', 'untrackedEntryCount', 'worktreeDeltaCount'],
    'Exact-head observation payload'
  );
  assertBooleans(value, ['clean'], 'Exact-head observation payload');
  assertNonNegativeIntegers(
    value,
    ['indexDeltaCount', 'untrackedEntryCount', 'worktreeDeltaCount'],
    'Exact-head observation payload'
  );
  assertGitObjectId(value.commitSha, 'Exact-head commit SHA');
  assertGitObjectId(value.treeSha, 'Exact-head tree SHA');
  return (
    value.clean === true &&
    value.commitSha === binding.identity.sourceCommitSha &&
    value.treeSha === binding.identity.sourceTreeSha &&
    value.indexDeltaCount === 0 &&
    value.untrackedEntryCount === 0 &&
    value.worktreeDeltaCount === 0
  );
}

function validateArtifactVersionManifest(value, binding) {
  assertExactKeys(
    value,
    [
      'artifactBytes',
      'artifactSha256',
      'artifactVersion',
      'manifestSha256',
      'manifestVersion',
      'runtimeEntryCount',
      'zipVerificationPassed'
    ],
    'Artifact version/manifest payload'
  );
  assertPositiveInteger(value.artifactBytes, 'Artifact bytes');
  assertPositiveInteger(value.runtimeEntryCount, 'Runtime entry count');
  assertSha256(value.artifactSha256, 'Artifact SHA-256');
  assertSha256(value.manifestSha256, 'Manifest SHA-256');
  assertSemanticVersion(value.artifactVersion, 'Artifact version');
  assertSemanticVersion(value.manifestVersion, 'Manifest version');
  assertBooleans(value, ['zipVerificationPassed'], 'Artifact version/manifest payload');
  return (
    value.zipVerificationPassed === true &&
    value.artifactBytes === binding.identity.artifactBytes &&
    value.artifactSha256 === binding.identity.artifactSha256 &&
    value.artifactVersion === binding.identity.artifactVersion &&
    value.manifestVersion === binding.identity.artifactVersion
  );
}

function validateSourceRuntimeParity(value, binding) {
  assertExactKeys(
    value,
    [
      'artifactRuntimeFileCount',
      'artifactRuntimeFingerprintSha256',
      'mismatchCount',
      'sourceRuntimeFileCount',
      'sourceRuntimeFingerprintSha256'
    ],
    'Source/runtime parity payload'
  );
  assertPositiveInteger(value.artifactRuntimeFileCount, 'Artifact runtime file count');
  assertPositiveInteger(value.sourceRuntimeFileCount, 'Source runtime file count');
  assertNonNegativeIntegers(value, ['mismatchCount'], 'Source/runtime parity payload');
  assertSha256(value.artifactRuntimeFingerprintSha256, 'Artifact runtime fingerprint');
  assertSha256(value.sourceRuntimeFingerprintSha256, 'Source runtime fingerprint');
  return (
    value.artifactRuntimeFileCount === value.sourceRuntimeFileCount &&
    value.mismatchCount === 0 &&
    value.artifactRuntimeFingerprintSha256 === binding.identity.runtimeFingerprintSha256 &&
    value.sourceRuntimeFingerprintSha256 === binding.identity.runtimeFingerprintSha256
  );
}

function validateNoncanonicalCandidateRejection(value, binding) {
  assertExactKeys(value, ['approvedArtifactSha256', 'cases'], 'Noncanonical-candidate rejection payload');
  assertSha256(value.approvedArtifactSha256, 'Approved artifact SHA-256');
  if (!Array.isArray(value.cases) || value.cases.length !== 2) {
    throw new Error('Noncanonical-candidate rejection payload requires exactly two cases.');
  }
  const expectations = [
    ['ignored_candidate', 'candidate_not_canonical'],
    ['stale_candidate', 'artifact_identity_mismatch']
  ];
  const candidateHashes = new Set();
  for (const [index, item] of value.cases.entries()) {
    assertExactKeys(item, ['candidateSha256', 'kind', 'rejected', 'rejectionCode'], 'Candidate rejection case');
    assertSha256(item.candidateSha256, 'Candidate SHA-256');
    assertBooleans(item, ['rejected'], 'Candidate rejection case');
    candidateHashes.add(item.candidateSha256);
    const [kind, code] = expectations[index];
    if (
      item.kind !== kind ||
      item.rejectionCode !== code ||
      item.rejected !== true ||
      item.candidateSha256 === value.approvedArtifactSha256
    ) {
      return false;
    }
  }
  return value.approvedArtifactSha256 === binding.identity.artifactSha256 && candidateHashes.size === 2;
}

function validateFreshProfile(value, binding) {
  assertExactKeys(
    value,
    [
      'extensionEnabled',
      'extensionId',
      'extensionName',
      'extensionOriginScheme',
      'extensionVersion',
      'profileDataEntryCountBeforeLaunch',
      'profileOwnershipMarkerMatched',
      'profileWasNew',
      'syncEnabled'
    ],
    'Fresh-profile payload'
  );
  assertBooleans(
    value,
    ['extensionEnabled', 'profileOwnershipMarkerMatched', 'profileWasNew', 'syncEnabled'],
    'Fresh-profile payload'
  );
  assertNonNegativeIntegers(value, ['profileDataEntryCountBeforeLaunch'], 'Fresh-profile payload');
  if (!/^[a-p]{32}$/.test(String(value.extensionId || ''))) throw new Error('Extension ID is malformed.');
  assertSemanticVersion(value.extensionVersion, 'Installed extension version');
  return (
    value.profileWasNew === true &&
    value.profileOwnershipMarkerMatched === true &&
    value.profileDataEntryCountBeforeLaunch === 0 &&
    value.syncEnabled === false &&
    value.extensionEnabled === true &&
    value.extensionName === 'SiteWipe' &&
    value.extensionVersion === binding.identity.artifactVersion &&
    value.extensionOriginScheme === 'chrome-extension'
  );
}

function validateSafeDefaults(value) {
  assertExactKeys(value, ['settings'], 'Safe-defaults payload');
  const settings = value.settings;
  assertExactKeys(settings, Object.keys(SETTINGS_DEFAULTS), 'Observed fresh-install settings');
  for (const [key, expected] of Object.entries(SETTINGS_DEFAULTS)) {
    const actual = settings[key];
    if (
      [
        'createdAt',
        'updatedAt',
        'stabilityDefaultsAppliedAt',
        'performanceDefaultsAppliedAt',
        'privacyDefaultsAppliedAt',
        'storagePartitionDisclosureAppliedAt'
      ].includes(key)
    ) {
      if (actual !== null) assertIsoTimestamp(actual, `Fresh-install setting ${key}`);
      continue;
    }
    if (stableJson(actual) !== stableJson(expected)) return false;
  }
  return settings.deleteDownloadedFiles === false && settings.skipCleanupReview === false;
}

function validateInstalledSurfaces(value) {
  assertExactKeys(value, ['surfaces'], 'Installed-surfaces payload');
  if (!Array.isArray(value.surfaces) || value.surfaces.length !== 3) {
    throw new Error('Installed-surfaces payload requires exactly three surfaces.');
  }
  const expected = [
    ['popup', 'SiteWipe'],
    ['options', 'SiteWipe Options'],
    ['sidepanel', 'SiteWipe Report']
  ];
  return value.surfaces.every((surface, index) => {
    assertExactKeys(
      surface,
      ['documentTitle', 'name', 'originScheme', 'readyState', 'visible'],
      'Installed surface observation'
    );
    assertBooleans(surface, ['visible'], 'Installed surface observation');
    return (
      surface.name === expected[index][0] &&
      surface.documentTitle === expected[index][1] &&
      surface.originScheme === 'chrome-extension' &&
      surface.readyState === 'complete' &&
      surface.visible === true
    );
  });
}

function validateNoAuthorityOrMutation(value) {
  assertExactKeys(
    value,
    [
      'cleanupMutationCount',
      'dnrBaselineNonemptyCount',
      'dnrObservationMode',
      'dnrPollCount',
      'dnrPollErrorCount',
      'dnrPollIntervalMs',
      'dnrPollMaximumObservedGapMs',
      'dnrPollNonemptyCount',
      'dynamicDnrRuleCountAfter',
      'dynamicDnrRuleCountBefore',
      'dynamicDnrRulesAfterSha256',
      'dynamicDnrRulesBeforeSha256',
      'fixtureAfterDataEntryCount',
      'fixtureAfterInventorySha256',
      'fixtureAfterStorageKindCount',
      'fixtureAfterValueSha256',
      'fixtureBeforeDataEntryCount',
      'fixtureBeforeInventorySha256',
      'fixtureBeforeStorageKindCount',
      'fixtureBeforeValueSha256',
      'fixtureScale',
      'fixtureSeedDataEntryCount',
      'fixtureSeedInventorySha256',
      'fixtureSeedReceiptSha256',
      'fixtureSeedStorageKindCount',
      'fixtureSeedValueSha256',
      'fixtureSeeded',
      'fixtureVersion',
      'finalLocalAuthorityEntryCount',
      'finalSessionAuthorityEntryCount',
      'hostPermissionOrigins',
      'initialLocalAuthorityEntryCount',
      'initialSessionAuthorityEntryCount',
      'localAuthorityChangedKeyCount',
      'monitorBaselineAcknowledgedCount',
      'monitorBaselineErrorCount',
      'monitorCoverageObservedAt',
      'monitorCoverageSequence',
      'monitorDocumentReadyCount',
      'monitorObservationReadyAt',
      'nativeObservationCoverageThrough',
      'nativeObservationObservedAt',
      'nativeObservationReadyAt',
      'nativePermissionPromptObserved',
      'observationReadinessBounded',
      'permissionAddedEventCount',
      'permissionLeaseCount',
      'permissionRemovedEventCount',
      'reportCount',
      'runningJobCount',
      'sessionAuthorityChangedKeyCount',
      'sessionDnrRuleCountAfter',
      'sessionDnrRuleCountBefore',
      'sessionDnrRulesAfterSha256',
      'sessionDnrRulesBeforeSha256',
      'startupEndpointPreconditionPassed',
      'startupSourceRouteContractMatched',
      'startupSourceRouteContractSha256',
      'downloadCreatedEventCount',
      'downloadErasedEventCount'
    ],
    'No-authority/no-mutation payload'
  );
  for (const [field, label] of [
    ['fixtureBeforeInventorySha256', 'Fixture-before inventory SHA-256'],
    ['fixtureAfterInventorySha256', 'Fixture-after inventory SHA-256'],
    ['fixtureBeforeValueSha256', 'Fixture-before value SHA-256'],
    ['fixtureAfterValueSha256', 'Fixture-after value SHA-256'],
    ['fixtureSeedInventorySha256', 'Fixture seed inventory SHA-256'],
    ['fixtureSeedReceiptSha256', 'Fixture seed-receipt SHA-256'],
    ['fixtureSeedValueSha256', 'Fixture seed value SHA-256'],
    ['dynamicDnrRulesBeforeSha256', 'Dynamic DNR-before SHA-256'],
    ['dynamicDnrRulesAfterSha256', 'Dynamic DNR-after SHA-256'],
    ['sessionDnrRulesBeforeSha256', 'Session DNR-before SHA-256'],
    ['sessionDnrRulesAfterSha256', 'Session DNR-after SHA-256'],
    ['startupSourceRouteContractSha256', 'Startup source-route contract SHA-256']
  ]) {
    assertSha256(value[field], label);
  }
  assertExactStringArray(value.hostPermissionOrigins, 'Host permission origins');
  assertBooleans(
    value,
    [
      'fixtureSeeded',
      'nativePermissionPromptObserved',
      'observationReadinessBounded',
      'startupEndpointPreconditionPassed',
      'startupSourceRouteContractMatched'
    ],
    'No-authority/no-mutation payload'
  );
  assertIsoTimestamp(value.monitorObservationReadyAt, 'SMOKE monitor readiness timestamp');
  assertIsoTimestamp(value.monitorCoverageObservedAt, 'SMOKE monitor coverage timestamp');
  assertIsoTimestamp(value.nativeObservationReadyAt, 'Native observation readiness timestamp');
  assertIsoTimestamp(value.nativeObservationCoverageThrough, 'Native observation coverage-through timestamp');
  assertIsoTimestamp(value.nativeObservationObservedAt, 'Native observation timestamp');
  assertNonNegativeIntegers(
    value,
    [
      'cleanupMutationCount',
      'dnrBaselineNonemptyCount',
      'dnrPollCount',
      'dnrPollErrorCount',
      'dnrPollIntervalMs',
      'dnrPollMaximumObservedGapMs',
      'dnrPollNonemptyCount',
      'dynamicDnrRuleCountAfter',
      'dynamicDnrRuleCountBefore',
      'fixtureAfterDataEntryCount',
      'fixtureAfterStorageKindCount',
      'fixtureBeforeDataEntryCount',
      'fixtureBeforeStorageKindCount',
      'fixtureSeedDataEntryCount',
      'fixtureSeedStorageKindCount',
      'finalLocalAuthorityEntryCount',
      'finalSessionAuthorityEntryCount',
      'initialLocalAuthorityEntryCount',
      'initialSessionAuthorityEntryCount',
      'localAuthorityChangedKeyCount',
      'monitorBaselineAcknowledgedCount',
      'monitorBaselineErrorCount',
      'monitorCoverageSequence',
      'monitorDocumentReadyCount',
      'permissionAddedEventCount',
      'permissionLeaseCount',
      'permissionRemovedEventCount',
      'reportCount',
      'runningJobCount',
      'sessionAuthorityChangedKeyCount',
      'sessionDnrRuleCountAfter',
      'sessionDnrRuleCountBefore',
      'downloadCreatedEventCount',
      'downloadErasedEventCount'
    ],
    'No-authority/no-mutation payload'
  );
  const emptyRuleSetSha256 = sha256(canonicalJsonBytes([]));
  return (
    value.fixtureVersion === 'sitewipe-synthetic-v1' &&
    value.fixtureScale === 'small' &&
    value.fixtureSeeded === true &&
    value.dnrObservationMode === 'endpoint_snapshots_and_bounded_polling' &&
    value.dnrPollIntervalMs >= 1 &&
    value.dnrPollIntervalMs <= 100 &&
    value.dnrPollCount >= 3 &&
    value.monitorBaselineAcknowledgedCount >= 1 &&
    value.monitorDocumentReadyCount >= 1 &&
    value.monitorCoverageSequence > value.dnrPollCount &&
    value.observationReadinessBounded === true &&
    value.startupEndpointPreconditionPassed === true &&
    value.startupSourceRouteContractMatched === true &&
    value.nativePermissionPromptObserved === false &&
    Date.parse(value.monitorObservationReadyAt) >= Date.parse(value.nativeObservationReadyAt) &&
    Date.parse(value.nativeObservationCoverageThrough) >= Date.parse(value.nativeObservationReadyAt) &&
    Date.parse(value.nativeObservationObservedAt) >= Date.parse(value.nativeObservationCoverageThrough) &&
    Date.parse(value.monitorCoverageObservedAt) >= Date.parse(value.monitorObservationReadyAt) &&
    Date.parse(value.monitorCoverageObservedAt) >= Date.parse(value.nativeObservationObservedAt) &&
    value.dynamicDnrRuleCountBefore === 0 &&
    value.dynamicDnrRuleCountAfter === 0 &&
    value.sessionDnrRuleCountBefore === 0 &&
    value.sessionDnrRuleCountAfter === 0 &&
    value.dynamicDnrRulesBeforeSha256 === emptyRuleSetSha256 &&
    value.dynamicDnrRulesAfterSha256 === emptyRuleSetSha256 &&
    value.sessionDnrRulesBeforeSha256 === emptyRuleSetSha256 &&
    value.sessionDnrRulesAfterSha256 === emptyRuleSetSha256 &&
    value.fixtureSeedDataEntryCount === value.fixtureBeforeDataEntryCount &&
    value.fixtureSeedStorageKindCount === value.fixtureBeforeStorageKindCount &&
    value.fixtureSeedInventorySha256 === value.fixtureBeforeInventorySha256 &&
    value.fixtureSeedValueSha256 === value.fixtureBeforeValueSha256 &&
    value.fixtureBeforeDataEntryCount >= SMOKE_MINIMUM_SEEDED_FIXTURE_ENTRIES &&
    value.fixtureAfterDataEntryCount === value.fixtureBeforeDataEntryCount &&
    value.fixtureBeforeStorageKindCount >= SMOKE_MINIMUM_SEEDED_STORAGE_KINDS &&
    value.fixtureAfterStorageKindCount === value.fixtureBeforeStorageKindCount &&
    value.fixtureBeforeInventorySha256 === value.fixtureAfterInventorySha256 &&
    value.fixtureBeforeValueSha256 === value.fixtureAfterValueSha256 &&
    value.fixtureBeforeInventorySha256 !== value.fixtureBeforeValueSha256 &&
    value.hostPermissionOrigins.length === 0 &&
    [
      value.cleanupMutationCount,
      value.dnrBaselineNonemptyCount,
      value.dnrPollErrorCount,
      value.dnrPollNonemptyCount,
      value.monitorBaselineErrorCount,
      value.initialLocalAuthorityEntryCount,
      value.initialSessionAuthorityEntryCount,
      value.finalLocalAuthorityEntryCount,
      value.finalSessionAuthorityEntryCount,
      value.localAuthorityChangedKeyCount,
      value.sessionAuthorityChangedKeyCount,
      value.permissionAddedEventCount,
      value.permissionRemovedEventCount,
      value.downloadCreatedEventCount,
      value.downloadErasedEventCount,
      value.permissionLeaseCount,
      value.reportCount,
      value.runningJobCount
    ].every((count) => count === 0)
  );
}

function validateStandardReview(value) {
  assertExactKeys(
    value,
    ['cleanupMutationCount', 'displayed', 'hostPermissionPatterns', 'mode', 'targetDomain'],
    'Standard-review payload'
  );
  assertReviewDisplay(value.displayed, REVIEW_STANDARD_DISPLAY_KEYS, 'Standard-review display');
  assertNonNegativeIntegers(value, ['cleanupMutationCount'], 'Standard-review payload');
  assertExactStringArray(value.hostPermissionPatterns, 'Standard-review host patterns');
  return (
    value.mode === 'standard' &&
    value.targetDomain === 'example.com' &&
    value.cleanupMutationCount === 0 &&
    exactArray(value.hostPermissionPatterns, REVIEWED_EXAMPLE_PERMISSION_PATTERNS) &&
    Object.values(value.displayed).every((displayed) => displayed === true)
  );
}

function validateExpertReview(value) {
  assertExactKeys(
    value,
    ['cleanupMutationCount', 'displayed', 'hostPermissionPatterns', 'mode', 'targetDomain'],
    'Expert-review payload'
  );
  assertReviewDisplay(value.displayed, REVIEW_EXPERT_DISPLAY_KEYS, 'Expert-review display');
  assertNonNegativeIntegers(value, ['cleanupMutationCount'], 'Expert-review payload');
  assertExactStringArray(value.hostPermissionPatterns, 'Expert-review host patterns');
  return (
    value.mode === 'expert' &&
    value.targetDomain === 'example.com' &&
    value.cleanupMutationCount === 0 &&
    exactArray(value.hostPermissionPatterns, REVIEWED_EXAMPLE_PERMISSION_PATTERNS) &&
    Object.values(value.displayed).every((displayed) => displayed === true)
  );
}

function validateReviewAcknowledgements(value) {
  assertExactKeys(
    value,
    [
      'allAcknowledgedApprovalEnabled',
      'associatedAcknowledgementRequired',
      'filePhraseRequired',
      'initialApprovalDisabled',
      'localAcknowledgementRequired',
      'protectedAcknowledgementRequired',
      'scopeAcknowledgementRequired',
      'wrongFilePhraseApprovalDisabled'
    ],
    'Review-acknowledgements payload'
  );
  assertBooleans(value, Object.keys(value), 'Review-acknowledgements payload');
  return Object.values(value).every((item) => item === true);
}

function validateReviewCancel(value) {
  assertExactKeys(
    value,
    [
      'cancelStatusObserved',
      'downloadInventoryAfterSha256',
      'downloadInventoryBeforeSha256',
      'fixtureAfterSha256',
      'fixtureBeforeSha256',
      'permissionInventoryAfterSha256',
      'permissionInventoryBeforeSha256',
      'reportCount',
      'runningJobCount'
    ],
    'Review-cancel payload'
  );
  for (const key of [
    'downloadInventoryAfterSha256',
    'downloadInventoryBeforeSha256',
    'fixtureAfterSha256',
    'fixtureBeforeSha256',
    'permissionInventoryAfterSha256',
    'permissionInventoryBeforeSha256'
  ]) {
    assertSha256(value[key], key);
  }
  assertBooleans(value, ['cancelStatusObserved'], 'Review-cancel payload');
  assertNonNegativeIntegers(value, ['reportCount', 'runningJobCount'], 'Review-cancel payload');
  return (
    value.cancelStatusObserved === true &&
    value.downloadInventoryAfterSha256 === value.downloadInventoryBeforeSha256 &&
    value.fixtureAfterSha256 === value.fixtureBeforeSha256 &&
    value.permissionInventoryAfterSha256 === value.permissionInventoryBeforeSha256 &&
    value.reportCount === 0 &&
    value.runningJobCount === 0
  );
}

function validateLegitimateActionSender(value) {
  assertExactKeys(
    value,
    [
      'actionTargetType',
      'activationApi',
      'cleanupMutationCount',
      'contextCount',
      'popupTargetTransition',
      'reviewPrepared',
      'senderDocumentIdPresent',
      'senderTabId',
      'senderWindowId'
    ],
    'Legitimate action-sender payload'
  );
  assertBooleans(value, ['reviewPrepared', 'senderDocumentIdPresent'], 'Legitimate action-sender payload');
  assertNonNegativeIntegers(value, ['cleanupMutationCount', 'contextCount'], 'Legitimate action-sender payload');
  if (!Number.isInteger(value.senderTabId) || !Number.isInteger(value.senderWindowId)) {
    throw new Error('Legitimate action-sender tab/window IDs must be integers.');
  }
  return (
    value.activationApi === 'Extensions.triggerAction' &&
    value.actionTargetType === 'page' &&
    value.popupTargetTransition === 'other_to_page' &&
    value.senderDocumentIdPresent === false &&
    value.senderTabId === -1 &&
    value.senderWindowId === -1 &&
    value.contextCount === 1 &&
    value.reviewPrepared === true &&
    value.cleanupMutationCount === 0
  );
}

function validateNetworkAllowlist(value) {
  assertExactKeys(
    value,
    [
      'allowedHosts',
      'allowedMethods',
      'allowedRoutes',
      'bindAddresses',
      'policyRejectedRequestCount',
      'unexpectedAllowedRequestCount'
    ],
    'Network allowlist payload'
  );
  for (const key of ['allowedHosts', 'allowedMethods', 'allowedRoutes', 'bindAddresses']) {
    assertExactStringArray(value[key], `Network allowlist ${key}`);
  }
  assertNonNegativeIntegers(
    value,
    ['policyRejectedRequestCount', 'unexpectedAllowedRequestCount'],
    'Network allowlist payload'
  );
  return (
    exactArray(value.bindAddresses, FIXED_FIXTURE_BIND_ADDRESSES) &&
    exactArray(value.allowedHosts, SYNTHETIC_FIXTURE_HOSTS) &&
    exactArray(value.allowedMethods, FIXTURE_ALLOWED_METHODS) &&
    exactArray(value.allowedRoutes, FIXTURE_ALLOWED_ROUTES) &&
    value.policyRejectedRequestCount > 0 &&
    value.unexpectedAllowedRequestCount === 0
  );
}

function validatePerRunSecret(value) {
  assertExactKeys(
    value,
    ['generatedAfterApproval', 'plaintextRetained', 'reuseCount', 'secretBytes', 'secretSha256'],
    'Per-run secret payload'
  );
  assertBooleans(value, ['generatedAfterApproval', 'plaintextRetained'], 'Per-run secret payload');
  assertNonNegativeIntegers(value, ['reuseCount', 'secretBytes'], 'Per-run secret payload');
  assertSha256(value.secretSha256, 'Per-run secret SHA-256');
  return (
    value.secretBytes === 32 &&
    value.generatedAfterApproval === true &&
    value.plaintextRetained === false &&
    value.reuseCount === 0
  );
}

function validateOutboundBlock(value) {
  assertExactKeys(
    value,
    [
      'connectRequestsAllowed',
      'denyByDefault',
      'directNonLoopbackConnectionsObserved',
      'nonLoopbackRequestsAllowed',
      'proxyLedgerSha256',
      'resolverPolicySha256',
      'transport'
    ],
    'Outbound-block payload'
  );
  assertBooleans(value, ['denyByDefault'], 'Outbound-block payload');
  assertNonNegativeIntegers(
    value,
    ['connectRequestsAllowed', 'directNonLoopbackConnectionsObserved', 'nonLoopbackRequestsAllowed'],
    'Outbound-block payload'
  );
  assertSha256(value.proxyLedgerSha256, 'Proxy ledger SHA-256');
  assertSha256(value.resolverPolicySha256, 'Resolver policy SHA-256');
  return (
    value.transport === 'pipe_and_loopback_proxy' &&
    value.denyByDefault === true &&
    value.connectRequestsAllowed === 0 &&
    value.nonLoopbackRequestsAllowed === 0 &&
    value.directNonLoopbackConnectionsObserved === 0
  );
}

function validateNetworkLedger(value) {
  assertExactKeys(
    value,
    [
      'authorizedFixtureRequestCount',
      'browserRequestCount',
      'deniedRequestCount',
      'fixtureRequestCount',
      'ledgerSha256',
      'proxyRequestCount',
      'unreconciledRequestCount'
    ],
    'Network ledger payload'
  );
  assertNonNegativeIntegers(
    value,
    [
      'authorizedFixtureRequestCount',
      'browserRequestCount',
      'deniedRequestCount',
      'fixtureRequestCount',
      'proxyRequestCount',
      'unreconciledRequestCount'
    ],
    'Network ledger payload'
  );
  assertSha256(value.ledgerSha256, 'Network ledger SHA-256');
  return (
    value.browserRequestCount > 0 &&
    value.browserRequestCount === value.proxyRequestCount &&
    value.fixtureRequestCount === value.authorizedFixtureRequestCount &&
    value.proxyRequestCount === value.authorizedFixtureRequestCount + value.deniedRequestCount &&
    value.unreconciledRequestCount === 0
  );
}

function validateProcessTreeExited(value) {
  assertExactKeys(
    value,
    [
      'allOwnedProcessesExited',
      'browserProcessCountAfterClose',
      'browserProcessCountBeforeClose',
      'forcedTerminationUsed',
      'profileBoundProcessCountAfterClose',
      'unownedProcessTerminated'
    ],
    'Process-tree teardown payload'
  );
  assertBooleans(
    value,
    ['allOwnedProcessesExited', 'forcedTerminationUsed', 'unownedProcessTerminated'],
    'Process-tree teardown payload'
  );
  assertNonNegativeIntegers(
    value,
    ['browserProcessCountAfterClose', 'browserProcessCountBeforeClose', 'profileBoundProcessCountAfterClose'],
    'Process-tree teardown payload'
  );
  return (
    value.browserProcessCountBeforeClose > 0 &&
    value.browserProcessCountAfterClose === 0 &&
    value.profileBoundProcessCountAfterClose === 0 &&
    value.allOwnedProcessesExited === true &&
    value.unownedProcessTerminated === false
  );
}

function validateOwnedIdentities(value, binding) {
  assertExactKeys(
    value,
    [
      'downloadInventoryAfterSha256',
      'downloadInventoryBeforeSha256',
      'foreignEntryCount',
      'identityRevalidated',
      'profileMarkerSha256',
      'runtimeArtifactSha256'
    ],
    'Owned-identities teardown payload'
  );
  for (const key of [
    'downloadInventoryAfterSha256',
    'downloadInventoryBeforeSha256',
    'profileMarkerSha256',
    'runtimeArtifactSha256'
  ]) {
    assertSha256(value[key], key);
  }
  assertBooleans(value, ['identityRevalidated'], 'Owned-identities teardown payload');
  assertNonNegativeIntegers(value, ['foreignEntryCount'], 'Owned-identities teardown payload');
  return (
    value.identityRevalidated === true &&
    value.runtimeArtifactSha256 === binding.identity.artifactSha256 &&
    value.downloadInventoryAfterSha256 === value.downloadInventoryBeforeSha256 &&
    value.foreignEntryCount === 0
  );
}

function validateTeardownReconciliation(value) {
  assertExactKeys(
    value,
    [
      'activeJobCount',
      'dnrRuleCount',
      'hostPermissionOriginCount',
      'permissionLeaseCount',
      'storageQuerySucceeded',
      'unresolvedRecoveryCount'
    ],
    'Teardown reconciliation payload'
  );
  assertBooleans(value, ['storageQuerySucceeded'], 'Teardown reconciliation payload');
  assertNonNegativeIntegers(
    value,
    ['activeJobCount', 'dnrRuleCount', 'hostPermissionOriginCount', 'permissionLeaseCount', 'unresolvedRecoveryCount'],
    'Teardown reconciliation payload'
  );
  return (
    value.storageQuerySucceeded === true &&
    value.activeJobCount === 0 &&
    value.dnrRuleCount === 0 &&
    value.hostPermissionOriginCount === 0 &&
    value.permissionLeaseCount === 0 &&
    value.unresolvedRecoveryCount === 0
  );
}

function validateTeardownReceipt(value) {
  assertExactKeys(
    value,
    ['action', 'automaticRecursiveDeletionPerformed', 'markerMatched', 'receiptSha256', 'runIdMatched'],
    'Teardown receipt payload'
  );
  assertBooleans(
    value,
    ['automaticRecursiveDeletionPerformed', 'markerMatched', 'runIdMatched'],
    'Teardown receipt payload'
  );
  assertSha256(value.receiptSha256, 'Teardown receipt SHA-256');
  return (
    ['retained', 'quarantined'].includes(value.action) &&
    value.markerMatched === true &&
    value.runIdMatched === true &&
    value.automaticRecursiveDeletionPerformed === false
  );
}

function validateEvidenceCompleteness(value) {
  assertExactKeys(
    value,
    [
      'completedNonTeardownCellCount',
      'duplicateCellCount',
      'evidenceIntegrityFailureCount',
      'missingNonTeardownCellCount',
      'plannedCellCount'
    ],
    'Evidence-completeness payload'
  );
  assertNonNegativeIntegers(value, Object.keys(value), 'Evidence-completeness payload');
  return (
    value.plannedCellCount === CANONICAL_BROWSER_MATRIX.length * REQUIRED_BROWSERS.length &&
    value.completedNonTeardownCellCount === (CANONICAL_BROWSER_MATRIX.length - 1) * REQUIRED_BROWSERS.length &&
    value.missingNonTeardownCellCount === 0 &&
    value.duplicateCellCount === 0 &&
    value.evidenceIntegrityFailureCount === 0
  );
}

function validateBinding(binding) {
  assertExactKeys(
    binding,
    ['browser', 'completedAt', 'identity', 'planSha256', 'runId', 'scenarioId', 'startedAt'],
    'Semantic observation binding'
  );
  canonicalScenario(binding.scenarioId);
  assertExactKeys(binding.browser, ['executableSha256', 'name', 'version'], 'Path-free browser identity');
  pathFreeBrowserIdentity(binding.browser);
  validateIdentity(binding.identity);
  if (!/^sitewipe-browser-[a-f0-9]{32}$/.test(String(binding.runId || '')) || !isSha256(binding.planSha256)) {
    throw new Error('Semantic observation binding has a malformed run or plan identity.');
  }
  assertIsoTimestamp(binding.startedAt, 'Semantic binding startedAt');
  assertIsoTimestamp(binding.completedAt, 'Semantic binding completedAt');
  if (Date.parse(binding.completedAt) < Date.parse(binding.startedAt)) {
    throw new Error('Semantic observation binding timestamps are reversed.');
  }
}

function pathFreeBrowserIdentity(browser) {
  if (!browser || typeof browser !== 'object' || Array.isArray(browser)) {
    throw new Error('Semantic browser identity is missing.');
  }
  const value = {
    name: browser.name,
    version: browser.version,
    executableSha256: browser.executableSha256
  };
  assertExactKeys(value, ['executableSha256', 'name', 'version'], 'Path-free browser identity');
  if (
    !REQUIRED_BROWSERS.includes(value.name) ||
    typeof value.version !== 'string' ||
    !/^\d+(?:\.\d+){2,3}$/.test(value.version)
  ) {
    throw new Error('Path-free browser identity has an unknown browser or version.');
  }
  assertSha256(value.executableSha256, 'Browser executable SHA-256');
  return value;
}

function validateIdentity(identity) {
  assertExactKeys(identity, IDENTITY_KEYS, 'Semantic source/artifact identity');
  assertGitObjectId(identity.sourceCommitSha, 'Source commit SHA');
  assertGitObjectId(identity.sourceTreeSha, 'Source tree SHA');
  assertSemanticVersion(identity.artifactVersion, 'Artifact version');
  assertPositiveInteger(identity.artifactBytes, 'Artifact byte count');
  if (!/^v\d+\.\d+\.\d+$/u.test(String(identity.nodeRuntimeVersion || ''))) {
    throw new Error('Semantic identity Node runtime version is malformed.');
  }
  if (identity.toolchainPuppeteerVersion !== PINNED_PUPPETEER_CORE_VERSION) {
    throw new Error('Semantic identity Puppeteer version differs from the pinned installed-browser toolchain.');
  }
  for (const key of ['toolchainPackageCount', 'toolchainFileCount', 'toolchainBytes']) {
    if (!Number.isSafeInteger(identity[key]) || identity[key] <= 0) {
      throw new Error(`Semantic identity ${key} must be a positive safe integer.`);
    }
  }
  for (const key of IDENTITY_KEYS.filter((candidate) => candidate.endsWith('Sha256'))) {
    assertSha256(identity[key], `Semantic identity ${key}`);
  }
}

function assertPathFreePrivateSafeValue(value, label) {
  const visit = (current, path) => {
    if (typeof current === 'string') {
      if ([...current].some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127)) {
        throw new Error(`${label} contains control characters at ${path}.`);
      }
      if (looksLikePrivatePath(current)) throw new Error(`${label} contains a local path at ${path}.`);
      if (looksLikeArbitraryUrl(current) && !ALLOWED_URL_LIKE_STRINGS.has(current)) {
        throw new Error(`${label} contains an arbitrary URL or URI at ${path}.`);
      }
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(current)) {
        throw new Error(`${label} contains an email-like identifier at ${path}.`);
      }
      return;
    }
    if (!current || typeof current !== 'object') return;
    for (const [key, child] of Object.entries(current)) {
      const exactSettingKey = path === `${label}.settings` && Object.hasOwn(SETTINGS_DEFAULTS, key);
      if (
        !exactSettingKey &&
        /(?:path|directory|root|uri|url|token|capabilit|cookie|base64|username|email|account)/iu.test(key)
      ) {
        throw new Error(`${label} contains forbidden private field ${path}.${key}.`);
      }
      visit(child, `${path}.${key}`);
    }
  };
  visit(value, label);
}

function looksLikePrivatePath(value) {
  const input = String(value || '');
  const decoded = safeDecodeURIComponent(input);
  return (
    /^[a-z]:[\\/]/iu.test(input) ||
    /^\\\\/u.test(input) ||
    /^\/\/(?!\*)/u.test(input) ||
    /^\/(?:Users|home|var|tmp|etc|opt|mnt|private|Volumes)(?:\/|$)/u.test(input) ||
    /(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(input) ||
    /^(?:file):/iu.test(input) ||
    /^[a-z]:[\\/]/iu.test(decoded) ||
    /^\/(?:Users|home|var|tmp|etc|opt|mnt|private|Volumes)(?:\/|$)/u.test(decoded)
  );
}

function looksLikeArbitraryUrl(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//iu.test(String(value || '')) || /^file:/iu.test(String(value || ''));
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function assertReviewDisplay(value, keys, label) {
  assertExactKeys(value, keys, label);
  assertBooleans(value, keys, label);
}

function assertBooleans(value, keys, label) {
  for (const key of keys) {
    if (typeof value[key] !== 'boolean') throw new Error(`${label} ${key} must be boolean.`);
  }
}

function assertNonNegativeIntegers(value, keys, label) {
  for (const key of keys) {
    if (!Number.isInteger(value[key]) || value[key] < 0) {
      throw new Error(`${label} ${key} must be a non-negative integer.`);
    }
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
}

function assertExactStringArray(value, label) {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string') ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${label} must be an exact duplicate-free string array.`);
  }
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const exact = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(exact)) {
    throw new Error(`${label} keys differ from the exact schema.`);
  }
}

function assertGitObjectId(value, label) {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(String(value || ''))) {
    throw new Error(`${label} is malformed.`);
  }
}

function assertSha256(value, label) {
  if (!isSha256(value)) throw new Error(`${label} is malformed.`);
}

function assertSemanticVersion(value, label) {
  if (!/^\d+\.\d+\.\d+$/.test(String(value || ''))) throw new Error(`${label} is malformed.`);
}

function assertIsoTimestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/u.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} is not an ISO timestamp.`);
  }
}

function decodeExactBase64(value) {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('Semantic raw evidence base64 is not canonical.');
  return bytes;
}

function aggregateAssertionStates(states) {
  if (states.includes('failed')) return 'failed';
  if (states.includes('not_run')) return 'not_run';
  return states.length > 0 && states.every((state) => state === 'passed') ? 'passed' : 'not_run';
}

function assertImplementedInventory() {
  for (const [key, config] of IMPLEMENTED) {
    const scenario = canonicalScenario(config.scenarioId);
    if (
      !scenario.requiredAssertions.includes(config.assertionId) ||
      key !== registryKey(config.scenarioId, config.assertionId)
    ) {
      throw new Error(`Implemented semantic validator is not canonical: ${key}.`);
    }
  }
}

function registryKey(scenarioId, assertionId) {
  return `${scenarioId}\0${assertionId}`;
}

function isStableId(value) {
  return /^[a-z0-9][a-z0-9._-]{0,127}$/.test(String(value || ''));
}

function isSha256(value) {
  return /^[A-F0-9]{64}$/.test(String(value || ''));
}

function exactArray(actual, expected) {
  return Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected);
}

function canonicalJsonBytes(value) {
  return Buffer.from(`${stableJson(value)}\n`, 'utf8');
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

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  CANONICAL_BROWSER_MATRIX,
  CANONICAL_BROWSER_MATRIX_SHA256,
  INTERNAL_SETTINGS,
  SETTINGS_DEFAULTS,
  VISIBLE_SETTINGS
} from './canonical-matrix.mjs';
import { FIXTURE_ALLOWED_METHODS, FIXTURE_ALLOWED_ROUTES, SYNTHETIC_FIXTURE_HOSTS } from '../fixture-server.mjs';
import {
  EXACT_ORIGIN_BROWSER_STORAGE_LIMITATION,
  SELECTED_SITE_PARTITION_STORAGE_DISCLOSURE
} from '../../../src/shared/storage-partition-policy.js';
import {
  SEMANTIC_OBSERVATION_MEDIA_TYPE,
  SEMANTIC_OBSERVATION_SCHEMA,
  SEMANTIC_RAW_EVIDENCE_SCHEMA,
  SEMANTIC_VALIDATOR_MANIFEST,
  SEMANTIC_VALIDATOR_MANIFEST_SHA256,
  SETTINGS_SEMANTIC_CONTRACT,
  createSemanticObservation,
  createSemanticObservationEvidence,
  decodeSemanticObservationEvidence,
  deriveSemanticAssertion,
  deriveSemanticScenarioAssertions,
  semanticBindingFromScenarioResult,
  semanticScenarioImplementationStatus,
  semanticValidatorEntry
} from './semantic-validator.mjs';

const startedAt = '2026-08-25T12:00:00.000Z';
const capturedAt = '2026-08-25T12:00:05.000Z';
const completedAt = '2026-08-25T12:00:10.000Z';
const fixedFixtureBindAddresses = ['127.0.0.1', '::1'];
const reviewedPatterns = [
  'http://*.example.com/*',
  'http://example.com/*',
  'https://*.example.com/*',
  'https://example.com/*'
];

function syntheticPrivateWindowsPath(...segments) {
  return ['C:', 'Users', 'private-person', ...segments].join('\\');
}

function syntheticPrivateFileUrl(...segments) {
  return `file:///${['C:', 'Users', 'private-person', ...segments].join('/')}`;
}

test('validator manifest covers every canonical assertion exactly once with an explicit status', () => {
  const canonical = CANONICAL_BROWSER_MATRIX.flatMap((scenario) =>
    scenario.requiredAssertions.map((assertionId) => `${scenario.id}\0${assertionId}`)
  );
  const manifested = SEMANTIC_VALIDATOR_MANIFEST.entries.map(
    ({ scenarioId, assertionId }) => `${scenarioId}\0${assertionId}`
  );

  assert.deepEqual(manifested, canonical);
  assert.equal(new Set(manifested).size, canonical.length);
  assert.equal(SEMANTIC_VALIDATOR_MANIFEST.entries.filter(({ status }) => status === 'implemented').length, 72);
  assert.equal(
    SEMANTIC_VALIDATOR_MANIFEST.entries.filter(({ status }) => status === 'not_implemented').length,
    canonical.length - 72
  );
  assert.match(SEMANTIC_VALIDATOR_MANIFEST_SHA256, /^[A-F0-9]{64}$/);
  assert.equal(Object.isFrozen(SEMANTIC_VALIDATOR_MANIFEST), true);
  assert.equal(Object.isFrozen(SEMANTIC_VALIDATOR_MANIFEST.entries), true);

  assert.equal(semanticScenarioImplementationStatus('ART-01'), 'implemented');
  assert.equal(semanticScenarioImplementationStatus('SW036-01'), 'partial');
  assert.equal(semanticScenarioImplementationStatus('UPG-01'), 'not_implemented');
  assert.equal(semanticValidatorEntry('UPG-01', 'upgrade.trusted_baseline').status, 'not_implemented');
  const smokeMutationValidator = semanticValidatorEntry('SMOKE-01', 'load.no_permission_or_cleanup');
  assert.equal(smokeMutationValidator.validatorVersion, 4);
  assert.equal(smokeMutationValidator.payloadSchema, 'smoke.no-authority-or-mutation.v4');
});

test('all 72 implemented validators derive pass from their exact typed path-free observations', () => {
  for (const scenario of CANONICAL_BROWSER_MATRIX) {
    const result = sampleResult(scenario.id);
    const binding = semanticBindingFromScenarioResult(result);
    result.evidence = SEMANTIC_VALIDATOR_MANIFEST.entries
      .filter(({ scenarioId, status }) => scenarioId === scenario.id && status === 'implemented')
      .map(({ assertionId }, index) =>
        createSemanticObservationEvidence({
          binding,
          assertionId,
          observationId: evidenceId(assertionId, index),
          payload: samplePayload(assertionId, binding),
          capturedAt,
          sequence: index
        })
      );

    const derived = deriveSemanticScenarioAssertions({ result });
    for (const entry of SEMANTIC_VALIDATOR_MANIFEST.entries.filter(
      ({ scenarioId, status }) => scenarioId === scenario.id && status === 'implemented'
    )) {
      assert.equal(
        derived.assertions.find(({ id }) => id === entry.assertionId)?.state,
        'passed',
        `${scenario.id}/${entry.assertionId}`
      );
    }
    for (const entry of SEMANTIC_VALIDATOR_MANIFEST.entries.filter(
      ({ scenarioId, status }) => scenarioId === scenario.id && status === 'not_implemented'
    )) {
      assert.equal(
        derived.assertions.find(({ id }) => id === entry.assertionId)?.state,
        'not_run',
        `${scenario.id}/${entry.assertionId}`
      );
    }
    const expectedScenarioState =
      semanticScenarioImplementationStatus(scenario.id) === 'implemented'
        ? 'passed'
        : semanticScenarioImplementationStatus(scenario.id) === 'partial'
          ? 'not_run'
          : 'not_run';
    assert.equal(derived.state, expectedScenarioState, scenario.id);
  }
});

test('each implemented validator rejects a decisive semantic mutation', () => {
  for (const entry of SEMANTIC_VALIDATOR_MANIFEST.entries.filter(({ status }) => status === 'implemented')) {
    const result = sampleResult(entry.scenarioId);
    const binding = semanticBindingFromScenarioResult(result);
    const payload = samplePayload(entry.assertionId, binding);
    mutateDecisiveField(entry.assertionId, payload);
    result.evidence = [
      createSemanticObservationEvidence({
        binding,
        assertionId: entry.assertionId,
        observationId: evidenceId(entry.assertionId, 0),
        payload,
        capturedAt
      })
    ];
    const derived = deriveSemanticAssertion({ result, assertionId: entry.assertionId });
    assert.equal(derived.state, 'failed', `${entry.scenarioId}/${entry.assertionId}`);
  }
});

test('SMOKE no-authority validation rejects empty no-op state and same-count inventory or value mutation', () => {
  const mutations = [
    (payload) => {
      payload.fixtureBeforeDataEntryCount = 0;
      payload.fixtureAfterDataEntryCount = 0;
      payload.fixtureBeforeStorageKindCount = 0;
      payload.fixtureAfterStorageKindCount = 0;
    },
    (payload) => {
      payload.fixtureAfterInventorySha256 = '8'.repeat(64);
    },
    (payload) => {
      payload.fixtureAfterValueSha256 = '9'.repeat(64);
    },
    (payload) => {
      payload.fixtureSeeded = false;
    },
    (payload) => {
      payload.fixtureBeforeValueSha256 = payload.fixtureBeforeInventorySha256;
      payload.fixtureAfterValueSha256 = payload.fixtureAfterInventorySha256;
    },
    (payload) => {
      payload.fixtureSeedDataEntryCount += 1;
    },
    (payload) => {
      payload.fixtureSeedInventorySha256 = '8'.repeat(64);
    },
    (payload) => {
      payload.fixtureSeedStorageKindCount += 1;
    },
    (payload) => {
      payload.fixtureSeedValueSha256 = '9'.repeat(64);
    },
    (payload) => {
      payload.initialLocalAuthorityEntryCount = 1;
    },
    (payload) => {
      payload.finalSessionAuthorityEntryCount = 1;
    },
    (payload) => {
      payload.localAuthorityChangedKeyCount = 1;
    },
    (payload) => {
      payload.permissionAddedEventCount = 1;
    },
    (payload) => {
      payload.permissionRemovedEventCount = 1;
    },
    (payload) => {
      payload.downloadCreatedEventCount = 1;
    },
    (payload) => {
      payload.downloadErasedEventCount = 1;
    },
    (payload) => {
      payload.nativePermissionPromptObserved = true;
    },
    (payload) => {
      payload.nativeObservationObservedAt = '2026-08-25T12:00:04.000Z';
    },
    (payload) => {
      payload.dnrPollNonemptyCount = 1;
    },
    (payload) => {
      payload.dnrPollErrorCount = 1;
    },
    (payload) => {
      payload.monitorBaselineAcknowledgedCount = 0;
    },
    (payload) => {
      payload.monitorObservationReadyAt = '2026-08-25T12:00:00.000Z';
    },
    (payload) => {
      payload.monitorCoverageObservedAt = '2026-08-25T12:00:05.000Z';
    },
    (payload) => {
      payload.startupSourceRouteContractMatched = false;
    }
  ];
  for (const [index, mutate] of mutations.entries()) {
    const result = sampleResult('SMOKE-01');
    const binding = semanticBindingFromScenarioResult(result);
    const payload = samplePayload('load.no_permission_or_cleanup', binding);
    mutate(payload);
    result.evidence = [
      createSemanticObservationEvidence({
        binding,
        assertionId: 'load.no_permission_or_cleanup',
        observationId: `smoke.no-authority.negative-${index}`,
        payload,
        capturedAt
      })
    ];
    assert.equal(deriveSemanticAssertion({ result, assertionId: 'load.no_permission_or_cleanup' }).state, 'failed');
  }
});

test('missing, duplicate, dummy, tampered, and runner-claimed evidence cannot pass', () => {
  const result = sampleResult('ART-01');
  result.assertions = [{ id: 'source.exact_head', state: 'passed' }];
  result.declaredState = 'passed';
  result.evidence = [];
  assert.equal(deriveSemanticAssertion({ result, assertionId: 'source.exact_head' }).state, 'not_run');

  const binding = semanticBindingFromScenarioResult(result);
  const first = createSemanticObservationEvidence({
    binding,
    assertionId: 'source.exact_head',
    observationId: 'source.exact_head.one',
    payload: samplePayload('source.exact_head', binding),
    capturedAt,
    sequence: 1
  });
  const second = createSemanticObservationEvidence({
    binding,
    assertionId: 'source.exact_head',
    observationId: 'source.exact_head.two',
    payload: samplePayload('source.exact_head', binding),
    capturedAt,
    sequence: 2
  });
  result.evidence = [first, second];
  assert.equal(deriveSemanticAssertion({ result, assertionId: 'source.exact_head' }).state, 'failed');

  result.evidence = [rawJsonEvidence('source.exact_head.dummy', { passed: true })];
  assert.throws(() => deriveSemanticScenarioAssertions({ result }), /keys differ|observation/i);

  const tampered = structuredClone(first);
  tampered.contentBase64 = Buffer.from('tampered\n').toString('base64');
  result.evidence = [tampered];
  assert.throws(() => deriveSemanticScenarioAssertions({ result }), /bytes or SHA-256/i);
});

test('observations cannot cross browser, scenario, run, plan, identity, manifest, or time boundaries', () => {
  const chromeResult = sampleResult('ART-01');
  const chromeBinding = semanticBindingFromScenarioResult(chromeResult);
  const evidence = createSemanticObservationEvidence({
    binding: chromeBinding,
    assertionId: 'source.exact_head',
    observationId: 'source.exact_head.boundary',
    payload: samplePayload('source.exact_head', chromeBinding),
    capturedAt
  });

  const braveResult = sampleResult('ART-01', 'brave');
  braveResult.evidence = [evidence];
  assert.throws(() => deriveSemanticScenarioAssertions({ result: braveResult }), /browser identity crosses/i);

  const smokeResult = sampleResult('SMOKE-01');
  smokeResult.evidence = [evidence];
  assert.throws(() => deriveSemanticScenarioAssertions({ result: smokeResult }), /run, plan|scenario boundary/i);

  for (const mutate of [
    (observation) => {
      observation.runId = `sitewipe-browser-${'f'.repeat(32)}`;
    },
    (observation) => {
      observation.planSha256 = 'F'.repeat(64);
    },
    (observation) => {
      observation.identity.artifactSha256 = 'F'.repeat(64);
    },
    (observation) => {
      observation.validatorManifestSha256 = 'F'.repeat(64);
    },
    (observation) => {
      observation.capturedAt = '2026-08-25T12:01:00.000Z';
    }
  ]) {
    const observation = decodeSemanticObservationEvidence(evidence, { binding: chromeBinding });
    const changed = structuredClone(observation);
    mutate(changed);
    chromeResult.evidence = [rawJsonEvidence(changed.observationId, changed)];
    assert.throws(() => deriveSemanticScenarioAssertions({ result: chromeResult }), /bound|crosses|interval/i);
  }
});

test('typed observations reject paths, file URIs, secret/capability/cookie/base64 fields, usernames, and arbitrary URLs', () => {
  const result = sampleResult('REV-01');
  const binding = semanticBindingFromScenarioResult(result);
  const base = samplePayload('review.standard_complete', binding);
  const cases = [
    ['local_path', syntheticPrivateWindowsPath('profile')],
    ['receipt_uri', syntheticPrivateFileUrl('receipt.json')],
    ['secret_token', 'plaintext-secret'],
    ['handoff_capability', 'secret-capability'],
    ['cookie_value', 'session=private'],
    ['evidence_base64', 'cHJpdmF0ZQ=='],
    ['username', 'private-person']
  ];
  for (const [key, value] of cases) {
    const payload = { ...structuredClone(base), [key]: value };
    assert.throws(
      () =>
        createSemanticObservation({
          binding,
          assertionId: 'review.standard_complete',
          observationId: `review.standard.${key.replaceAll('_', '-')}`,
          payload,
          capturedAt
        }),
      /forbidden private field|local path|arbitrary URL/i,
      key
    );
  }

  for (const targetDomain of ['https://personal.example/private?q=1', 'file:///C:/private.txt']) {
    const payload = { ...structuredClone(base), targetDomain };
    assert.throws(
      () =>
        createSemanticObservation({
          binding,
          assertionId: 'review.standard_complete',
          observationId: 'review.standard.arbitrary-url',
          payload,
          capturedAt
        }),
      /arbitrary URL|local path/i
    );
  }
});

test('raw observation wrapper and observation schema are exact and canonical', () => {
  const result = sampleResult('SMOKE-01');
  const binding = semanticBindingFromScenarioResult(result);
  const evidence = createSemanticObservationEvidence({
    binding,
    assertionId: 'install.fresh_profile',
    observationId: 'install.fresh-profile.schema',
    payload: samplePayload('install.fresh_profile', binding),
    capturedAt
  });
  const decoded = decodeSemanticObservationEvidence(evidence, { binding });
  assert.equal(decoded.schema, SEMANTIC_OBSERVATION_SCHEMA);
  assert.equal(decoded.matrixSha256, CANONICAL_BROWSER_MATRIX_SHA256);
  assert.equal(decoded.validatorManifestSha256, SEMANTIC_VALIDATOR_MANIFEST_SHA256);

  const extraWrapperKey = { ...evidence, state: 'passed' };
  assert.throws(() => decodeSemanticObservationEvidence(extraWrapperKey, { binding }), /keys differ/i);

  const changedObservation = structuredClone(decoded);
  changedObservation.state = 'passed';
  assert.throws(
    () =>
      decodeSemanticObservationEvidence(rawJsonEvidence(changedObservation.observationId, changedObservation), {
        binding
      }),
    /keys differ/i
  );

  const noncanonical = structuredClone(evidence);
  const pretty = Buffer.from(`${JSON.stringify(decoded, null, 2)}\n`);
  noncanonical.bytes = pretty.length;
  noncanonical.sha256 = sha256(pretty);
  noncanonical.contentBase64 = pretty.toString('base64');
  assert.throws(() => decodeSemanticObservationEvidence(noncanonical, { binding }), /not canonical JSON/i);

  const oversizedEncoding = {
    ...evidence,
    bytes: 1,
    contentBase64: 'A'.repeat(400_000)
  };
  assert.throws(() => decodeSemanticObservationEvidence(oversizedEncoding, { binding }), /bounded size/i);
});

test('externally supplied bindings cannot smuggle paths or nonnumeric browser versions', () => {
  const result = sampleResult('SMOKE-01');
  const binding = semanticBindingFromScenarioResult(result);
  const payload = samplePayload('install.fresh_profile', binding);

  const pathBearingBinding = structuredClone(binding);
  pathBearingBinding.browser.executablePath = result.browser.executablePath;
  assert.throws(
    () =>
      createSemanticObservation({
        binding: pathBearingBinding,
        assertionId: 'install.fresh_profile',
        observationId: 'install.fresh-profile.path-bearing-binding',
        payload,
        capturedAt
      }),
    /browser identity keys differ/i
  );

  const pathDisguisedAsVersion = structuredClone(binding);
  pathDisguisedAsVersion.browser.version = syntheticPrivateWindowsPath('chrome.exe');
  assert.throws(
    () =>
      createSemanticObservation({
        binding: pathDisguisedAsVersion,
        assertionId: 'install.fresh_profile',
        observationId: 'install.fresh-profile.path-version',
        payload,
        capturedAt
      }),
    /unknown browser or version/i
  );
});

function sampleResult(scenarioId, browserName = 'chrome') {
  return {
    scenarioId,
    runId: `sitewipe-browser-${'a'.repeat(32)}`,
    planSha256: '9'.repeat(64),
    startedAt,
    completedAt,
    browser: {
      name: browserName,
      version: browserName === 'chrome' ? '151.0.7922.174' : '151.1.93.138',
      executableSha256: browserName === 'chrome' ? '8'.repeat(64) : '7'.repeat(64),
      executablePath:
        browserName === 'chrome'
          ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
          : 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
    },
    identity: sampleIdentity(),
    evidence: [],
    assertions: [],
    declaredState: 'not_run'
  };
}

function sampleIdentity() {
  return {
    sourceCommitSha: 'a'.repeat(40),
    sourceTreeSha: 'b'.repeat(40),
    artifactVersion: '1.11.90',
    artifactBytes: 355_074,
    artifactSha256: 'A'.repeat(64),
    browserRuntimeSetSha256: '2'.repeat(64),
    gitExecutableSha256: 'B'.repeat(64),
    harnessManifestSha256: 'C'.repeat(64),
    launchPolicySha256: '3'.repeat(64),
    nativeHelperSha256: 'D'.repeat(64),
    nodeExecutableSha256: 'E'.repeat(64),
    nodeRuntimeVersion: 'v24.18.0',
    packageLockSha256: 'F'.repeat(64),
    powerShellExecutableSha256: '4'.repeat(64),
    processObserverHelperSha256: '5'.repeat(64),
    releaseInputFingerprintSha256: '0'.repeat(64),
    runtimeFingerprintSha256: '1'.repeat(64),
    toolchainBytes: 24_314_357,
    toolchainFileCount: 2_227,
    toolchainPackageCount: 26,
    toolchainPuppeteerVersion: '25.8.0',
    toolchainSetSha256: '6'.repeat(64)
  };
}

function samplePayload(assertionId, binding) {
  if (assertionId.startsWith('setting.')) return sampleSettingPayload(assertionId.slice('setting.'.length));
  if (assertionId.startsWith('settings.')) return sampleSettingsAggregatePayload(assertionId);
  const hash = (character) => character.repeat(64);
  const payloads = {
    'source.exact_head': {
      clean: true,
      commitSha: binding.identity.sourceCommitSha,
      indexDeltaCount: 0,
      treeSha: binding.identity.sourceTreeSha,
      untrackedEntryCount: 0,
      worktreeDeltaCount: 0
    },
    'artifact.version_manifest_hash': {
      artifactBytes: binding.identity.artifactBytes,
      artifactSha256: binding.identity.artifactSha256,
      artifactVersion: binding.identity.artifactVersion,
      manifestSha256: hash('2'),
      manifestVersion: binding.identity.artifactVersion,
      runtimeEntryCount: 61,
      zipVerificationPassed: true
    },
    'artifact.source_runtime_parity': {
      artifactRuntimeFileCount: 61,
      artifactRuntimeFingerprintSha256: binding.identity.runtimeFingerprintSha256,
      mismatchCount: 0,
      sourceRuntimeFileCount: 61,
      sourceRuntimeFingerprintSha256: binding.identity.runtimeFingerprintSha256
    },
    'artifact.stale_ignored_candidate_rejected': {
      approvedArtifactSha256: binding.identity.artifactSha256,
      cases: [
        {
          candidateSha256: hash('3'),
          kind: 'ignored_candidate',
          rejected: true,
          rejectionCode: 'candidate_not_canonical'
        },
        {
          candidateSha256: hash('4'),
          kind: 'stale_candidate',
          rejected: true,
          rejectionCode: 'artifact_identity_mismatch'
        }
      ]
    },
    'install.fresh_profile': {
      extensionEnabled: true,
      extensionId: 'abcdefghijklmnopabcdefghijklmnop',
      extensionName: 'SiteWipe',
      extensionOriginScheme: 'chrome-extension',
      extensionVersion: binding.identity.artifactVersion,
      profileDataEntryCountBeforeLaunch: 0,
      profileOwnershipMarkerMatched: true,
      profileWasNew: true,
      syncEnabled: false
    },
    'defaults.safe': {
      settings: structuredClone(SETTINGS_DEFAULTS)
    },
    'surfaces.popup_options_sidepanel': {
      surfaces: [
        {
          documentTitle: 'SiteWipe',
          name: 'popup',
          originScheme: 'chrome-extension',
          readyState: 'complete',
          visible: true
        },
        {
          documentTitle: 'SiteWipe Options',
          name: 'options',
          originScheme: 'chrome-extension',
          readyState: 'complete',
          visible: true
        },
        {
          documentTitle: 'SiteWipe Report',
          name: 'sidepanel',
          originScheme: 'chrome-extension',
          readyState: 'complete',
          visible: true
        }
      ]
    },
    'load.no_permission_or_cleanup': {
      cleanupMutationCount: 0,
      dnrBaselineNonemptyCount: 0,
      dnrObservationMode: 'endpoint_snapshots_and_bounded_polling',
      dnrPollCount: 6,
      dnrPollErrorCount: 0,
      dnrPollIntervalMs: 100,
      dnrPollMaximumObservedGapMs: 100,
      dnrPollNonemptyCount: 0,
      dynamicDnrRuleCountAfter: 0,
      dynamicDnrRuleCountBefore: 0,
      dynamicDnrRulesAfterSha256: sha256(canonicalJsonBytes([])),
      dynamicDnrRulesBeforeSha256: sha256(canonicalJsonBytes([])),
      fixtureAfterDataEntryCount: 41,
      fixtureAfterInventorySha256: hash('5'),
      fixtureAfterStorageKindCount: 6,
      fixtureAfterValueSha256: hash('6'),
      fixtureBeforeDataEntryCount: 41,
      fixtureBeforeInventorySha256: hash('5'),
      fixtureBeforeStorageKindCount: 6,
      fixtureBeforeValueSha256: hash('6'),
      fixtureScale: 'small',
      fixtureSeedDataEntryCount: 41,
      fixtureSeedInventorySha256: hash('5'),
      fixtureSeedReceiptSha256: hash('7'),
      fixtureSeedStorageKindCount: 6,
      fixtureSeedValueSha256: hash('6'),
      fixtureSeeded: true,
      fixtureVersion: 'sitewipe-synthetic-v1',
      finalLocalAuthorityEntryCount: 0,
      finalSessionAuthorityEntryCount: 0,
      hostPermissionOrigins: [],
      initialLocalAuthorityEntryCount: 0,
      initialSessionAuthorityEntryCount: 0,
      localAuthorityChangedKeyCount: 0,
      monitorBaselineAcknowledgedCount: 1,
      monitorBaselineErrorCount: 0,
      monitorCoverageObservedAt: '2026-08-25T12:00:07.000Z',
      monitorCoverageSequence: 20,
      monitorDocumentReadyCount: 1,
      monitorObservationReadyAt: '2026-08-25T12:00:02.000Z',
      nativeObservationCoverageThrough: '2026-08-25T12:00:05.000Z',
      nativeObservationObservedAt: '2026-08-25T12:00:06.000Z',
      nativeObservationReadyAt: '2026-08-25T12:00:01.000Z',
      nativePermissionPromptObserved: false,
      observationReadinessBounded: true,
      permissionAddedEventCount: 0,
      permissionLeaseCount: 0,
      permissionRemovedEventCount: 0,
      reportCount: 0,
      runningJobCount: 0,
      sessionAuthorityChangedKeyCount: 0,
      sessionDnrRuleCountAfter: 0,
      sessionDnrRuleCountBefore: 0,
      sessionDnrRulesAfterSha256: sha256(canonicalJsonBytes([])),
      sessionDnrRulesBeforeSha256: sha256(canonicalJsonBytes([])),
      startupEndpointPreconditionPassed: true,
      startupSourceRouteContractMatched: true,
      startupSourceRouteContractSha256: hash('A'),
      downloadCreatedEventCount: 0,
      downloadErasedEventCount: 0
    },
    'review.standard_complete': {
      cleanupMutationCount: 0,
      displayed: Object.fromEntries(
        [
          'attempted',
          'effects',
          'hostPermissions',
          'normalizedTarget',
          'protected',
          'scope',
          'unavailable',
          'warnings',
          'windowScope'
        ].map((key) => [key, true])
      ),
      hostPermissionPatterns: [...reviewedPatterns],
      mode: 'standard',
      targetDomain: 'example.com'
    },
    'review.expert_complete': {
      cleanupMutationCount: 0,
      displayed: Object.fromEntries(
        [
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
        ].map((key) => [key, true])
      ),
      hostPermissionPatterns: [...reviewedPatterns],
      mode: 'expert',
      targetDomain: 'example.com'
    },
    'review.acknowledgements_required': {
      allAcknowledgedApprovalEnabled: true,
      associatedAcknowledgementRequired: true,
      filePhraseRequired: true,
      initialApprovalDisabled: true,
      localAcknowledgementRequired: true,
      protectedAcknowledgementRequired: true,
      scopeAcknowledgementRequired: true,
      wrongFilePhraseApprovalDisabled: true
    },
    'review.cancel_no_mutation': {
      cancelStatusObserved: true,
      downloadInventoryAfterSha256: hash('6'),
      downloadInventoryBeforeSha256: hash('6'),
      fixtureAfterSha256: hash('7'),
      fixtureBeforeSha256: hash('7'),
      permissionInventoryAfterSha256: hash('8'),
      permissionInventoryBeforeSha256: hash('8'),
      reportCount: 0,
      runningJobCount: 0
    },
    'sender.legitimate_action_without_document_id': {
      actionTargetType: 'page',
      activationApi: 'Extensions.triggerAction',
      cleanupMutationCount: 0,
      contextCount: 1,
      popupTargetTransition: 'other_to_page',
      reviewPrepared: true,
      senderDocumentIdPresent: false,
      senderTabId: -1,
      senderWindowId: -1
    },
    'network.host_route_method_allowlist': {
      allowedHosts: [...SYNTHETIC_FIXTURE_HOSTS],
      allowedMethods: [...FIXTURE_ALLOWED_METHODS],
      allowedRoutes: [...FIXTURE_ALLOWED_ROUTES],
      bindAddresses: [...fixedFixtureBindAddresses],
      policyRejectedRequestCount: 2,
      unexpectedAllowedRequestCount: 0
    },
    'network.per_run_token': {
      generatedAfterApproval: true,
      plaintextRetained: false,
      reuseCount: 0,
      secretBytes: 32,
      secretSha256: hash('9')
    },
    'network.outbound_blocked': {
      connectRequestsAllowed: 0,
      denyByDefault: true,
      directNonLoopbackConnectionsObserved: 0,
      nonLoopbackRequestsAllowed: 0,
      proxyLedgerSha256: hash('A'),
      resolverPolicySha256: hash('B'),
      transport: 'pipe_and_loopback_proxy'
    },
    'network.request_ledger_complete': {
      authorizedFixtureRequestCount: 4,
      browserRequestCount: 6,
      deniedRequestCount: 2,
      fixtureRequestCount: 4,
      ledgerSha256: hash('C'),
      proxyRequestCount: 6,
      unreconciledRequestCount: 0
    },
    'teardown.process_tree_exited': {
      allOwnedProcessesExited: true,
      browserProcessCountAfterClose: 0,
      browserProcessCountBeforeClose: 5,
      forcedTerminationUsed: false,
      profileBoundProcessCountAfterClose: 0,
      unownedProcessTerminated: false
    },
    'teardown.profile_runtime_download_identity': {
      downloadInventoryAfterSha256: hash('D'),
      downloadInventoryBeforeSha256: hash('D'),
      foreignEntryCount: 0,
      identityRevalidated: true,
      profileMarkerSha256: hash('E'),
      runtimeArtifactSha256: binding.identity.artifactSha256
    },
    'teardown.permissions_rules_jobs_leases_reconciled': {
      activeJobCount: 0,
      dnrRuleCount: 0,
      hostPermissionOriginCount: 0,
      permissionLeaseCount: 0,
      storageQuerySucceeded: true,
      unresolvedRecoveryCount: 0
    },
    'teardown.cleanup_or_quarantine_receipt': {
      action: 'retained',
      automaticRecursiveDeletionPerformed: false,
      markerMatched: true,
      receiptSha256: hash('F'),
      runIdMatched: true
    },
    'teardown.evidence_complete': {
      completedNonTeardownCellCount: 46,
      duplicateCellCount: 0,
      evidenceIntegrityFailureCount: 0,
      missingNonTeardownCellCount: 0,
      plannedCellCount: 48
    }
  };
  const payload = payloads[assertionId];
  if (!payload) throw new Error(`No sample semantic payload for ${assertionId}.`);
  return structuredClone(payload);
}

function sampleSettingPayload(key) {
  if (VISIBLE_SETTINGS.includes(key)) {
    const isSelect = Object.hasOwn(SETTINGS_SEMANTIC_CONTRACT.selectOptions, key);
    const isTextarea = key === 'associatedDomainGroups';
    const attemptedValue = SETTINGS_SEMANTIC_CONTRACT.exerciseValues[key];
    const observedValue = key === 'embeddedFrameDiscovery' ? false : attemptedValue;
    return {
      classification: 'visible',
      control: {
        ariaDescribedByBound: true,
        ariaLabelledByBound: true,
        initialEnabled: !SETTINGS_SEMANTIC_CONTRACT.initialDisabledIds.includes(key),
        inputType: isSelect ? 'select-one' : isTextarea ? 'textarea' : 'checkbox',
        optionValues: structuredClone(SETTINGS_SEMANTIC_CONTRACT.selectOptions[key] || []),
        present: true,
        tagName: isSelect ? 'SELECT' : isTextarea ? 'TEXTAREA' : 'INPUT'
      },
      exercise: {
        attemptedValue,
        observedAfterSave: observedValue,
        persistedAfterReload: observedValue,
        saveOutcome: key === 'embeddedFrameDiscovery' ? 'remained_off' : 'saved',
        storageRoundTripObserved: true
      },
      initialValue: SETTINGS_DEFAULTS[key],
      key,
      productionDefault: SETTINGS_DEFAULTS[key],
      resetValue: SETTINGS_DEFAULTS[key]
    };
  }
  if (!INTERNAL_SETTINGS.includes(key)) throw new Error(`Unknown settings sample key: ${key}.`);
  if (key === 'mainWorldPageScrub') {
    return {
      afterExerciseState: 'false',
      classification: 'internal',
      controlAbsent: true,
      initialState: 'false',
      key,
      preservedAcrossVisibleSaves: true,
      productionDefault: false,
      resetState: 'false',
      resetValueChanged: false
    };
  }
  return {
    afterExerciseState: 'timestamp',
    classification: 'internal',
    controlAbsent: true,
    initialState: 'timestamp',
    key,
    preservedAcrossVisibleSaves: key !== 'updatedAt',
    productionDefault: null,
    resetState: 'timestamp',
    resetValueChanged: true
  };
}

function sampleSettingsAggregatePayload(assertionId) {
  const payloads = {
    'settings.select_options_and_bounds': {
      controls: Object.entries(SETTINGS_SEMANTIC_CONTRACT.selectOptions).map(([id, optionValues]) => ({
        id,
        optionValues: structuredClone(optionValues)
      })),
      invalidPatchResult: {
        cleanupMode: 'standard',
        latestReportRetentionMinutes: 30,
        overlayScope: 'target_tabs',
        postWipeShieldExpiresMinutes: 0,
        reportRetentionDays: 7
      },
      productionDefaultsMatched: true
    },
    'settings.dependencies_and_expert_gating': {
      expertEnabledControlIds: structuredClone(SETTINGS_SEMANTIC_CONTRACT.expertControlIds),
      parentOffDisabledControlIds: structuredClone(SETTINGS_SEMANTIC_CONTRACT.dependencyGroups),
      safetyBoundary: settingsSafetyBoundary(),
      standardDisabledControlIds: structuredClone(SETTINGS_SEMANTIC_CONTRACT.expertControlIds),
      standardForcedValues: { embeddedFrameDiscovery: false, overlayScope: 'target_tabs' }
    },
    'settings.persistence_and_reset': {
      exercisedVisibleSettingCount: VISIBLE_SETTINGS.length,
      internalSettingCount: INTERNAL_SETTINGS.length,
      persistedVisibleSettingCount: VISIBLE_SETTINGS.length,
      reloadRenderedVisibleSettingCount: VISIBLE_SETTINGS.length,
      resetAcceptRestoredSettingCount: VISIBLE_SETTINGS.length + INTERNAL_SETTINGS.length,
      resetCancelPreserved: true,
      safetyBoundary: settingsSafetyBoundary(),
      visibleSettingCount: VISIBLE_SETTINGS.length
    },
    'settings.import_export': {
      downloadSafety: settingsDownloadSafety(),
      exportBytes: 4096,
      exportDownloadEntryCountAdded: 1,
      exportSchema: 'sitewipe.settings.backup',
      exportSchemaVersion: 1,
      exportSettingsSha256: 'A'.repeat(64),
      exportUserSettingCount: VISIBLE_SETTINGS.length,
      exported: true,
      importAcceptApplied: true,
      importCancelPreserved: true,
      importRecognizedSettingCount: VISIBLE_SETTINGS.length,
      importUnknownIgnoredCount: 1,
      ownedSyntheticImportUsed: true
    },
    'settings.sensitive_confirm_cancel_and_accept': {
      cases: sensitiveSettingsPromptCases(),
      safetyBoundary: settingsSafetyBoundary()
    },
    'settings.malformed_associated_groups': {
      safetyBoundary: settingsSafetyBoundary(),
      safetyToggleExercised: true,
      storageBounds: {
        diagnosticBoundReported: true,
        ignoredLineCount: 1,
        inputLineCount: 51,
        maxStoredLineCharacters: 500,
        retainedLineCount: 50,
        shortenedLineCount: 50
      },
      syntax: {
        ariaInvalid: true,
        diagnosticErrorTone: true,
        errorCount: 1,
        storedInputBounded: true
      }
    }
  };
  if (!payloads[assertionId]) throw new Error(`Unknown settings aggregate sample: ${assertionId}.`);
  return structuredClone(payloads[assertionId]);
}

function sensitiveSettingsPromptCases() {
  const reportPrompt =
    'Store sensitive cleanup report details? Full unredacted reports can contain browsing domains, URLs, filenames, local paths, and browser error details; indefinite retention keeps the latest report until you delete it. Choose Cancel to keep the current privacy-safe settings.';
  const skipPrompt = `Skip the detailed cleanup review completely for future cleanups? This applies in Standard and Expert mode. One popup cleanup action can immediately begin all currently enabled cleanup effects. ${SELECTED_SITE_PARTITION_STORAGE_DISCLOSURE} ${EXACT_ORIGIN_BROWSER_STORAGE_LIMITATION} Expert options can delete matched downloaded files or affect broader site data, and private-window data can be included when incognito access is enabled. Chrome or Brave may still require its own permission prompt. Choose Cancel to keep detailed review enabled.`;
  const resetPrompt = 'Reset SiteWipe settings to the privacy-safe defaults? Your current settings cannot be restored.';
  return [
    ['skipCleanupReview', skipPrompt],
    ['redactReports', reportPrompt],
    ['latestReportRetentionMinutes', reportPrompt],
    ['resetSettings', resetPrompt]
  ].map(([id, prompt]) => ({
    acceptObserved: true,
    cancelObserved: true,
    changedAfterAccept: true,
    id,
    promptSha256: sha256(prompt),
    unchangedAfterCancel: true
  }));
}

function settingsSafetyBoundary() {
  const permissionApis = [
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
  ].sort();
  const emptyObjectSha256 = sha256(canonicalJsonBytes({}));
  const emptyArraySha256 = sha256(canonicalJsonBytes([]));
  const permissionSha256 = sha256(canonicalJsonBytes({ origins: [], permissions: permissionApis }));
  return {
    schema: 'sitewipe.settings-safety-boundary.v2',
    observationScope: 'bounded_preload_monitoring',
    localAuthorityBeforeSha256: emptyObjectSha256,
    localAuthorityAfterSha256: emptyObjectSha256,
    localAuthorityEntryCountBefore: 0,
    localAuthorityEntryCountAfter: 0,
    sessionAuthorityBeforeSha256: emptyObjectSha256,
    sessionAuthorityAfterSha256: emptyObjectSha256,
    sessionAuthorityEntryCountBefore: 0,
    sessionAuthorityEntryCountAfter: 0,
    dynamicRulesBeforeSha256: emptyArraySha256,
    dynamicRulesAfterSha256: emptyArraySha256,
    dynamicRuleCountBefore: 0,
    dynamicRuleCountAfter: 0,
    sessionRulesBeforeSha256: emptyArraySha256,
    sessionRulesAfterSha256: emptyArraySha256,
    sessionRuleCountBefore: 0,
    sessionRuleCountAfter: 0,
    permissionsBeforeSha256: permissionSha256,
    permissionsAfterSha256: permissionSha256,
    permissionOriginCountBefore: 0,
    permissionOriginCountAfter: 0,
    permissionApiCountBefore: permissionApis.length,
    permissionApiCountAfter: permissionApis.length,
    permissionApis,
    permissionAddedEventCount: 0,
    permissionRemovedEventCount: 0,
    authorityStorageChangeCount: 0,
    monitoredLocalAuthorityKeys: [
      'sitewipe.activeJob.v1',
      'sitewipe.activeShield.v1',
      'sitewipe.permissionLease.v1',
      'sitewipe.activeReport.v1',
      'sitewipe.reports.v1',
      'sitewipe.dnrPendingMutation.v1'
    ],
    monitoredSessionAuthorityKeys: [
      'sitewipe.cleanupReview.v1',
      'sitewipe.cleanupPermissionHandoff.v1',
      'sitewipe.dnrPendingMutation.session.v1'
    ],
    preloadDocumentReadyCountBefore: 1,
    preloadDocumentReadyCountAfter: 5,
    dnrPollIntervalMs: 100,
    dnrPollCountBefore: 1,
    dnrPollCountAfter: 20,
    dnrPollMaxGapMs: 120,
    dnrPollNonemptyCount: 0,
    dnrPollErrorCount: 0,
    incognitoAllowedBefore: false,
    incognitoAllowedAfter: false,
    nativeObservationScheduleId: 'SETTINGS-01.observe-none',
    nativeObservationStatus: 'no_prompt_observed',
    nativeReadinessStatus: 'ready',
    nativeControlledStopObserved: true,
    nativeObservationSettledBeforeFinalCapture: true,
    closeObservationStatus: 'clean',
    closeResidueCount: 0,
    closeCanaryPreserved: true,
    automaticProfileDeletionPerformed: false,
    automaticDownloadDeletionPerformed: false
  };
}

function settingsDownloadSafety() {
  const before = ['.sitewipe-must-preserve-download.bin', '.sitewipe-owned-browser-directory.json'].sort();
  const after = [...before, '.sitewipe-owned-settings-import.json', 'sitewipe-settings-1770000000000.json'].sort();
  return {
    schema: 'sitewipe.settings-owned-download-safety.v2',
    scopeBoundary: 'owned_disposable_cell_only',
    browserRecordCountBefore: 0,
    browserRecordCountAfter: 1,
    browserExport: {
      bytesReceived: 4096,
      danger: 'safe',
      exists: true,
      namePatternMatched: true,
      paused: false,
      state: 'complete',
      totalBytes: 4096
    },
    ownedEntryNamesBefore: before,
    ownedEntryNamesBeforeClose: after,
    ownedEntryNamesAfterClose: after,
    ownedSetBeforeSha256: 'B'.repeat(64),
    ownedSetBeforeCloseSha256: 'C'.repeat(64),
    ownedSetAfterCloseSha256: 'C'.repeat(64),
    ownedParentIdentitySha256: '9'.repeat(64),
    exportFileSha256: 'D'.repeat(64),
    importFileSha256: 'E'.repeat(64),
    canarySha256: 'F'.repeat(64),
    canaryPreservedAfterClose: true,
    automaticDownloadDeletionPerformed: false,
    browserDownloadCreatedEventCount: 1,
    browserDownloadErasedEventCount: 0,
    foreignEntryCount: 0,
    parentIdentityMatchedThroughClose: true,
    exportPhysicalIdentityRetained: true,
    importPhysicalIdentityRetained: true,
    precloseAndPostcloseOwnedSetMatched: true
  };
}

function mutateDecisiveField(assertionId, payload) {
  if (assertionId.startsWith('setting.')) {
    payload.classification = 'wrong';
    return;
  }
  const settingsMutations = {
    'settings.select_options_and_bounds': () => {
      payload.invalidPatchResult.reportRetentionDays = 30;
    },
    'settings.dependencies_and_expert_gating': () => {
      payload.safetyBoundary.permissionAddedEventCount = 1;
    },
    'settings.persistence_and_reset': () => {
      payload.persistedVisibleSettingCount -= 1;
    },
    'settings.import_export': () => {
      payload.downloadSafety.foreignEntryCount = 1;
    },
    'settings.sensitive_confirm_cancel_and_accept': () => {
      payload.cases[0].unchangedAfterCancel = false;
    },
    'settings.malformed_associated_groups': () => {
      payload.syntax.errorCount = 0;
    }
  };
  if (settingsMutations[assertionId]) {
    settingsMutations[assertionId]();
    return;
  }
  const mutations = {
    'source.exact_head': () => {
      payload.clean = false;
    },
    'artifact.version_manifest_hash': () => {
      payload.artifactSha256 = 'F'.repeat(64);
    },
    'artifact.source_runtime_parity': () => {
      payload.mismatchCount = 1;
    },
    'artifact.stale_ignored_candidate_rejected': () => {
      payload.cases[0].rejected = false;
    },
    'install.fresh_profile': () => {
      payload.profileWasNew = false;
    },
    'defaults.safe': () => {
      payload.settings.deleteDownloadedFiles = true;
    },
    'surfaces.popup_options_sidepanel': () => {
      payload.surfaces[0].visible = false;
    },
    'load.no_permission_or_cleanup': () => {
      payload.permissionAddedEventCount = 1;
    },
    'review.standard_complete': () => {
      payload.displayed.effects = false;
    },
    'review.expert_complete': () => {
      payload.displayed.associatedTargets = false;
    },
    'review.acknowledgements_required': () => {
      payload.initialApprovalDisabled = false;
    },
    'review.cancel_no_mutation': () => {
      payload.reportCount = 1;
    },
    'sender.legitimate_action_without_document_id': () => {
      payload.senderDocumentIdPresent = true;
    },
    'network.host_route_method_allowlist': () => {
      payload.unexpectedAllowedRequestCount = 1;
    },
    'network.per_run_token': () => {
      payload.secretBytes = 31;
    },
    'network.outbound_blocked': () => {
      payload.nonLoopbackRequestsAllowed = 1;
    },
    'network.request_ledger_complete': () => {
      payload.unreconciledRequestCount = 1;
    },
    'teardown.process_tree_exited': () => {
      payload.browserProcessCountAfterClose = 1;
    },
    'teardown.profile_runtime_download_identity': () => {
      payload.identityRevalidated = false;
    },
    'teardown.permissions_rules_jobs_leases_reconciled': () => {
      payload.activeJobCount = 1;
    },
    'teardown.cleanup_or_quarantine_receipt': () => {
      payload.markerMatched = false;
    },
    'teardown.evidence_complete': () => {
      payload.missingNonTeardownCellCount = 1;
    }
  };
  const mutate = mutations[assertionId];
  if (!mutate) throw new Error(`No decisive mutation for ${assertionId}.`);
  mutate();
}

function evidenceId(assertionId, index) {
  return `${assertionId.replaceAll('_', '-').toLowerCase()}.${index}`.slice(0, 128);
}

function rawJsonEvidence(id, value) {
  const bytes = canonicalJsonBytes(value);
  return {
    schema: SEMANTIC_RAW_EVIDENCE_SCHEMA,
    id,
    mediaType: SEMANTIC_OBSERVATION_MEDIA_TYPE,
    bytes: bytes.length,
    sha256: sha256(bytes),
    contentBase64: bytes.toString('base64')
  };
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

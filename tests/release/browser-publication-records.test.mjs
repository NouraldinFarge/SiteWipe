import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  BROWSER_PUBLICATION_RECORDS_SCHEMA,
  applyBrowserPublicationRecords,
  createBrowserPublicationRecords,
  validateBrowserPublicationRecords
} from '../../scripts/browser-publication-records.mjs';
import {
  BROWSER_PUBLIC_SEMANTIC_REPLAY,
  validateBrowserSemanticReceipts
} from '../../scripts/browser-semantic-receipts.mjs';
import {
  FIXTURE_ALLOWED_METHODS,
  FIXTURE_ALLOWED_ROUTES,
  SYNTHETIC_FIXTURE_HOSTS
} from '../../tests/browser/fixture-server.mjs';
import {
  BROWSER_MATRIX_VERSION,
  CANONICAL_BROWSER_MATRIX,
  CANONICAL_BROWSER_MATRIX_IDS,
  CANONICAL_BROWSER_MATRIX_SHA256,
  REQUIRED_BROWSERS,
  SETTINGS_DEFAULTS
} from '../../tests/browser/installed/canonical-matrix.mjs';
import {
  APPROVED_UNATTENDED_ACTIONS,
  BROWSER_PLAN_SCHEMA,
  FIXED_FIXTURE_BIND_ADDRESSES,
  SCENARIO_RESULT_SCHEMA,
  aggregateBrowserEvidence,
  computeAggregateSha256,
  computePlanSha256,
  createScenarioResultRecord
} from '../../tests/browser/installed/evidence-contract.mjs';
import { computeBrowserRuntimeSetSha256 } from '../../tests/browser/installed/browser-runtime-closure.mjs';
import { INSTALLED_RUNTIME_LAUNCH_POLICY_SHA256 } from '../../tests/browser/installed/launch-policy.mjs';
import {
  NATIVE_PROMPT_ALLOWED_ACTIONS,
  NATIVE_PROMPT_EXPECTED_FRAGMENTS,
  NATIVE_PROMPT_PERMISSION_PATTERNS,
  NATIVE_PROMPT_POLICY_SHA256,
  NATIVE_PROMPT_SCENARIO_SCHEDULE,
  NATIVE_PROMPT_UIA_SNAPSHOTS
} from '../../tests/browser/installed/native-permission-dialog.mjs';
import {
  SEMANTIC_VALIDATOR_MANIFEST_SHA256,
  createSemanticObservationEvidence,
  semanticBindingFromScenarioResult
} from '../../tests/browser/installed/semantic-validator.mjs';
import { PINNED_PUPPETEER_CORE_VERSION } from '../../tests/browser/installed/toolchain-closure.mjs';

const timestamp = '2026-08-25T20:00:00.000Z';

test('creates exact path-free retained commitments and 24 not-run assertions for each browser', () => {
  const fixture = runFixture();
  const records = createBrowserPublicationRecords(fixture);

  assert.equal(records.schema, BROWSER_PUBLICATION_RECORDS_SCHEMA);
  assert.equal(records.technicalStatus, 'not_run');
  assert.equal(records.installedEvidence.resultRecordCount, 48);
  assert.equal(records.semanticReceipts.cells.length, 48);
  assert.equal(records.semanticReceipts.resultRecordCount, 48);
  assert.equal(records.installedEvidence.aggregateSha256, fixture.completion.aggregateSha256);
  assert.equal(records.installedEvidence.resultSetSha256, fixture.aggregate.resultSetSha256);
  assert.equal(records.installedEvidence.publicSemanticReplay, BROWSER_PUBLIC_SEMANTIC_REPLAY);
  assert.equal(Object.isFrozen(records), true);

  for (const browserName of REQUIRED_BROWSERS) {
    const summary = records[browserName];
    assert.equal(summary.status, 'not_run');
    assert.equal(summary.disposableProfile, false);
    assert.equal(summary.assertions.length, 24);
    assert.deepEqual(
      summary.assertions.map(({ matrixCoverage }) => matrixCoverage[0]),
      CANONICAL_BROWSER_MATRIX_IDS
    );
    assert.ok(summary.assertions.every(({ status }) => status === 'not_run'));
  }
  assert.equal(validateBrowserPublicationRecords(records, fixture), records);
});

test('preserves genuine passed cells while every partial or not-run cell remains non-passing', () => {
  const fixture = runFixture({ passSmoke: true });
  const records = createBrowserPublicationRecords(fixture);

  assert.equal(records.technicalStatus, 'not_run');
  for (const browserName of REQUIRED_BROWSERS) {
    const smoke = records[browserName].assertions.find(({ matrixCoverage }) => matrixCoverage[0] === 'SMOKE-01');
    const art = records[browserName].assertions.find(({ matrixCoverage }) => matrixCoverage[0] === 'ART-01');
    assert.equal(smoke.status, 'passed');
    assert.equal(art.status, 'not_run');
    assert.equal(records[browserName].status, 'not_run');
    assert.equal(records[browserName].disposableProfile, true);
  }
  assert.equal(records.semanticReceipts.cells.filter(({ state }) => state === 'passed').length, 2);
  assert.equal(records.semanticReceipts.cells.filter(({ state }) => state === 'not_run').length, 46);
});

test('an authentic partial SMOKE result cannot become a passing publication record', () => {
  const fixture = runFixture({ partialSmoke: true });
  const records = createBrowserPublicationRecords(fixture);

  for (const browserName of REQUIRED_BROWSERS) {
    const smoke = records[browserName].assertions.find(({ matrixCoverage }) => matrixCoverage[0] === 'SMOKE-01');
    assert.equal(smoke.status, 'not_run');
    assert.equal(records[browserName].disposableProfile, false);
  }
  assert.equal(records.semanticReceipts.cells.filter(({ scenarioId }) => scenarioId === 'SMOKE-01').length, 2);
  assert.ok(
    records.semanticReceipts.cells
      .filter(({ scenarioId }) => scenarioId === 'SMOKE-01')
      .every(({ state }) => state === 'not_run')
  );
});

test('rejects completion, aggregate, assertion-summary, and semantic-receipt tampering', () => {
  const fixture = runFixture({ passSmoke: true });
  const wrongCompletion = structuredClone(fixture.completion);
  wrongCompletion.aggregateSha256 = 'F'.repeat(64);
  assert.throws(
    () => createBrowserPublicationRecords({ ...fixture, completion: wrongCompletion }),
    /completion does not exactly bind/
  );

  const wrongAggregate = structuredClone(fixture.aggregate);
  wrongAggregate.resultRecords[0].sha256 = 'E'.repeat(64);
  assert.throws(
    () => createBrowserPublicationRecords({ ...fixture, aggregate: wrongAggregate }),
    /raw-result binding|mechanical replay/
  );

  const records = createBrowserPublicationRecords(fixture);
  const wrongAssertion = structuredClone(records);
  wrongAssertion.chrome.assertions[0].status = 'passed';
  assert.throws(
    () => validateBrowserPublicationRecords(wrongAssertion, fixture),
    /launders|mechanical private-run projection/
  );

  const wrongReceipt = structuredClone(records);
  wrongReceipt.semanticReceipts.aggregateSha256 = 'D'.repeat(64);
  assert.throws(
    () => validateBrowserPublicationRecords(wrongReceipt, fixture),
    /independently expected|mechanical private-run projection/
  );
});

test('contains no path, token, raw evidence, or reviewer-approval authority and exactly binds the semantic receipt', () => {
  const fixture = runFixture({ passSmoke: true });
  const records = createBrowserPublicationRecords(fixture);
  const serialized = JSON.stringify(records);
  assert.doesNotMatch(serialized, /C:\\\\|contentBase64|fixtureToken|repositoryRoot|artifactPath|workspaceRoot/);
  assert.equal(hasKey(records, 'reviewerApproval'), false);
  assert.equal(hasKey(records, 'resultRecords'), false);

  const installed = records.installedEvidence;
  assert.equal(
    validateBrowserSemanticReceipts(records.semanticReceipts, {
      expected: {
        aggregateSha256: installed.aggregateSha256,
        completedAt: installed.completedAt,
        executionPlanSha256: installed.executionPlanSha256,
        identity: installed.identity,
        matrixSha256: installed.matrixSha256,
        matrixVersion: installed.matrixVersion,
        privateEvidenceRetained: installed.privateEvidenceRetained,
        publicSemanticReplay: installed.publicSemanticReplay,
        resultRecordCount: installed.resultRecordCount,
        resultSetSha256: installed.resultSetSha256,
        runId: installed.runId
      }
    }),
    records.semanticReceipts
  );
});

test('pure application preserves historical fields, keeps reviewer approval false, and never labels automation as reviewed', async () => {
  const fixture = runFixture({ passSmoke: true });
  const records = createBrowserPublicationRecords(fixture);
  const source = JSON.parse(
    await readFile(new URL('../../docs/evidence/browser-validation.json', import.meta.url), 'utf8')
  );
  const historicalKeys = [
    'priorExactArtifactEvidence',
    'olderExactArtifactEvidence',
    'earlierExactArtifactEvidence',
    'priorCandidateObservation',
    'syntheticInAppBrowser',
    'deferredBinaryPublicationMatrix',
    'limitations'
  ];
  const historical = Object.fromEntries(historicalKeys.map((key) => [key, structuredClone(source[key])]));

  const updated = applyBrowserPublicationRecords({
    ...fixture,
    browserValidation: source,
    records
  });
  assert.equal(updated.reviewerApproval, false);
  assert.notEqual(updated.status, 'passed');
  assert.equal(updated.status, 'not_run');
  assert.equal(updated.automationAttempt, null);
  assert.equal(updated.artifact.sha256, fixture.plan.identity.artifactSha256);
  for (const key of historicalKeys) assert.deepEqual(updated[key], historical[key]);
  assert.equal(source.artifact.sha256, null);

  const selfApproved = structuredClone(source);
  selfApproved.reviewerApproval = true;
  assert.throws(
    () =>
      applyBrowserPublicationRecords({
        ...fixture,
        browserValidation: selfApproved,
        records
      }),
    /cannot create, replace, preserve, or revoke a reviewer approval/
  );
});

function runFixture({ partialSmoke = false, passSmoke = false } = {}) {
  const plan = samplePlan();
  const resultRecords = [];
  for (const scenario of CANONICAL_BROWSER_MATRIX) {
    for (const browserName of REQUIRED_BROWSERS) {
      const result = sampleResult(plan, scenario, browserName);
      if ((passSmoke || partialSmoke) && scenario.id === 'SMOKE-01') {
        if (passSmoke) result.reason = null;
        result.evidence = smokeEvidence(result, { includeSidePanel: passSmoke });
      }
      resultRecords.push(createScenarioResultRecord(result, { plan }));
    }
  }
  const aggregate = aggregateBrowserEvidence({ plan, resultRecords });
  const completion = {
    schema: 'sitewipe.owned-browser-run-completion.v1',
    runId: plan.runId,
    planSha256: plan.planSha256,
    state: aggregate.state,
    aggregateSha256: computeAggregateSha256(aggregate),
    resultSetSha256: aggregate.resultSetSha256,
    resultRecordCount: aggregate.resultRecordCount,
    semanticValidationStatus: aggregate.semanticValidationStatus,
    detail: 'Exact synthetic run retained.',
    completedAt: timestamp,
    retainedRunRoot: true,
    automaticRecursiveDeletionPerformed: false
  };
  return { aggregate, completion, plan };
}

function sampleResult(plan, scenario, browserName) {
  const browser = structuredClone(plan.inputs.browserPins.find(({ name }) => name === browserName));
  return {
    schema: SCENARIO_RESULT_SCHEMA,
    matrixVersion: BROWSER_MATRIX_VERSION,
    matrixSha256: CANONICAL_BROWSER_MATRIX_SHA256,
    semanticValidatorManifestSha256: SEMANTIC_VALIDATOR_MANIFEST_SHA256,
    planSha256: plan.planSha256,
    runId: plan.runId,
    scenarioId: scenario.id,
    browser,
    identity: structuredClone(plan.identity),
    startedAt: timestamp,
    completedAt: timestamp,
    reason: 'Required exact typed observations or canonical validators are absent.',
    evidence: []
  };
}

function smokeEvidence(result, { includeSidePanel = true } = {}) {
  const binding = semanticBindingFromScenarioResult(result);
  const browserName = result.browser.name;
  const create = (assertionId, suffix, payload, sequence) =>
    createSemanticObservationEvidence({
      binding,
      assertionId,
      observationId: `${browserName}.smoke.${suffix}`,
      capturedAt: timestamp,
      payload,
      sequence
    });
  const fixtureInventorySha256 = '9'.repeat(64);
  const fixtureValueSha256 = '8'.repeat(64);
  const evidence = [
    create(
      'install.fresh_profile',
      'fresh-profile',
      {
        extensionEnabled: true,
        extensionId: 'a'.repeat(32),
        extensionName: 'SiteWipe',
        extensionOriginScheme: 'chrome-extension',
        extensionVersion: result.identity.artifactVersion,
        profileDataEntryCountBeforeLaunch: 0,
        profileOwnershipMarkerMatched: true,
        profileWasNew: true,
        syncEnabled: false
      },
      0
    ),
    create('defaults.safe', 'safe-defaults', { settings: structuredClone(SETTINGS_DEFAULTS) }, 1),
    create(
      'load.no_permission_or_cleanup',
      'no-authority-or-mutation',
      {
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
        dynamicDnrRulesAfterSha256: '37517E5F3DC66819F61F5A7BB8ACE1921282415F10551D2DEFA5C3EB0985B570',
        dynamicDnrRulesBeforeSha256: '37517E5F3DC66819F61F5A7BB8ACE1921282415F10551D2DEFA5C3EB0985B570',
        fixtureAfterDataEntryCount: 41,
        fixtureAfterInventorySha256: fixtureInventorySha256,
        fixtureAfterStorageKindCount: 6,
        fixtureAfterValueSha256: fixtureValueSha256,
        fixtureBeforeDataEntryCount: 41,
        fixtureBeforeInventorySha256: fixtureInventorySha256,
        fixtureBeforeStorageKindCount: 6,
        fixtureBeforeValueSha256: fixtureValueSha256,
        fixtureScale: 'small',
        fixtureSeedDataEntryCount: 41,
        fixtureSeedInventorySha256: fixtureInventorySha256,
        fixtureSeedReceiptSha256: '7'.repeat(64),
        fixtureSeedStorageKindCount: 6,
        fixtureSeedValueSha256: fixtureValueSha256,
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
        monitorCoverageObservedAt: timestamp,
        monitorCoverageSequence: 20,
        monitorDocumentReadyCount: 1,
        monitorObservationReadyAt: timestamp,
        nativeObservationCoverageThrough: timestamp,
        nativeObservationObservedAt: timestamp,
        nativeObservationReadyAt: timestamp,
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
        sessionDnrRulesAfterSha256: '37517E5F3DC66819F61F5A7BB8ACE1921282415F10551D2DEFA5C3EB0985B570',
        sessionDnrRulesBeforeSha256: '37517E5F3DC66819F61F5A7BB8ACE1921282415F10551D2DEFA5C3EB0985B570',
        startupEndpointPreconditionPassed: true,
        startupSourceRouteContractMatched: true,
        startupSourceRouteContractSha256: '6'.repeat(64),
        downloadCreatedEventCount: 0,
        downloadErasedEventCount: 0
      },
      includeSidePanel ? 3 : 2
    )
  ];
  if (includeSidePanel) {
    evidence.splice(
      2,
      0,
      create(
        'surfaces.popup_options_sidepanel',
        'installed-surfaces',
        {
          surfaces: [
            surface('popup', 'SiteWipe'),
            surface('options', 'SiteWipe Options'),
            surface('sidepanel', 'SiteWipe Report')
          ]
        },
        2
      )
    );
  }
  return evidence;
}

function surface(name, documentTitle) {
  return {
    documentTitle,
    name,
    originScheme: 'chrome-extension',
    readyState: 'complete',
    visible: true
  };
}

function samplePlan() {
  const browserPins = [
    {
      name: 'brave',
      executablePath: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      version: '151.1.93.138',
      executableSha256: '1'.repeat(64),
      runtimeRootPath: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\151.1.93.138',
      runtimeVersion: '151.1.93.138',
      runtimeFileCount: 176,
      runtimeBytes: 1076868141,
      runtimeManifestSha256: '3'.repeat(64)
    },
    {
      name: 'chrome',
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      version: '151.0.7922.174',
      executableSha256: '2'.repeat(64),
      runtimeRootPath: 'C:\\Program Files\\Google\\Chrome\\Application\\151.0.7922.174',
      runtimeVersion: '151.0.7922.174',
      runtimeFileCount: 266,
      runtimeBytes: 514076268,
      runtimeManifestSha256: '4'.repeat(64)
    }
  ];
  const browserRuntimeSetSha256 = computeBrowserRuntimeSetSha256(browserPins);
  const toolchain = {
    nodeRuntimeVersion: process.version,
    toolchainPuppeteerVersion: PINNED_PUPPETEER_CORE_VERSION,
    toolchainPackageCount: 31,
    toolchainFileCount: 402,
    toolchainBytes: 7463219,
    toolchainManifestSha256: '7'.repeat(64),
    toolchainSetSha256: '8'.repeat(64)
  };
  const plan = {
    schema: BROWSER_PLAN_SCHEMA,
    matrixVersion: BROWSER_MATRIX_VERSION,
    matrixSha256: CANONICAL_BROWSER_MATRIX_SHA256,
    runId: `sitewipe-browser-${'a'.repeat(32)}`,
    createdAt: timestamp,
    requiredBrowsers: [...REQUIRED_BROWSERS],
    requiredMatrixIds: [...CANONICAL_BROWSER_MATRIX_IDS],
    semanticValidatorManifestSha256: SEMANTIC_VALIDATOR_MANIFEST_SHA256,
    identity: {
      sourceCommitSha: 'a'.repeat(40),
      sourceTreeSha: 'b'.repeat(40),
      artifactVersion: '1.11.90',
      artifactBytes: 100,
      artifactSha256: 'A'.repeat(64),
      browserRuntimeSetSha256,
      gitExecutableSha256: '9'.repeat(64),
      harnessManifestSha256: 'B'.repeat(64),
      launchPolicySha256: INSTALLED_RUNTIME_LAUNCH_POLICY_SHA256,
      nativeHelperSha256: 'C'.repeat(64),
      nodeExecutableSha256: 'D'.repeat(64),
      nodeRuntimeVersion: toolchain.nodeRuntimeVersion,
      packageLockSha256: 'E'.repeat(64),
      powerShellExecutableSha256: '5'.repeat(64),
      processObserverHelperSha256: '6'.repeat(64),
      releaseInputFingerprintSha256: 'F'.repeat(64),
      runtimeFingerprintSha256: '0'.repeat(64),
      toolchainPuppeteerVersion: toolchain.toolchainPuppeteerVersion,
      toolchainPackageCount: toolchain.toolchainPackageCount,
      toolchainFileCount: toolchain.toolchainFileCount,
      toolchainBytes: toolchain.toolchainBytes,
      toolchainSetSha256: toolchain.toolchainSetSha256
    },
    inputs: {
      repositoryRoot: 'C:\\sitewipe\\repository',
      workspaceRoot: 'C:\\sitewipe\\browser-runs',
      artifactPath: 'C:\\sitewipe\\artifact.zip',
      git: {
        path: 'C:\\Program Files\\Git\\cmd\\git.exe',
        sha256: '9'.repeat(64),
        version: 'git version 2.51.0.windows.1'
      },
      browserPins,
      browserRuntimeSetSha256,
      launchPolicySha256: INSTALLED_RUNTIME_LAUNCH_POLICY_SHA256,
      fixture: {
        bindAddresses: [...FIXED_FIXTURE_BIND_ADDRESSES],
        allowedHosts: [...SYNTHETIC_FIXTURE_HOSTS],
        allowedRoutes: [...FIXTURE_ALLOWED_ROUTES],
        allowedMethods: [...FIXTURE_ALLOWED_METHODS],
        tokenBytes: 32,
        tokenGeneratedAfterApproval: true
      },
      nativePrompt: {
        helperPath: 'C:\\sitewipe\\windows-permission-dialog.ps1',
        helperSha256: 'C'.repeat(64),
        policySha256: NATIVE_PROMPT_POLICY_SHA256,
        allowedActions: [...NATIVE_PROMPT_ALLOWED_ACTIONS],
        permissionPatterns: [...NATIVE_PROMPT_PERMISSION_PATTERNS],
        expectedFragments: [...NATIVE_PROMPT_EXPECTED_FRAGMENTS],
        scenarioSchedule: structuredClone(NATIVE_PROMPT_SCENARIO_SCHEDULE),
        uiaSnapshots: structuredClone(NATIVE_PROMPT_UIA_SNAPSHOTS),
        requiresUnlockedInteractiveSession: true
      },
      processObserver: {
        helperPath: 'C:\\sitewipe\\windows-process-identity.ps1',
        helperSha256: '6'.repeat(64),
        powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        powershellSha256: '5'.repeat(64),
        helperModes: ['Identity', 'ProfileResidue', 'TerminateTree'],
        rawCommandLinesRetained: false,
        processTerminationAllowed: true
      },
      toolchain,
      retention: { failureDays: 14, passEvidenceDays: 30, retainProfilesOnFailure: true }
    },
    approval: {
      mode: 'single-start-plan-sha256',
      additionalInteractiveApprovalsAllowed: false,
      approvedActions: [...APPROVED_UNATTENDED_ACTIONS]
    },
    planSha256: null
  };
  plan.planSha256 = computePlanSha256(plan);
  return plan;
}

function hasKey(value, expectedKey) {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => key === expectedKey || hasKey(child, expectedKey));
}

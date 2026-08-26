import assert from 'node:assert/strict';
import test from 'node:test';

import { FIXTURE_ALLOWED_METHODS, FIXTURE_ALLOWED_ROUTES, SYNTHETIC_FIXTURE_HOSTS } from '../fixture-server.mjs';

import {
  BROWSER_MATRIX_VERSION,
  CANONICAL_BROWSER_MATRIX,
  CANONICAL_BROWSER_MATRIX_IDS,
  CANONICAL_BROWSER_MATRIX_SHA256,
  INTERNAL_SETTINGS,
  REQUIRED_BROWSERS,
  VISIBLE_SETTINGS
} from './canonical-matrix.mjs';
import {
  APPROVED_UNATTENDED_ACTIONS,
  BROWSER_PLAN_SCHEMA,
  FIXED_FIXTURE_BIND_ADDRESSES,
  SCENARIO_RESULT_SCHEMA,
  aggregateBrowserEvidence,
  computePlanSha256,
  createScenarioResultRecord,
  validateAndReplayBrowserAggregate,
  validateBrowserPlan,
  validateScenarioResult
} from './evidence-contract.mjs';
import {
  NATIVE_PROMPT_ALLOWED_ACTIONS,
  NATIVE_PROMPT_EXPECTED_FRAGMENTS,
  NATIVE_PROMPT_PERMISSION_PATTERNS,
  NATIVE_PROMPT_POLICY_SHA256,
  NATIVE_PROMPT_SCENARIO_SCHEDULE,
  NATIVE_PROMPT_UIA_SNAPSHOTS
} from './native-permission-dialog.mjs';
import { SEMANTIC_VALIDATOR_MANIFEST_SHA256 } from './semantic-validator.mjs';
import { computeBrowserRuntimeSetSha256 } from './browser-runtime-closure.mjs';
import { INSTALLED_RUNTIME_LAUNCH_POLICY_SHA256 } from './launch-policy.mjs';
import { PINNED_PUPPETEER_CORE_VERSION } from './toolchain-closure.mjs';

const timestamp = '2026-08-24T22:00:00.000Z';

test('canonical matrix is deeply frozen, has exactly 24 stable IDs, and classifies every setting', () => {
  assert.equal(CANONICAL_BROWSER_MATRIX.length, 24);
  assert.deepEqual(CANONICAL_BROWSER_MATRIX_IDS, [
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
  ]);
  assert.equal(VISIBLE_SETTINGS.length, 37);
  assert.equal(INTERNAL_SETTINGS.length, 7);
  const settings = CANONICAL_BROWSER_MATRIX.find(({ id }) => id === 'SETTINGS-01');
  for (const key of [...VISIBLE_SETTINGS, ...INTERNAL_SETTINGS]) {
    assert.ok(settings.requiredAssertions.includes(`setting.${key}`), key);
  }
  assert.equal(Object.isFrozen(CANONICAL_BROWSER_MATRIX), true);
  assert.equal(Object.isFrozen(settings.settings.defaults), true);
  assert.throws(() => {
    settings.requiredAssertions.push('setting.invented');
  }, TypeError);
});

test('mechanical aggregate replays all 48 cells but remains not_run while required observations or validators are absent', () => {
  const plan = samplePlan();
  const records = [];
  for (const scenario of CANONICAL_BROWSER_MATRIX) {
    for (const browserName of REQUIRED_BROWSERS) {
      records.push(createScenarioResultRecord(sampleResult(plan, scenario, browserName), { plan }));
    }
  }
  const aggregate = aggregateBrowserEvidence({ plan, resultRecords: records });
  assert.equal(aggregate.state, 'not_run');
  assert.deepEqual(aggregate.counts, { passed: 0, failed: 0, limited: 0, not_run: 48 });
  assert.equal(aggregate.cells.length, 48);
  assert.equal(validateAndReplayBrowserAggregate(aggregate, { plan }).resultSetSha256, aggregate.resultSetSha256);

  const tampered = structuredClone(aggregate);
  tampered.resultRecords[0].contentBase64 = Buffer.from('tampered\n').toString('base64');
  assert.throws(() => validateAndReplayBrowserAggregate(tampered, { plan }), /raw-result binding|bytes or SHA/);
});

test('missing, duplicate, and dummy-evidence results cannot become passed', () => {
  const plan = samplePlan();
  const scenario = CANONICAL_BROWSER_MATRIX[0];
  const missing = aggregateBrowserEvidence({ plan, resultRecords: [] });
  assert.equal(missing.state, 'not_run');
  assert.equal(missing.counts.not_run, 48);

  const falselyPassed = sampleResult(plan, scenario, 'chrome');
  falselyPassed.declaredState = 'passed';
  falselyPassed.reason = null;
  assert.throws(() => validateScenarioResult(falselyPassed, { plan }), /keys differ from the exact schema/);

  const record = createScenarioResultRecord(sampleResult(plan, scenario, 'chrome'), { plan });
  const duplicate = aggregateBrowserEvidence({ plan, resultRecords: [record, record] });
  assert.equal(duplicate.state, 'failed');
  assert.match(duplicate.integrityFindings.join('\n'), /has 2 result records/);
});

test('plan digest binds exact matrix, inputs, identities, and the one-approval boundary', () => {
  const plan = samplePlan();
  assert.equal(validateBrowserPlan(plan), plan);
  for (const mutate of [
    (value) => value.requiredMatrixIds.pop(),
    (value) => {
      value.matrixSha256 = 'F'.repeat(64);
    },
    (value) => {
      value.approval.additionalInteractiveApprovalsAllowed = true;
    },
    (value) => {
      value.inputs.fixture.tokenGeneratedAfterApproval = false;
    },
    (value) => {
      value.inputs.fixture.bindAddresses.push('0.0.0.0');
    },
    (value) => {
      value.inputs.fixture.allowedHosts.push('evil.invalid');
    },
    (value) => {
      value.inputs.fixture.allowedRoutes.push('/caller-selected');
    },
    (value) => {
      value.inputs.fixture.allowedMethods.push('POST');
    },
    (value) => {
      value.approval.approvedActions.push('filesystem.delete_arbitrary_path');
    },
    (value) => {
      value.inputs.nativePrompt.permissionPatterns.push('https://evil.invalid/*');
    },
    (value) => {
      value.inputs.nativePrompt.scenarioSchedule[0].action = 'allow';
    },
    (value) => {
      value.inputs.toolchain.toolchainManifestSha256 = '1'.repeat(64);
    },
    (value) => {
      value.identity.nodeRuntimeVersion = 'v0.0.1';
    }
  ]) {
    const changed = structuredClone(plan);
    mutate(changed);
    assert.throws(() => validateBrowserPlan(changed));
  }
});

test('plan path validation is host-independent and rejects ambiguous authority in every path field', () => {
  const posixPlan = samplePlan();
  posixPlan.inputs.repositoryRoot = '/var/tmp/sitewipe/repository';
  posixPlan.inputs.workspaceRoot = '/var/tmp/sitewipe/browser-runs';
  posixPlan.inputs.artifactPath = '/var/tmp/sitewipe/artifact.zip';
  posixPlan.inputs.git.path = '/usr/bin/git';
  posixPlan.inputs.browserPins[0].executablePath = '/opt/brave/brave';
  posixPlan.inputs.browserPins[1].executablePath = '/opt/chrome/chrome';
  posixPlan.inputs.nativePrompt.helperPath = '/var/tmp/sitewipe/native-permission-helper';
  posixPlan.planSha256 = computePlanSha256(posixPlan);
  assert.equal(validateBrowserPlan(posixPlan), posixPlan);

  const pathSetters = [
    (plan, value) => {
      plan.inputs.repositoryRoot = value;
    },
    (plan, value) => {
      plan.inputs.workspaceRoot = value;
    },
    (plan, value) => {
      plan.inputs.artifactPath = value;
    },
    (plan, value) => {
      plan.inputs.git.path = value;
    },
    (plan, value) => {
      plan.inputs.browserPins[0].executablePath = value;
    },
    (plan, value) => {
      plan.inputs.browserPins[1].executablePath = value;
    },
    (plan, value) => {
      plan.inputs.nativePrompt.helperPath = value;
    }
  ];
  const invalidPaths = [
    'relative/path',
    './relative/path',
    '../relative/path',
    'C:drive-relative',
    '\\rooted-without-drive',
    '\\\\server\\share\\sitewipe',
    '\\\\?\\C:\\device-path',
    '//network/share',
    ' C:\\sitewipe\\repository',
    'C:\\sitewipe\\repository ',
    'C:\\sitewipe\0repository'
  ];
  for (const setPath of pathSetters) {
    for (const invalidPath of invalidPaths) {
      const changed = samplePlan();
      setPath(changed, invalidPath);
      changed.planSha256 = computePlanSha256(changed);
      assert.throws(() => validateBrowserPlan(changed), /absolute|incomplete/);
    }
  }
});

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
      artifactVersion: '1.11.77',
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

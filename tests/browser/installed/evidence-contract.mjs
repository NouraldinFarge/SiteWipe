import { createHash } from 'node:crypto';

import { FIXTURE_ALLOWED_METHODS, FIXTURE_ALLOWED_ROUTES, SYNTHETIC_FIXTURE_HOSTS } from '../fixture-server.mjs';

import {
  BROWSER_MATRIX_VERSION,
  CANONICAL_BROWSER_MATRIX,
  CANONICAL_BROWSER_MATRIX_IDS,
  CANONICAL_BROWSER_MATRIX_SHA256,
  REQUIRED_BROWSERS,
  assertExactCanonicalMatrix,
  canonicalScenario
} from './canonical-matrix.mjs';
import {
  NATIVE_PROMPT_ALLOWED_ACTIONS,
  NATIVE_PROMPT_EXPECTED_FRAGMENTS,
  NATIVE_PROMPT_PERMISSION_PATTERNS,
  NATIVE_PROMPT_POLICY_SHA256,
  NATIVE_PROMPT_SCENARIO_SCHEDULE,
  NATIVE_PROMPT_UIA_SNAPSHOTS
} from './native-permission-dialog.mjs';
import { isPortableLocalAbsolutePath } from './path-contract.mjs';
import {
  BROWSER_RUNTIME_SUMMARY_KEYS,
  computeBrowserRuntimeSetSha256,
  validateBrowserRuntimeSummary
} from './browser-runtime-closure.mjs';
import {
  SEMANTIC_OBSERVATION_MEDIA_TYPE,
  SEMANTIC_VALIDATOR_MANIFEST,
  SEMANTIC_VALIDATOR_MANIFEST_SHA256,
  deriveSemanticScenarioAssertions,
  semanticValidatorEntry
} from './semantic-validator.mjs';
import { INSTALLED_RUNTIME_LAUNCH_POLICY_SHA256 } from './launch-policy.mjs';
import {
  INSTALLED_BROWSER_TOOLCHAIN_SUMMARY_KEYS,
  PINNED_PUPPETEER_CORE_VERSION,
  validateInstalledBrowserToolchainSummary
} from './toolchain-closure.mjs';

export const BROWSER_PLAN_SCHEMA = 'sitewipe.unattended-browser-plan.v2';
export const SCENARIO_RESULT_SCHEMA = 'sitewipe.installed-browser-scenario-result.v2';
export const RESULT_RECORD_SCHEMA = 'sitewipe.installed-browser-result-record.v2';
export const RAW_EVIDENCE_SCHEMA = 'sitewipe.installed-browser-raw-evidence.v1';
export const AGGREGATE_SCHEMA = 'sitewipe.installed-browser-aggregate.v2';
export const RESULT_STATES = Object.freeze(['passed', 'failed', 'limited', 'not_run']);
export const SEMANTIC_IMPLEMENTED_ASSERTION_COUNT = SEMANTIC_VALIDATOR_MANIFEST.entries.filter(
  ({ status }) => status === 'implemented'
).length;
export const SEMANTIC_NOT_IMPLEMENTED_ASSERTION_COUNT =
  SEMANTIC_VALIDATOR_MANIFEST.entries.length - SEMANTIC_IMPLEMENTED_ASSERTION_COUNT;
export const SEMANTIC_VALIDATION_STATUS =
  SEMANTIC_NOT_IMPLEMENTED_ASSERTION_COUNT === 0
    ? 'implemented'
    : SEMANTIC_IMPLEMENTED_ASSERTION_COUNT === 0
      ? 'not_implemented'
      : 'partial';
export const FIXED_FIXTURE_BIND_ADDRESSES = Object.freeze(['127.0.0.1', '::1']);
export const APPROVED_UNATTENDED_ACTIONS = Object.freeze([
  'filesystem.create_exact_owned_run',
  'fixture.bind_approved_loopback_only',
  'browser.launch_exact_pins_with_disposable_profiles',
  'browser.terminate_exact_owned_process_tree_on_failure',
  'native_prompt.invoke_predeclared_exact_controls',
  'browser.mutate_owned_synthetic_state_only',
  'filesystem.cleanup_or_quarantine_exact_owned_state'
]);

const PLAN_KEYS = Object.freeze([
  'approval',
  'createdAt',
  'identity',
  'inputs',
  'matrixSha256',
  'matrixVersion',
  'planSha256',
  'requiredBrowsers',
  'requiredMatrixIds',
  'runId',
  'schema',
  'semanticValidatorManifestSha256'
]);
const RESULT_KEYS = Object.freeze([
  'browser',
  'completedAt',
  'evidence',
  'identity',
  'matrixSha256',
  'matrixVersion',
  'planSha256',
  'reason',
  'runId',
  'scenarioId',
  'schema',
  'semanticValidatorManifestSha256',
  'startedAt'
]);

export function computePlanSha256(plan) {
  const unsigned = structuredClone(plan);
  delete unsigned.planSha256;
  return sha256(canonicalJsonBytes(unsigned));
}

export function validateBrowserPlan(plan) {
  assertExactKeys(plan, PLAN_KEYS, 'Browser plan');
  if (plan.schema !== BROWSER_PLAN_SCHEMA || plan.matrixVersion !== BROWSER_MATRIX_VERSION) {
    throw new Error('Browser plan has an unknown schema or matrix version.');
  }
  assertExactCanonicalMatrix(plan.requiredMatrixIds);
  if (JSON.stringify(plan.requiredBrowsers) !== JSON.stringify(REQUIRED_BROWSERS)) {
    throw new Error('Browser plan must require exactly pinned Brave and Chrome lanes.');
  }
  if (plan.matrixSha256 !== CANONICAL_BROWSER_MATRIX_SHA256) {
    throw new Error('Browser plan is not bound to the exact canonical matrix bytes.');
  }
  if (plan.semanticValidatorManifestSha256 !== SEMANTIC_VALIDATOR_MANIFEST_SHA256) {
    throw new Error('Browser plan is not bound to the exact semantic-validator manifest bytes.');
  }
  if (!/^sitewipe-browser-[a-f0-9]{32}$/.test(String(plan.runId || ''))) {
    throw new Error('Browser plan runId is malformed.');
  }
  assertIsoTimestamp(plan.createdAt, 'Browser plan createdAt');
  validateIdentity(plan.identity);
  validatePlanInputs(plan.inputs);
  validateIdentityInputBindings(plan.identity, plan.inputs);
  assertExactKeys(
    plan.approval,
    ['additionalInteractiveApprovalsAllowed', 'approvedActions', 'mode'],
    'Browser plan approval policy'
  );
  if (
    plan.approval.mode !== 'single-start-plan-sha256' ||
    plan.approval.additionalInteractiveApprovalsAllowed !== false ||
    !exactArray(plan.approval.approvedActions, APPROVED_UNATTENDED_ACTIONS)
  ) {
    throw new Error('Browser plan does not preserve the one-initial-approval boundary.');
  }
  if (!isSha256(plan.planSha256) || computePlanSha256(plan) !== plan.planSha256) {
    throw new Error('Browser plan SHA-256 does not match its canonical payload.');
  }
  return plan;
}

export function createRawEvidence({ id, mediaType = 'application/json', content }) {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(String(id || '')) || !isNonEmptyString(mediaType)) {
    throw new Error('Raw evidence requires a bounded stable ID and media type.');
  }
  const bytes = Buffer.isBuffer(content)
    ? Buffer.from(content)
    : typeof content === 'string'
      ? Buffer.from(content, 'utf8')
      : canonicalJsonBytes(content);
  if (!bytes.length) throw new Error('Raw evidence cannot be empty.');
  return Object.freeze({
    schema: RAW_EVIDENCE_SCHEMA,
    id,
    mediaType,
    bytes: bytes.length,
    sha256: sha256(bytes),
    contentBase64: bytes.toString('base64')
  });
}

export function createScenarioResultRecord(result, { plan }) {
  validateScenarioResult(result, { plan });
  const bytes = canonicalJsonBytes(result);
  return Object.freeze({
    schema: RESULT_RECORD_SCHEMA,
    bytes: bytes.length,
    sha256: sha256(bytes),
    contentBase64: bytes.toString('base64')
  });
}

export function validateScenarioResult(result, { plan }) {
  validateBrowserPlan(plan);
  assertExactKeys(result, RESULT_KEYS, 'Browser scenario result');
  if (
    result.schema !== SCENARIO_RESULT_SCHEMA ||
    result.matrixVersion !== BROWSER_MATRIX_VERSION ||
    result.matrixSha256 !== CANONICAL_BROWSER_MATRIX_SHA256 ||
    result.semanticValidatorManifestSha256 !== SEMANTIC_VALIDATOR_MANIFEST_SHA256 ||
    result.planSha256 !== plan.planSha256 ||
    result.runId !== plan.runId
  ) {
    throw new Error('Browser scenario result is not bound to its exact plan and matrix.');
  }
  const scenario = canonicalScenario(result.scenarioId);
  validateBrowser(result.browser, plan);
  if (stableJson(result.identity) !== stableJson(plan.identity)) {
    throw new Error('Browser scenario result identity differs from the approved plan identity.');
  }
  assertTimestampOrder(result.startedAt, result.completedAt, 'Browser scenario result');

  if (!Array.isArray(result.evidence)) throw new Error('Browser scenario result evidence must be an array.');
  const evidenceIds = new Set();
  for (const entry of result.evidence) {
    validateRawEvidence(entry);
    if (entry.mediaType !== SEMANTIC_OBSERVATION_MEDIA_TYPE) {
      throw new Error(`Browser scenario result evidence ${entry.id} is not a canonical semantic observation.`);
    }
    if (evidenceIds.has(entry.id)) throw new Error(`Browser scenario result repeats evidence ID ${entry.id}.`);
    evidenceIds.add(entry.id);
  }

  const derived = deriveSemanticScenarioAssertions({ result, evidence: result.evidence });
  const derivedState = derived.state;
  if (derivedState === 'not_run' && !isNonEmptyString(result.reason)) {
    throw new Error('A not_run scenario result must retain a reason.');
  }
  if (derivedState !== 'not_run' && result.reason !== null && !isNonEmptyString(result.reason)) {
    throw new Error('A scenario result reason must be null or a non-empty string.');
  }
  return Object.freeze({
    scenario,
    state: derivedState,
    implementationStatus: derived.implementationStatus,
    assertions: derived.assertions
  });
}

export function aggregateBrowserEvidence({ plan, resultRecords = [] } = {}) {
  validateBrowserPlan(plan);
  if (!Array.isArray(resultRecords)) throw new Error('Browser aggregate resultRecords must be an array.');

  const integrityFindings = [];
  const decoded = [];
  for (const [index, record] of resultRecords.entries()) {
    try {
      const value = decodeResultRecord(record);
      const validated = validateScenarioResult(value, { plan });
      decoded.push({
        record,
        result: value,
        state: validated.state,
        assertions: validated.assertions,
        implementationStatus: validated.implementationStatus
      });
    } catch (error) {
      integrityFindings.push(`Result record ${index + 1}: ${error?.message || String(error)}`);
    }
  }

  const cells = [];
  const executionFindings = [];
  for (const scenario of CANONICAL_BROWSER_MATRIX) {
    for (const browserName of REQUIRED_BROWSERS) {
      const matches = decoded.filter(
        ({ result }) => result.scenarioId === scenario.id && result.browser.name === browserName
      );
      if (matches.length === 0) {
        cells.push(missingCell(scenario, browserName));
        executionFindings.push(`${scenario.id}/${browserName} was not run.`);
        continue;
      }
      if (matches.length !== 1) {
        cells.push({
          scenarioId: scenario.id,
          browser: browserName,
          state: 'failed',
          implementationStatus: semanticScenarioStatus(scenario),
          resultRecordSha256: null,
          assertions: [],
          finding: `Expected one result record; observed ${matches.length}.`
        });
        integrityFindings.push(`${scenario.id}/${browserName} has ${matches.length} result records.`);
        continue;
      }
      const [{ record, result, state: cellState, assertions, implementationStatus }] = matches;
      cells.push({
        scenarioId: scenario.id,
        browser: browserName,
        state: cellState,
        implementationStatus,
        resultRecordSha256: record.sha256,
        assertions: assertions.map(({ id, state: assertionState, validatorId }) => ({
          id,
          state: assertionState,
          validatorId
        })),
        finding: result.reason
      });
      if (cellState !== 'passed') executionFindings.push(`${scenario.id}/${browserName} is ${cellState}.`);
    }
  }

  const orderedRecords = [...resultRecords].sort((left, right) =>
    String(left?.sha256 || '').localeCompare(String(right?.sha256 || ''))
  );
  const state = integrityFindings.length ? 'failed' : aggregateState(cells.map((entry) => entry.state));
  const counts = Object.fromEntries(
    RESULT_STATES.map((resultState) => [resultState, cells.filter((entry) => entry.state === resultState).length])
  );
  return {
    schema: AGGREGATE_SCHEMA,
    matrixVersion: BROWSER_MATRIX_VERSION,
    matrixSha256: CANONICAL_BROWSER_MATRIX_SHA256,
    planSha256: plan.planSha256,
    runId: plan.runId,
    state,
    semanticValidationStatus: SEMANTIC_VALIDATION_STATUS,
    semanticValidatorManifestSha256: SEMANTIC_VALIDATOR_MANIFEST_SHA256,
    semanticValidatorCounts: {
      implemented: SEMANTIC_IMPLEMENTED_ASSERTION_COUNT,
      notImplemented: SEMANTIC_NOT_IMPLEMENTED_ASSERTION_COUNT,
      total: SEMANTIC_VALIDATOR_MANIFEST.entries.length
    },
    identity: structuredClone(plan.identity),
    requiredBrowsers: [...REQUIRED_BROWSERS],
    requiredMatrixIds: [...CANONICAL_BROWSER_MATRIX_IDS],
    counts,
    cells,
    resultRecordCount: orderedRecords.length,
    resultSetSha256: sha256(canonicalJsonBytes(orderedRecords)),
    resultRecords: orderedRecords.map((record) => structuredClone(record)),
    integrityFindings,
    executionFindings
  };
}

export function validateAndReplayBrowserAggregate(aggregate, { plan }) {
  if (
    aggregate?.schema !== AGGREGATE_SCHEMA ||
    aggregate?.matrixVersion !== BROWSER_MATRIX_VERSION ||
    aggregate?.matrixSha256 !== CANONICAL_BROWSER_MATRIX_SHA256 ||
    aggregate?.semanticValidatorManifestSha256 !== SEMANTIC_VALIDATOR_MANIFEST_SHA256 ||
    aggregate?.planSha256 !== plan?.planSha256 ||
    !Array.isArray(aggregate?.resultRecords) ||
    aggregate.resultRecordCount !== aggregate.resultRecords.length ||
    aggregate.resultSetSha256 !== sha256(canonicalJsonBytes(aggregate.resultRecords))
  ) {
    throw new Error('Browser aggregate is missing its exact plan, matrix, or raw-result binding.');
  }
  const replayed = aggregateBrowserEvidence({ plan, resultRecords: aggregate.resultRecords });
  if (stableJson(replayed) !== stableJson(aggregate)) {
    throw new Error('Browser aggregate differs from mechanical replay of its embedded raw result records.');
  }
  return replayed;
}

export function computeAggregateSha256(aggregate) {
  return sha256(canonicalJsonBytes(aggregate));
}

export function canonicalJsonBytes(value) {
  return Buffer.from(`${stableJson(value)}\n`, 'utf8');
}

function validatePlanInputs(inputs) {
  assertExactKeys(
    inputs,
    [
      'artifactPath',
      'browserPins',
      'browserRuntimeSetSha256',
      'fixture',
      'git',
      'launchPolicySha256',
      'nativePrompt',
      'processObserver',
      'repositoryRoot',
      'retention',
      'toolchain',
      'workspaceRoot'
    ],
    'Browser plan inputs'
  );
  if (
    !isPortableLocalAbsolutePath(inputs.repositoryRoot) ||
    !isPortableLocalAbsolutePath(inputs.workspaceRoot) ||
    !isPortableLocalAbsolutePath(inputs.artifactPath)
  ) {
    throw new Error('Browser plan repository, workspace, and artifact paths must be absolute.');
  }
  if (!Array.isArray(inputs.browserPins) || inputs.browserPins.length !== REQUIRED_BROWSERS.length) {
    throw new Error('Browser plan must retain exactly two pinned browser inputs.');
  }
  assertExactKeys(inputs.git, ['path', 'sha256', 'version'], 'Trusted Git identity');
  if (
    !isPortableLocalAbsolutePath(inputs.git.path) ||
    !isSha256(inputs.git.sha256) ||
    !/^git version \d+\.\d+/.test(String(inputs.git.version || ''))
  ) {
    throw new Error('Browser plan trusted Git identity is incomplete.');
  }
  const names = inputs.browserPins.map((entry) => entry?.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(REQUIRED_BROWSERS)) {
    throw new Error('Browser plan browser pins must be exactly Brave and Chrome.');
  }
  for (const pin of inputs.browserPins) {
    assertExactKeys(
      pin,
      ['executablePath', 'executableSha256', 'name', 'version', ...BROWSER_RUNTIME_SUMMARY_KEYS],
      'Browser executable pin'
    );
    if (
      !isPortableLocalAbsolutePath(pin.executablePath) ||
      !isSha256(pin.executableSha256) ||
      !isNonEmptyString(pin.version)
    ) {
      throw new Error('Browser plan contains an incomplete executable pin.');
    }
    validateBrowserRuntimeSummary(Object.fromEntries(BROWSER_RUNTIME_SUMMARY_KEYS.map((key) => [key, pin[key]])));
  }
  if (computeBrowserRuntimeSetSha256(inputs.browserPins) !== inputs.browserRuntimeSetSha256) {
    throw new Error('Browser plan runtime-set SHA-256 differs from its exact browser runtime summaries.');
  }
  if (inputs.launchPolicySha256 !== INSTALLED_RUNTIME_LAUNCH_POLICY_SHA256) {
    throw new Error('Browser plan launch-policy SHA-256 differs from the exact committed runtime policy.');
  }
  assertExactKeys(
    inputs.toolchain,
    ['nodeRuntimeVersion', ...INSTALLED_BROWSER_TOOLCHAIN_SUMMARY_KEYS],
    'Browser installed-executor toolchain'
  );
  if (!isNodeVersion(inputs.toolchain.nodeRuntimeVersion)) {
    throw new Error('Browser installed-executor toolchain lacks an exact Node version.');
  }
  validateInstalledBrowserToolchainSummary(
    Object.fromEntries(INSTALLED_BROWSER_TOOLCHAIN_SUMMARY_KEYS.map((key) => [key, inputs.toolchain[key]]))
  );
  assertExactKeys(
    inputs.fixture,
    ['allowedHosts', 'allowedMethods', 'allowedRoutes', 'bindAddresses', 'tokenBytes', 'tokenGeneratedAfterApproval'],
    'Browser fixture policy'
  );
  if (
    !exactArray(inputs.fixture.bindAddresses, FIXED_FIXTURE_BIND_ADDRESSES) ||
    !exactArray(inputs.fixture.allowedHosts, SYNTHETIC_FIXTURE_HOSTS) ||
    !exactArray(inputs.fixture.allowedRoutes, FIXTURE_ALLOWED_ROUTES) ||
    !exactArray(inputs.fixture.allowedMethods, FIXTURE_ALLOWED_METHODS)
  ) {
    throw new Error(
      'Browser fixture bind addresses, hosts, routes, or methods differ from the exact canonical policy.'
    );
  }
  if (inputs.fixture.tokenBytes !== 32 || inputs.fixture.tokenGeneratedAfterApproval !== true) {
    throw new Error('Browser fixture token policy must create 32 random bytes only after approval.');
  }
  assertExactKeys(
    inputs.nativePrompt,
    [
      'allowedActions',
      'expectedFragments',
      'helperPath',
      'helperSha256',
      'permissionPatterns',
      'policySha256',
      'requiresUnlockedInteractiveSession',
      'scenarioSchedule',
      'uiaSnapshots'
    ],
    'Native prompt policy'
  );
  if (
    !isPortableLocalAbsolutePath(inputs.nativePrompt.helperPath) ||
    !isSha256(inputs.nativePrompt.helperSha256) ||
    inputs.nativePrompt.policySha256 !== NATIVE_PROMPT_POLICY_SHA256 ||
    !exactArray(inputs.nativePrompt.allowedActions, NATIVE_PROMPT_ALLOWED_ACTIONS) ||
    !exactArray(inputs.nativePrompt.permissionPatterns, NATIVE_PROMPT_PERMISSION_PATTERNS) ||
    !exactArray(inputs.nativePrompt.expectedFragments, NATIVE_PROMPT_EXPECTED_FRAGMENTS) ||
    stableJson(inputs.nativePrompt.scenarioSchedule) !== stableJson(NATIVE_PROMPT_SCENARIO_SCHEDULE) ||
    stableJson(inputs.nativePrompt.uiaSnapshots) !== stableJson(NATIVE_PROMPT_UIA_SNAPSHOTS) ||
    inputs.nativePrompt.requiresUnlockedInteractiveSession !== true
  ) {
    throw new Error('Browser plan native-prompt policy is incomplete or widened.');
  }
  assertExactKeys(
    inputs.processObserver,
    [
      'helperModes',
      'helperPath',
      'helperSha256',
      'powershellPath',
      'powershellSha256',
      'processTerminationAllowed',
      'rawCommandLinesRetained'
    ],
    'Browser process-observer policy'
  );
  if (
    !isPortableLocalAbsolutePath(inputs.processObserver.helperPath) ||
    !isSha256(inputs.processObserver.helperSha256) ||
    !isPortableLocalAbsolutePath(inputs.processObserver.powershellPath) ||
    !isSha256(inputs.processObserver.powershellSha256) ||
    !exactArray(inputs.processObserver.helperModes, ['Identity', 'ProfileResidue', 'TerminateTree']) ||
    inputs.processObserver.rawCommandLinesRetained !== false ||
    inputs.processObserver.processTerminationAllowed !== true
  ) {
    throw new Error('Browser process-observer policy is incomplete or widened.');
  }
  assertExactKeys(inputs.retention, ['failureDays', 'passEvidenceDays', 'retainProfilesOnFailure'], 'Retention policy');
  if (
    !Number.isInteger(inputs.retention.failureDays) ||
    inputs.retention.failureDays < 1 ||
    inputs.retention.failureDays > 30 ||
    !Number.isInteger(inputs.retention.passEvidenceDays) ||
    inputs.retention.passEvidenceDays < 1 ||
    inputs.retention.passEvidenceDays > 90 ||
    inputs.retention.retainProfilesOnFailure !== true
  ) {
    throw new Error('Browser plan retention policy is outside bounded limits.');
  }
}

function validateIdentity(identity) {
  assertExactKeys(
    identity,
    [
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
    ],
    'Browser evidence identity'
  );
  if (
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(String(identity.sourceCommitSha || '')) ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(String(identity.sourceTreeSha || '')) ||
    !/^\d+\.\d+\.\d+$/.test(String(identity.artifactVersion || '')) ||
    !isNodeVersion(identity.nodeRuntimeVersion) ||
    !Number.isInteger(identity.artifactBytes) ||
    identity.artifactBytes <= 0 ||
    !Number.isSafeInteger(identity.toolchainPackageCount) ||
    identity.toolchainPackageCount <= 0 ||
    !Number.isSafeInteger(identity.toolchainFileCount) ||
    identity.toolchainFileCount <= 0 ||
    !Number.isSafeInteger(identity.toolchainBytes) ||
    identity.toolchainBytes <= 0 ||
    identity.toolchainPuppeteerVersion !== PINNED_PUPPETEER_CORE_VERSION ||
    ![
      identity.artifactSha256,
      identity.browserRuntimeSetSha256,
      identity.gitExecutableSha256,
      identity.harnessManifestSha256,
      identity.launchPolicySha256,
      identity.nativeHelperSha256,
      identity.nodeExecutableSha256,
      identity.packageLockSha256,
      identity.powerShellExecutableSha256,
      identity.processObserverHelperSha256,
      identity.releaseInputFingerprintSha256,
      identity.runtimeFingerprintSha256,
      identity.toolchainSetSha256
    ].every(isSha256)
  ) {
    throw new Error('Browser evidence identity is incomplete or malformed.');
  }
}

function validateIdentityInputBindings(identity, inputs) {
  const bindings = [
    ['browserRuntimeSetSha256', inputs.browserRuntimeSetSha256],
    ['launchPolicySha256', inputs.launchPolicySha256],
    ['nodeRuntimeVersion', inputs.toolchain.nodeRuntimeVersion],
    ['toolchainPuppeteerVersion', inputs.toolchain.toolchainPuppeteerVersion],
    ['toolchainPackageCount', inputs.toolchain.toolchainPackageCount],
    ['toolchainFileCount', inputs.toolchain.toolchainFileCount],
    ['toolchainBytes', inputs.toolchain.toolchainBytes],
    ['toolchainSetSha256', inputs.toolchain.toolchainSetSha256]
  ];
  for (const [key, expected] of bindings) {
    if (identity[key] !== expected) {
      throw new Error(`Browser evidence identity ${key} differs from the exact approved plan input.`);
    }
  }
}

function validateBrowser(browser, plan) {
  assertExactKeys(
    browser,
    ['executablePath', 'executableSha256', 'name', 'version', ...BROWSER_RUNTIME_SUMMARY_KEYS],
    'Browser result identity'
  );
  const pin = plan.inputs.browserPins.find((entry) => entry.name === browser.name);
  if (!pin || stableJson(pin) !== stableJson(browser)) {
    throw new Error('Browser result does not match one exact approved executable pin.');
  }
}

function validateRawEvidence(entry) {
  assertExactKeys(entry, ['bytes', 'contentBase64', 'id', 'mediaType', 'schema', 'sha256'], 'Raw evidence');
  if (
    entry.schema !== RAW_EVIDENCE_SCHEMA ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(String(entry.id || '')) ||
    !isNonEmptyString(entry.mediaType) ||
    !Number.isInteger(entry.bytes) ||
    entry.bytes <= 0 ||
    !isSha256(entry.sha256) ||
    typeof entry.contentBase64 !== 'string'
  ) {
    throw new Error('Raw evidence entry is malformed.');
  }
  const bytes = Buffer.from(entry.contentBase64, 'base64');
  if (
    bytes.length !== entry.bytes ||
    bytes.toString('base64') !== entry.contentBase64 ||
    sha256(bytes) !== entry.sha256
  ) {
    throw new Error(`Raw evidence ${entry.id} does not match its retained bytes and SHA-256.`);
  }
}

function aggregateState(states) {
  if (states.includes('failed')) return 'failed';
  if (states.includes('not_run')) return 'not_run';
  if (states.includes('limited')) return 'limited';
  return states.length && states.every((state) => state === 'passed') ? 'passed' : 'not_run';
}

function decodeResultRecord(record) {
  assertExactKeys(record, ['bytes', 'contentBase64', 'schema', 'sha256'], 'Browser result record');
  if (
    record.schema !== RESULT_RECORD_SCHEMA ||
    !Number.isInteger(record.bytes) ||
    record.bytes <= 0 ||
    !isSha256(record.sha256) ||
    typeof record.contentBase64 !== 'string'
  ) {
    throw new Error('Browser result record is malformed.');
  }
  const bytes = Buffer.from(record.contentBase64, 'base64');
  if (
    bytes.length !== record.bytes ||
    bytes.toString('base64') !== record.contentBase64 ||
    sha256(bytes) !== record.sha256
  ) {
    throw new Error('Browser result record bytes or SHA-256 changed.');
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error('Browser result record is not exact UTF-8 JSON.', { cause: error });
  }
  if (!bytes.equals(canonicalJsonBytes(value))) {
    throw new Error('Browser result record is not canonical JSON.');
  }
  return value;
}

function missingCell(scenario, browser) {
  return {
    scenarioId: scenario.id,
    browser,
    state: 'not_run',
    implementationStatus: semanticScenarioStatus(scenario),
    resultRecordSha256: null,
    assertions: scenario.requiredAssertions.map((id) => ({
      id,
      state: 'not_run',
      validatorId: semanticValidatorEntry(scenario.id, id).validatorId
    })),
    finding: 'No exact result record was retained.'
  };
}

function semanticScenarioStatus(scenario) {
  const statuses = scenario.requiredAssertions.map((id) => semanticValidatorEntry(scenario.id, id).status);
  if (statuses.every((status) => status === 'implemented')) return 'implemented';
  if (statuses.every((status) => status === 'not_implemented')) return 'not_implemented';
  return 'partial';
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(keys) !== JSON.stringify(sortedExpected)) {
    throw new Error(`${label} keys differ from the exact schema.`);
  }
}

function assertTimestampOrder(startedAt, completedAt, label) {
  assertIsoTimestamp(startedAt, `${label} startedAt`);
  assertIsoTimestamp(completedAt, `${label} completedAt`);
  if (Date.parse(completedAt) < Date.parse(startedAt)) throw new Error(`${label} timestamps are reversed.`);
}

function assertIsoTimestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${label} is not an ISO timestamp.`);
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

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNodeVersion(value) {
  return /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(String(value || ''));
}

function exactArray(actual, expected) {
  return Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected);
}

function isSha256(value) {
  return /^[A-F0-9]{64}$/.test(String(value || ''));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

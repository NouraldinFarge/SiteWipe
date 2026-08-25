import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

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

export const BROWSER_PLAN_SCHEMA = 'sitewipe.unattended-browser-plan.v1';
export const SCENARIO_RESULT_SCHEMA = 'sitewipe.installed-browser-scenario-result.v1';
export const RESULT_RECORD_SCHEMA = 'sitewipe.installed-browser-result-record.v1';
export const RAW_EVIDENCE_SCHEMA = 'sitewipe.installed-browser-raw-evidence.v1';
export const AGGREGATE_SCHEMA = 'sitewipe.installed-browser-aggregate.v1';
export const RESULT_STATES = Object.freeze(['passed', 'failed', 'limited', 'not_run']);
export const SEMANTIC_VALIDATION_STATUS = 'not_implemented';
export const FIXED_FIXTURE_BIND_ADDRESSES = Object.freeze(['127.0.0.1', '::1']);
export const APPROVED_UNATTENDED_ACTIONS = Object.freeze([
  'filesystem.create_exact_owned_run',
  'fixture.bind_approved_loopback_only',
  'browser.launch_exact_pins_with_disposable_profiles',
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
  'schema'
]);
const RESULT_KEYS = Object.freeze([
  'assertions',
  'browser',
  'completedAt',
  'declaredState',
  'evidence',
  'identity',
  'matrixSha256',
  'matrixVersion',
  'planSha256',
  'reason',
  'runId',
  'scenarioId',
  'schema',
  'semanticValidationStatus',
  'startedAt',
  'teardown'
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
  if (!/^sitewipe-browser-[a-f0-9]{32}$/.test(String(plan.runId || ''))) {
    throw new Error('Browser plan runId is malformed.');
  }
  assertIsoTimestamp(plan.createdAt, 'Browser plan createdAt');
  validateIdentity(plan.identity);
  validatePlanInputs(plan.inputs);
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
    if (evidenceIds.has(entry.id)) throw new Error(`Browser scenario result repeats evidence ID ${entry.id}.`);
    evidenceIds.add(entry.id);
  }

  if (!Array.isArray(result.assertions)) throw new Error('Browser scenario assertions must be an array.');
  const assertions = new Map();
  for (const assertion of result.assertions) {
    validateAssertion(assertion, evidenceIds);
    if (!scenario.requiredAssertions.includes(assertion.id)) {
      throw new Error(`${result.scenarioId} claims unknown assertion ${assertion.id}.`);
    }
    if (assertions.has(assertion.id)) throw new Error(`${result.scenarioId} repeats assertion ${assertion.id}.`);
    assertions.set(assertion.id, assertion);
  }
  validateTeardown(result.teardown, evidenceIds);

  if (result.semanticValidationStatus !== SEMANTIC_VALIDATION_STATUS) {
    throw new Error('Browser scenario result has no recognized canonical semantic-validator inventory status.');
  }
  if (result.assertions.some((assertion) => assertion.state !== 'not_run') || result.teardown.state !== 'not_run') {
    throw new Error(
      'Browser semantic validators are not implemented; assertions and teardown cannot claim observed states.'
    );
  }

  const derivedState = deriveScenarioState({
    scenario,
    assertions,
    teardown: result.teardown,
    semanticValidationStatus: result.semanticValidationStatus
  });
  if (result.declaredState !== derivedState) {
    throw new Error(
      `${result.scenarioId}/${result.browser.name} declares ${String(result.declaredState)} but mechanically derives ${derivedState}.`
    );
  }
  if (derivedState === 'not_run' && !isNonEmptyString(result.reason)) {
    throw new Error('A not_run scenario result must retain a reason.');
  }
  if (derivedState !== 'not_run' && result.reason !== null && !isNonEmptyString(result.reason)) {
    throw new Error('A scenario result reason must be null or a non-empty string.');
  }
  return Object.freeze({ scenario, state: derivedState });
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
      decoded.push({ record, result: value, state: validated.state });
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
          resultRecordSha256: null,
          assertions: [],
          finding: `Expected one result record; observed ${matches.length}.`
        });
        integrityFindings.push(`${scenario.id}/${browserName} has ${matches.length} result records.`);
        continue;
      }
      const [{ record, result, state }] = matches;
      cells.push({
        scenarioId: scenario.id,
        browser: browserName,
        state,
        resultRecordSha256: record.sha256,
        assertions: scenario.requiredAssertions.map((id) => ({
          id,
          state: result.assertions.find((entry) => entry.id === id)?.state || 'not_run'
        })),
        finding: result.reason
      });
      if (state !== 'passed') executionFindings.push(`${scenario.id}/${browserName} is ${state}.`);
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
    ['artifactPath', 'browserPins', 'fixture', 'git', 'nativePrompt', 'repositoryRoot', 'retention', 'workspaceRoot'],
    'Browser plan inputs'
  );
  if (
    !isAbsolute(String(inputs.repositoryRoot || '')) ||
    !isAbsolute(String(inputs.workspaceRoot || '')) ||
    !isAbsolute(String(inputs.artifactPath || ''))
  ) {
    throw new Error('Browser plan repository, workspace, and artifact paths must be absolute.');
  }
  if (!Array.isArray(inputs.browserPins) || inputs.browserPins.length !== REQUIRED_BROWSERS.length) {
    throw new Error('Browser plan must retain exactly two pinned browser inputs.');
  }
  assertExactKeys(inputs.git, ['path', 'sha256', 'version'], 'Trusted Git identity');
  if (
    !isAbsolute(String(inputs.git.path || '')) ||
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
    assertExactKeys(pin, ['executablePath', 'executableSha256', 'name', 'version'], 'Browser executable pin');
    if (
      !isAbsolute(String(pin.executablePath || '')) ||
      !isSha256(pin.executableSha256) ||
      !isNonEmptyString(pin.version)
    ) {
      throw new Error('Browser plan contains an incomplete executable pin.');
    }
  }
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
    !isAbsolute(String(inputs.nativePrompt.helperPath || '')) ||
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
      'gitExecutableSha256',
      'harnessManifestSha256',
      'nativeHelperSha256',
      'nodeExecutableSha256',
      'packageLockSha256',
      'releaseInputFingerprintSha256',
      'runtimeFingerprintSha256',
      'sourceCommitSha',
      'sourceTreeSha'
    ],
    'Browser evidence identity'
  );
  if (
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(String(identity.sourceCommitSha || '')) ||
    !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(String(identity.sourceTreeSha || '')) ||
    !/^\d+\.\d+\.\d+$/.test(String(identity.artifactVersion || '')) ||
    !Number.isInteger(identity.artifactBytes) ||
    identity.artifactBytes <= 0 ||
    ![
      identity.artifactSha256,
      identity.gitExecutableSha256,
      identity.harnessManifestSha256,
      identity.nativeHelperSha256,
      identity.nodeExecutableSha256,
      identity.packageLockSha256,
      identity.releaseInputFingerprintSha256,
      identity.runtimeFingerprintSha256
    ].every(isSha256)
  ) {
    throw new Error('Browser evidence identity is incomplete or malformed.');
  }
}

function validateBrowser(browser, plan) {
  assertExactKeys(browser, ['executablePath', 'executableSha256', 'name', 'version'], 'Browser result identity');
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

function validateAssertion(assertion, evidenceIds) {
  assertExactKeys(assertion, ['detail', 'evidenceIds', 'id', 'observedAt', 'state'], 'Browser assertion');
  if (!isNonEmptyString(assertion.id) || !RESULT_STATES.includes(assertion.state)) {
    throw new Error('Browser assertion has an invalid ID or state.');
  }
  assertIsoTimestamp(assertion.observedAt, `Browser assertion ${assertion.id}`);
  if (
    !Array.isArray(assertion.evidenceIds) ||
    new Set(assertion.evidenceIds).size !== assertion.evidenceIds.length ||
    assertion.evidenceIds.some((id) => !evidenceIds.has(id))
  ) {
    throw new Error(`Browser assertion ${assertion.id} has missing, duplicate, or unknown evidence references.`);
  }
  if (assertion.state !== 'not_run' && assertion.evidenceIds.length === 0) {
    throw new Error(`Browser assertion ${assertion.id} cannot claim ${assertion.state} without raw evidence.`);
  }
  if (assertion.detail !== null && !isNonEmptyString(assertion.detail)) {
    throw new Error(`Browser assertion ${assertion.id} detail must be null or a non-empty string.`);
  }
}

function validateTeardown(teardown, evidenceIds) {
  assertExactKeys(teardown, ['detail', 'evidenceIds', 'observedAt', 'state'], 'Browser teardown');
  if (!RESULT_STATES.includes(teardown.state)) throw new Error('Browser teardown has an invalid state.');
  assertIsoTimestamp(teardown.observedAt, 'Browser teardown');
  if (
    !Array.isArray(teardown.evidenceIds) ||
    new Set(teardown.evidenceIds).size !== teardown.evidenceIds.length ||
    teardown.evidenceIds.some((id) => !evidenceIds.has(id)) ||
    (teardown.state !== 'not_run' && teardown.evidenceIds.length === 0)
  ) {
    throw new Error('Browser teardown lacks exact raw evidence references.');
  }
  if (teardown.detail !== null && !isNonEmptyString(teardown.detail)) {
    throw new Error('Browser teardown detail must be null or a non-empty string.');
  }
}

function deriveScenarioState({ scenario, assertions, teardown, semanticValidationStatus }) {
  if (semanticValidationStatus === SEMANTIC_VALIDATION_STATUS) return 'not_run';
  const states = scenario.requiredAssertions.map((id) => assertions.get(id)?.state || 'not_run');
  states.push(teardown.state);
  return aggregateState(states);
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
    resultRecordSha256: null,
    assertions: scenario.requiredAssertions.map((id) => ({ id, state: 'not_run' })),
    finding: 'No exact result record was retained.'
  };
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

function exactArray(actual, expected) {
  return Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected);
}

function isSha256(value) {
  return /^[A-F0-9]{64}$/.test(String(value || ''));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

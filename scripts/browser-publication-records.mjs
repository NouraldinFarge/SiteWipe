import {
  BROWSER_MATRIX_VERSION,
  CANONICAL_BROWSER_MATRIX_IDS,
  CANONICAL_BROWSER_MATRIX_SHA256,
  REQUIRED_BROWSERS
} from './browser-validation-policy.mjs';
import {
  BROWSER_PUBLIC_SEMANTIC_REPLAY,
  createBrowserSemanticReceipts,
  validateBrowserSemanticReceipts
} from './browser-semantic-receipts.mjs';
import {
  BROWSER_PRIVATE_EVIDENCE_RETAINED_STATUS,
  BROWSER_PUBLICATION_BINDING_SCHEMA,
  findTrackedBrowserEvidencePrivacyFindings
} from './publication-evidence-contract.mjs';
import {
  computeAggregateSha256,
  validateAndReplayBrowserAggregate,
  validateBrowserPlan
} from '../tests/browser/installed/evidence-contract.mjs';

export const BROWSER_PUBLICATION_RECORDS_SCHEMA = 'sitewipe.browser-publication-records.v1';

const RECORD_KEYS = Object.freeze([
  'brave',
  'chrome',
  'completedAt',
  'installedEvidence',
  'schema',
  'semanticReceipts',
  'technicalStatus'
]);
const INSTALLED_EVIDENCE_KEYS = Object.freeze([
  'aggregateSha256',
  'completedAt',
  'executionPlanSha256',
  'identity',
  'matrixSha256',
  'matrixVersion',
  'privateEvidenceRetained',
  'publicSemanticReplay',
  'requiredMatrixIds',
  'resultRecordCount',
  'resultSetSha256',
  'runId',
  'schema',
  'status'
]);
const COMPLETION_KEYS = Object.freeze([
  'aggregateSha256',
  'automaticRecursiveDeletionPerformed',
  'completedAt',
  'detail',
  'planSha256',
  'resultRecordCount',
  'resultSetSha256',
  'retainedRunRoot',
  'runId',
  'schema',
  'semanticValidationStatus',
  'state'
]);
const BROWSER_KEYS = Object.freeze(['assertions', 'disposableProfile', 'operatingSystem', 'status', 'version']);
const ASSERTION_KEYS = Object.freeze(['artifactSha256', 'id', 'matrixCoverage', 'observedAt', 'status']);
const STATES = Object.freeze(['failed', 'limited', 'not_run', 'passed']);
const EXPECTED_RECORD_COUNT = CANONICAL_BROWSER_MATRIX_IDS.length * REQUIRED_BROWSERS.length;

export function createBrowserPublicationRecords(options) {
  const context = validatePrivateRun(options);
  const records = buildRecords(context);
  validatePublicRecords(records, context);
  return deepFreeze(records);
}

export function validateBrowserPublicationRecords(records, options) {
  const context = validatePrivateRun(options);
  validatePublicRecords(records, context);
  const expected = buildRecords(context);
  if (stableJson(records) !== stableJson(expected)) {
    throw new Error('Browser publication records differ from the exact mechanical private-run projection.');
  }
  return records;
}

export function applyBrowserPublicationRecords(options) {
  assertExactKeys(
    options,
    ['aggregate', 'browserValidation', 'completion', 'plan', 'records'],
    'Browser publication-record application options'
  );
  const { aggregate, browserValidation, completion, plan, records } = options;
  validateBrowserPublicationRecords(records, { aggregate, completion, plan });
  if (!isPlainObject(browserValidation) || browserValidation.schemaVersion !== 1) {
    throw new Error('Browser publication records require one schemaVersion 1 browser-validation record.');
  }
  if (browserValidation.reviewerApproval !== false) {
    throw new Error('Automation cannot create, replace, preserve, or revoke a reviewer approval.');
  }
  if (browserValidation.automationAttempt !== null) {
    throw new Error('Tracked browser automationAttempt must remain null; private run details are not publishable.');
  }

  const updated = structuredClone(browserValidation);
  updated.status =
    records.technicalStatus === 'passed' ? 'technical_passed_pending_reviewer_approval' : records.technicalStatus;
  updated.attemptedAt = records.completedAt;
  updated.artifact = {
    version: records.installedEvidence.identity.artifactVersion,
    runtimeZip: `sitewipe-unreleased-candidate-${records.installedEvidence.identity.artifactVersion}.zip`,
    sha256: records.installedEvidence.identity.artifactSha256
  };
  updated.chrome = structuredClone(records.chrome);
  updated.brave = structuredClone(records.brave);
  updated.installedEvidence = structuredClone(records.installedEvidence);
  updated.matrixVersion = BROWSER_MATRIX_VERSION;
  updated.matrixSha256 = CANONICAL_BROWSER_MATRIX_SHA256;
  updated.requiredMatrix = [...CANONICAL_BROWSER_MATRIX_IDS];
  updated.reviewerApproval = false;

  const findings = findTrackedBrowserEvidencePrivacyFindings(updated);
  if (findings.length > 0) {
    throw new Error(`Applied browser publication record is not path-safe: ${findings.join(' ')}`);
  }
  return deepFreeze(updated);
}

function validatePrivateRun(options) {
  assertExactKeys(options, ['aggregate', 'completion', 'plan'], 'Browser publication-record inputs');
  const { aggregate, completion, plan } = options;
  validateBrowserPlan(plan);
  const replayed = validateAndReplayBrowserAggregate(aggregate, { plan });
  assertExactKeys(completion, COMPLETION_KEYS, 'Owned browser run completion receipt');

  if (
    completion.schema !== 'sitewipe.owned-browser-run-completion.v1' ||
    completion.runId !== plan.runId ||
    completion.planSha256 !== plan.planSha256 ||
    completion.state !== replayed.state ||
    completion.aggregateSha256 !== computeAggregateSha256(replayed) ||
    completion.resultSetSha256 !== replayed.resultSetSha256 ||
    completion.resultRecordCount !== replayed.resultRecordCount ||
    completion.semanticValidationStatus !== replayed.semanticValidationStatus ||
    completion.retainedRunRoot !== true ||
    completion.automaticRecursiveDeletionPerformed !== false ||
    !isIsoTimestamp(completion.completedAt) ||
    (completion.detail !== null && (typeof completion.detail !== 'string' || !completion.detail.trim()))
  ) {
    throw new Error('Browser completion does not exactly bind the validated aggregate and approved plan.');
  }
  if (
    replayed.runId !== plan.runId ||
    replayed.planSha256 !== plan.planSha256 ||
    replayed.matrixVersion !== BROWSER_MATRIX_VERSION ||
    replayed.matrixSha256 !== CANONICAL_BROWSER_MATRIX_SHA256 ||
    stableJson(replayed.identity) !== stableJson(plan.identity) ||
    replayed.resultRecordCount !== EXPECTED_RECORD_COUNT ||
    replayed.resultRecords.length !== EXPECTED_RECORD_COUNT ||
    replayed.cells.length !== EXPECTED_RECORD_COUNT ||
    replayed.integrityFindings.length !== 0 ||
    replayed.cells.some(({ resultRecordSha256 }) => !isSha256(resultRecordSha256)) ||
    new Set(replayed.cells.map(({ resultRecordSha256 }) => resultRecordSha256)).size !== EXPECTED_RECORD_COUNT
  ) {
    throw new Error('Browser aggregate is not one exact, integrity-clean 48-record canonical matrix run.');
  }
  return Object.freeze({ completion, plan, replayed });
}

function buildRecords({ completion, plan, replayed }) {
  const semanticReceipts = createBrowserSemanticReceipts({
    plan,
    aggregate: replayed,
    completedAt: completion.completedAt
  });
  const installedEvidence = {
    schema: BROWSER_PUBLICATION_BINDING_SCHEMA,
    status: BROWSER_PRIVATE_EVIDENCE_RETAINED_STATUS,
    runId: plan.runId,
    completedAt: completion.completedAt,
    matrixVersion: BROWSER_MATRIX_VERSION,
    matrixSha256: CANONICAL_BROWSER_MATRIX_SHA256,
    requiredMatrixIds: [...CANONICAL_BROWSER_MATRIX_IDS],
    executionPlanSha256: plan.planSha256,
    aggregateSha256: completion.aggregateSha256,
    resultSetSha256: completion.resultSetSha256,
    resultRecordCount: completion.resultRecordCount,
    identity: structuredClone(plan.identity),
    privateEvidenceRetained: true,
    publicSemanticReplay: BROWSER_PUBLIC_SEMANTIC_REPLAY
  };

  const summaries = Object.fromEntries(
    REQUIRED_BROWSERS.map((browserName) => {
      const receiptBrowser = semanticReceipts.browsers.find(({ browser }) => browser === browserName);
      const cells = semanticReceipts.cells.filter(({ browser }) => browser === browserName);
      const smokeCell = cells.find(({ scenarioId }) => scenarioId === 'SMOKE-01');
      return [
        browserName,
        {
          status: receiptBrowser.state,
          version: receiptBrowser.version,
          operatingSystem: 'Windows',
          disposableProfile: smokeCell?.state === 'passed',
          assertions: cells.map((cell) => ({
            id: `${browserName}-installed-${cell.scenarioId.toLowerCase()}`,
            status: cell.state,
            observedAt: completion.completedAt,
            artifactSha256: plan.identity.artifactSha256,
            matrixCoverage: [cell.scenarioId]
          }))
        }
      ];
    })
  );

  return {
    schema: BROWSER_PUBLICATION_RECORDS_SCHEMA,
    technicalStatus: semanticReceipts.status,
    completedAt: completion.completedAt,
    installedEvidence,
    semanticReceipts: structuredClone(semanticReceipts),
    chrome: summaries.chrome,
    brave: summaries.brave
  };
}

function validatePublicRecords(records, { completion, plan, replayed }) {
  assertExactKeys(records, RECORD_KEYS, 'Browser publication records');
  if (
    records.schema !== BROWSER_PUBLICATION_RECORDS_SCHEMA ||
    records.technicalStatus !== replayed.state ||
    records.completedAt !== completion.completedAt ||
    !STATES.includes(records.technicalStatus)
  ) {
    throw new Error('Browser publication records have a stale schema, state, or completion time.');
  }
  assertExactKeys(records.installedEvidence, INSTALLED_EVIDENCE_KEYS, 'Installed-browser public commitment');
  const installed = records.installedEvidence;
  if (
    installed.schema !== BROWSER_PUBLICATION_BINDING_SCHEMA ||
    installed.status !== BROWSER_PRIVATE_EVIDENCE_RETAINED_STATUS ||
    installed.runId !== plan.runId ||
    installed.completedAt !== completion.completedAt ||
    installed.matrixVersion !== BROWSER_MATRIX_VERSION ||
    installed.matrixSha256 !== CANONICAL_BROWSER_MATRIX_SHA256 ||
    stableJson(installed.requiredMatrixIds) !== stableJson(CANONICAL_BROWSER_MATRIX_IDS) ||
    installed.executionPlanSha256 !== plan.planSha256 ||
    installed.aggregateSha256 !== completion.aggregateSha256 ||
    installed.resultSetSha256 !== completion.resultSetSha256 ||
    installed.resultRecordCount !== EXPECTED_RECORD_COUNT ||
    stableJson(installed.identity) !== stableJson(plan.identity) ||
    installed.privateEvidenceRetained !== true ||
    installed.publicSemanticReplay !== BROWSER_PUBLIC_SEMANTIC_REPLAY
  ) {
    throw new Error('Installed-browser public commitment differs from the exact private-run identity.');
  }

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
  });
  if (records.semanticReceipts.status !== records.technicalStatus) {
    throw new Error('Browser semantic receipt status differs from the technical publication status.');
  }

  for (const browserName of REQUIRED_BROWSERS) {
    validateBrowserSummary(records[browserName], browserName, records);
  }
  assertPathFree(records);
}

function validateBrowserSummary(summary, browserName, records) {
  assertExactKeys(summary, BROWSER_KEYS, `Browser publication ${browserName} summary`);
  const receiptBrowser = records.semanticReceipts.browsers.find(({ browser }) => browser === browserName);
  const receiptCells = records.semanticReceipts.cells.filter(({ browser }) => browser === browserName);
  if (
    !receiptBrowser ||
    summary.status !== receiptBrowser.state ||
    summary.version !== receiptBrowser.version ||
    summary.operatingSystem !== 'Windows' ||
    typeof summary.disposableProfile !== 'boolean' ||
    summary.disposableProfile !==
      (receiptCells.find(({ scenarioId }) => scenarioId === 'SMOKE-01')?.state === 'passed') ||
    !Array.isArray(summary.assertions) ||
    summary.assertions.length !== CANONICAL_BROWSER_MATRIX_IDS.length
  ) {
    throw new Error(`Browser publication ${browserName} summary differs from its semantic receipt.`);
  }
  for (const [index, assertion] of summary.assertions.entries()) {
    const scenarioId = CANONICAL_BROWSER_MATRIX_IDS[index];
    const receiptCell = receiptCells[index];
    assertExactKeys(assertion, ASSERTION_KEYS, `Browser publication ${browserName} assertion ${index + 1}`);
    if (
      receiptCell?.scenarioId !== scenarioId ||
      assertion.id !== `${browserName}-installed-${scenarioId.toLowerCase()}` ||
      assertion.status !== receiptCell.state ||
      assertion.observedAt !== records.completedAt ||
      assertion.artifactSha256 !== records.installedEvidence.identity.artifactSha256 ||
      stableJson(assertion.matrixCoverage) !== stableJson([scenarioId])
    ) {
      throw new Error(`Browser publication ${browserName} assertion ${index + 1} launders or misbinds its cell.`);
    }
  }
}

function assertPathFree(value, key = '') {
  if (typeof value === 'string') {
    if (
      /^file:/i.test(value) ||
      /(?:^|[\s('"`])(?:[A-Za-z]:[\\/]|\\\\|\/(?:home|Users|tmp|var)\/)/u.test(value) ||
      /https?:\/\//i.test(value)
    ) {
      throw new Error('Browser publication records contain a private path or URL.');
    }
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [childKey, child] of Object.entries(value)) {
    if (/(?:path|root|token|base64|raw)/i.test(childKey)) {
      throw new Error(`Browser publication records contain a forbidden private field (${key}${childKey}).`);
    }
    assertPathFree(child, `${key}${childKey}.`);
  }
}

function assertExactKeys(value, expected, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object.`);
  if (stableJson(Object.keys(value).sort()) !== stableJson([...expected].sort())) {
    throw new Error(`${label} keys differ from the exact schema.`);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isSha256(value) {
  return /^[A-F0-9]{64}$/.test(String(value || ''));
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
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

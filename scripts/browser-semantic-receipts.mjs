import { createHash } from 'node:crypto';

import {
  BROWSER_MATRIX_VERSION,
  CANONICAL_BROWSER_MATRIX,
  CANONICAL_BROWSER_MATRIX_SHA256,
  REQUIRED_BROWSERS
} from './browser-validation-policy.mjs';
import {
  SEMANTIC_IMPLEMENTED_ASSERTION_COUNT,
  SEMANTIC_NOT_IMPLEMENTED_ASSERTION_COUNT,
  computeAggregateSha256,
  validateAndReplayBrowserAggregate,
  validateBrowserPlan
} from '../tests/browser/installed/evidence-contract.mjs';
import {
  SEMANTIC_VALIDATOR_MANIFEST_SHA256,
  semanticValidatorEntry,
  semanticScenarioImplementationStatus
} from '../tests/browser/installed/semantic-validator.mjs';
import { PINNED_PUPPETEER_CORE_VERSION } from '../tests/browser/installed/toolchain-closure.mjs';

export const BROWSER_SEMANTIC_RECEIPTS_SCHEMA = 'sitewipe.browser-semantic-receipts.v1';
export const BROWSER_PUBLIC_SEMANTIC_REPLAY = 'path_free_receipt_from_private_typed_replay_v1';

const RECEIPT_KEYS = Object.freeze([
  'aggregateSha256',
  'browsers',
  'cells',
  'completedAt',
  'executionPlanSha256',
  'identity',
  'matrixSha256',
  'matrixVersion',
  'privateEvidenceRetained',
  'publicSemanticReplay',
  'recordedByAutomation',
  'resultRecordCount',
  'resultSetSha256',
  'runId',
  'schema',
  'semanticValidatorCounts',
  'semanticValidatorManifestSha256',
  'status'
]);
const CELL_KEYS = Object.freeze([
  'assertionCounts',
  'browser',
  'implementationStatus',
  'resultRecordSha256',
  'scenarioId',
  'state'
]);
const BROWSER_KEYS = Object.freeze([
  'browser',
  'executableSha256',
  'runtimeManifestSha256',
  'scenarioCounts',
  'state',
  'version'
]);
const COUNT_KEYS = Object.freeze(['failed', 'limited', 'notRun', 'passed', 'total']);
export const BROWSER_SEMANTIC_RECEIPT_IDENTITY_KEYS = Object.freeze([
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
const STATES = Object.freeze(['failed', 'limited', 'not_run', 'passed']);

export function createBrowserSemanticReceipts({ plan, aggregate, completedAt }) {
  validateBrowserPlan(plan);
  const replayed = validateAndReplayBrowserAggregate(aggregate, { plan });
  const receipt = {
    schema: BROWSER_SEMANTIC_RECEIPTS_SCHEMA,
    status: replayed.state,
    runId: plan.runId,
    completedAt,
    matrixVersion: BROWSER_MATRIX_VERSION,
    matrixSha256: CANONICAL_BROWSER_MATRIX_SHA256,
    semanticValidatorManifestSha256: SEMANTIC_VALIDATOR_MANIFEST_SHA256,
    executionPlanSha256: plan.planSha256,
    aggregateSha256: computeAggregateSha256(replayed),
    resultSetSha256: replayed.resultSetSha256,
    resultRecordCount: replayed.resultRecordCount,
    semanticValidatorCounts: {
      implemented: SEMANTIC_IMPLEMENTED_ASSERTION_COUNT,
      notImplemented: SEMANTIC_NOT_IMPLEMENTED_ASSERTION_COUNT,
      total: SEMANTIC_IMPLEMENTED_ASSERTION_COUNT + SEMANTIC_NOT_IMPLEMENTED_ASSERTION_COUNT
    },
    cells: replayed.cells.map((cell) => ({
      scenarioId: cell.scenarioId,
      browser: cell.browser,
      state: cell.state,
      implementationStatus: cell.implementationStatus,
      resultRecordSha256: cell.resultRecordSha256,
      assertionCounts: stateCounts(cell.assertions.map(({ state }) => state))
    })),
    browsers: REQUIRED_BROWSERS.map((browserName) => {
      const pin = plan.inputs.browserPins.find(({ name }) => name === browserName);
      const cells = replayed.cells.filter(({ browser }) => browser === browserName);
      return {
        browser: browserName,
        version: pin.version,
        executableSha256: pin.executableSha256,
        runtimeManifestSha256: pin.runtimeManifestSha256,
        state: aggregateState(cells.map(({ state }) => state)),
        scenarioCounts: stateCounts(cells.map(({ state }) => state))
      };
    }),
    identity: structuredClone(plan.identity),
    privateEvidenceRetained: true,
    publicSemanticReplay: BROWSER_PUBLIC_SEMANTIC_REPLAY,
    recordedByAutomation: true
  };
  validateBrowserSemanticReceipts(receipt);
  return deepFreeze(receipt);
}

export function validateBrowserSemanticReceipts(receipt, { expected = null } = {}) {
  assertExactKeys(receipt, RECEIPT_KEYS, 'Browser semantic receipts');
  if (
    receipt.schema !== BROWSER_SEMANTIC_RECEIPTS_SCHEMA ||
    !STATES.includes(receipt.status) ||
    !/^sitewipe-browser-[a-f0-9]{32}$/.test(String(receipt.runId || '')) ||
    !isIsoTimestamp(receipt.completedAt) ||
    receipt.matrixVersion !== BROWSER_MATRIX_VERSION ||
    receipt.matrixSha256 !== CANONICAL_BROWSER_MATRIX_SHA256 ||
    receipt.semanticValidatorManifestSha256 !== SEMANTIC_VALIDATOR_MANIFEST_SHA256 ||
    !isSha256(receipt.executionPlanSha256) ||
    !isSha256(receipt.aggregateSha256) ||
    !isSha256(receipt.resultSetSha256) ||
    !Number.isInteger(receipt.resultRecordCount) ||
    receipt.resultRecordCount < 0 ||
    receipt.resultRecordCount > CANONICAL_BROWSER_MATRIX.length * REQUIRED_BROWSERS.length ||
    receipt.privateEvidenceRetained !== true ||
    receipt.publicSemanticReplay !== BROWSER_PUBLIC_SEMANTIC_REPLAY ||
    receipt.recordedByAutomation !== true
  ) {
    throw new Error('Browser semantic receipts have an invalid schema, identity, digest, time, or origin.');
  }
  assertExactKeys(
    receipt.semanticValidatorCounts,
    ['implemented', 'notImplemented', 'total'],
    'Browser semantic-validator counts'
  );
  if (
    receipt.semanticValidatorCounts.implemented !== SEMANTIC_IMPLEMENTED_ASSERTION_COUNT ||
    receipt.semanticValidatorCounts.notImplemented !== SEMANTIC_NOT_IMPLEMENTED_ASSERTION_COUNT ||
    receipt.semanticValidatorCounts.total !==
      SEMANTIC_IMPLEMENTED_ASSERTION_COUNT + SEMANTIC_NOT_IMPLEMENTED_ASSERTION_COUNT
  ) {
    throw new Error('Browser semantic receipts differ from the exact validator inventory.');
  }
  validateIdentity(receipt.identity);
  const retainedRecordCount = validateCells(receipt.cells, receipt.status);
  if (retainedRecordCount !== receipt.resultRecordCount) {
    throw new Error('Browser semantic receipt result-record count differs from its retained cell commitments.');
  }
  validateBrowsers(receipt.browsers, receipt.cells);
  if (findPrivateValue(receipt)) {
    throw new Error('Browser semantic receipts contain a private path, URL, secret, raw value, or encoded payload.');
  }
  if (expected !== null) validateExpected(receipt, expected);
  return receipt;
}

export function computeBrowserSemanticReceiptsSha256(receipt) {
  validateBrowserSemanticReceipts(receipt);
  return sha256(canonicalJsonBytes(receipt));
}

function validateExpected(receipt, expected) {
  assertExactKeys(
    expected,
    [
      'aggregateSha256',
      'completedAt',
      'executionPlanSha256',
      'identity',
      'matrixSha256',
      'matrixVersion',
      'privateEvidenceRetained',
      'publicSemanticReplay',
      'resultRecordCount',
      'resultSetSha256',
      'runId'
    ],
    'Expected browser semantic receipt binding'
  );
  validateIdentity(expected.identity);
  if (
    receipt.aggregateSha256 !== expected.aggregateSha256 ||
    receipt.completedAt !== expected.completedAt ||
    receipt.executionPlanSha256 !== expected.executionPlanSha256 ||
    receipt.matrixSha256 !== expected.matrixSha256 ||
    receipt.matrixVersion !== expected.matrixVersion ||
    receipt.privateEvidenceRetained !== expected.privateEvidenceRetained ||
    receipt.publicSemanticReplay !== expected.publicSemanticReplay ||
    receipt.resultRecordCount !== expected.resultRecordCount ||
    receipt.resultSetSha256 !== expected.resultSetSha256 ||
    receipt.runId !== expected.runId ||
    BROWSER_SEMANTIC_RECEIPT_IDENTITY_KEYS.some((key) => receipt.identity[key] !== expected.identity[key])
  ) {
    throw new Error('Browser semantic receipts differ from independently expected private-run commitments.');
  }
}

function validateIdentity(identity) {
  assertExactKeys(identity, BROWSER_SEMANTIC_RECEIPT_IDENTITY_KEYS, 'Browser semantic receipt identity');
  if (
    !isGitObjectId(identity.sourceCommitSha) ||
    !isGitObjectId(identity.sourceTreeSha) ||
    !/^\d+\.\d+\.\d+$/.test(String(identity.artifactVersion || '')) ||
    !/^v\d+\.\d+\.\d+$/.test(String(identity.nodeRuntimeVersion || '')) ||
    identity.toolchainPuppeteerVersion !== PINNED_PUPPETEER_CORE_VERSION ||
    !Number.isInteger(identity.artifactBytes) ||
    identity.artifactBytes <= 0 ||
    !Number.isSafeInteger(identity.toolchainPackageCount) ||
    identity.toolchainPackageCount <= 0 ||
    !Number.isSafeInteger(identity.toolchainFileCount) ||
    identity.toolchainFileCount <= 0 ||
    !Number.isSafeInteger(identity.toolchainBytes) ||
    identity.toolchainBytes <= 0 ||
    BROWSER_SEMANTIC_RECEIPT_IDENTITY_KEYS.filter((key) => key.endsWith('Sha256')).some(
      (key) => !isSha256(identity[key])
    )
  ) {
    throw new Error('Browser semantic receipt identity is incomplete or malformed.');
  }
}

function validateCells(cells, status) {
  if (!Array.isArray(cells) || cells.length !== CANONICAL_BROWSER_MATRIX.length * REQUIRED_BROWSERS.length) {
    throw new Error('Browser semantic receipts must contain exactly the canonical 48 cells.');
  }
  let index = 0;
  for (const scenario of CANONICAL_BROWSER_MATRIX) {
    for (const browserName of REQUIRED_BROWSERS) {
      const cell = cells[index];
      assertExactKeys(cell, CELL_KEYS, `Browser semantic receipt cell ${index + 1}`);
      if (
        cell.scenarioId !== scenario.id ||
        cell.browser !== browserName ||
        !STATES.includes(cell.state) ||
        cell.implementationStatus !== semanticScenarioImplementationStatus(scenario.id) ||
        (cell.resultRecordSha256 !== null && !isSha256(cell.resultRecordSha256))
      ) {
        throw new Error(`Browser semantic receipt cell ${index + 1} differs from the canonical order or schema.`);
      }
      validateCounts(cell.assertionCounts, `Browser semantic receipt cell ${index + 1} assertion counts`);
      if (cell.assertionCounts.total !== scenario.requiredAssertions.length) {
        throw new Error(`Browser semantic receipt cell ${index + 1} assertion total differs from the matrix.`);
      }
      if (aggregateCountState(cell.assertionCounts) !== cell.state) {
        throw new Error(`Browser semantic receipt cell ${index + 1} state differs from its assertion counts.`);
      }
      const notImplementedAssertionCount = scenario.requiredAssertions.filter(
        (assertionId) => semanticValidatorEntry(scenario.id, assertionId).status === 'not_implemented'
      ).length;
      if (cell.assertionCounts.notRun < notImplementedAssertionCount) {
        throw new Error(
          `Browser semantic receipt cell ${index + 1} launders assertions without implemented validators.`
        );
      }
      if (
        cell.resultRecordSha256 === null &&
        (cell.state !== 'not_run' || cell.assertionCounts.notRun !== cell.assertionCounts.total)
      ) {
        throw new Error(
          `Browser semantic receipt cell ${index + 1} has derived outcomes without a retained result-record commitment.`
        );
      }
      index += 1;
    }
  }
  if (aggregateState(cells.map(({ state }) => state)) !== status) {
    throw new Error('Browser semantic receipt status differs from its exact cell states.');
  }
  const retainedRecordHashes = cells
    .map(({ resultRecordSha256 }) => resultRecordSha256)
    .filter((resultRecordSha256) => resultRecordSha256 !== null);
  if (new Set(retainedRecordHashes).size !== retainedRecordHashes.length) {
    throw new Error('Browser semantic receipt repeats a result-record commitment across canonical cells.');
  }
  return retainedRecordHashes.length;
}

function validateBrowsers(browsers, cells) {
  if (!Array.isArray(browsers) || browsers.length !== REQUIRED_BROWSERS.length) {
    throw new Error('Browser semantic receipts must contain exact Brave and Chrome summaries.');
  }
  for (const [index, browser] of browsers.entries()) {
    const expectedName = REQUIRED_BROWSERS[index];
    assertExactKeys(browser, BROWSER_KEYS, `Browser semantic receipt ${expectedName} summary`);
    if (
      browser.browser !== expectedName ||
      !/^\d+(?:\.\d+){2,3}$/.test(String(browser.version || '')) ||
      !isSha256(browser.executableSha256) ||
      !isSha256(browser.runtimeManifestSha256) ||
      !STATES.includes(browser.state)
    ) {
      throw new Error(`Browser semantic receipt ${expectedName} summary is malformed.`);
    }
    validateCounts(browser.scenarioCounts, `Browser semantic receipt ${expectedName} scenario counts`);
    const browserCells = cells.filter((cell) => cell.browser === expectedName);
    if (
      browser.scenarioCounts.total !== CANONICAL_BROWSER_MATRIX.length ||
      browser.state !== aggregateState(browserCells.map(({ state }) => state)) ||
      JSON.stringify(browser.scenarioCounts) !== JSON.stringify(stateCounts(browserCells.map(({ state }) => state)))
    ) {
      throw new Error(`Browser semantic receipt ${expectedName} summary differs from its cells.`);
    }
  }
}

function stateCounts(states) {
  return {
    passed: states.filter((state) => state === 'passed').length,
    failed: states.filter((state) => state === 'failed').length,
    limited: states.filter((state) => state === 'limited').length,
    notRun: states.filter((state) => state === 'not_run').length,
    total: states.length
  };
}

function validateCounts(value, label) {
  assertExactKeys(value, COUNT_KEYS, label);
  if (
    Object.values(value).some((count) => !Number.isInteger(count) || count < 0) ||
    value.passed + value.failed + value.limited + value.notRun !== value.total
  ) {
    throw new Error(`${label} are inconsistent.`);
  }
}

function aggregateCountState(counts) {
  if (counts.failed > 0) return 'failed';
  if (counts.notRun > 0) return 'not_run';
  if (counts.limited > 0) return 'limited';
  return counts.total > 0 && counts.passed === counts.total ? 'passed' : 'not_run';
}

function aggregateState(states) {
  if (states.includes('failed')) return 'failed';
  if (states.includes('not_run')) return 'not_run';
  if (states.includes('limited')) return 'limited';
  return states.length > 0 && states.every((state) => state === 'passed') ? 'passed' : 'not_run';
}

function findPrivateValue(value, key = '') {
  if (typeof value === 'string') {
    const text = value.trim();
    return (
      /^file:/i.test(text) ||
      /(?:^|[\s('"`])(?:[A-Za-z]:[\\/]|\\\\|\/(?:home|Users|tmp|var)\/)/u.test(value) ||
      /https?:\/\//i.test(text) ||
      /(?:path|root|directory|token|capability|cookie|base64|raw)/i.test(key) ||
      (text.length >= 32 &&
        text.length % 4 === 0 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(text) &&
        !isSha256(text) &&
        !isGitObjectId(text))
    );
  }
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([childKey, child]) => findPrivateValue(child, childKey));
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} keys differ from the exact schema.`);
  }
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

function isGitObjectId(value) {
  return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(String(value || ''));
}

function isSha256(value) {
  return /^[A-F0-9]{64}$/.test(String(value || ''));
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

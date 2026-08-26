import assert from 'node:assert/strict';
import test from 'node:test';

import { CANONICAL_BROWSER_MATRIX, REQUIRED_BROWSERS } from '../../scripts/browser-validation-policy.mjs';
import {
  BROWSER_PUBLIC_SEMANTIC_REPLAY,
  BROWSER_SEMANTIC_RECEIPTS_SCHEMA,
  computeBrowserSemanticReceiptsSha256,
  validateBrowserSemanticReceipts
} from '../../scripts/browser-semantic-receipts.mjs';
import {
  SEMANTIC_IMPLEMENTED_ASSERTION_COUNT,
  SEMANTIC_NOT_IMPLEMENTED_ASSERTION_COUNT
} from '../../tests/browser/installed/evidence-contract.mjs';
import {
  SEMANTIC_VALIDATOR_MANIFEST_SHA256,
  semanticScenarioImplementationStatus
} from '../../tests/browser/installed/semantic-validator.mjs';

test('path-free semantic receipt validates an exact truthful 48-cell not-run projection', () => {
  const receipt = validReceipt();
  assert.equal(validateBrowserSemanticReceipts(receipt), receipt);
  assert.match(computeBrowserSemanticReceiptsSha256(receipt), /^[A-F0-9]{64}$/);
});

test('semantic receipt rejects cell laundering, private paths, and self-selected expected identity', () => {
  const passed = validReceipt();
  passed.cells[0].state = 'passed';
  passed.cells[0].assertionCounts = {
    passed: passed.cells[0].assertionCounts.total,
    failed: 0,
    limited: 0,
    notRun: 0,
    total: passed.cells[0].assertionCounts.total
  };
  assert.throws(
    () => validateBrowserSemanticReceipts(passed),
    /status differs|summary differs|without a retained result-record commitment/
  );

  const privateValue = validReceipt();
  privateValue.runId = 'C:\\Users\\Nah\\private';
  assert.throws(() => validateBrowserSemanticReceipts(privateValue), /invalid schema|private path/);

  const binding = validReceipt();
  assert.throws(
    () =>
      validateBrowserSemanticReceipts(binding, {
        expected: {
          aggregateSha256: '9'.repeat(64),
          completedAt: binding.completedAt,
          executionPlanSha256: binding.executionPlanSha256,
          identity: structuredClone(binding.identity),
          matrixSha256: binding.matrixSha256,
          matrixVersion: binding.matrixVersion,
          privateEvidenceRetained: binding.privateEvidenceRetained,
          publicSemanticReplay: binding.publicSemanticReplay,
          resultRecordCount: binding.resultRecordCount,
          resultSetSha256: binding.resultSetSha256,
          runId: binding.runId
        }
      }),
    /independently expected/
  );

  const implementationStatus = validReceipt();
  implementationStatus.cells[0].implementationStatus =
    implementationStatus.cells[0].implementationStatus === 'implemented' ? 'not_implemented' : 'implemented';
  assert.throws(() => validateBrowserSemanticReceipts(implementationStatus), /canonical order or schema/);

  const resultRecordCount = validReceipt();
  resultRecordCount.cells[0].resultRecordSha256 = 'D'.repeat(64);
  assert.throws(() => validateBrowserSemanticReceipts(resultRecordCount), /result-record count/);
});

test('semantic receipt counts limited states without laundering their aggregate state', () => {
  const receipt = validReceipt();
  const scenarioAssertionCount = receipt.cells[0].assertionCounts.total;
  receipt.cells[0].state = 'limited';
  receipt.cells[0].resultRecordSha256 = 'E'.repeat(64);
  receipt.resultRecordCount = 1;
  receipt.cells[0].assertionCounts = {
    passed: Math.max(0, scenarioAssertionCount - 1),
    failed: 0,
    limited: 1,
    notRun: 0,
    total: scenarioAssertionCount
  };
  receipt.browsers[0].state = 'not_run';
  receipt.browsers[0].scenarioCounts = {
    passed: 0,
    failed: 0,
    limited: 1,
    notRun: CANONICAL_BROWSER_MATRIX.length - 1,
    total: CANONICAL_BROWSER_MATRIX.length
  };
  assert.equal(validateBrowserSemanticReceipts(receipt), receipt);

  receipt.cells[0].state = 'passed';
  assert.throws(() => validateBrowserSemanticReceipts(receipt), /state differs from its assertion counts/);
});

test('semantic receipt cannot claim outcomes for assertions whose validators are not implemented', () => {
  const receipt = validReceipt();
  const index = receipt.cells.findIndex(({ implementationStatus }) => implementationStatus === 'not_implemented');
  assert.notEqual(index, -1);
  const cell = receipt.cells[index];
  cell.state = 'passed';
  cell.resultRecordSha256 = 'E'.repeat(64);
  cell.assertionCounts = {
    passed: cell.assertionCounts.total,
    failed: 0,
    limited: 0,
    notRun: 0,
    total: cell.assertionCounts.total
  };
  receipt.resultRecordCount = 1;
  assert.throws(() => validateBrowserSemanticReceipts(receipt), /without implemented validators/);

  const privateManifest = validReceipt();
  privateManifest.identity.toolchainManifestSha256 = 'F'.repeat(64);
  assert.throws(() => validateBrowserSemanticReceipts(privateManifest), /identity keys differ/);
});

function validReceipt() {
  const cells = [];
  for (const scenario of CANONICAL_BROWSER_MATRIX) {
    for (const browser of REQUIRED_BROWSERS) {
      cells.push({
        scenarioId: scenario.id,
        browser,
        state: 'not_run',
        implementationStatus: semanticScenarioImplementationStatus(scenario.id),
        resultRecordSha256: null,
        assertionCounts: {
          passed: 0,
          failed: 0,
          limited: 0,
          notRun: scenario.requiredAssertions.length,
          total: scenario.requiredAssertions.length
        }
      });
    }
  }
  return {
    schema: BROWSER_SEMANTIC_RECEIPTS_SCHEMA,
    status: 'not_run',
    runId: `sitewipe-browser-${'a'.repeat(32)}`,
    completedAt: '2026-08-25T20:00:00.000Z',
    matrixVersion: 'sitewipe.installed-browser-matrix.v1',
    matrixSha256: '29161C9604160D7C7CE71A7F5D6A6FC564715F88FC3E53548A3DA22FE3A6A543',
    semanticValidatorManifestSha256: SEMANTIC_VALIDATOR_MANIFEST_SHA256,
    executionPlanSha256: 'A'.repeat(64),
    aggregateSha256: 'B'.repeat(64),
    resultSetSha256: 'C'.repeat(64),
    resultRecordCount: 0,
    semanticValidatorCounts: {
      implemented: SEMANTIC_IMPLEMENTED_ASSERTION_COUNT,
      notImplemented: SEMANTIC_NOT_IMPLEMENTED_ASSERTION_COUNT,
      total: SEMANTIC_IMPLEMENTED_ASSERTION_COUNT + SEMANTIC_NOT_IMPLEMENTED_ASSERTION_COUNT
    },
    cells,
    browsers: REQUIRED_BROWSERS.map((browser) => ({
      browser,
      version: browser === 'brave' ? '151.1.93.138' : '151.0.7922.174',
      executableSha256: browser === 'brave' ? 'D'.repeat(64) : 'E'.repeat(64),
      runtimeManifestSha256: browser === 'brave' ? 'F'.repeat(64) : '0'.repeat(64),
      state: 'not_run',
      scenarioCounts: {
        passed: 0,
        failed: 0,
        limited: 0,
        notRun: CANONICAL_BROWSER_MATRIX.length,
        total: CANONICAL_BROWSER_MATRIX.length
      }
    })),
    identity: {
      sourceCommitSha: 'a'.repeat(40),
      sourceTreeSha: 'b'.repeat(40),
      artifactVersion: '1.11.90',
      artifactBytes: 1234,
      artifactSha256: '1'.repeat(64),
      browserRuntimeSetSha256: '2'.repeat(64),
      gitExecutableSha256: '3'.repeat(64),
      harnessManifestSha256: '4'.repeat(64),
      launchPolicySha256: '5'.repeat(64),
      nativeHelperSha256: '6'.repeat(64),
      nodeExecutableSha256: '7'.repeat(64),
      nodeRuntimeVersion: 'v24.18.0',
      packageLockSha256: '8'.repeat(64),
      powerShellExecutableSha256: '9'.repeat(64),
      processObserverHelperSha256: 'A'.repeat(64),
      releaseInputFingerprintSha256: 'B'.repeat(64),
      runtimeFingerprintSha256: 'C'.repeat(64),
      toolchainBytes: 123456,
      toolchainFileCount: 321,
      toolchainPackageCount: 23,
      toolchainPuppeteerVersion: '25.8.0',
      toolchainSetSha256: 'D'.repeat(64)
    },
    privateEvidenceRetained: true,
    publicSemanticReplay: BROWSER_PUBLIC_SEMANTIC_REPLAY,
    recordedByAutomation: true
  };
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

import {
  deriveExpectedEvidenceFinalizationIdentity,
  validatePublicationEvidenceFinalization
} from '../../scripts/publication-evidence-finalization.mjs';
import {
  canonicalEvidenceFinalizationJsonBytes,
  EVIDENCE_FINALIZATION_MANIFEST_PATH,
  EVIDENCE_FINALIZATION_MANIFEST_SCHEMA
} from '../../scripts/evidence-finalization-contract.mjs';
import {
  BROWSER_MATRIX_VERSION,
  CANONICAL_BROWSER_MATRIX,
  CANONICAL_BROWSER_MATRIX_SHA256,
  REQUIRED_BROWSERS
} from '../browser/installed/canonical-matrix.mjs';
import {
  BROWSER_PUBLIC_SEMANTIC_REPLAY,
  BROWSER_SEMANTIC_RECEIPTS_SCHEMA
} from '../../scripts/browser-semantic-receipts.mjs';
import {
  SEMANTIC_IMPLEMENTED_ASSERTION_COUNT,
  SEMANTIC_NOT_IMPLEMENTED_ASSERTION_COUNT
} from '../browser/installed/evidence-contract.mjs';
import {
  SEMANTIC_VALIDATOR_MANIFEST_SHA256,
  semanticScenarioImplementationStatus
} from '../browser/installed/semantic-validator.mjs';

const artifactVersion = '1.11.90';
const artifactSha256 = 'A'.repeat(64);
const runtimeFingerprintSha256 = 'B'.repeat(64);
const releaseInputFingerprintSha256 = 'C'.repeat(64);

test('derives the exact public finalization identity from independently cross-bound evidence', () => {
  const fixture = validFixture();
  const identity = deriveExpectedEvidenceFinalizationIdentity(fixture);
  assert.equal(identity.artifactVersion, artifactVersion);
  assert.equal(identity.browserAggregateSha256, fixture.browser.installedEvidence.aggregateSha256);
  assert.equal(identity.publicReceiptSetSha256.length, 64);
  assert.equal(identity.toolchainManifestSha256, undefined);
  assert.equal(Object.isFrozen(identity), true);
});

test('finalization derivation rejects self-selected receipts, source drift, and private toolchain widening', () => {
  const fixture = validFixture();
  const staleReceipt = structuredClone(fixture.semanticReceipts);
  staleReceipt.aggregateSha256 = 'D'.repeat(64);
  assert.throws(
    () => deriveExpectedEvidenceFinalizationIdentity({ ...fixture, semanticReceipts: staleReceipt }),
    /independently expected private-run commitments/i
  );
  assert.throws(
    () =>
      deriveExpectedEvidenceFinalizationIdentity({
        ...fixture,
        finalSource: { ...fixture.finalSource, testedTreeSha: 'e'.repeat(40) }
      }),
    /authoritative tested source/i
  );
  const widened = structuredClone(fixture.browser);
  widened.installedEvidence.identity.toolchainManifestSha256 = 'E'.repeat(64);
  assert.throws(
    () => deriveExpectedEvidenceFinalizationIdentity({ ...fixture, browser: widened }),
    /keys differ from the exact schema/i
  );
});

test('publication finalization rejects caller object A when the exact replay contains record B', async (t) => {
  const caller = validFixture();
  const disk = withAggregateSha256(caller, 'E'.repeat(64));
  const repository = await createPublicationRepository(t, disk);
  await assert.rejects(
    validatePublicationEvidenceFinalization(publicationValidationOptions(repository, caller)),
    /Caller-supplied browser validation differs from the exact final replayed evidence record/
  );
});

test('publication finalization independently rejects substituted semantic-receipt objects', async (t) => {
  const caller = validFixture();
  const disk = structuredClone(caller);
  disk.semanticReceipts.browsers[0].version = '151.0.7922.175';
  const repository = await createPublicationRepository(t, disk);
  await assert.rejects(
    validatePublicationEvidenceFinalization(publicationValidationOptions(repository, caller)),
    /Caller-supplied browser semantic receipts differs from the exact final replayed evidence record/
  );
});

test('publication finalization derives returned records from the final replay and rejects caller races', async (t) => {
  await t.test('returns the frozen final replay rather than caller-owned objects', async (t) => {
    const disk = validFixture();
    const caller = structuredClone(disk);
    const repository = await createPublicationRepository(t, disk);
    const result = await validatePublicationEvidenceFinalization(publicationValidationOptions(repository, caller));
    const browserRecord = result.records['docs/evidence/browser-validation.json'];
    const semanticRecord = result.records['docs/evidence/browser-semantic-receipts.json'];
    assert.strictEqual(result.accessibility, result.records['docs/evidence/accessibility-results.json'].value);
    assert.strictEqual(result.browser, browserRecord.value);
    assert.strictEqual(result.media, result.records['docs/evidence/media-inventory.json'].value);
    assert.strictEqual(result.performance, result.records['docs/evidence/performance-results.json'].value);
    assert.strictEqual(result.semanticReceipts, semanticRecord.value);
    assert.notStrictEqual(result.browser, caller.browser);
    assert.notStrictEqual(result.semanticReceipts, caller.semanticReceipts);
    assert.equal(Object.isFrozen(result.browser.installedEvidence.identity), true);
    assert.equal(browserRecord.canonicalJson, canonicalEvidenceFinalizationJsonBytes(result.browser).toString('utf8'));
    assert.equal(
      semanticRecord.canonicalJson,
      canonicalEvidenceFinalizationJsonBytes(result.semanticReceipts).toString('utf8')
    );
    caller.browser.installedEvidence.aggregateSha256 = 'F'.repeat(64);
    assert.equal(result.browser.installedEvidence.aggregateSha256, disk.browser.installedEvidence.aggregateSha256);
  });

  await t.test('caller mutation after the first pass cannot race final-snapshot derivation', async (t) => {
    const disk = validFixture();
    const caller = structuredClone(disk);
    const repository = await createPublicationRepository(t, disk);
    await assert.rejects(
      validatePublicationEvidenceFinalization({
        ...publicationValidationOptions(repository, caller),
        testOnlyAfterFirstPass: () => {
          caller.browser.installedEvidence.aggregateSha256 = 'F'.repeat(64);
        }
      }),
      /Caller-supplied browser validation differs from the exact final replayed evidence record/
    );
  });
});

function validFixture({ aggregateSha256 = '2'.repeat(64) } = {}) {
  const installedEvidence = installedCommitment({ aggregateSha256 });
  return {
    browser: { installedEvidence },
    semanticReceipts: semanticReceipt(installedEvidence),
    finalSource: {
      testedCommitIsAncestor: true,
      testedCommitSha: installedEvidence.identity.sourceCommitSha,
      testedTreeSha: installedEvidence.identity.sourceTreeSha,
      testedHarnessManifestSha256: installedEvidence.identity.harnessManifestSha256,
      testedPackageLockSha256: installedEvidence.identity.packageLockSha256,
      testedRuntimeFingerprintSha256: runtimeFingerprintSha256,
      testedReleaseInputFingerprintSha256: releaseInputFingerprintSha256
    },
    artifactVersion,
    runtimeArtifactSha256: artifactSha256,
    runtimeFingerprintSha256,
    releaseInputFingerprintSha256
  };
}

function installedCommitment({ aggregateSha256 }) {
  return {
    schema: 'sitewipe.private-installed-browser-run-commitment.v1',
    status: 'private_evidence_retained_public_semantic_replay_available',
    runId: `sitewipe-browser-${'a'.repeat(32)}`,
    matrixVersion: BROWSER_MATRIX_VERSION,
    matrixSha256: CANONICAL_BROWSER_MATRIX_SHA256,
    requiredMatrixIds: CANONICAL_BROWSER_MATRIX.map(({ id }) => id),
    executionPlanSha256: '1'.repeat(64),
    identity: publicIdentity(),
    aggregateSha256,
    resultSetSha256: '3'.repeat(64),
    resultRecordCount: 48,
    completedAt: '2026-08-25T22:00:00.000Z',
    privateEvidenceRetained: true,
    publicSemanticReplay: BROWSER_PUBLIC_SEMANTIC_REPLAY
  };
}

function publicIdentity() {
  return {
    sourceCommitSha: 'a'.repeat(40),
    sourceTreeSha: 'b'.repeat(40),
    artifactVersion,
    artifactBytes: 350_000,
    artifactSha256,
    browserRuntimeSetSha256: '4'.repeat(64),
    gitExecutableSha256: '5'.repeat(64),
    harnessManifestSha256: '6'.repeat(64),
    launchPolicySha256: '7'.repeat(64),
    nativeHelperSha256: '8'.repeat(64),
    nodeExecutableSha256: '9'.repeat(64),
    nodeRuntimeVersion: 'v24.18.0',
    packageLockSha256: 'D'.repeat(64),
    powerShellExecutableSha256: 'E'.repeat(64),
    processObserverHelperSha256: 'F'.repeat(64),
    releaseInputFingerprintSha256,
    runtimeFingerprintSha256,
    toolchainBytes: 24_314_357,
    toolchainFileCount: 2_227,
    toolchainPackageCount: 26,
    toolchainPuppeteerVersion: '25.8.0',
    toolchainSetSha256: '0'.repeat(64)
  };
}

function semanticReceipt(binding) {
  const cells = [];
  let index = 0;
  for (const scenario of CANONICAL_BROWSER_MATRIX) {
    for (const browser of REQUIRED_BROWSERS) {
      cells.push({
        scenarioId: scenario.id,
        browser,
        state: 'not_run',
        implementationStatus: semanticScenarioImplementationStatus(scenario.id),
        resultRecordSha256: hash(`record-${index++}`),
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
    runId: binding.runId,
    completedAt: binding.completedAt,
    matrixVersion: binding.matrixVersion,
    matrixSha256: binding.matrixSha256,
    semanticValidatorManifestSha256: SEMANTIC_VALIDATOR_MANIFEST_SHA256,
    executionPlanSha256: binding.executionPlanSha256,
    aggregateSha256: binding.aggregateSha256,
    resultSetSha256: binding.resultSetSha256,
    resultRecordCount: binding.resultRecordCount,
    semanticValidatorCounts: {
      implemented: SEMANTIC_IMPLEMENTED_ASSERTION_COUNT,
      notImplemented: SEMANTIC_NOT_IMPLEMENTED_ASSERTION_COUNT,
      total: SEMANTIC_IMPLEMENTED_ASSERTION_COUNT + SEMANTIC_NOT_IMPLEMENTED_ASSERTION_COUNT
    },
    cells,
    browsers: REQUIRED_BROWSERS.map((browser) => ({
      browser,
      version: browser === 'chrome' ? '151.0.7922.174' : '151.1.93.138',
      executableSha256: browser === 'chrome' ? '1'.repeat(64) : '2'.repeat(64),
      runtimeManifestSha256: browser === 'chrome' ? '3'.repeat(64) : '4'.repeat(64),
      state: 'not_run',
      scenarioCounts: { passed: 0, failed: 0, limited: 0, notRun: 24, total: 24 }
    })),
    identity: structuredClone(binding.identity),
    privateEvidenceRetained: true,
    publicSemanticReplay: BROWSER_PUBLIC_SEMANTIC_REPLAY,
    recordedByAutomation: true
  };
}

function hash(value) {
  return Buffer.from(value).toString('hex').toUpperCase().padEnd(64, '0').slice(0, 64);
}

function withAggregateSha256(fixture, aggregateSha256) {
  const result = structuredClone(fixture);
  result.browser.installedEvidence.aggregateSha256 = aggregateSha256;
  result.semanticReceipts.aggregateSha256 = aggregateSha256;
  return result;
}

async function createPublicationRepository(t, diskFixture) {
  const root = await mkdtemp(resolve(tmpdir(), 'sitewipe-publication-finalization-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const records = [
    ['docs/evidence/accessibility-results.json', 'accessibility', { schema: 'sitewipe.synthetic-accessibility.v1' }],
    ['docs/evidence/browser-semantic-receipts.json', 'browser', diskFixture.semanticReceipts],
    ['docs/evidence/browser-validation.json', 'browser', diskFixture.browser],
    ['docs/evidence/media-inventory.json', 'media', { schema: 'sitewipe.synthetic-media.v1' }],
    ['docs/evidence/performance-results.json', 'performance', { schema: 'sitewipe.synthetic-performance.v1' }]
  ];
  const entries = [];
  for (const [path, kind, value] of records) {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await write(root, path, bytes);
    entries.push({ bytes: bytes.length, kind, path, sha256: sha256(bytes) });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = {
    completedAt: '2026-08-25T23:00:00.000Z',
    entries,
    identity: deriveExpectedEvidenceFinalizationIdentity(diskFixture),
    recordedByAutomation: true,
    schema: EVIDENCE_FINALIZATION_MANIFEST_SCHEMA,
    version: artifactVersion
  };
  await write(root, EVIDENCE_FINALIZATION_MANIFEST_PATH, canonicalEvidenceFinalizationJsonBytes(manifest));
  return {
    changedPaths: [EVIDENCE_FINALIZATION_MANIFEST_PATH, ...entries.map(({ path }) => path)].sort(),
    manifest,
    root
  };
}

function publicationValidationOptions(repository, caller) {
  return {
    repositoryRoot: repository.root,
    manifest: repository.manifest,
    changedPaths: repository.changedPaths,
    browser: caller.browser,
    semanticReceipts: caller.semanticReceipts,
    finalSource: caller.finalSource,
    artifactVersion,
    runtimeArtifactSha256: artifactSha256,
    runtimeFingerprintSha256,
    releaseInputFingerprintSha256
  };
}

async function write(root, path, bytes) {
  const absolute = resolve(root, ...path.split('/'));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

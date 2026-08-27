import {
  BROWSER_SEMANTIC_RECEIPT_IDENTITY_KEYS,
  computeBrowserSemanticReceiptsSha256,
  validateBrowserSemanticReceipts
} from './browser-semantic-receipts.mjs';
import {
  canonicalFinalizedEvidenceRecordJson,
  validateEvidenceFinalizationManifest
} from './evidence-finalization-contract.mjs';
import { BROWSER_PRIVATE_EVIDENCE_RETAINED_STATUS } from './publication-evidence-contract.mjs';
import { SEMANTIC_VALIDATOR_MANIFEST_SHA256 } from '../tests/browser/installed/semantic-validator.mjs';

const ACCESSIBILITY_RESULTS_PATH = 'docs/evidence/accessibility-results.json';
const BROWSER_SEMANTIC_RECEIPTS_PATH = 'docs/evidence/browser-semantic-receipts.json';
const BROWSER_VALIDATION_PATH = 'docs/evidence/browser-validation.json';
const MEDIA_INVENTORY_PATH = 'docs/evidence/media-inventory.json';
const PERFORMANCE_RESULTS_PATH = 'docs/evidence/performance-results.json';
const PUBLICATION_SNAPSHOT_RECORD_PATHS = Object.freeze([
  ACCESSIBILITY_RESULTS_PATH,
  BROWSER_SEMANTIC_RECEIPTS_PATH,
  BROWSER_VALIDATION_PATH,
  MEDIA_INVENTORY_PATH,
  PERFORMANCE_RESULTS_PATH
]);

export function deriveExpectedEvidenceFinalizationIdentity({
  browser,
  semanticReceipts,
  finalSource,
  artifactVersion,
  runtimeArtifactSha256,
  runtimeFingerprintSha256,
  releaseInputFingerprintSha256
}) {
  const binding = browser?.installedEvidence;
  if (!binding || binding.status !== BROWSER_PRIVATE_EVIDENCE_RETAINED_STATUS || !binding.identity) {
    throw new Error('Evidence finalization requires one retained installed-browser commitment.');
  }
  if (
    JSON.stringify(Object.keys(binding.identity).sort()) !==
    JSON.stringify([...BROWSER_SEMANTIC_RECEIPT_IDENTITY_KEYS].sort())
  ) {
    throw new Error('Installed-browser finalization identity keys differ from the exact schema.');
  }
  validateBrowserSemanticReceipts(semanticReceipts, {
    expected: {
      aggregateSha256: binding.aggregateSha256,
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
  });
  if (
    !finalSource ||
    finalSource.testedCommitIsAncestor !== true ||
    finalSource.testedCommitSha !== binding.identity.sourceCommitSha ||
    finalSource.testedTreeSha !== binding.identity.sourceTreeSha ||
    finalSource.testedHarnessManifestSha256 !== binding.identity.harnessManifestSha256 ||
    finalSource.testedPackageLockSha256 !== binding.identity.packageLockSha256 ||
    finalSource.testedRuntimeFingerprintSha256 !== runtimeFingerprintSha256 ||
    finalSource.testedReleaseInputFingerprintSha256 !== releaseInputFingerprintSha256
  ) {
    throw new Error('Evidence finalization is not bound to the authoritative tested source snapshot.');
  }
  if (
    binding.identity.artifactVersion !== artifactVersion ||
    binding.identity.artifactSha256 !== runtimeArtifactSha256 ||
    binding.identity.runtimeFingerprintSha256 !== runtimeFingerprintSha256 ||
    binding.identity.releaseInputFingerprintSha256 !== releaseInputFingerprintSha256 ||
    semanticReceipts.semanticValidatorManifestSha256 !== SEMANTIC_VALIDATOR_MANIFEST_SHA256
  ) {
    throw new Error('Evidence finalization is stale for the current artifact, fingerprints, or validator.');
  }

  const identity = {
    artifactSha256: runtimeArtifactSha256,
    artifactVersion,
    browserAggregateSha256: binding.aggregateSha256,
    browserResultSetSha256: binding.resultSetSha256,
    browserRuntimeSetSha256: binding.identity.browserRuntimeSetSha256,
    gitExecutableSha256: binding.identity.gitExecutableSha256,
    harnessManifestSha256: finalSource.testedHarnessManifestSha256,
    launchPolicySha256: binding.identity.launchPolicySha256,
    nativeHelperSha256: binding.identity.nativeHelperSha256,
    nodeExecutableSha256: binding.identity.nodeExecutableSha256,
    nodeRuntimeVersion: binding.identity.nodeRuntimeVersion,
    packageLockSha256: finalSource.testedPackageLockSha256,
    powerShellExecutableSha256: binding.identity.powerShellExecutableSha256,
    processObserverHelperSha256: binding.identity.processObserverHelperSha256,
    publicReceiptSetSha256: computeBrowserSemanticReceiptsSha256(semanticReceipts),
    releaseInputFingerprintSha256,
    runtimeFingerprintSha256,
    semanticValidatorManifestSha256: SEMANTIC_VALIDATOR_MANIFEST_SHA256,
    testedCommitSha: finalSource.testedCommitSha,
    testedTreeSha: finalSource.testedTreeSha,
    toolchainBytes: binding.identity.toolchainBytes,
    toolchainFileCount: binding.identity.toolchainFileCount,
    toolchainPackageCount: binding.identity.toolchainPackageCount,
    toolchainPuppeteerVersion: binding.identity.toolchainPuppeteerVersion,
    toolchainSetSha256: binding.identity.toolchainSetSha256
  };
  return deepFreeze(identity);
}

export async function validatePublicationEvidenceFinalization({
  repositoryRoot,
  manifest,
  changedPaths,
  browser,
  semanticReceipts,
  finalSource,
  artifactVersion,
  runtimeArtifactSha256,
  runtimeFingerprintSha256,
  releaseInputFingerprintSha256,
  testOnlyAfterFirstPass = undefined,
  testOnlyAfterManifestRead = undefined
}) {
  let replayedBrowser;
  let replayedSemanticReceipts;
  const snapshot = await validateEvidenceFinalizationManifest({
    repositoryRoot,
    manifest,
    changedPaths,
    snapshotRecordPaths: PUBLICATION_SNAPSHOT_RECORD_PATHS,
    testOnlyAfterFirstPass,
    testOnlyAfterManifestRead,
    deriveExpectedIdentityFromSnapshot: (finalSnapshot) => {
      replayedBrowser = exactSnapshotRecordValue(finalSnapshot, BROWSER_VALIDATION_PATH);
      replayedSemanticReceipts = exactSnapshotRecordValue(finalSnapshot, BROWSER_SEMANTIC_RECEIPTS_PATH);
      assertCanonicalRecordEquivalent(
        browser,
        finalSnapshot.records[BROWSER_VALIDATION_PATH],
        'Caller-supplied browser validation'
      );
      assertCanonicalRecordEquivalent(
        semanticReceipts,
        finalSnapshot.records[BROWSER_SEMANTIC_RECEIPTS_PATH],
        'Caller-supplied browser semantic receipts'
      );
      return deriveExpectedEvidenceFinalizationIdentity({
        browser: replayedBrowser,
        semanticReceipts: replayedSemanticReceipts,
        finalSource,
        artifactVersion,
        runtimeArtifactSha256,
        runtimeFingerprintSha256,
        releaseInputFingerprintSha256
      });
    }
  });
  return deepFreeze({
    ...snapshot,
    accessibility: exactSnapshotRecordValue(snapshot, ACCESSIBILITY_RESULTS_PATH),
    browser: replayedBrowser,
    media: exactSnapshotRecordValue(snapshot, MEDIA_INVENTORY_PATH),
    performance: exactSnapshotRecordValue(snapshot, PERFORMANCE_RESULTS_PATH),
    semanticReceipts: replayedSemanticReceipts
  });
}

function exactSnapshotRecordValue(snapshot, path) {
  const record = snapshot?.records?.[path];
  if (!record || record.path !== path || !record.value || typeof record.canonicalJson !== 'string') {
    throw new Error(`Evidence finalization snapshot is missing its exact parsed record: ${path}.`);
  }
  return record.value;
}

function assertCanonicalRecordEquivalent(value, record, label) {
  const canonicalJson = canonicalFinalizedEvidenceRecordJson(value, label);
  if (canonicalJson !== record.canonicalJson) {
    throw new Error(`${label} differs from the exact final replayed evidence record.`);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

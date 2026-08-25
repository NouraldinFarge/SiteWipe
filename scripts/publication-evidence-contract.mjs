import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve, win32 } from 'node:path';

import {
  BROWSER_MATRIX_VERSION,
  CANONICAL_BROWSER_MATRIX_IDS,
  CANONICAL_BROWSER_MATRIX_SHA256
} from './browser-validation-policy.mjs';

export const BROWSER_PUBLICATION_BINDING_SCHEMA = 'sitewipe.private-installed-browser-run-commitment.v1';
export const BROWSER_PUBLICATION_NOT_RUN_STATUS = 'not_run';
export const BROWSER_PRIVATE_EVIDENCE_RETAINED_STATUS = 'private_evidence_retained_public_replay_unavailable';
export const BROWSER_PUBLIC_SEMANTIC_REPLAY = 'not_implemented';

const EMPTY_BROWSER_COMMITMENT_KEYS = Object.freeze(['schema', 'status']);
const TRACKED_BROWSER_EVIDENCE_KEYS = Object.freeze([
  'artifact',
  'attemptedAt',
  'automationAttempt',
  'brave',
  'chrome',
  'deferredBinaryPublicationMatrix',
  'earlierExactArtifactEvidence',
  'installedEvidence',
  'limitations',
  'matrixSha256',
  'matrixVersion',
  'olderExactArtifactEvidence',
  'priorCandidateObservation',
  'priorExactArtifactEvidence',
  'requiredMatrix',
  'reviewerApproval',
  'schemaVersion',
  'status',
  'syntheticInAppBrowser'
]);
const TRACKED_ARTIFACT_KEYS = Object.freeze(['runtimeZip', 'sha256', 'version']);
const TRACKED_HISTORICAL_RECORD_KEYS = Object.freeze([
  'historicalPathNote',
  'record',
  'runtimeZipSha256',
  'status',
  'version'
]);
const TRACKED_EARLIER_RECORD_KEYS = Object.freeze(['record', 'status', 'version']);
const TRACKED_PRIOR_CANDIDATE_KEYS = Object.freeze([
  'artifactSha256',
  'claimsReboundToCurrentArtifact',
  'note',
  'status',
  'version'
]);
const TRACKED_BROWSER_KEYS = Object.freeze(['assertions', 'disposableProfile', 'operatingSystem', 'status', 'version']);
const TRACKED_BROWSER_ASSERTION_KEYS = Object.freeze([
  'artifactSha256',
  'id',
  'matrixCoverage',
  'observedAt',
  'status'
]);
const TRACKED_SYNTHETIC_BROWSER_KEYS = Object.freeze([
  'assertions',
  'attemptedAt',
  'environment',
  'fixture',
  'limitations',
  'qualifiesAsInstalledExtensionEvidence',
  'status'
]);
const TRACKED_SYNTHETIC_ASSERTION_KEYS = Object.freeze([
  'checks',
  'domSha256',
  'fixture',
  'id',
  'modes',
  'observedAt',
  'screenshotSha256',
  'state',
  'status',
  'surface',
  'viewport'
]);
const TRACKED_SYNTHETIC_VIEWPORT_KEYS = Object.freeze(['height', 'width', 'zoomPercent']);
const TRACKED_SYNTHETIC_MODE_KEYS = Object.freeze([
  'cleanupMode',
  'colorScheme',
  'directCleanup',
  'forcedColors',
  'privateAccess',
  'reducedMotion'
]);
const TRACKED_SYNTHETIC_CHECK_KEYS = Object.freeze([
  'accessibleNames',
  'focus',
  'forcedColors',
  'liveRegions',
  'overflow',
  'reducedMotion',
  'scroll',
  'wrapping'
]);
const TRACKED_SYNTHETIC_STATUSES = Object.freeze(new Set(['failed', 'limited', 'not_run', 'passed']));
const TRACKED_SYNTHETIC_SURFACES = Object.freeze(new Set(['options', 'popup', 'report', 'side_panel']));
const APPROVED_HISTORICAL_BROWSER_RECORDS = Object.freeze(
  new Set([
    'browser/sitewipe-1.11.61-chrome-expiry-failure.json',
    'browser/sitewipe-1.11.62-chrome-target-partition-scope-failure.json',
    'browser-validation-2026-08-22-v1.11.57.json'
  ])
);
const RETAINED_BROWSER_COMMITMENT_KEYS = Object.freeze([
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
const BROWSER_COMMITMENT_IDENTITY_KEYS = Object.freeze([
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
]);
const EXPECTED_PRIVATE_RESULT_RECORD_COUNT = CANONICAL_BROWSER_MATRIX_IDS.length * 2;
const EXACT_POST_BROWSER_EVIDENCE_DELTA = Object.freeze(['docs/evidence/browser-validation.json']);
const PRIVATE_REPLAY_UNAVAILABLE_BLOCKER =
  'Private installed-browser evidence is retained, but public semantic replay is not implemented; digests and record counts cannot establish passing browser cells.';

export function findBrowserEvidenceFindings({
  browser,
  runtimeArtifactSha256,
  runtimeFingerprintSha256,
  releaseInputFingerprintSha256,
  finalSource
}) {
  const findings = findTrackedBrowserEvidencePrivacyFindings(browser);
  const requiredMatrix = browser?.requiredMatrix;
  if (browser?.matrixVersion !== BROWSER_MATRIX_VERSION) {
    findings.push('The browser evidence matrixVersion is missing or stale.');
  }
  if (browser?.matrixSha256 !== CANONICAL_BROWSER_MATRIX_SHA256) {
    findings.push('The browser evidence matrix SHA-256 is missing or stale.');
  }
  if (JSON.stringify(requiredMatrix) !== JSON.stringify(CANONICAL_BROWSER_MATRIX_IDS)) {
    findings.push('The browser requiredMatrix must equal the immutable canonical 24-ID matrix in exact order.');
    return findings;
  }

  findings.push(
    ...findInstalledCommitmentFindings({
      binding: browser?.installedEvidence,
      runtimeArtifactSha256,
      runtimeFingerprintSha256,
      releaseInputFingerprintSha256,
      finalSource
    })
  );

  for (const [browserName, evidence] of [
    ['Chrome', browser?.chrome],
    ['Brave', browser?.brave]
  ]) {
    const assertions = evidence?.assertions;
    if (!Array.isArray(assertions) || assertions.length === 0) {
      findings.push(`${browserName} must retain at least one reviewed browser assertion.`);
      continue;
    }
    const ids = new Set();
    const covered = new Set();
    for (const [index, assertion] of assertions.entries()) {
      const label = `${browserName} assertion ${index + 1}`;
      if (!isPlainObject(assertion)) {
        findings.push(`${label} must be an evidence object.`);
        continue;
      }
      if (!isNonEmptyString(assertion.id) || ids.has(assertion.id)) {
        findings.push(`${label} must have a unique non-empty id.`);
      } else {
        ids.add(assertion.id);
      }
      if (assertion.status !== 'passed') findings.push(`${label} is not passed.`);
      if (!isIsoDateOrTimestamp(assertion.observedAt)) {
        findings.push(`${label} has no valid observation date.`);
      }
      if (assertion.artifactSha256 !== runtimeArtifactSha256) {
        findings.push(`${label} is not bound to the current runtime artifact SHA-256.`);
      }
      if (!Array.isArray(assertion.matrixCoverage) || assertion.matrixCoverage.length === 0) {
        findings.push(`${label} has no requiredMatrix coverage.`);
        continue;
      }
      for (const requirement of assertion.matrixCoverage) {
        if (!requiredMatrix.includes(requirement)) {
          findings.push(`${label} claims an unknown requiredMatrix entry.`);
        } else {
          covered.add(requirement);
        }
      }
    }
    const missing = requiredMatrix.filter((requirement) => !covered.has(requirement));
    if (missing.length) {
      findings.push(`${browserName} assertions do not cover every requiredMatrix entry (${missing.length} missing).`);
    }
  }
  return findings;
}

export function findTrackedBrowserEvidencePrivacyFindings(browser) {
  const findings = [];
  if (!isPlainObject(browser)) {
    return ['Tracked browser evidence must be an exact path-safe publication record object.'];
  }

  const forbiddenField = findForbiddenTrackedBrowserEvidence(browser);
  if (forbiddenField) {
    findings.push(
      `Tracked browser evidence must not contain raw/base64 evidence, private paths, file URIs, or unapproved path/root/directory fields (${forbiddenField}).`
    );
  }
  if (!hasExactKeys(browser, TRACKED_BROWSER_EVIDENCE_KEYS)) {
    findings.push('Tracked browser evidence differs from the exact top-level publication schema.');
    return findings;
  }
  if (browser.schemaVersion !== 1) {
    findings.push('Tracked browser evidence uses an unknown schemaVersion.');
  }
  if (!hasExactKeys(browser.artifact, TRACKED_ARTIFACT_KEYS)) {
    findings.push('Tracked browser evidence artifact differs from the exact publication schema.');
  }
  validateHistoricalBrowserRecord({
    value: browser.priorExactArtifactEvidence,
    expectedKeys: TRACKED_HISTORICAL_RECORD_KEYS,
    label: 'priorExactArtifactEvidence',
    findings
  });
  validateHistoricalBrowserRecord({
    value: browser.olderExactArtifactEvidence,
    expectedKeys: TRACKED_HISTORICAL_RECORD_KEYS,
    label: 'olderExactArtifactEvidence',
    findings
  });
  validateHistoricalBrowserRecord({
    value: browser.earlierExactArtifactEvidence,
    expectedKeys: TRACKED_EARLIER_RECORD_KEYS,
    label: 'earlierExactArtifactEvidence',
    findings
  });
  if (!hasExactKeys(browser.priorCandidateObservation, TRACKED_PRIOR_CANDIDATE_KEYS)) {
    findings.push('Tracked priorCandidateObservation differs from the exact publication schema.');
  }
  for (const browserName of ['chrome', 'brave']) {
    validateTrackedBrowserEntry({ value: browser[browserName], label: browserName, findings });
  }
  if (!hasExactKeys(browser.syntheticInAppBrowser, TRACKED_SYNTHETIC_BROWSER_KEYS)) {
    findings.push('Tracked syntheticInAppBrowser differs from the exact publication schema.');
  } else {
    if (browser.syntheticInAppBrowser.qualifiesAsInstalledExtensionEvidence !== false) {
      findings.push('Tracked synthetic browser evidence must remain explicitly non-qualifying.');
    }
    const syntheticAssertions = browser.syntheticInAppBrowser.assertions;
    validateTrackedSyntheticAssertions(syntheticAssertions, findings);
    if (Array.isArray(syntheticAssertions) && syntheticAssertions.length === 0) {
      if (browser.syntheticInAppBrowser.status !== 'pending' || browser.syntheticInAppBrowser.attemptedAt !== null) {
        findings.push('Empty synthetic browser evidence must remain pending with no attemptedAt timestamp.');
      }
    } else if (Array.isArray(syntheticAssertions)) {
      if (!isIsoDateOrTimestamp(browser.syntheticInAppBrowser.attemptedAt)) {
        findings.push('Populated synthetic browser evidence requires a valid attemptedAt timestamp.');
      }
      if (
        !isSyntheticStatusConsistent(
          browser.syntheticInAppBrowser.status,
          syntheticAssertions.map((assertion) => assertion?.status)
        )
      ) {
        findings.push('Synthetic browser section status launders or contradicts its assertion statuses.');
      }
    }
    validateStringArray(browser.syntheticInAppBrowser.limitations, 'synthetic browser limitations', findings);
  }
  if (browser.automationAttempt !== null) {
    findings.push(
      'Tracked browser automationAttempt must be exactly null; private automation details are not publishable.'
    );
  }
  validateStringArray(browser.deferredBinaryPublicationMatrix, 'deferred browser matrix', findings);
  validateStringArray(browser.limitations, 'browser limitations', findings);
  return findings;
}

function findInstalledCommitmentFindings({
  binding,
  runtimeArtifactSha256,
  runtimeFingerprintSha256,
  releaseInputFingerprintSha256,
  finalSource
}) {
  const findings = [];
  if (!isPlainObject(binding)) {
    return ['Installed browser evidence is missing the strict private-run public commitment.'];
  }
  const forbiddenField = findForbiddenBrowserCommitmentField(binding);
  if (forbiddenField) {
    return [
      `Tracked installed-browser evidence must not contain plans, aggregates, result records, raw/base64 evidence, provenance, or paths (${forbiddenField}).`
    ];
  }
  if (binding.schema !== BROWSER_PUBLICATION_BINDING_SCHEMA) {
    return ['Installed browser evidence uses a legacy or unknown public commitment schema.'];
  }
  if (binding.status === BROWSER_PUBLICATION_NOT_RUN_STATUS) {
    if (!hasExactKeys(binding, EMPTY_BROWSER_COMMITMENT_KEYS)) {
      findings.push('The not_run installed-browser commitment must use the exact empty shape.');
    }
    findings.push('Installed browser execution is not_run; no private run commitment is retained.');
    return findings;
  }
  if (binding.status !== BROWSER_PRIVATE_EVIDENCE_RETAINED_STATUS) {
    return ['Installed browser commitment has an unknown explicitly non-passing status.'];
  }
  if (!hasExactKeys(binding, RETAINED_BROWSER_COMMITMENT_KEYS)) {
    findings.push('The retained private-run commitment differs from the exact digest-only public schema.');
    findings.push(PRIVATE_REPLAY_UNAVAILABLE_BLOCKER);
    return findings;
  }

  if (
    !/^sitewipe-browser-[a-f0-9]{32}$/.test(String(binding.runId || '')) ||
    binding.matrixVersion !== BROWSER_MATRIX_VERSION ||
    binding.matrixSha256 !== CANONICAL_BROWSER_MATRIX_SHA256 ||
    JSON.stringify(binding.requiredMatrixIds) !== JSON.stringify(CANONICAL_BROWSER_MATRIX_IDS)
  ) {
    findings.push('Private-run commitment is not bound to the canonical run and browser matrix identities.');
  }
  if (
    !isSha256(binding.executionPlanSha256) ||
    !isSha256(binding.aggregateSha256) ||
    !isSha256(binding.resultSetSha256)
  ) {
    findings.push('Private-run commitment is missing an exact plan, aggregate, or result-set digest.');
  }
  if (
    binding.resultRecordCount !== EXPECTED_PRIVATE_RESULT_RECORD_COUNT ||
    !isIsoDateOrTimestamp(binding.completedAt) ||
    binding.privateEvidenceRetained !== true ||
    binding.publicSemanticReplay !== BROWSER_PUBLIC_SEMANTIC_REPLAY
  ) {
    findings.push(
      'Private-run commitment must retain exactly the canonical record count, completion time, private-retention proof, and non-implemented public replay state.'
    );
  }

  const identity = binding.identity;
  if (!hasExactKeys(identity, BROWSER_COMMITMENT_IDENTITY_KEYS)) {
    findings.push('Private-run commitment identity differs from the exact path-free hash/version/commit/tree shape.');
  } else {
    const identityHashes = BROWSER_COMMITMENT_IDENTITY_KEYS.filter((key) => key.endsWith('Sha256'));
    if (
      !isSemanticVersion(identity.artifactVersion) ||
      !isGitObjectId(identity.sourceCommitSha) ||
      !isGitObjectId(identity.sourceTreeSha) ||
      identityHashes.some((key) => !isSha256(identity[key]))
    ) {
      findings.push('Private-run commitment identity contains a malformed hash, version, commit, or tree.');
    }
    if (
      !isSha256(runtimeArtifactSha256) ||
      identity.artifactSha256 !== runtimeArtifactSha256 ||
      !isSha256(runtimeFingerprintSha256) ||
      identity.runtimeFingerprintSha256 !== runtimeFingerprintSha256 ||
      !isSha256(releaseInputFingerprintSha256) ||
      identity.releaseInputFingerprintSha256 !== releaseInputFingerprintSha256
    ) {
      findings.push('Private-run commitment identity is stale for the current artifact or stable fingerprints.');
    }
    if (
      !finalSource ||
      finalSource.testedCommitIsAncestor !== true ||
      !isGitObjectId(finalSource.commitSha) ||
      !isGitObjectId(finalSource.treeSha) ||
      finalSource.commitSha === identity.sourceCommitSha ||
      finalSource.testedTreeSha !== identity.sourceTreeSha ||
      finalSource.testedHarnessManifestSha256 !== identity.harnessManifestSha256 ||
      finalSource.testedPackageLockSha256 !== identity.packageLockSha256 ||
      finalSource.testedRuntimeFingerprintSha256 !== identity.runtimeFingerprintSha256 ||
      finalSource.testedReleaseInputFingerprintSha256 !== identity.releaseInputFingerprintSha256 ||
      !exactArray(finalSource.changedPaths, EXACT_POST_BROWSER_EVIDENCE_DELTA)
    ) {
      findings.push(
        'Private-run commitment identity does not match the authoritative tested commit ancestry, tree, harness, lockfile, stable fingerprints, and exact browser-evidence-only final delta.'
      );
    }
  }

  findings.push(PRIVATE_REPLAY_UNAVAILABLE_BLOCKER);
  return findings;
}

function findForbiddenBrowserCommitmentField(value, prefix = 'installedEvidence') {
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    const qualified = `${prefix}.${key}`;
    const lower = key.toLowerCase();
    if (
      lower.includes('path') ||
      lower.endsWith('root') ||
      lower.includes('directory') ||
      lower.includes('base64') ||
      ['plan', 'aggregate', 'resultrecords', 'rawevidence', 'sourceprovenance'].includes(lower)
    ) {
      return qualified;
    }
    const nested = findForbiddenBrowserCommitmentField(child, qualified);
    if (nested) return nested;
  }
  return null;
}

function findForbiddenTrackedBrowserEvidence(value, prefix = '') {
  if (typeof value === 'string') {
    return looksLikePrivateEvidenceString(value) ? prefix || '<root>' : null;
  }
  if (!value || typeof value !== 'object') return null;
  const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
  for (const [key, child] of entries) {
    const stringKey = String(key);
    const qualified = prefix ? `${prefix}.${stringKey}` : stringKey;
    if (!Array.isArray(value)) {
      const lower = stringKey.toLowerCase();
      const approvedPathNote =
        qualified === 'priorExactArtifactEvidence.historicalPathNote' ||
        qualified === 'olderExactArtifactEvidence.historicalPathNote';
      const approvedRecordReference =
        qualified === 'priorExactArtifactEvidence.record' ||
        qualified === 'olderExactArtifactEvidence.record' ||
        qualified === 'earlierExactArtifactEvidence.record';
      if (
        lower.includes('base64') ||
        /(^|[_-])raw($|[_-])|raw(?:body|bytes|content|data|evidence|payload|record|response)/i.test(stringKey) ||
        (!approvedPathNote &&
          !approvedRecordReference &&
          (lower.includes('path') || lower.endsWith('root') || lower.includes('directory')))
      ) {
        return qualified;
      }
    }
    const nested = findForbiddenTrackedBrowserEvidence(child, qualified);
    if (nested) return nested;
  }
  return null;
}

function looksLikePrivateEvidenceString(value) {
  const trimmed = value.trim();
  if (
    /^file:/i.test(trimmed) ||
    /^data:[^,;]+(?:;[^,]*)?;base64,/i.test(trimmed) ||
    posix.isAbsolute(trimmed) ||
    win32.isAbsolute(trimmed) ||
    /(?:^|[\s('"`])(?:[A-Za-z]:[\\/]|\\\\|\/(?!\/))/u.test(value)
  ) {
    return true;
  }
  if (/^[A-Za-z0-9+/]+={1,2}$/.test(trimmed) && trimmed.length >= 4) {
    return true;
  }
  return (
    trimmed.length >= 24 &&
    trimmed.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+$/.test(trimmed) &&
    !/^[A-Fa-f0-9]+$/.test(trimmed)
  );
}

function validateHistoricalBrowserRecord({ value, expectedKeys, label, findings }) {
  if (!hasExactKeys(value, expectedKeys)) {
    findings.push(`Tracked ${label} differs from the exact historical-reference schema.`);
    return;
  }
  if (!isApprovedHistoricalBrowserRecord(value.record)) {
    findings.push(`Tracked ${label}.record is not an approved normalized repository-relative historical record.`);
  }
}

function isApprovedHistoricalBrowserRecord(value) {
  return (
    typeof value === 'string' &&
    !value.includes('\\') &&
    value === posix.normalize(value) &&
    !value.split('/').includes('..') &&
    APPROVED_HISTORICAL_BROWSER_RECORDS.has(value)
  );
}

function validateTrackedBrowserEntry({ value, label, findings }) {
  if (!hasExactKeys(value, TRACKED_BROWSER_KEYS)) {
    findings.push(`Tracked ${label} evidence differs from the exact browser publication schema.`);
    return;
  }
  if (!Array.isArray(value.assertions)) {
    findings.push(`Tracked ${label} assertions must be an array.`);
    return;
  }
  for (const [index, assertion] of value.assertions.entries()) {
    if (!hasExactKeys(assertion, TRACKED_BROWSER_ASSERTION_KEYS)) {
      findings.push(`Tracked ${label} assertion ${index + 1} differs from the exact path-free assertion schema.`);
    }
  }
}

function validateTrackedSyntheticAssertions(assertions, findings) {
  if (!Array.isArray(assertions)) {
    findings.push('Tracked synthetic browser assertions must be an array.');
    return;
  }
  const ids = new Set();
  for (const [index, assertion] of assertions.entries()) {
    const label = `Tracked synthetic browser assertion ${index + 1}`;
    if (!hasExactKeys(assertion, TRACKED_SYNTHETIC_ASSERTION_KEYS)) {
      findings.push(`${label} differs from the exact path-free assertion schema.`);
      continue;
    }
    if (!/^[a-z0-9][a-z0-9._-]{2,127}$/.test(assertion.id || '') || ids.has(assertion.id)) {
      findings.push(`${label} must have a unique normalized public id.`);
    } else {
      ids.add(assertion.id);
    }
    if (!TRACKED_SYNTHETIC_SURFACES.has(assertion.surface)) {
      findings.push(`${label} has an unknown extension surface.`);
    }
    if (!isPublicEvidenceLabel(assertion.fixture) || !isPublicEvidenceLabel(assertion.state)) {
      findings.push(`${label} must have bounded public fixture and state labels.`);
    }
    if (!isIsoDateOrTimestamp(assertion.observedAt)) {
      findings.push(`${label} has no valid observation timestamp.`);
    }
    validateTrackedSyntheticViewport(assertion.viewport, label, findings);
    validateTrackedSyntheticModes(assertion.modes, label, findings);
    validateTrackedSyntheticChecks(assertion, label, findings);
    if (!isSha256(assertion.screenshotSha256) || !isSha256(assertion.domSha256)) {
      findings.push(`${label} must contain exact screenshot and sanitized-DOM SHA-256 digests.`);
    }
  }
}

function validateTrackedSyntheticViewport(viewport, label, findings) {
  if (
    !hasExactKeys(viewport, TRACKED_SYNTHETIC_VIEWPORT_KEYS) ||
    !Number.isInteger(viewport.width) ||
    viewport.width < 240 ||
    viewport.width > 7680 ||
    !Number.isInteger(viewport.height) ||
    viewport.height < 200 ||
    viewport.height > 4320 ||
    !Number.isInteger(viewport.zoomPercent) ||
    viewport.zoomPercent < 25 ||
    viewport.zoomPercent > 500
  ) {
    findings.push(`${label} has a malformed bounded viewport.`);
  }
}

function validateTrackedSyntheticModes(modes, label, findings) {
  if (
    !hasExactKeys(modes, TRACKED_SYNTHETIC_MODE_KEYS) ||
    !['expert', 'standard'].includes(modes.cleanupMode) ||
    !['dark', 'light'].includes(modes.colorScheme) ||
    !['directCleanup', 'forcedColors', 'privateAccess', 'reducedMotion'].every((key) => typeof modes[key] === 'boolean')
  ) {
    findings.push(`${label} has malformed exact synthetic mode flags.`);
  }
}

function validateTrackedSyntheticChecks(assertion, label, findings) {
  const checks = assertion.checks;
  if (!hasExactKeys(checks, TRACKED_SYNTHETIC_CHECK_KEYS)) {
    findings.push(`${label} differs from the exact semantic-check schema.`);
    return;
  }
  const statuses = Object.values(checks);
  if (
    !TRACKED_SYNTHETIC_STATUSES.has(assertion.status) ||
    statuses.some((status) => !TRACKED_SYNTHETIC_STATUSES.has(status))
  ) {
    findings.push(`${label} contains an unknown overall or semantic-check status.`);
    return;
  }
  if (!isSyntheticStatusConsistent(assertion.status, statuses)) {
    findings.push(`${label} overall status launders or contradicts its semantic-check statuses.`);
  }
}

function isSyntheticStatusConsistent(overallStatus, childStatuses) {
  return (
    TRACKED_SYNTHETIC_STATUSES.has(overallStatus) &&
    childStatuses.every((status) => TRACKED_SYNTHETIC_STATUSES.has(status)) &&
    ((overallStatus === 'passed' && childStatuses.every((status) => status === 'passed')) ||
      (overallStatus === 'failed' && childStatuses.includes('failed')) ||
      (overallStatus === 'limited' && !childStatuses.includes('failed') && childStatuses.includes('limited')) ||
      (overallStatus === 'not_run' && childStatuses.every((status) => status === 'not_run')))
  );
}

function isPublicEvidenceLabel(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 160 &&
    value.trim() === value &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint <= 31 || codePoint === 127;
    })
  );
}

function validateStringArray(value, label, findings) {
  if (!Array.isArray(value) || value.some((entry) => !isNonEmptyString(entry))) {
    findings.push(`Tracked ${label} must be an array of non-empty public statements.`);
  }
}

export function findPerformanceEvidenceFindings({ performance, runtimeArtifactSha256 }) {
  const findings = [];
  if (!Array.isArray(performance?.fixtures) || performance.fixtures.length === 0) {
    return ['Performance evidence must contain at least one measured fixture result.'];
  }
  const fixtureIds = new Set();
  for (const [fixtureIndex, fixture] of performance.fixtures.entries()) {
    const label = `Performance fixture ${fixtureIndex + 1}`;
    if (!isPlainObject(fixture)) {
      findings.push(`${label} must be a result object.`);
      continue;
    }
    if (!isNonEmptyString(fixture.id) || fixtureIds.has(fixture.id)) {
      findings.push(`${label} must have a unique non-empty id.`);
    } else {
      fixtureIds.add(fixture.id);
    }
    if (fixture.status !== 'passed') findings.push(`${label} is not passed.`);
    if (!isNonEmptyString(fixture.browser) || !isNonEmptyString(fixture.scale)) {
      findings.push(`${label} is missing its browser or fixture scale.`);
    }
    if (!isIsoDateOrTimestamp(fixture.observedAt)) findings.push(`${label} has no valid observation date.`);
    if (fixture.artifactSha256 !== runtimeArtifactSha256) {
      findings.push(`${label} is not bound to the current runtime artifact SHA-256.`);
    }
    if (!Number.isInteger(fixture.sampleCount) || fixture.sampleCount <= 0) {
      findings.push(`${label} has an invalid sampleCount.`);
    }
    if (!Array.isArray(fixture.samples) || fixture.samples.length !== fixture.sampleCount) {
      findings.push(`${label} samples do not match sampleCount.`);
      continue;
    }
    const sampleIds = new Set();
    const durations = [];
    for (const [sampleIndex, sample] of fixture.samples.entries()) {
      const sampleLabel = `${label} sample ${sampleIndex + 1}`;
      if (!isPlainObject(sample)) {
        findings.push(`${sampleLabel} must be a result object.`);
        continue;
      }
      if (!isNonEmptyString(sample.id) || sampleIds.has(sample.id)) {
        findings.push(`${sampleLabel} must have a unique non-empty id.`);
      } else {
        sampleIds.add(sample.id);
      }
      if (sample.status !== 'passed') findings.push(`${sampleLabel} is not passed.`);
      if (!isFiniteNonNegative(sample.totalDurationMs)) {
        findings.push(`${sampleLabel} has an invalid totalDurationMs.`);
      } else {
        durations.push(sample.totalDurationMs);
      }
      if (
        !isPlainObject(sample.phaseTimingsMs) ||
        Object.keys(sample.phaseTimingsMs).length === 0 ||
        Object.values(sample.phaseTimingsMs).some((value) => !isFiniteNonNegative(value))
      ) {
        findings.push(`${sampleLabel} has invalid phaseTimingsMs.`);
      }
    }
    if (durations.length !== fixture.samples.length) continue;
    const expected = summarizeDurations(durations);
    const summary = fixture.summary;
    if (
      !isPlainObject(summary) ||
      !sameNumber(summary.medianMs, expected.medianMs) ||
      !sameNumber(summary.p95Ms, expected.p95Ms) ||
      !sameNumber(summary.maximumMs, expected.maximumMs)
    ) {
      findings.push(`${label} summary does not match its retained sample durations.`);
    }
  }
  return findings;
}

export async function findMediaEvidenceFindings({ media, root, runtimeArtifactSha256, readAssetBytes = readFile }) {
  const findings = [];
  const screenshots = media?.screenshots;
  if (
    !Number.isInteger(media?.authenticScreenshotCount) ||
    media.authenticScreenshotCount < 4 ||
    media.authenticScreenshotCount > 6 ||
    !Array.isArray(screenshots) ||
    screenshots.length !== media.authenticScreenshotCount
  ) {
    findings.push('Media screenshot count must be 4–6 and equal the number of screenshot objects.');
  }

  const screenshotPaths = [];
  if (Array.isArray(screenshots)) {
    for (const [index, screenshot] of screenshots.entries()) {
      const label = `Authentic screenshot ${index + 1}`;
      await validateMediaAsset({
        asset: screenshot,
        label,
        root,
        expectedWidth: 1280,
        expectedHeight: 800,
        runtimeArtifactSha256,
        requiresArtifactBinding: true,
        requiresCaptureDate: true,
        readAssetBytes,
        findings
      });
      if (isNonEmptyString(screenshot?.path)) screenshotPaths.push(screenshot.path);
    }
    if (new Set(screenshotPaths).size !== screenshotPaths.length) {
      findings.push('Authentic screenshots must reference unique media files.');
    }
  }

  if (
    !Number.isFinite(media?.demoDurationSeconds) ||
    media.demoDurationSeconds < 60 ||
    media.demoDurationSeconds > 90 ||
    !isPlainObject(media?.demo) ||
    media.demo.durationSeconds !== media.demoDurationSeconds
  ) {
    findings.push('Media demo must be an object with the same approved 60–90 second duration.');
  }
  if (isPlainObject(media?.demo)) {
    await validateMediaAsset({
      asset: media.demo,
      label: 'Authentic demo',
      root,
      runtimeArtifactSha256,
      requiresArtifactBinding: true,
      requiresCaptureDate: true,
      readAssetBytes,
      findings
    });
  }

  const storeAssets = media?.storeAssets;
  if (!isPlainObject(storeAssets)) {
    findings.push('Store media assets must be an object.');
    return findings;
  }
  await validateMediaAsset({
    asset: storeAssets.icon128,
    label: 'Store icon128',
    root,
    expectedWidth: 128,
    expectedHeight: 128,
    readAssetBytes,
    findings
  });
  await validateMediaAsset({
    asset: storeAssets.promotionalTile440x280,
    label: 'Store promotional tile',
    root,
    expectedWidth: 440,
    expectedHeight: 280,
    readAssetBytes,
    findings
  });
  await validateMediaAsset({
    asset: storeAssets.marquee1400x560,
    label: 'Store marquee',
    root,
    expectedWidth: 1400,
    expectedHeight: 560,
    readAssetBytes,
    findings
  });
  await validateMediaAsset({
    asset: storeAssets.githubSocialPreview,
    label: 'GitHub social preview',
    root,
    expectedWidth: 1280,
    expectedHeight: 640,
    readAssetBytes,
    findings
  });
  if (
    !Array.isArray(storeAssets.screenshots1280x800) ||
    storeAssets.screenshots1280x800.length !== media?.authenticScreenshotCount
  ) {
    findings.push('Store screenshot assets must contain every approved 1280×800 screenshot.');
  } else {
    for (const [index, screenshot] of storeAssets.screenshots1280x800.entries()) {
      await validateMediaAsset({
        asset: screenshot,
        label: `Store screenshot ${index + 1}`,
        root,
        expectedWidth: 1280,
        expectedHeight: 800,
        runtimeArtifactSha256,
        requiresArtifactBinding: true,
        requiresCaptureDate: true,
        readAssetBytes,
        findings
      });
    }
    const storeScreenshotPaths = storeAssets.screenshots1280x800.map((asset) => asset?.path);
    if (
      screenshotPaths.length !== storeScreenshotPaths.length ||
      screenshotPaths.some((path) => !storeScreenshotPaths.includes(path)) ||
      storeScreenshotPaths.some((path) => !screenshotPaths.includes(path))
    ) {
      findings.push('Store screenshot assets do not match the approved authentic screenshot set.');
    }
  }
  return findings;
}

export function findRemotePublicationFindings({ remote, version, privacyBytes }) {
  const findings = [];
  const expectedCandidateBranch = `candidate/sitewipe-${version}`;
  if (remote?.approvedPublicCandidateVersion !== version) {
    findings.push('The remote approval does not name the exact current package version.');
  }
  if (remote?.publicCandidateSourcePushAuthorized !== true) {
    findings.push('The exact public-candidate source push is not authorized.');
  }
  if (
    remote?.approvedPublicCandidateBranch !== expectedCandidateBranch ||
    remote?.publicCandidatePullRequestAuthorized !== true
  ) {
    findings.push('The exact source-candidate branch and pull request are not authorized.');
  }
  if (
    remote?.finalPublicationApproval !== true &&
    (remote?.mergeToDefaultBranchAuthorized !== false ||
      remote?.tagCreationAuthorized !== false ||
      remote?.githubReleaseAuthorized !== false ||
      remote?.browserStoreSubmissionAuthorized !== false ||
      remote?.promotionalPublicationAuthorized !== false)
  ) {
    findings.push(
      'The source-candidate authorization does not preserve the recorded no-merge, no-tag, no-release, no-store, and no-promotion boundary.'
    );
  }
  if (!isNonEmptyString(remote?.hostedPrivacyPolicyUrl) || !isNonEmptyString(remote?.hostedPrivacyPolicyRawUrl)) {
    findings.push('Stable hosted and immutable raw privacy-policy URLs are required.');
  }
  if (
    remote?.hostedPrivacyPolicyVersion !== version ||
    remote?.hostedPrivacyPolicySha256 !== sha256(privacyBytes || Buffer.alloc(0)) ||
    remote?.hostedPrivacyPolicyExactByteParity !== true
  ) {
    findings.push('The hosted privacy policy is not byte-bound to the exact current local policy and version.');
  }
  const localReviewedAt = extractPrivacyReviewDate(privacyBytes);
  if (!localReviewedAt || remote?.hostedPrivacyPolicyReviewedAt !== localReviewedAt) {
    findings.push('The hosted privacy-policy review date does not match the current local policy.');
  }
  return findings;
}

export function findAccessibilitySourceContractFindings({ accessibility, version, releaseInputFingerprintSha256 }) {
  const findings = [];
  if (!isCalendarDate(accessibility?.reviewedAt)) {
    findings.push('Accessibility evidence has no current review date.');
  }
  const sourceContracts = accessibility?.sourceContracts;
  if (
    sourceContracts?.status !== 'passed' ||
    sourceContracts?.reviewedAt !== accessibility?.reviewedAt ||
    !Number.isInteger(sourceContracts?.namedTests) ||
    sourceContracts.namedTests <= 0 ||
    !Array.isArray(sourceContracts?.coverage) ||
    sourceContracts.coverage.length === 0 ||
    sourceContracts.coverage.some((entry) => !isNonEmptyString(entry))
  ) {
    findings.push('Accessibility source-contract results are incomplete or not current-review bound.');
  }
  if (
    sourceContracts?.binding?.version !== version ||
    sourceContracts?.binding?.releaseInputFingerprintSha256 !== releaseInputFingerprintSha256
  ) {
    findings.push('Accessibility source-contract results are not bound to the current stable release inputs.');
  }
  return findings;
}

export function findDependencyCandidateAuditFindings({ inventory, version }) {
  const findings = [];
  if (
    inventory?.status !== 'technical_inventory_complete_owner_acknowledged' ||
    inventory?.candidateVersion !== version ||
    !isCalendarDate(inventory?.inventoriedAt) ||
    !isCalendarDate(inventory?.lastAuditAt)
  ) {
    findings.push('Dependency inventory and audit are not complete for the exact current candidate.');
  }
  const vulnerabilities = inventory?.npmAuditVulnerabilities;
  if (
    !isPlainObject(vulnerabilities) ||
    ['info', 'low', 'moderate', 'high', 'critical', 'total'].some(
      (severity) => !Number.isInteger(vulnerabilities[severity]) || vulnerabilities[severity] !== 0
    )
  ) {
    findings.push('The exact current dependency audit does not record zero vulnerabilities at every severity.');
  }
  const sbom = inventory?.developmentSbom;
  if (
    sbom?.status !== 'passed' ||
    sbom?.componentVersion !== version ||
    !Number.isInteger(sbom?.components) ||
    sbom.components <= 0 ||
    !Number.isInteger(sbom?.dependencyNodes) ||
    sbom.dependencyNodes <= 0 ||
    !Number.isInteger(sbom?.bytes) ||
    sbom.bytes <= 0 ||
    !/^[A-F0-9]{64}$/.test(sbom?.sha256 || '') ||
    !isIsoDateOrTimestamp(sbom?.generatedAt)
  ) {
    findings.push('The development SBOM is not regenerated and integrity-bound for the exact current candidate.');
  }
  return findings;
}

async function validateMediaAsset({
  asset,
  label,
  root,
  expectedWidth,
  expectedHeight,
  runtimeArtifactSha256,
  requiresArtifactBinding = false,
  requiresCaptureDate = false,
  readAssetBytes,
  findings
}) {
  if (!isPlainObject(asset)) {
    findings.push(`${label} must be an integrity-bound asset object.`);
    return;
  }
  if (
    !isNonEmptyString(asset.path) ||
    isAbsolute(asset.path) ||
    relative(root, resolve(root, asset.path)).startsWith('..')
  ) {
    findings.push(`${label} has an unsafe or missing repository-relative path.`);
    return;
  }
  if (expectedWidth !== undefined && asset.width !== expectedWidth) {
    findings.push(`${label} width must be ${expectedWidth}.`);
  }
  if (expectedHeight !== undefined && asset.height !== expectedHeight) {
    findings.push(`${label} height must be ${expectedHeight}.`);
  }
  if (requiresArtifactBinding && asset.artifactSha256 !== runtimeArtifactSha256) {
    findings.push(`${label} is not bound to the current runtime artifact SHA-256.`);
  }
  if (requiresCaptureDate && !isIsoDateOrTimestamp(asset.capturedAt)) {
    findings.push(`${label} has no valid capture date.`);
  }
  if (!Number.isInteger(asset.bytes) || asset.bytes <= 0 || !/^[A-F0-9]{64}$/.test(asset.sha256 || '')) {
    findings.push(`${label} has incomplete byte-count or SHA-256 integrity metadata.`);
    return;
  }
  try {
    const bytes = await readAssetBytes(resolve(root, asset.path));
    if (bytes.byteLength !== asset.bytes || sha256(bytes) !== asset.sha256) {
      findings.push(`${label} does not match its retained bytes and SHA-256.`);
    }
  } catch {
    findings.push(`${label} file is missing or unreadable.`);
  }
}

function summarizeDurations(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  return {
    medianMs,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maximumMs: sorted.at(-1)
  };
}

function extractPrivacyReviewDate(bytes) {
  const match = Buffer.from(bytes || [])
    .toString('utf8')
    .match(/^Last reviewed: (\d{4}-\d{2}-\d{2})\.$/m);
  return match && isCalendarDate(match[1]) ? match[1] : null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSha256(value) {
  return /^[A-F0-9]{64}$/.test(String(value || ''));
}

function isGitObjectId(value) {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(String(value || ''));
}

function isSemanticVersion(value) {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(String(value || ''));
}

function hasExactKeys(value, expected) {
  return isPlainObject(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function exactArray(value, expected) {
  return Array.isArray(value) && JSON.stringify(value) === JSON.stringify(expected);
}

function isFiniteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function sameNumber(left, right) {
  return Number.isFinite(left) && Math.abs(left - right) < 0.000001;
}

function isCalendarDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function isIsoDateOrTimestamp(value) {
  return isCalendarDate(value) || (typeof value === 'string' && !Number.isNaN(Date.parse(value)));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

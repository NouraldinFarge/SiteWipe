import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export function findBrowserEvidenceFindings({ browser, runtimeArtifactSha256 }) {
  const findings = [];
  const requiredMatrix = browser?.requiredMatrix;
  if (
    !Array.isArray(requiredMatrix) ||
    requiredMatrix.length === 0 ||
    requiredMatrix.some((entry) => !isNonEmptyString(entry)) ||
    new Set(requiredMatrix).size !== requiredMatrix.length
  ) {
    findings.push('The browser requiredMatrix must contain unique non-empty requirements.');
    return findings;
  }

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
  if (remote?.approvedPublicCandidateVersion !== version) {
    findings.push('The remote approval does not name the exact current package version.');
  }
  if (remote?.publicCandidateSourcePushAuthorized !== true) {
    findings.push('The exact public-candidate source push is not authorized.');
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

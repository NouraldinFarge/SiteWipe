import { readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import {
  assertSemanticVersion,
  computeReleaseInputFingerprint,
  computeRuntimeFingerprint,
  projectRoot,
  runtimeArtifactBase,
  sha256
} from './versioning.mjs';
import { RUNTIME_FILES } from './release-files.mjs';
import { resolveCurrentValidationEvidence } from './validation-evidence.mjs';

export class VersionContractError extends Error {
  constructor(errors) {
    super(`Version contract failed:\n${errors.map((error) => `- ${error}`).join('\n')}`);
    this.name = 'VersionContractError';
    this.errors = errors;
  }
}

export async function validateVersionContract({
  root = projectRoot,
  requireArtifact = false,
  artifactDirectory = resolve(root, 'dist', 'current')
} = {}) {
  const errors = [];
  const text = (path) => readFile(resolve(root, path), 'utf8');
  const json = async (path) => JSON.parse(await text(path));
  const requireValue = (value, message) => {
    if (!value) errors.push(message);
  };

  const pkg = await json('package.json');
  const lock = await json('package-lock.json');
  const sourcePkg = await json('src/package.json');
  const manifest = await json('src/manifest.json');
  const state = await json('docs/evidence/version-state.json');
  const version = assertSemanticVersion(pkg.version, 'package version');
  const artifactBase = runtimeArtifactBase(version);

  for (const [label, value] of [
    ['package-lock root', lock.version],
    ['package-lock workspace', lock.packages?.['']?.version],
    ['source package', sourcePkg.version],
    ['manifest', manifest.version],
    ['version ledger', state.currentVersion]
  ]) {
    requireValue(value === version, `${label} version ${String(value)} does not match ${version}`);
  }

  const constants = await text('src/shared/constants.js');
  const selfTest = await text('src/test-harness/release-selftest.mjs');
  requireValue(extract(constants, /\bversion:\s*'([^']+)'/) === version, 'APP.version does not match package version');
  requireValue(
    extract(selfTest, /manifest\.version,\s*'([^']+)'/) === version,
    'legacy release self-test version does not match package version'
  );

  for (const [path, expected] of [
    ['README.md', `current candidate version \`${version}\``],
    ['PRIVACY.md', `SiteWipe \`${version}\``],
    ['SECURITY.md', `public-source \`${version}\` prerelease`],
    ['src/README.md', `Version \`${version}\``],
    ['docs/architecture.md', `\`${version}\` remains a public-source prerelease version`],
    ['docs/threat-model.md', `SiteWipe \`${version}\` candidate`],
    ['docs/release-readiness.md', `v${version},`],
    ['CHANGELOG.md', `## ${version} — public-source prerelease work`],
    ['.github/ISSUE_TEMPLATE/bug.yml', `${version} / SHA-256`]
  ]) {
    requireValue((await text(path)).includes(expected), `${path} is missing current-version text: ${expected}`);
  }

  const browser = await json('docs/evidence/browser-validation.json');
  const performance = await json('docs/evidence/performance-results.json');
  const accessibility = await json('docs/evidence/accessibility-results.json');
  const media = await json('docs/evidence/media-inventory.json');
  const validationEvidence = await resolveCurrentValidationEvidence(root);
  const automated = await json(validationEvidence.relativePath);
  const expectedRuntimeZip = `${artifactBase}.zip`;
  for (const [label, artifact] of [
    ['browser evidence', browser.artifact],
    ['performance evidence', performance.artifact],
    ['accessibility evidence', accessibility.artifact],
    ['media evidence', media.artifact]
  ]) {
    requireValue(artifact?.version === version, `${label} version does not match ${version}`);
    requireValue(artifact?.runtimeZip === expectedRuntimeZip, `${label} runtime ZIP name is stale`);
  }
  requireValue(automated.fullCheck?.manifest?.version === version, 'automated evidence manifest version is stale');
  requireValue(automated.artifacts?.runtimeZip === expectedRuntimeZip, 'automated evidence runtime ZIP name is stale');
  requireValue(
    automated.artifacts?.sourceZip === `${artifactBase}-source.zip`,
    'automated evidence source ZIP name is stale'
  );
  requireValue(
    automated.artifacts?.runtimeSbom === `${artifactBase}.runtime-sbom.cdx.json`,
    'automated evidence runtime SBOM name is stale'
  );
  requireValue(
    automated.artifacts?.unsignedProvenanceInput === `${artifactBase}.unsigned-provenance-input.json`,
    'automated evidence unsigned provenance-input name is stale'
  );

  const fingerprint = await computeRuntimeFingerprint(root);
  const releaseInputFingerprint = await computeReleaseInputFingerprint(root);
  requireValue(state.runtimeFileCount === RUNTIME_FILES.length, 'version ledger runtime file count is stale');
  requireValue(
    state.runtimeFingerprintSha256 === fingerprint,
    'allowlisted runtime files changed without a version bump; add an Unreleased changelog entry and run npm run version:bump -- patch'
  );
  requireValue(
    state.releaseInputFileCount === releaseInputFingerprint.fileCount,
    'version ledger stable release-input file count is stale'
  );
  requireValue(
    state.releaseInputFingerprintSha256 === releaseInputFingerprint.sha256,
    'stable release inputs changed without a version bump; add an Unreleased changelog entry and run npm run version:bump -- patch'
  );

  if (requireArtifact) {
    const checkedArtifactDirectory = validateArtifactDirectory(root, artifactDirectory);
    let runtimeBytes;
    try {
      runtimeBytes = await readFile(resolve(checkedArtifactDirectory, expectedRuntimeZip));
    } catch {
      errors.push(
        `required current artifact is missing: ${relative(root, checkedArtifactDirectory)}/${expectedRuntimeZip}`
      );
    }
    if (runtimeBytes) {
      const digest = sha256(runtimeBytes);
      validateOptionalEvidenceHash(
        errors,
        'browser evidence',
        browser.artifact?.sha256,
        digest,
        evidenceRequiresHash(browser)
      );
      validateOptionalEvidenceHash(
        errors,
        'performance evidence',
        performance.artifact?.sha256,
        digest,
        evidenceRequiresHash(performance)
      );
      validateOptionalEvidenceHash(
        errors,
        'accessibility evidence',
        accessibility.artifact?.sha256,
        digest,
        evidenceRequiresHash(accessibility)
      );
      validateOptionalEvidenceHash(
        errors,
        'media evidence',
        media.artifact?.sha256,
        digest,
        evidenceRequiresHash(media)
      );
      requireValue(automated.artifacts?.runtimeZipSha256 === digest, 'automated evidence artifact hash is stale');
      requireValue(
        automated.artifacts?.runtimeZipBytes === runtimeBytes.length,
        'automated evidence artifact size is stale'
      );
    }
  }

  if (errors.length) throw new VersionContractError(errors);
  return {
    version,
    requireArtifact,
    runtimeFingerprintSha256: fingerprint,
    releaseInputFingerprintSha256: releaseInputFingerprint.sha256,
    message: `Version contract passed for v${version}; ${requireArtifact ? 'artifact evidence, ' : ''}runtime fingerprint ${fingerprint}; stable release-input fingerprint ${releaseInputFingerprint.sha256}.`
  };
}

export function validateArtifactDirectory(root, requested) {
  const absolute = resolve(root, requested);
  const distRoot = resolve(root, 'dist');
  const child = relative(distRoot, absolute);
  if (!child || child === '..' || child.startsWith(`..${sep}`)) {
    throw new Error('Artifact directory must be a child of the project dist directory.');
  }
  return absolute;
}

function extract(value, pattern) {
  return value.match(pattern)?.[1] || null;
}

function evidenceRequiresHash(evidence) {
  return evidence?.reviewerApproval === true || ['passed', 'approved'].includes(evidence?.status);
}

function validateOptionalEvidenceHash(errors, label, recorded, actual, required) {
  if (recorded == null && !required) return;
  if (!/^[0-9A-F]{64}$/.test(String(recorded || ''))) errors.push(`${label} artifact hash is missing or malformed`);
  if (recorded !== actual) errors.push(`${label} artifact hash is stale`);
}

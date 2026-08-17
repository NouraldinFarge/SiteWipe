import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  isLocalGeneratedPath,
  LOCAL_GENERATED_DIRECTORIES,
  RUNTIME_FILES,
  SOURCE_ARCHIVE_ROOT_FILES
} from '../../scripts/release-files.mjs';
import { resolveCurrentValidationEvidence } from '../../scripts/validation-evidence.mjs';
import {
  assertSemanticVersion,
  computeReleaseInputFingerprint,
  computeRuntimeFingerprint,
  isMutableReleaseRecord,
  resolveNextVersion,
  runtimeArtifactBase,
  sha256
} from '../../scripts/versioning.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('version helpers produce deliberate forward-only semantic versions and artifact names', () => {
  assert.equal(assertSemanticVersion('1.9.8'), '1.9.8');
  assert.equal(resolveNextVersion('1.9.8', 'patch'), '1.9.9');
  assert.equal(resolveNextVersion('1.9.8', 'minor'), '1.10.0');
  assert.equal(resolveNextVersion('1.9.8', 'major'), '2.0.0');
  assert.equal(resolveNextVersion('1.9.8', '1.11.2'), '1.11.2');
  assert.equal(runtimeArtifactBase('1.9.9'), 'sitewipe-private-rc-1.9.9');
  assert.throws(() => assertSemanticVersion('1.09.9'), /leading zeroes/);
  assert.throws(() => resolveNextVersion('1.9.8', '1.9.8'), /must be greater/);
  assert.throws(() => resolveNextVersion('1.9.8', '1.9.7'), /must be greater/);
});

test('the version ledger fingerprints every allowlisted runtime file and all release paths enforce it', async () => {
  const pkg = await json('package.json');
  const state = await json('docs/evidence/version-state.json');
  const automatedPath = (await resolveCurrentValidationEvidence(root)).relativePath;
  const automated = await json(automatedPath);
  assert.equal(state.currentVersion, pkg.version);
  assert.equal(state.runtimeFileCount, RUNTIME_FILES.length);
  assert.equal(state.runtimeFingerprintSha256, await computeRuntimeFingerprint(root));
  const releaseInputFingerprint = await computeReleaseInputFingerprint(root);
  assert.equal(state.releaseInputFileCount, releaseInputFingerprint.fileCount);
  assert.equal(state.releaseInputFingerprintSha256, releaseInputFingerprint.sha256);
  assert.equal(automated.artifacts.runtimeSbom, `sitewipe-private-rc-${pkg.version}.runtime-sbom.cdx.json`);
  assert.equal(
    automated.artifacts.unsignedProvenanceInput,
    `sitewipe-private-rc-${pkg.version}.unsigned-provenance-input.json`
  );
  assert.equal(pkg.scripts['version:bump'], 'node scripts/bump-version.mjs');
  assert.match(pkg.scripts.check, /npm run check:version/);
  assert.match(pkg.scripts.check, /npm run check:dependency-licenses/);
  assert.match(pkg.scripts.check, /npm run check:project-license/);
  assert.match(pkg.scripts.check, /npm run check:publication-scope/);
  assert.match(await text('scripts/build-release.mjs'), /check-version\.mjs/);
  assert.match(await text('scripts/build-release.mjs'), /check-project-license\.mjs/);
  assert.match(await text('scripts/build-release.mjs'), /check-publication-scope\.mjs/);
  assert.match(await text('scripts/verify-release.mjs'), /check-version\.mjs/);
});

test('stable release-input versioning excludes only mutable evidence and approval records', () => {
  assert.equal(isMutableReleaseRecord('docs/evidence/browser-validation.json'), true);
  assert.equal(isMutableReleaseRecord('docs/decisions/license.json'), true);
  assert.equal(isMutableReleaseRecord('assets/brand/icon-provenance.json'), true);
  assert.equal(isMutableReleaseRecord('docs/decisions/0001-permission-reduction.md'), false);
  assert.equal(isMutableReleaseRecord('scripts/build-release.mjs'), false);
  assert.equal(isMutableReleaseRecord('tests/release/versioning.test.mjs'), false);
  assert.equal(isMutableReleaseRecord('src/manifest.json'), false);
});

test('repository checks share the generated-output boundary', async () => {
  for (const directory of [
    'browser-profiles',
    'coverage',
    'dist',
    'node_modules',
    'playwright-report',
    'test-results'
  ]) {
    assert.equal(LOCAL_GENERATED_DIRECTORIES.includes(directory), true, `${directory} is not centrally excluded`);
    assert.equal(isLocalGeneratedPath(`C:\\work\\SiteWipe\\${directory}\\nested\\artifact.js`), true);
    assert.equal(isLocalGeneratedPath(`/work/SiteWipe/${directory.toUpperCase()}/nested/artifact.js`), true);
  }
  assert.equal(isLocalGeneratedPath('src/background/cleanup.js'), false);
  assert.match(await text('eslint.config.js'), /LOCAL_GENERATED_DIRECTORIES/);
  assert.match(await text('scripts/check-syntax.mjs'), /isLocalGeneratedPath/);
  assert.match(await text('scripts/check-docs.mjs'), /isLocalGeneratedPath/);
  assert.match(await text('scripts/check-publication-scope.mjs'), /LOCAL_GENERATED_DIRECTORIES/);
});

test('the owner-selected MIT license is exact, package-aligned, and included in the source closure', async () => {
  const pkg = await json('package.json');
  const sourcePkg = await json('src/package.json');
  const lock = await json('package-lock.json');
  const decision = await json('docs/decisions/license.json');
  const licenseBytes = await readFile(resolve(root, 'LICENSE'));
  assert.equal(decision.status, 'owner_approved');
  assert.equal(decision.ownerApproved, true);
  assert.equal(decision.model, 'MIT');
  assert.equal(decision.spdxIdentifier, 'MIT');
  assert.equal(decision.licenseFile, 'LICENSE');
  assert.equal(decision.licenseFileSha256, sha256(licenseBytes));
  assert.equal(pkg.license, 'MIT');
  assert.equal(sourcePkg.license, 'MIT');
  assert.equal(lock.packages[''].license, 'MIT');
  assert.equal(SOURCE_ARCHIVE_ROOT_FILES.includes('LICENSE'), true);
});

test('release evidence remains bound to tested bytes and approval runs after rebuild verification', async () => {
  const builder = await text('scripts/build-release.mjs');
  const bump = await text('scripts/bump-version.mjs');
  const versionCheck = await text('scripts/check-version.mjs');
  const workflow = await text('.github/workflows/release-candidate.yml');
  const codeqlWorkflow = await text('.github/workflows/codeql.yml');
  const publicationGate = await text('scripts/check-publication-gates.mjs');
  assert.doesNotMatch(builder, /browser-validation\.json|performance-results\.json|accessibility-results\.json/);
  assert.match(bump, /browser\.status = 'pending'/);
  assert.match(bump, /performance\.status = 'pending'/);
  assert.match(bump, /accessibility\.status = 'pending_installed_validation'/);
  assert.match(bump, /dependencyInventory\.lockfileSha256 = sha256/);
  assert.match(bump, /runtimeSbom: `\$\{artifactBase\}\.runtime-sbom\.cdx\.json`/);
  assert.match(bump, /unsignedProvenanceInput: `\$\{artifactBase\}\.unsigned-provenance-input\.json`/);
  assert.match(bump, /resolveConfig\(readinessPath\)/);
  assert.match(bump, /await format\(readiness/);
  assert.match(versionCheck, /automated evidence runtime SBOM name is stale/);
  assert.match(versionCheck, /automated evidence unsigned provenance-input name is stale/);
  assert.match(publicationGate, /knownExactNameListings/);
  assert.match(publicationGate, /dependencyInventory\?\.lockfileSha256 !== sha256\(packageLock\)/);
  assert.match(publicationGate, /requiredChecksVerified/);
  assert.match(publicationGate, /hostedPrivacyPolicyUrl/);
  assert.match(publicationGate, /releaseEnvironmentVerified/);
  assert.match(publicationGate, /findRetiredBypassSignals/);
  assert.match(publicationGate, /verifyLiveGitPublicationScope/);
  assert.match(publicationGate, /check-publication-scope\.mjs/);
  assert.match(publicationGate, /Every Standard and Expert cleanup must require detailed per-run review/);
  assert.match(codeqlWorkflow, /actions: read/);
  assert.match(codeqlWorkflow, /security-events: write/);
  assert.match(codeqlWorkflow, /repository\.visibility == 'public'/);
  assert.match(codeqlWorkflow, /upload-database: false/);
  assert.match(codeqlWorkflow, /Retain private CodeQL SARIF evidence/);
  assert.match(codeqlWorkflow, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(codeqlWorkflow, /output: codeql-results/);
  assert.match(codeqlWorkflow, /path: codeql-results\/\*\.sarif/);
  assert.doesNotMatch(codeqlWorkflow, /(?:output|path):\s+\.\.\//);
  assert.ok(
    workflow.indexOf('npm run verify:release-candidate') < workflow.indexOf('npm run check:publication-gates'),
    'publication gates must evaluate the rebuilt and verified bytes'
  );
});

async function json(relative) {
  return JSON.parse(await text(relative));
}

async function text(relative) {
  return readFile(resolve(root, relative), 'utf8');
}

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { RUNTIME_FILES, SOURCE_ARCHIVE_ROOT_FILES } from '../../scripts/release-files.mjs';
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
  assert.equal(runtimeArtifactBase('1.9.9'), 'sitewipe-unreleased-candidate-1.9.9');
  assert.throws(() => assertSemanticVersion('1.09.9'), /leading zeroes/);
  assert.throws(() => resolveNextVersion('1.9.8', '1.9.8'), /must be greater/);
  assert.throws(() => resolveNextVersion('1.9.8', '1.9.7'), /must be greater/);
});

test('the version ledger fingerprints every allowlisted runtime file and all release paths enforce it', async () => {
  const pkg = await json('package.json');
  const state = await json('docs/evidence/version-state.json');
  assert.equal(state.currentVersion, pkg.version);
  assert.equal(state.runtimeFileCount, RUNTIME_FILES.length);
  assert.equal(state.runtimeFingerprintSha256, await computeRuntimeFingerprint(root));
  const releaseInputFingerprint = await computeReleaseInputFingerprint(root);
  assert.equal(state.releaseInputFileCount, releaseInputFingerprint.fileCount);
  assert.equal(state.releaseInputFingerprintSha256, releaseInputFingerprint.sha256);
  assert.equal(pkg.scripts['version:bump'], 'node scripts/bump-version.mjs');
  assert.match(pkg.scripts.check, /npm run check:version/);
  assert.match(pkg.scripts.check, /npm run check:dependency-licenses/);
  assert.match(pkg.scripts.check, /npm run check:project-license/);
  assert.match(await text('scripts/build-release.mjs'), /check-version\.mjs/);
  assert.match(await text('scripts/build-release.mjs'), /check-project-license\.mjs/);
  assert.match(await text('scripts/verify-release.mjs'), /verifyReleaseCandidate/);
  assert.match(await text('scripts/release-artifact-verification.mjs'), /validateVersionContract/);
});

test('stable release-input versioning excludes only mutable evidence and approval records', () => {
  assert.equal(isMutableReleaseRecord('docs/evidence/browser-validation.json'), true);
  assert.equal(isMutableReleaseRecord('docs/decisions/license.json'), true);
  assert.equal(isMutableReleaseRecord('docs/decisions/direct-cleanup-owner-decision.json'), true);
  assert.equal(isMutableReleaseRecord('assets/brand/icon-provenance.json'), true);
  assert.equal(isMutableReleaseRecord('docs/decisions/0001-permission-reduction.md'), false);
  assert.equal(isMutableReleaseRecord('scripts/build-release.mjs'), false);
  assert.equal(isMutableReleaseRecord('tests/release/versioning.test.mjs'), false);
  assert.equal(isMutableReleaseRecord('src/manifest.json'), false);
});

test('the version transaction owns the synthetic side-panel report version marker', async () => {
  const pkg = await json('package.json');
  const bump = await text('scripts/bump-version.mjs');
  const sidepanelMock = await text('tests/browser/fixtures/sidepanel-browser-mock.js');
  assert.match(sidepanelMock, new RegExp(`appVersion: '${pkg.version.replaceAll('.', '\\.')}'`));
  assert.match(bump, /'tests\/browser\/fixtures\/sidepanel-browser-mock\.js'/);
  assert.match(bump, /`appVersion: '\$\{previousVersion\}'`/);
  assert.match(bump, /`appVersion: '\$\{nextVersion\}'`/);
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
  const evidenceReset = await text('scripts/evidence-reset.mjs');
  const workflow = await text('.github/workflows/release-candidate.yml');
  const publicationGate = await text('scripts/check-publication-gates.mjs');
  assert.doesNotMatch(builder, /browser-validation\.json|performance-results\.json|accessibility-results\.json/);
  assert.match(bump, /browser\.status = 'pending'/);
  assert.match(bump, /delete browser\.attemptedAtApproximate/);
  assert.match(bump, /browser\.syntheticInAppBrowser = emptySyntheticInAppBrowserEvidence\(\)/);
  assert.match(bump, /browser\.limitations = \[/);
  assert.match(bump, /Node tests and static checks do not establish installed Chrome behavior/);
  assert.match(bump, /assertDependencyInventoryMatchesLockfile\(dependencyInventory, lockfileBefore\)/);
  assert.match(bump, /resetAutomatedValidationEvidence/);
  assert.match(bump, /planValidationEvidenceVersionTransition/);
  assert.match(bump, /stageValidationEvidenceVersionTransition/);
  assert.match(bump, /createOnlyPaths: validationCreateOnlyPaths/);
  assert.match(bump, /resetProvenanceTechnicalEvidence/);
  assert.match(evidenceReset, /coverage:[\s\S]*status: 'pending'/);
  assert.match(evidenceReset, /dependencyAudit:[\s\S]*lockfileSha256: null/);
  assert.match(bump, /performance\.status = 'pending'/);
  assert.match(bump, /resetAccessibilityEvidence/);
  assert.match(evidenceReset, /status: 'pending_installed_validation'/);
  assert.match(evidenceReset, /sourceContracts:[\s\S]*releaseInputFingerprintSha256: null/);
  assert.match(bump, /resetDependencyLicenseInventoryEvidence/);
  assert.match(evidenceReset, /lockfileSha256: currentLockfileSha256/);
  assert.match(evidenceReset, /developmentSbom:[\s\S]*status: 'pending'/);
  assert.match(publicationGate, /knownExactNameListings/);
  assert.match(publicationGate, /dependencyInventory\?\.lockfileSha256 !== sha256\(packageLock\)/);
  assert.match(publicationGate, /lockedDevelopmentGraphCount !== lockedDevelopmentPackages\.length/);
  assert.doesNotMatch(publicationGate, /lockedDevelopmentGraphCount !== 406/);
  assert.match(publicationGate, /requiredChecksVerified/);
  assert.match(publicationGate, /hostedPrivacyPolicyUrl/);
  assert.match(publicationGate, /findRemotePublicationFindings/);
  assert.match(publicationGate, /findBrowserEvidenceFindings/);
  assert.match(publicationGate, /findPerformanceEvidenceFindings/);
  assert.match(publicationGate, /findMediaEvidenceFindings/);
  assert.match(publicationGate, /findAccessibilitySourceContractFindings/);
  assert.match(publicationGate, /findDependencyCandidateAuditFindings/);
  assert.match(publicationGate, /releaseEnvironmentVerified/);
  assert.match(publicationGate, /findDirectCleanupPublicationContractFindings/);
  assert.match(publicationGate, /direct-cleanup-owner-decision\.json/);
  assert.match(publicationGate, /publicationGateDirectCleanupContract/);
  assert.match(publicationGate, /default-off, explicitly confirmed, preflight-bound, single-use/);
  assert.match(publicationGate, /verifyReleaseCandidate\(\{ root \}\)/);
  assert.match(publicationGate, /sourceClosurePrivatePathScan\?\.repositoryFiles !== verifiedRelease\?\.sourceFiles/);
  assert.doesNotMatch(publicationGate, /findRetiredBypassSignals/);
  assert.ok(
    workflow.indexOf('npm run verify:release-candidate') < workflow.indexOf('npm run check:publication-gates'),
    'publication gates must evaluate the rebuilt and verified bytes'
  );
});

test('the active automated evidence pointer uses a fresh record instead of rewriting historical validation', async () => {
  const pkg = await json('package.json');
  const pointer = await json('docs/evidence/automated-validation-current.json');
  assert.match(pointer.record, /^automated-validation-\d{4}-\d{2}-\d{2}(?:-v\d+\.\d+\.\d+)?\.json$/);
  const current = await json(`docs/evidence/${pointer.record}`);
  assert.equal(current.schemaVersion, 1);
  assert.equal(current.fullCheck.versionContract.version, pkg.version);
  if (pointer.version) {
    assert.equal(pointer.version, pkg.version);
    assert.ok(pointer.record.endsWith(`-v${pkg.version}.json`));
  }
});

async function json(relative) {
  return JSON.parse(await text(relative));
}

async function text(relative) {
  return readFile(resolve(root, relative), 'utf8');
}

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resetAccessibilityEvidence,
  resetAutomatedValidationEvidence,
  resetDependencyLicenseInventoryEvidence,
  resetMediaEvidence,
  resetPerformanceEvidence,
  resetProvenanceTechnicalEvidence
} from '../../scripts/evidence-reset.mjs';
import { RUNTIME_FILES } from '../../scripts/release-files.mjs';

test('version reset removes every candidate-sensitive automated pass and result', () => {
  const reset = resetAutomatedValidationEvidence(
    {
      schemaVersion: 1,
      environment: { node: 'old' },
      fullCheck: { command: 'npm run check', status: 'passed', staleResult: true },
      coverage: { command: 'npm run test:coverage', status: 'passed', all: { lines: 99 } },
      dependencyInstall: { status: 'passed', installedPackages: 400 },
      dependencyAudit: { status: 'passed', knownVulnerabilities: 0, lockfileSha256: 'OLD' },
      fixtureInfrastructure: { version: 'fixture-v1', serverContract: 'passed' },
      artifacts: { status: 'local_reproducible_build_passed', runtimeZipSha256: 'OLD' },
      publicationGate: { command: 'npm run check:publication-gates', publicationRecommendation: 'approved' }
    },
    {
      version: '2.0.1',
      artifactBase: 'sitewipe-unreleased-candidate-2.0.1',
      runtimeFileCount: RUNTIME_FILES.length,
      releaseState: 'pending state'
    }
  );

  assert.equal(reset.status, 'version_bumped_pending_validation');
  assert.deepEqual(reset.environment, {});
  assert.equal(reset.fullCheck.status, 'pending');
  assert.equal(reset.fullCheck.versionContract.runtimeFingerprintSha256, null);
  assert.equal(reset.fullCheck.manifest.version, '2.0.1');
  assert.equal(Object.hasOwn(reset.fullCheck, 'staleResult'), false);
  assert.equal(reset.coverage.status, 'pending');
  assert.equal(Object.hasOwn(reset.coverage, 'all'), false);
  assert.equal(reset.dependencyInstall.status, 'pending');
  assert.equal(reset.dependencyInstall.installedPackages, null);
  assert.equal(reset.dependencyAudit.status, 'pending');
  assert.equal(reset.dependencyAudit.lockfileSha256, null);
  assert.equal(reset.fixtureInfrastructure.serverContract, 'pending');
  assert.equal(
    reset.scopeAndPrivacyEvidence.directCleanupDecision,
    'docs/decisions/direct-cleanup-owner-decision.json'
  );
  assert.equal(reset.scopeAndPrivacyEvidence.historicalBypassApprovalStatus, 'not_applicable_retired');
  assert.equal(reset.scopeAndPrivacyEvidence.publicationGateDirectCleanupContract, 'pending');
  assert.equal(Object.hasOwn(reset.scopeAndPrivacyEvidence, 'publicationGateRuntimeBypassScan'), false);
  assert.equal(reset.scopeAndPrivacyEvidence.redactionCanaries, 'pending');
  assert.equal(reset.gitInitialization.status, 'pending_exact_candidate_validation');
  assert.equal(reset.artifacts.status, 'pending_rebuild');
  assert.equal(reset.artifacts.runtimeFiles, RUNTIME_FILES.length);
  assert.equal(reset.artifacts.runtimeZipSha256, null);
  assert.equal(reset.artifacts.byteIdenticalAcrossConsecutiveBuilds, false);
  assert.equal(reset.publicationGate.publicationRecommendation, 'not_evaluated');
});

test('version reset preserves owner provenance but invalidates every technical provenance result', () => {
  const reset = resetProvenanceTechnicalEvidence(
    {
      schemaVersion: 1,
      status: 'approved',
      ownerApproval: true,
      ownerConfirmation: { firstPartyCreationConfirmed: true },
      technicalStatus: 'passed',
      technicalEvidence: {
        sourceClosurePrivatePathScan: { status: 'passed', repositoryFiles: 200 },
        runtimePackage: { status: 'passed', runtimeFiles: 50, npmRuntimeDependencies: 0 },
        candidateIcon: { status: 'passed', editableSource: 'assets/brand/icon-source.svg' }
      }
    },
    { runtimeFileCount: RUNTIME_FILES.length }
  );

  assert.equal(reset.ownerApproval, true);
  assert.equal(reset.ownerConfirmation.firstPartyCreationConfirmed, true);
  assert.equal(reset.status, 'owner_approved_technical_revalidation_pending');
  assert.equal(reset.technicalStatus, 'pending_validation');
  assert.equal(reset.technicalEvidence.sourceClosurePrivatePathScan.repositoryFiles, null);
  assert.equal(reset.technicalEvidence.runtimePackage.runtimeFiles, RUNTIME_FILES.length);
  assert.equal(reset.technicalEvidence.runtimePackage.npmRuntimeDependencies, null);
  assert.equal(reset.technicalEvidence.candidateIcon.status, 'pending');
  assert.equal(reset.technicalEvidence.sourceArchiveControls.exactSourceClosureRequired, null);
});

test('version reset invalidates accessibility source and installed evidence including candidate binding', () => {
  const reset = resetAccessibilityEvidence(
    {
      schemaVersion: 1,
      status: 'passed',
      reviewedAt: '2026-08-16',
      sourceContracts: {
        status: 'passed',
        reviewedAt: '2026-08-16',
        binding: { version: '2.0.0', releaseInputFingerprintSha256: 'OLD' },
        namedTests: 6,
        coverage: ['old result']
      },
      installedChecks: { axe: 'passed', keyboardOnly: 'passed' },
      installedEvidence: {
        status: 'passed',
        environment: 'Exact prior-version installed browser'
      },
      browserVersions: { chrome: '151' },
      artifact: { version: '2.0.0', runtimeZip: 'old.zip', sha256: 'OLD' },
      reviewerApproval: true
    },
    { version: '2.0.1', artifactBase: 'sitewipe-unreleased-candidate-2.0.1' }
  );

  assert.equal(reset.status, 'pending_installed_validation');
  assert.equal(reset.reviewedAt, null);
  assert.deepEqual(reset.sourceContracts, {
    status: 'pending',
    reviewedAt: null,
    binding: { version: '2.0.1', releaseInputFingerprintSha256: null },
    namedTests: null,
    coverage: []
  });
  assert.deepEqual(reset.installedChecks, { axe: 'pending', keyboardOnly: 'pending' });
  assert.equal(reset.installedEvidence, null);
  assert.deepEqual(reset.browserVersions, {});
  assert.deepEqual(reset.artifact, {
    version: '2.0.1',
    runtimeZip: 'sitewipe-unreleased-candidate-2.0.1.zip',
    sha256: null
  });
  assert.equal(reset.reviewerApproval, false);
});

test('version reset removes prior performance observations and uses neutral current requirements', () => {
  const reset = resetPerformanceEvidence(
    {
      schemaVersion: 1,
      status: 'passed',
      measuredAt: '2026-08-23T00:00:00.000Z',
      environment: { browser: 'prior Chrome' },
      artifact: { version: '2.0.0', runtimeZip: 'old.zip', sha256: 'OLD' },
      fixtures: [{ durationMs: 904 }],
      limitations: ['The current 904 ms result passed.'],
      reviewerApproval: true
    },
    { version: '2.0.1', artifactBase: 'sitewipe-unreleased-candidate-2.0.1' }
  );

  assert.equal(reset.status, 'pending');
  assert.equal(reset.measuredAt, null);
  assert.deepEqual(reset.environment, {});
  assert.deepEqual(reset.fixtures, []);
  assert.deepEqual(reset.artifact, {
    version: '2.0.1',
    runtimeZip: 'sitewipe-unreleased-candidate-2.0.1.zip',
    sha256: null
  });
  assert.equal(
    reset.limitations.some((entry) => /904|passed/i.test(entry)),
    false
  );
  assert.equal(
    reset.limitations.every((entry) => !/current .* result/i.test(entry)),
    true
  );
  assert.equal(reset.reviewerApproval, false);
});

test('version reset clears active media review while preserving explicitly historical media fields', () => {
  const historical = { version: '1.9.0', status: 'historical_approved_not_current' };
  const reset = resetMediaEvidence(
    {
      schemaVersion: 1,
      status: 'approved',
      authenticScreenshotCount: 4,
      demoDurationSeconds: 65,
      screenshots: [{ path: 'old.png' }],
      demo: { path: 'old.mp4' },
      priorInstalledMediaReview: historical,
      review: { status: 'approved_exact_artifact_media_only', scope: 'Exact prior-version artifact' },
      artifact: { version: '2.0.0', runtimeZip: 'old.zip', sha256: 'OLD' },
      storeAssets: {
        icon128: { path: 'src/assets/icons/icon128.png' },
        screenshots1280x800: ['old.png'],
        promotionalTile440x280: 'old-promo.png',
        marquee1400x560: 'old-marquee.png',
        githubSocialPreview: 'old-social.png'
      },
      reviewerApproval: true
    },
    { version: '2.0.1', artifactBase: 'sitewipe-unreleased-candidate-2.0.1' }
  );

  assert.equal(reset.status, 'pending');
  assert.equal(reset.authenticScreenshotCount, 0);
  assert.equal(reset.demoDurationSeconds, 0);
  assert.deepEqual(reset.screenshots, []);
  assert.equal(reset.demo, null);
  assert.equal(reset.review, null);
  assert.deepEqual(reset.priorInstalledMediaReview, historical);
  assert.deepEqual(reset.artifact, {
    version: '2.0.1',
    runtimeZip: 'sitewipe-unreleased-candidate-2.0.1.zip',
    sha256: null
  });
  assert.deepEqual(reset.storeAssets, {
    icon128: { path: 'src/assets/icons/icon128.png' },
    screenshots1280x800: [],
    promotionalTile440x280: null,
    marquee1400x560: null,
    githubSocialPreview: null
  });
  assert.equal(reset.reviewerApproval, false);
});

test('version reset preserves reviewed dependency tuples but invalidates audit and SBOM claims', () => {
  const reset = resetDependencyLicenseInventoryEvidence(
    {
      schemaVersion: 1,
      status: 'technical_inventory_complete_owner_acknowledged',
      inventoriedAt: '2026-08-17',
      lastAuditAt: '2026-08-21',
      lockfileSha256: 'OLD',
      lockedDevelopmentGraphCount: 406,
      licenseCounts: { MIT: 406 },
      directDevelopmentDependencies: [{ name: 'example', version: '1.0.0', license: 'MIT' }],
      npmAuditVulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
      developmentSbom: {
        path: 'dist/sitewipe-development-sbom.cdx.json',
        bomFormat: 'CycloneDX',
        specVersion: '1.6',
        componentVersion: '2.0.0',
        components: 300,
        dependencyNodes: 350,
        bytes: 1234,
        sha256: 'OLD',
        generatedAt: '2026-08-21T00:00:00.000Z'
      },
      controls: ['npm audit reported zero vulnerabilities for the prior candidate.'],
      ownerApproval: true
    },
    { version: '2.0.1', currentLockfileSha256: 'CURRENT' }
  );

  assert.equal(reset.status, 'pending_current_candidate_audit');
  assert.equal(reset.candidateVersion, '2.0.1');
  assert.equal(reset.inventoriedAt, null);
  assert.equal(reset.lastAuditAt, null);
  assert.equal(reset.lockfileSha256, 'CURRENT');
  assert.deepEqual(reset.npmAuditVulnerabilities, {
    info: null,
    low: null,
    moderate: null,
    high: null,
    critical: null,
    total: null
  });
  assert.deepEqual(reset.developmentSbom, {
    status: 'pending',
    path: 'validation-output/sitewipe-development-sbom.cdx.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    componentVersion: '2.0.1',
    components: null,
    dependencyNodes: null,
    bytes: null,
    sha256: null,
    generatedAt: null
  });
  assert.equal(reset.lockedDevelopmentGraphCount, 406);
  assert.equal(
    reset.controls.some((entry) => /reported zero|passed/i.test(entry)),
    false
  );
  assert.equal(
    reset.controls.some((entry) => /fresh vulnerability audit/i.test(entry)),
    true
  );
  assert.equal(
    reset.controls.some((entry) => /current candidate/i.test(entry)),
    true
  );
  assert.equal(reset.ownerApproval, true);
});

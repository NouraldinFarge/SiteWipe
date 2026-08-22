import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resetAccessibilityEvidence,
  resetAutomatedValidationEvidence,
  resetDependencyLicenseInventoryEvidence,
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
  assert.deepEqual(reset.browserVersions, {});
  assert.deepEqual(reset.artifact, {
    version: '2.0.1',
    runtimeZip: 'sitewipe-unreleased-candidate-2.0.1.zip',
    sha256: null
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
    path: 'dist/sitewipe-development-sbom.cdx.json',
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
  assert.equal(reset.ownerApproval, true);
});

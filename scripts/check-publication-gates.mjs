import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReleaseCandidate } from './release-artifact-verification.mjs';
import { RUNTIME_FILES } from './release-files.mjs';
import { resolveCurrentValidationEvidence } from './validation-evidence.mjs';
import { runtimeArtifactBase } from './versioning.mjs';
import {
  DIRECT_CLEANUP_CONTRACT_FILES,
  findDirectCleanupPublicationContractFindings
} from './direct-cleanup-publication-contract.mjs';
import {
  findAccessibilitySourceContractFindings,
  findBrowserEvidenceFindings,
  findDependencyCandidateAuditFindings,
  findMediaEvidenceFindings,
  findPerformanceEvidenceFindings,
  findRemotePublicationFindings
} from './publication-evidence-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const blockers = [];
let verifiedRelease = null;
try {
  verifiedRelease = await verifyReleaseCandidate({ root });
} catch (error) {
  blockers.push(`Local version/source/artifact integrity verification failed: ${error?.message || String(error)}`);
}
const pkg = await optionalJson('package.json');
const privacyBytes = await optionalBytes('PRIVACY.md');
const versionState = await optionalJson('docs/evidence/version-state.json');
const expectedArtifactBase = pkg?.version ? runtimeArtifactBase(pkg.version) : 'sitewipe-unreleased-candidate-unknown';
const expectedRuntimeZip = `${expectedArtifactBase}.zip`;
const currentRelease = await optionalJson('dist/current/current-release.json');
const runtimeArtifact = await optionalBytes(`dist/current/${expectedRuntimeZip}`);
const runtimeArtifactSha256 = runtimeArtifact ? sha256(runtimeArtifact) : null;
if (!runtimeArtifact) blockers.push('The exact current runtime artifact is missing from dist/current.');
if (
  currentRelease?.version !== pkg?.version ||
  currentRelease?.runtimeArtifact !== expectedRuntimeZip ||
  currentRelease?.artifactBase !== expectedArtifactBase ||
  currentRelease?.schema !== 'sitewipe.current-unreleased-candidate.v1'
) {
  blockers.push('The canonical current-release index does not identify the package version and runtime ZIP.');
}
const identity = await optionalJson('docs/decisions/product-identity.json');
const nameResearch = await optionalJson('docs/evidence/name-research-2026-08-17.json');
if (
  identity?.ownerApproved !== true ||
  identity?.approvedName !== 'SiteWipe' ||
  nameResearch?.approvedName !== identity?.approvedName ||
  !Array.isArray(identity?.knownExactNameListings) ||
  identity.knownExactNameListings.length < 3
) {
  blockers.push(
    'The owner-approved product identity and its known exact-name marketplace collisions are not recorded.'
  );
}
if (identity?.approvedPublicVersion !== pkg?.version) {
  blockers.push('The owner has not approved the exact package version as the public SiteWipe version.');
}
const license = await optionalJson('docs/decisions/license.json');
const licenseBytes = await optionalBytes('LICENSE');
const sourcePkg = await optionalJson('src/package.json');
const packageLockMetadata = await optionalJson('package-lock.json');
if (
  license?.status !== 'owner_approved' ||
  license?.ownerApproved !== true ||
  license?.model !== 'MIT' ||
  license?.spdxIdentifier !== 'MIT' ||
  license?.licenseFileRequired !== true ||
  license?.licenseFile !== 'LICENSE' ||
  !licenseBytes ||
  license?.licenseFileSha256 !== sha256(licenseBytes) ||
  pkg?.license !== 'MIT' ||
  sourcePkg?.license !== 'MIT' ||
  packageLockMetadata?.packages?.['']?.license !== 'MIT'
) {
  blockers.push('The owner-approved MIT license, exact LICENSE bytes, and package metadata are not aligned.');
}
const provenance = await optionalJson('docs/evidence/provenance-audit.json');
const dependencyInventory = await optionalJson('docs/evidence/dependency-license-inventory.json');
const packageLock = await optionalBytes('package-lock.json');
const lockedDevelopmentPackages = Object.entries(packageLockMetadata?.packages || {}).filter(([path]) =>
  path.startsWith('node_modules/')
);
if (
  provenance?.status !== 'approved' ||
  provenance?.technicalStatus !== 'passed' ||
  provenance?.technicalEvidence?.sourceClosurePrivatePathScan?.status !== 'passed' ||
  provenance?.technicalEvidence?.sourceClosurePrivatePathScan?.repositoryFiles !== verifiedRelease?.sourceFiles ||
  provenance?.technicalEvidence?.runtimePackage?.status !== 'passed' ||
  provenance?.technicalEvidence?.runtimePackage?.runtimeFiles !== RUNTIME_FILES.length ||
  provenance?.technicalEvidence?.runtimePackage?.npmRuntimeDependencies !== 0 ||
  provenance?.technicalEvidence?.dependencyLicenseInventory?.status !== 'passed' ||
  provenance?.technicalEvidence?.dependencyLicenseInventory?.lockedDevelopmentPackages !==
    dependencyInventory?.lockedDevelopmentGraphCount ||
  provenance?.technicalEvidence?.dependencyLicenseInventory?.legacyMetadataExceptionsResolved !==
    dependencyInventory?.metadataExceptions?.length ||
  provenance?.technicalEvidence?.thirdPartyNoticesAndPsl?.status !== 'passed' ||
  provenance?.technicalEvidence?.candidateIcon?.status !== 'passed' ||
  provenance?.technicalEvidence?.candidateIcon?.generatedPngsVerified !== 4 ||
  provenance?.technicalEvidence?.candidateIcon?.externalAssets !== 0 ||
  provenance?.technicalEvidence?.sourceArchiveControls?.status !== 'passed' ||
  provenance?.technicalEvidence?.sourceArchiveControls?.rejectsPrivateMaterialPatterns !== true ||
  provenance?.technicalEvidence?.sourceArchiveControls?.rejectsSymbolicLinksAndDirectoryJunctions !== true ||
  provenance?.technicalEvidence?.sourceArchiveControls?.exactSourceClosureRequired !== true ||
  dependencyInventory?.status !== 'technical_inventory_complete_owner_acknowledged' ||
  dependencyInventory?.ownerApproval !== true ||
  dependencyInventory?.runtimeDependencyCount !== 0 ||
  dependencyInventory?.lockedDevelopmentGraphCount !== lockedDevelopmentPackages.length ||
  lockedDevelopmentPackages.some(([, value]) => value?.dev !== true) ||
  !packageLock ||
  dependencyInventory?.lockfileSha256 !== sha256(packageLock)
) {
  blockers.push(
    'The local technical provenance, dependency-license, notice, asset, or source-closure audit is incomplete.'
  );
}
if (
  provenance?.ownerApproval !== true ||
  provenance?.iconProvenanceApproved !== true ||
  provenance?.thirdPartyNoticesReviewed !== true ||
  provenance?.dependencyLicensesReviewed !== true ||
  provenance?.privateMaterialExclusionReviewed !== true
) {
  blockers.push(
    'The technically complete ownership, dependency, media, notice, and private-material provenance audit is not owner-approved.'
  );
}
blockers.push(...findDependencyCandidateAuditFindings({ inventory: dependencyInventory, version: pkg?.version }));
const browser = await optionalJson('docs/evidence/browser-validation.json');
if (browser?.status !== 'passed' || browser?.reviewerApproval !== true)
  blockers.push('The exact-artifact browser validation record is not reviewer-approved.');
if (browser?.chrome?.status !== 'passed')
  blockers.push('Disposable-profile Chrome integration evidence is incomplete.');
if (browser?.brave?.status !== 'passed')
  blockers.push('A real Brave smoke-test record is incomplete; Brave compatibility cannot be claimed.');
for (const [name, evidence] of [
  ['Chrome', browser?.chrome],
  ['Brave', browser?.brave]
]) {
  if (
    !String(evidence?.version || '').trim() ||
    !String(evidence?.operatingSystem || '').trim() ||
    evidence?.disposableProfile !== true ||
    !Array.isArray(evidence?.assertions) ||
    evidence.assertions.length === 0
  ) {
    blockers.push(`${name} evidence is missing its version, environment, disposable-profile proof, or assertions.`);
  }
}
requireExactArtifactEvidence('Browser evidence', browser?.artifact, runtimeArtifactSha256);
blockers.push(...findBrowserEvidenceFindings({ browser, runtimeArtifactSha256 }));
const performance = await optionalJson('docs/evidence/performance-results.json');
if (
  performance?.status !== 'passed' ||
  performance?.reviewerApproval !== true ||
  !Array.isArray(performance?.fixtures) ||
  performance.fixtures.length === 0 ||
  !performance?.environment ||
  Object.keys(performance.environment).length === 0
) {
  blockers.push('Measured, exact-artifact performance evidence is incomplete or not reviewer-approved.');
}
requireExactArtifactEvidence('Performance evidence', performance?.artifact, runtimeArtifactSha256);
blockers.push(...findPerformanceEvidenceFindings({ performance, runtimeArtifactSha256 }));
const accessibility = await optionalJson('docs/evidence/accessibility-results.json');
if (
  accessibility?.status !== 'passed' ||
  accessibility?.reviewerApproval !== true ||
  !accessibility?.installedChecks ||
  Object.values(accessibility.installedChecks).some((value) => value !== 'passed') ||
  !accessibility?.browserVersions ||
  Object.keys(accessibility.browserVersions).length === 0
) {
  blockers.push('Installed exact-artifact accessibility evidence is incomplete or not reviewer-approved.');
}
requireExactArtifactEvidence('Accessibility evidence', accessibility?.artifact, runtimeArtifactSha256);
blockers.push(
  ...findAccessibilitySourceContractFindings({
    accessibility,
    version: pkg?.version,
    releaseInputFingerprintSha256: versionState?.releaseInputFingerprintSha256
  })
);
const automatedPointer = await resolveCurrentValidationEvidence(root).catch(() => null);
const automated = automatedPointer ? await optionalJson(automatedPointer.relativePath) : null;
if (
  automated?.status !== 'local_automated_checks_passed' ||
  automated?.fullCheck?.status !== 'passed' ||
  automated?.fullCheck?.versionContract?.status !== 'passed' ||
  automated?.fullCheck?.versionContract?.version !== pkg?.version ||
  automated?.fullCheck?.versionContract?.runtimeFiles !== RUNTIME_FILES.length ||
  automated?.fullCheck?.versionContract?.runtimeFingerprintSha256 !== versionState?.runtimeFingerprintSha256 ||
  automated?.coverage?.status !== 'passed' ||
  automated?.dependencyInstall?.status !== 'passed' ||
  automated?.dependencyInstall?.lifecycleScriptsDisabled !== true ||
  automated?.dependencyAudit?.status !== 'passed' ||
  automated?.dependencyAudit?.lockfileSha256 !== (packageLock ? sha256(packageLock) : null) ||
  automated?.dependencyAudit?.knownVulnerabilities !== 0 ||
  automated?.dependencyAudit?.runtimeDependencies !== 0 ||
  automated?.dependencyAudit?.lockedDevelopmentGraph !== dependencyInventory?.lockedDevelopmentGraphCount ||
  automated?.scopeAndPrivacyEvidence?.publicationGateDirectCleanupContract !== 'passed' ||
  automated?.scopeAndPrivacyEvidence?.redactionCanaries !== 'passed' ||
  automated?.scopeAndPrivacyEvidence?.privateContextPersistenceRefusal !== 'passed' ||
  automated?.scopeAndPrivacyEvidence?.deterministicThirtyMinuteExpiry !== 'passed' ||
  automated?.fixtureInfrastructure?.serverContract !== 'passed' ||
  automated?.artifacts?.status !== 'local_reproducible_build_passed' ||
  automated?.artifacts?.sourcePackageEquivalence !== 'exact' ||
  automated?.artifacts?.byteIdenticalAcrossConsecutiveBuilds !== true ||
  automated?.artifacts?.runtimeZip !== expectedRuntimeZip ||
  automated?.artifacts?.runtimeZipSha256 !== runtimeArtifactSha256 ||
  automated?.artifacts?.runtimeFiles !== RUNTIME_FILES.length ||
  automated?.artifacts?.sourceFiles !== verifiedRelease?.sourceFiles ||
  automated?.artifacts?.checksumFilesVerified !== verifiedRelease?.checksumFilesVerified
) {
  blockers.push(
    'Current automated checks, coverage, dependency audit, reproducibility, or package-equivalence evidence is incomplete.'
  );
}
const media = await optionalJson('docs/evidence/media-inventory.json');
if (
  !Number.isInteger(media?.authenticScreenshotCount) ||
  media.authenticScreenshotCount < 4 ||
  media.authenticScreenshotCount > 6
)
  blockers.push('Four to six authentic synthetic-data screenshots are not approved.');
if (!Number.isFinite(media?.demoDurationSeconds) || media.demoDurationSeconds < 60 || media.demoDurationSeconds > 90)
  blockers.push('An authentic 60–90 second demo is not approved.');
if (media?.status !== 'approved' || media?.reviewerApproval !== true)
  blockers.push('Synthetic showcase and store media are not reviewer-approved.');
requireExactArtifactEvidence('Media evidence', media?.artifact, runtimeArtifactSha256);
blockers.push(...(await findMediaEvidenceFindings({ media, root, runtimeArtifactSha256 })));
const remote = await optionalJson('docs/decisions/remote-publication.json');
if (!remote?.ownerApproved || !remote?.repositoryUrl)
  blockers.push('The intended remote and public-source authorization are not recorded.');
if (!remote?.branchProtectionVerified) blockers.push('Required remote branch checks and protection are not verified.');
if (!remote?.requiredChecksVerified) blockers.push('The required remote CI and CodeQL checks are not verified.');
if (!remote?.privateVulnerabilityReportingVerified)
  blockers.push('GitHub private vulnerability reporting is not verified.');
if (!remote?.hostedPrivacyPolicyUrl) blockers.push('A stable hosted privacy-policy URL is not recorded.');
if (!remote?.releaseEnvironmentVerified || remote?.releaseEnvironmentName !== 'unreleased-candidate') {
  blockers.push('The protected unreleased-candidate remote environment is not verified.');
}
if (!remote?.finalPublicationApproval)
  blockers.push(
    'The owner has not given final approval for merge, tag, GitHub Release, browser-store submission, or professional-profile promotion.'
  );
blockers.push(
  ...findRemotePublicationFindings({
    remote,
    version: pkg?.version,
    privacyBytes
  })
);
const directCleanupDecision = await optionalJson('docs/decisions/direct-cleanup-owner-decision.json');
const directCleanupSources = Object.fromEntries(
  await Promise.all(DIRECT_CLEANUP_CONTRACT_FILES.map(async (path) => [path, await optionalText(path)]))
);
const directCleanupContractFindings = findDirectCleanupPublicationContractFindings({
  sources: directCleanupSources,
  decision: directCleanupDecision
});
if (directCleanupContractFindings.length) {
  blockers.push(
    `The owner-approved direct-cleanup publication contract is incomplete (${directCleanupContractFindings.join('; ')}). Direct mode must remain default-off, explicitly confirmed, preflight-bound, single-use, truthfully reported, and unavailable through any raw cleanup route.`
  );
}

const result = {
  state: 'Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.',
  publicationRecommendation: blockers.length ? 'blocked' : 'owner-approved-for-binary-publication',
  blockerCount: blockers.length,
  blockers
};
console.log(JSON.stringify(result, null, 2));
if (blockers.length) process.exit(1);

async function optionalJson(relative) {
  try {
    return JSON.parse(await readFile(resolve(root, relative), 'utf8'));
  } catch {
    return null;
  }
}

async function optionalBytes(relative) {
  try {
    return await readFile(resolve(root, relative));
  } catch {
    return null;
  }
}

async function optionalText(relative) {
  try {
    return await readFile(resolve(root, relative), 'utf8');
  } catch {
    return null;
  }
}

function requireExactArtifactEvidence(label, artifact, actualSha256) {
  if (
    artifact?.version !== pkg?.version ||
    artifact?.runtimeZip !== expectedRuntimeZip ||
    !actualSha256 ||
    artifact?.sha256 !== actualSha256
  ) {
    blockers.push(`${label} is not bound to the exact current runtime artifact bytes.`);
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

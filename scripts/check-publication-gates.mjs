import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyLiveIndependentGitHubReview } from './github-review.mjs';
import { resolveCurrentValidationEvidence } from './validation-evidence.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const blockers = [];
if (!verifyLiveGitPublicationScope()) {
  blockers.push(
    'The live Git worktree, index, approved remote, and reviewed source closure do not form one safe publication scope.'
  );
}
const pkg = await optionalJson('package.json');
const expectedRuntimeZip = `sitewipe-private-rc-${pkg?.version || 'unknown'}.zip`;
const currentRelease = await optionalJson('dist/current/current-release.json');
const runtimeArtifact = await optionalBytes(`dist/current/${expectedRuntimeZip}`);
const runtimeArtifactSha256 = runtimeArtifact ? sha256(runtimeArtifact) : null;
if (!runtimeArtifact) blockers.push('The exact current runtime artifact is missing from dist/current.');
if (
  currentRelease?.version !== pkg?.version ||
  currentRelease?.runtimeArtifact !== expectedRuntimeZip ||
  currentRelease?.artifactBase !== `sitewipe-private-rc-${pkg?.version || 'unknown'}`
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
if (
  provenance?.technicalStatus !== 'passed' ||
  provenance?.technicalEvidence?.sourceClosurePrivatePathScan?.status !== 'passed' ||
  provenance?.technicalEvidence?.gitPublicationClosure?.status !== 'passed' ||
  provenance?.technicalEvidence?.gitPublicationClosure?.trackedMatchesSourceClosure !== true ||
  provenance?.technicalEvidence?.gitPublicationClosure?.approvedRemoteOnly !== true ||
  provenance?.technicalEvidence?.gitPublicationClosure?.outerContainerExcluded !== true ||
  provenance?.technicalEvidence?.gitPublicationClosure?.prohibitedIndexModesRejected !== true ||
  provenance?.technicalEvidence?.runtimePackage?.status !== 'passed' ||
  provenance?.technicalEvidence?.dependencyLicenseInventory?.status !== 'passed' ||
  provenance?.technicalEvidence?.thirdPartyNoticesAndPsl?.status !== 'passed' ||
  provenance?.technicalEvidence?.candidateIcon?.status !== 'passed' ||
  provenance?.technicalEvidence?.sourceArchiveControls?.status !== 'passed' ||
  dependencyInventory?.status !== 'technical_inventory_complete_owner_acknowledged' ||
  dependencyInventory?.ownerApproval !== true ||
  dependencyInventory?.runtimeDependencyCount !== 0 ||
  dependencyInventory?.lockedDevelopmentGraphCount !== 406 ||
  !packageLock ||
  dependencyInventory?.lockfileSha256 !== sha256(packageLock)
) {
  blockers.push(
    'The local technical provenance, dependency-license, notice, asset, or source-closure audit is incomplete.'
  );
}
if (
  provenance?.status !== 'approved' ||
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
const browser = await optionalJson('docs/evidence/browser-validation.json');
if (browser?.status !== 'passed') blockers.push('The exact-artifact browser validation record is incomplete.');
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
const performance = await optionalJson('docs/evidence/performance-results.json');
if (
  performance?.status !== 'passed' ||
  !Array.isArray(performance?.fixtures) ||
  performance.fixtures.length === 0 ||
  !performance?.environment ||
  Object.keys(performance.environment).length === 0
) {
  blockers.push('Measured, exact-artifact performance evidence is incomplete.');
}
requireExactArtifactEvidence('Performance evidence', performance?.artifact, runtimeArtifactSha256);
const accessibility = await optionalJson('docs/evidence/accessibility-results.json');
if (
  accessibility?.status !== 'passed' ||
  !accessibility?.installedChecks ||
  Object.values(accessibility.installedChecks).some((value) => value !== 'passed') ||
  !accessibility?.browserVersions ||
  Object.keys(accessibility.browserVersions).length === 0
) {
  blockers.push('Installed exact-artifact accessibility evidence is incomplete.');
}
requireExactArtifactEvidence('Accessibility evidence', accessibility?.artifact, runtimeArtifactSha256);
const automatedPointer = await resolveCurrentValidationEvidence(root).catch(() => null);
const automated = automatedPointer ? await optionalJson(automatedPointer.relativePath) : null;
if (
  automated?.status !== 'local_automated_checks_passed' ||
  automated?.fullCheck?.status !== 'passed' ||
  automated?.coverage?.status !== 'passed' ||
  automated?.dependencyAudit?.status !== 'passed' ||
  automated?.artifacts?.status !== 'local_reproducible_build_passed' ||
  automated?.artifacts?.sourcePackageEquivalence !== 'exact' ||
  automated?.artifacts?.byteIdenticalAcrossConsecutiveBuilds !== true ||
  automated?.artifacts?.runtimeZip !== expectedRuntimeZip ||
  automated?.artifacts?.runtimeZipSha256 !== runtimeArtifactSha256
) {
  blockers.push(
    'Current automated checks, coverage, dependency audit, reproducibility, or package-equivalence evidence is incomplete.'
  );
}
const media = await optionalJson('docs/evidence/media-inventory.json');
requireExactArtifactEvidence('Media evidence', media?.artifact, runtimeArtifactSha256);
if (
  !Number.isInteger(media?.authenticScreenshotCount) ||
  media.authenticScreenshotCount < 4 ||
  media.authenticScreenshotCount > 6
)
  blockers.push('Four to six authentic synthetic-data screenshots are not approved.');
if (!Number.isFinite(media?.demoDurationSeconds) || media.demoDurationSeconds < 60 || media.demoDurationSeconds > 90)
  blockers.push('An authentic 60–90 second demo is not approved.');
if (media?.status !== 'approved') blockers.push('Synthetic showcase and store media are not approved.');
for (const [label, evidence] of [
  ['Browser', browser],
  ['Performance', performance],
  ['Accessibility', accessibility],
  ['Media', media]
]) {
  if (evidence?.reviewRequirement !== 'current_head_github_approval') {
    blockers.push(`${label} evidence does not require a current-head GitHub approval.`);
  }
}
const remote = await optionalJson('docs/decisions/remote-publication.json');
if (!remote?.ownerApproved || !remote?.repositoryUrl)
  blockers.push('The intended remote and first-publication approval are not recorded.');
if (!remote?.branchProtectionVerified) blockers.push('Required remote branch checks and protection are not verified.');
if (!remote?.requiredChecksVerified) blockers.push('The required remote CI and CodeQL checks are not verified.');
if (!remote?.privateVulnerabilityReportingVerified)
  blockers.push('GitHub private vulnerability reporting is not verified.');
if (!remote?.hostedPrivacyPolicyUrl) blockers.push('A stable hosted privacy-policy URL is not recorded.');
if (!remote?.releaseEnvironmentVerified)
  blockers.push('The manually approved remote release environment is not verified.');
if (!remote?.finalPublicationApproval)
  blockers.push('The owner has not given final approval for the first public push/release/store or portfolio use.');
const independentReview = verifyLiveIndependentGitHubReview({
  repositoryUrl: remote?.repositoryUrl,
  pullRequestNumber: remote?.reviewPullRequestNumber,
  maintainerHandle: remote?.maintainerHandle,
  cwd: root
});
if (!independentReview.verified) {
  blockers.push(
    'A distinct write-capable reviewer has not approved the exact current Git head through the designated GitHub pull request.'
  );
}
const optionsHtml = await readFile(resolve(root, 'src/options/options.html'), 'utf8');
const retiredBypassFindings = await findRetiredBypassSignals(optionsHtml);
if (retiredBypassFindings.length) {
  blockers.push(
    `A retired cleanup-review bypass signal exists in the runtime (${retiredBypassFindings.join(', ')}). Every Standard and Expert cleanup must require detailed per-run review.`
  );
}

const result = {
  state: 'Private release candidate undergoing safety, privacy, accessibility, and release-readiness validation.',
  publicationRecommendation: blockers.length ? 'blocked' : 'owner-approved-for-publication',
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

async function findRetiredBypassSignals(optionsSource) {
  const sources = new Map([
    ['src/options/options.html', optionsSource],
    ['src/popup/popup.js', await readFile(resolve(root, 'src/popup/popup.js'), 'utf8')],
    ['src/shared/cleanup-review.js', await readFile(resolve(root, 'src/shared/cleanup-review.js'), 'utf8')],
    ['src/shared/message-contracts.js', await readFile(resolve(root, 'src/shared/message-contracts.js'), 'utf8')],
    [
      'src/background/cleanup-preflight.js',
      await readFile(resolve(root, 'src/background/cleanup-preflight.js'), 'utf8')
    ],
    ['src/background/service-worker.js', await readFile(resolve(root, 'src/background/service-worker.js'), 'utf8')]
  ]);
  const forbidden = [
    /Skip detailed cleanup review completely/i,
    /runPreparedQuickCleanup|prepareOneClickCleanup|isQuickCleanupSettingActive/,
    /quickCleanupAllowed|quickCleanupBlockedReasons|quickApproval/i,
    /\bapprovalMode\s*(?::|={2,3})\s*['"](?:quick|bypass)['"]/i
  ];
  return [...sources].filter(([, source]) => forbidden.some((pattern) => pattern.test(source))).map(([path]) => path);
}

function verifyLiveGitPublicationScope() {
  try {
    execFileSync(process.execPath, [resolve(root, 'scripts/check-publication-scope.mjs')], {
      cwd: root,
      stdio: 'pipe',
      windowsHide: true
    });
    return true;
  } catch {
    return false;
  }
}

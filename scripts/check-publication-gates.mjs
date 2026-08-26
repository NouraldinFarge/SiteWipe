import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReleaseCandidate } from './release-artifact-verification.mjs';
import { RUNTIME_FILES } from './release-files.mjs';
import {
  computeCommittedBrowserHarnessManifestSha256,
  listCommittedBrowserEvidenceDeltaPaths
} from './browser-validation-policy.mjs';
import { assertGitWorktreeClean, collectCommittedSourceArchiveEntries } from './source-archive.mjs';
import { isMutableReleaseRecord, runtimeArtifactBase } from './versioning.mjs';
import { assertTrustedGitRepository, runTrustedGit } from './trusted-git.mjs';
import {
  DIRECT_CLEANUP_CONTRACT_FILES,
  findDirectCleanupPublicationContractFindings
} from './direct-cleanup-publication-contract.mjs';
import {
  findAccessibilitySourceContractFindings,
  findAutomatedDependencyProtocolFindings,
  findBrowserEvidenceFindings,
  findDependencyCandidateAuditFindings,
  findMediaEvidenceFindings,
  findPerformanceEvidenceFindings,
  findRemotePublicationFindings
} from './publication-evidence-contract.mjs';
import { findRemotePublicationCaptureFindings } from './remote-publication-evidence.mjs';
import { validateRemotePublicationEvidenceBundle } from './collect-remote-publication-evidence.mjs';
import {
  REMOTE_PUBLICATION_EVIDENCE_DIRECTORY_ENVIRONMENT,
  REMOTE_PUBLICATION_EXPECTED_BINDING_ENVIRONMENT,
  readExternalRemotePublicationGateInput,
  resolveExpectedRemotePublicationBinding
} from './remote-publication-gate-input.mjs';
import {
  canonicalEvidenceFinalizationJsonBytes,
  canonicalFinalizedEvidenceRecordJson,
  EVIDENCE_FINALIZATION_MANIFEST_PATH
} from './evidence-finalization-contract.mjs';
import { validatePublicationEvidenceFinalization } from './publication-evidence-finalization.mjs';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const AUTOMATED_EVIDENCE_VERSION_LINEAGE_BLOCKER =
  'The committed automated-validation pointer, filename, and record are not bound to the exact package version.';

export async function checkPublicationGates({
  repositoryRoot = defaultRoot,
  testOnlyAfterReleaseVerification = undefined,
  testOnlyBeforeTerminalSourceReplay = undefined,
  testOnlyValidatePublicationEvidenceFinalization = undefined,
  testOnlyVerifyReleaseCandidate = undefined
} = {}) {
  const root = resolve(repositoryRoot);
  const blockers = [];
  const releaseVerifier = resolveReleaseVerifier(testOnlyVerifyReleaseCandidate);
  const publicationFinalizationValidator = resolvePublicationFinalizationValidator(
    testOnlyValidatePublicationEvidenceFinalization
  );
  let verifiedRelease = null;
  try {
    verifiedRelease = await releaseVerifier({ root });
  } catch (error) {
    blockers.push(`Local version/source/artifact integrity verification failed: ${error?.message || String(error)}`);
  }
  let committedPublicationInputs = null;
  let initialPublicationSource = null;
  if (verifiedRelease) {
    try {
      const committed = await collectCommittedSourceArchiveEntries(root, { ref: verifiedRelease.sourceCommit });
      if (committed.commit !== verifiedRelease.sourceCommit) {
        throw new Error('Verified release source commit changed before publication input capture.');
      }
      if (committed.entries.length !== verifiedRelease.sourceFiles) {
        throw new Error('Verified release source-file count differs from the committed publication input snapshot.');
      }
      committedPublicationInputs = new Map(committed.entries.map((entry) => [entry.path, entry.bytes]));
      initialPublicationSource = await captureExactPublicationSource(root, {
        committedSource: committed,
        expectedCommit: verifiedRelease.sourceCommit
      });
    } catch (error) {
      blockers.push(`Verified publication source capture failed: ${error?.message || String(error)}`);
    }
  }
  await runTestOnlyPublicationGateHook(testOnlyAfterReleaseVerification, 'after-release-verification');
  const pkg = await optionalJson('package.json');
  const privacyBytes = await optionalBytes('PRIVACY.md');
  const versionState = await optionalJson('docs/evidence/version-state.json');
  const expectedArtifactBase = pkg?.version
    ? runtimeArtifactBase(pkg.version)
    : 'sitewipe-unreleased-candidate-unknown';
  const expectedRuntimeZip = `${expectedArtifactBase}.zip`;
  const currentRelease = await optionalDiskJson('dist/current/current-release.json');
  const runtimeArtifact = await optionalDiskBytes(`dist/current/${expectedRuntimeZip}`);
  const runtimeArtifactSha256 = verifiedRelease?.sha256 ?? null;
  if (!runtimeArtifact) blockers.push('The exact current runtime artifact is missing from dist/current.');
  if (!isSha256(runtimeArtifactSha256) || (runtimeArtifact && sha256(runtimeArtifact) !== runtimeArtifactSha256)) {
    blockers.push(
      'The independently re-read runtime ZIP differs from the exact artifact digest verified for publication.'
    );
  }
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
  let browser = await optionalJson('docs/evidence/browser-validation.json');
  let browserSemanticReceipts = await optionalJson('docs/evidence/browser-semantic-receipts.json');
  let performance = await optionalJson('docs/evidence/performance-results.json');
  let accessibility = await optionalJson('docs/evidence/accessibility-results.json');
  let media = await optionalJson('docs/evidence/media-inventory.json');
  let automatedPath;
  try {
    automatedPath = committedValidationEvidencePath(
      await optionalJson('docs/evidence/automated-validation-current.json'),
      pkg?.version
    );
  } catch {
    blockers.push(AUTOMATED_EVIDENCE_VERSION_LINEAGE_BLOCKER);
  }
  const evidenceFinalizationManifest = await optionalJson('docs/evidence/evidence-finalization-manifest.json');
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
  const browserFinalSource = await captureBrowserFinalSource(
    root,
    browser?.installedEvidence?.identity?.sourceCommitSha,
    verifiedRelease?.sourceCommit
  );
  let evidenceFinalizationValidated = false;
  let evidenceFinalizationChangedPaths = null;
  let finalizedMediaEntries = null;
  try {
    const finalization = await publicationFinalizationValidator({
      repositoryRoot: root,
      manifest: evidenceFinalizationManifest,
      changedPaths: browserFinalSource?.changedPaths,
      browser,
      semanticReceipts: browserSemanticReceipts,
      finalSource: browserFinalSource,
      artifactVersion: pkg?.version,
      runtimeArtifactSha256,
      runtimeFingerprintSha256: versionState?.runtimeFingerprintSha256,
      releaseInputFingerprintSha256: versionState?.releaseInputFingerprintSha256
    });
    assertFinalizationManifestMatchesCommittedSource(finalization, evidenceFinalizationManifest);
    assertFinalizationEntriesMatchCommittedSource(finalization.entries, automatedPath);
    assertCommittedFinalizedEvidence(performance, finalization.performance, 'Performance evidence');
    assertCommittedFinalizedEvidence(accessibility, finalization.accessibility, 'Accessibility evidence');
    assertCommittedFinalizedEvidence(media, finalization.media, 'Media evidence');
    evidenceFinalizationValidated = true;
    evidenceFinalizationChangedPaths = finalization.changedPaths;
    browser = finalization.browser;
    browserSemanticReceipts = finalization.semanticReceipts;
    performance = finalization.performance;
    accessibility = finalization.accessibility;
    media = finalization.media;
    finalizedMediaEntries = Object.freeze(finalization.entries.filter((entry) => entry.kind === 'media'));
  } catch {
    blockers.push(
      'The exact post-browser evidence finalization manifest, independently derived identity, changed-path set, or file hashes are missing or invalid.'
    );
  }
  blockers.push(
    ...findBrowserEvidenceFindings({
      browser,
      semanticReceipts: browserSemanticReceipts,
      runtimeArtifactSha256,
      runtimeFingerprintSha256: versionState?.runtimeFingerprintSha256,
      releaseInputFingerprintSha256: versionState?.releaseInputFingerprintSha256,
      finalSource: browserFinalSource
        ? Object.freeze({
            ...browserFinalSource,
            evidenceFinalizationValidated,
            evidenceFinalizationChangedPaths
          })
        : browserFinalSource
    })
  );
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
  const automated = automatedPath ? await optionalJson(automatedPath) : null;
  blockers.push(
    ...findAutomatedDependencyProtocolFindings({
      automated,
      lockedDevelopmentGraph: dependencyInventory?.lockedDevelopmentGraphCount
    })
  );
  if (
    automated &&
    (!optionalAutomatedCandidateVersionsMatch(automated, pkg?.version) ||
      automated.fullCheck?.versionContract?.version !== pkg?.version ||
      automated.fullCheck?.manifest?.version !== pkg?.version)
  ) {
    blockers.push(AUTOMATED_EVIDENCE_VERSION_LINEAGE_BLOCKER);
  }
  if (
    automated?.status !== 'local_automated_checks_passed' ||
    automated?.fullCheck?.status !== 'passed' ||
    automated?.fullCheck?.versionContract?.status !== 'passed' ||
    automated?.fullCheck?.versionContract?.version !== pkg?.version ||
    automated?.fullCheck?.versionContract?.runtimeFiles !== RUNTIME_FILES.length ||
    automated?.fullCheck?.versionContract?.runtimeFingerprintSha256 !== versionState?.runtimeFingerprintSha256 ||
    automated?.coverage?.status !== 'passed' ||
    automated?.dependencyAudit?.lockfileSha256 !== (packageLock ? sha256(packageLock) : null) ||
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
      'Current automated checks, coverage, exact dependency-install/audit protocol, reproducibility, or package-equivalence evidence is incomplete.'
    );
  }
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
  blockers.push(
    ...(await findMediaEvidenceFindings({
      media,
      root,
      artifactVersion: pkg?.version,
      finalizedMediaEntries,
      runtimeArtifactSha256,
      readAssetBytes: readCommittedPublicationAsset
    }))
  );
  const remote = await optionalJson('docs/decisions/remote-publication.json');
  if (!remote?.ownerApproved || !remote?.repositoryUrl)
    blockers.push('The intended remote and public-source authorization are not recorded.');
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
  blockers.push(...(await remotePublicationCaptureFindings(remote)));
  const directCleanupDecision = await optionalJson('docs/decisions/direct-cleanup-owner-decision.json');
  const directCleanupSources = Object.fromEntries(
    await Promise.all(DIRECT_CLEANUP_CONTRACT_FILES.map(async (path) => [path, await optionalText(path)]))
  );
  const directCleanupContractFindings = findDirectCleanupPublicationContractFindings({
    sources: directCleanupSources,
    decision: directCleanupDecision,
    version: pkg?.version
  });
  if (directCleanupContractFindings.length) {
    blockers.push(
      `The owner-approved direct-cleanup publication contract is incomplete (${directCleanupContractFindings.join('; ')}). Direct mode must remain default-off, explicitly confirmed, preflight-bound, single-use, truthfully reported, and unavailable through any raw cleanup route.`
    );
  }

  await runTestOnlyPublicationGateHook(testOnlyBeforeTerminalSourceReplay, 'before-terminal-source-replay');
  try {
    if (!verifiedRelease || !initialPublicationSource) {
      throw new Error('The initial verified release/source identity is unavailable.');
    }
    const terminalVerifiedRelease = await releaseVerifier({ root });
    assertVerifiedReleaseReplay(verifiedRelease, terminalVerifiedRelease);
    const terminalPublicationSource = await captureExactPublicationSource(root, {
      expectedCommit: verifiedRelease.sourceCommit
    });
    assertPublicationSourceReplay(initialPublicationSource, terminalPublicationSource);
  } catch (error) {
    blockers.push(`Terminal publication source/artifact replay failed: ${error?.message || String(error)}`);
  }

  const result = {
    state:
      'Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.',
    publicationRecommendation: blockers.length ? 'blocked' : 'owner-approved-for-binary-publication',
    blockerCount: blockers.length,
    blockers
  };
  return deepFreeze(result);

  async function optionalJson(relative) {
    try {
      const bytes = committedPublicationInputs?.get(relative);
      return bytes ? JSON.parse(bytes.toString('utf8')) : null;
    } catch {
      return null;
    }
  }

  async function optionalBytes(relative) {
    const bytes = committedPublicationInputs?.get(relative);
    return bytes ? Buffer.from(bytes) : null;
  }

  async function optionalText(relative) {
    const bytes = committedPublicationInputs?.get(relative);
    return bytes ? bytes.toString('utf8') : null;
  }

  async function optionalDiskJson(relative) {
    try {
      return JSON.parse(await readFile(resolve(root, relative), 'utf8'));
    } catch {
      return null;
    }
  }

  async function optionalDiskBytes(relative) {
    try {
      return await readFile(resolve(root, relative));
    } catch {
      return null;
    }
  }

  async function readCommittedPublicationAsset(absolute) {
    const relation = relative(root, resolve(absolute));
    if (!relation || relation === '..' || relation.startsWith('..\\') || relation.startsWith('../')) {
      throw new Error('Publication media asset escapes the verified committed source snapshot.');
    }
    const relativePath = relation.split('\\').join('/');
    const bytes = committedPublicationInputs?.get(relativePath);
    if (!bytes) throw new Error(`Publication media asset is absent from verified committed source: ${relativePath}`);
    return Buffer.from(bytes);
  }

  async function captureBrowserFinalSource(repositoryRoot, testedCommitSha, currentCommitSha) {
    if (!isGitObjectId(testedCommitSha) || !isGitObjectId(currentCommitSha)) return null;
    try {
      assertTrustedGitRepository(repositoryRoot);
      const commitSha = currentCommitSha.toLowerCase();
      const treeSha = runTrustedGit({
        root: repositoryRoot,
        args: ['rev-parse', '--verify', `${commitSha}^{tree}`],
        encoding: 'utf8'
      })
        .trim()
        .toLowerCase();
      const testedTreeSha = runTrustedGit({
        root: repositoryRoot,
        args: ['rev-parse', '--verify', `${testedCommitSha}^{tree}`],
        encoding: 'utf8'
      })
        .trim()
        .toLowerCase();
      let testedCommitIsAncestor = true;
      try {
        runTrustedGit({
          root: repositoryRoot,
          args: ['merge-base', '--is-ancestor', testedCommitSha, commitSha],
          encoding: 'utf8'
        });
      } catch {
        testedCommitIsAncestor = false;
      }
      const changedPaths = listCommittedBrowserEvidenceDeltaPaths(repositoryRoot, testedCommitSha, commitSha);
      const committed = await collectCommittedSourceArchiveEntries(repositoryRoot, { ref: testedCommitSha });
      if (committed.commit !== testedCommitSha) throw new Error('Tested source commit changed during publication.');
      const byPath = new Map(committed.entries.map((entry) => [entry.path, entry.bytes]));
      const runtimeHash = createHash('sha256');
      for (const path of RUNTIME_FILES) {
        const bytes = byPath.get(`src/${path}`);
        if (!bytes) throw new Error(`Tested runtime source is missing: ${path}`);
        runtimeHash.update(path, 'utf8');
        runtimeHash.update('\0', 'utf8');
        runtimeHash.update(bytes);
        runtimeHash.update('\0', 'utf8');
      }
      const releaseInputHash = createHash('sha256');
      for (const entry of committed.entries) {
        if (isMutableReleaseRecord(entry.path)) continue;
        releaseInputHash.update(entry.path, 'utf8');
        releaseInputHash.update('\0', 'utf8');
        releaseInputHash.update(entry.bytes);
        releaseInputHash.update('\0', 'utf8');
      }
      const packageLockBytes = byPath.get('package-lock.json');
      if (!packageLockBytes) throw new Error('Tested package-lock.json is missing.');
      return Object.freeze({
        commitSha,
        treeSha,
        testedCommitSha: testedCommitSha.toLowerCase(),
        testedCommitIsAncestor,
        testedTreeSha,
        testedHarnessManifestSha256: computeCommittedBrowserHarnessManifestSha256(repositoryRoot, testedCommitSha),
        testedPackageLockSha256: sha256(packageLockBytes),
        testedRuntimeFingerprintSha256: runtimeHash.digest('hex').toUpperCase(),
        testedReleaseInputFingerprintSha256: releaseInputHash.digest('hex').toUpperCase(),
        changedPaths: Object.freeze(changedPaths)
      });
    } catch {
      return null;
    }
  }

  async function remotePublicationCaptureFindings(remoteDecision) {
    const evidenceDirectory = process.env[REMOTE_PUBLICATION_EVIDENCE_DIRECTORY_ENVIRONMENT];
    const expectedBindingPath = process.env[REMOTE_PUBLICATION_EXPECTED_BINDING_ENVIRONMENT];
    if (!evidenceDirectory || !expectedBindingPath) {
      return findRemotePublicationCaptureFindings({ capture: null });
    }
    try {
      assertTrustedGitRepository(root);
      const relativeEvidenceDirectory = dirnameRelativeToRoot(root, evidenceDirectory);
      const currentHeadSha = verifiedRelease?.sourceCommit?.toLowerCase();
      if (!isGitObjectId(currentHeadSha)) throw new Error('Verified publication source commit is unavailable.');
      const tracked = runTrustedGit({
        root,
        args: ['ls-tree', '-r', '-z', '--name-only', currentHeadSha, '--', relativeEvidenceDirectory],
        encoding: 'utf8'
      });
      if (tracked.length !== 0) throw new Error('Remote capture directory is tracked by the verified source commit.');
      const indexed = runTrustedGit({
        root,
        args: ['ls-files', '-z', '--', relativeEvidenceDirectory],
        encoding: 'utf8'
      });
      if (indexed.length !== 0) throw new Error('Remote capture directory is present in the live Git index.');
      runTrustedGit({ root, args: ['check-ignore', '-q', '--', relativeEvidenceDirectory], encoding: 'utf8' });
      const input = await readExternalRemotePublicationGateInput({
        repositoryRoot: root,
        evidenceDirectory,
        expectedBindingPath
      });
      const expected = resolveExpectedRemotePublicationBinding({
        externalExpected: input.externalExpected,
        remoteDecision,
        version: pkg?.version,
        currentHeadSha,
        privacyBytes
      });
      const now = new Date().toISOString();
      const capture = validateRemotePublicationEvidenceBundle({
        capture: input.capture,
        rawBundle: input.rawBundle,
        expected,
        now
      });
      return findRemotePublicationCaptureFindings({ capture, expected, now });
    } catch {
      return [
        'External exact-head remote-publication capture or its independently bound raw-response bundle is invalid.'
      ];
    }
  }

  function dirnameRelativeToRoot(repositoryRoot, value) {
    const absolute = resolve(value);
    const relation = relative(repositoryRoot, absolute);
    if (!relation || relation === '..' || relation.startsWith('..\\') || relation.startsWith('../')) {
      throw new Error('Remote capture directory is outside the repository-owned ignored evidence root.');
    }
    return relation.split('\\').join('/');
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

  function assertCommittedFinalizedEvidence(committed, replayed, label) {
    const committedJson = canonicalFinalizedEvidenceRecordJson(committed, `${label} committed snapshot`);
    const replayedJson = canonicalFinalizedEvidenceRecordJson(replayed, `${label} final replay`);
    if (committedJson !== replayedJson) {
      throw new Error(`${label} differs between the verified commit and exact final evidence replay.`);
    }
  }

  function assertFinalizationManifestMatchesCommittedSource(finalization, committedManifest) {
    const committedBytes = committedPublicationInputs?.get(EVIDENCE_FINALIZATION_MANIFEST_PATH);
    if (!committedBytes) {
      throw new Error('Evidence finalization manifest is absent from the verified committed source.');
    }
    const committedCanonicalBytes = canonicalEvidenceFinalizationJsonBytes(committedManifest);
    if (!committedBytes.equals(committedCanonicalBytes)) {
      throw new Error('Verified committed evidence finalization manifest bytes are not canonical JSON.');
    }
    if (
      finalization?.manifestSha256 !== sha256(committedBytes) ||
      !canonicalEvidenceFinalizationJsonBytes(finalization?.manifest).equals(committedBytes)
    ) {
      throw new Error('Finalized evidence manifest differs from the exact verified committed bytes.');
    }
  }

  function assertFinalizationEntriesMatchCommittedSource(entries, activeAutomatedPath) {
    if (!Array.isArray(entries) || entries.length === 0) {
      throw new Error('Evidence finalization returned no exact committed entry set.');
    }
    let automatedPointerEntries = 0;
    const datedAutomatedPaths = [];
    for (const entry of entries) {
      const bytes = committedPublicationInputs?.get(entry?.path);
      if (!bytes || entry.bytes !== bytes.length || entry.sha256 !== sha256(bytes)) {
        throw new Error(`Finalized evidence entry differs from verified committed source: ${String(entry?.path)}.`);
      }
      if (
        /^docs\/evidence\/automated-validation-\d{4}-\d{2}-\d{2}-v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.json$/.test(
          entry.path
        )
      ) {
        datedAutomatedPaths.push(entry.path);
      }
      if (entry.path === 'docs/evidence/automated-validation-current.json') automatedPointerEntries += 1;
    }
    if (automatedPointerEntries === 0 && datedAutomatedPaths.length === 0) return;
    if (automatedPointerEntries !== 1 || datedAutomatedPaths.length !== 1) {
      throw new Error(
        'Evidence finalization must contain exactly one committed automated pointer and its one active dated target.'
      );
    }
    if (datedAutomatedPaths[0] !== activeAutomatedPath) {
      throw new Error('Finalized dated automated evidence is not the committed active pointer target.');
    }
  }

  function sha256(value) {
    return createHash('sha256').update(value).digest('hex').toUpperCase();
  }

  function isSha256(value) {
    return /^[A-F0-9]{64}$/.test(String(value || ''));
  }

  function isGitObjectId(value) {
    return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(String(value || ''));
  }

  function committedValidationEvidencePath(pointer, expectedVersion) {
    const version = String(expectedVersion || '');
    if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(version)) {
      throw new Error('Expected automated-validation package version is invalid.');
    }
    const record = String(pointer?.record || '');
    const match =
      /^automated-validation-(\d{4}-\d{2}-\d{2})(?:-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)))?\.json$/.exec(
        record
      );
    if (!match) throw new Error('Committed automated-validation pointer is invalid.');
    const recordVersion = match[2] ?? null;
    const pointerVersion = pointer?.version == null ? null : String(pointer.version);
    if (pointerVersion && !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(pointerVersion)) {
      throw new Error('Committed automated-validation pointer version is invalid.');
    }
    if (pointerVersion !== version) {
      throw new Error('Committed automated-validation pointer version differs from the package version.');
    }
    if (recordVersion && recordVersion !== version) {
      throw new Error('Committed automated-validation record filename differs from the package version.');
    }
    return `docs/evidence/${record}`;
  }

  function optionalAutomatedCandidateVersionsMatch(record, expectedVersion) {
    return ['artifactVersion', 'candidateVersion', 'version'].every(
      (field) => !Object.hasOwn(record, field) || record[field] === expectedVersion
    );
  }

  async function captureExactPublicationSource(repositoryRoot, { committedSource = null, expectedCommit } = {}) {
    if (!isGitObjectId(expectedCommit)) throw new Error('Expected publication source commit is invalid.');
    assertTrustedGitRepository(repositoryRoot);
    const commitBefore = assertGitWorktreeClean(repositoryRoot, { expectedCommit }).toLowerCase();
    const treeBefore = resolveCommitTree(repositoryRoot, commitBefore);
    const source =
      committedSource ?? (await collectCommittedSourceArchiveEntries(repositoryRoot, { ref: commitBefore }));
    if (source.commit !== commitBefore) throw new Error('Committed publication source changed during replay.');
    const sourceSha256 = sourceArchiveSha256(source.entries);
    const commitAfter = assertGitWorktreeClean(repositoryRoot, { expectedCommit }).toLowerCase();
    const treeAfter = resolveCommitTree(repositoryRoot, commitAfter);
    if (commitAfter !== commitBefore || treeAfter !== treeBefore) {
      throw new Error('Publication HEAD or tree changed during exact source capture.');
    }
    return Object.freeze({
      commitSha: commitBefore,
      sourceFileCount: source.entries.length,
      sourceSha256,
      treeSha: treeBefore
    });
  }

  function resolveCommitTree(repositoryRoot, commitSha) {
    const treeSha = runTrustedGit({
      root: repositoryRoot,
      args: ['rev-parse', '--verify', `${commitSha}^{tree}`],
      encoding: 'utf8'
    })
      .trim()
      .toLowerCase();
    if (!isGitObjectId(treeSha)) throw new Error('Git returned an invalid publication source tree identity.');
    return treeSha;
  }

  function sourceArchiveSha256(entries) {
    const hash = createHash('sha256');
    for (const entry of entries) {
      hash.update(entry.path, 'utf8');
      hash.update('\0', 'utf8');
      hash.update(entry.bytes);
      hash.update('\0', 'utf8');
    }
    return hash.digest('hex').toUpperCase();
  }

  function assertVerifiedReleaseReplay(initial, terminal) {
    for (const key of ['sourceCommit', 'sha256', 'sourceFiles', 'checksumFilesVerified']) {
      if (terminal?.[key] !== initial?.[key]) {
        throw new Error(`Verified release ${key} changed during publication evaluation.`);
      }
    }
  }

  function assertPublicationSourceReplay(initial, terminal) {
    for (const key of ['commitSha', 'treeSha', 'sourceFileCount', 'sourceSha256']) {
      if (terminal?.[key] !== initial?.[key]) {
        throw new Error(`Publication source ${key} changed during terminal replay.`);
      }
    }
  }

  function resolveReleaseVerifier(testOnlyVerifier) {
    if (testOnlyVerifier === undefined) return verifyReleaseCandidate;
    assertTestOnlyPublicationGateCapability(testOnlyVerifier, 'release verifier');
    return testOnlyVerifier;
  }

  function resolvePublicationFinalizationValidator(testOnlyValidator) {
    if (testOnlyValidator === undefined) return validatePublicationEvidenceFinalization;
    assertTestOnlyPublicationGateCapability(testOnlyValidator, 'finalization validator');
    return testOnlyValidator;
  }

  async function runTestOnlyPublicationGateHook(callback, phase) {
    if (callback === undefined) return;
    assertTestOnlyPublicationGateCapability(callback, 'mutation hook');
    await callback(phase);
  }

  function assertTestOnlyPublicationGateCapability(callback, label) {
    if (
      typeof callback !== 'function' ||
      typeof process.env.NODE_TEST_CONTEXT !== 'string' ||
      !process.env.NODE_TEST_CONTEXT
    ) {
      throw new Error(`The publication-gate test-only ${label} is available only to the Node test runner.`);
    }
  }

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
    return value;
  }
}

if (import.meta.main) {
  const result = await checkPublicationGates();
  console.log(JSON.stringify(result, null, 2));
  if (result.blockerCount) process.exit(1);
}

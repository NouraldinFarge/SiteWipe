export function resetAutomatedValidationEvidence(automated, { version, artifactBase, runtimeFileCount, releaseState }) {
  return {
    schemaVersion: automated?.schemaVersion || 1,
    status: 'version_bumped_pending_validation',
    validatedAt: null,
    releaseState,
    environment: {},
    baseline: automated?.baseline || null,
    fullCheck: {
      command: automated?.fullCheck?.command || 'npm run check',
      status: 'pending',
      versionContract: {
        status: 'pending',
        version,
        runtimeFiles: runtimeFileCount,
        runtimeFingerprintSha256: null
      },
      manifest: {
        status: 'pending',
        version
      }
    },
    coverage: {
      command: automated?.coverage?.command || 'npm run test:coverage',
      status: 'pending',
      enforcedMinimums: automated?.coverage?.enforcedMinimums || {
        statements: 80,
        branches: 55,
        functions: 70,
        lines: 80
      }
    },
    dependencyInstall: {
      command: automated?.dependencyInstall?.command || 'npm ci --ignore-scripts',
      status: 'pending',
      installedPackages: null,
      auditedPackagesIncludingRoot: null,
      lifecycleScriptsDisabled: null,
      deprecationWarnings: []
    },
    dependencyAudit: {
      command: automated?.dependencyAudit?.command || 'npm audit --audit-level=moderate --json',
      status: 'pending',
      auditedAt: null,
      knownVulnerabilities: null,
      runtimeDependencies: null,
      lockedDevelopmentGraph: null,
      lockfileSha256: null
    },
    scopeAndPrivacyEvidence: {
      pslLedger: automated?.scopeAndPrivacyEvidence?.pslLedger || null,
      policyLedger: automated?.scopeAndPrivacyEvidence?.policyLedger || null,
      directCleanupDecision: 'docs/decisions/direct-cleanup-owner-decision.json',
      historicalBypassApprovalStatus: 'not_applicable_retired',
      publicationGateDirectCleanupContract: 'pending',
      redactionCanaries: 'pending',
      privateContextPersistenceRefusal: 'pending',
      deterministicThirtyMinuteExpiry: 'pending'
    },
    fixtureInfrastructure: {
      version: automated?.fixtureInfrastructure?.version || 'sitewipe-synthetic-v1',
      serverContract: 'pending',
      installedChromeRun: 'pending',
      installedBraveRun: 'pending'
    },
    gitInitialization: {
      status: 'pending_exact_candidate_validation',
      branch: null,
      commitCount: null,
      remoteCount: null,
      tagCount: null,
      parentContainerIsGitRepository: null,
      ignoredLocalDirectoriesVerified: [],
      note: 'Exact candidate commit, clean checkout, remote checks, and repository state require fresh validation.'
    },
    artifacts: {
      status: 'pending_rebuild',
      runtimeZip: `${artifactBase}.zip`,
      runtimeZipSha256: null,
      runtimeZipBytes: null,
      runtimeFiles: runtimeFileCount,
      sourceZip: `${artifactBase}-source.zip`,
      sourceZipSha256: null,
      sourceFiles: null,
      sourcePackageEquivalence: 'pending',
      checksumFilesVerified: 0,
      consecutiveBuildOutputsCompared: 0,
      byteIdenticalAcrossConsecutiveBuilds: false,
      runtimeSbom: `${artifactBase}.runtime-sbom.cdx.json`,
      unsignedProvenanceInput: `${artifactBase}.unsigned-provenance-input.json`,
      remoteAttestation: 'pending',
      sourceArchiveCompression: 'stored',
      sourceArchiveCrossPlatformExactByteContract: 'designed_not_two_host_validated',
      runtimeArchiveCrossPlatformSha256Claim: 'not_claimed_without_two_host_evidence'
    },
    publicationGate: {
      command: automated?.publicationGate?.command || 'npm run check:publication-gates',
      publicationRecommendation: 'not_evaluated',
      blockerCount: null,
      originalBlockerCount: null,
      closedOriginalBlockers: [],
      remainingClasses: ['Fresh validation and exact-artifact review are required for this version.']
    },
    limitations: [
      'No automated, installed-browser, performance, accessibility, media, or remote result is inherited across a version transaction.',
      'Automated tests do not prove complete erasure or installed-browser behavior.'
    ]
  };
}

export function resetProvenanceTechnicalEvidence(provenance, { runtimeFileCount }) {
  return {
    ...provenance,
    status: 'owner_approved_technical_revalidation_pending',
    technicalStatus: 'pending_validation',
    technicalValidatedAt: null,
    technicalEvidence: {
      sourceClosurePrivatePathScan: {
        status: 'pending',
        repositoryFiles: null
      },
      runtimePackage: {
        status: 'pending',
        runtimeFiles: runtimeFileCount,
        npmRuntimeDependencies: null
      },
      dependencyLicenseInventory: {
        status: 'pending',
        lockedDevelopmentPackages: null,
        legacyMetadataExceptionsResolved: null,
        developmentSbomGeneration: 'pending'
      },
      thirdPartyNoticesAndPsl: {
        status: 'pending',
        components: []
      },
      candidateIcon: {
        status: 'pending',
        editableSource: provenance?.technicalEvidence?.candidateIcon?.editableSource || 'assets/brand/icon-source.svg',
        generatedPngsVerified: null,
        externalAssets: null
      },
      sourceArchiveControls: {
        status: 'pending',
        rejectsPrivateMaterialPatterns: null,
        rejectsSymbolicLinksAndDirectoryJunctions: null,
        exactSourceClosureRequired: null
      }
    },
    notes: [
      'The owner confirmation and first-party rights decision remain recorded.',
      'Every technical provenance result was reset by the version transaction and must be regenerated for the current source closure before publication.'
    ]
  };
}

export function resetAccessibilityEvidence(accessibility, { version, artifactBase }) {
  return {
    ...accessibility,
    status: 'pending_installed_validation',
    reviewedAt: null,
    sourceContracts: {
      status: 'pending',
      reviewedAt: null,
      binding: {
        version,
        releaseInputFingerprintSha256: null
      },
      namedTests: null,
      coverage: []
    },
    installedChecks: Object.fromEntries(
      Object.keys(accessibility?.installedChecks || {}).map((key) => [key, 'pending'])
    ),
    browserVersions: {},
    artifact: { version, runtimeZip: `${artifactBase}.zip`, sha256: null },
    reviewerApproval: false
  };
}

export function resetDependencyLicenseInventoryEvidence(inventory, { version, currentLockfileSha256 }) {
  const priorSbom = inventory?.developmentSbom || {};
  return {
    ...inventory,
    status: 'pending_current_candidate_audit',
    candidateVersion: version,
    inventoriedAt: null,
    lastAuditAt: null,
    lockfileSha256: currentLockfileSha256,
    npmAuditVulnerabilities: {
      info: null,
      low: null,
      moderate: null,
      high: null,
      critical: null,
      total: null
    },
    developmentSbom: {
      status: 'pending',
      path: priorSbom.path || 'dist/sitewipe-development-sbom.cdx.json',
      bomFormat: priorSbom.bomFormat || 'CycloneDX',
      specVersion: priorSbom.specVersion || '1.6',
      componentVersion: version,
      components: null,
      dependencyNodes: null,
      bytes: null,
      sha256: null,
      generatedAt: null
    }
  };
}

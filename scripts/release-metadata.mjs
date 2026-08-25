export const RELEASE_CANDIDATE_STATE =
  'Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.';

export function createSourcePackageEquivalence({
  base,
  runtimeArtifactSha256,
  sourceCommit,
  runtimeEntries,
  packagedFileCount,
  manifestAtZipRoot
}) {
  return {
    schema: 'sitewipe.source-package-equivalence.v1',
    state: RELEASE_CANDIDATE_STATE,
    artifact: `${base}.zip`,
    artifactSha256: runtimeArtifactSha256,
    manifestAtZipRoot,
    expectedFileCount: runtimeEntries.length,
    packagedFileCount,
    exactPathParity: true,
    exactByteParity: true,
    fixedZipTimestamp: '1980-01-01T00:00:00.000Z',
    sourceArchiveCompression: 'stored',
    sourceCommit,
    files: runtimeEntries.map(({ path, size, sha256 }) => ({ path, size, sha256 }))
  };
}

export function parsePublicSuffixMetadata(sourceBytes) {
  const source = Buffer.from(sourceBytes || []).toString('utf8');
  const match = source.match(/export const PUBLIC_SUFFIX_METADATA = Object\.freeze\((\{[\s\S]*?\})\);/);
  if (!match) throw new Error('Committed public-suffix metadata record is missing or malformed.');
  const metadata = JSON.parse(match[1]);
  if (
    metadata.source !== 'https://publicsuffix.org/list/public_suffix_list.dat' ||
    typeof metadata.version !== 'string' ||
    !metadata.version ||
    !/^[A-F0-9]{64}$/.test(metadata.sha256 || '') ||
    metadata.license !== 'MPL-2.0' ||
    !Number.isInteger(metadata.bytes) ||
    metadata.bytes <= 0
  ) {
    throw new Error('Committed public-suffix metadata fields are incomplete or invalid.');
  }
  return Object.freeze({
    source: metadata.source,
    version: metadata.version,
    sha256: metadata.sha256,
    license: metadata.license
  });
}

export function createRuntimeSbom({ name, version, publicSuffixMetadata }) {
  const psl = publicSuffixMetadata;
  if (
    !psl ||
    psl.source !== 'https://publicsuffix.org/list/public_suffix_list.dat' ||
    typeof psl.version !== 'string' ||
    !/^[A-F0-9]{64}$/.test(psl.sha256 || '') ||
    psl.license !== 'MPL-2.0'
  ) {
    throw new Error('Runtime SBOM requires exact committed public-suffix metadata.');
  }
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: {
        type: 'application',
        name,
        version,
        properties: [
          { name: 'sitewipe:release-state', value: 'unreleased-candidate' },
          { name: 'sitewipe:runtime-dependencies', value: '0' }
        ]
      }
    },
    components: [
      {
        type: 'data',
        name: 'Public Suffix List snapshot',
        version: psl.version,
        licenses: [{ license: { id: psl.license } }],
        hashes: [
          {
            alg: 'SHA-256',
            content: psl.sha256
          }
        ],
        externalReferences: [
          {
            type: 'distribution',
            url: psl.source
          }
        ],
        properties: [
          {
            name: 'sitewipe:purpose',
            value: 'Registrable-domain and private-tenant boundary data'
          }
        ]
      }
    ]
  };
}

export function createReleaseNotes({ name, version }) {
  return `# ${name} ${version} unreleased candidate\n\nStatus: **${RELEASE_CANDIDATE_STATE}**\n\nThis exact version is a reviewable public-source candidate; exact-version and artifact approvals are recorded separately. The artifact is for disposable-profile validation only. Public source availability does not make it a supported binary, approve a browser-store submission, or authorize portfolio promotion. Installed-browser evidence, authentic media, exact-head remote CI, repository controls, and all applicable stage-specific gates must pass before those claims or actions.\n\nThe owner selected MIT for SiteWipe's first-party source. Third-party material remains governed by its identified terms and notices.\n\nThe loadable ZIP places \`manifest.json\` at its root and contains only the explicit runtime allowlist. Verify it with \`npm run verify:release-candidate\`.\n`;
}

export function createUnsignedProvenance({
  base,
  runtimeArtifactSha256,
  version,
  sourceCommit,
  runtimeEntries,
  nodeVersion,
  platform,
  architecture,
  gitVersion,
  gitExecutableSha256
}) {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: `${base}.zip`, digest: { sha256: runtimeArtifactSha256 } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'urn:sitewipe:build-type:local-unreleased-candidate:v1',
        externalParameters: {
          version,
          runtimeAllowlist: 'scripts/release-files.mjs',
          sourceCommit
        },
        internalParameters: {
          node: nodeVersion,
          platform,
          architecture,
          gitVersion,
          gitExecutableSha256
        },
        resolvedDependencies: runtimeEntries.map((entry) => ({
          uri: `file:src/${entry.path}`,
          digest: { sha256: entry.sha256 }
        }))
      },
      runDetails: {
        builder: { id: 'local-unattested-build' },
        metadata: {
          invocationId: 'not-attested',
          startedOn: null,
          finishedOn: null
        }
      }
    },
    warning:
      'Unsigned local provenance input only. This is not a GitHub artifact attestation and must not be represented as one.'
  };
}

export function createCurrentReleaseIndex({ base, version, sourceCommit, outputs }) {
  return {
    schema: 'sitewipe.current-unreleased-candidate.v1',
    state: RELEASE_CANDIDATE_STATE,
    version,
    sourceCommit,
    artifactBase: base,
    runtimeArtifact: `${base}.zip`,
    sourceArtifact: `${base}-source.zip`,
    checksumFile: 'SHA256SUMS',
    outputs
  };
}

export function serializeReleaseJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

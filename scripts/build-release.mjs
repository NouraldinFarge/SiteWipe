import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import yazl from 'yazl';
import { RUNTIME_FILES } from './release-files.mjs';
import { collectSourceArchiveEntries } from './source-archive.mjs';
import { resolveCurrentValidationEvidence } from './validation-evidence.mjs';
import { readZipEntries } from './zip-utils.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'src');
const distRoot = resolve(root, 'dist');
const dist = resolve(distRoot, '.current-staging');
const currentDist = resolve(distRoot, 'current');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(resolve(src, 'manifest.json'), 'utf8'));
if (pkg.version !== manifest.version) throw new Error('Version parity failed before packaging.');

for (const validator of [
  'validate-manifest.mjs',
  'validate-package-allowlist.mjs',
  'check-remote-code.mjs',
  'check-publication-scope.mjs',
  'check-secrets.mjs',
  'check-project-license.mjs',
  'check-notices.mjs',
  'check-assets.mjs',
  'check-docs.mjs',
  'check-action-pins.mjs',
  'check-version.mjs'
]) {
  execFileSync(process.execPath, [resolve(root, 'scripts', validator)], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true
  });
}

await prepareBuildDirectory(dist);
const base = `sitewipe-private-rc-${manifest.version}`;
const zipPath = resolve(dist, `${base}.zip`);
const fixedTime = new Date('1980-01-01T00:00:00.000Z');
const sourceEntries = [];

for (const relative of RUNTIME_FILES) {
  const absolute = resolve(src, relative);
  const info = await stat(absolute);
  if (!info.isFile() || info.size <= 0) throw new Error(`Runtime file is missing or empty: ${relative}`);
  const bytes = await readFile(absolute);
  sourceEntries.push({
    path: relative,
    bytes,
    sha256: sha256(bytes),
    size: bytes.length
  });
}

await writeZip(zipPath, sourceEntries, fixedTime);
const zipEntries = (await readZipEntries(zipPath)).sort((a, b) => a.path.localeCompare(b.path));
assertEquivalent(sourceEntries, zipEntries);

const zipBytes = await readFile(zipPath);
const zipDigest = sha256(zipBytes);
await updateAutomatedArtifactEvidence({
  runtimeZip: `${base}.zip`,
  runtimeZipSha256: zipDigest,
  runtimeZipBytes: zipBytes.length,
  sourceZip: `${base}-source.zip`
});
execFileSync(
  process.execPath,
  [resolve(root, 'scripts', 'check-version.mjs'), '--require-artifact', '--artifact-dir', dist],
  {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true
  }
);

let sourceArchiveEntries = await collectSourceArchiveEntries(root);
if (await updateSourceArtifactEvidence(sourceArchiveEntries.length)) {
  sourceArchiveEntries = await collectSourceArchiveEntries(root);
}
const sourceArchivePath = resolve(dist, `${base}-source.zip`);
await writeZip(sourceArchivePath, sourceArchiveEntries, fixedTime);
const sourceArchiveZipEntries = (await readZipEntries(sourceArchivePath)).sort((a, b) => a.path.localeCompare(b.path));
assertEquivalent(sourceArchiveEntries, sourceArchiveZipEntries, { requireRootManifest: false });
const sourceArchiveBytes = await readFile(sourceArchivePath);
const sourceArchiveDigest = sha256(sourceArchiveBytes);
const equivalence = {
  schema: 'sitewipe.source-package-equivalence.v1',
  state: 'Private release candidate undergoing safety, privacy, accessibility, and release-readiness validation.',
  artifact: `${base}.zip`,
  artifactSha256: zipDigest,
  manifestAtZipRoot: zipEntries.some((entry) => entry.path === 'manifest.json'),
  expectedFileCount: RUNTIME_FILES.length,
  packagedFileCount: zipEntries.length,
  exactPathParity: true,
  exactByteParity: true,
  fixedZipTimestamp: fixedTime.toISOString(),
  files: sourceEntries.map(({ path, size, sha256: digest }) => ({
    path,
    size,
    sha256: digest
  }))
};
const equivalencePath = resolve(dist, `${base}.source-package-equivalence.json`);
await writeFile(equivalencePath, `${JSON.stringify(equivalence, null, 2)}\n`, 'utf8');

const sbom = {
  bomFormat: 'CycloneDX',
  specVersion: '1.6',
  version: 1,
  metadata: {
    component: {
      type: 'application',
      name: manifest.name,
      version: manifest.version,
      properties: [
        { name: 'sitewipe:release-state', value: 'private-release-candidate' },
        { name: 'sitewipe:runtime-dependencies', value: '0' }
      ]
    }
  },
  components: [
    {
      type: 'data',
      name: 'Public Suffix List snapshot',
      version: '2026-08-14_20-15-49_UTC',
      licenses: [{ license: { id: 'MPL-2.0' } }],
      hashes: [
        {
          alg: 'SHA-256',
          content: '155B43D46932E933F622365225E7861288C36A45380B1F7D00B3D09748926226'
        }
      ],
      externalReferences: [
        {
          type: 'distribution',
          url: 'https://publicsuffix.org/list/public_suffix_list.dat'
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
const sbomPath = resolve(dist, `${base}.runtime-sbom.cdx.json`);
await writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');

const releaseNotesPath = resolve(dist, `${base}.release-notes.md`);
await writeFile(
  releaseNotesPath,
  `# ${manifest.name} ${manifest.version} private release candidate\n\nStatus: **Private release candidate undergoing safety, privacy, accessibility, and release-readiness validation.**\n\nThis artifact is for disposable-profile validation only. It is not approved for publication, a public release, a portfolio, or the Chrome Web Store. Exact public-version approval, installed-browser evidence, authentic media, remote CI and repository controls, and final publication approval remain gates.\n\nThe owner selected MIT for SiteWipe's first-party source. Third-party material remains governed by its identified terms and notices.\n\nThe loadable ZIP places \`manifest.json\` at its root and contains only the explicit runtime allowlist. Verify it with \`npm run verify:release-candidate\`.\n`,
  'utf8'
);

const provenancePath = resolve(dist, `${base}.unsigned-provenance-input.json`);
await writeFile(
  provenancePath,
  `${JSON.stringify(
    {
      _type: 'https://in-toto.io/Statement/v1',
      subject: [{ name: `${base}.zip`, digest: { sha256: zipDigest } }],
      predicateType: 'https://slsa.dev/provenance/v1',
      predicate: {
        buildDefinition: {
          buildType: 'urn:sitewipe:build-type:local-private-release-candidate:v1',
          externalParameters: {
            version: manifest.version,
            runtimeAllowlist: 'scripts/release-files.mjs'
          },
          internalParameters: {
            node: process.version,
            platform: os.platform(),
            architecture: os.arch()
          },
          resolvedDependencies: sourceEntries.map((entry) => ({
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
    },
    null,
    2
  )}\n`,
  'utf8'
);

const checksumTargets = [zipPath, sourceArchivePath, equivalencePath, sbomPath, releaseNotesPath, provenancePath];
const indexedOutputs = [];
for (const path of checksumTargets) {
  const bytes = await readFile(path);
  indexedOutputs.push({
    name: path.split(/[\\/]/).at(-1),
    sha256: sha256(bytes),
    bytes: bytes.length
  });
}
const currentReleasePath = resolve(dist, 'current-release.json');
await writeFile(
  currentReleasePath,
  `${JSON.stringify(
    {
      schema: 'sitewipe.current-private-release-candidate.v1',
      state: 'Private release candidate undergoing safety, privacy, accessibility, and release-readiness validation.',
      version: manifest.version,
      artifactBase: base,
      runtimeArtifact: `${base}.zip`,
      sourceArtifact: `${base}-source.zip`,
      checksumFile: 'SHA256SUMS',
      outputs: indexedOutputs
    },
    null,
    2
  )}\n`,
  'utf8'
);
checksumTargets.push(currentReleasePath);
const checksumLines = [];
for (const path of checksumTargets) {
  checksumLines.push(`${sha256(await readFile(path))}  ${path.split(/[\\/]/).at(-1)}`);
}
await writeFile(resolve(dist, 'SHA256SUMS'), `${checksumLines.join('\n')}\n`, 'utf8');
await promoteCurrentRelease();

console.log(
  JSON.stringify(
    {
      status: 'private-release-candidate',
      artifact: resolve(currentDist, `${base}.zip`),
      bytes: zipBytes.length,
      sha256: zipDigest,
      files: zipEntries.length,
      sourceArtifact: resolve(currentDist, `${base}-source.zip`),
      sourceBytes: sourceArchiveBytes.length,
      sourceSha256: sourceArchiveDigest,
      sourceFiles: sourceArchiveEntries.length,
      sourcePackageEquivalence: 'exact',
      currentReleaseDirectory: currentDist,
      outputs: checksumTargets.map((path) => path.split(/[\\/]/).at(-1)).concat('SHA256SUMS')
    },
    null,
    2
  )
);

async function prepareBuildDirectory(path) {
  assertGeneratedReleaseDirectory(path);
  await rm(path, { recursive: true, force: true });
  await mkdir(path, { recursive: true });
}

async function promoteCurrentRelease() {
  const previous = resolve(distRoot, '.current-previous');
  for (const path of [dist, currentDist, previous]) assertGeneratedReleaseDirectory(path);
  await rm(previous, { recursive: true, force: true });
  const hadCurrent = await pathExists(currentDist);
  if (hadCurrent) await rename(currentDist, previous);
  try {
    await rename(dist, currentDist);
  } catch (error) {
    if (hadCurrent && (await pathExists(previous))) await rename(previous, currentDist);
    throw new Error('Could not promote the staged current release directory.', { cause: error });
  }
  await rm(previous, { recursive: true, force: true });
}

function assertGeneratedReleaseDirectory(path) {
  const allowed = new Set(['.current-staging', '.current-previous', 'current']);
  if (resolve(dirname(path)) !== distRoot || !allowed.has(path.split(/[\\/]/).at(-1))) {
    throw new Error(`Refusing generated release-directory operation outside dist: ${path}`);
  }
}

async function pathExists(path) {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function writeZip(path, entries, mtime) {
  return new Promise((resolvePromise, reject) => {
    const zip = new yazl.ZipFile();
    const output = createWriteStream(path);
    output.on('close', resolvePromise);
    output.on('error', reject);
    zip.outputStream.on('error', reject);
    zip.outputStream.pipe(output);
    for (const entry of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
      zip.addBuffer(entry.bytes, entry.path, {
        mtime,
        mode: 0o100644,
        compress: true
      });
    }
    zip.end();
  });
}

function assertEquivalent(sourceFiles, packagedFiles, options = {}) {
  const expected = [...sourceFiles].sort((a, b) => a.path.localeCompare(b.path));
  if (expected.length !== packagedFiles.length)
    throw new Error(`ZIP file count mismatch: ${packagedFiles.length}/${expected.length}`);
  for (let index = 0; index < expected.length; index += 1) {
    const sourceFile = expected[index];
    const packagedFile = packagedFiles[index];
    if (sourceFile.path !== packagedFile.path)
      throw new Error(`ZIP path mismatch: ${packagedFile.path} != ${sourceFile.path}`);
    if (!sourceFile.bytes.equals(packagedFile.bytes)) throw new Error(`ZIP byte mismatch: ${sourceFile.path}`);
  }
  if (
    options.requireRootManifest !== false &&
    (packagedFiles[0]?.path === '' || !packagedFiles.some((entry) => entry.path === 'manifest.json'))
  )
    throw new Error('manifest.json is not at the ZIP root.');
}

async function updateAutomatedArtifactEvidence({ runtimeZip, runtimeZipSha256, runtimeZipBytes, sourceZip }) {
  const automatedPath = (await resolveCurrentValidationEvidence(root)).relativePath;
  const automated = await readJson(automatedPath);
  automated.artifacts = {
    ...automated.artifacts,
    runtimeZip,
    runtimeZipSha256,
    runtimeZipBytes,
    runtimeFiles: RUNTIME_FILES.length,
    sourceZip
  };
  await writeJson(automatedPath, automated);
}

async function updateSourceArtifactEvidence(sourceFiles) {
  const path = (await resolveCurrentValidationEvidence(root)).relativePath;
  const automated = await readJson(path);
  if (automated.artifacts?.sourceFiles === sourceFiles) return false;
  automated.artifacts = { ...automated.artifacts, sourceFiles };
  await writeJson(path, automated);
  return true;
}

async function readJson(relativePath) {
  return JSON.parse(await readFile(resolve(root, relativePath), 'utf8'));
}

async function writeJson(relativePath, value) {
  await writeFile(resolve(root, relativePath), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

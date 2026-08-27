import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import yazl from 'yazl';
import { RUNTIME_FILES } from './release-files.mjs';
import {
  assertGeneratedReleaseChild,
  createGeneratedReleaseChild,
  ensureGeneratedReleaseRoot,
  removeGeneratedReleaseChild
} from './generated-release-root.mjs';
import {
  createCurrentReleaseIndex,
  createReleaseNotes,
  createRuntimeSbom,
  createSourcePackageEquivalence,
  createUnsignedProvenance,
  parsePublicSuffixMetadata,
  serializeReleaseJson
} from './release-metadata.mjs';
import {
  assertGitWorktreeClean,
  collectCommittedSourceArchiveEntries,
  selectCommittedRuntimeEntries
} from './source-archive.mjs';
import { resolveTrustedGitExecutable } from './trusted-git.mjs';
import { runtimeArtifactBase } from './versioning.mjs';
import { readZipEntries } from './zip-utils.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = resolve(root, 'dist');
const dist = resolve(distRoot, '.current-staging');
const currentDist = resolve(distRoot, 'current');
const trustedGit = resolveTrustedGitExecutable({ root });
const sourceCommit = assertGitWorktreeClean(root);

for (const validator of [
  'validate-manifest.mjs',
  'validate-package-allowlist.mjs',
  'check-remote-code.mjs',
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
assertGitWorktreeClean(root, { expectedCommit: sourceCommit });
const committedSource = await collectCommittedSourceArchiveEntries(root, { ref: sourceCommit });
if (committedSource.commit !== sourceCommit)
  throw new Error('Committed source snapshot changed during release construction.');
const sourceArchiveEntries = committedSource.entries;
const committedSourceByPath = new Map(sourceArchiveEntries.map((entry) => [entry.path, entry]));
const pkg = parseCommittedJson(committedSourceByPath, 'package.json');
const manifest = parseCommittedJson(committedSourceByPath, 'src/manifest.json');
if (pkg.version !== manifest.version) throw new Error('Version parity failed before packaging.');
const publicSuffixMetadata = parsePublicSuffixMetadata(
  committedSourceByPath.get('src/shared/public-suffix-data.js')?.bytes
);

await ensureGeneratedReleaseRoot(distRoot);
await prepareBuildDirectory();
const base = runtimeArtifactBase(manifest.version);
const zipPath = resolve(dist, `${base}.zip`);
const fixedTime = new Date('1980-01-01T00:00:00.000Z');
const sourceEntries = selectCommittedRuntimeEntries(sourceArchiveEntries, RUNTIME_FILES);

await writeZip(zipPath, sourceEntries, fixedTime);
const zipEntries = (await readZipEntries(zipPath)).sort((a, b) => a.path.localeCompare(b.path));
assertEquivalent(sourceEntries, zipEntries);

const zipBytes = await readFile(zipPath);
const zipDigest = sha256(zipBytes);
const sourceArchivePath = resolve(dist, `${base}-source.zip`);
await writeZip(sourceArchivePath, sourceArchiveEntries, fixedTime, { compress: false });
const sourceArchiveZipEntries = (await readZipEntries(sourceArchivePath)).sort((a, b) => a.path.localeCompare(b.path));
assertEquivalent(sourceArchiveEntries, sourceArchiveZipEntries, { requireRootManifest: false });
assertStored(sourceArchiveZipEntries);
const sourceArchiveBytes = await readFile(sourceArchivePath);
const sourceArchiveDigest = sha256(sourceArchiveBytes);
const equivalence = createSourcePackageEquivalence({
  base,
  runtimeArtifactSha256: zipDigest,
  sourceCommit,
  runtimeEntries: sourceEntries,
  packagedFileCount: zipEntries.length,
  manifestAtZipRoot: zipEntries.some((entry) => entry.path === 'manifest.json')
});
const equivalencePath = resolve(dist, `${base}.source-package-equivalence.json`);
await writeFile(equivalencePath, serializeReleaseJson(equivalence), 'utf8');

const sbom = createRuntimeSbom({
  name: manifest.name,
  version: manifest.version,
  publicSuffixMetadata
});
const sbomPath = resolve(dist, `${base}.runtime-sbom.cdx.json`);
await writeFile(sbomPath, serializeReleaseJson(sbom), 'utf8');

const releaseNotesPath = resolve(dist, `${base}.release-notes.md`);
await writeFile(releaseNotesPath, createReleaseNotes({ name: manifest.name, version: manifest.version }), 'utf8');

const provenancePath = resolve(dist, `${base}.unsigned-provenance-input.json`);
await writeFile(
  provenancePath,
  serializeReleaseJson(
    createUnsignedProvenance({
      base,
      runtimeArtifactSha256: zipDigest,
      version: manifest.version,
      sourceCommit,
      runtimeEntries: sourceEntries,
      nodeVersion: process.version,
      platform: os.platform(),
      architecture: os.arch(),
      gitVersion: trustedGit.version,
      gitExecutableSha256: trustedGit.sha256
    })
  ),
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
  serializeReleaseJson(
    createCurrentReleaseIndex({ base, version: manifest.version, sourceCommit, outputs: indexedOutputs })
  ),
  'utf8'
);
checksumTargets.push(currentReleasePath);
const checksumLines = [];
for (const path of checksumTargets) {
  checksumLines.push(`${sha256(await readFile(path))}  ${path.split(/[\\/]/).at(-1)}`);
}
await writeFile(resolve(dist, 'SHA256SUMS'), `${checksumLines.join('\n')}\n`, 'utf8');
await promoteCurrentRelease();
assertGitWorktreeClean(root, { expectedCommit: sourceCommit });

console.log(
  JSON.stringify(
    {
      status: 'unreleased-candidate',
      artifact: resolve(currentDist, `${base}.zip`),
      bytes: zipBytes.length,
      sha256: zipDigest,
      files: zipEntries.length,
      sourceArtifact: resolve(currentDist, `${base}-source.zip`),
      sourceBytes: sourceArchiveBytes.length,
      sourceSha256: sourceArchiveDigest,
      sourceFiles: sourceArchiveEntries.length,
      sourceArchiveCompression: 'stored',
      sourceCommit,
      sourcePackageEquivalence: 'exact',
      currentReleaseDirectory: currentDist,
      outputs: checksumTargets.map((path) => path.split(/[\\/]/).at(-1)).concat('SHA256SUMS')
    },
    null,
    2
  )
);

async function prepareBuildDirectory() {
  await removeGeneratedReleaseChild(distRoot, '.current-staging');
  await createGeneratedReleaseChild(distRoot, '.current-staging');
}

async function promoteCurrentRelease() {
  const previous = resolve(distRoot, '.current-previous');
  for (const name of ['.current-staging', 'current', '.current-previous']) {
    await assertGeneratedReleaseChild(distRoot, name, { allowMissing: true });
  }
  await removeGeneratedReleaseChild(distRoot, '.current-previous');
  const hadCurrent = await pathExists(currentDist);
  if (hadCurrent) await rename(currentDist, previous);
  try {
    await rename(dist, currentDist);
  } catch (error) {
    if (hadCurrent && (await pathExists(previous))) await rename(previous, currentDist);
    throw new Error('Could not promote the staged current release directory.', { cause: error });
  }
  await removeGeneratedReleaseChild(distRoot, '.current-previous');
}

async function pathExists(path) {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function writeZip(path, entries, mtime, { compress = true } = {}) {
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
        compress
      });
    }
    zip.end();
  });
}

function assertStored(entries) {
  for (const entry of entries) {
    if (entry.compressedSize !== entry.uncompressedSize) {
      throw new Error(`Source ZIP entry must use stored bytes: ${entry.path}`);
    }
  }
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

function parseCommittedJson(entries, path) {
  const bytes = entries.get(path)?.bytes;
  if (!bytes) throw new Error(`Required committed JSON source is missing: ${path}`);
  return JSON.parse(bytes.toString('utf8'));
}

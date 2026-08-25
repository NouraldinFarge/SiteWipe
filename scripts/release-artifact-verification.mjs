import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import { resolve } from 'node:path';

import { RUNTIME_FILES } from './release-files.mjs';
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
import { validateArtifactDirectory, validateVersionContract } from './version-contract-check.mjs';
import { projectRoot, runtimeArtifactBase } from './versioning.mjs';
import { readZipEntries } from './zip-utils.mjs';

export async function verifyReleaseCandidate({
  root = projectRoot,
  artifactDirectory = resolve(root, 'dist', 'current')
} = {}) {
  const sourceCommit = assertGitWorktreeClean(root);
  const trustedGit = resolveTrustedGitExecutable({ root });
  const committedSource = await collectCommittedSourceArchiveEntries(root, { ref: sourceCommit });
  if (committedSource.commit !== sourceCommit)
    throw new Error('Committed source snapshot changed during verification.');
  const expectedSourceEntries = committedSource.entries;
  const committedSourceByPath = new Map(expectedSourceEntries.map((entry) => [entry.path, entry]));
  const packageBytes = committedSourceByPath.get('package.json')?.bytes;
  const manifestBytes = committedSourceByPath.get('src/manifest.json')?.bytes;
  if (!packageBytes) throw new Error('Committed package.json is missing.');
  if (!manifestBytes) throw new Error('Committed src/manifest.json is missing.');
  const pkg = JSON.parse(packageBytes.toString('utf8'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (pkg.version !== manifest.version) throw new Error('Committed package/manifest version parity is invalid.');
  const publicSuffixMetadata = parsePublicSuffixMetadata(
    committedSourceByPath.get('src/shared/public-suffix-data.js')?.bytes
  );
  const base = runtimeArtifactBase(pkg.version);
  const releaseDirectory = validateArtifactDirectory(root, artifactDirectory);
  const zipPath = resolve(releaseDirectory, `${base}.zip`);
  const sourceZipPath = resolve(releaseDirectory, `${base}-source.zip`);
  await validateVersionContract({ root, requireArtifact: true, artifactDirectory: releaseDirectory });

  const checksumText = await readFile(resolve(releaseDirectory, 'SHA256SUMS'), 'utf8');
  const checksumRows = checksumText
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^([0-9A-F]{64})\s{2}(.+)$/);
      if (!match) throw new Error(`Malformed SHA256SUMS line: ${line}`);
      return [match[2], match[1]];
    });
  const checksums = new Map(checksumRows);
  if (checksums.size !== checksumRows.length) throw new Error('SHA256SUMS contains duplicate output names.');

  const payloadNames = [
    `${base}.zip`,
    `${base}-source.zip`,
    `${base}.source-package-equivalence.json`,
    `${base}.runtime-sbom.cdx.json`,
    `${base}.release-notes.md`,
    `${base}.unsigned-provenance-input.json`
  ];
  const expectedChecksumNames = new Set([...payloadNames, 'current-release.json']);
  assertExactSet(new Set(checksums.keys()), expectedChecksumNames, 'SHA256SUMS entries');

  for (const [name, expected] of checksums) {
    const actual = sha256(await readFile(resolve(releaseDirectory, name)));
    if (actual !== expected) throw new Error(`Checksum mismatch for ${name}: ${actual} != ${expected}`);
  }
  const directoryEntries = await readdir(releaseDirectory, { withFileTypes: true });
  if (directoryEntries.some((entry) => !entry.isFile())) {
    throw new Error('Current release directory contains a subdirectory.');
  }
  assertExactSet(
    new Set(directoryEntries.map((entry) => entry.name)),
    new Set([...expectedChecksumNames, 'SHA256SUMS']),
    'current release directory entries'
  );

  const currentRelease = JSON.parse(await readFile(resolve(releaseDirectory, 'current-release.json'), 'utf8'));
  if (currentRelease.schema !== 'sitewipe.current-unreleased-candidate.v1') {
    throw new Error('Current release index schema is invalid.');
  }
  if (currentRelease.version !== pkg.version || currentRelease.artifactBase !== base) {
    throw new Error('Current release index points to a stale version.');
  }
  if (currentRelease.sourceCommit !== sourceCommit) {
    throw new Error(`Current release source commit mismatch: ${currentRelease.sourceCommit} != ${sourceCommit}`);
  }
  if (currentRelease.runtimeArtifact !== `${base}.zip` || currentRelease.sourceArtifact !== `${base}-source.zip`) {
    throw new Error('Current release index artifact names are stale.');
  }
  if (currentRelease.checksumFile !== 'SHA256SUMS') {
    throw new Error('Current release index checksum pointer is invalid.');
  }
  if (!Array.isArray(currentRelease.outputs) || currentRelease.outputs.length !== payloadNames.length) {
    throw new Error('Current release index output count is invalid.');
  }
  assertExactSet(
    new Set(currentRelease.outputs.map((item) => item?.name)),
    new Set(payloadNames),
    'current release indexed outputs'
  );
  for (const output of currentRelease.outputs) {
    const bytes = await readFile(resolve(releaseDirectory, output.name));
    if (output.sha256 !== sha256(bytes) || output.bytes !== bytes.length) {
      throw new Error(`Current release index digest/size mismatch: ${output.name}`);
    }
  }

  const entries = (await readZipEntries(zipPath)).sort((a, b) => a.path.localeCompare(b.path));
  const runtimeZipBytes = await readFile(zipPath);
  const runtimeArtifactSha256 = sha256(runtimeZipBytes);
  const expectedRuntimeEntries = selectCommittedRuntimeEntries(expectedSourceEntries, RUNTIME_FILES);
  const expectedPaths = [...RUNTIME_FILES].sort();
  if (entries.length !== expectedPaths.length) {
    throw new Error(`Unexpected ZIP file count: ${entries.length}/${expectedPaths.length}`);
  }
  for (let index = 0; index < entries.length; index += 1) {
    if (entries[index].path !== expectedPaths[index]) throw new Error(`Unexpected ZIP path: ${entries[index].path}`);
    const source = committedSourceByPath.get(`src/${entries[index].path}`)?.bytes;
    if (!source?.equals(entries[index].bytes)) {
      throw new Error(`Committed source/package mismatch: ${entries[index].path}`);
    }
    if (entries[index].modifiedAt !== '1980-01-01T00:00:00.000Z') {
      throw new Error(`Non-normalized ZIP timestamp: ${entries[index].path} ${entries[index].modifiedAt}`);
    }
  }
  if (!entries.some((entry) => entry.path === 'manifest.json')) {
    throw new Error('manifest.json is not at the ZIP root.');
  }

  const sourceEntries = (await readZipEntries(sourceZipPath)).sort((a, b) => a.path.localeCompare(b.path));
  for (const required of ['README.md', 'package-lock.json', 'src/manifest.json', 'docs/safety-case.md']) {
    if (!sourceEntries.some((entry) => entry.path === required)) {
      throw new Error(`Source archive is missing required file: ${required}`);
    }
  }
  if (sourceEntries.length !== expectedSourceEntries.length) {
    throw new Error(`Unexpected source ZIP file count: ${sourceEntries.length}/${expectedSourceEntries.length}`);
  }
  for (let index = 0; index < expectedSourceEntries.length; index += 1) {
    const expected = expectedSourceEntries[index];
    const packaged = sourceEntries[index];
    if (packaged.path !== expected.path) throw new Error(`Unexpected source ZIP path: ${packaged.path}`);
    if (!packaged.bytes.equals(expected.bytes)) throw new Error(`Source archive byte mismatch: ${expected.path}`);
    if (packaged.modifiedAt !== '1980-01-01T00:00:00.000Z') {
      throw new Error(`Non-normalized source ZIP timestamp: ${packaged.path} ${packaged.modifiedAt}`);
    }
    if (packaged.compressedSize !== packaged.uncompressedSize) {
      throw new Error(`Source ZIP entry is compressed instead of stored: ${packaged.path}`);
    }
  }

  await assertExactGeneratedFile(
    releaseDirectory,
    `${base}.source-package-equivalence.json`,
    serializeReleaseJson(
      createSourcePackageEquivalence({
        base,
        runtimeArtifactSha256,
        sourceCommit,
        runtimeEntries: expectedRuntimeEntries,
        packagedFileCount: entries.length,
        manifestAtZipRoot: entries.some((entry) => entry.path === 'manifest.json')
      })
    )
  );
  await assertExactGeneratedFile(
    releaseDirectory,
    `${base}.runtime-sbom.cdx.json`,
    serializeReleaseJson(createRuntimeSbom({ name: manifest.name, version: manifest.version, publicSuffixMetadata }))
  );
  await assertExactGeneratedFile(
    releaseDirectory,
    `${base}.release-notes.md`,
    createReleaseNotes({ name: manifest.name, version: manifest.version })
  );
  await assertExactGeneratedFile(
    releaseDirectory,
    `${base}.unsigned-provenance-input.json`,
    serializeReleaseJson(
      createUnsignedProvenance({
        base,
        runtimeArtifactSha256,
        version: pkg.version,
        sourceCommit,
        runtimeEntries: expectedRuntimeEntries,
        nodeVersion: process.version,
        platform: os.platform(),
        architecture: os.arch(),
        gitVersion: trustedGit.version,
        gitExecutableSha256: trustedGit.sha256
      })
    )
  );
  await assertExactGeneratedFile(
    releaseDirectory,
    'current-release.json',
    serializeReleaseJson(
      createCurrentReleaseIndex({
        base,
        version: pkg.version,
        sourceCommit,
        outputs: currentRelease.outputs
      })
    )
  );
  assertGitWorktreeClean(root, { expectedCommit: sourceCommit });

  return {
    artifact: `${base}.zip`,
    sha256: runtimeArtifactSha256,
    files: entries.length,
    sourceArtifact: `${base}-source.zip`,
    sourceFiles: sourceEntries.length,
    sourceCommit,
    sourceArchiveCompression: 'stored',
    checksumFilesVerified: checksums.size,
    sourcePackageEquivalence: 'exact'
  };
}

export async function assertExactGeneratedFile(directory, name, expectedText) {
  const actual = await readFile(resolve(directory, name));
  const expected = Buffer.from(expectedText, 'utf8');
  if (!actual.equals(expected)) {
    throw new Error(`Generated release metadata does not match its canonical derivation: ${name}`);
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

function assertExactSet(actual, expected, label) {
  const missing = [...expected].filter((value) => !actual.has(value));
  const unexpected = [...actual].filter((value) => !expected.has(value));
  if (missing.length || unexpected.length) {
    throw new Error(
      `${label} mismatch; missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}`
    );
  }
}

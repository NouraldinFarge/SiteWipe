import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_FILES } from './release-files.mjs';
import { collectSourceArchiveEntries } from './source-archive.mjs';
import { readZipEntries } from './zip-utils.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const base = `sitewipe-private-rc-${pkg.version}`;
const dist = resolve(root, 'dist', 'current');
const zipPath = resolve(dist, `${base}.zip`);
const sourceZipPath = resolve(dist, `${base}-source.zip`);
execFileSync(process.execPath, [resolve(root, 'scripts', 'check-version.mjs'), '--require-artifact'], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true
});
const checksumText = await readFile(resolve(dist, 'SHA256SUMS'), 'utf8');
const checksums = new Map(
  checksumText
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^([0-9A-F]{64})\s{2}(.+)$/);
      if (!match) throw new Error(`Malformed SHA256SUMS line: ${line}`);
      return [match[2], match[1]];
    })
);

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
  const actual = sha256(await readFile(resolve(dist, name)));
  if (actual !== expected) throw new Error(`Checksum mismatch for ${name}: ${actual} != ${expected}`);
}
const directoryEntries = await readdir(dist, { withFileTypes: true });
if (directoryEntries.some((entry) => !entry.isFile()))
  throw new Error('Current release directory contains a subdirectory.');
assertExactSet(
  new Set(directoryEntries.map((entry) => entry.name)),
  new Set([...expectedChecksumNames, 'SHA256SUMS']),
  'current release directory entries'
);

const currentRelease = JSON.parse(await readFile(resolve(dist, 'current-release.json'), 'utf8'));
if (currentRelease.schema !== 'sitewipe.current-private-release-candidate.v1') {
  throw new Error('Current release index schema is invalid.');
}
if (currentRelease.version !== pkg.version || currentRelease.artifactBase !== base) {
  throw new Error('Current release index points to a stale version.');
}
if (currentRelease.runtimeArtifact !== `${base}.zip` || currentRelease.sourceArtifact !== `${base}-source.zip`) {
  throw new Error('Current release index artifact names are stale.');
}
if (currentRelease.checksumFile !== 'SHA256SUMS') throw new Error('Current release index checksum pointer is invalid.');
assertExactSet(
  new Set((currentRelease.outputs || []).map((item) => item?.name)),
  new Set(payloadNames),
  'current release indexed outputs'
);
for (const output of currentRelease.outputs || []) {
  const bytes = await readFile(resolve(dist, output.name));
  if (output.sha256 !== sha256(bytes) || output.bytes !== bytes.length) {
    throw new Error(`Current release index digest/size mismatch: ${output.name}`);
  }
}

const entries = (await readZipEntries(zipPath)).sort((a, b) => a.path.localeCompare(b.path));
const expectedPaths = [...RUNTIME_FILES].sort();
if (entries.length !== expectedPaths.length)
  throw new Error(`Unexpected ZIP file count: ${entries.length}/${expectedPaths.length}`);
for (let index = 0; index < entries.length; index += 1) {
  if (entries[index].path !== expectedPaths[index]) throw new Error(`Unexpected ZIP path: ${entries[index].path}`);
  const source = await readFile(resolve(root, 'src', entries[index].path));
  if (!source.equals(entries[index].bytes)) throw new Error(`Source/package mismatch: ${entries[index].path}`);
  if (entries[index].modifiedAt !== '1980-01-01T00:00:00.000Z')
    throw new Error(`Non-normalized ZIP timestamp: ${entries[index].path} ${entries[index].modifiedAt}`);
}
if (!entries.some((entry) => entry.path === 'manifest.json')) throw new Error('manifest.json is not at the ZIP root.');
const sourceEntries = (await readZipEntries(sourceZipPath)).sort((a, b) => a.path.localeCompare(b.path));
for (const required of ['README.md', 'package-lock.json', 'src/manifest.json', 'docs/safety-case.md']) {
  if (!sourceEntries.some((entry) => entry.path === required))
    throw new Error(`Source archive is missing required file: ${required}`);
}
const expectedSourceEntries = await collectSourceArchiveEntries(root);
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
}
console.log(
  JSON.stringify(
    {
      artifact: `${base}.zip`,
      sha256: sha256(await readFile(zipPath)),
      files: entries.length,
      sourceArtifact: `${base}-source.zip`,
      sourceFiles: sourceEntries.length,
      checksumFilesVerified: checksums.size,
      sourcePackageEquivalence: 'exact'
    },
    null,
    2
  )
);

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

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertReleaseSnapshotsEqual, snapshotReleaseDirectory } from '../../scripts/release-reproducibility.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('release reproducibility compares every output name, size, and byte digest', async (context) => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'sitewipe-release-reproducibility-'));
  const firstDirectory = resolve(temporary, 'first');
  const secondDirectory = resolve(temporary, 'second');
  context.after(() => rm(temporary, { recursive: true, force: true }));
  await mkdir(firstDirectory);
  await mkdir(secondDirectory);
  for (const directory of [firstDirectory, secondDirectory]) {
    await writeFile(resolve(directory, 'SHA256SUMS'), 'fixture sums\n');
    await writeFile(resolve(directory, 'sitewipe.zip'), Buffer.from([0, 1, 2, 3]));
  }

  const first = await snapshotReleaseDirectory(firstDirectory);
  const second = await snapshotReleaseDirectory(secondDirectory);
  assert.doesNotThrow(() => assertReleaseSnapshotsEqual(first, second));

  await writeFile(resolve(secondDirectory, 'sitewipe.zip'), Buffer.from([0, 1, 2, 4]));
  const mutated = await snapshotReleaseDirectory(secondDirectory);
  assert.throws(() => assertReleaseSnapshotsEqual(first, mutated), /consecutive release builds differ/i);
});

test('release reproducibility rejects added or non-file outputs', async (context) => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'sitewipe-release-reproducibility-shape-'));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  await writeFile(resolve(temporary, 'one.txt'), 'one\n');
  const first = await snapshotReleaseDirectory(temporary);
  await writeFile(resolve(temporary, 'two.txt'), 'two\n');
  const second = await snapshotReleaseDirectory(temporary);
  assert.throws(() => assertReleaseSnapshotsEqual(first, second), /different file counts/i);
  await mkdir(resolve(temporary, 'unexpected-directory'));
  await assert.rejects(snapshotReleaseDirectory(temporary), /non-file entry/i);
});

test('release builder is side-effect-free and CI invokes the two-build hook', async () => {
  const buildSource = await readFile(resolve(root, 'scripts', 'build-release.mjs'), 'utf8');
  assert.doesNotMatch(buildSource, /resolveCurrentValidationEvidence|updateAutomatedArtifactEvidence|writeJson/);
  assert.match(buildSource, /collectCommittedSourceArchiveEntries/);
  assert.match(buildSource, /selectCommittedRuntimeEntries\(sourceArchiveEntries, RUNTIME_FILES\)/);
  assert.doesNotMatch(buildSource, /readFile\(absolute\)|\bstat\(absolute\)/);
  assert.match(buildSource, /assertGitWorktreeClean/);

  for (const workflow of ['ci.yml', 'release-candidate.yml']) {
    const source = await readFile(resolve(root, '.github', 'workflows', workflow), 'utf8');
    assert.match(source, /npm run verify:reproducible-release-candidate/);
  }
});

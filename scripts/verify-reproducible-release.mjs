import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertReleaseSnapshotsEqual, snapshotReleaseDirectory } from './release-reproducibility.mjs';
import { assertGitWorktreeClean } from './source-archive.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDirectory = resolve(root, 'dist', 'current');
const sourceCommit = assertGitWorktreeClean(root);

const first = await buildAndSnapshot();
const second = await buildAndSnapshot();
assertReleaseSnapshotsEqual(first, second);
assertGitWorktreeClean(root, { expectedCommit: sourceCommit });

console.log(
  JSON.stringify(
    {
      status: 'passed',
      sourceCommit,
      consecutiveBuilds: 2,
      byteIdentical: true,
      outputs: second
    },
    null,
    2
  )
);

async function buildAndSnapshot() {
  for (const script of ['build-release.mjs', 'verify-release.mjs']) {
    execFileSync(process.execPath, [resolve(root, 'scripts', script)], {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true
    });
  }
  assertGitWorktreeClean(root, { expectedCommit: sourceCommit });
  return snapshotReleaseDirectory(releaseDirectory);
}

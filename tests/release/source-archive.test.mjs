import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { SOURCE_ARCHIVE_DIRECTORIES, SOURCE_ARCHIVE_ROOT_FILES } from '../../scripts/release-files.mjs';
import { listCommittedBrowserEvidenceDeltaPaths } from '../../scripts/browser-validation-policy.mjs';
import {
  assertGitWorktreeClean,
  collectCommittedSourceArchiveEntries,
  collectSourceArchiveEntries,
  selectCommittedRuntimeEntries
} from '../../scripts/source-archive.mjs';
import { assertTrustedGitExecutableUnchanged, resolveTrustedGitExecutable } from '../../scripts/trusted-git.mjs';

test('source archive closure rejects a linked root directory instead of following it', async (context) => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'sitewipe-source-archive-'));
  const root = resolve(temporary, 'project');
  context.after(() => rm(temporary, { recursive: true, force: true }));
  await mkdir(root);
  for (const directory of SOURCE_ARCHIVE_DIRECTORIES) await mkdir(resolve(root, directory), { recursive: true });
  for (const file of SOURCE_ARCHIVE_ROOT_FILES) await writeFile(resolve(root, file), 'fixture\n');
  const external = resolve(temporary, 'outside');
  const linkedRootDirectory = resolve(root, SOURCE_ARCHIVE_DIRECTORIES[0]);
  await mkdir(external);
  await writeFile(resolve(external, 'private.txt'), 'must not be archived\n');
  await rm(linkedRootDirectory, { recursive: true });
  await symlink(external, linkedRootDirectory, 'junction');

  await assert.rejects(collectSourceArchiveEntries(root), /symbolic links are prohibited/i);
});

test('committed source archive reads exact Git blobs and clean-tree checks fail closed', async (context) => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'sitewipe-committed-source-archive-'));
  const root = resolve(temporary, 'project');
  context.after(() => rm(temporary, { recursive: true, force: true }));
  await mkdir(root);
  for (const directory of SOURCE_ARCHIVE_DIRECTORIES) await mkdir(resolve(root, directory), { recursive: true });
  for (const file of SOURCE_ARCHIVE_ROOT_FILES) await writeFile(resolve(root, file), `committed ${file}\n`);
  await writeFile(resolve(root, 'docs', 'fixture.md'), 'committed documentation\n');
  await writeFile(resolve(root, 'src', 'runtime.js'), 'export const source = "committed";\n');

  git(root, ['init', '--quiet']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'user.name', 'SiteWipe release test']);
  git(root, ['config', 'user.email', 'release-test@invalid.example']);
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', 'fixture']);

  const commit = assertGitWorktreeClean(root);
  const committed = await collectCommittedSourceArchiveEntries(root);
  assert.equal(committed.commit, commit);
  const originalReadme = committed.entries.find((entry) => entry.path === 'README.md');
  assert.equal(originalReadme?.bytes.toString('utf8'), 'committed README.md\n');
  assert.equal(
    selectCommittedRuntimeEntries(committed.entries, ['runtime.js'])[0].bytes.toString('utf8'),
    'export const source = "committed";\n'
  );

  await writeFile(resolve(root, 'README.md'), 'uncommitted replacement\n');
  await writeFile(resolve(root, 'src', 'runtime.js'), 'export const source = "uncommitted";\n');
  await writeFile(resolve(root, 'docs', 'untracked.md'), 'must not enter the committed archive\n');
  assert.throws(() => assertGitWorktreeClean(root), /requires a clean Git worktree/i);

  const afterMutation = await collectCommittedSourceArchiveEntries(root, { ref: commit });
  assert.equal(afterMutation.entries.find((entry) => entry.path === 'README.md')?.sha256, originalReadme.sha256);
  assert.equal(
    selectCommittedRuntimeEntries(afterMutation.entries, ['runtime.js'])[0].bytes.toString('utf8'),
    'export const source = "committed";\n'
  );
  assert.equal(
    afterMutation.entries.some((entry) => entry.path === 'docs/untracked.md'),
    false
  );
  assert.equal(await readFile(resolve(root, 'README.md'), 'utf8'), 'uncommitted replacement\n');
});

test('trusted Git resolution ignores a project-local PATH shadow', async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), 'sitewipe-trusted-git-'));
  const shadow = resolve(root, 'shadow');
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(shadow);
  const fakeGit = resolve(shadow, process.platform === 'win32' ? 'git.exe' : 'git');
  await writeFile(fakeGit, 'not Git\n', { mode: 0o755 });
  const originalPath = process.env.PATH;
  process.env.PATH = `${shadow}${process.platform === 'win32' ? ';' : ':'}${originalPath || ''}`;
  try {
    const identity = resolveTrustedGitExecutable({ root });
    assert.notEqual(resolve(identity.path), resolve(fakeGit));
    assert.match(identity.sha256, /^[A-F0-9]{64}$/);
    assert.match(identity.version, /^git version /);
  } finally {
    process.env.PATH = originalPath;
  }
});

test('trusted Git resolution rejects a matching caller-supplied executable override', () => {
  const originalPath = process.env.SITEWIPE_GIT_EXECUTABLE;
  const originalSha256 = process.env.SITEWIPE_GIT_EXECUTABLE_SHA256;
  process.env.SITEWIPE_GIT_EXECUTABLE = 'C:\\Users\\attacker\\git.exe';
  process.env.SITEWIPE_GIT_EXECUTABLE_SHA256 = 'A'.repeat(64);
  try {
    assert.throws(
      () => resolveTrustedGitExecutable({ root: process.cwd() }),
      /custom Git executable overrides are prohibited/i
    );
  } finally {
    if (originalPath === undefined) delete process.env.SITEWIPE_GIT_EXECUTABLE;
    else process.env.SITEWIPE_GIT_EXECUTABLE = originalPath;
    if (originalSha256 === undefined) delete process.env.SITEWIPE_GIT_EXECUTABLE_SHA256;
    else process.env.SITEWIPE_GIT_EXECUTABLE_SHA256 = originalSha256;
  }
});

test('committed snapshots ignore replacement refs and inherited Git repository overrides', async (context) => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'sitewipe-git-provenance-'));
  const root = resolve(temporary, 'project');
  const decoy = resolve(temporary, 'decoy');
  context.after(() => rm(temporary, { recursive: true, force: true }));
  await mkdir(root);
  for (const directory of SOURCE_ARCHIVE_DIRECTORIES) await mkdir(resolve(root, directory), { recursive: true });
  for (const file of SOURCE_ARCHIVE_ROOT_FILES) await writeFile(resolve(root, file), `original ${file}\n`);
  await writeFile(resolve(root, 'docs', 'fixture.md'), 'original documentation\n');
  await writeFile(resolve(root, 'src', 'runtime.js'), 'export const source = "original";\n');
  git(root, ['init', '--quiet']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'user.name', 'SiteWipe release test']);
  git(root, ['config', 'user.email', 'release-test@invalid.example']);
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', 'original']);
  const originalCommit = gitOutput(root, ['rev-parse', 'HEAD']);

  await writeFile(resolve(root, 'README.md'), 'replacement bytes\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '--quiet', '-m', 'replacement']);
  const replacementCommit = gitOutput(root, ['rev-parse', 'HEAD']);
  git(root, ['replace', originalCommit, replacementCommit]);

  await mkdir(decoy);
  git(decoy, ['init', '--quiet']);
  const originalGitDir = process.env.GIT_DIR;
  const originalGitWorkTree = process.env.GIT_WORK_TREE;
  process.env.GIT_DIR = resolve(decoy, '.git');
  process.env.GIT_WORK_TREE = decoy;
  try {
    const committed = await collectCommittedSourceArchiveEntries(root, { ref: originalCommit });
    assert.equal(committed.commit, originalCommit);
    assert.equal(
      committed.entries.find((entry) => entry.path === 'README.md')?.bytes.toString('utf8'),
      'original README.md\n'
    );
  } finally {
    if (originalGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = originalGitDir;
    if (originalGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = originalGitWorkTree;
  }
});

test('trusted Git identity revalidation detects later executable-byte mutation', async (context) => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'sitewipe-git-rehash-'));
  const executable = resolve(temporary, 'git-fixture.bin');
  context.after(() => rm(temporary, { recursive: true, force: true }));
  await writeFile(executable, 'first executable bytes\n');
  const firstBytes = await readFile(executable);
  const identity = {
    path: executable,
    sha256: createHash('sha256').update(firstBytes).digest('hex').toUpperCase()
  };
  assert.doesNotThrow(() => assertTrustedGitExecutableUnchanged(identity));
  await writeFile(executable, 'mutated executable bytes\n');
  assert.throws(() => assertTrustedGitExecutableUnchanged(identity), /changed after identity validation/i);
});

test('clean-tree proof rejects assume-unchanged and skip-worktree index concealment', async (context) => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'sitewipe-hidden-index-'));
  const root = resolve(temporary, 'project');
  context.after(() => rm(temporary, { recursive: true, force: true }));
  await mkdir(root);
  for (const directory of SOURCE_ARCHIVE_DIRECTORIES) await mkdir(resolve(root, directory), { recursive: true });
  for (const file of SOURCE_ARCHIVE_ROOT_FILES) await writeFile(resolve(root, file), `committed ${file}\n`);
  git(root, ['init', '--quiet']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'user.name', 'SiteWipe release test']);
  git(root, ['config', 'user.email', 'release-test@invalid.example']);
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', 'fixture']);

  git(root, ['update-index', '--assume-unchanged', 'README.md']);
  await writeFile(resolve(root, 'README.md'), 'hidden assume-unchanged mutation\n');
  assert.throws(() => assertGitWorktreeClean(root), /assume-unchanged or skip-worktree/i);
  git(root, ['update-index', '--no-assume-unchanged', 'README.md']);
  await writeFile(resolve(root, 'README.md'), 'committed README.md\n');

  git(root, ['update-index', '--skip-worktree', 'README.md']);
  await writeFile(resolve(root, 'README.md'), 'hidden skip-worktree mutation\n');
  assert.throws(() => assertGitWorktreeClean(root), /assume-unchanged or skip-worktree/i);
});

test('browser evidence delta reports both ends of a cross-root rename', async (context) => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'sitewipe-evidence-rename-'));
  const root = resolve(temporary, 'project');
  context.after(() => rm(temporary, { recursive: true, force: true }));
  await mkdir(resolve(root, 'tests'), { recursive: true });
  await mkdir(resolve(root, 'docs', 'evidence'), { recursive: true });
  await writeFile(resolve(root, 'tests', 'hidden-source.js'), 'export const hidden = true;\n');
  git(root, ['init', '--quiet']);
  git(root, ['config', 'core.autocrlf', 'false']);
  git(root, ['config', 'user.name', 'SiteWipe release test']);
  git(root, ['config', 'user.email', 'release-test@invalid.example']);
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', 'tested source']);
  const testedCommit = gitOutput(root, ['rev-parse', 'HEAD']);

  await rename(resolve(root, 'tests', 'hidden-source.js'), resolve(root, 'docs', 'evidence', 'capture.js'));
  git(root, ['add', '--all']);
  git(root, ['commit', '--quiet', '-m', 'cross-root rename']);
  const finalCommit = gitOutput(root, ['rev-parse', 'HEAD']);

  assert.deepEqual(listCommittedBrowserEvidenceDeltaPaths(root, testedCommit, finalCommit), [
    'docs/evidence/capture.js',
    'tests/hidden-source.js'
  ]);
});

function git(root, args) {
  const identity = resolveTrustedGitExecutable({ root });
  execFileSync(identity.path, ['-C', root, ...args], { stdio: 'pipe', windowsHide: true });
}

function gitOutput(root, args) {
  const identity = resolveTrustedGitExecutable({ root });
  return execFileSync(identity.path, ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  }).trim();
}

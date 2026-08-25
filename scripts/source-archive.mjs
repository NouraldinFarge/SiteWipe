import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import { FORBIDDEN_PACKAGE_PATTERNS, SOURCE_ARCHIVE_DIRECTORIES, SOURCE_ARCHIVE_ROOT_FILES } from './release-files.mjs';
import { assertTrustedGitRepository, runTrustedGit } from './trusted-git.mjs';

export async function collectSourceArchivePaths(root) {
  const paths = [];
  for (const rootFile of SOURCE_ARCHIVE_ROOT_FILES) paths.push(resolve(root, rootFile));
  for (const directory of SOURCE_ARCHIVE_DIRECTORIES)
    paths.push(...(await discoverFiles(root, resolve(root, directory))));
  const unique = [...new Set(paths.map((path) => resolve(path)))];
  return unique.sort((a, b) => archivePath(root, a).localeCompare(archivePath(root, b)));
}

export async function collectSourceArchiveEntries(root) {
  const entries = [];
  for (const absolute of await collectSourceArchivePaths(root)) {
    const path = archivePath(root, absolute);
    if (FORBIDDEN_PACKAGE_PATTERNS.some((pattern) => pattern.test(path))) {
      throw new Error(`Forbidden source archive path: ${path}`);
    }
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Symbolic links are prohibited in source archives: ${absolute}`);
    if (!info.isFile() || info.size <= 0) throw new Error(`Source archive file is missing or empty: ${path}`);
    const bytes = await readFile(absolute);
    entries.push({ path, bytes, sha256: sha256(bytes), size: bytes.length });
  }
  return entries;
}

/**
 * Returns the source archive from immutable Git blobs instead of the live
 * working tree. Release builders use this path so an in-process write cannot
 * silently change the reviewed source bytes after the commit check.
 */
export async function collectCommittedSourceArchiveEntries(root, { ref = 'HEAD' } = {}) {
  const projectRoot = assertProjectGitRoot(root);
  const commit = resolveGitCommit(projectRoot, ref);
  const pathspecs = [...SOURCE_ARCHIVE_ROOT_FILES, ...SOURCE_ARCHIVE_DIRECTORIES];
  const tree = runGit(projectRoot, ['ls-tree', '-r', '-z', '--full-tree', commit, '--', ...pathspecs]);
  const entries = [];
  const seen = new Set();

  for (const record of tree.toString('utf8').split('\0').filter(Boolean)) {
    const match = record.match(/^([0-7]{6}) ([a-z]+) ([0-9a-f]{40,64})\t([\s\S]+)$/);
    if (!match) throw new Error(`Malformed Git source-tree entry: ${record}`);
    const [, mode, type, objectId, path] = match;
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) {
      throw new Error(`Non-regular Git source-tree entry is prohibited: ${path} (${mode} ${type})`);
    }
    if (seen.has(path)) throw new Error(`Duplicate Git source-tree entry: ${path}`);
    if (FORBIDDEN_PACKAGE_PATTERNS.some((pattern) => pattern.test(path))) {
      throw new Error(`Forbidden source archive path: ${path}`);
    }
    const bytes = runGit(projectRoot, ['cat-file', 'blob', objectId]);
    if (bytes.length <= 0) throw new Error(`Committed source archive file is empty: ${path}`);
    seen.add(path);
    entries.push({ path, bytes, sha256: sha256(bytes), size: bytes.length });
  }

  for (const required of SOURCE_ARCHIVE_ROOT_FILES) {
    if (!seen.has(required)) throw new Error(`Committed source archive root file is missing: ${required}`);
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { commit, entries };
}

export function selectCommittedRuntimeEntries(sourceEntries, runtimePaths) {
  if (!Array.isArray(sourceEntries) || !Array.isArray(runtimePaths)) {
    throw new TypeError('Committed source entries and runtime paths must be arrays.');
  }
  const byPath = new Map(sourceEntries.map((entry) => [entry.path, entry]));
  const selected = [];
  const seen = new Set();
  for (const runtimePath of runtimePaths) {
    if (seen.has(runtimePath)) throw new Error(`Duplicate runtime allowlist path: ${runtimePath}`);
    seen.add(runtimePath);
    const committed = byPath.get(`src/${runtimePath}`);
    if (!committed) throw new Error(`Runtime file is missing from the exact committed source: ${runtimePath}`);
    selected.push({ path: runtimePath, bytes: committed.bytes, sha256: committed.sha256, size: committed.size });
  }
  return selected;
}

export function assertGitWorktreeClean(root, { expectedCommit = null } = {}) {
  const projectRoot = assertProjectGitRoot(root);
  const commit = resolveGitCommit(projectRoot, 'HEAD');
  if (expectedCommit && commit !== expectedCommit) {
    throw new Error(`Git HEAD changed during release construction: ${commit} != ${expectedCommit}`);
  }
  assertNoHiddenIndexEntries(projectRoot);
  const status = runGit(projectRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status.length) {
    const paths = status.toString('utf8').split('\0').filter(Boolean).slice(0, 8).join(', ');
    throw new Error(`Release construction requires a clean Git worktree: ${paths}`);
  }
  return commit;
}

function assertNoHiddenIndexEntries(root) {
  const assumeRecords = runGit(root, ['ls-files', '-v', '-z']).toString('utf8').split('\0').filter(Boolean);
  const assumed = assumeRecords.filter((record) => /^[a-z] /.test(record));
  const tagRecords = runGit(root, ['ls-files', '-t', '-z']).toString('utf8').split('\0').filter(Boolean);
  const skipped = tagRecords.filter((record) => /^S /.test(record));
  if (assumed.length || skipped.length) {
    const paths = [...assumed, ...skipped]
      .map((record) => record.slice(2))
      .filter((path, index, values) => values.indexOf(path) === index)
      .slice(0, 8)
      .join(', ');
    throw new Error(`Release construction rejects assume-unchanged or skip-worktree index entries: ${paths}`);
  }
}

export function resolveGitCommit(root, ref = 'HEAD') {
  const commit = runGit(root, ['rev-parse', '--verify', `${ref}^{commit}`])
    .toString('utf8')
    .trim();
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error(`Git did not resolve an exact commit for ${ref}.`);
  return commit;
}

function archivePath(root, absolute) {
  const path = relative(root, absolute);
  if (!path || path === '..' || path.startsWith(`..${sep}`)) {
    throw new Error(`Source archive path escapes the project root: ${absolute}`);
  }
  return path.split(sep).join('/');
}

function assertProjectGitRoot(root) {
  const requested = resolve(root);
  assertTrustedGitRepository(requested);
  return requested;
}

function runGit(root, args) {
  try {
    return runTrustedGit({ root, args });
  } catch (error) {
    const detail = Buffer.isBuffer(error?.stderr) ? error.stderr.toString('utf8').trim() : '';
    throw new Error(`Git source snapshot failed${detail ? `: ${detail}` : '.'}`, { cause: error });
  }
}

async function discoverFiles(root, directory) {
  const directoryInfo = await lstat(directory);
  if (directoryInfo.isSymbolicLink()) throw new Error(`Symbolic links are prohibited in source archives: ${directory}`);
  if (!directoryInfo.isDirectory()) throw new Error(`Source archive directory is invalid: ${directory}`);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = resolve(directory, entry.name);
    archivePath(root, absolute);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Symbolic links are prohibited in source archives: ${absolute}`);
    if (entry.isDirectory()) files.push(...(await discoverFiles(root, absolute)));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

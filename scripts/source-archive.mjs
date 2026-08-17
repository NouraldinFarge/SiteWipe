import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

import { FORBIDDEN_PACKAGE_PATTERNS, SOURCE_ARCHIVE_DIRECTORIES, SOURCE_ARCHIVE_ROOT_FILES } from './release-files.mjs';

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

function archivePath(root, absolute) {
  const path = relative(root, absolute);
  if (!path || path === '..' || path.startsWith(`..${sep}`)) {
    throw new Error(`Source archive path escapes the project root: ${absolute}`);
  }
  return path.split(sep).join('/');
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

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RUNTIME_FILES } from './release-files.mjs';
import { collectSourceArchivePaths } from './source-archive.mjs';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function assertSemanticVersion(value, label = 'version') {
  const text = String(value || '');
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(text)) {
    throw new Error(`${label} must use numeric major.minor.patch form without leading zeroes.`);
  }
  return text;
}

export function resolveNextVersion(currentValue, request = 'patch') {
  const current = assertSemanticVersion(currentValue, 'current version');
  const parts = current.split('.').map(Number);
  if (['major', 'minor', 'patch'].includes(request)) {
    const [major, minor, patch] = parts;
    if (request === 'major') return `${major + 1}.0.0`;
    if (request === 'minor') return `${major}.${minor + 1}.0`;
    return `${major}.${minor}.${patch + 1}`;
  }

  const requested = assertSemanticVersion(request, 'requested version');
  const requestedParts = requested.split('.').map(Number);
  for (let index = 0; index < parts.length; index += 1) {
    if (requestedParts[index] > parts[index]) return requested;
    if (requestedParts[index] < parts[index]) break;
  }
  throw new Error(`Requested version ${requested} must be greater than current version ${current}.`);
}

export function runtimeArtifactBase(version) {
  return `sitewipe-private-rc-${assertSemanticVersion(version)}`;
}

export async function computeRuntimeFingerprint(root = projectRoot, overrides = new Map()) {
  const hash = createHash('sha256');
  for (const relative of RUNTIME_FILES) {
    hash.update(relative, 'utf8');
    hash.update('\0', 'utf8');
    const repoPath = `src/${relative}`;
    hash.update(overrides.has(repoPath) ? overrides.get(repoPath) : await readFile(resolve(root, repoPath)));
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex').toUpperCase();
}

export async function computeReleaseInputFingerprint(root = projectRoot, overrides = new Map()) {
  const hash = createHash('sha256');
  let fileCount = 0;
  for (const absolute of await collectSourceArchivePaths(root)) {
    const path = relative(root, absolute).split(sep).join('/');
    if (isMutableReleaseRecord(path)) continue;
    hash.update(path, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(overrides.has(path) ? overrides.get(path) : await readFile(absolute));
    hash.update('\0', 'utf8');
    fileCount += 1;
  }
  return { fileCount, sha256: hash.digest('hex').toUpperCase() };
}

export function isMutableReleaseRecord(path) {
  const value = String(path).replaceAll('\\', '/');
  return (
    value.startsWith('docs/evidence/') ||
    /^docs\/decisions\/[^/]+\.json$/i.test(value) ||
    value === 'assets/brand/icon-provenance.json'
  );
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

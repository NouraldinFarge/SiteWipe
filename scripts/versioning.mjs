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
  return `sitewipe-unreleased-candidate-${assertSemanticVersion(version)}`;
}

export async function collectVersionFingerprintPaths(root = projectRoot) {
  const runtimePaths = Object.freeze(RUNTIME_FILES.map((path) => `src/${path}`));
  const releaseInputPaths = Object.freeze(
    (await collectSourceArchivePaths(root))
      .map((absolute) => relative(root, absolute).split(sep).join('/'))
      .filter((path) => !isMutableReleaseRecord(path))
  );
  const allPaths = Object.freeze([...new Set([...runtimePaths, ...releaseInputPaths])].sort(compareStrings));
  return Object.freeze({ allPaths, releaseInputPaths, runtimePaths });
}

export async function computeVersionFingerprintSnapshot(root = projectRoot, overrides = new Map()) {
  const paths = await collectVersionFingerprintPaths(root);
  const inputs = new Map();
  for (const path of paths.allPaths) {
    const value = overrides.has(path) ? overrides.get(path) : await readFile(resolve(root, path));
    inputs.set(path, exactFingerprintBytes(value, path));
  }

  const runtimeHash = createHash('sha256');
  for (const relativePath of RUNTIME_FILES) {
    runtimeHash.update(relativePath, 'utf8');
    runtimeHash.update('\0', 'utf8');
    runtimeHash.update(inputs.get(`src/${relativePath}`));
    runtimeHash.update('\0', 'utf8');
  }

  const releaseInputHash = createHash('sha256');
  for (const path of paths.releaseInputPaths) {
    releaseInputHash.update(path, 'utf8');
    releaseInputHash.update('\0', 'utf8');
    releaseInputHash.update(inputs.get(path));
    releaseInputHash.update('\0', 'utf8');
  }

  return Object.freeze({
    inputs,
    paths,
    releaseInputFingerprint: Object.freeze({
      fileCount: paths.releaseInputPaths.length,
      sha256: releaseInputHash.digest('hex').toUpperCase()
    }),
    runtimeFingerprintSha256: runtimeHash.digest('hex').toUpperCase()
  });
}

/**
 * Compute the version fingerprints from one already captured source closure.
 * Release verification uses immutable committed Git blobs here instead of
 * rediscovering or re-reading mutable worktree paths.
 */
export function computeVersionFingerprintFromSourceEntries(sourceEntries) {
  if (!Array.isArray(sourceEntries) || sourceEntries.length === 0) {
    throw new Error('Committed version fingerprint requires one non-empty source-entry array.');
  }
  const inputs = new Map();
  for (const entry of sourceEntries) {
    const path = String(entry?.path || '');
    if (!path || inputs.has(path) || (!Buffer.isBuffer(entry?.bytes) && !(entry?.bytes instanceof Uint8Array))) {
      throw new Error(`Committed version fingerprint source entry is invalid or duplicated: ${path || '<missing>'}.`);
    }
    inputs.set(path, Buffer.from(entry.bytes));
  }

  const runtimeHash = createHash('sha256');
  for (const relativePath of RUNTIME_FILES) {
    const path = `src/${relativePath}`;
    const bytes = inputs.get(path);
    if (!bytes) throw new Error(`Committed version fingerprint runtime input is missing: ${path}.`);
    runtimeHash.update(relativePath, 'utf8');
    runtimeHash.update('\0', 'utf8');
    runtimeHash.update(bytes);
    runtimeHash.update('\0', 'utf8');
  }

  const releaseInputPaths = [...inputs.keys()]
    .filter((path) => !isMutableReleaseRecord(path))
    .sort((left, right) => left.localeCompare(right));
  const releaseInputHash = createHash('sha256');
  for (const path of releaseInputPaths) {
    releaseInputHash.update(path, 'utf8');
    releaseInputHash.update('\0', 'utf8');
    releaseInputHash.update(inputs.get(path));
    releaseInputHash.update('\0', 'utf8');
  }
  return Object.freeze({
    releaseInputFingerprint: Object.freeze({
      fileCount: releaseInputPaths.length,
      sha256: releaseInputHash.digest('hex').toUpperCase()
    }),
    runtimeFingerprintSha256: runtimeHash.digest('hex').toUpperCase()
  });
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

function exactFingerprintBytes(value, path) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
  throw new Error(`Version fingerprint input must be exact text or bytes: ${path}.`);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

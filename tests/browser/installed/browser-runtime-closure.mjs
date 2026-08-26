import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { posix, relative, resolve, sep } from 'node:path';

import { assertNativeAbsolutePath, isPortableLocalAbsolutePath } from './path-contract.mjs';

export const BROWSER_RUNTIME_CLOSURE_SCHEMA = 'sitewipe.browser-runtime-closure.v1';

const CLOSURE_KEYS = Object.freeze([
  'bytes',
  'fileCount',
  'files',
  'manifestSha256',
  'runtimeRootPath',
  'runtimeVersion',
  'schema'
]);
const FILE_KEYS = Object.freeze(['bytes', 'relativePath', 'sha256']);
// Access time is intentionally excluded because the validator's own reads may update it.
// Every non-access identity, allocation, metadata, and mutation timestamp field stays bigint-exact.
const STABLE_PHYSICAL_IDENTITY_KEYS = Object.freeze([
  'dev',
  'ino',
  'mode',
  'nlink',
  'uid',
  'gid',
  'rdev',
  'size',
  'blksize',
  'blocks',
  'mtimeNs',
  'ctimeNs',
  'birthtimeNs'
]);
export const BROWSER_RUNTIME_SUMMARY_KEYS = Object.freeze([
  'runtimeBytes',
  'runtimeFileCount',
  'runtimeManifestSha256',
  'runtimeRootPath',
  'runtimeVersion'
]);

export async function captureBrowserRuntimeClosure({ runtimeRootPath, runtimeVersion }, testHooks = null) {
  validateCaptureTestHooks(testHooks);
  const root = await exactPhysicalDirectory(runtimeRootPath, 'Browser runtime root');
  if (!isVersion(runtimeVersion) || !samePath(resolve(root.path, '..', runtimeVersion), root.path)) {
    throw new Error('Browser runtime root must be the exact directory named by its pinned runtime version.');
  }
  const initialManifest = await capturePhysicalRuntimeManifest(root.path, testHooks);
  const initialRoot = initialManifest.directories.find(({ relativePath }) => relativePath === '');
  if (!initialRoot || !sameStablePhysicalIdentity(root.identity, initialRoot.identity)) {
    throw new Error('Browser runtime root identity changed before its files were captured.');
  }
  if (testHooks?.afterInitialManifest) await testHooks.afterInitialManifest();
  const replayedManifest = await capturePhysicalRuntimeManifest(root.path);
  assertExactRuntimeManifestReplay(initialManifest, replayedManifest);
  const files = initialManifest.files.map(({ relativePath, bytes, sha256: digest }) => ({
    relativePath,
    bytes,
    sha256: digest
  }));
  if (!files.length) throw new Error('Browser runtime closure cannot be empty.');
  const unsigned = {
    schema: BROWSER_RUNTIME_CLOSURE_SCHEMA,
    runtimeRootPath: root.path,
    runtimeVersion,
    fileCount: files.length,
    bytes: files.reduce((total, entry) => safeAdd(total, entry.bytes, 'Browser runtime byte total'), 0),
    files
  };
  const closure = { ...unsigned, manifestSha256: sha256(canonicalJsonBytes(unsigned)) };
  validateBrowserRuntimeClosure(closure);
  return deepFreeze(closure);
}

export function validateBrowserRuntimeClosure(closure) {
  assertExactKeys(closure, CLOSURE_KEYS, 'Browser runtime closure');
  if (
    closure.schema !== BROWSER_RUNTIME_CLOSURE_SCHEMA ||
    !isPortableLocalAbsolutePath(closure.runtimeRootPath) ||
    !isVersion(closure.runtimeVersion) ||
    !Number.isSafeInteger(closure.fileCount) ||
    closure.fileCount <= 0 ||
    !Number.isSafeInteger(closure.bytes) ||
    closure.bytes <= 0 ||
    !Array.isArray(closure.files) ||
    closure.files.length !== closure.fileCount ||
    !isSha256(closure.manifestSha256)
  ) {
    throw new Error('Browser runtime closure has an invalid root, version, count, byte total, or digest.');
  }
  const paths = [];
  let observedBytes = 0;
  const caseInsensitivePaths = new Set();
  for (const file of closure.files) {
    assertExactKeys(file, FILE_KEYS, 'Browser runtime closure file');
    if (
      !isNormalizedRelativePath(file.relativePath) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes <= 0 ||
      !isSha256(file.sha256)
    ) {
      throw new Error('Browser runtime closure contains a malformed file identity.');
    }
    const folded = file.relativePath.toLowerCase();
    if (caseInsensitivePaths.has(folded)) {
      throw new Error('Browser runtime closure contains a case-insensitive path collision.');
    }
    caseInsensitivePaths.add(folded);
    paths.push(file.relativePath);
    observedBytes = safeAdd(observedBytes, file.bytes, 'Browser runtime closure byte total');
  }
  const sortedPaths = [...paths].sort(compareStrings);
  if (JSON.stringify(paths) !== JSON.stringify(sortedPaths) || new Set(paths).size !== paths.length) {
    throw new Error('Browser runtime closure files must be unique and sorted by normalized relative path.');
  }
  if (observedBytes !== closure.bytes) throw new Error('Browser runtime closure byte total differs from its files.');
  const unsigned = { ...closure };
  delete unsigned.manifestSha256;
  if (sha256(canonicalJsonBytes(unsigned)) !== closure.manifestSha256) {
    throw new Error('Browser runtime closure manifest SHA-256 differs from its canonical payload.');
  }
  return closure;
}

export function browserRuntimeClosureSummary(closure) {
  validateBrowserRuntimeClosure(closure);
  return Object.freeze({
    runtimeRootPath: closure.runtimeRootPath,
    runtimeVersion: closure.runtimeVersion,
    runtimeFileCount: closure.fileCount,
    runtimeBytes: closure.bytes,
    runtimeManifestSha256: closure.manifestSha256
  });
}

export function validateBrowserRuntimeSummary(summary) {
  assertExactKeys(summary, BROWSER_RUNTIME_SUMMARY_KEYS, 'Browser runtime summary');
  if (
    !isPortableLocalAbsolutePath(summary.runtimeRootPath) ||
    !isVersion(summary.runtimeVersion) ||
    !Number.isSafeInteger(summary.runtimeFileCount) ||
    summary.runtimeFileCount <= 0 ||
    !Number.isSafeInteger(summary.runtimeBytes) ||
    summary.runtimeBytes <= 0 ||
    !isSha256(summary.runtimeManifestSha256)
  ) {
    throw new Error('Browser runtime summary is incomplete or malformed.');
  }
  return summary;
}

export function computeBrowserRuntimeSetSha256(browserPins) {
  if (!Array.isArray(browserPins) || browserPins.length !== 2) {
    throw new Error('Browser runtime set requires exactly two browser pins.');
  }
  const values = browserPins.map((pin) => {
    if (!pin || typeof pin !== 'object' || !['brave', 'chrome'].includes(pin.name)) {
      throw new Error('Browser runtime set contains an unknown browser.');
    }
    const summary = Object.fromEntries(BROWSER_RUNTIME_SUMMARY_KEYS.map((key) => [key, pin[key]]));
    validateBrowserRuntimeSummary(summary);
    return { name: pin.name, ...summary };
  });
  values.sort((left, right) => compareStrings(left.name, right.name));
  if (JSON.stringify(values.map(({ name }) => name)) !== JSON.stringify(['brave', 'chrome'])) {
    throw new Error('Browser runtime set must contain exact unique Brave and Chrome summaries.');
  }
  return sha256(canonicalJsonBytes(values));
}

async function capturePhysicalRuntimeManifest(root, testHooks = null) {
  const files = [];
  const directories = [];
  const caseInsensitivePaths = new Set();
  await walkPhysicalRuntime(root, root, files, directories, caseInsensitivePaths, testHooks);
  files.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
  directories.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
  return deepFreeze({ files, directories });
}

async function walkPhysicalRuntime(root, current, files, directories, caseInsensitivePaths, testHooks) {
  const before = await exactPhysicalDirectory(current, 'Browser runtime directory');
  const entries = await readdir(current, { withFileTypes: true });
  if (testHooks?.afterDirectoryEnumeration) {
    await testHooks.afterDirectoryEnumeration(Object.freeze({ currentPath: current, rootPath: root }));
  }
  entries.sort((left, right) => compareStrings(left.name, right.name));
  for (const entry of entries) {
    const absolute = resolve(current, entry.name);
    const information = await lstat(absolute, { bigint: true });
    if (entry.isSymbolicLink() || information.isSymbolicLink() || !samePath(await realpath(absolute), absolute)) {
      throw new Error('Browser runtime closure contains a symbolic link, reparse alias, or redirected entry.');
    }
    if (information.isDirectory()) {
      await walkPhysicalRuntime(root, absolute, files, directories, caseInsensitivePaths, testHooks);
      continue;
    }
    if (!information.isFile() || information.nlink !== 1n) {
      throw new Error('Browser runtime closure contains a non-regular or multiply linked file.');
    }
    const relativePath = relative(root, absolute).split(sep).join('/');
    if (!isNormalizedRelativePath(relativePath)) {
      throw new Error('Browser runtime closure contains an invalid relative path.');
    }
    const folded = relativePath.toLowerCase();
    if (caseInsensitivePaths.has(folded)) {
      throw new Error('Browser runtime closure contains a case-insensitive path collision.');
    }
    caseInsensitivePaths.add(folded);
    const identity = await exactOpenedFileIdentity(absolute, information);
    files.push({
      relativePath,
      bytes: identity.bytes,
      sha256: identity.sha256,
      identity: identity.information
    });
  }
  const after = await exactPhysicalDirectory(current, 'Browser runtime directory');
  if (!sameStablePhysicalIdentity(before.identity, after.identity)) {
    throw new Error('Browser runtime directory drifted while its files were captured.');
  }
  directories.push({
    relativePath: samePath(root, current) ? '' : relative(root, current).split(sep).join('/'),
    identity: after.identity
  });
}

async function exactPhysicalDirectory(path, label) {
  const expected = resolve(assertNativeAbsolutePath(path, `${label} path`));
  const information = await lstat(expected, { bigint: true });
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error(`${label} must be one physical non-reparse directory.`);
  }
  if (!samePath(await realpath(expected), expected)) throw new Error(`${label} is aliased.`);
  return Object.freeze({
    path: expected,
    information,
    identity: stablePhysicalIdentity(information, `${label} identity`)
  });
}

async function exactOpenedFileIdentity(path, before) {
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameFileIdentity(before, opened)) {
      throw new Error('Browser runtime file identity changed before hashing.');
    }
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      bytes = safeAdd(bytes, chunk.length, 'Browser runtime file byte count');
    }
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    if (
      !sameFileIdentity(opened, after) ||
      !sameFileIdentity(after, pathAfter) ||
      after.size !== BigInt(bytes) ||
      after.nlink !== 1n ||
      pathAfter.isSymbolicLink() ||
      !samePath(await realpath(path), path)
    ) {
      throw new Error('Browser runtime file identity changed while hashing.');
    }
    return Object.freeze({
      bytes,
      sha256: hash.digest('hex').toUpperCase(),
      information: stablePhysicalIdentity(after, 'Browser runtime file identity')
    });
  } finally {
    await handle.close();
  }
}

function assertExactRuntimeManifestReplay(initial, replayed) {
  if (initial.directories.length !== replayed.directories.length || initial.files.length !== replayed.files.length) {
    throw new Error('Browser runtime manifest entry set drifted before final replay.');
  }
  for (let index = 0; index < initial.directories.length; index += 1) {
    const expected = initial.directories[index];
    const observed = replayed.directories[index];
    if (
      expected.relativePath !== observed.relativePath ||
      !sameStablePhysicalIdentity(expected.identity, observed.identity)
    ) {
      throw new Error('Browser runtime directory identity drifted before final replay.');
    }
  }
  for (let index = 0; index < initial.files.length; index += 1) {
    const expected = initial.files[index];
    const observed = replayed.files[index];
    if (
      expected.relativePath !== observed.relativePath ||
      expected.bytes !== observed.bytes ||
      expected.sha256 !== observed.sha256 ||
      !sameStablePhysicalIdentity(expected.identity, observed.identity)
    ) {
      throw new Error('Browser runtime file identity or bytes drifted before final replay.');
    }
  }
}

function validateCaptureTestHooks(testHooks) {
  if (testHooks === null) return;
  assertExactKeys(
    testHooks,
    ['afterDirectoryEnumeration', 'afterInitialManifest'],
    'Browser runtime closure test hooks'
  );
  for (const key of ['afterDirectoryEnumeration', 'afterInitialManifest']) {
    if (testHooks[key] !== null && typeof testHooks[key] !== 'function') {
      throw new Error('Browser runtime closure test hook is malformed.');
    }
  }
}

function isNormalizedRelativePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    value === value.trim() &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !value.startsWith('/') &&
    value === posix.normalize(value) &&
    !value.split('/').includes('..')
  );
}

function canonicalJsonBytes(value) {
  return Buffer.from(`${stableJson(value)}\n`, 'utf8');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} keys differ from the exact schema.`);
  }
}

function sameFileIdentity(left, right) {
  return sameStablePhysicalIdentity(
    stablePhysicalIdentity(left, 'Browser runtime file identity'),
    stablePhysicalIdentity(right, 'Browser runtime file identity')
  );
}

function stablePhysicalIdentity(information, label) {
  if (!information || typeof information !== 'object') throw new Error(`${label} is unavailable.`);
  const identity = {};
  for (const key of STABLE_PHYSICAL_IDENTITY_KEYS) {
    if (typeof information[key] !== 'bigint') throw new Error(`${label} is not bigint-safe and complete.`);
    identity[key] = information[key];
  }
  return Object.freeze(identity);
}

function sameStablePhysicalIdentity(left, right) {
  return Boolean(left) && Boolean(right) && STABLE_PHYSICAL_IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isVersion(value) {
  return typeof value === 'string' && /^\d+(?:\.\d+){2,3}$/.test(value);
}

function isSha256(value) {
  return typeof value === 'string' && /^[A-F0-9]{64}$/.test(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

function safeAdd(left, right, label) {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${label} exceeds the safe integer range.`);
  return result;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

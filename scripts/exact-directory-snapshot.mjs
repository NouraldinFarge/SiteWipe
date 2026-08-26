import { createHash } from 'node:crypto';
import { lstat as nativeLstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

const EXACT_STAT_OPTIONS = Object.freeze({ bigint: true });
const SNAPSHOT_STATE = new WeakMap();

/**
 * Capture every direct child of one physical directory through an exact file
 * handle. The returned object exposes only immutable names, sizes, and digests;
 * owned bytes and physical identities remain private to this module.
 */
export async function captureExactDirectorySnapshot(directoryPath) {
  const path = assertExactAbsolutePath(directoryPath);
  const state = await captureDirectoryPass(path);
  const snapshot = Object.freeze({
    path,
    files: Object.freeze(
      state.files.map(({ bytes, name, sha256 }) => Object.freeze({ bytes: bytes.length, name, sha256 }))
    )
  });
  SNAPSHOT_STATE.set(snapshot, state);
  return snapshot;
}

/**
 * Return caller-owned copies of the bytes captured in the original pass.
 * Mutating the returned map or buffers cannot alter the replay authority.
 */
export function readExactDirectorySnapshotFiles(snapshot) {
  const state = requireSnapshotState(snapshot);
  return new Map(state.files.map(({ bytes, name }) => [name, Buffer.from(bytes)]));
}

/**
 * Re-read the complete directory twice and require the same directory, exact
 * entry set, physical file identities, and bytes captured initially.
 */
export async function replayExactDirectorySnapshot(snapshot, { testOnlyAfterFirstPass = undefined } = {}) {
  const expected = requireSnapshotState(snapshot);
  const first = await captureDirectoryPass(expected.path);
  assertDirectoryPassEqual(expected, first, 'first complete replay');
  await runTestOnlyHook(testOnlyAfterFirstPass, 'after-first-pass');
  const final = await captureDirectoryPass(expected.path);
  assertDirectoryPassEqual(expected, final, 'final complete replay');
  assertDirectoryPassEqual(first, final, 'complete replay comparison');
  return snapshot;
}

async function captureDirectoryPass(path) {
  const before = await exactPhysicalDirectory(path, 'Exact snapshot directory');
  const firstNames = await readExactEntryNames(path);
  const files = [];
  for (const name of firstNames) {
    const file = await exactPhysicalFile(resolve(path, name), `Exact snapshot entry ${name}`);
    files.push(Object.freeze({ ...file, name }));
  }
  const after = await exactPhysicalDirectory(path, 'Exact snapshot directory');
  if (!sameDirectoryIdentity(before.information, after.information)) {
    throw new Error('Exact snapshot directory identity changed during capture.');
  }
  const finalNames = await readExactEntryNames(path);
  if (!exactArray(firstNames, finalNames)) {
    throw new Error('Exact snapshot directory entries changed during capture.');
  }
  return Object.freeze({
    path,
    directoryInformation: after.information,
    files: Object.freeze(files)
  });
}

async function readExactEntryNames(path) {
  const entries = await readdir(path, { withFileTypes: true });
  const names = entries.map(({ name }) => name).sort(compareStrings);
  if (
    names.some(
      (name) =>
        typeof name !== 'string' ||
        !name ||
        name === '.' ||
        name === '..' ||
        name.includes('/') ||
        name.includes('\\') ||
        name.includes('\0')
    ) ||
    new Set(names.map(normalizedName)).size !== names.length
  ) {
    throw new Error('Exact snapshot directory contains an invalid or colliding entry name.');
  }
  return Object.freeze(names);
}

async function exactPhysicalDirectory(path, label) {
  const information = await exactDirectoryPathStat(path);
  assertExactDirectory(information, label);
  if (!samePath(await realpath(path), path)) throw new Error(`${label} is aliased or reparse-backed.`);
  return Object.freeze({ information, path });
}

async function exactPhysicalFile(path, label) {
  const pathBefore = await exactDirectoryPathStat(path);
  assertExactFile(pathBefore, label);
  if (!samePath(await realpath(path), path)) throw new Error(`${label} is aliased or reparse-backed.`);
  const handle = await open(path, 'r');
  try {
    const opened = await exactDirectoryHandleStat(handle);
    assertExactFile(opened, label);
    if (!sameFileIdentity(pathBefore, opened)) {
      throw new Error(`${label} changed before its exact handle was opened.`);
    }
    const bytes = await handle.readFile();
    const handleAfter = await exactDirectoryHandleStat(handle);
    const pathAfter = await exactDirectoryPathStat(path);
    assertExactFile(handleAfter, label);
    assertExactFile(pathAfter, label);
    if (
      !sameFileIdentity(opened, handleAfter) ||
      !sameFileIdentity(handleAfter, pathAfter) ||
      handleAfter.size !== BigInt(bytes.length) ||
      !samePath(await realpath(path), path)
    ) {
      throw new Error(`${label} changed while its exact bytes were captured.`);
    }
    const owned = Buffer.from(bytes);
    return Object.freeze({
      bytes: owned,
      information: handleAfter,
      path,
      sha256: sha256(owned)
    });
  } finally {
    await handle.close();
  }
}

function assertDirectoryPassEqual(expected, observed, phase) {
  if (
    expected.path !== observed.path ||
    !sameDirectoryIdentity(expected.directoryInformation, observed.directoryInformation)
  ) {
    throw new Error(`Exact snapshot directory identity changed during ${phase}.`);
  }
  if (expected.files.length !== observed.files.length) {
    throw new Error(`Exact snapshot directory entry count changed during ${phase}.`);
  }
  for (const [index, current] of observed.files.entries()) {
    const earlier = expected.files[index];
    if (
      current.name !== earlier.name ||
      current.path !== earlier.path ||
      current.sha256 !== earlier.sha256 ||
      !current.bytes.equals(earlier.bytes) ||
      !sameFileIdentity(current.information, earlier.information)
    ) {
      throw new Error(`Exact snapshot entry changed during ${phase}: ${current.name}.`);
    }
  }
}

function requireSnapshotState(snapshot) {
  const state = SNAPSHOT_STATE.get(snapshot);
  if (!state) throw new Error('Exact directory snapshot was not created by this module instance.');
  return state;
}

async function runTestOnlyHook(callback, phase) {
  if (callback === undefined) return;
  if (
    typeof callback !== 'function' ||
    typeof process.env.NODE_TEST_CONTEXT !== 'string' ||
    !process.env.NODE_TEST_CONTEXT
  ) {
    throw new Error('Exact directory replay mutation hooks are available only to the Node test runner.');
  }
  await callback(phase);
}

export async function exactDirectoryPathStat(path, statImplementation = nativeLstat) {
  if (typeof statImplementation !== 'function') {
    throw new Error('Exact directory path-stat implementation is unavailable.');
  }
  return statImplementation(path, EXACT_STAT_OPTIONS);
}

export async function exactDirectoryHandleStat(handle) {
  if (!handle || typeof handle.stat !== 'function') {
    throw new Error('Exact directory handle-stat capability is unavailable.');
  }
  return handle.stat(EXACT_STAT_OPTIONS);
}

function assertExactDirectory(information, label) {
  if (
    !information?.isDirectory() ||
    information.isSymbolicLink() ||
    !hasExactBigIntFields(information, ['birthtimeNs', 'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink'])
  ) {
    throw new Error(`${label} must be one physical non-reparse directory with exact bigint identity.`);
  }
}

function assertExactFile(information, label) {
  if (
    !information?.isFile() ||
    information.isSymbolicLink() ||
    !hasExactBigIntFields(information, ['birthtimeNs', 'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink', 'size']) ||
    information.nlink !== 1n ||
    information.size < 0n
  ) {
    throw new Error(`${label} must be one singly linked regular non-reparse file with exact bigint identity.`);
  }
}

function sameDirectoryIdentity(left, right) {
  const fields = ['birthtimeNs', 'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink'];
  return (
    hasExactBigIntFields(left, fields) &&
    hasExactBigIntFields(right, fields) &&
    fields.every((field) => left[field] === right[field])
  );
}

function sameFileIdentity(left, right) {
  const fields = ['birthtimeNs', 'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink', 'size'];
  return (
    hasExactBigIntFields(left, fields) &&
    hasExactBigIntFields(right, fields) &&
    fields.every((field) => left[field] === right[field])
  );
}

function hasExactBigIntFields(value, fields) {
  return Boolean(value) && fields.every((field) => typeof value[field] === 'bigint');
}

function assertExactAbsolutePath(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value) {
    throw new Error('Exact directory snapshot requires one normalized absolute path.');
  }
  return value;
}

function samePath(left, right) {
  return normalizePath(left) === normalizePath(right);
}

function normalizePath(value) {
  const exact = resolve(value);
  return process.platform === 'win32' ? exact.toLowerCase() : exact;
}

function normalizedName(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function exactArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

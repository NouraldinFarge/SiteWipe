import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat as nativeLstat, open, realpath, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import {
  canonicalEvidenceFinalizationJsonBytes as canonicalManifestBytes,
  EVIDENCE_FINALIZATION_MANIFEST_PATH,
  EVIDENCE_FINALIZATION_MANIFEST_SCHEMA,
  expectedFinalizationKind,
  isApprovedFinalizationPath,
  validateManifestShape
} from './evidence-finalization-contract.mjs';

const PACKAGE_NAME = 'sitewipe-unreleased-candidate';
const INVENTORY_KEYS = Object.freeze(['kind', 'path']);
const EXACT_STAT_OPTIONS = Object.freeze({ bigint: true });
const REPOSITORY_FILE_MODE = process.platform === 'win32' ? 0o666 : 0o666 & (~process.umask() & 0o777);

/**
 * Mechanically finalizes an externally selected identity and evidence inventory.
 *
 * This function never derives or approves identity claims. The manifest is an
 * immutable create-only record. Any existing record requires a forward version;
 * it is never rewritten in place.
 */
export async function finalizePublicationEvidence({
  repositoryRoot,
  completedAt,
  expectedIdentity,
  inventory,
  expectedExistingManifestSha256 = null,
  testOnlyAfterInventoryPass = undefined
}) {
  const repository = await proveRepositoryRoot(repositoryRoot);
  const packageIdentity = await readCurrentPackageIdentity(repository.path);
  const version = packageIdentity.version;
  const timestamp = assertExactIsoTimestamp(completedAt);
  const externalIdentity = cloneExactJsonRecord(expectedIdentity, 'Externally supplied finalization identity');
  const exactInventory = validateInventory(inventory, version);

  if (externalIdentity.artifactVersion !== version) {
    throw new Error('Externally supplied finalization identity differs from the current package version.');
  }
  if (expectedExistingManifestSha256 !== null) {
    throw new Error(
      'Evidence-finalization manifest replacement is prohibited; retain the immutable record and advance to a forward version.'
    );
  }

  const evidenceRoot = await proveEvidenceRoot(repository.path);
  const inventoryDirectories = await captureFinalizationDirectories(repository, [
    EVIDENCE_FINALIZATION_MANIFEST_PATH,
    ...exactInventory.map(({ path }) => path)
  ]);
  const initialInventory = await readInventoryPass(repository.path, exactInventory);
  const entries = initialInventory.map(({ bytes, kind, path, sha256: digest }) => ({
    bytes: bytes.length,
    kind,
    path,
    sha256: digest
  }));

  const manifest = {
    completedAt: timestamp,
    entries,
    identity: externalIdentity,
    recordedByAutomation: true,
    schema: EVIDENCE_FINALIZATION_MANIFEST_SCHEMA,
    version
  };
  validateManifestShape(manifest);
  const bytes = canonicalManifestBytes(manifest);
  const manifestSha256 = sha256(bytes);

  await revalidateDirectory(repository, 'Finalization repository root');
  await revalidateDirectory(evidenceRoot, 'Finalization evidence root');
  await revalidateFinalizationDirectories(inventoryDirectories);
  await runTestOnlyInventoryHook(testOnlyAfterInventoryPass, 'after-initial-pass');
  const beforeCreateInventory = await readInventoryPass(repository.path, exactInventory);
  assertInventoryReplay(initialInventory, beforeCreateInventory, 'before immutable manifest creation');
  await replayCurrentPackageIdentity(repository.path, packageIdentity, 'before immutable manifest creation');
  await revalidateFinalizationDirectories(inventoryDirectories);
  const target = resolveContainedPath(repository.path, EVIDENCE_FINALIZATION_MANIFEST_PATH);
  if (!sameHostPath(dirname(target), evidenceRoot.path)) {
    throw new Error('Evidence-finalization manifest target is not the exact evidence-root child.');
  }

  const stagedManifest = await stageExclusiveManifest(target, bytes, testOnlyAfterInventoryPass);
  let createdManifest;
  try {
    await runTestOnlyInventoryHook(testOnlyAfterInventoryPass, 'after-stage');
    const beforePublishInventory = await readInventoryPass(repository.path, exactInventory);
    assertInventoryReplay(initialInventory, beforePublishInventory, 'before immutable manifest publication');
    await replayCurrentPackageIdentity(repository.path, packageIdentity, 'before immutable manifest publication');
    const stagedDirectories = await captureFinalizationDirectories(repository, [
      EVIDENCE_FINALIZATION_MANIFEST_PATH,
      ...exactInventory.map(({ path }) => path)
    ]);
    await revalidateFinalizationDirectories(stagedDirectories);
    createdManifest = await publishStagedManifest(target, bytes, stagedManifest);
  } catch (error) {
    try {
      await removeOwnedStagedManifestIfPresent(stagedManifest, bytes);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Evidence-finalization publication failed and its exact staging file could not be cleaned.',
        { cause: cleanupError }
      );
    }
    throw error;
  }

  await revalidateDirectory(repository, 'Finalization repository root');
  await revalidateDirectory(evidenceRoot, 'Finalization evidence root');
  const postCreateDirectories = await captureFinalizationDirectories(repository, [
    EVIDENCE_FINALIZATION_MANIFEST_PATH,
    ...exactInventory.map(({ path }) => path)
  ]);
  await runTestOnlyInventoryHook(testOnlyAfterInventoryPass, 'after-create');
  const afterCreateInventory = await readInventoryPass(repository.path, exactInventory);
  assertInventoryReplay(initialInventory, afterCreateInventory, 'after immutable manifest creation');
  await replayCurrentPackageIdentity(repository.path, packageIdentity, 'after immutable manifest creation');
  const stored = await readExactPhysicalFile(target, 'Evidence-finalization manifest');
  if (
    !stored.bytes.equals(bytes) ||
    stored.sha256 !== manifestSha256 ||
    !sameExactFileIdentity(stored.information, createdManifest.information)
  ) {
    throw new Error('Evidence-finalization manifest changed immediately after its bounded write.');
  }
  await revalidateFinalizationDirectories(postCreateDirectories);
  const finalStored = await readExactPhysicalFile(target, 'Final evidence-finalization manifest replay');
  if (
    !finalStored.bytes.equals(bytes) ||
    finalStored.sha256 !== manifestSha256 ||
    !sameExactFileIdentity(finalStored.information, createdManifest.information)
  ) {
    throw new Error('Evidence-finalization manifest changed during final replay.');
  }
  await replayCurrentPackageIdentity(repository.path, packageIdentity, 'during final replay');
  await revalidateFinalizationDirectories(postCreateDirectories);

  return deepFreeze({ manifest, manifestSha256, writeMode: createdManifest.writeMode });
}

export function canonicalEvidenceFinalizationJsonBytes(value) {
  return canonicalManifestBytes(value);
}

async function proveRepositoryRoot(repositoryRoot) {
  if (typeof repositoryRoot !== 'string' || !isAbsolute(repositoryRoot) || resolve(repositoryRoot) !== repositoryRoot) {
    throw new Error('Evidence finalization requires one exact absolute repository root.');
  }
  const repository = await readExactPhysicalDirectory(repositoryRoot, 'Finalization repository root');
  const markerPath = resolve(repository.path, '.git');
  let marker;
  try {
    marker = await exactFinalizationPathStat(markerPath);
  } catch {
    throw new Error('Finalization repository root lacks its exact repository marker.');
  }
  if (
    marker.isSymbolicLink() ||
    (!marker.isFile() && !marker.isDirectory()) ||
    !hasExactBigIntFields(marker, ['birthtimeNs', 'dev', 'ino', 'mode', 'nlink']) ||
    (marker.isFile() && marker.nlink !== 1n)
  ) {
    throw new Error('Finalization repository marker is not one physical file or directory.');
  }
  let markerRealPath;
  try {
    markerRealPath = await realpath(markerPath);
  } catch {
    throw new Error('Finalization repository marker cannot be physically resolved.');
  }
  if (!sameHostPath(markerRealPath, markerPath)) {
    throw new Error('Finalization repository marker is aliased or reparse-backed.');
  }
  return repository;
}

async function readCurrentPackageIdentity(repositoryRoot) {
  const packageIdentity = await readExactPhysicalFile(resolve(repositoryRoot, 'package.json'), 'Finalization package');
  let packageJson;
  try {
    packageJson = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(packageIdentity.bytes));
  } catch {
    throw new Error('Finalization package is not exact UTF-8 JSON.');
  }
  if (
    !isPlainRecord(packageJson) ||
    packageJson.name !== PACKAGE_NAME ||
    packageJson.private !== true ||
    !/^\d+\.\d+\.\d+$/.test(String(packageJson.version || ''))
  ) {
    throw new Error('Finalization package does not prove the expected private SiteWipe source root and version.');
  }
  return Object.freeze({ ...packageIdentity, version: packageJson.version });
}

async function replayCurrentPackageIdentity(repositoryRoot, expected, phase) {
  const observed = await readCurrentPackageIdentity(repositoryRoot);
  if (
    observed.version !== expected.version ||
    observed.sha256 !== expected.sha256 ||
    !observed.bytes.equals(expected.bytes) ||
    !sameExactFileIdentity(observed.information, expected.information)
  ) {
    throw new Error(`Finalization package identity changed ${phase}.`);
  }
}

async function proveEvidenceRoot(repositoryRoot) {
  const docsPath = resolve(repositoryRoot, 'docs');
  const evidencePath = resolve(docsPath, 'evidence');
  const docs = await readExactPhysicalDirectory(docsPath, 'Finalization docs root');
  if (!sameHostPath(dirname(docs.path), repositoryRoot)) {
    throw new Error('Finalization docs root is not an exact repository child.');
  }
  const evidence = await readExactPhysicalDirectory(evidencePath, 'Finalization evidence root');
  if (!sameHostPath(dirname(evidence.path), docs.path)) {
    throw new Error('Finalization evidence root is not an exact docs-root child.');
  }
  return evidence;
}

function validateInventory(inventory, version) {
  if (!Array.isArray(inventory) || !inventory.length) {
    throw new Error('Evidence finalization requires one non-empty explicit inventory.');
  }
  const result = inventory.map((item) => {
    assertPlainJson(item, 'Evidence finalization inventory entry');
    assertExactKeys(item, INVENTORY_KEYS, 'Evidence finalization inventory entry');
    const expectedKind = expectedFinalizationKind(item.path, version);
    if (!isApprovedFinalizationPath(item.path, version)) {
      throw new Error(`Evidence finalization inventory entry is outside the exact allowlist: ${String(item.path)}.`);
    }
    if (item.kind !== expectedKind) {
      throw new Error(`Evidence finalization inventory entry has the wrong evidence kind: ${item.path}.`);
    }
    return Object.freeze({ kind: item.kind, path: item.path });
  });
  const paths = result.map(({ path }) => path);
  const sortedPaths = [...paths].sort(compareStrings);
  if (new Set(paths).size !== paths.length || !exactArray(paths, sortedPaths)) {
    throw new Error('Evidence finalization inventory paths must be unique and sorted exactly.');
  }
  return Object.freeze(result);
}

async function readInventoryPass(repositoryRoot, inventory) {
  const observed = [];
  for (const item of inventory) {
    const absolute = resolveContainedPath(repositoryRoot, item.path);
    const physical = await readExactPhysicalFile(absolute, `Finalization inventory entry ${item.path}`);
    observed.push(Object.freeze({ ...physical, kind: item.kind, path: item.path }));
  }
  return Object.freeze(observed);
}

function assertInventoryReplay(expected, observed, phase) {
  if (expected.length !== observed.length) {
    throw new Error(`Evidence finalization inventory length changed ${phase}.`);
  }
  for (const [index, current] of observed.entries()) {
    const earlier = expected[index];
    if (
      current.path !== earlier.path ||
      current.kind !== earlier.kind ||
      current.sha256 !== earlier.sha256 ||
      !current.bytes.equals(earlier.bytes) ||
      !sameExactFileIdentity(current.information, earlier.information)
    ) {
      throw new Error(`Evidence finalization inventory changed ${phase}: ${current.path}.`);
    }
  }
}

async function captureFinalizationDirectories(repository, repositoryPaths) {
  const identities = new Map([[normalizedHostPath(repository.path), repository]]);
  for (const repositoryPath of repositoryPaths) {
    const absolute = resolveContainedPath(repository.path, repositoryPath);
    const parent = dirname(absolute);
    const relation = relative(repository.path, parent);
    if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
      throw new Error(`Finalization inventory parent escapes the repository: ${repositoryPath}.`);
    }
    let current = repository.path;
    for (const segment of relation ? relation.split(sep) : []) {
      current = resolve(current, segment);
      const key = normalizedHostPath(current);
      if (!identities.has(key)) {
        identities.set(key, await readExactPhysicalDirectory(current, `Finalization inventory ancestor ${current}`));
      }
    }
  }
  return Object.freeze([...identities.values()]);
}

async function revalidateFinalizationDirectories(directories) {
  for (const expected of directories) {
    const observed = await readExactPhysicalDirectory(
      expected.path,
      `Finalization inventory ancestor ${expected.path}`
    );
    if (!sameExactDirectoryIdentity(expected.information, observed.information)) {
      throw new Error(`Finalization inventory directory identity changed: ${expected.path}.`);
    }
  }
}

async function runTestOnlyInventoryHook(callback, phase) {
  if (callback === undefined) return;
  if (
    typeof callback !== 'function' ||
    typeof process.env.NODE_TEST_CONTEXT !== 'string' ||
    !process.env.NODE_TEST_CONTEXT
  ) {
    throw new Error('The finalization inventory mutation hook is available only to the Node test runner.');
  }
  await callback(phase);
}

async function stageExclusiveManifest(path, bytes, testOnlyAfterInventoryPass) {
  const stagePath = resolve(dirname(path), `.${basename(path)}.sitewipe-${randomUUID()}.tmp`);
  let handle;
  let writtenIdentity;
  try {
    if (await lstatIfPresent(path)) {
      throw Object.assign(
        new Error('Evidence-finalization manifest already exists and is immutable; advance to a forward version.'),
        {
          code: 'EEXIST'
        }
      );
    }
    handle = await open(stagePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, REPOSITORY_FILE_MODE);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      if (await lstatIfPresent(path)) {
        throw new Error(
          'Evidence-finalization manifest already exists and is immutable; advance to a forward version.',
          {
            cause: error
          }
        );
      }
      throw new Error('Evidence-finalization staging path already exists and will not be replaced.', { cause: error });
    }
    throw new Error('Evidence-finalization manifest staging file could not be exclusively created.', { cause: error });
  }
  let createdIdentity;
  try {
    const opened = await exactFinalizationHandleStat(handle);
    assertWritableManifestIdentity(opened);
    createdIdentity = opened;
    const openedPath = await exactFinalizationPathStat(stagePath);
    assertWritableManifestIdentity(openedPath);
    if (
      opened.size !== 0n ||
      !sameExactFileIdentity(opened, openedPath) ||
      !sameHostPath(await realpath(stagePath), stagePath)
    ) {
      throw new Error('Evidence-finalization staging path differs from its exact exclusive handle.');
    }
    await writeAllAt(handle, bytes, 0);
    await runTestOnlyInventoryHook(testOnlyAfterInventoryPass, 'after-stage-write');
    if (process.platform !== 'win32') await handle.chmod(REPOSITORY_FILE_MODE);
    await handle.sync();
    const information = await exactFinalizationHandleStat(handle);
    assertWritableManifestIdentity(information);
    const retained = await exactFinalizationPathStat(stagePath);
    assertWritableManifestIdentity(retained);
    if (
      !sameNodeIdentity(information, retained, { compareSize: true }) ||
      information.size !== BigInt(bytes.length) ||
      permissionMode(information) !== REPOSITORY_FILE_MODE ||
      !sameHostPath(await realpath(stagePath), stagePath)
    ) {
      throw new Error('Evidence-finalization staging path differs from its exact written handle.');
    }
    writtenIdentity = information;
    await handle.close();
    handle = null;
    await runTestOnlyInventoryHook(testOnlyAfterInventoryPass, 'after-stage-close');
    const stored = await readExactPhysicalFile(stagePath, 'Staged evidence-finalization manifest');
    if (!stored.bytes.equals(bytes) || !sameExactFileIdentity(stored.information, writtenIdentity)) {
      throw new Error('Staged evidence-finalization manifest bytes changed after handle close.');
    }
    return Object.freeze({ information: stored.information, path: stagePath });
  } catch (error) {
    let cleanupError = null;
    if (handle) {
      try {
        await handle.close();
      } catch (caught) {
        cleanupError = caught;
      }
    }
    if (createdIdentity) {
      try {
        await removePartiallyWrittenStage(stagePath, createdIdentity);
      } catch (caught) {
        cleanupError = cleanupError ? new AggregateError([cleanupError, caught]) : caught;
      }
    }
    if (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Evidence-finalization staging failed and its exact partial file could not be cleaned.',
        { cause: error }
      );
    }
    throw error;
  }
}

async function removePartiallyWrittenStage(path, createdIdentity) {
  if (!(await lstatIfPresent(path))) return;
  const observed = await readExactPhysicalFile(path, 'Partially written evidence-finalization staging file');
  if (!sameNodeIdentity(observed.information, createdIdentity, { compareSize: false })) {
    throw new Error('Partially written evidence-finalization staging file lost its exact owned physical identity.');
  }
  await rm(path);
  if (await lstatIfPresent(path)) {
    throw new Error('Partially written evidence-finalization staging file survived exact cleanup.');
  }
}

async function publishStagedManifest(path, bytes, staged) {
  const before = await readExactPhysicalFile(staged.path, 'Staged evidence-finalization manifest');
  if (!before.bytes.equals(bytes) || !sameExactFileIdentity(before.information, staged.information)) {
    throw new Error('Staged evidence-finalization manifest changed before immutable publication.');
  }
  try {
    await link(staged.path, path);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error('Evidence-finalization manifest already exists and is immutable; advance to a forward version.', {
        cause: error
      });
    }
    throw new Error('Evidence-finalization manifest could not be immutably published.', { cause: error });
  }
  const linkedStage = await readExactPhysicalFile(staged.path, 'Linked evidence-finalization staging file', {
    requireSingleLink: false
  });
  const linkedTarget = await readExactPhysicalFile(path, 'Published evidence-finalization manifest', {
    requireSingleLink: false
  });
  if (
    linkedStage.information.nlink !== 2n ||
    linkedTarget.information.nlink !== 2n ||
    !sameNodeIdentity(linkedStage.information, linkedTarget.information, { compareSize: true }) ||
    !linkedTarget.bytes.equals(bytes)
  ) {
    throw new Error('Published evidence-finalization manifest is not the exact staged physical file.');
  }
  await removeExactStagedManifest(staged.path, linkedStage);
  const stored = await readExactPhysicalFile(path, 'Created evidence-finalization manifest');
  if (
    !stored.bytes.equals(bytes) ||
    !sameNodeIdentity(stored.information, linkedTarget.information, { compareLinks: false, compareSize: true })
  ) {
    throw new Error('Created evidence-finalization manifest changed after staging cleanup.');
  }
  return Object.freeze({ information: stored.information, writeMode: 'created' });
}

async function removeExactStagedManifest(path, expected) {
  const observed = await readExactPhysicalFile(path, 'Linked evidence-finalization staging file', {
    requireSingleLink: false
  });
  if (!observed.bytes.equals(expected.bytes) || !sameExactFileIdentity(observed.information, expected.information)) {
    throw new Error('Evidence-finalization staging file changed before exact cleanup.');
  }
  await rm(path);
  if (await lstatIfPresent(path)) throw new Error('Evidence-finalization staging file survived exact cleanup.');
}

async function removeOwnedStagedManifestIfPresent(staged, bytes) {
  if (!(await lstatIfPresent(staged.path))) return;
  const observed = await readExactPhysicalFileIfPresent(staged.path, 'Owned evidence-finalization staging file', {
    requireSingleLink: false
  });
  if (!observed) return;
  if (
    !observed.bytes.equals(bytes) ||
    !sameNodeIdentity(observed.information, staged.information, { compareLinks: false, compareSize: true })
  ) {
    throw new Error('Evidence-finalization staging file is no longer the exact owned physical file.');
  }
  await rm(staged.path);
  if (await lstatIfPresent(staged.path)) {
    throw new Error('Evidence-finalization staging file survived bounded failure cleanup.');
  }
}

async function writeAllAt(handle, bytes, startPosition) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, startPosition + offset);
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) {
      throw new Error('Evidence-finalization manifest write made no forward progress.');
    }
    offset += bytesWritten;
  }
}

export async function exactFinalizationPathStat(path, statImplementation = nativeLstat) {
  if (typeof statImplementation !== 'function') {
    throw new Error('Evidence-finalization exact path-stat implementation is unavailable.');
  }
  return statImplementation(path, EXACT_STAT_OPTIONS);
}

export async function exactFinalizationHandleStat(handle) {
  if (!handle || typeof handle.stat !== 'function') {
    throw new Error('Evidence-finalization exact handle-stat capability is unavailable.');
  }
  return handle.stat(EXACT_STAT_OPTIONS);
}

function assertWritableManifestIdentity(information, { requireSingleLink = true } = {}) {
  if (
    !information.isFile() ||
    information.isSymbolicLink() ||
    !hasExactBigIntFields(information, ['birthtimeNs', 'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink', 'size']) ||
    information.nlink < 1n ||
    (requireSingleLink && information.nlink !== 1n) ||
    information.size < 0n
  ) {
    throw new Error('Evidence-finalization manifest must remain one singly linked regular non-reparse file.');
  }
}

function assertExactFinalizationFile(information, label, options) {
  try {
    assertWritableManifestIdentity(information, options);
  } catch (error) {
    throw new Error(`${label} must be one singly linked regular non-reparse file with exact bigint identity.`, {
      cause: error
    });
  }
}

async function lstatIfPresent(path) {
  try {
    return await exactFinalizationPathStat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readExactPhysicalDirectory(path, label) {
  const expected = resolve(path);
  let information;
  let actual;
  try {
    information = await exactFinalizationPathStat(expected);
    actual = await realpath(expected);
  } catch {
    throw new Error(`${label} is missing or cannot be physically resolved.`);
  }
  if (
    !information.isDirectory() ||
    information.isSymbolicLink() ||
    !hasExactBigIntFields(information, ['birthtimeNs', 'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink']) ||
    !sameHostPath(actual, expected)
  ) {
    throw new Error(`${label} must be one physical non-reparse directory.`);
  }
  return Object.freeze({ information, path: expected });
}

async function revalidateDirectory(identity, label) {
  const observed = await readExactPhysicalDirectory(identity.path, label);
  if (!sameNodeIdentity(identity.information, observed.information, { compareSize: false })) {
    throw new Error(`${label} identity changed during evidence finalization.`);
  }
}

async function readExactPhysicalFile(path, label, { requireSingleLink = true } = {}) {
  const expected = resolve(path);
  let before;
  let actual;
  try {
    before = await exactFinalizationPathStat(expected);
    actual = await realpath(expected);
  } catch {
    throw new Error(`${label} is missing or cannot be physically resolved.`);
  }
  assertExactFinalizationFile(before, label, { requireSingleLink });
  if (!sameHostPath(actual, expected)) throw new Error(`${label} must be one singly linked regular non-reparse file.`);
  let handle;
  try {
    handle = await open(expected, 'r');
  } catch {
    throw new Error(`${label} could not be opened exactly.`);
  }
  try {
    const opened = await exactFinalizationHandleStat(handle);
    assertExactFinalizationFile(opened, label, { requireSingleLink });
    const bytes = await handle.readFile();
    const after = await exactFinalizationHandleStat(handle);
    assertExactFinalizationFile(after, label, { requireSingleLink });
    const pathAfter = await exactFinalizationPathStat(expected);
    assertExactFinalizationFile(pathAfter, label, { requireSingleLink });
    const actualAfter = await realpath(expected);
    if (
      !sameExactFileIdentity(before, opened) ||
      !sameExactFileIdentity(opened, after) ||
      !sameExactFileIdentity(after, pathAfter) ||
      after.size !== BigInt(bytes.length) ||
      !sameHostPath(actualAfter, expected)
    ) {
      throw new Error(`${label} identity changed while hashing.`);
    }
    return Object.freeze({ bytes, information: after, sha256: sha256(bytes) });
  } finally {
    await handle.close();
  }
}

async function readExactPhysicalFileIfPresent(path, label, options) {
  try {
    return await readExactPhysicalFile(path, label, options);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.cause?.code === 'ENOENT') return null;
    throw error;
  }
}

function resolveContainedPath(repositoryRoot, repositoryPath) {
  const absolute = resolve(repositoryRoot, ...repositoryPath.split('/'));
  const relation = relative(repositoryRoot, absolute);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error('Evidence-finalization path escapes or equals its repository root.');
  }
  return absolute;
}

function cloneExactJsonRecord(value, label) {
  assertPlainJson(value, label);
  return JSON.parse(JSON.stringify(value));
}

function assertPlainJson(value, label) {
  if (!isPlainRecord(value)) throw new Error(`${label} must be one plain JSON object.`);
  const seen = new Set();
  visitPlainJson(value, label, seen);
}

function visitPlainJson(value, label, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value))
      throw new Error(`${label} contains a non-exact number.`);
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) throw new Error(`${label} is not an acyclic JSON value.`);
  seen.add(value);
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const keys = Object.keys(value);
    if (
      keys.length !== value.length ||
      keys.some((key, index) => key !== String(index)) ||
      Reflect.ownKeys(value).length !== value.length + 1 ||
      !Object.hasOwn(descriptors, 'length') ||
      lengthDescriptor?.enumerable !== false ||
      Object.entries(descriptors).some(
        ([key, descriptor]) =>
          key !== 'length' && (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)
      )
    ) {
      throw new Error(`${label} contains a sparse, accessor-backed, or extended array.`);
    }
    for (const child of value) visitPlainJson(child, label, seen);
    seen.delete(value);
    return;
  }
  if (!isPlainRecord(value)) throw new Error(`${label} contains a non-plain value.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true
    ) ||
    Object.keys(descriptors).length !== Object.keys(value).length
  ) {
    throw new Error(`${label} contains accessors or hidden properties.`);
  }
  for (const child of Object.values(value)) visitPlainJson(child, label, seen);
  seen.delete(value);
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expected, label) {
  if (
    !isPlainRecord(value) ||
    !exactArray(Object.keys(value).sort(compareStrings), [...expected].sort(compareStrings))
  ) {
    throw new Error(`${label} keys differ from the exact schema.`);
  }
}

function assertExactIsoTimestamp(value) {
  if (typeof value !== 'string')
    throw new Error('Evidence finalization requires one externally supplied exact UTC time.');
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error('Evidence finalization time must be one exact canonical UTC timestamp.');
  }
  return value;
}

function sameHostPath(left, right) {
  return normalizedHostPath(left) === normalizedHostPath(right);
}

function normalizedHostPath(value) {
  const exact = resolve(value);
  return process.platform === 'win32' ? exact.toLowerCase() : exact;
}

function sameExactDirectoryIdentity(left, right) {
  const fields = ['birthtimeNs', 'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink'];
  if (!hasExactBigIntFields(left, fields) || !hasExactBigIntFields(right, fields)) return false;
  return (
    fields.every((field) => left[field] === right[field]) && (left.ino !== 0n || left.birthtimeNs === right.birthtimeNs)
  );
}

function sameNodeIdentity(left, right, { compareLinks = true, compareSize }) {
  const fields = ['birthtimeNs', 'dev', 'ino', 'mode', 'nlink', 'size'];
  if (!hasExactBigIntFields(left, fields) || !hasExactBigIntFields(right, fields)) return false;
  if (
    left.dev !== right.dev ||
    left.ino !== right.ino ||
    left.mode !== right.mode ||
    (compareLinks && left.nlink !== right.nlink)
  ) {
    return false;
  }
  if (compareSize && left.size !== right.size) return false;
  return left.ino !== 0n || left.birthtimeNs === right.birthtimeNs;
}

export function sameExactFileIdentity(left, right) {
  const fields = ['birthtimeNs', 'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink', 'size'];
  if (!hasExactBigIntFields(left, fields) || !hasExactBigIntFields(right, fields)) return false;
  return fields.every((field) => left[field] === right[field]);
}

function hasExactBigIntFields(value, fields) {
  return Boolean(value) && fields.every((field) => typeof value[field] === 'bigint');
}

function permissionMode(information) {
  if (!hasExactBigIntFields(information, ['mode'])) {
    throw new Error('Evidence-finalization file lacks an exact bigint permission mode.');
  }
  return Number(information.mode & 0o777n);
}

function exactArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) && JSON.stringify(left) === JSON.stringify(right);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

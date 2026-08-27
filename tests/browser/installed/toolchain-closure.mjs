import { createHash } from 'node:crypto';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, posix, relative, resolve, sep } from 'node:path';

import { assertNativeAbsolutePath, isNativeLocalAbsolutePath } from './path-contract.mjs';

export const INSTALLED_BROWSER_TOOLCHAIN_CLOSURE_SCHEMA = 'sitewipe.installed-browser-toolchain-closure.v1';
export const INSTALLED_BROWSER_TOOLCHAIN_SET_SCHEMA = 'sitewipe.installed-browser-toolchain-set.v1';
export const PINNED_PUPPETEER_CORE_VERSION = '25.8.0';

export const INSTALLED_BROWSER_TOOLCHAIN_SUMMARY_KEYS = Object.freeze([
  'toolchainBytes',
  'toolchainFileCount',
  'toolchainManifestSha256',
  'toolchainPackageCount',
  'toolchainPuppeteerVersion',
  'toolchainSetSha256'
]);

const ROOT_PACKAGE_LOCK_PATH = 'node_modules/puppeteer-core';
const CLOSURE_KEYS = Object.freeze([
  'bytes',
  'fileCount',
  'manifestSha256',
  'nodeModulesPath',
  'packageCount',
  'packageLockPath',
  'packages',
  'puppeteerVersion',
  'schema',
  'setSha256'
]);
const PACKAGE_KEYS = Object.freeze([
  'bytes',
  'fileCount',
  'files',
  'lockPath',
  'name',
  'packagePath',
  'runtimeDependencies',
  'version'
]);
const DEPENDENCY_KEYS = Object.freeze(['kind', 'name', 'requested', 'resolvedLockPath']);
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
const RUNTIME_FIELDS = Object.freeze([
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta'
]);
const DEPENDENCY_KINDS = new Set(['dependency', 'optionalDependency', 'optionalPeerDependency', 'peerDependency']);

export async function captureInstalledBrowserToolchainClosure(options, testHooks = null) {
  assertExactKeys(options, ['nodeModulesPath', 'packageLockPath'], 'Installed-browser toolchain capture options');
  validateCaptureTestHooks(testHooks);
  return captureSnapshot(options, testHooks);
}

export async function verifyInstalledBrowserToolchainClosure(closure) {
  validateInstalledBrowserToolchainClosure(closure);
  const observed = await captureSnapshot({
    packageLockPath: closure.packageLockPath,
    nodeModulesPath: closure.nodeModulesPath
  });
  if (!sameCanonicalValue(observed, closure)) {
    throw new Error('Installed-browser toolchain files, dependency graph, or physical identities have drifted.');
  }
  return closure;
}

export function validateInstalledBrowserToolchainClosure(closure) {
  assertExactKeys(closure, CLOSURE_KEYS, 'Installed-browser toolchain closure');
  if (
    closure.schema !== INSTALLED_BROWSER_TOOLCHAIN_CLOSURE_SCHEMA ||
    !isNativeLocalAbsolutePath(closure.packageLockPath) ||
    !isNativeLocalAbsolutePath(closure.nodeModulesPath) ||
    basename(closure.packageLockPath) !== 'package-lock.json' ||
    !samePath(resolve(dirname(closure.packageLockPath), 'node_modules'), closure.nodeModulesPath) ||
    closure.puppeteerVersion !== PINNED_PUPPETEER_CORE_VERSION ||
    !Number.isSafeInteger(closure.packageCount) ||
    closure.packageCount <= 0 ||
    !Number.isSafeInteger(closure.fileCount) ||
    closure.fileCount <= 0 ||
    !Number.isSafeInteger(closure.bytes) ||
    closure.bytes <= 0 ||
    !Array.isArray(closure.packages) ||
    closure.packages.length !== closure.packageCount ||
    !isSha256(closure.setSha256) ||
    !isSha256(closure.manifestSha256)
  ) {
    throw new Error('Installed-browser toolchain closure has an invalid root, version, count, byte total, or digest.');
  }

  const repositoryRootPath = dirname(closure.packageLockPath);
  const packagePaths = [];
  const packageNamesByLockPath = new Map();
  const caseInsensitivePackagePaths = new Set();
  const caseInsensitiveFilePaths = new Set();
  let observedFileCount = 0;
  let observedBytes = 0;

  for (const entry of closure.packages) {
    assertExactKeys(entry, PACKAGE_KEYS, 'Installed-browser toolchain package');
    if (
      !isNormalizedPackageLockPath(entry.lockPath) ||
      !isPackageName(entry.name) ||
      packageNameFromLockPath(entry.lockPath) !== entry.name ||
      !isPackageVersion(entry.version) ||
      !isNativeLocalAbsolutePath(entry.packagePath) ||
      !samePath(resolve(repositoryRootPath, ...entry.lockPath.split('/')), entry.packagePath) ||
      !Number.isSafeInteger(entry.fileCount) ||
      entry.fileCount <= 0 ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes <= 0 ||
      !Array.isArray(entry.runtimeDependencies) ||
      !Array.isArray(entry.files) ||
      entry.files.length !== entry.fileCount
    ) {
      throw new Error('Installed-browser toolchain closure contains a malformed package identity.');
    }
    const foldedPackagePath = entry.lockPath.toLowerCase();
    if (caseInsensitivePackagePaths.has(foldedPackagePath)) {
      throw new Error('Installed-browser toolchain closure contains a case-insensitive package-path collision.');
    }
    caseInsensitivePackagePaths.add(foldedPackagePath);
    packagePaths.push(entry.lockPath);
    packageNamesByLockPath.set(entry.lockPath, entry.name);

    validateRuntimeDependencies(entry.runtimeDependencies);
    const filePaths = [];
    let packageBytes = 0;
    for (const file of entry.files) {
      assertExactKeys(file, FILE_KEYS, 'Installed-browser toolchain file');
      if (
        !isNormalizedRelativePath(file.relativePath) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0 ||
        !isSha256(file.sha256)
      ) {
        throw new Error('Installed-browser toolchain closure contains a malformed file identity.');
      }
      const logicalPath = `${entry.lockPath}/${file.relativePath}`;
      const foldedFilePath = logicalPath.toLowerCase();
      if (caseInsensitiveFilePaths.has(foldedFilePath)) {
        throw new Error('Installed-browser toolchain closure contains a case-insensitive file-path collision.');
      }
      caseInsensitiveFilePaths.add(foldedFilePath);
      filePaths.push(file.relativePath);
      packageBytes = safeAdd(packageBytes, file.bytes, 'Installed-browser toolchain package byte total');
    }
    assertSortedUnique(filePaths, 'Installed-browser toolchain package files');
    if (!filePaths.includes('package.json')) {
      throw new Error('Installed-browser toolchain package does not contain its exact package.json file.');
    }
    if (packageBytes !== entry.bytes) {
      throw new Error('Installed-browser toolchain package byte total differs from its files.');
    }
    observedFileCount = safeAdd(observedFileCount, entry.fileCount, 'Installed-browser toolchain file count');
    observedBytes = safeAdd(observedBytes, entry.bytes, 'Installed-browser toolchain byte total');
  }

  assertSortedUnique(packagePaths, 'Installed-browser toolchain packages');
  if (observedFileCount !== closure.fileCount || observedBytes !== closure.bytes) {
    throw new Error('Installed-browser toolchain aggregate counts differ from its packages.');
  }
  const rootPackage = closure.packages.find(({ lockPath }) => lockPath === ROOT_PACKAGE_LOCK_PATH);
  if (!rootPackage || rootPackage.name !== 'puppeteer-core' || rootPackage.version !== PINNED_PUPPETEER_CORE_VERSION) {
    throw new Error('Installed-browser toolchain closure lacks exact puppeteer-core 25.8.0.');
  }

  for (const entry of closure.packages) {
    for (const dependency of entry.runtimeDependencies) {
      if (dependency.resolvedLockPath === null) continue;
      const resolvedName = packageNamesByLockPath.get(dependency.resolvedLockPath);
      if (!resolvedName || resolvedName !== dependency.name) {
        throw new Error('Installed-browser toolchain dependency resolves outside the captured package set.');
      }
    }
  }
  assertExactReachability(closure.packages);

  if (computeInstalledBrowserToolchainSetSha256(closure) !== closure.setSha256) {
    throw new Error('Installed-browser toolchain set SHA-256 differs from its canonical path-free package set.');
  }
  const unsigned = { ...closure };
  delete unsigned.manifestSha256;
  if (sha256(canonicalJsonBytes(unsigned)) !== closure.manifestSha256) {
    throw new Error('Installed-browser toolchain manifest SHA-256 differs from its canonical payload.');
  }
  return closure;
}

export function installedBrowserToolchainClosureSummary(closure) {
  validateInstalledBrowserToolchainClosure(closure);
  return Object.freeze({
    toolchainPuppeteerVersion: closure.puppeteerVersion,
    toolchainPackageCount: closure.packageCount,
    toolchainFileCount: closure.fileCount,
    toolchainBytes: closure.bytes,
    toolchainManifestSha256: closure.manifestSha256,
    toolchainSetSha256: closure.setSha256
  });
}

export function validateInstalledBrowserToolchainSummary(summary) {
  assertExactKeys(summary, INSTALLED_BROWSER_TOOLCHAIN_SUMMARY_KEYS, 'Installed-browser toolchain summary');
  if (
    summary.toolchainPuppeteerVersion !== PINNED_PUPPETEER_CORE_VERSION ||
    !Number.isSafeInteger(summary.toolchainPackageCount) ||
    summary.toolchainPackageCount <= 0 ||
    !Number.isSafeInteger(summary.toolchainFileCount) ||
    summary.toolchainFileCount <= 0 ||
    !Number.isSafeInteger(summary.toolchainBytes) ||
    summary.toolchainBytes <= 0 ||
    !isSha256(summary.toolchainManifestSha256) ||
    !isSha256(summary.toolchainSetSha256)
  ) {
    throw new Error('Installed-browser toolchain summary is incomplete or malformed.');
  }
  return summary;
}

export function computeInstalledBrowserToolchainSetSha256(closure) {
  if (!closure || typeof closure !== 'object' || !Array.isArray(closure.packages)) {
    throw new Error('Installed-browser toolchain set requires a closure package array.');
  }
  return sha256(
    canonicalJsonBytes({
      schema: INSTALLED_BROWSER_TOOLCHAIN_SET_SCHEMA,
      puppeteerVersion: closure.puppeteerVersion,
      packages: closure.packages.map((entry) => ({
        lockPath: entry.lockPath,
        name: entry.name,
        version: entry.version,
        runtimeDependencies: entry.runtimeDependencies,
        files: entry.files
      }))
    })
  );
}

async function captureSnapshot({ packageLockPath, nodeModulesPath }, testHooks = null) {
  const normalizedPackageLockPath = normalizeExactInputPath(packageLockPath, 'Package-lock path');
  const normalizedNodeModulesPath = normalizeExactInputPath(nodeModulesPath, 'Node-modules path');
  if (
    basename(normalizedPackageLockPath) !== 'package-lock.json' ||
    !samePath(resolve(dirname(normalizedPackageLockPath), 'node_modules'), normalizedNodeModulesPath)
  ) {
    throw new Error('Package-lock and node-modules paths must be exact siblings in one project root.');
  }
  const initialManifest = await captureToolchainManifest(
    {
      packageLockPath: normalizedPackageLockPath,
      nodeModulesPath: normalizedNodeModulesPath
    },
    testHooks
  );
  if (testHooks?.afterInitialManifest) await testHooks.afterInitialManifest();
  const replayedManifest = await captureToolchainManifest({
    packageLockPath: normalizedPackageLockPath,
    nodeModulesPath: normalizedNodeModulesPath
  });
  assertExactToolchainManifestReplay(initialManifest, replayedManifest);

  const packages = initialManifest.packages;
  const unsignedWithoutSet = {
    schema: INSTALLED_BROWSER_TOOLCHAIN_CLOSURE_SCHEMA,
    packageLockPath: normalizedPackageLockPath,
    nodeModulesPath: normalizedNodeModulesPath,
    puppeteerVersion: PINNED_PUPPETEER_CORE_VERSION,
    packageCount: packages.length,
    fileCount: packages.reduce(
      (total, entry) => safeAdd(total, entry.fileCount, 'Installed-browser toolchain file count'),
      0
    ),
    bytes: packages.reduce((total, entry) => safeAdd(total, entry.bytes, 'Installed-browser toolchain byte total'), 0),
    packages
  };
  const setSha256 = computeInstalledBrowserToolchainSetSha256(unsignedWithoutSet);
  const unsigned = { ...unsignedWithoutSet, setSha256 };
  const closure = { ...unsigned, manifestSha256: sha256(canonicalJsonBytes(unsigned)) };
  validateInstalledBrowserToolchainClosure(closure);
  return deepFreeze(closure);
}

async function captureToolchainManifest({ packageLockPath, nodeModulesPath }, testHooks = null) {
  const repositoryRootPath = dirname(packageLockPath);
  const projectRootBefore = await exactPhysicalDirectory(repositoryRootPath, 'Project root');
  const nodeModulesBefore = await exactPhysicalDirectory(nodeModulesPath, 'Node-modules root');
  const normalizedPackageLockPath = packageLockPath;
  const initialLock = await readJsonPhysicalFile(normalizedPackageLockPath, 'Package lock');
  const initialGraph = await deriveInstalledRuntimeGraph(initialLock.value, repositoryRootPath);
  const globalPhysicalFiles = new Set();
  const packages = [];
  const directories = [
    { path: projectRootBefore.path, identity: projectRootBefore.identity },
    { path: nodeModulesBefore.path, identity: nodeModulesBefore.identity }
  ];
  const physicalFiles = [
    {
      path: normalizedPackageLockPath,
      bytes: initialLock.bytes,
      sha256: initialLock.sha256,
      identity: initialLock.information
    }
  ];

  for (const graphPackage of initialGraph) {
    const packagePath = resolve(repositoryRootPath, ...graphPackage.lockPath.split('/'));
    const packageRoot = await exactPhysicalDirectory(packagePath, `Runtime package ${graphPackage.name}`);
    const packageJsonPath = resolve(packagePath, 'package.json');
    const packageJson = await readJsonPhysicalFile(packageJsonPath, `${graphPackage.name} package.json`);
    assertInstalledPackageMetadata(packageJson.value, graphPackage);
    const physicalPackageFiles = [];
    const packageDirectories = [];
    const caseInsensitivePaths = new Set();
    await walkPhysicalPackage(
      packagePath,
      packagePath,
      physicalPackageFiles,
      packageDirectories,
      caseInsensitivePaths,
      globalPhysicalFiles
    );
    physicalPackageFiles.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
    packageDirectories.sort((left, right) => compareStrings(left.path, right.path));
    const capturedRoot = packageDirectories.find(({ path }) => samePath(path, packagePath));
    if (!capturedRoot || !sameStablePhysicalIdentity(packageRoot.identity, capturedRoot.identity)) {
      throw new Error(`${graphPackage.name} package directory drifted before its manifest was captured.`);
    }
    const capturedPackageJson = physicalPackageFiles.find(({ relativePath }) => relativePath === 'package.json');
    if (
      !capturedPackageJson ||
      capturedPackageJson.bytes !== packageJson.bytes ||
      capturedPackageJson.sha256 !== packageJson.sha256 ||
      !sameStablePhysicalIdentity(capturedPackageJson.identity, packageJson.information)
    ) {
      throw new Error(`${graphPackage.name} package.json drifted while the toolchain closure was captured.`);
    }
    const files = physicalPackageFiles.map(({ relativePath, bytes, sha256: digest }) => ({
      relativePath,
      bytes,
      sha256: digest
    }));
    const bytes = files.reduce(
      (total, file) => safeAdd(total, file.bytes, `${graphPackage.name} package byte total`),
      0
    );
    packages.push({
      lockPath: graphPackage.lockPath,
      packagePath,
      name: graphPackage.name,
      version: graphPackage.version,
      runtimeDependencies: graphPackage.runtimeDependencies,
      fileCount: files.length,
      bytes,
      files
    });
    directories.push(...packageDirectories);
    physicalFiles.push(...physicalPackageFiles);
    if (testHooks?.afterPackageCaptured) {
      await testHooks.afterPackageCaptured(Object.freeze({ lockPath: graphPackage.lockPath, name: graphPackage.name }));
    }
  }

  packages.sort((left, right) => compareStrings(left.lockPath, right.lockPath));
  const finalLock = await readJsonPhysicalFile(normalizedPackageLockPath, 'Package lock');
  const finalGraph = await deriveInstalledRuntimeGraph(finalLock.value, repositoryRootPath);
  if (
    !sameCanonicalValue(initialGraph, finalGraph) ||
    initialLock.bytes !== finalLock.bytes ||
    initialLock.sha256 !== finalLock.sha256 ||
    !sameStablePhysicalIdentity(initialLock.information, finalLock.information)
  ) {
    throw new Error('Reachable package-lock dependency data drifted while the toolchain closure was captured.');
  }
  const nodeModulesAfter = await exactPhysicalDirectory(nodeModulesPath, 'Node-modules root');
  const projectRootAfter = await exactPhysicalDirectory(repositoryRootPath, 'Project root');
  if (
    !sameStablePhysicalIdentity(nodeModulesBefore.identity, nodeModulesAfter.identity) ||
    !sameStablePhysicalIdentity(projectRootBefore.identity, projectRootAfter.identity)
  ) {
    throw new Error('Installed-browser toolchain root directory drifted while its manifest was captured.');
  }
  await revalidateToolchainManifestIdentities({ directories, physicalFiles });
  directories.sort((left, right) => compareStrings(left.path, right.path));
  physicalFiles.sort((left, right) => compareStrings(left.path, right.path));
  return deepFreeze({
    graph: initialGraph,
    packageLock: physicalFiles.find(({ path }) => samePath(path, normalizedPackageLockPath)),
    packages,
    directories,
    physicalFiles
  });
}

async function revalidateToolchainManifestIdentities({ directories, physicalFiles }) {
  for (const directory of directories) {
    const observed = await exactPhysicalDirectory(directory.path, 'Installed-browser toolchain replay directory');
    if (!sameStablePhysicalIdentity(directory.identity, observed.identity)) {
      throw new Error('Installed-browser toolchain directory identity drifted before manifest settlement.');
    }
  }
  for (const file of physicalFiles) {
    const observed = await lstat(file.path, { bigint: true });
    if (
      !observed.isFile() ||
      observed.isSymbolicLink() ||
      observed.nlink !== 1n ||
      !sameStablePhysicalIdentity(
        file.identity,
        stablePhysicalIdentity(observed, 'Installed-browser toolchain replay file identity')
      ) ||
      !samePath(await realpath(file.path), file.path)
    ) {
      throw new Error('Installed-browser toolchain file identity drifted before manifest settlement.');
    }
  }
}

function assertExactToolchainManifestReplay(initial, replayed) {
  if (!sameCanonicalValue(initial.graph, replayed.graph) || !sameCanonicalValue(initial.packages, replayed.packages)) {
    throw new Error('Installed-browser toolchain graph or package manifest drifted before final replay.');
  }
  assertExactPhysicalFileReplay(initial.packageLock, replayed.packageLock, 'Package lock');
  if (
    initial.directories.length !== replayed.directories.length ||
    initial.physicalFiles.length !== replayed.physicalFiles.length
  ) {
    throw new Error('Installed-browser toolchain physical manifest entry set drifted before final replay.');
  }
  for (let index = 0; index < initial.directories.length; index += 1) {
    const expected = initial.directories[index];
    const observed = replayed.directories[index];
    if (!samePath(expected.path, observed.path) || !sameStablePhysicalIdentity(expected.identity, observed.identity)) {
      throw new Error('Installed-browser toolchain directory identity drifted before final replay.');
    }
  }
  for (let index = 0; index < initial.physicalFiles.length; index += 1) {
    assertExactPhysicalFileReplay(
      initial.physicalFiles[index],
      replayed.physicalFiles[index],
      'Installed-browser toolchain file'
    );
  }
}

function assertExactPhysicalFileReplay(expected, observed, label) {
  if (
    !expected ||
    !observed ||
    !samePath(expected.path, observed.path) ||
    expected.bytes !== observed.bytes ||
    expected.sha256 !== observed.sha256 ||
    !sameStablePhysicalIdentity(expected.identity, observed.identity)
  ) {
    throw new Error(`${label} identity or bytes drifted before final replay.`);
  }
}

function validateCaptureTestHooks(testHooks) {
  if (testHooks === null) return;
  assertExactKeys(
    testHooks,
    ['afterInitialManifest', 'afterPackageCaptured'],
    'Installed-browser toolchain closure test hooks'
  );
  for (const key of ['afterInitialManifest', 'afterPackageCaptured']) {
    if (testHooks[key] !== null && typeof testHooks[key] !== 'function') {
      throw new Error('Installed-browser toolchain closure test hook is malformed.');
    }
  }
}

async function deriveInstalledRuntimeGraph(lock, repositoryRootPath) {
  if (
    !isPlainObject(lock) ||
    lock.lockfileVersion !== 3 ||
    !isPlainObject(lock.packages) ||
    !isPlainObject(lock.packages[''])
  ) {
    throw new Error('Package lock must be an npm lockfileVersion 3 object with a root package entry.');
  }
  assertExactRootPuppeteerDeclaration(lock.packages['']);
  const lockPathAliases = indexLockPathAliases(lock.packages);
  const graph = new Map();
  const queue = [ROOT_PACKAGE_LOCK_PATH];

  while (queue.length > 0) {
    const lockPath = queue.shift();
    if (graph.has(lockPath)) continue;
    assertNoLockPathAlias(lockPath, lockPathAliases);
    const lockEntry = lock.packages[lockPath];
    if (!isPlainObject(lockEntry) || !isNormalizedPackageLockPath(lockPath)) {
      throw new Error(`Reachable package-lock entry is missing or malformed: ${lockPath}`);
    }
    const name = packageNameFromLockPath(lockPath);
    if (!isPackageVersion(lockEntry.version)) {
      throw new Error(`Reachable package-lock entry lacks an exact version: ${lockPath}`);
    }
    rejectBundledDependencies(lockEntry, `Package-lock entry ${lockPath}`);
    const declarations = runtimeDependencyDeclarations(lockEntry, `Package-lock entry ${lockPath}`);
    const runtimeDependencies = [];
    for (const declaration of declarations) {
      const resolvedLockPath = await resolveInstalledRuntimeDependency({
        fromLockPath: lockPath,
        dependency: declaration,
        lockPackages: lock.packages,
        lockPathAliases,
        repositoryRootPath
      });
      runtimeDependencies.push({ ...declaration, resolvedLockPath });
      if (resolvedLockPath !== null) queue.push(resolvedLockPath);
    }
    runtimeDependencies.sort((left, right) => compareStrings(left.name, right.name));
    graph.set(lockPath, {
      lockPath,
      name,
      version: lockEntry.version,
      runtimeDependencies,
      runtimeFields: normalizedRuntimeFields(lockEntry, `Package-lock entry ${lockPath}`)
    });
  }

  const result = [...graph.values()].sort((left, right) => compareStrings(left.lockPath, right.lockPath));
  const root = result.find(({ lockPath }) => lockPath === ROOT_PACKAGE_LOCK_PATH);
  if (!root || root.version !== PINNED_PUPPETEER_CORE_VERSION) {
    throw new Error('Package lock does not resolve exact puppeteer-core 25.8.0.');
  }
  return result;
}

async function resolveInstalledRuntimeDependency({
  fromLockPath,
  dependency,
  lockPackages,
  lockPathAliases,
  repositoryRootPath
}) {
  for (const candidate of dependencyResolutionCandidates(fromLockPath, dependency.name)) {
    const physicalPath = resolve(repositoryRootPath, ...candidate.split('/'));
    const information = await optionalLstat(physicalPath);
    if (!information) continue;
    assertNoLockPathAlias(candidate, lockPathAliases);
    if (!Object.prototype.hasOwnProperty.call(lockPackages, candidate)) {
      throw new Error(`Installed runtime dependency is not represented by its exact package-lock path: ${candidate}`);
    }
    return candidate;
  }
  if (isOptionalDependencyKind(dependency.kind)) return null;
  throw new Error(`Required runtime dependency is not physically installed: ${fromLockPath} -> ${dependency.name}`);
}

function runtimeDependencyDeclarations(value, label) {
  const fields = normalizedRuntimeFields(value, label);
  const declarations = new Map();
  for (const [name, requested] of Object.entries(fields.dependencies)) {
    declarations.set(name, { kind: 'dependency', name, requested });
  }
  for (const [name, requested] of Object.entries(fields.optionalDependencies)) {
    declarations.set(name, { kind: 'optionalDependency', name, requested });
  }
  for (const [name, requested] of Object.entries(fields.peerDependencies)) {
    if (declarations.has(name)) continue;
    declarations.set(name, {
      kind: fields.peerDependenciesMeta[name]?.optional === true ? 'optionalPeerDependency' : 'peerDependency',
      name,
      requested
    });
  }
  return [...declarations.values()].sort((left, right) => compareStrings(left.name, right.name));
}

function normalizedRuntimeFields(value, label) {
  const result = {};
  for (const field of RUNTIME_FIELDS.slice(0, 3)) {
    const observed = value[field] ?? {};
    if (!isPlainObject(observed)) throw new Error(`${label} ${field} must be an object when present.`);
    const normalized = {};
    for (const [name, requested] of Object.entries(observed)) {
      if (!isPackageName(name) || !isSafeMetadataString(requested, 1024)) {
        throw new Error(`${label} contains an invalid ${field} declaration.`);
      }
      normalized[name] = requested;
    }
    result[field] = normalized;
  }
  const peerDependenciesMeta = value.peerDependenciesMeta ?? {};
  if (!isPlainObject(peerDependenciesMeta)) {
    throw new Error(`${label} peerDependenciesMeta must be an object when present.`);
  }
  result.peerDependenciesMeta = {};
  for (const [name, metadata] of Object.entries(peerDependenciesMeta)) {
    if (
      !Object.prototype.hasOwnProperty.call(result.peerDependencies, name) ||
      !isPlainObject(metadata) ||
      JSON.stringify(Object.keys(metadata).sort()) !== JSON.stringify(['optional']) ||
      metadata.optional !== true
    ) {
      throw new Error(`${label} contains unsupported or malformed peer dependency metadata.`);
    }
    result.peerDependenciesMeta[name] = { optional: true };
  }
  return result;
}

function assertInstalledPackageMetadata(packageJson, graphPackage) {
  if (
    !isPlainObject(packageJson) ||
    packageJson.name !== graphPackage.name ||
    packageJson.version !== graphPackage.version
  ) {
    throw new Error(`${graphPackage.name} package.json identity differs from package-lock.`);
  }
  rejectBundledDependencies(packageJson, `${graphPackage.name} package.json`);
  const installedFields = normalizedRuntimeFields(packageJson, `${graphPackage.name} package.json`);
  if (!sameCanonicalValue(installedFields, graphPackage.runtimeFields)) {
    throw new Error(`${graphPackage.name} package.json runtime dependency declarations differ from package-lock.`);
  }
}

async function walkPhysicalPackage(root, current, files, directories, caseInsensitivePaths, globalPhysicalFiles) {
  const before = await exactPhysicalDirectory(current, 'Runtime package directory');
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((left, right) => compareStrings(left.name, right.name));
  for (const entry of entries) {
    const absolutePath = resolve(current, entry.name);
    const information = await lstat(absolutePath, { bigint: true });
    if (
      entry.isSymbolicLink() ||
      information.isSymbolicLink() ||
      !samePath(await realpath(absolutePath), absolutePath)
    ) {
      throw new Error('Installed-browser toolchain contains a symbolic link, reparse alias, or redirected entry.');
    }
    if (information.isDirectory()) {
      if (samePath(current, root) && entry.name === 'node_modules') {
        const dependencyDirectory = await exactPhysicalDirectory(absolutePath, 'Runtime dependency directory');
        directories.push({ path: dependencyDirectory.path, identity: dependencyDirectory.identity });
        continue;
      }
      await walkPhysicalPackage(root, absolutePath, files, directories, caseInsensitivePaths, globalPhysicalFiles);
      continue;
    }
    if (!information.isFile() || information.nlink !== 1n) {
      throw new Error('Installed-browser toolchain contains a non-regular or multiply linked file.');
    }
    const relativePath = relative(root, absolutePath).split(sep).join('/');
    if (!isNormalizedRelativePath(relativePath)) {
      throw new Error('Installed-browser toolchain contains an invalid package-relative file path.');
    }
    const folded = relativePath.toLowerCase();
    if (caseInsensitivePaths.has(folded)) {
      throw new Error('Installed-browser toolchain contains a case-insensitive file-path collision.');
    }
    caseInsensitivePaths.add(folded);
    const identity = await exactOpenedFileIdentity(absolutePath, information);
    const physicalIdentity = stablePhysicalFileIdentity(identity.information);
    if (physicalIdentity && globalPhysicalFiles.has(physicalIdentity)) {
      throw new Error('Installed-browser toolchain contains an aliased or multiply referenced physical file.');
    }
    if (physicalIdentity) globalPhysicalFiles.add(physicalIdentity);
    files.push({
      path: absolutePath,
      relativePath,
      bytes: identity.bytes,
      sha256: identity.sha256,
      identity: identity.information
    });
  }
  const after = await exactPhysicalDirectory(current, 'Runtime package directory');
  if (!sameStablePhysicalIdentity(before.identity, after.identity)) {
    throw new Error('Installed-browser toolchain directory drifted while its files were captured.');
  }
  directories.push({ path: after.path, identity: after.identity });
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

async function readJsonPhysicalFile(path, label) {
  const before = await lstat(path, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || !samePath(await realpath(path), path)) {
    throw new Error(`${label} must be one exact physical, singly linked regular file.`);
  }
  const identity = await exactOpenedFileIdentity(path, before, true);
  let value;
  try {
    value = JSON.parse(identity.content.toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  return Object.freeze({
    value,
    bytes: identity.bytes,
    sha256: identity.sha256,
    information: identity.information
  });
}

async function exactOpenedFileIdentity(path, before, includeContent = false) {
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameFileIdentity(before, opened)) {
      throw new Error('Installed-browser toolchain file identity changed before hashing.');
    }
    const hash = createHash('sha256');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      if (includeContent) chunks.push(chunk);
      bytes = safeAdd(bytes, chunk.length, 'Installed-browser toolchain file byte count');
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
      throw new Error('Installed-browser toolchain file identity changed while hashing.');
    }
    return Object.freeze({
      bytes,
      sha256: hash.digest('hex').toUpperCase(),
      content: includeContent ? Buffer.concat(chunks, bytes) : undefined,
      information: stablePhysicalIdentity(after, 'Installed-browser toolchain file identity')
    });
  } finally {
    await handle.close();
  }
}

function validateRuntimeDependencies(dependencies) {
  const names = [];
  for (const dependency of dependencies) {
    assertExactKeys(dependency, DEPENDENCY_KEYS, 'Installed-browser toolchain runtime dependency');
    if (
      !DEPENDENCY_KINDS.has(dependency.kind) ||
      !isPackageName(dependency.name) ||
      !isSafeMetadataString(dependency.requested, 1024) ||
      (dependency.resolvedLockPath !== null && !isNormalizedPackageLockPath(dependency.resolvedLockPath)) ||
      (dependency.resolvedLockPath === null && !isOptionalDependencyKind(dependency.kind))
    ) {
      throw new Error('Installed-browser toolchain closure contains a malformed runtime dependency.');
    }
    names.push(dependency.name);
  }
  assertSortedUnique(names, 'Installed-browser toolchain runtime dependencies');
}

function assertExactReachability(packages) {
  const byPath = new Map(packages.map((entry) => [entry.lockPath, entry]));
  const visited = new Set();
  const queue = [ROOT_PACKAGE_LOCK_PATH];
  while (queue.length > 0) {
    const lockPath = queue.shift();
    if (visited.has(lockPath)) continue;
    const entry = byPath.get(lockPath);
    if (!entry) throw new Error('Installed-browser toolchain dependency graph is incomplete.');
    visited.add(lockPath);
    for (const dependency of entry.runtimeDependencies) {
      if (dependency.resolvedLockPath !== null) queue.push(dependency.resolvedLockPath);
    }
  }
  if (visited.size !== packages.length) {
    throw new Error('Installed-browser toolchain closure contains packages outside the reachable runtime graph.');
  }
}

function assertExactRootPuppeteerDeclaration(root) {
  const declarations = [];
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const value = root[field];
    if (value !== undefined && !isPlainObject(value)) {
      throw new Error(`Package-lock root ${field} must be an object when present.`);
    }
    if (Object.prototype.hasOwnProperty.call(value ?? {}, 'puppeteer-core')) {
      declarations.push(value['puppeteer-core']);
    }
  }
  if (declarations.length !== 1 || declarations[0] !== PINNED_PUPPETEER_CORE_VERSION) {
    throw new Error('Package-lock root must declare exact puppeteer-core 25.8.0 once.');
  }
}

function rejectBundledDependencies(value, label) {
  for (const field of ['bundleDependencies', 'bundledDependencies']) {
    if (value[field] !== undefined && (!Array.isArray(value[field]) || value[field].length > 0)) {
      throw new Error(`${label} uses unsupported bundled dependency metadata.`);
    }
  }
}

function dependencyResolutionCandidates(fromLockPath, dependencyName) {
  const candidates = [];
  let cursor = fromLockPath;
  while (true) {
    candidates.push(`${cursor}/node_modules/${dependencyName}`);
    const marker = cursor.lastIndexOf('/node_modules/');
    if (marker < 0) break;
    cursor = cursor.slice(0, marker);
  }
  candidates.push(`node_modules/${dependencyName}`);
  return [...new Set(candidates)];
}

function indexLockPathAliases(packages) {
  const result = new Map();
  for (const key of Object.keys(packages)) {
    if (key === '') continue;
    const folded = key.toLowerCase();
    const aliases = result.get(folded) ?? [];
    aliases.push(key);
    result.set(folded, aliases);
  }
  return result;
}

function assertNoLockPathAlias(lockPath, aliases) {
  const observed = aliases.get(lockPath.toLowerCase()) ?? [];
  if (observed.length > 1 || (observed.length === 1 && observed[0] !== lockPath)) {
    throw new Error(`Package lock contains a case-insensitive alias or collision for ${lockPath}.`);
  }
}

function packageNameFromLockPath(lockPath) {
  const leaf = lockPath.slice(lockPath.lastIndexOf('/node_modules/') + '/node_modules/'.length);
  const rootLeaf = leaf === lockPath ? lockPath.slice('node_modules/'.length) : leaf;
  return rootLeaf;
}

function isNormalizedPackageLockPath(value) {
  if (typeof value !== 'string' || !value.startsWith('node_modules/') || !isNormalizedRelativePath(value)) {
    return false;
  }
  const packages = value.slice('node_modules/'.length).split('/node_modules/');
  return packages.length > 0 && packages.every(isPackageName);
}

function isNormalizedRelativePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 2048 &&
    value === value.trim() &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !value.startsWith('/') &&
    value === posix.normalize(value) &&
    !value.split('/').some((part) => part === '' || part === '.' || part === '..')
  );
}

function isPackageName(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 214 &&
    /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u.test(value)
  );
}

function isPackageVersion(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value);
}

function isOptionalDependencyKind(kind) {
  return kind === 'optionalDependency' || kind === 'optionalPeerDependency';
}

function isSafeMetadataString(value, maximumLength) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value === value.trim() &&
    !/[\0\r\n]/u.test(value)
  );
}

function normalizeExactInputPath(value, label) {
  const input = assertNativeAbsolutePath(value, label);
  const normalized = resolve(input);
  if (!sameLexicalPath(input, normalized)) {
    throw new Error(`${label} must be normalized and cannot contain an aliasing path segment.`);
  }
  return normalized;
}

async function optionalLstat(path) {
  try {
    return await lstat(path, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
    throw error;
  }
}

function sameFileIdentity(left, right) {
  return sameStablePhysicalIdentity(
    stablePhysicalIdentity(left, 'Installed-browser toolchain file identity'),
    stablePhysicalIdentity(right, 'Installed-browser toolchain file identity')
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

function stablePhysicalFileIdentity(information) {
  if (!information || information.ino === 0n) return null;
  return `${information.dev}:${information.ino}`;
}

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sameLexicalPath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function assertSortedUnique(values, label) {
  const sorted = [...values].sort(compareStrings);
  if (JSON.stringify(values) !== JSON.stringify(sorted) || new Set(values).size !== values.length) {
    throw new Error(`${label} must be unique and sorted.`);
  }
}

function safeAdd(left, right, label) {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${label} exceeds the safe integer range.`);
  return result;
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

function sameCanonicalValue(left, right) {
  return stableJson(left) === stableJson(right);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, expected, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object.`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} keys differ from the exact schema.`);
  }
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isSha256(value) {
  return typeof value === 'string' && /^[A-F0-9]{64}$/u.test(value);
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

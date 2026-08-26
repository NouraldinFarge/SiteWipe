import { createHash, randomBytes } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertGitWorktreeClean } from '../../../scripts/source-archive.mjs';
import { assertTrustedGitRepository, resolveTrustedGitExecutable } from '../../../scripts/trusted-git.mjs';

import { REQUIRED_BROWSERS } from './canonical-matrix.mjs';
import { validateBrowserPlan } from './evidence-contract.mjs';
import { NATIVE_PROMPT_HELPER_PATH, NATIVE_PROMPT_HELPER_SHA256 } from './native-permission-dialog.mjs';
import {
  assertApprovedBrowserPlanObservation,
  captureCleanCommittedBrowserSourceSnapshot,
  captureCommittedBrowserSourceSnapshot,
  createUnattendedBrowserPlanRecord
} from './unattended-coordinator-core.mjs';
import { assertNativeAbsolutePath } from './path-contract.mjs';
import {
  BROWSER_RUNTIME_SUMMARY_KEYS,
  computeBrowserRuntimeSetSha256,
  validateBrowserRuntimeSummary
} from './browser-runtime-closure.mjs';
import { INSTALLED_RUNTIME_LAUNCH_POLICY_SHA256 } from './launch-policy.mjs';
import {
  INSTALLED_BROWSER_TOOLCHAIN_SUMMARY_KEYS,
  captureInstalledBrowserToolchainClosure,
  installedBrowserToolchainClosureSummary
} from './toolchain-closure.mjs';

const PROCESS_OBSERVER_HELPER_PATH = fileURLToPath(new URL('./windows-process-identity.ps1', import.meta.url));
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

export async function createUnattendedBrowserPlanFixture({
  repositoryRoot,
  workspaceRoot,
  artifact,
  browserPins,
  createdAt = new Date().toISOString(),
  randomBytesFn = randomBytes,
  retention = { failureDays: 14, passEvidenceDays: 30, retainProfilesOnFailure: true },
  afterCleanCheck = null
}) {
  const repository = await exactPhysicalDirectory(repositoryRoot, 'Fixture browser-plan repository root');
  const workspace = await validateWorkspacePlacement(repository.path, workspaceRoot, { allowMissing: true });
  const gitIdentity = resolveTrustedGitExecutable({ root: repository.path });
  const source = await captureFixtureSource(repository.path, afterCleanCheck);
  const artifactIdentity = await captureArtifactIdentity(artifact);
  const exactPins = await captureBrowserPins(browserPins);
  const nodeIdentity = await exactFileIdentity(process.execPath, 'Node executable', { allowInputAlias: true });
  const toolchainSummary = await captureFixtureToolchain(repository.path, source);
  const helperIdentity = await exactFileIdentity(NATIVE_PROMPT_HELPER_PATH, 'Native prompt helper');
  if (helperIdentity.sha256 !== NATIVE_PROMPT_HELPER_SHA256) {
    throw new Error('Native prompt helper identity changed while creating the fixture browser plan.');
  }
  const processObserver = await captureFixtureProcessObserver();
  return createUnattendedBrowserPlanRecord({
    repositoryPath: repository.path,
    workspacePath: workspace.path,
    source,
    artifactIdentity,
    browserPins: exactPins,
    gitIdentity,
    nodeIdentity,
    helperIdentity,
    processObserver,
    toolchainSummary,
    nodeRuntimeVersion: process.version,
    createdAt,
    randomBytesFn,
    retention
  });
}

export async function revalidateUnattendedBrowserPlanFixture(plan, { artifact, browserPins, afterCleanCheck = null }) {
  validateBrowserPlan(plan);
  const repository = await exactPhysicalDirectory(plan.inputs.repositoryRoot, 'Fixture browser repository root');
  await validateWorkspacePlacement(repository.path, plan.inputs.workspaceRoot, { allowMissing: true });
  const gitIdentity = resolveTrustedGitExecutable({ root: repository.path });
  const source = await captureFixtureSource(repository.path, afterCleanCheck);
  const artifactIdentity = await captureArtifactIdentity(artifact);
  const [pins, nodeIdentity, helperIdentity, processObserver, toolchainSummary] = await Promise.all([
    captureBrowserPins(browserPins),
    exactFileIdentity(process.execPath, 'Node executable', { allowInputAlias: true }),
    exactFileIdentity(NATIVE_PROMPT_HELPER_PATH, 'Native prompt helper'),
    captureFixtureProcessObserver(),
    captureFixtureToolchain(repository.path, source)
  ]);
  const observedIdentity = {
    sourceCommitSha: source.commitSha,
    sourceTreeSha: source.treeSha,
    artifactVersion: artifactIdentity.version,
    artifactBytes: artifactIdentity.bytes,
    artifactSha256: artifactIdentity.sha256,
    browserRuntimeSetSha256: computeBrowserRuntimeSetSha256(pins),
    harnessManifestSha256: source.harnessManifestSha256,
    launchPolicySha256: INSTALLED_RUNTIME_LAUNCH_POLICY_SHA256,
    gitExecutableSha256: gitIdentity.sha256,
    nativeHelperSha256: helperIdentity.sha256,
    processObserverHelperSha256: processObserver.helperSha256,
    powerShellExecutableSha256: processObserver.powershellSha256,
    nodeExecutableSha256: nodeIdentity.sha256,
    nodeRuntimeVersion: process.version,
    packageLockSha256: source.packageLockSha256,
    releaseInputFingerprintSha256: source.releaseInputFingerprintSha256,
    runtimeFingerprintSha256: source.runtimeFingerprintSha256,
    toolchainPuppeteerVersion: toolchainSummary.toolchainPuppeteerVersion,
    toolchainPackageCount: toolchainSummary.toolchainPackageCount,
    toolchainFileCount: toolchainSummary.toolchainFileCount,
    toolchainBytes: toolchainSummary.toolchainBytes,
    toolchainSetSha256: toolchainSummary.toolchainSetSha256
  };
  return assertApprovedBrowserPlanObservation(plan, {
    gitIdentity,
    identity: observedIdentity,
    browserPins: pins,
    processObserver,
    toolchain: {
      nodeRuntimeVersion: process.version,
      ...Object.fromEntries(INSTALLED_BROWSER_TOOLCHAIN_SUMMARY_KEYS.map((key) => [key, toolchainSummary[key]]))
    }
  });
}

async function captureFixtureToolchain(repositoryRoot, source) {
  const packageLockPath = resolve(repositoryRoot, 'package-lock.json');
  const nodeModulesPath = resolve(repositoryRoot, 'node_modules');
  const before = await exactFileIdentity(packageLockPath, 'Fixture installed-browser package lock');
  if (before.sha256 !== source.packageLockSha256) {
    throw new Error('Fixture installed-browser package lock differs from the exact committed source snapshot.');
  }
  const closure = await captureInstalledBrowserToolchainClosure({ packageLockPath, nodeModulesPath });
  const after = await exactFileIdentity(packageLockPath, 'Fixture installed-browser package lock');
  if (after.sha256 !== before.sha256 || !sameFileIdentity(before.information, after.information)) {
    throw new Error('Fixture installed-browser package lock changed while capturing the toolchain closure.');
  }
  return installedBrowserToolchainClosureSummary(closure);
}

async function captureFixtureProcessObserver() {
  const [helper, powershell] = await Promise.all([
    exactFileIdentity(PROCESS_OBSERVER_HELPER_PATH, 'Fixture process-observer helper'),
    exactFileIdentity(process.execPath, 'Fixture PowerShell substitute', { allowInputAlias: true })
  ]);
  return Object.freeze({
    helperPath: helper.path,
    helperSha256: helper.sha256,
    powershellPath: powershell.path,
    powershellSha256: powershell.sha256,
    helperModes: Object.freeze(['Identity', 'ProfileResidue', 'TerminateTree']),
    rawCommandLinesRetained: false,
    processTerminationAllowed: true
  });
}

async function captureFixtureSource(repositoryRoot, afterCleanCheck) {
  if (afterCleanCheck === null) return captureCleanCommittedBrowserSourceSnapshot(repositoryRoot);
  if (typeof afterCleanCheck !== 'function') {
    throw new TypeError('Fixture post-clean callback must be a function or null.');
  }
  assertTrustedGitRepository(repositoryRoot);
  const commitSha = assertGitWorktreeClean(repositoryRoot).toLowerCase();
  await afterCleanCheck();
  return captureCommittedBrowserSourceSnapshot(repositoryRoot, commitSha);
}

async function captureArtifactIdentity(artifact) {
  if (!artifact || !isNativeAbsolutePath(artifact.path) || !/^\d+\.\d+\.\d+$/.test(String(artifact.version || ''))) {
    throw new Error('Fixture browser plan requires an absolute artifact path and semantic version.');
  }
  const identity = await exactFileIdentity(artifact.path, 'Fixture runtime artifact');
  if (identity.bytes.length <= 0) throw new Error('Fixture runtime artifact cannot be empty.');
  return Object.freeze({
    path: identity.path,
    version: artifact.version,
    bytes: identity.bytes.length,
    sha256: identity.sha256
  });
}

async function captureBrowserPins(browserPins) {
  if (!Array.isArray(browserPins) || browserPins.length !== REQUIRED_BROWSERS.length) {
    throw new Error('Exactly two fixture browser pins are required.');
  }
  const captured = [];
  for (const pin of browserPins) {
    if (!REQUIRED_BROWSERS.includes(pin?.name) || !isSha256(pin?.executableSha256) || !pin?.version) {
      throw new Error('Fixture installed browser pin is malformed.');
    }
    const identity = await exactFileIdentity(pin.executablePath, `Fixture pinned ${pin.name} executable`);
    if (identity.sha256 !== pin.executableSha256) {
      throw new Error(`Fixture pinned ${pin.name} executable bytes changed.`);
    }
    const runtimeSummary = Object.fromEntries(BROWSER_RUNTIME_SUMMARY_KEYS.map((key) => [key, pin[key]]));
    validateBrowserRuntimeSummary(runtimeSummary);
    captured.push({
      name: pin.name,
      executablePath: identity.path,
      version: String(pin.version),
      executableSha256: identity.sha256,
      ...runtimeSummary
    });
  }
  captured.sort((left, right) => left.name.localeCompare(right.name));
  if (JSON.stringify(captured.map(({ name }) => name)) !== JSON.stringify(REQUIRED_BROWSERS)) {
    throw new Error('Fixture installed browser pins must be exactly Brave and Chrome.');
  }
  return captured;
}

async function validateWorkspacePlacement(repositoryRoot, workspaceRoot, { allowMissing }) {
  const expected = resolve(assertNativeAbsolutePath(workspaceRoot, 'Fixture browser workspace root path'));
  const repositoryRelative = relative(repositoryRoot, expected);
  if (!repositoryRelative || (!repositoryRelative.startsWith(`..${sep}`) && repositoryRelative !== '..')) {
    throw new Error('Fixture browser workspace root must remain outside the source repository.');
  }
  try {
    return await exactPhysicalDirectory(expected, 'Fixture browser workspace root');
  } catch (error) {
    if (!allowMissing || error?.code !== 'ENOENT') throw error;
    await exactPhysicalDirectory(resolve(expected, '..'), 'Fixture browser workspace parent');
    return Object.freeze({ path: expected, information: null, missing: true });
  }
}

async function exactPhysicalDirectory(path, label) {
  const expected = resolve(assertNativeAbsolutePath(path, `${label} path`));
  const information = await lstat(expected, { bigint: true });
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error(`${label} must be one physical non-reparse directory.`);
  }
  if (!samePath(await realpath(expected), expected)) throw new Error(`${label} is aliased.`);
  const after = await lstat(expected, { bigint: true });
  if (!after.isDirectory() || after.isSymbolicLink() || !sameDirectoryIdentity(information, after)) {
    throw new Error(`${label} identity changed while resolving.`);
  }
  return Object.freeze({ path: expected, information: after });
}

async function exactFileIdentity(path, label, { allowInputAlias = false } = {}) {
  const requested = resolve(assertNativeAbsolutePath(path, `${label} path`));
  const actual = await realpath(requested);
  if (!allowInputAlias && !samePath(actual, requested)) throw new Error(`${label} is aliased.`);
  const before = await lstat(actual, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new Error(`${label} must be one singly linked regular non-reparse file.`);
  }
  const handle = await open(actual, 'r');
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1n) {
      throw new Error(`${label} opened handle is not singly linked.`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const finalPath = await lstat(actual, { bigint: true });
    const finalRealPath = await realpath(actual);
    if (
      after.nlink !== 1n ||
      finalPath.nlink !== 1n ||
      !finalPath.isFile() ||
      finalPath.isSymbolicLink() ||
      !samePath(finalRealPath, actual) ||
      !sameFileIdentity(before, opened) ||
      !sameFileIdentity(opened, after) ||
      !sameFileIdentity(after, finalPath) ||
      after.size !== BigInt(bytes.length)
    ) {
      throw new Error(`${label} identity changed while hashing.`);
    }
    return Object.freeze({ path: actual, information: after, bytes, sha256: sha256(bytes) });
  } finally {
    await handle.close();
  }
}

function sameFileIdentity(left, right) {
  if (!left || !right || left.isFile() !== right.isFile() || left.isDirectory() !== right.isDirectory()) return false;
  return STABLE_PHYSICAL_IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

function sameDirectoryIdentity(left, right) {
  if (!left || !right || !left.isDirectory() || !right.isDirectory()) return false;
  // Keep fixture revalidation aligned with the production POSIX identity
  // contract: child creation may change nlink without replacing the node.
  return ['dev', 'ino', 'mode', 'uid', 'gid', 'rdev'].every((key) => left[key] === right[key]);
}

function samePath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isSha256(value) {
  return /^[A-F0-9]{64}$/.test(String(value || ''));
}

function isNativeAbsolutePath(value) {
  try {
    assertNativeAbsolutePath(value, 'Fixture native path');
    return true;
  } catch {
    return false;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

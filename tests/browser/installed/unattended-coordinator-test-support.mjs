import { createHash, randomBytes } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

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
  const helperIdentity = await exactFileIdentity(NATIVE_PROMPT_HELPER_PATH, 'Native prompt helper');
  if (helperIdentity.sha256 !== NATIVE_PROMPT_HELPER_SHA256) {
    throw new Error('Native prompt helper identity changed while creating the fixture browser plan.');
  }
  return createUnattendedBrowserPlanRecord({
    repositoryPath: repository.path,
    workspacePath: workspace.path,
    source,
    artifactIdentity,
    browserPins: exactPins,
    gitIdentity,
    nodeIdentity,
    helperIdentity,
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
  const [pins, nodeIdentity, helperIdentity] = await Promise.all([
    captureBrowserPins(browserPins),
    exactFileIdentity(process.execPath, 'Node executable', { allowInputAlias: true }),
    exactFileIdentity(NATIVE_PROMPT_HELPER_PATH, 'Native prompt helper')
  ]);
  const observedIdentity = {
    sourceCommitSha: source.commitSha,
    sourceTreeSha: source.treeSha,
    artifactVersion: artifactIdentity.version,
    artifactBytes: artifactIdentity.bytes,
    artifactSha256: artifactIdentity.sha256,
    harnessManifestSha256: source.harnessManifestSha256,
    gitExecutableSha256: gitIdentity.sha256,
    nativeHelperSha256: helperIdentity.sha256,
    nodeExecutableSha256: nodeIdentity.sha256,
    packageLockSha256: source.packageLockSha256,
    releaseInputFingerprintSha256: source.releaseInputFingerprintSha256,
    runtimeFingerprintSha256: source.runtimeFingerprintSha256
  };
  return assertApprovedBrowserPlanObservation(plan, {
    gitIdentity,
    identity: observedIdentity,
    browserPins: pins
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
  if (
    !artifact ||
    !isAbsolute(String(artifact.path || '')) ||
    !/^\d+\.\d+\.\d+$/.test(String(artifact.version || ''))
  ) {
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
    captured.push({
      name: pin.name,
      executablePath: identity.path,
      version: String(pin.version),
      executableSha256: identity.sha256
    });
  }
  captured.sort((left, right) => left.name.localeCompare(right.name));
  if (JSON.stringify(captured.map(({ name }) => name)) !== JSON.stringify(REQUIRED_BROWSERS)) {
    throw new Error('Fixture installed browser pins must be exactly Brave and Chrome.');
  }
  return captured;
}

async function validateWorkspacePlacement(repositoryRoot, workspaceRoot, { allowMissing }) {
  if (!isAbsolute(String(workspaceRoot || ''))) throw new Error('Fixture browser workspace root must be absolute.');
  const expected = resolve(workspaceRoot);
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
  const expected = resolve(path);
  const information = await lstat(expected);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error(`${label} must be one physical non-reparse directory.`);
  }
  if (!samePath(await realpath(expected), expected)) throw new Error(`${label} is aliased.`);
  return Object.freeze({ path: expected, information });
}

async function exactFileIdentity(path, label, { allowInputAlias = false } = {}) {
  const requested = resolve(path);
  const actual = await realpath(requested);
  if (!allowInputAlias && !samePath(actual, requested)) throw new Error(`${label} is aliased.`);
  const before = await lstat(actual);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error(`${label} must be one singly linked regular non-reparse file.`);
  }
  const handle = await open(actual, 'r');
  try {
    const opened = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFileIdentity(before, opened) || !sameFileIdentity(opened, after) || after.size !== bytes.length) {
      throw new Error(`${label} identity changed while hashing.`);
    }
    return Object.freeze({ path: actual, information: after, bytes, sha256: sha256(bytes) });
  } finally {
    await handle.close();
  }
}

function sameFileIdentity(left, right) {
  if (!left || !right || left.dev !== right.dev || left.ino !== right.ino || left.size !== right.size) return false;
  return left.ino !== 0 || left.birthtimeMs === right.birthtimeMs;
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

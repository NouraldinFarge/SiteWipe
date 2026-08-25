import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { verifyReleaseCandidate } from '../../../scripts/release-artifact-verification.mjs';
import { resolveTrustedGitExecutable } from '../../../scripts/trusted-git.mjs';

import { REQUIRED_BROWSERS } from './canonical-matrix.mjs';
import { RESULT_STATES, canonicalJsonBytes, validateBrowserPlan } from './evidence-contract.mjs';
import { NATIVE_PROMPT_HELPER_PATH, NATIVE_PROMPT_HELPER_SHA256 } from './native-permission-dialog.mjs';
import {
  assertApprovedBrowserPlanObservation,
  captureCleanCommittedBrowserSourceSnapshot,
  createUnattendedBrowserPlanRecord
} from './unattended-coordinator-core.mjs';
import { assertNativeAbsolutePath, isDriveQualifiedWindowsAbsolutePath } from './path-contract.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
export const INSTALLED_BROWSER_POLICY_PATH = resolve(directory, 'installed-browser-policy.json');
const policy = validateInstalledBrowserPolicy(JSON.parse(await readFile(INSTALLED_BROWSER_POLICY_PATH, 'utf8')));

const WORKSPACE_MARKER_NAME = '.sitewipe-browser-workspace.json';
const ACTIVE_LOCK_NAME = '.sitewipe-active-run.lock';

export const INSTALLED_BROWSER_PINS = policy.browsers;

export async function createUnattendedBrowserPlan(options) {
  assertExactOptionKeys(
    options,
    ['createdAt', 'repositoryRoot', 'retention', 'workspaceRoot'],
    'Unattended browser plan options'
  );
  return createUnattendedBrowserPlanInternal(options);
}

async function createUnattendedBrowserPlanInternal({
  repositoryRoot,
  workspaceRoot,
  createdAt = new Date().toISOString(),
  retention = { failureDays: 14, passEvidenceDays: 30, retainProfilesOnFailure: true }
}) {
  const repository = await exactPhysicalDirectory(repositoryRoot, 'Browser-plan repository root');
  const workspace = await validateWorkspacePlacement(repository.path, workspaceRoot, { allowMissing: true });
  const gitIdentity = resolveTrustedGitExecutable({ root: repository.path });
  const source = captureCleanCommittedBrowserSourceSnapshot(repository.path);
  const artifact = await captureCanonicalReleaseArtifact(repository.path, source);
  const artifactIdentity = await captureArtifactIdentity(artifact);
  const exactPins = await captureBrowserPins(INSTALLED_BROWSER_PINS);
  const nodeIdentity = await exactFileIdentity(process.execPath, 'Node executable', { allowInputAlias: true });
  const helperIdentity = await exactFileIdentity(NATIVE_PROMPT_HELPER_PATH, 'Native prompt helper');
  if (helperIdentity.sha256 !== NATIVE_PROMPT_HELPER_SHA256) {
    throw new Error('Native prompt helper identity changed while creating the browser plan.');
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
    randomBytesFn: randomBytes,
    retention
  });
}

export async function revalidateApprovedBrowserPlan(plan) {
  validateBrowserPlan(plan);
  const repository = await exactPhysicalDirectory(plan.inputs.repositoryRoot, 'Approved browser repository root');
  await validateWorkspacePlacement(repository.path, plan.inputs.workspaceRoot, { allowMissing: true });
  const gitIdentity = resolveTrustedGitExecutable({ root: repository.path });
  const source = captureCleanCommittedBrowserSourceSnapshot(repository.path);
  const canonicalArtifact = await captureCanonicalReleaseArtifact(repository.path, source);
  const artifact = await captureArtifactIdentity(canonicalArtifact);
  const [pins, nodeIdentity, helperIdentity] = await Promise.all([
    captureBrowserPins(INSTALLED_BROWSER_PINS),
    exactFileIdentity(process.execPath, 'Node executable', { allowInputAlias: true }),
    exactFileIdentity(NATIVE_PROMPT_HELPER_PATH, 'Native prompt helper')
  ]);
  const observedIdentity = {
    sourceCommitSha: source.commitSha,
    sourceTreeSha: source.treeSha,
    artifactVersion: artifact.version,
    artifactBytes: artifact.bytes,
    artifactSha256: artifact.sha256,
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

export async function prepareApprovedOwnedRun(options) {
  assertExactOptionKeys(options, ['approvalSha256', 'plan'], 'Approved owned-run options');
  const { plan, approvalSha256 } = options;
  validateBrowserPlan(plan);
  if (approvalSha256 !== plan.planSha256) {
    throw new Error('The one initial approval does not match the exact browser-plan SHA-256.');
  }
  await revalidateApprovedBrowserPlan(plan);
  const workspace = await ensureOwnedWorkspaceRoot(plan.inputs.workspaceRoot);
  const lockTokenBytes = Buffer.from(randomBytes(32));
  const fixtureTokenBytes = Buffer.from(randomBytes(32));
  if (lockTokenBytes.length !== 32 || fixtureTokenBytes.length !== 32) {
    throw new Error('Owned-run token entropy source must return exactly 32 bytes.');
  }
  const lockToken = lockTokenBytes.toString('hex');
  const fixtureToken = fixtureTokenBytes.toString('hex');
  const lockPath = resolve(workspace.path, ACTIVE_LOCK_NAME);
  const lockValue = {
    schema: 'sitewipe.browser-run-lock.v1',
    runId: plan.runId,
    planSha256: plan.planSha256,
    ownerProcessId: process.pid,
    coordinationTokenSha256: sha256(lockToken),
    createdAt: new Date().toISOString()
  };
  const lock = await writeExclusiveRegularFile(lockPath, canonicalJsonBytes(lockValue), 'Browser run lock');
  let run;
  try {
    const runRoot = assertDescendant(workspace.path, resolve(workspace.path, plan.runId), 'Browser run root');
    await mkdir(runRoot, { recursive: false });
    run = await exactPhysicalDirectory(runRoot, 'Browser run root');
    const marker = {
      schema: 'sitewipe.owned-browser-run.v1',
      runId: plan.runId,
      planSha256: plan.planSha256,
      fixtureTokenSha256: sha256(fixtureToken),
      ownerProcessId: process.pid,
      state: 'prepared',
      retention: structuredClone(plan.inputs.retention)
    };
    await writeExclusiveRegularFile(
      resolve(run.path, '.sitewipe-owned-run.json'),
      canonicalJsonBytes(marker),
      'Browser run ownership marker'
    );
    await writeExclusiveRegularFile(
      resolve(run.path, 'approved-plan.json'),
      canonicalJsonBytes(plan),
      'Approved browser plan record'
    );
  } catch (error) {
    await releaseExactRunLock({ workspace, lock, lockToken, runId: plan.runId }).catch(() => undefined);
    throw error;
  }

  let completed = false;
  return Object.freeze({
    runRoot: run.path,
    fixtureToken,
    fixtureTokenSha256: sha256(fixtureToken),
    async complete({ state, aggregateSha256 = null, detail = null }) {
      if (completed) throw new Error('Owned browser run was already completed.');
      if (!RESULT_STATES.includes(state)) throw new Error('Owned browser run completion state is invalid.');
      if (aggregateSha256 !== null && !isSha256(aggregateSha256)) {
        throw new Error('Owned browser run aggregate SHA-256 is invalid.');
      }
      if (detail !== null && (typeof detail !== 'string' || !detail.trim())) {
        throw new Error('Owned browser run completion detail must be null or non-empty.');
      }
      await assertExactDirectoryIdentity(run, 'Browser run root');
      const receipt = {
        schema: 'sitewipe.owned-browser-run-completion.v1',
        runId: plan.runId,
        planSha256: plan.planSha256,
        state,
        aggregateSha256,
        detail,
        completedAt: new Date().toISOString(),
        retainedRunRoot: true,
        automaticRecursiveDeletionPerformed: false
      };
      await writeExclusiveRegularFile(
        resolve(run.path, 'completion.json'),
        canonicalJsonBytes(receipt),
        'Browser run completion receipt'
      );
      await releaseExactRunLock({ workspace, lock, lockToken, runId: plan.runId });
      completed = true;
      return Object.freeze(receipt);
    }
  });
}

async function captureArtifactIdentity(artifact) {
  if (
    !artifact ||
    !isAbsolute(String(artifact.path || '')) ||
    !/^\d+\.\d+\.\d+$/.test(String(artifact.version || ''))
  ) {
    throw new Error('Browser plan requires an absolute artifact path and semantic version.');
  }
  const identity = await exactFileIdentity(artifact.path, 'Runtime artifact');
  if (identity.bytes.length <= 0) throw new Error('Runtime artifact cannot be empty.');
  return Object.freeze({
    path: identity.path,
    version: artifact.version,
    bytes: identity.bytes.length,
    sha256: identity.sha256
  });
}

async function captureCanonicalReleaseArtifact(repositoryRoot, source) {
  const repository = await exactPhysicalDirectory(repositoryRoot, 'Canonical release repository root');
  const verified = await verifyReleaseCandidate({ root: repository.path });
  if (verified.sourceCommit.toLowerCase() !== source.commitSha) {
    throw new Error('Canonical verified release artifact differs from the exact committed browser source snapshot.');
  }
  const artifact = {
    path: resolve(repository.path, 'dist', 'current', verified.artifact),
    version: source.packageVersion
  };
  const identity = await captureArtifactIdentity(artifact);
  if (identity.sha256 !== verified.sha256) {
    throw new Error('Canonical verified release artifact changed before browser planning.');
  }
  return artifact;
}

async function captureBrowserPins(browserPins) {
  if (!Array.isArray(browserPins) || browserPins.length !== REQUIRED_BROWSERS.length) {
    throw new Error('Exactly two browser pins are required.');
  }
  const captured = [];
  for (const pin of browserPins) {
    if (!REQUIRED_BROWSERS.includes(pin?.name) || !isSha256(pin?.executableSha256) || !pin?.version) {
      throw new Error('Installed browser pin is malformed.');
    }
    const identity = await exactFileIdentity(pin.executablePath, `Pinned ${pin.name} executable`);
    if (identity.sha256 !== pin.executableSha256) {
      throw new Error(`Pinned ${pin.name} executable bytes changed.`);
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
    throw new Error('Installed browser pins must be exactly Brave and Chrome.');
  }
  return captured;
}

async function validateWorkspacePlacement(repositoryRoot, workspaceRoot, { allowMissing }) {
  const expected = resolve(assertNativeAbsolutePath(workspaceRoot, 'Browser workspace root path'));
  const repositoryRelative = relative(repositoryRoot, expected);
  if (!repositoryRelative || (!repositoryRelative.startsWith(`..${sep}`) && repositoryRelative !== '..')) {
    throw new Error('Browser workspace root must remain outside the source repository.');
  }
  try {
    const workspace = await exactPhysicalDirectory(expected, 'Browser workspace root');
    await assertWorkspaceMarkerOrEmpty(workspace.path);
    return workspace;
  } catch (error) {
    if (!allowMissing || error?.code !== 'ENOENT') throw error;
    await exactPhysicalDirectory(dirname(expected), 'Browser workspace parent');
    return Object.freeze({ path: expected, information: null, missing: true });
  }
}

async function ensureOwnedWorkspaceRoot(workspaceRoot) {
  const expected = resolve(assertNativeAbsolutePath(workspaceRoot, 'Browser workspace root path'));
  let workspace;
  try {
    workspace = await exactPhysicalDirectory(expected, 'Browser workspace root');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await exactPhysicalDirectory(dirname(expected), 'Browser workspace parent');
    await mkdir(expected, { recursive: false });
    workspace = await exactPhysicalDirectory(expected, 'Browser workspace root');
  }
  const markerPath = resolve(workspace.path, WORKSPACE_MARKER_NAME);
  const markerValue = {
    schema: 'sitewipe.browser-workspace.v1',
    purpose: 'SiteWipe synthetic installed-browser runs only'
  };
  try {
    const bytes = await readFile(markerPath);
    if (!bytes.equals(canonicalJsonBytes(markerValue))) {
      throw new Error('Browser workspace marker differs from the exact ownership policy.');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const entries = await readdir(workspace.path);
    if (entries.length !== 0) {
      throw new Error('Unmarked browser workspace is not empty; refusing to claim it.', { cause: error });
    }
    await writeExclusiveRegularFile(markerPath, canonicalJsonBytes(markerValue), 'Browser workspace marker');
  }
  return workspace;
}

async function assertWorkspaceMarkerOrEmpty(workspaceRoot) {
  const entries = await readdir(workspaceRoot);
  if (entries.length === 0) return;
  if (!entries.includes(WORKSPACE_MARKER_NAME)) {
    throw new Error('Existing browser workspace has no exact SiteWipe ownership marker.');
  }
  const expected = {
    schema: 'sitewipe.browser-workspace.v1',
    purpose: 'SiteWipe synthetic installed-browser runs only'
  };
  const marker = await exactFileIdentity(resolve(workspaceRoot, WORKSPACE_MARKER_NAME), 'Browser workspace marker');
  if (!marker.bytes.equals(canonicalJsonBytes(expected))) {
    throw new Error('Existing browser workspace marker differs from the exact ownership policy.');
  }
}

async function releaseExactRunLock({ workspace, lock, lockToken, runId }) {
  await assertExactDirectoryIdentity(workspace, 'Browser workspace root');
  const observed = await exactFileIdentity(lock.path, 'Browser run lock');
  if (
    !sameFileIdentity(lock.information, observed.information) ||
    observed.sha256 !== lock.sha256 ||
    sha256(lockToken) !== lock.value.coordinationTokenSha256
  ) {
    throw new Error('Browser run lock identity changed; refusing release.');
  }
  const quarantine = resolve(workspace.path, `.sitewipe-released-${runId}.lock`);
  await rename(lock.path, quarantine);
  const quarantined = await exactFileIdentity(quarantine, 'Released browser run lock');
  if (!sameFileIdentity(lock.information, quarantined.information) || quarantined.sha256 !== lock.sha256) {
    throw new Error('Browser run lock identity changed during quarantine.');
  }
  await unlink(quarantine);
}

async function writeExclusiveRegularFile(path, bytes, label) {
  const content = Buffer.from(bytes);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  let information;
  try {
    await handle.writeFile(content);
    await handle.sync();
    information = await handle.stat();
    if (!information.isFile() || information.isSymbolicLink() || information.nlink !== 1) {
      throw new Error(`${label} must remain one singly linked regular file.`);
    }
  } finally {
    await handle.close();
  }
  const actual = await realpath(path);
  if (!samePath(actual, path)) throw new Error(`${label} became aliased.`);
  const value = JSON.parse(content.toString('utf8'));
  return Object.freeze({ path: resolve(path), information, sha256: sha256(content), value });
}

async function exactPhysicalDirectory(path, label) {
  const expected = resolve(assertNativeAbsolutePath(path, `${label} path`));
  const information = await lstat(expected);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error(`${label} must be one physical non-reparse directory.`);
  }
  if (!samePath(await realpath(expected), expected)) throw new Error(`${label} is aliased.`);
  return Object.freeze({ path: expected, information });
}

async function assertExactDirectoryIdentity(identity, label) {
  const observed = await exactPhysicalDirectory(identity.path, label);
  if (!sameDirectoryIdentity(identity.information, observed.information)) throw new Error(`${label} identity changed.`);
  return observed;
}

async function exactFileIdentity(path, label, { allowInputAlias = false } = {}) {
  const requested = resolve(assertNativeAbsolutePath(path, `${label} path`));
  const actual = await realpath(requested);
  if (!allowInputAlias && !samePath(actual, requested)) throw new Error(`${label} is aliased.`);
  const expected = actual;
  const before = await lstat(expected);
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

function validateInstalledBrowserPolicy(value) {
  if (
    value?.schema !== 'sitewipe.installed-browser-policy.v1' ||
    !Array.isArray(value?.browsers) ||
    value.browsers.length !== 2 ||
    value?.transport?.pipe !== true ||
    value?.transport?.remoteDebuggingPortAllowed !== false ||
    value?.transport?.attachToExistingBrowserAllowed !== false ||
    value?.transport?.existingProfileAllowed !== false
  ) {
    throw new Error('Installed browser policy is malformed or permits unsafe launch behavior.');
  }
  const browsers = value.browsers.map((entry) => {
    if (
      !REQUIRED_BROWSERS.includes(entry?.name) ||
      !isDriveQualifiedWindowsAbsolutePath(entry?.executablePath) ||
      !entry?.version ||
      !isSha256(entry?.executableSha256)
    ) {
      throw new Error('Installed browser policy contains an invalid pin.');
    }
    return { ...entry };
  });
  browsers.sort((left, right) => left.name.localeCompare(right.name));
  if (JSON.stringify(browsers.map(({ name }) => name)) !== JSON.stringify(REQUIRED_BROWSERS)) {
    throw new Error('Installed browser policy must pin exactly Brave and Chrome.');
  }
  return deepFreeze({ ...structuredClone(value), browsers });
}

function assertDescendant(parent, child, label) {
  const exactParent = resolve(parent);
  const exactChild = resolve(child);
  const relation = relative(exactParent, exactChild);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`${label} escapes or equals its owned parent.`);
  }
  return exactChild;
}

function sameFileIdentity(left, right) {
  if (!left || !right || left.dev !== right.dev || left.ino !== right.ino || left.size !== right.size) return false;
  return left.ino !== 0 || left.birthtimeMs === right.birthtimeMs;
}

function sameDirectoryIdentity(left, right) {
  if (!left || !right || left.dev !== right.dev || left.ino !== right.ino) return false;
  return left.ino !== 0 || left.birthtimeMs === right.birthtimeMs;
}

function samePath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function isSha256(value) {
  return /^[A-F0-9]{64}$/.test(String(value || ''));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

function assertExactOptionKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length) throw new Error(`${label} contain caller-controlled fields: ${unexpected.join(', ')}.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const argumentsList = process.argv.slice(2);
  if (!argumentsList.includes('--plan-only')) {
    throw new Error('Only read-only --plan-only is exposed until the installed scenario runner is implemented.');
  }
  const argumentValue = (name) => {
    const index = argumentsList.indexOf(name);
    return index >= 0 ? argumentsList[index + 1] : undefined;
  };
  const repositoryRoot = argumentValue('--repository-root') || resolve(directory, '..', '..', '..');
  const workspaceRoot = argumentValue('--workspace-root');
  if (!workspaceRoot) {
    throw new Error(
      '--plan-only requires --workspace-root; the runtime artifact is derived from verified dist/current.'
    );
  }
  const plan = await createUnattendedBrowserPlan({
    repositoryRoot,
    workspaceRoot
  });
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

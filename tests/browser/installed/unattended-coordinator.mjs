import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { verifyReleaseCandidate } from '../../../scripts/release-artifact-verification.mjs';
import { resolveTrustedGitExecutable } from '../../../scripts/trusted-git.mjs';

import { REQUIRED_BROWSERS } from './canonical-matrix.mjs';
import {
  canonicalJsonBytes,
  computeAggregateSha256,
  validateAndReplayBrowserAggregate,
  validateBrowserPlan
} from './evidence-contract.mjs';
import {
  NATIVE_PROMPT_HELPER_PATH,
  NATIVE_PROMPT_HELPER_SHA256,
  NATIVE_PROMPT_POLICY_PATH,
  NATIVE_PROMPT_POLICY_SHA256,
  hasApprovedNativeFileLinkCount
} from './native-permission-dialog.mjs';
import {
  assertApprovedBrowserPlanObservation,
  captureCleanCommittedBrowserSourceSnapshot,
  createUnattendedBrowserPlanRecord
} from './unattended-coordinator-core.mjs';
import { assertNativeAbsolutePath, isDriveQualifiedWindowsAbsolutePath } from './path-contract.mjs';
import {
  BROWSER_RUNTIME_SUMMARY_KEYS,
  browserRuntimeClosureSummary,
  captureBrowserRuntimeClosure,
  computeBrowserRuntimeSetSha256,
  validateBrowserRuntimeSummary
} from './browser-runtime-closure.mjs';
import { INSTALLED_RUNTIME_LAUNCH_POLICY_SHA256 } from './launch-policy.mjs';
import {
  INSTALLED_BROWSER_TOOLCHAIN_SUMMARY_KEYS,
  captureInstalledBrowserToolchainClosure,
  installedBrowserToolchainClosureSummary
} from './toolchain-closure.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
export const INSTALLED_BROWSER_POLICY_PATH = resolve(directory, 'installed-browser-policy.json');

const WORKSPACE_MARKER_NAME = '.sitewipe-browser-workspace.json';
const ACTIVE_LOCK_NAME = '.sitewipe-active-run.lock';
const PROCESS_OBSERVER_HELPER_PATH = resolve(directory, 'windows-process-identity.ps1');
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
const policyIdentity = await exactFileIdentity(INSTALLED_BROWSER_POLICY_PATH, 'Installed-browser policy');
const policy = validateInstalledBrowserPolicy(JSON.parse(policyIdentity.bytes.toString('utf8')));

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
  const toolchainSummary = await captureInstalledBrowserToolchain(repository.path, source);
  const helperIdentity = await exactFileIdentity(NATIVE_PROMPT_HELPER_PATH, 'Native prompt helper');
  if (helperIdentity.sha256 !== NATIVE_PROMPT_HELPER_SHA256) {
    throw new Error('Native prompt helper identity changed while creating the browser plan.');
  }
  const processObserver = await captureProcessObserverIdentity();
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
  const [pins, nodeIdentity, helperIdentity, processObserver, toolchainSummary] = await Promise.all([
    captureBrowserPins(INSTALLED_BROWSER_PINS),
    exactFileIdentity(process.execPath, 'Node executable', { allowInputAlias: true }),
    exactFileIdentity(NATIVE_PROMPT_HELPER_PATH, 'Native prompt helper'),
    captureProcessObserverIdentity(),
    captureInstalledBrowserToolchain(repository.path, source)
  ]);
  const observedIdentity = {
    sourceCommitSha: source.commitSha,
    sourceTreeSha: source.treeSha,
    artifactVersion: artifact.version,
    artifactBytes: artifact.bytes,
    artifactSha256: artifact.sha256,
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

async function captureInstalledBrowserToolchain(repositoryRoot, source) {
  const packageLockPath = resolve(repositoryRoot, 'package-lock.json');
  const nodeModulesPath = resolve(repositoryRoot, 'node_modules');
  const before = await exactFileIdentity(packageLockPath, 'Installed-browser package lock');
  if (before.sha256 !== source.packageLockSha256) {
    throw new Error('Installed-browser package lock differs from the exact committed source snapshot.');
  }
  const closure = await captureInstalledBrowserToolchainClosure({ packageLockPath, nodeModulesPath });
  const after = await exactFileIdentity(packageLockPath, 'Installed-browser package lock');
  if (after.sha256 !== before.sha256 || !sameFileIdentity(before.information, after.information)) {
    throw new Error('Installed-browser package lock changed while capturing the toolchain closure.');
  }
  return installedBrowserToolchainClosureSummary(closure);
}

async function captureProcessObserverIdentity() {
  const [helper, nativePolicy] = await Promise.all([
    exactFileIdentity(PROCESS_OBSERVER_HELPER_PATH, 'Windows process-observer helper'),
    exactFileIdentity(NATIVE_PROMPT_POLICY_PATH, 'Native prompt policy')
  ]);
  if (nativePolicy.sha256 !== NATIVE_PROMPT_POLICY_SHA256) {
    throw new Error('Native prompt policy changed while capturing the process-observer identity.');
  }
  let policy;
  try {
    policy = JSON.parse(nativePolicy.bytes.toString('utf8'));
  } catch (error) {
    throw new Error('Native prompt policy is not valid JSON.', { cause: error });
  }
  if (!isDriveQualifiedWindowsAbsolutePath(policy?.powershell?.path) || !isSha256(policy?.powershell?.sha256)) {
    throw new Error('Native prompt policy lacks the exact pinned PowerShell identity.');
  }
  const powershell = await exactFileIdentity(policy.powershell.path, 'Pinned Windows PowerShell', {
    allowWindowsSystemPowerShellHardLinks: true
  });
  if (powershell.sha256 !== policy.powershell.sha256) {
    throw new Error('Pinned Windows PowerShell bytes changed while capturing the process-observer identity.');
  }
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
  const lock = await writeExclusiveRegularFile(lockPath, canonicalJsonBytes(lockValue), 'Browser run lock', workspace);
  // The immutable lock intentionally seals this workspace even when a later preparation step fails.
  const runRoot = assertDescendant(workspace.path, resolve(workspace.path, plan.runId), 'Browser run root');
  await mkdir(runRoot, { recursive: false });
  const run = await exactPhysicalDirectory(runRoot, 'Browser run root');
  const marker = {
    schema: 'sitewipe.owned-browser-run.v1',
    runId: plan.runId,
    planSha256: plan.planSha256,
    fixtureTokenSha256: sha256(fixtureToken),
    ownerProcessId: process.pid,
    state: 'prepared',
    retention: structuredClone(plan.inputs.retention)
  };
  const runMarker = await writeExclusiveRegularFile(
    resolve(run.path, '.sitewipe-owned-run.json'),
    canonicalJsonBytes(marker),
    'Browser run ownership marker',
    run
  );
  const approvedPlan = await writeExclusiveRegularFile(
    resolve(run.path, 'approved-plan.json'),
    canonicalJsonBytes(plan),
    'Approved browser plan record',
    run
  );

  const settlement = {
    state: 'open',
    kind: null,
    attemptedKinds: new Set(),
    durableKind: null,
    terminalCreationAttempted: false
  };
  const beginSettlement = (kind) => {
    if (
      settlement.state !== 'open' ||
      settlement.attemptedKinds.has(kind) ||
      settlement.attemptedKinds.has('failure')
    ) {
      throw new Error('Owned browser run settlement capability was already used.');
    }
    settlement.state = 'settling';
    settlement.kind = kind;
  };
  const markTerminalCreationAttempted = (kind) => {
    if (
      settlement.state !== 'settling' ||
      settlement.kind !== kind ||
      settlement.durableKind !== null ||
      settlement.terminalCreationAttempted
    ) {
      throw new Error('Owned browser run settlement state became inconsistent before terminal creation.');
    }
    settlement.terminalCreationAttempted = true;
  };
  const failSettlement = (kind) => {
    if (settlement.state !== 'settling' || settlement.kind !== kind || settlement.durableKind !== null) {
      throw new Error('Owned browser run settlement state became inconsistent after failure.');
    }
    settlement.attemptedKinds.add(kind);
    settlement.state = settlement.terminalCreationAttempted ? 'terminal-uncertain' : 'open';
    settlement.kind = null;
  };
  const markSettlementDurable = (kind) => {
    if (
      settlement.state !== 'settling' ||
      settlement.kind !== kind ||
      settlement.durableKind !== null ||
      !settlement.terminalCreationAttempted
    ) {
      throw new Error('Owned browser run settlement state became inconsistent at durability.');
    }
    settlement.durableKind = kind;
    settlement.state = 'settled';
  };
  return Object.freeze({
    runRoot: run.path,
    fixtureToken,
    fixtureTokenSha256: sha256(fixtureToken),
    async complete(completionOptions = {}) {
      assertExactOptionKeys(completionOptions, ['detail'], 'Owned browser run completion options');
      const { detail = null } = completionOptions;
      if (detail !== null && (typeof detail !== 'string' || !detail.trim())) {
        throw new Error('Owned browser run completion detail must be null or non-empty.');
      }
      beginSettlement('completion');
      try {
        await assertExactOwnedRunIdentity({ approvedPlan, plan, run, runMarker, workspace });
        await assertExactRunLockIdentity({ workspace, lock, lockToken });
        const aggregateIdentity = await exactFileIdentity(resolve(run.path, 'aggregate.json'), 'Browser run aggregate');
        let aggregate;
        try {
          aggregate = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(aggregateIdentity.bytes));
        } catch (error) {
          throw new Error('Browser run aggregate is not exact UTF-8 JSON.', { cause: error });
        }
        if (!aggregateIdentity.bytes.equals(canonicalJsonBytes(aggregate))) {
          throw new Error('Browser run aggregate is not canonical JSON.');
        }
        const replayed = validateAndReplayBrowserAggregate(aggregate, { plan });
        const aggregateSha256 = computeAggregateSha256(replayed);
        if (aggregateSha256 !== aggregateIdentity.sha256) {
          throw new Error('Browser run aggregate digest differs from the exact retained bytes.');
        }
        const receipt = {
          schema: 'sitewipe.owned-browser-run-completion.v1',
          runId: plan.runId,
          planSha256: plan.planSha256,
          state: replayed.state,
          aggregateSha256,
          resultSetSha256: replayed.resultSetSha256,
          resultRecordCount: replayed.resultRecordCount,
          semanticValidationStatus: replayed.semanticValidationStatus,
          detail,
          completedAt: new Date().toISOString(),
          retainedRunRoot: true,
          automaticRecursiveDeletionPerformed: false
        };
        const terminal = terminalRecord({ disposition: 'completion', plan, receipt });
        const terminalBytes = canonicalJsonBytes(terminal);
        markTerminalCreationAttempted('completion');
        const written = await writeExclusiveRegularFile(
          resolve(run.path, 'terminal.json'),
          terminalBytes,
          'Browser run terminal record',
          run
        );
        await assertExactOwnedRunIdentity({ approvedPlan, plan, run, runMarker, workspace });
        await assertExactRunLockIdentity({ workspace, lock, lockToken });
        await assertRetainedFileIdentity(written, terminalBytes, 'Browser run terminal record');
        markSettlementDurable('completion');
        return Object.freeze(receipt);
      } catch (error) {
        if (settlement.durableKind === null) failSettlement('completion');
        throw error;
      }
    },
    async retainFailure(failureOptions = {}) {
      assertExactOptionKeys(failureOptions, ['detail'], 'Owned browser run failure options');
      const { detail } = failureOptions;
      if (!isSha256(detail)) {
        throw new Error('Owned browser run failure detail must be one uppercase SHA-256 digest.');
      }
      beginSettlement('failure');
      try {
        await assertExactOwnedRunIdentity({ approvedPlan, plan, run, runMarker, workspace });
        await assertExactRunLockIdentity({ workspace, lock, lockToken });
        const receipt = {
          schema: 'sitewipe.owned-browser-run-failure.v1',
          runId: plan.runId,
          planSha256: plan.planSha256,
          detail,
          failedAt: new Date().toISOString(),
          retainedRunRoot: true,
          automaticRecursiveDeletionPerformed: false
        };
        const terminal = terminalRecord({ disposition: 'failure', plan, receipt });
        const terminalBytes = canonicalJsonBytes(terminal);
        markTerminalCreationAttempted('failure');
        const written = await writeExclusiveRegularFile(
          resolve(run.path, 'terminal.json'),
          terminalBytes,
          'Browser run terminal record',
          run
        );
        await assertExactOwnedRunIdentity({ approvedPlan, plan, run, runMarker, workspace });
        await assertExactRunLockIdentity({ workspace, lock, lockToken });
        await assertRetainedFileIdentity(written, terminalBytes, 'Browser run terminal record');
        markSettlementDurable('failure');
        return Object.freeze(receipt);
      } catch (error) {
        if (settlement.durableKind === null) failSettlement('failure');
        throw error;
      }
    }
  });
}

async function assertExactOwnedRunIdentity({ approvedPlan, plan, run, runMarker, workspace }) {
  await assertExactDirectoryIdentity(workspace, 'Browser workspace root');
  await assertRetainedFileIdentity(
    workspace.marker,
    canonicalJsonBytes({
      schema: 'sitewipe.browser-workspace.v1',
      purpose: 'SiteWipe synthetic installed-browser runs only'
    }),
    'Browser workspace marker'
  );
  await assertExactDirectoryIdentity(run, 'Browser run root');
  await assertRetainedFileIdentity(runMarker, runMarker.bytes, 'Browser run ownership marker');
  await assertRetainedFileIdentity(approvedPlan, canonicalJsonBytes(plan), 'Approved browser plan record');
}

async function assertRetainedFileIdentity(retained, expectedBytes, label) {
  if (!retained || !Buffer.isBuffer(retained.bytes)) {
    throw new Error(`${label} retained identity is unavailable.`);
  }
  const observed = await exactFileIdentity(retained.path, label);
  if (
    !sameFileIdentity(retained.information, observed.information) ||
    !observed.bytes.equals(retained.bytes) ||
    !observed.bytes.equals(expectedBytes)
  ) {
    throw new Error(`${label} identity changed; refusing settlement.`);
  }
  return observed;
}

function terminalRecord({ disposition, plan, receipt }) {
  if (!['completion', 'failure'].includes(disposition)) {
    throw new Error('Owned browser run terminal disposition is outside the exact policy.');
  }
  const receiptBytes = canonicalJsonBytes(receipt);
  return Object.freeze({
    schema: 'sitewipe.owned-browser-run-terminal.v1',
    disposition,
    runId: plan.runId,
    planSha256: plan.planSha256,
    receiptSha256: sha256(receiptBytes),
    receipt: structuredClone(receipt),
    retainedActiveLock: true,
    workspaceSealed: true,
    automaticRecursiveDeletionPerformed: false
  });
}

async function captureArtifactIdentity(artifact) {
  if (!artifact || !isNativeAbsolutePath(artifact.path) || !/^\d+\.\d+\.\d+$/.test(String(artifact.version || ''))) {
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
    const runtimeRoot = resolve(dirname(identity.path), pin.runtimeVersion);
    if (!samePath(runtimeRoot, pin.runtimeRootPath)) {
      throw new Error(`Pinned ${pin.name} runtime root is not the exact sibling version directory.`);
    }
    const runtime = await captureBrowserRuntimeClosure({
      runtimeRootPath: pin.runtimeRootPath,
      runtimeVersion: pin.runtimeVersion
    });
    const runtimeSummary = browserRuntimeClosureSummary(runtime);
    const approvedRuntimeSummary = Object.fromEntries(BROWSER_RUNTIME_SUMMARY_KEYS.map((key) => [key, pin[key]]));
    if (BROWSER_RUNTIME_SUMMARY_KEYS.some((key) => runtimeSummary[key] !== approvedRuntimeSummary[key])) {
      throw new Error(`Pinned ${pin.name} browser runtime closure changed.`);
    }
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
  let marker;
  try {
    marker = await exactFileIdentity(markerPath, 'Browser workspace marker');
    if (!marker.bytes.equals(canonicalJsonBytes(markerValue))) {
      throw new Error('Browser workspace marker differs from the exact ownership policy.');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const entries = await readdir(workspace.path);
    if (entries.length !== 0) {
      throw new Error('Unmarked browser workspace is not empty; refusing to claim it.', { cause: error });
    }
    marker = await writeExclusiveRegularFile(
      markerPath,
      canonicalJsonBytes(markerValue),
      'Browser workspace marker',
      workspace
    );
  }
  return Object.freeze({ ...workspace, marker });
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

async function assertExactRunLockIdentity({ workspace, lock, lockToken }) {
  await assertExactDirectoryIdentity(workspace, 'Browser workspace root');
  const observed = await exactFileIdentity(lock.path, 'Browser run lock');
  if (
    !sameFileIdentity(lock.information, observed.information) ||
    observed.sha256 !== lock.sha256 ||
    sha256(lockToken) !== lock.value.coordinationTokenSha256
  ) {
    throw new Error('Browser run lock identity changed; refusing release.');
  }
  return observed;
}

async function writeExclusiveRegularFile(path, bytes, label, parentIdentity) {
  if (!parentIdentity || !samePath(dirname(resolve(path)), parentIdentity.path)) {
    throw new Error(`${label} must remain a direct child of its exact approved parent.`);
  }
  await assertExactDirectoryIdentity(parentIdentity, `${label} parent directory`);
  const content = Buffer.from(bytes);
  // O_EXCL remains pathname-based in Node; retained child-handle and exact-parent
  // checks bound and detect that unavoidable close-to-parent race window.
  const handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
  let information;
  try {
    await handle.writeFile(content);
    await handle.sync();
    information = await handle.stat({ bigint: true });
    if (!information.isFile() || information.isSymbolicLink() || information.nlink !== 1n) {
      throw new Error(`${label} must remain one singly linked regular file.`);
    }
    const verifiedBytes = Buffer.alloc(content.length);
    const read = await handle.read(verifiedBytes, 0, verifiedBytes.length, 0);
    const afterRead = await handle.stat({ bigint: true });
    const childPath = await lstat(path, { bigint: true });
    const childRealPath = await realpath(path);
    await assertExactDirectoryIdentity(parentIdentity, `${label} parent directory during create`);
    if (
      read.bytesRead !== content.length ||
      !verifiedBytes.equals(content) ||
      !sameFileIdentity(information, afterRead) ||
      !sameFileIdentity(afterRead, childPath) ||
      childPath.nlink !== 1n ||
      !samePath(childRealPath, resolve(path))
    ) {
      throw new Error(`${label} changed across retained-handle child and parent validation.`);
    }
  } finally {
    await handle.close();
  }
  const observed = await exactFileIdentity(path, label);
  if (!sameFileIdentity(information, observed.information) || !observed.bytes.equals(content)) {
    throw new Error(`${label} identity or bytes changed immediately after exclusive creation.`);
  }
  await assertExactDirectoryIdentity(parentIdentity, `${label} parent directory`);
  if (!samePath(dirname(observed.path), parentIdentity.path)) {
    throw new Error(`${label} escaped its exact approved parent during creation.`);
  }
  const value = JSON.parse(observed.bytes.toString('utf8'));
  return Object.freeze({ ...observed, value });
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

async function assertExactDirectoryIdentity(identity, label) {
  const observed = await exactPhysicalDirectory(identity.path, label);
  if (!sameDirectoryIdentity(identity.information, observed.information)) throw new Error(`${label} identity changed.`);
  return observed;
}

async function exactFileIdentity(
  path,
  label,
  { allowInputAlias = false, allowWindowsSystemPowerShellHardLinks = false } = {}
) {
  const requested = resolve(assertNativeAbsolutePath(path, `${label} path`));
  const actual = await realpath(requested);
  if (!allowInputAlias && !samePath(actual, requested)) throw new Error(`${label} is aliased.`);
  const expected = actual;
  const before = await lstat(expected, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    !hasApprovedNativeFileLinkCount(before, { allowWindowsSystemPowerShellHardLinks })
  ) {
    throw new Error(
      allowWindowsSystemPowerShellHardLinks
        ? `${label} must be one regular non-reparse file with a stable nonzero link count.`
        : `${label} must be one singly linked regular non-reparse file.`
    );
  }
  const handle = await open(actual, 'r');
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      !hasApprovedNativeFileLinkCount(opened, { allowWindowsSystemPowerShellHardLinks })
    ) {
      throw new Error(
        allowWindowsSystemPowerShellHardLinks
          ? `${label} opened handle has no stable nonzero link count.`
          : `${label} opened handle is not singly linked.`
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const finalPath = await lstat(expected, { bigint: true });
    const finalRealPath = await realpath(expected);
    if (
      !hasApprovedNativeFileLinkCount(after, { allowWindowsSystemPowerShellHardLinks }) ||
      !hasApprovedNativeFileLinkCount(finalPath, { allowWindowsSystemPowerShellHardLinks }) ||
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

function validateInstalledBrowserPolicy(value) {
  if (
    JSON.stringify(Object.keys(value || {}).sort()) !==
      JSON.stringify(['browsers', 'launchPolicySha256', 'schema', 'transport']) ||
    value?.schema !== 'sitewipe.installed-browser-policy.v2' ||
    value?.launchPolicySha256 !== INSTALLED_RUNTIME_LAUNCH_POLICY_SHA256 ||
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
      JSON.stringify(Object.keys(entry || {}).sort()) !==
        JSON.stringify(
          ['executablePath', 'executableSha256', 'name', 'version', ...BROWSER_RUNTIME_SUMMARY_KEYS].sort()
        ) ||
      !REQUIRED_BROWSERS.includes(entry?.name) ||
      !isDriveQualifiedWindowsAbsolutePath(entry?.executablePath) ||
      !entry?.version ||
      !isSha256(entry?.executableSha256)
    ) {
      throw new Error('Installed browser policy contains an invalid pin.');
    }
    validateBrowserRuntimeSummary(Object.fromEntries(BROWSER_RUNTIME_SUMMARY_KEYS.map((key) => [key, entry[key]])));
    if (!isDriveQualifiedWindowsAbsolutePath(entry.runtimeRootPath)) {
      throw new Error('Installed browser policy contains a non-local runtime root pin.');
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
  if (!left || !right || left.isFile() !== right.isFile() || left.isDirectory() !== right.isDirectory()) return false;
  return STABLE_PHYSICAL_IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

function sameDirectoryIdentity(left, right) {
  if (!left || !right || !left.isDirectory() || !right.isDirectory()) return false;
  return ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev'].every((key) => left[key] === right[key]);
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

function isNativeAbsolutePath(value) {
  try {
    assertNativeAbsolutePath(value, 'Browser artifact path');
    return true;
  } catch {
    return false;
  }
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

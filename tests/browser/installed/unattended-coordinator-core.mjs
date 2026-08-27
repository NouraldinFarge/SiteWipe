import { createHash } from 'node:crypto';

import { computeCommittedBrowserHarnessManifestSha256 } from '../../../scripts/browser-validation-policy.mjs';
import { assertGitWorktreeClean } from '../../../scripts/source-archive.mjs';
import { assertTrustedGitRepository, runTrustedGit } from '../../../scripts/trusted-git.mjs';

import {
  BROWSER_MATRIX_VERSION,
  CANONICAL_BROWSER_MATRIX_IDS,
  CANONICAL_BROWSER_MATRIX_SHA256,
  REQUIRED_BROWSERS
} from './canonical-matrix.mjs';
import {
  APPROVED_UNATTENDED_ACTIONS,
  BROWSER_PLAN_SCHEMA,
  FIXED_FIXTURE_BIND_ADDRESSES,
  computePlanSha256,
  validateBrowserPlan
} from './evidence-contract.mjs';
import { SEMANTIC_VALIDATOR_MANIFEST_SHA256 } from './semantic-validator.mjs';
import { computeBrowserRuntimeSetSha256 } from './browser-runtime-closure.mjs';
import { INSTALLED_RUNTIME_LAUNCH_POLICY_SHA256 } from './launch-policy.mjs';
import {
  INSTALLED_BROWSER_TOOLCHAIN_SUMMARY_KEYS,
  validateInstalledBrowserToolchainSummary
} from './toolchain-closure.mjs';
import { FIXTURE_ALLOWED_METHODS, FIXTURE_ALLOWED_ROUTES, SYNTHETIC_FIXTURE_HOSTS } from '../fixture-server.mjs';
import {
  NATIVE_PROMPT_ALLOWED_ACTIONS,
  NATIVE_PROMPT_EXPECTED_FRAGMENTS,
  NATIVE_PROMPT_PERMISSION_PATTERNS,
  NATIVE_PROMPT_POLICY_SHA256,
  NATIVE_PROMPT_SCENARIO_SCHEDULE,
  NATIVE_PROMPT_UIA_SNAPSHOTS
} from './native-permission-dialog.mjs';

const COMMITTED_IDENTITY_PATHS = Object.freeze({
  package: 'package.json',
  packageLock: 'package-lock.json',
  versionState: 'docs/evidence/version-state.json'
});

export function captureCleanCommittedBrowserSourceSnapshot(repositoryRoot) {
  assertTrustedGitRepository(repositoryRoot);
  const commitSha = assertGitWorktreeClean(repositoryRoot).toLowerCase();
  return captureCommittedBrowserSourceSnapshot(repositoryRoot, commitSha);
}

export function captureCommittedBrowserSourceSnapshot(repositoryRoot, commitSha) {
  assertTrustedGitRepository(repositoryRoot);
  const exactCommitSha = String(commitSha || '').toLowerCase();
  if (!isGitObjectId(exactCommitSha)) {
    throw new Error('Unattended browser source commit identity is invalid.');
  }
  const treeSha = runTrustedGit({
    root: repositoryRoot,
    args: ['rev-parse', '--verify', `${exactCommitSha}^{tree}`],
    encoding: 'utf8'
  })
    .trim()
    .toLowerCase();
  if (!isGitObjectId(treeSha)) {
    throw new Error('Unattended browser source tree identity is invalid.');
  }

  const packageBytes = readCommittedBlob(repositoryRoot, exactCommitSha, COMMITTED_IDENTITY_PATHS.package);
  const packageLockBytes = readCommittedBlob(repositoryRoot, exactCommitSha, COMMITTED_IDENTITY_PATHS.packageLock);
  const versionStateBytes = readCommittedBlob(repositoryRoot, exactCommitSha, COMMITTED_IDENTITY_PATHS.versionState);
  const pkg = parseCommittedJson(packageBytes, COMMITTED_IDENTITY_PATHS.package);
  const versionState = parseCommittedJson(versionStateBytes, COMMITTED_IDENTITY_PATHS.versionState);
  if (!/^\d+\.\d+\.\d+$/.test(String(pkg?.version || ''))) {
    throw new Error('Committed package.json lacks a semantic version for browser planning.');
  }
  if (
    !isSha256(versionState?.runtimeFingerprintSha256) ||
    !isSha256(versionState?.releaseInputFingerprintSha256) ||
    !Number.isInteger(versionState?.releaseInputFileCount) ||
    versionState.releaseInputFileCount <= 0
  ) {
    throw new Error(
      'Committed version state lacks stable runtime and release-input fingerprints for browser planning.'
    );
  }

  return Object.freeze({
    commitSha: exactCommitSha,
    treeSha,
    packageVersion: pkg.version,
    packageLockSha256: sha256(packageLockBytes),
    runtimeFingerprintSha256: versionState.runtimeFingerprintSha256,
    releaseInputFingerprintSha256: versionState.releaseInputFingerprintSha256,
    harnessManifestSha256: computeCommittedBrowserHarnessManifestSha256(repositoryRoot, exactCommitSha)
  });
}

export function createUnattendedBrowserPlanRecord({
  repositoryPath,
  workspacePath,
  source,
  artifactIdentity,
  browserPins,
  gitIdentity,
  nodeIdentity,
  helperIdentity,
  processObserver,
  toolchainSummary,
  nodeRuntimeVersion,
  createdAt,
  randomBytesFn,
  retention
}) {
  if (source.packageVersion !== artifactIdentity.version) {
    throw new Error('Browser-plan artifact version differs from the exact committed source package version.');
  }
  validateInstalledBrowserToolchainSummary(toolchainSummary);
  const runBytes = Buffer.from(randomBytesFn(16));
  if (runBytes.length !== 16) throw new Error('Browser-plan run ID entropy source must return exactly 16 bytes.');

  const plan = {
    schema: BROWSER_PLAN_SCHEMA,
    matrixVersion: BROWSER_MATRIX_VERSION,
    matrixSha256: CANONICAL_BROWSER_MATRIX_SHA256,
    runId: `sitewipe-browser-${runBytes.toString('hex')}`,
    createdAt,
    requiredBrowsers: [...REQUIRED_BROWSERS],
    requiredMatrixIds: [...CANONICAL_BROWSER_MATRIX_IDS],
    semanticValidatorManifestSha256: SEMANTIC_VALIDATOR_MANIFEST_SHA256,
    identity: {
      sourceCommitSha: source.commitSha,
      sourceTreeSha: source.treeSha,
      artifactVersion: artifactIdentity.version,
      artifactBytes: artifactIdentity.bytes,
      artifactSha256: artifactIdentity.sha256,
      browserRuntimeSetSha256: computeBrowserRuntimeSetSha256(browserPins),
      harnessManifestSha256: source.harnessManifestSha256,
      launchPolicySha256: INSTALLED_RUNTIME_LAUNCH_POLICY_SHA256,
      gitExecutableSha256: gitIdentity.sha256,
      nativeHelperSha256: helperIdentity.sha256,
      processObserverHelperSha256: processObserver.helperSha256,
      powerShellExecutableSha256: processObserver.powershellSha256,
      nodeExecutableSha256: nodeIdentity.sha256,
      nodeRuntimeVersion,
      packageLockSha256: source.packageLockSha256,
      releaseInputFingerprintSha256: source.releaseInputFingerprintSha256,
      runtimeFingerprintSha256: source.runtimeFingerprintSha256,
      toolchainPuppeteerVersion: toolchainSummary.toolchainPuppeteerVersion,
      toolchainPackageCount: toolchainSummary.toolchainPackageCount,
      toolchainFileCount: toolchainSummary.toolchainFileCount,
      toolchainBytes: toolchainSummary.toolchainBytes,
      toolchainSetSha256: toolchainSummary.toolchainSetSha256
    },
    inputs: {
      repositoryRoot: repositoryPath,
      workspaceRoot: workspacePath,
      artifactPath: artifactIdentity.path,
      git: structuredClone(gitIdentity),
      browserPins,
      browserRuntimeSetSha256: computeBrowserRuntimeSetSha256(browserPins),
      launchPolicySha256: INSTALLED_RUNTIME_LAUNCH_POLICY_SHA256,
      fixture: {
        bindAddresses: [...FIXED_FIXTURE_BIND_ADDRESSES],
        allowedHosts: [...SYNTHETIC_FIXTURE_HOSTS],
        allowedRoutes: [...FIXTURE_ALLOWED_ROUTES],
        allowedMethods: [...FIXTURE_ALLOWED_METHODS],
        tokenBytes: 32,
        tokenGeneratedAfterApproval: true
      },
      nativePrompt: {
        helperPath: helperIdentity.path,
        helperSha256: helperIdentity.sha256,
        policySha256: NATIVE_PROMPT_POLICY_SHA256,
        allowedActions: [...NATIVE_PROMPT_ALLOWED_ACTIONS],
        permissionPatterns: [...NATIVE_PROMPT_PERMISSION_PATTERNS],
        expectedFragments: [...NATIVE_PROMPT_EXPECTED_FRAGMENTS],
        scenarioSchedule: structuredClone(NATIVE_PROMPT_SCENARIO_SCHEDULE),
        uiaSnapshots: structuredClone(NATIVE_PROMPT_UIA_SNAPSHOTS),
        requiresUnlockedInteractiveSession: true
      },
      processObserver: structuredClone(processObserver),
      toolchain: {
        nodeRuntimeVersion,
        ...Object.fromEntries(INSTALLED_BROWSER_TOOLCHAIN_SUMMARY_KEYS.map((key) => [key, toolchainSummary[key]]))
      },
      retention: structuredClone(retention)
    },
    approval: {
      mode: 'single-start-plan-sha256',
      additionalInteractiveApprovalsAllowed: false,
      approvedActions: [...APPROVED_UNATTENDED_ACTIONS]
    },
    planSha256: null
  };
  plan.planSha256 = computePlanSha256(plan);
  validateBrowserPlan(plan);
  return deepFreeze(plan);
}

export function assertApprovedBrowserPlanObservation(
  plan,
  { gitIdentity, identity, browserPins, processObserver, toolchain }
) {
  if (stableJson(gitIdentity) !== stableJson(plan.inputs.git)) {
    throw new Error('Approved trusted Git executable identity changed.');
  }
  if (stableJson(toolchain) !== stableJson(plan.inputs.toolchain)) {
    throw new Error('Approved installed-executor toolchain closure or Node version changed.');
  }
  if (stableJson(identity) !== stableJson(plan.identity)) {
    throw new Error(
      'Approved browser-plan committed source, artifact, harness, helper, Node, lock, or release fingerprint identity changed.'
    );
  }
  if (stableJson(browserPins) !== stableJson(plan.inputs.browserPins)) {
    throw new Error('Approved browser executable identity changed or differs from canonical installed-browser policy.');
  }
  if (stableJson(processObserver) !== stableJson(plan.inputs.processObserver)) {
    throw new Error('Approved process-observer or PowerShell identity changed.');
  }
  return plan;
}

function readCommittedBlob(repositoryRoot, commitSha, path) {
  const bytes = runTrustedGit({
    root: repositoryRoot,
    args: ['cat-file', 'blob', `${commitSha}:${path}`]
  });
  if (!Buffer.isBuffer(bytes) || bytes.length <= 0) {
    throw new Error(`Committed browser identity input is missing or empty: ${path}`);
  }
  return bytes;
}

function parseCommittedJson(bytes, path) {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`Committed browser identity JSON is malformed: ${path}`, { cause: error });
  }
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

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function isGitObjectId(value) {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value);
}

function isSha256(value) {
  return /^[A-F0-9]{64}$/.test(String(value || ''));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

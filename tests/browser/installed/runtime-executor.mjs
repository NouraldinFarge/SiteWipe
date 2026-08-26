import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, posix, relative, resolve, sep, win32 } from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { RUNTIME_FILES } from '../../../scripts/release-files.mjs';
import { runTrustedGit } from '../../../scripts/trusted-git.mjs';
import { readZipEntriesFromBuffer } from '../../../scripts/zip-utils.mjs';
import { SYNTHETIC_FIXTURE_HOSTS } from '../fixture-server.mjs';
import {
  SEMANTIC_VALIDATION_STATUS,
  canonicalJsonBytes,
  computeAggregateSha256,
  validateAndReplayBrowserAggregate,
  validateBrowserPlan
} from './evidence-contract.mjs';
import { NATIVE_PROMPT_POLICY_PATH, hasApprovedNativeFileLinkCount } from './native-permission-dialog.mjs';
import { assertNativeAbsolutePath, isDriveQualifiedWindowsAbsolutePath } from './path-contract.mjs';
import { SEMANTIC_VALIDATOR_MANIFEST_SHA256 } from './semantic-validator.mjs';
import {
  BROWSER_RUNTIME_SUMMARY_KEYS,
  browserRuntimeClosureSummary,
  captureBrowserRuntimeClosure
} from './browser-runtime-closure.mjs';
import {
  INSTALLED_RUNTIME_LAUNCH_POLICY,
  INSTALLED_RUNTIME_LAUNCH_POLICY_SHA256,
  LOOPBACK_HOST_RESOLVER_RULES,
  RUNTIME_NETWORK_ALLOWLIST,
  validateRuntimeProxyBinding
} from './launch-policy.mjs';
import {
  INSTALLED_BROWSER_TOOLCHAIN_SUMMARY_KEYS,
  captureInstalledBrowserToolchainClosure,
  installedBrowserToolchainClosureSummary
} from './toolchain-closure.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
const OWNED_RUN_MARKER_NAME = '.sitewipe-owned-run.json';
const APPROVED_PLAN_NAME = 'approved-plan.json';
const RUNTIME_DIRECTORY_NAME = 'runtime-extension';
const RUNTIME_RECEIPT_NAME = 'runtime-artifact.json';
const TOOLCHAIN_DIRECTORY_NAME = 'runtime-toolchain';
const BROWSER_CELLS_DIRECTORY_NAME = 'browser-cells';
const OWNED_DIRECTORY_MARKER_NAME = '.sitewipe-owned-browser-directory.json';
const OWNED_CELL_MARKER_NAME = '.sitewipe-owned-browser-cell.json';
const DOWNLOAD_CANARY_NAME = '.sitewipe-must-preserve-download.bin';
const MAX_RUNTIME_ZIP_BYTES = 16 * 1024 * 1024;
const MAX_RUNTIME_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_RUNTIME_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_HELPER_OUTPUT_BYTES = 1024 * 1024;
const PROCESS_HELPER_COMMITTED_PATH = 'tests/browser/installed/windows-process-identity.ps1';
const RUNTIME_FILE_SET = new Set(RUNTIME_FILES);
const BROWSER_CELL_KINDS = Object.freeze(['profile', 'downloads', 'evidence', 'screenshots']);
const WINDOWS_RESERVED_SEGMENT = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;
const SHA256_PATTERN = /^[A-F0-9]{64}$/u;
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/u;
const UNIX_HOST_SYSTEM = 3;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_REGULAR_FILE = 0o100000;
const EXPECTED_UNIX_MODE = 0o100644;
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
const STABLE_DIRECTORY_OBJECT_IDENTITY_KEYS = Object.freeze(['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev']);
const SPAWNED_SESSION_TIMEOUTS = Object.freeze({
  lateConnectionMs: 10_000,
  gracefulCloseMs: 20_000,
  processIdentityMs: 35_000,
  residueMs: 35_000,
  terminationMs: 30_000,
  canaryMs: 5_000
});

export const WINDOWS_PROCESS_IDENTITY_HELPER_PATH = resolve(directory, 'windows-process-identity.ps1');
export const INSTALLED_RUNTIME_CLOSE_POLICY_BOUND_MS =
  SPAWNED_SESSION_TIMEOUTS.lateConnectionMs +
  SPAWNED_SESSION_TIMEOUTS.gracefulCloseMs +
  SPAWNED_SESSION_TIMEOUTS.processIdentityMs +
  SPAWNED_SESSION_TIMEOUTS.residueMs * 2 +
  SPAWNED_SESSION_TIMEOUTS.terminationMs +
  SPAWNED_SESSION_TIMEOUTS.canaryMs;
export const RUNTIME_EXECUTOR_TEST_SUPPORT = Object.freeze({
  createSpawnedBrowserSessionOwner(options) {
    return createSpawnedBrowserSessionOwner(options);
  },
  loadVerifiedStagedPuppeteer(options) {
    return loadVerifiedStagedPuppeteer(options);
  },
  observeSpawnedChildSettlement(child) {
    return observeSpawnedChildSettlement(child);
  },
  readExactRetainedBytes(handle, length, label) {
    return readExactRetainedBytes(handle, length, label);
  },
  spawnWithActiveAuthority(signal, spawnAction) {
    return spawnWithActiveAuthority(signal, spawnAction);
  },
  sameFileIdentity(left, right) {
    return sameFileIdentity(left, right);
  },
  samePostCloseFileIdentity(left, right, platform) {
    return samePostCloseFileIdentity(left, right, platform);
  },
  settlePostSpawnPhase(promise, timeoutMs, label, signal) {
    return settlePostSpawnPhase(promise, timeoutMs, label, signal);
  },
  writeExclusiveRegularFile(options) {
    assertExactKeys(options, ['bytes', 'label', 'path', 'testHooks'], 'Runtime exclusive-writer test options');
    return writeExclusiveRegularFile(options.path, options.bytes, options.label, {
      testHooks: options.testHooks
    });
  }
});
export {
  INSTALLED_RUNTIME_LAUNCH_POLICY,
  INSTALLED_RUNTIME_LAUNCH_POLICY_SHA256,
  LOOPBACK_HOST_RESOLVER_RULES,
  RUNTIME_NETWORK_ALLOWLIST
} from './launch-policy.mjs';

export async function stageVerifiedRuntimeArtifact(options) {
  assertExactKeys(options, ['plan', 'runRoot'], 'Runtime artifact staging options');
  const { plan } = options;
  validateBrowserPlan(plan);
  const run = await assertOwnedRunRoot(options.runRoot, plan);
  await stageVerifiedInstalledBrowserToolchain({ plan, runRoot: run.path });
  const artifact = await exactFileIdentity(plan.inputs.artifactPath, 'Approved runtime ZIP');
  if (artifact.bytes.length > MAX_RUNTIME_ZIP_BYTES) {
    throw new Error('Approved runtime ZIP exceeds the installed-executor byte limit.');
  }
  if (artifact.bytes.length !== plan.identity.artifactBytes || artifact.sha256 !== plan.identity.artifactSha256) {
    throw new Error('Approved runtime ZIP bytes differ from the exact approved plan.');
  }

  const entries = await readStrictRuntimeArchive(artifact.bytes);
  const manifestEntry = entries.find((entry) => entry.path === 'manifest.json');
  const manifest = validateRuntimeManifest(manifestEntry?.bytes, plan.identity.artifactVersion);
  const extensionRootPath = assertDescendant(
    run.path,
    resolve(run.path, RUNTIME_DIRECTORY_NAME),
    'Runtime extension directory'
  );
  const extensionRoot = await createExclusivePhysicalDirectory(extensionRootPath, 'Runtime extension directory');

  const archiveDirectories = new Set();
  for (const entry of entries) {
    let archiveDirectory = posix.dirname(entry.path);
    while (archiveDirectory !== '.') {
      archiveDirectories.add(archiveDirectory);
      archiveDirectory = posix.dirname(archiveDirectory);
    }
  }
  const directoryPaths = [...archiveDirectories].sort(
    (left, right) => pathDepth(left) - pathDepth(right) || left.localeCompare(right)
  );
  for (const archiveDirectory of directoryPaths) {
    const target = descendantFromArchivePath(extensionRoot.path, archiveDirectory, 'Runtime archive directory');
    await createExclusivePhysicalDirectory(target, `Runtime archive directory ${archiveDirectory}`);
  }

  const files = [];
  for (const entry of entries) {
    const target = descendantFromArchivePath(extensionRoot.path, entry.path, 'Runtime archive file');
    const written = await writeExclusiveRegularFile(target, entry.bytes, `Runtime archive file ${entry.path}`, {
      readOnly: true
    });
    files.push({ path: entry.path, bytes: entry.bytes.length, sha256: written.sha256 });
  }

  const contentSetSha256 = sha256(canonicalJsonBytes(files));
  const receipt = {
    schema: 'sitewipe.staged-runtime-artifact.v1',
    runId: plan.runId,
    planSha256: plan.planSha256,
    artifactVersion: plan.identity.artifactVersion,
    artifactBytes: artifact.bytes.length,
    artifactSha256: artifact.sha256,
    extensionDirectoryName: RUNTIME_DIRECTORY_NAME,
    manifest: {
      manifestVersion: manifest.manifest_version,
      name: manifest.name,
      version: manifest.version,
      serviceWorker: manifest.background.service_worker,
      defaultPopup: manifest.action.default_popup,
      optionsPage: manifest.options_page
    },
    fileCount: files.length,
    contentSetSha256,
    files,
    semanticValidationStatus: SEMANTIC_VALIDATION_STATUS,
    semanticValidatorManifestSha256: SEMANTIC_VALIDATOR_MANIFEST_SHA256,
    stagedAt: new Date().toISOString()
  };
  await verifyRuntimeTree(extensionRoot.path, files);
  await writeExclusiveRegularFile(
    resolve(run.path, RUNTIME_RECEIPT_NAME),
    canonicalJsonBytes(receipt),
    'Runtime artifact staging receipt'
  );
  return deepFreeze({
    ...structuredClone(receipt),
    extensionRoot: extensionRoot.path,
    toolchainRoot: resolve(run.path, TOOLCHAIN_DIRECTORY_NAME)
  });
}

async function stageVerifiedInstalledBrowserToolchain({ plan, runRoot }) {
  const source = await captureApprovedInstalledBrowserToolchain(plan);
  const toolchainRoot = resolve(runRoot, TOOLCHAIN_DIRECTORY_NAME);
  await createExclusivePhysicalDirectory(toolchainRoot, 'Staged browser toolchain directory');
  const stagedNodeModulesPath = resolve(toolchainRoot, 'node_modules');
  await createExclusivePhysicalDirectory(stagedNodeModulesPath, 'Staged browser toolchain node_modules directory');
  const createdDirectories = new Set([samePathKey(toolchainRoot), samePathKey(stagedNodeModulesPath)]);
  const ensureDirectory = async (directoryPath) => {
    const ancestors = [];
    let cursor = directoryPath;
    while (!createdDirectories.has(samePathKey(cursor))) {
      ancestors.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor || !isDescendantOrEqual(toolchainRoot, parent)) {
        throw new Error('Staged toolchain directory escaped its exact owned root.');
      }
      cursor = parent;
    }
    for (const target of ancestors.reverse()) {
      await createExclusivePhysicalDirectory(target, 'Staged browser toolchain package directory');
      createdDirectories.add(samePathKey(target));
    }
  };

  const sourceLock = await exactFileIdentity(source.packageLockPath, 'Approved installed-browser package lock');
  await writeExclusiveRegularFile(
    resolve(toolchainRoot, 'package-lock.json'),
    sourceLock.bytes,
    'Staged browser toolchain package lock',
    { readOnly: true }
  );
  for (const packageEntry of source.packages) {
    for (const file of packageEntry.files) {
      const sourcePath = resolve(packageEntry.packagePath, ...file.relativePath.split('/'));
      const observed = await exactFileIdentity(sourcePath, `Approved toolchain file ${file.relativePath}`);
      if (observed.bytes.length !== file.bytes || observed.sha256 !== file.sha256) {
        throw new Error('Approved installed-browser toolchain changed while its owned stage was created.');
      }
      const target = resolve(toolchainRoot, ...packageEntry.lockPath.split('/'), ...file.relativePath.split('/'));
      if (!isDescendantOrEqual(toolchainRoot, target) || sameHostPath(toolchainRoot, target)) {
        throw new Error('Staged toolchain file escaped its exact owned root.');
      }
      await ensureDirectory(dirname(target));
      await writeExclusiveRegularFile(target, observed.bytes, 'Staged installed-browser toolchain file', {
        readOnly: true
      });
    }
  }
  const staged = await captureInstalledBrowserToolchainClosure({
    packageLockPath: resolve(toolchainRoot, 'package-lock.json'),
    nodeModulesPath: stagedNodeModulesPath
  });
  assertSamePathFreeToolchainClosure(source, staged, plan);
  const replay = await captureInstalledBrowserToolchainClosure({
    packageLockPath: staged.packageLockPath,
    nodeModulesPath: staged.nodeModulesPath
  });
  assertSamePathFreeToolchainClosure(staged, replay, plan);
  return deepFreeze({ toolchainRoot, closure: staged });
}

export async function stageOwnedBrowserCell(options) {
  assertExactKeys(options, ['browserName', 'plan', 'runRoot', 'scenarioId'], 'Owned browser-cell staging options');
  const { browserName, plan, scenarioId } = options;
  validateBrowserPlan(plan);
  assertBrowserAndScenario(plan, browserName, scenarioId);
  const run = await assertOwnedRunRoot(options.runRoot, plan);
  const canaryBytes = Buffer.from(randomBytes(32));
  if (canaryBytes.length !== 32) throw new Error('Download preservation canary requires exactly 32 random bytes.');
  const canarySha256 = sha256(canaryBytes);

  const cells = await ensureOwnedContainer(run.path, BROWSER_CELLS_DIRECTORY_NAME, {
    schema: 'sitewipe.owned-browser-container.v1',
    runId: plan.runId,
    planSha256: plan.planSha256,
    kind: 'all-browser-cells'
  });
  const browserRoot = await ensureOwnedContainer(cells.path, browserName, {
    schema: 'sitewipe.owned-browser-container.v1',
    runId: plan.runId,
    planSha256: plan.planSha256,
    kind: 'browser',
    browserName
  });
  const scenarioRootPath = assertDescendant(
    browserRoot.path,
    resolve(browserRoot.path, scenarioId),
    'Browser scenario directory'
  );
  const scenarioRoot = await createExclusivePhysicalDirectory(scenarioRootPath, 'Browser scenario directory');
  const scenarioMarker = {
    schema: 'sitewipe.owned-browser-cell.v1',
    runId: plan.runId,
    planSha256: plan.planSha256,
    browserName,
    scenarioId,
    canarySha256,
    state: 'staged'
  };
  await writeExclusiveRegularFile(
    resolve(scenarioRoot.path, OWNED_CELL_MARKER_NAME),
    canonicalJsonBytes(scenarioMarker),
    'Browser cell marker'
  );

  const paths = {};
  for (const kind of BROWSER_CELL_KINDS) {
    const child = await createExclusivePhysicalDirectory(resolve(scenarioRoot.path, kind), `Browser ${kind} directory`);
    const marker = {
      schema: 'sitewipe.owned-browser-directory.v1',
      runId: plan.runId,
      planSha256: plan.planSha256,
      browserName,
      scenarioId,
      kind,
      canarySha256
    };
    await writeExclusiveRegularFile(
      resolve(child.path, OWNED_DIRECTORY_MARKER_NAME),
      canonicalJsonBytes(marker),
      `Browser ${kind} directory marker`
    );
    paths[kind] = child.path;
  }

  const canary = await writeExclusiveRegularFile(
    resolve(paths.downloads, DOWNLOAD_CANARY_NAME),
    canaryBytes,
    'Must-preserve download canary',
    { readOnly: true }
  );
  return deepFreeze({
    schema: 'sitewipe.staged-browser-cell.v1',
    runId: plan.runId,
    planSha256: plan.planSha256,
    browserName,
    scenarioId,
    scenarioRoot: scenarioRoot.path,
    profilePath: paths.profile,
    downloadPath: paths.downloads,
    evidencePath: paths.evidence,
    screenshotPath: paths.screenshots,
    canaryPath: canary.path,
    canarySha256: canary.sha256,
    syntheticDownloadsMayBeCreated: true,
    automaticDownloadDeletion: false
  });
}

export async function writeCanonicalBrowserAggregate(options) {
  assertExactKeys(options, ['aggregate', 'plan', 'runRoot'], 'Canonical browser aggregate options');
  const { aggregate, plan } = options;
  validateBrowserPlan(plan);
  const run = await assertOwnedRunRoot(options.runRoot, plan);
  const replayed = validateAndReplayBrowserAggregate(aggregate, { plan });
  const bytes = canonicalJsonBytes(replayed);
  const aggregatePath = resolve(run.path, 'aggregate.json');
  const written = await writeExclusiveRegularFile(aggregatePath, bytes, 'Canonical browser aggregate');
  const expectedSha256 = computeAggregateSha256(replayed);
  if (written.sha256 !== expectedSha256) {
    throw new Error('Canonical browser aggregate file hash differs from its mechanical replay hash.');
  }
  return deepFreeze({
    schema: 'sitewipe.persisted-browser-aggregate.v1',
    aggregateRelativePath: 'aggregate.json',
    aggregatePath: written.path,
    aggregateSha256: written.sha256,
    state: replayed.state,
    semanticValidationStatus: replayed.semanticValidationStatus
  });
}

export async function completeOwnedBrowserRunWithAggregate(options) {
  assertExactKeys(options, ['aggregate', 'detail', 'ownedRun', 'plan'], 'Owned browser aggregate completion options');
  const { aggregate, detail, ownedRun, plan } = options;
  if (
    !ownedRun ||
    typeof ownedRun !== 'object' ||
    typeof ownedRun.complete !== 'function' ||
    typeof ownedRun.runRoot !== 'string'
  ) {
    throw new Error('Owned browser aggregate completion requires the exact prepared-run capability.');
  }
  if (detail !== null && (typeof detail !== 'string' || !detail.trim())) {
    throw new Error('Owned browser aggregate completion detail must be null or non-empty.');
  }
  const persisted = await writeCanonicalBrowserAggregate({
    aggregate,
    plan,
    runRoot: ownedRun.runRoot
  });
  const completion = await ownedRun.complete({ detail });
  return deepFreeze({ persisted: structuredClone(persisted), completion: structuredClone(completion) });
}

export async function verifyInstalledSiteWipeExtension(browser, options) {
  assertExactKeys(options, ['expectedVersion', 'extensionPath'], 'Installed extension verification options');
  if (!browser || typeof browser.extensions !== 'function') {
    throw new Error('Installed extension verification requires a Puppeteer Browser.');
  }
  if (!/^\d+\.\d+\.\d+$/u.test(String(options.expectedVersion || ''))) {
    throw new Error('Installed extension verification requires an exact semantic version.');
  }
  const extensionPath = resolve(assertNativeAbsolutePath(options.extensionPath, 'Installed extension path'));
  const extensions = await browser.extensions();
  if (!(extensions instanceof Map) || extensions.size !== 1) {
    throw new Error('Disposable browser must contain exactly one installed unpacked extension.');
  }
  const [mapEntry] = [...extensions.entries()];
  const [extensionId, extension] = mapEntry;
  if (
    !EXTENSION_ID_PATTERN.test(String(extensionId || '')) ||
    extension?.id !== extensionId ||
    extension?.name !== 'SiteWipe' ||
    extension?.version !== options.expectedVersion ||
    extension?.enabled !== true ||
    typeof extension?.triggerAction !== 'function' ||
    !sameHostPath(extension?.path, extensionPath)
  ) {
    throw new Error('Installed extension identity differs from the exact staged SiteWipe artifact.');
  }
  return extension;
}

export async function launchPinnedSiteWipeBrowser(options) {
  assertExactKeys(
    options,
    ['browserName', 'plan', 'proxy', 'registerCleanup', 'runRoot', 'scenarioId', 'signal'],
    'Pinned browser launch options'
  );
  if (process.platform !== 'win32')
    throw new Error('The pinned installed-browser executor currently requires Windows.');
  if (typeof options.registerCleanup !== 'function' || !(options.signal instanceof AbortSignal)) {
    throw new Error('Pinned browser launch requires the runner cleanup registrar and cancellation signal.');
  }
  assertActiveLaunchSignal(options.signal);
  const { browserName, plan, scenarioId } = options;
  const proxy = validateRuntimeProxyBinding(options.proxy);
  validateBrowserPlan(plan);
  assertBrowserAndScenario(plan, browserName, scenarioId);
  const run = await assertOwnedRunRoot(options.runRoot, plan);
  const runtime = await loadAndVerifyRuntimeStage(run.path, plan);
  const cell = await loadAndVerifyBrowserCell(run.path, plan, browserName, scenarioId, { requirePristine: true });
  const browserPin = plan.inputs.browserPins.find((entry) => entry.name === browserName);
  const browserRuntime = browserRuntimeClosureSummary(
    await captureBrowserRuntimeClosure({
      runtimeRootPath: browserPin.runtimeRootPath,
      runtimeVersion: browserPin.runtimeVersion
    })
  );
  if (BROWSER_RUNTIME_SUMMARY_KEYS.some((key) => browserRuntime[key] !== browserPin[key])) {
    throw new Error(`Pinned ${browserName} browser runtime closure changed before launch.`);
  }
  const executable = await exactFileIdentity(browserPin.executablePath, `Pinned ${browserName} executable`);
  if (executable.sha256 !== browserPin.executableSha256) {
    throw new Error(`Pinned ${browserName} executable bytes changed before launch.`);
  }
  const launchOptions = buildLaunchOptions({
    executablePath: executable.path,
    extensionPath: runtime.extensionRoot,
    profilePath: cell.profilePath,
    downloadPath: cell.downloadPath,
    proxy
  });
  const { PipeTransport, puppeteer } = await loadVerifiedStagedPuppeteer({ plan, runtime });
  const browserArguments = [...(await puppeteer.defaultArgs(launchOptions)), '--remote-debugging-pipe'];
  assertExactDirectLaunchArguments(browserArguments, launchOptions);
  const child = spawnWithActiveAuthority(options.signal, () =>
    spawn(executable.path, browserArguments, {
      detached: true,
      env: launchOptions.env,
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
  );
  const childSettlement = observeSpawnedChildSettlement(child);
  const session = createSpawnedBrowserSessionOwner({
    browserName,
    browserPin,
    cell,
    child,
    childSettlement,
    plan
  });
  // Ownership is transferred immediately after spawn, before transport connection,
  // process observation, browser queries, extension enumeration, or runtime replay.
  options.registerCleanup(session.close);
  if (!Number.isInteger(child.pid) || child.pid <= 0 || !child.stdio[3] || !child.stdio[4]) {
    throw new Error('Direct pinned browser spawn did not expose one exact process and CDP pipe pair.');
  }

  const transport = new PipeTransport(child.stdio[3], child.stdio[4]);
  const browserPromise = Promise.resolve(
    puppeteer.connect({
      acceptInsecureCerts: launchOptions.acceptInsecureCerts,
      allowlist: launchOptions.allowlist,
      defaultViewport: launchOptions.defaultViewport,
      downloadBehavior: launchOptions.downloadBehavior,
      protocol: launchOptions.protocol,
      protocolTimeout: launchOptions.protocolTimeout,
      transport
    })
  );
  session.bindBrowserPromise(browserPromise);
  const browser = await settlePostSpawnPhase(
    rejectOnEarlyChildSettlement(browserPromise, childSettlement),
    30_000,
    'Puppeteer CDP pipe connection',
    options.signal
  );
  session.bindBrowser(browser);
  const processIdentity = await settlePostSpawnPhase(
    observeWindowsBrowserProcessIdentity({
      plan,
      processId: child.pid,
      browserPin,
      profilePath: cell.profilePath
    }),
    35_000,
    'Pinned browser process observation',
    options.signal
  );
  session.bindProcessIdentity(processIdentity);
  const browserVersion = await settlePostSpawnPhase(
    browser.version(),
    10_000,
    'Pinned browser version query',
    options.signal
  );
  assertObservedBrowserMajor(browserPin, browserVersion);
  if (typeof browser.installExtension !== 'function') {
    throw new Error('Approved Puppeteer browser lacks the exact extension installation API.');
  }
  await settlePostSpawnPhase(
    browser.installExtension(runtime.extensionRoot, { enabledInIncognito: false }),
    30_000,
    'Pinned SiteWipe extension installation',
    options.signal
  );
  const extension = await settlePostSpawnPhase(
    verifyInstalledSiteWipeExtension(browser, {
      extensionPath: runtime.extensionRoot,
      expectedVersion: plan.identity.artifactVersion
    }),
    20_000,
    'Installed extension enumeration',
    options.signal
  );
  const postLoadRuntime = await settlePostSpawnPhase(
    loadAndVerifyRuntimeStage(run.path, plan),
    30_000,
    'Post-load staged runtime replay',
    options.signal
  );
  if (postLoadRuntime.contentSetSha256 !== runtime.contentSetSha256) {
    throw new Error('Staged SiteWipe runtime identity changed while the browser loaded the extension.');
  }
  await settlePostSpawnPhase(
    revalidatePinnedBrowserRuntime(browserPin),
    60_000,
    'Post-load pinned browser closure replay',
    options.signal
  );
  await settlePostSpawnPhase(
    revalidateStagedInstalledBrowserToolchain(postLoadRuntime, plan),
    60_000,
    'Post-load staged toolchain replay',
    options.signal
  );
  return createLaunchedRuntimeController({
    browser,
    browserName,
    browserPin,
    browserVersion,
    cell,
    close: session.close,
    extension,
    plan,
    processIdentity,
    proxy,
    runtime: postLoadRuntime
  });
}

export async function revalidateApprovedInstalledBrowserToolchain(plan) {
  const closure = await captureApprovedInstalledBrowserToolchain(plan);
  return deepFreeze(toolchainObservation(closure));
}

async function captureApprovedInstalledBrowserToolchain(plan) {
  validateBrowserPlan(plan);
  const packageLockPath = resolve(plan.inputs.repositoryRoot, 'package-lock.json');
  const nodeModulesPath = resolve(plan.inputs.repositoryRoot, 'node_modules');
  const [packageLockBefore, nodeExecutable] = await Promise.all([
    exactFileIdentity(packageLockPath, 'Approved installed-browser package lock'),
    exactFileIdentity(process.execPath, 'Approved Node executable', { allowInputAlias: true })
  ]);
  if (
    packageLockBefore.sha256 !== plan.identity.packageLockSha256 ||
    nodeExecutable.sha256 !== plan.identity.nodeExecutableSha256 ||
    process.version !== plan.inputs.toolchain.nodeRuntimeVersion ||
    process.version !== plan.identity.nodeRuntimeVersion
  ) {
    throw new Error('Installed-browser package lock, Node executable, or Node version changed after approval.');
  }
  const closure = await captureInstalledBrowserToolchainClosure({ packageLockPath, nodeModulesPath });
  const packageLockAfter = await exactFileIdentity(packageLockPath, 'Approved installed-browser package lock');
  if (
    packageLockAfter.sha256 !== packageLockBefore.sha256 ||
    !sameFileIdentity(packageLockBefore.information, packageLockAfter.information)
  ) {
    throw new Error('Installed-browser package lock changed during prelaunch toolchain validation.');
  }
  const observed = toolchainObservation(closure);
  if (stableJson(observed) !== stableJson(plan.inputs.toolchain)) {
    throw new Error('Installed-browser toolchain closure changed after approval.');
  }
  return closure;
}

function toolchainObservation(closure) {
  const summary = installedBrowserToolchainClosureSummary(closure);
  return {
    nodeRuntimeVersion: process.version,
    ...Object.fromEntries(INSTALLED_BROWSER_TOOLCHAIN_SUMMARY_KEYS.map((key) => [key, summary[key]]))
  };
}

function assertSamePathFreeToolchainClosure(expected, observed, plan) {
  const expectedSummary = installedBrowserToolchainClosureSummary(expected);
  const observedSummary = installedBrowserToolchainClosureSummary(observed);
  for (const key of INSTALLED_BROWSER_TOOLCHAIN_SUMMARY_KEYS) {
    if (key === 'toolchainManifestSha256') continue;
    if (expectedSummary[key] !== observedSummary[key]) {
      throw new Error('Staged installed-browser toolchain differs from the complete approved package set.');
    }
  }
  const planned = plan.inputs.toolchain;
  for (const key of INSTALLED_BROWSER_TOOLCHAIN_SUMMARY_KEYS) {
    if (key === 'toolchainManifestSha256') continue;
    if (observedSummary[key] !== planned[key]) {
      throw new Error('Staged installed-browser toolchain differs from the approved plan summary.');
    }
  }
}

async function revalidateStagedInstalledBrowserToolchain(runtime, plan) {
  const toolchainRoot = resolve(runtime.toolchainRoot);
  const closure = await captureInstalledBrowserToolchainClosure({
    packageLockPath: resolve(toolchainRoot, 'package-lock.json'),
    nodeModulesPath: resolve(toolchainRoot, 'node_modules')
  });
  assertSamePathFreeToolchainClosure(closure, closure, plan);
  return closure;
}

async function loadVerifiedStagedPuppeteer({ plan, runtime }) {
  const before = await revalidateStagedInstalledBrowserToolchain(runtime, plan);
  const puppeteerEntry = resolve(
    runtime.toolchainRoot,
    'node_modules',
    'puppeteer-core',
    'lib',
    'puppeteer',
    'puppeteer-core.js'
  );
  const pipeTransportEntry = resolve(
    runtime.toolchainRoot,
    'node_modules',
    'puppeteer-core',
    'lib',
    'puppeteer',
    'node',
    'PipeTransport.js'
  );
  // Node resolves and opens module files by pathname rather than through a retained
  // directory handle. The built-in synchronous hook confines this evaluation graph
  // to Node built-ins plus the verified owned stage. Whole-closure replay before and
  // after evaluation bounds/detects same-privilege drift; it is not an absolute claim
  // that a pathname cannot be swapped between verification and Node's internal open.
  const moduleBoundary = registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolvedModule = nextResolve(specifier, context);
      assertStagedModuleUrl(resolvedModule.url, runtime.toolchainRoot);
      return resolvedModule;
    },
    load(url, context, nextLoad) {
      assertStagedModuleUrl(url, runtime.toolchainRoot);
      return nextLoad(url, context);
    }
  });
  let puppeteerModule;
  let transportModule;
  try {
    [puppeteerModule, transportModule] = await Promise.all([
      import(pathToFileURL(puppeteerEntry).href),
      import(pathToFileURL(pipeTransportEntry).href)
    ]);
  } finally {
    moduleBoundary.deregister();
  }
  const after = await revalidateStagedInstalledBrowserToolchain(runtime, plan);
  assertSamePathFreeToolchainClosure(before, after, plan);
  const puppeteer = puppeteerModule.default;
  const { PipeTransport } = transportModule;
  if (
    !puppeteer ||
    typeof puppeteer.connect !== 'function' ||
    typeof puppeteer.defaultArgs !== 'function' ||
    typeof PipeTransport !== 'function'
  ) {
    throw new Error('Verified staged Puppeteer closure lacks the exact direct-pipe APIs.');
  }
  return Object.freeze({ PipeTransport, puppeteer });
}

function assertStagedModuleUrl(value, toolchainRoot) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Verified runtime module resolution returned no exact URL.');
  }
  if (value.startsWith('node:')) return;
  if (!value.startsWith('file:')) {
    throw new Error('Verified runtime module resolution escaped Node built-ins and the owned toolchain stage.');
  }
  const modulePath = fileURLToPath(value);
  if (!isDescendantOrEqual(toolchainRoot, modulePath) || sameHostPath(toolchainRoot, modulePath)) {
    throw new Error('Verified runtime module resolution escaped the exact owned toolchain stage.');
  }
}

async function revalidatePinnedBrowserRuntime(browserPin) {
  const observed = browserRuntimeClosureSummary(
    await captureBrowserRuntimeClosure({
      runtimeRootPath: browserPin.runtimeRootPath,
      runtimeVersion: browserPin.runtimeVersion
    })
  );
  if (BROWSER_RUNTIME_SUMMARY_KEYS.some((key) => observed[key] !== browserPin[key])) {
    throw new Error('Pinned browser runtime closure changed during direct launch or load.');
  }
  return observed;
}

export function assertSyntheticFixturePageUrl(value, allowedHosts = SYNTHETIC_FIXTURE_HOSTS) {
  if (!Array.isArray(allowedHosts) || JSON.stringify(allowedHosts) !== JSON.stringify(SYNTHETIC_FIXTURE_HOSTS)) {
    throw new Error('Synthetic action target hosts differ from the exact fixture policy.');
  }
  let url;
  try {
    url = new URL(String(value || ''));
  } catch (error) {
    throw new Error('SiteWipe action target is not a valid synthetic fixture URL.', { cause: error });
  }
  const hostname =
    url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname;
  if (
    url.protocol !== 'http:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.hash !== '' ||
    !allowedHosts.includes(hostname)
  ) {
    throw new Error('SiteWipe action target is outside the exact synthetic HTTP fixture hosts.');
  }
  return url;
}

export function validateWindowsProcessIdentityObservation(evidence, request) {
  assertExactKeys(
    request,
    ['expectedProcessPath', 'expectedProcessSha256', 'expectedProfilePath', 'processId'],
    'Windows identity observation request'
  );
  if (
    !Number.isInteger(request.processId) ||
    request.processId <= 0 ||
    !isDriveQualifiedWindowsAbsolutePath(request.expectedProcessPath) ||
    !isDriveQualifiedWindowsAbsolutePath(request.expectedProfilePath) ||
    !isSha256(request.expectedProcessSha256)
  ) {
    throw new Error('Windows identity observation request is malformed.');
  }
  assertExactKeys(evidence, ['mode', 'observedAt', 'schema', 'targetProcess'], 'Windows identity evidence');
  assertExactKeys(
    evidence.targetProcess,
    ['commandLineSha256', 'parentProcessId', 'path', 'processId', 'profilePath', 'sha256', 'startTimeUtcTicks'],
    'Windows identity target process'
  );
  if (
    evidence.schema !== 'sitewipe.windows-process-observation.v1' ||
    evidence.mode !== 'identity' ||
    evidence.targetProcess.processId !== request.processId ||
    !Number.isInteger(evidence.targetProcess.parentProcessId) ||
    evidence.targetProcess.parentProcessId < 0 ||
    !sameWindowsPath(evidence.targetProcess.path, request.expectedProcessPath) ||
    evidence.targetProcess.sha256 !== request.expectedProcessSha256 ||
    !/^\d+$/u.test(String(evidence.targetProcess.startTimeUtcTicks || '')) ||
    !sameWindowsPath(evidence.targetProcess.profilePath, request.expectedProfilePath) ||
    !isSha256(evidence.targetProcess.commandLineSha256) ||
    Number.isNaN(Date.parse(String(evidence.observedAt || '')))
  ) {
    throw new Error('Windows identity evidence differs from the exact launched browser request.');
  }
  return evidence;
}

export function validateWindowsProfileResidueObservation(evidence, request) {
  assertExactKeys(
    request,
    [
      'expectedProcessPath',
      'expectedProcessSha256',
      'expectedProcessStartTimeUtcTicks',
      'expectedProfilePath',
      'processId'
    ],
    'Windows residue observation request'
  );
  if (
    !Number.isInteger(request.processId) ||
    request.processId <= 0 ||
    !isDriveQualifiedWindowsAbsolutePath(request.expectedProcessPath) ||
    !isDriveQualifiedWindowsAbsolutePath(request.expectedProfilePath) ||
    !isSha256(request.expectedProcessSha256) ||
    !/^\d+$/u.test(String(request.expectedProcessStartTimeUtcTicks || ''))
  ) {
    throw new Error('Windows residue observation request is malformed.');
  }
  assertExactKeys(
    evidence,
    ['mode', 'observedAt', 'profilePath', 'residues', 'rootIdentity', 'schema'],
    'Windows residue evidence'
  );
  assertExactKeys(
    evidence.rootIdentity,
    ['path', 'present', 'processId', 'sha256', 'startTimeUtcTicks'],
    'Windows residue root identity'
  );
  if (
    evidence.schema !== 'sitewipe.windows-process-observation.v1' ||
    evidence.mode !== 'profile-residue' ||
    evidence.rootIdentity.processId !== request.processId ||
    !sameWindowsPath(evidence.rootIdentity.path, request.expectedProcessPath) ||
    evidence.rootIdentity.sha256 !== request.expectedProcessSha256 ||
    evidence.rootIdentity.startTimeUtcTicks !== request.expectedProcessStartTimeUtcTicks ||
    typeof evidence.rootIdentity.present !== 'boolean' ||
    !sameWindowsPath(evidence.profilePath, request.expectedProfilePath) ||
    !Array.isArray(evidence.residues) ||
    evidence.residues.length > 1024 ||
    Number.isNaN(Date.parse(String(evidence.observedAt || '')))
  ) {
    throw new Error('Windows residue evidence differs from the exact launched browser request.');
  }
  let previousProcessId = 0;
  for (const residue of evidence.residues) {
    assertExactKeys(
      residue,
      ['commandLineSha256', 'matchedBy', 'parentProcessId', 'path', 'processId', 'sha256', 'startTimeUtcTicks'],
      'Windows process residue'
    );
    const nullableIdentityIsExact =
      (residue.path === null && residue.sha256 === null) ||
      (isDriveQualifiedWindowsAbsolutePath(residue.path) && isSha256(residue.sha256));
    const nullableCommandHash = residue.commandLineSha256 === null || isSha256(residue.commandLineSha256);
    const exactMatches = ['process-tree', 'profile-argument'].filter((item) => residue.matchedBy?.includes(item));
    if (
      !Number.isInteger(residue.processId) ||
      residue.processId <= previousProcessId ||
      !Number.isInteger(residue.parentProcessId) ||
      residue.parentProcessId < 0 ||
      !nullableIdentityIsExact ||
      !nullableCommandHash ||
      !/^\d+$/u.test(String(residue.startTimeUtcTicks || '')) ||
      !Array.isArray(residue.matchedBy) ||
      residue.matchedBy.length === 0 ||
      new Set(residue.matchedBy).size !== residue.matchedBy.length ||
      JSON.stringify(exactMatches) !== JSON.stringify(residue.matchedBy)
    ) {
      throw new Error('Windows process residue is malformed, duplicated, or not profile/tree-bound.');
    }
    previousProcessId = residue.processId;
  }
  if (evidence.rootIdentity.present && !evidence.residues.some((entry) => entry.processId === request.processId)) {
    throw new Error('Windows residue evidence omitted the still-present exact browser root process.');
  }
  return evidence;
}

export function validateWindowsProcessTerminationObservation(evidence, request) {
  assertExactKeys(
    request,
    [
      'expectedProcessPath',
      'expectedProcessSha256',
      'expectedProcessStartTimeUtcTicks',
      'expectedProfilePath',
      'processId'
    ],
    'Windows termination request'
  );
  if (
    !Number.isInteger(request.processId) ||
    request.processId <= 0 ||
    !isDriveQualifiedWindowsAbsolutePath(request.expectedProcessPath) ||
    !isDriveQualifiedWindowsAbsolutePath(request.expectedProfilePath) ||
    !isSha256(request.expectedProcessSha256) ||
    !/^\d+$/u.test(String(request.expectedProcessStartTimeUtcTicks || ''))
  ) {
    throw new Error('Windows termination request is malformed.');
  }
  assertExactKeys(
    evidence,
    ['mode', 'observedAt', 'rootIdentity', 'schema', 'terminatedProcesses'],
    'Windows termination evidence'
  );
  assertExactKeys(
    evidence.rootIdentity,
    ['path', 'present', 'processId', 'sha256', 'startTimeUtcTicks'],
    'Windows termination root identity'
  );
  if (
    evidence.schema !== 'sitewipe.windows-process-termination.v1' ||
    evidence.mode !== 'terminate-tree' ||
    evidence.rootIdentity.processId !== request.processId ||
    !sameWindowsPath(evidence.rootIdentity.path, request.expectedProcessPath) ||
    evidence.rootIdentity.sha256 !== request.expectedProcessSha256 ||
    evidence.rootIdentity.startTimeUtcTicks !== request.expectedProcessStartTimeUtcTicks ||
    typeof evidence.rootIdentity.present !== 'boolean' ||
    !Array.isArray(evidence.terminatedProcesses) ||
    evidence.terminatedProcesses.length > 512 ||
    Number.isNaN(Date.parse(String(evidence.observedAt || '')))
  ) {
    throw new Error('Windows termination evidence differs from the exact launched browser request.');
  }
  const processIds = new Set();
  let previousDepth = Number.POSITIVE_INFINITY;
  let previousProcessId = Number.POSITIVE_INFINITY;
  for (const terminated of evidence.terminatedProcesses) {
    assertExactKeys(
      terminated,
      ['depth', 'parentProcessId', 'path', 'processId', 'sha256', 'startTimeUtcTicks'],
      'Windows terminated process'
    );
    const orderIsExact =
      terminated.depth < previousDepth ||
      (terminated.depth === previousDepth && terminated.processId < previousProcessId);
    if (
      !Number.isInteger(terminated.processId) ||
      terminated.processId <= 0 ||
      processIds.has(terminated.processId) ||
      !Number.isInteger(terminated.parentProcessId) ||
      terminated.parentProcessId < 0 ||
      !Number.isInteger(terminated.depth) ||
      terminated.depth < 0 ||
      terminated.depth > 64 ||
      !orderIsExact ||
      !sameWindowsPath(terminated.path, request.expectedProcessPath) ||
      terminated.sha256 !== request.expectedProcessSha256 ||
      !/^\d+$/u.test(String(terminated.startTimeUtcTicks || '')) ||
      (terminated.processId === request.processId &&
        (terminated.depth !== 0 || terminated.startTimeUtcTicks !== request.expectedProcessStartTimeUtcTicks))
    ) {
      throw new Error('Windows terminated-process evidence is malformed, duplicated, or not leaf-first.');
    }
    processIds.add(terminated.processId);
    previousDepth = terminated.depth;
    previousProcessId = terminated.processId;
  }
  return evidence;
}

async function readStrictRuntimeArchive(zipBytes) {
  const archiveEntries = await readZipEntriesFromBuffer(zipBytes, {
    includeDirectories: true,
    maxArchiveBytes: MAX_RUNTIME_ZIP_BYTES,
    maxEntryBytes: MAX_RUNTIME_ENTRY_BYTES,
    maxEntryCount: RUNTIME_FILES.length + 1,
    maxExpandedBytes: MAX_RUNTIME_EXPANDED_BYTES,
    strictFileNames: true
  });
  const entries = [];
  const exactNames = new Set();
  const portableNames = new Set();
  let expandedBytes = 0;
  for (const entry of archiveEntries) {
    const archivePath = assertStrictRuntimeArchivePath(entry.path);
    const portableName = archivePath.normalize('NFC').toLowerCase();
    if (exactNames.has(archivePath) || portableNames.has(portableName)) {
      throw new Error(`Runtime ZIP contains a duplicate or Windows-colliding path: ${archivePath}`);
    }
    exactNames.add(archivePath);
    portableNames.add(portableName);
    if (!RUNTIME_FILE_SET.has(archivePath)) {
      throw new Error(`Runtime ZIP contains a path outside the exact runtime manifest: ${archivePath}`);
    }
    if (entry.versionMadeBy >>> 8 !== UNIX_HOST_SYSTEM) {
      throw new Error(`Runtime ZIP entry lacks exact Unix regular-file metadata: ${archivePath}`);
    }
    const unixMode = entry.externalFileAttributes >>> 16;
    if ((unixMode & UNIX_FILE_TYPE_MASK) !== UNIX_REGULAR_FILE || unixMode !== EXPECTED_UNIX_MODE) {
      throw new Error(`Runtime ZIP entry is a link, directory, device, or has unexpected mode: ${archivePath}`);
    }
    if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize > MAX_RUNTIME_ENTRY_BYTES) {
      throw new Error(`Runtime ZIP entry exceeds the installed-executor byte limit: ${archivePath}`);
    }
    expandedBytes += entry.uncompressedSize;
    if (expandedBytes > MAX_RUNTIME_EXPANDED_BYTES) {
      throw new Error('Runtime ZIP exceeds the installed-executor expanded-byte limit.');
    }
    const localHeader = entry.localFileHeader;
    if (
      !Buffer.from(localHeader.fileName).equals(entry.fileNameRaw) ||
      localHeader.generalPurposeBitFlag !== entry.generalPurposeBitFlag ||
      localHeader.compressionMethod !== entry.compressionMethod ||
      localHeader.crc32 !== entry.crc32 ||
      localHeader.compressedSize !== entry.compressedSize ||
      localHeader.uncompressedSize !== entry.uncompressedSize
    ) {
      throw new Error(`Runtime ZIP local/central metadata differs: ${archivePath}`);
    }
    const bytes = Buffer.from(entry.bytes);
    if (bytes.length !== entry.uncompressedSize) {
      throw new Error(`Runtime ZIP entry expanded length differs from its exact declaration: ${archivePath}`);
    }
    entries.push({ path: archivePath, bytes });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  if (
    entries.length !== RUNTIME_FILES.length ||
    JSON.stringify(entries.map((entry) => entry.path)) !== JSON.stringify(RUNTIME_FILES)
  ) {
    throw new Error(
      `Runtime ZIP path set differs from the exact runtime manifest: ${entries.length}/${RUNTIME_FILES.length}.`
    );
  }
  return entries;
}

function assertStrictRuntimeArchivePath(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.normalize('NFC') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.startsWith('/') ||
    value.endsWith('/') ||
    /^[A-Za-z]:/u.test(value) ||
    posix.normalize(value) !== value
  ) {
    throw new Error(`Runtime ZIP contains an invalid relative path: ${String(value)}`);
  }
  const segments = value.split('/');
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        segment.includes(':') ||
        [...segment].some((character) => character.codePointAt(0) <= 0x1f) ||
        /[. ]$/u.test(segment) ||
        WINDOWS_RESERVED_SEGMENT.test(segment)
    )
  ) {
    throw new Error(`Runtime ZIP contains an unsafe Windows path segment: ${value}`);
  }
  return value;
}

function validateRuntimeManifest(bytes, expectedVersion) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error('Runtime ZIP lacks manifest.json bytes.');
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error('Runtime ZIP manifest.json is malformed.', { cause: error });
  }
  if (
    manifest?.manifest_version !== 3 ||
    manifest?.name !== 'SiteWipe' ||
    manifest?.version !== expectedVersion ||
    manifest?.background?.service_worker !== 'background/service-worker.js' ||
    manifest?.background?.type !== 'module' ||
    manifest?.action?.default_popup !== 'popup/popup.html' ||
    manifest?.options_page !== 'options/options.html'
  ) {
    throw new Error('Runtime ZIP manifest identity differs from exact SiteWipe expectations.');
  }
  return manifest;
}

async function assertOwnedRunRoot(runRoot, plan) {
  const expectedRunRoot = resolve(
    assertNativeAbsolutePath(plan.inputs.workspaceRoot, 'Approved workspace root'),
    plan.runId
  );
  const requested = resolve(assertNativeAbsolutePath(runRoot, 'Owned browser run root'));
  if (!sameHostPath(expectedRunRoot, requested)) {
    throw new Error('Owned browser run root differs from the exact approved workspace/run ID.');
  }
  const run = await exactPhysicalDirectory(requested, 'Owned browser run root');
  const marker = await readExactCanonicalJson(resolve(run.path, OWNED_RUN_MARKER_NAME), 'Owned browser run marker');
  assertExactKeys(
    marker,
    ['fixtureTokenSha256', 'ownerProcessId', 'planSha256', 'retention', 'runId', 'schema', 'state'],
    'Owned browser run marker'
  );
  if (
    marker.schema !== 'sitewipe.owned-browser-run.v1' ||
    marker.runId !== plan.runId ||
    marker.planSha256 !== plan.planSha256 ||
    !isSha256(marker.fixtureTokenSha256) ||
    !Number.isInteger(marker.ownerProcessId) ||
    marker.ownerProcessId <= 0 ||
    marker.state !== 'prepared' ||
    stableJson(marker.retention) !== stableJson(plan.inputs.retention)
  ) {
    throw new Error('Owned browser run marker differs from the exact approved plan.');
  }
  const approvedPlan = await exactFileIdentity(resolve(run.path, APPROVED_PLAN_NAME), 'Approved browser plan record');
  if (!approvedPlan.bytes.equals(canonicalJsonBytes(plan))) {
    throw new Error('Owned run approved-plan record differs from the in-memory approved plan.');
  }
  return run;
}

async function loadAndVerifyRuntimeStage(runRoot, plan) {
  const receipt = await readExactCanonicalJson(resolve(runRoot, RUNTIME_RECEIPT_NAME), 'Runtime artifact receipt');
  assertExactKeys(
    receipt,
    [
      'artifactBytes',
      'artifactSha256',
      'artifactVersion',
      'contentSetSha256',
      'extensionDirectoryName',
      'fileCount',
      'files',
      'manifest',
      'planSha256',
      'runId',
      'schema',
      'semanticValidationStatus',
      'semanticValidatorManifestSha256',
      'stagedAt'
    ],
    'Runtime artifact receipt'
  );
  if (
    receipt.schema !== 'sitewipe.staged-runtime-artifact.v1' ||
    receipt.runId !== plan.runId ||
    receipt.planSha256 !== plan.planSha256 ||
    receipt.artifactVersion !== plan.identity.artifactVersion ||
    receipt.artifactBytes !== plan.identity.artifactBytes ||
    receipt.artifactSha256 !== plan.identity.artifactSha256 ||
    receipt.extensionDirectoryName !== RUNTIME_DIRECTORY_NAME ||
    receipt.fileCount !== RUNTIME_FILES.length ||
    receipt.semanticValidationStatus !== SEMANTIC_VALIDATION_STATUS ||
    receipt.semanticValidatorManifestSha256 !== SEMANTIC_VALIDATOR_MANIFEST_SHA256 ||
    Number.isNaN(Date.parse(String(receipt.stagedAt || ''))) ||
    !Array.isArray(receipt.files) ||
    receipt.contentSetSha256 !== sha256(canonicalJsonBytes(receipt.files))
  ) {
    throw new Error('Runtime artifact receipt differs from the approved artifact identity.');
  }
  const expectedPaths = receipt.files.map((entry) => entry?.path);
  if (JSON.stringify(expectedPaths) !== JSON.stringify(RUNTIME_FILES)) {
    throw new Error('Runtime artifact receipt path set differs from the exact runtime manifest.');
  }
  for (const entry of receipt.files) {
    assertExactKeys(entry, ['bytes', 'path', 'sha256'], 'Runtime artifact receipt file');
    if (!Number.isInteger(entry.bytes) || entry.bytes < 0 || !isSha256(entry.sha256)) {
      throw new Error('Runtime artifact receipt contains an invalid file identity.');
    }
  }
  const extensionRoot = await exactPhysicalDirectory(resolve(runRoot, RUNTIME_DIRECTORY_NAME), 'Runtime extension');
  const toolchainRoot = await exactPhysicalDirectory(
    resolve(runRoot, TOOLCHAIN_DIRECTORY_NAME),
    'Staged browser toolchain'
  );
  await verifyRuntimeTree(extensionRoot.path, receipt.files);
  return deepFreeze({
    ...structuredClone(receipt),
    extensionRoot: extensionRoot.path,
    toolchainRoot: toolchainRoot.path
  });
}

async function verifyRuntimeTree(extensionRoot, files) {
  const expected = new Map(files.map((entry) => [entry.path, entry]));
  const observedPaths = [];
  async function walk(directoryPath, prefix = '') {
    const directoryIdentity = await exactPhysicalDirectory(directoryPath, `Runtime directory ${prefix || '[root]'}`);
    const entries = await readdir(directoryIdentity.path, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const archivePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      assertStrictRuntimeArchivePath(archivePath);
      const target = resolve(directoryIdentity.path, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
        throw new Error(`Runtime tree contains a link, reparse point, or special file: ${archivePath}`);
      }
      if (entry.isDirectory()) {
        await walk(target, archivePath);
        continue;
      }
      const expectedFile = expected.get(archivePath);
      if (!expectedFile) throw new Error(`Runtime tree contains an unexpected file: ${archivePath}`);
      const identity = await exactFileIdentity(target, `Runtime file ${archivePath}`);
      if (identity.bytes.length !== expectedFile.bytes || identity.sha256 !== expectedFile.sha256) {
        throw new Error(`Runtime file identity changed after exact extraction: ${archivePath}`);
      }
      observedPaths.push(archivePath);
    }
  }
  await walk(extensionRoot);
  observedPaths.sort();
  if (JSON.stringify(observedPaths) !== JSON.stringify(RUNTIME_FILES)) {
    throw new Error('Runtime extracted tree does not contain the exact runtime file set.');
  }
}

async function loadAndVerifyBrowserCell(runRoot, plan, browserName, scenarioId, { requirePristine }) {
  const scenarioRoot = await exactPhysicalDirectory(
    resolve(runRoot, BROWSER_CELLS_DIRECTORY_NAME, browserName, scenarioId),
    'Owned browser scenario directory'
  );
  const marker = await readExactCanonicalJson(
    resolve(scenarioRoot.path, OWNED_CELL_MARKER_NAME),
    'Browser cell marker'
  );
  assertExactBrowserCellMarker(marker, plan, browserName, scenarioId);
  const paths = {};
  for (const kind of BROWSER_CELL_KINDS) {
    const child = await exactPhysicalDirectory(resolve(scenarioRoot.path, kind), `Browser ${kind} directory`);
    const childMarker = await readExactCanonicalJson(
      resolve(child.path, OWNED_DIRECTORY_MARKER_NAME),
      `Browser ${kind} directory marker`
    );
    assertExactKeys(
      childMarker,
      ['browserName', 'canarySha256', 'kind', 'planSha256', 'runId', 'scenarioId', 'schema'],
      `Browser ${kind} directory marker`
    );
    if (
      childMarker.schema !== 'sitewipe.owned-browser-directory.v1' ||
      childMarker.runId !== plan.runId ||
      childMarker.planSha256 !== plan.planSha256 ||
      childMarker.browserName !== browserName ||
      childMarker.scenarioId !== scenarioId ||
      childMarker.kind !== kind ||
      childMarker.canarySha256 !== marker.canarySha256
    ) {
      throw new Error(`Browser ${kind} directory marker differs from the exact staged cell.`);
    }
    if (requirePristine) {
      const exactNames =
        kind === 'downloads'
          ? [DOWNLOAD_CANARY_NAME, OWNED_DIRECTORY_MARKER_NAME].sort()
          : [OWNED_DIRECTORY_MARKER_NAME];
      const observedNames = (await readdir(child.path)).sort();
      if (JSON.stringify(observedNames) !== JSON.stringify(exactNames)) {
        throw new Error(`Browser ${kind} directory is not pristine before launch.`);
      }
    }
    paths[kind] = child.path;
  }
  const canary = await exactFileIdentity(
    resolve(paths.downloads, DOWNLOAD_CANARY_NAME),
    'Download preservation canary'
  );
  if (canary.bytes.length !== 32 || canary.sha256 !== marker.canarySha256) {
    throw new Error('Download preservation canary changed before browser launch.');
  }
  return deepFreeze({
    scenarioRoot: scenarioRoot.path,
    profilePath: paths.profile,
    downloadPath: paths.downloads,
    evidencePath: paths.evidence,
    screenshotPath: paths.screenshots,
    canaryPath: canary.path,
    canarySha256: canary.sha256
  });
}

function assertExactBrowserCellMarker(marker, plan, browserName, scenarioId) {
  assertExactKeys(
    marker,
    ['browserName', 'canarySha256', 'planSha256', 'runId', 'scenarioId', 'schema', 'state'],
    'Browser cell marker'
  );
  if (
    marker.schema !== 'sitewipe.owned-browser-cell.v1' ||
    marker.runId !== plan.runId ||
    marker.planSha256 !== plan.planSha256 ||
    marker.browserName !== browserName ||
    marker.scenarioId !== scenarioId ||
    !isSha256(marker.canarySha256) ||
    marker.state !== 'staged'
  ) {
    throw new Error('Browser cell marker differs from the exact approved cell.');
  }
}

function buildLaunchOptions({ executablePath, extensionPath, profilePath, downloadPath, proxy }) {
  for (const [label, value] of Object.entries({ executablePath, extensionPath, profilePath, downloadPath })) {
    assertNativeAbsolutePath(value, `Pinned launch ${label}`);
  }
  const { window } = INSTALLED_RUNTIME_LAUNCH_POLICY;
  return {
    browser: INSTALLED_RUNTIME_LAUNCH_POLICY.puppeteerBrowser,
    protocol: INSTALLED_RUNTIME_LAUNCH_POLICY.protocol,
    executablePath,
    userDataDir: profilePath,
    headless: false,
    pipe: true,
    enableExtensions: [extensionPath],
    extensionsEnabledInIncognito: [],
    defaultViewport: null,
    downloadBehavior: { policy: 'allow', downloadPath },
    allowlist: [...RUNTIME_NETWORK_ALLOWLIST],
    acceptInsecureCerts: false,
    waitForInitialPage: true,
    timeout: INSTALLED_RUNTIME_LAUNCH_POLICY.launchTimeoutMs,
    protocolTimeout: INSTALLED_RUNTIME_LAUNCH_POLICY.protocolTimeoutMs,
    dumpio: false,
    handleSIGINT: true,
    handleSIGTERM: true,
    handleSIGHUP: true,
    env: minimalBrowserEnvironment(),
    args: [
      '--disable-background-networking',
      '--disable-breakpad',
      '--disable-component-update',
      '--disable-crash-reporter',
      '--disable-default-apps',
      '--disable-domain-reliability',
      '--disable-quic',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-default-browser-check',
      '--no-first-run',
      `--proxy-server=http://${proxy.host}:${proxy.port}`,
      `--proxy-bypass-list=${INSTALLED_RUNTIME_LAUNCH_POLICY.proxy.bypassList}`,
      `--lang=${INSTALLED_RUNTIME_LAUNCH_POLICY.locale}`,
      `--window-position=${window.x},${window.y}`,
      `--window-size=${window.width},${window.height}`,
      `--host-resolver-rules=${LOOPBACK_HOST_RESOLVER_RULES}`
    ]
  };
}

function assertExactDirectLaunchArguments(browserArguments, launchOptions) {
  if (
    !Array.isArray(browserArguments) ||
    browserArguments.some((value) => typeof value !== 'string' || value.includes('\0')) ||
    browserArguments.filter((value) => value === '--remote-debugging-pipe').length !== 1 ||
    browserArguments.some((value) => value.startsWith('--remote-debugging-port')) ||
    browserArguments.filter((value) => value.startsWith('--user-data-dir=')).length !== 1 ||
    !browserArguments.includes(`--user-data-dir=${launchOptions.userDataDir}`) ||
    browserArguments.includes('--disable-extensions')
  ) {
    throw new Error('Approved Puppeteer default arguments do not preserve the exact direct-pipe launch policy.');
  }
}

function observeSpawnedChildSettlement(child) {
  let resolveError;
  let resolveExit;
  const error = new Promise((resolvePromise) => {
    resolveError = resolvePromise;
  });
  const exit = new Promise((resolvePromise) => {
    resolveExit = resolvePromise;
  });
  child.once('error', (value) => resolveError(value));
  child.once('exit', (code, signal) => resolveExit(Object.freeze({ code, signal })));
  // Both event promises resolve rather than reject, so a late spawn error/exit is
  // always observed even when synchronous pid/stdio validation already refused.
  void error.then(() => {});
  void exit.then(() => {});
  return Object.freeze({ error, exit });
}

function assertActiveLaunchSignal(signal) {
  if (!(signal instanceof AbortSignal) || signal.aborted) {
    throw new Error('Pinned browser launch authority is unavailable or expired.');
  }
}

function spawnWithActiveAuthority(signal, spawnAction) {
  if (typeof spawnAction !== 'function') throw new TypeError('Pinned browser spawn action must be a function.');
  assertActiveLaunchSignal(signal);
  return spawnAction();
}

function rejectOnEarlyChildSettlement(browserPromise, childSettlement) {
  return Promise.race([
    browserPromise,
    childSettlement.error.then((error) => {
      throw error;
    }),
    childSettlement.exit.then(({ code, signal }) => {
      throw new Error(`Pinned browser exited before CDP connection settled (${String(code)}/${String(signal)}).`);
    })
  ]);
}

async function terminateAuthenticatedSpawnedTree({ browserPin, cell, child, plan, processIdentity }) {
  const target = processIdentity?.targetProcess;
  if (
    target?.processId !== child.pid ||
    !sameHostPath(target.path, browserPin.executablePath) ||
    target.sha256 !== browserPin.executableSha256 ||
    !/^\d+$/u.test(String(target.startTimeUtcTicks || ''))
  ) {
    throw new Error('Spawned browser fallback termination lacks the exact authenticated process identity.');
  }
  if (plan.inputs.processObserver.processTerminationAllowed !== true) {
    throw new Error('Approved process-observer policy does not authorize disposable browser tree termination.');
  }
  const request = {
    processId: target.processId,
    expectedProcessPath: browserPin.executablePath,
    expectedProcessSha256: browserPin.executableSha256,
    expectedProcessStartTimeUtcTicks: target.startTimeUtcTicks,
    expectedProfilePath: cell.profilePath
  };
  const evidence = await runWindowsProcessHelper(plan, {
    mode: 'TerminateTree',
    ...request
  });
  validateWindowsProcessTerminationObservation(evidence, request);
  return deepFreeze(structuredClone(evidence));
}

async function settlePostSpawnPhase(promise, timeoutMs, label, signal) {
  let removeAbort = () => {};
  const aborted = new Promise((resolvePromise, rejectPromise) => {
    const listener = () =>
      rejectPromise(signal.reason instanceof Error ? signal.reason : new Error(`${label} was cancelled.`));
    if (signal.aborted) listener();
    else {
      signal.addEventListener('abort', listener, { once: true });
      removeAbort = () => signal.removeEventListener('abort', listener);
    }
  });
  try {
    return await settleWithin(Promise.race([Promise.resolve(promise), aborted]), timeoutMs, label);
  } finally {
    removeAbort();
  }
}

const DEFAULT_SPAWNED_SESSION_OPERATIONS = Object.freeze({
  closeBrowser(browser) {
    return browser.close();
  },
  observeCanary(path) {
    return exactFileIdentity(path, 'Post-close download preservation canary');
  },
  observeIdentity({ plan, processId, browserPin, profilePath }) {
    return observeWindowsBrowserProcessIdentity({ plan, processId, browserPin, profilePath });
  },
  observeResidue({ plan, processIdentity, browserPin, profilePath }) {
    return observeWindowsProfileProcessResidue({ plan, processIdentity, browserPin, profilePath });
  },
  settle(promise, timeoutMs, label) {
    return settleWithin(promise, timeoutMs, label);
  },
  terminateTree({ browserPin, cell, child, plan, processIdentity }) {
    return terminateAuthenticatedSpawnedTree({ browserPin, cell, child, plan, processIdentity });
  }
});

function createSpawnedBrowserSessionOwner({
  browserName,
  browserPin,
  cell,
  child,
  childSettlement,
  operations = DEFAULT_SPAWNED_SESSION_OPERATIONS,
  plan,
  timeouts = SPAWNED_SESSION_TIMEOUTS
}) {
  if (
    !childSettlement ||
    typeof childSettlement.error?.then !== 'function' ||
    typeof childSettlement.exit?.then !== 'function'
  ) {
    throw new Error('Spawned browser cleanup owner requires observed error and exit settlement.');
  }
  void Promise.resolve(childSettlement.error).then(
    () => {},
    () => {}
  );
  void Promise.resolve(childSettlement.exit).then(
    () => {},
    () => {}
  );
  let browser = null;
  let browserPromise = null;
  let closeInvocationCount = 0;
  let disconnectExpected = false;
  let disconnectedBeforeCentralClose = false;
  let processIdentity = null;
  let removeDisconnectObserver = () => {};

  const observeBrowser = (value) => {
    if (
      browser !== null ||
      !value ||
      typeof value.close !== 'function' ||
      typeof value.on !== 'function' ||
      typeof value.off !== 'function'
    ) {
      throw new Error('Spawned browser session cannot rebind its exact observable browser.');
    }
    const onDisconnected = () => {
      if (!disconnectExpected) disconnectedBeforeCentralClose = true;
    };
    value.on('disconnected', onDisconnected);
    try {
      if (value.connected !== true) disconnectedBeforeCentralClose = true;
    } catch (error) {
      try {
        value.off('disconnected', onDisconnected);
      } catch {
        // The original connection-observation failure remains authoritative.
      }
      throw error;
    }
    browser = value;
    removeDisconnectObserver = () => value.off('disconnected', onDisconnected);
  };

  const close = async () => {
    closeInvocationCount += 1;
    if (closeInvocationCount !== 1) throw new Error('Spawned browser cleanup owner is single use.');
    const closeStartedAt = new Date().toISOString();
    let closeError = null;
    if (browser === null && browserPromise !== null) {
      try {
        const lateBrowser = await operations.settle(
          browserPromise,
          timeouts.lateConnectionMs,
          'Late browser connection before cleanup'
        );
        observeBrowser(lateBrowser);
      } catch (error) {
        closeError = errorText(error);
        void browserPromise.then(
          (lateBrowser) => {
            void Promise.resolve()
              .then(() => operations.closeBrowser(lateBrowser))
              .then((closePromise) =>
                operations.settle(closePromise, timeouts.gracefulCloseMs, 'Late graceful browser close')
              )
              .catch(() => {});
          },
          () => {}
        );
      }
    }
    if (browser !== null) {
      try {
        if (browser.connected !== true) disconnectedBeforeCentralClose = true;
      } catch (error) {
        disconnectedBeforeCentralClose = true;
        closeError ??= errorText(error);
      }
      if (disconnectedBeforeCentralClose) {
        closeError ??= 'Browser disconnected before the runner-owned central close began.';
      }
      disconnectExpected = true;
      try {
        await operations.settle(operations.closeBrowser(browser), timeouts.gracefulCloseMs, 'Graceful browser close');
      } catch (error) {
        closeError ??= errorText(error);
      }
      try {
        if (browser.connected !== false) {
          closeError ??= 'Browser remained connected after the runner-owned central close.';
        }
      } catch (error) {
        closeError ??= errorText(error);
      }
      try {
        removeDisconnectObserver();
      } catch (error) {
        closeError ??= errorText(error);
      }
    }
    if (processIdentity === null) {
      if (!Number.isInteger(child.pid) || child.pid <= 0) {
        closeError ??= 'Spawned browser did not expose an exact process ID for authenticated cleanup.';
      } else {
        try {
          processIdentity = await operations.settle(
            operations.observeIdentity({
              plan,
              processId: child.pid,
              browserPin,
              profilePath: cell.profilePath
            }),
            timeouts.processIdentityMs,
            'Cleanup process identity observation'
          );
        } catch (error) {
          closeError ??= errorText(error);
        }
      }
    }
    let residue = null;
    if (processIdentity !== null) {
      try {
        residue = await operations.settle(
          operations.observeResidue({
            plan,
            processIdentity,
            browserPin,
            profilePath: cell.profilePath
          }),
          timeouts.residueMs,
          'Cleanup process residue observation'
        );
      } catch (error) {
        closeError ??= errorText(error);
      }
    }
    if (processIdentity !== null && (closeError !== null || (residue?.residues.length ?? 1) !== 0)) {
      try {
        await operations.settle(
          operations.terminateTree({ browserPin, cell, child, plan, processIdentity }),
          timeouts.terminationMs,
          'Authenticated disposable browser tree termination'
        );
        residue = await operations.settle(
          operations.observeResidue({
            plan,
            processIdentity,
            browserPin,
            profilePath: cell.profilePath
          }),
          timeouts.residueMs,
          'Post-termination process residue observation'
        );
      } catch (error) {
        closeError ??= errorText(error);
      }
    }
    let canary = null;
    try {
      canary = await operations.settle(
        operations.observeCanary(cell.canaryPath),
        timeouts.canaryMs,
        'Cleanup download canary observation'
      );
    } catch (error) {
      closeError ??= errorText(error);
    }
    const canaryPreserved = canary?.bytes.length === 32 && canary.sha256 === cell.canarySha256;
    const clean = closeError === null && residue?.residues.length === 0 && canaryPreserved;
    return deepFreeze({
      schema: 'sitewipe.installed-browser-close-observation.v1',
      runId: plan.runId,
      planSha256: plan.planSha256,
      browserName,
      closeStartedAt,
      observedAt: new Date().toISOString(),
      gracefulCloseError: closeError,
      processResidue:
        residue ??
        conservativeUnobservedResidue({
          browserPin,
          cell,
          child,
          observedAt: new Date().toISOString(),
          processIdentity
        }),
      profileProcessResidueCount: residue?.residues.length ?? 1,
      mustPreserveDownloadCanary: {
        path: cell.canaryPath,
        expectedSha256: cell.canarySha256,
        observedSha256: canary?.sha256 ?? null,
        preserved: canaryPreserved
      },
      observationStatus: clean ? 'clean' : 'attention_required',
      semanticValidationStatus: SEMANTIC_VALIDATION_STATUS,
      semanticValidatorManifestSha256: SEMANTIC_VALIDATOR_MANIFEST_SHA256,
      automaticProfileDeletionPerformed: false,
      automaticDownloadDeletionPerformed: false
    });
  };
  return Object.freeze({
    bindBrowser(value) {
      observeBrowser(value);
    },
    bindBrowserPromise(value) {
      if (browserPromise !== null || !value || typeof value.then !== 'function') {
        throw new Error('Spawned browser session cannot rebind its exact connection promise.');
      }
      browserPromise = value;
    },
    bindProcessIdentity(value) {
      if (processIdentity !== null || !value?.targetProcess) {
        throw new Error('Spawned browser session cannot rebind its exact process identity.');
      }
      processIdentity = value;
    },
    close
  });
}

function conservativeUnobservedResidue({ browserPin, cell, child, observedAt, processIdentity }) {
  return {
    schema: 'sitewipe.windows-process-observation.v1',
    mode: 'profile-residue',
    rootIdentity: {
      processId: child.pid,
      path: browserPin.executablePath,
      sha256: browserPin.executableSha256,
      startTimeUtcTicks: processIdentity?.targetProcess?.startTimeUtcTicks ?? '0',
      present: true
    },
    profilePath: cell.profilePath,
    residues: [
      {
        processId: child.pid,
        parentProcessId: 0,
        path: browserPin.executablePath,
        sha256: browserPin.executableSha256,
        startTimeUtcTicks: processIdentity?.targetProcess?.startTimeUtcTicks ?? '0',
        commandLineSha256: null,
        matchedBy: ['process-tree']
      }
    ],
    observedAt
  };
}

function createLaunchedRuntimeController({
  browser,
  browserName,
  browserPin,
  browserVersion,
  cell,
  close,
  extension,
  plan,
  processIdentity,
  proxy,
  runtime
}) {
  const receipt = deepFreeze({
    schema: 'sitewipe.launched-installed-browser.v1',
    runId: plan.runId,
    planSha256: plan.planSha256,
    browserName,
    pinnedBrowserVersion: browserPin.version,
    observedBrowserVersion: browserVersion,
    executablePath: browserPin.executablePath,
    executableSha256: browserPin.executableSha256,
    browserRuntime: structuredClone(browserRuntimeClosureReceipt(browserPin)),
    profilePath: cell.profilePath,
    downloadPath: cell.downloadPath,
    extensionId: extension.id,
    extensionName: extension.name,
    extensionVersion: extension.version,
    extensionPath: runtime.extensionRoot,
    processIdentity: structuredClone(processIdentity.targetProcess),
    launchPolicy: structuredClone(INSTALLED_RUNTIME_LAUNCH_POLICY),
    launchPolicySha256: INSTALLED_RUNTIME_LAUNCH_POLICY_SHA256,
    proxy: structuredClone(proxy),
    semanticValidationStatus: SEMANTIC_VALIDATION_STATUS,
    semanticValidatorManifestSha256: SEMANTIC_VALIDATOR_MANIFEST_SHA256,
    launchedAt: new Date().toISOString()
  });

  return Object.freeze({
    browser,
    extension,
    receipt,
    async triggerAction(page, { timeoutMs = 10_000 } = {}) {
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
        throw new Error('SiteWipe popup wait timeout is outside the bounded runtime policy.');
      }
      if (!page || typeof page.url !== 'function' || typeof page.browser !== 'function' || page.browser() !== browser) {
        throw new Error('SiteWipe action requires a page owned by the exact disposable browser.');
      }
      const targetUrl = assertSyntheticFixturePageUrl(page.url(), plan.inputs.fixture.allowedHosts);
      const popupUrl = `chrome-extension://${extension.id}/popup/popup.html`;
      if (browser.targets().some((target) => target.url() === popupUrl)) {
        throw new Error('An existing SiteWipe popup target makes authentic action attribution ambiguous.');
      }
      const popupTargetPromise = browser.waitForTarget((target) => target.url() === popupUrl, { timeout: timeoutMs });
      void popupTargetPromise.catch(() => undefined);
      await extension.triggerAction(page);
      const popupTarget = await popupTargetPromise;
      const targetTypeBeforeAsPage = popupTarget.type();
      const popupPage = await popupTarget.asPage();
      if (popupPage.url() !== popupUrl) {
        throw new Error('Authentically triggered action did not resolve to the exact SiteWipe popup.');
      }
      return Object.freeze({
        page: popupPage,
        receipt: deepFreeze({
          schema: 'sitewipe.authentic-extension-action.v1',
          extensionId: extension.id,
          targetOrigin: targetUrl.origin,
          popupUrl,
          targetTypeBeforeAsPage,
          invocation: 'puppeteer-extension-triggerAction',
          scriptOrDomInjectionUsed: false,
          observedAt: new Date().toISOString()
        })
      });
    },
    close
  });
}

function browserRuntimeClosureReceipt(browserPin) {
  return Object.fromEntries(BROWSER_RUNTIME_SUMMARY_KEYS.map((key) => [key, browserPin[key]]));
}

async function observeWindowsBrowserProcessIdentity({ plan, processId, browserPin, profilePath }) {
  const request = {
    processId,
    expectedProcessPath: browserPin.executablePath,
    expectedProcessSha256: browserPin.executableSha256,
    expectedProfilePath: profilePath
  };
  const evidence = await runWindowsProcessHelper(plan, {
    mode: 'Identity',
    processId,
    expectedProcessPath: browserPin.executablePath,
    expectedProcessSha256: browserPin.executableSha256,
    expectedProcessStartTimeUtcTicks: '',
    expectedProfilePath: profilePath
  });
  validateWindowsProcessIdentityObservation(evidence, request);
  return deepFreeze(structuredClone(evidence));
}

async function observeWindowsProfileProcessResidue({ plan, processIdentity, browserPin, profilePath }) {
  const request = {
    processId: processIdentity.targetProcess.processId,
    expectedProcessPath: browserPin.executablePath,
    expectedProcessSha256: browserPin.executableSha256,
    expectedProcessStartTimeUtcTicks: processIdentity.targetProcess.startTimeUtcTicks,
    expectedProfilePath: profilePath
  };
  const evidence = await runWindowsProcessHelper(plan, {
    mode: 'ProfileResidue',
    ...request
  });
  validateWindowsProfileResidueObservation(evidence, request);
  return deepFreeze(structuredClone(evidence));
}

async function runWindowsProcessHelper(plan, request) {
  if (process.platform !== 'win32') throw new Error('Windows process observation requires Windows.');
  const observer = plan.inputs.processObserver;
  if (
    !sameHostPath(observer.helperPath, WINDOWS_PROCESS_IDENTITY_HELPER_PATH) ||
    !observer.helperModes.includes(request.mode)
  ) {
    throw new Error('Windows process observation differs from its exact approved helper path or mode.');
  }
  const helper = await exactFileIdentity(observer.helperPath, 'Windows process helper');
  if (helper.sha256 !== observer.helperSha256) {
    throw new Error('Windows process helper bytes changed after approval.');
  }
  const committedHelper = runTrustedGit({
    root: plan.inputs.repositoryRoot,
    args: ['cat-file', 'blob', `${plan.identity.sourceCommitSha}:${PROCESS_HELPER_COMMITTED_PATH}`]
  });
  if (!Buffer.isBuffer(committedHelper) || !helper.bytes.equals(committedHelper)) {
    throw new Error('Windows process helper differs from the exact approved source commit.');
  }
  const nativePolicy = await exactFileIdentity(NATIVE_PROMPT_POLICY_PATH, 'Native prompt policy');
  if (nativePolicy.sha256 !== plan.inputs.nativePrompt.policySha256) {
    throw new Error('Native prompt policy changed before Windows process observation.');
  }
  const policy = JSON.parse(nativePolicy.bytes.toString('utf8'));
  if (
    !isDriveQualifiedWindowsAbsolutePath(policy?.powershell?.path) ||
    !isSha256(policy?.powershell?.sha256) ||
    !sameHostPath(policy.powershell.path, observer.powershellPath) ||
    policy.powershell.sha256 !== observer.powershellSha256
  ) {
    throw new Error('Native prompt policy lacks the exact pinned PowerShell identity.');
  }
  const powerShell = await exactFileIdentity(observer.powershellPath, 'Pinned Windows PowerShell', {
    allowWindowsSystemPowerShellHardLinks: true
  });
  if (powerShell.sha256 !== observer.powershellSha256) {
    throw new Error('Pinned Windows PowerShell bytes changed before process observation.');
  }
  const args = [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-File',
    helper.path,
    '-Mode',
    request.mode,
    '-TargetProcessId',
    String(request.processId),
    '-ExpectedProcessPath',
    request.expectedProcessPath,
    '-ExpectedProcessSha256',
    request.expectedProcessSha256,
    '-ExpectedProcessStartTimeUtcTicks',
    request.expectedProcessStartTimeUtcTicks,
    '-ExpectedProfilePath',
    request.expectedProfilePath,
    '-ExpectedHelperSha256',
    helper.sha256
  ];
  if (args.includes('-Command') || args.includes('-ExecutionPolicy')) {
    throw new Error('Windows process observation cannot use arbitrary commands or bypass PowerShell policy.');
  }
  const result = await spawnBounded(powerShell.path, args, 30_000);
  if (result.signal !== null || result.code !== 0) {
    throw new Error(`Windows process helper failed: ${result.stderr || `exit ${result.code}`}`);
  }
  let evidence;
  try {
    evidence = JSON.parse(result.stdout.trim());
  } catch (error) {
    throw new Error('Windows process helper returned unreadable evidence.', { cause: error });
  }
  return evidence;
}

async function spawnBounded(executablePath, args, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executablePath, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: minimalWindowsEnvironment()
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (callback) => {
      if (settled) return false;
      settled = true;
      clearTimeout(timeout);
      callback();
      return true;
    };
    const timeout = setTimeout(() => {
      if (!settled) child.kill();
      finish(() => rejectPromise(new Error('Windows process helper exceeded its fixed timeout.')));
    }, timeoutMs);
    timeout.unref();
    const collect = (current, chunk) => {
      const next = current + chunk;
      if (Buffer.byteLength(next, 'utf8') > MAX_HELPER_OUTPUT_BYTES) {
        child.kill();
        finish(() => rejectPromise(new Error('Windows process helper exceeded its output bound.')));
      }
      return next;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout = collect(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = collect(stderr, chunk);
    });
    child.once('error', (error) => finish(() => rejectPromise(error)));
    child.once('close', (code, signal) => finish(() => resolvePromise({ code, signal, stdout, stderr })));
  });
}

async function ensureOwnedContainer(parentPath, name, marker) {
  const target = assertDescendant(parentPath, resolve(parentPath, name), 'Owned browser container');
  let created = false;
  try {
    await mkdir(target, { recursive: false, mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const identity = await exactPhysicalDirectory(target, 'Owned browser container');
  const markerPath = resolve(identity.path, OWNED_DIRECTORY_MARKER_NAME);
  if (created) {
    await writeExclusiveRegularFile(markerPath, canonicalJsonBytes(marker), 'Owned browser container marker');
  } else {
    const observed = await exactFileIdentity(markerPath, 'Owned browser container marker');
    if (!observed.bytes.equals(canonicalJsonBytes(marker))) {
      throw new Error('Existing browser container marker differs from the exact owned hierarchy.');
    }
  }
  return identity;
}

async function readExactCanonicalJson(path, label) {
  const identity = await exactFileIdentity(path, label);
  let value;
  try {
    value = JSON.parse(identity.bytes.toString('utf8'));
  } catch (error) {
    throw new Error(`${label} is malformed JSON.`, { cause: error });
  }
  if (!identity.bytes.equals(canonicalJsonBytes(value))) {
    throw new Error(`${label} is not canonical JSON.`);
  }
  return value;
}

async function writeExclusiveRegularFile(path, bytes, label, { readOnly = false, testHooks = null } = {}) {
  if (testHooks !== null) {
    assertExactKeys(
      testHooks,
      ['afterCloseBeforeReopen', 'afterParentCheckBeforeOpen', 'afterWriteBeforeRetainedCheck'],
      `${label} test hooks`
    );
    for (const hook of Object.values(testHooks)) {
      if (hook !== null && typeof hook !== 'function')
        throw new TypeError(`${label} test hooks must be functions or null.`);
    }
  }
  const content = Buffer.from(bytes);
  const parentPath = dirname(path);
  const parentBefore = await exactPhysicalDirectory(parentPath, `${label} parent before create`);
  // Node's cross-platform fs API cannot bind O_EXCL creation atomically to an
  // already-open parent-directory handle. These retained-handle before/after checks
  // make that pathname boundary bounded and detectable, not absolutely race-proof.
  await testHooks?.afterParentCheckBeforeOpen?.({ parentPath, path });
  const handle = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
  let information;
  try {
    await handle.writeFile(content);
    await handle.sync();
    if (readOnly) await handle.chmod(0o444);
    await testHooks?.afterWriteBeforeRetainedCheck?.({ parentPath, path });
    const written = await handle.stat({ bigint: true });
    if (!written.isFile() || written.isSymbolicLink() || written.nlink !== 1n) {
      throw new Error(`${label} must remain one singly linked regular file.`);
    }
    const verifiedBytes = await readExactRetainedBytes(handle, content.length, label);
    await handle.sync();
    information = await handle.stat({ bigint: true });
    const childPath = await lstat(path, { bigint: true });
    const childRealPath = await realpath(path);
    const parentDuring = await exactPhysicalDirectory(parentPath, `${label} parent during create`);
    if (
      !verifiedBytes.equals(content) ||
      !sameFileIdentity(information, childPath) ||
      childPath.nlink !== 1n ||
      !sameHostPath(childRealPath, resolve(path)) ||
      !sameDirectoryIdentity(parentBefore.information, parentDuring.information)
    ) {
      throw new Error(`${label} changed across retained-handle child and parent validation.`);
    }
  } finally {
    await handle.close();
  }
  await testHooks?.afterCloseBeforeReopen?.({ parentPath, path });
  const observed = await exactFileIdentity(path, label);
  const parentAfter = await exactPhysicalDirectory(parentPath, `${label} parent after reopen`);
  if (
    !samePostCloseFileIdentity(information, observed.information) ||
    !observed.bytes.equals(content) ||
    !sameDirectoryIdentity(parentBefore.information, parentAfter.information)
  ) {
    throw new Error(`${label} identity changed immediately after exclusive creation.`);
  }
  return observed;
}

async function createExclusivePhysicalDirectory(path, label) {
  await mkdir(path, { recursive: false, mode: 0o700 });
  return exactPhysicalDirectory(path, label);
}

async function exactPhysicalDirectory(path, label) {
  const expected = resolve(assertNativeAbsolutePath(path, `${label} path`));
  const information = await lstat(expected, { bigint: true });
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error(`${label} must be one physical non-reparse directory.`);
  }
  const actual = await realpath(expected);
  if (!sameHostPath(actual, expected)) throw new Error(`${label} is aliased.`);
  const after = await lstat(expected, { bigint: true });
  if (!after.isDirectory() || after.isSymbolicLink() || !sameFileIdentity(information, after)) {
    throw new Error(`${label} identity changed while it was resolved.`);
  }
  return Object.freeze({ path: expected, information: after });
}

async function readExactRetainedBytes(handle, length, label) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < bytes.length) {
    const remaining = bytes.length - offset;
    const { bytesRead } = await handle.read(bytes, offset, remaining, offset);
    if (!Number.isInteger(bytesRead) || bytesRead <= 0 || bytesRead > remaining) {
      throw new Error(`${label} ended before its complete retained-handle readback.`);
    }
    offset += bytesRead;
  }
  return bytes;
}

async function exactFileIdentity(
  path,
  label,
  { allowInputAlias = false, allowWindowsSystemPowerShellHardLinks = false } = {}
) {
  const expected = resolve(assertNativeAbsolutePath(path, `${label} path`));
  const actual = await realpath(expected);
  if (!allowInputAlias && !sameHostPath(actual, expected)) throw new Error(`${label} is aliased.`);
  const before = await lstat(actual, { bigint: true });
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
          : `${label} opened handle is not one singly linked regular file.`
      );
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const finalPath = await lstat(actual, { bigint: true });
    const finalRealPath = await realpath(actual);
    if (
      !hasApprovedNativeFileLinkCount(after, { allowWindowsSystemPowerShellHardLinks }) ||
      !hasApprovedNativeFileLinkCount(finalPath, { allowWindowsSystemPowerShellHardLinks }) ||
      !finalPath.isFile() ||
      finalPath.isSymbolicLink() ||
      !sameHostPath(finalRealPath, actual) ||
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

function descendantFromArchivePath(parent, archivePath, label) {
  const segments = assertStrictRuntimeArchivePath(archivePath).split('/');
  return assertDescendant(parent, resolve(parent, ...segments), label);
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

function isDescendantOrEqual(parent, child) {
  const relation = relative(resolve(parent), resolve(child));
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function samePathKey(value) {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function assertBrowserAndScenario(plan, browserName, scenarioId) {
  if (!plan.requiredBrowsers.includes(browserName)) {
    throw new Error('Installed browser name is outside the exact approved plan.');
  }
  if (!plan.requiredMatrixIds.includes(scenarioId)) {
    throw new Error('Installed browser scenario is outside the exact canonical matrix.');
  }
}

function assertObservedBrowserMajor(browserPin, observedVersion) {
  const expectedMajor = String(browserPin.version).match(/^\d+/u)?.[0];
  const observedMajor = String(observedVersion || '').match(/\d+/u)?.[0];
  if (!expectedMajor || observedMajor !== expectedMajor) {
    throw new Error('Observed Chromium protocol version differs from the pinned browser major version.');
  }
}

function minimalBrowserEnvironment() {
  const names = INSTALLED_RUNTIME_LAUNCH_POLICY.environmentVariableNames;
  return Object.fromEntries(
    names.flatMap((name) => (typeof process.env[name] === 'string' ? [[name, process.env[name]]] : []))
  );
}

function minimalWindowsEnvironment() {
  return Object.fromEntries(
    ['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].flatMap((name) =>
      typeof process.env[name] === 'string' ? [[name, process.env[name]]] : []
    )
  );
}

async function settleWithin(promise, timeoutMs, label) {
  let timeout;
  const timeoutPromise = new Promise((_, rejectPromise) => {
    timeout = setTimeout(() => rejectPromise(new Error(`${label} exceeded ${timeoutMs} ms.`)), timeoutMs);
    timeout.unref();
  });
  try {
    return await Promise.race([Promise.resolve(promise), timeoutPromise]);
  } finally {
    clearTimeout(timeout);
  }
}

function pathDepth(value) {
  return value.split('/').length;
}

function sameFileIdentity(left, right) {
  if (!left || !right || left.isFile() !== right.isFile() || left.isDirectory() !== right.isDirectory()) return false;
  return STABLE_PHYSICAL_IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

function samePostCloseFileIdentity(left, right, platform = process.platform) {
  if (sameFileIdentity(left, right)) return true;
  if (
    platform !== 'win32' ||
    !left ||
    !right ||
    left.isFile() !== right.isFile() ||
    left.isDirectory() !== right.isDirectory()
  ) {
    return false;
  }
  // NTFS allocation accounting can settle when the final writable handle is
  // closed even after fsync. `blocks` is allocation metadata, not object
  // identity. Every other identity field must remain exact, and the caller
  // still reopens, hashes, and byte-compares the complete file.
  return STABLE_PHYSICAL_IDENTITY_KEYS.every((key) => key === 'blocks' || left[key] === right[key]);
}

function sameDirectoryIdentity(left, right) {
  if (!left || !right || !left.isDirectory() || !right.isDirectory()) return false;
  return STABLE_DIRECTORY_OBJECT_IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

function sameWindowsPath(left, right) {
  if (!isDriveQualifiedWindowsAbsolutePath(left) || !isDriveQualifiedWindowsAbsolutePath(right)) return false;
  return win32.resolve(left).toLowerCase() === win32.resolve(right).toLowerCase();
}

function sameHostPath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const exact = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(exact)) {
    throw new Error(`${label} keys differ from the exact runtime contract.`);
  }
}

function isSha256(value) {
  return SHA256_PATTERN.test(String(value || ''));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
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

function errorText(error) {
  return `Opaque browser-cleanup error SHA-256 ${sha256(`sitewipe.runtime-cleanup-error.v1\0${typeof error}`)}.`;
}

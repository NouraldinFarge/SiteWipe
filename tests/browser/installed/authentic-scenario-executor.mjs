import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import { RUNTIME_FILES } from '../../../scripts/release-files.mjs';
import {
  assertGitWorktreeClean,
  collectCommittedSourceArchiveEntries,
  selectCommittedRuntimeEntries
} from '../../../scripts/source-archive.mjs';
import {
  assertTrustedGitExecutableUnchanged,
  resolveTrustedGitExecutable,
  runTrustedGit
} from '../../../scripts/trusted-git.mjs';
import { readZipEntries } from '../../../scripts/zip-utils.mjs';
import { STORAGE_KEYS } from '../../../src/shared/constants.js';
import { CLEANUP_REVIEW_STORAGE_KEY } from '../../../src/background/cleanup-preflight.js';

import { PROFILE_PRELAUNCH_OBSERVATION_SCHEMA, assertSyntheticFixturePageUrl } from './runtime-executor.mjs';
import { startNativePermissionPromptHelper } from './native-permission-dialog.mjs';
import { createSemanticObservationEvidence, semanticBindingFromScenarioResult } from './semantic-validator.mjs';
import { captureCleanCommittedBrowserSourceSnapshot } from './unattended-coordinator-core.mjs';

const PROFILE_OWNERSHIP_MARKER = '.sitewipe-owned-browser-directory.json';
const CLEANUP_PERMISSION_HANDOFF_STORAGE_KEY = 'sitewipe.cleanupPermissionHandoff.v1';
const DNR_PENDING_MUTATION_LOCAL_KEY = 'sitewipe.dnrPendingMutation.v1';
const DNR_PENDING_MUTATION_SESSION_KEY = 'sitewipe.dnrPendingMutation.session.v1';
const EXTENSION_ID_PATTERN = /^[a-p]{32}$/u;
const SHA256_PATTERN = /^[A-F0-9]{64}$/u;
const GIT_OBJECT_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const FIXTURE_HOST = 'selected.example.com';
const FIXTURE_SCALE = 'small';
const FIXTURE_VERSION = 'sitewipe-synthetic-v1';
const SURFACE_TIMEOUT_MS = 15_000;
const SMOKE_DNR_POLL_INTERVAL_MS = 100;
const SMOKE_MONITOR_READY_TIMEOUT_MS = 15_000;
const SMOKE_MONITOR_BINDING = '__sitewipeReportSmokeSafetyEvent';
const SMOKE_MONITOR_GLOBAL = '__sitewipeSmokeSafetyMonitor';
const SMOKE_MONITOR_REPORT_SCHEMA = 'sitewipe.smoke-safety-monitor-report.v2';
const SMOKE_MONITOR_PRELOAD_SCHEMA = 'sitewipe.smoke-safety-monitor-preload.v2';
const SMOKE_STARTUP_SOURCE_ROUTE_CONTRACT = Object.freeze({
  schema: 'sitewipe.smoke-startup-source-route-contract.v1',
  files: Object.freeze([
    Object.freeze({
      path: 'background/dnr-shield.js',
      sha256: '11E47DCD09B7DFA463B7868A1345C36DBE4834D07D7F7B12E14075D3A1603A20'
    }),
    Object.freeze({
      path: 'background/service-worker.js',
      sha256: '6EE5B3F30CD109B44B35F5C282C977B4F06C5A0D61A9F9BC07FF37BC2D4D6BC5'
    }),
    Object.freeze({
      path: 'background/shield-recovery.js',
      sha256: 'B781B85108EB5347277EE2B6DB4A525A6343B93751E6D93D971812A6C7F126C9'
    })
  ]),
  startupDnrMutationRoute: 'shield_recovery_clear_only',
  startupEntryPointCount: 3,
  startupMayAddDnrRules: false
});
const LOCAL_CLEANUP_AUTHORITY_KEYS = Object.freeze([
  STORAGE_KEYS.activeJob,
  STORAGE_KEYS.activeShield,
  STORAGE_KEYS.permissionLease,
  STORAGE_KEYS.activeReport,
  STORAGE_KEYS.reports,
  DNR_PENDING_MUTATION_LOCAL_KEY
]);
const SESSION_CLEANUP_AUTHORITY_KEYS = Object.freeze([
  CLEANUP_REVIEW_STORAGE_KEY,
  CLEANUP_PERMISSION_HANDOFF_STORAGE_KEY,
  DNR_PENDING_MUTATION_SESSION_KEY
]);

const ART_ASSERTIONS = Object.freeze([
  ['source.exact_head', 'art-01-source-exact-head', 'exactHead'],
  ['artifact.version_manifest_hash', 'art-01-artifact-version-manifest', 'artifact'],
  ['artifact.source_runtime_parity', 'art-01-source-runtime-parity', 'parity']
]);
const SMOKE_ASSERTIONS = Object.freeze([
  ['install.fresh_profile', 'smoke-01-fresh-profile', 'freshProfile'],
  ['defaults.safe', 'smoke-01-safe-defaults', 'safeDefaults'],
  ['load.no_permission_or_cleanup', 'smoke-01-no-authority-or-mutation', 'noAuthorityOrMutation']
]);

const DEPENDENCY_KEYS = Object.freeze([
  'captureArtFacts',
  'inspectExtensionState',
  'inspectFixtureState',
  'inspectFreshProfile',
  'inspectStartupSourceContract',
  'observeExactServiceWorker',
  'observeSurface',
  'preloadSafetyMonitor',
  'seedFixtureState',
  'startNativePromptObserver'
]);

const DEFAULT_DEPENDENCIES = Object.freeze({
  captureArtFacts: captureAuthenticArtFacts,
  inspectExtensionState: inspectInstalledExtensionState,
  inspectFixtureState: inspectSyntheticFixtureState,
  inspectFreshProfile: inspectOwnedFreshProfile,
  inspectStartupSourceContract: inspectSmokeStartupSourceContract,
  observeExactServiceWorker,
  observeSurface: observeInstalledSurface,
  preloadSafetyMonitor: preloadInstalledSafetyMonitor,
  seedFixtureState: seedSyntheticFixtureState,
  startNativePromptObserver: startSmokeNativePromptObserver
});

/**
 * Creates the concrete dispatcher consumed by installed-runner's executeCell(context)
 * hook. Dependency replacement exists solely so unit tests can use faithful browser
 * doubles without launching a real browser.
 */
export function createAuthenticScenarioExecutor(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('Authentic scenario executor overrides must be an object.');
  }
  const unexpected = Object.keys(overrides).filter((key) => !DEPENDENCY_KEYS.includes(key));
  if (unexpected.length) {
    throw new Error(`Authentic scenario executor received unknown dependencies: ${unexpected.join(', ')}.`);
  }
  const dependencies = Object.freeze({ ...DEFAULT_DEPENDENCIES, ...overrides });
  for (const key of DEPENDENCY_KEYS) {
    if (typeof dependencies[key] !== 'function') {
      throw new TypeError(`Authentic scenario executor dependency ${key} must be a function.`);
    }
  }
  return async function executeCell(context) {
    validateHookContext(context);
    if (context.scenario.id === 'ART-01') return executeArtCell(context, dependencies);
    if (context.scenario.id === 'SMOKE-01') return executeSmokeCell(context, dependencies);
    const startedAt = exactTimestamp(context.captureTimestamp());
    return Object.freeze({
      browser: structuredClone(context.browser),
      startedAt,
      completedAt: nondecreasingTimestamp(context.captureTimestamp(), startedAt),
      evidence: Object.freeze([]),
      reason: `No authentic scenario executor is registered here for ${context.scenario.id}.`
    });
  };
}

export const executeAuthenticInstalledBrowserCell = createAuthenticScenarioExecutor();
export const executeAuthenticScenarioCell = executeAuthenticInstalledBrowserCell;
export default executeAuthenticInstalledBrowserCell;

async function executeArtCell(context, dependencies) {
  const startedAt = exactTimestamp(context.captureTimestamp());
  const facts = await dependencies.captureArtFacts(context);
  assertExactKeys(facts, ['artifact', 'exactHead', 'parity'], 'Authentic ART facts');
  const completedAt = nondecreasingTimestamp(context.captureTimestamp(), startedAt);
  const binding = semanticBinding(context, { startedAt, completedAt });
  const evidence = ART_ASSERTIONS.map(([assertionId, observationId, fact], sequence) =>
    createSemanticObservationEvidence({
      binding,
      assertionId,
      observationId,
      payload: facts[fact],
      capturedAt: completedAt,
      sequence
    })
  );
  return Object.freeze({
    browser: structuredClone(context.browser),
    startedAt,
    completedAt,
    evidence: Object.freeze(evidence),
    reason:
      'Exact clean source, canonical artifact, staged runtime, and source/runtime parity were rechecked. ' +
      'The stale/ignored-candidate assertion remains not_run because this executor did not obtain two real production-verifier rejection cases.'
  });
}

async function executeSmokeCell(context, dependencies) {
  const startedAt = exactTimestamp(context.captureTimestamp());
  const freshProfile = await dependencies.inspectFreshProfile({
    cell: context.cell,
    launched: context.launched,
    plan: context.plan
  });
  assertSafeFreshProfilePrecondition(freshProfile);
  const fixtureUrl = exactFixtureUrl(context);
  const startupSourceContract = await dependencies.inspectStartupSourceContract(context.runtime);
  assertSmokeStartupSourceContract(startupSourceContract, context.runtime);

  const launched = context.launched;
  assertExactLaunchedController(launched, context);
  let nativeObserver = null;
  let nativeObserverLifecycleConsumed = false;
  let observations = null;
  let executionFailure = null;
  try {
    assertLoadedRuntimeManifest(context.runtime);

    const extensionOrigin = `chrome-extension://${launched.extension.id}`;
    const optionsPage = await launched.browser.newPage();
    const optionsUrl = `${extensionOrigin}/options/options.html`;
    const safetyMonitorPreload = await dependencies.preloadSafetyMonitor(optionsPage);
    assertSafetyMonitorPreloadReceipt(safetyMonitorPreload);
    nativeObserver = await dependencies.startNativePromptObserver(launched);
    assertNoPromptObserverCapability(nativeObserver, launched, context.browser);
    await navigateExactExtensionPage(optionsPage, optionsUrl);
    const beforeExtension = await dependencies.inspectExtensionState(optionsPage, {
      includeSettings: true,
      safetyMonitor: safetyMonitorPreload
    });
    assertSafeExtensionStartupPrecondition(beforeExtension);

    const fixturePage = await launched.browser.newPage();
    const fixtureResponse = await fixturePage.goto(fixtureUrl.href, {
      waitUntil: 'load',
      timeout: SURFACE_TIMEOUT_MS
    });
    if (!fixtureResponse || typeof fixtureResponse.status !== 'function' || fixtureResponse.status() !== 200) {
      throw new Error('Authentic SMOKE fixture navigation did not receive one exact successful synthetic response.');
    }
    assertExactPageUrl(fixturePage, fixtureUrl.href, 'Synthetic fixture page');
    const seedReceipt = await dependencies.seedFixtureState(fixturePage);
    assertSyntheticFixtureSeedReceipt(seedReceipt);
    const beforeFixture = await dependencies.inspectFixtureState(fixturePage);
    assertSeedReceiptMatchesBaseline(seedReceipt, beforeFixture);

    await fixturePage.bringToFront();
    const popup = await launched.triggerAction(fixturePage, { timeoutMs: 10_000 });
    assertAuthenticActionReceipt(popup, {
      extensionId: launched.extension.id,
      fixtureOrigin: fixtureUrl.origin,
      popupUrl: `${extensionOrigin}/popup/popup.html`
    });
    const popupSurface = await dependencies.observeSurface(popup.page, {
      expectedTitle: 'SiteWipe',
      expectedUrl: `${extensionOrigin}/popup/popup.html`,
      name: 'popup'
    });
    const optionsSurface = await dependencies.observeSurface(optionsPage, {
      expectedTitle: 'SiteWipe Options',
      expectedUrl: optionsUrl,
      name: 'options'
    });

    await dependencies.observeExactServiceWorker(launched.browser, {
      extensionId: launched.extension.id,
      serviceWorkerPath: context.runtime.manifest.serviceWorker
    });
    const coveredExtension = await dependencies.inspectExtensionState(optionsPage, {
      includeSettings: true,
      safetyMonitor: safetyMonitorPreload
    });
    const coveredFixture = await dependencies.inspectFixtureState(fixturePage);
    const coverageThrough = nondecreasingTimestamp(context.captureTimestamp(), startedAt);
    nativeObserverLifecycleConsumed = true;
    const nativePromptEvidence = await settleNoPromptObserver(nativeObserver, { coverageThrough });
    const afterFixture = await dependencies.inspectFixtureState(fixturePage);
    const afterExtension = await dependencies.inspectExtensionState(optionsPage, {
      includeSettings: false,
      safetyMonitor: safetyMonitorPreload
    });
    assertFinalSmokeCoverage({ afterExtension, beforeExtension, coveredExtension, nativePromptEvidence });
    observations = deriveSmokeObservations({
      afterExtension,
      afterFixture,
      beforeExtension,
      beforeFixture,
      coveredExtension,
      coveredFixture,
      freshProfile,
      launched,
      nativePromptEvidence,
      observationCoverageThrough: coverageThrough,
      seedReceipt,
      startupSourceContract,
      surfaces: [popupSurface, optionsSurface]
    });
  } catch (error) {
    executionFailure = error;
  }

  let observerFailure = null;
  if (nativeObserver !== null && !nativeObserverLifecycleConsumed) {
    try {
      nativeObserverLifecycleConsumed = true;
      await cancelNoPromptObserver(nativeObserver);
    } catch (error) {
      observerFailure = error;
    }
  }
  if (observerFailure !== null) throw observerFailure;
  if (executionFailure !== null) throw executionFailure;

  if (observations === null) {
    throw new Error('Authentic SMOKE evidence cannot be prepared without complete bounded observations.');
  }
  const completedAt = nondecreasingTimestamp(context.captureTimestamp(), startedAt);
  const binding = semanticBinding(context, { startedAt, completedAt });
  const evidence = SMOKE_ASSERTIONS.map(([assertionId, observationId, fact], sequence) =>
    createSemanticObservationEvidence({
      binding,
      assertionId,
      observationId,
      payload: observations[fact],
      capturedAt: completedAt,
      sequence
    })
  );
  return Object.freeze({
    browser: structuredClone(context.browser),
    startedAt,
    completedAt,
    evidence: Object.freeze(evidence),
    reason:
      'Fresh owned profile, safe installed defaults, authentic popup/options surfaces, exact MV3 worker, and unchanged nonempty synthetic state were observed; the runner accepts this evidence only after exact clean browser teardown. ' +
      'The side-panel assertion remains not_run because this executor did not observe the actual browser side-panel container or sidePanel API.'
  });
}

async function captureAuthenticArtFacts({ plan, runtime }) {
  const trustedGit = resolveTrustedGitExecutable({ root: plan.inputs.repositoryRoot });
  if (stableJson(trustedGit) !== stableJson(plan.inputs.git)) {
    throw new Error('ART recheck observed a trusted Git identity different from the approved plan.');
  }
  assertTrustedGitExecutableUnchanged(trustedGit);
  const sourceBefore = captureCleanCommittedBrowserSourceSnapshot(plan.inputs.repositoryRoot);
  assertExactSourceIdentity(sourceBefore, plan);
  const gitCounts = captureExactGitCounts(plan.inputs.repositoryRoot, sourceBefore.commitSha);
  if (gitCounts.indexDeltaCount || gitCounts.untrackedEntryCount || gitCounts.worktreeDeltaCount) {
    throw new Error('ART recheck observed a non-clean worktree after the production clean-tree guard.');
  }

  const committed = await collectCommittedSourceArchiveEntries(plan.inputs.repositoryRoot, {
    ref: sourceBefore.commitSha
  });
  if (committed.commit.toLowerCase() !== sourceBefore.commitSha) {
    throw new Error('ART committed source archive crossed its exact source commit.');
  }
  const sourceRuntime = selectCommittedRuntimeEntries(committed.entries, RUNTIME_FILES);
  const artifactIdentityBefore = await readStableRegularFile(plan.inputs.artifactPath, 'Approved runtime artifact');
  if (
    artifactIdentityBefore.bytes.length !== plan.identity.artifactBytes ||
    artifactIdentityBefore.sha256 !== plan.identity.artifactSha256
  ) {
    throw new Error('ART approved runtime artifact bytes differ from the approved identity.');
  }
  const artifactEntries = (await readZipEntries(plan.inputs.artifactPath)).sort((left, right) =>
    left.path.localeCompare(right.path)
  );
  const artifactIdentityAfter = await readStableRegularFile(plan.inputs.artifactPath, 'Approved runtime artifact');
  if (
    artifactIdentityAfter.sha256 !== artifactIdentityBefore.sha256 ||
    artifactIdentityAfter.bytes.length !== artifactIdentityBefore.bytes.length
  ) {
    throw new Error('ART runtime artifact changed while its ZIP entries were inspected.');
  }
  assertExactRuntimePathSet(artifactEntries);
  const artifactByPath = new Map(artifactEntries.map((entry) => [entry.path, entry]));
  const sourceByPath = new Map(sourceRuntime.map((entry) => [entry.path, entry]));
  const staged = await readExactStagedRuntime(runtime);
  const stagedByPath = new Map(staged.map((entry) => [entry.path, entry]));

  let mismatchCount = 0;
  for (const path of RUNTIME_FILES) {
    const source = sourceByPath.get(path);
    const artifact = artifactByPath.get(path);
    const stagedEntry = stagedByPath.get(path);
    if (!source || !artifact || !stagedEntry) {
      throw new Error(`ART runtime recheck is missing one canonical entry: ${path}.`);
    }
    if (!artifact.bytes.equals(source.bytes)) mismatchCount += 1;
    if (!stagedEntry.bytes.equals(artifact.bytes)) {
      throw new Error(`ART staged runtime differs from the exact approved artifact: ${path}.`);
    }
  }

  const manifestEntry = artifactByPath.get('manifest.json');
  const manifest = parseManifest(manifestEntry?.bytes);
  assertRuntimeReceipt(runtime, { artifactEntries, artifactIdentity: artifactIdentityBefore, manifest });
  const artifactFingerprint = runtimeFingerprint(
    RUNTIME_FILES.map((path) => ({ path, bytes: artifactByPath.get(path).bytes }))
  );
  const sourceFingerprint = runtimeFingerprint(sourceRuntime);

  assertGitWorktreeClean(plan.inputs.repositoryRoot, { expectedCommit: sourceBefore.commitSha });
  const sourceAfter = captureCleanCommittedBrowserSourceSnapshot(plan.inputs.repositoryRoot);
  if (stableJson(sourceAfter) !== stableJson(sourceBefore)) {
    throw new Error('ART committed source identity changed while the artifact was inspected.');
  }

  return deepFreeze({
    exactHead: {
      clean: true,
      commitSha: sourceBefore.commitSha,
      treeSha: sourceBefore.treeSha,
      ...gitCounts
    },
    artifact: {
      artifactBytes: artifactIdentityBefore.bytes.length,
      artifactSha256: artifactIdentityBefore.sha256,
      artifactVersion: manifest.version,
      manifestSha256: sha256(manifestEntry.bytes),
      manifestVersion: manifest.version,
      runtimeEntryCount: artifactEntries.length,
      zipVerificationPassed: artifactEntries.every(
        (entry) =>
          entry.modifiedAt === '1980-01-01T00:00:00.000Z' &&
          entry.uncompressedSize === entry.bytes.length &&
          Number.isInteger(entry.compressedSize) &&
          entry.compressedSize > 0
      )
    },
    parity: {
      artifactRuntimeFileCount: artifactEntries.length,
      artifactRuntimeFingerprintSha256: artifactFingerprint,
      mismatchCount,
      sourceRuntimeFileCount: sourceRuntime.length,
      sourceRuntimeFingerprintSha256: sourceFingerprint
    }
  });
}

export async function inspectOwnedFreshProfile({ cell, launched, plan }) {
  if (
    cell?.runId !== plan.runId ||
    cell?.planSha256 !== plan.planSha256 ||
    cell?.scenarioId !== 'SMOKE-01' ||
    typeof cell?.profilePath !== 'string' ||
    !SHA256_PATTERN.test(String(cell?.canarySha256 || ''))
  ) {
    throw new Error('SMOKE staged cell differs from the exact approved run or ownership identity.');
  }
  const profilePath = resolve(cell.profilePath);
  const profileInfo = await lstat(profilePath, { bigint: true });
  if (!profileInfo.isDirectory() || profileInfo.isSymbolicLink()) {
    throw new Error('SMOKE profile is not a physical owned directory.');
  }
  if (!samePath(profilePath, await realpath(profilePath))) {
    throw new Error('SMOKE profile traverses a filesystem alias or reparse point.');
  }
  const prelaunch = launched?.receipt?.profilePrelaunch;
  assertExactKeys(
    prelaunch,
    ['profileDataEntryCountBeforeLaunch', 'profileOwnershipMarkerMatched', 'profilePath', 'profileWasNew', 'schema'],
    'SMOKE receipt-bound profile prelaunch observation'
  );
  if (
    prelaunch.schema !== PROFILE_PRELAUNCH_OBSERVATION_SCHEMA ||
    !samePath(prelaunch.profilePath, profilePath) ||
    prelaunch.profileWasNew !== true ||
    prelaunch.profileOwnershipMarkerMatched !== true ||
    prelaunch.profileDataEntryCountBeforeLaunch !== 0
  ) {
    throw new Error('SMOKE launch receipt lacks the exact pristine prelaunch profile observation.');
  }
  const markerPath = resolve(profilePath, PROFILE_OWNERSHIP_MARKER);
  const markerIdentity = await readStableRegularFile(markerPath, 'SMOKE profile ownership marker');
  let marker;
  try {
    marker = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(markerIdentity.bytes));
  } catch (error) {
    throw new Error('SMOKE profile ownership marker is not exact UTF-8 JSON.', { cause: error });
  }
  if (!markerIdentity.bytes.equals(canonicalJsonBytes(marker))) {
    throw new Error('SMOKE profile ownership marker is not canonical JSON.');
  }
  assertExactKeys(
    marker,
    ['browserName', 'canarySha256', 'kind', 'planSha256', 'runId', 'scenarioId', 'schema'],
    'SMOKE profile ownership marker'
  );
  if (
    marker.schema !== 'sitewipe.owned-browser-directory.v1' ||
    marker.runId !== plan.runId ||
    marker.planSha256 !== plan.planSha256 ||
    marker.browserName !== cell.browserName ||
    marker.scenarioId !== 'SMOKE-01' ||
    marker.kind !== 'profile' ||
    marker.canarySha256 !== cell.canarySha256
  ) {
    throw new Error('SMOKE profile ownership marker differs from the exact staged cell.');
  }
  return deepFreeze({
    profileWasNew: true,
    profileOwnershipMarkerMatched: true,
    profileDataEntryCountBeforeLaunch: prelaunch.profileDataEntryCountBeforeLaunch
  });
}

async function seedSyntheticFixtureState(page) {
  const seedOperation = await page.evaluate(
    async ({ operation, expectedVersion, expectedScale }) => {
      if (operation !== 'sitewipe-smoke-seed-fixture') throw new Error('Unexpected fixture seed operation.');
      const fixture = globalThis.sitewipeFixture;
      if (
        !fixture ||
        fixture.readOnly !== false ||
        fixture.version !== expectedVersion ||
        fixture.scale !== expectedScale ||
        typeof fixture.seedFixture !== 'function'
      ) {
        throw new Error('Synthetic fixture does not expose the exact bounded seed capability.');
      }
      const snapshot = await fixture.seedFixture();
      if (snapshot?.ok !== true || snapshot.fixtureVersion !== expectedVersion || snapshot.scale !== expectedScale) {
        throw new Error('Synthetic fixture seed did not return its exact successful snapshot.');
      }
      if (navigator.serviceWorker?.getRegistrations) {
        const registrations = await navigator.serviceWorker.getRegistrations();
        if (registrations.length > 0) {
          const registration = await Promise.race([
            navigator.serviceWorker.ready,
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Synthetic fixture worker activation timed out.')), 10_000)
            )
          ]);
          if (!registration?.active || registration.active.state !== 'activated') {
            throw new Error('Synthetic fixture service worker did not reach an exact activated state.');
          }
        }
      }
      const stableJson = (value) => {
        if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
        if (value && typeof value === 'object') {
          return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
            .join(',')}}`;
        }
        return JSON.stringify(value);
      };
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(snapshot)));
      return {
        fixtureVersion: snapshot.fixtureVersion,
        scale: snapshot.scale,
        seeded: true,
        snapshotSha256: [...new Uint8Array(digest)]
          .map((value) => value.toString(16).padStart(2, '0'))
          .join('')
          .toUpperCase()
      };
    },
    {
      operation: 'sitewipe-smoke-seed-fixture',
      expectedVersion: FIXTURE_VERSION,
      expectedScale: FIXTURE_SCALE
    }
  );
  assertExactKeys(seedOperation, ['fixtureVersion', 'scale', 'seeded', 'snapshotSha256'], 'Fixture seed operation');
  const baseline = await inspectSyntheticFixtureState(page);
  const receipt = {
    baselineDataEntryCount: baseline.dataEntryCount,
    baselineInventorySha256: baseline.inventorySha256,
    baselineStorageKindCount: baseline.storageKindCount,
    baselineValueSha256: baseline.valueSha256,
    fixtureVersion: seedOperation.fixtureVersion,
    scale: seedOperation.scale,
    schema: 'sitewipe.synthetic-fixture-seed-receipt.v2',
    seeded: seedOperation.seeded,
    snapshotSha256: seedOperation.snapshotSha256
  };
  assertSyntheticFixtureSeedReceipt(receipt);
  return deepFreeze(receipt);
}

async function inspectSyntheticFixtureState(page) {
  const state = await page.evaluate(
    async ({ operation }) => {
      if (operation !== 'sitewipe-smoke-fixture-state') throw new Error('Unexpected fixture observation operation.');
      if (typeof globalThis.indexedDB?.databases !== 'function') {
        throw new Error('The pinned browser does not expose read-only IndexedDB enumeration.');
      }

      const stableJson = (value) => {
        if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
        if (value && typeof value === 'object') {
          return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
            .join(',')}}`;
        }
        return JSON.stringify(value);
      };
      const digestBytes = async (bytes) => {
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return [...new Uint8Array(digest)]
          .map((value) => value.toString(16).padStart(2, '0'))
          .join('')
          .toUpperCase();
      };
      const digestValue = (value) => digestBytes(new TextEncoder().encode(stableJson(value)));
      const requestResult = (request) =>
        new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error || new Error('Synthetic fixture read request failed.'));
          request.onblocked = () => reject(new Error('Synthetic fixture read request was blocked.'));
        });
      const transactionDone = (transaction) =>
        new Promise((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = () =>
            reject(transaction.error || new Error('Synthetic fixture read transaction failed.'));
          transaction.onabort = () =>
            reject(transaction.error || new Error('Synthetic fixture read transaction was aborted.'));
        });
      const storageEntries = (storage) => {
        const entries = [];
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (key !== null) entries.push([key, storage.getItem(key)]);
        }
        return entries.sort((left, right) => left[0].localeCompare(right[0]));
      };
      const readDatabases = async () => {
        const metadata = (await globalThis.indexedDB.databases())
          .filter((entry) => typeof entry?.name === 'string' && entry.name)
          .sort((left, right) => left.name.localeCompare(right.name));
        const databases = [];
        for (const descriptor of metadata) {
          const request = globalThis.indexedDB.open(descriptor.name);
          request.onupgradeneeded = () => request.transaction?.abort();
          const database = await requestResult(request);
          try {
            const stores = [];
            for (const storeName of [...database.objectStoreNames].sort()) {
              const transaction = database.transaction(storeName, 'readonly');
              const completion = transactionDone(transaction);
              const store = transaction.objectStore(storeName);
              const [keys, values] = await Promise.all([
                requestResult(store.getAllKeys()),
                requestResult(store.getAll())
              ]);
              await completion;
              const records = keys
                .map((key, index) => ({ key, value: values[index] }))
                .sort((left, right) => stableJson(left.key).localeCompare(stableJson(right.key)));
              stores.push({
                name: storeName,
                keyPath: store.keyPath,
                autoIncrement: store.autoIncrement,
                indexNames: [...store.indexNames].sort(),
                records
              });
            }
            databases.push({ name: database.name, version: database.version, stores });
          } finally {
            database.close();
          }
        }
        return databases;
      };
      const readCacheStorage = async (storage) => {
        if (!storage?.keys || !storage?.open) return [];
        const caches = [];
        for (const cacheName of (await storage.keys()).sort()) {
          const cache = await storage.open(cacheName);
          const requests = await cache.keys();
          const entries = [];
          for (const request of requests.sort((left, right) => left.url.localeCompare(right.url))) {
            const response = await cache.match(request);
            if (!response) throw new Error('Synthetic fixture cache entry disappeared during observation.');
            entries.push({
              method: request.method,
              requestUrl: request.url,
              responseStatus: response.status,
              responseBodySha256: await digestBytes(await response.clone().arrayBuffer())
            });
          }
          caches.push({ name: cacheName, entries });
        }
        return caches;
      };
      const readOpfs = async () => {
        if (!navigator.storage?.getDirectory) return [];
        const root = await navigator.storage.getDirectory();
        const files = [];
        const visit = async (directory, prefix) => {
          const entries = [];
          for await (const [name, handle] of directory.entries()) entries.push([name, handle]);
          entries.sort((left, right) => left[0].localeCompare(right[0]));
          for (const [name, handle] of entries) {
            const childPath = prefix ? `${prefix}/${name}` : name;
            if (handle.kind === 'directory') {
              await visit(handle, childPath);
            } else if (handle.kind === 'file') {
              const file = await handle.getFile();
              files.push({
                path: childPath,
                bytes: file.size,
                sha256: await digestBytes(await file.arrayBuffer())
              });
            } else {
              throw new Error('Synthetic fixture OPFS exposed an unknown handle kind.');
            }
          }
        };
        await visit(root, '');
        return files;
      };
      const readBuckets = async () => {
        if (!navigator.storageBuckets?.keys || !navigator.storageBuckets?.open) return [];
        const buckets = [];
        for (const name of (await navigator.storageBuckets.keys()).sort()) {
          const bucket = await navigator.storageBuckets.open(name);
          buckets.push({ name, caches: await readCacheStorage(bucket.caches) });
        }
        return buckets;
      };

      const localEntries = storageEntries(localStorage);
      const sessionEntries = storageEntries(sessionStorage);
      const cookies = globalThis.document.cookie
        .split(';')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          const separator = entry.indexOf('=');
          return separator < 0 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)];
        })
        .sort((left, right) => left[0].localeCompare(right[0]));
      const databases = await readDatabases();
      const caches = await readCacheStorage(globalThis.caches);
      const registrations = (await navigator.serviceWorker.getRegistrations())
        .map((registration) => ({
          scope: registration.scope,
          scriptUrl:
            registration.active?.scriptURL ||
            registration.waiting?.scriptURL ||
            registration.installing?.scriptURL ||
            null
        }))
        .sort((left, right) => left.scope.localeCompare(right.scope));
      const opfsFiles = await readOpfs();
      const buckets = await readBuckets();
      const fixtureSnapshot = await globalThis.sitewipeFixture.snapshotFixture();
      const databaseRecordCount = databases.reduce(
        (total, database) =>
          total + database.stores.reduce((storeTotal, store) => storeTotal + store.records.length, 0),
        0
      );
      const cacheEntryCount = caches.reduce((total, cache) => total + cache.entries.length, 0);
      const bucketEntryCount = buckets.reduce(
        (total, bucket) => total + bucket.caches.reduce((cacheTotal, cache) => cacheTotal + cache.entries.length, 0),
        0
      );
      const counts = {
        localStorage: localEntries.length,
        sessionStorage: sessionEntries.length,
        cookies: cookies.length,
        indexedDbRecords: databaseRecordCount,
        cacheEntries: cacheEntryCount,
        serviceWorkers: registrations.length,
        opfsFiles: opfsFiles.length,
        bucketCacheEntries: bucketEntryCount
      };
      const inventory = {
        localStorageKeys: localEntries.map(([key]) => key),
        sessionStorageKeys: sessionEntries.map(([key]) => key),
        cookieNames: cookies.map(([name]) => name),
        databases: databases.map((database) => ({
          name: database.name,
          version: database.version,
          stores: database.stores.map((store) => ({
            name: store.name,
            keyPath: store.keyPath,
            autoIncrement: store.autoIncrement,
            indexNames: store.indexNames,
            keys: store.records.map(({ key }) => key)
          }))
        })),
        caches: caches.map((cache) => ({
          name: cache.name,
          requests: cache.entries.map(({ method, requestUrl }) => ({ method, requestUrl }))
        })),
        serviceWorkers: registrations,
        opfsPaths: opfsFiles.map(({ path }) => path),
        buckets: buckets.map((bucket) => ({
          name: bucket.name,
          caches: bucket.caches.map((cache) => ({
            name: cache.name,
            requests: cache.entries.map(({ method, requestUrl }) => ({ method, requestUrl }))
          }))
        }))
      };
      const values = {
        localStorage: localEntries,
        sessionStorage: sessionEntries,
        cookies,
        databases,
        caches,
        serviceWorkers: registrations,
        opfsFiles,
        buckets,
        fixtureSnapshot
      };
      return {
        dataEntryCount: Object.values(counts).reduce((total, value) => total + value, 0),
        storageKindCount: Object.values(counts).filter((value) => value > 0).length,
        inventorySha256: await digestValue(inventory),
        valueSha256: await digestValue(values)
      };
    },
    { operation: 'sitewipe-smoke-fixture-state' }
  );
  assertSyntheticFixtureStateObservation(state);
  return deepFreeze(state);
}

async function inspectInstalledExtensionState(page, { includeSettings, safetyMonitor } = {}) {
  if (typeof includeSettings !== 'boolean' || !safetyMonitor || typeof safetyMonitor.snapshotBarrier !== 'function') {
    throw new Error('Installed extension state inspection requires the exact Node-retained SMOKE monitor capability.');
  }
  await safetyMonitor.snapshotBarrier();
  const directState = await page.evaluate(
    async ({ includeSettings: shouldReadSettings, operation, protocolVersion, storageKeys, internalKeys }) => {
      if (operation !== 'sitewipe-smoke-extension-state')
        throw new Error('Unexpected extension observation operation.');
      let settings = null;
      if (shouldReadSettings) {
        const requestId = `smoke-${crypto.randomUUID()}`;
        const response = await chrome.runtime.sendMessage({
          protocolVersion,
          requestId,
          type: 'sitewipe.getSettings',
          payload: {}
        });
        if (
          response?.ok !== true ||
          response.protocolVersion !== protocolVersion ||
          response.requestId !== requestId ||
          !response.settings ||
          typeof response.settings !== 'object' ||
          Array.isArray(response.settings)
        ) {
          throw new Error('SiteWipe did not return one exact production settings response.');
        }
        settings = structuredClone(response.settings);
      }
      const [permissions, dynamicRules, sessionRules, local, session] = await Promise.all([
        chrome.permissions.getAll(),
        chrome.declarativeNetRequest.getDynamicRules(),
        chrome.declarativeNetRequest.getSessionRules(),
        chrome.storage.local.get(null),
        chrome.storage.session.get(null)
      ]);
      if (!Array.isArray(dynamicRules) || !Array.isArray(sessionRules)) {
        throw new Error('Installed extension DNR endpoints returned malformed rule collections.');
      }
      const stableJson = (value) => {
        if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
        if (value && typeof value === 'object') {
          return `{${Object.keys(value)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
            .join(',')}}`;
        }
        return JSON.stringify(value);
      };
      const digest = async (value) => {
        const bytes = new TextEncoder().encode(`${stableJson(value)}\n`);
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        return [...new Uint8Array(hash)]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('')
          .toUpperCase();
      };
      const normalizedDynamicRules = [...dynamicRules].sort((left, right) => Number(left.id) - Number(right.id));
      const normalizedSessionRules = [...sessionRules].sort((left, right) => Number(left.id) - Number(right.id));
      const originsAreExact = Array.isArray(permissions?.origins);
      const origins = originsAreExact ? permissions.origins : [];
      const reports = Array.isArray(local[storageKeys.reports])
        ? local[storageKeys.reports].length
        : local[storageKeys.reports] == null
          ? 0
          : 1;
      const activeReport = local[storageKeys.activeReport] == null ? 0 : 1;
      return {
        dynamicDnrRuleCount: normalizedDynamicRules.length,
        dynamicDnrRulesSha256: await digest(normalizedDynamicRules),
        finalLocalAuthorityEntryCount: internalKeys.localAuthority.filter((key) => local[key] != null).length,
        finalSessionAuthorityEntryCount: internalKeys.sessionAuthority.filter((key) => session[key] != null).length,
        hostPermissionOrigins: [],
        permissionLeaseCount: local[storageKeys.permissionLease] == null ? 0 : 1,
        reportCount: reports + activeReport,
        runningJobCount: local[storageKeys.activeJob] == null ? 0 : 1,
        sessionDnrRuleCount: normalizedSessionRules.length,
        sessionDnrRulesSha256: await digest(normalizedSessionRules),
        settings,
        unexpectedHostPermissionOriginCount: originsAreExact ? origins.length : 1
      };
    },
    {
      operation: 'sitewipe-smoke-extension-state',
      includeSettings,
      protocolVersion: 1,
      storageKeys: {
        activeJob: STORAGE_KEYS.activeJob,
        activeReport: STORAGE_KEYS.activeReport,
        activeShield: STORAGE_KEYS.activeShield,
        permissionLease: STORAGE_KEYS.permissionLease,
        reports: STORAGE_KEYS.reports
      },
      internalKeys: {
        localAuthority: LOCAL_CLEANUP_AUTHORITY_KEYS,
        sessionAuthority: SESSION_CLEANUP_AUTHORITY_KEYS
      }
    }
  );
  const safety = await safetyMonitor.snapshotBarrier();
  const state = {
    ...directState,
    monitorBaselineErrorCount: safety.baselineErrorCount,
    downloadCreatedEventCount: safety.downloadCreatedEventCount,
    downloadErasedEventCount: safety.downloadErasedEventCount,
    dnrBaselineNonemptyCount: safety.dnrBaselineNonemptyCount,
    dnrPollCount: safety.dnrPollCount,
    dnrPollErrorCount: safety.dnrPollErrorCount,
    dnrPollIntervalMs: safety.dnrPollIntervalMs,
    dnrPollMaximumObservedGapMs: safety.dnrPollMaximumObservedGapMs,
    dnrPollNonemptyCount: safety.dnrPollNonemptyCount,
    initialLocalAuthorityEntryCount: safety.initialLocalAuthorityEntryCount,
    initialSessionAuthorityEntryCount: safety.initialSessionAuthorityEntryCount,
    localAuthorityChangedKeyCount: safety.localAuthorityChangedKeyCount,
    monitorBaselineAcknowledgedCount: safety.baselineAcknowledgedCount,
    monitorCoverageObservedAt: safety.coverageObservedAt,
    monitorCoverageSequence: safety.coverageSequence,
    monitorDocumentReadyCount: safety.documentReadyCount,
    monitorReadyAt: safety.firstBaselineAt,
    permissionAddedEventCount: safety.permissionAddedEventCount,
    permissionRemovedEventCount: safety.permissionRemovedEventCount,
    sessionAuthorityChangedKeyCount: safety.sessionAuthorityChangedKeyCount
  };
  assertExactKeys(
    state,
    [
      'downloadCreatedEventCount',
      'downloadErasedEventCount',
      'dnrBaselineNonemptyCount',
      'dnrPollCount',
      'dnrPollErrorCount',
      'dnrPollIntervalMs',
      'dnrPollMaximumObservedGapMs',
      'dnrPollNonemptyCount',
      'dynamicDnrRuleCount',
      'dynamicDnrRulesSha256',
      'finalLocalAuthorityEntryCount',
      'finalSessionAuthorityEntryCount',
      'hostPermissionOrigins',
      'initialLocalAuthorityEntryCount',
      'initialSessionAuthorityEntryCount',
      'localAuthorityChangedKeyCount',
      'monitorBaselineAcknowledgedCount',
      'monitorBaselineErrorCount',
      'monitorCoverageObservedAt',
      'monitorCoverageSequence',
      'monitorDocumentReadyCount',
      'monitorReadyAt',
      'permissionAddedEventCount',
      'permissionLeaseCount',
      'permissionRemovedEventCount',
      'reportCount',
      'runningJobCount',
      'sessionAuthorityChangedKeyCount',
      'sessionDnrRuleCount',
      'sessionDnrRulesSha256',
      'settings',
      'unexpectedHostPermissionOriginCount'
    ],
    'Installed extension state observation'
  );
  if (
    !Array.isArray(state.hostPermissionOrigins) ||
    state.hostPermissionOrigins.some((origin) => typeof origin !== 'string')
  ) {
    throw new Error('Installed extension host-permission observation is malformed.');
  }
  for (const key of ['dynamicDnrRulesSha256', 'sessionDnrRulesSha256']) {
    if (!SHA256_PATTERN.test(String(state[key] || ''))) {
      throw new Error(`Installed extension state ${key} is malformed.`);
    }
  }
  for (const key of [
    'downloadCreatedEventCount',
    'downloadErasedEventCount',
    'dnrBaselineNonemptyCount',
    'dnrPollCount',
    'dnrPollErrorCount',
    'dnrPollIntervalMs',
    'dnrPollMaximumObservedGapMs',
    'dnrPollNonemptyCount',
    'dynamicDnrRuleCount',
    'finalLocalAuthorityEntryCount',
    'finalSessionAuthorityEntryCount',
    'initialLocalAuthorityEntryCount',
    'initialSessionAuthorityEntryCount',
    'localAuthorityChangedKeyCount',
    'monitorBaselineAcknowledgedCount',
    'monitorBaselineErrorCount',
    'monitorCoverageSequence',
    'monitorDocumentReadyCount',
    'permissionAddedEventCount',
    'permissionLeaseCount',
    'permissionRemovedEventCount',
    'reportCount',
    'runningJobCount',
    'sessionAuthorityChangedKeyCount',
    'sessionDnrRuleCount',
    'unexpectedHostPermissionOriginCount'
  ]) {
    if (!Number.isInteger(state[key]) || state[key] < 0) {
      throw new Error(`Installed extension state ${key} is malformed.`);
    }
  }
  if (
    (includeSettings && (!state.settings || typeof state.settings !== 'object' || Array.isArray(state.settings))) ||
    (!includeSettings && state.settings !== null) ||
    !isIsoTimestamp(state.monitorReadyAt) ||
    !isIsoTimestamp(state.monitorCoverageObservedAt) ||
    state.dnrPollIntervalMs < 1 ||
    state.dnrPollIntervalMs > 100 ||
    state.monitorBaselineAcknowledgedCount < 1 ||
    state.monitorDocumentReadyCount < 1
  ) {
    throw new Error('Installed extension settings observation is malformed.');
  }
  return deepFreeze(structuredClone(state));
}

async function observeInstalledSurface(page, { expectedTitle, expectedUrl, name }) {
  assertExactPageUrl(page, expectedUrl, `Installed ${name} surface`);
  if (typeof page.bringToFront !== 'function' || typeof page.waitForFunction !== 'function') {
    throw new Error(`Installed ${name} surface is not a controllable browser page.`);
  }
  await page.bringToFront();
  await page.waitForFunction(
    (title) => globalThis.document.readyState === 'complete' && globalThis.document.title === title,
    { timeout: SURFACE_TIMEOUT_MS },
    expectedTitle
  );
  const observed = await page.evaluate(
    ({ operation }) => {
      if (operation !== 'sitewipe-smoke-surface') throw new Error('Unexpected surface observation operation.');
      return {
        documentTitle: globalThis.document.title,
        readyState: globalThis.document.readyState,
        visible: globalThis.document.visibilityState === 'visible' && globalThis.document.hidden === false
      };
    },
    { operation: 'sitewipe-smoke-surface' }
  );
  assertExactKeys(observed, ['documentTitle', 'readyState', 'visible'], `Installed ${name} surface observation`);
  if (observed.documentTitle !== expectedTitle || observed.readyState !== 'complete' || observed.visible !== true) {
    throw new Error(`Installed ${name} surface did not become the exact visible production document.`);
  }
  return deepFreeze({
    name,
    documentTitle: observed.documentTitle,
    originScheme: 'chrome-extension',
    readyState: observed.readyState,
    visible: observed.visible
  });
}

async function observeExactServiceWorker(browser, { extensionId, serviceWorkerPath }) {
  const expectedUrl = `chrome-extension://${extensionId}/${serviceWorkerPath}`;
  const predicate = (target) => target.type() === 'service_worker' && target.url() === expectedUrl;
  let target = browser.targets().find(predicate);
  if (!target) target = await browser.waitForTarget(predicate, { timeout: SURFACE_TIMEOUT_MS });
  if (!target || !predicate(target)) {
    throw new Error('The exact SiteWipe MV3 service-worker target was not observed.');
  }
  return true;
}

async function startSmokeNativePromptObserver(launched) {
  const identity = launched?.receipt?.processIdentity;
  if (
    !identity ||
    !Number.isInteger(identity.processId) ||
    identity.processId <= 0 ||
    typeof identity.path !== 'string' ||
    !SHA256_PATTERN.test(String(identity.sha256 || '')) ||
    !/^\d+$/u.test(String(identity.startTimeUtcTicks || ''))
  ) {
    throw new Error('SMOKE launch receipt lacks the exact browser process identity for no-prompt observation.');
  }
  return startNativePermissionPromptHelper({
    targetProcessId: identity.processId,
    expectedProcessPath: identity.path,
    expectedProcessSha256: identity.sha256,
    expectedProcessStartTimeUtcTicks: identity.startTimeUtcTicks,
    scheduleId: 'SMOKE-01.observe-none'
  });
}

async function settleNoPromptObserver(observer, { coverageThrough }) {
  if (!observer || typeof observer !== 'object' || typeof observer.settle !== 'function') {
    throw new Error('SMOKE no-prompt observer did not return one exact bounded settlement capability.');
  }
  const readyAt = observer.readiness?.readyAt;
  const evidence = await observer.settle();
  if (
    evidence?.schema !== 'sitewipe.native-permission-dialog-evidence.v1' ||
    evidence.status !== 'no_prompt_observed' ||
    evidence.scheduleId !== 'SMOKE-01.observe-none' ||
    evidence.scenarioId !== 'SMOKE-01' ||
    evidence.action !== 'observe-none' ||
    !isIsoTimestamp(readyAt) ||
    !isIsoTimestamp(evidence.observedAt) ||
    !isIsoTimestamp(coverageThrough) ||
    Date.parse(coverageThrough) < Date.parse(readyAt) ||
    Date.parse(evidence.observedAt) < Date.parse(coverageThrough)
  ) {
    throw new Error('SMOKE native observation did not prove that no host-access prompt appeared.');
  }
  return deepFreeze({ ...structuredClone(evidence), readyAt });
}

async function cancelNoPromptObserver(observer) {
  if (!observer || typeof observer !== 'object' || typeof observer.cancelAndWait !== 'function') {
    throw new Error('SMOKE no-prompt observer did not return one exact bounded cancellation capability.');
  }
  const settlement = await observer.cancelAndWait();
  if (
    settlement?.schema !== 'sitewipe.native-permission-helper-settlement.v1' ||
    !Number.isInteger(settlement.processId) ||
    settlement.processId <= 0 ||
    !['already_settled', 'terminated_and_settled'].includes(settlement.status)
  ) {
    throw new Error('SMOKE no-prompt observer did not settle its exact helper child.');
  }
}

function assertNoPromptObserverCapability(observer, launched, browserPin) {
  if (
    !observer ||
    typeof observer !== 'object' ||
    typeof observer.settle !== 'function' ||
    typeof observer.cancelAndWait !== 'function'
  ) {
    throw new Error('SMOKE no-prompt observer did not return exact bounded settle/cancel capabilities.');
  }
  const readiness = observer.readiness;
  const processIdentity = launched?.receipt?.processIdentity;
  assertExactKeys(
    readiness,
    [
      'action',
      'browserName',
      'browserVersion',
      'helperProcessId',
      'readyAt',
      'scenarioId',
      'scheduleId',
      'schema',
      'status',
      'targetProcess'
    ],
    'SMOKE native-observer readiness'
  );
  assertExactKeys(
    readiness.targetProcess,
    ['path', 'processId', 'sha256', 'startTimeUtcTicks'],
    'SMOKE native-observer ready target process'
  );
  if (
    readiness.schema !== 'sitewipe.native-permission-helper-ready.v1' ||
    readiness.status !== 'ready' ||
    readiness.scheduleId !== 'SMOKE-01.observe-none' ||
    readiness.scenarioId !== 'SMOKE-01' ||
    readiness.action !== 'observe-none' ||
    readiness.browserName !== browserPin.name ||
    readiness.browserVersion !== browserPin.version ||
    !Number.isInteger(readiness.helperProcessId) ||
    readiness.helperProcessId <= 0 ||
    !isIsoTimestamp(readiness.readyAt) ||
    readiness.targetProcess.processId !== processIdentity.processId ||
    !samePath(readiness.targetProcess.path, processIdentity.path) ||
    readiness.targetProcess.sha256 !== processIdentity.sha256 ||
    readiness.targetProcess.startTimeUtcTicks !== processIdentity.startTimeUtcTicks
  ) {
    throw new Error('SMOKE no-prompt observer was not ready for the exact launched browser before navigation.');
  }
}

function assertSafetyMonitorPreloadReceipt(receipt) {
  assertExactKeys(
    receipt,
    ['installedBeforeNavigation', 'schema', 'snapshotBarrier'],
    'SMOKE safety-monitor preload receipt'
  );
  if (
    receipt.schema !== SMOKE_MONITOR_PRELOAD_SCHEMA ||
    receipt.installedBeforeNavigation !== true ||
    typeof receipt.snapshotBarrier !== 'function'
  ) {
    throw new Error('SMOKE safety monitor was not installed before Options navigation.');
  }
}

function assertSafeExtensionStartupPrecondition(value) {
  const emptyRulesSha256 = sha256(canonicalJsonBytes([]));
  if (
    value.dynamicDnrRuleCount !== 0 ||
    value.sessionDnrRuleCount !== 0 ||
    value.dynamicDnrRulesSha256 !== emptyRulesSha256 ||
    value.sessionDnrRulesSha256 !== emptyRulesSha256 ||
    value.dnrBaselineNonemptyCount !== 0 ||
    value.dnrPollErrorCount !== 0 ||
    value.dnrPollNonemptyCount !== 0 ||
    value.monitorBaselineAcknowledgedCount < 1 ||
    value.monitorBaselineErrorCount !== 0 ||
    value.monitorDocumentReadyCount < 1 ||
    value.initialLocalAuthorityEntryCount !== 0 ||
    value.initialSessionAuthorityEntryCount !== 0 ||
    value.finalLocalAuthorityEntryCount !== 0 ||
    value.finalSessionAuthorityEntryCount !== 0 ||
    value.unexpectedHostPermissionOriginCount !== 0 ||
    value.localAuthorityChangedKeyCount !== 0 ||
    value.sessionAuthorityChangedKeyCount !== 0 ||
    value.permissionAddedEventCount !== 0 ||
    value.permissionRemovedEventCount !== 0 ||
    value.downloadCreatedEventCount !== 0 ||
    value.downloadErasedEventCount !== 0 ||
    value.permissionLeaseCount !== 0 ||
    value.reportCount !== 0 ||
    value.runningJobCount !== 0
  ) {
    throw new Error('SMOKE startup endpoint state is outside the exact no-authority boundary.');
  }
}

function assertFinalSmokeCoverage({ afterExtension, beforeExtension, coveredExtension, nativePromptEvidence }) {
  if (
    afterExtension.monitorCoverageSequence <= coveredExtension.monitorCoverageSequence ||
    coveredExtension.monitorCoverageSequence < beforeExtension.monitorCoverageSequence ||
    Date.parse(afterExtension.monitorCoverageObservedAt) < Date.parse(coveredExtension.monitorCoverageObservedAt) ||
    Date.parse(afterExtension.monitorCoverageObservedAt) < Date.parse(nativePromptEvidence.observedAt) ||
    afterExtension.monitorBaselineAcknowledgedCount < beforeExtension.monitorBaselineAcknowledgedCount ||
    afterExtension.monitorDocumentReadyCount < beforeExtension.monitorDocumentReadyCount
  ) {
    throw new Error('The final SMOKE monitor boundary did not cover fixture reinspection and native settlement.');
  }
}

function deriveSmokeObservations({
  afterExtension,
  afterFixture,
  beforeExtension,
  beforeFixture,
  coveredExtension,
  coveredFixture,
  freshProfile,
  launched,
  nativePromptEvidence,
  observationCoverageThrough,
  seedReceipt,
  startupSourceContract,
  surfaces
}) {
  assertSyntheticFixtureSeedReceipt(seedReceipt);
  assertSeedReceiptMatchesBaseline(seedReceipt, beforeFixture);
  assertSyntheticFixtureStateObservation(coveredFixture);
  assertSyntheticFixtureStateObservation(afterFixture);
  assertObservedPopupAndOptionsSurfaces(surfaces);
  if (
    beforeExtension.hostPermissionOrigins.length ||
    coveredExtension.hostPermissionOrigins.length ||
    afterExtension.hostPermissionOrigins.length ||
    beforeExtension.unexpectedHostPermissionOriginCount > 0 ||
    coveredExtension.unexpectedHostPermissionOriginCount > 0 ||
    afterExtension.unexpectedHostPermissionOriginCount > 0
  ) {
    throw new Error('Fresh SMOKE state unexpectedly contains host access; private origins will not be retained.');
  }
  if (stableJson(beforeExtension.settings) !== stableJson(coveredExtension.settings)) {
    throw new Error('Installed SiteWipe settings changed while read-only SMOKE surfaces were observed.');
  }
  const fixtureMutationCount = [coveredFixture, afterFixture]
    .flatMap((observed) => [
      beforeFixture.dataEntryCount !== observed.dataEntryCount,
      beforeFixture.storageKindCount !== observed.storageKindCount,
      beforeFixture.inventorySha256 !== observed.inventorySha256,
      beforeFixture.valueSha256 !== observed.valueSha256
    ])
    .filter(Boolean).length;
  const extensionStates = [beforeExtension, coveredExtension, afterExtension];
  const numericMaximum = (key) => Math.max(...extensionStates.map((state) => state[key]));
  const fixtureSeedReceiptSha256 = sha256(canonicalJsonBytes(seedReceipt));
  const anyDnrEndpointNonempty = extensionStates.some(
    ({ dynamicDnrRuleCount, sessionDnrRuleCount }) => dynamicDnrRuleCount > 0 || sessionDnrRuleCount > 0
  );
  return deepFreeze({
    freshProfile: {
      extensionEnabled: true,
      extensionId: launched.extension.id,
      extensionName: launched.extension.name,
      extensionOriginScheme: 'chrome-extension',
      extensionVersion: launched.extension.version,
      profileDataEntryCountBeforeLaunch: freshProfile.profileDataEntryCountBeforeLaunch,
      profileOwnershipMarkerMatched: freshProfile.profileOwnershipMarkerMatched,
      profileWasNew: freshProfile.profileWasNew,
      syncEnabled: false
    },
    safeDefaults: { settings: structuredClone(coveredExtension.settings) },
    noAuthorityOrMutation: {
      cleanupMutationCount: fixtureMutationCount,
      dnrObservationMode: 'endpoint_snapshots_and_bounded_polling',
      dnrBaselineNonemptyCount: numericMaximum('dnrBaselineNonemptyCount'),
      dnrPollCount: numericMaximum('dnrPollCount'),
      dnrPollErrorCount: numericMaximum('dnrPollErrorCount'),
      dnrPollIntervalMs: numericMaximum('dnrPollIntervalMs'),
      dnrPollMaximumObservedGapMs: numericMaximum('dnrPollMaximumObservedGapMs'),
      dnrPollNonemptyCount: Math.max(numericMaximum('dnrPollNonemptyCount'), Number(anyDnrEndpointNonempty)),
      dynamicDnrRuleCountAfter: afterExtension.dynamicDnrRuleCount,
      dynamicDnrRuleCountBefore: beforeExtension.dynamicDnrRuleCount,
      dynamicDnrRulesAfterSha256: afterExtension.dynamicDnrRulesSha256,
      dynamicDnrRulesBeforeSha256: beforeExtension.dynamicDnrRulesSha256,
      fixtureAfterDataEntryCount: afterFixture.dataEntryCount,
      fixtureAfterInventorySha256: afterFixture.inventorySha256,
      fixtureAfterStorageKindCount: afterFixture.storageKindCount,
      fixtureAfterValueSha256: afterFixture.valueSha256,
      fixtureBeforeDataEntryCount: beforeFixture.dataEntryCount,
      fixtureBeforeInventorySha256: beforeFixture.inventorySha256,
      fixtureBeforeStorageKindCount: beforeFixture.storageKindCount,
      fixtureBeforeValueSha256: beforeFixture.valueSha256,
      fixtureScale: seedReceipt.scale,
      fixtureSeedDataEntryCount: seedReceipt.baselineDataEntryCount,
      fixtureSeedInventorySha256: seedReceipt.baselineInventorySha256,
      fixtureSeedReceiptSha256,
      fixtureSeedStorageKindCount: seedReceipt.baselineStorageKindCount,
      fixtureSeedValueSha256: seedReceipt.baselineValueSha256,
      fixtureSeeded: seedReceipt.seeded,
      fixtureVersion: seedReceipt.fixtureVersion,
      finalLocalAuthorityEntryCount: numericMaximum('finalLocalAuthorityEntryCount'),
      finalSessionAuthorityEntryCount: numericMaximum('finalSessionAuthorityEntryCount'),
      hostPermissionOrigins: [],
      initialLocalAuthorityEntryCount: numericMaximum('initialLocalAuthorityEntryCount'),
      initialSessionAuthorityEntryCount: numericMaximum('initialSessionAuthorityEntryCount'),
      localAuthorityChangedKeyCount: numericMaximum('localAuthorityChangedKeyCount'),
      monitorBaselineAcknowledgedCount: afterExtension.monitorBaselineAcknowledgedCount,
      monitorBaselineErrorCount: numericMaximum('monitorBaselineErrorCount'),
      monitorCoverageObservedAt: afterExtension.monitorCoverageObservedAt,
      monitorCoverageSequence: afterExtension.monitorCoverageSequence,
      monitorDocumentReadyCount: afterExtension.monitorDocumentReadyCount,
      monitorObservationReadyAt: beforeExtension.monitorReadyAt,
      nativeObservationCoverageThrough: observationCoverageThrough,
      nativeObservationObservedAt: nativePromptEvidence.observedAt,
      nativeObservationReadyAt: nativePromptEvidence.readyAt,
      nativePermissionPromptObserved: false,
      observationReadinessBounded: true,
      permissionAddedEventCount: numericMaximum('permissionAddedEventCount'),
      permissionLeaseCount: numericMaximum('permissionLeaseCount'),
      permissionRemovedEventCount: numericMaximum('permissionRemovedEventCount'),
      reportCount: numericMaximum('reportCount'),
      runningJobCount: numericMaximum('runningJobCount'),
      sessionAuthorityChangedKeyCount: numericMaximum('sessionAuthorityChangedKeyCount'),
      sessionDnrRuleCountAfter: afterExtension.sessionDnrRuleCount,
      sessionDnrRuleCountBefore: beforeExtension.sessionDnrRuleCount,
      sessionDnrRulesAfterSha256: afterExtension.sessionDnrRulesSha256,
      sessionDnrRulesBeforeSha256: beforeExtension.sessionDnrRulesSha256,
      startupEndpointPreconditionPassed: true,
      startupSourceRouteContractMatched: startupSourceContract.matched,
      startupSourceRouteContractSha256: startupSourceContract.contractSha256,
      downloadCreatedEventCount: numericMaximum('downloadCreatedEventCount'),
      downloadErasedEventCount: numericMaximum('downloadErasedEventCount')
    }
  });
}

function assertSyntheticFixtureSeedReceipt(receipt) {
  assertExactKeys(
    receipt,
    [
      'baselineDataEntryCount',
      'baselineInventorySha256',
      'baselineStorageKindCount',
      'baselineValueSha256',
      'fixtureVersion',
      'scale',
      'schema',
      'seeded',
      'snapshotSha256'
    ],
    'Synthetic fixture seed receipt'
  );
  if (
    receipt.schema !== 'sitewipe.synthetic-fixture-seed-receipt.v2' ||
    receipt.fixtureVersion !== FIXTURE_VERSION ||
    receipt.scale !== FIXTURE_SCALE ||
    receipt.seeded !== true ||
    !Number.isInteger(receipt.baselineDataEntryCount) ||
    receipt.baselineDataEntryCount < 0 ||
    !Number.isInteger(receipt.baselineStorageKindCount) ||
    receipt.baselineStorageKindCount < 0 ||
    !SHA256_PATTERN.test(String(receipt.baselineInventorySha256 || '')) ||
    !SHA256_PATTERN.test(String(receipt.baselineValueSha256 || '')) ||
    !SHA256_PATTERN.test(String(receipt.snapshotSha256 || ''))
  ) {
    throw new Error('Synthetic fixture seed receipt does not prove the exact bounded seed operation.');
  }
}

function assertSeedReceiptMatchesBaseline(receipt, baseline) {
  assertSyntheticFixtureStateObservation(baseline);
  if (
    receipt.baselineDataEntryCount !== baseline.dataEntryCount ||
    receipt.baselineStorageKindCount !== baseline.storageKindCount ||
    receipt.baselineInventorySha256 !== baseline.inventorySha256 ||
    receipt.baselineValueSha256 !== baseline.valueSha256
  ) {
    throw new Error('Synthetic fixture seed receipt does not bind the exact deep pre-action baseline.');
  }
}

function assertSyntheticFixtureStateObservation(state) {
  assertExactKeys(
    state,
    ['dataEntryCount', 'inventorySha256', 'storageKindCount', 'valueSha256'],
    'Synthetic fixture state observation'
  );
  if (
    !Number.isInteger(state.dataEntryCount) ||
    state.dataEntryCount < 0 ||
    !Number.isInteger(state.storageKindCount) ||
    state.storageKindCount < 0 ||
    !SHA256_PATTERN.test(state.inventorySha256) ||
    !SHA256_PATTERN.test(state.valueSha256)
  ) {
    throw new Error('Synthetic fixture state observation is malformed.');
  }
}

function assertObservedPopupAndOptionsSurfaces(surfaces) {
  const expected = [
    ['popup', 'SiteWipe'],
    ['options', 'SiteWipe Options']
  ];
  if (!Array.isArray(surfaces) || surfaces.length !== expected.length) {
    throw new Error('SMOKE must authentically observe exactly the popup and options surfaces.');
  }
  for (const [index, surface] of surfaces.entries()) {
    assertExactKeys(
      surface,
      ['documentTitle', 'name', 'originScheme', 'readyState', 'visible'],
      'Authentic popup/options surface observation'
    );
    if (
      surface.name !== expected[index][0] ||
      surface.documentTitle !== expected[index][1] ||
      surface.originScheme !== 'chrome-extension' ||
      surface.readyState !== 'complete' ||
      surface.visible !== true
    ) {
      throw new Error('SMOKE popup/options surface observation differs from its exact installed document.');
    }
  }
}

function assertSafeFreshProfilePrecondition(value) {
  assertExactKeys(
    value,
    ['profileDataEntryCountBeforeLaunch', 'profileOwnershipMarkerMatched', 'profileWasNew'],
    'Fresh-profile prelaunch observation'
  );
  if (
    value.profileWasNew !== true ||
    value.profileOwnershipMarkerMatched !== true ||
    value.profileDataEntryCountBeforeLaunch !== 0
  ) {
    throw new Error('SMOKE browser launch requires a fresh profile containing only its exact ownership marker.');
  }
}

function assertExactLaunchedController(launched, context) {
  if (
    !launched ||
    typeof launched !== 'object' ||
    !launched.browser ||
    typeof launched.browser.newPage !== 'function' ||
    typeof launched.browser.targets !== 'function' ||
    typeof launched.browser.waitForTarget !== 'function' ||
    typeof launched.triggerAction !== 'function' ||
    !launched.extension ||
    !EXTENSION_ID_PATTERN.test(String(launched.extension.id || '')) ||
    launched.extension.name !== 'SiteWipe' ||
    launched.extension.version !== context.plan.identity.artifactVersion ||
    launched.extension.enabled !== true
  ) {
    throw new Error('SMOKE launch did not return the exact enabled SiteWipe controller.');
  }
  const receipt = launched.receipt;
  if (
    receipt?.runId !== context.plan.runId ||
    receipt?.planSha256 !== context.plan.planSha256 ||
    receipt?.browserName !== context.browser.name ||
    receipt?.extensionId !== launched.extension.id ||
    receipt?.extensionName !== launched.extension.name ||
    receipt?.extensionVersion !== launched.extension.version ||
    receipt?.launchPolicy?.headless !== false ||
    receipt?.launchPolicy?.pipe !== true ||
    receipt?.launchPolicy?.existingProfile !== false ||
    receipt?.launchPolicy?.incognitoExtensionAccess !== false ||
    !receipt?.launchPolicy?.argumentTemplates?.includes('--disable-sync')
  ) {
    throw new Error('SMOKE launch receipt differs from the exact disposable no-sync policy.');
  }
}

function assertLoadedRuntimeManifest(runtime) {
  if (
    runtime?.manifest?.manifestVersion !== 3 ||
    runtime?.manifest?.name !== 'SiteWipe' ||
    runtime?.manifest?.serviceWorker !== 'background/service-worker.js' ||
    runtime?.manifest?.defaultPopup !== 'popup/popup.html' ||
    runtime?.manifest?.optionsPage !== 'options/options.html'
  ) {
    throw new Error('SMOKE staged runtime is not the exact SiteWipe MV3 surface manifest.');
  }
}

function assertAuthenticActionReceipt(popup, { extensionId, fixtureOrigin, popupUrl }) {
  if (!popup?.page || typeof popup.page.url !== 'function') {
    throw new Error('Authentic SMOKE action did not return a popup page.');
  }
  const receipt = popup.receipt;
  if (
    receipt?.schema !== 'sitewipe.authentic-extension-action.v1' ||
    receipt.extensionId !== extensionId ||
    receipt.targetOrigin !== fixtureOrigin ||
    receipt.popupUrl !== popupUrl ||
    receipt.targetTypeBeforeAsPage !== 'other' ||
    receipt.invocation !== 'puppeteer-extension-triggerAction' ||
    receipt.scriptOrDomInjectionUsed !== false
  ) {
    throw new Error('SMOKE popup was not opened by one exact authentic extension action.');
  }
  assertExactPageUrl(popup.page, popupUrl, 'Authentic SiteWipe popup');
}

async function inspectSmokeStartupSourceContract(runtime) {
  if (!runtime || typeof runtime.extensionRoot !== 'string' || !Array.isArray(runtime.files)) {
    throw new Error('SMOKE startup source-route review lacks the exact staged runtime identity.');
  }
  const root = resolve(runtime.extensionRoot);
  const rootInfo = await lstat(root, { bigint: true });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !samePath(root, await realpath(root))) {
    throw new Error('SMOKE startup source-route review crossed a runtime alias.');
  }
  for (const expected of SMOKE_STARTUP_SOURCE_ROUTE_CONTRACT.files) {
    const receipt = runtime.files.find((entry) => entry?.path === expected.path);
    const path = resolve(root, ...expected.path.split('/'));
    assertDescendant(root, path, 'SMOKE startup source-route file');
    const observed = await readStableRegularFile(path, 'SMOKE startup source-route file');
    if (receipt?.sha256 !== expected.sha256 || observed.sha256 !== expected.sha256) {
      throw new Error('SMOKE startup source route differs from the exact reviewed no-DNR-add contract.');
    }
  }
  return deepFreeze({
    contractSha256: sha256(canonicalJsonBytes(SMOKE_STARTUP_SOURCE_ROUTE_CONTRACT)),
    matched: true,
    schema: SMOKE_STARTUP_SOURCE_ROUTE_CONTRACT.schema,
    startupMayAddDnrRules: false
  });
}

function assertSmokeStartupSourceContract(value, runtime) {
  assertExactKeys(
    value,
    ['contractSha256', 'matched', 'schema', 'startupMayAddDnrRules'],
    'SMOKE startup source-route contract'
  );
  if (
    value.schema !== SMOKE_STARTUP_SOURCE_ROUTE_CONTRACT.schema ||
    value.contractSha256 !== sha256(canonicalJsonBytes(SMOKE_STARTUP_SOURCE_ROUTE_CONTRACT)) ||
    value.matched !== true ||
    value.startupMayAddDnrRules !== false ||
    runtime.manifest?.serviceWorker !== 'background/service-worker.js'
  ) {
    throw new Error('SMOKE startup source route is not the exact reviewed fail-closed contract.');
  }
}

async function preloadInstalledSafetyMonitor(page) {
  if (
    !page ||
    typeof page.exposeFunction !== 'function' ||
    typeof page.evaluateOnNewDocument !== 'function' ||
    typeof page.evaluate !== 'function'
  ) {
    throw new Error('Installed Options page cannot preload the SMOKE safety monitor.');
  }
  const state = {
    baselineAcknowledgedCount: 0,
    baselineErrorCount: 0,
    coverageObservedAt: null,
    coverageSequence: 0,
    documentIds: new Set(),
    documentReadyCount: 0,
    downloadCreatedEventCount: 0,
    downloadErasedEventCount: 0,
    dnrPollCount: 0,
    dnrPollErrorCount: 0,
    dnrPollMaximumObservedGapMs: 0,
    dnrPollNonemptyCount: 0,
    dnrBaselineNonemptyCount: 0,
    failure: null,
    firstBaselineAt: null,
    initialLocalAuthorityEntryCount: 0,
    initialSessionAuthorityEntryCount: 0,
    lastDnrPollAt: null,
    localAuthorityChangedKeyCount: 0,
    permissionAddedEventCount: 0,
    permissionRemovedEventCount: 0,
    sessionAuthorityChangedKeyCount: 0
  };
  const report = (message) => {
    try {
      acceptSmokeMonitorReport(state, message);
    } catch (error) {
      state.failure ??= error;
      throw error;
    }
  };
  await page.exposeFunction(SMOKE_MONITOR_BINDING, report);
  const registration = await page.evaluateOnNewDocument(
    ({ bindingName, dnrPollIntervalMs, globalName, localKeys, operation, reportSchema, sessionKeys }) => {
      if (operation !== 'sitewipe-smoke-preload-safety-monitor') {
        throw new Error('Unexpected SMOKE safety-monitor preload operation.');
      }
      if (globalThis[globalName]) {
        throw new Error('SMOKE safety monitor was installed more than once.');
      }
      if (
        typeof globalThis[bindingName] !== 'function' ||
        !chrome?.storage?.local?.get ||
        !chrome?.storage?.session?.get ||
        !chrome?.storage?.onChanged?.addListener ||
        !chrome?.declarativeNetRequest?.getDynamicRules ||
        !chrome?.declarativeNetRequest?.getSessionRules ||
        !chrome?.permissions?.onAdded?.addListener ||
        !chrome?.permissions?.onRemoved?.addListener ||
        !chrome?.downloads?.onCreated?.addListener ||
        !chrome?.downloads?.onErased?.addListener
      ) {
        throw new Error('Installed extension APIs cannot support the exact SMOKE safety monitor.');
      }
      const binding = globalThis[bindingName];
      const documentId = crypto.randomUUID();
      const local = new Set(localKeys);
      const session = new Set(sessionKeys);
      const observedAt = () => new Date().toISOString();
      let reporting = Promise.resolve();
      let pollInFlight = null;
      const enqueue = (message) => {
        reporting = reporting.then(() => binding(message));
        return reporting;
      };
      const exactPresentCount = (record, keys) =>
        keys.filter((key) => Object.prototype.hasOwnProperty.call(record, key)).length;
      chrome.storage.onChanged.addListener((changes, areaName) => {
        const selected = areaName === 'local' ? local : areaName === 'session' ? session : null;
        const changedKeys = selected
          ? Object.keys(changes)
              .filter((key) => selected.has(key))
              .sort()
          : [];
        if (changedKeys.length > 0) {
          void enqueue({
            areaName,
            changedKeys,
            documentId,
            observedAt: observedAt(),
            schema: reportSchema,
            type: 'authority-storage-change'
          });
        }
      });
      chrome.permissions.onAdded.addListener(() => {
        void enqueue({ documentId, observedAt: observedAt(), schema: reportSchema, type: 'permission-added' });
      });
      chrome.permissions.onRemoved.addListener(() => {
        void enqueue({ documentId, observedAt: observedAt(), schema: reportSchema, type: 'permission-removed' });
      });
      chrome.downloads.onCreated.addListener(() => {
        void enqueue({ documentId, observedAt: observedAt(), schema: reportSchema, type: 'download-created' });
      });
      chrome.downloads.onErased.addListener(() => {
        void enqueue({ documentId, observedAt: observedAt(), schema: reportSchema, type: 'download-erased' });
      });

      const pollDnr = () => {
        if (pollInFlight) return pollInFlight;
        pollInFlight = (async () => {
          try {
            const [dynamicRules, sessionRules] = await Promise.all([
              chrome.declarativeNetRequest.getDynamicRules(),
              chrome.declarativeNetRequest.getSessionRules()
            ]);
            await enqueue({
              documentId,
              dynamicRuleCount: Array.isArray(dynamicRules) ? dynamicRules.length : -1,
              observedAt: observedAt(),
              schema: reportSchema,
              sessionRuleCount: Array.isArray(sessionRules) ? sessionRules.length : -1,
              type: 'dnr-poll'
            });
          } catch {
            await enqueue({
              documentId,
              observedAt: observedAt(),
              schema: reportSchema,
              type: 'dnr-poll-error'
            });
          } finally {
            pollInFlight = null;
          }
        })();
        return pollInFlight;
      };

      const ready = enqueue({
        documentId,
        localKeys: [...localKeys],
        observedAt: observedAt(),
        schema: reportSchema,
        sessionKeys: [...sessionKeys],
        type: 'document-ready'
      });
      const baselineReads = Promise.all([
        chrome.storage.local.get(localKeys),
        chrome.storage.session.get(sessionKeys),
        chrome.declarativeNetRequest.getDynamicRules(),
        chrome.declarativeNetRequest.getSessionRules()
      ]);
      const baseline = baselineReads.then(
        async (observed) => {
          await ready;
          const [localState, sessionState, dynamicRules, sessionRules] = observed;
          await enqueue({
            documentId,
            dynamicRuleCount: Array.isArray(dynamicRules) ? dynamicRules.length : -1,
            initialLocalAuthorityEntryCount: exactPresentCount(localState, localKeys),
            initialSessionAuthorityEntryCount: exactPresentCount(sessionState, sessionKeys),
            observedAt: observedAt(),
            schema: reportSchema,
            sessionRuleCount: Array.isArray(sessionRules) ? sessionRules.length : -1,
            type: 'baseline'
          });
        },
        async () => {
          await ready;
          await enqueue({ documentId, observedAt: observedAt(), schema: reportSchema, type: 'baseline-error' });
          throw new Error('SMOKE safety-monitor baseline could not be established.');
        }
      );
      const snapshotBarrier = async () => {
        await baseline;
        await pollDnr();
        await reporting;
        await enqueue({ documentId, observedAt: observedAt(), schema: reportSchema, type: 'barrier' });
      };
      Object.defineProperty(globalThis, globalName, {
        configurable: false,
        enumerable: false,
        writable: false,
        value: Object.freeze({ snapshotBarrier })
      });
      void baseline.catch(() => {});
      void pollDnr().catch(() => {});
      setInterval(() => void pollDnr().catch(() => {}), dnrPollIntervalMs);
    },
    {
      bindingName: SMOKE_MONITOR_BINDING,
      dnrPollIntervalMs: SMOKE_DNR_POLL_INTERVAL_MS,
      globalName: SMOKE_MONITOR_GLOBAL,
      operation: 'sitewipe-smoke-preload-safety-monitor',
      localKeys: LOCAL_CLEANUP_AUTHORITY_KEYS,
      reportSchema: SMOKE_MONITOR_REPORT_SCHEMA,
      sessionKeys: SESSION_CLEANUP_AUTHORITY_KEYS
    }
  );
  if (!registration || typeof registration.identifier !== 'string' || !registration.identifier) {
    throw new Error('Installed Options page did not return an exact preload registration.');
  }
  const snapshotBarrier = async () => {
    await page.evaluate(async (globalName) => {
      const capability = globalThis[globalName];
      if (!capability || typeof capability.snapshotBarrier !== 'function') {
        throw new Error('The active Options document lacks the preloaded SMOKE monitor capability.');
      }
      await capability.snapshotBarrier();
    }, SMOKE_MONITOR_GLOBAL);
    await waitForSmokeMonitorReady(state);
    return snapshotSmokeMonitorState(state);
  };
  return Object.freeze({
    installedBeforeNavigation: true,
    schema: SMOKE_MONITOR_PRELOAD_SCHEMA,
    snapshotBarrier
  });
}

async function waitForSmokeMonitorReady(state) {
  const deadline = Date.now() + SMOKE_MONITOR_READY_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    if (state.failure) throw state.failure;
    if (state.baselineAcknowledgedCount >= 1 && state.documentReadyCount >= 1 && state.dnrPollCount >= 1) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error('The Node-retained SMOKE monitor did not acknowledge its initial baseline.');
}

function acceptSmokeMonitorReport(state, message) {
  if (
    !message ||
    typeof message !== 'object' ||
    Array.isArray(message) ||
    message.schema !== SMOKE_MONITOR_REPORT_SCHEMA ||
    typeof message.documentId !== 'string' ||
    !/^[0-9a-f-]{36}$/iu.test(message.documentId) ||
    !isIsoTimestamp(message.observedAt)
  ) {
    throw new Error('The Node-retained SMOKE monitor received a malformed report.');
  }
  const knownDocument = state.documentIds.has(message.documentId);
  if (message.type === 'document-ready') {
    assertExactKeys(
      message,
      ['documentId', 'localKeys', 'observedAt', 'schema', 'sessionKeys', 'type'],
      'SMOKE monitor document-ready report'
    );
    if (
      knownDocument ||
      stableJson(message.localKeys) !== stableJson(LOCAL_CLEANUP_AUTHORITY_KEYS) ||
      stableJson(message.sessionKeys) !== stableJson(SESSION_CLEANUP_AUTHORITY_KEYS)
    ) {
      throw new Error('The SMOKE monitor document-ready report has incomplete or duplicate coverage.');
    }
    state.documentIds.add(message.documentId);
    state.documentReadyCount += 1;
    advanceSmokeMonitorCoverage(state, message.observedAt);
    return;
  }
  if (!knownDocument) throw new Error('The SMOKE monitor reported an event before document readiness.');

  if (message.type === 'baseline') {
    assertExactKeys(
      message,
      [
        'documentId',
        'dynamicRuleCount',
        'initialLocalAuthorityEntryCount',
        'initialSessionAuthorityEntryCount',
        'observedAt',
        'schema',
        'sessionRuleCount',
        'type'
      ],
      'SMOKE monitor baseline report'
    );
    for (const key of [
      'dynamicRuleCount',
      'initialLocalAuthorityEntryCount',
      'initialSessionAuthorityEntryCount',
      'sessionRuleCount'
    ]) {
      if (!Number.isInteger(message[key]) || message[key] < 0) {
        throw new Error('The SMOKE monitor baseline report contains a malformed count.');
      }
    }
    state.baselineAcknowledgedCount += 1;
    state.firstBaselineAt ??= message.observedAt;
    state.initialLocalAuthorityEntryCount = Math.max(
      state.initialLocalAuthorityEntryCount,
      message.initialLocalAuthorityEntryCount
    );
    state.initialSessionAuthorityEntryCount = Math.max(
      state.initialSessionAuthorityEntryCount,
      message.initialSessionAuthorityEntryCount
    );
    if (message.dynamicRuleCount > 0 || message.sessionRuleCount > 0) state.dnrBaselineNonemptyCount += 1;
    advanceSmokeMonitorCoverage(state, message.observedAt);
    return;
  }
  if (message.type === 'baseline-error') {
    assertExactKeys(message, ['documentId', 'observedAt', 'schema', 'type'], 'SMOKE monitor baseline-error report');
    state.baselineErrorCount += 1;
    advanceSmokeMonitorCoverage(state, message.observedAt);
    return;
  }
  if (message.type === 'authority-storage-change') {
    assertExactKeys(
      message,
      ['areaName', 'changedKeys', 'documentId', 'observedAt', 'schema', 'type'],
      'SMOKE monitor storage-change report'
    );
    const selected = message.areaName === 'local' ? LOCAL_CLEANUP_AUTHORITY_KEYS : SESSION_CLEANUP_AUTHORITY_KEYS;
    if (
      !['local', 'session'].includes(message.areaName) ||
      !Array.isArray(message.changedKeys) ||
      message.changedKeys.length === 0 ||
      new Set(message.changedKeys).size !== message.changedKeys.length ||
      message.changedKeys.some((key) => !selected.includes(key))
    ) {
      throw new Error('The SMOKE monitor storage-change report exceeded the selected authority keys.');
    }
    const counter = message.areaName === 'local' ? 'localAuthorityChangedKeyCount' : 'sessionAuthorityChangedKeyCount';
    state[counter] += message.changedKeys.length;
    advanceSmokeMonitorCoverage(state, message.observedAt);
    return;
  }
  if (message.type === 'dnr-poll' || message.type === 'dnr-poll-error') {
    assertExactKeys(
      message,
      message.type === 'dnr-poll'
        ? ['documentId', 'dynamicRuleCount', 'observedAt', 'schema', 'sessionRuleCount', 'type']
        : ['documentId', 'observedAt', 'schema', 'type'],
      'SMOKE monitor DNR report'
    );
    const observedMs = Date.parse(message.observedAt);
    if (state.lastDnrPollAt !== null) {
      const gap = observedMs - Date.parse(state.lastDnrPollAt);
      if (!Number.isFinite(gap) || gap < 0) throw new Error('SMOKE DNR poll timestamps are decreasing.');
      state.dnrPollMaximumObservedGapMs = Math.max(state.dnrPollMaximumObservedGapMs, gap);
    }
    state.lastDnrPollAt = message.observedAt;
    state.dnrPollCount += 1;
    if (message.type === 'dnr-poll-error') {
      state.dnrPollErrorCount += 1;
    } else {
      if (
        !Number.isInteger(message.dynamicRuleCount) ||
        message.dynamicRuleCount < 0 ||
        !Number.isInteger(message.sessionRuleCount) ||
        message.sessionRuleCount < 0
      ) {
        throw new Error('SMOKE DNR poll counts are malformed.');
      }
      if (message.dynamicRuleCount > 0 || message.sessionRuleCount > 0) state.dnrPollNonemptyCount += 1;
    }
    advanceSmokeMonitorCoverage(state, message.observedAt);
    return;
  }
  if (message.type === 'barrier') {
    assertExactKeys(message, ['documentId', 'observedAt', 'schema', 'type'], 'SMOKE monitor barrier report');
    advanceSmokeMonitorCoverage(state, message.observedAt);
    return;
  }
  const counter = {
    'download-created': 'downloadCreatedEventCount',
    'download-erased': 'downloadErasedEventCount',
    'permission-added': 'permissionAddedEventCount',
    'permission-removed': 'permissionRemovedEventCount'
  }[message.type];
  if (!counter) throw new Error('The SMOKE monitor emitted an unknown report type.');
  assertExactKeys(message, ['documentId', 'observedAt', 'schema', 'type'], 'SMOKE monitor event report');
  state[counter] += 1;
  advanceSmokeMonitorCoverage(state, message.observedAt);
}

function advanceSmokeMonitorCoverage(state, observedAt) {
  state.coverageSequence += 1;
  if (state.coverageObservedAt === null || Date.parse(observedAt) > Date.parse(state.coverageObservedAt)) {
    state.coverageObservedAt = observedAt;
  }
}

function snapshotSmokeMonitorState(state) {
  if (state.failure) throw state.failure;
  if (
    state.baselineErrorCount !== 0 ||
    state.baselineAcknowledgedCount < 1 ||
    !isIsoTimestamp(state.firstBaselineAt) ||
    !isIsoTimestamp(state.coverageObservedAt)
  ) {
    throw new Error('The Node-retained SMOKE monitor has no exact acknowledged baseline.');
  }
  return deepFreeze({
    baselineAcknowledgedCount: state.baselineAcknowledgedCount,
    baselineErrorCount: state.baselineErrorCount,
    coverageObservedAt: state.coverageObservedAt,
    coverageSequence: state.coverageSequence,
    documentReadyCount: state.documentReadyCount,
    downloadCreatedEventCount: state.downloadCreatedEventCount,
    downloadErasedEventCount: state.downloadErasedEventCount,
    dnrBaselineNonemptyCount: state.dnrBaselineNonemptyCount,
    dnrPollCount: state.dnrPollCount,
    dnrPollErrorCount: state.dnrPollErrorCount,
    dnrPollIntervalMs: SMOKE_DNR_POLL_INTERVAL_MS,
    dnrPollMaximumObservedGapMs: state.dnrPollMaximumObservedGapMs,
    dnrPollNonemptyCount: state.dnrPollNonemptyCount,
    firstBaselineAt: state.firstBaselineAt,
    initialLocalAuthorityEntryCount: state.initialLocalAuthorityEntryCount,
    initialSessionAuthorityEntryCount: state.initialSessionAuthorityEntryCount,
    localAuthorityChangedKeyCount: state.localAuthorityChangedKeyCount,
    permissionAddedEventCount: state.permissionAddedEventCount,
    permissionRemovedEventCount: state.permissionRemovedEventCount,
    sessionAuthorityChangedKeyCount: state.sessionAuthorityChangedKeyCount
  });
}

async function navigateExactExtensionPage(page, expectedUrl) {
  const response = await page.goto(expectedUrl, { waitUntil: 'load', timeout: SURFACE_TIMEOUT_MS });
  if (response && typeof response.status === 'function' && response.status() >= 400) {
    throw new Error('Installed extension surface navigation returned an error response.');
  }
  assertExactPageUrl(page, expectedUrl, 'Installed extension page');
}

function exactFixtureUrl(context) {
  const ipv4 = context.fixtures?.ipv4;
  const ipv6 = context.fixtures?.ipv6;
  if (
    ipv4?.host !== '127.0.0.1' ||
    ipv6?.host !== '::1' ||
    !Number.isInteger(ipv4.port) ||
    ipv4.port < 1 ||
    ipv4.port > 65535 ||
    ipv6.port !== ipv4.port ||
    !/^[a-f0-9]{64}$/u.test(String(ipv4.runToken || '')) ||
    ipv6.runToken !== ipv4.runToken ||
    ipv4.runTokenSha256 !== sha256(ipv4.runToken) ||
    ipv6.runTokenSha256 !== ipv4.runTokenSha256
  ) {
    throw new Error('SMOKE fixture does not expose the exact approved dual-stack seeded endpoint and token.');
  }
  const requested = new URL(`http://${FIXTURE_HOST}:${ipv4.port}/`);
  requested.searchParams.set('scale', FIXTURE_SCALE);
  requested.searchParams.set('runToken', ipv4.runToken);
  const url = assertSyntheticFixturePageUrl(requested.href, context.plan.inputs.fixture.allowedHosts);
  if (
    url.hostname !== FIXTURE_HOST ||
    url.port !== String(ipv4.port) ||
    url.pathname !== '/' ||
    url.searchParams.size !== 2 ||
    url.searchParams.get('scale') !== FIXTURE_SCALE ||
    url.searchParams.get('runToken') !== ipv4.runToken
  ) {
    throw new Error('SMOKE fixture URL differs from the exact bounded synthetic seed root.');
  }
  return url;
}

function semanticBinding(context, { startedAt, completedAt }) {
  return semanticBindingFromScenarioResult({
    scenarioId: context.scenario.id,
    browser: context.browser,
    runId: context.plan.runId,
    planSha256: context.plan.planSha256,
    identity: context.plan.identity,
    startedAt,
    completedAt
  });
}

function validateHookContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) {
    throw new TypeError('Authentic scenario executor requires one installed-runner hook context.');
  }
  for (const key of ['captureTimestamp']) {
    if (typeof context[key] !== 'function') throw new Error(`Authentic scenario hook lacks ${key}.`);
  }
  if (
    !context.scenario?.id ||
    !context.browser?.name ||
    !context.plan?.identity ||
    !context.cell ||
    !context.runtime ||
    !context.launched ||
    typeof context.launched !== 'object'
  ) {
    throw new Error(
      'Authentic scenario hook lacks its exact scenario, browser, plan, cell, runtime, or launched-browser binding.'
    );
  }
  if ('close' in context.launched || 'launchBrowser' in context || 'closeBrowser' in context) {
    throw new Error('Authentic scenario hooks cannot own browser launch or teardown capabilities.');
  }
}

function captureExactGitCounts(repositoryRoot, expectedCommit) {
  const commit = runTrustedGit({
    root: repositoryRoot,
    args: ['rev-parse', '--verify', 'HEAD^{commit}'],
    encoding: 'utf8'
  })
    .trim()
    .toLowerCase();
  const treeSha = runTrustedGit({
    root: repositoryRoot,
    args: ['rev-parse', '--verify', `${commit}^{tree}`],
    encoding: 'utf8'
  })
    .trim()
    .toLowerCase();
  if (commit !== expectedCommit || !GIT_OBJECT_PATTERN.test(commit) || !GIT_OBJECT_PATTERN.test(treeSha)) {
    throw new Error('ART Git head/tree identity changed during exact status counting.');
  }
  return {
    indexDeltaCount: nulRecordCount(
      runTrustedGit({ root: repositoryRoot, args: ['diff', '--name-only', '--cached', '-z', 'HEAD', '--'] })
    ),
    untrackedEntryCount: nulRecordCount(
      runTrustedGit({ root: repositoryRoot, args: ['ls-files', '--others', '--exclude-standard', '-z', '--'] })
    ),
    worktreeDeltaCount: nulRecordCount(
      runTrustedGit({ root: repositoryRoot, args: ['diff', '--name-only', '-z', 'HEAD', '--'] })
    )
  };
}

function assertExactSourceIdentity(source, plan) {
  if (
    source.commitSha !== plan.identity.sourceCommitSha ||
    source.treeSha !== plan.identity.sourceTreeSha ||
    source.packageVersion !== plan.identity.artifactVersion ||
    source.packageLockSha256 !== plan.identity.packageLockSha256 ||
    source.runtimeFingerprintSha256 !== plan.identity.runtimeFingerprintSha256 ||
    source.releaseInputFingerprintSha256 !== plan.identity.releaseInputFingerprintSha256 ||
    source.harnessManifestSha256 !== plan.identity.harnessManifestSha256
  ) {
    throw new Error('ART clean committed source identity differs from the exact approved plan.');
  }
}

function assertExactRuntimePathSet(entries) {
  const paths = entries.map((entry) => entry.path);
  if (
    entries.length !== RUNTIME_FILES.length ||
    new Set(paths).size !== paths.length ||
    JSON.stringify(paths) !== JSON.stringify(RUNTIME_FILES)
  ) {
    throw new Error('ART runtime artifact path set differs from the exact committed allowlist.');
  }
}

async function readExactStagedRuntime(runtime) {
  if (!runtime || typeof runtime.extensionRoot !== 'string' || !isAbsolute(runtime.extensionRoot)) {
    throw new Error('ART staged runtime lacks one absolute extension root.');
  }
  const root = resolve(runtime.extensionRoot);
  const rootInfo = await lstat(root, { bigint: true });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !samePath(root, await realpath(root))) {
    throw new Error('ART staged runtime root is not one exact physical directory.');
  }
  const files = await collectPhysicalFiles(root, root);
  if (JSON.stringify(files.map((entry) => entry.path)) !== JSON.stringify(RUNTIME_FILES)) {
    throw new Error('ART staged runtime physical path set differs from the exact runtime manifest.');
  }
  const receiptFiles = runtime.files;
  if (!Array.isArray(receiptFiles) || receiptFiles.length !== files.length) {
    throw new Error('ART staged runtime receipt has an invalid file inventory.');
  }
  for (const [index, file] of files.entries()) {
    const receipt = receiptFiles[index];
    if (receipt?.path !== file.path || receipt?.bytes !== file.bytes.length || receipt?.sha256 !== file.sha256) {
      throw new Error(`ART staged runtime receipt differs from physical bytes: ${file.path}.`);
    }
  }
  return files;
}

async function collectPhysicalFiles(root, directory) {
  const files = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(directory, entry.name);
    assertDescendant(root, path, 'ART staged runtime entry');
    const info = await lstat(path, { bigint: true });
    if (info.isSymbolicLink()) throw new Error('ART staged runtime contains a symbolic link or reparse point.');
    if (entry.isDirectory()) {
      if (!samePath(path, await realpath(path))) throw new Error('ART staged runtime directory crosses an alias.');
      files.push(...(await collectPhysicalFiles(root, path)));
    } else if (entry.isFile()) {
      const identity = await readStableRegularFile(path, 'ART staged runtime file');
      files.push({
        path: relative(root, path).split(sep).join('/'),
        bytes: identity.bytes,
        sha256: identity.sha256
      });
    } else {
      throw new Error('ART staged runtime contains a non-regular filesystem entry.');
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function assertRuntimeReceipt(runtime, { artifactEntries, artifactIdentity, manifest }) {
  const receiptFiles = artifactEntries.map((entry) => ({
    path: entry.path,
    bytes: entry.bytes.length,
    sha256: sha256(entry.bytes)
  }));
  if (
    runtime.artifactVersion !== manifest.version ||
    runtime.artifactBytes !== artifactIdentity.bytes.length ||
    runtime.artifactSha256 !== artifactIdentity.sha256 ||
    runtime.fileCount !== artifactEntries.length ||
    runtime.contentSetSha256 !== sha256(canonicalJsonBytes(receiptFiles)) ||
    stableJson(runtime.files) !== stableJson(receiptFiles)
  ) {
    throw new Error('ART staged runtime receipt differs from the independently re-read artifact bytes.');
  }
}

function parseManifest(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new Error('ART runtime artifact lacks manifest.json.');
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error('ART runtime manifest is not exact UTF-8 JSON.', { cause: error });
  }
  if (
    manifest?.manifest_version !== 3 ||
    manifest?.name !== 'SiteWipe' ||
    !/^\d+\.\d+\.\d+$/u.test(String(manifest.version || '')) ||
    manifest?.background?.service_worker !== 'background/service-worker.js' ||
    manifest?.background?.type !== 'module' ||
    manifest?.action?.default_popup !== 'popup/popup.html' ||
    manifest?.options_page !== 'options/options.html' ||
    manifest?.side_panel?.default_path !== 'sidepanel/sidepanel.html'
  ) {
    throw new Error('ART runtime manifest differs from the exact SiteWipe MV3 identity.');
  }
  return manifest;
}

async function readStableRegularFile(path, label) {
  const absolute = resolve(path);
  const before = await lstat(absolute, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    !samePath(absolute, await realpath(absolute))
  ) {
    throw new Error(`${label} is not one exact physical single-link file.`);
  }
  const bytes = await readFile(absolute);
  const after = await lstat(absolute, { bigint: true });
  if (!sameFileIdentity(before, after) || BigInt(bytes.length) !== after.size) {
    throw new Error(`${label} changed while it was read.`);
  }
  return Object.freeze({ bytes, sha256: sha256(bytes) });
}

function runtimeFingerprint(entries) {
  const hash = createHash('sha256');
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  for (const path of RUNTIME_FILES) {
    const entry = byPath.get(path);
    if (!entry || !Buffer.isBuffer(entry.bytes)) throw new Error(`Runtime fingerprint lacks exact bytes for ${path}.`);
    hash.update(path, 'utf8');
    hash.update('\0', 'utf8');
    hash.update(entry.bytes);
    hash.update('\0', 'utf8');
  }
  return hash.digest('hex').toUpperCase();
}

function assertExactPageUrl(page, expectedUrl, label) {
  if (!page || typeof page.url !== 'function' || page.url() !== expectedUrl) {
    throw new Error(`${label} differs from its exact installed or synthetic origin.`);
  }
}

function nulRecordCount(value) {
  if (!Buffer.isBuffer(value)) throw new Error('Trusted Git did not return a byte buffer for exact status counting.');
  if (value.length === 0) return 0;
  if (value.at(-1) !== 0) throw new Error('Trusted Git returned a non-NUL-terminated status record.');
  return value.subarray(0, -1).toString('utf8').split('\0').length;
}

function assertDescendant(parent, child, label) {
  const relation = relative(resolve(parent), resolve(child));
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`${label} escapes or equals its exact root.`);
  }
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.birthtimeMs === right.birthtimeMs &&
    left.mtimeMs === right.mtimeMs
  );
}

function samePath(left, right) {
  const first = resolve(left);
  const second = resolve(right);
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function exactTimestamp(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error('Authentic scenario timestamp is not ISO-8601.');
  }
  return value;
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(value) && !Number.isNaN(Date.parse(value));
}

function nondecreasingTimestamp(value, minimum) {
  const timestamp = exactTimestamp(value);
  if (Date.parse(timestamp) < Date.parse(minimum)) {
    throw new Error('Authentic scenario timestamps are reversed.');
  }
  return timestamp;
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} keys differ from the exact contract.`);
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

function canonicalJsonBytes(value) {
  return Buffer.from(`${stableJson(value)}\n`, 'utf8');
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

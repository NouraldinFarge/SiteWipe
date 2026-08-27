import { createHash } from 'node:crypto';
import { lstat as nativeLstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';

import { STORAGE_KEYS } from '../../../src/shared/constants.js';
import { CLEANUP_REVIEW_STORAGE_KEY } from '../../../src/background/cleanup-preflight.js';
import { INTERNAL_SETTINGS, SETTINGS_DEFAULTS, VISIBLE_SETTINGS, canonicalScenario } from './canonical-matrix.mjs';
import { SEMANTIC_VALIDATION_STATUS } from './evidence-contract.mjs';
import { startNativePermissionPromptHelper } from './native-permission-dialog.mjs';
import { validateWindowsProfileResidueObservation } from './runtime-executor.mjs';
import {
  SEMANTIC_VALIDATOR_MANIFEST_SHA256,
  SETTINGS_SEMANTIC_CONTRACT,
  createSemanticObservationEvidence
} from './semantic-validator.mjs';

/* global document, HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement */

const SETTINGS_SCENARIO_ID = 'SETTINGS-01';
const SETTINGS_STORAGE_KEY = 'sitewipe.settings.v1';
const SETTINGS_BACKUP_SCHEMA = 'sitewipe.settings.backup';
const SETTINGS_BACKUP_MAX_BYTES = 128 * 1024;
const OPTIONS_READY_TIMEOUT_MS = 30_000;
const UI_SETTLE_TIMEOUT_MS = 20_000;
const SYNTHETIC_IMPORT_NAME = '.sitewipe-owned-settings-import.json';
const OWNED_DIRECTORY_MARKER_NAME = '.sitewipe-owned-browser-directory.json';
const DOWNLOAD_CANARY_NAME = '.sitewipe-must-preserve-download.bin';
const CLEANUP_PERMISSION_HANDOFF_STORAGE_KEY = 'sitewipe.cleanupPermissionHandoff.v1';
const DNR_PENDING_MUTATION_LOCAL_KEY = 'sitewipe.dnrPendingMutation.v1';
const DNR_PENDING_MUTATION_SESSION_KEY = 'sitewipe.dnrPendingMutation.session.v1';
const SETTINGS_NATIVE_SCHEDULE_ID = 'SETTINGS-01.observe-none';
const SETTINGS_MONITOR_BINDING = '__sitewipeSettingsMonitorReport';
const SETTINGS_MONITOR_GLOBAL = '__sitewipeSettingsSafetyMonitorV2';
const SETTINGS_DNR_POLL_INTERVAL_MS = 100;
const SETTINGS_DNR_MAX_GAP_MS = 5_000;
const SETTINGS_MONITOR_READY_TIMEOUT_MS = 10_000;
const SHA256_PATTERN = /^[A-F0-9]{64}$/u;
const EXACT_STAT_OPTIONS = Object.freeze({ bigint: true });
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
const REQUIRED_EXTENSION_PERMISSIONS = Object.freeze(
  [
    'alarms',
    'browsingData',
    'cookies',
    'declarativeNetRequest',
    'downloads',
    'history',
    'scripting',
    'sidePanel',
    'storage',
    'tabs'
  ].sort()
);
const CONTEXT_KEYS = Object.freeze([
  'browser',
  'captureTimestamp',
  'cell',
  'fixtures',
  'launched',
  'plan',
  'proxy',
  'runtime',
  'scenario',
  'signal'
]);
const SESSION_KEYS = Object.freeze(['payloads', 'safety']);
const SESSION_SAFETY_KEYS = Object.freeze([
  'afterBoundary',
  'afterCapturedAt',
  'beforeBoundary',
  'beforeCapturedAt',
  'ownedDownloadsBefore',
  'ownedDownloadsBeforeClose',
  'nativeObservation',
  'nativeReadiness'
]);
const SELECT_ASSERTION_IDS = Object.freeze([
  ...VISIBLE_SETTINGS.map((key) => `setting.${key}`),
  ...INTERNAL_SETTINGS.map((key) => `setting.${key}`),
  'settings.select_options_and_bounds',
  'settings.dependencies_and_expert_gating',
  'settings.persistence_and_reset',
  'settings.import_export',
  'settings.sensitive_confirm_cancel_and_accept',
  'settings.malformed_associated_groups'
]);
const NUMERIC_VISIBLE_SETTINGS = new Set([
  'reportRetentionDays',
  'latestReportRetentionMinutes',
  'postWipeShieldExpiresMinutes'
]);

export const SETTINGS_SCENARIO_EXECUTOR_DEPENDENCIES = Object.freeze({
  captureOwnedDownloadInventory,
  runSession: runAuthenticSettingsSession,
  startNativePromptObserver: startSettingsNativePromptObserver
});

export async function executeSettingsScenario(context) {
  return createSettingsScenarioExecutor(SETTINGS_SCENARIO_EXECUTOR_DEPENDENCIES)(context);
}

export function createSettingsScenarioExecutor(dependencies) {
  assertExactKeys(
    dependencies,
    ['captureOwnedDownloadInventory', 'runSession', 'startNativePromptObserver'],
    'Settings-scenario executor dependencies'
  );
  for (const key of ['captureOwnedDownloadInventory', 'runSession', 'startNativePromptObserver']) {
    if (typeof dependencies[key] !== 'function') {
      throw new TypeError(`Settings-scenario ${key} dependency must be a function.`);
    }
  }
  const exactDependencies = Object.freeze({ ...dependencies });
  return async function settingsScenarioExecutor(context) {
    assertExactKeys(context, CONTEXT_KEYS, 'Settings-scenario runner context');
    if (context.scenario?.id !== SETTINGS_SCENARIO_ID) {
      throw new Error('Settings-scenario executor only accepts the exact SETTINGS-01 cell.');
    }
    canonicalScenario(SETTINGS_SCENARIO_ID);
    if (typeof context.captureTimestamp !== 'function' || !(context.signal instanceof AbortSignal)) {
      throw new Error('Settings-scenario executor requires the exact runner timestamp and cancellation capabilities.');
    }
    const startedAt = context.captureTimestamp();
    const launched = context.launched;
    assertLaunchedControllerView(launched, context);
    if ('close' in launched || 'launchBrowser' in context || 'closeBrowser' in context) {
      throw new Error('SETTINGS-01 cannot own browser launch or teardown capabilities.');
    }
    let nativeObserver = null;
    let nativeObserverLifecycleConsumed = false;
    let session = null;
    let nativeObservation = null;
    let executionFailure = null;
    try {
      nativeObserver = await exactDependencies.startNativePromptObserver(launched);
      const nativeReadiness = assertSettingsNativeObserverReady(nativeObserver);
      session = await exactDependencies.runSession(
        Object.freeze({
          artifactVersion: context.plan.identity.artifactVersion,
          browser: launched.browser,
          cell: context.cell,
          extension: launched.extension,
          nativeReadiness,
          settleNativePromptObserver: async () => {
            if (nativeObserverLifecycleConsumed) {
              throw new Error('SETTINGS-01 native observer settlement capability is single use.');
            }
            nativeObserverLifecycleConsumed = true;
            return settleSettingsNativePromptObserver(nativeObserver);
          }
        })
      );
      validateSettingsSession(session);
      if (!nativeObserverLifecycleConsumed) {
        throw new Error('SETTINGS-01 authentic session did not consume the exact native observer settlement.');
      }
      nativeObservation = session.safety.nativeObservation;
    } catch (error) {
      executionFailure = error;
    }

    let observerCancellationFailure = null;
    if (nativeObserver !== null && !nativeObserverLifecycleConsumed) {
      try {
        nativeObserverLifecycleConsumed = true;
        await cancelSettingsNativePromptObserver(nativeObserver);
      } catch (error) {
        observerCancellationFailure = error;
      }
    }
    if (observerCancellationFailure !== null) throw observerCancellationFailure;
    if (executionFailure !== null) throw executionFailure;
    if (session === null || nativeObservation === null) {
      throw new Error('SETTINGS-01 cannot prepare evidence before its exact observer settles.');
    }
    return Object.freeze({
      postCloseFinalizer: async (finalizerContext) => {
        assertExactKeys(finalizerContext, ['closeReceipt', 'signal'], 'SETTINGS-01 post-close finalizer context');
        if (!(finalizerContext.signal instanceof AbortSignal)) {
          throw new Error('SETTINGS-01 post-close finalizer lacks the exact runner cancellation signal.');
        }
        const { closeReceipt } = finalizerContext;
        assertCertainCleanSettingsClose(closeReceipt, context, launched);
        const ownedDownloadsAfterClose = await exactDependencies.captureOwnedDownloadInventory(context.cell);
        const payloads = finalizeSettingsPayloads(session, {
          cell: context.cell,
          closeReceipt,
          nativeObservation,
          ownedDownloadsAfterClose
        });
        const completedAt = context.captureTimestamp();
        const binding = {
          scenarioId: SETTINGS_SCENARIO_ID,
          browser: structuredClone(context.browser),
          runId: context.plan.runId,
          planSha256: context.plan.planSha256,
          identity: structuredClone(context.plan.identity),
          startedAt,
          completedAt
        };
        const evidence = SELECT_ASSERTION_IDS.map((assertionId, sequence) =>
          createSemanticObservationEvidence({
            binding,
            assertionId,
            observationId: settingsEvidenceId(assertionId),
            payload: payloads[assertionId],
            capturedAt: completedAt,
            sequence
          })
        );
        return Object.freeze({
          browser: structuredClone(context.browser),
          completedAt,
          evidence,
          reason: null,
          startedAt
        });
      },
      result: null
    });
  };
}

export async function runAuthenticSettingsSession({
  artifactVersion,
  browser,
  cell,
  extension,
  nativeReadiness,
  settleNativePromptObserver
}) {
  if (!browser || typeof browser.newPage !== 'function') {
    throw new Error('Authentic SETTINGS-01 execution requires the exact launched Puppeteer browser.');
  }
  if (!extension || !/^[a-p]{32}$/u.test(String(extension.id || '')) || extension.version !== artifactVersion) {
    throw new Error('Authentic SETTINGS-01 execution requires the exact installed SiteWipe extension identity.');
  }
  if (!cell || typeof cell.downloadPath !== 'string') {
    throw new Error('Authentic SETTINGS-01 execution requires the owned synthetic download directory.');
  }
  if (typeof settleNativePromptObserver !== 'function') {
    throw new Error('Authentic SETTINGS-01 execution requires the exact controlled native-observer settlement.');
  }
  assertSettingsNativeReadiness(nativeReadiness);

  const ownedDownloadsBefore = await captureOwnedDownloadInventory(cell);
  assertPristineOwnedDownloadInventory(ownedDownloadsBefore, cell);
  const optionsPage = `chrome-extension://${extension.id}/options/options.html`;
  const page = await browser.newPage();
  const safetyMonitor = await installSettingsSafetyMonitor(page);
  await page.goto(optionsPage, { waitUntil: 'domcontentloaded', timeout: OPTIONS_READY_TIMEOUT_MS });
  await waitForSettingsMonitorDocumentReady(safetyMonitor, 1);
  await waitForOptionsReady(page);
  const beforeBoundary = await captureSettingsSafetyBoundary(page, safetyMonitor);
  assertSafeSettingsBoundaryPrecondition(beforeBoundary);
  const beforeCapturedAt = new Date().toISOString();
  if (Date.parse(nativeReadiness.readyAt) > Date.parse(beforeCapturedAt)) {
    throw new Error('SETTINGS-01 native observer was not ready before the first installed Options interaction.');
  }

  const initial = await captureOptionsSnapshot(page);
  assertFreshVisibleDefaults(initial.settings);
  const standardDisabledControlIds = SETTINGS_SEMANTIC_CONTRACT.expertControlIds.filter(
    (id) => initial.controls[id]?.disabled === true
  );
  const parentOffDisabledControlIds = {
    keepHistory: disabledChildren(initial, 'keepHistory'),
    pageScriptScrub: await captureParentOffDependencies(page, 'pageScriptScrub'),
    progressOverlay: await captureParentOffDependencies(page, 'progressOverlay'),
    postWipeSessionBlock: disabledChildren(initial, 'postWipeSessionBlock')
  };

  await setSelectAndWait(page, 'cleanupMode', 'expert', 'expert');
  await setCheckboxAndWait(page, 'postWipeSessionBlock', true, true);
  const exactExpertEnabledControlIds = await page.evaluate(
    ({ ids }) => ids.filter((id) => document.querySelector(`#${id}`)?.disabled === false),
    { ids: SETTINGS_SEMANTIC_CONTRACT.expertControlIds }
  );

  const sensitiveCases = [];
  sensitiveCases.push(await exerciseSensitiveCheckbox(page, 'skipCleanupReview', false, true));
  sensitiveCases.push(await exerciseSensitiveCheckbox(page, 'redactReports', true, false));
  sensitiveCases.push(await exerciseSensitiveSelect(page, 'latestReportRetentionMinutes', 30, 0));

  const exerciseOrder = [
    'keepHistory',
    'reportRetentionDays',
    'aggressiveCookieSweep',
    'includeProtectedWebOrigins',
    'storageBucketScrub',
    'embeddedFrameDiscovery',
    'probePartitionedCookiesWithEmbeddingSites',
    'exhaustiveCookieStoreScan',
    'downloadRecentFallback',
    'broadDiscoveryFallback',
    'verificationPass',
    'temporaryDnrShield',
    'progressOverlayCancelButton',
    'overlayScope',
    'postWipeShieldExpiresMinutes',
    'autoRepairOrphanedShields',
    'resetZoom',
    'resetMutedTabs',
    'unpinTargetTabs',
    'opfsScrub',
    'serviceWorkerExtraScrub',
    'appBadgeClear',
    'permissionAudit',
    'deleteDownloadedFiles',
    'allowLocalTargets',
    'blockOnAssociatedGroupErrors',
    'associatedDomainGroups',
    'reducedMotion',
    'highContrast',
    'debugLog',
    'pageScriptScrub',
    'progressOverlay'
  ];
  for (const key of exerciseOrder) {
    const attempted = SETTINGS_SEMANTIC_CONTRACT.exerciseValues[key];
    const expected = key === 'embeddedFrameDiscovery' ? false : attempted;
    await setVisibleSettingAndWait(page, key, attempted, expected);
  }

  const afterExercise = await captureOptionsSnapshot(page);
  await reloadMonitoredOptionsPage(page, safetyMonitor);
  const afterReload = await captureOptionsSnapshot(page);

  const importExport = await exerciseImportExport({
    artifactVersion,
    cell,
    page,
    expectedSettings: afterReload.settings
  });
  await restoreExerciseSettings(page, safetyMonitor);

  const malformed = await exerciseMalformedAssociatedGroups(page);
  await restoreExerciseSettings(page, safetyMonitor);

  const invalidPatchResponse = await sendOptionsMessage(page, 'sitewipe.saveSettings', {
    settings: {
      cleanupMode: 'invalid',
      latestReportRetentionMinutes: 2,
      overlayScope: 'invalid',
      postWipeShieldExpiresMinutes: 2,
      reportRetentionDays: 2
    }
  });
  const invalidPatchResult = selectSettings(invalidPatchResponse.settings, [
    'cleanupMode',
    'latestReportRetentionMinutes',
    'overlayScope',
    'postWipeShieldExpiresMinutes',
    'reportRetentionDays'
  ]);
  await restoreExerciseSettings(page, safetyMonitor);

  await setSelectAndWait(page, 'cleanupMode', 'standard', 'standard');
  const standardForcedValues = await page.evaluate(() => ({
    embeddedFrameDiscovery: document.querySelector('#embeddedFrameDiscovery')?.checked === true,
    overlayScope: document.querySelector('#overlayScope')?.value
  }));
  await restoreExerciseSettings(page, safetyMonitor);

  const resetCancelBeforeSha256 = sha256(
    canonicalJsonBytes(selectSettings((await captureOptionsSnapshot(page)).settings, VISIBLE_SETTINGS))
  );
  const resetCancel = await runConfirmation(page, () => page.click('#resetSettings'), false);
  const resetCancelAfterSha256 = sha256(
    canonicalJsonBytes(selectSettings((await captureOptionsSnapshot(page)).settings, VISIBLE_SETTINGS))
  );
  const resetAccept = await runConfirmation(page, () => page.click('#resetSettings'), true);
  await waitForVisibleDefaults(page);
  const afterReset = await captureOptionsSnapshot(page);
  sensitiveCases.push({
    acceptObserved: resetAccept.accepted,
    cancelObserved: !resetCancel.accepted && resetCancel.promptSha256 === resetAccept.promptSha256,
    changedAfterAccept: visibleSettingsMatchDefaults(afterReset.settings),
    id: 'resetSettings',
    promptSha256: resetAccept.promptSha256,
    unchangedAfterCancel: resetCancelBeforeSha256 === resetCancelAfterSha256
  });

  const payloads = buildSettingsPayloads({
    afterExercise,
    afterReload,
    afterReset,
    exactExpertEnabledControlIds,
    importExport,
    initial,
    invalidPatchResult,
    malformed,
    parentOffDisabledControlIds,
    sensitiveCases,
    standardDisabledControlIds,
    standardForcedValues
  });
  const nativeObservation = await settleNativePromptObserver();
  const ownedDownloadsBeforeClose = await captureOwnedDownloadInventory(cell);
  const afterBoundary = await captureSettingsSafetyBoundary(page, safetyMonitor);
  const afterCapturedAt = new Date().toISOString();
  return deepFreeze({
    payloads,
    safety: {
      afterBoundary,
      afterCapturedAt,
      beforeBoundary,
      beforeCapturedAt,
      ownedDownloadsBefore,
      ownedDownloadsBeforeClose,
      nativeObservation,
      nativeReadiness
    }
  });
}

function buildSettingsPayloads({
  afterExercise,
  afterReload,
  afterReset,
  exactExpertEnabledControlIds,
  importExport,
  initial,
  invalidPatchResult,
  malformed,
  parentOffDisabledControlIds,
  sensitiveCases,
  standardDisabledControlIds,
  standardForcedValues
}) {
  const payloads = {};
  for (const key of VISIBLE_SETTINGS) {
    const initialControl = initial.controls[key];
    const attemptedValue = SETTINGS_SEMANTIC_CONTRACT.exerciseValues[key];
    const expectedObserved = key === 'embeddedFrameDiscovery' ? false : attemptedValue;
    payloads[`setting.${key}`] = {
      classification: 'visible',
      control: {
        ariaDescribedByBound: initialControl.ariaDescribedByBound,
        ariaLabelledByBound: initialControl.ariaLabelledByBound,
        initialEnabled: initialControl.disabled === false,
        inputType: initialControl.inputType,
        optionValues: initialControl.optionValues,
        present: initialControl.present,
        tagName: initialControl.tagName
      },
      exercise: {
        attemptedValue,
        observedAfterSave: normalizedSettingValue(key, afterExercise.settings[key]),
        persistedAfterReload: normalizedSettingValue(key, afterReload.settings[key]),
        saveOutcome: key === 'embeddedFrameDiscovery' ? 'remained_off' : 'saved',
        storageRoundTripObserved:
          stableJson(normalizedSettingValue(key, afterExercise.settings[key])) === stableJson(expectedObserved) &&
          stableJson(normalizedSettingValue(key, afterReload.settings[key])) === stableJson(expectedObserved)
      },
      initialValue: normalizedSettingValue(key, initial.settings[key]),
      key,
      productionDefault: SETTINGS_DEFAULTS[key],
      resetValue: normalizedSettingValue(key, afterReset.settings[key])
    };
  }
  for (const key of INTERNAL_SETTINGS) {
    payloads[`setting.${key}`] = {
      afterExerciseState: internalSettingState(key, afterExercise.settings[key]),
      classification: 'internal',
      controlAbsent: !Object.hasOwn(afterExercise.controls, key),
      initialState: internalSettingState(key, initial.settings[key]),
      key,
      preservedAcrossVisibleSaves: stableJson(initial.settings[key]) === stableJson(afterExercise.settings[key]),
      productionDefault: SETTINGS_DEFAULTS[key],
      resetState: internalSettingState(key, afterReset.settings[key]),
      resetValueChanged: stableJson(initial.settings[key]) !== stableJson(afterReset.settings[key])
    };
  }
  payloads['settings.select_options_and_bounds'] = {
    controls: Object.keys(SETTINGS_SEMANTIC_CONTRACT.selectOptions).map((id) => ({
      id,
      optionValues: initial.controls[id].optionValues
    })),
    invalidPatchResult,
    productionDefaultsMatched: visibleSettingsMatchDefaults(initial.settings)
  };
  payloads['settings.dependencies_and_expert_gating'] = {
    expertEnabledControlIds: exactExpertEnabledControlIds,
    parentOffDisabledControlIds,
    standardDisabledControlIds,
    standardForcedValues
  };
  const observedExerciseCount = VISIBLE_SETTINGS.filter((key) => {
    const expected = key === 'embeddedFrameDiscovery' ? false : SETTINGS_SEMANTIC_CONTRACT.exerciseValues[key];
    return stableJson(normalizedSettingValue(key, afterExercise.settings[key])) === stableJson(expected);
  }).length;
  const persistedCount = VISIBLE_SETTINGS.filter((key) => {
    const expected = key === 'embeddedFrameDiscovery' ? false : SETTINGS_SEMANTIC_CONTRACT.exerciseValues[key];
    return stableJson(normalizedSettingValue(key, afterReload.settings[key])) === stableJson(expected);
  }).length;
  const renderedCount = VISIBLE_SETTINGS.filter(
    (key) =>
      stableJson(normalizedSettingValue(key, afterReload.controls[key].value)) ===
      stableJson(normalizedSettingValue(key, afterReload.settings[key]))
  ).length;
  payloads['settings.persistence_and_reset'] = {
    exercisedVisibleSettingCount: observedExerciseCount,
    internalSettingCount: INTERNAL_SETTINGS.length,
    persistedVisibleSettingCount: persistedCount,
    reloadRenderedVisibleSettingCount: renderedCount,
    resetAcceptRestoredSettingCount:
      VISIBLE_SETTINGS.filter(
        (key) =>
          stableJson(normalizedSettingValue(key, afterReset.settings[key])) === stableJson(SETTINGS_DEFAULTS[key])
      ).length + INTERNAL_SETTINGS.filter((key) => resetInternalSettingValid(key, afterReset.settings[key])).length,
    resetCancelPreserved: sensitiveCases.find(({ id }) => id === 'resetSettings')?.unchangedAfterCancel === true,
    visibleSettingCount: VISIBLE_SETTINGS.length
  };
  payloads['settings.import_export'] = importExport;
  payloads['settings.sensitive_confirm_cancel_and_accept'] = {
    cases: sensitiveCases
  };
  payloads['settings.malformed_associated_groups'] = malformed;
  return payloads;
}

function finalizeSettingsPayloads(session, { cell, closeReceipt, nativeObservation, ownedDownloadsAfterClose }) {
  validateSettingsSession(session);
  const payloads = structuredClone(session.payloads);
  const safetyBoundary = createSettingsSafetyBoundaryEvidence({
    ...session.safety,
    closeReceipt,
    nativeObservation
  });
  const downloadSafety = createOwnedDownloadSafetyEvidence({
    afterBoundary: session.safety.afterBoundary,
    beforeBoundary: session.safety.beforeBoundary,
    cell,
    closeReceipt,
    importExport: payloads['settings.import_export'],
    ownedDownloadsAfterClose,
    ownedDownloadsBefore: session.safety.ownedDownloadsBefore,
    ownedDownloadsBeforeClose: session.safety.ownedDownloadsBeforeClose
  });
  payloads['settings.dependencies_and_expert_gating'].safetyBoundary = structuredClone(safetyBoundary);
  payloads['settings.persistence_and_reset'].safetyBoundary = structuredClone(safetyBoundary);
  payloads['settings.sensitive_confirm_cancel_and_accept'].safetyBoundary = structuredClone(safetyBoundary);
  payloads['settings.malformed_associated_groups'].safetyBoundary = structuredClone(safetyBoundary);
  delete payloads['settings.import_export'].exportEntryName;
  delete payloads['settings.import_export'].exportFileSha256;
  delete payloads['settings.import_export'].exportIdentitySha256;
  delete payloads['settings.import_export'].importFileSha256;
  delete payloads['settings.import_export'].importIdentitySha256;
  payloads['settings.import_export'].downloadSafety = downloadSafety;
  return deepFreeze(payloads);
}

function createSettingsSafetyBoundaryEvidence({
  afterBoundary,
  afterCapturedAt,
  beforeBoundary,
  beforeCapturedAt,
  closeReceipt,
  nativeObservation,
  nativeReadiness
}) {
  assertSettingsSafetyBoundary(afterBoundary, 'Post-settings safety boundary');
  assertSettingsSafetyBoundary(beforeBoundary, 'Pre-settings safety boundary');
  if (Date.parse(afterCapturedAt) < Date.parse(beforeCapturedAt)) {
    throw new Error('SETTINGS-01 safety observation timestamps are decreasing.');
  }
  assertSafeSettingsBoundaryPrecondition(beforeBoundary);
  assertSafeSettingsBoundaryPostcondition(afterBoundary);
  assertSettingsNativeReadiness(nativeReadiness);
  if (
    nativeObservation.observationStartedAt !== nativeReadiness.readyAt ||
    Date.parse(nativeReadiness.readyAt) > Date.parse(beforeCapturedAt) ||
    Date.parse(nativeObservation.observedAt) > Date.parse(afterCapturedAt)
  ) {
    throw new Error('SETTINGS-01 native no-prompt interval is not bound around the complete settings interaction.');
  }
  return {
    schema: 'sitewipe.settings-safety-boundary.v2',
    observationScope: 'bounded_preload_monitoring',
    localAuthorityBeforeSha256: sha256(canonicalJsonBytes(beforeBoundary.localAuthority)),
    localAuthorityAfterSha256: sha256(canonicalJsonBytes(afterBoundary.localAuthority)),
    localAuthorityEntryCountBefore: Object.keys(beforeBoundary.localAuthority).length,
    localAuthorityEntryCountAfter: Object.keys(afterBoundary.localAuthority).length,
    sessionAuthorityBeforeSha256: sha256(canonicalJsonBytes(beforeBoundary.sessionAuthority)),
    sessionAuthorityAfterSha256: sha256(canonicalJsonBytes(afterBoundary.sessionAuthority)),
    sessionAuthorityEntryCountBefore: Object.keys(beforeBoundary.sessionAuthority).length,
    sessionAuthorityEntryCountAfter: Object.keys(afterBoundary.sessionAuthority).length,
    dynamicRulesBeforeSha256: sha256(canonicalJsonBytes(beforeBoundary.dynamicRules)),
    dynamicRulesAfterSha256: sha256(canonicalJsonBytes(afterBoundary.dynamicRules)),
    dynamicRuleCountBefore: beforeBoundary.dynamicRules.length,
    dynamicRuleCountAfter: afterBoundary.dynamicRules.length,
    sessionRulesBeforeSha256: sha256(canonicalJsonBytes(beforeBoundary.sessionRules)),
    sessionRulesAfterSha256: sha256(canonicalJsonBytes(afterBoundary.sessionRules)),
    sessionRuleCountBefore: beforeBoundary.sessionRules.length,
    sessionRuleCountAfter: afterBoundary.sessionRules.length,
    permissionsBeforeSha256: sha256(canonicalJsonBytes(beforeBoundary.permissions)),
    permissionsAfterSha256: sha256(canonicalJsonBytes(afterBoundary.permissions)),
    permissionOriginCountBefore: beforeBoundary.permissions.origins.length,
    permissionOriginCountAfter: afterBoundary.permissions.origins.length,
    permissionApiCountBefore: beforeBoundary.permissions.permissions.length,
    permissionApiCountAfter: afterBoundary.permissions.permissions.length,
    permissionApis: structuredClone(beforeBoundary.permissions.permissions),
    permissionAddedEventCount: afterBoundary.monitorEvents.permissionAddedEventCount,
    permissionRemovedEventCount: afterBoundary.monitorEvents.permissionRemovedEventCount,
    authorityStorageChangeCount: afterBoundary.monitorEvents.authorityStorageChangeCount,
    monitoredLocalAuthorityKeys: structuredClone(afterBoundary.monitorEvents.localAuthorityKeys),
    monitoredSessionAuthorityKeys: structuredClone(afterBoundary.monitorEvents.sessionAuthorityKeys),
    preloadDocumentReadyCountBefore: beforeBoundary.monitorEvents.documentReadyCount,
    preloadDocumentReadyCountAfter: afterBoundary.monitorEvents.documentReadyCount,
    dnrPollIntervalMs: afterBoundary.monitorEvents.dnrPollIntervalMs,
    dnrPollCountBefore: beforeBoundary.monitorEvents.dnrPollCount,
    dnrPollCountAfter: afterBoundary.monitorEvents.dnrPollCount,
    dnrPollMaxGapMs: afterBoundary.monitorEvents.dnrPollMaxGapMs,
    dnrPollNonemptyCount: afterBoundary.monitorEvents.dnrPollNonemptyCount,
    dnrPollErrorCount: afterBoundary.monitorEvents.dnrPollErrorCount,
    incognitoAllowedBefore: beforeBoundary.incognitoAllowed,
    incognitoAllowedAfter: afterBoundary.incognitoAllowed,
    nativeObservationScheduleId: nativeObservation.scheduleId,
    nativeObservationStatus: nativeObservation.status,
    nativeReadinessStatus: nativeReadiness.status,
    nativeControlledStopObserved: isIsoTimestamp(nativeObservation.stopRequestedAt),
    nativeObservationSettledBeforeFinalCapture: Date.parse(nativeObservation.observedAt) <= Date.parse(afterCapturedAt),
    closeObservationStatus: closeReceipt.observationStatus,
    closeResidueCount: closeReceipt.profileProcessResidueCount,
    closeCanaryPreserved: closeReceipt.mustPreserveDownloadCanary.preserved,
    automaticProfileDeletionPerformed: closeReceipt.automaticProfileDeletionPerformed,
    automaticDownloadDeletionPerformed: closeReceipt.automaticDownloadDeletionPerformed
  };
}

function createOwnedDownloadSafetyEvidence({
  afterBoundary,
  beforeBoundary,
  cell,
  closeReceipt,
  importExport,
  ownedDownloadsAfterClose,
  ownedDownloadsBefore,
  ownedDownloadsBeforeClose
}) {
  for (const [label, inventory] of [
    ['Pre-settings owned downloads', ownedDownloadsBefore],
    ['Pre-close owned downloads', ownedDownloadsBeforeClose],
    ['Post-close owned downloads', ownedDownloadsAfterClose]
  ]) {
    assertOwnedDownloadInventory(inventory, label);
  }
  const beforeRecords = beforeBoundary.downloadRecords;
  const afterRecords = afterBoundary.downloadRecords;
  if (beforeRecords.length !== 0 || afterRecords.length !== 1) {
    throw new Error('SETTINGS-01 browser download records differ from the exact disposable export boundary.');
  }
  const exportRecord = afterRecords[0];
  const exportName = importExport.exportEntryName;
  if (
    basename(exportRecord.filename) !== exportName ||
    !sameHostPath(exportRecord.filename, resolve(cell.downloadPath, exportName)) ||
    exportRecord.state !== 'complete' ||
    exportRecord.exists !== true ||
    exportRecord.paused !== false ||
    exportRecord.danger !== 'safe' ||
    exportRecord.error !== null ||
    exportRecord.bytesReceived !== importExport.exportBytes ||
    exportRecord.totalBytes !== importExport.exportBytes
  ) {
    throw new Error('SETTINGS-01 export browser record is not one exact completed owned synthetic download.');
  }
  const exactExport = ownedDownloadsBeforeClose.entries.find(({ name }) => name === exportName);
  const exactImport = ownedDownloadsBeforeClose.entries.find(({ name }) => name === SYNTHETIC_IMPORT_NAME);
  if (
    !exactExport ||
    exactExport.bytes !== importExport.exportBytes ||
    exactExport.sha256 !== importExport.exportFileSha256 ||
    exactExport.identitySha256 !== importExport.exportIdentitySha256 ||
    !exactImport ||
    exactImport.sha256 !== importExport.importFileSha256 ||
    exactImport.identitySha256 !== importExport.importIdentitySha256
  ) {
    throw new Error('SETTINGS-01 filesystem export/import identities differ from the exact synthetic files.');
  }
  const foreignEntryCount = ownedDownloadsBeforeClose.entries.filter(
    ({ name }) => ![OWNED_DIRECTORY_MARKER_NAME, DOWNLOAD_CANARY_NAME, SYNTHETIC_IMPORT_NAME, exportName].includes(name)
  ).length;
  const directoryIdentityMatchedThroughClose =
    ownedDownloadsBefore.directoryIdentitySha256 === ownedDownloadsBeforeClose.directoryIdentitySha256 &&
    ownedDownloadsBeforeClose.directoryIdentitySha256 === ownedDownloadsAfterClose.directoryIdentitySha256;
  if (!directoryIdentityMatchedThroughClose) {
    throw new Error('SETTINGS-01 owned download parent was substituted before exact close settlement.');
  }
  return {
    schema: 'sitewipe.settings-owned-download-safety.v2',
    scopeBoundary: 'owned_disposable_cell_only',
    browserRecordCountBefore: beforeRecords.length,
    browserRecordCountAfter: afterRecords.length,
    browserExport: {
      bytesReceived: exportRecord.bytesReceived,
      danger: exportRecord.danger,
      exists: exportRecord.exists,
      namePatternMatched: /^sitewipe-settings-\d+\.json$/u.test(exportName),
      paused: exportRecord.paused,
      state: exportRecord.state,
      totalBytes: exportRecord.totalBytes
    },
    ownedEntryNamesBefore: ownedDownloadsBefore.entries.map(({ name }) => name),
    ownedEntryNamesBeforeClose: ownedDownloadsBeforeClose.entries.map(({ name }) => name),
    ownedEntryNamesAfterClose: ownedDownloadsAfterClose.entries.map(({ name }) => name),
    ownedSetBeforeSha256: ownedDownloadsBefore.inventorySha256,
    ownedSetBeforeCloseSha256: ownedDownloadsBeforeClose.inventorySha256,
    ownedSetAfterCloseSha256: ownedDownloadsAfterClose.inventorySha256,
    ownedParentIdentitySha256: ownedDownloadsAfterClose.directoryIdentitySha256,
    exportFileSha256: exactExport.sha256,
    importFileSha256: exactImport.sha256,
    canarySha256: ownedDownloadsBefore.canarySha256,
    canaryPreservedAfterClose: closeReceipt.mustPreserveDownloadCanary.preserved,
    automaticDownloadDeletionPerformed: closeReceipt.automaticDownloadDeletionPerformed,
    browserDownloadCreatedEventCount: afterBoundary.monitorEvents.downloadCreatedEventCount,
    browserDownloadErasedEventCount: afterBoundary.monitorEvents.downloadErasedEventCount,
    foreignEntryCount,
    parentIdentityMatchedThroughClose: directoryIdentityMatchedThroughClose,
    exportPhysicalIdentityRetained: exactExport.identitySha256 === importExport.exportIdentitySha256,
    importPhysicalIdentityRetained: exactImport.identitySha256 === importExport.importIdentitySha256,
    precloseAndPostcloseOwnedSetMatched:
      ownedDownloadsBeforeClose.inventorySha256 === ownedDownloadsAfterClose.inventorySha256
  };
}

export async function installSettingsSafetyMonitor(page) {
  if (
    !page ||
    typeof page.exposeFunction !== 'function' ||
    typeof page.evaluateOnNewDocument !== 'function' ||
    typeof page.evaluate !== 'function'
  ) {
    throw new Error('SETTINGS-01 preload monitor requires the exact Puppeteer page capabilities.');
  }
  const state = {
    authorityStorageChangeCount: 0,
    documentIds: new Set(),
    documentReadyCount: 0,
    downloadCreatedEventCount: 0,
    downloadErasedEventCount: 0,
    dnrPollCount: 0,
    dnrPollErrorCount: 0,
    dnrPollMaxGapMs: 0,
    dnrPollNonemptyCount: 0,
    failure: null,
    firstReadyAt: null,
    lastDnrPollAt: null,
    lastReadyAt: null,
    permissionAddedEventCount: 0,
    permissionRemovedEventCount: 0
  };
  const report = (message) => {
    try {
      acceptSettingsMonitorReport(state, message);
    } catch (error) {
      state.failure ??= error;
      throw error;
    }
  };
  await page.exposeFunction(SETTINGS_MONITOR_BINDING, report);
  const registration = await page.evaluateOnNewDocument(
    ({ bindingName, dnrPollIntervalMs, globalName, localKeys, sessionKeys }) => {
      if (globalThis[globalName]) throw new Error('SETTINGS-01 preload monitor was installed twice in one document.');
      const binding = globalThis[bindingName];
      if (typeof binding !== 'function') throw new Error('SETTINGS-01 preload monitor binding is unavailable.');
      const documentId = crypto.randomUUID();
      const local = new Set(localKeys);
      const session = new Set(sessionKeys);
      let reporting = Promise.resolve();
      const enqueue = (message) => {
        reporting = reporting.then(() => binding(message));
        return reporting;
      };
      const observedAt = () => new Date().toISOString();
      chrome.storage.onChanged.addListener((changes, areaName) => {
        const selected = areaName === 'local' ? local : areaName === 'session' ? session : null;
        const changedKeys = selected
          ? Object.keys(changes)
              .filter((key) => selected.has(key))
              .sort()
          : [];
        if (changedKeys.length > 0) {
          void enqueue({
            schema: 'sitewipe.settings-preload-monitor-report.v1',
            type: 'authority-storage-change',
            areaName,
            changedKeys,
            documentId,
            observedAt: observedAt()
          });
        }
      });
      chrome.permissions.onAdded.addListener(() => {
        void enqueue({
          schema: 'sitewipe.settings-preload-monitor-report.v1',
          type: 'permission-added',
          documentId,
          observedAt: observedAt()
        });
      });
      chrome.permissions.onRemoved.addListener(() => {
        void enqueue({
          schema: 'sitewipe.settings-preload-monitor-report.v1',
          type: 'permission-removed',
          documentId,
          observedAt: observedAt()
        });
      });
      chrome.downloads.onCreated.addListener(() => {
        void enqueue({
          schema: 'sitewipe.settings-preload-monitor-report.v1',
          type: 'download-created',
          documentId,
          observedAt: observedAt()
        });
      });
      chrome.downloads.onErased.addListener(() => {
        void enqueue({
          schema: 'sitewipe.settings-preload-monitor-report.v1',
          type: 'download-erased',
          documentId,
          observedAt: observedAt()
        });
      });
      const pollDnr = async () => {
        try {
          const [dynamicRules, sessionRules] = await Promise.all([
            chrome.declarativeNetRequest.getDynamicRules(),
            chrome.declarativeNetRequest.getSessionRules()
          ]);
          await enqueue({
            schema: 'sitewipe.settings-preload-monitor-report.v1',
            type: 'dnr-poll',
            documentId,
            dynamicRuleCount: dynamicRules.length,
            sessionRuleCount: sessionRules.length,
            observedAt: observedAt()
          });
        } catch {
          await enqueue({
            schema: 'sitewipe.settings-preload-monitor-report.v1',
            type: 'dnr-poll-error',
            documentId,
            observedAt: observedAt()
          });
        }
      };
      const snapshotBarrier = async () => {
        await pollDnr();
        await reporting;
      };
      Object.defineProperty(globalThis, globalName, {
        configurable: false,
        enumerable: false,
        value: Object.freeze({ snapshotBarrier }),
        writable: false
      });
      void enqueue({
        schema: 'sitewipe.settings-preload-monitor-report.v1',
        type: 'document-ready',
        documentId,
        localKeys: [...localKeys],
        sessionKeys: [...sessionKeys],
        observedAt: observedAt()
      });
      void pollDnr();
      setInterval(() => void pollDnr(), dnrPollIntervalMs);
    },
    {
      bindingName: SETTINGS_MONITOR_BINDING,
      dnrPollIntervalMs: SETTINGS_DNR_POLL_INTERVAL_MS,
      globalName: SETTINGS_MONITOR_GLOBAL,
      localKeys: LOCAL_CLEANUP_AUTHORITY_KEYS,
      sessionKeys: SESSION_CLEANUP_AUTHORITY_KEYS
    }
  );
  if (!registration || typeof registration.identifier !== 'string' || registration.identifier.length === 0) {
    throw new Error('SETTINGS-01 preload monitor registration identity is unavailable.');
  }
  return Object.freeze({
    page,
    registrationSha256: sha256(registration.identifier),
    snapshot: () => snapshotSettingsMonitorState(state),
    state
  });
}

async function waitForSettingsMonitorDocumentReady(monitor, minimumDocumentCount) {
  const deadline = Date.now() + SETTINGS_MONITOR_READY_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    if (monitor.state.failure) throw monitor.state.failure;
    if (monitor.state.documentReadyCount >= minimumDocumentCount && monitor.state.dnrPollCount > 0) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error('SETTINGS-01 preload safety monitor did not prove document readiness before interaction.');
}

async function reloadMonitoredOptionsPage(page, monitor) {
  const previousDocuments = monitor.state.documentReadyCount;
  await page.reload({ waitUntil: 'domcontentloaded', timeout: OPTIONS_READY_TIMEOUT_MS });
  await waitForSettingsMonitorDocumentReady(monitor, previousDocuments + 1);
  await waitForOptionsReady(page);
}

function acceptSettingsMonitorReport(state, message) {
  if (
    !message ||
    typeof message !== 'object' ||
    Array.isArray(message) ||
    message.schema !== 'sitewipe.settings-preload-monitor-report.v1' ||
    typeof message.documentId !== 'string' ||
    !/^[0-9a-f-]{36}$/iu.test(message.documentId) ||
    Number.isNaN(Date.parse(String(message.observedAt || '')))
  ) {
    throw new Error('SETTINGS-01 preload monitor emitted a malformed report.');
  }
  const knownDocument = state.documentIds.has(message.documentId);
  if (message.type === 'document-ready') {
    assertExactKeys(
      message,
      ['documentId', 'localKeys', 'observedAt', 'schema', 'sessionKeys', 'type'],
      'SETTINGS-01 preload ready report'
    );
    if (
      knownDocument ||
      stableJson(message.localKeys) !== stableJson(LOCAL_CLEANUP_AUTHORITY_KEYS) ||
      stableJson(message.sessionKeys) !== stableJson(SESSION_CLEANUP_AUTHORITY_KEYS)
    ) {
      throw new Error('SETTINGS-01 preload monitor readiness coverage is incomplete or duplicated.');
    }
    state.documentIds.add(message.documentId);
    state.documentReadyCount += 1;
    state.firstReadyAt ??= message.observedAt;
    state.lastReadyAt = message.observedAt;
    return;
  }
  if (!knownDocument) throw new Error('SETTINGS-01 preload monitor reported an event before document readiness.');
  if (message.type === 'authority-storage-change') {
    assertExactKeys(
      message,
      ['areaName', 'changedKeys', 'documentId', 'observedAt', 'schema', 'type'],
      'SETTINGS-01 preload storage report'
    );
    const selected = message.areaName === 'local' ? LOCAL_CLEANUP_AUTHORITY_KEYS : SESSION_CLEANUP_AUTHORITY_KEYS;
    if (
      !['local', 'session'].includes(message.areaName) ||
      !Array.isArray(message.changedKeys) ||
      message.changedKeys.length === 0 ||
      message.changedKeys.some((key) => !selected.includes(key))
    ) {
      throw new Error('SETTINGS-01 preload storage report exceeded the selected authority keys.');
    }
    state.authorityStorageChangeCount += 1;
    return;
  }
  if (message.type === 'dnr-poll' || message.type === 'dnr-poll-error') {
    const exactKeys =
      message.type === 'dnr-poll'
        ? ['documentId', 'dynamicRuleCount', 'observedAt', 'schema', 'sessionRuleCount', 'type']
        : ['documentId', 'observedAt', 'schema', 'type'];
    assertExactKeys(message, exactKeys, 'SETTINGS-01 preload DNR report');
    const observedMs = Date.parse(message.observedAt);
    if (state.lastDnrPollAt !== null) {
      const gap = observedMs - Date.parse(state.lastDnrPollAt);
      if (!Number.isFinite(gap) || gap < 0) throw new Error('SETTINGS-01 preload DNR observations are decreasing.');
      state.dnrPollMaxGapMs = Math.max(state.dnrPollMaxGapMs, gap);
    }
    state.lastDnrPollAt = message.observedAt;
    if (message.type === 'dnr-poll-error') {
      state.dnrPollErrorCount += 1;
    } else {
      if (
        !Number.isInteger(message.dynamicRuleCount) ||
        message.dynamicRuleCount < 0 ||
        !Number.isInteger(message.sessionRuleCount) ||
        message.sessionRuleCount < 0
      ) {
        throw new Error('SETTINGS-01 preload DNR poll counts are malformed.');
      }
      state.dnrPollCount += 1;
      if (message.dynamicRuleCount > 0 || message.sessionRuleCount > 0) state.dnrPollNonemptyCount += 1;
    }
    return;
  }
  const counter = {
    'download-created': 'downloadCreatedEventCount',
    'download-erased': 'downloadErasedEventCount',
    'permission-added': 'permissionAddedEventCount',
    'permission-removed': 'permissionRemovedEventCount'
  }[message.type];
  if (!counter) throw new Error('SETTINGS-01 preload monitor emitted an unknown report type.');
  assertExactKeys(message, ['documentId', 'observedAt', 'schema', 'type'], 'SETTINGS-01 preload event report');
  state[counter] += 1;
}

function snapshotSettingsMonitorState(state) {
  if (state.failure) throw state.failure;
  return deepFreeze({
    authorityStorageChangeCount: state.authorityStorageChangeCount,
    documentReadyCount: state.documentReadyCount,
    downloadCreatedEventCount: state.downloadCreatedEventCount,
    downloadErasedEventCount: state.downloadErasedEventCount,
    dnrPollCount: state.dnrPollCount,
    dnrPollErrorCount: state.dnrPollErrorCount,
    dnrPollIntervalMs: SETTINGS_DNR_POLL_INTERVAL_MS,
    dnrPollMaxGapMs: state.dnrPollMaxGapMs,
    dnrPollNonemptyCount: state.dnrPollNonemptyCount,
    firstReadyAt: state.firstReadyAt,
    lastDnrPollAt: state.lastDnrPollAt,
    lastReadyAt: state.lastReadyAt,
    localAuthorityKeys: [...LOCAL_CLEANUP_AUTHORITY_KEYS],
    permissionAddedEventCount: state.permissionAddedEventCount,
    permissionRemovedEventCount: state.permissionRemovedEventCount,
    sessionAuthorityKeys: [...SESSION_CLEANUP_AUTHORITY_KEYS]
  });
}

async function captureSettingsSafetyBoundary(page, monitor) {
  await page.evaluate(async (globalName) => {
    const capability = globalThis[globalName];
    if (!capability || typeof capability.snapshotBarrier !== 'function') {
      throw new Error('SETTINGS-01 preload monitor is absent from the active Options document.');
    }
    await capability.snapshotBarrier();
  }, SETTINGS_MONITOR_GLOBAL);
  const value = await page.evaluate(
    async ({ localKeys, sessionKeys }) => {
      const incognitoAllowed = await new Promise((resolveAllowed, rejectAllowed) => {
        chrome.extension.isAllowedIncognitoAccess((allowed) => {
          const message = chrome.runtime.lastError?.message;
          if (message) rejectAllowed(new Error(message));
          else resolveAllowed(allowed === true);
        });
      });
      const [localAuthority, sessionAuthority, dynamicRules, sessionRules, permissions, downloadRecords] =
        await Promise.all([
          chrome.storage.local.get(localKeys),
          chrome.storage.session.get(sessionKeys),
          chrome.declarativeNetRequest.getDynamicRules(),
          chrome.declarativeNetRequest.getSessionRules(),
          chrome.permissions.getAll(),
          chrome.downloads.search({})
        ]);
      const sortRecord = (record) =>
        Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
      const normalizeRules = (rules) => [...rules].sort((left, right) => left.id - right.id);
      const normalizeDownload = (item) => ({
        bytesReceived: Number(item.bytesReceived),
        danger: String(item.danger || ''),
        error: item.error ? String(item.error) : null,
        exists: item.exists === true,
        filename: String(item.filename || ''),
        id: Number(item.id),
        paused: item.paused === true,
        state: String(item.state || ''),
        totalBytes: Number(item.totalBytes)
      });
      return {
        downloadRecords: [...downloadRecords].map(normalizeDownload).sort((left, right) => left.id - right.id),
        dynamicRules: normalizeRules(dynamicRules),
        incognitoAllowed,
        localAuthority: sortRecord(localAuthority),
        permissions: {
          origins: [...(permissions.origins || [])].sort(),
          permissions: [...(permissions.permissions || [])].sort()
        },
        sessionAuthority: sortRecord(sessionAuthority),
        sessionRules: normalizeRules(sessionRules)
      };
    },
    { localKeys: LOCAL_CLEANUP_AUTHORITY_KEYS, sessionKeys: SESSION_CLEANUP_AUTHORITY_KEYS }
  );
  await page.evaluate(async (globalName) => {
    const capability = globalThis[globalName];
    if (!capability || typeof capability.snapshotBarrier !== 'function') {
      throw new Error('SETTINGS-01 preload monitor disappeared before boundary settlement.');
    }
    await capability.snapshotBarrier();
  }, SETTINGS_MONITOR_GLOBAL);
  value.monitorEvents = monitor.snapshot();
  assertSettingsSafetyBoundary(value, 'Authentic SETTINGS-01 safety boundary');
  return deepFreeze(value);
}

function assertSettingsSafetyBoundary(value, label) {
  assertExactKeys(
    value,
    [
      'downloadRecords',
      'dynamicRules',
      'incognitoAllowed',
      'localAuthority',
      'monitorEvents',
      'permissions',
      'sessionAuthority',
      'sessionRules'
    ],
    label
  );
  if (
    typeof value.incognitoAllowed !== 'boolean' ||
    !Array.isArray(value.downloadRecords) ||
    !Array.isArray(value.dynamicRules) ||
    !Array.isArray(value.sessionRules)
  ) {
    throw new Error(`${label} has malformed browser state collections.`);
  }
  assertExactKeys(value.permissions, ['origins', 'permissions'], `${label} permissions`);
  if (!Array.isArray(value.permissions.origins) || !Array.isArray(value.permissions.permissions)) {
    throw new Error(`${label} permissions are malformed.`);
  }
  for (const [name, items] of Object.entries(value.permissions)) {
    if (
      items.some((item) => typeof item !== 'string' || item.length === 0) ||
      stableJson(items) !== stableJson([...new Set(items)].sort())
    ) {
      throw new Error(`${label} permission ${name} values are duplicated, unsorted, or malformed.`);
    }
  }
  for (const item of value.downloadRecords) {
    assertExactKeys(
      item,
      ['bytesReceived', 'danger', 'error', 'exists', 'filename', 'id', 'paused', 'state', 'totalBytes'],
      `${label} browser download record`
    );
    if (
      !Number.isInteger(item.id) ||
      item.id < 0 ||
      !Number.isFinite(item.bytesReceived) ||
      item.bytesReceived < 0 ||
      !Number.isFinite(item.totalBytes) ||
      item.totalBytes < 0 ||
      typeof item.exists !== 'boolean' ||
      typeof item.paused !== 'boolean' ||
      typeof item.filename !== 'string' ||
      !isAbsolute(item.filename) ||
      typeof item.danger !== 'string' ||
      typeof item.state !== 'string' ||
      (item.error !== null && typeof item.error !== 'string')
    ) {
      throw new Error(`${label} browser download record is malformed.`);
    }
  }
  assertExactKeys(
    value.monitorEvents,
    [
      'authorityStorageChangeCount',
      'documentReadyCount',
      'downloadCreatedEventCount',
      'downloadErasedEventCount',
      'dnrPollCount',
      'dnrPollErrorCount',
      'dnrPollIntervalMs',
      'dnrPollMaxGapMs',
      'dnrPollNonemptyCount',
      'firstReadyAt',
      'lastDnrPollAt',
      'lastReadyAt',
      'localAuthorityKeys',
      'permissionAddedEventCount',
      'permissionRemovedEventCount',
      'sessionAuthorityKeys'
    ],
    `${label} monitor events`
  );
  if (
    [
      'authorityStorageChangeCount',
      'documentReadyCount',
      'downloadCreatedEventCount',
      'downloadErasedEventCount',
      'dnrPollCount',
      'dnrPollErrorCount',
      'dnrPollIntervalMs',
      'dnrPollMaxGapMs',
      'dnrPollNonemptyCount',
      'permissionAddedEventCount',
      'permissionRemovedEventCount'
    ].some((key) => !Number.isInteger(value.monitorEvents[key]) || value.monitorEvents[key] < 0) ||
    value.monitorEvents.dnrPollIntervalMs !== SETTINGS_DNR_POLL_INTERVAL_MS ||
    value.monitorEvents.documentReadyCount < 1 ||
    value.monitorEvents.dnrPollCount < 1 ||
    value.monitorEvents.dnrPollMaxGapMs > SETTINGS_DNR_MAX_GAP_MS ||
    value.monitorEvents.dnrPollErrorCount !== 0 ||
    value.monitorEvents.dnrPollNonemptyCount !== 0 ||
    stableJson(value.monitorEvents.localAuthorityKeys) !== stableJson(LOCAL_CLEANUP_AUTHORITY_KEYS) ||
    stableJson(value.monitorEvents.sessionAuthorityKeys) !== stableJson(SESSION_CLEANUP_AUTHORITY_KEYS) ||
    !isIsoTimestamp(value.monitorEvents.firstReadyAt) ||
    !isIsoTimestamp(value.monitorEvents.lastReadyAt) ||
    !isIsoTimestamp(value.monitorEvents.lastDnrPollAt) ||
    !value.localAuthority ||
    typeof value.localAuthority !== 'object' ||
    Array.isArray(value.localAuthority) ||
    !value.sessionAuthority ||
    typeof value.sessionAuthority !== 'object' ||
    Array.isArray(value.sessionAuthority)
  ) {
    throw new Error(`${label} authority observations are malformed.`);
  }
}

function assertSafeSettingsBoundaryPrecondition(value) {
  assertSettingsSafetyBoundary(value, 'Pre-settings safety boundary');
  if (
    value.incognitoAllowed !== false ||
    Object.keys(value.localAuthority).length !== 0 ||
    Object.keys(value.sessionAuthority).length !== 0 ||
    value.dynamicRules.length !== 0 ||
    value.sessionRules.length !== 0 ||
    value.permissions.origins.length !== 0 ||
    stableJson(value.permissions.permissions) !== stableJson(REQUIRED_EXTENSION_PERMISSIONS) ||
    value.downloadRecords.length !== 0 ||
    value.monitorEvents.authorityStorageChangeCount !== 0 ||
    value.monitorEvents.downloadCreatedEventCount !== 0 ||
    value.monitorEvents.downloadErasedEventCount !== 0 ||
    value.monitorEvents.permissionAddedEventCount !== 0 ||
    value.monitorEvents.permissionRemovedEventCount !== 0
  ) {
    throw new Error('SETTINGS-01 fresh disposable browser state is outside the no-authority safety boundary.');
  }
}

function assertSafeSettingsBoundaryPostcondition(value) {
  assertSettingsSafetyBoundary(value, 'Post-settings safety boundary');
  if (
    value.incognitoAllowed !== false ||
    Object.keys(value.localAuthority).length !== 0 ||
    Object.keys(value.sessionAuthority).length !== 0 ||
    value.dynamicRules.length !== 0 ||
    value.sessionRules.length !== 0 ||
    value.permissions.origins.length !== 0 ||
    stableJson(value.permissions.permissions) !== stableJson(REQUIRED_EXTENSION_PERMISSIONS) ||
    value.monitorEvents.authorityStorageChangeCount !== 0 ||
    value.monitorEvents.permissionAddedEventCount !== 0 ||
    value.monitorEvents.permissionRemovedEventCount !== 0 ||
    value.monitorEvents.downloadCreatedEventCount !== 1 ||
    value.monitorEvents.downloadErasedEventCount !== 0
  ) {
    throw new Error('SETTINGS-01 changed cleanup authority, host access, private access, or download safety state.');
  }
}

async function captureOptionsSnapshot(page) {
  return page.evaluate(
    async ({ settingsKey, visibleSettings, numericSettings }) => {
      const stored = await chrome.storage.local.get([settingsKey]);
      const settings = stored[settingsKey] || {};
      const controls = {};
      for (const id of visibleSettings) {
        const control = document.querySelector(`#${id}`);
        if (!control) {
          controls[id] = { present: false };
          continue;
        }
        const labelledBy = String(control.getAttribute('aria-labelledby') || '')
          .split(/\s+/u)
          .filter(Boolean);
        const describedBy = String(control.getAttribute('aria-describedby') || '')
          .split(/\s+/u)
          .filter(Boolean);
        let value;
        if (control instanceof HTMLInputElement && control.type === 'checkbox') value = control.checked;
        else if (numericSettings.includes(id)) value = Number(control.value);
        else value = control.value;
        controls[id] = {
          ariaDescribedByBound: describedBy.length > 0 && describedBy.every((ref) => document.getElementById(ref)),
          ariaLabelledByBound: labelledBy.length > 0 && labelledBy.every((ref) => document.getElementById(ref)),
          disabled: control.disabled,
          inputType:
            control instanceof HTMLSelectElement
              ? 'select-one'
              : control instanceof HTMLTextAreaElement
                ? 'textarea'
                : control.type,
          optionValues: control instanceof HTMLSelectElement ? [...control.options].map((option) => option.value) : [],
          present: true,
          tagName: control.tagName,
          value
        };
      }
      return { controls, settings };
    },
    {
      settingsKey: SETTINGS_STORAGE_KEY,
      visibleSettings: VISIBLE_SETTINGS,
      numericSettings: [...NUMERIC_VISIBLE_SETTINGS]
    }
  );
}

async function waitForOptionsReady(page) {
  await page.waitForFunction(
    () =>
      document.readyState === 'complete' &&
      !document.body.classList.contains('options-loading') &&
      !document.body.classList.contains('options-load-failed') &&
      document.querySelector('#mainContent')?.getAttribute('aria-busy') === 'false' &&
      document.querySelector('#settingsStateBadge')?.textContent?.includes('Ready'),
    { timeout: OPTIONS_READY_TIMEOUT_MS }
  );
}

async function captureParentOffDependencies(page, parentId) {
  const original = await page.$eval(`#${parentId}`, (control) => control.checked);
  if (original) await setCheckboxAndWait(page, parentId, false, false);
  const disabled = await page.evaluate(
    ({ childIds }) => childIds.filter((id) => document.querySelector(`#${id}`)?.disabled === true),
    { childIds: SETTINGS_SEMANTIC_CONTRACT.dependencyGroups[parentId] }
  );
  if (original) await setCheckboxAndWait(page, parentId, true, true);
  return disabled;
}

function disabledChildren(snapshot, parentId) {
  return SETTINGS_SEMANTIC_CONTRACT.dependencyGroups[parentId].filter((id) => snapshot.controls[id]?.disabled === true);
}

async function exerciseSensitiveCheckbox(page, id, before, after) {
  await waitForStoredSetting(page, id, before);
  const cancel = await runConfirmation(page, () => page.click(`#${id}`), false);
  await waitForStoredSetting(page, id, before);
  const unchangedAfterCancel = (await storedSetting(page, id)) === before;
  const accept = await runConfirmation(page, () => page.click(`#${id}`), true);
  await waitForStoredSetting(page, id, after);
  return {
    acceptObserved: accept.accepted,
    cancelObserved: !cancel.accepted && cancel.promptSha256 === accept.promptSha256,
    changedAfterAccept: (await storedSetting(page, id)) === after,
    id,
    promptSha256: accept.promptSha256,
    unchangedAfterCancel
  };
}

async function exerciseSensitiveSelect(page, id, before, after) {
  await waitForStoredSetting(page, id, before);
  const cancel = await runConfirmation(page, () => page.select(`#${id}`, String(after)), false);
  await waitForStoredSetting(page, id, before);
  const unchangedAfterCancel = (await storedSetting(page, id)) === before;
  const accept = await runConfirmation(page, () => page.select(`#${id}`, String(after)), true);
  await waitForStoredSetting(page, id, after);
  return {
    acceptObserved: accept.accepted,
    cancelObserved: !cancel.accepted && cancel.promptSha256 === accept.promptSha256,
    changedAfterAccept: (await storedSetting(page, id)) === after,
    id,
    promptSha256: accept.promptSha256,
    unchangedAfterCancel
  };
}

async function runConfirmation(page, action, accept) {
  const dialogPromise = new Promise((resolveDialog, rejectDialog) => {
    const timer = setTimeout(
      () => rejectDialog(new Error('Expected SiteWipe confirmation dialog did not appear.')),
      UI_SETTLE_TIMEOUT_MS
    );
    page.once('dialog', async (dialog) => {
      try {
        if (dialog.type() !== 'confirm') throw new Error('Expected one exact JavaScript confirmation dialog.');
        const message = dialog.message();
        if (accept) await dialog.accept();
        else await dialog.dismiss();
        clearTimeout(timer);
        resolveDialog({ accepted: accept, promptSha256: sha256(message) });
      } catch (error) {
        clearTimeout(timer);
        rejectDialog(error);
      }
    });
  });
  const actionPromise = action();
  const result = await dialogPromise;
  await actionPromise;
  return result;
}

async function setVisibleSettingAndWait(page, key, attempted, expected) {
  if (Object.hasOwn(SETTINGS_SEMANTIC_CONTRACT.selectOptions, key)) {
    return setSelectAndWait(page, key, attempted, expected);
  }
  if (key === 'associatedDomainGroups') return setTextareaAndWait(page, key, attempted, expected);
  return setCheckboxAndWait(page, key, attempted, expected);
}

async function setCheckboxAndWait(page, id, attempted, expected) {
  const current = await page.$eval(`#${id}`, (control) => control.checked);
  if (current !== attempted) await page.click(`#${id}`);
  await waitForStoredSetting(page, id, expected);
}

async function setSelectAndWait(page, id, attempted, expected) {
  await page.select(`#${id}`, String(attempted));
  await waitForStoredSetting(page, id, expected);
}

async function setTextareaAndWait(page, id, attempted, expected) {
  await page.$eval(
    `#${id}`,
    (control, value) => {
      control.value = value;
      control.dispatchEvent(new Event('input', { bubbles: true }));
      control.dispatchEvent(new Event('change', { bubbles: true }));
    },
    attempted
  );
  await waitForStoredSetting(page, id, expected);
}

async function waitForStoredSetting(page, key, expected) {
  await page.waitForFunction(
    async ({ expectedValue, settingKey, storageKey }) => {
      const stored = await chrome.storage.local.get([storageKey]);
      return JSON.stringify(stored[storageKey]?.[settingKey]) === JSON.stringify(expectedValue);
    },
    { timeout: UI_SETTLE_TIMEOUT_MS },
    { expectedValue: expected, settingKey: key, storageKey: SETTINGS_STORAGE_KEY }
  );
}

async function storedSetting(page, key) {
  return page.evaluate(
    async ({ settingKey, storageKey }) => (await chrome.storage.local.get([storageKey]))[storageKey]?.[settingKey],
    { settingKey: key, storageKey: SETTINGS_STORAGE_KEY }
  );
}

async function sendOptionsMessage(page, type, payload) {
  return page.evaluate(
    async ({ messagePayload, messageType }) => {
      const requestId = crypto.randomUUID();
      const response = await chrome.runtime.sendMessage({
        protocolVersion: 1,
        requestId,
        type: messageType,
        payload: messagePayload
      });
      if (!response || response.protocolVersion !== 1 || response.requestId !== requestId || response.ok !== true) {
        throw new Error(response?.error || 'SiteWipe options message did not return an exact successful envelope.');
      }
      return response;
    },
    { messagePayload: payload, messageType: type }
  );
}

async function restoreExerciseSettings(page, safetyMonitor) {
  const settings = { ...SETTINGS_SEMANTIC_CONTRACT.exerciseValues, embeddedFrameDiscovery: false };
  await sendOptionsMessage(page, 'sitewipe.saveSettings', { settings });
  await reloadMonitoredOptionsPage(page, safetyMonitor);
  for (const key of VISIBLE_SETTINGS) {
    const expected = key === 'embeddedFrameDiscovery' ? false : SETTINGS_SEMANTIC_CONTRACT.exerciseValues[key];
    await waitForStoredSetting(page, key, expected);
  }
}

async function exerciseImportExport({ artifactVersion, cell, page, expectedSettings }) {
  const beforeInventory = await captureOwnedDownloadInventory(cell);
  const before = new Set(beforeInventory.entries.map(({ name }) => name));
  await page.click('#exportSettings');
  const exportedFile = await waitForOneOwnedExport(cell, before, beforeInventory.directoryIdentitySha256);
  const exportedName = exportedFile.name;
  const exportedBytes = exportedFile.bytes;
  if (exportedBytes.length <= 0 || exportedBytes.length > SETTINGS_BACKUP_MAX_BYTES) {
    throw new Error('Authentic settings export is empty or exceeds its exact byte limit.');
  }
  const exported = JSON.parse(exportedBytes.toString('utf8'));
  if (
    exported.schema !== SETTINGS_BACKUP_SCHEMA ||
    exported.schemaVersion !== 1 ||
    exported.app !== 'SiteWipe' ||
    exported.appVersion !== artifactVersion ||
    !exported.settings ||
    typeof exported.settings !== 'object' ||
    Array.isArray(exported.settings)
  ) {
    throw new Error('Authentic settings export differs from the exact SiteWipe backup contract.');
  }
  const exportNamesAfter = (await captureOwnedDownloadInventory(cell)).entries.map(({ name }) => name);
  const expectedVisible = selectSettings(expectedSettings, VISIBLE_SETTINGS);
  if (stableJson(exported.settings) !== stableJson(expectedVisible)) {
    throw new Error('Authentic settings export differs from the exercised installed settings.');
  }

  const importPayload = structuredClone(exported);
  importPayload.settings.debugLog = false;
  importPayload.settings.unknownFutureSetting = true;
  const importBytes = Buffer.from(`${JSON.stringify(importPayload, null, 2)}\n`, 'utf8');
  if (importBytes.length > SETTINGS_BACKUP_MAX_BYTES)
    throw new Error('Synthetic settings import exceeds its byte limit.');
  const importPath = resolve(cell.downloadPath, SYNTHETIC_IMPORT_NAME);
  const importFile = await createExactOwnedImportFile(cell, importBytes, beforeInventory.directoryIdentitySha256);

  const beforeImportSha256 = sha256(
    canonicalJsonBytes(selectSettings((await captureOptionsSnapshot(page)).settings, VISIBLE_SETTINGS))
  );
  const cancel = await uploadSettingsImport(page, importPath, false);
  const afterCancelSha256 = sha256(
    canonicalJsonBytes(selectSettings((await captureOptionsSnapshot(page)).settings, VISIBLE_SETTINGS))
  );
  const accept = await uploadSettingsImport(page, importPath, true);
  await waitForStoredSetting(page, 'debugLog', false);
  const stored = (await captureOptionsSnapshot(page)).settings;
  return {
    exportBytes: exportedBytes.length,
    exportDownloadEntryCountAdded: exportNamesAfter.filter((name) => !before.has(name)).length,
    exportSchema: exported.schema,
    exportSchemaVersion: exported.schemaVersion,
    exportEntryName: exportedName,
    exportFileSha256: sha256(exportedBytes),
    exportIdentitySha256: exportedFile.identitySha256,
    exportSettingsSha256: sha256(canonicalJsonBytes(exported.settings)),
    exportUserSettingCount: Object.keys(exported.settings).length,
    exported: true,
    importAcceptApplied: accept.accepted === true && stored.debugLog === false,
    importCancelPreserved:
      cancel.accepted === false &&
      cancel.promptSha256 === accept.promptSha256 &&
      beforeImportSha256 === afterCancelSha256,
    importRecognizedSettingCount: Object.keys(exported.settings).length,
    importFileSha256: importFile.sha256,
    importIdentitySha256: importFile.identitySha256,
    importUnknownIgnoredCount: Object.hasOwn(stored, 'unknownFutureSetting') ? 0 : 1,
    ownedSyntheticImportUsed: true
  };
}

async function uploadSettingsImport(page, importPath, accept) {
  const input = await page.$('#settingsImportFile');
  if (!input || typeof input.uploadFile !== 'function') {
    throw new Error('Installed Options did not expose its exact settings import file control.');
  }
  return runConfirmation(page, () => input.uploadFile(importPath), accept);
}

async function waitForOneOwnedExport(cell, before, expectedDirectoryIdentitySha256) {
  const deadline = Date.now() + UI_SETTLE_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    const directory = await captureOwnedDirectoryIdentity(cell);
    if (directory.identitySha256 !== expectedDirectoryIdentitySha256) {
      throw new Error('SETTINGS-01 owned download parent identity changed while waiting for export.');
    }
    const names = await enumerateExactOwnedDirectory(directory);
    const candidates = names.filter((name) => !before.has(name) && /^sitewipe-settings-\d+\.json$/u.test(name));
    if (candidates.length === 1) {
      const first = await readExactOwnedFile(directory, candidates[0], 'SETTINGS-01 browser export');
      if (first.bytes.length > 0) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        const second = await readExactOwnedFile(directory, candidates[0], 'SETTINGS-01 browser export');
        if (first.identitySha256 === second.identitySha256 && first.sha256 === second.sha256) {
          return second;
        }
      }
    }
    if (candidates.length > 1) throw new Error('Settings export created an ambiguous owned download set.');
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error('Authentic settings export did not create one bounded owned JSON download.');
}

async function exerciseMalformedAssociatedGroups(page) {
  const malformed = 'not-a-group';
  await setTextareaAndWait(page, 'associatedDomainGroups', malformed, malformed);
  await page.waitForFunction(
    () => document.querySelector('#associatedDomainGroups')?.getAttribute('aria-invalid') === 'true',
    { timeout: UI_SETTLE_TIMEOUT_MS }
  );
  const validation = await sendOptionsMessage(page, 'sitewipe.validateAssociatedGroups', { groupsText: malformed });
  const syntaxDom = await page.evaluate(() => ({
    ariaInvalid: document.querySelector('#associatedDomainGroups')?.getAttribute('aria-invalid') === 'true',
    diagnosticErrorTone: document.querySelector('#associatedGroupsDiagnostics')?.classList.contains('error') === true
  }));
  const storedMalformed = await storedSetting(page, 'associatedDomainGroups');

  const longLines = Array.from(
    { length: 51 },
    (_value, index) => `${String(index).padStart(2, '0')}${'x'.repeat(499)}`
  );
  const oversized = longLines.join('\n');
  await setTextareaAndWait(
    page,
    'associatedDomainGroups',
    oversized,
    longLines
      .slice(0, 50)
      .map((line) => line.slice(0, 500))
      .join('\n')
  );
  await page.waitForFunction(
    () => /Storage limit:/u.test(document.querySelector('#associatedGroupsDiagnostics')?.textContent || ''),
    { timeout: UI_SETTLE_TIMEOUT_MS }
  );
  const storedBounded = await storedSetting(page, 'associatedDomainGroups');
  const retainedLines = String(storedBounded || '').split('\n');
  const diagnosticBoundReported = await page.$eval('#associatedGroupsDiagnostics', (element) =>
    /Storage limit:/u.test(element.textContent || '')
  );
  return {
    safetyToggleExercised: SETTINGS_SEMANTIC_CONTRACT.exerciseValues.blockOnAssociatedGroupErrors === false,
    storageBounds: {
      diagnosticBoundReported,
      ignoredLineCount: longLines.length - retainedLines.length,
      inputLineCount: longLines.length,
      maxStoredLineCharacters: Math.max(...retainedLines.map((line) => line.length)),
      retainedLineCount: retainedLines.length,
      shortenedLineCount: retainedLines.filter((line) => line.length === 500).length
    },
    syntax: {
      ariaInvalid: syntaxDom.ariaInvalid,
      diagnosticErrorTone: syntaxDom.diagnosticErrorTone,
      errorCount: Array.isArray(validation.validation?.errors) ? validation.validation.errors.length : 0,
      storedInputBounded: typeof storedMalformed === 'string' && storedMalformed.length <= 500
    }
  };
}

async function waitForVisibleDefaults(page) {
  await page.waitForFunction(
    async ({ defaults, settingsKey, visibleSettings }) => {
      const stored = (await chrome.storage.local.get([settingsKey]))[settingsKey] || {};
      return visibleSettings.every((key) => JSON.stringify(stored[key]) === JSON.stringify(defaults[key]));
    },
    { timeout: UI_SETTLE_TIMEOUT_MS },
    { defaults: SETTINGS_DEFAULTS, settingsKey: SETTINGS_STORAGE_KEY, visibleSettings: VISIBLE_SETTINGS }
  );
}

function assertFreshVisibleDefaults(settings) {
  if (!visibleSettingsMatchDefaults(settings)) {
    throw new Error('Fresh installed Options settings differ from the exact production defaults.');
  }
  for (const key of INTERNAL_SETTINGS.filter((candidate) => candidate !== 'mainWorldPageScrub')) {
    if (!isIsoTimestamp(settings[key])) {
      throw new Error(`Fresh installed internal setting ${key} is not its exact initialized timestamp state.`);
    }
  }
  if (settings.mainWorldPageScrub !== false) {
    throw new Error('Retired MAIN-world page scrub is not safely forced off.');
  }
}

function visibleSettingsMatchDefaults(settings) {
  return VISIBLE_SETTINGS.every(
    (key) => stableJson(normalizedSettingValue(key, settings[key])) === stableJson(SETTINGS_DEFAULTS[key])
  );
}

function normalizedSettingValue(key, value) {
  return NUMERIC_VISIBLE_SETTINGS.has(key) ? Number(value) : value;
}

function internalSettingState(key, value) {
  if (key === 'mainWorldPageScrub') return value === false ? 'false' : 'other';
  if (value === null) return 'null';
  return isIsoTimestamp(value) ? 'timestamp' : 'other';
}

function resetInternalSettingValid(key, value) {
  if (key === 'mainWorldPageScrub') return value === false;
  if (
    [
      'stabilityDefaultsAppliedAt',
      'performanceDefaultsAppliedAt',
      'privacyDefaultsAppliedAt',
      'storagePartitionDisclosureAppliedAt'
    ].includes(key)
  ) {
    return value === null || isIsoTimestamp(value);
  }
  return isIsoTimestamp(value);
}

export async function captureOwnedDownloadInventory(cell, testHooks = null) {
  if (
    !cell ||
    typeof cell !== 'object' ||
    typeof cell.downloadPath !== 'string' ||
    typeof cell.canaryPath !== 'string' ||
    !SHA256_PATTERN.test(String(cell.canarySha256 || ''))
  ) {
    throw new Error('SETTINGS-01 owned download cell identity is incomplete.');
  }
  if (testHooks !== null) {
    assertExactKeys(
      testHooks,
      ['afterParentCapture', 'beforeFinalEnumeration'],
      'SETTINGS-01 owned-download test hooks'
    );
    for (const key of ['afterParentCapture', 'beforeFinalEnumeration']) {
      if (testHooks[key] !== null && typeof testHooks[key] !== 'function') {
        throw new Error('SETTINGS-01 owned-download test hook is malformed.');
      }
    }
  }
  const directory = await captureOwnedDirectoryIdentity(cell);
  if (testHooks?.afterParentCapture) await testHooks.afterParentCapture();
  const names = await enumerateExactOwnedDirectory(directory);
  const entries = [];
  let exactMarkerBytes = null;
  for (const name of names) {
    if (!isSafeOwnedEntryName(name)) throw new Error('SETTINGS-01 owned download entry name is unsafe.');
    const file = await readExactOwnedFile(directory, name, 'SETTINGS-01 owned download entry');
    entries.push({
      bytes: file.bytes.length,
      identitySha256: file.identitySha256,
      name,
      sha256: file.sha256
    });
    if (name === OWNED_DIRECTORY_MARKER_NAME) exactMarkerBytes = Buffer.from(file.bytes);
  }
  if (testHooks?.beforeFinalEnumeration) await testHooks.beforeFinalEnumeration();
  const finalNames = await enumerateExactOwnedDirectory(directory);
  if (stableJson(finalNames) !== stableJson(names)) {
    throw new Error('SETTINGS-01 owned download entry set changed during its final enumeration.');
  }
  for (const entry of entries) await revalidateExactOwnedFile(directory, entry);
  const marker = entries.find(({ name }) => name === OWNED_DIRECTORY_MARKER_NAME);
  const canary = entries.find(({ name }) => name === DOWNLOAD_CANARY_NAME);
  if (
    !marker ||
    !canary ||
    exactMarkerBytes === null ||
    canary.bytes !== 32 ||
    canary.sha256 !== cell.canarySha256 ||
    !sameHostPath(cell.canaryPath, resolve(directory.actualPath, DOWNLOAD_CANARY_NAME))
  ) {
    throw new Error('SETTINGS-01 owned download marker or must-preserve canary changed.');
  }
  let markerValue;
  try {
    markerValue = JSON.parse(exactMarkerBytes.toString('utf8'));
  } catch (error) {
    throw new Error('SETTINGS-01 owned download marker is malformed JSON.', { cause: error });
  }
  if (!exactMarkerBytes.equals(canonicalJsonBytes(markerValue))) {
    throw new Error('SETTINGS-01 owned download marker is not canonical JSON.');
  }
  assertExactKeys(
    markerValue,
    ['browserName', 'canarySha256', 'kind', 'planSha256', 'runId', 'scenarioId', 'schema'],
    'SETTINGS-01 owned download marker'
  );
  if (
    markerValue.schema !== 'sitewipe.owned-browser-directory.v1' ||
    markerValue.kind !== 'downloads' ||
    markerValue.runId !== cell.runId ||
    markerValue.planSha256 !== cell.planSha256 ||
    markerValue.browserName !== cell.browserName ||
    markerValue.scenarioId !== SETTINGS_SCENARIO_ID ||
    markerValue.canarySha256 !== cell.canarySha256
  ) {
    throw new Error('SETTINGS-01 owned download marker differs from the exact staged cell.');
  }
  return deepFreeze({
    canarySha256: canary.sha256,
    directoryIdentitySha256: directory.identitySha256,
    entries,
    inventorySha256: sha256(canonicalJsonBytes(entries))
  });
}

export async function exactOwnedPathStat(path, statImplementation = nativeLstat) {
  if (typeof statImplementation !== 'function') {
    throw new Error('SETTINGS-01 exact path-stat implementation is unavailable.');
  }
  return statImplementation(path, EXACT_STAT_OPTIONS);
}

export async function exactOwnedHandleStat(handle) {
  if (!handle || typeof handle.stat !== 'function') {
    throw new Error('SETTINGS-01 exact handle-stat capability is unavailable.');
  }
  return handle.stat(EXACT_STAT_OPTIONS);
}

async function captureOwnedDirectoryIdentity(cell) {
  const expectedPath = resolve(cell.downloadPath);
  const before = await exactOwnedPathStat(expectedPath);
  assertPhysicalOwnedDirectory(before, 'SETTINGS-01 owned download container');
  const actualPath = await realpath(expectedPath);
  if (!sameHostPath(actualPath, expectedPath)) {
    throw new Error('SETTINGS-01 owned download container is aliased or reparse-backed.');
  }
  const after = await exactOwnedPathStat(actualPath);
  assertPhysicalOwnedDirectory(after, 'SETTINGS-01 owned download container');
  if (!sameDirectoryIdentity(before, after)) {
    throw new Error('SETTINGS-01 owned download parent identity changed while resolving.');
  }
  return Object.freeze({
    actualPath,
    expectedPath,
    identity: directoryIdentityRecord(after),
    identitySha256: sha256(canonicalJsonBytes(directoryIdentityRecord(after)))
  });
}

async function revalidateOwnedDirectory(directory, label) {
  const before = await exactOwnedPathStat(directory.expectedPath);
  assertPhysicalOwnedDirectory(before, label);
  const actual = await realpath(directory.expectedPath);
  const after = await exactOwnedPathStat(actual);
  assertPhysicalOwnedDirectory(after, label);
  if (
    !sameHostPath(actual, directory.actualPath) ||
    !sameDirectoryIdentity(before, after) ||
    sha256(canonicalJsonBytes(directoryIdentityRecord(after))) !== directory.identitySha256
  ) {
    throw new Error(`${label} physical parent identity changed.`);
  }
}

async function enumerateExactOwnedDirectory(directory) {
  await revalidateOwnedDirectory(directory, 'SETTINGS-01 owned download enumeration parent');
  const names = (await readdir(directory.actualPath)).sort();
  await revalidateOwnedDirectory(directory, 'SETTINGS-01 owned download enumeration parent');
  if (names.some((name) => !isSafeOwnedEntryName(name))) {
    throw new Error('SETTINGS-01 owned download enumeration returned an unsafe name.');
  }
  return names;
}

async function readExactOwnedFile(directory, name, label) {
  if (!isSafeOwnedEntryName(name)) throw new Error(`${label} name is unsafe.`);
  await revalidateOwnedDirectory(directory, `${label} parent`);
  const expected = resolve(directory.actualPath, name);
  const before = await exactOwnedPathStat(expected);
  assertPhysicalOwnedFile(before, label);
  const actual = await realpath(expected);
  if (!sameHostPath(actual, expected)) throw new Error(`${label} is aliased or reparse-backed.`);
  await revalidateOwnedDirectory(directory, `${label} parent`);
  const handle = await open(actual, 'r');
  try {
    const opened = await exactOwnedHandleStat(handle);
    assertPhysicalOwnedFile(opened, label);
    const bytes = await handle.readFile();
    const after = await exactOwnedHandleStat(handle);
    assertPhysicalOwnedFile(after, label);
    const pathAfter = await exactOwnedPathStat(expected);
    const realAfter = await realpath(expected);
    await revalidateOwnedDirectory(directory, `${label} parent`);
    if (
      !sameHostPath(realAfter, expected) ||
      !sameFileIdentity(before, opened) ||
      !sameFileIdentity(opened, after) ||
      !sameFileIdentity(after, pathAfter) ||
      after.size !== BigInt(bytes.length)
    ) {
      throw new Error(`${label} identity changed while it was opened and read.`);
    }
    return {
      bytes,
      identitySha256: sha256(canonicalJsonBytes(fileIdentityRecord(after))),
      name,
      sha256: sha256(bytes)
    };
  } finally {
    await handle.close();
  }
}

async function revalidateExactOwnedFile(directory, entry) {
  await revalidateOwnedDirectory(directory, 'SETTINGS-01 final owned-file validation parent');
  const expected = resolve(directory.actualPath, entry.name);
  const stat = await exactOwnedPathStat(expected);
  assertPhysicalOwnedFile(stat, 'SETTINGS-01 final owned-file validation');
  const actual = await realpath(expected);
  if (
    !sameHostPath(actual, expected) ||
    sha256(canonicalJsonBytes(fileIdentityRecord(stat))) !== entry.identitySha256
  ) {
    throw new Error('SETTINGS-01 owned file was substituted before final inventory settlement.');
  }
  await revalidateOwnedDirectory(directory, 'SETTINGS-01 final owned-file validation parent');
}

export async function createExactOwnedImportFile(
  cell,
  bytes,
  expectedDirectoryIdentitySha256,
  testAfterClose = null,
  testBeforeClose = null
) {
  if (
    (testAfterClose !== null && typeof testAfterClose !== 'function') ||
    (testBeforeClose !== null && typeof testBeforeClose !== 'function')
  ) {
    throw new Error('SETTINGS-01 owned import test hook is malformed.');
  }
  const directory = await captureOwnedDirectoryIdentity(cell);
  if (directory.identitySha256 !== expectedDirectoryIdentitySha256) {
    throw new Error('SETTINGS-01 owned download parent changed before import creation.');
  }
  await revalidateOwnedDirectory(directory, 'SETTINGS-01 import creation parent');
  const expected = resolve(directory.actualPath, SYNTHETIC_IMPORT_NAME);
  const handle = await open(expected, 'wx', 0o600);
  let writtenIdentity;
  try {
    const opened = await exactOwnedHandleStat(handle);
    assertPhysicalOwnedFile(opened, 'SETTINGS-01 owned import');
    const pathOpened = await exactOwnedPathStat(expected);
    if (!sameFileIdentity(opened, pathOpened)) {
      throw new Error('SETTINGS-01 owned import path differs from its exclusive open handle.');
    }
    await revalidateOwnedDirectory(directory, 'SETTINGS-01 import creation parent');
    await handle.writeFile(bytes);
    await handle.sync();
    if (testBeforeClose) await testBeforeClose(expected);
    const written = await exactOwnedHandleStat(handle);
    assertPhysicalOwnedFile(written, 'SETTINGS-01 owned import');
    const writtenPath = await exactOwnedPathStat(expected);
    const writtenRealPath = await realpath(expected);
    await revalidateOwnedDirectory(directory, 'SETTINGS-01 import creation parent after write');
    if (
      written.size !== BigInt(bytes.length) ||
      !sameFileIdentity(written, writtenPath) ||
      !sameHostPath(writtenRealPath, expected)
    ) {
      throw new Error('SETTINGS-01 owned import changed before its retained handle was closed.');
    }
    writtenIdentity = sha256(canonicalJsonBytes(fileIdentityRecord(written)));
  } finally {
    await handle.close();
  }
  if (testAfterClose) await testAfterClose(expected);
  const reopened = await readExactOwnedFile(directory, SYNTHETIC_IMPORT_NAME, 'SETTINGS-01 owned import');
  if (
    reopened.identitySha256 !== writtenIdentity ||
    reopened.sha256 !== sha256(bytes) ||
    !reopened.bytes.equals(bytes)
  ) {
    throw new Error('SETTINGS-01 owned import changed during close and exact reopen verification.');
  }
  await revalidateOwnedDirectory(directory, 'SETTINGS-01 import creation parent');
  return reopened;
}

function assertPhysicalOwnedDirectory(stat, label) {
  if (
    !stat?.isDirectory() ||
    stat.isSymbolicLink() ||
    !hasExactBigIntFields(stat, ['birthtimeNs', 'dev', 'ino', 'mode', 'nlink']) ||
    stat.dev < 0n ||
    stat.ino < 0n ||
    stat.mode < 0n ||
    stat.nlink < 1n
  ) {
    throw new Error(`${label} is not one physical non-reparse directory.`);
  }
}

function assertPhysicalOwnedFile(stat, label) {
  if (
    !stat?.isFile() ||
    stat.isSymbolicLink() ||
    !hasExactBigIntFields(stat, ['birthtimeNs', 'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink', 'size']) ||
    stat.dev < 0n ||
    stat.ino < 0n ||
    stat.mode < 0n ||
    stat.nlink !== 1n ||
    stat.size < 0n
  ) {
    throw new Error(`${label} is not one singly linked physical non-reparse file.`);
  }
}

export function directoryIdentityRecord(stat) {
  return {
    birthtimeNs: exactBigIntDecimal(stat.birthtimeNs, 'birthtimeNs'),
    dev: exactBigIntDecimal(stat.dev, 'dev'),
    ino: exactBigIntDecimal(stat.ino, 'ino'),
    mode: exactBigIntDecimal(stat.mode, 'mode'),
    nlink: exactBigIntDecimal(stat.nlink, 'nlink')
  };
}

export function fileIdentityRecord(stat) {
  return {
    ...directoryIdentityRecord(stat),
    ctimeNs: exactBigIntDecimal(stat.ctimeNs, 'ctimeNs'),
    mtimeNs: exactBigIntDecimal(stat.mtimeNs, 'mtimeNs'),
    size: exactBigIntDecimal(stat.size, 'size')
  };
}

function exactBigIntDecimal(value, field) {
  if (typeof value !== 'bigint') {
    throw new Error(`SETTINGS-01 exact filesystem identity ${field} is not a bigint.`);
  }
  return value.toString(10);
}

function hasExactBigIntFields(value, fields) {
  return Boolean(value) && fields.every((field) => typeof value[field] === 'bigint');
}

function assertPristineOwnedDownloadInventory(inventory, cell) {
  assertOwnedDownloadInventory(inventory, 'Pristine SETTINGS-01 owned downloads');
  const expected = [DOWNLOAD_CANARY_NAME, OWNED_DIRECTORY_MARKER_NAME].sort();
  if (
    stableJson(inventory.entries.map(({ name }) => name)) !== stableJson(expected) ||
    inventory.canarySha256 !== cell.canarySha256
  ) {
    throw new Error('SETTINGS-01 owned download container was not pristine before settings work.');
  }
}

function assertOwnedDownloadInventory(inventory, label) {
  assertExactKeys(inventory, ['canarySha256', 'directoryIdentitySha256', 'entries', 'inventorySha256'], label);
  if (
    !SHA256_PATTERN.test(inventory.canarySha256) ||
    !SHA256_PATTERN.test(inventory.directoryIdentitySha256) ||
    !SHA256_PATTERN.test(inventory.inventorySha256)
  ) {
    throw new Error(`${label} SHA-256 identity is malformed.`);
  }
  if (!Array.isArray(inventory.entries) || inventory.entries.length < 2 || inventory.entries.length > 8) {
    throw new Error(`${label} entry set is outside its exact bound.`);
  }
  let previous = '';
  for (const entry of inventory.entries) {
    assertExactKeys(entry, ['bytes', 'identitySha256', 'name', 'sha256'], `${label} entry`);
    if (
      !isSafeOwnedEntryName(entry.name) ||
      entry.name <= previous ||
      !Number.isInteger(entry.bytes) ||
      entry.bytes < 1 ||
      !SHA256_PATTERN.test(entry.sha256) ||
      !SHA256_PATTERN.test(entry.identitySha256)
    ) {
      throw new Error(`${label} entry identity is malformed or unordered.`);
    }
    previous = entry.name;
  }
  if (inventory.inventorySha256 !== sha256(canonicalJsonBytes(inventory.entries))) {
    throw new Error(`${label} inventory SHA-256 does not match its exact entries.`);
  }
}

async function startSettingsNativePromptObserver(launched) {
  const identity = launched?.receipt?.processIdentity;
  if (
    !identity ||
    !Number.isInteger(identity.processId) ||
    identity.processId <= 0 ||
    typeof identity.path !== 'string' ||
    !SHA256_PATTERN.test(String(identity.sha256 || '')) ||
    !/^\d+$/u.test(String(identity.startTimeUtcTicks || ''))
  ) {
    throw new Error('SETTINGS-01 launch receipt lacks exact browser process identity for no-prompt observation.');
  }
  return startNativePermissionPromptHelper({
    targetProcessId: identity.processId,
    expectedProcessPath: identity.path,
    expectedProcessSha256: identity.sha256,
    expectedProcessStartTimeUtcTicks: identity.startTimeUtcTicks,
    scheduleId: SETTINGS_NATIVE_SCHEDULE_ID
  });
}

function assertSettingsNativeObserverReady(observer) {
  if (!observer || typeof observer !== 'object' || typeof observer.settle !== 'function') {
    throw new Error('SETTINGS-01 no-prompt observer lacks its exact bounded settlement capability.');
  }
  assertSettingsNativeReadiness(observer.readiness);
  return deepFreeze(structuredClone(observer.readiness));
}

function assertSettingsNativeReadiness(readiness) {
  if (
    !readiness ||
    readiness.schema !== 'sitewipe.native-permission-helper-ready.v1' ||
    readiness.status !== 'ready' ||
    readiness.scheduleId !== SETTINGS_NATIVE_SCHEDULE_ID ||
    readiness.scenarioId !== SETTINGS_SCENARIO_ID ||
    readiness.action !== 'observe-none' ||
    Number.isNaN(Date.parse(String(readiness.readyAt || '')))
  ) {
    throw new Error('SETTINGS-01 native no-prompt observer readiness is absent or inexact.');
  }
}

async function settleSettingsNativePromptObserver(observer) {
  if (!observer || typeof observer !== 'object' || typeof observer.settle !== 'function') {
    throw new Error('SETTINGS-01 no-prompt observer lacks its exact bounded settlement capability.');
  }
  const evidence = await observer.settle();
  if (
    evidence?.schema !== 'sitewipe.native-permission-dialog-evidence.v1' ||
    evidence.status !== 'no_prompt_observed' ||
    evidence.scheduleId !== SETTINGS_NATIVE_SCHEDULE_ID ||
    evidence.scenarioId !== SETTINGS_SCENARIO_ID ||
    evidence.action !== 'observe-none' ||
    Number.isNaN(Date.parse(String(evidence.observationStartedAt || ''))) ||
    Number.isNaN(Date.parse(String(evidence.stopRequestedAt || ''))) ||
    Number.isNaN(Date.parse(String(evidence.observedAt || ''))) ||
    evidence.observationStartedAt !== observer.readiness?.readyAt ||
    Date.parse(evidence.observationStartedAt) > Date.parse(evidence.stopRequestedAt) ||
    Date.parse(evidence.stopRequestedAt) > Date.parse(evidence.observedAt)
  ) {
    throw new Error('SETTINGS-01 native observation did not cover the complete settings interaction interval.');
  }
  return evidence;
}

async function cancelSettingsNativePromptObserver(observer) {
  if (!observer || typeof observer !== 'object' || typeof observer.cancelAndWait !== 'function') {
    throw new Error('SETTINGS-01 no-prompt observer lacks its exact bounded cancellation capability.');
  }
  const settlement = await observer.cancelAndWait();
  if (
    settlement?.schema !== 'sitewipe.native-permission-helper-settlement.v1' ||
    !Number.isInteger(settlement.processId) ||
    settlement.processId <= 0 ||
    !['already_settled', 'terminated_and_settled'].includes(settlement.status)
  ) {
    throw new Error('SETTINGS-01 native observer cancellation did not settle its exact helper child.');
  }
}

function assertCertainCleanSettingsClose(receipt, context, launched) {
  const expectedCanarySha256 = context.cell.canarySha256;
  assertExactKeys(
    receipt,
    [
      'automaticDownloadDeletionPerformed',
      'automaticProfileDeletionPerformed',
      'browserName',
      'closeStartedAt',
      'gracefulCloseError',
      'mustPreserveDownloadCanary',
      'observationStatus',
      'observedAt',
      'planSha256',
      'processResidue',
      'profileProcessResidueCount',
      'runId',
      'schema',
      'semanticValidationStatus',
      'semanticValidatorManifestSha256'
    ],
    'SETTINGS-01 browser close observation'
  );
  assertExactKeys(
    receipt.mustPreserveDownloadCanary,
    ['expectedSha256', 'observedSha256', 'path', 'preserved'],
    'SETTINGS-01 close canary observation'
  );
  const processIdentity = launched.receipt?.processIdentity;
  validateWindowsProfileResidueObservation(receipt.processResidue, {
    processId: processIdentity?.processId,
    expectedProcessPath: processIdentity?.path,
    expectedProcessSha256: processIdentity?.sha256,
    expectedProcessStartTimeUtcTicks: processIdentity?.startTimeUtcTicks,
    expectedProfilePath: context.cell.profilePath
  });
  if (
    receipt?.schema !== 'sitewipe.installed-browser-close-observation.v1' ||
    receipt.runId !== context.plan.runId ||
    receipt.planSha256 !== context.plan.planSha256 ||
    receipt.browserName !== context.browser.name ||
    receipt.observationStatus !== 'clean' ||
    receipt.gracefulCloseError !== null ||
    receipt.profileProcessResidueCount !== 0 ||
    !Array.isArray(receipt.processResidue?.residues) ||
    receipt.processResidue.residues.length !== 0 ||
    receipt.mustPreserveDownloadCanary?.expectedSha256 !== expectedCanarySha256 ||
    receipt.mustPreserveDownloadCanary?.observedSha256 !== expectedCanarySha256 ||
    receipt.mustPreserveDownloadCanary?.preserved !== true ||
    !sameHostPath(receipt.mustPreserveDownloadCanary?.path, context.cell.canaryPath) ||
    receipt.automaticProfileDeletionPerformed !== false ||
    receipt.automaticDownloadDeletionPerformed !== false ||
    receipt.semanticValidationStatus !== SEMANTIC_VALIDATION_STATUS ||
    receipt.semanticValidatorManifestSha256 !== SEMANTIC_VALIDATOR_MANIFEST_SHA256 ||
    Number.isNaN(Date.parse(String(receipt.closeStartedAt || ''))) ||
    Number.isNaN(Date.parse(String(receipt.observedAt || ''))) ||
    Date.parse(receipt.observedAt) < Date.parse(receipt.closeStartedAt) ||
    launched.receipt?.runId !== receipt.runId ||
    launched.receipt?.planSha256 !== receipt.planSha256 ||
    launched.receipt?.browserName !== receipt.browserName
  ) {
    throw new Error('SETTINGS-01 browser teardown is uncertain; no semantic assertion may be emitted.');
  }
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(value) && Number.isFinite(Date.parse(value));
}

function selectSettings(settings, keys) {
  return Object.fromEntries(keys.map((key) => [key, settings?.[key]]));
}

function validateSettingsSession(session) {
  assertExactKeys(session, SESSION_KEYS, 'Settings-scenario authentic session');
  assertExactKeys(session.payloads, SELECT_ASSERTION_IDS, 'Settings-scenario semantic payload set');
  assertExactKeys(session.safety, SESSION_SAFETY_KEYS, 'Settings-scenario authentic safety set');
  assertSettingsSafetyBoundary(session.safety.beforeBoundary, 'Settings-scenario pre-boundary');
  assertSettingsSafetyBoundary(session.safety.afterBoundary, 'Settings-scenario post-boundary');
  assertOwnedDownloadInventory(session.safety.ownedDownloadsBefore, 'Settings-scenario pre-download inventory');
  assertOwnedDownloadInventory(
    session.safety.ownedDownloadsBeforeClose,
    'Settings-scenario pre-close download inventory'
  );
  assertSettingsNativeReadiness(session.safety.nativeReadiness);
  const nativeObservation = session.safety.nativeObservation;
  if (
    nativeObservation?.schema !== 'sitewipe.native-permission-dialog-evidence.v1' ||
    nativeObservation.status !== 'no_prompt_observed' ||
    nativeObservation.scheduleId !== SETTINGS_NATIVE_SCHEDULE_ID ||
    nativeObservation.scenarioId !== SETTINGS_SCENARIO_ID ||
    nativeObservation.action !== 'observe-none' ||
    nativeObservation.observationStartedAt !== session.safety.nativeReadiness.readyAt ||
    !isIsoTimestamp(nativeObservation.stopRequestedAt) ||
    !isIsoTimestamp(nativeObservation.observedAt)
  ) {
    throw new Error('Settings-scenario native no-prompt observation is incomplete or inexact.');
  }
  for (const [label, value] of [
    ['beforeCapturedAt', session.safety.beforeCapturedAt],
    ['afterCapturedAt', session.safety.afterCapturedAt]
  ]) {
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
      throw new Error(`Settings-scenario ${label} is not an exact timestamp.`);
    }
  }
  if (
    Date.parse(session.safety.nativeReadiness.readyAt) > Date.parse(session.safety.beforeCapturedAt) ||
    Date.parse(session.safety.beforeCapturedAt) > Date.parse(nativeObservation.observedAt) ||
    Date.parse(nativeObservation.observedAt) > Date.parse(session.safety.afterCapturedAt)
  ) {
    throw new Error('Settings-scenario safety and native-observer timestamps are not monotonically bound.');
  }
}

function assertLaunchedControllerView(value, context) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !value.browser ||
    !value.extension ||
    !value.receipt ||
    typeof value.triggerAction !== 'function' ||
    value.extension.id !== value.receipt.extensionId ||
    value.extension.version !== value.receipt.extensionVersion ||
    value.receipt.schema !== 'sitewipe.launched-installed-browser.v1' ||
    value.receipt.runId !== context.plan.runId ||
    value.receipt.planSha256 !== context.plan.planSha256 ||
    value.receipt.browserName !== context.browser.name ||
    !sameHostPath(value.receipt.downloadPath, context.cell.downloadPath) ||
    !sameHostPath(value.receipt.profilePath, context.cell.profilePath)
  ) {
    throw new Error('Settings-scenario launch did not return the exact runner controller view.');
  }
}

function settingsEvidenceId(assertionId) {
  return `settings-01.${assertionId.replaceAll('_', '-').toLowerCase()}`.slice(0, 128);
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const exact = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(exact)) {
    throw new Error(`${label} keys differ from the exact schema.`);
  }
}

function canonicalJsonBytes(value) {
  return Buffer.from(`${stableJson(value)}\n`, 'utf8');
}

function isSafeOwnedEntryName(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 255 &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('/') &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !isAbsolute(value)
  );
}

export function sameFileIdentity(left, right) {
  return (
    sameDirectoryIdentity(left, right) &&
    hasExactBigIntFields(left, ['ctimeNs', 'mtimeNs', 'size']) &&
    hasExactBigIntFields(right, ['ctimeNs', 'mtimeNs', 'size']) &&
    left.size === right.size &&
    left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export function sameDirectoryIdentity(left, right) {
  if (
    !hasExactBigIntFields(left, ['birthtimeNs', 'dev', 'ino', 'mode', 'nlink']) ||
    !hasExactBigIntFields(right, ['birthtimeNs', 'dev', 'ino', 'mode', 'nlink']) ||
    left.dev !== right.dev ||
    left.ino !== right.ino ||
    left.mode !== right.mode ||
    left.nlink !== right.nlink
  ) {
    return false;
  }
  return left.ino !== 0n || left.birthtimeNs === right.birthtimeNs;
}

function sameHostPath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

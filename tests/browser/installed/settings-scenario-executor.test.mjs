import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { INTERNAL_SETTINGS, SETTINGS_DEFAULTS, VISIBLE_SETTINGS, canonicalScenario } from './canonical-matrix.mjs';
import { SEMANTIC_VALIDATION_STATUS } from './evidence-contract.mjs';
import {
  SEMANTIC_VALIDATOR_MANIFEST_SHA256,
  SETTINGS_SEMANTIC_CONTRACT,
  deriveSemanticScenarioAssertions
} from './semantic-validator.mjs';
import {
  captureOwnedDownloadInventory,
  createExactOwnedImportFile,
  createSettingsScenarioExecutor,
  directoryIdentityRecord,
  exactOwnedHandleStat,
  exactOwnedPathStat,
  fileIdentityRecord,
  installSettingsSafetyMonitor,
  runAuthenticSettingsSession,
  sameDirectoryIdentity,
  sameFileIdentity
} from './settings-scenario-executor.mjs';
import {
  EXACT_ORIGIN_BROWSER_STORAGE_LIMITATION,
  SELECTED_SITE_PARTITION_STORAGE_DISCLOSURE
} from '../../../src/shared/storage-partition-policy.js';

const startedAt = '2026-08-25T15:00:00.000Z';
const completedAt = '2026-08-25T15:00:10.000Z';

test('strict fake session yields all 50 passing SETTINGS observations only through the post-close finalizer', async () => {
  let runSessionCount = 0;
  const context = sampleContext();
  const execute = createSettingsScenarioExecutor({
    captureOwnedDownloadInventory: async () => validOwnedInventory('after'),
    runSession: async (options) => {
      runSessionCount += 1;
      assert.deepEqual(Object.keys(options).sort(), [
        'artifactVersion',
        'browser',
        'cell',
        'extension',
        'nativeReadiness',
        'settleNativePromptObserver'
      ]);
      assert.equal(options.artifactVersion, '1.11.90');
      assert.equal(options.cell.downloadPath, 'D:\\owned-synthetic-downloads');
      return completeFakeSession(options);
    },
    startNativePromptObserver: async () => validNativeObserver()
  });

  const result = await executeAndFinalize(execute, context);
  assert.equal(runSessionCount, 1);
  assert.equal(result.reason, null);
  assert.equal(result.evidence.length, 50);
  assert.equal(new Set(result.evidence.map(({ id }) => id)).size, 50);

  const derived = deriveSemanticScenarioAssertions({
    result: {
      ...result,
      scenarioId: 'SETTINGS-01',
      runId: context.plan.runId,
      planSha256: context.plan.planSha256,
      identity: context.plan.identity
    }
  });
  assert.equal(derived.implementationStatus, 'implemented');
  assert.equal(derived.state, 'passed');
  assert.equal(derived.assertions.length, 50);
  assert.equal(
    derived.assertions.every(({ state }) => state === 'passed'),
    true
  );
});

test('executor rejects the wrong scenario, malformed controller, and inexact session payload set', async () => {
  const execute = createSettingsScenarioExecutor(fakeDependencies());
  const wrongScenario = sampleContext();
  wrongScenario.scenario = canonicalScenario('SMOKE-01');
  await assert.rejects(execute(wrongScenario), /only accepts the exact SETTINGS-01/i);

  const malformedController = sampleContext({ launched: { browser: {}, extension: {}, receipt: {} } });
  await assert.rejects(execute(malformedController), /exact runner controller view/i);

  const missingPayload = validPayloads();
  delete missingPayload['setting.cleanupMode'];
  const missing = createSettingsScenarioExecutor(
    fakeDependencies({
      runSession: async (options) => ({ ...(await completeFakeSession(options)), payloads: missingPayload })
    })
  );
  await assert.rejects(executeAndFinalize(missing, sampleContext()), /payload set keys differ/i);

  const extraPayload = validPayloads();
  extraPayload['settings.claimed_pass'] = { passed: true };
  const extra = createSettingsScenarioExecutor(
    fakeDependencies({
      runSession: async (options) => ({ ...(await completeFakeSession(options)), payloads: extraPayload })
    })
  );
  await assert.rejects(executeAndFinalize(extra, sampleContext()), /payload set keys differ/i);
});

test('a decisive fake-session mutation cannot become passed semantic evidence', async () => {
  const payloads = validPayloads();
  payloads['setting.deleteDownloadedFiles'].exercise.observedAfterSave = false;
  const execute = createSettingsScenarioExecutor(
    fakeDependencies({
      runSession: async (options) => ({ ...(await completeFakeSession(options)), payloads })
    })
  );
  const context = sampleContext();
  const result = await executeAndFinalize(execute, context);
  const derived = deriveSemanticScenarioAssertions({
    result: {
      ...result,
      scenarioId: 'SETTINGS-01',
      runId: context.plan.runId,
      planSha256: context.plan.planSha256,
      identity: context.plan.identity
    }
  });
  assert.equal(derived.assertions.find(({ id }) => id === 'setting.deleteDownloadedFiles')?.state, 'failed');
  assert.equal(derived.state, 'failed');
});

test('uncertain close rejects the cell before any SETTINGS evidence can be returned', async () => {
  let postCloseInventoryCount = 0;
  const context = sampleContext();
  const execute = createSettingsScenarioExecutor(
    fakeDependencies({
      captureOwnedDownloadInventory: async () => {
        postCloseInventoryCount += 1;
        return validOwnedInventory('after');
      }
    })
  );
  await assert.rejects(
    executeAndFinalize(execute, context, { ...validCloseReceipt(), observationStatus: 'attention_required' }),
    /teardown is uncertain; no semantic assertion may be emitted/i
  );
  assert.equal(postCloseInventoryCount, 0);
});

test('cross-bound close identity and early native observation remain non-evidence failures', async () => {
  const crossPlan = sampleContext();
  await assert.rejects(
    executeAndFinalize(createSettingsScenarioExecutor(fakeDependencies()), crossPlan, {
      ...validCloseReceipt(),
      planSha256: '7'.repeat(64)
    }),
    /teardown is uncertain; no semantic assertion may be emitted/i
  );

  const earlyNative = createSettingsScenarioExecutor(
    fakeDependencies({
      startNativePromptObserver: async () => ({
        readiness: validNativeReadiness(),
        cancelAndWait: async () => {
          throw new Error('settled observer must not be cancelled');
        },
        settle: async () => ({
          schema: 'sitewipe.native-permission-dialog-evidence.v1',
          status: 'no_prompt_observed',
          scheduleId: 'SETTINGS-01.observe-none',
          scenarioId: 'SETTINGS-01',
          action: 'observe-none',
          observationStartedAt: '2026-08-25T15:00:00.500Z',
          stopRequestedAt: '2026-08-25T15:00:00.700Z',
          observedAt: '2026-08-25T15:00:00.800Z'
        })
      })
    })
  );
  await assert.rejects(earlyNative(sampleContext()), /timestamps are not monotonically bound/i);
});

test('session failure cancels and waits for the exact observer before closing the browser', async () => {
  const events = [];
  const execute = createSettingsScenarioExecutor(
    fakeDependencies({
      runSession: async () => {
        events.push('session-failed');
        throw new Error('synthetic session failure');
      },
      startNativePromptObserver: async () => ({
        readiness: validNativeReadiness(),
        cancelAndWait: async () => {
          events.push('observer-cancelled');
          return {
            schema: 'sitewipe.native-permission-helper-settlement.v1',
            processId: 4321,
            status: 'terminated_and_settled'
          };
        },
        settle: async () => {
          throw new Error('settle must not be called after a session failure');
        }
      })
    })
  );
  const context = sampleContext();
  await assert.rejects(execute(context), /synthetic session failure/);
  assert.deepEqual(events, ['session-failed', 'observer-cancelled']);
});

test('a cleanup-authority mutation arriving while native settle completes remains non-evidence', async () => {
  const execute = createSettingsScenarioExecutor(
    fakeDependencies({
      runSession: async (options) => {
        const session = await completeFakeSession(options);
        session.safety.afterBoundary.localAuthority['sitewipe.activeJob.v1'] = { status: 'running' };
        session.safety.afterBoundary.monitorEvents.authorityStorageChangeCount = 1;
        return session;
      }
    })
  );
  const context = sampleContext();
  await assert.rejects(executeAndFinalize(execute, context), /changed cleanup authority/i);
});

test('preload monitor catches first-load mutation, retains counters across reloads, and observes transient DNR', async () => {
  const page = fakePreloadPage();
  const monitor = await installSettingsSafetyMonitor(page);
  await page.load({
    dynamicRules: [{ id: 1 }],
    afterPreload: ({ storageChanged }) =>
      storageChanged({ 'sitewipe.activeJob.v1': { newValue: { status: 'running' } } }, 'local')
  });
  await nextTurns();
  let snapshot = monitor.snapshot();
  assert.equal(snapshot.documentReadyCount, 1);
  assert.equal(snapshot.authorityStorageChangeCount, 1);
  assert.equal(snapshot.dnrPollNonemptyCount, 1);

  await page.load({
    afterPreload: ({ permissionAdded }) => permissionAdded({ permissions: ['webNavigation'] })
  });
  await nextTurns();
  snapshot = monitor.snapshot();
  assert.equal(snapshot.documentReadyCount, 2);
  assert.equal(snapshot.authorityStorageChangeCount, 1);
  assert.equal(snapshot.permissionAddedEventCount, 1);
  assert.equal(snapshot.dnrPollCount, 2);
  assert.equal(snapshot.dnrPollNonemptyCount, 1);
});

test('owned filesystem identity remains exact above Number.MAX_SAFE_INTEGER and every stat route requests bigint', async () => {
  const unsafeBoundary = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  const adjacentIdentity = unsafeBoundary + 1n;
  assert.equal(Number(unsafeBoundary), Number(adjacentIdentity));

  const original = syntheticExactFileStat({ dev: unsafeBoundary, ino: unsafeBoundary });
  const differentInode = syntheticExactFileStat({ dev: unsafeBoundary, ino: adjacentIdentity });
  const differentDevice = syntheticExactFileStat({ dev: adjacentIdentity, ino: unsafeBoundary });
  assert.equal(sameDirectoryIdentity(original, differentInode), false);
  assert.equal(sameDirectoryIdentity(original, differentDevice), false);
  assert.equal(sameFileIdentity(original, differentInode), false);
  assert.notEqual(
    sha256(canonicalJsonBytes(directoryIdentityRecord(original))),
    sha256(canonicalJsonBytes(directoryIdentityRecord(differentInode)))
  );
  assert.notEqual(
    sha256(canonicalJsonBytes(fileIdentityRecord(original))),
    sha256(canonicalJsonBytes(fileIdentityRecord(differentDevice)))
  );
  assert.equal(
    Object.values(fileIdentityRecord(original)).every((value) => typeof value === 'string'),
    true
  );

  const pathCalls = [];
  assert.equal(
    await exactOwnedPathStat('owned-path', async (...args) => {
      pathCalls.push(args);
      return original;
    }),
    original
  );
  assert.deepEqual(pathCalls, [['owned-path', { bigint: true }]]);

  const handleCalls = [];
  assert.equal(
    await exactOwnedHandleStat({
      stat: async (options) => {
        handleCalls.push(options);
        return original;
      }
    }),
    original
  );
  assert.deepEqual(handleCalls, [{ bigint: true }]);

  const source = await readFile(new URL('./settings-scenario-executor.mjs', import.meta.url), 'utf8');
  assert.equal(source.match(/\bexactOwnedPathStat\(/gu)?.length, 10);
  assert.equal(source.match(/\bexactOwnedHandleStat\(/gu)?.length, 5);
  assert.equal(source.match(/\bhandle\.stat\(/gu)?.length, 1);
  assert.equal(source.match(/\bnativeLstat\(/gu), null);
});

test('owned download capture rejects parent swaps, hardlinks, reparse entries, and final export substitution', async (t) => {
  await t.test('parent swap', async () => {
    const fixture = await createOwnedFilesystemFixture();
    try {
      await assert.rejects(
        captureOwnedDownloadInventory(fixture.cell, {
          afterParentCapture: async () => {
            await rename(fixture.cell.downloadPath, `${fixture.cell.downloadPath}-parked`);
            await mkdir(fixture.cell.downloadPath);
          },
          beforeFinalEnumeration: null
        }),
        /parent identity changed/i
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
      await rm(`${fixture.cell.downloadPath}-parked`, { force: true, recursive: true });
    }
  });

  await t.test('hardlink', async () => {
    const fixture = await createOwnedFilesystemFixture();
    try {
      await link(fixture.cell.canaryPath, join(fixture.cell.downloadPath, 'hardlink.bin'));
      await assert.rejects(captureOwnedDownloadInventory(fixture.cell), /singly linked physical non-reparse file/i);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  await t.test('reparse entry', async (nested) => {
    const fixture = await createOwnedFilesystemFixture();
    try {
      const target = join(fixture.root, 'outside-directory');
      await mkdir(target);
      try {
        await symlink(target, join(fixture.cell.downloadPath, 'reparse-entry'), 'junction');
      } catch (error) {
        if (error?.code === 'EPERM') {
          nested.skip('Host policy does not permit creating a disposable file symlink.');
          return;
        }
        throw error;
      }
      await assert.rejects(captureOwnedDownloadInventory(fixture.cell), /physical non-reparse file|aliased/i);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  await t.test('export substitution before final enumeration', async () => {
    const fixture = await createOwnedFilesystemFixture();
    const exportPath = join(fixture.cell.downloadPath, 'sitewipe-settings-1770000000000.json');
    const bytes = Buffer.from('{"safe":true}\n', 'utf8');
    try {
      await writeFile(exportPath, bytes, { flag: 'wx' });
      await assert.rejects(
        captureOwnedDownloadInventory(fixture.cell, {
          afterParentCapture: null,
          beforeFinalEnumeration: async () => {
            await unlink(exportPath);
            await writeFile(exportPath, bytes, { flag: 'wx' });
          }
        }),
        /substituted before final inventory settlement/i
      );
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
});

test('exclusive import creation rejects close-to-reopen substitution race', async () => {
  const fixture = await createOwnedFilesystemFixture();
  const bytes = Buffer.from('{"schema":"sitewipe.settings.backup"}\n', 'utf8');
  try {
    const before = await captureOwnedDownloadInventory(fixture.cell);
    await assert.rejects(
      createExactOwnedImportFile(fixture.cell, bytes, before.directoryIdentitySha256, async (importPath) => {
        await rename(importPath, `${importPath}.substituted`);
        await writeFile(importPath, bytes, { flag: 'wx' });
      }),
      /changed during close and exact reopen verification/i
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test('exclusive import creation keeps its child handle through final path, link, and parent checks', async () => {
  const fixture = await createOwnedFilesystemFixture();
  const bytes = Buffer.from('{"schema":"sitewipe.settings.backup"}\n', 'utf8');
  try {
    const before = await captureOwnedDownloadInventory(fixture.cell);
    await assert.rejects(
      createExactOwnedImportFile(fixture.cell, bytes, before.directoryIdentitySha256, null, async (importPath) =>
        link(importPath, `${importPath}.linked`)
      ),
      /singly linked|changed before its retained handle was closed/i
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test('default authentic session fails closed without a real disposable Puppeteer browser and owned cell', async () => {
  await assert.rejects(
    runAuthenticSettingsSession({
      artifactVersion: '1.11.90',
      browser: {},
      cell: { downloadPath: 'D:\\owned-synthetic-downloads' },
      extension: { id: 'abcdefghijklmnopabcdefghijklmnop', version: '1.11.90' }
    }),
    /exact launched Puppeteer browser/i
  );
});

function sampleContext(overrides = {}) {
  const timestamps = [startedAt, completedAt];
  return {
    browser: {
      name: 'chrome',
      version: '151.0.7922.174',
      executableSha256: '8'.repeat(64)
    },
    captureTimestamp: () => timestamps.shift(),
    cell: sampleCell(),
    fixtures: { ipv4: {}, ipv6: {} },
    launched: {
      browser: { strictFake: true },
      extension: {
        id: 'abcdefghijklmnopabcdefghijklmnop',
        name: 'SiteWipe',
        version: '1.11.90'
      },
      receipt: {
        schema: 'sitewipe.launched-installed-browser.v1',
        runId: `sitewipe-browser-${'a'.repeat(32)}`,
        planSha256: '9'.repeat(64),
        browserName: 'chrome',
        downloadPath: 'D:\\owned-synthetic-downloads',
        profilePath: 'D:\\owned-synthetic-profile',
        extensionId: 'abcdefghijklmnopabcdefghijklmnop',
        extensionVersion: '1.11.90',
        processIdentity: {
          processId: 4242,
          path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          sha256: '8'.repeat(64),
          startTimeUtcTicks: '638917729350000000'
        }
      },
      triggerAction: async () => {
        throw new Error('SETTINGS-01 must not trigger the SiteWipe cleanup action.');
      }
    },
    plan: {
      runId: `sitewipe-browser-${'a'.repeat(32)}`,
      planSha256: '9'.repeat(64),
      identity: sampleIdentity()
    },
    proxy: {},
    runtime: {},
    scenario: canonicalScenario('SETTINGS-01'),
    signal: new AbortController().signal,
    ...overrides
  };
}

async function executeAndFinalize(execute, context, closeReceipt = validCloseReceipt()) {
  const envelope = await execute(context);
  assert.deepEqual(Object.keys(envelope).sort(), ['postCloseFinalizer', 'result']);
  assert.equal(envelope.result, null);
  assert.equal(typeof envelope.postCloseFinalizer, 'function');
  return envelope.postCloseFinalizer({ closeReceipt, signal: context.signal });
}

function sampleIdentity() {
  return {
    sourceCommitSha: 'a'.repeat(40),
    sourceTreeSha: 'b'.repeat(40),
    artifactVersion: '1.11.90',
    artifactBytes: 355_074,
    artifactSha256: 'A'.repeat(64),
    browserRuntimeSetSha256: '2'.repeat(64),
    gitExecutableSha256: 'B'.repeat(64),
    harnessManifestSha256: 'C'.repeat(64),
    launchPolicySha256: '3'.repeat(64),
    nativeHelperSha256: 'D'.repeat(64),
    nodeExecutableSha256: 'E'.repeat(64),
    nodeRuntimeVersion: 'v24.18.0',
    packageLockSha256: 'F'.repeat(64),
    powerShellExecutableSha256: '4'.repeat(64),
    processObserverHelperSha256: '5'.repeat(64),
    releaseInputFingerprintSha256: '0'.repeat(64),
    runtimeFingerprintSha256: '1'.repeat(64),
    toolchainBytes: 24_314_357,
    toolchainFileCount: 2_227,
    toolchainPackageCount: 26,
    toolchainPuppeteerVersion: '25.8.0',
    toolchainSetSha256: '6'.repeat(64)
  };
}

function validPayloads() {
  const payloads = {};
  for (const key of VISIBLE_SETTINGS) {
    const isSelect = Object.hasOwn(SETTINGS_SEMANTIC_CONTRACT.selectOptions, key);
    const isTextarea = key === 'associatedDomainGroups';
    const attemptedValue = SETTINGS_SEMANTIC_CONTRACT.exerciseValues[key];
    const observedValue = key === 'embeddedFrameDiscovery' ? false : attemptedValue;
    payloads[`setting.${key}`] = {
      classification: 'visible',
      control: {
        ariaDescribedByBound: true,
        ariaLabelledByBound: true,
        initialEnabled: !SETTINGS_SEMANTIC_CONTRACT.initialDisabledIds.includes(key),
        inputType: isSelect ? 'select-one' : isTextarea ? 'textarea' : 'checkbox',
        optionValues: structuredClone(SETTINGS_SEMANTIC_CONTRACT.selectOptions[key] || []),
        present: true,
        tagName: isSelect ? 'SELECT' : isTextarea ? 'TEXTAREA' : 'INPUT'
      },
      exercise: {
        attemptedValue,
        observedAfterSave: observedValue,
        persistedAfterReload: observedValue,
        saveOutcome: key === 'embeddedFrameDiscovery' ? 'remained_off' : 'saved',
        storageRoundTripObserved: true
      },
      initialValue: SETTINGS_DEFAULTS[key],
      key,
      productionDefault: SETTINGS_DEFAULTS[key],
      resetValue: SETTINGS_DEFAULTS[key]
    };
  }
  for (const key of INTERNAL_SETTINGS) {
    payloads[`setting.${key}`] = {
      afterExerciseState: key === 'mainWorldPageScrub' ? 'false' : 'timestamp',
      classification: 'internal',
      controlAbsent: true,
      initialState: key === 'mainWorldPageScrub' ? 'false' : 'timestamp',
      key,
      preservedAcrossVisibleSaves: key !== 'updatedAt',
      productionDefault: SETTINGS_DEFAULTS[key],
      resetState: key === 'mainWorldPageScrub' ? 'false' : 'timestamp',
      resetValueChanged: key !== 'mainWorldPageScrub'
    };
  }
  payloads['settings.select_options_and_bounds'] = {
    controls: Object.entries(SETTINGS_SEMANTIC_CONTRACT.selectOptions).map(([id, optionValues]) => ({
      id,
      optionValues: structuredClone(optionValues)
    })),
    invalidPatchResult: {
      cleanupMode: 'standard',
      latestReportRetentionMinutes: 30,
      overlayScope: 'target_tabs',
      postWipeShieldExpiresMinutes: 0,
      reportRetentionDays: 7
    },
    productionDefaultsMatched: true
  };
  payloads['settings.dependencies_and_expert_gating'] = {
    expertEnabledControlIds: structuredClone(SETTINGS_SEMANTIC_CONTRACT.expertControlIds),
    parentOffDisabledControlIds: structuredClone(SETTINGS_SEMANTIC_CONTRACT.dependencyGroups),
    standardDisabledControlIds: structuredClone(SETTINGS_SEMANTIC_CONTRACT.expertControlIds),
    standardForcedValues: { embeddedFrameDiscovery: false, overlayScope: 'target_tabs' }
  };
  payloads['settings.persistence_and_reset'] = {
    exercisedVisibleSettingCount: VISIBLE_SETTINGS.length,
    internalSettingCount: INTERNAL_SETTINGS.length,
    persistedVisibleSettingCount: VISIBLE_SETTINGS.length,
    reloadRenderedVisibleSettingCount: VISIBLE_SETTINGS.length,
    resetAcceptRestoredSettingCount: VISIBLE_SETTINGS.length + INTERNAL_SETTINGS.length,
    resetCancelPreserved: true,
    visibleSettingCount: VISIBLE_SETTINGS.length
  };
  payloads['settings.import_export'] = {
    exportBytes: 4096,
    exportDownloadEntryCountAdded: 1,
    exportEntryName: 'sitewipe-settings-1770000000000.json',
    exportFileSha256: 'D'.repeat(64),
    exportIdentitySha256: '4'.repeat(64),
    exportSchema: 'sitewipe.settings.backup',
    exportSchemaVersion: 1,
    exportSettingsSha256: 'A'.repeat(64),
    exportUserSettingCount: VISIBLE_SETTINGS.length,
    exported: true,
    importAcceptApplied: true,
    importCancelPreserved: true,
    importRecognizedSettingCount: VISIBLE_SETTINGS.length,
    importFileSha256: 'E'.repeat(64),
    importIdentitySha256: '3'.repeat(64),
    importUnknownIgnoredCount: 1,
    ownedSyntheticImportUsed: true
  };
  payloads['settings.sensitive_confirm_cancel_and_accept'] = {
    cases: sensitiveCases()
  };
  payloads['settings.malformed_associated_groups'] = {
    safetyToggleExercised: true,
    storageBounds: {
      diagnosticBoundReported: true,
      ignoredLineCount: 1,
      inputLineCount: 51,
      maxStoredLineCharacters: 500,
      retainedLineCount: 50,
      shortenedLineCount: 50
    },
    syntax: {
      ariaInvalid: true,
      diagnosticErrorTone: true,
      errorCount: 1,
      storedInputBounded: true
    }
  };
  return payloads;
}

function fakeDependencies(overrides = {}) {
  return {
    captureOwnedDownloadInventory: async () => validOwnedInventory('after'),
    runSession: async (options) => completeFakeSession(options),
    startNativePromptObserver: async () => validNativeObserver(),
    ...overrides
  };
}

async function completeFakeSession(options) {
  const nativeObservation = await options.settleNativePromptObserver();
  return validSession({ nativeObservation, nativeReadiness: options.nativeReadiness });
}

function validSession({ nativeObservation = validNativeObservation(), nativeReadiness = validNativeReadiness() } = {}) {
  return {
    payloads: validPayloads(),
    safety: {
      afterBoundary: validSafetyBoundary('after'),
      afterCapturedAt: '2026-08-25T15:00:09.100Z',
      beforeBoundary: validSafetyBoundary('before'),
      beforeCapturedAt: '2026-08-25T15:00:01.000Z',
      ownedDownloadsBefore: validOwnedInventory('before'),
      ownedDownloadsBeforeClose: validOwnedInventory('after'),
      nativeObservation,
      nativeReadiness
    }
  };
}

function validSafetyBoundary(phase) {
  const after = phase === 'after';
  return {
    downloadRecords: after
      ? [
          {
            bytesReceived: 4096,
            danger: 'safe',
            error: null,
            exists: true,
            filename: resolve('D:\\owned-synthetic-downloads', 'sitewipe-settings-1770000000000.json'),
            id: 1,
            paused: false,
            state: 'complete',
            totalBytes: 4096
          }
        ]
      : [],
    dynamicRules: [],
    incognitoAllowed: false,
    localAuthority: {},
    monitorEvents: {
      authorityStorageChangeCount: 0,
      documentReadyCount: after ? 5 : 1,
      downloadCreatedEventCount: after ? 1 : 0,
      downloadErasedEventCount: 0,
      dnrPollCount: after ? 20 : 1,
      dnrPollErrorCount: 0,
      dnrPollIntervalMs: 100,
      dnrPollMaxGapMs: after ? 120 : 0,
      dnrPollNonemptyCount: 0,
      firstReadyAt: '2026-08-25T15:00:00.600Z',
      lastDnrPollAt: after ? '2026-08-25T15:00:09.050Z' : '2026-08-25T15:00:00.900Z',
      lastReadyAt: after ? '2026-08-25T15:00:08.500Z' : '2026-08-25T15:00:00.600Z',
      localAuthorityKeys: [
        'sitewipe.activeJob.v1',
        'sitewipe.activeShield.v1',
        'sitewipe.permissionLease.v1',
        'sitewipe.activeReport.v1',
        'sitewipe.reports.v1',
        'sitewipe.dnrPendingMutation.v1'
      ],
      permissionAddedEventCount: 0,
      permissionRemovedEventCount: 0,
      sessionAuthorityKeys: [
        'sitewipe.cleanupReview.v1',
        'sitewipe.cleanupPermissionHandoff.v1',
        'sitewipe.dnrPendingMutation.session.v1'
      ]
    },
    permissions: {
      origins: [],
      permissions: [
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
    },
    sessionAuthority: {},
    sessionRules: []
  };
}

function validOwnedInventory(phase) {
  const entries = [
    {
      bytes: 32,
      identitySha256: '1'.repeat(64),
      name: '.sitewipe-must-preserve-download.bin',
      sha256: 'F'.repeat(64)
    },
    {
      bytes: 256,
      identitySha256: '2'.repeat(64),
      name: '.sitewipe-owned-browser-directory.json',
      sha256: 'A'.repeat(64)
    }
  ];
  if (phase === 'after') {
    entries.push(
      {
        bytes: 1024,
        identitySha256: '3'.repeat(64),
        name: '.sitewipe-owned-settings-import.json',
        sha256: 'E'.repeat(64)
      },
      {
        bytes: 4096,
        identitySha256: '4'.repeat(64),
        name: 'sitewipe-settings-1770000000000.json',
        sha256: 'D'.repeat(64)
      }
    );
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return {
    canarySha256: 'F'.repeat(64),
    directoryIdentitySha256: '9'.repeat(64),
    entries,
    inventorySha256: sha256(canonicalJsonBytes(entries))
  };
}

function validNativeObserver() {
  return {
    readiness: validNativeReadiness(),
    cancelAndWait: async () => ({
      schema: 'sitewipe.native-permission-helper-settlement.v1',
      processId: 4321,
      status: 'already_settled'
    }),
    settle: async () => validNativeObservation()
  };
}

function validNativeReadiness() {
  return {
    schema: 'sitewipe.native-permission-helper-ready.v1',
    status: 'ready',
    scheduleId: 'SETTINGS-01.observe-none',
    scenarioId: 'SETTINGS-01',
    action: 'observe-none',
    readyAt: '2026-08-25T15:00:00.500Z'
  };
}

function validNativeObservation() {
  return {
    schema: 'sitewipe.native-permission-dialog-evidence.v1',
    status: 'no_prompt_observed',
    scheduleId: 'SETTINGS-01.observe-none',
    scenarioId: 'SETTINGS-01',
    action: 'observe-none',
    observationStartedAt: '2026-08-25T15:00:00.500Z',
    stopRequestedAt: '2026-08-25T15:00:08.900Z',
    observedAt: '2026-08-25T15:00:09.000Z'
  };
}

function sampleCell() {
  return {
    schema: 'sitewipe.staged-browser-cell.v1',
    runId: `sitewipe-browser-${'a'.repeat(32)}`,
    planSha256: '9'.repeat(64),
    browserName: 'chrome',
    scenarioId: 'SETTINGS-01',
    scenarioRoot: 'D:\\owned-synthetic-cell',
    profilePath: 'D:\\owned-synthetic-profile',
    downloadPath: 'D:\\owned-synthetic-downloads',
    evidencePath: 'D:\\owned-synthetic-evidence',
    screenshotPath: 'D:\\owned-synthetic-screenshots',
    canaryPath: 'D:\\owned-synthetic-downloads\\.sitewipe-must-preserve-download.bin',
    canarySha256: 'F'.repeat(64),
    syntheticDownloadsMayBeCreated: true,
    automaticDownloadDeletion: false
  };
}

function validCloseReceipt() {
  return {
    schema: 'sitewipe.installed-browser-close-observation.v1',
    runId: `sitewipe-browser-${'a'.repeat(32)}`,
    planSha256: '9'.repeat(64),
    browserName: 'chrome',
    closeStartedAt: '2026-08-25T15:00:09.200Z',
    observedAt: '2026-08-25T15:00:09.500Z',
    observationStatus: 'clean',
    gracefulCloseError: null,
    profileProcessResidueCount: 0,
    processResidue: {
      schema: 'sitewipe.windows-process-observation.v1',
      mode: 'profile-residue',
      observedAt: '2026-08-25T15:00:09.400Z',
      profilePath: 'D:\\owned-synthetic-profile',
      rootIdentity: {
        path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        present: false,
        processId: 4242,
        sha256: '8'.repeat(64),
        startTimeUtcTicks: '638917729350000000'
      },
      residues: []
    },
    mustPreserveDownloadCanary: {
      path: 'D:\\owned-synthetic-downloads\\.sitewipe-must-preserve-download.bin',
      expectedSha256: 'F'.repeat(64),
      observedSha256: 'F'.repeat(64),
      preserved: true
    },
    automaticProfileDeletionPerformed: false,
    automaticDownloadDeletionPerformed: false,
    semanticValidationStatus: SEMANTIC_VALIDATION_STATUS,
    semanticValidatorManifestSha256: SEMANTIC_VALIDATOR_MANIFEST_SHA256
  };
}

function sensitiveCases() {
  const reportPrompt =
    'Store sensitive cleanup report details? Full unredacted reports can contain browsing domains, URLs, filenames, local paths, and browser error details; indefinite retention keeps the latest report until you delete it. Choose Cancel to keep the current privacy-safe settings.';
  const skipPrompt = `Skip the detailed cleanup review completely for future cleanups? This applies in Standard and Expert mode. One popup cleanup action can immediately begin all currently enabled cleanup effects. ${SELECTED_SITE_PARTITION_STORAGE_DISCLOSURE} ${EXACT_ORIGIN_BROWSER_STORAGE_LIMITATION} Expert options can delete matched downloaded files or affect broader site data, and private-window data can be included when incognito access is enabled. Chrome or Brave may still require its own permission prompt. Choose Cancel to keep detailed review enabled.`;
  const resetPrompt = 'Reset SiteWipe settings to the privacy-safe defaults? Your current settings cannot be restored.';
  return [
    ['skipCleanupReview', skipPrompt],
    ['redactReports', reportPrompt],
    ['latestReportRetentionMinutes', reportPrompt],
    ['resetSettings', resetPrompt]
  ].map(([id, prompt]) => ({
    acceptObserved: true,
    cancelObserved: true,
    changedAfterAccept: true,
    id,
    promptSha256: sha256(prompt),
    unchangedAfterCancel: true
  }));
}

function fakePreloadPage() {
  const exposed = new Map();
  let preload = null;
  let uuidSequence = 0;
  return {
    evaluate: async () => undefined,
    evaluateOnNewDocument: async (fn, args) => {
      preload = { args: structuredClone(args), source: fn.toString() };
      return { identifier: 'settings-preload-registration-1' };
    },
    exposeFunction: async (name, fn) => {
      exposed.set(name, fn);
    },
    load: async ({ afterPreload = null, dynamicRules = [], sessionRules = [] } = {}) => {
      if (!preload) throw new Error('Preload was not registered.');
      const listeners = {
        downloadCreated: [],
        downloadErased: [],
        permissionAdded: [],
        permissionRemoved: [],
        storageChanged: []
      };
      const context = {
        chrome: {
          declarativeNetRequest: {
            getDynamicRules: async () => structuredClone(dynamicRules),
            getSessionRules: async () => structuredClone(sessionRules)
          },
          downloads: {
            onCreated: { addListener: (fn) => listeners.downloadCreated.push(fn) },
            onErased: { addListener: (fn) => listeners.downloadErased.push(fn) }
          },
          permissions: {
            onAdded: { addListener: (fn) => listeners.permissionAdded.push(fn) },
            onRemoved: { addListener: (fn) => listeners.permissionRemoved.push(fn) }
          },
          storage: {
            onChanged: { addListener: (fn) => listeners.storageChanged.push(fn) }
          }
        },
        crypto: {
          randomUUID: () => {
            uuidSequence += 1;
            return `00000000-0000-4000-8000-${String(uuidSequence).padStart(12, '0')}`;
          }
        },
        setInterval: () => 1
      };
      for (const [name, fn] of exposed) context[name] = fn;
      runInNewContext(`(${preload.source})(${JSON.stringify(preload.args)})`, context);
      if (afterPreload) {
        afterPreload({
          downloadCreated: (...args) => listeners.downloadCreated.forEach((fn) => fn(...args)),
          downloadErased: (...args) => listeners.downloadErased.forEach((fn) => fn(...args)),
          permissionAdded: (...args) => listeners.permissionAdded.forEach((fn) => fn(...args)),
          permissionRemoved: (...args) => listeners.permissionRemoved.forEach((fn) => fn(...args)),
          storageChanged: (...args) => listeners.storageChanged.forEach((fn) => fn(...args))
        });
      }
    }
  };
}

async function nextTurns() {
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
}

function syntheticExactFileStat(overrides = {}) {
  return {
    birthtimeNs: 1_769_356_800_000_000_000n,
    ctimeNs: 1_769_356_801_000_000_000n,
    dev: 1n,
    ino: 1n,
    mode: 33_188n,
    mtimeNs: 1_769_356_802_000_000_000n,
    nlink: 1n,
    size: 32n,
    ...overrides
  };
}

async function createOwnedFilesystemFixture() {
  const root = await mkdtemp(join(tmpdir(), 'sitewipe-settings-owned-'));
  const downloadPath = join(root, 'downloads');
  await mkdir(downloadPath);
  const canaryBytes = Buffer.alloc(32, 7);
  const canarySha256 = sha256(canaryBytes);
  const cell = {
    ...sampleCell(),
    downloadPath,
    canaryPath: resolve(downloadPath, '.sitewipe-must-preserve-download.bin'),
    canarySha256
  };
  await writeFile(cell.canaryPath, canaryBytes, { flag: 'wx' });
  const marker = {
    browserName: cell.browserName,
    canarySha256,
    kind: 'downloads',
    planSha256: cell.planSha256,
    runId: cell.runId,
    scenarioId: cell.scenarioId,
    schema: 'sitewipe.owned-browser-directory.v1'
  };
  await writeFile(
    join(downloadPath, '.sitewipe-owned-browser-directory.json'),
    Buffer.from(`${JSON.stringify(marker)}\n`, 'utf8'),
    { flag: 'wx' }
  );
  return { cell, root };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
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

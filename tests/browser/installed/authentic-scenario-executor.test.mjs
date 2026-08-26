import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { SETTINGS_DEFAULTS } from './canonical-matrix.mjs';
import { canonicalJsonBytes } from './evidence-contract.mjs';
import {
  createAuthenticScenarioExecutor,
  executeAuthenticInstalledBrowserCell,
  executeAuthenticScenarioCell,
  inspectOwnedFreshProfile
} from './authentic-scenario-executor.mjs';
import {
  SEMANTIC_VALIDATOR_MANIFEST_SHA256,
  decodeSemanticObservationEvidence,
  deriveSemanticScenarioAssertions,
  semanticBindingFromScenarioResult
} from './semantic-validator.mjs';

const FIXTURE_TOKEN = 'f'.repeat(64);
const FIXTURE_TOKEN_SHA256 = sha256(FIXTURE_TOKEN);
const EMPTY_RULE_SET_SHA256 = sha256('[]\n');
const STARTUP_SOURCE_ROUTE_CONTRACT_SHA256 = '0C5A8C3B496072FDDDC9D0143CC06DFCE8469F26FDA5F8993D46687F453B986F';

test('exports one installed-runner-compatible authentic dispatcher', () => {
  assert.equal(typeof executeAuthenticInstalledBrowserCell, 'function');
  assert.equal(executeAuthenticScenarioCell, executeAuthenticInstalledBrowserCell);
  assert.throws(
    () => createAuthenticScenarioExecutor({ inventedAuthority: async () => true }),
    /unknown dependencies/i
  );
});

test('SMOKE consumes the receipt-bound pristine prelaunch fact after post-launch profile population', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'sitewipe-smoke-prelaunch-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  const profilePath = join(root, 'profile');
  await mkdir(profilePath);
  const harness = createHarness();
  const cell = {
    browserName: 'chrome',
    canarySha256: '7'.repeat(64),
    planSha256: harness.plan.planSha256,
    profilePath,
    runId: harness.plan.runId,
    scenarioId: 'SMOKE-01'
  };
  await writeFile(
    join(profilePath, '.sitewipe-owned-browser-directory.json'),
    canonicalJsonBytes({
      browserName: cell.browserName,
      canarySha256: cell.canarySha256,
      kind: 'profile',
      planSha256: cell.planSha256,
      runId: cell.runId,
      scenarioId: cell.scenarioId,
      schema: 'sitewipe.owned-browser-directory.v1'
    })
  );
  await mkdir(join(profilePath, 'Default'));
  const launched = {
    receipt: {
      profilePrelaunch: {
        profileDataEntryCountBeforeLaunch: 0,
        profileOwnershipMarkerMatched: true,
        profilePath,
        profileWasNew: true,
        schema: 'sitewipe.profile-prelaunch-observation.v1'
      }
    }
  };

  assert.deepEqual(await inspectOwnedFreshProfile({ cell, launched, plan: harness.plan }), {
    profileWasNew: true,
    profileOwnershipMarkerMatched: true,
    profileDataEntryCountBeforeLaunch: 0
  });

  const stale = structuredClone(launched);
  stale.receipt.profilePrelaunch.profileDataEntryCountBeforeLaunch = 1;
  await assert.rejects(
    inspectOwnedFreshProfile({ cell, launched: stale, plan: harness.plan }),
    /lacks the exact pristine prelaunch profile observation/i
  );
});

test('exact filesystem identity helpers use BigInt stats and never compare rounded Number sizes', async () => {
  const source = await readFile(new URL('./authentic-scenario-executor.mjs', import.meta.url), 'utf8');
  assert.equal([...source.matchAll(/\bawait lstat\(/gu)].length, 6);
  assert.equal([...source.matchAll(/\bawait lstat\([^\n]+, \{ bigint: true \}\)/gu)].length, 6);
  assert.match(source, /before\.nlink !== 1n/u);
  assert.match(source, /BigInt\(bytes\.length\) !== after\.size/u);
  assert.doesNotMatch(source, /bytes\.length !== after\.size/u);
});

test('production extension inspection labels only the exact local permission-lease key as a lease', async () => {
  const source = await readFile(new URL('./authentic-scenario-executor.mjs', import.meta.url), 'utf8');
  assert.match(source, /permissionLeaseCount: local\[storageKeys\.permissionLease\] == null \? 0 : 1/u);
  assert.doesNotMatch(source, /permissionLeaseCount:\s*localAuthorityCount\s*\+\s*sessionAuthorityCount/u);
});

test('ART emits only three independently observed assertions and leaves candidate rejection not_run', async () => {
  const harness = createHarness();
  const execute = createAuthenticScenarioExecutor({ captureArtFacts: async () => sampleArtFacts(harness.plan) });
  const result = await execute(harness.context('ART-01'));
  const replayed = replay(result, harness.plan, 'ART-01');

  assert.equal(result.evidence.length, 3);
  assert.deepEqual(
    replayed.assertions.map(({ id, state }) => [id, state]),
    [
      ['source.exact_head', 'passed'],
      ['artifact.version_manifest_hash', 'passed'],
      ['artifact.source_runtime_parity', 'passed'],
      ['artifact.stale_ignored_candidate_rejected', 'not_run']
    ]
  );
  assert.equal(replayed.state, 'not_run');
  assert.equal(harness.log.filter(({ event }) => event === 'launch').length, 0);
  assert.equal(harness.log.filter(({ event }) => event === 'close').length, 0);
  assert.ok(result.evidence.every(({ sha256 }) => /^[A-F0-9]{64}$/.test(sha256)));
});

test('ART never turns an observed source mutation into a pass', async () => {
  const harness = createHarness();
  const facts = sampleArtFacts(harness.plan);
  facts.exactHead.clean = false;
  facts.exactHead.worktreeDeltaCount = 1;
  const execute = createAuthenticScenarioExecutor({ captureArtFacts: async () => facts });
  const result = await execute(harness.context('ART-01'));
  const replayed = replay(result, harness.plan, 'ART-01');

  assert.equal(assertion(replayed, 'source.exact_head').state, 'failed');
  assert.equal(replayed.state, 'failed');
});

test('ART never turns artifact/source divergence into a pass', async () => {
  const harness = createHarness();
  const facts = sampleArtFacts(harness.plan);
  facts.parity.mismatchCount = 1;
  facts.parity.artifactRuntimeFingerprintSha256 = '9'.repeat(64);
  const execute = createAuthenticScenarioExecutor({ captureArtFacts: async () => facts });
  const result = await execute(harness.context('ART-01'));
  const replayed = replay(result, harness.plan, 'ART-01');

  assert.equal(assertion(replayed, 'artifact.source_runtime_parity').state, 'failed');
  assert.equal(replayed.state, 'failed');
});

test('SMOKE seeds nonempty synthetic state before one authentic action and prepares only supported evidence', async () => {
  const harness = createHarness();
  const result = await harness.execute(harness.context('SMOKE-01'));
  const replayed = replay(result, harness.plan, 'SMOKE-01');

  assert.equal(replayed.state, 'not_run');
  assert.equal(result.evidence.length, 3);
  assert.equal(assertion(replayed, 'install.fresh_profile').state, 'passed');
  assert.equal(assertion(replayed, 'defaults.safe').state, 'passed');
  assert.equal(assertion(replayed, 'load.no_permission_or_cleanup').state, 'passed');
  assert.equal(assertion(replayed, 'surfaces.popup_options_sidepanel').state, 'not_run');
  assert.match(result.reason, /actual browser side-panel container|sidePanel API/i);
  assert.equal(harness.log.filter(({ event }) => event === 'launch').length, 0);
  assert.equal(harness.log.filter(({ event }) => event === 'seed-fixture').length, 1);
  assert.equal(harness.log.filter(({ event }) => event === 'trigger-action').length, 1);
  assert.equal(harness.log.filter(({ event }) => event === 'close').length, 0);
  assert.ok(
    harness.log.find(({ event }) => event === 'seed-fixture').index <
      harness.log.find(({ event }) => event === 'trigger-action').index
  );
  const firstFixtureBaseline = harness.log.find(({ event }) => event === 'inspect-fixture');
  const preload = harness.log.find(({ event }) => event === 'preload-safety-monitor');
  const observerStart = harness.log.find(({ event }) => event === 'native-observer-start');
  const firstExtensionNavigation = harness.log.find(
    ({ event, url }) => event === 'goto' && url.startsWith('chrome-extension://')
  );
  assert.ok(harness.log.find(({ event }) => event === 'seed-fixture').index < firstFixtureBaseline.index);
  assert.ok(preload.index < observerStart.index);
  assert.equal(observerStart.index + 1, firstExtensionNavigation.index);
  assert.ok(firstExtensionNavigation.index < harness.log.find(({ event }) => event === 'seed-fixture').index);
  assert.equal(harness.log.at(-1).event, 'timestamp');
  const navigations = harness.log.filter(({ event }) => event === 'goto').map(({ url }) => url);
  assert.equal(navigations.filter((url) => url.startsWith('http://')).length, 1);
  const fixtureUrl = new URL(navigations.find((url) => url.startsWith('http://')));
  assert.equal(fixtureUrl.origin, 'http://selected.example.com:43822');
  assert.equal(fixtureUrl.pathname, '/');
  assert.equal(fixtureUrl.searchParams.get('scale'), 'small');
  assert.equal(fixtureUrl.searchParams.get('runToken'), FIXTURE_TOKEN);
  assert.equal(navigations.filter((url) => url.startsWith('chrome-extension://')).length, 1);
  assert.deepEqual(
    harness.log.filter(({ event }) => event === 'observe-surface').map(({ name }) => name),
    ['popup', 'options']
  );
  assert.equal(
    navigations.some((url) => url.includes('/sidepanel/')),
    false
  );
  const fixtureSnapshots = harness.log.filter(({ event }) => event === 'inspect-fixture');
  const extensionSnapshots = harness.log.filter(({ event }) => event === 'inspect-extension');
  const coveredFixtureSnapshot = fixtureSnapshots.at(-2);
  const finalFixtureSnapshot = fixtureSnapshots.at(-1);
  const coveredExtensionSnapshot = extensionSnapshots.at(-2);
  const finalExtensionSnapshot = extensionSnapshots.at(-1);
  const coverageTimestamp = harness.log.find(
    ({ event, index }) => event === 'timestamp' && index > coveredFixtureSnapshot.index
  );
  const nativeSettle = harness.log.find(({ event }) => event === 'native-observer-settle');
  assert.ok(coveredFixtureSnapshot.index < coverageTimestamp.index);
  assert.ok(coveredExtensionSnapshot.index < coverageTimestamp.index);
  assert.ok(coverageTimestamp.index < nativeSettle.index);
  assert.ok(nativeSettle.index < finalFixtureSnapshot.index);
  assert.ok(finalFixtureSnapshot.index < finalExtensionSnapshot.index);
  assert.equal(harness.log.at(-1).event, 'timestamp');
});

test('SMOKE rejects a nonfresh profile before any browser launch', async () => {
  const harness = createHarness({ profileDataEntryCountBeforeLaunch: 1 });
  await assert.rejects(harness.execute(harness.context('SMOKE-01')), /fresh profile/i);
  assert.equal(harness.log.filter(({ event }) => event === 'launch').length, 0);
  assert.equal(harness.log.filter(({ event }) => event === 'close').length, 0);
});

test('SMOKE rejects an extension identity mutation and leaves browser close exclusively to the runner', async () => {
  const harness = createHarness({ extensionVersion: '9.9.9' });
  await assert.rejects(harness.execute(harness.context('SMOKE-01')), /exact enabled SiteWipe controller/i);
  assert.equal(harness.log.filter(({ event }) => event === 'launch').length, 0);
  assert.equal(harness.log.filter(({ event }) => event === 'close').length, 0);
});

test('SMOKE rejects a missing exact MV3 service worker and leaves browser close exclusively to the runner', async () => {
  const harness = createHarness({ serviceWorkerPresent: false });
  await assert.rejects(harness.execute(harness.context('SMOKE-01')), /MV3 service-worker/i);
  assert.equal(harness.log.filter(({ event }) => event === 'launch').length, 0);
  assert.equal(harness.log.filter(({ event }) => event === 'close').length, 0);
});

test('SMOKE reports a same-inventory fixture value mutation as a failed semantic assertion', async () => {
  const harness = createHarness({ fixtureAfterValueSha256: 'F'.repeat(64) });
  const result = await harness.execute(harness.context('SMOKE-01'));
  const replayed = replay(result, harness.plan, 'SMOKE-01');

  assert.equal(assertion(replayed, 'load.no_permission_or_cleanup').state, 'failed');
  assert.equal(replayed.state, 'failed');
  assert.equal(harness.log.filter(({ event }) => event === 'close').length, 0);
});

test('SMOKE reports a same-count fixture inventory mutation as a failed semantic assertion', async () => {
  const harness = createHarness({ fixtureAfterInventorySha256: 'E'.repeat(64) });
  const result = await harness.execute(harness.context('SMOKE-01'));
  const replayed = replay(result, harness.plan, 'SMOKE-01');

  assert.equal(assertion(replayed, 'load.no_permission_or_cleanup').state, 'failed');
  assert.equal(replayed.state, 'failed');
  assert.equal(harness.log.filter(({ event }) => event === 'close').length, 0);
});

test('SMOKE no-authority assertion cannot pass when a seed dependency reports empty no-op state', async () => {
  const harness = createHarness({ fixtureDataEntryCount: 0, fixtureStorageKindCount: 0 });
  const result = await harness.execute(harness.context('SMOKE-01'));
  const replayed = replay(result, harness.plan, 'SMOKE-01');

  assert.equal(assertion(replayed, 'load.no_permission_or_cleanup').state, 'failed');
  assert.equal(replayed.state, 'failed');
  assert.equal(harness.log.filter(({ event }) => event === 'close').length, 0);
});

test('SMOKE rejects an inexact seed receipt before action and leaves browser close exclusively to the runner', async () => {
  const harness = createHarness({ fixtureSeeded: false });
  await assert.rejects(harness.execute(harness.context('SMOKE-01')), /seed receipt/i);
  assert.equal(harness.log.filter(({ event }) => event === 'trigger-action').length, 0);
  assert.equal(harness.log.filter(({ event }) => event === 'close').length, 0);
});

test('SMOKE rejects every seed-receipt field that does not bind the exact deep pre-action baseline', async () => {
  for (const mutation of [
    { seedBaselineDataEntryCount: 42 },
    { seedBaselineStorageKindCount: 7 },
    { seedBaselineInventorySha256: 'A'.repeat(64) },
    { seedBaselineValueSha256: 'B'.repeat(64) }
  ]) {
    const harness = createHarness(mutation);
    await assert.rejects(harness.execute(harness.context('SMOKE-01')), /deep pre-action baseline/i);
    assert.equal(harness.log.filter(({ event }) => event === 'native-observer-start').length, 1);
    assert.equal(harness.log.filter(({ event }) => event === 'native-observer-cancel').length, 1);
    assert.equal(
      harness.log.some(({ event, url }) => event === 'goto' && url.startsWith('chrome-extension://')),
      true
    );
    assert.equal(harness.log.filter(({ event }) => event === 'trigger-action').length, 0);
    assert.equal(harness.log.filter(({ event }) => event === 'close').length, 0);
  }
});

test('SMOKE records every transient authority, permission, and download event as a decisive failure', async () => {
  for (const field of [
    'localAuthorityChangedKeyCount',
    'sessionAuthorityChangedKeyCount',
    'permissionAddedEventCount',
    'permissionRemovedEventCount',
    'downloadCreatedEventCount',
    'downloadErasedEventCount'
  ]) {
    const harness = createHarness({ safetyMutation: { [field]: 1 } });
    const result = await harness.execute(harness.context('SMOKE-01'));
    const replayed = replay(result, harness.plan, 'SMOKE-01');
    assert.equal(assertion(replayed, 'load.no_permission_or_cleanup').state, 'failed', field);
    assert.equal(harness.log.filter(({ event }) => event === 'native-observer-settle').length, 1, field);
    assert.equal(harness.log.filter(({ event }) => event === 'native-observer-cancel').length, 0, field);
  }
});

test('SMOKE rejects transient dynamic or session DNR rules observed only by bounded polling', async () => {
  for (const option of ['transientDynamicDnr', 'transientSessionDnr']) {
    const harness = createHarness({ [option]: true });
    const result = await harness.execute(harness.context('SMOKE-01'));
    const replayed = replay(result, harness.plan, 'SMOKE-01');
    const payload = noAuthorityPayload(result, harness.plan);
    assert.equal(assertion(replayed, 'load.no_permission_or_cleanup').state, 'failed', option);
    assert.equal(payload.dynamicDnrRuleCountBefore, 0);
    assert.equal(payload.dynamicDnrRuleCountAfter, 0);
    assert.equal(payload.sessionDnrRuleCountBefore, 0);
    assert.equal(payload.sessionDnrRuleCountAfter, 0);
    assert.equal(payload.dnrPollNonemptyCount, 1);
  }
});

test('SMOKE counts only the exact permission-lease key as a permission lease', async () => {
  const harness = createHarness({ endpointMutation: { finalLocalAuthorityEntryCount: 1 } });
  const result = await harness.execute(harness.context('SMOKE-01'));
  const payload = noAuthorityPayload(result, harness.plan);
  assert.equal(payload.finalLocalAuthorityEntryCount, 1);
  assert.equal(payload.permissionLeaseCount, 0);
  assert.equal(assertion(replay(result, harness.plan, 'SMOKE-01'), 'load.no_permission_or_cleanup').state, 'failed');
});

test('SMOKE fails closed when the preloaded monitor has not acknowledged its initial baseline', async () => {
  const harness = createHarness({ initialMonitorMutation: { baselineAcknowledgedCount: 0 } });
  await assert.rejects(harness.execute(harness.context('SMOKE-01')), /startup endpoint state|acknowledged baseline/i);
  assert.equal(harness.log.filter(({ event }) => event === 'trigger-action').length, 0);
  assert.equal(harness.log.filter(({ event }) => event === 'native-observer-cancel').length, 1);
  assert.equal(harness.log.filter(({ event }) => event === 'close').length, 0);
});

test('SMOKE retains Node-owned monitor counters across multiple acknowledged documents', async () => {
  const harness = createHarness({
    initialMonitorMutation: { baselineAcknowledgedCount: 2, documentReadyCount: 2 }
  });
  const result = await harness.execute(harness.context('SMOKE-01'));
  const payload = noAuthorityPayload(result, harness.plan);
  assert.equal(payload.monitorBaselineAcknowledgedCount, 2);
  assert.equal(payload.monitorDocumentReadyCount, 2);
  assert.equal(assertion(replay(result, harness.plan, 'SMOKE-01'), 'load.no_permission_or_cleanup').state, 'passed');
});

test('SMOKE final boundary catches a safety event and fixture mutation that occur during native settlement', async () => {
  const safetyHarness = createHarness({ lateSafetyMutation: { permissionAddedEventCount: 1 } });
  const safetyResult = await safetyHarness.execute(safetyHarness.context('SMOKE-01'));
  assert.equal(noAuthorityPayload(safetyResult, safetyHarness.plan).permissionAddedEventCount, 1);
  assert.equal(
    assertion(replay(safetyResult, safetyHarness.plan, 'SMOKE-01'), 'load.no_permission_or_cleanup').state,
    'failed'
  );

  const fixtureHarness = createHarness({ fixtureFinalValueSha256: 'C'.repeat(64) });
  const fixtureResult = await fixtureHarness.execute(fixtureHarness.context('SMOKE-01'));
  assert.equal(noAuthorityPayload(fixtureResult, fixtureHarness.plan).cleanupMutationCount, 1);
  assert.equal(
    assertion(replay(fixtureResult, fixtureHarness.plan, 'SMOKE-01'), 'load.no_permission_or_cleanup').state,
    'failed'
  );
});

test('SMOKE emits nothing when the final Node monitor boundary does not cover native settlement', async () => {
  const harness = createHarness({ finalMonitorCoverageObservedAt: '2026-08-25T12:00:02.000Z' });
  await assert.rejects(harness.execute(harness.context('SMOKE-01')), /final SMOKE monitor boundary/i);
  assert.equal(harness.log.filter(({ event }) => event === 'native-observer-settle').length, 1);
  assert.equal(harness.log.filter(({ event }) => event === 'close').length, 0);
});

test('SMOKE refuses an unreviewed startup source route before launch', async () => {
  const harness = createHarness({ startupSourceContractMatched: false });
  await assert.rejects(harness.execute(harness.context('SMOKE-01')), /startup source route/i);
  assert.equal(harness.log.filter(({ event }) => event === 'launch').length, 0);
});

test('SMOKE keeps native prompt absence separate from observed permission changes', async () => {
  const harness = createHarness({ safetyMutation: { permissionAddedEventCount: 1 } });
  const result = await harness.execute(harness.context('SMOKE-01'));
  const binding = semanticBindingFromScenarioResult({
    browser: result.browser,
    completedAt: result.completedAt,
    identity: harness.plan.identity,
    planSha256: harness.plan.planSha256,
    runId: harness.plan.runId,
    scenarioId: 'SMOKE-01',
    startedAt: result.startedAt
  });
  const noAuthorityEvidence = result.evidence.find(
    (entry) => decodeSemanticObservationEvidence(entry, { binding }).assertionId === 'load.no_permission_or_cleanup'
  );
  const payload = decodeSemanticObservationEvidence(noAuthorityEvidence, { binding }).payload;
  assert.equal(payload.permissionAddedEventCount, 1);
  assert.equal(payload.nativePermissionPromptObserved, false);
  assert.equal(Object.hasOwn(payload, 'permissionPromptCount'), false);
});

test('SMOKE records initial or final authority presence as a decisive failure', async () => {
  for (const field of ['initialLocalAuthorityEntryCount', 'initialSessionAuthorityEntryCount']) {
    const harness = createHarness({ safetyMutation: { [field]: 1 } });
    const result = await harness.execute(harness.context('SMOKE-01'));
    const replayed = replay(result, harness.plan, 'SMOKE-01');
    assert.equal(assertion(replayed, 'load.no_permission_or_cleanup').state, 'failed', field);
  }
  for (const field of ['finalLocalAuthorityEntryCount', 'finalSessionAuthorityEntryCount']) {
    const harness = createHarness({ endpointMutation: { [field]: 1 } });
    const result = await harness.execute(harness.context('SMOKE-01'));
    assert.equal(assertion(replay(result, harness.plan, 'SMOKE-01'), 'load.no_permission_or_cleanup').state, 'failed');
  }
});

test('SMOKE rejects native no-prompt evidence that does not cover the final snapshots', async () => {
  const harness = createHarness({ nativeObservedAt: '2026-08-25T12:00:01.500Z' });
  await assert.rejects(harness.execute(harness.context('SMOKE-01')), /did not prove/i);
  assert.equal(harness.log.filter(({ event }) => event === 'native-observer-settle').length, 1);
  assert.equal(harness.log.filter(({ event }) => event === 'native-observer-cancel').length, 0);
  assert.equal(harness.log.filter(({ event }) => event === 'close').length, 0);
});

test('SMOKE cancels an active native observer after a pre-settlement failure and never settles it', async () => {
  const harness = createHarness({ surfaceFailure: 'popup' });
  await assert.rejects(harness.execute(harness.context('SMOKE-01')), /popup observation failed/i);
  assert.equal(harness.log.filter(({ event }) => event === 'native-observer-settle').length, 0);
  assert.equal(harness.log.filter(({ event }) => event === 'native-observer-cancel').length, 1);
  assert.equal(harness.log.filter(({ event }) => event === 'close').length, 0);
});

test('SMOKE fails before starting the native observer when the pre-navigation monitor cannot be installed', async () => {
  const harness = createHarness({ preloadFailure: true });
  await assert.rejects(harness.execute(harness.context('SMOKE-01')), /monitor preload failed/i);
  assert.equal(harness.log.filter(({ event }) => event === 'native-observer-start').length, 0);
  assert.equal(
    harness.log.some(({ event, url }) => event === 'goto' && url.startsWith('chrome-extension://')),
    false
  );
  assert.equal(harness.log.filter(({ event }) => event === 'close').length, 0);
});

test('SMOKE rejects an inexact safety-monitor preload receipt before observer start or Options navigation', async () => {
  const harness = createHarness({ preloadInstalledBeforeNavigation: false });
  await assert.rejects(harness.execute(harness.context('SMOKE-01')), /before Options navigation/i);
  assert.equal(harness.log.filter(({ event }) => event === 'native-observer-start').length, 0);
  assert.equal(
    harness.log.some(({ event, url }) => event === 'goto' && url.startsWith('chrome-extension://')),
    false
  );
  assert.equal(harness.log.filter(({ event }) => event === 'close').length, 0);
});

test('SMOKE production preload registers the exact authority monitor before Options navigation', async () => {
  const harness = createHarness({ useProductionPreload: true });
  await harness.execute(harness.context('SMOKE-01'));
  const preload = harness.log.find(({ event }) => event === 'evaluate-on-new-document');
  const observerStart = harness.log.find(({ event }) => event === 'native-observer-start');
  const optionsNavigation = harness.log.find(
    ({ event, url }) => event === 'goto' && url.startsWith('chrome-extension://')
  );
  assert.deepEqual(preload.argument, {
    bindingName: '__sitewipeReportSmokeSafetyEvent',
    dnrPollIntervalMs: 100,
    globalName: '__sitewipeSmokeSafetyMonitor',
    operation: 'sitewipe-smoke-preload-safety-monitor',
    localKeys: [
      'sitewipe.activeJob.v1',
      'sitewipe.activeShield.v1',
      'sitewipe.permissionLease.v1',
      'sitewipe.activeReport.v1',
      'sitewipe.reports.v1',
      'sitewipe.dnrPendingMutation.v1'
    ],
    reportSchema: 'sitewipe.smoke-safety-monitor-report.v2',
    sessionKeys: [
      'sitewipe.cleanupReview.v1',
      'sitewipe.cleanupPermissionHandoff.v1',
      'sitewipe.dnrPendingMutation.session.v1'
    ]
  });
  assert.ok(preload.index < observerStart.index);
  assert.equal(observerStart.index + 1, optionsNavigation.index);
  const expose = harness.log.find(({ event }) => event === 'expose-function');
  const fixtureNavigation = harness.log.find(({ event, url }) => event === 'goto' && url.startsWith('http://'));
  assert.ok(expose.index < preload.index);
  assert.ok(optionsNavigation.index < fixtureNavigation.index);
  assert.ok(
    preload.operationSource.indexOf('chrome.storage.onChanged.addListener') <
      preload.operationSource.indexOf('const baseline')
  );
  assert.ok(
    preload.operationSource.indexOf('chrome.permissions.onAdded.addListener') <
      preload.operationSource.indexOf('const baseline')
  );
  assert.ok(
    preload.operationSource.indexOf('chrome.downloads.onCreated.addListener') <
      preload.operationSource.indexOf('const baseline')
  );
});

test('SMOKE requires exact native observer readiness before the first extension navigation', async () => {
  const harness = createHarness({ nativeReadinessStatus: 'not-ready' });
  await assert.rejects(harness.execute(harness.context('SMOKE-01')), /not ready.*exact launched browser/i);
  assert.equal(harness.log.filter(({ event }) => event === 'native-observer-start').length, 1);
  assert.equal(harness.log.filter(({ event }) => event === 'native-observer-cancel').length, 1);
  assert.equal(
    harness.log.some(({ event, url }) => event === 'goto' && url.startsWith('chrome-extension://')),
    false
  );
  assert.equal(harness.log.filter(({ event }) => event === 'close').length, 0);
});

test('SMOKE never cancels a native observer after its single-use settle capability was claimed', async () => {
  const harness = createHarness({ nativeSettleFailure: true });
  await assert.rejects(harness.execute(harness.context('SMOKE-01')), /native settlement failed/i);
  assert.equal(harness.log.filter(({ event }) => event === 'native-observer-settle').length, 1);
  assert.equal(harness.log.filter(({ event }) => event === 'native-observer-cancel').length, 0);
  assert.equal(harness.log.filter(({ event }) => event === 'close').length, 0);
});

test('SMOKE fails closed rather than retaining unexpected host origins', async () => {
  const harness = createHarness({ hostPermissionOrigins: ['https://personal.invalid/*'] });
  await assert.rejects(harness.execute(harness.context('SMOKE-01')), /no-authority boundary|host access/i);
  assert.equal(harness.log.filter(({ event }) => event === 'close').length, 0);
});

test('SMOKE emits no assertions when the native observer does not prove prompt absence', async () => {
  const harness = createHarness({ nativePromptStatus: 'invoked' });
  await assert.rejects(harness.execute(harness.context('SMOKE-01')), /did not prove/i);
  assert.equal(harness.log.filter(({ event }) => event === 'native-observer-start').length, 1);
  assert.equal(harness.log.filter(({ event }) => event === 'close').length, 0);
  assert.equal(harness.log.filter(({ event }) => event === 'timestamp').length, 2);
});

test('SMOKE retains observed unsafe defaults as a decisive failed result without invoking cleanup', async () => {
  const settings = structuredClone(SETTINGS_DEFAULTS);
  settings.deleteDownloadedFiles = true;
  const harness = createHarness({ settings });
  const result = await harness.execute(harness.context('SMOKE-01'));
  const replayed = replay(result, harness.plan, 'SMOKE-01');

  assert.equal(assertion(replayed, 'defaults.safe').state, 'failed');
  assert.equal(harness.log.filter(({ event }) => event === 'trigger-action').length, 1);
  assert.equal(
    harness.log.some(({ event }) => event === 'click'),
    false
  );
  assert.equal(
    harness.log.some(({ event }) => event === 'permission-request'),
    false
  );
  assert.equal(
    harness.log.some(({ event }) => event === 'download-delete'),
    false
  );
});

function createHarness(options = {}) {
  const plan = samplePlan();
  const log = [];
  let logIndex = 0;
  const record = (value) => {
    log.push({ ...value, index: logIndex });
    logIndex += 1;
  };
  const fixtureBaseline = {
    dataEntryCount: options.fixtureDataEntryCount ?? 41,
    storageKindCount: options.fixtureStorageKindCount ?? 6,
    inventorySha256: '1'.repeat(64),
    valueSha256: '2'.repeat(64)
  };
  const fixtureCovered = {
    dataEntryCount: options.fixtureAfterDataEntryCount ?? fixtureBaseline.dataEntryCount,
    storageKindCount: options.fixtureAfterStorageKindCount ?? fixtureBaseline.storageKindCount,
    inventorySha256: options.fixtureAfterInventorySha256 || fixtureBaseline.inventorySha256,
    valueSha256: options.fixtureAfterValueSha256 || fixtureBaseline.valueSha256
  };
  const fixtureStates = [
    fixtureBaseline,
    fixtureCovered,
    {
      dataEntryCount: options.fixtureFinalDataEntryCount ?? fixtureCovered.dataEntryCount,
      storageKindCount: options.fixtureFinalStorageKindCount ?? fixtureCovered.storageKindCount,
      inventorySha256: options.fixtureFinalInventorySha256 || fixtureCovered.inventorySha256,
      valueSha256: options.fixtureFinalValueSha256 || fixtureCovered.valueSha256
    }
  ];
  const browser = fakeBrowser({
    log: record,
    plan,
    serviceWorkerPresent: options.serviceWorkerPresent !== false
  });
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
  let timestamps = 0;
  let fixtureObservations = 0;
  let extensionObservations = 0;
  let monitorBarrierCount = 0;
  let nativeSettled = false;
  const monitorState = sampleMonitorState();
  if (options.initialMonitorMutation) Object.assign(monitorState, options.initialMonitorMutation);
  const snapshotMonitor = async () => {
    monitorBarrierCount += 1;
    monitorState.dnrPollCount += 1;
    monitorState.coverageSequence += 2;
    monitorState.coverageObservedAt = new Date(
      Date.parse('2026-08-25T12:00:03.000Z') + monitorBarrierCount * 1000
    ).toISOString();
    if (monitorBarrierCount >= 2 && options.safetyMutation) Object.assign(monitorState, options.safetyMutation);
    if (monitorBarrierCount === 2 && (options.transientDynamicDnr || options.transientSessionDnr)) {
      monitorState.dnrPollNonemptyCount += 1;
    }
    if (nativeSettled && options.lateSafetyMutation) Object.assign(monitorState, options.lateSafetyMutation);
    if (nativeSettled && options.finalMonitorCoverageObservedAt) {
      monitorState.coverageObservedAt = options.finalMonitorCoverageObservedAt;
    }
    record({ event: 'monitor-snapshot-barrier', observation: monitorBarrierCount });
    return structuredClone(monitorState);
  };
  const dependencies = {
    captureArtFacts: async () => sampleArtFacts(plan),
    inspectStartupSourceContract: async () => {
      record({ event: 'inspect-startup-source-contract' });
      return {
        contractSha256: STARTUP_SOURCE_ROUTE_CONTRACT_SHA256,
        matched: options.startupSourceContractMatched ?? true,
        schema: 'sitewipe.smoke-startup-source-route-contract.v1',
        startupMayAddDnrRules: false
      };
    },
    inspectFreshProfile: async () => ({
      profileWasNew: true,
      profileOwnershipMarkerMatched: true,
      profileDataEntryCountBeforeLaunch: options.profileDataEntryCountBeforeLaunch ?? 0
    }),
    inspectFixtureState: async () => {
      record({ event: 'inspect-fixture' });
      return structuredClone(fixtureStates[Math.min(fixtureObservations++, fixtureStates.length - 1)]);
    },
    inspectExtensionState: async (_page, { includeSettings, safetyMonitor }) => {
      const safety = await safetyMonitor.snapshotBarrier();
      const observation = extensionObservations++;
      record({ event: 'inspect-extension', observation });
      return sampleExtensionState({
        hostPermissionOrigins: options.hostPermissionOrigins,
        includeSettings,
        permissionLeaseCount:
          observation > 0
            ? (options.permissionLeaseCountAfterStartup ?? 0)
            : (options.permissionLeaseCountAtStartup ?? 0),
        safety,
        settings: options.settings,
        endpointMutation: observation > 0 ? options.endpointMutation : options.startupEndpointMutation
      });
    },
    observeExactServiceWorker: async (observedBrowser, request) => {
      assert.equal(observedBrowser, browser);
      assert.deepEqual(request, {
        extensionId,
        serviceWorkerPath: 'background/service-worker.js'
      });
      if (options.serviceWorkerPresent === false) {
        throw new Error('The exact SiteWipe MV3 service-worker target was not observed.');
      }
      return true;
    },
    observeSurface: async (page, request) => {
      if (options.surfaceFailure === request.name) throw new Error(`Synthetic ${request.name} observation failed.`);
      assert.equal(page.url(), request.expectedUrl);
      record({ event: 'observe-surface', name: request.name });
      return {
        name: request.name,
        documentTitle: request.expectedTitle,
        originScheme: 'chrome-extension',
        readyState: 'complete',
        visible: true
      };
    },
    seedFixtureState: async () => {
      record({ event: 'seed-fixture' });
      return {
        baselineDataEntryCount: options.seedBaselineDataEntryCount ?? options.fixtureDataEntryCount ?? 41,
        baselineInventorySha256: options.seedBaselineInventorySha256 || '1'.repeat(64),
        baselineStorageKindCount: options.seedBaselineStorageKindCount ?? options.fixtureStorageKindCount ?? 6,
        baselineValueSha256: options.seedBaselineValueSha256 || '2'.repeat(64),
        fixtureVersion: 'sitewipe-synthetic-v1',
        scale: 'small',
        schema: 'sitewipe.synthetic-fixture-seed-receipt.v2',
        seeded: options.fixtureSeeded ?? true,
        snapshotSha256: '3'.repeat(64)
      };
    },
    preloadSafetyMonitor: async () => {
      record({ event: 'preload-safety-monitor' });
      if (options.preloadFailure) throw new Error('Synthetic monitor preload failed.');
      return {
        installedBeforeNavigation: options.preloadInstalledBeforeNavigation ?? true,
        schema: 'sitewipe.smoke-safety-monitor-preload.v2',
        snapshotBarrier: snapshotMonitor
      };
    },
    startNativePromptObserver: async () => {
      record({ event: 'native-observer-start' });
      return {
        cancelAndWait: async () => {
          record({ event: 'native-observer-cancel' });
          return {
            schema: 'sitewipe.native-permission-helper-settlement.v1',
            processId: 4321,
            status: 'terminated_and_settled'
          };
        },
        readiness: {
          action: 'observe-none',
          browserName: 'chrome',
          browserVersion: plan.inputs.browserPins.find(({ name }) => name === 'chrome').version,
          helperProcessId: 4321,
          readyAt: '2026-08-25T12:00:01.500Z',
          scenarioId: 'SMOKE-01',
          scheduleId: 'SMOKE-01.observe-none',
          schema: 'sitewipe.native-permission-helper-ready.v1',
          status: options.nativeReadinessStatus || 'ready',
          targetProcess: {
            path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            processId: 2468,
            sha256: '8'.repeat(64),
            startTimeUtcTicks: '9876543210'
          }
        },
        settle: async () => {
          record({ event: 'native-observer-settle' });
          if (options.nativeSettleFailure) throw new Error('Synthetic native settlement failed.');
          nativeSettled = true;
          return {
            schema: 'sitewipe.native-permission-dialog-evidence.v1',
            status: options.nativePromptStatus || 'no_prompt_observed',
            scheduleId: 'SMOKE-01.observe-none',
            scenarioId: 'SMOKE-01',
            action: 'observe-none',
            observedAt: options.nativeObservedAt || '2026-08-25T12:00:03.000Z'
          };
        }
      };
    }
  };
  if (options.useProductionPreload) delete dependencies.preloadSafetyMonitor;
  const execute = createAuthenticScenarioExecutor(dependencies);

  return {
    plan,
    log,
    execute,
    context(scenarioId) {
      const browserPin = plan.inputs.browserPins.find(({ name }) => name === 'chrome');
      return {
        browser: structuredClone(browserPin),
        captureTimestamp() {
          const timestamp = new Date(Date.parse('2026-08-25T12:00:01.000Z') + timestamps * 1000).toISOString();
          timestamps += 1;
          record({ event: 'timestamp', timestamp });
          return timestamp;
        },
        cell: {
          browserName: 'chrome',
          scenarioId,
          profilePath: 'C:\\sitewipe-disposable\\profile',
          canaryPath: 'C:\\sitewipe-disposable\\downloads\\must-preserve.bin',
          canarySha256: '7'.repeat(64)
        },
        fixtures: {
          ipv4: {
            host: '127.0.0.1',
            port: 43822,
            runToken: FIXTURE_TOKEN,
            runTokenSha256: FIXTURE_TOKEN_SHA256
          },
          ipv6: {
            host: '::1',
            port: 43822,
            runToken: FIXTURE_TOKEN,
            runTokenSha256: FIXTURE_TOKEN_SHA256
          }
        },
        launched: (() => {
          const extension = {
            id: extensionId,
            name: 'SiteWipe',
            version: options.extensionVersion || plan.identity.artifactVersion,
            enabled: true
          };
          return {
            browser,
            extension,
            receipt: sampleLaunchReceipt({ extension, plan }),
            async triggerAction(page, triggerOptions) {
              record({ event: 'trigger-action' });
              assert.equal(page.browser(), browser);
              assert.deepEqual(triggerOptions, { timeoutMs: 10_000 });
              const popupUrl = `chrome-extension://${extensionId}/popup/popup.html`;
              const popupPage = fakePage({ browser, initialUrl: popupUrl, log: record });
              return {
                page: popupPage,
                receipt: {
                  schema: 'sitewipe.authentic-extension-action.v1',
                  extensionId,
                  targetOrigin: 'http://selected.example.com:43822',
                  popupUrl,
                  targetTypeBeforeAsPage: 'other',
                  invocation: 'puppeteer-extension-triggerAction',
                  scriptOrDomInjectionUsed: false
                }
              };
            }
          };
        })(),
        plan,
        proxy: { schema: 'sitewipe.loopback-deny-proxy.v1', host: '127.0.0.1', port: 49152 },
        runtime: sampleRuntime(plan),
        scenario: { id: scenarioId }
      };
    }
  };
}

function fakeBrowser({ log, plan, serviceWorkerPresent }) {
  const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
  const serviceWorkerUrl = `chrome-extension://${extensionId}/background/service-worker.js`;
  const target = {
    type: () => 'service_worker',
    url: () => serviceWorkerUrl
  };
  const browser = {
    async newPage() {
      const page = fakePage({ browser, initialUrl: 'about:blank', log });
      return page;
    },
    targets() {
      return serviceWorkerPresent ? [target] : [];
    },
    async waitForTarget(predicate) {
      if (serviceWorkerPresent && predicate(target)) return target;
      throw new Error(`No service worker for ${plan.runId}.`);
    }
  };
  return browser;
}

function fakePage({ browser, initialUrl, log }) {
  let currentUrl = initialUrl;
  let preloadArgument = null;
  let monitorDocumentId = null;
  let monitorTick = 0;
  const exposed = new Map();
  const monitorTimestamp = () => new Date(Date.parse('2026-08-25T12:00:03.000Z') + monitorTick++ * 1000).toISOString();
  const reportMonitor = async (message) => {
    const binding = exposed.get(preloadArgument?.bindingName);
    if (typeof binding !== 'function') throw new Error('Synthetic page lacks the exposed SMOKE monitor binding.');
    await binding({
      documentId: monitorDocumentId,
      observedAt: monitorTimestamp(),
      schema: preloadArgument.reportSchema,
      ...message
    });
  };
  return {
    browser: () => browser,
    url: () => currentUrl,
    async goto(url) {
      currentUrl = url;
      log({ event: 'goto', url });
      if (url.startsWith('chrome-extension://') && preloadArgument) {
        monitorDocumentId = '11111111-1111-4111-8111-111111111111';
        await reportMonitor({
          localKeys: preloadArgument.localKeys,
          sessionKeys: preloadArgument.sessionKeys,
          type: 'document-ready'
        });
        await reportMonitor({
          dynamicRuleCount: 0,
          initialLocalAuthorityEntryCount: 0,
          initialSessionAuthorityEntryCount: 0,
          sessionRuleCount: 0,
          type: 'baseline'
        });
        await reportMonitor({ dynamicRuleCount: 0, sessionRuleCount: 0, type: 'dnr-poll' });
      }
      return { status: () => 200 };
    },
    async evaluate(_operation, argument) {
      if (argument === '__sitewipeSmokeSafetyMonitor' && monitorDocumentId) {
        await reportMonitor({ dynamicRuleCount: 0, sessionRuleCount: 0, type: 'dnr-poll' });
        await reportMonitor({ type: 'barrier' });
        return;
      }
      throw new Error(`Unexpected direct fake-page evaluation: ${argument?.operation || String(argument)}`);
    },
    async evaluateOnNewDocument(operation, argument) {
      assert.equal(typeof operation, 'function');
      preloadArgument = structuredClone(argument);
      log({
        event: 'evaluate-on-new-document',
        argument: structuredClone(argument),
        operationSource: operation.toString()
      });
      return { identifier: 'sitewipe-smoke-safety-monitor-preload' };
    },
    async exposeFunction(name, callback) {
      exposed.set(name, callback);
      log({ event: 'expose-function', name });
    },
    async bringToFront() {},
    async waitForFunction() {}
  };
}

function sampleLaunchReceipt({ extension, plan }) {
  return {
    schema: 'sitewipe.launched-installed-browser.v1',
    runId: plan.runId,
    planSha256: plan.planSha256,
    browserName: 'chrome',
    extensionId: extension.id,
    extensionName: extension.name,
    extensionVersion: extension.version,
    processIdentity: {
      processId: 2468,
      path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      sha256: '8'.repeat(64),
      startTimeUtcTicks: '9876543210'
    },
    launchPolicy: {
      headless: false,
      pipe: true,
      existingProfile: false,
      incognitoExtensionAccess: false,
      argumentTemplates: ['--disable-sync']
    }
  };
}

function sampleRuntime(plan) {
  return {
    artifactVersion: plan.identity.artifactVersion,
    manifest: {
      manifestVersion: 3,
      name: 'SiteWipe',
      serviceWorker: 'background/service-worker.js',
      defaultPopup: 'popup/popup.html',
      optionsPage: 'options/options.html'
    }
  };
}

function sampleArtFacts(plan) {
  return {
    exactHead: {
      clean: true,
      commitSha: plan.identity.sourceCommitSha,
      indexDeltaCount: 0,
      treeSha: plan.identity.sourceTreeSha,
      untrackedEntryCount: 0,
      worktreeDeltaCount: 0
    },
    artifact: {
      artifactBytes: plan.identity.artifactBytes,
      artifactSha256: plan.identity.artifactSha256,
      artifactVersion: plan.identity.artifactVersion,
      manifestSha256: '2'.repeat(64),
      manifestVersion: plan.identity.artifactVersion,
      runtimeEntryCount: 61,
      zipVerificationPassed: true
    },
    parity: {
      artifactRuntimeFileCount: 61,
      artifactRuntimeFingerprintSha256: plan.identity.runtimeFingerprintSha256,
      mismatchCount: 0,
      sourceRuntimeFileCount: 61,
      sourceRuntimeFingerprintSha256: plan.identity.runtimeFingerprintSha256
    }
  };
}

function sampleExtensionState(options = {}) {
  const hostPermissionOrigins = structuredClone(options.hostPermissionOrigins || []);
  const safety = structuredClone(options.safety || sampleMonitorState());
  const endpoint = {
    dynamicDnrRuleCount: 0,
    dynamicDnrRulesSha256: EMPTY_RULE_SET_SHA256,
    finalLocalAuthorityEntryCount: 0,
    finalSessionAuthorityEntryCount: 0,
    sessionDnrRuleCount: 0,
    sessionDnrRulesSha256: EMPTY_RULE_SET_SHA256,
    ...(options.endpointMutation || {})
  };
  return {
    downloadCreatedEventCount: safety.downloadCreatedEventCount,
    downloadErasedEventCount: safety.downloadErasedEventCount,
    dnrBaselineNonemptyCount: safety.dnrBaselineNonemptyCount,
    dnrPollCount: safety.dnrPollCount,
    dnrPollErrorCount: safety.dnrPollErrorCount,
    dnrPollIntervalMs: safety.dnrPollIntervalMs,
    dnrPollMaximumObservedGapMs: safety.dnrPollMaximumObservedGapMs,
    dnrPollNonemptyCount: safety.dnrPollNonemptyCount,
    ...endpoint,
    hostPermissionOrigins: [],
    initialLocalAuthorityEntryCount: safety.initialLocalAuthorityEntryCount,
    initialSessionAuthorityEntryCount: safety.initialSessionAuthorityEntryCount,
    localAuthorityChangedKeyCount: safety.localAuthorityChangedKeyCount,
    monitorBaselineAcknowledgedCount: safety.baselineAcknowledgedCount,
    monitorBaselineErrorCount: safety.baselineErrorCount,
    monitorCoverageObservedAt: safety.coverageObservedAt,
    monitorCoverageSequence: safety.coverageSequence,
    monitorDocumentReadyCount: safety.documentReadyCount,
    monitorReadyAt: safety.firstBaselineAt,
    permissionAddedEventCount: safety.permissionAddedEventCount,
    permissionLeaseCount: options.permissionLeaseCount || 0,
    permissionRemovedEventCount: safety.permissionRemovedEventCount,
    reportCount: 0,
    runningJobCount: 0,
    sessionAuthorityChangedKeyCount: safety.sessionAuthorityChangedKeyCount,
    settings: options.includeSettings === false ? null : structuredClone(options.settings || SETTINGS_DEFAULTS),
    unexpectedHostPermissionOriginCount: hostPermissionOrigins.length
  };
}

function sampleMonitorState() {
  return {
    baselineAcknowledgedCount: 1,
    baselineErrorCount: 0,
    coverageObservedAt: '2026-08-25T12:00:03.000Z',
    coverageSequence: 2,
    documentReadyCount: 1,
    downloadCreatedEventCount: 0,
    downloadErasedEventCount: 0,
    dnrBaselineNonemptyCount: 0,
    dnrPollCount: 0,
    dnrPollErrorCount: 0,
    dnrPollIntervalMs: 100,
    dnrPollMaximumObservedGapMs: 100,
    dnrPollNonemptyCount: 0,
    firstBaselineAt: '2026-08-25T12:00:02.000Z',
    initialLocalAuthorityEntryCount: 0,
    initialSessionAuthorityEntryCount: 0,
    localAuthorityChangedKeyCount: 0,
    permissionAddedEventCount: 0,
    permissionRemovedEventCount: 0,
    sessionAuthorityChangedKeyCount: 0
  };
}

function samplePlan() {
  const identity = {
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
  return {
    runId: `sitewipe-browser-${'a'.repeat(32)}`,
    planSha256: '9'.repeat(64),
    semanticValidatorManifestSha256: SEMANTIC_VALIDATOR_MANIFEST_SHA256,
    identity,
    inputs: {
      repositoryRoot: 'C:\\sitewipe\\repository',
      artifactPath: 'C:\\sitewipe\\artifact.zip',
      git: {
        path: 'C:\\Program Files\\Git\\cmd\\git.exe',
        sha256: identity.gitExecutableSha256,
        version: 'git version 2.51.0.windows.1'
      },
      fixture: {
        allowedHosts: [
          '127.0.0.1',
          '::1',
          'alice.blogspot.com',
          'bob.blogspot.com',
          'chips.localhost',
          'localhost',
          'selected.example.com',
          'selected.example.com.evil.invalid',
          'sub.selected.example.com'
        ]
      },
      browserPins: [
        {
          name: 'chrome',
          version: '151.0.7922.174',
          executableSha256: '8'.repeat(64),
          executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
        }
      ]
    }
  };
}

function replay(result, plan, scenarioId) {
  return deriveSemanticScenarioAssertions({
    result: {
      scenarioId,
      browser: result.browser,
      runId: plan.runId,
      planSha256: plan.planSha256,
      identity: plan.identity,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      evidence: result.evidence
    }
  });
}

function assertion(replayResult, id) {
  return replayResult.assertions.find((entry) => entry.id === id);
}

function noAuthorityPayload(result, plan) {
  const binding = semanticBindingFromScenarioResult({
    browser: result.browser,
    completedAt: result.completedAt,
    identity: plan.identity,
    planSha256: plan.planSha256,
    runId: plan.runId,
    scenarioId: 'SMOKE-01',
    startedAt: result.startedAt
  });
  const evidence = result.evidence.find(
    (entry) => decodeSemanticObservationEvidence(entry, { binding }).assertionId === 'load.no_permission_or_cleanup'
  );
  return decodeSemanticObservationEvidence(evidence, { binding }).payload;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

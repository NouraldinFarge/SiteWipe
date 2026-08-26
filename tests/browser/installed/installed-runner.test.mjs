import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { FIXTURE_ALLOWED_METHODS, FIXTURE_ALLOWED_ROUTES, SYNTHETIC_FIXTURE_HOSTS } from '../fixture-server.mjs';

import {
  BROWSER_MATRIX_VERSION,
  CANONICAL_BROWSER_MATRIX,
  CANONICAL_BROWSER_MATRIX_IDS,
  CANONICAL_BROWSER_MATRIX_SHA256,
  REQUIRED_BROWSERS
} from './canonical-matrix.mjs';
import {
  APPROVED_UNATTENDED_ACTIONS,
  BROWSER_PLAN_SCHEMA,
  FIXED_FIXTURE_BIND_ADDRESSES,
  SEMANTIC_VALIDATION_STATUS,
  aggregateBrowserEvidence,
  computeAggregateSha256,
  computePlanSha256,
  createScenarioResultRecord,
  validateBrowserPlan,
  validateScenarioResult
} from './evidence-contract.mjs';
import {
  DEFAULT_INSTALLED_BROWSER_RUNNER_DEPENDENCIES,
  INSTALLED_BROWSER_CLOSE_SETTLEMENT_TIMEOUT_MS,
  INSTALLED_BROWSER_LAUNCH_SETTLEMENT_TIMEOUT_MS,
  INSTALLED_BROWSER_PUBLIC_PROJECTION_SCHEMA,
  browserRunFailureSettlementDigest,
  createExactFixtureDestinationMap,
  createInstalledBrowserRunner
} from './installed-runner.mjs';
import { INSTALLED_RUNTIME_LAUNCH_POLICY, INSTALLED_RUNTIME_LAUNCH_POLICY_SHA256 } from './launch-policy.mjs';
import { INSTALLED_RUNTIME_CLOSE_POLICY_BOUND_MS } from './runtime-executor.mjs';
import { LOOPBACK_DENY_PROXY_SCHEMA } from './loopback-deny-proxy.mjs';
import {
  NATIVE_PROMPT_ALLOWED_ACTIONS,
  NATIVE_PROMPT_EXPECTED_FRAGMENTS,
  NATIVE_PROMPT_PERMISSION_PATTERNS,
  NATIVE_PROMPT_POLICY_SHA256,
  NATIVE_PROMPT_SCENARIO_SCHEDULE,
  NATIVE_PROMPT_UIA_SNAPSHOTS
} from './native-permission-dialog.mjs';
import {
  SEMANTIC_VALIDATOR_MANIFEST_SHA256,
  createSemanticObservationEvidence,
  semanticScenarioImplementationStatus
} from './semantic-validator.mjs';
import { computeBrowserRuntimeSetSha256 } from './browser-runtime-closure.mjs';

const FIXTURE_TOKEN = 'f'.repeat(64);
const FIXTURE_TOKEN_SHA256 = sha256(FIXTURE_TOKEN);

test('runner creates 48 ordered isolated records, skips unsupported launches, preserves failed evidence, and reconciles once', async () => {
  const plan = samplePlan();
  const harness = createHarness({ plan, includeFailedObservation: true, throwCell: 'SMOKE-01/brave' });
  const run = createInstalledBrowserRunner(harness.dependencies);
  const result = await run({ plan, approvalSha256: plan.planSha256 });

  assert.equal(harness.log.filter(({ event }) => event === 'prepare').length, 1);
  assert.equal(harness.log.filter(({ event }) => event === 'stage-runtime').length, 1);
  const staged = harness.log.filter(({ event }) => event === 'stage-cell');
  assert.equal(staged.length, 48);
  assert.equal(new Set(staged.map(({ profilePath }) => profilePath.toLowerCase())).size, 48);
  assert.deepEqual(
    staged.map(({ cell }) => cell),
    expectedCellOrder()
  );

  const executed = harness.log.filter(({ event }) => event === 'execute').map(({ cell }) => cell);
  const supported = CANONICAL_BROWSER_MATRIX.filter(
    ({ id }) => semanticScenarioImplementationStatus(id) !== 'not_implemented'
  ).flatMap(({ id }) => REQUIRED_BROWSERS.map((browser) => `${id}/${browser}`));
  assert.deepEqual(executed, supported);

  const launched = harness.log.filter(({ event }) => event === 'launch').map(({ cell }) => cell);
  assert.deepEqual(launched, supported);
  assert.equal(
    launched.some((cell) => semanticScenarioImplementationStatus(cell.split('/')[0]) === 'not_implemented'),
    false
  );
  assert.equal(harness.log.filter(({ event }) => event === 'browser-close').length, launched.length);
  for (const cell of launched) {
    assert.equal(harness.log.filter((entry) => entry.event === 'browser-close' && entry.cell === cell).length, 1);
  }

  const recordEvents = harness.log.filter(({ event }) => event === 'record');
  assert.equal(recordEvents.length, 48);
  assert.deepEqual(
    recordEvents.map(({ cell }) => cell),
    expectedCellOrder()
  );
  assert.equal(result.aggregate.resultRecordCount, 48);
  assert.equal(result.aggregate.cells.length, 48);
  assert.deepEqual(result.aggregate.counts, { passed: 0, failed: 1, limited: 0, not_run: 47 });
  assert.equal(findCell(result.aggregate, 'ART-01', 'chrome').state, 'failed');
  assert.equal(findCell(result.aggregate, 'SMOKE-01', 'brave').state, 'not_run');
  assert.match(findCell(result.aggregate, 'SMOKE-01', 'brave').finding, /cell_execution_failed/);

  const closureEvents = harness.log
    .filter(({ event }) => ['proxy-close', 'fixture-close'].includes(event))
    .map((entry) => (entry.event === 'proxy-close' ? 'proxy' : entry.host));
  assert.deepEqual(closureEvents, ['proxy', '::1', '127.0.0.1']);
  assert.ok(
    harness.log.findIndex(({ event }) => event === 'complete') >
      harness.log.findIndex(({ event, host }) => event === 'fixture-close' && host === '127.0.0.1')
  );
  assert.equal(harness.log.filter(({ event }) => event === 'complete').length, 1);

  assert.equal(result.publicProjection.schema, INSTALLED_BROWSER_PUBLIC_PROJECTION_SCHEMA);
  assert.equal(result.publicProjection.resultRecordCount, 48);
  assert.equal(result.publicProjection.networkReconciled, true);
  assert.equal(result.publicProjection.completion.retained, true);
  assert.equal(result.publicProjection.completion.automaticRecursiveDeletionPerformed, false);
  assertPublicProjectionIsPathAndSecretFree(result.publicProjection);
});

test('runner fails closed on a dual-stack port mismatch without starting a proxy, hook, or browser', async () => {
  const plan = samplePlan();
  const harness = createHarness({ plan, mismatchedIpv6Port: true });
  const result = await createInstalledBrowserRunner(harness.dependencies)({
    plan,
    approvalSha256: plan.planSha256
  });

  assert.equal(harness.log.filter(({ event }) => event === 'stage-runtime').length, 1);
  assert.equal(harness.log.filter(({ event }) => event === 'fixture-start').length, 2);
  assert.equal(
    harness.log.some(({ event }) => event === 'proxy-start'),
    false
  );
  assert.equal(
    harness.log.some(({ event }) => event === 'execute'),
    false
  );
  assert.equal(
    harness.log.some(({ event }) => event === 'launch'),
    false
  );
  assert.equal(harness.log.filter(({ event }) => event === 'stage-cell').length, 48);
  assert.equal(harness.log.filter(({ event }) => event === 'record').length, 48);
  assert.deepEqual(result.aggregate.counts, { passed: 0, failed: 0, limited: 0, not_run: 48 });
  assert.match(result.aggregate.cells[0].finding, /fixture_or_proxy_setup_failed/);
  assert.deepEqual(
    harness.log.filter(({ event }) => event === 'fixture-close').map(({ host }) => host),
    ['::1', '127.0.0.1']
  );
  assertPublicProjectionIsPathAndSecretFree(result.publicProjection);
});

test('browser teardown failure terminally refuses the owned run before any later launch', async () => {
  const plan = samplePlan();
  const cell = 'ART-01/chrome';
  const harness = createHarness({
    plan,
    includeFailedObservation: true,
    closeFailureCell: cell
  });
  await assert.rejects(
    createInstalledBrowserRunner(harness.dependencies)({ plan, approvalSha256: plan.planSha256 }),
    /cleanup did not establish one exact clean zero-residue receipt/
  );
  assert.equal(harness.log.filter((entry) => entry.event === 'browser-close' && entry.cell === cell).length, 1);
  assert.equal(harness.log.filter(({ event }) => event === 'launch').at(-1)?.cell, cell);
  assert.equal(harness.log.filter(({ event }) => event === 'owned-retain-failure').length, 1);
  assert.equal(harness.log.filter(({ event }) => event === 'proxy-close').length, 1);
  assert.equal(harness.log.filter(({ event }) => event === 'fixture-close').length, 2);
});

test('central teardown validation terminally refuses an attention-required receipt before any later launch', async () => {
  const plan = samplePlan();
  const cell = 'ART-01/chrome';
  const harness = createHarness({
    plan,
    includeFailedObservation: true,
    closeReceiptForCell({ cell: observedCell, receipt }) {
      return observedCell === cell
        ? {
            ...receipt,
            gracefulCloseError: 'synthetic close uncertainty',
            observationStatus: 'attention_required'
          }
        : receipt;
    }
  });
  await assert.rejects(
    createInstalledBrowserRunner(harness.dependencies)({ plan, approvalSha256: plan.planSha256 }),
    /cleanup did not establish one exact clean zero-residue receipt/
  );
  assert.equal(harness.log.filter((entry) => entry.event === 'browser-close' && entry.cell === cell).length, 1);
  assert.equal(harness.log.filter(({ event }) => event === 'launch').at(-1)?.cell, cell);
  assert.equal(harness.log.filter(({ event }) => event === 'owned-retain-failure').length, 1);
});

test('runner-owned lifecycle removes hook launch/close authority and adopts thenables, Promise.resolve/all, and delayed results', async () => {
  const plan = samplePlan();
  const modes = new Map([
    ['ART-01/chrome', 'then'],
    ['ART-01/brave', 'promise-resolve'],
    ['SMOKE-01/chrome', 'promise-all'],
    ['SMOKE-01/brave', 'delayed'],
    ['SETTINGS-01/chrome', 'finalizer-then'],
    ['SETTINGS-01/brave', 'finalizer-promise-all']
  ]);
  const harness = createHarness({ plan, includeFailedObservation: true, hookModeByCell: modes });
  const result = await createInstalledBrowserRunner(harness.dependencies)({
    plan,
    approvalSha256: plan.planSha256
  });

  for (const [cell] of modes) {
    const [scenarioId, browserName] = cell.split('/');
    assert.equal(harness.log.filter((entry) => entry.event === 'launch' && entry.cell === cell).length, 1);
    assert.equal(harness.log.filter((entry) => entry.event === 'browser-close' && entry.cell === cell).length, 1);
    assert.notEqual(findCell(result.aggregate, scenarioId, browserName).finding, 'browser_lifecycle_uncertain');
  }
  assert.equal(harness.pendingLifecycleOperations(), 0);
});

test('runner bounds a never-settling partial launch, closes its registered owner once, and refuses the whole run', async () => {
  assert.ok(INSTALLED_BROWSER_LAUNCH_SETTLEMENT_TIMEOUT_MS > INSTALLED_RUNTIME_LAUNCH_POLICY.launchTimeoutMs + 30_000);
  assert.ok(INSTALLED_BROWSER_CLOSE_SETTLEMENT_TIMEOUT_MS > INSTALLED_RUNTIME_CLOSE_POLICY_BOUND_MS);
  const plan = samplePlan();
  const cell = 'ART-01/chrome';
  const harness = createHarness({
    plan,
    includeFailedObservation: true,
    lifecycleTimerDelayMs: 20,
    neverSettlingLaunchCell: cell
  });
  await assert.rejects(
    createInstalledBrowserRunner(harness.dependencies)({ plan, approvalSha256: plan.planSha256 }),
    /launch remained live after cancellation grace/
  );
  assert.equal(harness.log.filter((entry) => entry.event === 'browser-close' && entry.cell === cell).length, 1);
  assert.equal(harness.log.filter(({ event }) => event === 'owned-retain-failure').length, 1);
});

test('runner bounds never-settling hooks and post-close finalizers, closes once, and refuses the whole run', async () => {
  for (const mode of ['never', 'finalizer-never']) {
    const plan = samplePlan();
    const cell = 'ART-01/chrome';
    const harness = createHarness({
      plan,
      hookModeByCell: new Map([[cell, mode]]),
      lifecycleTimerDelayMs: 20
    });
    await assert.rejects(
      createInstalledBrowserRunner(harness.dependencies)({ plan, approvalSha256: plan.planSha256 }),
      /(?:scenario-hook|post-close finalizer) remained live after cancellation grace/
    );
    assert.equal(harness.log.filter((entry) => entry.event === 'browser-close' && entry.cell === cell).length, 1);
    assert.equal(harness.log.filter(({ event }) => event === 'owned-retain-failure').length, 1);
  }
});

test('a never-settling central close terminally refuses the run before any later cell can launch', async () => {
  const plan = samplePlan();
  const cell = 'ART-01/chrome';
  const harness = createHarness({
    plan,
    lifecycleTimerDelayMs: 20,
    neverSettlingCloseCell: cell
  });
  await assert.rejects(
    createInstalledBrowserRunner(harness.dependencies)({ plan, approvalSha256: plan.planSha256 }),
    /central-close remained live after cancellation grace/
  );
  assert.equal(harness.log.filter((entry) => entry.event === 'browser-close' && entry.cell === cell).length, 1);
  const launches = harness.log.filter(({ event }) => event === 'launch');
  assert.equal(launches.filter((entry) => entry.cell === cell).length, 1);
  assert.equal(launches.at(-1)?.cell, cell);
  assert.equal(harness.log.filter(({ event }) => event === 'owned-retain-failure').length, 1);
});

test('late cleanup registration reuses one close operation and observes a rejecting cleanup without restoring eligibility', async () => {
  const plan = samplePlan();
  const cell = 'ART-01/chrome';
  const harness = createHarness({
    closeFailureCell: cell,
    lateCleanupRegistrationCell: cell,
    lifecycleTimerDelayMs: 20,
    plan
  });
  await assert.rejects(
    createInstalledBrowserRunner(harness.dependencies)({ plan, approvalSha256: plan.planSha256 }),
    /launch remained live after cancellation grace/
  );
  await delay(30);
  assert.equal(harness.log.filter((entry) => entry.event === 'browser-close' && entry.cell === cell).length, 1);
  const launches = harness.log.filter(({ event }) => event === 'launch');
  assert.equal(launches.filter((entry) => entry.cell === cell).length, 1);
  assert.equal(launches.at(-1)?.cell, cell);
});

test('fallback controller adoption guards hostile close access and preserves the close receiver', async () => {
  {
    const plan = samplePlan();
    const cell = `ART-01/${REQUIRED_BROWSERS[0]}`;
    const harness = createHarness({ plan });
    const conformingLaunch = harness.dependencies.launchPinnedSiteWipeBrowser;
    let receiverBoundCloseCalls = 0;
    harness.dependencies.launchPinnedSiteWipeBrowser = async (options) => {
      if (`${options.scenarioId}/${options.browserName}` !== cell) {
        return conformingLaunch(options);
      }
      const base = await conformingLaunch({ ...options, registerCleanup() {} });
      const candidate = {
        ...base,
        async close() {
          assert.equal(this, candidate);
          receiverBoundCloseCalls += 1;
          return base.close();
        }
      };
      return candidate;
    };

    const result = await createInstalledBrowserRunner(harness.dependencies)({
      plan,
      approvalSha256: plan.planSha256
    });

    assert.equal(receiverBoundCloseCalls, 1);
    assert.equal(findCell(result.aggregate, 'ART-01', REQUIRED_BROWSERS[0]).state, 'not_run');
    assert.match(findCell(result.aggregate, 'ART-01', REQUIRED_BROWSERS[0]).finding, /browser_launch_failed/);
  }

  {
    const plan = samplePlan();
    const cell = `ART-01/${REQUIRED_BROWSERS[0]}`;
    const harness = createHarness({ plan });
    const conformingLaunch = harness.dependencies.launchPinnedSiteWipeBrowser;
    let hostileGetterReads = 0;
    harness.dependencies.launchPinnedSiteWipeBrowser = async (options) => {
      if (`${options.scenarioId}/${options.browserName}` !== cell) {
        return conformingLaunch(options);
      }
      return Object.defineProperty({}, 'close', {
        get() {
          hostileGetterReads += 1;
          throw new Error('Hostile synthetic close getter.');
        }
      });
    };

    await assert.rejects(
      createInstalledBrowserRunner(harness.dependencies)({ plan, approvalSha256: plan.planSha256 }),
      /cleanup did not establish one exact clean zero-residue receipt/
    );
    await delay(0);

    assert.equal(hostileGetterReads, 2);
    assert.equal(harness.log.filter(({ event }) => event === 'launch').length, 0);
    assert.equal(harness.log.filter(({ event }) => event === 'owned-retain-failure').length, 1);
  }
});

test('central teardown validation terminally refuses every invalid identity, residue, canary, and deletion receipt', async () => {
  const mutations = [
    (receipt) => ({ ...receipt, planSha256: '0'.repeat(64) }),
    (receipt) => ({
      ...receipt,
      profileProcessResidueCount: 1,
      processResidue: {
        ...receipt.processResidue,
        residues: [
          {
            commandLineSha256: null,
            matchedBy: ['process-tree'],
            parentProcessId: 1,
            path: null,
            processId: 9999,
            sha256: null,
            startTimeUtcTicks: '2'
          }
        ]
      }
    }),
    (receipt) => ({
      ...receipt,
      mustPreserveDownloadCanary: { ...receipt.mustPreserveDownloadCanary, preserved: false }
    }),
    (receipt) => ({ ...receipt, automaticProfileDeletionPerformed: true }),
    (receipt) => ({ ...receipt, automaticDownloadDeletionPerformed: true }),
    (receipt) => ({ ...receipt, browserName: 'brave' })
  ];

  for (const mutate of mutations) {
    const plan = samplePlan();
    const cell = 'ART-01/chrome';
    const harness = createHarness({
      plan,
      includeFailedObservation: true,
      closeReceiptForCell({ cell: observedCell, receipt }) {
        return observedCell === cell ? mutate(receipt) : receipt;
      }
    });
    await assert.rejects(
      createInstalledBrowserRunner(harness.dependencies)({ plan, approvalSha256: plan.planSha256 }),
      /cleanup did not establish one exact clean zero-residue receipt/
    );
    assert.equal(harness.log.filter((entry) => entry.event === 'browser-close' && entry.cell === cell).length, 1);
    assert.equal(harness.log.filter(({ event }) => event === 'launch').at(-1)?.cell, cell);
    assert.equal(harness.log.filter(({ event }) => event === 'owned-retain-failure').length, 1);
  }
});

test('scenario Page capability exposes no raw browser, context, frame, handle, or CDP route', async () => {
  const plan = samplePlan();
  const cell = 'ART-01/chrome';
  const harness = createHarness({
    plan,
    includeFailedObservation: true,
    hookModeByCell: new Map([[cell, 'assert-explicit-page-capability']])
  });
  const result = await createInstalledBrowserRunner(harness.dependencies)({
    plan,
    approvalSha256: plan.planSha256
  });
  assert.equal(findCell(result.aggregate, 'ART-01', 'chrome').state, 'failed');
  assert.equal(
    harness.log.filter((entry) => entry.event === 'indirect-browser-close' && entry.cell === cell).length,
    0
  );
  assert.equal(harness.log.filter((entry) => entry.event === 'browser-close' && entry.cell === cell).length, 1);
  assert.equal(harness.log.filter(({ event }) => event === 'owned-retain-failure').length, 0);
});

test('scenario capabilities reject callable Page and Target values instead of forwarding them', async () => {
  const plan = samplePlan();
  const modes = new Map([
    ['ART-01/chrome', 'reject-callable-page'],
    ['ART-01/brave', 'reject-callable-target']
  ]);
  const harness = createHarness({ plan, hookModeByCell: modes });
  const result = await createInstalledBrowserRunner(harness.dependencies)({
    plan,
    approvalSha256: plan.planSha256
  });

  for (const cell of modes.keys()) {
    const [scenarioId, browserName] = cell.split('/');
    assert.equal(findCell(result.aggregate, scenarioId, browserName).state, 'not_run');
    assert.equal(harness.log.filter((entry) => entry.event === 'browser-close' && entry.cell === cell).length, 1);
  }
  assert.equal(harness.log.filter(({ event }) => event === 'owned-retain-failure').length, 0);
});

test('network reconciliation attempts every owned listener once and reports close failures without deleting or retrying', async () => {
  const plan = samplePlan();
  const harness = createHarness({ plan, networkCloseFailures: ['proxy', '::1'] });
  const result = await createInstalledBrowserRunner(harness.dependencies)({
    plan,
    approvalSha256: plan.planSha256
  });

  assert.deepEqual(
    harness.log
      .filter(({ event }) => ['proxy-close', 'fixture-close'].includes(event))
      .map((entry) => (entry.event === 'proxy-close' ? 'proxy' : entry.host)),
    ['proxy', '::1', '127.0.0.1']
  );
  assert.equal(harness.log.filter(({ event }) => event === 'proxy-close').length, 1);
  assert.equal(harness.log.filter(({ event, host }) => event === 'fixture-close' && host === '::1').length, 1);
  assert.equal(harness.log.filter(({ event, host }) => event === 'fixture-close' && host === '127.0.0.1').length, 1);
  assert.equal(result.publicProjection.networkReconciled, false);
  assert.equal(result.publicProjection.networkReconciliationFailureCount, 2);
  assert.equal(findCell(result.aggregate, 'TEARDOWN-01', 'brave').state, 'not_run');
  assert.match(findCell(result.aggregate, 'TEARDOWN-01', 'brave').finding, /reconciliation_failed/);
  assert.equal(result.completion.automaticRecursiveDeletionPerformed, false);
  assertPublicProjectionIsPathAndSecretFree(result.publicProjection);
});

test('exact approval and option schemas are checked before creating any owned state', async () => {
  const plan = samplePlan();
  const harness = createHarness({ plan });
  const run = createInstalledBrowserRunner(harness.dependencies);

  await assert.rejects(run({ plan, approvalSha256: '0'.repeat(64) }), /does not match the exact approved plan SHA-256/);
  await assert.rejects(
    run({ plan, approvalSha256: plan.planSha256, widenedAuthority: true }),
    /keys differ from the exact schema/
  );
  assert.equal(harness.log.length, 0);

  const changed = structuredClone(plan);
  changed.inputs.fixture.allowedHosts = [...changed.inputs.fixture.allowedHosts, 'evil.invalid'];
  changed.planSha256 = computePlanSha256(changed);
  await assert.rejects(run({ plan: changed, approvalSha256: changed.planSha256 }), /canonical policy/);
  assert.equal(harness.log.length, 0);
});

test('unexpected fatal orchestration failure reconciles resources and settles the exact retained run without deletion', async () => {
  const plan = samplePlan();
  const harness = createHarness({ plan });
  const expectedFailure = new Error('Synthetic fatal runner failure at C:\\private\\profile.');
  harness.dependencies.semanticScenarioImplementationStatus = () => {
    throw expectedFailure;
  };

  await assert.rejects(
    createInstalledBrowserRunner(harness.dependencies)({ plan, approvalSha256: plan.planSha256 }),
    (error) => error === expectedFailure
  );

  assert.deepEqual(
    harness.log
      .filter(({ event }) => ['proxy-close', 'fixture-close'].includes(event))
      .map((entry) => (entry.event === 'proxy-close' ? 'proxy' : entry.host)),
    ['proxy', '::1', '127.0.0.1']
  );
  const settlements = harness.log.filter(({ event }) => event === 'owned-retain-failure');
  assert.equal(settlements.length, 1);
  assert.match(settlements[0].detail, /^[A-F0-9]{64}$/u);
  assert.equal(settlements[0].detail.includes('private'), false);
  assert.equal(
    harness.log.some(({ event }) => event === 'complete'),
    false
  );
});

test('hostile thrown values cannot block failure settlement, leak diagnostics, or mask the original value', async () => {
  const plan = samplePlan();
  const hostileAccesses = [];
  const hostile = new Proxy(
    Object.create(null, {
      name: {
        get() {
          hostileAccesses.push('name');
          throw new Error('name getter must not run');
        }
      },
      message: {
        get() {
          hostileAccesses.push('message');
          throw new Error('message getter must not run');
        }
      },
      [Symbol.toPrimitive]: {
        value() {
          hostileAccesses.push('toPrimitive');
          throw new Error('conversion must not run');
        }
      }
    }),
    {
      defineProperty() {
        hostileAccesses.push('defineProperty');
        throw new Error('defineProperty trap must not run');
      },
      isExtensible() {
        hostileAccesses.push('isExtensible');
        throw new Error('isExtensible trap must not run');
      }
    }
  );
  const harness = createHarness({ plan, settlementFailure: hostile });
  harness.dependencies.semanticScenarioImplementationStatus = () => {
    throw hostile;
  };

  let observed;
  try {
    await createInstalledBrowserRunner(harness.dependencies)({ plan, approvalSha256: plan.planSha256 });
  } catch (error) {
    observed = error;
  }
  assert.equal(observed, hostile);
  assert.deepEqual(hostileAccesses, []);
  assert.equal(harness.log.filter(({ event }) => event === 'owned-retain-failure').length, 1);
  assert.match(browserRunFailureSettlementDigest(hostile), /^[A-F0-9]{64}$/u);

  for (const thrown of [Symbol('hostile'), Object.freeze({}), 1n]) {
    const next = createHarness({ plan });
    next.dependencies.semanticScenarioImplementationStatus = () => {
      throw thrown;
    };
    let nextObserved;
    try {
      await createInstalledBrowserRunner(next.dependencies)({ plan, approvalSha256: plan.planSha256 });
    } catch (error) {
      nextObserved = error;
    }
    assert.equal(nextObserved, thrown);
    assert.equal(next.log.filter(({ event }) => event === 'owned-retain-failure').length, 1);
  }
});

test('destination mapping binds every canonical host to one shared port and only exact loopback listeners', () => {
  const plan = samplePlan();
  const ipv4Fixture = fixtureCapability({ host: '127.0.0.1', port: 43822, plan, log: [] });
  const ipv6Fixture = fixtureCapability({ host: '::1', port: 43822, plan, log: [] });
  const destinations = createExactFixtureDestinationMap({ ipv4Fixture, ipv6Fixture, plan });

  assert.deepEqual(Object.keys(destinations), SYNTHETIC_FIXTURE_HOSTS);
  for (const host of SYNTHETIC_FIXTURE_HOSTS) {
    assert.deepEqual(destinations[host], {
      connectHost: host === '::1' ? '::1' : '127.0.0.1',
      port: 43822
    });
  }
  assert.equal(Object.isFrozen(destinations), true);
  assert.equal(Object.isFrozen(destinations['selected.example.com']), true);

  const wrongSecret = {
    ...ipv6Fixture,
    runToken: 'e'.repeat(64),
    runTokenSha256: sha256('e'.repeat(64))
  };
  assert.throws(
    () => createExactFixtureDestinationMap({ ipv4Fixture, ipv6Fixture: wrongSecret, plan }),
    /do not share one exact 32-byte post-approval secret/
  );
});

function createHarness({
  plan,
  includeFailedObservation = false,
  throwCell = null,
  closeFailureCell = null,
  closeReceiptForCell = null,
  hookModeByCell = new Map(),
  lateCleanupRegistrationCell = null,
  lifecycleTimerDelayMs = null,
  mismatchedIpv6Port = false,
  neverSettlingCloseCell = null,
  neverSettlingLaunchCell = null,
  networkCloseFailures = [],
  settlementFailure = null
}) {
  const log = [];
  let pendingLifecycleOperations = 0;
  let clockTick = 0;
  const now = () => new Date(Date.UTC(2026, 7, 25, 12, 0, 0, clockTick++)).toISOString();
  const dependencies = {
    ...DEFAULT_INSTALLED_BROWSER_RUNNER_DEPENDENCIES,
    clearLifecycleTimer: (timer) => clearTimeout(timer),
    now,
    setLifecycleTimer: (callback, milliseconds) =>
      setTimeout(callback, lifecycleTimerDelayMs === null ? milliseconds : lifecycleTimerDelayMs),
    async prepareApprovedOwnedRun({ approvalSha256, plan: observedPlan }) {
      log.push({ event: 'prepare', approvalSha256 });
      assert.equal(observedPlan, plan);
      return {
        runRoot: 'C:\\sitewipe-disposable\\run',
        fixtureToken: FIXTURE_TOKEN,
        fixtureTokenSha256: FIXTURE_TOKEN_SHA256,
        async complete() {
          log.push({ event: 'owned-complete' });
        },
        async retainFailure({ detail }) {
          log.push({ event: 'owned-retain-failure', detail });
          if (settlementFailure !== null) throw settlementFailure;
          return Object.freeze({
            schema: 'sitewipe.owned-browser-run-failure.v1',
            runId: plan.runId,
            planSha256: plan.planSha256,
            detail,
            failedAt: now(),
            retainedRunRoot: true,
            automaticRecursiveDeletionPerformed: false
          });
        }
      };
    },
    async stageVerifiedRuntimeArtifact({ plan: observedPlan, runRoot }) {
      log.push({ event: 'stage-runtime', runRoot });
      assert.equal(observedPlan, plan);
      return Object.freeze({ schema: 'fixture-runtime', contentSetSha256: '7'.repeat(64) });
    },
    async startFixtureServer(options) {
      log.push({ event: 'fixture-start', host: options.host, requestedPort: options.port });
      assert.equal(options.runToken, FIXTURE_TOKEN);
      assert.deepEqual(options.allowedHosts, plan.inputs.fixture.allowedHosts);
      const port = options.host === '::1' && mismatchedIpv6Port ? 43823 : 43822;
      return fixtureCapability({ host: options.host, port, plan, log, networkCloseFailures });
    },
    async startLoopbackDenyProxy({ destinations, allowedHosts, allowedRoutes, allowedMethods }) {
      log.push({ event: 'proxy-start' });
      assert.deepEqual(allowedHosts, plan.inputs.fixture.allowedHosts);
      assert.deepEqual(allowedRoutes, plan.inputs.fixture.allowedRoutes);
      assert.deepEqual(allowedMethods, plan.inputs.fixture.allowedMethods);
      assert.deepEqual(Object.keys(destinations), plan.inputs.fixture.allowedHosts);
      for (const host of allowedHosts) {
        assert.deepEqual(destinations[host], {
          connectHost: host === '::1' ? '::1' : '127.0.0.1',
          port: 43822
        });
      }
      return {
        schema: LOOPBACK_DENY_PROXY_SCHEMA,
        host: '127.0.0.1',
        port: 49152,
        requestLedger: () => [],
        async close() {
          log.push({ event: 'proxy-close' });
          if (networkCloseFailures.includes('proxy')) throw new Error('Synthetic proxy reconciliation failed.');
        }
      };
    },
    async stageOwnedBrowserCell({ browserName, plan: observedPlan, runRoot, scenarioId }) {
      assert.equal(observedPlan, plan);
      const cell = `${scenarioId}/${browserName}`;
      const profilePath = `${runRoot}\\cells\\${scenarioId}\\${browserName}\\profile`;
      log.push({ event: 'stage-cell', cell, profilePath });
      return {
        schema: 'sitewipe.staged-browser-cell.v1',
        runId: plan.runId,
        planSha256: plan.planSha256,
        browserName,
        scenarioId,
        profilePath,
        canaryPath: `${runRoot}\\cells\\${scenarioId}\\${browserName}\\downloads\\canary.bin`,
        canarySha256: 'A'.repeat(64)
      };
    },
    async launchPinnedSiteWipeBrowser({
      browserName,
      plan: observedPlan,
      proxy,
      registerCleanup,
      runRoot,
      scenarioId,
      signal
    }) {
      assert.equal(observedPlan, plan);
      assert.equal(runRoot, 'C:\\sitewipe-disposable\\run');
      assert.deepEqual(proxy, { schema: LOOPBACK_DENY_PROXY_SCHEMA, host: '127.0.0.1', port: 49152 });
      assert.equal(typeof registerCleanup, 'function');
      assert.ok(signal instanceof AbortSignal);
      const cell = `${scenarioId}/${browserName}`;
      const browserPin = plan.inputs.browserPins.find(({ name }) => name === browserName);
      const profilePath = `${runRoot}\\cells\\${scenarioId}\\${browserName}\\profile`;
      const canaryPath = `${runRoot}\\cells\\${scenarioId}\\${browserName}\\downloads\\canary.bin`;
      const processId = 1000 + log.filter(({ event }) => event === 'launch').length;
      const processIdentity = {
        processId,
        startTimeUtcTicks: String(10_000 + processId)
      };
      let indirectlyClosed = false;
      const rawBrowser = {
        async close() {
          indirectlyClosed = true;
          log.push({ event: 'indirect-browser-close', cell });
        },
        async newPage() {
          if (hookModeByCell.get(cell) === 'reject-callable-page') {
            return Object.assign(() => {}, { close() {}, createCDPSession() {} });
          }
          return {
            browser: () => rawBrowser,
            target: () => ({ browserContext: () => ({ browser: () => rawBrowser }) })
          };
        },
        targets() {
          return hookModeByCell.get(cell) === 'reject-callable-target'
            ? [Object.assign(() => {}, { close() {}, createCDPSession() {} })]
            : [];
        }
      };
      log.push({ event: 'launch', cell });
      const close = async () => {
        log.push({ event: 'browser-close', cell });
        if (cell === neverSettlingCloseCell) await new Promise(() => {});
        if (hookModeByCell.get(cell) === 'delayed-close') {
          pendingLifecycleOperations += 1;
          await delay(15);
          pendingLifecycleOperations -= 1;
        }
        if (cell === closeFailureCell) throw new Error('Synthetic browser close failed at C:\\private\\profile.');
        const timestamp = now();
        const receipt = {
          schema: 'sitewipe.installed-browser-close-observation.v1',
          runId: plan.runId,
          planSha256: plan.planSha256,
          browserName,
          closeStartedAt: timestamp,
          observedAt: timestamp,
          gracefulCloseError: indirectlyClosed ? 'Browser was closed outside the runner-owned cleanup.' : null,
          processResidue: {
            schema: 'sitewipe.windows-process-observation.v1',
            mode: 'profile-residue',
            observedAt: timestamp,
            profilePath,
            rootIdentity: {
              processId,
              path: browserPin.executablePath,
              sha256: browserPin.executableSha256,
              startTimeUtcTicks: processIdentity.startTimeUtcTicks,
              present: false
            },
            residues: []
          },
          profileProcessResidueCount: 0,
          mustPreserveDownloadCanary: {
            path: canaryPath,
            expectedSha256: 'A'.repeat(64),
            observedSha256: 'A'.repeat(64),
            preserved: true
          },
          observationStatus: indirectlyClosed ? 'attention_required' : 'clean',
          semanticValidationStatus: SEMANTIC_VALIDATION_STATUS,
          semanticValidatorManifestSha256: SEMANTIC_VALIDATOR_MANIFEST_SHA256,
          automaticProfileDeletionPerformed: false,
          automaticDownloadDeletionPerformed: false
        };
        return Object.freeze(closeReceiptForCell?.({ cell, receipt }) ?? receipt);
      };
      if (cell === lateCleanupRegistrationCell) await delay(30);
      registerCleanup(close);
      if (cell === lateCleanupRegistrationCell) await new Promise(() => {});
      if (cell === neverSettlingLaunchCell) await new Promise(() => {});
      return {
        browser: Object.freeze(rawBrowser),
        close,
        extension: Object.freeze({ fixtureExtension: cell }),
        receipt: Object.freeze({ fixtureReceipt: cell, processIdentity }),
        async triggerAction() {}
      };
    },
    executeCell(context) {
      const { browser, captureTimestamp, fixtures, launched, plan: observedPlan, proxy, scenario, signal } = context;
      assert.equal(observedPlan, plan);
      assert.ok(signal instanceof AbortSignal);
      assert.equal(Object.hasOwn(context, 'launchBrowser'), false);
      assert.equal(Object.hasOwn(context, 'closeBrowser'), false);
      assert.equal(Object.hasOwn(launched, 'close'), false);
      assert.equal(launched.browser.close, undefined);
      assert.equal(launched.browser.disconnect, undefined);
      assert.equal(launched.extension.triggerAction, undefined);
      assert.equal(Object.hasOwn(fixtures.ipv4, 'close'), false);
      assert.equal(Object.hasOwn(fixtures.ipv6, 'close'), false);
      assert.equal(Object.hasOwn(proxy, 'close'), false);
      assert.equal(fixtures.ipv4.runToken, FIXTURE_TOKEN);
      const cell = `${scenario.id}/${browser.name}`;
      const hookMode = hookModeByCell.get(cell) ?? 'awaited';
      log.push({ event: 'execute', cell });
      if (cell === throwCell) throw new Error('Synthetic hook failed at C:\\private\\profile.');
      const startedAt = captureTimestamp();
      const completedAt = captureTimestamp();
      const evidence = [];
      if (includeFailedObservation && cell === 'ART-01/chrome') {
        evidence.push(
          createSemanticObservationEvidence({
            binding: {
              scenarioId: scenario.id,
              browser: {
                name: browser.name,
                version: browser.version,
                executableSha256: browser.executableSha256
              },
              runId: plan.runId,
              planSha256: plan.planSha256,
              identity: structuredClone(plan.identity),
              startedAt,
              completedAt
            },
            assertionId: 'source.exact_head',
            observationId: 'art.source.exact_head',
            capturedAt: startedAt,
            payload: {
              clean: false,
              commitSha: plan.identity.sourceCommitSha,
              treeSha: plan.identity.sourceTreeSha,
              indexDeltaCount: 0,
              untrackedEntryCount: 0,
              worktreeDeltaCount: 0
            }
          })
        );
      }
      const result = {
        browser,
        startedAt,
        completedAt,
        evidence,
        reason: evidence.length
          ? 'A canonical semantic predicate observed a failure.'
          : 'Authentic scenario-specific observations are not yet implemented.'
      };
      const envelope = {
        postCloseFinalizer: hookMode.startsWith('finalizer-')
          ? () => lifecycleTestValue(hookMode.slice('finalizer-'.length), result)
          : null,
        result: hookMode.startsWith('finalizer-') ? null : result
      };
      if (hookMode === 'assert-explicit-page-capability') {
        return Promise.resolve().then(async () => {
          const page = await launched.browser.newPage();
          assert.equal(Object.getPrototypeOf(page), null);
          assert.deepEqual(Object.keys(page).sort(), [
            '$',
            '$eval',
            'bringToFront',
            'click',
            'evaluate',
            'evaluateOnNewDocument',
            'exposeFunction',
            'goto',
            'once',
            'reload',
            'select',
            'url',
            'waitForFunction'
          ]);
          for (const forbidden of [
            '_client',
            'browser',
            'browserContext',
            'close',
            'createCDPSession',
            'evaluateHandle',
            'frames',
            'mainFrame',
            'target',
            'valueOf',
            'waitForFrame'
          ]) {
            assert.equal(page[forbidden], undefined, forbidden);
          }
          return envelope;
        });
      }
      if (hookMode === 'reject-callable-page') {
        return Promise.resolve().then(async () => {
          await assert.rejects(launched.browser.newPage(), /Page capability requires one exact non-callable object/);
          return envelope;
        });
      }
      if (hookMode === 'reject-callable-target') {
        assert.throws(() => launched.browser.targets(), /Target capability requires one exact non-callable object/);
        return envelope;
      }
      return lifecycleTestValue(hookMode, envelope);
    },
    createScenarioResultRecord(result, options) {
      log.push({ event: 'record', cell: `${result.scenarioId}/${result.browser.name}` });
      return createScenarioResultRecord(result, options);
    },
    aggregateBrowserEvidence({ plan: observedPlan, resultRecords }) {
      log.push({ event: 'aggregate', recordCount: resultRecords.length });
      assert.equal(observedPlan, plan);
      return aggregateBrowserEvidence({ plan: observedPlan, resultRecords });
    },
    async completeOwnedBrowserRunWithAggregate({ aggregate, detail, ownedRun, plan: observedPlan }) {
      log.push({ event: 'complete', detail });
      assert.equal(observedPlan, plan);
      assert.equal(ownedRun.runRoot, 'C:\\sitewipe-disposable\\run');
      assert.match(detail, /retained/);
      return {
        persisted: Object.freeze({ aggregateSha256: computeAggregateSha256(aggregate) }),
        completion: Object.freeze({
          schema: 'sitewipe.owned-browser-run-completion.v1',
          runId: plan.runId,
          planSha256: plan.planSha256,
          state: aggregate.state,
          aggregateSha256: computeAggregateSha256(aggregate),
          resultSetSha256: aggregate.resultSetSha256,
          resultRecordCount: aggregate.resultRecordCount,
          semanticValidationStatus: aggregate.semanticValidationStatus,
          detail,
          completedAt: now(),
          retainedRunRoot: true,
          automaticRecursiveDeletionPerformed: false
        })
      };
    },
    semanticScenarioImplementationStatus,
    validateBrowserPlan,
    validateScenarioResult
  };
  return { dependencies, log, pendingLifecycleOperations: () => pendingLifecycleOperations };
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function lifecycleTestValue(mode, value) {
  if (mode === 'then') {
    return Object.freeze({
      then(resolvePromise) {
        resolvePromise(value);
      }
    });
  }
  if (mode === 'promise-resolve') return Promise.resolve(value);
  if (mode === 'promise-all') return Promise.all([Promise.resolve('adopted')]).then(() => value);
  if (mode === 'delayed') return delay(15).then(() => value);
  if (mode === 'never') return new Promise(() => {});
  return value;
}

function fixtureCapability({ host, port, plan, log, networkCloseFailures = [] }) {
  return {
    host,
    port,
    runToken: FIXTURE_TOKEN,
    runTokenSha256: FIXTURE_TOKEN_SHA256,
    policy: Object.freeze({
      allowedHosts: Object.freeze([...plan.inputs.fixture.allowedHosts]),
      allowedRoutes: Object.freeze([...plan.inputs.fixture.allowedRoutes]),
      allowedMethods: Object.freeze([...plan.inputs.fixture.allowedMethods])
    }),
    requestLedger: () => [],
    async close() {
      log.push({ event: 'fixture-close', host });
      if (networkCloseFailures.includes(host)) throw new Error(`Synthetic ${host} reconciliation failed.`);
    }
  };
}

function samplePlan() {
  const browserPins = [
    {
      name: 'brave',
      executablePath: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      version: '151.1.93.138',
      executableSha256: '1'.repeat(64),
      runtimeRootPath: 'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\151.1.93.138',
      runtimeVersion: '151.1.93.138',
      runtimeFileCount: 176,
      runtimeBytes: 1076868141,
      runtimeManifestSha256: '3'.repeat(64)
    },
    {
      name: 'chrome',
      executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      version: '151.0.7922.174',
      executableSha256: '2'.repeat(64),
      runtimeRootPath: 'C:\\Program Files\\Google\\Chrome\\Application\\151.0.7922.174',
      runtimeVersion: '151.0.7922.174',
      runtimeFileCount: 266,
      runtimeBytes: 514076268,
      runtimeManifestSha256: '4'.repeat(64)
    }
  ];
  const browserRuntimeSetSha256 = computeBrowserRuntimeSetSha256(browserPins);
  const toolchain = {
    nodeRuntimeVersion: process.version,
    toolchainPuppeteerVersion: '25.8.0',
    toolchainPackageCount: 17,
    toolchainFileCount: 401,
    toolchainBytes: 9_000_000,
    toolchainManifestSha256: '7'.repeat(64),
    toolchainSetSha256: '8'.repeat(64)
  };
  const plan = {
    schema: BROWSER_PLAN_SCHEMA,
    matrixVersion: BROWSER_MATRIX_VERSION,
    matrixSha256: CANONICAL_BROWSER_MATRIX_SHA256,
    runId: `sitewipe-browser-${'a'.repeat(32)}`,
    createdAt: '2026-08-25T12:00:00.000Z',
    requiredBrowsers: [...REQUIRED_BROWSERS],
    requiredMatrixIds: [...CANONICAL_BROWSER_MATRIX_IDS],
    semanticValidatorManifestSha256: SEMANTIC_VALIDATOR_MANIFEST_SHA256,
    identity: {
      sourceCommitSha: 'a'.repeat(40),
      sourceTreeSha: 'b'.repeat(40),
      artifactVersion: '1.11.90',
      artifactBytes: 100,
      artifactSha256: 'A'.repeat(64),
      browserRuntimeSetSha256,
      gitExecutableSha256: '9'.repeat(64),
      harnessManifestSha256: 'B'.repeat(64),
      launchPolicySha256: INSTALLED_RUNTIME_LAUNCH_POLICY_SHA256,
      nativeHelperSha256: 'C'.repeat(64),
      nodeExecutableSha256: 'D'.repeat(64),
      nodeRuntimeVersion: toolchain.nodeRuntimeVersion,
      packageLockSha256: 'E'.repeat(64),
      powerShellExecutableSha256: '5'.repeat(64),
      processObserverHelperSha256: '6'.repeat(64),
      releaseInputFingerprintSha256: 'F'.repeat(64),
      runtimeFingerprintSha256: '0'.repeat(64),
      toolchainPuppeteerVersion: toolchain.toolchainPuppeteerVersion,
      toolchainPackageCount: toolchain.toolchainPackageCount,
      toolchainFileCount: toolchain.toolchainFileCount,
      toolchainBytes: toolchain.toolchainBytes,
      toolchainSetSha256: toolchain.toolchainSetSha256
    },
    inputs: {
      repositoryRoot: 'C:\\sitewipe\\repository',
      workspaceRoot: 'C:\\sitewipe\\browser-runs',
      artifactPath: 'C:\\sitewipe\\artifact.zip',
      git: {
        path: 'C:\\Program Files\\Git\\cmd\\git.exe',
        sha256: '9'.repeat(64),
        version: 'git version 2.51.0.windows.1'
      },
      browserPins,
      browserRuntimeSetSha256,
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
        helperPath: 'C:\\sitewipe\\windows-permission-dialog.ps1',
        helperSha256: 'C'.repeat(64),
        policySha256: NATIVE_PROMPT_POLICY_SHA256,
        allowedActions: [...NATIVE_PROMPT_ALLOWED_ACTIONS],
        permissionPatterns: [...NATIVE_PROMPT_PERMISSION_PATTERNS],
        expectedFragments: [...NATIVE_PROMPT_EXPECTED_FRAGMENTS],
        scenarioSchedule: structuredClone(NATIVE_PROMPT_SCENARIO_SCHEDULE),
        uiaSnapshots: structuredClone(NATIVE_PROMPT_UIA_SNAPSHOTS),
        requiresUnlockedInteractiveSession: true
      },
      processObserver: {
        helperPath: 'C:\\sitewipe\\windows-process-identity.ps1',
        helperSha256: '6'.repeat(64),
        powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        powershellSha256: '5'.repeat(64),
        helperModes: ['Identity', 'ProfileResidue', 'TerminateTree'],
        rawCommandLinesRetained: false,
        processTerminationAllowed: true
      },
      toolchain,
      retention: { failureDays: 14, passEvidenceDays: 30, retainProfilesOnFailure: true }
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
  return plan;
}

function expectedCellOrder() {
  return CANONICAL_BROWSER_MATRIX.flatMap(({ id }) => REQUIRED_BROWSERS.map((browser) => `${id}/${browser}`));
}

function findCell(aggregate, scenarioId, browser) {
  return aggregate.cells.find((cell) => cell.scenarioId === scenarioId && cell.browser === browser);
}

function assertPublicProjectionIsPathAndSecretFree(projection) {
  const serialized = JSON.stringify(projection);
  assert.equal(serialized.includes(FIXTURE_TOKEN), false);
  assert.equal(/[A-Z]:\\\\/u.test(serialized), false);
  const visit = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.doesNotMatch(key, /path|root|token/iu);
      visit(child);
    }
  };
  visit(projection);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

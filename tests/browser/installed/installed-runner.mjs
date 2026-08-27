import { createHash } from 'node:crypto';

import { startFixtureServer } from '../fixture-server.mjs';

import {
  BROWSER_MATRIX_VERSION,
  CANONICAL_BROWSER_MATRIX,
  CANONICAL_BROWSER_MATRIX_SHA256,
  REQUIRED_BROWSERS
} from './canonical-matrix.mjs';
import {
  SEMANTIC_VALIDATION_STATUS,
  SCENARIO_RESULT_SCHEMA,
  aggregateBrowserEvidence,
  computeAggregateSha256,
  createScenarioResultRecord,
  validateAndReplayBrowserAggregate,
  validateBrowserPlan,
  validateScenarioResult
} from './evidence-contract.mjs';
import { validateRuntimeProxyBinding } from './launch-policy.mjs';
import { LOOPBACK_DENY_PROXY_SCHEMA, startLoopbackDenyProxy } from './loopback-deny-proxy.mjs';
import {
  INSTALLED_RUNTIME_CLOSE_POLICY_BOUND_MS,
  completeOwnedBrowserRunWithAggregate,
  launchPinnedSiteWipeBrowser,
  stageOwnedBrowserCell,
  stageVerifiedRuntimeArtifact,
  validateWindowsProfileResidueObservation
} from './runtime-executor.mjs';
import { SEMANTIC_VALIDATOR_MANIFEST_SHA256, semanticScenarioImplementationStatus } from './semantic-validator.mjs';
import { prepareApprovedOwnedRun } from './unattended-coordinator.mjs';
import { executeAuthenticInstalledBrowserCell } from './authentic-scenario-executor.mjs';
import { executeSettingsScenario } from './settings-scenario-executor.mjs';

export const INSTALLED_BROWSER_RUN_SCHEMA = 'sitewipe.installed-browser-run.v1';
export const INSTALLED_BROWSER_PUBLIC_PROJECTION_SCHEMA = 'sitewipe.installed-browser-public-projection.v1';
export const INSTALLED_BROWSER_LAUNCH_SETTLEMENT_TIMEOUT_MS = 330_000;
export const INSTALLED_BROWSER_HOOK_SETTLEMENT_TIMEOUT_MS = 120_000;
export const INSTALLED_BROWSER_POST_CLOSE_FINALIZER_TIMEOUT_MS = 60_000;
export const INSTALLED_BROWSER_CANCELLATION_GRACE_MS = 5_000;
export const INSTALLED_BROWSER_CLOSE_SETTLEMENT_TIMEOUT_MS = INSTALLED_RUNTIME_CLOSE_POLICY_BOUND_MS + 30_000;
export const INSTALLED_BROWSER_CELL_DEADLINE_MS =
  INSTALLED_BROWSER_LAUNCH_SETTLEMENT_TIMEOUT_MS +
  INSTALLED_BROWSER_HOOK_SETTLEMENT_TIMEOUT_MS +
  INSTALLED_BROWSER_CLOSE_SETTLEMENT_TIMEOUT_MS +
  INSTALLED_BROWSER_POST_CLOSE_FINALIZER_TIMEOUT_MS +
  30_000;

const FAILURE_SETTLEMENT_ANNOTATIONS = new WeakMap();

class FatalCellLifecycleError extends Error {}

const DEPENDENCY_KEYS = Object.freeze([
  'aggregateBrowserEvidence',
  'completeOwnedBrowserRunWithAggregate',
  'clearLifecycleTimer',
  'createScenarioResultRecord',
  'executeCell',
  'launchPinnedSiteWipeBrowser',
  'now',
  'prepareApprovedOwnedRun',
  'semanticScenarioImplementationStatus',
  'stageOwnedBrowserCell',
  'stageVerifiedRuntimeArtifact',
  'setLifecycleTimer',
  'startFixtureServer',
  'startLoopbackDenyProxy',
  'validateBrowserPlan',
  'validateScenarioResult'
]);

export const DEFAULT_INSTALLED_BROWSER_RUNNER_DEPENDENCIES = Object.freeze({
  aggregateBrowserEvidence,
  completeOwnedBrowserRunWithAggregate,
  clearLifecycleTimer: (timer) => clearTimeout(timer),
  createScenarioResultRecord,
  executeCell: defaultCellExecutor,
  launchPinnedSiteWipeBrowser,
  now: () => new Date().toISOString(),
  prepareApprovedOwnedRun,
  semanticScenarioImplementationStatus,
  stageOwnedBrowserCell,
  stageVerifiedRuntimeArtifact,
  setLifecycleTimer: (callback, milliseconds) => setTimeout(callback, milliseconds),
  startFixtureServer,
  startLoopbackDenyProxy,
  validateBrowserPlan,
  validateScenarioResult
});

export async function runInstalledBrowserValidation(options) {
  return createInstalledBrowserRunner(DEFAULT_INSTALLED_BROWSER_RUNNER_DEPENDENCIES)(options);
}

export function browserRunFailureSettlementDigest(error) {
  if (error === null || !['function', 'object'].includes(typeof error)) return null;
  try {
    return FAILURE_SETTLEMENT_ANNOTATIONS.get(error) ?? null;
  } catch {
    return null;
  }
}

export function createInstalledBrowserRunner(dependencies) {
  assertExactKeys(dependencies, DEPENDENCY_KEYS, 'Installed-browser runner dependencies');
  for (const key of DEPENDENCY_KEYS) {
    if (typeof dependencies[key] !== 'function') {
      throw new TypeError(`Installed-browser runner dependency ${key} must be a function.`);
    }
  }
  const exactDependencies = Object.freeze({ ...dependencies });
  return async function run(options) {
    return runWithDependencies(options, exactDependencies);
  };
}

export function createExactFixtureDestinationMap({ ipv4Fixture, ipv6Fixture, plan }) {
  validateBrowserPlan(plan);
  assertExactFixturePair({ ipv4Fixture, ipv6Fixture, plan, expectedToken: null, expectedTokenSha256: null });
  return Object.freeze(
    Object.fromEntries(
      plan.inputs.fixture.allowedHosts.map((host) => [
        host,
        Object.freeze({ connectHost: host === '::1' ? '::1' : '127.0.0.1', port: ipv4Fixture.port })
      ])
    )
  );
}

export function createInstalledBrowserPublicProjection({ aggregate, completion, plan, reconciliation }) {
  validateBrowserPlan(plan);
  if (!aggregate || typeof aggregate !== 'object' || Array.isArray(aggregate)) {
    throw new Error('Installed-browser public projection requires one mechanical aggregate.');
  }
  if (!completion || typeof completion !== 'object' || Array.isArray(completion)) {
    throw new Error('Installed-browser public projection requires one completion receipt.');
  }
  assertExactKeys(
    reconciliation,
    ['failures', 'ipv4FixtureClosed', 'ipv6FixtureClosed', 'proxyClosed'],
    'Installed-browser network reconciliation'
  );
  if (
    !Array.isArray(reconciliation.failures) ||
    reconciliation.failures.some((entry) => typeof entry !== 'string' || !entry) ||
    typeof reconciliation.ipv4FixtureClosed !== 'boolean' ||
    typeof reconciliation.ipv6FixtureClosed !== 'boolean' ||
    typeof reconciliation.proxyClosed !== 'boolean'
  ) {
    throw new Error('Installed-browser public projection requires an exact fixture and proxy reconciliation result.');
  }
  validateAndReplayBrowserAggregate(aggregate, { plan });
  if (
    aggregate.runId !== plan.runId ||
    aggregate.planSha256 !== plan.planSha256 ||
    aggregate.matrixVersion !== BROWSER_MATRIX_VERSION ||
    aggregate.matrixSha256 !== CANONICAL_BROWSER_MATRIX_SHA256 ||
    aggregate.semanticValidatorManifestSha256 !== SEMANTIC_VALIDATOR_MANIFEST_SHA256 ||
    completion.runId !== plan.runId ||
    completion.planSha256 !== plan.planSha256 ||
    completion.state !== aggregate.state ||
    completion.resultSetSha256 !== aggregate.resultSetSha256 ||
    completion.resultRecordCount !== aggregate.resultRecordCount ||
    completion.semanticValidationStatus !== aggregate.semanticValidationStatus ||
    completion.aggregateSha256 !== computeAggregateSha256(aggregate) ||
    completion.retainedRunRoot !== true ||
    completion.automaticRecursiveDeletionPerformed !== false ||
    !isIsoTimestamp(completion.completedAt)
  ) {
    throw new Error('Installed-browser completion does not bind the exact aggregate and approved plan.');
  }

  const projection = {
    schema: INSTALLED_BROWSER_PUBLIC_PROJECTION_SCHEMA,
    runId: plan.runId,
    planSha256: plan.planSha256,
    matrixVersion: aggregate.matrixVersion,
    matrixSha256: aggregate.matrixSha256,
    semanticValidationStatus: aggregate.semanticValidationStatus,
    semanticValidatorManifestSha256: aggregate.semanticValidatorManifestSha256,
    identity: structuredClone(plan.identity),
    browsers: plan.inputs.browserPins.map(({ name, version, executableSha256 }) => ({
      name,
      version,
      executableSha256
    })),
    state: aggregate.state,
    counts: structuredClone(aggregate.counts),
    cells: aggregate.cells.map(
      ({ scenarioId, browser, state, implementationStatus, resultRecordSha256, assertions }) => ({
        scenarioId,
        browser,
        state,
        implementationStatus,
        resultRecordSha256,
        assertions: assertions.map(({ id, state: assertionState, validatorId }) => ({
          id,
          state: assertionState,
          validatorId
        }))
      })
    ),
    resultRecordCount: aggregate.resultRecordCount,
    resultSetSha256: aggregate.resultSetSha256,
    completion: {
      state: completion.state,
      aggregateSha256: completion.aggregateSha256,
      resultSetSha256: completion.resultSetSha256,
      resultRecordCount: completion.resultRecordCount,
      semanticValidationStatus: completion.semanticValidationStatus,
      completedAt: completion.completedAt,
      retained: completion.retainedRunRoot === true,
      automaticRecursiveDeletionPerformed: completion.automaticRecursiveDeletionPerformed === true
    },
    networkReconciled:
      reconciliation.failures.length === 0 &&
      reconciliation.ipv4FixtureClosed &&
      reconciliation.ipv6FixtureClosed &&
      reconciliation.proxyClosed,
    networkReconciliationFailureCount: reconciliation.failures.length
  };
  assertPublicProjectionPrivacy(projection);
  return deepFreeze(projection);
}

async function runWithDependencies(options, dependencies) {
  assertExactKeys(options, ['approvalSha256', 'plan'], 'Installed-browser run options');
  const { approvalSha256, plan } = options;
  dependencies.validateBrowserPlan(plan);
  if (approvalSha256 !== plan.planSha256) {
    throw new Error('Installed-browser execution approval does not match the exact approved plan SHA-256.');
  }

  const ownedRun = await dependencies.prepareApprovedOwnedRun({ plan, approvalSha256 });
  const resources = { ipv4Fixture: null, ipv6Fixture: null, proxy: null };
  const stagedProfiles = new Set();
  const results = [];
  const setupFailures = [];
  let runtime = null;
  let reconciliation = null;
  let completionFinished = false;

  try {
    assertOwnedRunCapability(ownedRun, plan);
    try {
      try {
        runtime = await dependencies.stageVerifiedRuntimeArtifact({ plan, runRoot: ownedRun.runRoot });
      } catch (error) {
        setupFailures.push(failureReason('runtime_stage_failed', error));
      }

      if (runtime !== null) {
        try {
          resources.ipv4Fixture = await dependencies.startFixtureServer({
            host: '127.0.0.1',
            port: 0,
            allowedHosts: plan.inputs.fixture.allowedHosts,
            runToken: ownedRun.fixtureToken
          });
          assertFixtureEndpoint(resources.ipv4Fixture, {
            host: '127.0.0.1',
            port: null,
            plan,
            expectedToken: ownedRun.fixtureToken,
            expectedTokenSha256: ownedRun.fixtureTokenSha256
          });
          resources.ipv6Fixture = await dependencies.startFixtureServer({
            host: '::1',
            port: resources.ipv4Fixture.port,
            allowedHosts: plan.inputs.fixture.allowedHosts,
            runToken: ownedRun.fixtureToken
          });
          assertExactFixturePair({
            ipv4Fixture: resources.ipv4Fixture,
            ipv6Fixture: resources.ipv6Fixture,
            plan,
            expectedToken: ownedRun.fixtureToken,
            expectedTokenSha256: ownedRun.fixtureTokenSha256
          });
          const destinations = createExactFixtureDestinationMap({
            ipv4Fixture: resources.ipv4Fixture,
            ipv6Fixture: resources.ipv6Fixture,
            plan
          });
          resources.proxy = await dependencies.startLoopbackDenyProxy({
            destinations,
            allowedHosts: plan.inputs.fixture.allowedHosts,
            allowedRoutes: plan.inputs.fixture.allowedRoutes,
            allowedMethods: plan.inputs.fixture.allowedMethods
          });
          validateProxyCapability(resources.proxy);
        } catch (error) {
          setupFailures.push(failureReason('fixture_or_proxy_setup_failed', error));
        }
      }

      for (const scenario of CANONICAL_BROWSER_MATRIX) {
        const implementationStatus = dependencies.semanticScenarioImplementationStatus(scenario.id);
        if (!['implemented', 'partial', 'not_implemented'].includes(implementationStatus)) {
          throw new Error(`Semantic implementation status is invalid for ${scenario.id}.`);
        }
        for (const browserName of REQUIRED_BROWSERS) {
          const browser = exactBrowserPin(plan, browserName);
          const initialTimestamp = exactNow(dependencies.now);
          let cell = null;
          let stageFailure = null;
          try {
            cell = await dependencies.stageOwnedBrowserCell({
              browserName,
              plan,
              runRoot: ownedRun.runRoot,
              scenarioId: scenario.id
            });
            assertStagedCell(cell, { browserName, scenarioId: scenario.id, plan, stagedProfiles });
          } catch (error) {
            stageFailure = failureReason('cell_stage_failed', error);
          }

          let result;
          if (stageFailure !== null) {
            result = notRunResult({
              browser,
              completedAt: nondecreasingNow(dependencies.now, initialTimestamp),
              plan,
              reason: stageFailure,
              scenarioId: scenario.id,
              startedAt: initialTimestamp
            });
          } else if (setupFailures.length > 0) {
            result = notRunResult({
              browser,
              completedAt: nondecreasingNow(dependencies.now, initialTimestamp),
              plan,
              reason: setupFailures.join(' '),
              scenarioId: scenario.id,
              startedAt: initialTimestamp
            });
          } else if (implementationStatus === 'not_implemented') {
            result = notRunResult({
              browser,
              completedAt: nondecreasingNow(dependencies.now, initialTimestamp),
              plan,
              reason: 'All canonical semantic validators for this scenario are explicitly not implemented.',
              scenarioId: scenario.id,
              startedAt: initialTimestamp
            });
          } else {
            result = await executeSupportedCell({
              browser,
              cell,
              dependencies,
              initialTimestamp,
              ownedRun,
              plan,
              resources,
              runtime,
              scenario
            });
          }
          results.push(validateOrConservativelyReplaceResult({ browser, dependencies, plan, result, scenario }));
        }
      }

      reconciliation = await reconcileNetworkResources(resources);
      if (reconciliation.failures.length > 0) {
        const reason = reconciliation.failures.join(' ');
        for (let index = 0; index < results.length; index += 1) {
          if (results[index].scenarioId !== 'TEARDOWN-01') continue;
          results[index] = notRunResult({
            browser: results[index].browser,
            completedAt: nondecreasingNow(dependencies.now, results[index].startedAt),
            plan,
            reason,
            scenarioId: results[index].scenarioId,
            startedAt: results[index].startedAt
          });
        }
      }

      const resultRecords = results.map((result) => dependencies.createScenarioResultRecord(result, { plan }));
      if (resultRecords.length !== CANONICAL_BROWSER_MATRIX.length * REQUIRED_BROWSERS.length) {
        throw new Error('Installed-browser runner did not create exactly 48 canonical result records.');
      }
      const aggregate = dependencies.aggregateBrowserEvidence({ plan, resultRecords });
      const completed = await dependencies.completeOwnedBrowserRunWithAggregate({
        aggregate,
        detail: 'Run evidence and disposable state were retained; automatic recursive deletion was not performed.',
        ownedRun,
        plan
      });
      completionFinished = true;
      const publicProjection = createInstalledBrowserPublicProjection({
        aggregate,
        completion: completed.completion,
        plan,
        reconciliation
      });
      return deepFreeze({
        schema: INSTALLED_BROWSER_RUN_SCHEMA,
        aggregate: structuredClone(aggregate),
        completion: structuredClone(completed.completion),
        publicProjection
      });
    } finally {
      if (reconciliation === null) await reconcileNetworkResources(resources);
    }
  } catch (error) {
    if (!completionFinished && typeof ownedRun?.retainFailure === 'function') {
      try {
        await ownedRun.retainFailure({ detail: opaqueErrorDigest(error) });
      } catch (settlementError) {
        attachOpaqueSettlementFailure(error, settlementError);
      }
    }
    throw error;
  }
}

async function executeSupportedCell({
  browser,
  cell,
  dependencies,
  initialTimestamp,
  ownedRun,
  plan,
  resources,
  runtime,
  scenario
}) {
  const cancellation = new AbortController();
  const cellDeadline = createCellDeadline({ cancellation, dependencies });
  let cleanupCapability = null;
  let cleanupRegistrationCount = 0;
  let controller = null;
  let controllerCloseInvocationCount = 0;
  let closeOperation = null;
  let closeReceipt = null;
  let fatalCleanupUncertainty = false;
  let fatalLiveOperation = null;
  let hookEnvelope = null;
  let hookFailure = null;
  let launchFailure = null;

  const performControllerClose = () => {
    if (closeOperation !== null) return closeOperation.promise;
    controllerCloseInvocationCount += 1;
    closeOperation = createObservedOperation(async () => {
      if (cleanupCapability === null) {
        throw new Error('No authenticated disposable-browser cleanup capability was registered.');
      }
      return cleanupCapability();
    });
    return closeOperation.promise;
  };

  const registerCleanup = (candidate) => {
    cleanupRegistrationCount += 1;
    if (cleanupRegistrationCount !== 1 || typeof candidate !== 'function') {
      throw new Error('Installed-browser launch must register exactly one cleanup capability.');
    }
    cleanupCapability = candidate;
    if (cancellation.signal.aborted) {
      // A launch phase can finish after the runner has already failed closed. Start the
      // one bounded cleanup immediately; its late result can never make evidence eligible.
      void settleCentralClose({ dependencies, operationPromise: performControllerClose() }).catch(() => {
        // Late cleanup is deliberately nonmasking. The cell/run is already terminally
        // refused, and the exact shared close operation remains single invocation.
      });
    }
  };

  const proxyBinding = validateRuntimeProxyBinding({
    schema: LOOPBACK_DENY_PROXY_SCHEMA,
    host: resources.proxy.host,
    port: resources.proxy.port
  });
  const launchOperation = createObservedOperation(() =>
    dependencies.launchPinnedSiteWipeBrowser({
      browserName: browser.name,
      plan,
      proxy: proxyBinding,
      registerCleanup,
      runRoot: ownedRun.runRoot,
      scenarioId: scenario.id,
      signal: cancellation.signal
    })
  );
  // Even a non-conforming launcher that returns a controller without registering it
  // gets one bounded best-effort cleanup. Such a launch remains ineligible for evidence.
  void launchOperation.promise.then(
    (candidate) => {
      if (
        cleanupCapability !== null ||
        candidate === null ||
        (typeof candidate !== 'object' && typeof candidate !== 'function')
      ) {
        return;
      }
      try {
        const close = Reflect.get(candidate, 'close');
        if (typeof close === 'function') {
          registerCleanup(() => Reflect.apply(close, candidate, []));
        }
      } catch {
        // Property access and registration are both non-authoritative here. The
        // awaited launch path remains fail-closed and reports the uncertainty.
      }
    },
    () => {}
  );

  try {
    try {
      controller = await awaitObservedOperation(launchOperation, {
        cancellation,
        dependencies,
        label: 'Installed-browser launch',
        timeoutMs: INSTALLED_BROWSER_LAUNCH_SETTLEMENT_TIMEOUT_MS
      });
      if (
        !controller ||
        typeof controller !== 'object' ||
        typeof controller.close !== 'function' ||
        cleanupRegistrationCount !== 1 ||
        controller.close !== cleanupCapability
      ) {
        throw new Error('Installed-browser launch did not return the exact registered cleanup controller.');
      }
    } catch (error) {
      launchFailure = error;
      cancellation.abort(new Error('Installed-browser launch failed closed.'));
      if (!(await settlesDuringGrace(launchOperation, { dependencies }))) {
        fatalLiveOperation = 'launch';
      }
    }

    if (launchFailure === null) {
      if (cancellation.signal.aborted) {
        hookFailure = new Error('Installed-browser cell authority expired before the scenario hook could start.');
      } else {
        const launched = createScenarioLaunchedView(controller);
        const hookOperation = createObservedOperation(() =>
          dependencies.executeCell(
            Object.freeze({
              browser: structuredClone(browser),
              captureTimestamp: () => exactNow(dependencies.now),
              cell,
              fixtures: Object.freeze({
                ipv4: fixtureExecutionView(resources.ipv4Fixture),
                ipv6: fixtureExecutionView(resources.ipv6Fixture)
              }),
              launched,
              plan,
              proxy: proxyExecutionView(resources.proxy),
              runtime,
              scenario,
              signal: cancellation.signal
            })
          )
        );
        try {
          hookEnvelope = await awaitObservedOperation(hookOperation, {
            cancellation,
            dependencies,
            label: 'Installed-browser scenario hook',
            timeoutMs: INSTALLED_BROWSER_HOOK_SETTLEMENT_TIMEOUT_MS
          });
        } catch (error) {
          hookFailure = error;
          cancellation.abort(new Error('Installed-browser scenario hook failed closed.'));
          if (!(await settlesDuringGrace(hookOperation, { dependencies }))) {
            fatalLiveOperation = 'scenario-hook';
          }
        }
      }
    }
  } catch (error) {
    hookFailure = error;
  } finally {
    try {
      let cleanupFailure = null;
      if (cleanupCapability === null) {
        cleanupFailure = new Error('Installed-browser launch did not establish an authenticated cleanup capability.');
      } else {
        try {
          closeReceipt = await settleCentralClose({
            dependencies,
            operationPromise: performControllerClose()
          });
          if (controller === null) {
            cleanupFailure = new Error(
              'Installed-browser cleanup receipt cannot be authenticated without its launch receipt.'
            );
          } else {
            assertExactCleanCloseReceipt(closeReceipt, {
              browser,
              cell,
              launchReceipt: controller.receipt,
              plan
            });
          }
        } catch (error) {
          cleanupFailure = error;
        }
      }

      if (cleanupFailure !== null) {
        hookFailure ??= cleanupFailure;
        closeReceipt = null;
        if (closeOperation !== null && !(await settlesDuringGrace(closeOperation, { dependencies }))) {
          fatalLiveOperation = 'central-close';
        } else {
          fatalCleanupUncertainty = true;
        }
      }
    } finally {
      cellDeadline.clear();
    }
  }

  if (fatalLiveOperation !== null) {
    throw new FatalCellLifecycleError(
      `Installed-browser ${fatalLiveOperation} remained live after cancellation grace; the owned run is terminally refused.`
    );
  }

  if (fatalCleanupUncertainty) {
    if (launchFailure !== null) {
      throw new FatalCellLifecycleError(
        'Installed-browser launch failed before returning its exact controller; cleanup could not be authenticated without that launch receipt, so the owned run is terminally refused.',
        { cause: launchFailure }
      );
    }
    throw new FatalCellLifecycleError(
      'Installed-browser cleanup did not establish one exact clean zero-residue receipt; the owned run is terminally refused.'
    );
  }

  if (
    launchFailure !== null ||
    hookFailure !== null ||
    cleanupRegistrationCount !== 1 ||
    controllerCloseInvocationCount !== 1 ||
    closeReceipt === null ||
    cancellation.signal.aborted
  ) {
    return notRunResult({
      browser,
      completedAt: nondecreasingNow(dependencies.now, initialTimestamp),
      plan,
      reason: failureReason(
        closeReceipt === null && cleanupCapability !== null
          ? 'browser_teardown_failed'
          : launchFailure !== null
            ? 'browser_launch_failed'
            : hookFailure !== null
              ? 'cell_execution_failed'
              : cancellation.signal.aborted
                ? 'cell_authority_expired'
                : 'browser_lifecycle_uncertain',
        hookFailure ?? launchFailure ?? undefined
      ),
      scenarioId: scenario.id,
      startedAt: initialTimestamp
    });
  }

  try {
    assertExactKeys(hookEnvelope, ['postCloseFinalizer', 'result'], 'Installed-browser cell executor envelope');
    if (hookEnvelope.postCloseFinalizer !== null && typeof hookEnvelope.postCloseFinalizer !== 'function') {
      throw new Error('Installed-browser post-close finalizer must be null or a function.');
    }
    let hookValue = hookEnvelope.result;
    if (hookEnvelope.postCloseFinalizer !== null) {
      if (cancellation.signal.aborted) {
        throw new Error('Installed-browser cell authority expired before the post-close finalizer could start.');
      }
      const finalizerOperation = createObservedOperation(() =>
        hookEnvelope.postCloseFinalizer(Object.freeze({ closeReceipt, signal: cancellation.signal }))
      );
      try {
        hookValue = await awaitObservedOperation(finalizerOperation, {
          cancellation,
          dependencies,
          label: 'Installed-browser post-close finalizer',
          timeoutMs: INSTALLED_BROWSER_POST_CLOSE_FINALIZER_TIMEOUT_MS
        });
      } catch (error) {
        cancellation.abort(new Error('Installed-browser post-close finalizer failed closed.'));
        if (!(await settlesDuringGrace(finalizerOperation, { dependencies }))) {
          throw new FatalCellLifecycleError(
            'Installed-browser post-close finalizer remained live after cancellation grace; the owned run is terminally refused.'
          );
        }
        throw error;
      }
    }
    if (cancellation.signal.aborted) {
      throw new Error('Installed-browser cell authority expired before evidence validation completed.');
    }
    assertExactKeys(
      hookValue,
      ['browser', 'completedAt', 'evidence', 'reason', 'startedAt'],
      'Installed-browser cell executor result'
    );
    if (stableJson(hookValue.browser) !== stableJson(browser)) {
      throw new Error('Installed-browser cell executor crossed its exact browser identity.');
    }
    const candidate = scenarioResult({
      browser,
      completedAt: hookValue.completedAt,
      evidence: hookValue.evidence,
      plan,
      reason: hookValue.reason,
      scenarioId: scenario.id,
      startedAt: hookValue.startedAt
    });
    dependencies.validateScenarioResult(candidate, { plan });
    return candidate;
  } catch (error) {
    if (error instanceof FatalCellLifecycleError) throw error;
    return notRunResult({
      browser,
      completedAt: nondecreasingNow(dependencies.now, initialTimestamp),
      plan,
      reason: failureReason('invalid_cell_result', error),
      scenarioId: scenario.id,
      startedAt: initialTimestamp
    });
  }
}

function createScenarioLaunchedView(controller) {
  // Scenario executors receive only the Page/Target operations used by the canonical
  // scenarios. Returning a generic Proxy would leak Puppeteer objects through Page,
  // Frame, Response, Handle, EventEmitter, BrowserContext, and CDP-session methods.
  // The runtime's independent disconnect observer remains the authoritative lifecycle
  // guard; this explicit capability surface is defense in depth and API minimization.
  const rawBrowser = controller.browser;
  const pageViews = new WeakMap();
  const pageSources = new WeakMap();
  const targetViews = new WeakMap();
  const freezeCapability = (value) => Object.freeze(Object.assign(Object.create(null), value));

  const call = (target, property, args, label) => {
    const method = Reflect.get(target, property, target);
    if (typeof method !== 'function') throw new Error(`Installed-browser ${label} capability is unavailable.`);
    return Reflect.apply(method, target, args);
  };
  const wrapResponse = (response) => {
    if (response === null) return null;
    if (!response || typeof response !== 'object') {
      throw new Error('Installed-browser navigation returned an invalid response capability.');
    }
    return freezeCapability({
      status: () => call(response, 'status', [], 'response status')
    });
  };
  const wrapElement = (element) => {
    if (element === null) return null;
    if (!element || typeof element !== 'object') {
      throw new Error('Installed-browser selector returned an invalid element capability.');
    }
    return freezeCapability({
      uploadFile: (...paths) => call(element, 'uploadFile', paths, 'file upload')
    });
  };
  const wrapDialog = (dialog) => {
    if (!dialog || typeof dialog !== 'object') {
      throw new Error('Installed-browser dialog event returned an invalid dialog capability.');
    }
    return freezeCapability({
      accept: (...args) => call(dialog, 'accept', args, 'dialog accept'),
      dismiss: (...args) => call(dialog, 'dismiss', args, 'dialog dismiss'),
      message: () => call(dialog, 'message', [], 'dialog message'),
      type: () => call(dialog, 'type', [], 'dialog type')
    });
  };

  const wrapPage = (page, { allowNull = false } = {}) => {
    if (page === null && allowNull) return null;
    if (!page || typeof page !== 'object') {
      throw new Error('Installed-browser Page capability requires one exact non-callable object.');
    }
    const existing = pageViews.get(page);
    if (existing) return existing;
    let view;
    view = freezeCapability({
      $: async (...args) => wrapElement(await call(page, '$', args, 'selector')),
      $eval: (...args) => call(page, '$eval', args, 'selector evaluation'),
      bringToFront: (...args) => call(page, 'bringToFront', args, 'bring-to-front'),
      click: (...args) => call(page, 'click', args, 'click'),
      evaluate: (...args) => call(page, 'evaluate', args, 'evaluation'),
      async evaluateOnNewDocument(...args) {
        const registration = await call(page, 'evaluateOnNewDocument', args, 'preload registration');
        if (!registration || typeof registration.identifier !== 'string' || !registration.identifier) {
          throw new Error('Installed-browser preload registration did not return an exact identifier.');
        }
        return freezeCapability({ identifier: registration.identifier });
      },
      exposeFunction: (...args) => call(page, 'exposeFunction', args, 'exposed function'),
      async goto(...args) {
        return wrapResponse(await call(page, 'goto', args, 'navigation'));
      },
      once(eventName, listener) {
        if (eventName !== 'dialog' || typeof listener !== 'function') {
          throw new Error('Installed-browser Page event capability permits only one exact dialog listener.');
        }
        call(page, 'once', ['dialog', (dialog) => listener(wrapDialog(dialog))], 'dialog listener');
        return view;
      },
      async reload(...args) {
        return wrapResponse(await call(page, 'reload', args, 'reload'));
      },
      select: (...args) => call(page, 'select', args, 'select'),
      url: () => call(page, 'url', [], 'URL'),
      async waitForFunction(...args) {
        const handle = await call(page, 'waitForFunction', args, 'wait-for-function');
        if (!handle || typeof handle.dispose !== 'function') {
          throw new Error('Installed-browser wait-for-function did not return a disposable handle.');
        }
        await handle.dispose();
      }
    });
    pageViews.set(page, view);
    pageSources.set(view, page);
    return view;
  };
  const wrapTarget = (target) => {
    if (!target || typeof target !== 'object') {
      throw new Error('Installed-browser Target capability requires one exact non-callable object.');
    }
    const existing = targetViews.get(target);
    if (existing) return existing;
    const view = freezeCapability({
      asPage: async () => wrapPage(await target.asPage(), { allowNull: true }),
      type: () => target.type(),
      url: () => target.url()
    });
    targetViews.set(target, view);
    return view;
  };
  const browserView = freezeCapability({
    newPage: typeof rawBrowser?.newPage === 'function' ? async () => wrapPage(await rawBrowser.newPage()) : undefined,
    targets:
      typeof rawBrowser?.targets === 'function'
        ? () => rawBrowser.targets().map((target) => wrapTarget(target))
        : undefined,
    waitForTarget:
      typeof rawBrowser?.waitForTarget === 'function'
        ? async (predicate, options) =>
            wrapTarget(await rawBrowser.waitForTarget((target) => predicate(wrapTarget(target)), options))
        : undefined
  });
  // Puppeteer's Extension identity is exposed through prototype getters backed by
  // private fields. Copy the already-verified values explicitly; Object.hasOwn()
  // would silently erase every real installed-extension identity field.
  const installedExtension = controller.extension;
  const extension = Object.freeze({
    enabled: installedExtension?.enabled,
    id: installedExtension?.id,
    name: installedExtension?.name,
    path: installedExtension?.path,
    version: installedExtension?.version
  });
  return Object.freeze({
    browser: browserView,
    extension,
    receipt: controller.receipt,
    async triggerAction(page, options) {
      const rawPage = pageSources.get(page);
      if (!rawPage) throw new Error('Installed-browser action requires an exact runner-owned page view.');
      const result = await controller.triggerAction(rawPage, options);
      return Object.freeze({ page: wrapPage(result.page), receipt: result.receipt });
    }
  });
}

function createObservedOperation(action) {
  const operation = {
    error: undefined,
    promise: null,
    settlement: null,
    status: 'pending',
    value: undefined
  };
  operation.promise = Promise.resolve().then(action);
  operation.settlement = operation.promise.then(
    (value) => {
      operation.status = 'fulfilled';
      operation.value = value;
    },
    (error) => {
      operation.status = 'rejected';
      operation.error = error;
    }
  );
  return operation;
}

async function awaitObservedOperation(operation, { cancellation, dependencies, label, timeoutMs }) {
  if (operation.status !== 'pending') return operation.promise;
  const timeout = createTimeoutSignal({ dependencies, label, timeoutMs });
  const aborted = createAbortSignal(cancellation.signal, label);
  try {
    return await Promise.race([operation.promise, timeout.promise, aborted.promise]);
  } catch (error) {
    if (timeout.fired) cancellation.abort(error);
    throw error;
  } finally {
    timeout.clear();
    aborted.clear();
  }
}

async function settlesDuringGrace(operation, { dependencies }) {
  if (operation.status !== 'pending') return true;
  const timeout = createTimeoutSignal({
    dependencies,
    label: 'Installed-browser cancellation grace',
    timeoutMs: INSTALLED_BROWSER_CANCELLATION_GRACE_MS
  });
  try {
    return await Promise.race([operation.settlement.then(() => true), timeout.promise.then(() => false)]);
  } catch (error) {
    if (timeout.fired) return false;
    throw error;
  } finally {
    timeout.clear();
  }
}

async function settleCentralClose({ dependencies, operationPromise }) {
  const timeout = createTimeoutSignal({
    dependencies,
    label: 'Installed-browser central close',
    timeoutMs: INSTALLED_BROWSER_CLOSE_SETTLEMENT_TIMEOUT_MS
  });
  try {
    return await Promise.race([operationPromise, timeout.promise]);
  } finally {
    timeout.clear();
  }
}

function createCellDeadline({ cancellation, dependencies }) {
  const timer = dependencies.setLifecycleTimer(() => {
    cancellation.abort(
      new Error(`Installed-browser cell exceeded its exact ${INSTALLED_BROWSER_CELL_DEADLINE_MS} ms deadline.`)
    );
  }, INSTALLED_BROWSER_CELL_DEADLINE_MS);
  return Object.freeze({
    clear() {
      try {
        dependencies.clearLifecycleTimer(timer);
      } catch {
        // A timer-clear failure cannot widen or revive the cell authority.
      }
    }
  });
}

function createTimeoutSignal({ dependencies, label, timeoutMs }) {
  let fired = false;
  let rejectTimeout;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    rejectTimeout = rejectPromise;
  });
  const timer = dependencies.setLifecycleTimer(() => {
    fired = true;
    rejectTimeout(new Error(`${label} exceeded its exact ${timeoutMs} ms settlement bound.`));
  }, timeoutMs);
  return {
    clear() {
      try {
        dependencies.clearLifecycleTimer(timer);
      } catch {
        // The bounded operation result remains conservative if timer cleanup fails.
      }
    },
    get fired() {
      return fired;
    },
    promise
  };
}

function createAbortSignal(signal, label) {
  let rejectAbort;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    rejectAbort = rejectPromise;
  });
  const listener = () => {
    rejectAbort(signal.reason instanceof Error ? signal.reason : new Error(`${label} was aborted.`));
  };
  if (signal.aborted) listener();
  else signal.addEventListener('abort', listener, { once: true });
  return Object.freeze({
    clear() {
      signal.removeEventListener('abort', listener);
    },
    promise
  });
}

function validateOrConservativelyReplaceResult({ browser, dependencies, plan, result, scenario }) {
  try {
    dependencies.validateScenarioResult(result, { plan });
    return result;
  } catch (error) {
    const startedAt = result?.startedAt && isIsoTimestamp(result.startedAt) ? result.startedAt : plan.createdAt;
    const completedAt =
      result?.completedAt &&
      isIsoTimestamp(result.completedAt) &&
      Date.parse(result.completedAt) >= Date.parse(startedAt)
        ? result.completedAt
        : startedAt;
    const replacement = notRunResult({
      browser,
      completedAt,
      plan,
      reason: failureReason('invalid_runner_result', error),
      scenarioId: scenario.id,
      startedAt
    });
    dependencies.validateScenarioResult(replacement, { plan });
    return replacement;
  }
}

function scenarioResult({ browser, completedAt, evidence, plan, reason, scenarioId, startedAt }) {
  return {
    schema: SCENARIO_RESULT_SCHEMA,
    matrixVersion: BROWSER_MATRIX_VERSION,
    matrixSha256: CANONICAL_BROWSER_MATRIX_SHA256,
    semanticValidatorManifestSha256: SEMANTIC_VALIDATOR_MANIFEST_SHA256,
    planSha256: plan.planSha256,
    runId: plan.runId,
    scenarioId,
    browser: structuredClone(browser),
    identity: structuredClone(plan.identity),
    startedAt,
    completedAt,
    evidence: Array.isArray(evidence) ? structuredClone(evidence) : evidence,
    reason
  };
}

function notRunResult({ browser, completedAt, plan, reason, scenarioId, startedAt }) {
  return scenarioResult({
    browser,
    completedAt,
    evidence: [],
    plan,
    reason,
    scenarioId,
    startedAt
  });
}

async function defaultCellExecutor(context) {
  if (context.scenario.id === 'SETTINGS-01') return executeSettingsScenario(context);
  return Object.freeze({
    postCloseFinalizer: null,
    result: await executeAuthenticInstalledBrowserCell(context)
  });
}

function assertOwnedRunCapability(ownedRun, plan) {
  if (
    !ownedRun ||
    typeof ownedRun !== 'object' ||
    typeof ownedRun.runRoot !== 'string' ||
    typeof ownedRun.fixtureToken !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(ownedRun.fixtureToken) ||
    ownedRun.fixtureTokenSha256 !== sha256(ownedRun.fixtureToken) ||
    typeof ownedRun.complete !== 'function' ||
    typeof ownedRun.retainFailure !== 'function'
  ) {
    throw new Error('Prepared installed-browser run capability is malformed or not bound to a 32-byte fixture secret.');
  }
  if (!plan.inputs.fixture.tokenGeneratedAfterApproval || plan.inputs.fixture.tokenBytes !== 32) {
    throw new Error('Approved plan does not require a post-approval 32-byte fixture secret.');
  }
}

function assertExactFixturePair({ ipv4Fixture, ipv6Fixture, plan, expectedToken, expectedTokenSha256 }) {
  assertFixtureEndpoint(ipv4Fixture, {
    host: '127.0.0.1',
    port: null,
    plan,
    expectedToken,
    expectedTokenSha256
  });
  assertFixtureEndpoint(ipv6Fixture, {
    host: '::1',
    port: ipv4Fixture.port,
    plan,
    expectedToken,
    expectedTokenSha256
  });
  if (
    !/^[a-f0-9]{64}$/u.test(String(ipv4Fixture.runToken || '')) ||
    ipv4Fixture.runToken !== ipv6Fixture.runToken ||
    ipv4Fixture.runTokenSha256 !== sha256(ipv4Fixture.runToken) ||
    ipv4Fixture.runTokenSha256 !== ipv6Fixture.runTokenSha256
  ) {
    throw new Error('Installed-browser dual-stack fixtures do not share one exact 32-byte post-approval secret.');
  }
}

function assertFixtureEndpoint(fixture, { host, port, plan, expectedToken, expectedTokenSha256 }) {
  if (
    !fixture ||
    typeof fixture !== 'object' ||
    fixture.host !== host ||
    !Number.isInteger(fixture.port) ||
    fixture.port < 1 ||
    fixture.port > 65535 ||
    (port !== null && fixture.port !== port) ||
    typeof fixture.close !== 'function' ||
    typeof fixture.requestLedger !== 'function' ||
    (expectedToken !== null && fixture.runToken !== expectedToken) ||
    (expectedTokenSha256 !== null && fixture.runTokenSha256 !== expectedTokenSha256) ||
    stableJson(fixture.policy?.allowedHosts) !== stableJson(plan.inputs.fixture.allowedHosts) ||
    stableJson(fixture.policy?.allowedRoutes) !== stableJson(plan.inputs.fixture.allowedRoutes) ||
    stableJson(fixture.policy?.allowedMethods) !== stableJson(plan.inputs.fixture.allowedMethods)
  ) {
    throw new Error(`Installed-browser ${host} fixture differs from the exact approved post-approval binding.`);
  }
}

function validateProxyCapability(proxy) {
  validateRuntimeProxyBinding({ schema: proxy?.schema, host: proxy?.host, port: proxy?.port });
  if (typeof proxy?.requestLedger !== 'function' || typeof proxy?.close !== 'function') {
    throw new Error('Installed-browser deny proxy lacks its exact ledger or reconciliation capability.');
  }
  return proxy;
}

function fixtureExecutionView(fixture) {
  return Object.freeze({
    host: fixture.host,
    port: fixture.port,
    runToken: fixture.runToken,
    runTokenSha256: fixture.runTokenSha256,
    policy: structuredClone(fixture.policy),
    requestLedger: fixture.requestLedger
  });
}

function proxyExecutionView(proxy) {
  return Object.freeze({
    schema: proxy.schema,
    host: proxy.host,
    port: proxy.port,
    requestLedger: proxy.requestLedger
  });
}

function assertStagedCell(cell, { browserName, scenarioId, plan, stagedProfiles }) {
  if (
    !cell ||
    typeof cell !== 'object' ||
    cell.runId !== plan.runId ||
    cell.planSha256 !== plan.planSha256 ||
    cell.browserName !== browserName ||
    cell.scenarioId !== scenarioId ||
    typeof cell.profilePath !== 'string' ||
    !cell.profilePath ||
    typeof cell.canaryPath !== 'string' ||
    !cell.canaryPath ||
    !/^[A-F0-9]{64}$/u.test(String(cell.canarySha256 || ''))
  ) {
    throw new Error('Staged browser cell differs from its exact plan, scenario, or browser identity.');
  }
  const profileIdentity = process.platform === 'win32' ? cell.profilePath.toLowerCase() : cell.profilePath;
  if (stagedProfiles.has(profileIdentity)) {
    throw new Error('Staged browser cells reused a disposable profile identity.');
  }
  stagedProfiles.add(profileIdentity);
}

function assertExactCleanCloseReceipt(receipt, { browser, cell, launchReceipt, plan }) {
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
    'Installed-browser close receipt'
  );
  assertExactKeys(
    receipt.mustPreserveDownloadCanary,
    ['expectedSha256', 'observedSha256', 'path', 'preserved'],
    'Installed-browser close canary receipt'
  );
  const processIdentity = launchReceipt?.processIdentity;
  if (
    !processIdentity ||
    !Number.isInteger(processIdentity.processId) ||
    processIdentity.processId <= 0 ||
    !/^\d+$/u.test(String(processIdentity.startTimeUtcTicks || ''))
  ) {
    throw new Error('Installed-browser close receipt lacks its exact launched process binding.');
  }
  validateWindowsProfileResidueObservation(receipt.processResidue, {
    processId: processIdentity.processId,
    expectedProcessPath: browser.executablePath,
    expectedProcessSha256: browser.executableSha256,
    expectedProcessStartTimeUtcTicks: processIdentity.startTimeUtcTicks,
    expectedProfilePath: cell.profilePath
  });
  if (
    receipt.schema !== 'sitewipe.installed-browser-close-observation.v1' ||
    receipt.runId !== plan.runId ||
    receipt.planSha256 !== plan.planSha256 ||
    receipt.browserName !== browser.name ||
    !isIsoTimestamp(receipt.closeStartedAt) ||
    !isIsoTimestamp(receipt.observedAt) ||
    Date.parse(receipt.observedAt) < Date.parse(receipt.closeStartedAt) ||
    receipt.observationStatus !== 'clean' ||
    receipt.gracefulCloseError !== null ||
    receipt.profileProcessResidueCount !== 0 ||
    receipt.processResidue.residues.length !== 0 ||
    !sameCellPath(receipt.mustPreserveDownloadCanary.path, cell.canaryPath) ||
    receipt.mustPreserveDownloadCanary.expectedSha256 !== cell.canarySha256 ||
    receipt.mustPreserveDownloadCanary.observedSha256 !== cell.canarySha256 ||
    receipt.mustPreserveDownloadCanary.preserved !== true ||
    receipt.semanticValidationStatus !== SEMANTIC_VALIDATION_STATUS ||
    receipt.semanticValidatorManifestSha256 !== SEMANTIC_VALIDATOR_MANIFEST_SHA256 ||
    receipt.automaticProfileDeletionPerformed !== false ||
    receipt.automaticDownloadDeletionPerformed !== false
  ) {
    throw new Error('Installed-browser teardown was not certainly clean; no cell evidence may be accepted.');
  }
}

function sameCellPath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  const normalize = (value) => value.replaceAll('/', '\\');
  const normalizedLeft = normalize(left);
  const normalizedRight = normalize(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function exactBrowserPin(plan, browserName) {
  const browser = plan.inputs.browserPins.find(({ name }) => name === browserName);
  if (!browser) throw new Error(`Approved browser plan lacks exact ${browserName} identity.`);
  return browser;
}

async function reconcileNetworkResources(resources) {
  const failures = [];
  const closed = {
    proxyClosed: resources.proxy === null,
    ipv6FixtureClosed: resources.ipv6Fixture === null,
    ipv4FixtureClosed: resources.ipv4Fixture === null
  };
  for (const [key, label, closedKey] of [
    ['proxy', 'proxy_reconciliation_failed', 'proxyClosed'],
    ['ipv6Fixture', 'ipv6_fixture_reconciliation_failed', 'ipv6FixtureClosed'],
    ['ipv4Fixture', 'ipv4_fixture_reconciliation_failed', 'ipv4FixtureClosed']
  ]) {
    const resource = resources[key];
    if (resource === null) continue;
    try {
      await resource.close();
      closed[closedKey] = true;
    } catch (error) {
      failures.push(failureReason(label, error));
    } finally {
      resources[key] = null;
    }
  }
  return Object.freeze({ ...closed, failures: Object.freeze(failures) });
}

function failureReason(code, error) {
  const digest = opaqueErrorDigest(error);
  return `${code}; no semantic success was claimed; opaque error SHA-256 ${digest}.`;
}

function opaqueErrorDigest(error) {
  return sha256(`sitewipe.opaque-thrown-value.v1\0${typeof error}`);
}

function attachOpaqueSettlementFailure(error, settlementError) {
  if (error === null || !['function', 'object'].includes(typeof error)) return;
  try {
    FAILURE_SETTLEMENT_ANNOTATIONS.set(error, opaqueErrorDigest(settlementError));
  } catch {
    // Settlement annotation must never replace or mask the original thrown value.
  }
}

function exactNow(now) {
  const value = now();
  if (!isIsoTimestamp(value)) throw new Error('Installed-browser runner clock returned a non-ISO timestamp.');
  return value;
}

function nondecreasingNow(now, lowerBound) {
  const value = exactNow(now);
  return Date.parse(value) < Date.parse(lowerBound) ? lowerBound : value;
}

function assertPublicProjectionPrivacy(value) {
  const visit = (current, keyPath) => {
    if (typeof current === 'string') {
      if (
        /^[a-z]:[\\/]/iu.test(current) ||
        /^\\\\/u.test(current) ||
        /^\/(?:Users|home|tmp|var)(?:\/|$)/u.test(current)
      ) {
        throw new Error(`Installed-browser public projection contains a local path at ${keyPath}.`);
      }
      return;
    }
    if (!current || typeof current !== 'object') return;
    for (const [key, child] of Object.entries(current)) {
      if (/path|root|token/iu.test(key)) {
        throw new Error(`Installed-browser public projection contains forbidden private field ${keyPath}.${key}.`);
      }
      visit(child, `${keyPath}.${key}`);
    }
  };
  visit(value, 'projection');
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} keys differ from the exact schema.`);
  }
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(value) && !Number.isNaN(Date.parse(value));
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

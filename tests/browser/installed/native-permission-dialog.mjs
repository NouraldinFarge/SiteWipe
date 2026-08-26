import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat as nativeLstat, open, realpath } from 'node:fs/promises';
import { dirname, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isDriveQualifiedWindowsAbsolutePath } from './path-contract.mjs';

const directory = dirname(fileURLToPath(import.meta.url));
export const NATIVE_PROMPT_POLICY_PATH = resolve(directory, 'native-permission-policy.json');
export const NATIVE_PROMPT_HELPER_PATH = resolve(directory, 'windows-permission-dialog.ps1');
const EXACT_STAT_OPTIONS = Object.freeze({ bigint: true });

const REVIEWED_PERMISSION_PATTERNS = Object.freeze([
  'http://*.example.com/*',
  'http://example.com/*',
  'https://*.example.com/*',
  'https://example.com/*'
]);
const REVIEWED_EXPECTED_FRAGMENTS = Object.freeze(['SiteWipe', 'example.com']);
const REVIEWED_SCENARIO_SCHEDULE = deepFreeze([
  {
    id: 'SMOKE-01.observe-none',
    scenarioId: 'SMOKE-01',
    action: 'observe-none',
    timeoutSeconds: 420,
    actionDelaySeconds: 0
  },
  {
    id: 'SETTINGS-01.observe-none',
    scenarioId: 'SETTINGS-01',
    action: 'observe-none',
    timeoutSeconds: 420,
    actionDelaySeconds: 0
  },
  {
    id: 'PERM-01.allow',
    scenarioId: 'PERM-01',
    action: 'allow',
    timeoutSeconds: 20,
    actionDelaySeconds: 0
  },
  {
    id: 'PERM-01.deny',
    scenarioId: 'PERM-01',
    action: 'deny',
    timeoutSeconds: 20,
    actionDelaySeconds: 0
  },
  {
    id: 'PERM-01.dismiss',
    scenarioId: 'PERM-01',
    action: 'dismiss',
    timeoutSeconds: 20,
    actionDelaySeconds: 0
  },
  {
    id: 'PERM-01.timeout-late-allow',
    scenarioId: 'PERM-01',
    action: 'allow',
    timeoutSeconds: 420,
    actionDelaySeconds: 360
  }
]);
const REVIEWED_UIA_SNAPSHOTS = deepFreeze([
  {
    browserName: 'brave',
    browserVersion: '151.1.93.138',
    browserExecutableSha256: '5765ED474E75FD3C69A418CD6F8A0EC13F4B269459ABF4245674A83355657293',
    scheduleIds: ['PERM-01.allow', 'PERM-01.deny', 'PERM-01.dismiss', 'PERM-01.timeout-late-allow'],
    exactNormalizedNames: [
      'Allow',
      'Close',
      'Deny',
      'Read and change your data on example.com and all its subdomains',
      'SiteWipe'
    ]
  },
  {
    browserName: 'chrome',
    browserVersion: '151.0.7922.174',
    browserExecutableSha256: 'B6D40F55E48E61760335D18F46ABCEC929E1A11B8330E7F2B501037584AF4AA4',
    scheduleIds: ['PERM-01.allow', 'PERM-01.deny', 'PERM-01.dismiss', 'PERM-01.timeout-late-allow'],
    exactNormalizedNames: [
      'Allow',
      'Close',
      'Deny',
      'Read and change your data on example.com and all its subdomains',
      'SiteWipe'
    ]
  }
]);

const policyBytes = await readExactFile(NATIVE_PROMPT_POLICY_PATH, 'Native prompt policy');
const policy = validatePolicy(JSON.parse(policyBytes.toString('utf8')));
const helperBytes = await readExactFile(NATIVE_PROMPT_HELPER_PATH, 'Native prompt helper');

export const NATIVE_PROMPT_POLICY_SHA256 = sha256(policyBytes);
export const NATIVE_PROMPT_HELPER_SHA256 = sha256(helperBytes);
export const NATIVE_PROMPT_ALLOWED_ACTIONS = Object.freeze([...policy.allowedActions]);
export const NATIVE_PROMPT_PERMISSION_PATTERNS = Object.freeze([...policy.permissionPatterns]);
export const NATIVE_PROMPT_EXPECTED_FRAGMENTS = Object.freeze([...policy.expectedFragments]);
export const NATIVE_PROMPT_SCENARIO_SCHEDULE = deepFreeze(structuredClone(policy.scenarioSchedule));
export const NATIVE_PROMPT_UIA_SNAPSHOTS = deepFreeze(structuredClone(policy.uiaSnapshots));
export const NATIVE_PROMPT_MAX_OUTPUT_BYTES = 64 * 1024;
export const NATIVE_PROMPT_PROCESS_SETTLE_GRACE_MS = 5_000;
export const NATIVE_PROMPT_READY_TIMEOUT_MS = 10_000;
export const NATIVE_PROMPT_HELPER_FAILURE_STAGES = Object.freeze([
  'helper_identity',
  'request_json_decode',
  'request_policy',
  'uia_assembly_load',
  'target_process_identity',
  'readiness_emit',
  'runtime_observation'
]);
const NATIVE_PROMPT_HELPER_FAILURE_SCHEMA = 'sitewipe.native-permission-helper-failure.v1';

export function validateNativePromptRequest(request) {
  assertExactKeys(
    request,
    [
      'expectedProcessPath',
      'expectedProcessSha256',
      'expectedProcessStartTimeUtcTicks',
      'scheduleId',
      'targetProcessId'
    ],
    'Native prompt request'
  );
  const { targetProcessId, expectedProcessPath, expectedProcessSha256, expectedProcessStartTimeUtcTicks, scheduleId } =
    request;
  if (!Number.isInteger(targetProcessId) || targetProcessId <= 0)
    throw new Error('Native prompt browser PID is invalid.');
  if (!isDriveQualifiedWindowsAbsolutePath(expectedProcessPath) || !isSha256(expectedProcessSha256)) {
    throw new Error('Native prompt browser path and SHA-256 must be exact.');
  }
  if (!/^\d+$/.test(String(expectedProcessStartTimeUtcTicks || ''))) {
    throw new Error('Native prompt browser start-time identity is invalid.');
  }
  const schedule = policy.scenarioSchedule.find((entry) => entry.id === scheduleId);
  if (!schedule) throw new Error('Native prompt scheduleId is outside the exact reviewed scenario/action schedule.');
  const browserSnapshot = policy.uiaSnapshots.find((entry) => entry.browserExecutableSha256 === expectedProcessSha256);
  if (!browserSnapshot) throw new Error('Native prompt browser identity has no exact reviewed UIA snapshot policy.');
  if (schedule.action !== 'observe-none' && !browserSnapshot.scheduleIds.includes(schedule.id)) {
    throw new Error('Native prompt browser/schedule pair has no exact reviewed UIA snapshot policy.');
  }
  const expectedDialogTitle = policy.dialogTitleTemplate.replace('{extensionName}', policy.extensionName);
  return Object.freeze({
    targetProcessId,
    expectedProcessPath: win32.resolve(expectedProcessPath),
    expectedProcessSha256,
    expectedProcessStartTimeUtcTicks: String(expectedProcessStartTimeUtcTicks),
    scheduleId: schedule.id,
    scenarioId: schedule.scenarioId,
    action: schedule.action,
    browserName: browserSnapshot.browserName,
    browserVersion: browserSnapshot.browserVersion,
    expectedExtensionName: policy.extensionName,
    expectedDialogTitle,
    permissionPatterns: NATIVE_PROMPT_PERMISSION_PATTERNS,
    expectedFragments: NATIVE_PROMPT_EXPECTED_FRAGMENTS,
    expectedUiaNames: Object.freeze(
      schedule.action === 'observe-none' ? [] : [...browserSnapshot.exactNormalizedNames]
    ),
    expectedActionControlName:
      schedule.action === 'observe-none' ? '[none]' : policy.actionControlNames[schedule.action],
    timeoutSeconds: schedule.timeoutSeconds,
    actionDelaySeconds: schedule.actionDelaySeconds
  });
}

export function nativePromptArguments(request) {
  const exact = validateNativePromptRequest(request);
  return nativePromptArgumentsFromExact(exact);
}

function nativePromptArgumentsFromExact(exact) {
  return Object.freeze([
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-File',
    NATIVE_PROMPT_HELPER_PATH,
    '-TargetProcessId',
    String(exact.targetProcessId),
    '-ExpectedProcessPath',
    exact.expectedProcessPath,
    '-ExpectedProcessSha256',
    exact.expectedProcessSha256,
    '-ExpectedProcessStartTimeUtcTicks',
    exact.expectedProcessStartTimeUtcTicks,
    '-ExpectedScheduleId',
    exact.scheduleId,
    '-ExpectedBrowserName',
    exact.browserName,
    '-ExpectedBrowserVersion',
    exact.browserVersion,
    '-Action',
    exact.action,
    '-ExpectedExtensionName',
    exact.expectedExtensionName,
    '-ExpectedDialogTitle',
    exact.expectedDialogTitle,
    '-ExpectedFragmentsJson',
    JSON.stringify(exact.expectedFragments),
    '-ExpectedPermissionPatternsJson',
    JSON.stringify(exact.permissionPatterns),
    '-ExpectedUiaNamesJson',
    JSON.stringify(exact.expectedUiaNames),
    '-ExpectedActionControlName',
    exact.expectedActionControlName,
    '-ExpectedHelperSha256',
    NATIVE_PROMPT_HELPER_SHA256,
    '-TimeoutSeconds',
    String(exact.timeoutSeconds),
    '-ActionDelaySeconds',
    String(exact.actionDelaySeconds)
  ]);
}

export async function startNativePermissionPromptHelper(request) {
  if (process.platform !== 'win32') throw new Error('Native permission prompt automation requires Windows.');
  const exact = validateNativePromptRequest(request);
  const browserIdentity = await exactFileIdentity(exact.expectedProcessPath, 'Pinned browser executable');
  if (browserIdentity.sha256 !== exact.expectedProcessSha256) {
    throw new Error('Pinned browser executable bytes changed before native prompt helper launch.');
  }
  const powerShell = await exactFileIdentity(policy.powershell.path, 'Pinned Windows PowerShell', {
    allowWindowsSystemPowerShellHardLinks: true
  });
  if (powerShell.sha256 !== policy.powershell.sha256) {
    throw new Error('Pinned Windows PowerShell bytes differ from native prompt policy.');
  }
  const args = nativePromptArgumentsFromExact(exact);
  if (args.includes('-ExecutionPolicy')) throw new Error('Native prompt helper may not bypass PowerShell policy.');
  const child = spawn(powerShell.path, args, {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: minimalWindowsEnvironment()
  });
  const lifecycle = createNativePromptHelperLifecycle(child, request, { powerShell });
  const readiness = await lifecycle.waitUntilReady();
  return Object.freeze({
    cancelAndWait: lifecycle.cancelAndWait,
    helperSha256: lifecycle.helperSha256,
    powerShell: lifecycle.powerShell,
    readiness,
    settle: lifecycle.settle
  });
}

/**
 * Wraps exactly one spawned PowerShell helper. The lifecycle methods are
 * mutually exclusive and single use. They may terminate only this exact child
 * process and always wait a bounded time for its close event.
 */
export function createNativePromptHelperLifecycle(child, request, { powerShell = null } = {}) {
  const exact = validateNativePromptRequest(request);
  const lifecycleStartedAtMs = Date.now();
  if (
    !child ||
    typeof child !== 'object' ||
    !Number.isInteger(child.pid) ||
    child.pid <= 0 ||
    !child.stdin ||
    !child.stdout ||
    !child.stderr ||
    typeof child.kill !== 'function' ||
    typeof child.once !== 'function'
  ) {
    throw new Error('Native prompt helper child capability is malformed.');
  }
  let stdout = '';
  let stderr = '';
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputFailure = null;
  let lifecycleClaimed = false;
  let processClosed = false;
  let childError = null;
  let terminationRequested = false;
  let readiness = null;
  let readinessFailure = null;
  let resolveReadiness;
  let rejectReadiness;
  let finalEvidence = null;
  let completeLineBuffer = '';
  const readinessResult = new Promise((resolveReady, rejectReady) => {
    resolveReadiness = resolveReady;
    rejectReadiness = rejectReady;
  });
  void readinessResult.catch(() => undefined);
  const requestExactTermination = () => {
    if (processClosed || terminationRequested) return;
    terminationRequested = true;
    try {
      terminateExactHelperChild(child);
    } catch (error) {
      outputFailure ??= new Error('Native prompt helper exact-child termination failed.', { cause: error });
    }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    ({ bytes: stdoutBytes, text: stdout } = collectBoundedHelperOutput({
      bytes: stdoutBytes,
      chunk,
      label: 'stdout',
      onLimit: (error) => {
        if (outputFailure === null) {
          outputFailure = error;
          requestExactTermination();
        }
      },
      text: stdout
    }));
    if (outputFailure === null) {
      completeLineBuffer += String(chunk);
      let newline = completeLineBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = completeLineBuffer.slice(0, newline).trimEnd();
        completeLineBuffer = completeLineBuffer.slice(newline + 1);
        if (line.length > 0) {
          try {
            const record = JSON.parse(line);
            if (record?.schema === NATIVE_PROMPT_HELPER_FAILURE_SCHEMA) {
              const failure = validateNativePromptFailure(
                record,
                request,
                child.pid,
                readiness === null ? 'before_ready' : 'after_ready'
              );
              if (readiness === null) {
                readinessFailure ??= nativePromptFailureError(failure);
                rejectReadiness(readinessFailure);
                requestExactTermination();
              } else if (finalEvidence === null) {
                finalEvidence = failure;
              } else {
                outputFailure ??= new Error('Native prompt helper returned more than one final evidence record.');
                requestExactTermination();
              }
            } else if (readiness === null) {
              readiness = validateNativePromptReadiness(record, request, child.pid);
              resolveReadiness(readiness);
            } else if (finalEvidence === null) {
              finalEvidence = record;
            } else {
              outputFailure ??= new Error('Native prompt helper returned more than one final evidence record.');
              requestExactTermination();
            }
          } catch (error) {
            readinessFailure ??= new Error('Native prompt helper returned a malformed protocol record.', {
              cause: error
            });
            rejectReadiness(readinessFailure);
            requestExactTermination();
          }
        }
        newline = completeLineBuffer.indexOf('\n');
      }
    }
  });
  child.stderr.on('data', (chunk) => {
    ({ bytes: stderrBytes, text: stderr } = collectBoundedHelperOutput({
      bytes: stderrBytes,
      chunk,
      label: 'stderr',
      onLimit: (error) => {
        if (outputFailure === null) {
          outputFailure = error;
          requestExactTermination();
        }
      },
      text: stderr
    }));
  });
  const closed = new Promise((resolveClosed) => {
    child.once('error', (error) => {
      childError ??= error;
      rejectReadiness(error);
      requestExactTermination();
    });
    child.once('close', (code, signal) => {
      if (processClosed) return;
      processClosed = true;
      if (readiness === null)
        rejectReadiness(new Error('Native prompt helper closed before its exact readiness handshake.'));
      resolveClosed({ code, signal });
    });
  });
  const result = closed.then(({ code, signal }) => {
    if (childError) throw childError;
    if (outputFailure) throw outputFailure;
    if (readinessFailure) throw readinessFailure;
    if (readiness === null) throw new Error('Native prompt helper closed before its exact readiness handshake.');
    if (completeLineBuffer.trim().length > 0)
      throw new Error('Native prompt helper ended with an incomplete protocol record.');
    const evidence = finalEvidence;
    if (evidence?.schema === NATIVE_PROMPT_HELPER_FAILURE_SCHEMA) {
      throw nativePromptFailureError(validateNativePromptFailure(evidence, request, child.pid, 'after_ready'));
    }
    try {
      validateNativePromptEvidence(evidence, request, { code, signal });
      return evidence;
    } catch (validationError) {
      throw Object.assign(validationError, { nativePromptEvidence: evidence, stderr });
    }
  });
  void result.catch(() => undefined);

  const claimLifecycle = () => {
    if (lifecycleClaimed) throw new Error('Native prompt helper lifecycle was already settled or cancelled.');
    lifecycleClaimed = true;
  };
  const waitUntilReady = async () => {
    try {
      return await settleWithin(readinessResult, NATIVE_PROMPT_READY_TIMEOUT_MS, 'Native prompt helper readiness');
    } catch (error) {
      if (!processClosed) {
        requestExactTermination();
        await settleWithin(
          closed,
          NATIVE_PROMPT_PROCESS_SETTLE_GRACE_MS,
          'Native prompt helper readiness termination wait'
        );
      }
      throw outputFailure || childError || readinessFailure || error;
    }
  };
  const settle = async () => {
    claimLifecycle();
    try {
      await waitUntilReady();
      if (exact.action === 'observe-none') await signalObserveNoneStop(child, exact);
      const remainingWatchdogMs = Math.max(
        1,
        exact.timeoutSeconds * 1_000 + NATIVE_PROMPT_PROCESS_SETTLE_GRACE_MS - (Date.now() - lifecycleStartedAtMs)
      );
      return await settleWithin(result, remainingWatchdogMs, 'Native prompt helper settlement');
    } catch (error) {
      if (!processClosed) {
        requestExactTermination();
        await settleWithin(closed, NATIVE_PROMPT_PROCESS_SETTLE_GRACE_MS, 'Native prompt helper termination wait');
      }
      throw error;
    }
  };
  const cancelAndWait = async () => {
    claimLifecycle();
    const alreadySettled = processClosed;
    if (!alreadySettled) requestExactTermination();
    await settleWithin(closed, NATIVE_PROMPT_PROCESS_SETTLE_GRACE_MS, 'Native prompt helper cancellation wait');
    return Object.freeze({
      schema: 'sitewipe.native-permission-helper-settlement.v1',
      processId: child.pid,
      status: alreadySettled ? 'already_settled' : 'terminated_and_settled'
    });
  };
  return Object.freeze({
    cancelAndWait,
    helperSha256: NATIVE_PROMPT_HELPER_SHA256,
    powerShell,
    settle,
    waitUntilReady
  });
}

async function signalObserveNoneStop(child, exact) {
  if (exact.action !== 'observe-none' || child.stdin.destroyed || child.stdin.writableEnded) {
    throw new Error('Native no-prompt helper does not expose its exact controlled-stop channel.');
  }
  const control = {
    schema: 'sitewipe.native-permission-helper-control.v1',
    command: 'stop-observation',
    scheduleId: exact.scheduleId
  };
  await new Promise((resolveWrite, rejectWrite) => {
    const onError = (error) => {
      child.stdin.off('error', onError);
      rejectWrite(new Error('Native no-prompt helper controlled-stop write failed.', { cause: error }));
    };
    child.stdin.once('error', onError);
    child.stdin.end(`${JSON.stringify(control)}\n`, 'utf8', () => {
      child.stdin.off('error', onError);
      resolveWrite();
    });
  });
}

function collectBoundedHelperOutput({ bytes, chunk, label, onLimit, text }) {
  if (typeof chunk !== 'string') chunk = String(chunk);
  const chunkBytes = Buffer.byteLength(chunk, 'utf8');
  if (bytes + chunkBytes > NATIVE_PROMPT_MAX_OUTPUT_BYTES) {
    onLimit(new Error(`Native prompt helper ${label} exceeded its fixed byte limit.`));
    return { bytes, text };
  }
  return { bytes: bytes + chunkBytes, text: text + chunk };
}

function terminateExactHelperChild(child) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) {
    throw new Error('Native prompt helper cannot terminate an inexact child process.');
  }
  child.kill('SIGTERM');
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

export function validateNativePromptEvidence(evidence, request, { code = 0, signal = null } = {}) {
  const exact = validateNativePromptRequest(request);
  const expectedStatus = exact.action === 'observe-none' ? 'no_prompt_observed' : 'invoked';
  if (
    signal !== null ||
    code !== 0 ||
    evidence?.schema !== 'sitewipe.native-permission-dialog-evidence.v1' ||
    evidence?.status !== expectedStatus ||
    evidence?.scheduleId !== exact.scheduleId ||
    evidence?.scenarioId !== exact.scenarioId ||
    evidence?.browserName !== exact.browserName ||
    evidence?.browserVersion !== exact.browserVersion ||
    evidence?.action !== exact.action ||
    evidence?.dialogTitle !== exact.expectedDialogTitle ||
    evidence?.targetProcess?.processId !== exact.targetProcessId ||
    !sameWindowsPath(evidence?.targetProcess?.path, exact.expectedProcessPath) ||
    evidence?.targetProcess?.sha256 !== exact.expectedProcessSha256 ||
    evidence?.targetProcess?.startTimeUtcTicks !== exact.expectedProcessStartTimeUtcTicks ||
    JSON.stringify(evidence?.permissionPatterns) !== JSON.stringify(exact.permissionPatterns) ||
    JSON.stringify(evidence?.expectedFragments) !== JSON.stringify(exact.expectedFragments) ||
    JSON.stringify(evidence?.observedNames) !== JSON.stringify(exact.expectedUiaNames) ||
    Number.isNaN(Date.parse(String(evidence?.observedAt || ''))) ||
    (exact.action === 'observe-none' &&
      (Number.isNaN(Date.parse(String(evidence?.observationStartedAt || ''))) ||
        Number.isNaN(Date.parse(String(evidence?.stopRequestedAt || ''))) ||
        Date.parse(evidence.observationStartedAt) > Date.parse(evidence.stopRequestedAt) ||
        Date.parse(evidence.stopRequestedAt) > Date.parse(evidence.observedAt)))
  ) {
    throw new Error('Native prompt helper evidence is incomplete or differs from the exact request.');
  }
  if (exact.action !== 'observe-none' && evidence.actionControlName !== exact.expectedActionControlName) {
    throw new Error('Native prompt helper invoked a different action control.');
  }
  return evidence;
}

export function validateNativePromptReadiness(value, request, helperProcessId) {
  const exact = validateNativePromptRequest(request);
  assertExactKeys(
    value,
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
    'Native prompt readiness'
  );
  if (
    value.schema !== 'sitewipe.native-permission-helper-ready.v1' ||
    value.status !== 'ready' ||
    value.scheduleId !== exact.scheduleId ||
    value.scenarioId !== exact.scenarioId ||
    value.action !== exact.action ||
    value.browserName !== exact.browserName ||
    value.browserVersion !== exact.browserVersion ||
    value.helperProcessId !== helperProcessId ||
    value.targetProcess?.processId !== exact.targetProcessId ||
    !sameWindowsPath(value.targetProcess?.path, exact.expectedProcessPath) ||
    value.targetProcess?.sha256 !== exact.expectedProcessSha256 ||
    value.targetProcess?.startTimeUtcTicks !== exact.expectedProcessStartTimeUtcTicks ||
    Number.isNaN(Date.parse(String(value.readyAt || '')))
  ) {
    throw new Error('Native prompt helper readiness differs from the exact request and child identity.');
  }
  return deepFreeze(structuredClone(value));
}

export function validateNativePromptFailure(value, request, helperProcessId, expectedPhase) {
  const exact = validateNativePromptRequest(request);
  const stageMatchesPhase =
    expectedPhase === 'before_ready'
      ? value?.stage !== 'runtime_observation'
      : expectedPhase === 'after_ready' && value?.stage === 'runtime_observation';
  assertExactKeys(
    value,
    ['action', 'browserName', 'helperProcessId', 'phase', 'scheduleId', 'schema', 'stage', 'status', 'targetProcessId'],
    'Native prompt helper failure'
  );
  if (
    value.schema !== NATIVE_PROMPT_HELPER_FAILURE_SCHEMA ||
    value.status !== 'failed' ||
    !['before_ready', 'after_ready'].includes(expectedPhase) ||
    value.phase !== expectedPhase ||
    !NATIVE_PROMPT_HELPER_FAILURE_STAGES.includes(value.stage) ||
    !stageMatchesPhase ||
    value.scheduleId !== exact.scheduleId ||
    value.browserName !== exact.browserName ||
    value.action !== exact.action ||
    value.helperProcessId !== helperProcessId ||
    value.targetProcessId !== exact.targetProcessId
  ) {
    throw new Error('Native prompt helper failure differs from the exact request, child, phase, or stage contract.');
  }
  return deepFreeze(structuredClone(value));
}

function nativePromptFailureError(failure) {
  const error = new Error(`Native prompt helper failed at the fixed ${failure.phase}/${failure.stage} stage.`);
  error.code = 'SITEWIPE_NATIVE_PROMPT_HELPER_FAILURE';
  error.phase = failure.phase;
  error.stage = failure.stage;
  return error;
}

async function readExactFile(path, label) {
  const identity = await exactFileIdentity(path, label);
  return identity.bytes;
}

export async function exactNativePathStat(path, statImplementation = nativeLstat) {
  if (typeof statImplementation !== 'function') {
    throw new Error('Native prompt exact path-stat implementation is unavailable.');
  }
  return statImplementation(path, EXACT_STAT_OPTIONS);
}

export async function exactNativeHandleStat(handle) {
  if (!handle || typeof handle.stat !== 'function') {
    throw new Error('Native prompt exact handle-stat capability is unavailable.');
  }
  return handle.stat(EXACT_STAT_OPTIONS);
}

async function exactFileIdentity(path, label, { allowWindowsSystemPowerShellHardLinks = false } = {}) {
  const expected = resolve(path);
  const before = await exactNativePathStat(expected);
  assertExactPhysicalNativeFile(before, label, { allowWindowsSystemPowerShellHardLinks });
  const actual = await realpath(expected);
  if (!sameHostPath(actual, expected)) throw new Error(`${label} path is aliased.`);
  const handle = await open(actual, 'r');
  try {
    const opened = await exactNativeHandleStat(handle);
    assertExactPhysicalNativeFile(opened, label, { allowWindowsSystemPowerShellHardLinks });
    const bytes = await handle.readFile();
    const after = await exactNativeHandleStat(handle);
    assertExactPhysicalNativeFile(after, label, { allowWindowsSystemPowerShellHardLinks });
    if (
      !sameNativeFileIdentity(before, opened) ||
      !sameNativeFileIdentity(opened, after) ||
      after.size !== BigInt(bytes.length)
    ) {
      throw new Error(`${label} identity changed while hashing.`);
    }
    return Object.freeze({ path: actual, bytes, sha256: sha256(bytes) });
  } finally {
    await handle.close();
  }
}

function validatePolicy(value) {
  if (
    value?.schema !== 'sitewipe.native-prompt-policy.v1' ||
    value?.extensionName !== 'SiteWipe' ||
    value?.dialogTitleTemplate !== '"{extensionName}" has requested additional permissions.' ||
    JSON.stringify(value?.allowedActions) !== JSON.stringify(['allow', 'deny', 'dismiss', 'observe-none']) ||
    JSON.stringify(value?.permissionPatterns) !== JSON.stringify(REVIEWED_PERMISSION_PATTERNS) ||
    JSON.stringify(value?.expectedFragments) !== JSON.stringify(REVIEWED_EXPECTED_FRAGMENTS) ||
    JSON.stringify(value?.scenarioSchedule) !== JSON.stringify(REVIEWED_SCENARIO_SCHEDULE) ||
    JSON.stringify(value?.uiaSnapshots) !== JSON.stringify(REVIEWED_UIA_SNAPSHOTS) ||
    JSON.stringify(value?.actionControlNames) !== JSON.stringify({ allow: 'Allow', deny: 'Deny', dismiss: 'Close' }) ||
    !isDriveQualifiedWindowsAbsolutePath(value?.powershell?.path) ||
    !isSha256(value?.powershell?.sha256) ||
    value?.constraints?.exactProcessIdentity !== true ||
    value?.constraints?.exactlyOneDialog !== true ||
    value?.constraints?.exactlyOneActionControl !== true ||
    value?.constraints?.coordinatesAllowed !== false ||
    value?.constraints?.globalInputAllowed !== false ||
    value?.constraints?.requiresUnlockedInteractiveSession !== true ||
    value?.constraints?.readinessHandshakeRequired !== true ||
    value?.constraints?.controlledObserveNoneStopRequired !== true ||
    value?.constraints?.maximumTimeoutSeconds !== 420 ||
    value?.constraints?.maximumActionDelaySeconds !== 360
  ) {
    throw new Error('Native prompt policy is malformed or wider than the reviewed boundary.');
  }
  return deepFreeze(structuredClone(value));
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const exact = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(exact)) {
    throw new Error(`${label} keys differ from the exact reviewed contract.`);
  }
}

function minimalWindowsEnvironment() {
  return Object.fromEntries(
    ['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].flatMap((name) =>
      typeof process.env[name] === 'string' ? [[name, process.env[name]]] : []
    )
  );
}

function assertExactPhysicalNativeFile(stat, label, { allowWindowsSystemPowerShellHardLinks = false } = {}) {
  if (
    !stat?.isFile() ||
    stat.isSymbolicLink() ||
    !hasExactBigIntFields(stat, ['birthtimeNs', 'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink', 'size']) ||
    stat.dev < 0n ||
    stat.ino < 0n ||
    stat.mode < 0n ||
    !hasApprovedNativeFileLinkCount(stat, { allowWindowsSystemPowerShellHardLinks }) ||
    stat.size < 0n
  ) {
    throw new Error(
      allowWindowsSystemPowerShellHardLinks
        ? `${label} must be a regular non-reparse file with a stable nonzero link count and exact bigint identity.`
        : `${label} must be a singly linked regular non-reparse file with exact bigint identity.`
    );
  }
}

export function hasApprovedNativeFileLinkCount(stat, { allowWindowsSystemPowerShellHardLinks = false } = {}) {
  if (typeof stat?.nlink !== 'bigint') return false;
  return allowWindowsSystemPowerShellHardLinks ? stat.nlink > 0n : stat.nlink === 1n;
}

export function sameNativeFileIdentity(left, right) {
  if (
    !hasExactBigIntFields(left, ['birthtimeNs', 'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink', 'size']) ||
    !hasExactBigIntFields(right, ['birthtimeNs', 'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink', 'size'])
  ) {
    return false;
  }
  return (
    left.birthtimeNs === right.birthtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.mtimeNs === right.mtimeNs &&
    left.nlink === right.nlink &&
    left.size === right.size
  );
}

function hasExactBigIntFields(value, fields) {
  return Boolean(value) && fields.every((field) => typeof value[field] === 'bigint');
}

function sameWindowsPath(left, right) {
  if (!isDriveQualifiedWindowsAbsolutePath(left) || !isDriveQualifiedWindowsAbsolutePath(right)) return false;
  return win32.resolve(String(left || '')).toLowerCase() === win32.resolve(String(right || '')).toLowerCase();
}

function sameHostPath(left, right) {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isSha256(value) {
  return /^[A-F0-9]{64}$/.test(String(value || ''));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

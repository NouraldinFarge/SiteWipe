import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  NATIVE_PROMPT_ALLOWED_ACTIONS,
  NATIVE_PROMPT_EXPECTED_FRAGMENTS,
  NATIVE_PROMPT_HELPER_PATH,
  NATIVE_PROMPT_HELPER_SHA256,
  NATIVE_PROMPT_HELPER_FAILURE_STAGES,
  NATIVE_PROMPT_MAX_OUTPUT_BYTES,
  NATIVE_PROMPT_PERMISSION_PATTERNS,
  NATIVE_PROMPT_POLICY_PATH,
  NATIVE_PROMPT_PROCESS_SETTLE_GRACE_MS,
  NATIVE_PROMPT_SCENARIO_SCHEDULE,
  NATIVE_PROMPT_UIA_SNAPSHOTS,
  createNativePromptHelperLifecycle,
  exactNativeHandleStat,
  exactNativePathStat,
  hasApprovedNativeFileLinkCount,
  nativePromptArguments,
  sameNativeFileIdentity,
  validateNativePromptEvidence,
  validateNativePromptFailure,
  validateNativePromptReadiness,
  validateNativePromptRequest
} from './native-permission-dialog.mjs';

const browserSha256 = 'B6D40F55E48E61760335D18F46ABCEC929E1A11B8330E7F2B501037584AF4AA4';
const request = {
  targetProcessId: 4242,
  expectedProcessPath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  expectedProcessSha256: browserSha256,
  expectedProcessStartTimeUtcTicks: '638917729350000000',
  scheduleId: 'PERM-01.allow'
};
const observeRequest = { ...request, scheduleId: 'SETTINGS-01.observe-none' };

test('native prompt request is exact, bounded, and derives the reviewed title/control', () => {
  assert.deepEqual(NATIVE_PROMPT_ALLOWED_ACTIONS, ['allow', 'deny', 'dismiss', 'observe-none']);
  assert.deepEqual(NATIVE_PROMPT_PERMISSION_PATTERNS, [
    'http://*.example.com/*',
    'http://example.com/*',
    'https://*.example.com/*',
    'https://example.com/*'
  ]);
  assert.deepEqual(NATIVE_PROMPT_EXPECTED_FRAGMENTS, ['SiteWipe', 'example.com']);
  assert.deepEqual(
    NATIVE_PROMPT_SCENARIO_SCHEDULE.map(({ id }) => id),
    [
      'SMOKE-01.observe-none',
      'SETTINGS-01.observe-none',
      'PERM-01.allow',
      'PERM-01.deny',
      'PERM-01.dismiss',
      'PERM-01.timeout-late-allow'
    ]
  );
  assert.equal(NATIVE_PROMPT_UIA_SNAPSHOTS.length, 2);
  const exact = validateNativePromptRequest(request);
  assert.equal(exact.action, 'allow');
  assert.equal(exact.scenarioId, 'PERM-01');
  assert.equal(exact.expectedDialogTitle, '"SiteWipe" has requested additional permissions.');
  assert.equal(exact.expectedActionControlName, 'Allow');
  assert.equal(Object.isFrozen(exact), true);
  assert.match(NATIVE_PROMPT_HELPER_SHA256, /^[A-F0-9]{64}$/);

  const args = nativePromptArguments(request);
  assert.equal(args.includes('-ExecutionPolicy'), false);
  assert.equal(args.includes('-File'), true);
  assert.equal(args[args.indexOf('-File') + 1], NATIVE_PROMPT_HELPER_PATH);
  assert.equal(args[args.indexOf('-ExpectedHelperSha256') + 1], NATIVE_PROMPT_HELPER_SHA256);
  assert.equal(args[args.indexOf('-ExpectedActionControlName') + 1], 'Allow');
});

test('native prompt request rejects caller-selected actions, fragments, origins, and schedules', () => {
  assert.throws(
    () => validateNativePromptRequest({ ...request, action: 'allow' }),
    /keys differ from the exact reviewed contract/
  );
  assert.throws(
    () => validateNativePromptRequest({ ...request, expectedFragments: ['SiteWipe', 'evil.invalid'] }),
    /keys differ from the exact reviewed contract/
  );
  assert.throws(
    () => validateNativePromptRequest({ ...request, permissionPatterns: ['https://evil.invalid/*'] }),
    /keys differ from the exact reviewed contract/
  );
  assert.throws(
    () => validateNativePromptRequest({ ...request, scheduleId: 'PERM-01.accept-anything' }),
    /outside the exact reviewed scenario\/action schedule/
  );
});

test('native prompt request rejects relative, root-relative, UNC, device, and padded browser paths', () => {
  for (const expectedProcessPath of [
    'chrome.exe',
    '\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '\\\\server\\share\\chrome.exe',
    '\\\\?\\C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ' C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe '
  ]) {
    assert.throws(
      () => validateNativePromptRequest({ ...request, expectedProcessPath }),
      /browser path and SHA-256 must be exact/,
      expectedProcessPath
    );
  }
});

test('native prompt evidence must retain the exact process, dialog, fragments, and action control', () => {
  const exact = validateNativePromptRequest(request);
  const evidence = {
    schema: 'sitewipe.native-permission-dialog-evidence.v1',
    status: 'invoked',
    scheduleId: exact.scheduleId,
    scenarioId: exact.scenarioId,
    browserName: exact.browserName,
    browserVersion: exact.browserVersion,
    action: 'allow',
    actionControlName: 'Allow',
    targetProcess: {
      processId: request.targetProcessId,
      path: request.expectedProcessPath,
      sha256: browserSha256,
      startTimeUtcTicks: request.expectedProcessStartTimeUtcTicks
    },
    dialogTitle: exact.expectedDialogTitle,
    permissionPatterns: [...exact.permissionPatterns],
    expectedFragments: [...exact.expectedFragments],
    observedNames: [...exact.expectedUiaNames],
    observedAt: '2026-08-24T22:00:00.000Z'
  };
  assert.equal(validateNativePromptEvidence(evidence, request), evidence);
  assert.throws(
    () => validateNativePromptEvidence({ ...evidence, actionControlName: 'Always allow' }, request),
    /different action control/
  );
  assert.throws(
    () =>
      validateNativePromptEvidence(
        { ...evidence, targetProcess: { ...evidence.targetProcess, startTimeUtcTicks: '638917729350000001' } },
        request
      ),
    /incomplete or differs/
  );
  assert.throws(
    () =>
      validateNativePromptEvidence(
        {
          ...evidence,
          observedNames: [...evidence.observedNames, 'Also read and change your data on evil.invalid']
        },
        request
      ),
    /incomplete or differs/
  );
});

test('PowerShell helper uses exact UIA identity and InvokePattern without coordinate or global-input fallbacks', async () => {
  const source = await readFile(NATIVE_PROMPT_HELPER_PATH, 'utf8');
  assert.match(source, /Expected exactly one enabled visible action control/);
  assert.match(source, /Expected at most one exact permission dialog/);
  assert.match(source, /Exact normalized UIA snapshot differs from the reviewed pinned-browser snapshot/);
  assert.match(source, /GetRuntimeId/);
  assert.match(source, /InvokePattern/);
  assert.match(source, /Get-ExactTargetProcess/);
  assert.match(source, /sitewipe\.native-permission-helper-ready\.v1/);
  assert.match(source, /ReadLineAsync/);
  assert.match(source, /observation_watchdog_expired/);
  for (const jsonArgument of ['ExpectedFragmentsJson', 'ExpectedUiaNamesJson', 'ExpectedPermissionPatternsJson']) {
    assert.match(source, new RegExp(`\\[object\\[\\]\\]\\(\\$${jsonArgument} \\| ConvertFrom-Json\\)`));
  }
  assert.match(source, /sitewipe\.native-permission-helper-failure\.v1/);
  for (const stage of NATIVE_PROMPT_HELPER_FAILURE_STAGES) assert.match(source, new RegExp(stage));
  assert.doesNotMatch(source, /Exception\.Message|\berror\s*=/i);
  assert.doesNotMatch(source, /SendKeys|SetCursorPos|mouse_event|keybd_event|Clipboard|WScript\.Shell/i);
});

test(
  'pinned Windows PowerShell decodes exact JSON arrays before target-process validation',
  { skip: process.platform !== 'win32' ? 'Pinned Windows PowerShell integration is Windows-only.' : false },
  async () => {
    const policy = JSON.parse(await readFile(NATIVE_PROMPT_POLICY_PATH, 'utf8'));
    const impossibleRequest = {
      ...observeRequest,
      targetProcessId: 2_147_483_647
    };
    const child = spawn(policy.powershell.path, nativePromptArguments(impossibleRequest), {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: Object.fromEntries(
        ['SystemRoot', 'WINDIR', 'TEMP', 'TMP'].flatMap((name) =>
          typeof process.env[name] === 'string' ? [[name, process.env[name]]] : []
        )
      )
    });
    const outcome = await captureExactChildOutput(child);
    assert.equal(outcome.code, 9);
    assert.equal(outcome.signal, null);
    assert.equal(outcome.stderr, '');
    const lines = outcome.stdout.trim().split(/\r?\n/u);
    assert.equal(lines.length, 1);
    const failure = JSON.parse(lines[0]);
    assert.deepEqual(validateNativePromptFailure(failure, impossibleRequest, child.pid, 'before_ready'), failure);
    assert.equal(failure.stage, 'target_process_identity');
    assert.equal(Object.hasOwn(failure, 'error'), false);
  }
);

test('native helper file identity remains exact above Number.MAX_SAFE_INTEGER and every stat route requests bigint', async () => {
  const unsafeBoundary = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  const adjacentIdentity = unsafeBoundary + 1n;
  assert.equal(Number(unsafeBoundary), Number(adjacentIdentity));

  const original = syntheticExactFileStat({ dev: unsafeBoundary, ino: unsafeBoundary });
  const differentInode = syntheticExactFileStat({ dev: unsafeBoundary, ino: adjacentIdentity });
  const differentDevice = syntheticExactFileStat({ dev: adjacentIdentity, ino: unsafeBoundary });
  assert.equal(sameNativeFileIdentity(original, differentInode), false);
  assert.equal(sameNativeFileIdentity(original, differentDevice), false);

  const pathCalls = [];
  assert.equal(
    await exactNativePathStat('native-owned-path', async (...args) => {
      pathCalls.push(args);
      return original;
    }),
    original
  );
  assert.deepEqual(pathCalls, [['native-owned-path', { bigint: true }]]);

  const handleCalls = [];
  assert.equal(
    await exactNativeHandleStat({
      stat: async (options) => {
        handleCalls.push(options);
        return original;
      }
    }),
    original
  );
  assert.deepEqual(handleCalls, [{ bigint: true }]);

  const source = await readFile(new URL('./native-permission-dialog.mjs', import.meta.url), 'utf8');
  assert.equal(source.match(/\bexactNativePathStat\(/gu)?.length, 2);
  assert.equal(source.match(/\bexactNativeHandleStat\(/gu)?.length, 3);
  assert.equal(source.match(/\bhandle\.stat\(/gu)?.length, 1);
  assert.equal(source.match(/\bnativeLstat\(/gu), null);
});

test('only pinned Windows PowerShell may use a stable nonzero hard-link count', async () => {
  const singleLink = syntheticExactFileStat();
  const twoLinks = syntheticExactFileStat({ nlink: 2n });
  assert.equal(hasApprovedNativeFileLinkCount(singleLink), true);
  assert.equal(hasApprovedNativeFileLinkCount(twoLinks), false);
  assert.equal(hasApprovedNativeFileLinkCount(twoLinks, { allowWindowsSystemPowerShellHardLinks: true }), true);
  assert.equal(
    hasApprovedNativeFileLinkCount(syntheticExactFileStat({ nlink: 0n }), {
      allowWindowsSystemPowerShellHardLinks: true
    }),
    false
  );
  assert.equal(hasApprovedNativeFileLinkCount({ nlink: 2 }), false);
  assert.equal(sameNativeFileIdentity(twoLinks, syntheticExactFileStat({ nlink: 3n })), false);

  const sourceContracts = [
    {
      path: new URL('./native-permission-dialog.mjs', import.meta.url),
      defaultOnly: /exactFileIdentity\(exact\.expectedProcessPath, 'Pinned browser executable'\);/u
    },
    {
      path: new URL('./unattended-coordinator.mjs', import.meta.url),
      defaultOnly: /exactFileIdentity\(pin\.executablePath, `Pinned \$\{pin\.name\} executable`\)/u
    },
    {
      path: new URL('./runtime-executor.mjs', import.meta.url),
      defaultOnly: /exactFileIdentity\(browserPin\.executablePath, `Pinned \$\{browserName\} executable`\)/u
    }
  ];
  for (const contract of sourceContracts) {
    const source = await readFile(contract.path, 'utf8');
    assert.equal(source.match(/allowWindowsSystemPowerShellHardLinks:\s*true/gu)?.length, 1, contract.path.href);
    assert.match(
      source,
      /exactFileIdentity\([^;]*'Pinned Windows PowerShell'[^;]*allowWindowsSystemPowerShellHardLinks:\s*true[^;]*\);/su,
      contract.path.href
    );
    assert.match(source, /allowWindowsSystemPowerShellHardLinks\s*=\s*false/u, contract.path.href);
    assert.match(source, contract.defaultOnly, contract.path.href);
  }
});

test('native helper lifecycle terminates only its exact child, waits for close, and is single use', async () => {
  const child = fakeChild();
  const lifecycle = createNativePromptHelperLifecycle(child, request);
  const settlement = await lifecycle.cancelAndWait();
  assert.deepEqual(child.killSignals, ['SIGTERM']);
  assert.deepEqual(settlement, {
    schema: 'sitewipe.native-permission-helper-settlement.v1',
    processId: child.pid,
    status: 'terminated_and_settled'
  });
  await assert.rejects(lifecycle.cancelAndWait(), /already settled or cancelled/i);
  await assert.rejects(lifecycle.settle(), /already settled or cancelled/i);
});

test('native helper lifecycle caps both output channels and terminates the exact noisy child once', async () => {
  const child = fakeChild();
  const lifecycle = createNativePromptHelperLifecycle(child, request);
  child.stdout.write('x'.repeat(NATIVE_PROMPT_MAX_OUTPUT_BYTES + 1));
  child.stderr.write('y'.repeat(NATIVE_PROMPT_MAX_OUTPUT_BYTES + 1));
  await assert.rejects(lifecycle.settle(), /stdout exceeded its fixed byte limit/i);
  assert.deepEqual(child.killSignals, ['SIGTERM']);
});

test('native helper lifecycle settles exact evidence without terminating an exited child', async () => {
  const child = fakeChild();
  const exact = validateNativePromptRequest(request);
  const lifecycle = createNativePromptHelperLifecycle(child, request);
  child.stdout.end(`${JSON.stringify(validReadiness(exact, child.pid))}\n${JSON.stringify(validEvidence(exact))}\n`);
  child.emit('close', 0, null);
  const evidence = await lifecycle.settle();
  assert.equal(evidence.status, 'invoked');
  assert.deepEqual(child.killSignals, []);
});

test('native helper lifecycle rejects a bounded pre-readiness failure without exposing raw text', async () => {
  const child = fakeChild({ closeOnKill: false });
  const exact = validateNativePromptRequest(observeRequest);
  const lifecycle = createNativePromptHelperLifecycle(child, observeRequest);
  const failure = validFailure(exact, child.pid, 'request_policy', 'before_ready');
  const readiness = lifecycle.waitUntilReady();
  child.stdout.write(`${JSON.stringify(failure)}\n`);
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  assert.deepEqual(child.killSignals, ['SIGTERM']);
  child.emit('close', null, 'SIGTERM');
  await assert.rejects(readiness, (error) => {
    assert.equal(error.code, 'SITEWIPE_NATIVE_PROMPT_HELPER_FAILURE');
    assert.equal(error.phase, 'before_ready');
    assert.equal(error.stage, 'request_policy');
    assert.match(error.message, /fixed before_ready\/request_policy stage/);
    assert.doesNotMatch(error.message, /private sentinel|C:\\/i);
    return true;
  });
});

test('native helper failure contract rejects unknown stages, wrong bindings, and raw-message fields', () => {
  const exact = validateNativePromptRequest(observeRequest);
  const valid = validFailure(exact, 9123, 'request_policy', 'before_ready');
  assert.deepEqual(validateNativePromptFailure(valid, observeRequest, 9123, 'before_ready'), valid);
  for (const candidate of [
    { ...valid, stage: 'arbitrary_private_stage' },
    { ...valid, helperProcessId: 9124 },
    { ...valid, scheduleId: 'SMOKE-01.observe-none' },
    { ...valid, phase: 'after_ready' },
    { ...valid, error: 'private sentinel C:\\not-for-output' }
  ]) {
    assert.throws(
      () => validateNativePromptFailure(candidate, observeRequest, 9123, 'before_ready'),
      /keys differ|differs from the exact request/
    );
  }
  for (const [candidate, expectedPhase] of [
    [validFailure(exact, 9123, 'runtime_observation', 'before_ready'), 'before_ready'],
    [validFailure(exact, 9123, 'request_policy', 'after_ready'), 'after_ready']
  ]) {
    assert.throws(
      () => validateNativePromptFailure(candidate, observeRequest, 9123, expectedPhase),
      /differs from the exact request/
    );
  }
});

test('native helper lifecycle rejects malformed failure records without reflecting raw fields', async () => {
  const child = fakeChild({ closeOnKill: false });
  const exact = validateNativePromptRequest(observeRequest);
  const lifecycle = createNativePromptHelperLifecycle(child, observeRequest);
  const readiness = lifecycle.waitUntilReady();
  child.stdout.write(
    `${JSON.stringify({
      ...validFailure(exact, child.pid, 'request_policy', 'before_ready'),
      error: 'private sentinel C:\\must-not-be-reflected'
    })}\n`
  );
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  assert.deepEqual(child.killSignals, ['SIGTERM']);
  child.emit('close', null, 'SIGTERM');
  await assert.rejects(readiness, (error) => {
    assert.match(error.message, /malformed protocol record/);
    assert.doesNotMatch(`${error.message}\n${error.cause?.message || ''}`, /private sentinel|must-not-be-reflected/i);
    return true;
  });
});

test('native helper lifecycle reports a bounded post-readiness failure without reflecting raw text', async () => {
  const child = fakeChild({ closeOnKill: false });
  const exact = validateNativePromptRequest(request);
  const lifecycle = createNativePromptHelperLifecycle(child, request);
  child.stdout.write(`${JSON.stringify(validReadiness(exact, child.pid))}\n`);
  await lifecycle.waitUntilReady();
  const settlement = lifecycle.settle();
  child.stdout.write(`${JSON.stringify(validFailure(exact, child.pid, 'runtime_observation', 'after_ready'))}\n`);
  child.emit('close', 9, null);
  await assert.rejects(settlement, (error) => {
    assert.equal(error.code, 'SITEWIPE_NATIVE_PROMPT_HELPER_FAILURE');
    assert.equal(error.phase, 'after_ready');
    assert.equal(error.stage, 'runtime_observation');
    assert.doesNotMatch(error.message, /private sentinel|C:\\/i);
    return true;
  });
  assert.deepEqual(child.killSignals, []);
});

test('native helper lifecycle does not treat an error event as process termination', async () => {
  const child = fakeChild({ closeOnKill: false });
  const lifecycle = createNativePromptHelperLifecycle(child, request);
  let settled = false;
  const settlement = lifecycle.settle().finally(() => {
    settled = true;
  });
  child.emit('error', new Error('synthetic child runtime error'));
  await new Promise((resolveTurn) => setImmediate(resolveTurn));
  assert.equal(settled, false);
  assert.deepEqual(child.killSignals, ['SIGTERM']);
  child.emit('close', null, 'SIGTERM');
  await assert.rejects(settlement, /synthetic child runtime error/);
});

test('native no-prompt lifecycle proves readiness before controlled stop and final observation', async () => {
  const child = fakeChild({ closeOnKill: false });
  const exact = validateNativePromptRequest(observeRequest);
  const lifecycle = createNativePromptHelperLifecycle(child, observeRequest);
  child.stdout.write(`${JSON.stringify(validReadiness(exact, child.pid))}\n`);
  const readiness = await lifecycle.waitUntilReady();
  assert.equal(readiness.status, 'ready');
  assert.deepEqual(validateNativePromptReadiness(readiness, observeRequest, child.pid), readiness);
  const controlReceived = new Promise((resolveControl) => {
    child.stdin.once('data', (chunk) => {
      const control = JSON.parse(String(chunk).trim());
      resolveControl(control);
      child.stdout.write(`${JSON.stringify(validNoPromptEvidence(exact, readiness.readyAt))}\n`);
      child.emit('close', 0, null);
    });
  });
  const settlement = lifecycle.settle();
  assert.deepEqual(await controlReceived, {
    schema: 'sitewipe.native-permission-helper-control.v1',
    command: 'stop-observation',
    scheduleId: 'SETTINGS-01.observe-none'
  });
  assert.equal((await settlement).status, 'no_prompt_observed');
  assert.deepEqual(child.killSignals, []);
});

test('native no-prompt hard-watchdog outcome fails closed after exact readiness', async () => {
  const child = fakeChild({ closeOnKill: false });
  const exact = validateNativePromptRequest(observeRequest);
  const lifecycle = createNativePromptHelperLifecycle(child, observeRequest);
  child.stdout.write(`${JSON.stringify(validReadiness(exact, child.pid))}\n`);
  child.stdin.once('data', () => {
    child.stdout.write(
      `${JSON.stringify({
        ...validNoPromptEvidence(exact, '2026-08-24T21:59:59.000Z'),
        status: 'observation_watchdog_expired'
      })}\n`
    );
    child.emit('close', 10, null);
  });
  await assert.rejects(lifecycle.settle(), /incomplete or differs from the exact request/i);
  assert.deepEqual(child.killSignals, []);
});

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

function fakeChild({ closeOnKill = true } = {}) {
  const child = new EventEmitter();
  child.pid = 9123;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killSignals = [];
  child.kill = (signal) => {
    child.killSignals.push(signal);
    if (closeOnKill) queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  return child;
}

function captureExactChildOutput(child) {
  return new Promise((resolveOutcome, rejectOutcome) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let settlementTimeout = null;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (settlementTimeout !== null) clearTimeout(settlementTimeout);
      callback();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      settlementTimeout = setTimeout(() => {
        finish(() =>
          rejectOutcome(
            new Error('Pinned Windows PowerShell helper did not settle within the exact post-timeout grace period.')
          )
        );
      }, NATIVE_PROMPT_PROCESS_SETTLE_GRACE_MS);
      settlementTimeout.unref();
      child.kill('SIGTERM');
    }, 15_000);
    timeout.unref();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (Buffer.byteLength(stdout, 'utf8') > NATIVE_PROMPT_MAX_OUTPUT_BYTES) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (Buffer.byteLength(stderr, 'utf8') > NATIVE_PROMPT_MAX_OUTPUT_BYTES) child.kill('SIGTERM');
    });
    child.once('error', (error) => {
      if (!timedOut) finish(() => rejectOutcome(error));
    });
    child.once('close', (code, signal) => {
      if (timedOut) {
        finish(() =>
          rejectOutcome(new Error('Pinned Windows PowerShell helper exceeded 15 seconds and then settled.'))
        );
        return;
      }
      finish(() => resolveOutcome({ code, signal, stdout, stderr }));
    });
  });
}

function validEvidence(exact) {
  return {
    schema: 'sitewipe.native-permission-dialog-evidence.v1',
    status: 'invoked',
    scheduleId: exact.scheduleId,
    scenarioId: exact.scenarioId,
    browserName: exact.browserName,
    browserVersion: exact.browserVersion,
    action: exact.action,
    actionControlName: exact.expectedActionControlName,
    targetProcess: {
      processId: exact.targetProcessId,
      path: exact.expectedProcessPath,
      sha256: exact.expectedProcessSha256,
      startTimeUtcTicks: exact.expectedProcessStartTimeUtcTicks
    },
    dialogTitle: exact.expectedDialogTitle,
    permissionPatterns: [...exact.permissionPatterns],
    expectedFragments: [...exact.expectedFragments],
    observedNames: [...exact.expectedUiaNames],
    observedAt: '2026-08-24T22:00:00.000Z'
  };
}

function validReadiness(exact, helperProcessId) {
  return {
    schema: 'sitewipe.native-permission-helper-ready.v1',
    status: 'ready',
    scheduleId: exact.scheduleId,
    scenarioId: exact.scenarioId,
    browserName: exact.browserName,
    browserVersion: exact.browserVersion,
    action: exact.action,
    helperProcessId,
    targetProcess: {
      processId: exact.targetProcessId,
      path: exact.expectedProcessPath,
      sha256: exact.expectedProcessSha256,
      startTimeUtcTicks: exact.expectedProcessStartTimeUtcTicks
    },
    readyAt: '2026-08-24T21:59:59.000Z'
  };
}

function validFailure(exact, helperProcessId, stage, phase) {
  return {
    schema: 'sitewipe.native-permission-helper-failure.v1',
    status: 'failed',
    phase,
    stage,
    scheduleId: exact.scheduleId,
    browserName: exact.browserName,
    action: exact.action,
    helperProcessId,
    targetProcessId: exact.targetProcessId
  };
}

function validNoPromptEvidence(exact, observationStartedAt) {
  return {
    schema: 'sitewipe.native-permission-dialog-evidence.v1',
    status: 'no_prompt_observed',
    scheduleId: exact.scheduleId,
    scenarioId: exact.scenarioId,
    browserName: exact.browserName,
    browserVersion: exact.browserVersion,
    action: exact.action,
    targetProcess: {
      processId: exact.targetProcessId,
      path: exact.expectedProcessPath,
      sha256: exact.expectedProcessSha256,
      startTimeUtcTicks: exact.expectedProcessStartTimeUtcTicks
    },
    dialogTitle: exact.expectedDialogTitle,
    permissionPatterns: [...exact.permissionPatterns],
    expectedFragments: [...exact.expectedFragments],
    observedNames: [],
    observationStartedAt,
    stopRequestedAt: '2026-08-24T22:00:00.000Z',
    observedAt: '2026-08-24T22:00:00.001Z'
  };
}

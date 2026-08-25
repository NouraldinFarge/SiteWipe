import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  NATIVE_PROMPT_ALLOWED_ACTIONS,
  NATIVE_PROMPT_EXPECTED_FRAGMENTS,
  NATIVE_PROMPT_HELPER_PATH,
  NATIVE_PROMPT_HELPER_SHA256,
  NATIVE_PROMPT_PERMISSION_PATTERNS,
  NATIVE_PROMPT_SCENARIO_SCHEDULE,
  NATIVE_PROMPT_UIA_SNAPSHOTS,
  nativePromptArguments,
  validateNativePromptEvidence,
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
    ['SMOKE-01.observe-none', 'PERM-01.allow', 'PERM-01.deny', 'PERM-01.dismiss', 'PERM-01.timeout-late-allow']
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
  assert.doesNotMatch(source, /SendKeys|SetCursorPos|mouse_event|keybd_event|Clipboard|WScript\.Shell/i);
});

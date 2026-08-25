import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
export const NATIVE_PROMPT_POLICY_PATH = resolve(directory, 'native-permission-policy.json');
export const NATIVE_PROMPT_HELPER_PATH = resolve(directory, 'windows-permission-dialog.ps1');

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
    timeoutSeconds: 20,
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
  if (!win32.isAbsolute(String(expectedProcessPath || '')) || !isSha256(expectedProcessSha256)) {
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
  const powerShell = await exactFileIdentity(policy.powershell.path, 'Pinned Windows PowerShell');
  if (powerShell.sha256 !== policy.powershell.sha256) {
    throw new Error('Pinned Windows PowerShell bytes differ from native prompt policy.');
  }
  const args = nativePromptArgumentsFromExact(exact);
  if (args.includes('-ExecutionPolicy')) throw new Error('Native prompt helper may not bypass PowerShell policy.');
  const child = spawn(powerShell.path, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: minimalWindowsEnvironment()
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const result = new Promise((resolveResult, rejectResult) => {
    child.once('error', rejectResult);
    child.once('close', (code, signal) => {
      let evidence;
      try {
        evidence = JSON.parse(stdout.trim());
      } catch (error) {
        rejectResult(new Error(`Native prompt helper returned unreadable evidence: ${stderr || error.message}`));
        return;
      }
      try {
        validateNativePromptEvidence(evidence, exact, { code, signal });
        resolveResult(evidence);
      } catch (error) {
        rejectResult(Object.assign(error, { nativePromptEvidence: evidence, stderr }));
      }
    });
  });
  void result.catch(() => undefined);
  return Object.freeze({ child, result, powerShell, helperSha256: NATIVE_PROMPT_HELPER_SHA256 });
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
    Number.isNaN(Date.parse(String(evidence?.observedAt || '')))
  ) {
    throw new Error('Native prompt helper evidence is incomplete or differs from the exact request.');
  }
  if (exact.action !== 'observe-none' && evidence.actionControlName !== exact.expectedActionControlName) {
    throw new Error('Native prompt helper invoked a different action control.');
  }
  return evidence;
}

async function readExactFile(path, label) {
  const identity = await exactFileIdentity(path, label);
  return identity.bytes;
}

async function exactFileIdentity(path, label) {
  const expected = resolve(path);
  const before = await lstat(expected);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} must be a regular non-reparse file.`);
  const actual = await realpath(expected);
  if (!sameHostPath(actual, expected)) throw new Error(`${label} path is aliased.`);
  const handle = await open(actual, 'r');
  try {
    const opened = await handle.stat();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameFileIdentity(before, opened) || !sameFileIdentity(opened, after) || after.size !== bytes.length) {
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
    !win32.isAbsolute(String(value?.powershell?.path || '')) ||
    !isSha256(value?.powershell?.sha256) ||
    value?.constraints?.exactProcessIdentity !== true ||
    value?.constraints?.exactlyOneDialog !== true ||
    value?.constraints?.exactlyOneActionControl !== true ||
    value?.constraints?.coordinatesAllowed !== false ||
    value?.constraints?.globalInputAllowed !== false ||
    value?.constraints?.requiresUnlockedInteractiveSession !== true ||
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

function sameFileIdentity(left, right) {
  if (!left || !right || left.dev !== right.dev || left.ino !== right.ino || left.size !== right.size) return false;
  return left.ino !== 0 || left.birthtimeMs === right.birthtimeMs;
}

function sameWindowsPath(left, right) {
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

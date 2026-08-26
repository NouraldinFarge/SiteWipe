import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createWriteStream } from 'node:fs';
import { access, chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import yazl from 'yazl';

import { RUNTIME_FILES } from '../../../scripts/release-files.mjs';
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
  SCENARIO_RESULT_SCHEMA,
  aggregateBrowserEvidence,
  canonicalJsonBytes,
  computePlanSha256,
  createScenarioResultRecord,
  validateBrowserPlan
} from './evidence-contract.mjs';
import {
  NATIVE_PROMPT_ALLOWED_ACTIONS,
  NATIVE_PROMPT_EXPECTED_FRAGMENTS,
  NATIVE_PROMPT_PERMISSION_PATTERNS,
  NATIVE_PROMPT_POLICY_SHA256,
  NATIVE_PROMPT_SCENARIO_SCHEDULE,
  NATIVE_PROMPT_UIA_SNAPSHOTS
} from './native-permission-dialog.mjs';
import { SEMANTIC_VALIDATOR_MANIFEST_SHA256 } from './semantic-validator.mjs';
import { computeBrowserRuntimeSetSha256 } from './browser-runtime-closure.mjs';
import { INSTALLED_RUNTIME_LAUNCH_POLICY_SHA256 } from './launch-policy.mjs';
import {
  captureInstalledBrowserToolchainClosure,
  installedBrowserToolchainClosureSummary
} from './toolchain-closure.mjs';
import {
  INSTALLED_RUNTIME_LAUNCH_POLICY,
  INSTALLED_RUNTIME_CLOSE_POLICY_BOUND_MS,
  LOOPBACK_HOST_RESOLVER_RULES,
  RUNTIME_EXECUTOR_TEST_SUPPORT,
  RUNTIME_NETWORK_ALLOWLIST,
  WINDOWS_PROCESS_IDENTITY_HELPER_PATH,
  assertSyntheticFixturePageUrl,
  completeOwnedBrowserRunWithAggregate,
  revalidateApprovedInstalledBrowserToolchain,
  stageOwnedBrowserCell,
  stageVerifiedRuntimeArtifact,
  validateWindowsProcessIdentityObservation,
  validateWindowsProcessTerminationObservation,
  validateWindowsProfileResidueObservation,
  verifyInstalledSiteWipeExtension,
  writeCanonicalBrowserAggregate
} from './runtime-executor.mjs';

const timestamp = '2026-08-25T15:00:00.000Z';
const browserSha256 = 'B6D40F55E48E61760335D18F46ABCEC929E1A11B8330E7F2B501037584AF4AA4';
const execFileAsync = promisify(execFile);

test('exact approved runtime ZIP is extracted into the owned run with an independently hashed receipt', async (t) => {
  const fixture = await runtimeFixture(t);
  const staged = await stageVerifiedRuntimeArtifact({ plan: fixture.plan, runRoot: fixture.runRoot });
  assert.equal(staged.schema, 'sitewipe.staged-runtime-artifact.v1');
  assert.equal(staged.fileCount, RUNTIME_FILES.length);
  assert.equal(staged.artifactSha256, fixture.plan.identity.artifactSha256);
  assert.equal(staged.manifest.name, 'SiteWipe');
  assert.equal(staged.manifest.version, fixture.plan.identity.artifactVersion);
  assert.equal(staged.semanticValidationStatus, 'partial');
  assert.deepEqual(await listFiles(staged.extensionRoot), RUNTIME_FILES);
  assert.deepEqual(
    staged.files.map(({ path }) => path),
    RUNTIME_FILES
  );
  const receiptBytes = await readFile(resolve(fixture.runRoot, 'runtime-artifact.json'));
  const receipt = JSON.parse(receiptBytes.toString('utf8'));
  assert.equal(receiptBytes.equals(canonicalJsonBytes(receipt)), true);
  assert.equal(receipt.contentSetSha256, staged.contentSetSha256);
  await assert.rejects(
    stageVerifiedRuntimeArtifact({ plan: fixture.plan, runRoot: fixture.runRoot }),
    /EEXIST|already exists/i
  );
});

test('runtime ZIP extraction rejects traversal before creating any output directory', async (t) => {
  const fixture = await runtimeFixture(t, { mutateArchive: mutateManifestPathToTraversal });
  await assert.rejects(
    stageVerifiedRuntimeArtifact({ plan: fixture.plan, runRoot: fixture.runRoot }),
    /invalid relative path|invalid characters|invalid filename|path is unsafe/i
  );
  await assert.rejects(access(resolve(fixture.runRoot, 'runtime-extension')));
});

test('runtime ZIP extraction rejects duplicate paths and Windows-colliding aliases', async (t) => {
  const duplicate = await runtimeFixture(t, { duplicatePath: 'manifest.json' });
  await assert.rejects(
    stageVerifiedRuntimeArtifact({ plan: duplicate.plan, runRoot: duplicate.runRoot }),
    /duplicate|path set/i
  );
  await assert.rejects(access(resolve(duplicate.runRoot, 'runtime-extension')));

  const collision = await runtimeFixture(t, {
    extraEntry: { path: 'MANIFEST.JSON', bytes: runtimeManifestBytes(), mode: 0o100644 }
  });
  await assert.rejects(
    stageVerifiedRuntimeArtifact({ plan: collision.plan, runRoot: collision.runRoot }),
    /duplicate or Windows-colliding/i
  );
});

test('runtime ZIP extraction rejects symlink metadata and pre-existing output', async (t) => {
  const linked = await runtimeFixture(t, { modeMutationPath: RUNTIME_FILES[0] });
  await assert.rejects(
    stageVerifiedRuntimeArtifact({ plan: linked.plan, runRoot: linked.runRoot }),
    /link, directory, device|unexpected mode/i
  );
  await assert.rejects(access(resolve(linked.runRoot, 'runtime-extension')));

  const prepopulated = await runtimeFixture(t);
  const runtimeRoot = resolve(prepopulated.runRoot, 'runtime-extension');
  await mkdir(runtimeRoot);
  await writeFile(resolve(runtimeRoot, 'foreign.txt'), 'must not be overwritten\n');
  await assert.rejects(
    stageVerifiedRuntimeArtifact({ plan: prepopulated.plan, runRoot: prepopulated.runRoot }),
    /EEXIST|already exists/i
  );
  assert.equal(await readFile(resolve(runtimeRoot, 'foreign.txt'), 'utf8'), 'must not be overwritten\n');
});

test('browser-cell staging is deterministic, marked, canary-protected, and single-use', async (t) => {
  const fixture = await runtimeFixture(t);
  const cell = await stageOwnedBrowserCell({
    plan: fixture.plan,
    runRoot: fixture.runRoot,
    browserName: 'chrome',
    scenarioId: 'SMOKE-01'
  });
  assert.equal(cell.browserName, 'chrome');
  assert.equal(cell.scenarioId, 'SMOKE-01');
  assert.match(cell.canarySha256, /^[A-F0-9]{64}$/u);
  assert.equal((await readFile(cell.canaryPath)).length, 32);
  assert.deepEqual((await readdir(cell.profilePath)).sort(), ['.sitewipe-owned-browser-directory.json']);
  assert.deepEqual((await readdir(cell.downloadPath)).sort(), [
    '.sitewipe-must-preserve-download.bin',
    '.sitewipe-owned-browser-directory.json'
  ]);
  await assert.rejects(
    stageOwnedBrowserCell({
      plan: fixture.plan,
      runRoot: fixture.runRoot,
      browserName: 'chrome',
      scenarioId: 'SMOKE-01'
    }),
    /EEXIST|already exists/i
  );
  await assert.rejects(
    stageOwnedBrowserCell({
      plan: fixture.plan,
      runRoot: fixture.runRoot,
      browserName: 'chrome',
      scenarioId: 'INVENTED-01'
    }),
    /outside the exact canonical matrix/
  );
});

test('headful pipe policy is fixed to disposable paths, loopback fixtures, and no incognito or remote port', () => {
  assert.equal(INSTALLED_RUNTIME_LAUNCH_POLICY.headless, false);
  assert.equal(INSTALLED_RUNTIME_LAUNCH_POLICY.pipe, true);
  assert.equal(INSTALLED_RUNTIME_LAUNCH_POLICY.remoteDebuggingPort, null);
  assert.equal(INSTALLED_RUNTIME_LAUNCH_POLICY.attachToExistingBrowser, false);
  assert.equal(INSTALLED_RUNTIME_LAUNCH_POLICY.existingProfile, false);
  assert.equal(INSTALLED_RUNTIME_LAUNCH_POLICY.incognitoExtensionAccess, false);
  assert.equal(INSTALLED_RUNTIME_LAUNCH_POLICY.window.maximized, false);
  assert.equal(INSTALLED_RUNTIME_LAUNCH_POLICY.downloads.automaticDeletion, false);
  assert.equal(INSTALLED_RUNTIME_LAUNCH_POLICY.unsupportedSemanticsRemainNotRun, true);
  for (const host of SYNTHETIC_FIXTURE_HOSTS.filter((host) => !['127.0.0.1', '::1', 'localhost'].includes(host))) {
    assert.match(LOOPBACK_HOST_RESOLVER_RULES, new RegExp(`MAP ${escapeRegExp(host)} 127\\.0\\.0\\.1`, 'u'));
  }
  assert.match(LOOPBACK_HOST_RESOLVER_RULES, /EXCLUDE localhost/u);
  assert.doesNotMatch(LOOPBACK_HOST_RESOLVER_RULES, /0\.0\.0\.0|evil\.invalid(?!,| )/u);
  assert.equal(RUNTIME_NETWORK_ALLOWLIST.includes('chrome-extension://*/*'), true);
  assert.equal(
    RUNTIME_NETWORK_ALLOWLIST.some((value) => value.includes('https://')),
    false
  );
  assert.equal(
    RUNTIME_NETWORK_ALLOWLIST.some((value) => value.includes('evil.invalid')),
    true
  );
  assert.equal(
    RUNTIME_NETWORK_ALLOWLIST.includes('http://selected.example.com.evil.invalid:*/*'),
    true,
    'the intentionally allowed lookalike control is loopback-confined'
  );
  assert.equal(Object.isFrozen(INSTALLED_RUNTIME_LAUNCH_POLICY), true);
  assert.equal(Object.isFrozen(INSTALLED_RUNTIME_LAUNCH_POLICY.window), true);
});

test('installed extension verification requires one exact enabled SiteWipe record', async () => {
  const extensionPath = resolve(tmpdir(), 'sitewipe-runtime-extension');
  const extension = {
    id: 'a'.repeat(32),
    name: 'SiteWipe',
    version: '9.9.9',
    enabled: true,
    path: extensionPath,
    triggerAction() {}
  };
  const browser = { extensions: async () => new Map([[extension.id, extension]]) };
  assert.equal(await verifyInstalledSiteWipeExtension(browser, { expectedVersion: '9.9.9', extensionPath }), extension);
  await assert.rejects(
    verifyInstalledSiteWipeExtension(
      { extensions: async () => new Map([[extension.id, { ...extension, name: 'Foreign' }]]) },
      { expectedVersion: '9.9.9', extensionPath }
    ),
    /identity differs/
  );
  await assert.rejects(
    verifyInstalledSiteWipeExtension(
      {
        extensions: async () =>
          new Map([
            [extension.id, extension],
            ['b'.repeat(32), { ...extension, id: 'b'.repeat(32) }]
          ])
      },
      { expectedVersion: '9.9.9', extensionPath }
    ),
    /exactly one/
  );
});

test('authentic action targets are restricted to the exact synthetic HTTP fixtures', () => {
  assert.equal(
    assertSyntheticFixturePageUrl('http://selected.example.com:43819/?scale=small').hostname,
    'selected.example.com'
  );
  assert.equal(assertSyntheticFixturePageUrl('http://[::1]:43819/').hostname, '[::1]');
  for (const value of [
    'https://selected.example.com:43819/',
    'http://example.com:43819/',
    'http://selected.example.com.evil.invalid.attacker.test/',
    'http://user@selected.example.com:43819/',
    'file:///C:/fixture.html',
    'not a URL'
  ]) {
    assert.throws(() => assertSyntheticFixturePageUrl(value), /synthetic|valid/);
  }
  assert.throws(
    () => assertSyntheticFixturePageUrl('http://selected.example.com/', ['selected.example.com']),
    /differ from the exact fixture policy/
  );
});

test('Windows process observations are exact, bounded, sorted, and contain no raw command line', () => {
  const identityRequest = {
    processId: 4242,
    expectedProcessPath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    expectedProcessSha256: browserSha256,
    expectedProfilePath: 'D:\\SiteWipe Runs\\profile'
  };
  const identity = {
    schema: 'sitewipe.windows-process-observation.v1',
    mode: 'identity',
    targetProcess: {
      processId: 4242,
      parentProcessId: 100,
      path: identityRequest.expectedProcessPath,
      sha256: browserSha256,
      startTimeUtcTicks: '638917729350000000',
      profilePath: identityRequest.expectedProfilePath,
      commandLineSha256: 'A'.repeat(64)
    },
    observedAt: timestamp
  };
  assert.equal(validateWindowsProcessIdentityObservation(identity, identityRequest), identity);
  assert.throws(
    () =>
      validateWindowsProcessIdentityObservation(
        { ...identity, targetProcess: { ...identity.targetProcess, profilePath: 'C:\\Users\\Normal' } },
        identityRequest
      ),
    /differs/
  );

  const residueRequest = {
    ...identityRequest,
    expectedProcessStartTimeUtcTicks: identity.targetProcess.startTimeUtcTicks
  };
  const residue = {
    schema: 'sitewipe.windows-process-observation.v1',
    mode: 'profile-residue',
    rootIdentity: {
      processId: 4242,
      path: identityRequest.expectedProcessPath,
      sha256: browserSha256,
      startTimeUtcTicks: identity.targetProcess.startTimeUtcTicks,
      present: true
    },
    profilePath: identityRequest.expectedProfilePath,
    residues: [
      {
        processId: 4242,
        parentProcessId: 100,
        path: identityRequest.expectedProcessPath,
        sha256: browserSha256,
        startTimeUtcTicks: identity.targetProcess.startTimeUtcTicks,
        commandLineSha256: 'B'.repeat(64),
        matchedBy: ['process-tree', 'profile-argument']
      }
    ],
    observedAt: timestamp
  };
  assert.equal(validateWindowsProfileResidueObservation(residue, residueRequest), residue);
  assert.equal(JSON.stringify(residue).includes('--user-data-dir'), false);
  assert.throws(
    () =>
      validateWindowsProfileResidueObservation(
        { ...residue, residues: [{ ...residue.residues[0], matchedBy: ['profile-argument', 'process-tree'] }] },
        residueRequest
      ),
    /malformed, duplicated/
  );
  assert.throws(
    () => validateWindowsProfileResidueObservation({ ...residue, residues: [] }, residueRequest),
    /omitted the still-present/
  );

  const termination = {
    schema: 'sitewipe.windows-process-termination.v1',
    mode: 'terminate-tree',
    rootIdentity: { ...residue.rootIdentity },
    terminatedProcesses: [
      {
        processId: 4343,
        parentProcessId: 4242,
        depth: 1,
        path: identityRequest.expectedProcessPath,
        sha256: browserSha256,
        startTimeUtcTicks: '638917729350000001'
      },
      {
        processId: 4242,
        parentProcessId: 100,
        depth: 0,
        path: identityRequest.expectedProcessPath,
        sha256: browserSha256,
        startTimeUtcTicks: identity.targetProcess.startTimeUtcTicks
      }
    ],
    observedAt: timestamp
  };
  assert.equal(validateWindowsProcessTerminationObservation(termination, residueRequest), termination);
  assert.throws(
    () =>
      validateWindowsProcessTerminationObservation(
        {
          ...termination,
          terminatedProcesses: [...termination.terminatedProcesses].reverse()
        },
        residueRequest
      ),
    /leaf-first/
  );
  assert.throws(
    () =>
      validateWindowsProcessTerminationObservation(
        {
          ...termination,
          terminatedProcesses: [{ ...termination.terminatedProcesses[0], path: 'C:\\Windows\\System32\\notepad.exe' }]
        },
        residueRequest
      ),
    /leaf-first/
  );
});

test('fixed-purpose process helper observes identity/residue and only terminates an authenticated disposable tree', async () => {
  const helper = await readFile(WINDOWS_PROCESS_IDENTITY_HELPER_PATH, 'utf8');
  assert.match(helper, /ValidateSet\('Identity', 'ProfileResidue', 'TerminateTree'\)/u);
  assert.match(helper, /CommandLineToArgvW/u);
  assert.match(helper, /DllImport\("shell32\.dll", SetLastError = true, CharSet = CharSet\.Unicode\)/u);
  assert.match(helper, /Get-CimInstance -ClassName Win32_Process/u);
  assert.match(helper, /ExpectedHelperSha256/u);
  assert.match(helper, /profile-residue/u);
  assert.match(helper, /Root browser identity or disposable-profile binding changed before tree termination/u);
  assert.match(helper, /Sort-Object -Property @\{ Expression = 'depth'; Descending = \$true \}/u);
  assert.equal(helper.match(/Stop-Process/gu)?.length, 1);
  assert.doesNotMatch(
    helper,
    /taskkill|TerminateProcess|Remove-Item|Invoke-Expression|ScriptBlock|SendKeys|SetCursorPos|mouse_event|keybd_event/iu
  );

  const runtimeSource = await readFile(new URL('./runtime-executor.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(runtimeSource, /^import .*puppeteer-core/mu);
  assert.doesNotMatch(runtimeSource, /^import .*yauzl/mu);
  assert.match(
    runtimeSource,
    /revalidateStagedInstalledBrowserToolchain\(runtime, plan\)[\s\S]*?import\(pathToFileURL\(puppeteerEntry\)\.href\)[\s\S]*?revalidateStagedInstalledBrowserToolchain\(runtime, plan\)/u
  );
  assert.match(runtimeSource, /spawn\(executable\.path, browserArguments/u);
  assert.match(runtimeSource, /options\.registerCleanup\(session\.close\)/u);
  assert.ok(
    runtimeSource.indexOf('options.registerCleanup(session.close)') <
      runtimeSource.indexOf('Direct pinned browser spawn did not expose one exact process and CDP pipe pair')
  );
  assert.match(runtimeSource, /puppeteer\.connect/u);
  assert.doesNotMatch(runtimeSource, /puppeteer\.launch/u);
  assert.match(runtimeSource, /await extension\.triggerAction\(page\)/u);
  assert.match(runtimeSource, /await popupTarget\.asPage\(\)/u);
  assert.doesNotMatch(runtimeSource, /page\.evaluate|chrome\.action\.openPopup/u);
  assert.match(runtimeSource, /browserArguments\.some\(\(value\) => value\.startsWith\('--remote-debugging-port'\)\)/u);
  assert.doesNotMatch(runtimeSource, /--no-proxy-server/u);
  assert.match(runtimeSource, /--proxy-server=http:\/\//u);
  assert.match(runtimeSource, /--proxy-bypass-list=/u);
  assert.match(runtimeSource, /--disable-quic/u);
  assert.match(runtimeSource, /automaticProfileDeletionPerformed: false/u);
  assert.match(runtimeSource, /automaticDownloadDeletionPerformed: false/u);
});

test(
  'Windows process helper flattens native argv and authenticates one quoted disposable profile argument',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const container = await mkdtemp(resolve(tmpdir(), 'sitewipe-process-helper-'));
    const profilePath = resolve(container, 'profile with spaces');
    await mkdir(profilePath);
    const child = spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1_000);', '--', `--user-data-dir=${profilePath}`],
      { stdio: 'ignore', windowsHide: true }
    );
    await new Promise((resolvePromise, rejectPromise) => {
      child.once('spawn', resolvePromise);
      child.once('error', rejectPromise);
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise((resolvePromise) => child.once('exit', resolvePromise));
      }
      await rm(container, { recursive: true, force: true });
    });

    const systemRoot = process.env.SystemRoot;
    assert.match(systemRoot, /^[A-Za-z]:[\\/]/u);
    const powershellPath = resolve(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const helperBytes = await readFile(WINDOWS_PROCESS_IDENTITY_HELPER_PATH);
    const executableBytes = await readFile(process.execPath);
    const exactArguments = [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-File',
      WINDOWS_PROCESS_IDENTITY_HELPER_PATH,
      '-Mode',
      'Identity',
      '-TargetProcessId',
      String(child.pid),
      '-ExpectedProcessPath',
      process.execPath,
      '-ExpectedProcessSha256',
      sha256(executableBytes),
      '-ExpectedProcessStartTimeUtcTicks',
      '',
      '-ExpectedProfilePath',
      profilePath,
      '-ExpectedHelperSha256',
      sha256(helperBytes)
    ];
    const { stdout } = await execFileAsync(powershellPath, exactArguments, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      timeout: 30_000,
      windowsHide: true
    });
    const observation = JSON.parse(stdout.trim());
    assert.equal(observation.mode, 'identity');
    assert.equal(observation.targetProcess.processId, child.pid);
    assert.equal(observation.targetProcess.profilePath, profilePath);
    assert.match(observation.targetProcess.commandLineSha256, /^[A-F0-9]{64}$/u);

    const mismatchedProfile = resolve(container, 'other profile');
    const refusedArguments = [...exactArguments];
    refusedArguments[refusedArguments.indexOf(profilePath)] = mismatchedProfile;
    await assert.rejects(
      execFileAsync(powershellPath, refusedArguments, {
        encoding: 'utf8',
        maxBuffer: 64 * 1024,
        timeout: 30_000,
        windowsHide: true
      }),
      /exact disposable profile/iu
    );
  }
);

test('spawn error and early-exit events are observed immediately without rejection leaks', async () => {
  const child = new EventEmitter();
  const settlement = RUNTIME_EXECUTOR_TEST_SUPPORT.observeSpawnedChildSettlement(child);
  const spawnError = new Error('synthetic spawn error');
  child.emit('error', spawnError);
  child.emit('exit', 7, null);
  assert.equal(await settlement.error, spawnError);
  assert.deepEqual(await settlement.exit, { code: 7, signal: null });
});

test('expired launch authority prevents process creation at entry and after the last asynchronous boundary', async () => {
  for (const abortAtLastBoundary of [false, true]) {
    const cancellation = new AbortController();
    let spawnCalls = 0;
    if (abortAtLastBoundary) {
      await Promise.resolve().then(() => cancellation.abort(new Error('Synthetic final pre-spawn expiry.')));
    } else {
      cancellation.abort(new Error('Synthetic entry expiry.'));
    }
    assert.throws(
      () =>
        RUNTIME_EXECUTOR_TEST_SUPPORT.spawnWithActiveAuthority(cancellation.signal, () => {
          spawnCalls += 1;
          return {};
        }),
      /launch authority is unavailable or expired/
    );
    assert.equal(spawnCalls, 0);
  }
});

test('never-settling post-spawn phases are bounded for every authenticated launch verification stage', async () => {
  for (const label of [
    'Pinned browser process observation',
    'Pinned browser version query',
    'Installed extension enumeration',
    'Post-load staged runtime replay'
  ]) {
    await assert.rejects(
      RUNTIME_EXECUTOR_TEST_SUPPORT.settlePostSpawnPhase(
        new Promise(() => {}),
        10,
        label,
        new AbortController().signal
      ),
      new RegExp(`${label} exceeded 10 ms`)
    );
  }
});

test('never-connecting and rejecting sessions force one authenticated tree cleanup and remain attention-required', async () => {
  for (const createBrowserPromise of [
    () => new Promise(() => {}),
    () => Promise.reject(new Error('synthetic connect refusal'))
  ]) {
    const harness = spawnedSessionHarness();
    harness.owner.bindBrowserPromise(createBrowserPromise());
    const receipt = await harness.owner.close();
    assert.equal(receipt.observationStatus, 'attention_required');
    assert.equal(receipt.profileProcessResidueCount, 0);
    assert.equal(receipt.mustPreserveDownloadCanary.preserved, true);
    assert.deepEqual(
      harness.events.filter((event) => event === 'terminate-tree'),
      ['terminate-tree']
    );
    assert.equal(harness.events.filter((event) => event === 'observe-residue').length, 2);
    await assert.rejects(harness.owner.close(), /single use/);
  }
});

test('hostile rejected values cannot prevent authenticated cleanup, residue replay, or canary settlement', async () => {
  const hostile = new Proxy(Object.create(null), {
    defineProperty() {
      throw new Error('defineProperty trap must not run');
    },
    get() {
      throw new Error('getter trap must not run');
    },
    getOwnPropertyDescriptor() {
      throw new Error('descriptor trap must not run');
    },
    getPrototypeOf() {
      throw new Error('prototype trap must not run');
    },
    isExtensible() {
      throw new Error('isExtensible trap must not run');
    },
    ownKeys() {
      throw new Error('ownKeys trap must not run');
    }
  });
  const harness = spawnedSessionHarness();
  harness.owner.bindBrowserPromise(Promise.reject(hostile));
  const receipt = await harness.owner.close();
  assert.equal(receipt.observationStatus, 'attention_required');
  assert.match(receipt.gracefulCloseError, /^Opaque browser-cleanup error SHA-256 [A-F0-9]{64}\.$/u);
  assert.equal(harness.events.filter((event) => event === 'terminate-tree').length, 1);
  assert.equal(harness.events.filter((event) => event === 'observe-residue').length, 2);
  assert.equal(harness.events.filter((event) => event === 'observe-canary').length, 1);
});

test('a connection resolving after cleanup refusal is centrally observed and closed once without restoring eligibility', async () => {
  let resolveBrowser;
  const browserPromise = new Promise((resolvePromise) => {
    resolveBrowser = resolvePromise;
  });
  const harness = spawnedSessionHarness();
  harness.owner.bindBrowserPromise(browserPromise);
  const receipt = await harness.owner.close();
  assert.equal(receipt.observationStatus, 'attention_required');
  resolveBrowser({ close: async () => harness.events.push('late-browser-close') });
  await delay(30);
  assert.equal(harness.events.filter((event) => event === 'late-browser-close').length, 1);
  assert.equal(harness.events.filter((event) => event === 'terminate-tree').length, 1);
});

test('session owner distinguishes its central disconnect from an earlier idempotent browser close', async () => {
  const createBrowser = () => {
    const browser = new EventEmitter();
    browser.connected = true;
    browser.close = async () => {
      if (!browser.connected) return;
      browser.connected = false;
      browser.emit('disconnected');
    };
    return browser;
  };

  {
    const harness = spawnedSessionHarness();
    const browser = createBrowser();
    harness.owner.bindBrowser(browser);
    const receipt = await harness.owner.close();
    assert.equal(receipt.observationStatus, 'clean');
    assert.equal(receipt.gracefulCloseError, null);
  }

  {
    const harness = spawnedSessionHarness();
    const browser = createBrowser();
    harness.owner.bindBrowser(browser);
    await browser.close();
    const receipt = await harness.owner.close();
    assert.equal(receipt.observationStatus, 'attention_required');
    assert.equal(receipt.gracefulCloseError, 'Browser disconnected before the runner-owned central close began.');
    assert.equal(harness.events.filter((event) => event === 'terminate-tree').length, 1);
  }
});

test('exported runtime close bound includes both possible residue observations', () => {
  assert.equal(INSTALLED_RUNTIME_CLOSE_POLICY_BOUND_MS, 170_000);
});

test('retained-handle readback deterministically consumes short reads and rejects premature EOF', async () => {
  const content = Buffer.from('exact retained bytes');
  const shortReadHandle = {
    async read(target, offset, length, position) {
      const bytesRead = Math.min(3, length, content.length - position);
      content.copy(target, offset, position, position + bytesRead);
      return { bytesRead, buffer: target };
    }
  };
  assert.deepEqual(
    await RUNTIME_EXECUTOR_TEST_SUPPORT.readExactRetainedBytes(shortReadHandle, content.length, 'Short-read fixture'),
    content
  );
  await assert.rejects(
    RUNTIME_EXECUTOR_TEST_SUPPORT.readExactRetainedBytes(
      {
        async read() {
          return { bytesRead: 0, buffer: Buffer.alloc(0) };
        }
      },
      1,
      'Premature-EOF fixture'
    ),
    /ended before its complete retained-handle readback/iu
  );
});

test('create-only retained-handle writes detect parent swaps, in-handle hardlinks, and close-to-reopen replacement', async (t) => {
  const container = await mkdtemp(resolve(tmpdir(), 'sitewipe-runtime-writer-races-'));
  t.after(() => rm(container, { recursive: true, force: true }));
  const exactHooks = (overrides = {}) => ({
    afterCloseBeforeReopen: null,
    afterParentCheckBeforeOpen: null,
    afterWriteBeforeRetainedCheck: null,
    ...overrides
  });

  await t.test('parent swap after validation and before pathname open', async () => {
    const parent = resolve(container, 'parent-swap');
    const replacement = resolve(container, 'parent-swap-replacement');
    const displaced = resolve(container, 'parent-swap-displaced');
    await Promise.all([mkdir(parent), mkdir(replacement)]);
    await assert.rejects(
      RUNTIME_EXECUTOR_TEST_SUPPORT.writeExclusiveRegularFile({
        path: resolve(parent, 'output.json'),
        bytes: Buffer.from('{}\n'),
        label: 'Parent-swap output',
        testHooks: exactHooks({
          async afterParentCheckBeforeOpen() {
            await rename(parent, displaced);
            await rename(replacement, parent);
          }
        })
      }),
      /parent.*identity|changed across retained-handle/iu
    );
  });

  await t.test('hardlink while the exact child handle is retained', async () => {
    const parent = resolve(container, 'hardlink');
    await mkdir(parent);
    const path = resolve(parent, 'output.json');
    await assert.rejects(
      RUNTIME_EXECUTOR_TEST_SUPPORT.writeExclusiveRegularFile({
        path,
        bytes: Buffer.from('{}\n'),
        label: 'Hardlink output',
        testHooks: exactHooks({
          async afterWriteBeforeRetainedCheck() {
            await link(path, resolve(parent, 'linked-output.json'));
          }
        })
      }),
      /singly linked|changed across retained-handle/iu
    );
  });

  await t.test('same-byte physical replacement after close and before reopen', async () => {
    const parent = resolve(container, 'replacement');
    await mkdir(parent);
    const path = resolve(parent, 'output.json');
    const bytes = Buffer.from('{}\n');
    await assert.rejects(
      RUNTIME_EXECUTOR_TEST_SUPPORT.writeExclusiveRegularFile({
        path,
        bytes,
        label: 'Replacement output',
        testHooks: exactHooks({
          async afterCloseBeforeReopen() {
            await rename(path, resolve(parent, 'displaced-output.json'));
            await writeFile(path, bytes, { flag: 'wx' });
          }
        })
      }),
      /identity changed immediately|changed while hashing/iu
    );
  });
});

test('all coordinator, runtime, toolchain, and CLI exact-identity helpers retain bigint-safe filesystem identities', async () => {
  const unsafeBoundary = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  const exactStat = (ino) => ({
    isDirectory: () => false,
    isFile: () => true,
    dev: unsafeBoundary,
    ino,
    mode: 0o100600n,
    nlink: 1n,
    uid: 1000n,
    gid: 1000n,
    rdev: 0n,
    size: 3n,
    blksize: 4096n,
    blocks: 1n,
    mtimeNs: unsafeBoundary + 10n,
    ctimeNs: unsafeBoundary + 11n,
    birthtimeNs: unsafeBoundary + 12n
  });
  assert.equal(
    RUNTIME_EXECUTOR_TEST_SUPPORT.sameFileIdentity(exactStat(unsafeBoundary), exactStat(unsafeBoundary)),
    true
  );
  assert.equal(
    RUNTIME_EXECUTOR_TEST_SUPPORT.sameFileIdentity(exactStat(unsafeBoundary), exactStat(unsafeBoundary + 1n)),
    false
  );
  const settledAllocation = { ...exactStat(unsafeBoundary), blocks: 2n };
  assert.equal(
    RUNTIME_EXECUTOR_TEST_SUPPORT.samePostCloseFileIdentity(exactStat(unsafeBoundary), settledAllocation, 'win32'),
    true
  );
  assert.equal(
    RUNTIME_EXECUTOR_TEST_SUPPORT.samePostCloseFileIdentity(exactStat(unsafeBoundary), settledAllocation, 'linux'),
    false
  );
  assert.equal(
    RUNTIME_EXECUTOR_TEST_SUPPORT.samePostCloseFileIdentity(
      exactStat(unsafeBoundary),
      { ...settledAllocation, ino: unsafeBoundary + 1n },
      'win32'
    ),
    false
  );
  const modules = [
    ['./unattended-coordinator.mjs', 5],
    ['./unattended-coordinator-test-support.mjs', 4],
    ['./runtime-executor.mjs', 5],
    ['./browser-runtime-closure.mjs', 4],
    ['./toolchain-closure.mjs', 8],
    ['../../../scripts/run-installed-browser-validation-core.mjs', 5]
  ];
  for (const [specifier, minimumBigIntStatCalls] of modules) {
    const source = await readFile(new URL(specifier, import.meta.url), 'utf8');
    const bigintStatCalls = source.match(/\{\s*bigint:\s*true\s*\}/gu) ?? [];
    assert.ok(bigintStatCalls.length >= minimumBigIntStatCalls, specifier);
    assert.doesNotMatch(source, /handle\.stat\(\)/u, specifier);
    assert.doesNotMatch(source, /\.nlink\s*!==\s*1(?!n)/u, specifier);
    assert.doesNotMatch(source, /\.ino\s*(?:===|!==)\s*0(?!n)/u, specifier);
    assert.doesNotMatch(source, /after\.size\s*!==\s*bytes(?:\.length)?\b/u, specifier);
    for (const key of ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs']) {
      assert.match(source, new RegExp(`['"]${key}['"]`), `${specifier} omits ${key}`);
    }
  }
});

test('prelaunch toolchain revalidation binds the exact reachable closure and Node runtime', async (t) => {
  const fixture = await runtimeFixture(t);
  const observed = await revalidateApprovedInstalledBrowserToolchain(fixture.plan);
  assert.deepEqual(observed, fixture.plan.inputs.toolchain);
  assert.equal(observed.nodeRuntimeVersion, process.version);
  assert.equal(Object.hasOwn(fixture.plan.identity, 'toolchainManifestSha256'), false);

  await writeFile(
    resolve(fixture.repositoryRoot, 'node_modules', 'puppeteer-core', 'index.js'),
    'reachable toolchain changed after approval\n'
  );
  await assert.rejects(
    revalidateApprovedInstalledBrowserToolchain(fixture.plan),
    /toolchain closure changed after approval/i
  );
});

test('a staged-closure mutation is refused before any verified external module body can evaluate', async (t) => {
  const fixture = await runtimeFixture(t);
  const runtime = await stageVerifiedRuntimeArtifact({ plan: fixture.plan, runRoot: fixture.runRoot });
  const stagedIndex = resolve(runtime.toolchainRoot, 'node_modules', 'puppeteer-core', 'index.js');
  await rename(stagedIndex, `${stagedIndex}.displaced`);
  await writeFile(stagedIndex, 'export const runtimeFixture = false;\n', { flag: 'wx' });
  delete globalThis.__sitewipeFakePuppeteerEvaluated;
  await assert.rejects(
    RUNTIME_EXECUTOR_TEST_SUPPORT.loadVerifiedStagedPuppeteer({ plan: fixture.plan, runtime }),
    /toolchain|package set|drift/iu
  );
  assert.equal(globalThis.__sitewipeFakePuppeteerEvaluated, undefined);
});

test('verified staged module evaluation is confined to built-ins and the complete owned dependency closure', async (t) => {
  const fixture = await runtimeFixture(t);
  const runtime = await stageVerifiedRuntimeArtifact({ plan: fixture.plan, runRoot: fixture.runRoot });
  delete globalThis.__sitewipeFakePuppeteerEvaluated;
  const loaded = await RUNTIME_EXECUTOR_TEST_SUPPORT.loadVerifiedStagedPuppeteer({
    plan: fixture.plan,
    runtime
  });
  assert.equal(typeof loaded.puppeteer.connect, 'function');
  assert.equal(typeof loaded.puppeteer.defaultArgs, 'function');
  assert.equal(typeof loaded.PipeTransport, 'function');
  assert.equal(globalThis.__sitewipeFakePuppeteerEvaluated, 1);
});

test('an approved package cannot resolve an undeclared file outside the verified owned stage', async (t) => {
  const fixture = await runtimeFixture(t, {
    puppeteerEntrySource: ({ repositoryRoot }) => `import ${JSON.stringify(
      pathToFileURL(resolve(repositoryRoot, 'undeclared-runtime.mjs')).href
    )};
globalThis.__sitewipeEscapedModuleEvaluated = true;
export default { connect() { return Promise.resolve({}); }, defaultArgs() { return []; } };
`
  });
  await writeFile(
    resolve(fixture.repositoryRoot, 'undeclared-runtime.mjs'),
    'globalThis.__sitewipeEscapedModuleEvaluated = true;\n',
    { flag: 'wx' }
  );
  const runtime = await stageVerifiedRuntimeArtifact({ plan: fixture.plan, runRoot: fixture.runRoot });
  delete globalThis.__sitewipeEscapedModuleEvaluated;
  await assert.rejects(
    RUNTIME_EXECUTOR_TEST_SUPPORT.loadVerifiedStagedPuppeteer({ plan: fixture.plan, runtime }),
    /escaped Node built-ins and the owned toolchain stage|escaped the exact owned toolchain stage/iu
  );
  assert.equal(globalThis.__sitewipeEscapedModuleEvaluated, undefined);
});

test('canonical aggregate is mechanically replayed, exclusively persisted, and handed to owned-run completion by relative path', async (t) => {
  const fixture = await runtimeFixture(t);
  const aggregate = allNotRunAggregate(fixture.plan);
  const written = await writeCanonicalBrowserAggregate({
    aggregate,
    plan: fixture.plan,
    runRoot: fixture.runRoot
  });
  assert.equal(written.aggregateRelativePath, 'aggregate.json');
  assert.equal(written.state, 'not_run');
  assert.equal(written.semanticValidationStatus, 'partial');
  const bytes = await readFile(resolve(fixture.runRoot, 'aggregate.json'));
  assert.equal(bytes.equals(canonicalJsonBytes(aggregate)), true);
  await assert.rejects(
    writeCanonicalBrowserAggregate({ aggregate, plan: fixture.plan, runRoot: fixture.runRoot }),
    /EEXIST|already exists/i
  );

  const second = await runtimeFixture(t);
  const secondAggregate = allNotRunAggregate(second.plan);
  let completionOptions;
  const ownedRun = {
    runRoot: second.runRoot,
    async complete(options) {
      completionOptions = options;
      return { schema: 'fixture-completion.v1', state: secondAggregate.state, ...options };
    }
  };
  const completed = await completeOwnedBrowserRunWithAggregate({
    aggregate: secondAggregate,
    detail: 'All unsupported semantic cells remain truthfully not_run.',
    ownedRun,
    plan: second.plan
  });
  assert.deepEqual(completionOptions, {
    detail: 'All unsupported semantic cells remain truthfully not_run.'
  });
  assert.equal(completed.persisted.aggregateRelativePath, 'aggregate.json');
  assert.equal(completed.completion.state, 'not_run');
});

test('tampered aggregate cannot create a completion file', async (t) => {
  const fixture = await runtimeFixture(t);
  const aggregate = allNotRunAggregate(fixture.plan);
  aggregate.resultSetSha256 = 'F'.repeat(64);
  await assert.rejects(
    writeCanonicalBrowserAggregate({ aggregate, plan: fixture.plan, runRoot: fixture.runRoot }),
    /raw-result binding|mechanical replay/
  );
  await assert.rejects(access(resolve(fixture.runRoot, 'aggregate.json')));
});

function spawnedSessionHarness() {
  const events = [];
  let residueObservationCount = 0;
  const canaryBytes = Buffer.alloc(32, 7);
  const browserPin = {
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    executableSha256: browserSha256
  };
  const cell = {
    profilePath: 'D:\\SiteWipe Runs\\profile',
    canaryPath: 'D:\\SiteWipe Runs\\downloads\\.sitewipe-must-preserve-download.bin',
    canarySha256: sha256(canaryBytes)
  };
  const processIdentity = {
    targetProcess: {
      processId: 4242,
      path: browserPin.executablePath,
      sha256: browserPin.executableSha256,
      startTimeUtcTicks: '638917729350000000'
    }
  };
  const child = { pid: 4242 };
  const childSettlement = {
    error: new Promise(() => {}),
    exit: new Promise(() => {})
  };
  const operations = {
    closeBrowser(browser) {
      return browser.close();
    },
    observeCanary() {
      events.push('observe-canary');
      return Promise.resolve({ bytes: canaryBytes, sha256: sha256(canaryBytes) });
    },
    observeIdentity() {
      events.push('observe-identity');
      return Promise.resolve(processIdentity);
    },
    observeResidue() {
      events.push('observe-residue');
      residueObservationCount += 1;
      return Promise.resolve({ residues: residueObservationCount === 1 ? [{ processId: 4242 }] : [] });
    },
    settle(promise, timeoutMs, label) {
      return settleForTest(promise, timeoutMs, label);
    },
    terminateTree() {
      events.push('terminate-tree');
      return Promise.resolve({ mode: 'terminate-tree' });
    }
  };
  const owner = RUNTIME_EXECUTOR_TEST_SUPPORT.createSpawnedBrowserSessionOwner({
    browserName: 'chrome',
    browserPin,
    cell,
    child,
    childSettlement,
    operations,
    plan: {
      runId: `sitewipe-browser-${'a'.repeat(32)}`,
      planSha256: 'B'.repeat(64),
      inputs: { processObserver: { processTerminationAllowed: true } }
    },
    timeouts: {
      lateConnectionMs: 10,
      gracefulCloseMs: 10,
      processIdentityMs: 10,
      residueMs: 10,
      terminationMs: 10,
      canaryMs: 10
    }
  });
  return { events, owner };
}

async function settleForTest(promise, timeoutMs, label) {
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, rejectPromise) => {
        timeout = setTimeout(() => rejectPromise(new Error(`${label} exceeded ${timeoutMs} ms.`)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function runtimeFixture(t, archiveOptions = {}) {
  const container = await mkdtemp(resolve(tmpdir(), 'sitewipe-runtime-executor-'));
  t.after(async () => {
    await makeWritableRecursively(container);
    await rm(container, { recursive: true, force: true });
  });
  const repositoryRoot = resolve(container, 'repository');
  const workspaceRoot = resolve(container, 'browser-runs');
  const inputsRoot = resolve(container, 'inputs');
  await Promise.all([mkdir(repositoryRoot), mkdir(workspaceRoot), mkdir(inputsRoot)]);
  const packageLockPath = resolve(repositoryRoot, 'package-lock.json');
  const nodeModulesPath = resolve(repositoryRoot, 'node_modules');
  const puppeteerPath = resolve(nodeModulesPath, 'puppeteer-core');
  await mkdir(puppeteerPath, { recursive: true });
  await writeFile(packageLockPath, `${runtimeToolchainLockText()}\n`);
  await writeFile(
    resolve(puppeteerPath, 'package.json'),
    `${JSON.stringify({ name: 'puppeteer-core', version: '25.8.0', type: 'module' })}\n`
  );
  await writeFile(resolve(puppeteerPath, 'index.js'), 'export const runtimeFixture = true;\n');
  const puppeteerModulePath = resolve(puppeteerPath, 'lib', 'puppeteer');
  const pipeTransportPath = resolve(puppeteerModulePath, 'node');
  await mkdir(pipeTransportPath, { recursive: true });
  const puppeteerEntrySource =
    typeof archiveOptions.puppeteerEntrySource === 'function'
      ? archiveOptions.puppeteerEntrySource({ repositoryRoot })
      : archiveOptions.puppeteerEntrySource;
  await writeFile(
    resolve(puppeteerModulePath, 'puppeteer-core.js'),
    puppeteerEntrySource ??
      `globalThis.__sitewipeFakePuppeteerEvaluated = (globalThis.__sitewipeFakePuppeteerEvaluated ?? 0) + 1;
export default { connect() { return Promise.resolve({}); }, defaultArgs() { return []; } };
`
  );
  await writeFile(resolve(pipeTransportPath, 'PipeTransport.js'), 'export class PipeTransport {}\n');
  const toolchainSummary = installedBrowserToolchainClosureSummary(
    await captureInstalledBrowserToolchainClosure({ packageLockPath, nodeModulesPath })
  );
  const artifactPath = resolve(inputsRoot, 'sitewipe-runtime.zip');
  const gitPath = resolve(inputsRoot, process.platform === 'win32' ? 'git.exe' : 'git');
  const bravePath = resolve(inputsRoot, process.platform === 'win32' ? 'brave.exe' : 'brave');
  const chromePath = resolve(inputsRoot, process.platform === 'win32' ? 'chrome.exe' : 'chrome');
  const nativeHelperPath = resolve(inputsRoot, process.platform === 'win32' ? 'native-helper.ps1' : 'native-helper');
  await Promise.all([
    writeFile(gitPath, 'fixture git\n'),
    writeFile(bravePath, 'fixture brave\n'),
    writeFile(chromePath, 'fixture chrome\n'),
    writeFile(nativeHelperPath, 'fixture native helper\n')
  ]);
  await writeRuntimeZip(artifactPath, archiveOptions);
  if (archiveOptions.mutateArchive) {
    const original = await readFile(artifactPath);
    await writeFile(artifactPath, archiveOptions.mutateArchive(original));
  }
  const artifactBytes = await readFile(artifactPath);
  const nodeExecutableSha256 = sha256(await readFile(process.execPath));
  const runId = `sitewipe-browser-${'a'.repeat(32)}`;
  const retention = { failureDays: 14, passEvidenceDays: 30, retainProfilesOnFailure: true };
  const browserPins = [
    {
      name: 'brave',
      executablePath: bravePath,
      version: '151.1.93.138',
      executableSha256: sha256(await readFile(bravePath)),
      runtimeRootPath: resolve(inputsRoot, '151.1.93.138'),
      runtimeVersion: '151.1.93.138',
      runtimeFileCount: 176,
      runtimeBytes: 1076868141,
      runtimeManifestSha256: '1'.repeat(64)
    },
    {
      name: 'chrome',
      executablePath: chromePath,
      version: '151.0.7922.174',
      executableSha256: sha256(await readFile(chromePath)),
      runtimeRootPath: resolve(inputsRoot, '151.0.7922.174'),
      runtimeVersion: '151.0.7922.174',
      runtimeFileCount: 266,
      runtimeBytes: 514076268,
      runtimeManifestSha256: '2'.repeat(64)
    }
  ];
  const browserRuntimeSetSha256 = computeBrowserRuntimeSetSha256(browserPins);
  const plan = {
    schema: BROWSER_PLAN_SCHEMA,
    matrixVersion: BROWSER_MATRIX_VERSION,
    matrixSha256: CANONICAL_BROWSER_MATRIX_SHA256,
    runId,
    createdAt: timestamp,
    requiredBrowsers: [...REQUIRED_BROWSERS],
    requiredMatrixIds: [...CANONICAL_BROWSER_MATRIX_IDS],
    semanticValidatorManifestSha256: SEMANTIC_VALIDATOR_MANIFEST_SHA256,
    identity: {
      sourceCommitSha: 'a'.repeat(40),
      sourceTreeSha: 'b'.repeat(40),
      artifactVersion: '9.9.9',
      artifactBytes: artifactBytes.length,
      artifactSha256: sha256(artifactBytes),
      browserRuntimeSetSha256,
      gitExecutableSha256: sha256(await readFile(gitPath)),
      harnessManifestSha256: 'B'.repeat(64),
      launchPolicySha256: INSTALLED_RUNTIME_LAUNCH_POLICY_SHA256,
      nativeHelperSha256: sha256(await readFile(nativeHelperPath)),
      nodeExecutableSha256,
      nodeRuntimeVersion: process.version,
      packageLockSha256: sha256(await readFile(packageLockPath)),
      powerShellExecutableSha256: sha256(await readFile(gitPath)),
      processObserverHelperSha256: sha256(await readFile(nativeHelperPath)),
      releaseInputFingerprintSha256: 'F'.repeat(64),
      runtimeFingerprintSha256: '0'.repeat(64),
      toolchainPuppeteerVersion: toolchainSummary.toolchainPuppeteerVersion,
      toolchainPackageCount: toolchainSummary.toolchainPackageCount,
      toolchainFileCount: toolchainSummary.toolchainFileCount,
      toolchainBytes: toolchainSummary.toolchainBytes,
      toolchainSetSha256: toolchainSummary.toolchainSetSha256
    },
    inputs: {
      repositoryRoot,
      workspaceRoot,
      artifactPath,
      git: {
        path: gitPath,
        sha256: sha256(await readFile(gitPath)),
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
        helperPath: nativeHelperPath,
        helperSha256: sha256(await readFile(nativeHelperPath)),
        policySha256: NATIVE_PROMPT_POLICY_SHA256,
        allowedActions: [...NATIVE_PROMPT_ALLOWED_ACTIONS],
        permissionPatterns: [...NATIVE_PROMPT_PERMISSION_PATTERNS],
        expectedFragments: [...NATIVE_PROMPT_EXPECTED_FRAGMENTS],
        scenarioSchedule: structuredClone(NATIVE_PROMPT_SCENARIO_SCHEDULE),
        uiaSnapshots: structuredClone(NATIVE_PROMPT_UIA_SNAPSHOTS),
        requiresUnlockedInteractiveSession: true
      },
      processObserver: {
        helperPath: nativeHelperPath,
        helperSha256: sha256(await readFile(nativeHelperPath)),
        powershellPath: gitPath,
        powershellSha256: sha256(await readFile(gitPath)),
        helperModes: ['Identity', 'ProfileResidue', 'TerminateTree'],
        rawCommandLinesRetained: false,
        processTerminationAllowed: true
      },
      toolchain: {
        nodeRuntimeVersion: process.version,
        ...toolchainSummary
      },
      retention
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
  const runRoot = resolve(workspaceRoot, runId);
  await mkdir(runRoot);
  await writeFile(
    resolve(runRoot, '.sitewipe-owned-run.json'),
    canonicalJsonBytes({
      schema: 'sitewipe.owned-browser-run.v1',
      runId,
      planSha256: plan.planSha256,
      fixtureTokenSha256: '1'.repeat(64),
      ownerProcessId: process.pid,
      state: 'prepared',
      retention
    })
  );
  await writeFile(resolve(runRoot, 'approved-plan.json'), canonicalJsonBytes(plan));
  return { container, repositoryRoot, workspaceRoot, runRoot, artifactPath, plan };
}

function runtimeToolchainLockText() {
  return JSON.stringify({
    name: 'sitewipe-runtime-fixture',
    version: '9.9.9',
    lockfileVersion: 3,
    packages: {
      '': {
        name: 'sitewipe-runtime-fixture',
        version: '9.9.9',
        devDependencies: { 'puppeteer-core': '25.8.0' }
      },
      'node_modules/puppeteer-core': { version: '25.8.0' }
    }
  });
}

async function writeRuntimeZip(path, { duplicatePath = null, extraEntry = null, modeMutationPath = null } = {}) {
  const zip = new yazl.ZipFile();
  const output = createWriteStream(path);
  const completed = new Promise((resolvePromise, rejectPromise) => {
    output.once('close', resolvePromise);
    output.once('error', rejectPromise);
    zip.outputStream.once('error', rejectPromise);
  });
  zip.outputStream.pipe(output);
  for (const runtimePath of RUNTIME_FILES) {
    zip.addBuffer(runtimeBytes(runtimePath), runtimePath, {
      mtime: new Date('1980-01-01T00:00:00.000Z'),
      mode: runtimePath === modeMutationPath ? 0o120777 : 0o100644,
      compress: true
    });
  }
  if (duplicatePath) {
    zip.addBuffer(runtimeBytes(duplicatePath), duplicatePath, {
      mtime: new Date('1980-01-01T00:00:00.000Z'),
      mode: 0o100644,
      compress: true
    });
  }
  if (extraEntry) {
    zip.addBuffer(Buffer.from(extraEntry.bytes), extraEntry.path, {
      mtime: new Date('1980-01-01T00:00:00.000Z'),
      mode: extraEntry.mode,
      compress: true
    });
  }
  zip.end();
  await completed;
}

function runtimeBytes(path) {
  return path === 'manifest.json' ? runtimeManifestBytes() : Buffer.from(`synthetic:${path}\n`, 'utf8');
}

function runtimeManifestBytes() {
  return Buffer.from(
    JSON.stringify({
      manifest_version: 3,
      name: 'SiteWipe',
      version: '9.9.9',
      background: { service_worker: 'background/service-worker.js', type: 'module' },
      action: { default_popup: 'popup/popup.html' },
      options_page: 'options/options.html'
    }),
    'utf8'
  );
}

function mutateManifestPathToTraversal(bytes) {
  const result = Buffer.from(bytes);
  const source = Buffer.from('manifest.json');
  const replacement = Buffer.from('../ifest.json');
  let offset = 0;
  let replacements = 0;
  while ((offset = result.indexOf(source, offset)) >= 0) {
    replacement.copy(result, offset);
    replacements += 1;
    offset += replacement.length;
  }
  assert.ok(replacements >= 2, 'local and central ZIP names were both mutated');
  return result;
}

function allNotRunAggregate(plan) {
  const records = [];
  for (const scenario of CANONICAL_BROWSER_MATRIX) {
    for (const browserName of REQUIRED_BROWSERS) {
      const result = {
        schema: SCENARIO_RESULT_SCHEMA,
        matrixVersion: BROWSER_MATRIX_VERSION,
        matrixSha256: CANONICAL_BROWSER_MATRIX_SHA256,
        semanticValidatorManifestSha256: SEMANTIC_VALIDATOR_MANIFEST_SHA256,
        planSha256: plan.planSha256,
        runId: plan.runId,
        scenarioId: scenario.id,
        browser: structuredClone(plan.inputs.browserPins.find(({ name }) => name === browserName)),
        identity: structuredClone(plan.identity),
        startedAt: timestamp,
        completedAt: timestamp,
        reason: 'Required exact typed observations or canonical validators are absent.',
        evidence: []
      };
      records.push(createScenarioResultRecord(result, { plan }));
    }
  }
  return aggregateBrowserEvidence({ plan, resultRecords: records });
}

async function listFiles(root) {
  const files = [];
  async function walk(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(resolve(directory, entry.name), relativePath);
      else files.push(relativePath);
    }
  }
  await walk(root);
  return files.sort();
}

async function makeWritableRecursively(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      const path = resolve(root, entry.name);
      if (entry.isDirectory()) await makeWritableRecursively(path);
      else await chmod(path, 0o600).catch(() => undefined);
    }
    await chmod(root, 0o700).catch(() => undefined);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

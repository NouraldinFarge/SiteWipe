import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, link, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  INSTALLED_BROWSER_POLICY_PATH,
  INSTALLED_BROWSER_PINS,
  createUnattendedBrowserPlan,
  prepareApprovedOwnedRun
} from './unattended-coordinator.mjs';
import {
  SCENARIO_RESULT_SCHEMA,
  aggregateBrowserEvidence,
  canonicalJsonBytes,
  computePlanSha256,
  createScenarioResultRecord
} from './evidence-contract.mjs';
import { isDriveQualifiedWindowsAbsolutePath } from './path-contract.mjs';
import {
  BROWSER_MATRIX_VERSION,
  CANONICAL_BROWSER_MATRIX,
  CANONICAL_BROWSER_MATRIX_SHA256,
  REQUIRED_BROWSERS
} from './canonical-matrix.mjs';
import { SEMANTIC_VALIDATOR_MANIFEST_SHA256 } from './semantic-validator.mjs';
import {
  createUnattendedBrowserPlanFixture,
  revalidateUnattendedBrowserPlanFixture
} from './unattended-coordinator-test-support.mjs';

test('committed browser pins retain explicit local Windows drive authority on every host', () => {
  assert.deepEqual(
    INSTALLED_BROWSER_PINS.map(({ name }) => name),
    ['brave', 'chrome']
  );
  for (const pin of INSTALLED_BROWSER_PINS) {
    assert.equal(isDriveQualifiedWindowsAbsolutePath(pin.executablePath), true, pin.name);
  }
});

test('installed browser policy uses the exact v2 runtime-closure contract', async () => {
  const policy = JSON.parse(await readFile(INSTALLED_BROWSER_POLICY_PATH, 'utf8'));
  assert.equal(policy.schema, 'sitewipe.installed-browser-policy.v2');
  assert.deepEqual(Object.keys(policy).sort(), ['browsers', 'launchPolicySha256', 'schema', 'transport']);
});

test('production coordinator rejects foreign path grammar before physical lookup', async () => {
  const foreignRepositoryRoot =
    process.platform === 'win32' ? '/var/tmp/sitewipe/repository' : 'C:\\sitewipe\\repository';
  await assert.rejects(
    createUnattendedBrowserPlan({
      repositoryRoot: foreignRepositoryRoot,
      workspaceRoot: resolve(tmpdir(), 'sitewipe-foreign-path-regression')
    }),
    /current host/
  );
});

test('production coordinator rejects a foreign workspace root before normalization', async () => {
  const foreignWorkspaceRoot =
    process.platform === 'win32' ? '/var/tmp/sitewipe/browser-runs' : 'C:\\sitewipe\\browser-runs';
  await assert.rejects(
    createUnattendedBrowserPlan({
      repositoryRoot: resolve('.'),
      workspaceRoot: foreignWorkspaceRoot
    }),
    /current host/
  );
});

test('test support creates and revalidates an exact fixture plan without weakening production authority', async (t) => {
  const fixture = await coordinatorFixture(t);
  const plan = await createUnattendedBrowserPlanFixture({
    ...fixture.inputs,
    createdAt: '2026-08-24T22:00:00.000Z',
    randomBytesFn: () => Buffer.alloc(16, 0xab)
  });
  assert.equal(plan.planSha256.length, 64);
  assert.equal(plan.requiredMatrixIds.length, 24);
  await assert.rejects(access(fixture.workspaceRoot));
  assert.equal(await revalidateUnattendedBrowserPlanFixture(plan, fixture.inputs), plan);
  assert.equal(relative(fixture.inputs.repositoryRoot, plan.inputs.workspaceRoot).startsWith('..'), true);

  await assert.rejects(prepareApprovedOwnedRun({ plan, approvalSha256: 'F'.repeat(64) }), /one initial approval/);
  await assert.rejects(access(fixture.workspaceRoot));
});

test('coordinator revalidation fails closed when exact artifact bytes change', async (t) => {
  const fixture = await coordinatorFixture(t);
  const plan = await createUnattendedBrowserPlanFixture({
    ...fixture.inputs,
    createdAt: '2026-08-24T22:00:00.000Z',
    randomBytesFn: () => Buffer.alloc(16, 0xef)
  });
  await writeFile(fixture.artifactPath, 'changed artifact bytes\n');
  await assert.rejects(revalidateUnattendedBrowserPlanFixture(plan, fixture.inputs), /identity changed/);
});

test('coordinator revalidation fails closed when the approved installed-browser toolchain drifts', async (t) => {
  const fixture = await coordinatorFixture(t);
  const plan = await createUnattendedBrowserPlanFixture({
    ...fixture.inputs,
    createdAt: '2026-08-24T22:00:00.000Z',
    randomBytesFn: () => Buffer.alloc(16, 0xed)
  });
  assert.equal(plan.inputs.toolchain.nodeRuntimeVersion, process.version);
  assert.equal(plan.identity.toolchainSetSha256, plan.inputs.toolchain.toolchainSetSha256);
  assert.equal(Object.hasOwn(plan.identity, 'toolchainManifestSha256'), false);

  await writeFile(
    resolve(fixture.inputs.repositoryRoot, 'node_modules', 'puppeteer-core', 'index.js'),
    'reachable installed toolchain drift\n'
  );
  await assert.rejects(
    revalidateUnattendedBrowserPlanFixture(plan, fixture.inputs),
    /toolchain closure.*changed|files.*drifted/i
  );
});

test('production plan rejects caller-selected browser authority and in-repository private storage', async (t) => {
  const fixture = await coordinatorFixture(t);
  const base = {
    repositoryRoot: fixture.inputs.repositoryRoot,
    workspaceRoot: fixture.inputs.workspaceRoot
  };
  await assert.rejects(
    createUnattendedBrowserPlan({ ...base, artifact: fixture.inputs.artifact }),
    /caller-controlled fields: artifact/
  );
  await assert.rejects(
    createUnattendedBrowserPlan({ ...base, browserPins: fixture.inputs.browserPins }),
    /caller-controlled fields: browserPins/
  );
  await assert.rejects(
    createUnattendedBrowserPlan({ ...base, randomBytesFn: () => Buffer.alloc(16) }),
    /caller-controlled fields: randomBytesFn/
  );
  await assert.rejects(
    prepareApprovedOwnedRun({
      plan: {},
      approvalSha256: 'F'.repeat(64),
      randomBytesFn: () => Buffer.alloc(32)
    }),
    /caller-controlled fields: randomBytesFn/
  );
  await assert.rejects(
    createUnattendedBrowserPlan({
      ...base,
      workspaceRoot: resolve(fixture.inputs.repositoryRoot, 'private-browser-plan')
    }),
    /workspace root must remain outside the source repository/
  );
});

test('coordinator rejects hidden assume-unchanged index state', async (t) => {
  const fixture = await coordinatorFixture(t);
  git(fixture.inputs.repositoryRoot, ['update-index', '--assume-unchanged', 'package.json']);
  await assert.rejects(
    createUnattendedBrowserPlanFixture({
      ...fixture.inputs,
      createdAt: '2026-08-24T22:00:00.000Z',
      randomBytesFn: () => Buffer.alloc(16, 0xaa)
    }),
    /assume-unchanged or skip-worktree/
  );
});

test('coordinator rejects hidden skip-worktree index state', async (t) => {
  const fixture = await coordinatorFixture(t);
  git(fixture.inputs.repositoryRoot, ['update-index', '--skip-worktree', 'package.json']);
  await assert.rejects(
    createUnattendedBrowserPlanFixture({
      ...fixture.inputs,
      createdAt: '2026-08-24T22:00:00.000Z',
      randomBytesFn: () => Buffer.alloc(16, 0xbb)
    }),
    /assume-unchanged or skip-worktree/
  );
});

test('production coordinator source exposes no environment-switched fixture authority', async () => {
  const source = await readFile(new URL('./unattended-coordinator.mjs', import.meta.url), 'utf8');
  const productionExports = await import('./unattended-coordinator.mjs');
  assert.doesNotMatch(source, /NODE_TEST_CONTEXT/);
  assert.doesNotMatch(source, /WeakMap/);
  assert.doesNotMatch(source, /createUnattendedBrowserPlanForTest/);
  assert.doesNotMatch(source, /unattended-coordinator-test-support/);
  assert.match(
    source,
    /async function exactPhysicalDirectory[\s\S]*?resolve\(assertNativeAbsolutePath\(path,[\s\S]*?async function exactFileIdentity/
  );
  assert.match(
    source,
    /async function exactFileIdentity[\s\S]*?resolve\(assertNativeAbsolutePath\(path,[\s\S]*?function validateInstalledBrowserPolicy/
  );
  assert.match(
    source,
    /async function validateWorkspacePlacement[\s\S]*?resolve\(assertNativeAbsolutePath\(workspaceRoot,[\s\S]*?async function ensureOwnedWorkspaceRoot[\s\S]*?resolve\(assertNativeAbsolutePath\(workspaceRoot,/
  );
  assert.match(
    source,
    /async function ensureOwnedWorkspaceRoot[\s\S]*?exactFileIdentity\(markerPath, 'Browser workspace marker'\)[\s\S]*?async function assertWorkspaceMarkerOrEmpty/
  );
  assert.match(
    source,
    /async function writeExclusiveRegularFile[\s\S]*?await handle\.close\(\)[\s\S]*?exactFileIdentity\(path, label\)[\s\S]*?sameFileIdentity\(information, observed\.information\)[\s\S]*?observed\.bytes\.equals\(content\)/
  );
  assert.match(
    source,
    /async function writeExclusiveRegularFile\(path, bytes, label, parentIdentity\)[\s\S]*?assertExactDirectoryIdentity\(parentIdentity,[\s\S]*?await handle\.close\(\)[\s\S]*?assertExactDirectoryIdentity\(parentIdentity,/
  );
  assert.doesNotMatch(source, /\bunlink\s*\(/u);
  assert.deepEqual(Object.keys(productionExports).sort(), [
    'INSTALLED_BROWSER_PINS',
    'INSTALLED_BROWSER_POLICY_PATH',
    'createUnattendedBrowserPlan',
    'prepareApprovedOwnedRun',
    'revalidateApprovedBrowserPlan'
  ]);
});

test('committed package identity ignores and cannot be satisfied by post-clean live mutations', async (t) => {
  const changedPackageLock = JSON.stringify({
    name: 'sitewipe-fixture',
    version: '9.9.9',
    lockfileVersion: 3,
    injectedAfterCleanCheck: true
  });
  const changedVersionState = JSON.stringify({
    runtimeFingerprintSha256: 'A'.repeat(64),
    releaseInputFileCount: 1,
    releaseInputFingerprintSha256: 'B'.repeat(64)
  });
  const mutateLiveIdentityFiles = (fixture) =>
    Promise.all([
      writeFile(resolve(fixture.inputs.repositoryRoot, 'package.json'), '{"version":"9.9.9"}\n'),
      writeFile(resolve(fixture.inputs.repositoryRoot, 'docs/evidence/version-state.json'), `${changedVersionState}\n`)
    ]);

  const creationFixture = await coordinatorFixture(t);
  const postCleanCreationPlan = await createUnattendedBrowserPlanFixture({
    ...creationFixture.inputs,
    createdAt: '2026-08-24T22:00:00.000Z',
    randomBytesFn: () => Buffer.alloc(16, 0xcc),
    afterCleanCheck: () => mutateLiveIdentityFiles(creationFixture)
  });
  assert.equal(postCleanCreationPlan.identity.artifactVersion, '1.11.77');
  assert.equal(postCleanCreationPlan.identity.packageLockSha256, sha256Text(`${fixturePackageLockText()}\n`));
  assert.equal(postCleanCreationPlan.identity.runtimeFingerprintSha256, '7'.repeat(64));
  assert.equal(postCleanCreationPlan.identity.releaseInputFingerprintSha256, '8'.repeat(64));

  const unchangedFixture = await coordinatorFixture(t);
  const unchangedPlan = await createUnattendedBrowserPlanFixture({
    ...unchangedFixture.inputs,
    createdAt: '2026-08-24T22:00:00.000Z',
    randomBytesFn: () => Buffer.alloc(16, 0xcd)
  });
  assert.equal(
    await revalidateUnattendedBrowserPlanFixture(unchangedPlan, {
      ...unchangedFixture.inputs,
      afterCleanCheck: () => mutateLiveIdentityFiles(unchangedFixture)
    }),
    unchangedPlan
  );
  assert.equal(unchangedPlan.identity.artifactVersion, '1.11.77');
  assert.notEqual(unchangedPlan.identity.packageLockSha256, sha256Text(`${changedPackageLock}\n`));
  assert.equal(unchangedPlan.identity.runtimeFingerprintSha256, '7'.repeat(64));
  assert.equal(unchangedPlan.identity.releaseInputFingerprintSha256, '8'.repeat(64));

  const rejectedFixture = await coordinatorFixture(t);
  const committedPlan = await createUnattendedBrowserPlanFixture({
    ...rejectedFixture.inputs,
    createdAt: '2026-08-24T22:00:00.000Z',
    randomBytesFn: () => Buffer.alloc(16, 0xce)
  });
  const liveIdentityPlan = structuredClone(committedPlan);
  liveIdentityPlan.identity.packageLockSha256 = sha256Text(`${changedPackageLock}\n`);
  liveIdentityPlan.identity.runtimeFingerprintSha256 = 'A'.repeat(64);
  liveIdentityPlan.identity.releaseInputFingerprintSha256 = 'B'.repeat(64);
  liveIdentityPlan.planSha256 = computePlanSha256(liveIdentityPlan);

  await assert.rejects(
    revalidateUnattendedBrowserPlanFixture(liveIdentityPlan, {
      ...rejectedFixture.inputs,
      afterCleanCheck: () => mutateLiveIdentityFiles(rejectedFixture)
    }),
    /committed source.*identity changed/i
  );
});

test('failure settlement retains the exact run and immutable lock, writes one canonical terminal record, and is single-use', async (t) => {
  const { fixture, ownedRun, plan } = await preparedFixtureOwnedRun(t, 0xd1);
  const retainedDirectory = resolve(ownedRun.runRoot, 'retained-profile');
  const retainedFile = resolve(retainedDirectory, 'synthetic-profile-state.txt');
  const workspaceSentinel = resolve(fixture.workspaceRoot, 'unrelated-retained-run.txt');
  await mkdir(retainedDirectory);
  await writeFile(retainedFile, 'retain this exact synthetic state\n');
  await writeFile(workspaceSentinel, 'do not broadly delete workspace entries\n');
  const lockPath = resolve(fixture.workspaceRoot, '.sitewipe-active-run.lock');
  const lockBytes = await readFile(lockPath);

  const detail = 'D'.repeat(64);
  const receipt = await ownedRun.retainFailure({ detail });
  assert.deepEqual(Object.keys(receipt), [
    'schema',
    'runId',
    'planSha256',
    'detail',
    'failedAt',
    'retainedRunRoot',
    'automaticRecursiveDeletionPerformed'
  ]);
  assert.equal(receipt.schema, 'sitewipe.owned-browser-run-failure.v1');
  assert.equal(receipt.runId, plan.runId);
  assert.equal(receipt.planSha256, plan.planSha256);
  assert.equal(receipt.detail, detail);
  assert.equal(receipt.retainedRunRoot, true);
  assert.equal(receipt.automaticRecursiveDeletionPerformed, false);
  assert.equal(Number.isNaN(Date.parse(receipt.failedAt)), false);

  const terminal = await readTerminal(ownedRun);
  assert.equal(terminal.schema, 'sitewipe.owned-browser-run-terminal.v1');
  assert.equal(terminal.disposition, 'failure');
  assert.equal(terminal.runId, plan.runId);
  assert.equal(terminal.planSha256, plan.planSha256);
  assert.equal(
    terminal.receiptSha256,
    createHash('sha256').update(canonicalJsonBytes(receipt)).digest('hex').toUpperCase()
  );
  assert.deepEqual(terminal.receipt, receipt);
  assert.equal(terminal.retainedActiveLock, true);
  assert.equal(terminal.workspaceSealed, true);
  assert.equal(terminal.automaticRecursiveDeletionPerformed, false);
  assert.equal(await readFile(retainedFile, 'utf8'), 'retain this exact synthetic state\n');
  assert.equal(await readFile(workspaceSentinel, 'utf8'), 'do not broadly delete workspace entries\n');
  assert.deepEqual(await readFile(lockPath), lockBytes);
  await assert.rejects(ownedRun.complete(), /settlement capability was already used/);
  await assert.rejects(ownedRun.retainFailure({ detail }), /settlement capability was already used/);
});

test('failure settlement rejects non-opaque input without consuming the capability', async (t) => {
  const { ownedRun } = await preparedFixtureOwnedRun(t, 0xd2);
  for (const invalid of [
    {},
    { detail: '' },
    { detail: 'C:\\private\\profile\\secret.txt' },
    { detail: 'a'.repeat(64) },
    { detail: 'A'.repeat(63) },
    { detail: 'A'.repeat(64), path: 'caller-controlled' }
  ]) {
    await assert.rejects(ownedRun.retainFailure(invalid), /uppercase SHA-256 digest|caller-controlled fields/);
  }
  const receipt = await ownedRun.retainFailure({ detail: 'A'.repeat(64) });
  assert.equal(receipt.detail, 'A'.repeat(64));
});

test('failure settlement fails closed when the exact owned-run marker identity changes', async (t) => {
  const { fixture, ownedRun } = await preparedFixtureOwnedRun(t, 0xd3);
  const markerPath = resolve(ownedRun.runRoot, '.sitewipe-owned-run.json');
  await writeFile(markerPath, '{"tampered":true}\n');

  await assert.rejects(ownedRun.retainFailure({ detail: 'B'.repeat(64) }), /ownership marker identity changed/);
  await access(resolve(fixture.workspaceRoot, '.sitewipe-active-run.lock'));
  await assert.rejects(access(resolve(ownedRun.runRoot, 'terminal.json')), { code: 'ENOENT' });
  await assert.rejects(ownedRun.retainFailure({ detail: 'B'.repeat(64) }), /settlement capability was already used/);
});

test('terminal settlement uses one create-only filename and a collision leaves the capability terminal-uncertain', async (t) => {
  const { fixture, ownedRun } = await preparedFixtureOwnedRun(t, 0xd4);
  const collisionPath = resolve(ownedRun.runRoot, 'terminal.json');
  await writeFile(collisionPath, 'pre-existing collision sentinel\n');

  await assert.rejects(ownedRun.retainFailure({ detail: 'C'.repeat(64) }), { code: 'EEXIST' });
  assert.equal(await readFile(collisionPath, 'utf8'), 'pre-existing collision sentinel\n');
  await access(resolve(fixture.workspaceRoot, '.sitewipe-active-run.lock'));
  await assert.rejects(ownedRun.retainFailure({ detail: 'C'.repeat(64) }), /settlement capability was already used/);
  await assert.rejects(ownedRun.complete(), /settlement capability was already used/);
});

test('failure settlement refuses a replacement active-lock object without moving or deleting either object', async (t) => {
  const { fixture, ownedRun } = await preparedFixtureOwnedRun(t, 0xd6);
  const lockPath = resolve(fixture.workspaceRoot, '.sitewipe-active-run.lock');
  const displacedLockPath = resolve(fixture.workspaceRoot, '.sitewipe-original-run.lock');
  await rename(lockPath, displacedLockPath);
  await writeFile(lockPath, '{"tampered":true}\n');

  await assert.rejects(ownedRun.retainFailure({ detail: 'F'.repeat(64) }), /run lock identity changed/);
  assert.equal(await readFile(lockPath, 'utf8'), '{"tampered":true}\n');
  await access(displacedLockPath);
  await assert.rejects(access(resolve(ownedRun.runRoot, 'terminal.json')), { code: 'ENOENT' });
  await assert.rejects(ownedRun.retainFailure({ detail: 'F'.repeat(64) }), /settlement capability was already used/);
});

test('failed completion before terminal creation reopens only the conservative failure route with one terminal record', async (t) => {
  const { fixture, ownedRun } = await preparedFixtureOwnedRun(t, 0xd7);

  await assert.rejects(ownedRun.complete({ detail: 'Missing aggregate must not complete.' }), /aggregate/i);
  await assert.rejects(ownedRun.complete({ detail: 'A completion retry is forbidden.' }), /already used/);
  await access(resolve(fixture.workspaceRoot, '.sitewipe-active-run.lock'));
  await assert.rejects(access(resolve(ownedRun.runRoot, 'terminal.json')), { code: 'ENOENT' });

  const failure = await ownedRun.retainFailure({ detail: '7'.repeat(64) });
  assert.equal(failure.schema, 'sitewipe.owned-browser-run-failure.v1');
  const terminal = await readTerminal(ownedRun);
  assert.equal(terminal.disposition, 'failure');
  assert.deepEqual(terminal.receipt, failure);
  await access(resolve(fixture.workspaceRoot, '.sitewipe-active-run.lock'));
  await assert.rejects(ownedRun.retainFailure({ detail: '8'.repeat(64) }), /already used/);
});

test('a pre-existing terminal collision is non-overwriting and cannot be followed by an opposite settlement', async (t) => {
  const { fixture, ownedRun, plan } = await preparedFixtureOwnedRun(t, 0xd9);
  await writeNotRunAggregateForOwnedRun(ownedRun, plan);
  const terminalPath = resolve(ownedRun.runRoot, 'terminal.json');
  await writeFile(terminalPath, 'do not overwrite this terminal collision\n');

  await assert.rejects(ownedRun.complete({ detail: 'Exact retained aggregate.' }), { code: 'EEXIST' });
  assert.equal(await readFile(terminalPath, 'utf8'), 'do not overwrite this terminal collision\n');
  await access(resolve(fixture.workspaceRoot, '.sitewipe-active-run.lock'));
  await assert.rejects(ownedRun.retainFailure({ detail: '9'.repeat(64) }), /already used/);
});

test('settlement revalidates retained workspace marker, approved plan, and run-parent identity before writing', async (t) => {
  await t.test('workspace marker tamper', async (t) => {
    const { fixture, ownedRun } = await preparedFixtureOwnedRun(t, 0xda);
    await writeFile(resolve(fixture.workspaceRoot, '.sitewipe-browser-workspace.json'), '{"tampered":true}\n');
    await assert.rejects(ownedRun.retainFailure({ detail: 'A'.repeat(64) }), /workspace marker identity changed/i);
    await access(resolve(fixture.workspaceRoot, '.sitewipe-active-run.lock'));
    await assert.rejects(access(resolve(ownedRun.runRoot, 'terminal.json')), { code: 'ENOENT' });
  });

  await t.test('approved-plan tamper', async (t) => {
    const { fixture, ownedRun } = await preparedFixtureOwnedRun(t, 0xdb);
    await writeFile(resolve(ownedRun.runRoot, 'approved-plan.json'), '{"tampered":true}\n');
    await assert.rejects(
      ownedRun.retainFailure({ detail: 'B'.repeat(64) }),
      /approved browser plan.*identity changed/i
    );
    await access(resolve(fixture.workspaceRoot, '.sitewipe-active-run.lock'));
    await assert.rejects(access(resolve(ownedRun.runRoot, 'terminal.json')), { code: 'ENOENT' });
  });

  await t.test('approved-plan hard link', async (t) => {
    const { fixture, ownedRun } = await preparedFixtureOwnedRun(t, 0xde);
    const approvedPlanPath = resolve(ownedRun.runRoot, 'approved-plan.json');
    await link(approvedPlanPath, resolve(ownedRun.runRoot, 'approved-plan-hardlink.json'));
    await assert.rejects(ownedRun.retainFailure({ detail: 'D'.repeat(64) }), /singly linked/i);
    await access(resolve(fixture.workspaceRoot, '.sitewipe-active-run.lock'));
    await assert.rejects(access(resolve(ownedRun.runRoot, 'terminal.json')), { code: 'ENOENT' });
  });

  await t.test('run-parent swap', async (t) => {
    const { fixture, ownedRun } = await preparedFixtureOwnedRun(t, 0xdc);
    const displaced = `${ownedRun.runRoot}-displaced`;
    await rename(ownedRun.runRoot, displaced);
    await mkdir(ownedRun.runRoot);
    await assert.rejects(ownedRun.retainFailure({ detail: 'C'.repeat(64) }), /run root identity changed/i);
    await access(resolve(fixture.workspaceRoot, '.sitewipe-active-run.lock'));
    await assert.rejects(access(resolve(ownedRun.runRoot, 'terminal.json')), { code: 'ENOENT' });
  });
});

test('post-create terminal recheck detects terminal replacement and leaves settlement terminal-uncertain', async (t) => {
  const sourceTransform = (source) => {
    const anchor = "        await assertRetainedFileIdentity(written, terminalBytes, 'Browser run terminal record');";
    assert.equal(source.split(anchor).length - 1, 2);
    const offset = source.lastIndexOf(anchor);
    return `${source.slice(0, offset)}        await (await import('node:fs/promises')).writeFile(resolve(run.path, 'terminal.json'), '{"tampered":true}\\n');\n${source.slice(offset)}`;
  };
  const { fixture, ownedRun } = await preparedFixtureOwnedRun(t, 0xdd, { sourceTransform });

  await assert.rejects(ownedRun.retainFailure({ detail: 'D'.repeat(64) }), /terminal record identity changed/i);
  assert.equal(await readFile(resolve(ownedRun.runRoot, 'terminal.json'), 'utf8'), '{"tampered":true}\n');
  await access(resolve(fixture.workspaceRoot, '.sitewipe-active-run.lock'));
  await assert.rejects(ownedRun.retainFailure({ detail: 'E'.repeat(64) }), /already used/);
  await assert.rejects(ownedRun.complete(), /already used/);
});

test('post-create settlement revalidates the retained workspace marker and approved plan before durability', async (t) => {
  for (const fixtureCase of [
    {
      label: 'workspace marker',
      expression: "resolve(workspace.path, '.sitewipe-browser-workspace.json')",
      expected: /workspace marker identity changed/i
    },
    {
      label: 'approved plan',
      expression: "resolve(run.path, 'approved-plan.json')",
      expected: /approved browser plan.*identity changed/i
    }
  ]) {
    await t.test(fixtureCase.label, async (t) => {
      const sourceTransform = (source) => {
        const anchor = '        await assertExactOwnedRunIdentity({ approvedPlan, plan, run, runMarker, workspace });';
        assert.equal(source.split(anchor).length - 1, 4);
        const offset = source.lastIndexOf(anchor);
        const injection = `        await (await import('node:fs/promises')).writeFile(${fixtureCase.expression}, '{"tampered":true}\\n');\n`;
        return `${source.slice(0, offset)}${injection}${source.slice(offset)}`;
      };
      const { fixture, ownedRun } = await preparedFixtureOwnedRun(t, 0xe0, { sourceTransform });

      await assert.rejects(ownedRun.retainFailure({ detail: 'F'.repeat(64) }), fixtureCase.expected);
      await access(resolve(ownedRun.runRoot, 'terminal.json'));
      await access(resolve(fixture.workspaceRoot, '.sitewipe-active-run.lock'));
      await assert.rejects(ownedRun.complete(), /already used/);
      await assert.rejects(ownedRun.retainFailure({ detail: '1'.repeat(64) }), /already used/);
    });
  }
});

test('existing workspace marker must remain one exact physical single-link file', async (t) => {
  const fixture = await coordinatorFixture(t);
  const plan = await createUnattendedBrowserPlanFixture({
    ...fixture.inputs,
    createdAt: '2026-08-24T22:00:00.000Z',
    randomBytesFn: () => Buffer.alloc(16, 0xd8)
  });
  assert.equal(await revalidateUnattendedBrowserPlanFixture(plan, fixture.inputs), plan);
  await mkdir(fixture.workspaceRoot);
  const markerPath = resolve(fixture.workspaceRoot, '.sitewipe-browser-workspace.json');
  await writeFile(
    markerPath,
    canonicalJsonBytes({
      schema: 'sitewipe.browser-workspace.v1',
      purpose: 'SiteWipe synthetic installed-browser runs only'
    })
  );
  await link(markerPath, resolve(fixture.workspaceRoot, '.sitewipe-marker-hardlink.json'));
  const coordinator = await importCoordinatorWithFixtureRevalidation(t);

  await assert.rejects(
    coordinator.prepareApprovedOwnedRun({ plan, approvalSha256: plan.planSha256 }),
    /singly linked regular non-reparse file/
  );
  await assert.rejects(access(resolve(fixture.workspaceRoot, '.sitewipe-active-run.lock')), { code: 'ENOENT' });
});

test('successful completion and failure settlement are mutually exclusive and permanently seal the workspace', async (t) => {
  const { coordinator, fixture, ownedRun, plan } = await preparedFixtureOwnedRun(t, 0xd5);
  const timestamp = '2026-08-24T22:00:00.000Z';
  const resultRecords = [];
  for (const scenario of CANONICAL_BROWSER_MATRIX) {
    for (const browserName of REQUIRED_BROWSERS) {
      const browser = structuredClone(plan.inputs.browserPins.find(({ name }) => name === browserName));
      resultRecords.push(
        createScenarioResultRecord(
          {
            schema: SCENARIO_RESULT_SCHEMA,
            matrixVersion: BROWSER_MATRIX_VERSION,
            matrixSha256: CANONICAL_BROWSER_MATRIX_SHA256,
            semanticValidatorManifestSha256: SEMANTIC_VALIDATOR_MANIFEST_SHA256,
            planSha256: plan.planSha256,
            runId: plan.runId,
            scenarioId: scenario.id,
            browser,
            identity: structuredClone(plan.identity),
            startedAt: timestamp,
            completedAt: timestamp,
            reason: 'Required exact typed observations or canonical validators are absent.',
            evidence: []
          },
          { plan }
        )
      );
    }
  }
  const aggregate = aggregateBrowserEvidence({ plan, resultRecords });
  await writeFile(resolve(ownedRun.runRoot, 'aggregate.json'), canonicalJsonBytes(aggregate));

  const completion = await ownedRun.complete({ detail: 'Exact not-run aggregate retained.' });
  assert.equal(completion.schema, 'sitewipe.owned-browser-run-completion.v1');
  assert.equal(completion.state, 'not_run');
  const terminal = await readTerminal(ownedRun);
  assert.equal(terminal.disposition, 'completion');
  assert.deepEqual(terminal.receipt, completion);
  await access(resolve(fixture.workspaceRoot, '.sitewipe-active-run.lock'));
  await assert.rejects(ownedRun.retainFailure({ detail: 'E'.repeat(64) }), /settlement capability was already used/);
  await assert.rejects(ownedRun.complete(), /settlement capability was already used/);
  await assert.rejects(
    coordinator.prepareApprovedOwnedRun({ plan, approvalSha256: plan.planSha256 }),
    (error) => error?.code === 'EEXIST'
  );
});

async function writeNotRunAggregateForOwnedRun(ownedRun, plan) {
  const timestamp = '2026-08-24T22:00:00.000Z';
  const resultRecords = [];
  for (const scenario of CANONICAL_BROWSER_MATRIX) {
    for (const browserName of REQUIRED_BROWSERS) {
      const browser = structuredClone(plan.inputs.browserPins.find(({ name }) => name === browserName));
      resultRecords.push(
        createScenarioResultRecord(
          {
            schema: SCENARIO_RESULT_SCHEMA,
            matrixVersion: BROWSER_MATRIX_VERSION,
            matrixSha256: CANONICAL_BROWSER_MATRIX_SHA256,
            semanticValidatorManifestSha256: SEMANTIC_VALIDATOR_MANIFEST_SHA256,
            planSha256: plan.planSha256,
            runId: plan.runId,
            scenarioId: scenario.id,
            browser,
            identity: structuredClone(plan.identity),
            startedAt: timestamp,
            completedAt: timestamp,
            reason: 'Required exact typed observations or canonical validators are absent.',
            evidence: []
          },
          { plan }
        )
      );
    }
  }
  const aggregate = aggregateBrowserEvidence({ plan, resultRecords });
  await writeFile(resolve(ownedRun.runRoot, 'aggregate.json'), canonicalJsonBytes(aggregate));
  return aggregate;
}

async function readTerminal(ownedRun) {
  return JSON.parse(await readFile(resolve(ownedRun.runRoot, 'terminal.json'), 'utf8'));
}

async function preparedFixtureOwnedRun(t, randomByte, { sourceTransform } = {}) {
  const fixture = await coordinatorFixture(t);
  const plan = await createUnattendedBrowserPlanFixture({
    ...fixture.inputs,
    createdAt: '2026-08-24T22:00:00.000Z',
    randomBytesFn: () => Buffer.alloc(16, randomByte)
  });
  assert.equal(await revalidateUnattendedBrowserPlanFixture(plan, fixture.inputs), plan);
  const coordinator = await importCoordinatorWithFixtureRevalidation(t, { sourceTransform });
  const ownedRun = await coordinator.prepareApprovedOwnedRun({ plan, approvalSha256: plan.planSha256 });
  return { coordinator, fixture, ownedRun, plan };
}

async function importCoordinatorWithFixtureRevalidation(t, { sourceTransform } = {}) {
  const coordinatorUrl = new URL('./unattended-coordinator.mjs', import.meta.url);
  let source = await readFile(coordinatorUrl, 'utf8');
  source = source.replace(
    /from\s+(['"])(\.\.?\/[^'"]+)\1/g,
    (_match, quote, specifier) => `from ${quote}${new URL(specifier, coordinatorUrl).href}${quote}`
  );
  const directoryDeclaration = 'const directory = dirname(fileURLToPath(import.meta.url));';
  assert.equal(source.split(directoryDeclaration).length - 1, 1);
  source = source.replace(
    directoryDeclaration,
    `const directory = ${JSON.stringify(dirname(fileURLToPath(coordinatorUrl)))};`
  );
  const revalidationCall = 'await revalidateApprovedBrowserPlan(plan);';
  assert.equal(source.split(revalidationCall).length - 1, 1);
  source = source.replace(
    revalidationCall,
    '// Fixture plan identity was independently revalidated before this production settlement-path test.'
  );
  if (sourceTransform) source = sourceTransform(source);

  const moduleRoot = await mkdtemp(resolve(tmpdir(), 'sitewipe-coordinator-settlement-module-'));
  t.after(() => rm(moduleRoot, { recursive: true, force: true }));
  const modulePath = resolve(moduleRoot, 'unattended-coordinator-fixture.mjs');
  await writeFile(modulePath, source);
  return import(pathToFileURL(modulePath).href);
}

async function coordinatorFixture(t) {
  const container = await mkdtemp(resolve(tmpdir(), 'sitewipe-unattended-coordinator-'));
  const repositoryRoot = resolve(container, 'repository');
  const inputsRoot = resolve(container, 'inputs');
  const workspaceRoot = resolve(container, 'browser-runs');
  await mkdir(repositoryRoot);
  await mkdir(inputsRoot);
  t.after(() => rm(container, { recursive: true, force: true }));

  const files = {
    '.gitignore': 'node_modules/',
    'package.json': JSON.stringify({
      name: 'sitewipe-fixture',
      version: '1.11.77',
      devDependencies: { 'puppeteer-core': '25.8.0' }
    }),
    'package-lock.json': fixturePackageLockText(),
    'docs/evidence/version-state.json': JSON.stringify({
      runtimeFingerprintSha256: '7'.repeat(64),
      releaseInputFileCount: 100,
      releaseInputFingerprintSha256: '8'.repeat(64)
    }),
    'scripts/browser-validation-policy.mjs': 'export const fixture = true;\n',
    'scripts/trusted-git.mjs': 'export const fixture = true;\n',
    'tests/browser/fixture-server.mjs': 'export const fixture = true;\n',
    'tests/browser/installed/canonical-matrix.mjs': 'export const fixture = true;\n'
  };
  for (const [path, content] of Object.entries(files)) {
    const target = resolve(repositoryRoot, ...path.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${content}\n`);
  }
  git(repositoryRoot, ['init']);
  git(repositoryRoot, ['config', 'user.name', 'SiteWipe Test']);
  git(repositoryRoot, ['config', 'user.email', 'sitewipe-test@example.invalid']);
  git(repositoryRoot, ['add', '.']);
  git(repositoryRoot, ['commit', '-m', 'fixture']);

  const puppeteerPath = resolve(repositoryRoot, 'node_modules', 'puppeteer-core');
  await mkdir(puppeteerPath, { recursive: true });
  await writeFile(
    resolve(puppeteerPath, 'package.json'),
    `${JSON.stringify({ name: 'puppeteer-core', version: '25.8.0' })}\n`
  );
  await writeFile(resolve(puppeteerPath, 'index.js'), 'export const fixturePuppeteer = true;\n');

  const artifactPath = resolve(inputsRoot, 'sitewipe-unreleased-candidate-1.11.77.zip');
  const bravePath = resolve(inputsRoot, 'brave.exe');
  const chromePath = resolve(inputsRoot, 'chrome.exe');
  await writeFile(artifactPath, 'exact artifact bytes\n');
  await writeFile(bravePath, 'exact brave bytes\n');
  await writeFile(chromePath, 'exact chrome bytes\n');
  const browserPins = [
    {
      name: 'brave',
      executablePath: bravePath,
      version: '151.1.93.138',
      executableSha256: await fileSha(bravePath),
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
      executableSha256: await fileSha(chromePath),
      runtimeRootPath: resolve(inputsRoot, '151.0.7922.174'),
      runtimeVersion: '151.0.7922.174',
      runtimeFileCount: 266,
      runtimeBytes: 514076268,
      runtimeManifestSha256: '2'.repeat(64)
    }
  ];
  return {
    artifactPath,
    workspaceRoot,
    inputs: {
      repositoryRoot,
      workspaceRoot,
      artifact: { path: artifactPath, version: '1.11.77' },
      browserPins
    }
  };
}

function fixturePackageLockText() {
  return JSON.stringify({
    name: 'sitewipe-fixture',
    version: '1.11.77',
    lockfileVersion: 3,
    packages: {
      '': {
        name: 'sitewipe-fixture',
        version: '1.11.77',
        devDependencies: { 'puppeteer-core': '25.8.0' }
      },
      'node_modules/puppeteer-core': { version: '25.8.0' }
    }
  });
}

async function fileSha(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
    .toUpperCase();
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
}

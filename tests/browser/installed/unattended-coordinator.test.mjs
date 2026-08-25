import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import test from 'node:test';

import { createUnattendedBrowserPlan, prepareApprovedOwnedRun } from './unattended-coordinator.mjs';
import { computePlanSha256 } from './evidence-contract.mjs';
import {
  createUnattendedBrowserPlanFixture,
  revalidateUnattendedBrowserPlanFixture
} from './unattended-coordinator-test-support.mjs';

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
      writeFile(resolve(fixture.inputs.repositoryRoot, 'package-lock.json'), `${changedPackageLock}\n`),
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
  assert.equal(
    postCleanCreationPlan.identity.packageLockSha256,
    sha256Text(`${JSON.stringify({ name: 'sitewipe-fixture', version: '1.11.77', lockfileVersion: 3 })}\n`)
  );
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

async function coordinatorFixture(t) {
  const container = await mkdtemp(resolve(tmpdir(), 'sitewipe-unattended-coordinator-'));
  const repositoryRoot = resolve(container, 'repository');
  const inputsRoot = resolve(container, 'inputs');
  const workspaceRoot = resolve(container, 'browser-runs');
  await mkdir(repositoryRoot);
  await mkdir(inputsRoot);
  t.after(() => rm(container, { recursive: true, force: true }));

  const files = {
    'package.json': JSON.stringify({ name: 'sitewipe-fixture', version: '1.11.77' }),
    'package-lock.json': JSON.stringify({ name: 'sitewipe-fixture', version: '1.11.77', lockfileVersion: 3 }),
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

  const artifactPath = resolve(inputsRoot, 'sitewipe-unreleased-candidate-1.11.77.zip');
  const bravePath = resolve(inputsRoot, 'brave.exe');
  const chromePath = resolve(inputsRoot, 'chrome.exe');
  await writeFile(artifactPath, 'exact artifact bytes\n');
  await writeFile(bravePath, 'exact brave bytes\n');
  await writeFile(chromePath, 'exact chrome bytes\n');
  const browserPins = [
    { name: 'brave', executablePath: bravePath, version: '151.1.93.138', executableSha256: await fileSha(bravePath) },
    {
      name: 'chrome',
      executablePath: chromePath,
      version: '151.0.7922.174',
      executableSha256: await fileSha(chromePath)
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

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  INSTALLED_BROWSER_OWNED_RUNS_DIRECTORY,
  INSTALLED_BROWSER_VALIDATION_PLAN_RECEIPT_SCHEMA,
  INSTALLED_BROWSER_VALIDATION_REPOSITORY_ROOT,
  INSTALLED_BROWSER_VALIDATION_RESULT_RECEIPT_SCHEMA,
  INSTALLED_BROWSER_VALIDATION_SUMMARY_SCHEMA,
  createInstalledBrowserValidationCli,
  parseInstalledBrowserValidationArguments
} from '../../scripts/run-installed-browser-validation-core.mjs';
import {
  formatInstalledBrowserValidationRefusal,
  runInstalledBrowserValidationEntrypoint,
  runInstalledBrowserValidationMain
} from '../../scripts/run-installed-browser-validation.mjs';
import { canonicalJsonBytes } from '../browser/installed/evidence-contract.mjs';
import {
  INSTALLED_BROWSER_PUBLIC_PROJECTION_SCHEMA,
  INSTALLED_BROWSER_RUN_SCHEMA
} from '../browser/installed/installed-runner.mjs';

const HASH_A = 'A'.repeat(64);
const HASH_B = 'B'.repeat(64);
const HASH_C = 'C'.repeat(64);
const COMPLETED_AT = '2026-08-25T12:00:00.000Z';

test('create-plan writes one canonical external plan and never approves or runs it', async (t) => {
  const fixture = await createFixture(t);
  const planOutput = join(fixture.externalRoot, 'browser-plan.json');
  const receipt = await fixture.cli({
    argv: createArguments(fixture.externalRoot, planOutput),
    environment: {}
  });

  assert.deepEqual(
    fixture.log.map(({ event }) => event),
    ['create', 'validate']
  );
  assert.equal(receipt.schema, INSTALLED_BROWSER_VALIDATION_PLAN_RECEIPT_SCHEMA);
  assert.equal(receipt.command, 'create-plan');
  assert.equal(receipt.approvalRequired, true);
  assert.equal(receipt.browserExecutionPerformed, false);
  assert.equal(JSON.stringify(receipt).includes(fixture.externalRoot), false);

  const bytes = await readFile(planOutput);
  const plan = JSON.parse(bytes.toString('utf8'));
  assert.equal(bytes.equals(canonicalJsonBytes(plan)), true);
  assert.equal(plan.inputs.repositoryRoot, resolve(INSTALLED_BROWSER_VALIDATION_REPOSITORY_ROOT));
  assert.equal(plan.inputs.workspaceRoot, resolve(fixture.externalRoot, INSTALLED_BROWSER_OWNED_RUNS_DIRECTORY));
  assert.equal(
    fixture.log.some(({ event }) => event === 'revalidate' || event === 'run'),
    false
  );
});

test('run independently reads, validates, explicitly approves, revalidates, and writes only a path-free summary', async (t) => {
  const fixture = await createFixture(t);
  const planInput = join(fixture.externalRoot, 'approved-plan.json');
  const resultOutput = join(fixture.externalRoot, 'public-result.json');
  const plan = fixture.makePlan();
  await writeFile(planInput, canonicalJsonBytes(plan));

  const receipt = await fixture.cli({
    argv: runArguments(fixture.externalRoot, planInput, plan.planSha256, resultOutput),
    environment: {}
  });

  assert.deepEqual(
    fixture.log.map(({ event }) => event),
    ['validate', 'revalidate', 'run']
  );
  assert.equal(receipt.schema, INSTALLED_BROWSER_VALIDATION_RESULT_RECEIPT_SCHEMA);
  assert.equal(receipt.command, 'run');
  assert.equal(receipt.planSha256, plan.planSha256);
  assert.equal(receipt.rawEvidenceRetained, true);
  assert.equal(JSON.stringify(receipt).includes(fixture.externalRoot), false);

  const bytes = await readFile(resultOutput);
  const summary = JSON.parse(bytes.toString('utf8'));
  assert.equal(bytes.equals(canonicalJsonBytes(summary)), true);
  assert.equal(summary.schema, INSTALLED_BROWSER_VALIDATION_SUMMARY_SCHEMA);
  assert.equal(summary.result.schema, INSTALLED_BROWSER_RUN_SCHEMA);
  assert.equal(summary.publicProjection.schema, INSTALLED_BROWSER_PUBLIC_PROJECTION_SCHEMA);
  assert.equal(summary.result.rawEvidenceRetained, true);
  assert.equal(summary.result.automaticRecursiveDeletionPerformed, false);
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes(fixture.externalRoot), false);
  assert.equal(serialized.includes('contentBase64'), false);
  assert.equal(serialized.includes('PRIVATE_RAW_EVIDENCE'), false);
  assert.equal(serialized.includes('executablePath'), false);
});

test('argument parser accepts only the two exact phases and rejects aliases, overrides, duplicates, and omissions', () => {
  const root = resolve(tmpdir(), 'sitewipe-parser-root');
  const plan = resolve(root, 'plan.json');
  const result = resolve(root, 'result.json');
  const approval = 'D'.repeat(64);
  assert.equal(parseInstalledBrowserValidationArguments(createArguments(root, plan)).command, 'create-plan');
  assert.equal(parseInstalledBrowserValidationArguments(runArguments(root, plan, approval, result)).command, 'run');

  const rejected = [
    [],
    ['create', '--workspace-root', root, '--plan-output', plan],
    ['create-plan', `--workspace-root=${root}`, '--plan-output', plan],
    ['create-plan', '--workspace-root', root, '--workspace-root', root],
    ['create-plan', '--workspace-root', root, '--profile', resolve(root, 'profile')],
    ['create-plan', '--workspace-root', root, '--browser', 'chrome'],
    ['create-plan', '--repository-root', INSTALLED_BROWSER_VALIDATION_REPOSITORY_ROOT, '--plan-output', plan],
    ['run', '--workspace-root', root, '--plan-input', plan, '--approval-sha256', approval],
    [
      'run',
      '--workspace-root',
      root,
      '--plan-input',
      plan,
      '--approval-sha256',
      approval.toLowerCase(),
      '--result-output',
      result
    ],
    [...runArguments(root, plan, approval, result), '--profile', resolve(root, 'profile')]
  ];
  for (const argv of rejected) assert.throws(() => parseInstalledBrowserValidationArguments(argv));
});

test('authority-selecting environment variables fail before planning or execution', async (t) => {
  const fixture = await createFixture(t);
  const planOutput = join(fixture.externalRoot, 'browser-plan.json');
  for (const [key, value] of [
    ['SITEWIPE_GIT_EXECUTABLE', 'C:\\untrusted\\git.exe'],
    ['CHROME_PATH', 'C:\\untrusted\\chrome.exe'],
    ['PUPPETEER_EXECUTABLE_PATH', 'C:\\untrusted\\browser.exe'],
    ['NODE_OPTIONS', '--import=C:\\untrusted\\hook.mjs']
  ]) {
    await assert.rejects(
      fixture.cli({ argv: createArguments(fixture.externalRoot, planOutput), environment: { [key]: value } }),
      /environment-selected/i
    );
  }
  assert.deepEqual(fixture.log, []);
});

test('public refusal output exposes only a stable opaque digest and no private diagnostic text', () => {
  const privatePath = 'C:\\Users\\Reviewer\\private-profile\\Default';
  const secret = 'fixture-capability-do-not-print';
  const error = new Error(`Failed to open ${privatePath} with ${secret}`);
  const first = formatInstalledBrowserValidationRefusal(error);
  const second = formatInstalledBrowserValidationRefusal(error);
  assert.equal(first, second);
  assert.match(
    first,
    /^Installed-browser validation refused \[SITEWIPE_BROWSER_VALIDATION_REFUSED:[A-F0-9]{64}\]\. Private diagnostic text was withheld\.\n$/u
  );
  assert.equal(first.includes(privatePath), false);
  assert.equal(first.includes(secret), false);
  assert.equal(first.includes(error.message), false);
  assert.match(formatInstalledBrowserValidationRefusal(undefined), /SITEWIPE_BROWSER_VALIDATION_REFUSED:[A-F0-9]{64}/u);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.match(formatInstalledBrowserValidationRefusal(cyclic), /SITEWIPE_BROWSER_VALIDATION_REFUSED:[A-F0-9]{64}/u);
});

test('dependency-minimal entrypoint catches dynamic core import failure without touching policy or hostile diagnostics', async () => {
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
      getOwnPropertyDescriptor() {
        hostileAccesses.push('getOwnPropertyDescriptor');
        throw new Error('descriptor trap must not run');
      },
      ownKeys() {
        hostileAccesses.push('ownKeys');
        throw new Error('ownKeys trap must not run');
      }
    }
  );
  const stdout = [];
  const stderr = [];
  const exitCode = await runInstalledBrowserValidationEntrypoint({
    argv: ['create-plan'],
    environment: {},
    async loadCore() {
      throw hostile;
    },
    stdout: { write: (value) => stdout.push(value) },
    stderr: { write: (value) => stderr.push(value) }
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(stdout, []);
  assert.equal(stderr.length, 1);
  assert.match(
    stderr[0],
    /^Installed-browser validation refused \[SITEWIPE_BROWSER_VALIDATION_REFUSED:[A-F0-9]{64}\]\. Private diagnostic text was withheld\.\n$/u
  );
  assert.deepEqual(hostileAccesses, []);

  const entrySource = await readFile(
    new URL('../../scripts/run-installed-browser-validation.mjs', import.meta.url),
    'utf8'
  );
  assert.match(entrySource, /import\(CORE_MODULE_URL\)/u);
  assert.doesNotMatch(entrySource, /from ['"].*(?:installed-runner|unattended-coordinator|evidence-contract)/u);
});

test('entrypoint normalizes null and hostile option getters inside its opaque refusal boundary', async () => {
  assert.equal(await runInstalledBrowserValidationEntrypoint(null), 1);

  const privateText = 'C:\\private\\entrypoint-options';
  const stderr = [];
  const options = {
    stderr: { write: (value) => stderr.push(value) }
  };
  Object.defineProperty(options, 'argv', {
    get() {
      throw new Error(privateText);
    }
  });
  const exitCode = await runInstalledBrowserValidationEntrypoint(options);
  assert.equal(exitCode, 1);
  assert.equal(stderr.length, 1);
  assert.match(stderr[0], /SITEWIPE_BROWSER_VALIDATION_REFUSED:[A-F0-9]{64}/u);
  assert.equal(stderr[0].includes(privateText), false);
});

test('main-module resolution and hostile main option getters use the same path-free refusal', async () => {
  for (const options of [
    {
      processArgv: ['node', 'C:\\private\\entry.mjs'],
      moduleUrl: 'file:///expected-entry.mjs',
      resolveMainPath() {
        throw new Error('C:\\private\\main-resolution');
      },
      toFileUrl: (value) => value
    },
    Object.defineProperty({}, 'processArgv', {
      get() {
        throw new Error('C:\\private\\main-options');
      }
    })
  ]) {
    const stderr = [];
    options.stderr = { write: (value) => stderr.push(value) };
    const exitCode = await runInstalledBrowserValidationMain(options);
    assert.equal(exitCode, 1);
    assert.equal(stderr.length, 1);
    assert.match(stderr[0], /SITEWIPE_BROWSER_VALIDATION_REFUSED:[A-F0-9]{64}/u);
    assert.equal(stderr[0].includes('private'), false);
  }
});

test('create-only outputs reject repository paths and overwrite attempts before plan creation', async (t) => {
  const fixture = await createFixture(t);
  const existing = join(fixture.externalRoot, 'existing.json');
  await writeFile(existing, '{}\n');
  await assert.rejects(
    fixture.cli({ argv: createArguments(fixture.externalRoot, existing), environment: {} }),
    /already exists|overwrite/i
  );
  await assert.rejects(
    fixture.cli({
      argv: createArguments(fixture.externalRoot, join(INSTALLED_BROWSER_VALIDATION_REPOSITORY_ROOT, 'plan.json')),
      environment: {}
    }),
    /external workspace|directly inside/i
  );
  await assert.rejects(
    fixture.cli({
      argv: createArguments(INSTALLED_BROWSER_VALIDATION_REPOSITORY_ROOT, join(fixture.externalRoot, 'plan.json')),
      environment: {}
    }),
    /disjoint/i
  );
  assert.deepEqual(fixture.log, []);
});

test('run rejects a mismatched approval before revalidation, execution, or result creation', async (t) => {
  const fixture = await createFixture(t);
  const planInput = join(fixture.externalRoot, 'plan.json');
  const resultOutput = join(fixture.externalRoot, 'result.json');
  await writeFile(planInput, canonicalJsonBytes(fixture.makePlan()));
  await assert.rejects(
    fixture.cli({
      argv: runArguments(fixture.externalRoot, planInput, 'F'.repeat(64), resultOutput),
      environment: {}
    }),
    /does not match/i
  );
  assert.deepEqual(
    fixture.log.map(({ event }) => event),
    ['validate']
  );
  await assert.rejects(readFile(resultOutput), /ENOENT/);
});

test('run rejects noncanonical plans, wrong layout bindings, linked inputs, and existing result targets', async (t) => {
  await t.test('noncanonical JSON', async (t) => {
    const fixture = await createFixture(t);
    const plan = fixture.makePlan();
    const input = join(fixture.externalRoot, 'plan.json');
    const output = join(fixture.externalRoot, 'result.json');
    await writeFile(input, `${JSON.stringify(plan, null, 2)}\n`);
    await assert.rejects(
      fixture.cli({ argv: runArguments(fixture.externalRoot, input, plan.planSha256, output), environment: {} }),
      /canonical JSON representation/i
    );
    assert.deepEqual(fixture.log, []);
  });

  await t.test('wrong owned workspace binding', async (t) => {
    const fixture = await createFixture(t);
    const plan = fixture.makePlan({ workspaceRoot: resolve(fixture.externalRoot, 'caller-profile') });
    const input = join(fixture.externalRoot, 'plan.json');
    const output = join(fixture.externalRoot, 'result.json');
    await writeFile(input, canonicalJsonBytes(plan));
    await assert.rejects(
      fixture.cli({ argv: runArguments(fixture.externalRoot, input, plan.planSha256, output), environment: {} }),
      /paths differ/i
    );
    assert.deepEqual(
      fixture.log.map(({ event }) => event),
      ['validate']
    );
  });

  await t.test('hard-linked plan input', async (t) => {
    const fixture = await createFixture(t);
    const plan = fixture.makePlan();
    const original = join(fixture.externalRoot, 'original.json');
    const linked = join(fixture.externalRoot, 'linked.json');
    const output = join(fixture.externalRoot, 'result.json');
    await writeFile(original, canonicalJsonBytes(plan));
    await link(original, linked);
    await assert.rejects(
      fixture.cli({ argv: runArguments(fixture.externalRoot, linked, plan.planSha256, output), environment: {} }),
      /singly linked/i
    );
    assert.deepEqual(fixture.log, []);
  });

  await t.test('existing result output', async (t) => {
    const fixture = await createFixture(t);
    const plan = fixture.makePlan();
    const input = join(fixture.externalRoot, 'plan.json');
    const output = join(fixture.externalRoot, 'result.json');
    await writeFile(input, canonicalJsonBytes(plan));
    await writeFile(output, '{"ownedBy":"caller"}\n');
    await assert.rejects(
      fixture.cli({ argv: runArguments(fixture.externalRoot, input, plan.planSha256, output), environment: {} }),
      /already exists|overwrite/i
    );
    assert.equal(await readFile(output, 'utf8'), '{"ownedBy":"caller"}\n');
    assert.deepEqual(fixture.log, []);
  });
});

test('run refuses a projection carrying a private path and does not publish a summary', async (t) => {
  const fixture = await createFixture(t, { mutateProjection: privateProjectionMutation });
  const plan = fixture.makePlan();
  const input = join(fixture.externalRoot, 'plan.json');
  const output = join(fixture.externalRoot, 'result.json');
  await writeFile(input, canonicalJsonBytes(plan));
  await assert.rejects(
    fixture.cli({ argv: runArguments(fixture.externalRoot, input, plan.planSha256, output), environment: {} }),
    /forbidden private field|private or unbounded string/i
  );
  assert.deepEqual(
    fixture.log.map(({ event }) => event),
    ['validate', 'revalidate', 'run']
  );
  await assert.rejects(readFile(output), /ENOENT/);
});

async function createFixture(t, options = {}) {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'sitewipe-installed-cli-'));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const externalRoot = join(temporaryRoot, 'external');
  await mkdir(externalRoot);
  const log = [];
  const makePlan = (overrides = {}) =>
    samplePlan({
      repositoryRoot: resolve(INSTALLED_BROWSER_VALIDATION_REPOSITORY_ROOT),
      workspaceRoot: resolve(externalRoot, INSTALLED_BROWSER_OWNED_RUNS_DIRECTORY),
      ...overrides
    });
  const dependencies = {
    async createUnattendedBrowserPlan({ repositoryRoot, workspaceRoot }) {
      log.push({ event: 'create', repositoryRoot, workspaceRoot });
      return samplePlan({ repositoryRoot, workspaceRoot });
    },
    async revalidateApprovedBrowserPlan(plan) {
      log.push({ event: 'revalidate', planSha256: plan.planSha256 });
      validateFakePlan(plan);
      return plan;
    },
    async runInstalledBrowserValidation({ plan, approvalSha256 }) {
      log.push({ event: 'run', planSha256: plan.planSha256, approvalSha256 });
      const result = sampleResult(plan);
      if (options.mutateProjection) options.mutateProjection(result.publicProjection, externalRoot);
      return result;
    },
    validateBrowserPlan(plan) {
      log.push({ event: 'validate', planSha256: plan?.planSha256 });
      return validateFakePlan(plan);
    }
  };
  return {
    cli: createInstalledBrowserValidationCli(dependencies),
    externalRoot,
    log,
    makePlan
  };
}

function samplePlan({ repositoryRoot, workspaceRoot }) {
  const unsigned = {
    schema: 'sitewipe.test-browser-plan.v1',
    runId: 'sitewipe-browser-0123456789abcdef0123456789abcdef',
    matrixVersion: 'sitewipe.test-matrix.v1',
    matrixSha256: HASH_A,
    semanticValidatorManifestSha256: HASH_B,
    requiredBrowsers: ['brave', 'chrome'],
    requiredMatrixIds: ['ART-01'],
    identity: {
      artifactVersion: '1.11.89',
      artifactSha256: HASH_C,
      sourceCommitSha: '1'.repeat(40),
      sourceTreeSha: '2'.repeat(40)
    },
    inputs: {
      repositoryRoot: resolve(repositoryRoot),
      workspaceRoot: resolve(workspaceRoot),
      browserPins: [
        {
          name: 'brave',
          version: '140.0.0.0',
          executableSha256: '4'.repeat(64),
          executablePath: 'C:\\pinned\\brave.exe'
        },
        {
          name: 'chrome',
          version: '140.0.0.0',
          executableSha256: '5'.repeat(64),
          executablePath: 'C:\\pinned\\chrome.exe'
        }
      ]
    }
  };
  return { ...unsigned, planSha256: sha256(canonicalJsonBytes(unsigned)) };
}

function validateFakePlan(plan) {
  assert.ok(plan && typeof plan === 'object' && !Array.isArray(plan));
  assert.match(plan.runId, /^sitewipe-browser-[a-f0-9]{32}$/u);
  assert.match(plan.planSha256, /^[A-F0-9]{64}$/u);
  const unsigned = structuredClone(plan);
  delete unsigned.planSha256;
  assert.equal(plan.planSha256, sha256(canonicalJsonBytes(unsigned)));
  assert.ok(resolve(plan.inputs.repositoryRoot));
  assert.ok(resolve(plan.inputs.workspaceRoot));
  return plan;
}

function sampleResult(plan) {
  const cells = plan.requiredBrowsers.map((browser, index) => ({
    scenarioId: 'ART-01',
    browser,
    state: 'passed',
    implementationStatus: 'implemented',
    resultRecordSha256: String(index + 6).repeat(64),
    assertions: [{ id: 'artifact-authenticity', state: 'passed', validatorId: 'validator.artifact.v1' }]
  }));
  const projection = {
    schema: INSTALLED_BROWSER_PUBLIC_PROJECTION_SCHEMA,
    runId: plan.runId,
    planSha256: plan.planSha256,
    matrixVersion: plan.matrixVersion,
    matrixSha256: plan.matrixSha256,
    semanticValidationStatus: 'implemented',
    semanticValidatorManifestSha256: plan.semanticValidatorManifestSha256,
    identity: structuredClone(plan.identity),
    browsers: plan.inputs.browserPins.map(({ name, version, executableSha256 }) => ({
      name,
      version,
      executableSha256
    })),
    state: 'passed',
    counts: { passed: 2, failed: 0, limited: 0, not_run: 0 },
    cells,
    resultRecordCount: 2,
    resultSetSha256: '8'.repeat(64),
    completion: {
      state: 'passed',
      aggregateSha256: '9'.repeat(64),
      resultSetSha256: '8'.repeat(64),
      resultRecordCount: 2,
      semanticValidationStatus: 'implemented',
      completedAt: COMPLETED_AT,
      retained: true,
      automaticRecursiveDeletionPerformed: false
    },
    networkReconciled: true,
    networkReconciliationFailureCount: 0
  };
  return {
    schema: INSTALLED_BROWSER_RUN_SCHEMA,
    aggregate: {
      runId: plan.runId,
      planSha256: plan.planSha256,
      state: 'passed',
      resultRecordCount: 2,
      resultSetSha256: '8'.repeat(64),
      contentBase64: 'PRIVATE_RAW_EVIDENCE'
    },
    completion: {
      runId: plan.runId,
      planSha256: plan.planSha256,
      state: 'passed',
      aggregateSha256: '9'.repeat(64),
      resultSetSha256: '8'.repeat(64),
      resultRecordCount: 2,
      semanticValidationStatus: 'implemented',
      completedAt: COMPLETED_AT,
      retainedRunRoot: true,
      automaticRecursiveDeletionPerformed: false
    },
    publicProjection: projection
  };
}

function privateProjectionMutation(projection, externalRoot) {
  projection.cells[0].assertions[0].validatorId = join(externalRoot, 'owned-browser-runs', 'private-validator');
}

function createArguments(root, output) {
  return ['create-plan', '--workspace-root', root, '--plan-output', output];
}

function runArguments(root, input, approval, output) {
  return [
    'run',
    '--workspace-root',
    root,
    '--plan-input',
    input,
    '--approval-sha256',
    approval,
    '--result-output',
    output
  ];
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

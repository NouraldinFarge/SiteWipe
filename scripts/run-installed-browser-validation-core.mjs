import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJsonBytes, validateBrowserPlan } from '../tests/browser/installed/evidence-contract.mjs';
import {
  INSTALLED_BROWSER_PUBLIC_PROJECTION_SCHEMA,
  INSTALLED_BROWSER_RUN_SCHEMA,
  runInstalledBrowserValidation
} from '../tests/browser/installed/installed-runner.mjs';
import { semanticValidatorEntry } from '../tests/browser/installed/semantic-validator.mjs';
import {
  createUnattendedBrowserPlan,
  revalidateApprovedBrowserPlan
} from '../tests/browser/installed/unattended-coordinator.mjs';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));

export const INSTALLED_BROWSER_VALIDATION_REPOSITORY_ROOT = resolve(scriptDirectory, '..');
export const INSTALLED_BROWSER_OWNED_RUNS_DIRECTORY = 'owned-browser-runs';
export const INSTALLED_BROWSER_VALIDATION_PLAN_RECEIPT_SCHEMA = 'sitewipe.installed-browser-validation-plan-receipt.v1';
export const INSTALLED_BROWSER_VALIDATION_SUMMARY_SCHEMA = 'sitewipe.installed-browser-validation-summary.v1';
export const INSTALLED_BROWSER_VALIDATION_RESULT_RECEIPT_SCHEMA =
  'sitewipe.installed-browser-validation-result-receipt.v1';

const COMMAND_CREATE = 'create-plan';
const COMMAND_RUN = 'run';
const SHA256_PATTERN = /^[A-F0-9]{64}$/u;
const RESULT_STATES = Object.freeze(['passed', 'failed', 'limited', 'not_run']);
const SEMANTIC_STATUSES = Object.freeze(['implemented', 'partial', 'not_implemented']);
const AUTHORITY_ENVIRONMENT_PATTERN =
  /^(?:SITEWIPE_|PUPPETEER_|PLAYWRIGHT_BROWSERS_PATH$|CHROME_PATH$|BRAVE_PATH$|GOOGLE_CHROME_BIN$|NODE_OPTIONS$|NODE_PATH$)/iu;
const PRIVATE_PUBLIC_FIELD_PATTERN =
  /(?:path|root|token|cookie|storage|base64|content|url|uri|profile|download|fixture|secret|credential)/iu;
const STABLE_PHYSICAL_IDENTITY_KEYS = Object.freeze([
  'dev',
  'ino',
  'mode',
  'nlink',
  'uid',
  'gid',
  'rdev',
  'size',
  'blksize',
  'blocks',
  'mtimeNs',
  'ctimeNs',
  'birthtimeNs'
]);

const DEPENDENCY_KEYS = Object.freeze([
  'createUnattendedBrowserPlan',
  'revalidateApprovedBrowserPlan',
  'runInstalledBrowserValidation',
  'validateBrowserPlan'
]);

export const DEFAULT_INSTALLED_BROWSER_VALIDATION_CLI_DEPENDENCIES = Object.freeze({
  createUnattendedBrowserPlan,
  revalidateApprovedBrowserPlan,
  runInstalledBrowserValidation,
  validateBrowserPlan
});

export function parseInstalledBrowserValidationArguments(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string')) {
    throw new Error('Installed-browser validation arguments must be an array of strings.');
  }
  const command = argv[0];
  const definitions =
    command === COMMAND_CREATE
      ? Object.freeze(['--workspace-root', '--plan-output'])
      : command === COMMAND_RUN
        ? Object.freeze(['--workspace-root', '--plan-input', '--approval-sha256', '--result-output'])
        : null;
  if (definitions === null || argv.length !== 1 + definitions.length * 2) {
    throw new Error(
      'Use exactly create-plan with --workspace-root and --plan-output, or run with --workspace-root, --plan-input, --approval-sha256, and --result-output.'
    );
  }

  const allowed = new Set(definitions);
  const parsed = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !allowed.has(flag) ||
      Object.hasOwn(parsed, flag) ||
      typeof value !== 'string' ||
      !value ||
      value !== value.trim() ||
      value.startsWith('--')
    ) {
      throw new Error(`The ${command} command accepts each exact documented argument once.`);
    }
    parsed[flag] = value;
  }
  if (Object.keys(parsed).length !== definitions.length) {
    throw new Error(`The ${command} command requires its complete exact argument set.`);
  }

  for (const flag of definitions.filter((entry) => entry !== '--approval-sha256')) {
    if (!isAbsolute(parsed[flag])) throw new Error(`${flag} must be an absolute local path.`);
  }
  if (command === COMMAND_RUN && !SHA256_PATTERN.test(parsed['--approval-sha256'])) {
    throw new Error('--approval-sha256 must be one exact uppercase SHA-256 digest.');
  }

  return Object.freeze({
    command,
    workspaceRoot: resolve(parsed['--workspace-root']),
    ...(command === COMMAND_CREATE
      ? { planOutput: resolve(parsed['--plan-output']) }
      : {
          planInput: resolve(parsed['--plan-input']),
          approvalSha256: parsed['--approval-sha256'],
          resultOutput: resolve(parsed['--result-output'])
        })
  });
}

export function createInstalledBrowserValidationCli(dependencies) {
  assertExactKeys(dependencies, DEPENDENCY_KEYS, 'Installed-browser validation CLI dependencies');
  for (const key of DEPENDENCY_KEYS) {
    if (typeof dependencies[key] !== 'function') {
      throw new TypeError(`Installed-browser validation CLI dependency ${key} must be a function.`);
    }
  }
  const exactDependencies = Object.freeze({ ...dependencies });
  return async function execute(options) {
    assertAllowedKeys(options, ['argv', 'environment'], 'Installed-browser validation CLI options');
    const argv = options?.argv;
    const environment = options?.environment ?? process.env;
    assertNoAuthorityEnvironment(environment);
    const parsed = parseInstalledBrowserValidationArguments(argv);
    return parsed.command === COMMAND_CREATE
      ? createPlanCommand(parsed, exactDependencies)
      : runPlanCommand(parsed, exactDependencies);
  };
}

const defaultCli = createInstalledBrowserValidationCli(DEFAULT_INSTALLED_BROWSER_VALIDATION_CLI_DEPENDENCIES);

export async function executeInstalledBrowserValidationCli(options) {
  return defaultCli(options);
}

export async function executeInstalledBrowserValidationCliForEntrypoint(options) {
  return canonicalJsonBytes(await executeInstalledBrowserValidationCli(options));
}

async function createPlanCommand({ workspaceRoot, planOutput }, dependencies) {
  const layout = await validateExternalLayout({ workspaceRoot, outputPath: planOutput, outputLabel: 'Plan output' });
  await assertMissingPath(planOutput, 'Plan output');

  const plan = await dependencies.createUnattendedBrowserPlan({
    repositoryRoot: layout.repository.path,
    workspaceRoot: layout.ownedRunsRoot
  });
  dependencies.validateBrowserPlan(plan);
  assertPlanLayoutBinding(plan, layout);
  await assertExactDirectoryIdentity(layout.external, 'External validation workspace');
  await assertMissingPath(planOutput, 'Plan output');
  await writeExclusiveCanonicalFile(planOutput, canonicalJsonBytes(plan), 'Canonical browser plan', layout.external);

  return deepFreeze({
    schema: INSTALLED_BROWSER_VALIDATION_PLAN_RECEIPT_SCHEMA,
    command: COMMAND_CREATE,
    runId: plan.runId,
    planSha256: plan.planSha256,
    approvalRequired: true,
    browserExecutionPerformed: false
  });
}

async function runPlanCommand({ workspaceRoot, planInput, approvalSha256, resultOutput }, dependencies) {
  const layout = await validateExternalLayout({
    workspaceRoot,
    inputPath: planInput,
    inputLabel: 'Plan input',
    outputPath: resultOutput,
    outputLabel: 'Result output'
  });
  if (samePath(planInput, resultOutput)) throw new Error('Plan input and result output must be distinct files.');
  await assertMissingPath(resultOutput, 'Result output');
  const plan = await readCanonicalPlan(planInput);
  dependencies.validateBrowserPlan(plan);
  assertPlanLayoutBinding(plan, layout);
  if (approvalSha256 !== plan.planSha256) {
    throw new Error('The explicit approval SHA-256 does not match the exact canonical browser plan.');
  }

  await dependencies.revalidateApprovedBrowserPlan(plan);
  await assertExactDirectoryIdentity(layout.external, 'External validation workspace');
  await assertMissingPath(resultOutput, 'Result output');
  const result = await dependencies.runInstalledBrowserValidation({ plan, approvalSha256 });
  const publicProjection = validateRunnerResult(result, plan);
  const summary = createPathFreeSummary(result.schema, publicProjection);
  assertPathFreePublicValue(summary);

  await assertExactDirectoryIdentity(layout.external, 'External validation workspace');
  await assertMissingPath(resultOutput, 'Result output');
  await writeExclusiveCanonicalFile(
    resultOutput,
    canonicalJsonBytes(summary),
    'Public browser-validation summary',
    layout.external
  );

  return deepFreeze({
    schema: INSTALLED_BROWSER_VALIDATION_RESULT_RECEIPT_SCHEMA,
    command: COMMAND_RUN,
    runId: summary.result.runId,
    planSha256: summary.result.planSha256,
    state: summary.result.state,
    resultRecordCount: summary.result.resultRecordCount,
    resultSetSha256: summary.result.resultSetSha256,
    networkReconciled: summary.result.networkReconciled,
    rawEvidenceRetained: true
  });
}

async function validateExternalLayout({ workspaceRoot, inputPath, inputLabel, outputPath, outputLabel }) {
  const repository = await exactPhysicalDirectory(
    INSTALLED_BROWSER_VALIDATION_REPOSITORY_ROOT,
    'Installed-browser repository root'
  );
  const external = await exactPhysicalDirectory(workspaceRoot, 'External validation workspace');
  if (pathsOverlap(repository.path, external.path)) {
    throw new Error('External validation workspace must be physically disjoint from the source repository.');
  }
  const ownedRunsRoot = resolve(external.path, INSTALLED_BROWSER_OWNED_RUNS_DIRECTORY);
  await assertMissingOrExactPhysicalDirectory(ownedRunsRoot, 'Owned browser-runs workspace');
  if (inputPath !== undefined) await assertDirectExternalJsonFile(inputPath, external.path, inputLabel);
  await assertDirectExternalJsonFile(outputPath, external.path, outputLabel);
  return Object.freeze({ repository, external, ownedRunsRoot });
}

async function assertDirectExternalJsonFile(value, externalRoot, label) {
  const exact = resolve(value);
  if (!isAbsolute(value) || !samePath(dirname(exact), externalRoot) || extname(exact).toLowerCase() !== '.json') {
    throw new Error(`${label} must be an absolute .json file directly inside the exact external workspace.`);
  }
}

async function readCanonicalPlan(planPath) {
  const identity = await exactPhysicalFile(planPath, 'Canonical browser plan');
  let plan;
  try {
    plan = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(identity.bytes));
  } catch (error) {
    throw new Error('Canonical browser plan must contain exact UTF-8 JSON.', { cause: error });
  }
  if (!identity.bytes.equals(canonicalJsonBytes(plan))) {
    throw new Error('Canonical browser plan bytes are not in the exact canonical JSON representation.');
  }
  return plan;
}

function assertPlanLayoutBinding(plan, layout) {
  if (
    !samePath(plan?.inputs?.repositoryRoot, layout.repository.path) ||
    !samePath(plan?.inputs?.workspaceRoot, layout.ownedRunsRoot)
  ) {
    throw new Error('Browser plan paths differ from the fixed repository and exact external workspace binding.');
  }
}

function validateRunnerResult(result, plan) {
  assertExactKeys(result, ['aggregate', 'completion', 'publicProjection', 'schema'], 'Installed-browser result');
  if (result.schema !== INSTALLED_BROWSER_RUN_SCHEMA) {
    throw new Error('Installed-browser result uses an unexpected schema.');
  }
  const projection = result.publicProjection;
  assertExactKeys(
    projection,
    [
      'browsers',
      'cells',
      'completion',
      'counts',
      'identity',
      'matrixSha256',
      'matrixVersion',
      'networkReconciled',
      'networkReconciliationFailureCount',
      'planSha256',
      'resultRecordCount',
      'resultSetSha256',
      'runId',
      'schema',
      'semanticValidationStatus',
      'semanticValidatorManifestSha256',
      'state'
    ],
    'Installed-browser public projection'
  );
  if (
    projection.schema !== INSTALLED_BROWSER_PUBLIC_PROJECTION_SCHEMA ||
    projection.runId !== plan.runId ||
    projection.planSha256 !== plan.planSha256 ||
    projection.matrixVersion !== plan.matrixVersion ||
    projection.matrixSha256 !== plan.matrixSha256 ||
    projection.semanticValidatorManifestSha256 !== plan.semanticValidatorManifestSha256 ||
    stableJson(projection.identity) !== stableJson(plan.identity) ||
    !RESULT_STATES.includes(projection.state) ||
    !SEMANTIC_STATUSES.includes(projection.semanticValidationStatus) ||
    !SHA256_PATTERN.test(String(projection.resultSetSha256 || '')) ||
    !Number.isSafeInteger(projection.resultRecordCount) ||
    projection.resultRecordCount < 0 ||
    typeof projection.networkReconciled !== 'boolean' ||
    !Number.isSafeInteger(projection.networkReconciliationFailureCount) ||
    projection.networkReconciliationFailureCount < 0
  ) {
    throw new Error('Installed-browser public projection is not bound to the exact approved plan and result.');
  }

  const expectedBrowsers = plan.inputs.browserPins.map(({ name, version, executableSha256 }) => ({
    name,
    version,
    executableSha256
  }));
  if (stableJson(projection.browsers) !== stableJson(expectedBrowsers)) {
    throw new Error('Installed-browser public projection changed its exact browser identities.');
  }
  validateProjectionCountsAndCells(projection, plan);
  validateProjectionCompletion(projection);
  assertPrivateResultBinding(result, projection);
  assertPathFreePublicValue(projection);
  return deepFreeze(structuredClone(projection));
}

function validateProjectionCountsAndCells(projection, plan) {
  assertExactKeys(projection.counts, RESULT_STATES, 'Installed-browser projection counts');
  if (
    Object.values(projection.counts).some((value) => !Number.isSafeInteger(value) || value < 0) ||
    !Array.isArray(projection.cells) ||
    projection.cells.length !== projection.resultRecordCount ||
    Object.values(projection.counts).reduce((sum, value) => sum + value, 0) !== projection.cells.length
  ) {
    throw new Error('Installed-browser projection counts do not bind its exact result cells.');
  }
  const expectedCells = new Set(
    plan.requiredMatrixIds.flatMap((scenarioId) => plan.requiredBrowsers.map((browser) => `${scenarioId}\0${browser}`))
  );
  const observedCells = new Set();
  for (const cell of projection.cells) {
    assertExactKeys(
      cell,
      ['assertions', 'browser', 'implementationStatus', 'resultRecordSha256', 'scenarioId', 'state'],
      'Installed-browser projection cell'
    );
    const key = `${cell.scenarioId}\0${cell.browser}`;
    if (
      !expectedCells.has(key) ||
      observedCells.has(key) ||
      !RESULT_STATES.includes(cell.state) ||
      !SEMANTIC_STATUSES.includes(cell.implementationStatus) ||
      (cell.resultRecordSha256 !== null && !SHA256_PATTERN.test(String(cell.resultRecordSha256))) ||
      !Array.isArray(cell.assertions)
    ) {
      throw new Error('Installed-browser projection cell is malformed, duplicated, or outside the exact matrix.');
    }
    observedCells.add(key);
    for (const assertion of cell.assertions) {
      assertExactKeys(assertion, ['id', 'state', 'validatorId'], 'Installed-browser projection assertion');
      let expectedValidatorId;
      try {
        expectedValidatorId = semanticValidatorEntry(cell.scenarioId, assertion.id).validatorId;
      } catch {
        throw new Error('Installed-browser projection assertion is outside the exact semantic-validator manifest.');
      }
      if (
        typeof assertion.id !== 'string' ||
        !assertion.id ||
        !RESULT_STATES.includes(assertion.state) ||
        assertion.validatorId !== expectedValidatorId ||
        (expectedValidatorId === null && assertion.state !== 'not_run')
      ) {
        throw new Error('Installed-browser projection assertion is malformed.');
      }
    }
  }
  if (observedCells.size !== expectedCells.size) {
    throw new Error('Installed-browser projection does not cover the exact approved matrix.');
  }
}

function validateProjectionCompletion(projection) {
  const completion = projection.completion;
  assertExactKeys(
    completion,
    [
      'aggregateSha256',
      'automaticRecursiveDeletionPerformed',
      'completedAt',
      'resultRecordCount',
      'resultSetSha256',
      'retained',
      'semanticValidationStatus',
      'state'
    ],
    'Installed-browser projection completion'
  );
  if (
    completion.state !== projection.state ||
    completion.resultSetSha256 !== projection.resultSetSha256 ||
    completion.resultRecordCount !== projection.resultRecordCount ||
    completion.semanticValidationStatus !== projection.semanticValidationStatus ||
    !SHA256_PATTERN.test(String(completion.aggregateSha256 || '')) ||
    !isIsoTimestamp(completion.completedAt) ||
    completion.retained !== true ||
    completion.automaticRecursiveDeletionPerformed !== false
  ) {
    throw new Error('Installed-browser public completion is not an exact retained result binding.');
  }
}

function assertPrivateResultBinding(result, projection) {
  const aggregate = result.aggregate;
  const completion = result.completion;
  if (
    !aggregate ||
    !completion ||
    aggregate.runId !== projection.runId ||
    aggregate.planSha256 !== projection.planSha256 ||
    aggregate.state !== projection.state ||
    aggregate.resultRecordCount !== projection.resultRecordCount ||
    aggregate.resultSetSha256 !== projection.resultSetSha256 ||
    completion.runId !== projection.runId ||
    completion.planSha256 !== projection.planSha256 ||
    completion.state !== projection.completion.state ||
    completion.resultRecordCount !== projection.completion.resultRecordCount ||
    completion.resultSetSha256 !== projection.completion.resultSetSha256 ||
    completion.aggregateSha256 !== projection.completion.aggregateSha256 ||
    completion.completedAt !== projection.completion.completedAt ||
    completion.retainedRunRoot !== true ||
    completion.automaticRecursiveDeletionPerformed !== false
  ) {
    throw new Error('Installed-browser public projection differs from the retained private run result.');
  }
}

function createPathFreeSummary(executionSchema, projection) {
  return deepFreeze({
    schema: INSTALLED_BROWSER_VALIDATION_SUMMARY_SCHEMA,
    result: {
      schema: executionSchema,
      runId: projection.runId,
      planSha256: projection.planSha256,
      state: projection.state,
      resultRecordCount: projection.resultRecordCount,
      resultSetSha256: projection.resultSetSha256,
      completedAt: projection.completion.completedAt,
      networkReconciled: projection.networkReconciled,
      networkReconciliationFailureCount: projection.networkReconciliationFailureCount,
      rawEvidenceRetained: true,
      automaticRecursiveDeletionPerformed: false
    },
    publicProjection: structuredClone(projection)
  });
}

function assertPathFreePublicValue(value) {
  const visit = (current, keyPath) => {
    if (typeof current === 'string') {
      if (
        current.length > 512 ||
        containsForbiddenControlCharacter(current) ||
        /^[a-z]:[\\/]/iu.test(current) ||
        /^\\\\/u.test(current) ||
        /^\/(?:Users|home|tmp|var)(?:\/|$)/u.test(current) ||
        /^(?:file|chrome-extension|https?):/iu.test(current) ||
        current.includes('://')
      ) {
        throw new Error(`Public browser-validation output contains a private or unbounded string at ${keyPath}.`);
      }
      return;
    }
    if (!current || typeof current !== 'object') return;
    if (Array.isArray(current)) {
      current.forEach((child, index) => visit(child, `${keyPath}[${index}]`));
      return;
    }
    for (const [key, child] of Object.entries(current)) {
      if (PRIVATE_PUBLIC_FIELD_PATTERN.test(key)) {
        throw new Error(`Public browser-validation output contains forbidden private field ${keyPath}.${key}.`);
      }
      visit(child, `${keyPath}.${key}`);
    }
  };
  visit(value, 'summary');
}

function assertNoAuthorityEnvironment(environment) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new Error('Installed-browser validation environment must be one string map.');
  }
  const forbidden = Object.entries(environment)
    .filter(([key, value]) => AUTHORITY_ENVIRONMENT_PATTERN.test(key) && value !== undefined && value !== '')
    .map(([key]) => key)
    .sort();
  if (forbidden.length > 0) {
    throw new Error(`Environment-selected browser validation authority is prohibited: ${forbidden.join(', ')}.`);
  }
}

function containsForbiddenControlCharacter(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code < 32 && code !== 9 && code !== 10 && code !== 13;
  });
}

async function exactPhysicalDirectory(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${label} must be an absolute local path.`);
  const expected = resolve(value);
  const information = await lstat(expected, { bigint: true });
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error(`${label} must be one physical non-link directory.`);
  }
  const actual = await realpath(expected);
  if (!samePath(actual, expected)) throw new Error(`${label} must not be an alias or link.`);
  const after = await lstat(expected, { bigint: true });
  if (!after.isDirectory() || after.isSymbolicLink() || !sameDirectoryIdentity(information, after)) {
    throw new Error(`${label} identity changed while it was resolved.`);
  }
  return Object.freeze({ path: expected, information: after });
}

async function assertMissingOrExactPhysicalDirectory(value, label) {
  try {
    await exactPhysicalDirectory(value, label);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function exactPhysicalFile(value, label) {
  const expected = resolve(value);
  const actual = await realpath(expected);
  if (!samePath(actual, expected)) throw new Error(`${label} must not be an alias or link.`);
  const before = await lstat(expected, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
    throw new Error(`${label} must be one singly linked physical file.`);
  }
  const handle = await open(expected, constants.O_RDONLY);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1n) {
      throw new Error(`${label} opened handle is not one singly linked file.`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const finalPath = await lstat(expected, { bigint: true });
    const finalRealPath = await realpath(expected);
    if (
      after.nlink !== 1n ||
      finalPath.nlink !== 1n ||
      !finalPath.isFile() ||
      finalPath.isSymbolicLink() ||
      !samePath(finalRealPath, expected) ||
      !sameFileIdentity(before, opened) ||
      !sameFileIdentity(opened, after) ||
      !sameFileIdentity(after, finalPath) ||
      after.size !== BigInt(bytes.length)
    ) {
      throw new Error(`${label} identity changed while it was read.`);
    }
    return Object.freeze({ path: expected, information: after, bytes });
  } finally {
    await handle.close();
  }
}

async function assertExactDirectoryIdentity(identity, label) {
  const observed = await exactPhysicalDirectory(identity.path, label);
  if (!sameDirectoryIdentity(identity.information, observed.information)) {
    throw new Error(`${label} identity changed during validation.`);
  }
}

async function assertMissingPath(value, label) {
  try {
    await lstat(value);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`${label} already exists; create-only output refuses overwrite.`);
}

async function writeExclusiveCanonicalFile(value, bytes, label, parentIdentity) {
  if (!parentIdentity || !samePath(dirname(resolve(value)), parentIdentity.path)) {
    throw new Error(`${label} must remain a direct child of its exact approved parent.`);
  }
  await assertExactDirectoryIdentity(parentIdentity, `${label} parent directory`);
  const content = Buffer.from(bytes);
  // Node cannot create a child relative to a retained parent handle portably. O_EXCL
  // plus retained child-handle and exact-parent checks bounds/detects this path race.
  const handle = await open(value, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
  let writtenIdentity;
  try {
    await handle.writeFile(content);
    await handle.sync();
    writtenIdentity = await handle.stat({ bigint: true });
    if (!writtenIdentity.isFile() || writtenIdentity.isSymbolicLink() || writtenIdentity.nlink !== 1n) {
      throw new Error(`${label} must remain one singly linked regular file.`);
    }
    const verifiedBytes = Buffer.alloc(content.length);
    const read = await handle.read(verifiedBytes, 0, verifiedBytes.length, 0);
    const afterRead = await handle.stat({ bigint: true });
    const childPath = await lstat(value, { bigint: true });
    const childRealPath = await realpath(value);
    await assertExactDirectoryIdentity(parentIdentity, `${label} parent directory during create`);
    if (
      read.bytesRead !== content.length ||
      !verifiedBytes.equals(content) ||
      !sameFileIdentity(writtenIdentity, afterRead) ||
      !sameFileIdentity(afterRead, childPath) ||
      childPath.nlink !== 1n ||
      !samePath(childRealPath, resolve(value))
    ) {
      throw new Error(`${label} changed across retained-handle child and parent validation.`);
    }
  } finally {
    await handle.close();
  }
  const observed = await exactPhysicalFile(value, label);
  if (!sameFileIdentity(writtenIdentity, observed.information) || !observed.bytes.equals(content)) {
    throw new Error(`${label} changed after its create-only write.`);
  }
  await assertExactDirectoryIdentity(parentIdentity, `${label} parent directory`);
  if (!samePath(dirname(observed.path), parentIdentity.path)) {
    throw new Error(`${label} escaped its exact approved parent during creation.`);
  }
}

function pathsOverlap(left, right) {
  return samePath(left, right) || isDescendant(left, right) || isDescendant(right, left);
}

function isDescendant(parent, child) {
  const relationship = relative(resolve(parent), resolve(child));
  return (
    Boolean(relationship) && relationship !== '..' && !relationship.startsWith(`..${sep}`) && !isAbsolute(relationship)
  );
}

function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function sameFileIdentity(left, right) {
  if (!left || !right || left.isFile() !== right.isFile() || left.isDirectory() !== right.isDirectory()) return false;
  return STABLE_PHYSICAL_IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

function sameDirectoryIdentity(left, right) {
  if (!left || !right || !left.isDirectory() || !right.isDirectory()) return false;
  return ['dev', 'ino', 'mode', 'nlink', 'uid', 'gid', 'rdev'].every((key) => left[key] === right[key]);
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  if (stableJson(Object.keys(value).sort()) !== stableJson([...expected].sort())) {
    throw new Error(`${label} keys differ from the exact schema.`);
  }
}

function assertAllowedKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) throw new Error(`${label} contains unexpected fields: ${unexpected.join(', ')}.`);
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

function isIsoTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(value) && !Number.isNaN(Date.parse(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

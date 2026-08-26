import { createHash, randomUUID } from 'node:crypto';
import { lstat as nativeLstat, link, open, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import { assertTrustedGitRepository } from './trusted-git.mjs';

const EXACT_STAT_OPTIONS = Object.freeze({ bigint: true });
const LOCK_SCHEMA = 'sitewipe.file-transaction-lock.v4';
const JOURNAL_SCHEMA = 'sitewipe.file-transaction-journal.v4';
const MARKER_SCHEMA = 'sitewipe.file-transaction-commit.v4';
const TERMINAL_SCHEMA = 'sitewipe.file-transaction-terminal.v4';
const CONTROL_IDENTITY_KEYS = Object.freeze(['repositoryId', 'transactionDigest', 'transactionId', 'transactionName']);
const LOCK_KEYS = Object.freeze([...CONTROL_IDENTITY_KEYS, 'entries', 'inputs', 'schema']);
const JOURNAL_KEYS = LOCK_KEYS;
const MARKER_KEYS = Object.freeze(['repositoryId', 'schema', 'transactionDigest', 'transactionId']);
const TERMINAL_KEYS = Object.freeze([...CONTROL_IDENTITY_KEYS, 'entries', 'inputs', 'outcome', 'schema']);
const JOURNAL_ENTRY_KEYS = Object.freeze([
  'operation',
  'originalBytes',
  'originalMode',
  'originalSha256',
  'path',
  'stagedBytes',
  'stagedMode',
  'stagedSha256'
]);
const INPUT_RECORD_KEYS = Object.freeze(['bytes', 'path', 'sha256']);

export const FILE_TRANSACTION_DURABILITY_LIMITATION =
  'This is a bounded userspace multi-file recovery protocol, not an atomic multi-file filesystem commit; successful file-handle sync does not prove parent-directory-entry durability.';

/**
 * Performs an early read-only refusal check. The later exclusive lock create is
 * still authoritative because another process can start after this check.
 */
export async function assertFileTransactionCanStart(
  root,
  transactionName = 'sitewipe-version-bump',
  { testOnlyControlDirectory = undefined } = {}
) {
  const context = await transactionContext(root, transactionName, testOnlyControlDirectory);
  await assertTransactionControlAvailable(context);
  return true;
}

/**
 * Explicitly recovers one retained transaction. The caller must independently
 * provide the exact target/operation allowlist. A missing, malformed, foreign,
 * or non-canonical control record is never repaired, replaced, or interpreted
 * as authority to mutate a worktree path.
 */
export async function recoverFileTransaction(
  root,
  transactionName = 'sitewipe-version-bump',
  {
    expectedOperations = undefined,
    testOnlyAfterPreflight = undefined,
    testOnlyControlDirectory = undefined,
    testOnlyCrashAfter = null
  } = {}
) {
  const context = await transactionContext(root, transactionName, testOnlyControlDirectory);
  const expected = normalizeExpectedOperations(context.root.path, expectedOperations);
  const terminal = await readCanonicalControlRecordIfPresent(
    context.paths.terminal,
    'Retained transaction terminal record',
    validateTerminal
  );
  if (terminal) {
    return recoverTerminalTransaction(context, expected, terminal, testOnlyCrashAfter);
  }

  const lock = await readCanonicalControlRecordIfPresent(context.paths.lock, 'Retained transaction lock', validateLock);
  if (!lock) {
    if ((await lstatIfPresent(context.paths.journal)) || (await lstatIfPresent(context.paths.marker))) {
      throw new Error('Foreign retained transaction control state exists without its owning lock.');
    }
    return Object.freeze({ recovered: false });
  }
  validatePrimaryControl(context, lock.value, expected, 'Retained transaction lock');
  const journal = await readCanonicalControlRecordIfPresent(
    context.paths.journal,
    'Retained transaction journal',
    validateJournal
  );
  if (journal) {
    if (!exactOperationAllowlist(journal.value.entries, expected)) {
      throw new Error('Retained transaction journal differs from the exact expected target/operation allowlist.');
    }
    validateControlBinding(context, lock.value, journal.value);
  }
  const derived = await deriveRecoveryEntries(context, lock.value.entries, lock.value.transactionId);
  const marker = await readCanonicalControlRecordIfPresent(
    context.paths.marker,
    'Retained transaction commit marker',
    validateMarker
  );
  if (marker) validateMarkerBinding(context, lock.value, marker.value);

  const plan = await preflightRecovery(derived, Boolean(marker));
  await runTestOnlyTransactionHook(testOnlyAfterPreflight, 'after-preflight');
  await replayRetainedRecoveryControls(context, { journal, lock, marker });
  for (const action of plan) {
    await replayRetainedRecoveryControls(context, { journal, lock, marker });
    await applyRecoveryAction(action);
  }
  await verifyRecoveredState(derived, Boolean(marker));
  await replayRetainedRecoveryControls(context, { journal, lock, marker });
  const outcome = marker ? 'committed' : 'rolledBack';
  const terminalValue = terminalControlValue(lock.value, outcome);
  const retainedTerminal = await writeCanonicalControlRecord(
    context.paths.terminal,
    terminalValue,
    'Retained transaction terminal record',
    validateTerminal
  );
  await finishTerminalCleanup(context, { journal, lock, marker, terminal: retainedTerminal }, testOnlyCrashAfter);

  return Object.freeze({
    committed: outcome === 'committed',
    entries: derived.length,
    recovered: true,
    durabilityLimitation: FILE_TRANSACTION_DURABILITY_LIMITATION
  });
}

export async function transactionalWriteFiles(
  root,
  updates,
  transactionName = 'sitewipe-version-bump',
  {
    createOnlyPaths = new Set(),
    expectedOriginals = undefined,
    expectedInputSnapshot = undefined,
    resolveInputPaths = undefined,
    testOnlyAfterInputCapture = undefined,
    testOnlyControlDirectory = undefined,
    testOnlyCrashAfter = null
  } = {}
) {
  const context = await transactionContext(root, transactionName, testOnlyControlDirectory);
  await assertTransactionControlAvailable(context);
  const prepared = await prepareEntries(context, updates, createOnlyPaths, expectedOriginals);
  const transactionId = randomUUID();
  const entries = prepared.map((entry) => ({ ...entry, ...derivedPaths(entry.target, transactionId) }));
  assertDisjointTransactionPaths(entries);
  const inputPlan = normalizeExpectedInputSnapshot(
    context.root.path,
    expectedInputSnapshot,
    resolveInputPaths,
    entries
  );
  const transientRepoPaths = transactionTransientRepoPaths(context.root.path, entries);

  const journalEntries = entries.map(({ operation, original, repoPath, staged }) => ({
    operation,
    originalBytes: original ? original.bytes.length : null,
    originalMode: original ? original.mode : null,
    originalSha256: original ? original.sha256 : null,
    path: repoPath,
    stagedBytes: staged.bytes.length,
    stagedMode: staged.mode,
    stagedSha256: staged.sha256
  }));
  const inputRecords = inputPlan.inputs.map(({ bytes, repoPath, sha256: digest }) => ({
    bytes: bytes.length,
    path: repoPath,
    sha256: digest
  }));
  const digest = transactionDigest({
    entries: journalEntries,
    inputs: inputRecords,
    repositoryId: context.repositoryId,
    transactionId,
    transactionName: context.transactionName
  });
  const lockValue = {
    entries: journalEntries,
    inputs: inputRecords,
    repositoryId: context.repositoryId,
    schema: LOCK_SCHEMA,
    transactionDigest: digest,
    transactionId,
    transactionName: context.transactionName
  };
  const journalValue = { ...lockValue, entries: journalEntries, schema: JOURNAL_SCHEMA };
  const markerValue = {
    repositoryId: context.repositoryId,
    schema: MARKER_SCHEMA,
    transactionDigest: digest,
    transactionId
  };
  let lockAcquired = false;
  let journalCreated = false;
  let lockRecord;
  let journalRecord;
  let markerRecord;
  let readOnlyInputs;

  try {
    await revalidateTransactionContext(context);
    try {
      lockRecord = await writeCanonicalControlRecord(
        context.paths.lock,
        lockValue,
        'Retained transaction lock',
        validateLock
      );
      lockAcquired = true;
    } catch (error) {
      if (error?.code === 'EEXIST' || error?.cause?.code === 'EEXIST') {
        throw Object.assign(
          new Error(
            'A concurrent or stale retained transaction lock exists; automatic lock breaking and recovery are prohibited.',
            { cause: error }
          ),
          { code: 'SITEWIPE_RETAINED_LOCK' }
        );
      }
      throw error;
    }

    if (
      (await lstatIfPresent(context.paths.journal)) ||
      (await lstatIfPresent(context.paths.marker)) ||
      (await lstatIfPresent(context.paths.terminal))
    ) {
      await removeBoundControlFile(context.paths.lock, lockRecord, 'Retained transaction lock');
      throw Object.assign(new Error('Foreign retained transaction control state exists without its owning lock.'), {
        code: 'SITEWIPE_FOREIGN_CONTROL'
      });
    }
    await revalidateTransactionContext(context);
    readOnlyInputs = await captureReadOnlyInputs(context, inputPlan, transientRepoPaths);
    await runTestOnlyTransactionHook(testOnlyAfterInputCapture, 'after-input-capture', 'testOnlyAfterInputCapture');
    await replayReadOnlyInputs(context, inputPlan, readOnlyInputs, transientRepoPaths);
    journalRecord = await writeCanonicalControlRecord(
      context.paths.journal,
      journalValue,
      'Retained transaction journal',
      validateJournal
    );
    journalCreated = true;
    maybeCrash(testOnlyCrashAfter, 'journal');

    for (const entry of entries) {
      await replayOwnedActiveControls(context, lockRecord, journalRecord);
      await replayReadOnlyInputs(context, inputPlan, readOnlyInputs, transientRepoPaths);
      if ((await lstatIfPresent(entry.temp)) || (await lstatIfPresent(entry.backup))) {
        throw new Error(`Derived transaction staging path already exists: ${entry.repoPath}.`);
      }
      await revalidateDirectories(entry.directories);
      const stored = await writeExactExclusiveTransactionFile(
        entry.temp,
        entry.staged.bytes,
        `Transactional staged file ${entry.repoPath}`,
        { createMode: entry.staged.mode, enforceMode: true }
      );
      entry.staged = Object.freeze({ ...entry.staged, information: stored.information });
    }
    maybeCrash(testOnlyCrashAfter, 'staging');

    for (const [index, entry] of entries.entries()) {
      await replayOwnedActiveControls(context, lockRecord, journalRecord);
      await replayReadOnlyInputs(context, inputPlan, readOnlyInputs, transientRepoPaths);
      await promoteEntry(entry);
      if (index === 0) maybeCrash(testOnlyCrashAfter, 'first-promotion');
    }
    await revalidateTransactionContext(context);
    await replayOwnedActiveControls(context, lockRecord, journalRecord);
    await replayReadOnlyInputs(context, inputPlan, readOnlyInputs, transientRepoPaths);
    markerRecord = await writeCanonicalControlRecord(
      context.paths.marker,
      markerValue,
      'Retained transaction commit marker',
      validateMarker
    );
    maybeCrash(testOnlyCrashAfter, 'marker');

    for (const entry of entries) {
      await replayOwnedActiveControls(context, lockRecord, journalRecord, markerRecord);
      await cleanCommittedEntry(entry);
    }
    await verifyCommittedPreparedState(entries);
    await replayOwnedActiveControls(context, lockRecord, journalRecord, markerRecord);
    const terminalRecord = await writeCanonicalControlRecord(
      context.paths.terminal,
      terminalControlValue(lockValue, 'committed'),
      'Retained transaction terminal record',
      validateTerminal
    );
    await finishTerminalCleanup(
      context,
      { journal: journalRecord, lock: lockRecord, marker: markerRecord, terminal: terminalRecord },
      testOnlyCrashAfter
    );
    return Object.freeze({
      durabilityLimitation: FILE_TRANSACTION_DURABILITY_LIMITATION,
      filesUpdated: entries.length,
      transactionId
    });
  } catch (error) {
    if (
      error?.code === 'SITEWIPE_TEST_CRASH' ||
      error?.code === 'SITEWIPE_RETAINED_LOCK' ||
      error?.code === 'SITEWIPE_FOREIGN_CONTROL'
    ) {
      throw error;
    }
    if (journalCreated || lockAcquired) {
      throw Object.assign(
        new Error(
          'File transaction failed with retained exact control state; automatic recovery is prohibited and explicit recovery is required.',
          { cause: error }
        ),
        { code: 'SITEWIPE_RECOVERY_REQUIRED' }
      );
    }
    throw new Error(
      'File transaction failed before exclusive control ownership was proven; no automatic cleanup or recovery was attempted.',
      { cause: error }
    );
  }
}

async function assertTransactionControlAvailable(context) {
  await revalidateTransactionContext(context);
  if (await lstatIfPresent(context.paths.lock)) {
    throw Object.assign(
      new Error(
        'A concurrent or stale retained transaction lock exists; automatic lock breaking and recovery are prohibited.'
      ),
      { code: 'SITEWIPE_RETAINED_LOCK' }
    );
  }
  if (
    (await lstatIfPresent(context.paths.journal)) ||
    (await lstatIfPresent(context.paths.marker)) ||
    (await lstatIfPresent(context.paths.terminal))
  ) {
    throw Object.assign(new Error('Foreign retained transaction control state exists without its owning lock.'), {
      code: 'SITEWIPE_FOREIGN_CONTROL'
    });
  }
}

async function recoverTerminalTransaction(context, expected, terminal, testOnlyCrashAfter) {
  validatePrimaryControl(context, terminal.value, expected, 'Retained transaction terminal record');
  const lock = await readCanonicalControlRecordIfPresent(context.paths.lock, 'Retained transaction lock', validateLock);
  const journal = await readCanonicalControlRecordIfPresent(
    context.paths.journal,
    'Retained transaction journal',
    validateJournal
  );
  const marker = await readCanonicalControlRecordIfPresent(
    context.paths.marker,
    'Retained transaction commit marker',
    validateMarker
  );
  if (lock) validateControlBinding(context, terminal.value, lock.value);
  if (journal) validateControlBinding(context, terminal.value, journal.value);
  if (marker) validateMarkerBinding(context, terminal.value, marker.value);
  const committed = terminal.value.outcome === 'committed';
  if (!validTerminalControlCombination({ committed, journal, lock, marker })) {
    throw new Error('Retained terminal record has an impossible exact control-cleanup state.');
  }
  const derived = await deriveRecoveryEntries(context, terminal.value.entries, terminal.value.transactionId);
  await verifyRecoveredState(derived, committed);
  await revalidateTransactionContext(context);
  await replayControlRecord(context.paths.terminal, terminal, 'Retained transaction terminal record', validateTerminal);
  if (lock) await replayControlRecord(context.paths.lock, lock, 'Retained transaction lock', validateLock);
  if (journal) {
    await replayControlRecord(context.paths.journal, journal, 'Retained transaction journal', validateJournal);
  }
  if (marker) {
    await replayControlRecord(context.paths.marker, marker, 'Retained transaction commit marker', validateMarker);
  }
  await verifyRecoveredState(derived, committed);
  await revalidateTransactionContext(context);
  await finishTerminalCleanup(context, { journal, lock, marker, terminal }, testOnlyCrashAfter);
  return Object.freeze({
    committed,
    durabilityLimitation: FILE_TRANSACTION_DURABILITY_LIMITATION,
    entries: derived.length,
    recovered: true
  });
}

function validTerminalControlCombination({ committed, journal, lock, marker }) {
  if (journal && !lock) return false;
  if (marker && !lock) return false;
  if (!committed && marker) return false;
  if (committed && journal && !marker) return false;
  return true;
}

async function finishTerminalCleanup(context, records, testOnlyCrashAfter) {
  const { journal, lock, marker, terminal } = records;
  await revalidateTransactionContext(context);
  await replayControlRecord(context.paths.terminal, terminal, 'Retained transaction terminal record', validateTerminal);
  if (journal) {
    await removeBoundControlFile(context.paths.journal, journal, 'Retained transaction journal');
  }
  maybeCrash(testOnlyCrashAfter, 'journal-remove');
  await replayControlRecord(context.paths.terminal, terminal, 'Retained transaction terminal record', validateTerminal);
  if (marker) {
    await removeBoundControlFile(context.paths.marker, marker, 'Retained transaction commit marker');
  }
  maybeCrash(testOnlyCrashAfter, 'marker-remove');
  await replayControlRecord(context.paths.terminal, terminal, 'Retained transaction terminal record', validateTerminal);
  if (lock) await removeBoundControlFile(context.paths.lock, lock, 'Retained transaction lock');
  maybeCrash(testOnlyCrashAfter, 'lock-remove');
  await replayControlRecord(context.paths.terminal, terminal, 'Retained transaction terminal record', validateTerminal);
  await removeBoundControlFile(context.paths.terminal, terminal, 'Retained transaction terminal record');
}

async function replayOwnedActiveControls(context, lock, journal, marker = null) {
  await revalidateTransactionContext(context);
  await replayControlRecord(context.paths.lock, lock, 'Retained transaction lock', validateLock);
  await replayControlRecord(context.paths.journal, journal, 'Retained transaction journal', validateJournal);
  if (marker) {
    await replayControlRecord(context.paths.marker, marker, 'Retained transaction commit marker', validateMarker);
  } else if (await lstatIfPresent(context.paths.marker)) {
    throw new Error('A foreign transaction commit marker appeared before exact commit publication.');
  }
  if (await lstatIfPresent(context.paths.terminal)) {
    throw new Error('A foreign transaction terminal record appeared during active mutation.');
  }
}

async function replayRetainedRecoveryControls(context, { journal, lock, marker }) {
  await revalidateTransactionContext(context);
  await replayControlRecord(context.paths.lock, lock, 'Retained transaction lock', validateLock);
  if (journal) {
    await replayControlRecord(context.paths.journal, journal, 'Retained transaction journal', validateJournal);
  } else if (await lstatIfPresent(context.paths.journal)) {
    throw new Error('A foreign transaction journal appeared during recovery.');
  }
  if (marker) {
    await replayControlRecord(context.paths.marker, marker, 'Retained transaction commit marker', validateMarker);
  } else if (await lstatIfPresent(context.paths.marker)) {
    throw new Error('A foreign transaction commit marker appeared during recovery.');
  }
  if (await lstatIfPresent(context.paths.terminal)) {
    throw new Error('A foreign transaction terminal record appeared during recovery.');
  }
}

function terminalControlValue(primary, outcome) {
  return {
    entries: primary.entries,
    inputs: primary.inputs,
    outcome,
    repositoryId: primary.repositoryId,
    schema: TERMINAL_SCHEMA,
    transactionDigest: primary.transactionDigest,
    transactionId: primary.transactionId,
    transactionName: primary.transactionName
  };
}

function normalizeExpectedInputSnapshot(root, expectedInputs, resolveInputPaths, entries) {
  if (expectedInputs === undefined && resolveInputPaths === undefined) {
    const empty = Object.freeze([]);
    return Object.freeze({ inputs: empty, readOnlyInputs: empty, resolveInputPaths: null });
  }
  if (
    !(expectedInputs instanceof Map) ||
    Object.getPrototypeOf(expectedInputs) !== Map.prototype ||
    Reflect.ownKeys(expectedInputs).length !== 0
  ) {
    throw new Error('Transactional expected input snapshot must be one exact Map when supplied.');
  }
  if (typeof resolveInputPaths !== 'function') {
    throw new Error('Transactional expected input snapshot requires one exact path-inventory resolver.');
  }

  const updatesByPath = new Map(entries.map((entry) => [entry.repoPath, entry]));
  const inputs = [];
  const readOnlyInputs = [];
  const seen = new Set();
  for (const [path, value] of Map.prototype.entries.call(expectedInputs)) {
    const repoPath = normalizedRepoPath(root, path);
    if (seen.has(repoPath)) {
      throw new Error(`Duplicate normalized transactional input: ${repoPath}.`);
    }
    const bytes = exactUpdateBytes(value, repoPath);
    const update = updatesByPath.get(repoPath);
    if (update && !bytes.equals(update.staged.bytes)) {
      throw new Error(`Transactional input snapshot differs from its staged update bytes: ${repoPath}.`);
    }
    seen.add(repoPath);
    const input = Object.freeze({ bytes, repoPath, sha256: sha256(bytes) });
    inputs.push(input);
    if (!update) readOnlyInputs.push(input);
  }
  inputs.sort((left, right) => compareStrings(left.repoPath, right.repoPath));
  readOnlyInputs.sort((left, right) => compareStrings(left.repoPath, right.repoPath));
  return Object.freeze({
    inputs: Object.freeze(inputs),
    readOnlyInputs: Object.freeze(readOnlyInputs),
    resolveInputPaths
  });
}

function transactionTransientRepoPaths(root, entries) {
  const result = new Set();
  for (const entry of entries) {
    for (const path of [entry.temp, entry.backup]) {
      result.add(normalizedRepoPath(root, relative(root, path).split(sep).join('/')));
    }
  }
  return result;
}

async function captureReadOnlyInputs(context, plan, transientRepoPaths) {
  await replayReadOnlyInputInventory(context, plan, transientRepoPaths);
  const captured = [];
  for (const input of plan.readOnlyInputs) {
    const target = resolveInsideRoot(context.root.path, input.repoPath);
    const directories = await captureAncestorDirectories(context.root, dirname(target));
    await revalidateDirectories(directories);
    const observed = await readExactTransactionFile(target, `Read-only transaction input ${input.repoPath}`);
    assertDataMatches(observed, input, `Read-only transaction input ${input.repoPath}`);
    await revalidateDirectories(directories);
    captured.push(
      Object.freeze({
        ...input,
        directories,
        information: observed.information,
        target
      })
    );
  }
  return Object.freeze(captured);
}

async function replayReadOnlyInputs(context, plan, captured, transientRepoPaths) {
  if (!captured) throw new Error('Read-only transaction inputs were not captured under exclusive control.');
  await replayReadOnlyInputInventory(context, plan, transientRepoPaths);
  for (const input of captured) {
    await revalidateDirectories(input.directories);
    const observed = await readExactTransactionFile(input.target, `Read-only transaction input ${input.repoPath}`);
    assertDataMatches(observed, input, `Read-only transaction input ${input.repoPath}`);
    if (!sameTransactionFileIdentity(observed.information, input.information)) {
      throw new Error(`Read-only transaction input identity changed: ${input.repoPath}.`);
    }
    await revalidateDirectories(input.directories);
  }
}

async function replayReadOnlyInputInventory(context, plan, transientRepoPaths) {
  if (!plan.resolveInputPaths) return;
  await revalidateTransactionContext(context);
  const supplied = await plan.resolveInputPaths();
  const observed = normalizeResolvedReadOnlyInputPaths(context.root.path, supplied).filter(
    (path) => !transientRepoPaths.has(path)
  );
  const expected = plan.inputs.map(({ repoPath }) => repoPath);
  if (!exactArray(observed, expected)) {
    throw new Error('Transactional read-only input path inventory changed after planning.');
  }
}

function normalizeResolvedReadOnlyInputPaths(root, value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error('Transactional read-only input path resolver must return one exact plain array.');
  }
  const ownKeys = Reflect.ownKeys(value);
  const expectedKeys = [...Array.from({ length: value.length }, (_, index) => String(index)), 'length'];
  if (
    !Number.isSafeInteger(value.length) ||
    value.length < 0 ||
    !exactArray([...ownKeys].sort(compareStrings), expectedKeys.sort(compareStrings))
  ) {
    throw new Error('Transactional read-only input path resolver returned a sparse or decorated array.');
  }
  const paths = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw new Error('Transactional read-only input path resolver returned an accessor-backed array.');
    }
    paths.push(normalizedRepoPath(root, descriptor.value));
  }
  paths.sort(compareStrings);
  if (new Set(paths).size !== paths.length) {
    throw new Error('Transactional read-only input path resolver returned duplicate normalized paths.');
  }
  return paths;
}

async function transactionContext(root, transactionName, testOnlyControlDirectory) {
  const safeName = validateTransactionName(transactionName);
  const requestedRoot = resolve(root);
  const rootIdentity = await readExactPhysicalDirectory(requestedRoot, 'Transaction repository root');
  let controlDirectory;
  let trusted = null;
  if (testOnlyControlDirectory !== undefined) {
    assertTestOnlyCapability('testOnlyControlDirectory');
    if (!isAbsolute(testOnlyControlDirectory) || resolve(testOnlyControlDirectory) !== testOnlyControlDirectory) {
      throw new Error('Test-only transaction control directory must be one exact absolute path.');
    }
    controlDirectory = await readExactPhysicalDirectory(
      testOnlyControlDirectory,
      'Test-only transaction control directory'
    );
    if (isContainedPath(rootIdentity.path, controlDirectory.path)) {
      throw new Error('Test-only transaction control state must be outside its worktree.');
    }
  } else {
    if (isNodeTestContext() && !(await lstatIfPresent(resolve(rootIdentity.path, '.git')))) {
      controlDirectory = await readExactPhysicalDirectory(tmpdir(), 'Node test transaction control directory');
    } else {
      trusted = assertTrustedGitRepository(rootIdentity.path);
    }
    if (trusted) {
      controlDirectory = await readExactPhysicalDirectory(trusted.gitDir, 'Exact per-worktree Git metadata directory');
      if (!sameTransactionPath(trusted.root, rootIdentity.path)) {
        throw new Error('Trusted Git worktree identity differs from the exact transaction root.');
      }
      const reservedMainGitDirectory = resolve(rootIdentity.path, '.git');
      if (
        isContainedPath(rootIdentity.path, controlDirectory.path) &&
        !sameTransactionPath(controlDirectory.path, reservedMainGitDirectory)
      ) {
        throw new Error(
          'Exact per-worktree Git metadata must be external to tracked worktree paths or the reserved physical .git directory.'
        );
      }
    }
  }
  const repositoryId = transactionRepositoryId(controlDirectory.information, trusted ? null : rootIdentity.information);
  const stem = trusted
    ? `sitewipe-file-transaction-${safeName}`
    : `sitewipe-file-transaction-${repositoryId.slice(0, 24).toLowerCase()}-${safeName}`;
  return Object.freeze({
    controlDirectory,
    paths: Object.freeze({
      journal: resolve(controlDirectory.path, `${stem}.journal.json`),
      lock: resolve(controlDirectory.path, `${stem}.lock.json`),
      marker: resolve(controlDirectory.path, `${stem}.committed.json`),
      terminal: resolve(controlDirectory.path, `${stem}.terminal.json`)
    }),
    repositoryId,
    root: rootIdentity,
    transactionName: safeName
  });
}

async function prepareEntries(context, updates, createOnlyPaths, expectedOriginals) {
  if (!(updates instanceof Map) || updates.size === 0) {
    throw new Error('File transaction requires one non-empty exact update map.');
  }
  if (!(createOnlyPaths instanceof Set)) {
    throw new Error('Transactional create-only paths must be one exact Set.');
  }
  const normalizedCreates = new Set(
    [...createOnlyPaths].map((repoPath) => normalizedRepoPath(context.root.path, repoPath))
  );
  const normalizedUpdates = new Map();
  for (const [repoPath, value] of updates) {
    const normalized = normalizedRepoPath(context.root.path, repoPath);
    if (normalizedUpdates.has(normalized)) throw new Error(`Duplicate normalized transaction target: ${normalized}.`);
    normalizedUpdates.set(normalized, exactUpdateBytes(value, normalized));
  }
  for (const path of normalizedCreates) {
    if (!normalizedUpdates.has(path)) {
      throw new Error(`Create-only transaction allowlist contains an unexpected target: ${path}.`);
    }
  }
  const normalizedExpectedOriginals = normalizeExpectedOriginals(
    context.root.path,
    expectedOriginals,
    normalizedCreates,
    normalizedUpdates
  );

  const result = [];
  for (const repoPath of [...normalizedUpdates.keys()].sort(compareStrings)) {
    const target = resolveInsideRoot(context.root.path, repoPath);
    const operation = normalizedCreates.has(repoPath) ? 'create' : 'replace';
    const directories = await captureAncestorDirectories(context.root, dirname(target));
    const current = await lstatIfPresent(target);
    if (operation === 'create') {
      if (current) {
        throw new Error(`Transactional create target already exists and will not be overwritten: ${repoPath}`);
      }
    } else if (!current) {
      throw new Error(`Transactional update target must be a regular existing file: ${repoPath}`);
    }
    const originalFile = operation === 'replace' ? await readExactTransactionFile(target, `Target ${repoPath}`) : null;
    const original = originalFile
      ? Object.freeze({ ...originalFile, mode: transactionPermissionMode(originalFile.information) })
      : null;
    const expectedOriginal = normalizedExpectedOriginals?.get(repoPath);
    if (expectedOriginal && !original.bytes.equals(expectedOriginal)) {
      throw new Error(`Transactional target differs from the exact source bytes used to plan its update: ${repoPath}.`);
    }
    const stagedBytes = normalizedUpdates.get(repoPath);
    const stagedMode = original ? original.mode : repositoryFileCreateMode();
    result.push({
      directories,
      operation,
      original,
      repoPath,
      staged: Object.freeze({ bytes: stagedBytes, mode: stagedMode, sha256: sha256(stagedBytes) }),
      target
    });
  }
  return result;
}

function normalizeExpectedOriginals(root, expectedOriginals, normalizedCreates, normalizedUpdates) {
  if (expectedOriginals === undefined) return null;
  if (!(expectedOriginals instanceof Map)) {
    throw new Error('Transactional expected originals must be one exact Map when supplied.');
  }
  const result = new Map();
  for (const [repoPath, value] of expectedOriginals) {
    const normalized = normalizedRepoPath(root, repoPath);
    if (result.has(normalized)) {
      throw new Error(`Duplicate normalized expected transaction original: ${normalized}.`);
    }
    result.set(normalized, exactUpdateBytes(value, normalized));
  }
  const expectedReplacePaths = [...normalizedUpdates.keys()]
    .filter((path) => !normalizedCreates.has(path))
    .sort(compareStrings);
  const suppliedPaths = [...result.keys()].sort(compareStrings);
  if (!exactArray(suppliedPaths, expectedReplacePaths)) {
    throw new Error('Transactional expected originals must exactly cover every replacement and no creation.');
  }
  return result;
}

function normalizeExpectedOperations(root, expectedOperations) {
  const source =
    expectedOperations instanceof Map
      ? [...expectedOperations].map(([path, operation]) => ({ operation, path }))
      : expectedOperations;
  if (!Array.isArray(source) || source.length === 0) {
    throw new Error('Explicit transaction recovery requires one non-empty expected target/operation allowlist.');
  }
  const result = source.map((entry) => {
    assertExactKeys(entry, ['operation', 'path'], 'Expected transaction operation');
    if (entry.operation !== 'create' && entry.operation !== 'replace') {
      throw new Error('Expected transaction operation must be exactly create or replace.');
    }
    return Object.freeze({ operation: entry.operation, path: normalizedRepoPath(root, entry.path) });
  });
  const sorted = [...result].sort((left, right) => compareStrings(left.path, right.path));
  if (new Set(result.map(({ path }) => path)).size !== result.length || !exactArray(result, sorted)) {
    throw new Error('Expected transaction target/operation allowlist must be unique and sorted exactly.');
  }
  return Object.freeze(result);
}

async function deriveRecoveryEntries(context, journalEntries, transactionId) {
  const entries = [];
  for (const journal of journalEntries) {
    const target = resolveInsideRoot(context.root.path, journal.path);
    const directories = await captureAncestorDirectories(context.root, dirname(target));
    entries.push({
      ...journal,
      ...derivedPaths(target, transactionId),
      directories,
      repoPath: journal.path,
      target
    });
  }
  assertDisjointTransactionPaths(entries);
  return entries;
}

function derivedPaths(target, transactionId) {
  const suffix = `.sitewipe-${transactionId}`;
  return {
    backup: resolve(dirname(target), `.${basename(target)}${suffix}.bak`),
    temp: resolve(dirname(target), `.${basename(target)}${suffix}.tmp`)
  };
}

function assertDisjointTransactionPaths(entries) {
  const paths = [];
  for (const entry of entries) paths.push(entry.target, entry.temp, entry.backup);
  const normalized = paths.map(normalizedHostPath);
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('Transaction targets and transactionId-derived staging paths must be exactly disjoint.');
  }
}

async function promoteEntry(entry) {
  await revalidateDirectories(entry.directories);
  const staged = await readExactTransactionFile(entry.temp, `Transactional staged file ${entry.repoPath}`);
  assertDataMatches(staged, entry.staged, `Transactional staged file ${entry.repoPath}`);
  if (!sameTransactionFileIdentity(staged.information, entry.staged.information)) {
    throw new Error(`Transactional staged identity changed before promotion: ${entry.repoPath}.`);
  }
  if (entry.operation === 'create') {
    if (await lstatIfPresent(entry.target)) throw new Error(`Transactional create target appeared: ${entry.repoPath}.`);
    await link(entry.temp, entry.target);
    const linkedTemp = await readExactTransactionFile(entry.temp, `Linked staged file ${entry.repoPath}`, {
      requireSingleLink: false
    });
    const linkedTarget = await readExactTransactionFile(entry.target, `Created target ${entry.repoPath}`, {
      requireSingleLink: false
    });
    if (
      linkedTemp.information.nlink !== 2n ||
      linkedTarget.information.nlink !== 2n ||
      !sameTransactionPhysicalNode(linkedTemp.information, linkedTarget.information) ||
      !linkedTarget.bytes.equals(entry.staged.bytes)
    ) {
      throw new Error(`Transactional create target is not the exact staged physical file: ${entry.repoPath}.`);
    }
    return;
  }

  const original = await readExactTransactionFile(entry.target, `Transactional target ${entry.repoPath}`);
  assertDataMatches(original, entry.original, `Transactional target ${entry.repoPath}`);
  if (!sameTransactionFileIdentity(original.information, entry.original.information)) {
    throw new Error(`Transactional target identity changed before promotion: ${entry.repoPath}.`);
  }
  if (await lstatIfPresent(entry.backup)) throw new Error(`Transactional backup path appeared: ${entry.repoPath}.`);
  await link(entry.target, entry.backup);
  const linkedOriginal = await readExactTransactionFile(entry.target, `Linked original target ${entry.repoPath}`, {
    requireSingleLink: false
  });
  const linkedBackup = await readExactTransactionFile(entry.backup, `Linked transaction backup ${entry.repoPath}`, {
    requireSingleLink: false
  });
  if (
    linkedOriginal.information.nlink !== 2n ||
    linkedBackup.information.nlink !== 2n ||
    !sameTransactionPhysicalNode(linkedOriginal.information, linkedBackup.information) ||
    !sameTransactionPhysicalNode(linkedOriginal.information, entry.original.information) ||
    !linkedOriginal.bytes.equals(entry.original.bytes)
  ) {
    throw new Error(`Transactional backup is not an exact no-overwrite link to the original: ${entry.repoPath}.`);
  }
  await removeBoundDataFileIfPresent(entry.target, entry.original, `Linked original target ${entry.repoPath}`, {
    allowMultipleLinks: true,
    expectedIdentity: linkedOriginal.information
  });
  const backup = await readExactTransactionFile(entry.backup, `Transactional backup ${entry.repoPath}`);
  if (!sameTransactionPhysicalNode(backup.information, entry.original.information)) {
    throw new Error(`Transactional backup lost the exact original physical identity: ${entry.repoPath}.`);
  }
  await link(entry.temp, entry.target);
  const linkedTemp = await readExactTransactionFile(entry.temp, `Linked staged file ${entry.repoPath}`, {
    requireSingleLink: false
  });
  const linkedTarget = await readExactTransactionFile(entry.target, `Linked promoted target ${entry.repoPath}`, {
    requireSingleLink: false
  });
  if (
    linkedTemp.information.nlink !== 2n ||
    linkedTarget.information.nlink !== 2n ||
    !sameTransactionPhysicalNode(linkedTemp.information, linkedTarget.information) ||
    !sameTransactionPhysicalNode(linkedTemp.information, entry.staged.information) ||
    !linkedTarget.bytes.equals(entry.staged.bytes)
  ) {
    throw new Error(`Transactional promoted target is not an exact no-overwrite staged link: ${entry.repoPath}.`);
  }
  await removeBoundDataFileIfPresent(entry.temp, entry.staged, `Linked staged file ${entry.repoPath}`, {
    allowMultipleLinks: true,
    expectedIdentity: linkedTemp.information
  });
  const promoted = await readExactTransactionFile(entry.target, `Promoted target ${entry.repoPath}`);
  assertDataMatches(promoted, entry.staged, `Promoted target ${entry.repoPath}`);
  if (!sameTransactionPhysicalNode(promoted.information, entry.staged.information)) {
    throw new Error(`Promoted target is not the exact staged physical file: ${entry.repoPath}.`);
  }
  if (await lstatIfPresent(entry.temp))
    throw new Error(`Transactional staged path survived promotion: ${entry.repoPath}.`);
}

async function cleanCommittedEntry(entry) {
  await revalidateDirectories(entry.directories);
  const target = await readExactTransactionFile(entry.target, `Committed target ${entry.repoPath}`, {
    requireSingleLink: entry.operation !== 'create'
  });
  assertDataMatches(target, entry.staged, `Committed target ${entry.repoPath}`);
  if (!sameTransactionPhysicalNode(target.information, entry.staged.information)) {
    throw new Error(`Committed target is not the exact staged physical file: ${entry.repoPath}.`);
  }
  if (entry.operation === 'create') {
    const temp = await readExactTransactionFile(entry.temp, `Committed create staging file ${entry.repoPath}`, {
      requireSingleLink: false
    });
    assertDataMatches(temp, entry.staged, `Committed create staging file ${entry.repoPath}`);
    if (
      target.information.nlink !== 2n ||
      temp.information.nlink !== 2n ||
      !sameTransactionPhysicalNode(target.information, temp.information)
    ) {
      throw new Error(`Committed create target and staging file have a foreign topology: ${entry.repoPath}.`);
    }
    await removeBoundDataFileIfPresent(entry.temp, entry.staged, `Committed create staging file ${entry.repoPath}`, {
      allowMultipleLinks: true,
      expectedIdentity: temp.information
    });
    const retained = await readExactTransactionFile(entry.target, `Committed created target ${entry.repoPath}`);
    assertDataMatches(retained, entry.staged, `Committed created target ${entry.repoPath}`);
  } else {
    await removeBoundDataFileIfPresent(entry.backup, entry.original, `Committed backup ${entry.repoPath}`, {
      expectedIdentity: entry.original.information,
      identityMode: 'physical'
    });
  }
}

async function preflightRecovery(entries, committed) {
  const plan = [];
  for (const entry of entries) {
    await revalidateDirectories(entry.directories);
    const state = await inspectRecoveryEntry(entry);
    if (committed) {
      assertStateData(state.target, entry, 'staged', 'Committed recovery target');
      if (entry.operation === 'create') {
        if (state.backup) throw new Error(`Committed create recovery has an unexpected backup: ${entry.repoPath}.`);
        if (state.temp) {
          assertStateData(state.temp, entry, 'staged', 'Committed create staging file');
          if (
            state.target.information.nlink !== 2n ||
            state.temp.information.nlink !== 2n ||
            !sameTransactionPhysicalNode(state.target.information, state.temp.information)
          ) {
            throw new Error(`Committed create recovery staging identity is foreign: ${entry.repoPath}.`);
          }
          plan.push({ entry, kind: 'remove-temp', observed: state.temp });
        } else if (state.target.information.nlink !== 1n) {
          throw new Error(`Committed create recovery target has a foreign link count: ${entry.repoPath}.`);
        }
      } else {
        if (state.temp)
          throw new Error(`Committed replacement retained an impossible staging file: ${entry.repoPath}.`);
        if (state.target.information.nlink !== 1n) {
          throw new Error(`Committed replacement target has a foreign link count: ${entry.repoPath}.`);
        }
        if (state.backup) {
          assertStateData(state.backup, entry, 'original', 'Committed replacement backup');
          if (state.backup.information.nlink !== 1n) {
            throw new Error(`Committed replacement backup has a foreign link count: ${entry.repoPath}.`);
          }
          plan.push({ entry, kind: 'remove-backup', observed: state.backup });
        }
      }
      continue;
    }

    if (entry.operation === 'create') {
      if (state.backup) throw new Error(`Uncommitted create recovery has an unexpected backup: ${entry.repoPath}.`);
      if (state.target) {
        assertStateData(state.target, entry, 'staged', 'Uncommitted created target');
        if (!state.temp) throw new Error(`Uncommitted created target lacks its exact staged link: ${entry.repoPath}.`);
        assertStateData(state.temp, entry, 'staged', 'Uncommitted create staging file');
        if (
          state.target.information.nlink !== 2n ||
          state.temp.information.nlink !== 2n ||
          !sameTransactionPhysicalNode(state.target.information, state.temp.information)
        ) {
          throw new Error(`Uncommitted created target is not its exact staged link: ${entry.repoPath}.`);
        }
        plan.push(
          { entry, kind: 'remove-created-target', observed: state.target },
          { entry, identityMode: 'physical', kind: 'remove-temp', observed: state.temp }
        );
      } else if (state.temp) {
        assertStateData(state.temp, entry, 'staged', 'Uncommitted create staging file');
        if (state.temp.information.nlink !== 1n) {
          throw new Error(`Uncommitted create staging file has a foreign link count: ${entry.repoPath}.`);
        }
        plan.push({ entry, kind: 'remove-temp', observed: state.temp });
      }
      continue;
    }

    if (state.target && state.backup) {
      assertStateData(state.backup, entry, 'original', 'Uncommitted replacement backup');
      if (state.temp) {
        assertStateData(state.temp, entry, 'staged', 'Uncommitted replacement staging file');
        if (
          matchesData(state.target, entry.originalBytes, entry.originalSha256, entry.originalMode) &&
          state.target.information.nlink === 2n &&
          state.backup.information.nlink === 2n &&
          state.temp.information.nlink === 1n &&
          sameTransactionPhysicalNode(state.target.information, state.backup.information)
        ) {
          plan.push(
            { allowMultipleLinks: true, entry, kind: 'remove-backup', observed: state.backup },
            { entry, kind: 'remove-temp', observed: state.temp }
          );
        } else {
          assertStateData(state.target, entry, 'staged', 'Uncommitted linked promoted target');
          if (
            state.target.information.nlink !== 2n ||
            state.temp.information.nlink !== 2n ||
            state.backup.information.nlink !== 1n ||
            !sameTransactionPhysicalNode(state.target.information, state.temp.information)
          ) {
            throw new Error(`Uncommitted linked promotion has a foreign topology: ${entry.repoPath}.`);
          }
          plan.push(
            {
              allowMultipleLinks: true,
              entry,
              kind: 'remove-promoted-target',
              observed: state.target
            },
            { entry, identityMode: 'physical', kind: 'remove-temp', observed: state.temp },
            { entry, kind: 'restore-backup', observed: state.backup }
          );
        }
      } else {
        assertStateData(state.target, entry, 'staged', 'Uncommitted promoted target');
        if (state.target.information.nlink !== 1n || state.backup.information.nlink !== 1n) {
          throw new Error(`Uncommitted promoted replacement has a foreign topology: ${entry.repoPath}.`);
        }
        plan.push(
          { entry, kind: 'remove-promoted-target', observed: state.target },
          { entry, kind: 'restore-backup', observed: state.backup }
        );
      }
    } else if (state.target) {
      assertStateData(state.target, entry, 'original', 'Rolled-back replacement target');
      if (state.target.information.nlink !== 1n) {
        throw new Error(`Rolled-back replacement target has a foreign link count: ${entry.repoPath}.`);
      }
      if (state.temp) {
        assertStateData(state.temp, entry, 'staged', 'Uncommitted replacement staging file');
        if (state.temp.information.nlink !== 1n) {
          throw new Error(`Uncommitted replacement staging file has a foreign link count: ${entry.repoPath}.`);
        }
        plan.push({ entry, kind: 'remove-temp', observed: state.temp });
      }
    } else if (state.backup) {
      assertStateData(state.backup, entry, 'original', 'Uncommitted replacement backup');
      if (state.backup.information.nlink !== 1n) {
        throw new Error(`Uncommitted replacement backup has a foreign link count: ${entry.repoPath}.`);
      }
      if (state.temp) {
        assertStateData(state.temp, entry, 'staged', 'Uncommitted replacement staging file');
        if (state.temp.information.nlink !== 1n) {
          throw new Error(`Uncommitted replacement staging file has a foreign link count: ${entry.repoPath}.`);
        }
      }
      plan.push({ entry, kind: 'restore-backup', observed: state.backup });
      if (state.temp) plan.push({ entry, kind: 'remove-temp', observed: state.temp });
    } else {
      throw new Error(`Uncommitted replacement lost every exact rollback path: ${entry.repoPath}.`);
    }
  }
  return plan;
}

async function inspectRecoveryEntry(entry) {
  return {
    backup: await readExactTransactionFileIfPresent(entry.backup, `Recovery backup ${entry.repoPath}`, {
      requireSingleLink: false
    }),
    target: await readExactTransactionFileIfPresent(entry.target, `Recovery target ${entry.repoPath}`, {
      requireSingleLink: false
    }),
    temp: await readExactTransactionFileIfPresent(entry.temp, `Recovery staging file ${entry.repoPath}`, {
      requireSingleLink: false
    })
  };
}

async function applyRecoveryAction({ allowMultipleLinks = false, entry, identityMode = 'exact', kind, observed }) {
  await revalidateDirectories(entry.directories);
  if (kind === 'remove-temp') {
    await removeBoundDataFileIfPresent(entry.temp, entry, `Recovery staging file ${entry.repoPath}`, {
      allowMultipleLinks: entry.operation === 'create',
      dataPrefix: 'staged',
      expectedIdentity: observed.information,
      identityMode
    });
  } else if (kind === 'remove-backup') {
    await removeBoundDataFileIfPresent(entry.backup, entry, `Recovery backup ${entry.repoPath}`, {
      allowMultipleLinks,
      dataPrefix: 'original',
      expectedIdentity: observed.information,
      identityMode
    });
  } else if (kind === 'remove-created-target' || kind === 'remove-promoted-target') {
    await removeBoundDataFileIfPresent(entry.target, entry, `Recovery target ${entry.repoPath}`, {
      allowMultipleLinks: kind === 'remove-created-target' || allowMultipleLinks,
      dataPrefix: 'staged',
      expectedIdentity: observed.information,
      identityMode
    });
  } else if (kind === 'restore-backup') {
    if (await lstatIfPresent(entry.target)) throw new Error(`Recovery target reappeared: ${entry.repoPath}.`);
    const backup = await readExactTransactionFile(entry.backup, `Recovery backup ${entry.repoPath}`);
    assertStateData(backup, entry, 'original', 'Recovery backup');
    if (!sameTransactionFileIdentity(backup.information, observed.information)) {
      throw new Error(`Recovery backup identity changed before restoration: ${entry.repoPath}.`);
    }
    await link(entry.backup, entry.target);
    const linkedBackup = await readExactTransactionFile(entry.backup, `Linked recovery backup ${entry.repoPath}`, {
      requireSingleLink: false
    });
    const linkedTarget = await readExactTransactionFile(entry.target, `Linked restored target ${entry.repoPath}`, {
      requireSingleLink: false
    });
    if (
      linkedBackup.information.nlink !== 2n ||
      linkedTarget.information.nlink !== 2n ||
      !sameTransactionPhysicalNode(linkedBackup.information, linkedTarget.information) ||
      !sameTransactionPhysicalNode(linkedBackup.information, observed.information)
    ) {
      throw new Error(`Restored target is not an exact no-overwrite link to its recovery backup: ${entry.repoPath}.`);
    }
    await removeBoundDataFileIfPresent(entry.backup, entry, `Linked recovery backup ${entry.repoPath}`, {
      allowMultipleLinks: true,
      dataPrefix: 'original',
      expectedIdentity: linkedBackup.information
    });
    const restored = await readExactTransactionFile(entry.target, `Restored target ${entry.repoPath}`);
    assertStateData(restored, entry, 'original', 'Restored target');
    if (!sameTransactionPhysicalNode(restored.information, observed.information)) {
      throw new Error(`Restored target lost the exact recovery backup physical identity: ${entry.repoPath}.`);
    }
  } else {
    throw new Error(`Unknown bounded recovery action: ${kind}.`);
  }
}

async function verifyRecoveredState(entries, committed) {
  for (const entry of entries) {
    if (!committed && entry.operation === 'create') {
      if (await lstatIfPresent(entry.target)) {
        throw new Error(`Rolled-back create target survived recovery: ${entry.repoPath}.`);
      }
    } else {
      const target = await readExactTransactionFile(entry.target, `Recovered target ${entry.repoPath}`);
      assertStateData(target, entry, committed ? 'staged' : 'original', 'Recovered target');
    }
    if ((await lstatIfPresent(entry.temp)) || (await lstatIfPresent(entry.backup))) {
      throw new Error(`Recovered transaction retained a derived staging path: ${entry.repoPath}.`);
    }
  }
}

async function verifyCommittedPreparedState(entries) {
  for (const entry of entries) {
    await revalidateDirectories(entry.directories);
    const target = await readExactTransactionFile(entry.target, `Committed target ${entry.repoPath}`);
    assertDataMatches(target, entry.staged, `Committed target ${entry.repoPath}`);
    if (!sameTransactionPhysicalNode(target.information, entry.staged.information)) {
      throw new Error(`Committed target lost its exact staged physical identity: ${entry.repoPath}.`);
    }
    if ((await lstatIfPresent(entry.temp)) || (await lstatIfPresent(entry.backup))) {
      throw new Error(`Committed transaction retained a derived staging path: ${entry.repoPath}.`);
    }
  }
}

function validateControlBinding(context, lock, journal) {
  if (
    lock.repositoryId !== context.repositoryId ||
    journal.repositoryId !== context.repositoryId ||
    lock.transactionName !== context.transactionName ||
    journal.transactionName !== context.transactionName ||
    lock.transactionId !== journal.transactionId ||
    lock.transactionDigest !== journal.transactionDigest ||
    stableJson(lock.entries) !== stableJson(journal.entries) ||
    stableJson(lock.inputs) !== stableJson(journal.inputs)
  ) {
    throw new Error('Retained transaction lock and journal are foreign or not identity-bound to this worktree.');
  }
}

function validateMarkerBinding(context, primary, marker) {
  if (
    marker.repositoryId !== context.repositoryId ||
    marker.transactionId !== primary.transactionId ||
    marker.transactionDigest !== primary.transactionDigest
  ) {
    throw new Error('Retained transaction commit marker is foreign or not bound to its exact journal.');
  }
}

function validateLock(value) {
  assertExactKeys(value, LOCK_KEYS, 'Transaction lock');
  validateControlIdentity(value, LOCK_SCHEMA, true);
  validateJournalEntries(value.entries);
  validateInputRecords(value.inputs);
}

function validateJournal(value) {
  assertExactKeys(value, JOURNAL_KEYS, 'Transaction journal');
  validateControlIdentity(value, JOURNAL_SCHEMA, true);
  validateJournalEntries(value.entries);
  validateInputRecords(value.inputs);
}

function validateJournalEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('Transaction journal must contain one non-empty exact entry list.');
  }
  for (const entry of entries) {
    assertExactKeys(entry, JOURNAL_ENTRY_KEYS, 'Transaction journal entry');
    if (
      (entry.operation !== 'create' && entry.operation !== 'replace') ||
      typeof entry.path !== 'string' ||
      !Number.isSafeInteger(entry.stagedBytes) ||
      entry.stagedBytes < 0 ||
      !isPermissionMode(entry.stagedMode) ||
      !isSha256(entry.stagedSha256)
    ) {
      throw new Error('Transaction journal entry has an invalid operation, path, size, or digest.');
    }
    if (entry.operation === 'create') {
      if (entry.originalBytes !== null || entry.originalMode !== null || entry.originalSha256 !== null) {
        throw new Error('Transaction create journal entry must have exact null original identity fields.');
      }
    } else if (
      !Number.isSafeInteger(entry.originalBytes) ||
      entry.originalBytes < 0 ||
      !isPermissionMode(entry.originalMode) ||
      !isSha256(entry.originalSha256)
    ) {
      throw new Error('Transaction replacement journal entry has an invalid original identity.');
    }
  }
  const sorted = [...entries].sort((left, right) => compareStrings(left.path, right.path));
  if (new Set(entries.map(({ path }) => path)).size !== entries.length || !exactArray(entries, sorted)) {
    throw new Error('Transaction journal entries must be unique and sorted exactly.');
  }
}

function validateInputRecords(inputs) {
  if (!Array.isArray(inputs)) {
    throw new Error('Transaction inputs must be one exact entry list.');
  }
  for (const input of inputs) {
    assertExactKeys(input, INPUT_RECORD_KEYS, 'Transaction input');
    if (
      typeof input.path !== 'string' ||
      !Number.isSafeInteger(input.bytes) ||
      input.bytes < 0 ||
      !isSha256(input.sha256)
    ) {
      throw new Error('Transaction input has an invalid path, size, or digest.');
    }
  }
  const sorted = [...inputs].sort((left, right) => compareStrings(left.path, right.path));
  if (new Set(inputs.map(({ path }) => path)).size !== inputs.length || !exactArray(inputs, sorted)) {
    throw new Error('Transaction inputs must be unique and sorted exactly.');
  }
}

function validateMarker(value) {
  assertExactKeys(value, MARKER_KEYS, 'Transaction commit marker');
  validateControlIdentity(value, MARKER_SCHEMA, false);
}

function validateTerminal(value) {
  assertExactKeys(value, TERMINAL_KEYS, 'Transaction terminal record');
  validateControlIdentity(value, TERMINAL_SCHEMA, true);
  validateJournalEntries(value.entries);
  validateInputRecords(value.inputs);
  if (value.outcome !== 'committed' && value.outcome !== 'rolledBack') {
    throw new Error('Transaction terminal record has an invalid exact outcome.');
  }
}

function validatePrimaryControl(context, primary, expected, label) {
  if (
    primary.repositoryId !== context.repositoryId ||
    primary.transactionName !== context.transactionName ||
    !exactOperationAllowlist(primary.entries, expected) ||
    primary.inputs.some(({ path }) => normalizedRepoPath(context.root.path, path) !== path) ||
    primary.inputs.some((input) => {
      const update = primary.entries.find((entry) => entry.path === input.path);
      return update && (input.bytes !== update.stagedBytes || input.sha256 !== update.stagedSha256);
    })
  ) {
    throw new Error(`${label} differs from this worktree and exact expected target/operation allowlist.`);
  }
  const digest = transactionDigest({
    entries: primary.entries,
    inputs: primary.inputs,
    repositoryId: primary.repositoryId,
    transactionId: primary.transactionId,
    transactionName: primary.transactionName
  });
  if (digest !== primary.transactionDigest) {
    throw new Error(`${label} digest is not bound to its canonical entries and identity.`);
  }
}

function validateControlIdentity(value, schema, requireName) {
  if (
    value.schema !== schema ||
    !isSha256(value.repositoryId) ||
    !isSha256(value.transactionDigest) ||
    !isCanonicalUuid(value.transactionId) ||
    (requireName && validateTransactionName(value.transactionName) !== value.transactionName)
  ) {
    throw new Error('Transaction control record has an invalid schema or identity binding.');
  }
}

async function writeExactExclusiveTransactionFile(
  path,
  value,
  label,
  { createMode = 0o600, enforceMode = false } = {}
) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  let handle;
  let writtenIdentity;
  try {
    handle = await open(path, 'wx', createMode);
  } catch (error) {
    throw Object.assign(new Error(`${label} could not be exclusively created.`, { cause: error }), {
      code: error?.code
    });
  }
  try {
    const opened = await exactTransactionHandleStat(handle);
    assertExactTransactionFileStat(opened, label, { requireSingleLink: true });
    const pathOpened = await exactTransactionPathStat(path);
    assertExactTransactionFileStat(pathOpened, label, { requireSingleLink: true });
    if (!sameTransactionFileIdentity(opened, pathOpened) || !sameTransactionPath(await realpath(path), path)) {
      throw new Error(`${label} path differs from its exact exclusive handle.`);
    }
    await writeAll(handle, bytes);
    if (enforceMode && process.platform !== 'win32') await handle.chmod(createMode);
    await handle.sync();
    const written = await exactTransactionHandleStat(handle);
    writtenIdentity = written;
    assertExactTransactionFileStat(written, label, { requireSingleLink: true });
    const pathWritten = await exactTransactionPathStat(path);
    assertExactTransactionFileStat(pathWritten, label, { requireSingleLink: true });
    if (
      !sameTransactionPhysicalNode(opened, written) ||
      !sameTransactionFileIdentity(written, pathWritten) ||
      written.size !== BigInt(bytes.length) ||
      (enforceMode && process.platform !== 'win32' && transactionPermissionMode(written) !== createMode) ||
      !sameTransactionPath(await realpath(path), path)
    ) {
      throw new Error(`${label} identity changed during its exclusive write.`);
    }
  } finally {
    await handle.close();
  }
  const stored = await readExactTransactionFile(path, label);
  if (!stored.bytes.equals(bytes) || !sameTransactionFileIdentity(stored.information, writtenIdentity)) {
    throw new Error(`${label} bytes or identity changed after its exclusive write.`);
  }
  return stored;
}

async function writeCanonicalControlRecord(path, value, label, validate) {
  validate(value);
  const bytes = canonicalJsonBytes(value);
  const stored = await writeExactExclusiveTransactionFile(path, bytes, label, {
    createMode: 0o600,
    enforceMode: true
  });
  return Object.freeze({ bytes: stored.bytes, information: stored.information, value });
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) {
      throw new Error('Transaction file write made no exact forward progress.');
    }
    offset += result.bytesWritten;
  }
}

async function readCanonicalControlRecord(path, label, validate) {
  const record = await readCanonicalControlRecordIfPresent(path, label, validate);
  if (!record) throw new Error(`${label} is missing; exact recovery is unavailable.`);
  return record;
}

async function readCanonicalControlRecordIfPresent(path, label, validate) {
  const stored = await readExactTransactionFileIfPresent(path, label);
  if (!stored) return null;
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stored.bytes));
  } catch (error) {
    throw new Error(`${label} is not exact UTF-8 JSON.`, { cause: error });
  }
  validate(value);
  const canonical = canonicalJsonBytes(value);
  if (!stored.bytes.equals(canonical)) throw new Error(`${label} is not canonical JSON.`);
  return Object.freeze({ bytes: stored.bytes, information: stored.information, value });
}

async function replayControlRecord(path, expected, label, validate) {
  const observed = await readCanonicalControlRecord(path, label, validate);
  if (
    !observed.bytes.equals(expected.bytes) ||
    !sameTransactionFileIdentity(observed.information, expected.information)
  ) {
    throw new Error(`${label} changed before recovery mutation.`);
  }
}

async function removeBoundControlFile(path, expected, label) {
  const observed = await readExactTransactionFile(path, label);
  if (
    !observed.bytes.equals(expected.bytes) ||
    !sameTransactionFileIdentity(observed.information, expected.information)
  ) {
    throw new Error(`${label} changed before bounded removal.`);
  }
  await rm(path);
  if (await lstatIfPresent(path)) throw new Error(`${label} survived bounded removal.`);
}

async function removeBoundDataFileIfPresent(
  path,
  expected,
  label,
  { allowMultipleLinks = false, dataPrefix = null, expectedIdentity = null, identityMode = 'exact' } = {}
) {
  const observed = await readExactTransactionFileIfPresent(path, label, {
    requireSingleLink: !allowMultipleLinks
  });
  if (!observed) {
    if (expectedIdentity) throw new Error(`${label} disappeared before its exact bounded action.`);
    return;
  }
  if (dataPrefix) assertStateData(observed, expected, dataPrefix, label);
  else assertDataMatches(observed, expected, label);
  if (
    expectedIdentity &&
    !(identityMode === 'exact'
      ? sameTransactionFileIdentity(observed.information, expectedIdentity)
      : identityMode === 'physical' && sameTransactionPhysicalNode(observed.information, expectedIdentity))
  ) {
    throw new Error(`${label} physical identity changed before bounded removal.`);
  }
  await rm(path);
  if (await lstatIfPresent(path)) throw new Error(`${label} survived bounded removal.`);
}

async function readExactTransactionFileIfPresent(path, label, options) {
  try {
    return await readExactTransactionFile(path, label, options);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.cause?.code === 'ENOENT') return null;
    throw error;
  }
}

async function readExactTransactionFile(path, label, { requireSingleLink = true } = {}) {
  const expected = resolve(path);
  const before = await exactTransactionPathStat(expected);
  assertExactTransactionFileStat(before, label, { requireSingleLink });
  if (!sameTransactionPath(await realpath(expected), expected)) throw new Error(`${label} path is aliased.`);
  const handle = await open(expected, 'r');
  try {
    const opened = await exactTransactionHandleStat(handle);
    assertExactTransactionFileStat(opened, label, { requireSingleLink });
    const bytes = await handle.readFile();
    const after = await exactTransactionHandleStat(handle);
    assertExactTransactionFileStat(after, label, { requireSingleLink });
    const pathAfter = await exactTransactionPathStat(expected);
    assertExactTransactionFileStat(pathAfter, label, { requireSingleLink });
    if (
      !sameTransactionFileIdentity(before, opened) ||
      !sameTransactionFileIdentity(opened, after) ||
      !sameTransactionFileIdentity(after, pathAfter) ||
      after.size !== BigInt(bytes.length) ||
      !sameTransactionPath(await realpath(expected), expected)
    ) {
      throw new Error(`${label} identity changed while reading.`);
    }
    return Object.freeze({ bytes, information: after, sha256: sha256(bytes) });
  } finally {
    await handle.close();
  }
}

async function readExactPhysicalDirectory(path, label) {
  const expected = resolve(path);
  let information;
  let physical;
  try {
    information = await exactTransactionPathStat(expected);
    physical = await realpath(expected);
  } catch (error) {
    throw Object.assign(new Error(`${label} is missing or cannot be physically resolved.`, { cause: error }), {
      code: error?.code
    });
  }
  if (
    !information.isDirectory() ||
    information.isSymbolicLink() ||
    !hasExactBigIntFields(information, ['birthtimeNs', 'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink']) ||
    !sameTransactionPath(physical, expected)
  ) {
    throw new Error(`${label} must be one exact physical non-reparse directory.`);
  }
  return Object.freeze({ information, path: expected });
}

async function captureAncestorDirectories(rootIdentity, parent) {
  const relation = relative(rootIdentity.path, parent);
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error('Transactional target parent escapes the exact repository root.');
  }
  const result = [rootIdentity];
  let current = rootIdentity.path;
  for (const segment of relation ? relation.split(sep) : []) {
    current = resolve(current, segment);
    result.push(await readExactPhysicalDirectory(current, `Transactional target ancestor ${current}`));
  }
  return Object.freeze(result);
}

async function revalidateDirectories(directories) {
  for (const expected of directories) {
    const observed = await readExactPhysicalDirectory(expected.path, `Transactional ancestor ${expected.path}`);
    if (!sameTransactionDirectoryNode(expected.information, observed.information)) {
      throw new Error(`Transactional ancestor identity changed: ${expected.path}.`);
    }
  }
}

async function revalidateTransactionContext(context) {
  await revalidateDirectories([context.root, context.controlDirectory]);
}

export async function exactTransactionPathStat(path, statImplementation = nativeLstat) {
  if (typeof statImplementation !== 'function') {
    throw new Error('Transactional exact path-stat implementation is unavailable.');
  }
  return statImplementation(path, EXACT_STAT_OPTIONS);
}

export async function exactTransactionHandleStat(handle) {
  if (!handle || typeof handle.stat !== 'function') {
    throw new Error('Transactional exact handle-stat capability is unavailable.');
  }
  return handle.stat(EXACT_STAT_OPTIONS);
}

function exactUpdateBytes(value, label) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
  throw new Error(`Transactional update bytes must be exact text or bytes: ${label}.`);
}

function repositoryFileCreateMode() {
  return process.platform === 'win32' ? 0o666 : 0o666 & (~process.umask() & 0o777);
}

function transactionPermissionMode(information) {
  if (!hasExactBigIntFields(information, ['mode'])) {
    throw new Error('Transaction file lacks an exact bigint permission mode.');
  }
  return Number(information.mode & 0o777n);
}

function isPermissionMode(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 0o777;
}

function normalizedRepoPath(root, path) {
  const segments = typeof path === 'string' ? path.split('/') : [];
  if (
    typeof path !== 'string' ||
    !path ||
    path !== path.trim() ||
    path.includes('\\') ||
    path.includes('\0') ||
    isAbsolute(path) ||
    segments.some((segment) => !isPortableTransactionPathSegment(segment))
  ) {
    throw new Error(`Transactional path is not one normalized repository path: ${String(path)}.`);
  }
  const absolute = resolveInsideRoot(root, path);
  const normalized = relative(root, absolute).split(sep).join('/');
  if (
    normalized !== path ||
    /^\.git(?:\/|$)/iu.test(path) ||
    path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`Transactional path is not one normalized repository path: ${path}.`);
  }
  return normalized;
}

function isPortableTransactionPathSegment(segment) {
  if (
    !segment ||
    segment === '.' ||
    segment === '..' ||
    segment.normalize('NFC') !== segment ||
    /[<>:"|?*]/u.test(segment) ||
    [...segment].some((character) => character.codePointAt(0) <= 0x1f) ||
    /[ .]$/u.test(segment)
  ) {
    return false;
  }
  const base = segment.split('.')[0].toUpperCase();
  return !/^(?:AUX|CLOCK\$|CON|CONIN\$|CONOUT\$|NUL|PRN|COM[1-9¹²³]|LPT[1-9¹²³])$/u.test(base);
}

function resolveInsideRoot(root, path) {
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, String(path || ''));
  const child = relative(absoluteRoot, absolute);
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`Transactional path escapes or aliases the project root: ${String(path)}`);
  }
  return absolute;
}

async function lstatIfPresent(path) {
  try {
    return await exactTransactionPathStat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function assertExactTransactionFileStat(information, label, { requireSingleLink }) {
  if (!isExactTransactionFileStat(information) || (requireSingleLink && information.nlink !== 1n)) {
    throw new Error(`${label} must be an exact physical regular file.`);
  }
}

function isExactTransactionFileStat(information) {
  return Boolean(
    information?.isFile() &&
    !information.isSymbolicLink() &&
    hasExactBigIntFields(information, ['birthtimeNs', 'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink', 'size']) &&
    information.nlink >= 1n &&
    information.size >= 0n
  );
}

function sameTransactionPhysicalNode(left, right) {
  const fields = ['birthtimeNs', 'dev', 'ino', 'mode'];
  if (!hasExactBigIntFields(left, fields) || !hasExactBigIntFields(right, fields)) return false;
  if (left.dev !== right.dev || left.ino !== right.ino || left.mode !== right.mode) return false;
  return left.ino !== 0n || left.birthtimeNs === right.birthtimeNs;
}

function sameTransactionDirectoryNode(left, right) {
  const fields = ['birthtimeNs', 'dev', 'ino', 'mode', 'nlink'];
  if (!hasExactBigIntFields(left, fields) || !hasExactBigIntFields(right, fields)) return false;
  if (left.dev !== right.dev || left.ino !== right.ino || left.mode !== right.mode || left.nlink !== right.nlink) {
    return false;
  }
  return left.ino !== 0n || left.birthtimeNs === right.birthtimeNs;
}

export function sameTransactionFileIdentity(left, right) {
  const fields = ['birthtimeNs', 'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink', 'size'];
  if (!hasExactBigIntFields(left, fields) || !hasExactBigIntFields(right, fields)) return false;
  return fields.every((field) => left[field] === right[field]);
}

function assertDataMatches(observed, expected, label) {
  if (
    !expected ||
    observed.bytes.length !== expected.bytes.length ||
    observed.sha256 !== expected.sha256 ||
    !observed.bytes.equals(expected.bytes) ||
    (expected.mode !== undefined && transactionPermissionMode(observed.information) !== expected.mode)
  ) {
    throw new Error(`${label} bytes differ from their exact transaction binding.`);
  }
}

function assertStateData(observed, entry, prefix, label) {
  if (!observed || !matchesData(observed, entry[`${prefix}Bytes`], entry[`${prefix}Sha256`], entry[`${prefix}Mode`])) {
    throw new Error(`${label} differs from the exact journal binding: ${entry.repoPath}.`);
  }
}

function matchesData(observed, bytes, digest, mode = undefined) {
  return Boolean(
    observed &&
    observed.bytes.length === bytes &&
    observed.sha256 === digest &&
    (mode === undefined || transactionPermissionMode(observed.information) === mode)
  );
}

function exactOperationAllowlist(entries, expected) {
  return exactArray(
    entries.map(({ operation, path }) => ({ operation, path })),
    expected
  );
}

function transactionDigest({ entries, inputs, repositoryId, transactionId, transactionName }) {
  return sha256(canonicalJsonBytes({ entries, inputs, repositoryId, transactionId, transactionName }));
}

function canonicalJsonBytes(value) {
  return Buffer.from(`${stableJson(value)}\n`, 'utf8');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort(compareStrings)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertExactKeys(value, expected, label) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !exactArray(Object.keys(value).sort(compareStrings), [...expected].sort(compareStrings))
  ) {
    throw new Error(`${label} keys differ from the exact schema.`);
  }
}

function validateTransactionName(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(value)) {
    throw new Error('Transaction name must be one exact lowercase control identifier.');
  }
  return value;
}

function maybeCrash(requested, phase) {
  if (requested === null) return;
  assertTestOnlyCapability('testOnlyCrashAfter');
  if (
    !['journal', 'staging', 'first-promotion', 'marker', 'journal-remove', 'marker-remove', 'lock-remove'].includes(
      requested
    )
  ) {
    throw new Error('Unknown test-only retained transaction crash phase.');
  }
  if (requested === phase) {
    throw Object.assign(new Error(`Simulated retained transaction crash after ${phase}.`), {
      code: 'SITEWIPE_TEST_CRASH'
    });
  }
}

async function runTestOnlyTransactionHook(callback, phase, capability = 'testOnlyAfterPreflight') {
  if (callback === undefined) return;
  assertTestOnlyCapability(capability);
  if (typeof callback !== 'function') throw new Error('Test-only transaction hook must be one exact function.');
  await callback(phase);
}

function assertTestOnlyCapability(label) {
  if (!isNodeTestContext()) throw new Error(`${label} is available only to the Node test runner.`);
}

function isNodeTestContext() {
  return typeof process.env.NODE_TEST_CONTEXT === 'string' && process.env.NODE_TEST_CONTEXT.length > 0;
}

function isContainedPath(root, path) {
  const child = relative(root, path);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}

function normalizedHostPath(value) {
  const exact = resolve(value);
  return process.platform === 'win32' ? exact.toLowerCase() : exact;
}

function transactionRepositoryId(information, testOnlyRootInformation = null) {
  const fields = ['birthtimeNs', 'dev', 'ino', 'mode'];
  if (
    !hasExactBigIntFields(information, fields) ||
    (testOnlyRootInformation && !hasExactBigIntFields(testOnlyRootInformation, fields))
  ) {
    throw new Error('Transaction control directory lacks an exact stable physical identity.');
  }
  const controlIdentity = fields.map((field) => `control.${field}:${information[field]}`);
  const testRootIdentity = testOnlyRootInformation
    ? fields.map((field) => `testRoot.${field}:${testOnlyRootInformation[field]}`)
    : [];
  return sha256(Buffer.from([...controlIdentity, ...testRootIdentity].join('|'), 'utf8'));
}

function sameTransactionPath(left, right) {
  return normalizedHostPath(left) === normalizedHostPath(right);
}

function hasExactBigIntFields(value, fields) {
  return Boolean(value) && fields.every((field) => typeof value[field] === 'bigint');
}

function exactArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) && JSON.stringify(left) === JSON.stringify(right);
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isCanonicalUuid(value) {
  return (
    typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

function isSha256(value) {
  return typeof value === 'string' && /^[A-F0-9]{64}$/.test(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

import { randomUUID } from 'node:crypto';
import { link, lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';

export async function recoverFileTransaction(root, transactionName = 'sitewipe-version-bump') {
  const paths = transactionControlPaths(root, transactionName);
  const journal = await readJournal(paths.journal);
  if (!journal) {
    await removeFileIfPresent(paths.marker);
    return { recovered: false };
  }
  const entries = journal.entries.map((entry) => normalizeJournalEntry(root, entry));
  const committed = await isFile(paths.marker);
  if (committed) {
    for (const entry of entries) {
      await removeFileIfPresent(entry.temp);
      await removeFileIfPresent(entry.backup);
    }
  } else {
    for (const entry of [...entries].reverse()) {
      if (entry.operation === 'create') {
        await removeCreatedTarget(entry);
      } else if (await isFile(entry.backup)) {
        await removeFileIfPresent(entry.target);
        await rename(entry.backup, entry.target);
      }
      await removeFileIfPresent(entry.temp);
    }
  }
  await removeFileIfPresent(paths.journal);
  await removeFileIfPresent(paths.marker);
  return { recovered: true, committed, entries: entries.length };
}

export async function transactionalWriteFiles(
  root,
  updates,
  transactionName = 'sitewipe-version-bump',
  { createOnlyPaths = new Set() } = {}
) {
  await recoverFileTransaction(root, transactionName);
  const transactionId = randomUUID();
  const entries = [];
  const normalizedCreateOnlyPaths = new Set([...createOnlyPaths].map((repoPath) => normalizedRepoPath(root, repoPath)));
  for (const [repoPath, value] of updates) {
    const target = resolveInsideRoot(root, repoPath);
    const normalizedPath = relative(root, target).split(sep).join('/');
    const operation = normalizedCreateOnlyPaths.has(normalizedPath) ? 'create' : 'replace';
    const info = await lstatIfPresent(target);
    if (operation === 'create' && info) {
      throw new Error(`Transactional create target already exists and will not be overwritten: ${repoPath}`);
    }
    if (operation === 'replace' && (!info || !info.isFile() || info.isSymbolicLink())) {
      throw new Error(`Transactional update target must be a regular existing file: ${repoPath}`);
    }
    const suffix = `.sitewipe-${transactionId}`;
    entries.push({
      repoPath: normalizedPath,
      operation,
      target,
      temp: resolve(dirname(target), `.${basename(target)}${suffix}.tmp`),
      backup: resolve(dirname(target), `.${basename(target)}${suffix}.bak`),
      value
    });
  }
  const paths = transactionControlPaths(root, transactionName);
  const journalTemp = `${paths.journal}.${transactionId}.tmp`;
  try {
    for (const entry of entries) await writeFile(entry.temp, entry.value, { flag: 'wx' });
    const journal = {
      schemaVersion: 1,
      transactionName,
      transactionId,
      entries: entries.map((entry) => ({
        target: relative(root, entry.target).split(sep).join('/'),
        temp: relative(root, entry.temp).split(sep).join('/'),
        backup: relative(root, entry.backup).split(sep).join('/'),
        operation: entry.operation
      }))
    };
    await writeFile(journalTemp, `${JSON.stringify(journal, null, 2)}\n`, { flag: 'wx' });
    await rename(journalTemp, paths.journal);

    for (const entry of entries) {
      if (entry.operation === 'create') {
        await link(entry.temp, entry.target);
      } else {
        await rename(entry.target, entry.backup);
        await rename(entry.temp, entry.target);
      }
    }
    await writeFile(paths.marker, `${transactionId}\n`, { flag: 'wx' });
    for (const entry of entries) {
      await removeFileIfPresent(entry.temp);
      await removeFileIfPresent(entry.backup);
    }
    await removeFileIfPresent(paths.journal);
    await removeFileIfPresent(paths.marker);
    return { filesUpdated: entries.length, transactionId };
  } catch (error) {
    await removeFileIfPresent(journalTemp).catch(() => {});
    let recoveryError = null;
    try {
      await recoverFileTransaction(root, transactionName);
    } catch (rollbackError) {
      recoveryError = rollbackError;
    }
    for (const entry of entries) {
      await removeFileIfPresent(entry.temp).catch(() => {});
      if (!recoveryError) await removeFileIfPresent(entry.backup).catch(() => {});
    }
    if (recoveryError) {
      throw new AggregateError([error, recoveryError], 'Version-file transaction failed and rollback was incomplete.', {
        cause: error
      });
    }
    throw new Error('Version-file transaction failed and was rolled back.', { cause: error });
  }
}

function transactionControlPaths(root, transactionName) {
  const safeName = String(transactionName).replace(/[^a-z0-9._-]+/gi, '-');
  return {
    journal: resolve(root, `.${safeName}.transaction.json`),
    marker: resolve(root, `.${safeName}.transaction.committed`)
  };
}

async function readJournal(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error(`Cannot read file-transaction journal: ${path}`, { cause: error });
  }
}

function normalizeJournalEntry(root, entry) {
  return {
    target: resolveInsideRoot(root, entry?.target),
    temp: resolveInsideRoot(root, entry?.temp),
    backup: resolveInsideRoot(root, entry?.backup),
    operation: entry?.operation === 'create' ? 'create' : 'replace'
  };
}

function normalizedRepoPath(root, path) {
  const absolute = resolveInsideRoot(root, path);
  return relative(root, absolute).split(sep).join('/');
}

function resolveInsideRoot(root, path) {
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, String(path || ''));
  const child = relative(absoluteRoot, absolute);
  if (!child || child === '..' || child.startsWith(`..${sep}`)) {
    throw new Error(`Transactional path escapes or aliases the project root: ${String(path)}`);
  }
  return absolute;
}

async function isFile(path) {
  try {
    return (await lstat(path)).isFile();
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function lstatIfPresent(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function removeCreatedTarget(entry) {
  const target = await lstatIfPresent(entry.target);
  if (!target) return;
  const temp = await lstatIfPresent(entry.temp);
  if (!temp || !target.ino || target.dev !== temp.dev || target.ino !== temp.ino) {
    throw new Error(`Cannot safely roll back transactional file creation: ${entry.target}`);
  }
  await removeFileIfPresent(entry.target);
}

async function removeFileIfPresent(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`Refusing to remove non-file transaction path: ${path}`);
    await rm(path, { force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

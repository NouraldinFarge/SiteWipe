import assert from 'node:assert/strict';
import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { recoverFileTransaction, transactionalWriteFiles } from '../../scripts/transactional-files.mjs';

test('transactional file updates promote every staged file together', async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), 'sitewipe-transaction-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(resolve(root, 'a.txt'), 'old-a');
  await writeFile(resolve(root, 'b.txt'), 'old-b');

  const result = await transactionalWriteFiles(
    root,
    new Map([
      ['a.txt', 'new-a'],
      ['b.txt', 'new-b']
    ]),
    'test-update'
  );

  assert.equal(result.filesUpdated, 2);
  assert.equal(await readFile(resolve(root, 'a.txt'), 'utf8'), 'new-a');
  assert.equal(await readFile(resolve(root, 'b.txt'), 'utf8'), 'new-b');
});

test('transactional file creation advances existing files without overwriting history', async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), 'sitewipe-transaction-create-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(resolve(root, 'pointer.txt'), 'old-pointer');

  const result = await transactionalWriteFiles(
    root,
    new Map([
      ['history.txt', 'preserved-history'],
      ['next.txt', 'next-record'],
      ['pointer.txt', 'next.txt']
    ]),
    'test-create',
    { createOnlyPaths: new Set(['history.txt', 'next.txt']) }
  );

  assert.equal(result.filesUpdated, 3);
  assert.equal(await readFile(resolve(root, 'history.txt'), 'utf8'), 'preserved-history');
  assert.equal(await readFile(resolve(root, 'next.txt'), 'utf8'), 'next-record');
  assert.equal(await readFile(resolve(root, 'pointer.txt'), 'utf8'), 'next.txt');

  await assert.rejects(
    transactionalWriteFiles(
      root,
      new Map([
        ['history.txt', 'replacement-history'],
        ['pointer.txt', 'other.txt']
      ]),
      'test-create-again',
      { createOnlyPaths: new Set(['history.txt']) }
    ),
    /already exists and will not be overwritten/
  );
  assert.equal(await readFile(resolve(root, 'history.txt'), 'utf8'), 'preserved-history');
  assert.equal(await readFile(resolve(root, 'pointer.txt'), 'utf8'), 'next.txt');
});

test('recovery rolls an interrupted uncommitted promotion back to its original bytes', async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), 'sitewipe-rollback-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(resolve(root, 'a.txt'), 'new-a');
  await writeFile(resolve(root, '.a.txt.tx.tmp'), 'staged-a');
  await writeFile(resolve(root, '.a.txt.tx.bak'), 'old-a');
  await writeFile(
    resolve(root, '.test-recovery.transaction.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      entries: [{ target: 'a.txt', temp: '.a.txt.tx.tmp', backup: '.a.txt.tx.bak' }]
    })}\n`
  );

  const result = await recoverFileTransaction(root, 'test-recovery');

  assert.equal(result.recovered, true);
  assert.equal(result.committed, false);
  assert.equal(await readFile(resolve(root, 'a.txt'), 'utf8'), 'old-a');
});

test('recovery completes cleanup after the commit marker was written', async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), 'sitewipe-commit-recovery-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(resolve(root, 'a.txt'), 'new-a');
  await writeFile(resolve(root, '.a.txt.tx.bak'), 'old-a');
  await writeFile(
    resolve(root, '.test-commit.transaction.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      entries: [{ target: 'a.txt', temp: '.a.txt.tx.tmp', backup: '.a.txt.tx.bak' }]
    })}\n`
  );
  await writeFile(resolve(root, '.test-commit.transaction.committed'), 'committed\n');

  const result = await recoverFileTransaction(root, 'test-commit');

  assert.equal(result.committed, true);
  assert.equal(await readFile(resolve(root, 'a.txt'), 'utf8'), 'new-a');
});

test('recovery removes an uncommitted created file and restores the prior pointer', async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), 'sitewipe-create-rollback-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(resolve(root, 'pointer.txt'), 'new-pointer');
  await writeFile(resolve(root, '.pointer.txt.tx.bak'), 'old-pointer');
  await writeFile(resolve(root, '.pointer.txt.tx.tmp'), 'staged-pointer');
  await writeFile(resolve(root, '.history.txt.tx.tmp'), 'preserved-history');
  await link(resolve(root, '.history.txt.tx.tmp'), resolve(root, 'history.txt'));
  await writeFile(
    resolve(root, '.test-create-recovery.transaction.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      entries: [
        {
          target: 'history.txt',
          temp: '.history.txt.tx.tmp',
          backup: '.history.txt.tx.bak',
          operation: 'create'
        },
        {
          target: 'pointer.txt',
          temp: '.pointer.txt.tx.tmp',
          backup: '.pointer.txt.tx.bak',
          operation: 'replace'
        }
      ]
    })}\n`
  );

  const result = await recoverFileTransaction(root, 'test-create-recovery');

  assert.equal(result.recovered, true);
  assert.equal(result.committed, false);
  assert.equal(await readFile(resolve(root, 'pointer.txt'), 'utf8'), 'old-pointer');
  await assert.rejects(readFile(resolve(root, 'history.txt')), { code: 'ENOENT' });
});

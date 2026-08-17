import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

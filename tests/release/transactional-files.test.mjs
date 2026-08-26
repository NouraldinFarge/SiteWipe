import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  FILE_TRANSACTION_DURABILITY_LIMITATION,
  exactTransactionHandleStat,
  exactTransactionPathStat,
  recoverFileTransaction,
  sameTransactionFileIdentity,
  transactionalWriteFiles
} from '../../scripts/transactional-files.mjs';

test('transaction identities are BigInt-exact and production control discovery is Git-bound', async () => {
  const [original, differentInode, differentDevice] = collidingExactStats();
  assert.equal(Number(original.ino), Number(differentInode.ino));
  assert.equal(sameTransactionFileIdentity(original, differentInode), false);
  assert.equal(sameTransactionFileIdentity(original, differentDevice), false);
  assert.equal(sameTransactionFileIdentity({ ...original, ino: Number(original.ino) }, original), false);

  const pathCalls = [];
  await exactTransactionPathStat('transaction-path', async (...args) => {
    pathCalls.push(args);
    return original;
  });
  assert.deepEqual(pathCalls, [['transaction-path', { bigint: true }]]);
  const handleCalls = [];
  await exactTransactionHandleStat({ stat: async (options) => (handleCalls.push(options), original) });
  assert.deepEqual(handleCalls, [{ bigint: true }]);

  const source = await readFile(new URL('../../scripts/transactional-files.mjs', import.meta.url), 'utf8');
  const bumpSource = await readFile(new URL('../../scripts/bump-version.mjs', import.meta.url), 'utf8');
  assert.match(source, /assertTrustedGitRepository\(rootIdentity\.path\)/u);
  assert.match(source, /trusted\.gitDir/u);
  assert.match(bumpSource, /await assertFileTransactionCanStart\(projectRoot, 'sitewipe-version-bump'\)/u);
  assert.ok(bumpSource.indexOf('assertFileTransactionCanStart(projectRoot') < bumpSource.indexOf('const updates'));
  assert.match(bumpSource, /computeVersionFingerprintSnapshot\(projectRoot, updates\)/u);
  assert.match(
    bumpSource,
    /versionTransactionInputSnapshot\.set\(validationRecordInputPath, validationEvidenceTransition\.previousBytes\)/u
  );
  assert.match(bumpSource, /expectedInputSnapshot: versionTransactionInputSnapshot/u);
  assert.match(
    bumpSource,
    /resolveInputPaths:[\s\S]*collectVersionFingerprintPaths\(projectRoot\)[\s\S]*validationRecordInputPath/u
  );
  assert.match(FILE_TRANSACTION_DURABILITY_LIMITATION, /not an atomic multi-file filesystem commit/u);
  assert.match(FILE_TRANSACTION_DURABILITY_LIMITATION, /does not prove parent-directory-entry durability/u);
  assert.doesNotMatch(source, /\bhandle\.stat\(\s*\)/u);
  assert.doesNotMatch(source, /\bnativeLstat\(/u);
  assert.doesNotMatch(source, /import\s*\{[^}]*\breadFile\b[^}]*\}\s*from\s*'node:fs\/promises'/su);
  assert.doesNotMatch(source, /import\s*\{[^}]*\bwriteFile\b[^}]*\}\s*from\s*'node:fs\/promises'/su);
});

test('transactional updates and immutable creations promote together without worktree control files', async (t) => {
  const { control, root } = await transactionFixture(t, 'sitewipe-transaction-success-');
  await writeFile(resolve(root, 'a.txt'), 'old-a');
  await writeFile(resolve(root, 'b.txt'), 'old-b');
  if (process.platform !== 'win32') {
    await chmod(resolve(root, 'a.txt'), 0o751);
    await chmod(resolve(root, 'b.txt'), 0o640);
  }

  const result = await transactionalWriteFiles(
    root,
    new Map([
      ['a.txt', 'new-a'],
      ['b.txt', 'new-b'],
      ['history.txt', 'preserved-history']
    ]),
    'test-success',
    {
      createOnlyPaths: new Set(['history.txt']),
      testOnlyControlDirectory: control
    }
  );

  assert.equal(result.filesUpdated, 3);
  assert.equal(await readFile(resolve(root, 'a.txt'), 'utf8'), 'new-a');
  assert.equal(await readFile(resolve(root, 'b.txt'), 'utf8'), 'new-b');
  assert.equal(await readFile(resolve(root, 'history.txt'), 'utf8'), 'preserved-history');
  assert.deepEqual(await readdir(control), []);
  assert.deepEqual((await readdir(root)).sort(), ['a.txt', 'b.txt', 'history.txt']);
  if (process.platform !== 'win32') {
    assert.equal(Number((await lstat(resolve(root, 'a.txt'), { bigint: true })).mode & 0o777n), 0o751);
    assert.equal(Number((await lstat(resolve(root, 'b.txt'), { bigint: true })).mode & 0o777n), 0o640);
    assert.equal(
      Number((await lstat(resolve(root, 'history.txt'), { bigint: true })).mode & 0o777n),
      0o666 & (~process.umask() & 0o777)
    );
  }

  await assert.rejects(
    transactionalWriteFiles(root, new Map([['history.txt', 'replacement']]), 'test-existing-create', {
      createOnlyPaths: new Set(['history.txt']),
      testOnlyControlDirectory: control
    }),
    /already exists and will not be overwritten/
  );
  assert.equal(await readFile(resolve(root, 'history.txt'), 'utf8'), 'preserved-history');
});

test('planned replacements are bound to every exact original source byte before lock acquisition', async (t) => {
  const { control, root } = await transactionFixture(t, 'sitewipe-transaction-planning-binding-');
  await writeFile(resolve(root, 'a.txt'), 'old-a');
  await writeFile(resolve(root, 'b.txt'), 'old-b');
  const updates = new Map([
    ['a.txt', 'new-a'],
    ['b.txt', 'new-b']
  ]);
  const expectedOriginals = new Map([
    ['a.txt', 'old-a'],
    ['b.txt', 'old-b']
  ]);
  await writeFile(resolve(root, 'a.txt'), 'racing-a');

  await assert.rejects(
    transactionalWriteFiles(root, updates, 'test-planning-binding', {
      expectedOriginals,
      testOnlyControlDirectory: control
    }),
    /differs from the exact source bytes used to plan/
  );
  assert.equal(await readFile(resolve(root, 'a.txt'), 'utf8'), 'racing-a');
  assert.equal(await readFile(resolve(root, 'b.txt'), 'utf8'), 'old-b');
  assert.deepEqual(await readdir(control), []);

  await assert.rejects(
    transactionalWriteFiles(root, updates, 'test-planning-coverage', {
      expectedOriginals: new Map([['a.txt', 'racing-a']]),
      testOnlyControlDirectory: control
    }),
    /exactly cover every replacement and no creation/
  );
  assert.deepEqual(await readdir(control), []);
});

test('full input snapshots are captured under the lock and replayed before worktree mutation', async (t) => {
  await t.test('exact transaction-derived siblings do not self-invalidate full inventory replay', async (t) => {
    const { control, root } = await transactionFixture(t, 'sitewipe-transaction-input-transients-');
    await writeFile(resolve(root, 'a.txt'), 'old-a');
    await writeFile(resolve(root, 'b.txt'), 'old-b');
    await writeFile(resolve(root, 'fingerprint.txt'), 'stable');

    const result = await transactionalWriteFiles(
      root,
      new Map([
        ['a.txt', 'new-a'],
        ['b.txt', 'new-b']
      ]),
      'test-input-transients',
      {
        expectedInputSnapshot: new Map([
          ['a.txt', 'new-a'],
          ['b.txt', 'new-b'],
          ['fingerprint.txt', 'stable']
        ]),
        resolveInputPaths: async () => readdir(root),
        testOnlyControlDirectory: control
      }
    );

    assert.equal(result.filesUpdated, 2);
    assert.equal(await readFile(resolve(root, 'a.txt'), 'utf8'), 'new-a');
    assert.equal(await readFile(resolve(root, 'b.txt'), 'utf8'), 'new-b');
    assert.deepEqual((await readdir(root)).sort(), ['a.txt', 'b.txt', 'fingerprint.txt']);
    assert.deepEqual(await readdir(control), []);
  });

  await t.test('a foreign lookalike sibling remains an unexpected inventory path', async (t) => {
    const { control, root } = await transactionFixture(t, 'sitewipe-transaction-input-lookalike-');
    await writeFile(resolve(root, 'a.txt'), 'old-a');
    await writeFile(resolve(root, 'fingerprint.txt'), 'stable');
    const lookalikePath = resolve(root, '.a.txt.sitewipe-foreign.tmp');

    await assert.rejects(
      transactionalWriteFiles(root, new Map([['a.txt', 'new-a']]), 'test-input-lookalike', {
        expectedInputSnapshot: new Map([
          ['a.txt', 'new-a'],
          ['fingerprint.txt', 'stable']
        ]),
        resolveInputPaths: async () => readdir(root),
        testOnlyAfterInputCapture: async () => writeFile(lookalikePath, 'foreign'),
        testOnlyControlDirectory: control
      }),
      (error) => {
        assert.equal(error.code, 'SITEWIPE_RECOVERY_REQUIRED');
        assert.match(error.cause?.message || '', /path inventory changed after planning/u);
        return true;
      }
    );
    assert.equal(await readFile(resolve(root, 'a.txt'), 'utf8'), 'old-a');
    assert.equal(await readFile(lookalikePath, 'utf8'), 'foreign');
    await recoverFileTransaction(root, 'test-input-lookalike', {
      expectedOperations: [{ operation: 'replace', path: 'a.txt' }],
      testOnlyControlDirectory: control
    });
    assert.equal(await readFile(lookalikePath, 'utf8'), 'foreign');
  });

  await t.test('same-size byte mutation is refused and explicit recovery never mutates the input', async (t) => {
    const { control, root } = await transactionFixture(t, 'sitewipe-transaction-input-bytes-');
    await writeFile(resolve(root, 'a.txt'), 'old-a');
    await writeFile(resolve(root, 'fingerprint.txt'), 'stable');

    await assert.rejects(
      transactionalWriteFiles(root, new Map([['a.txt', 'new-a']]), 'test-input-bytes', {
        expectedInputSnapshot: new Map([
          ['a.txt', 'new-a'],
          ['fingerprint.txt', 'stable']
        ]),
        resolveInputPaths: async () => ['a.txt', 'fingerprint.txt'],
        testOnlyAfterInputCapture: async () => {
          assert.equal(
            (await readdir(control)).some((name) => name.endsWith('.lock.json')),
            true
          );
          await writeFile(resolve(root, 'fingerprint.txt'), 'racing');
        },
        testOnlyControlDirectory: control
      }),
      (error) => {
        assert.equal(error.code, 'SITEWIPE_RECOVERY_REQUIRED');
        assert.match(error.cause?.message || '', /bytes differ from their exact transaction binding/u);
        return true;
      }
    );
    assert.equal(await readFile(resolve(root, 'a.txt'), 'utf8'), 'old-a');
    assert.equal(await readFile(resolve(root, 'fingerprint.txt'), 'utf8'), 'racing');
    assert.deepEqual((await readdir(root)).sort(), ['a.txt', 'fingerprint.txt']);

    const recovery = await recoverFileTransaction(root, 'test-input-bytes', {
      expectedOperations: [{ operation: 'replace', path: 'a.txt' }],
      testOnlyControlDirectory: control
    });
    assert.equal(recovery.recovered, true);
    assert.equal(recovery.committed, false);
    assert.equal(await readFile(resolve(root, 'a.txt'), 'utf8'), 'old-a');
    assert.equal(await readFile(resolve(root, 'fingerprint.txt'), 'utf8'), 'racing');
    assert.deepEqual(await readdir(control), []);
  });

  await t.test('the exact planned validation record is immutable transaction input', async (t) => {
    const { control, root } = await transactionFixture(t, 'sitewipe-transaction-validation-record-');
    const evidenceDirectory = resolve(root, 'docs', 'evidence');
    const currentRecord = 'docs/evidence/automated-validation-2026-08-25-v1.2.3.json';
    const nextRecord = 'docs/evidence/automated-validation-2026-08-25-v1.2.4.json';
    const pointerPath = 'docs/evidence/automated-validation-current.json';
    const plannedRecordBytes = '{"fullCheck":{"versionContract":{"version":"1.2.3"}}}\n';
    const racedRecordBytes = '{"fullCheck":{"versionContract":{"version":"9.9.9"}}}\n';
    const oldPointerBytes = '{"record":"automated-validation-2026-08-25-v1.2.3.json"}\n';
    const newPointerBytes = '{"record":"automated-validation-2026-08-25-v1.2.4.json"}\n';
    await mkdir(evidenceDirectory, { recursive: true });
    await writeFile(resolve(root, currentRecord), plannedRecordBytes);
    await writeFile(resolve(root, pointerPath), oldPointerBytes);
    await writeFile(resolve(root, 'version.txt'), '1.2.3\n');

    await assert.rejects(
      transactionalWriteFiles(
        root,
        new Map([
          [nextRecord, '{"status":"pending","version":"1.2.4"}\n'],
          [pointerPath, newPointerBytes],
          ['version.txt', '1.2.4\n']
        ]),
        'test-validation-record-binding',
        {
          createOnlyPaths: new Set([nextRecord]),
          expectedInputSnapshot: new Map([
            [currentRecord, plannedRecordBytes],
            ['version.txt', '1.2.4\n']
          ]),
          expectedOriginals: new Map([
            [pointerPath, oldPointerBytes],
            ['version.txt', '1.2.3\n']
          ]),
          resolveInputPaths: async () => [currentRecord, 'version.txt'],
          testOnlyAfterInputCapture: async () => {
            assert.equal(
              (await readdir(control)).some((name) => name.endsWith('.lock.json')),
              true
            );
            await writeFile(resolve(root, currentRecord), racedRecordBytes);
          },
          testOnlyControlDirectory: control
        }
      ),
      (error) => {
        assert.equal(error.code, 'SITEWIPE_RECOVERY_REQUIRED');
        assert.match(error.cause?.message || '', /bytes differ from their exact transaction binding/u);
        return true;
      }
    );
    assert.equal(await readFile(resolve(root, currentRecord), 'utf8'), racedRecordBytes);
    assert.equal(await readFile(resolve(root, pointerPath), 'utf8'), oldPointerBytes);
    assert.equal(await readFile(resolve(root, 'version.txt'), 'utf8'), '1.2.3\n');
    await assert.rejects(readFile(resolve(root, nextRecord)), { code: 'ENOENT' });

    const recovery = await recoverFileTransaction(root, 'test-validation-record-binding', {
      expectedOperations: [
        { operation: 'create', path: nextRecord },
        { operation: 'replace', path: pointerPath },
        { operation: 'replace', path: 'version.txt' }
      ],
      testOnlyControlDirectory: control
    });
    assert.equal(recovery.recovered, true);
    assert.equal(recovery.committed, false);
    assert.equal(await readFile(resolve(root, currentRecord), 'utf8'), racedRecordBytes);
    assert.equal(await readFile(resolve(root, pointerPath), 'utf8'), oldPointerBytes);
    assert.equal(await readFile(resolve(root, 'version.txt'), 'utf8'), '1.2.3\n');
    await assert.rejects(readFile(resolve(root, nextRecord)), { code: 'ENOENT' });
    assert.deepEqual(await readdir(control), []);
  });

  await t.test('planning-to-lock drift is refused before any target or staging mutation', async (t) => {
    const { control, root } = await transactionFixture(t, 'sitewipe-transaction-input-planning-drift-');
    await writeFile(resolve(root, 'a.txt'), 'old-a');
    await writeFile(resolve(root, 'fingerprint.txt'), 'stable');
    const snapshot = new Map([
      ['a.txt', 'new-a'],
      ['fingerprint.txt', 'stable']
    ]);
    await writeFile(resolve(root, 'fingerprint.txt'), 'racing');

    await assert.rejects(
      transactionalWriteFiles(root, new Map([['a.txt', 'new-a']]), 'test-input-planning-drift', {
        expectedInputSnapshot: snapshot,
        resolveInputPaths: async () => ['a.txt', 'fingerprint.txt'],
        testOnlyControlDirectory: control
      }),
      (error) => {
        assert.equal(error.code, 'SITEWIPE_RECOVERY_REQUIRED');
        assert.match(error.cause?.message || '', /bytes differ from their exact transaction binding/u);
        return true;
      }
    );
    assert.equal(await readFile(resolve(root, 'a.txt'), 'utf8'), 'old-a');
    assert.deepEqual((await readdir(root)).sort(), ['a.txt', 'fingerprint.txt']);
    await recoverFileTransaction(root, 'test-input-planning-drift', {
      expectedOperations: [{ operation: 'replace', path: 'a.txt' }],
      testOnlyControlDirectory: control
    });
    assert.equal(await readFile(resolve(root, 'fingerprint.txt'), 'utf8'), 'racing');
  });

  await t.test('same-byte physical replacement is rejected by full identity replay', async (t) => {
    const { control, root } = await transactionFixture(t, 'sitewipe-transaction-input-identity-');
    const inputPath = resolve(root, 'fingerprint.txt');
    await writeFile(resolve(root, 'a.txt'), 'old-a');
    await writeFile(inputPath, 'stable');

    await assert.rejects(
      transactionalWriteFiles(root, new Map([['a.txt', 'new-a']]), 'test-input-identity', {
        expectedInputSnapshot: new Map([
          ['a.txt', 'new-a'],
          ['fingerprint.txt', 'stable']
        ]),
        resolveInputPaths: async () => ['a.txt', 'fingerprint.txt'],
        testOnlyAfterInputCapture: async () => {
          await rename(inputPath, resolve(root, 'fingerprint-retired.txt'));
          await writeFile(inputPath, 'stable');
        },
        testOnlyControlDirectory: control
      }),
      (error) => {
        assert.equal(error.code, 'SITEWIPE_RECOVERY_REQUIRED');
        assert.match(error.cause?.message || '', /input identity changed/u);
        return true;
      }
    );
    assert.equal(await readFile(resolve(root, 'a.txt'), 'utf8'), 'old-a');
    await recoverFileTransaction(root, 'test-input-identity', {
      expectedOperations: [{ operation: 'replace', path: 'a.txt' }],
      testOnlyControlDirectory: control
    });
    assert.deepEqual(await readdir(control), []);
  });

  await t.test('a new fingerprint path after capture changes the exact inventory', async (t) => {
    const { control, root } = await transactionFixture(t, 'sitewipe-transaction-input-inventory-');
    await writeFile(resolve(root, 'a.txt'), 'old-a');
    await writeFile(resolve(root, 'fingerprint.txt'), 'stable');
    const discovered = ['a.txt', 'fingerprint.txt'];

    await assert.rejects(
      transactionalWriteFiles(root, new Map([['a.txt', 'new-a']]), 'test-input-inventory', {
        expectedInputSnapshot: new Map([
          ['a.txt', 'new-a'],
          ['fingerprint.txt', 'stable']
        ]),
        resolveInputPaths: async () => [...discovered],
        testOnlyAfterInputCapture: async () => {
          await writeFile(resolve(root, 'new-stable.txt'), 'new');
          discovered.push('new-stable.txt');
        },
        testOnlyControlDirectory: control
      }),
      (error) => {
        assert.equal(error.code, 'SITEWIPE_RECOVERY_REQUIRED');
        assert.match(error.cause?.message || '', /path inventory changed after planning/u);
        return true;
      }
    );
    assert.equal(await readFile(resolve(root, 'a.txt'), 'utf8'), 'old-a');
    await recoverFileTransaction(root, 'test-input-inventory', {
      expectedOperations: [{ operation: 'replace', path: 'a.txt' }],
      testOnlyControlDirectory: control
    });
  });
});

test('input snapshot path and staged-byte validation fail closed', async (t) => {
  const { control, root } = await transactionFixture(t, 'sitewipe-transaction-input-validation-');
  await writeFile(resolve(root, 'a.txt'), 'old-a');

  await assert.rejects(
    transactionalWriteFiles(root, new Map([['a.txt', 'new-a']]), 'test-input-staged-mismatch', {
      expectedInputSnapshot: new Map([['a.txt', 'not-new-a']]),
      resolveInputPaths: async () => ['a.txt'],
      testOnlyControlDirectory: control
    }),
    /input snapshot differs from its staged update bytes/u
  );
  await assert.rejects(
    transactionalWriteFiles(root, new Map([['a.txt', 'new-a']]), 'test-input-invalid-path', {
      expectedInputSnapshot: new Map([['carrier.txt:secret', 'stable']]),
      resolveInputPaths: async () => ['carrier.txt:secret'],
      testOnlyControlDirectory: control
    }),
    /not one normalized repository path/u
  );
  await assert.rejects(
    transactionalWriteFiles(root, new Map([['a.txt', 'new-a']]), 'test-input-missing-resolver', {
      expectedInputSnapshot: new Map([['a.txt', 'new-a']]),
      testOnlyControlDirectory: control
    }),
    /requires one exact path-inventory resolver/u
  );
  await assert.rejects(
    transactionalWriteFiles(root, new Map([['a.txt', 'new-a']]), 'test-input-missing-snapshot', {
      resolveInputPaths: async () => ['a.txt'],
      testOnlyControlDirectory: control
    }),
    /expected input snapshot must be one exact Map/u
  );
  assert.equal(await readFile(resolve(root, 'a.txt'), 'utf8'), 'old-a');
  assert.deepEqual(await readdir(control), []);
});

test(
  'private control records remain owner-readable under a restrictive process umask',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { control, root } = await transactionFixture(t, 'sitewipe-transaction-control-mode-');
    await writeFile(resolve(root, 'a.txt'), 'old-a');
    const priorUmask = process.umask(0o777);
    try {
      await assert.rejects(
        transactionalWriteFiles(root, new Map([['a.txt', 'new-a']]), 'test-control-mode', {
          testOnlyControlDirectory: control,
          testOnlyCrashAfter: 'journal'
        }),
        /Simulated retained transaction crash/
      );
    } finally {
      process.umask(priorUmask);
    }
    for (const name of await readdir(control)) {
      assert.equal(Number((await lstat(resolve(control, name), { bigint: true })).mode & 0o777n), 0o600);
    }
    await recoverFileTransaction(root, 'test-control-mode', {
      expectedOperations: [{ operation: 'replace', path: 'a.txt' }],
      testOnlyControlDirectory: control
    });
    assert.deepEqual(await readdir(control), []);
  }
);

for (const crashPhase of ['journal', 'first-promotion']) {
  test(`explicit recovery rolls back the exact ${crashPhase} crash state`, async (t) => {
    const { control, root } = await transactionFixture(t, `sitewipe-transaction-${crashPhase}-`);
    await writeFile(resolve(root, 'a.txt'), 'old-a');
    await writeFile(resolve(root, 'b.txt'), 'old-b');
    const updates = new Map([
      ['a.txt', 'new-a'],
      ['b.txt', 'new-b']
    ]);

    await assert.rejects(
      transactionalWriteFiles(root, updates, `test-crash-${crashPhase}`, {
        testOnlyControlDirectory: control,
        testOnlyCrashAfter: crashPhase
      }),
      /Simulated retained transaction crash/
    );
    await assert.rejects(
      transactionalWriteFiles(root, updates, `test-crash-${crashPhase}`, {
        testOnlyControlDirectory: control
      }),
      /concurrent or stale retained transaction lock/
    );

    const recovery = await recoverFileTransaction(root, `test-crash-${crashPhase}`, {
      expectedOperations: [
        { operation: 'replace', path: 'a.txt' },
        { operation: 'replace', path: 'b.txt' }
      ],
      testOnlyControlDirectory: control
    });
    assert.equal(recovery.recovered, true);
    assert.equal(recovery.committed, false);
    assert.equal(await readFile(resolve(root, 'a.txt'), 'utf8'), 'old-a');
    assert.equal(await readFile(resolve(root, 'b.txt'), 'utf8'), 'old-b');
    assert.deepEqual(await readdir(control), []);
  });
}

test('topology-first recovery rolls back a promoted replacement whose new bytes equal its original bytes', async (t) => {
  const { control, root } = await transactionFixture(t, 'sitewipe-transaction-identical-replacement-');
  await writeFile(resolve(root, 'a.txt'), 'same-bytes');
  await assert.rejects(
    transactionalWriteFiles(root, new Map([['a.txt', 'same-bytes']]), 'test-identical-replacement', {
      testOnlyControlDirectory: control,
      testOnlyCrashAfter: 'first-promotion'
    }),
    /Simulated retained transaction crash/
  );
  const recovery = await recoverFileTransaction(root, 'test-identical-replacement', {
    expectedOperations: [{ operation: 'replace', path: 'a.txt' }],
    testOnlyControlDirectory: control
  });
  assert.equal(recovery.committed, false);
  assert.equal(await readFile(resolve(root, 'a.txt'), 'utf8'), 'same-bytes');
  assert.deepEqual(await readdir(control), []);
  assert.deepEqual(await readdir(root), ['a.txt']);
});

test('explicit recovery completes cleanup only for an exact bound commit marker', async (t) => {
  const { control, root } = await transactionFixture(t, 'sitewipe-transaction-committed-');
  await writeFile(resolve(root, 'a.txt'), 'old-a');
  await assert.rejects(
    transactionalWriteFiles(root, new Map([['a.txt', 'new-a']]), 'test-committed', {
      testOnlyControlDirectory: control,
      testOnlyCrashAfter: 'marker'
    }),
    /Simulated retained transaction crash/
  );

  const recovery = await recoverFileTransaction(root, 'test-committed', {
    expectedOperations: [{ operation: 'replace', path: 'a.txt' }],
    testOnlyControlDirectory: control
  });
  assert.equal(recovery.committed, true);
  assert.equal(await readFile(resolve(root, 'a.txt'), 'utf8'), 'new-a');
  assert.deepEqual(await readdir(control), []);
});

for (const crashPhase of ['journal-remove', 'marker-remove', 'lock-remove']) {
  test(`terminal-bound explicit recovery completes the exact ${crashPhase} cleanup state`, async (t) => {
    const { control, root } = await transactionFixture(t, `sitewipe-transaction-${crashPhase}-`);
    await writeFile(resolve(root, 'a.txt'), 'old-a');
    const updates = new Map([['a.txt', 'new-a']]);
    await assert.rejects(
      transactionalWriteFiles(root, updates, `test-${crashPhase}`, {
        testOnlyControlDirectory: control,
        testOnlyCrashAfter: crashPhase
      }),
      /Simulated retained transaction crash/
    );
    assert.equal(await readFile(resolve(root, 'a.txt'), 'utf8'), 'new-a');
    await assert.rejects(
      transactionalWriteFiles(root, updates, `test-${crashPhase}`, { testOnlyControlDirectory: control }),
      /retained transaction|retained transaction control state/i
    );
    const recovery = await recoverFileTransaction(root, `test-${crashPhase}`, {
      expectedOperations: [{ operation: 'replace', path: 'a.txt' }],
      testOnlyControlDirectory: control
    });
    assert.equal(recovery.committed, true);
    assert.equal(await readFile(resolve(root, 'a.txt'), 'utf8'), 'new-a');
    assert.deepEqual(await readdir(control), []);
  });
}

test('explicit recovery removes an interrupted create and restores a partially promoted replacement', async (t) => {
  const { control, root } = await transactionFixture(t, 'sitewipe-transaction-create-recovery-');
  await writeFile(resolve(root, 'pointer.txt'), 'old-pointer');
  await assert.rejects(
    transactionalWriteFiles(
      root,
      new Map([
        ['history.txt', 'history'],
        ['pointer.txt', 'new-pointer']
      ]),
      'test-create-recovery',
      {
        createOnlyPaths: new Set(['history.txt']),
        testOnlyControlDirectory: control,
        testOnlyCrashAfter: 'first-promotion'
      }
    ),
    /Simulated retained transaction crash/
  );

  await recoverFileTransaction(root, 'test-create-recovery', {
    expectedOperations: [
      { operation: 'create', path: 'history.txt' },
      { operation: 'replace', path: 'pointer.txt' }
    ],
    testOnlyControlDirectory: control
  });
  await assert.rejects(readFile(resolve(root, 'history.txt')), { code: 'ENOENT' });
  assert.equal(await readFile(resolve(root, 'pointer.txt'), 'utf8'), 'old-pointer');
});

test('stale locks and foreign marker or journal bindings fail closed without mutation', async (t) => {
  await t.test('stale lock is retained and never broken automatically', async (t) => {
    const { control, root } = await transactionFixture(t, 'sitewipe-transaction-stale-');
    await writeFile(resolve(root, 'a.txt'), 'old-a');
    await assert.rejects(
      transactionalWriteFiles(root, new Map([['a.txt', 'new-a']]), 'test-stale', {
        testOnlyControlDirectory: control,
        testOnlyCrashAfter: 'staging'
      }),
      /Simulated/
    );
    const lock = await controlPath(control, '.lock.json');
    await utimes(lock, new Date('2000-01-01T00:00:00.000Z'), new Date('2000-01-01T00:00:00.000Z'));
    await assert.rejects(
      transactionalWriteFiles(root, new Map([['a.txt', 'other-a']]), 'test-stale', {
        testOnlyControlDirectory: control
      }),
      /concurrent or stale retained transaction lock/
    );
    assert.equal(await readFile(resolve(root, 'a.txt'), 'utf8'), 'old-a');
  });

  await t.test('foreign marker cannot convert an uncommitted journal into cleanup authority', async (t) => {
    const { control, root } = await transactionFixture(t, 'sitewipe-transaction-foreign-marker-');
    await writeFile(resolve(root, 'a.txt'), 'old-a');
    await assert.rejects(
      transactionalWriteFiles(root, new Map([['a.txt', 'new-a']]), 'test-foreign-marker', {
        testOnlyControlDirectory: control,
        testOnlyCrashAfter: 'journal'
      }),
      /Simulated/
    );
    const journalPath = await controlPath(control, '.journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    const markerPath = journalPath.replace(/\.journal\.json$/u, '.committed.json');
    await writeFile(
      markerPath,
      canonicalJson({
        repositoryId: journal.repositoryId,
        schema: 'sitewipe.file-transaction-commit.v4',
        transactionDigest: journal.transactionDigest,
        transactionId: '00000000-0000-4000-8000-000000000000'
      })
    );
    await assert.rejects(
      recoverFileTransaction(root, 'test-foreign-marker', {
        expectedOperations: [{ operation: 'replace', path: 'a.txt' }],
        testOnlyControlDirectory: control
      }),
      /commit marker is foreign/
    );
    assert.equal(await readFile(resolve(root, 'a.txt'), 'utf8'), 'old-a');
  });

  await t.test('foreign journal target is rejected against the independent allowlist', async (t) => {
    const { control, root } = await transactionFixture(t, 'sitewipe-transaction-foreign-journal-');
    await writeFile(resolve(root, 'a.txt'), 'old-a');
    await writeFile(resolve(root, 'victim.txt'), 'keep-victim');
    await assert.rejects(
      transactionalWriteFiles(root, new Map([['a.txt', 'new-a']]), 'test-foreign-journal', {
        testOnlyControlDirectory: control,
        testOnlyCrashAfter: 'journal'
      }),
      /Simulated/
    );
    const journalPath = await controlPath(control, '.journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8'));
    journal.entries[0].path = 'victim.txt';
    await writeFile(journalPath, canonicalJson(journal));
    await assert.rejects(
      recoverFileTransaction(root, 'test-foreign-journal', {
        expectedOperations: [{ operation: 'replace', path: 'a.txt' }],
        testOnlyControlDirectory: control
      }),
      /differs from the exact expected target\/operation allowlist/
    );
    assert.equal(await readFile(resolve(root, 'a.txt'), 'utf8'), 'old-a');
    assert.equal(await readFile(resolve(root, 'victim.txt'), 'utf8'), 'keep-victim');
  });
});

test('a malicious tracked in-root journal is never consulted and its victim is unchanged', async (t) => {
  const { control, root } = await transactionFixture(t, 'sitewipe-transaction-in-root-journal-');
  await writeFile(resolve(root, 'safe.txt'), 'safe');
  await writeFile(resolve(root, 'victim.txt'), 'keep-victim');
  const maliciousPath = resolve(root, '.test-malicious.transaction.json');
  await writeFile(
    maliciousPath,
    `${JSON.stringify({
      entries: [
        {
          backup: 'victim.txt',
          operation: 'create',
          target: 'victim.txt',
          temp: 'victim.txt'
        }
      ],
      schemaVersion: 1
    })}\n`
  );

  const result = await recoverFileTransaction(root, 'test-malicious', {
    expectedOperations: [{ operation: 'replace', path: 'safe.txt' }],
    testOnlyControlDirectory: control
  });
  assert.equal(result.recovered, false);
  assert.equal(await readFile(resolve(root, 'victim.txt'), 'utf8'), 'keep-victim');
  assert.match(await readFile(maliciousPath, 'utf8'), /"target":"victim\.txt"/u);
});

test('transaction targets reject reparse-backed ancestors before any mutation', async (t) => {
  const { control, root } = await transactionFixture(t, 'sitewipe-transaction-reparse-');
  const outside = await mkdtemp(resolve(tmpdir(), 'sitewipe-transaction-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(resolve(outside, 'victim.txt'), 'outside');
  await symlink(outside, resolve(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');

  await assert.rejects(
    transactionalWriteFiles(root, new Map([['linked/victim.txt', 'changed']]), 'test-reparse', {
      testOnlyControlDirectory: control
    }),
    /physical non-reparse directory/
  );
  assert.equal(await readFile(resolve(outside, 'victim.txt'), 'utf8'), 'outside');
  assert.deepEqual(await readdir(control), []);
});

test('transaction targets reject alternate streams and Windows-reserved path aliases before control or data writes', async (t) => {
  for (const repositoryPath of ['carrier.txt:secret', 'NUL.txt', 'trailing-dot.']) {
    await t.test(repositoryPath, async (t) => {
      const { control, root } = await transactionFixture(t, 'sitewipe-transaction-portable-path-');
      await assert.rejects(
        transactionalWriteFiles(root, new Map([[repositoryPath, 'payload']]), 'test-portable-path', {
          createOnlyPaths: new Set([repositoryPath]),
          testOnlyControlDirectory: control
        }),
        /not one normalized repository path/
      );
      assert.deepEqual(await readdir(root), []);
      assert.deepEqual(await readdir(control), []);
    });
  }
});

test('recovery replays control and data-node identities after preflight before any affected action', async (t) => {
  await t.test('same-byte journal replacement is foreign', async (t) => {
    const { control, root } = await transactionFixture(t, 'sitewipe-transaction-control-identity-');
    await writeFile(resolve(root, 'a.txt'), 'old-a');
    await assert.rejects(
      transactionalWriteFiles(root, new Map([['a.txt', 'new-a']]), 'test-control-identity', {
        testOnlyControlDirectory: control,
        testOnlyCrashAfter: 'journal'
      }),
      /Simulated/
    );
    await assert.rejects(
      recoverFileTransaction(root, 'test-control-identity', {
        expectedOperations: [{ operation: 'replace', path: 'a.txt' }],
        testOnlyAfterPreflight: async () => {
          const journalPath = await controlPath(control, '.journal.json');
          const bytes = await readFile(journalPath);
          await rm(journalPath);
          await writeFile(journalPath, bytes);
        },
        testOnlyControlDirectory: control
      }),
      /journal changed before recovery mutation/
    );
    assert.equal(await readFile(resolve(root, 'a.txt'), 'utf8'), 'old-a');
  });

  await t.test('same-byte staging replacement is rejected at its bounded action', async (t) => {
    const { control, root } = await transactionFixture(t, 'sitewipe-transaction-data-identity-');
    await writeFile(resolve(root, 'a.txt'), 'old-a');
    await assert.rejects(
      transactionalWriteFiles(root, new Map([['a.txt', 'new-a']]), 'test-data-identity', {
        testOnlyControlDirectory: control,
        testOnlyCrashAfter: 'staging'
      }),
      /Simulated/
    );
    await assert.rejects(
      recoverFileTransaction(root, 'test-data-identity', {
        expectedOperations: [{ operation: 'replace', path: 'a.txt' }],
        testOnlyAfterPreflight: async () => {
          const [stageName] = (await readdir(root)).filter((name) => name.endsWith('.tmp'));
          const stagePath = resolve(root, stageName);
          const bytes = await readFile(stagePath);
          await rm(stagePath);
          await writeFile(stagePath, bytes);
        },
        testOnlyControlDirectory: control
      }),
      /physical identity changed before bounded removal/
    );
    assert.equal(await readFile(resolve(root, 'a.txt'), 'utf8'), 'old-a');
  });
});

async function transactionFixture(t, prefix) {
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  const control = await mkdtemp(resolve(tmpdir(), `${prefix}control-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(control, { recursive: true, force: true }));
  return { control, root };
}

async function controlPath(control, suffix) {
  const matches = (await readdir(control)).filter((name) => name.endsWith(suffix));
  assert.equal(matches.length, 1);
  return resolve(control, matches[0]);
}

function canonicalJson(value) {
  return `${stableJson(value)}\n`;
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

function collidingExactStats() {
  const first = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
  const second = first + 1n;
  const base = {
    birthtimeNs: 1_769_356_800_000_000_000n,
    ctimeNs: 1_769_356_801_000_000_000n,
    dev: first,
    ino: first,
    mode: 33_188n,
    mtimeNs: 1_769_356_802_000_000_000n,
    nlink: 1n,
    size: 32n
  };
  return [base, { ...base, ino: second }, { ...base, dev: second }];
}

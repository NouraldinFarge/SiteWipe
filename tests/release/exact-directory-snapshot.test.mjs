import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  captureExactDirectorySnapshot,
  exactDirectoryHandleStat,
  exactDirectoryPathStat,
  readExactDirectorySnapshotFiles,
  replayExactDirectorySnapshot
} from '../../scripts/exact-directory-snapshot.mjs';

test('exact directory snapshots retain private owned bytes and replay a stable complete directory', async (t) => {
  const root = await fixture(t, 'sitewipe-exact-directory-stable-');
  await writeFile(resolve(root, 'metadata.json'), '{"status":"A"}\n');
  await writeFile(resolve(root, 'runtime.zip'), Buffer.from('ZIP-A'));

  const snapshot = await captureExactDirectorySnapshot(root);
  assert.deepEqual(
    snapshot.files.map(({ name }) => name),
    ['metadata.json', 'runtime.zip']
  );
  const first = readExactDirectorySnapshotFiles(snapshot);
  first.get('runtime.zip')[0] = 0;
  const second = readExactDirectorySnapshotFiles(snapshot);
  assert.deepEqual(second.get('runtime.zip'), Buffer.from('ZIP-A'));
  await assert.doesNotReject(replayExactDirectorySnapshot(snapshot));
});

test('exact directory replay rejects entry additions, removals, and non-file replacements', async (t) => {
  for (const mutation of ['add', 'remove', 'replace-with-directory']) {
    await t.test(mutation, async (t) => {
      const root = await fixture(t, `sitewipe-exact-directory-${mutation}-`);
      const target = resolve(root, 'runtime.zip');
      await writeFile(target, Buffer.from('ZIP-A'));
      const snapshot = await captureExactDirectorySnapshot(root);
      if (mutation === 'add') await writeFile(resolve(root, 'unexpected.txt'), 'unexpected');
      if (mutation === 'remove') await rm(target);
      if (mutation === 'replace-with-directory') {
        await rename(target, `${target}.old`);
        await mkdir(target);
      }
      await assert.rejects(replayExactDirectorySnapshot(snapshot), /snapshot|regular non-reparse file/i);
    });
  }
});

test('exact directory replay rejects physical replacement even when bytes and size are unchanged', async (t) => {
  const root = await fixture(t, 'sitewipe-exact-directory-physical-replacement-');
  const target = resolve(root, 'runtime.zip');
  await writeFile(target, Buffer.from('ZIP-A'));
  const snapshot = await captureExactDirectorySnapshot(root);
  await rename(target, `${target}.old`);
  await writeFile(target, Buffer.from('ZIP-A'));
  await assert.rejects(replayExactDirectorySnapshot(snapshot), /identity changed|entry changed/i);
});

test('captured ZIP A cannot be mixed with substituted ZIP B', async (t) => {
  const root = await fixture(t, 'sitewipe-exact-directory-zip-substitution-');
  const target = resolve(root, 'runtime.zip');
  await writeFile(target, Buffer.from('ZIP-A'));
  const snapshot = await captureExactDirectorySnapshot(root);
  await writeFile(target, Buffer.from('ZIP-B'));
  assert.deepEqual(readExactDirectorySnapshotFiles(snapshot).get('runtime.zip'), Buffer.from('ZIP-A'));
  await assert.rejects(replayExactDirectorySnapshot(snapshot), /entry changed/i);
});

test('same-size metadata substitution and between-pass final replay drift are refused', async (t) => {
  await t.test('same-size metadata substitution', async (t) => {
    const root = await fixture(t, 'sitewipe-exact-directory-metadata-substitution-');
    const target = resolve(root, 'metadata.json');
    await writeFile(target, '{"status":"A"}\n');
    const snapshot = await captureExactDirectorySnapshot(root);
    await writeFile(target, '{"status":"B"}\n');
    await assert.rejects(replayExactDirectorySnapshot(snapshot), /entry changed/i);
  });

  await t.test('between-pass final replay drift', async (t) => {
    const root = await fixture(t, 'sitewipe-exact-directory-final-drift-');
    const target = resolve(root, 'metadata.json');
    await writeFile(target, '{"status":"A"}\n');
    const snapshot = await captureExactDirectorySnapshot(root);
    await assert.rejects(
      replayExactDirectorySnapshot(snapshot, {
        testOnlyAfterFirstPass: async () => writeFile(target, '{"status":"B"}\n')
      }),
      /entry changed/i
    );
  });
});

test('exact directory files reject hard links', async (t) => {
  const root = await fixture(t, 'sitewipe-exact-directory-hardlink-');
  const target = resolve(root, 'runtime.zip');
  await writeFile(target, Buffer.from('ZIP-A'));
  try {
    await link(target, resolve(root, 'runtime-copy.zip'));
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
      t.skip(`Hard links unavailable on this host: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(captureExactDirectorySnapshot(root), /singly linked regular non-reparse file/i);
});

test('every exact directory stat route requests bigint identity', async () => {
  const pathCalls = [];
  const fakeStat = exactStatFixture();
  assert.equal(
    await exactDirectoryPathStat('fixture', async (...args) => {
      pathCalls.push(args);
      return fakeStat;
    }),
    fakeStat
  );
  assert.deepEqual(pathCalls, [['fixture', { bigint: true }]]);
  const handleCalls = [];
  assert.equal(
    await exactDirectoryHandleStat({
      stat: async (options) => {
        handleCalls.push(options);
        return fakeStat;
      }
    }),
    fakeStat
  );
  assert.deepEqual(handleCalls, [{ bigint: true }]);

  const source = await readFile(new URL('../../scripts/exact-directory-snapshot.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bhandle\.stat\(\s*\)/u);
  assert.doesNotMatch(source, /\bnativeLstat\(/u);
});

async function fixture(t, prefix) {
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function exactStatFixture() {
  return {
    birthtimeNs: 1n,
    ctimeNs: 2n,
    dev: 3n,
    ino: 4n,
    mode: 5n,
    mtimeNs: 6n,
    nlink: 1n,
    size: 7n,
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false
  };
}

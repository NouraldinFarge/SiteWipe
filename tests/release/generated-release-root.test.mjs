import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  createGeneratedReleaseChild,
  ensureGeneratedReleaseRoot,
  GENERATED_RELEASE_ROOT_MARKER,
  removeGeneratedReleaseChild
} from '../../scripts/generated-release-root.mjs';

test('generated release root claims only an empty physical directory', async (context) => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'sitewipe-generated-root-'));
  const root = resolve(temporary, 'dist');
  context.after(() => rm(temporary, { recursive: true, force: true }));

  await ensureGeneratedReleaseRoot(root);
  assert.match(
    await readFile(resolve(root, GENERATED_RELEASE_ROOT_MARKER), 'utf8'),
    /sitewipe\.generated-release-root/
  );
  const staging = await createGeneratedReleaseChild(root, '.current-staging');
  await writeFile(resolve(staging, 'artifact.zip'), 'synthetic artifact\n');
  await removeGeneratedReleaseChild(root, '.current-staging');
  await assert.rejects(readFile(resolve(staging, 'artifact.zip')), /ENOENT/);
});

test('generated release root refuses to adopt unmarked existing content', async (context) => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'sitewipe-unmarked-root-'));
  const root = resolve(temporary, 'dist');
  context.after(() => rm(temporary, { recursive: true, force: true }));
  await mkdir(root);
  await writeFile(resolve(root, 'keep.txt'), 'not owned by the release builder\n');

  await assert.rejects(ensureGeneratedReleaseRoot(root), /non-empty unmarked generated release root/i);
  assert.equal(await readFile(resolve(root, 'keep.txt'), 'utf8'), 'not owned by the release builder\n');
});

test('recursive release cleanup refuses a junction or symbolic-link child', async (context) => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'sitewipe-linked-release-'));
  const root = resolve(temporary, 'dist');
  const external = resolve(temporary, 'external');
  context.after(() => rm(temporary, { recursive: true, force: true }));
  await ensureGeneratedReleaseRoot(root);
  await mkdir(external);
  await writeFile(resolve(external, 'sentinel.txt'), 'must survive\n');
  await symlink(external, resolve(root, '.current-staging'), process.platform === 'win32' ? 'junction' : 'dir');

  await assert.rejects(removeGeneratedReleaseChild(root, '.current-staging'), /physical directory/i);
  assert.equal(await readFile(resolve(external, 'sentinel.txt'), 'utf8'), 'must survive\n');
});

test('recursive release cleanup refuses multiply linked files', async (context) => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'sitewipe-hardlinked-release-'));
  const root = resolve(temporary, 'dist');
  const external = resolve(temporary, 'external.txt');
  context.after(() => rm(temporary, { recursive: true, force: true }));
  await ensureGeneratedReleaseRoot(root);
  const staging = await createGeneratedReleaseChild(root, '.current-staging');
  await writeFile(external, 'must survive\n');
  await link(external, resolve(staging, 'artifact.zip'));

  await assert.rejects(removeGeneratedReleaseChild(root, '.current-staging'), /multiply linked file/i);
  assert.equal(await readFile(external, 'utf8'), 'must survive\n');
});

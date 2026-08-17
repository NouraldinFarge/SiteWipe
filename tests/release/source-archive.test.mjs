import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { SOURCE_ARCHIVE_DIRECTORIES, SOURCE_ARCHIVE_ROOT_FILES } from '../../scripts/release-files.mjs';
import { collectSourceArchiveEntries } from '../../scripts/source-archive.mjs';

test('source archive closure rejects a linked root directory instead of following it', async (context) => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'sitewipe-source-archive-'));
  const root = resolve(temporary, 'project');
  context.after(() => rm(temporary, { recursive: true, force: true }));
  await mkdir(root);
  for (const directory of SOURCE_ARCHIVE_DIRECTORIES) await mkdir(resolve(root, directory), { recursive: true });
  for (const file of SOURCE_ARCHIVE_ROOT_FILES) await writeFile(resolve(root, file), 'fixture\n');
  const external = resolve(temporary, 'outside');
  const linkedRootDirectory = resolve(root, SOURCE_ARCHIVE_DIRECTORIES[0]);
  await mkdir(external);
  await writeFile(resolve(external, 'private.txt'), 'must not be archived\n');
  await rm(linkedRootDirectory, { recursive: true });
  await symlink(external, linkedRootDirectory, 'junction');

  await assert.rejects(collectSourceArchiveEntries(root), /symbolic links are prohibited/i);
});

import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { RUNTIME_FILES, SOURCE_ARCHIVE_DIRECTORIES, SOURCE_ARCHIVE_ROOT_FILES } from '../../scripts/release-files.mjs';
import { validateVersionContract, VersionContractError } from '../../scripts/version-contract-check.mjs';
import { computeReleaseInputFingerprint, computeRuntimeFingerprint } from '../../scripts/versioning.mjs';

const root = resolve(import.meta.dirname, '../..');

test('the reusable version contract rejects source changes after a recorded fingerprint', async (context) => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'sitewipe-version-contract-'));
  const fixtureRoot = resolve(temporary, 'project');
  context.after(() => rm(temporary, { recursive: true, force: true }));
  for (const directory of SOURCE_ARCHIVE_DIRECTORIES) {
    await cp(resolve(root, directory), resolve(fixtureRoot, directory), { recursive: true });
  }
  for (const file of SOURCE_ARCHIVE_ROOT_FILES) {
    await cp(resolve(root, file), resolve(fixtureRoot, file));
  }

  const statePath = resolve(fixtureRoot, 'docs/evidence/version-state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const releaseInput = await computeReleaseInputFingerprint(fixtureRoot);
  state.runtimeFileCount = RUNTIME_FILES.length;
  state.runtimeFingerprintSha256 = await computeRuntimeFingerprint(fixtureRoot);
  state.releaseInputFileCount = releaseInput.fileCount;
  state.releaseInputFingerprintSha256 = releaseInput.sha256;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);

  await assert.doesNotReject(validateVersionContract({ root: fixtureRoot }));
  const runtimePath = resolve(fixtureRoot, 'src/shared/settings-backup.js');
  await writeFile(runtimePath, `${await readFile(runtimePath, 'utf8')}\n// unversioned fixture change\n`);
  await assert.rejects(
    validateVersionContract({ root: fixtureRoot }),
    (error) =>
      error instanceof VersionContractError &&
      error.errors.some((message) => message.includes('allowlisted runtime files changed without a version bump'))
  );
});

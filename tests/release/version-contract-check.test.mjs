import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { RUNTIME_FILES, SOURCE_ARCHIVE_DIRECTORIES, SOURCE_ARCHIVE_ROOT_FILES } from '../../scripts/release-files.mjs';
import { collectSourceArchiveEntries } from '../../scripts/source-archive.mjs';
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

  const pkg = JSON.parse(await readFile(resolve(fixtureRoot, 'package.json'), 'utf8'));
  for (const [path, marker] of [
    ['docs/architecture.md', `forward ${pkg.version} transaction`],
    ['docs/threat-model.md', `the ${pkg.version} corrective working source`],
    ['docs/release-readiness.md', `SiteWipe ${pkg.version}`]
  ]) {
    const target = resolve(fixtureRoot, path);
    await writeFile(target, `${await readFile(target, 'utf8')}\n${marker}\n`);
  }
  const statePath = resolve(fixtureRoot, 'docs/evidence/version-state.json');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  const releaseInput = await computeReleaseInputFingerprint(fixtureRoot);
  state.runtimeFileCount = RUNTIME_FILES.length;
  state.runtimeFingerprintSha256 = await computeRuntimeFingerprint(fixtureRoot);
  state.releaseInputFileCount = releaseInput.fileCount;
  state.releaseInputFingerprintSha256 = releaseInput.sha256;
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const committedSourceEntries = await collectSourceArchiveEntries(fixtureRoot);

  await assert.doesNotReject(validateVersionContract({ root: fixtureRoot }));
  const pointerPath = resolve(fixtureRoot, 'docs/evidence/automated-validation-current.json');
  const pointerBytes = await readFile(pointerPath);
  const pointer = JSON.parse(pointerBytes.toString('utf8'));
  const currentRecordPath = resolve(fixtureRoot, 'docs', 'evidence', pointer.record);
  const currentRecordBytes = await readFile(currentRecordPath);
  const staleRecord = 'automated-validation-2026-08-25-v0.0.1.json';
  await writeFile(resolve(fixtureRoot, 'docs', 'evidence', staleRecord), currentRecordBytes);
  await writeFile(
    pointerPath,
    `${JSON.stringify({ ...pointer, record: staleRecord, version: pkg.version }, null, 2)}\n`
  );
  await assert.rejects(validateVersionContract({ root: fixtureRoot }), (error) =>
    String(error?.message || '').includes(`version ${pkg.version} does not match record ${staleRecord}`)
  );
  await writeFile(pointerPath, `${JSON.stringify({ ...pointer, record: staleRecord, version: '0.0.1' }, null, 2)}\n`);
  await assert.rejects(
    validateVersionContract({ root: fixtureRoot }),
    (error) =>
      error instanceof VersionContractError &&
      error.errors.some((message) => message.includes('automated validation pointer version'))
  );

  const legacyRecord = 'automated-validation-2026-08-25.json';
  await writeFile(resolve(fixtureRoot, 'docs', 'evidence', legacyRecord), currentRecordBytes);
  await writeFile(
    pointerPath,
    `${JSON.stringify({ ...pointer, record: legacyRecord, version: pkg.version }, null, 2)}\n`
  );
  await assert.doesNotReject(validateVersionContract({ root: fixtureRoot }));

  const mismatchedCandidate = { ...JSON.parse(currentRecordBytes.toString('utf8')), candidateVersion: '0.0.1' };
  await writeFile(currentRecordPath, `${JSON.stringify(mismatchedCandidate, null, 2)}\n`);
  await writeFile(pointerPath, pointerBytes);
  await assert.rejects(
    validateVersionContract({ root: fixtureRoot }),
    (error) =>
      error instanceof VersionContractError &&
      error.errors.some((message) => message.includes('automated evidence candidateVersion'))
  );
  await writeFile(currentRecordPath, currentRecordBytes);

  const mismatchedFullCheck = structuredClone(JSON.parse(currentRecordBytes.toString('utf8')));
  mismatchedFullCheck.fullCheck.versionContract.version = '0.0.1';
  await writeFile(currentRecordPath, `${JSON.stringify(mismatchedFullCheck, null, 2)}\n`);
  await assert.rejects(
    validateVersionContract({ root: fixtureRoot }),
    (error) =>
      error instanceof VersionContractError &&
      error.errors.some((message) => message.includes('automated evidence version-contract version'))
  );
  await writeFile(currentRecordPath, currentRecordBytes);

  const runtimePath = resolve(fixtureRoot, 'src/shared/settings-backup.js');
  await writeFile(runtimePath, `${await readFile(runtimePath, 'utf8')}\n// unversioned fixture change\n`);
  await assert.rejects(
    validateVersionContract({ root: fixtureRoot }),
    (error) =>
      error instanceof VersionContractError &&
      error.errors.some((message) => message.includes('allowlisted runtime files changed without a version bump'))
  );
  await writeFile(
    resolve(fixtureRoot, 'docs/evidence/automated-validation-current.json'),
    '{"record":"transient-untrusted-record.json"}\n'
  );

  await assert.doesNotReject(
    validateVersionContract({
      root: fixtureRoot,
      committedSourceEntries,
      requireArtifact: true,
      runtimeArtifactBytes: Buffer.from('captured-runtime-artifact')
    })
  );
  const substitutedEntries = committedSourceEntries.map((entry) =>
    entry.path === 'src/shared/settings-backup.js'
      ? { ...entry, bytes: Buffer.concat([entry.bytes, Buffer.from('\n// substituted captured source\n')]) }
      : entry
  );
  await assert.rejects(
    validateVersionContract({ root: fixtureRoot, committedSourceEntries: substitutedEntries }),
    (error) =>
      error instanceof VersionContractError &&
      error.errors.some((message) => message.includes('allowlisted runtime files changed without a version bump'))
  );
});

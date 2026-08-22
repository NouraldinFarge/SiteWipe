import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { transactionalWriteFiles } from '../../scripts/transactional-files.mjs';
import {
  planValidationEvidenceVersionTransition,
  resolveCurrentValidationEvidence,
  stageValidationEvidenceVersionTransition
} from '../../scripts/validation-evidence.mjs';

test('same-day validation transitions preserve exact history and advance the pointer append-only', async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), 'sitewipe-validation-history-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'docs', 'evidence'), { recursive: true });
  await writeFile(resolve(root, 'version.txt'), '1.2.3\n');

  const originalBytes =
    '{\n  "schemaVersion": 1,\n  "note": "retain these exact bytes",\n  "fullCheck": { "versionContract": { "version": "1.2.3" } }\n}\n';
  await writeFile(resolve(root, 'docs', 'evidence', 'automated-validation-2026-08-21.json'), originalBytes);
  await writeJson(resolve(root, 'docs', 'evidence', 'automated-validation-current.json'), {
    schemaVersion: 1,
    record: 'automated-validation-2026-08-21.json',
    purpose: 'test pointer'
  });

  const first = await planValidationEvidenceVersionTransition(root, {
    previousVersion: '1.2.3',
    nextVersion: '1.2.4',
    date: '2026-08-21'
  });
  const firstUpdates = new Map([['version.txt', '1.2.4\n']]);
  const firstCreates = stageValidationEvidenceVersionTransition(firstUpdates, first, pendingEvidence('1.2.4'));
  await transactionalWriteFiles(root, firstUpdates, 'validation-first', {
    createOnlyPaths: firstCreates
  });

  const firstHistoricalPath = resolve(root, 'docs', 'evidence', 'automated-validation-2026-08-21-v1.2.3.json');
  assert.equal(await readFile(firstHistoricalPath, 'utf8'), originalBytes);
  assert.deepEqual(await currentPointer(root), {
    schemaVersion: 1,
    record: 'automated-validation-2026-08-21-v1.2.4.json',
    purpose: 'test pointer',
    version: '1.2.4'
  });
  const firstCurrent = await currentEvidence(root);
  assert.equal(firstCurrent.baseline.baselineVersion, '1.2.3');
  assert.equal(firstCurrent.baseline.baselineRecord, 'docs/evidence/automated-validation-2026-08-21-v1.2.3.json');

  const firstCurrentBytes = await readFile(
    resolve(root, 'docs', 'evidence', 'automated-validation-2026-08-21-v1.2.4.json'),
    'utf8'
  );
  const second = await planValidationEvidenceVersionTransition(root, {
    previousVersion: '1.2.4',
    nextVersion: '1.2.5',
    date: '2026-08-21'
  });
  assert.equal(second.historicalCreations.size, 0);
  const secondUpdates = new Map([['version.txt', '1.2.5\n']]);
  const secondCreates = stageValidationEvidenceVersionTransition(secondUpdates, second, pendingEvidence('1.2.5'));
  await transactionalWriteFiles(root, secondUpdates, 'validation-second', {
    createOnlyPaths: secondCreates
  });

  assert.equal(await readFile(firstHistoricalPath, 'utf8'), originalBytes);
  assert.equal(
    await readFile(resolve(root, 'docs', 'evidence', 'automated-validation-2026-08-21-v1.2.4.json'), 'utf8'),
    firstCurrentBytes
  );
  assert.equal((await currentPointer(root)).record, 'automated-validation-2026-08-21-v1.2.5.json');
  const secondCurrent = await currentEvidence(root);
  assert.equal(secondCurrent.baseline.baselineVersion, '1.2.4');
  assert.equal(secondCurrent.baseline.baselineRecord, 'docs/evidence/automated-validation-2026-08-21-v1.2.4.json');

  await writeFile(
    resolve(root, 'docs', 'evidence', 'automated-validation-2026-08-21-v1.2.6.json'),
    'immutable-existing-history\n'
  );
  const blocked = await planValidationEvidenceVersionTransition(root, {
    previousVersion: '1.2.5',
    nextVersion: '1.2.6',
    date: '2026-08-21'
  });
  const blockedUpdates = new Map([['version.txt', '1.2.6\n']]);
  const blockedCreates = stageValidationEvidenceVersionTransition(blockedUpdates, blocked, pendingEvidence('1.2.6'));
  await assert.rejects(
    transactionalWriteFiles(root, blockedUpdates, 'validation-blocked', {
      createOnlyPaths: blockedCreates
    }),
    /already exists and will not be overwritten/
  );
  assert.equal(await readFile(resolve(root, 'version.txt'), 'utf8'), '1.2.5\n');
  assert.equal((await currentPointer(root)).version, '1.2.5');
  assert.equal(
    await readFile(resolve(root, 'docs', 'evidence', 'automated-validation-2026-08-21-v1.2.6.json'), 'utf8'),
    'immutable-existing-history\n'
  );
});

function pendingEvidence(version) {
  return {
    schemaVersion: 1,
    status: 'version_bumped_pending_validation',
    fullCheck: { versionContract: { version } }
  };
}

async function currentPointer(root) {
  return readJson(resolve(root, 'docs', 'evidence', 'automated-validation-current.json'));
}

async function currentEvidence(root) {
  const current = await resolveCurrentValidationEvidence(root);
  return readJson(current.absolutePath);
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

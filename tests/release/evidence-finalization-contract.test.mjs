import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, link, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

import {
  canonicalEvidenceFinalizationJsonBytes,
  EVIDENCE_FINALIZATION_MANIFEST_PATH,
  EVIDENCE_FINALIZATION_MANIFEST_SCHEMA,
  expectedFinalizationKind,
  exactEvidenceHandleStat,
  exactEvidencePathStat,
  isApprovedFinalizationPath,
  sameEvidenceFileIdentity,
  validateEvidenceFinalizationManifest,
  validateManifestShape
} from '../../scripts/evidence-finalization-contract.mjs';

const version = '1.11.90';
const required = [
  ['docs/evidence/accessibility-results.json', 'accessibility'],
  ['docs/evidence/browser-semantic-receipts.json', 'browser'],
  ['docs/evidence/browser-validation.json', 'browser'],
  ['docs/evidence/media-inventory.json', 'media'],
  ['docs/evidence/performance-results.json', 'performance']
];

test('finalization evidence file identity is BigInt-exact and every stat route requests bigint', async () => {
  const [original, differentInode, differentDevice] = collidingExactStats();
  assert.equal(Number(original.ino), Number(differentInode.ino));
  assert.equal(sameEvidenceFileIdentity(original, differentInode), false);
  assert.equal(sameEvidenceFileIdentity(original, differentDevice), false);
  assert.equal(sameEvidenceFileIdentity({ ...original, ino: Number(original.ino) }, original), false);

  const pathCalls = [];
  assert.equal(
    await exactEvidencePathStat('evidence-path', async (...args) => {
      pathCalls.push(args);
      return original;
    }),
    original
  );
  assert.deepEqual(pathCalls, [['evidence-path', { bigint: true }]]);
  const handleCalls = [];
  await exactEvidenceHandleStat({ stat: async (options) => (handleCalls.push(options), original) });
  assert.deepEqual(handleCalls, [{ bigint: true }]);

  const source = await readFile(new URL('../../scripts/evidence-finalization-contract.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bhandle\.stat\(\s*\)/u);
  assert.doesNotMatch(source, /\bnativeLstat\(/u);
  assert.doesNotMatch(source, /import\s*\{[^}]*\breadFile\b[^}]*\}\s*from\s*'node:fs\/promises'/su);
});

test('finalization manifest permits only exact hash-listed evidence and media changes', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'sitewipe-finalization-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = [];
  for (const [path, kind] of required) {
    const bytes = evidenceRecordBytes(path);
    await write(root, path, bytes);
    entries.push({ path, kind, bytes: bytes.length, sha256: sha256(bytes) });
  }
  const mediaPath = `docs/evidence/media/sitewipe-${version}-chrome-popup.png`;
  const mediaBytes = Buffer.from('synthetic png fixture');
  await write(root, mediaPath, mediaBytes);
  entries.push({ path: mediaPath, kind: 'media', bytes: mediaBytes.length, sha256: sha256(mediaBytes) });
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = validManifest(entries);
  await write(root, EVIDENCE_FINALIZATION_MANIFEST_PATH, canonicalEvidenceFinalizationJsonBytes(manifest));
  const changedPaths = [EVIDENCE_FINALIZATION_MANIFEST_PATH, ...entries.map(({ path }) => path)].sort();
  const result = await validateEvidenceFinalizationManifest({
    repositoryRoot: root,
    manifest,
    changedPaths,
    snapshotRecordPaths: [
      'docs/evidence/accessibility-results.json',
      'docs/evidence/browser-semantic-receipts.json',
      'docs/evidence/browser-validation.json',
      'docs/evidence/media-inventory.json',
      'docs/evidence/performance-results.json'
    ],
    deriveExpectedIdentityFromSnapshot: () => manifest.identity
  });
  assert.match(result.manifestSha256, /^[A-F0-9]{64}$/);
  assert.deepEqual(result.changedPaths, changedPaths);
  assert.equal(Object.isFrozen(result.manifest), true);
  assert.equal(Object.isFrozen(result.records), true);
  assert.deepEqual(Object.keys(result.records), [
    'docs/evidence/accessibility-results.json',
    'docs/evidence/browser-semantic-receipts.json',
    'docs/evidence/browser-validation.json',
    'docs/evidence/media-inventory.json',
    'docs/evidence/performance-results.json'
  ]);
  assert.deepEqual(result.records['docs/evidence/browser-validation.json'].value, {
    marker: 'docs/evidence/browser-validation.json',
    schema: 'sitewipe.synthetic-finalized-evidence.v1'
  });
  assert.equal(
    result.records['docs/evidence/browser-validation.json'].canonicalJson,
    canonicalEvidenceFinalizationJsonBytes(result.records['docs/evidence/browser-validation.json'].value).toString(
      'utf8'
    )
  );
  assert.equal(result.records[mediaPath], undefined);
});

test('final replay rejects hash-listed JSON that cannot produce one exact parsed record', async (t) => {
  const fixture = await createValidRepository(t, 'sitewipe-finalization-invalid-record-', {
    writeManifest: false
  });
  const path = 'docs/evidence/browser-validation.json';
  const bytes = Buffer.from('{"incomplete":', 'utf8');
  await write(fixture.root, path, bytes);
  const entries = fixture.manifest.entries.map((entry) =>
    entry.path === path ? { ...entry, bytes: bytes.length, sha256: sha256(bytes) } : entry
  );
  const manifest = validManifest(entries);
  await write(fixture.root, EVIDENCE_FINALIZATION_MANIFEST_PATH, canonicalEvidenceFinalizationJsonBytes(manifest));
  await assert.rejects(
    validateEvidenceFinalizationManifest({
      repositoryRoot: fixture.root,
      manifest,
      changedPaths: fixture.changedPaths,
      snapshotRecordPaths: [path],
      deriveExpectedIdentityFromSnapshot: () => manifest.identity
    }),
    /not exact UTF-8 JSON/
  );
});

test('finalization manifest fails closed on byte drift, extra delta paths, private strings, and loose globs', async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), 'sitewipe-finalization-tamper-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = [];
  for (const [path, kind] of required) {
    const bytes = evidenceRecordBytes(path);
    await write(root, path, bytes);
    entries.push({ path, kind, bytes: bytes.length, sha256: sha256(bytes) });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = validManifest(entries);
  const changedPaths = [EVIDENCE_FINALIZATION_MANIFEST_PATH, ...entries.map(({ path }) => path)].sort();
  await write(root, EVIDENCE_FINALIZATION_MANIFEST_PATH, canonicalEvidenceFinalizationJsonBytes(manifest));

  await write(root, entries[0].path, Buffer.from('changed'));
  await assert.rejects(
    validateEvidenceFinalizationManifest({
      repositoryRoot: root,
      manifest,
      changedPaths,
      expectedIdentity: manifest.identity
    }),
    /bytes changed/
  );
  await write(root, entries[0].path, evidenceRecordBytes(entries[0].path));
  await assert.rejects(
    validateEvidenceFinalizationManifest({
      repositoryRoot: root,
      manifest,
      changedPaths: [...changedPaths, 'README.md'],
      expectedIdentity: manifest.identity
    }),
    /changed paths differ/
  );
  assert.throws(
    () => validateManifestShape({ ...manifest, completedAt: 'C:\\Users\\Nah\\evidence.json' }),
    /invalid schema, version, time/
  );
  assert.equal(isApprovedFinalizationPath('docs/evidence/anything.json', version), false);
  assert.equal(isApprovedFinalizationPath('../docs/evidence/browser-validation.json', version), false);
  assert.equal(isApprovedFinalizationPath('docs\\evidence\\browser-validation.json', version), false);
  assert.equal(isApprovedFinalizationPath(`docs/evidence/media/sitewipe-${version}-chrome-popup.exe`, version), false);
  await assert.rejects(
    validateEvidenceFinalizationManifest({
      repositoryRoot: root,
      manifest,
      changedPaths,
      expectedIdentity: { ...manifest.identity, artifactSha256: '9'.repeat(64) }
    }),
    /differs from independently computed/
  );
});

test('validator requires the exact canonical on-disk manifest and rejects caller substitution', async (t) => {
  await t.test('missing on-disk manifest', async (t) => {
    const fixture = await createValidRepository(t, 'sitewipe-finalization-missing-manifest-');
    await assert.rejects(
      validateEvidenceFinalizationManifest({
        repositoryRoot: fixture.root,
        manifest: fixture.manifest,
        changedPaths: fixture.changedPaths,
        expectedIdentity: fixture.manifest.identity
      }),
      /on-disk evidence finalization manifest is missing or physically unsafe/
    );
  });

  await t.test('non-canonical on-disk manifest', async (t) => {
    const fixture = await createValidRepository(t, 'sitewipe-finalization-noncanonical-manifest-');
    await write(
      fixture.root,
      EVIDENCE_FINALIZATION_MANIFEST_PATH,
      Buffer.from(`${JSON.stringify(fixture.manifest, null, 2)}\n`)
    );
    await assert.rejects(
      validateEvidenceFinalizationManifest({
        repositoryRoot: fixture.root,
        manifest: fixture.manifest,
        changedPaths: fixture.changedPaths,
        expectedIdentity: fixture.manifest.identity
      }),
      /on-disk evidence finalization manifest is not canonical JSON/
    );
  });

  await t.test('valid but substituted on-disk manifest', async (t) => {
    const fixture = await createValidRepository(t, 'sitewipe-finalization-substituted-manifest-');
    const substituted = { ...fixture.manifest, completedAt: '2026-08-25T20:01:00.000Z' };
    await write(fixture.root, EVIDENCE_FINALIZATION_MANIFEST_PATH, canonicalEvidenceFinalizationJsonBytes(substituted));
    await assert.rejects(
      validateEvidenceFinalizationManifest({
        repositoryRoot: fixture.root,
        manifest: fixture.manifest,
        changedPaths: fixture.changedPaths,
        expectedIdentity: fixture.manifest.identity
      }),
      /Supplied evidence finalization manifest differs from the exact canonical on-disk manifest/
    );
  });
});

test('two complete replay passes reject earlier-entry additions, replacements, and same-size mutation', async (t) => {
  for (const mutation of ['add-link', 'replace', 'same-size']) {
    await t.test(mutation, async (t) => {
      const fixture = await createValidRepository(t, `sitewipe-finalization-replay-${mutation}-`, {
        writeManifest: true
      });
      const firstPath = resolve(fixture.root, ...fixture.manifest.entries[0].path.split('/'));
      await assert.rejects(
        validateEvidenceFinalizationManifest({
          repositoryRoot: fixture.root,
          manifest: fixture.manifest,
          changedPaths: fixture.changedPaths,
          expectedIdentity: fixture.manifest.identity,
          testOnlyAfterFirstPass: async () => {
            if (mutation === 'add-link') {
              await link(firstPath, `${firstPath}.second-link`);
            } else if (mutation === 'replace') {
              const replacement = `${firstPath}.replacement`;
              await writeFile(replacement, Buffer.alloc(fixture.manifest.entries[0].bytes, 0x52));
              await rename(replacement, firstPath);
            } else {
              await writeFile(firstPath, Buffer.alloc(fixture.manifest.entries[0].bytes, 0x53));
            }
          }
        }),
        /Finalized evidence|directory identity changed/
      );
    });
  }
});

test('manifest ancestors are identity-bound before the first on-disk manifest read', async (t) => {
  const fixture = await createValidRepository(t, 'sitewipe-finalization-manifest-ancestor-', {
    writeManifest: true
  });
  const evidenceRoot = resolve(fixture.root, 'docs', 'evidence');
  await assert.rejects(
    validateEvidenceFinalizationManifest({
      repositoryRoot: fixture.root,
      manifest: fixture.manifest,
      changedPaths: fixture.changedPaths,
      expectedIdentity: fixture.manifest.identity,
      testOnlyAfterManifestRead: async () => {
        const displaced = `${evidenceRoot}.displaced`;
        await rename(evidenceRoot, displaced);
        await cp(displaced, evidenceRoot, { recursive: true });
      }
    }),
    /directory identity changed during replay/
  );
});

test('manifest identity and required-record inventory cannot be omitted or self-authored as approved', () => {
  const entries = required.map(([path, kind]) => ({ path, kind, bytes: 1, sha256: 'A'.repeat(64) }));
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = validManifest(entries);
  assert.equal(validateManifestShape(manifest), manifest);
  assert.throws(() => validateManifestShape({ ...manifest, recordedByAutomation: false }), /invalid schema, version/);
  assert.throws(() => validateManifestShape({ ...manifest, entries: entries.slice(1) }), /missing required record/);
  assert.throws(
    () =>
      validateManifestShape({
        ...manifest,
        entries: manifest.entries.map((entry) =>
          entry.path === 'docs/evidence/accessibility-results.json' ? { ...entry, kind: 'browser' } : entry
        )
      }),
    /wrong evidence kind/
  );
  assert.throws(
    () => validateManifestShape({ ...manifest, identity: { ...manifest.identity, artifactVersion: '1.11.91' } }),
    /identity is incomplete/
  );
  assert.throws(
    () => validateManifestShape({ ...manifest, identity: { ...manifest.identity, nodeRuntimeVersion: '24.18.0' } }),
    /identity is incomplete/
  );
  assert.throws(
    () => validateManifestShape({ ...manifest, identity: { ...manifest.identity, toolchainFileCount: 0 } }),
    /identity is incomplete/
  );
  assert.throws(
    () =>
      validateManifestShape({
        ...manifest,
        identity: { ...manifest.identity, toolchainManifestSha256: '5'.repeat(64) }
      }),
    /keys differ from the exact schema/
  );
});

test('changed paths and manifest arrays reject sparse, extended, and subclassed JavaScript values', async (t) => {
  const fixture = await createValidRepository(t, 'sitewipe-finalization-array-shape-', { writeManifest: true });
  const extended = [...fixture.changedPaths];
  extended.toJSON = () => [];
  const sparse = new Array(fixture.changedPaths.length);
  sparse[0] = fixture.changedPaths[0];
  class ChangedPathSubclass extends Array {}
  const subclassed = ChangedPathSubclass.from(fixture.changedPaths);
  for (const changedPaths of [extended, sparse, subclassed]) {
    await assert.rejects(
      validateEvidenceFinalizationManifest({
        repositoryRoot: fixture.root,
        manifest: fixture.manifest,
        changedPaths,
        expectedIdentity: fixture.manifest.identity
      }),
      /sparse, accessor-backed, subclassed, or extended array/
    );
  }

  const malformedManifest = validManifest([...fixture.manifest.entries]);
  malformedManifest.entries.toJSON = () => [];
  assert.throws(
    () => validateManifestShape(malformedManifest),
    /sparse, accessor-backed, subclassed, or extended array/
  );
});

test('final-snapshot identity derivation can read only explicit hash-listed JSON records', async (t) => {
  const fixture = await createValidRepository(t, 'sitewipe-finalization-identity-record-paths-', {
    writeManifest: true
  });
  await assert.rejects(
    validateEvidenceFinalizationManifest({
      repositoryRoot: fixture.root,
      manifest: fixture.manifest,
      changedPaths: fixture.changedPaths,
      expectedIdentity: fixture.manifest.identity,
      snapshotRecordPaths: ['docs/evidence/browser-validation.json']
    }),
    /require final-snapshot identity derivation/
  );
  await assert.rejects(
    validateEvidenceFinalizationManifest({
      repositoryRoot: fixture.root,
      manifest: fixture.manifest,
      changedPaths: fixture.changedPaths,
      snapshotRecordPaths: ['README.md'],
      deriveExpectedIdentityFromSnapshot: () => fixture.manifest.identity
    }),
    /not one exact hash-listed JSON entry/
  );
  await assert.rejects(
    validateEvidenceFinalizationManifest({
      repositoryRoot: fixture.root,
      manifest: fixture.manifest,
      changedPaths: fixture.changedPaths,
      snapshotRecordPaths: ['docs/evidence/browser-validation.json', 'docs/evidence/browser-semantic-receipts.json'],
      deriveExpectedIdentityFromSnapshot: () => fixture.manifest.identity
    }),
    /unique, and sorted exactly/
  );
});

test('every optional allowlisted path has one total exact evidence-kind mapping', () => {
  const automated = 'docs/evidence/automated-validation-current.json';
  const dated = `docs/evidence/automated-validation-2026-08-25-v${version}.json`;
  const media = `docs/evidence/media/sitewipe-${version}-chrome-popup.png`;
  assert.equal(expectedFinalizationKind(automated, version), 'automated');
  assert.equal(expectedFinalizationKind(dated, version), 'automated');
  assert.equal(expectedFinalizationKind(media, version), 'media');
  assert.equal(expectedFinalizationKind('README.md', version), null);

  const entries = required.map(([path, kind]) => ({ path, kind, bytes: 1, sha256: 'A'.repeat(64) }));
  entries.push({ path: automated, kind: 'browser', bytes: 1, sha256: 'B'.repeat(64) });
  entries.sort((left, right) => left.path.localeCompare(right.path));
  assert.throws(() => validateManifestShape(validManifest(entries)), /wrong evidence kind/);
});

async function createValidRepository(t, prefix, { writeManifest = false } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entries = [];
  for (const [path, kind] of required) {
    const bytes = evidenceRecordBytes(path);
    await write(root, path, bytes);
    entries.push({ path, kind, bytes: bytes.length, sha256: sha256(bytes) });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = validManifest(entries);
  if (writeManifest) {
    await write(root, EVIDENCE_FINALIZATION_MANIFEST_PATH, canonicalEvidenceFinalizationJsonBytes(manifest));
  }
  return {
    changedPaths: [EVIDENCE_FINALIZATION_MANIFEST_PATH, ...entries.map(({ path }) => path)].sort(),
    manifest,
    root
  };
}

function validManifest(entries) {
  return {
    schema: EVIDENCE_FINALIZATION_MANIFEST_SCHEMA,
    version,
    completedAt: '2026-08-25T20:00:00.000Z',
    recordedByAutomation: true,
    identity: {
      artifactVersion: version,
      artifactSha256: 'A'.repeat(64),
      browserAggregateSha256: 'B'.repeat(64),
      browserResultSetSha256: 'C'.repeat(64),
      browserRuntimeSetSha256: '5'.repeat(64),
      gitExecutableSha256: 'A'.repeat(64),
      harnessManifestSha256: 'D'.repeat(64),
      launchPolicySha256: '6'.repeat(64),
      nativeHelperSha256: 'B'.repeat(64),
      nodeExecutableSha256: 'C'.repeat(64),
      nodeRuntimeVersion: 'v24.18.0',
      packageLockSha256: 'E'.repeat(64),
      powerShellExecutableSha256: '7'.repeat(64),
      processObserverHelperSha256: '8'.repeat(64),
      publicReceiptSetSha256: 'F'.repeat(64),
      releaseInputFingerprintSha256: '1'.repeat(64),
      runtimeFingerprintSha256: '2'.repeat(64),
      semanticValidatorManifestSha256: '9'.repeat(64),
      testedCommitSha: '3'.repeat(40),
      testedTreeSha: '4'.repeat(40),
      toolchainBytes: 123456,
      toolchainFileCount: 321,
      toolchainPackageCount: 23,
      toolchainPuppeteerVersion: '25.8.0',
      toolchainSetSha256: '0'.repeat(64)
    },
    entries
  };
}

async function write(root, path, bytes) {
  const absolute = resolve(root, ...path.split('/'));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

function evidenceRecordBytes(path) {
  return canonicalEvidenceFinalizationJsonBytes({
    marker: path,
    schema: 'sitewipe.synthetic-finalized-evidence.v1'
  });
}

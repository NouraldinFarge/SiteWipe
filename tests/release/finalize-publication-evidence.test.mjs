import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, sep } from 'node:path';
import test from 'node:test';

import {
  canonicalEvidenceFinalizationJsonBytes,
  exactFinalizationHandleStat,
  exactFinalizationPathStat,
  finalizePublicationEvidence,
  sameExactFileIdentity
} from '../../scripts/finalize-publication-evidence.mjs';
import {
  EVIDENCE_FINALIZATION_MANIFEST_PATH,
  EVIDENCE_FINALIZATION_MANIFEST_SCHEMA,
  validateEvidenceFinalizationManifest
} from '../../scripts/evidence-finalization-contract.mjs';

const version = '1.11.90';
const completedAt = '2026-08-25T23:15:00.000Z';
const requiredInventory = Object.freeze([
  { kind: 'accessibility', path: 'docs/evidence/accessibility-results.json' },
  { kind: 'browser', path: 'docs/evidence/browser-semantic-receipts.json' },
  { kind: 'browser', path: 'docs/evidence/browser-validation.json' },
  { kind: 'media', path: 'docs/evidence/media-inventory.json' },
  { kind: 'performance', path: 'docs/evidence/performance-results.json' }
]);

test('finalizer physical identities are BigInt-exact and every path/handle stat requests bigint', async () => {
  const [original, differentInode, differentDevice] = collidingExactStats();
  assert.equal(Number(original.dev), Number(differentDevice.dev));
  assert.equal(sameExactFileIdentity(original, differentInode), false);
  assert.equal(sameExactFileIdentity(original, differentDevice), false);
  assert.equal(sameExactFileIdentity({ ...original, dev: Number(original.dev) }, original), false);

  const pathCalls = [];
  await exactFinalizationPathStat('manifest-path', async (...args) => {
    pathCalls.push(args);
    return original;
  });
  assert.deepEqual(pathCalls, [['manifest-path', { bigint: true }]]);
  const handleCalls = [];
  await exactFinalizationHandleStat({ stat: async (options) => (handleCalls.push(options), original) });
  assert.deepEqual(handleCalls, [{ bigint: true }]);

  const source = await readFile(new URL('../../scripts/finalize-publication-evidence.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bhandle\.stat\(\s*\)/u);
  assert.doesNotMatch(source, /\bnativeLstat\(/u);
  assert.doesNotMatch(source, /open\(path, ['"]r\+['"]\)/u);
  assert.doesNotMatch(source, /\.truncate\(/u);
});

test('mechanically creates one canonical v2 manifest from external identity and sorted inventory', async (t) => {
  const root = await createRepository(t);
  const before = await repositoryFiles(root);
  const expectedIdentity = validIdentity();
  const result = await finalizePublicationEvidence({
    repositoryRoot: root,
    completedAt,
    expectedIdentity,
    inventory: requiredInventory
  });

  assert.equal(result.writeMode, 'created');
  assert.equal(result.manifest.schema, EVIDENCE_FINALIZATION_MANIFEST_SCHEMA);
  assert.equal(result.manifest.version, version);
  assert.equal(result.manifest.recordedByAutomation, true);
  assert.deepEqual(result.manifest.identity, expectedIdentity);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.manifest.identity), true);
  const target = resolve(root, ...EVIDENCE_FINALIZATION_MANIFEST_PATH.split('/'));
  const stored = await readFile(target);
  assert.equal(stored.equals(canonicalEvidenceFinalizationJsonBytes(result.manifest)), true);
  assert.equal(result.manifestSha256, sha256(stored));
  if (process.platform !== 'win32') {
    assert.equal(Number((await lstat(target, { bigint: true })).mode & 0o777n), 0o666 & (~process.umask() & 0o777));
  }

  for (const entry of result.manifest.entries) {
    const source = await readFile(resolve(root, ...entry.path.split('/')));
    assert.equal(entry.bytes, source.length);
    assert.equal(entry.sha256, sha256(source));
  }
  const changedPaths = [EVIDENCE_FINALIZATION_MANIFEST_PATH, ...result.manifest.entries.map(({ path }) => path)].sort();
  const replay = await validateEvidenceFinalizationManifest({
    repositoryRoot: root,
    manifest: result.manifest,
    changedPaths,
    expectedIdentity
  });
  assert.equal(replay.manifestSha256, result.manifestSha256);
  assert.deepEqual(await repositoryFiles(root), [...before, EVIDENCE_FINALIZATION_MANIFEST_PATH].sort());
});

test('requires the current package version, five mandatory records, exact kinds, and sorted allowlisted paths', async (t) => {
  const root = await createRepository(t);
  const target = resolve(root, ...EVIDENCE_FINALIZATION_MANIFEST_PATH.split('/'));
  const invoke = (overrides = {}) =>
    finalizePublicationEvidence({
      repositoryRoot: root,
      completedAt,
      expectedIdentity: validIdentity(),
      inventory: requiredInventory,
      ...overrides
    });

  await assert.rejects(
    invoke({ expectedIdentity: { ...validIdentity(), artifactVersion: '1.11.91' } }),
    /current package version/
  );
  await assert.rejects(invoke({ inventory: requiredInventory.slice(1) }), /missing required record/);
  await assert.rejects(
    invoke({
      inventory: requiredInventory.map((item) =>
        item.path === 'docs/evidence/accessibility-results.json' ? { ...item, kind: 'browser' } : item
      )
    }),
    /wrong evidence kind/
  );
  await assert.rejects(invoke({ inventory: [...requiredInventory].reverse() }), /unique and sorted exactly/);
  await assert.rejects(
    invoke({ inventory: [...requiredInventory, { kind: 'automated', path: 'README.md' }] }),
    /outside the exact allowlist/
  );
  await assert.rejects(
    invoke({ inventory: requiredInventory.map((item) => ({ ...item, approved: true })) }),
    /keys differ from the exact schema/
  );
  await assert.rejects(invoke({ completedAt: '2026-08-25T23:15:00Z' }), /canonical UTC timestamp/);
  await assert.rejects(
    invoke({ expectedIdentity: { ...validIdentity(), reviewerApproval: true } }),
    /keys differ from the exact schema/
  );
  await assert.rejects(
    invoke({
      inventory: [...requiredInventory, { kind: 'media', path: `docs/evidence/media/sitewipe-${version}-private.exe` }]
    }),
    /outside the exact allowlist/
  );
  await assert.rejects(lstat(target), /ENOENT/);
});

test('fails closed on linked inventory files and proves an exact repository root before writing', async (t) => {
  const root = await createRepository(t);
  const linkedPath = resolve(root, 'docs', 'evidence', 'accessibility-results.json');
  const secondName = resolve(root, 'docs', 'evidence', 'accessibility-results-second-link.json');
  await link(linkedPath, secondName);

  await assert.rejects(
    finalizePublicationEvidence({
      repositoryRoot: root,
      completedAt,
      expectedIdentity: validIdentity(),
      inventory: requiredInventory
    }),
    /singly linked regular non-reparse file/
  );

  const notRepository = await mkdtemp(resolve(tmpdir(), 'sitewipe-finalizer-not-repository-'));
  t.after(() => rm(notRepository, { recursive: true, force: true }));
  await assert.rejects(
    finalizePublicationEvidence({
      repositoryRoot: notRepository,
      completedAt,
      expectedIdentity: validIdentity(),
      inventory: requiredInventory
    }),
    /repository marker/
  );
  await assert.rejects(
    finalizePublicationEvidence({
      repositoryRoot: `${root}${sep}`,
      completedAt,
      expectedIdentity: validIdentity(),
      inventory: requiredInventory
    }),
    /exact absolute repository root/
  );
});

test('an existing manifest is immutable and every replacement request requires a forward version', async (t) => {
  const root = await createRepository(t);
  await assert.rejects(
    finalizePublicationEvidence({
      repositoryRoot: root,
      completedAt,
      expectedIdentity: validIdentity(),
      inventory: requiredInventory,
      expectedExistingManifestSha256: '0'.repeat(64)
    }),
    /replacement is prohibited.*forward version/
  );
  const first = await finalizePublicationEvidence({
    repositoryRoot: root,
    completedAt,
    expectedIdentity: validIdentity(),
    inventory: requiredInventory
  });
  const target = resolve(root, ...EVIDENCE_FINALIZATION_MANIFEST_PATH.split('/'));
  const original = await readFile(target);

  await assert.rejects(
    finalizePublicationEvidence({
      repositoryRoot: root,
      completedAt: '2026-08-25T23:16:00.000Z',
      expectedIdentity: validIdentity(),
      inventory: requiredInventory
    }),
    /already exists and is immutable.*forward version/
  );
  assert.equal((await readFile(target)).equals(original), true);

  await assert.rejects(
    finalizePublicationEvidence({
      repositoryRoot: root,
      completedAt: '2026-08-25T23:16:00.000Z',
      expectedIdentity: validIdentity(),
      inventory: requiredInventory,
      expectedExistingManifestSha256: '0'.repeat(64)
    }),
    /replacement is prohibited.*forward version/
  );
  assert.equal((await readFile(target)).equals(original), true);

  await assert.rejects(
    finalizePublicationEvidence({
      repositoryRoot: root,
      completedAt: '2026-08-25T23:16:00.000Z',
      expectedIdentity: validIdentity(),
      inventory: requiredInventory,
      expectedExistingManifestSha256: first.manifestSha256
    }),
    /replacement is prohibited.*forward version/
  );
  assert.equal((await readFile(target)).equals(original), true);
});

test('final inventory replay rejects mutation before and after immutable creation', async (t) => {
  await t.test('same-size earlier-entry mutation before create leaves no manifest', async (t) => {
    const root = await createRepository(t);
    const firstPath = resolve(root, ...requiredInventory[0].path.split('/'));
    const target = resolve(root, ...EVIDENCE_FINALIZATION_MANIFEST_PATH.split('/'));
    const size = (await readFile(firstPath)).length;
    await assert.rejects(
      finalizePublicationEvidence({
        repositoryRoot: root,
        completedAt,
        expectedIdentity: validIdentity(),
        inventory: requiredInventory,
        testOnlyAfterInventoryPass: async (phase) => {
          if (phase === 'after-initial-pass') await writeFile(firstPath, Buffer.alloc(size, 0x53));
        }
      }),
      /inventory changed before immutable manifest creation/
    );
    await assert.rejects(readFile(target), { code: 'ENOENT' });
  });

  await t.test('earlier-entry replacement after create is detected and the manifest is never rewritten', async (t) => {
    const root = await createRepository(t);
    const firstPath = resolve(root, ...requiredInventory[0].path.split('/'));
    const target = resolve(root, ...EVIDENCE_FINALIZATION_MANIFEST_PATH.split('/'));
    const size = (await readFile(firstPath)).length;
    await assert.rejects(
      finalizePublicationEvidence({
        repositoryRoot: root,
        completedAt,
        expectedIdentity: validIdentity(),
        inventory: requiredInventory,
        testOnlyAfterInventoryPass: async (phase) => {
          if (phase === 'after-create') {
            const replacement = `${firstPath}.replacement`;
            await writeFile(replacement, Buffer.alloc(size, 0x52));
            await rm(firstPath);
            await link(replacement, firstPath);
            await rm(replacement);
          }
        }
      }),
      /inventory changed after immutable manifest creation/
    );
    const retained = await readFile(target);
    await assert.rejects(
      finalizePublicationEvidence({
        repositoryRoot: root,
        completedAt: '2026-08-25T23:17:00.000Z',
        expectedIdentity: validIdentity(),
        inventory: requiredInventory
      }),
      /already exists and is immutable.*forward version/
    );
    assert.equal((await readFile(target)).equals(retained), true);
  });
});

test('staged publication failure leaves the canonical path absent and permits one clean retry', async (t) => {
  const root = await createRepository(t);
  const target = resolve(root, ...EVIDENCE_FINALIZATION_MANIFEST_PATH.split('/'));
  await assert.rejects(
    finalizePublicationEvidence({
      repositoryRoot: root,
      completedAt,
      expectedIdentity: validIdentity(),
      inventory: requiredInventory,
      testOnlyAfterInventoryPass: async (phase) => {
        if (phase === 'after-stage-write') throw new Error('injected staged publication failure');
      }
    }),
    /injected staged publication failure/
  );
  await assert.rejects(readFile(target), { code: 'ENOENT' });
  assert.equal(
    (await repositoryFiles(root)).some((path) => path.includes('.sitewipe-')),
    false
  );

  const retry = await finalizePublicationEvidence({
    repositoryRoot: root,
    completedAt,
    expectedIdentity: validIdentity(),
    inventory: requiredInventory
  });
  assert.equal(retry.writeMode, 'created');
  assert.equal((await readFile(target)).equals(canonicalEvidenceFinalizationJsonBytes(retry.manifest)), true);
});

test('post-close staging replay failure removes the exact owned sibling before returning', async (t) => {
  const root = await createRepository(t);
  const target = resolve(root, ...EVIDENCE_FINALIZATION_MANIFEST_PATH.split('/'));
  await assert.rejects(
    finalizePublicationEvidence({
      repositoryRoot: root,
      completedAt,
      expectedIdentity: validIdentity(),
      inventory: requiredInventory,
      testOnlyAfterInventoryPass: async (phase) => {
        if (phase === 'after-stage-close') throw new Error('injected post-close replay failure');
      }
    }),
    /injected post-close replay failure/
  );
  await assert.rejects(readFile(target), { code: 'ENOENT' });
  assert.equal(
    (await repositoryFiles(root)).some((path) => path.includes('.sitewipe-')),
    false
  );
});

test('package identity is replayed before publication and a same-size version substitution leaves no manifest', async (t) => {
  const root = await createRepository(t);
  const target = resolve(root, ...EVIDENCE_FINALIZATION_MANIFEST_PATH.split('/'));
  await assert.rejects(
    finalizePublicationEvidence({
      repositoryRoot: root,
      completedAt,
      expectedIdentity: validIdentity(),
      inventory: requiredInventory,
      testOnlyAfterInventoryPass: async (phase) => {
        if (phase === 'after-initial-pass') {
          await writeFile(
            resolve(root, 'package.json'),
            `${JSON.stringify({ name: 'sitewipe-unreleased-candidate', version: '1.11.91', private: true }, null, 2)}\n`
          );
        }
      }
    }),
    /package identity changed before immutable manifest creation/
  );
  await assert.rejects(readFile(target), { code: 'ENOENT' });
});

test('create-only result exposes no repository path or approval claim', async (t) => {
  const root = await createRepository(t);
  const created = await finalizePublicationEvidence({
    repositoryRoot: root,
    completedAt,
    expectedIdentity: validIdentity(),
    inventory: requiredInventory
  });
  assert.equal(JSON.stringify(created).includes(root), false);
  assert.equal(Object.hasOwn(created, 'approved'), false);
  assert.equal(Object.hasOwn(created.manifest, 'reviewerApproval'), false);
});

async function createRepository(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'sitewipe-finalizer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, '.git'));
  await writeFile(
    resolve(root, 'package.json'),
    `${JSON.stringify({ name: 'sitewipe-unreleased-candidate', version, private: true }, null, 2)}\n`
  );
  for (const item of requiredInventory) {
    const bytes = Buffer.from(`${item.path}\n`, 'utf8');
    await write(root, item.path, bytes);
  }
  return root;
}

async function write(root, repositoryPath, bytes) {
  const absolute = resolve(root, ...repositoryPath.split('/'));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, bytes);
}

async function repositoryFiles(root, current = root) {
  const result = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = resolve(current, entry.name);
    if (entry.isDirectory()) result.push(...(await repositoryFiles(root, absolute)));
    else result.push(absolute.slice(root.length + 1).replaceAll('\\', '/'));
  }
  return result.sort();
}

function validIdentity() {
  return {
    artifactSha256: 'A'.repeat(64),
    artifactVersion: version,
    browserAggregateSha256: 'B'.repeat(64),
    browserResultSetSha256: 'C'.repeat(64),
    browserRuntimeSetSha256: 'D'.repeat(64),
    gitExecutableSha256: 'E'.repeat(64),
    harnessManifestSha256: 'F'.repeat(64),
    launchPolicySha256: '1'.repeat(64),
    nativeHelperSha256: '2'.repeat(64),
    nodeExecutableSha256: '3'.repeat(64),
    nodeRuntimeVersion: 'v24.18.0',
    packageLockSha256: '4'.repeat(64),
    powerShellExecutableSha256: '5'.repeat(64),
    processObserverHelperSha256: '6'.repeat(64),
    publicReceiptSetSha256: '7'.repeat(64),
    releaseInputFingerprintSha256: '8'.repeat(64),
    runtimeFingerprintSha256: '9'.repeat(64),
    semanticValidatorManifestSha256: 'A'.repeat(64),
    testedCommitSha: 'b'.repeat(40),
    testedTreeSha: 'c'.repeat(40),
    toolchainBytes: 24_314_357,
    toolchainFileCount: 2_227,
    toolchainPackageCount: 26,
    toolchainPuppeteerVersion: '25.8.0',
    toolchainSetSha256: 'D'.repeat(64)
  };
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

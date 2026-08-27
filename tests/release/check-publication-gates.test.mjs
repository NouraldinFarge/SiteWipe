import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

import { checkPublicationGates } from '../../scripts/check-publication-gates.mjs';
import {
  canonicalEvidenceFinalizationJsonBytes,
  EVIDENCE_FINALIZATION_MANIFEST_PATH
} from '../../scripts/evidence-finalization-contract.mjs';
import { SOURCE_ARCHIVE_ROOT_FILES } from '../../scripts/release-files.mjs';
import { runTrustedGit } from '../../scripts/trusted-git.mjs';
import { runtimeArtifactBase } from '../../scripts/versioning.mjs';

const VERSION = '9.8.7';
const ORIGINAL_ARTIFACT = Buffer.from('verified synthetic runtime artifact\n', 'utf8');
const FINALIZATION_BLOCKER =
  'The exact post-browser evidence finalization manifest, independently derived identity, changed-path set, or file hashes are missing or invalid.';
const AUTOMATED_EVIDENCE_VERSION_LINEAGE_BLOCKER =
  'The committed automated-validation pointer, filename, and record are not bound to the exact package version.';
const SYNTHETIC_FINALIZATION_MANIFEST = Object.freeze({ fixture: 'committed-finalization-manifest' });
const REQUIRED_FINALIZED_RECORDS = Object.freeze(
  new Map([
    ['docs/evidence/accessibility-results.json', 'accessibility'],
    ['docs/evidence/browser-semantic-receipts.json', 'browser'],
    ['docs/evidence/browser-validation.json', 'browser'],
    ['docs/evidence/media-inventory.json', 'media'],
    ['docs/evidence/performance-results.json', 'performance']
  ])
);

test('publication gate refuses a runtime ZIP substituted after release verification', async (t) => {
  const fixture = await createPublicationFixture(t);
  const replacement = Buffer.from('substituted synthetic runtime bytes\n', 'utf8');

  const result = await checkPublicationGates({
    repositoryRoot: fixture.root,
    testOnlyVerifyReleaseCandidate: fixture.verify,
    testOnlyAfterReleaseVerification: async (phase) => {
      assert.equal(phase, 'after-release-verification');
      await writeFile(fixture.runtimeArtifactPath, replacement);
    }
  });

  assert.equal(result.publicationRecommendation, 'blocked');
  assert.ok(
    result.blockers.includes(
      'The independently re-read runtime ZIP differs from the exact artifact digest verified for publication.'
    )
  );
});

test('publication decisions come from one committed source snapshot despite a restored live substitution', async (t) => {
  const identityPath = 'docs/decisions/product-identity.json';
  const researchPath = 'docs/evidence/name-research-2026-08-17.json';
  const committedIdentity = identityBytes(false);
  const fixture = await createPublicationFixture(t, {
    trackedFiles: new Map([
      [identityPath, committedIdentity],
      [researchPath, Buffer.from(`${JSON.stringify({ approvedName: 'SiteWipe' }, null, 2)}\n`, 'utf8')]
    ])
  });

  const result = await checkPublicationGates({
    repositoryRoot: fixture.root,
    testOnlyVerifyReleaseCandidate: fixture.verify,
    testOnlyAfterReleaseVerification: async () => {
      await writeFile(resolve(fixture.root, identityPath), identityBytes(true));
    },
    testOnlyBeforeTerminalSourceReplay: async () => {
      await writeFile(resolve(fixture.root, identityPath), committedIdentity);
    }
  });

  assert.ok(
    result.blockers.includes(
      'The owner-approved product identity and its known exact-name marketplace collisions are not recorded.'
    )
  );
  assert.equal(
    result.blockers.some((blocker) => blocker.startsWith('Terminal publication source/artifact replay failed:')),
    false
  );
});

test('finalization refuses a transient optional entry that differs from the committed bytes', async (t) => {
  const optionalPath = 'docs/evidence/provenance-audit.json';
  const committedBytes = Buffer.from('{"fixture":"committed-B"}\n', 'utf8');
  const fixture = await createFinalizationFixture(t, new Map([[optionalPath, committedBytes]]));

  const result = await checkPublicationGates({
    repositoryRoot: fixture.root,
    testOnlyVerifyReleaseCandidate: fixture.verify,
    testOnlyValidatePublicationEvidenceFinalization: () =>
      finalizationFromLive(fixture.root, [...REQUIRED_FINALIZED_RECORDS, [optionalPath, 'automated']]),
    testOnlyAfterReleaseVerification: async () => {
      await writeFile(resolve(fixture.root, optionalPath), '{"fixture":"transient-A"}\n');
    },
    testOnlyBeforeTerminalSourceReplay: async () => {
      await writeFile(resolve(fixture.root, optionalPath), committedBytes);
    }
  });

  assert.ok(result.blockers.includes(FINALIZATION_BLOCKER));
  assertNoTerminalReplayFailure(result);
});

test('finalization refuses a transient canonical manifest substituted for non-canonical committed bytes', async (t) => {
  const committedBytes = Buffer.from(`${JSON.stringify(SYNTHETIC_FINALIZATION_MANIFEST, null, 2)}\n`, 'utf8');
  const canonicalBytes = canonicalEvidenceFinalizationJsonBytes(SYNTHETIC_FINALIZATION_MANIFEST);
  assert.notDeepEqual(committedBytes, canonicalBytes);
  const fixture = await createFinalizationFixture(t, new Map(), { manifestBytes: committedBytes });

  const result = await checkPublicationGates({
    repositoryRoot: fixture.root,
    testOnlyVerifyReleaseCandidate: fixture.verify,
    testOnlyValidatePublicationEvidenceFinalization: () =>
      finalizationFromLive(fixture.root, REQUIRED_FINALIZED_RECORDS),
    testOnlyAfterReleaseVerification: async () => {
      await writeFile(resolve(fixture.root, EVIDENCE_FINALIZATION_MANIFEST_PATH), canonicalBytes);
    },
    testOnlyBeforeTerminalSourceReplay: async () => {
      await writeFile(resolve(fixture.root, EVIDENCE_FINALIZATION_MANIFEST_PATH), committedBytes);
    }
  });

  assert.ok(result.blockers.includes(FINALIZATION_BLOCKER));
  assertNoTerminalReplayFailure(result);
});

test('finalization rejects an unused same-version automated record', async (t) => {
  const pointerPath = 'docs/evidence/automated-validation-current.json';
  const activeRecord = `automated-validation-2026-08-25-v${VERSION}.json`;
  const extraRecord = `automated-validation-2026-08-24-v${VERSION}.json`;
  const activePath = `docs/evidence/${activeRecord}`;
  const extraPath = `docs/evidence/${extraRecord}`;
  const fixture = await createFinalizationFixture(
    t,
    new Map([
      [pointerPath, Buffer.from(`${JSON.stringify({ record: activeRecord, version: VERSION }, null, 2)}\n`, 'utf8')],
      [activePath, Buffer.from('{"fixture":"active"}\n', 'utf8')],
      [extraPath, Buffer.from('{"fixture":"unused"}\n', 'utf8')]
    ])
  );

  const result = await checkPublicationGates({
    repositoryRoot: fixture.root,
    testOnlyVerifyReleaseCandidate: fixture.verify,
    testOnlyValidatePublicationEvidenceFinalization: () =>
      finalizationFromLive(fixture.root, [
        ...REQUIRED_FINALIZED_RECORDS,
        [pointerPath, 'automated'],
        [activePath, 'automated'],
        [extraPath, 'automated']
      ])
  });

  assert.ok(result.blockers.includes(FINALIZATION_BLOCKER));
  assertNoTerminalReplayFailure(result);
});

test('finalization rejects an active dated automated record without its pointer entry', async (t) => {
  const fixture = await createAutomatedPairFixture(t);
  const result = await checkPublicationGates({
    repositoryRoot: fixture.root,
    testOnlyVerifyReleaseCandidate: fixture.verify,
    testOnlyValidatePublicationEvidenceFinalization: () =>
      finalizationFromLive(fixture.root, [...REQUIRED_FINALIZED_RECORDS, [fixture.activePath, 'automated']])
  });

  assert.ok(result.blockers.includes(FINALIZATION_BLOCKER));
  assertNoTerminalReplayFailure(result);
});

test('finalization rejects an automated pointer entry without its active dated target', async (t) => {
  const fixture = await createAutomatedPairFixture(t);
  const result = await checkPublicationGates({
    repositoryRoot: fixture.root,
    testOnlyVerifyReleaseCandidate: fixture.verify,
    testOnlyValidatePublicationEvidenceFinalization: () =>
      finalizationFromLive(fixture.root, [...REQUIRED_FINALIZED_RECORDS, [fixture.pointerPath, 'automated']])
  });

  assert.ok(result.blockers.includes(FINALIZATION_BLOCKER));
  assertNoTerminalReplayFailure(result);
});

test('finalization accepts exactly one committed automated pointer and its active dated target', async (t) => {
  const fixture = await createAutomatedPairFixture(t);
  const result = await checkPublicationGates({
    repositoryRoot: fixture.root,
    testOnlyVerifyReleaseCandidate: fixture.verify,
    testOnlyValidatePublicationEvidenceFinalization: () =>
      finalizationFromLive(fixture.root, [
        ...REQUIRED_FINALIZED_RECORDS,
        [fixture.pointerPath, 'automated'],
        [fixture.activePath, 'automated']
      ])
  });

  assert.equal(result.blockers.includes(FINALIZATION_BLOCKER), false);
  assertNoTerminalReplayFailure(result);
});

test('publication rejects stale automated pointer and filename lineage even when finalization omits the pair', async (t) => {
  const staleRecord = 'automated-validation-2026-08-25-v0.0.1.json';
  const fixture = await createFinalizationFixture(
    t,
    new Map([
      [
        'docs/evidence/automated-validation-current.json',
        Buffer.from(`${JSON.stringify({ record: staleRecord, version: '0.0.1' }, null, 2)}\n`, 'utf8')
      ],
      [`docs/evidence/${staleRecord}`, Buffer.from('{}\n', 'utf8')]
    ])
  );
  const result = await checkPublicationGates({
    repositoryRoot: fixture.root,
    testOnlyVerifyReleaseCandidate: fixture.verify,
    testOnlyValidatePublicationEvidenceFinalization: () =>
      finalizationFromLive(fixture.root, REQUIRED_FINALIZED_RECORDS)
  });

  assert.ok(result.blockers.includes(AUTOMATED_EVIDENCE_VERSION_LINEAGE_BLOCKER));
  assert.equal(result.blockers.includes(FINALIZATION_BLOCKER), false);
  assertNoTerminalReplayFailure(result);
});

test('publication rejects a stale version-qualified filename under a current automated pointer', async (t) => {
  const staleRecord = 'automated-validation-2026-08-25-v0.0.1.json';
  const fixture = await createFinalizationFixture(
    t,
    new Map([
      [
        'docs/evidence/automated-validation-current.json',
        Buffer.from(`${JSON.stringify({ record: staleRecord, version: VERSION }, null, 2)}\n`, 'utf8')
      ],
      [`docs/evidence/${staleRecord}`, Buffer.from('{}\n', 'utf8')]
    ])
  );
  const result = await checkPublicationGates({
    repositoryRoot: fixture.root,
    testOnlyVerifyReleaseCandidate: fixture.verify,
    testOnlyValidatePublicationEvidenceFinalization: () =>
      finalizationFromLive(fixture.root, REQUIRED_FINALIZED_RECORDS)
  });

  assert.ok(result.blockers.includes(AUTOMATED_EVIDENCE_VERSION_LINEAGE_BLOCKER));
  assert.equal(result.blockers.includes(FINALIZATION_BLOCKER), false);
  assertNoTerminalReplayFailure(result);
});

test('publication permits a legacy unversioned automated filename only with the current pointer version', async (t) => {
  const legacyRecord = 'automated-validation-2026-08-25.json';
  const fixture = await createFinalizationFixture(
    t,
    new Map([
      [
        'docs/evidence/automated-validation-current.json',
        Buffer.from(`${JSON.stringify({ record: legacyRecord, version: VERSION }, null, 2)}\n`, 'utf8')
      ],
      [
        `docs/evidence/${legacyRecord}`,
        Buffer.from(
          `${JSON.stringify(
            {
              fullCheck: {
                manifest: { version: VERSION },
                versionContract: { version: VERSION }
              }
            },
            null,
            2
          )}\n`,
          'utf8'
        )
      ]
    ])
  );
  const result = await checkPublicationGates({
    repositoryRoot: fixture.root,
    testOnlyVerifyReleaseCandidate: fixture.verify,
    testOnlyValidatePublicationEvidenceFinalization: () =>
      finalizationFromLive(fixture.root, REQUIRED_FINALIZED_RECORDS)
  });

  assert.equal(result.blockers.includes(AUTOMATED_EVIDENCE_VERSION_LINEAGE_BLOCKER), false);
  assert.equal(result.blockers.includes(FINALIZATION_BLOCKER), false);
  assertNoTerminalReplayFailure(result);
});

test('publication rejects a pointed automated record with a mismatched candidate version field', async (t) => {
  const currentRecord = `automated-validation-2026-08-25-v${VERSION}.json`;
  const fixture = await createFinalizationFixture(
    t,
    new Map([
      [
        'docs/evidence/automated-validation-current.json',
        Buffer.from(`${JSON.stringify({ record: currentRecord, version: VERSION }, null, 2)}\n`, 'utf8')
      ],
      [
        `docs/evidence/${currentRecord}`,
        Buffer.from(
          `${JSON.stringify(
            {
              candidateVersion: '0.0.1',
              fullCheck: {
                manifest: { version: VERSION },
                versionContract: { version: VERSION }
              }
            },
            null,
            2
          )}\n`,
          'utf8'
        )
      ]
    ])
  );
  const result = await checkPublicationGates({
    repositoryRoot: fixture.root,
    testOnlyVerifyReleaseCandidate: fixture.verify,
    testOnlyValidatePublicationEvidenceFinalization: () =>
      finalizationFromLive(fixture.root, REQUIRED_FINALIZED_RECORDS)
  });

  assert.ok(result.blockers.includes(AUTOMATED_EVIDENCE_VERSION_LINEAGE_BLOCKER));
  assert.equal(result.blockers.includes(FINALIZATION_BLOCKER), false);
  assertNoTerminalReplayFailure(result);
});

test('terminal publication replay refuses exact HEAD, tree, source, and worktree drift', async (t) => {
  await t.test('clean HEAD movement with a changed source tree', async (t) => {
    const fixture = await createPublicationFixture(t);
    const result = await checkPublicationGates({
      repositoryRoot: fixture.root,
      testOnlyVerifyReleaseCandidate: fixture.verify,
      testOnlyBeforeTerminalSourceReplay: async (phase) => {
        assert.equal(phase, 'before-terminal-source-replay');
        await writeFile(resolve(fixture.root, 'README.md'), 'changed committed publication source\n');
        git(fixture.root, ['add', '--', 'README.md']);
        commit(fixture.root, 'move publication source HEAD');
      }
    });

    assertTerminalRefusal(result, /Git HEAD changed during release construction|Publication source/u);
  });

  await t.test('clean HEAD movement with the same source tree', async (t) => {
    const fixture = await createPublicationFixture(t);
    const result = await checkPublicationGates({
      repositoryRoot: fixture.root,
      testOnlyVerifyReleaseCandidate: fixture.verify,
      testOnlyBeforeTerminalSourceReplay: async () => {
        commit(fixture.root, 'move HEAD without changing its tree', ['--allow-empty']);
      }
    });

    assertTerminalRefusal(result, /Git HEAD changed during release construction|Publication source/u);
  });

  await t.test('tracked source/worktree mutation without a commit', async (t) => {
    const fixture = await createPublicationFixture(t);
    const result = await checkPublicationGates({
      repositoryRoot: fixture.root,
      testOnlyVerifyReleaseCandidate: fixture.verify,
      testOnlyBeforeTerminalSourceReplay: async () => {
        await writeFile(resolve(fixture.root, 'README.md'), 'dirty publication source worktree\n');
      }
    });

    assertTerminalRefusal(result, /clean Git worktree/u);
  });
});

test('publication test-only authority is unavailable outside the Node test runner', async (t) => {
  const fixture = await createPublicationFixture(t);
  const original = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    await assert.rejects(
      checkPublicationGates({ repositoryRoot: fixture.root, testOnlyVerifyReleaseCandidate: fixture.verify }),
      /available only to the Node test runner/u
    );
  } finally {
    if (original === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = original;
  }
});

async function createPublicationFixture(t, { trackedFiles = new Map() } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'sitewipe-publication-gate-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  git(root, ['init', '--quiet']);

  for (const path of SOURCE_ARCHIVE_ROOT_FILES) {
    let bytes = Buffer.from(`synthetic committed fixture for ${path}\n`, 'utf8');
    if (path === '.gitignore') bytes = Buffer.from('dist/\n', 'utf8');
    if (path === 'package.json') {
      bytes = Buffer.from(
        `${JSON.stringify({ license: 'MIT', name: 'sitewipe-unreleased-candidate', version: VERSION }, null, 2)}\n`,
        'utf8'
      );
    }
    if (path === 'package-lock.json') {
      bytes = Buffer.from(
        `${JSON.stringify({ lockfileVersion: 3, name: 'sitewipe-unreleased-candidate', packages: {}, version: VERSION }, null, 2)}\n`,
        'utf8'
      );
    }
    await mkdir(dirname(resolve(root, path)), { recursive: true });
    await writeFile(resolve(root, path), bytes);
  }
  await mkdir(resolve(root, 'src'), { recursive: true });
  await writeFile(
    resolve(root, 'src', 'package.json'),
    `${JSON.stringify({ license: 'MIT', name: 'SiteWipe', version: VERSION }, null, 2)}\n`
  );
  for (const [path, bytes] of trackedFiles) {
    await mkdir(dirname(resolve(root, path)), { recursive: true });
    await writeFile(resolve(root, path), bytes);
  }
  git(root, ['add', '--all']);
  commit(root, 'synthetic publication fixture');

  const sourceCommit = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim().toLowerCase();
  const artifactBase = runtimeArtifactBase(VERSION);
  const releaseDirectory = resolve(root, 'dist', 'current');
  const runtimeArtifactPath = resolve(releaseDirectory, `${artifactBase}.zip`);
  await mkdir(releaseDirectory, { recursive: true });
  await writeFile(runtimeArtifactPath, ORIGINAL_ARTIFACT);
  await writeFile(
    resolve(releaseDirectory, 'current-release.json'),
    `${JSON.stringify(
      {
        artifactBase,
        runtimeArtifact: `${artifactBase}.zip`,
        schema: 'sitewipe.current-unreleased-candidate.v1',
        version: VERSION
      },
      null,
      2
    )}\n`
  );

  const verified = Object.freeze({
    checksumFilesVerified: 7,
    sha256: sha256(ORIGINAL_ARTIFACT),
    sourceCommit,
    sourceFiles: SOURCE_ARCHIVE_ROOT_FILES.length + 1 + trackedFiles.size
  });
  return Object.freeze({
    root,
    runtimeArtifactPath,
    verify: async () => verified
  });
}

async function createFinalizationFixture(
  t,
  extraTrackedFiles,
  { manifestBytes = canonicalEvidenceFinalizationJsonBytes(SYNTHETIC_FINALIZATION_MANIFEST) } = {}
) {
  const records = new Map(
    [...REQUIRED_FINALIZED_RECORDS].map(([path, kind]) => [
      path,
      Buffer.from(`${JSON.stringify({ fixture: `${kind}:${path}` }, null, 2)}\n`, 'utf8')
    ])
  );
  for (const [path, bytes] of extraTrackedFiles) records.set(path, bytes);
  records.set(EVIDENCE_FINALIZATION_MANIFEST_PATH, manifestBytes);
  return createPublicationFixture(t, { trackedFiles: records });
}

async function createAutomatedPairFixture(t) {
  const pointerPath = 'docs/evidence/automated-validation-current.json';
  const activeRecord = `automated-validation-2026-08-25-v${VERSION}.json`;
  const activePath = `docs/evidence/${activeRecord}`;
  const fixture = await createFinalizationFixture(
    t,
    new Map([
      [pointerPath, Buffer.from(`${JSON.stringify({ record: activeRecord, version: VERSION }, null, 2)}\n`, 'utf8')],
      [activePath, Buffer.from('{"fixture":"active"}\n', 'utf8')]
    ])
  );
  return Object.freeze({ ...fixture, activePath, pointerPath });
}

async function finalizationFromLive(root, inventory) {
  const entries = [];
  for (const [path, kind] of [...inventory].sort(([left], [right]) => left.localeCompare(right))) {
    const bytes = await readFile(resolve(root, path));
    entries.push({ bytes: bytes.length, kind, path, sha256: sha256(bytes) });
  }
  const json = async (path) => JSON.parse(await readFile(resolve(root, path), 'utf8'));
  const manifestBytes = await readFile(resolve(root, EVIDENCE_FINALIZATION_MANIFEST_PATH));
  return {
    accessibility: await json('docs/evidence/accessibility-results.json'),
    browser: await json('docs/evidence/browser-validation.json'),
    changedPaths: [],
    entries,
    manifest: JSON.parse(manifestBytes.toString('utf8')),
    manifestSha256: sha256(manifestBytes),
    media: await json('docs/evidence/media-inventory.json'),
    performance: await json('docs/evidence/performance-results.json'),
    semanticReceipts: await json('docs/evidence/browser-semantic-receipts.json')
  };
}

function identityBytes(ownerApproved) {
  return Buffer.from(
    `${JSON.stringify(
      {
        approvedName: 'SiteWipe',
        approvedPublicVersion: VERSION,
        knownExactNameListings: ['first', 'second', 'third'],
        ownerApproved
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

function assertTerminalRefusal(result, detailPattern) {
  assert.equal(result.publicationRecommendation, 'blocked');
  const terminal = result.blockers.find((blocker) =>
    blocker.startsWith('Terminal publication source/artifact replay failed:')
  );
  assert.match(terminal ?? '', detailPattern);
}

function assertNoTerminalReplayFailure(result) {
  assert.equal(
    result.blockers.some((blocker) => blocker.startsWith('Terminal publication source/artifact replay failed:')),
    false
  );
}

function commit(root, message, extra = []) {
  git(root, [
    '-c',
    'user.name=SiteWipe Fixture',
    '-c',
    'user.email=sitewipe-fixture@example.invalid',
    'commit',
    '--quiet',
    ...extra,
    '-m',
    message
  ]);
}

function git(root, args) {
  return runTrustedGit({ root, args, encoding: 'utf8' });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

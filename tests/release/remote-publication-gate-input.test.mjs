import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';

import { canonicalRemotePublicationJsonBytes } from '../../scripts/remote-publication-evidence.mjs';
import {
  exactRemoteGateHandleStat,
  exactRemoteGatePathStat,
  readExternalRemotePublicationGateInput,
  resolveExpectedRemotePublicationBinding,
  sameRemoteGateFileIdentity
} from '../../scripts/remote-publication-gate-input.mjs';

test('remote gate file identities are BigInt-exact and every stat route requests bigint', async () => {
  const [original, differentInode, differentDevice] = collidingExactStats();
  assert.equal(Number(original.ino), Number(differentInode.ino));
  assert.equal(sameRemoteGateFileIdentity(original, differentInode), false);
  assert.equal(sameRemoteGateFileIdentity(original, differentDevice), false);
  assert.equal(sameRemoteGateFileIdentity({ ...original, ino: Number(original.ino) }, original), false);

  const pathCalls = [];
  await exactRemoteGatePathStat('gate-path', async (...args) => {
    pathCalls.push(args);
    return original;
  });
  assert.deepEqual(pathCalls, [['gate-path', { bigint: true }]]);
  const handleCalls = [];
  await exactRemoteGateHandleStat({ stat: async (options) => (handleCalls.push(options), original) });
  assert.deepEqual(handleCalls, [{ bigint: true }]);

  const source = await readFile(new URL('../../scripts/remote-publication-gate-input.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bhandle\.stat\(\s*\)/u);
  assert.doesNotMatch(source, /\bnativeLstat\(/u);
});

test('external remote gate input accepts only the exact ignored two-file canonical bundle', async (t) => {
  const container = await mkdtemp(resolve(tmpdir(), 'sitewipe-remote-gate-'));
  t.after(() => rm(container, { recursive: true, force: true }));
  const repositoryRoot = resolve(container, 'repository');
  const captureRoot = resolve(repositoryRoot, 'validation-output', 'remote-publication-captures');
  const evidenceDirectory = resolve(captureRoot, 'sitewipe-remote-fixture');
  const expectedBindingPath = resolve(container, 'expected.json');
  await mkdir(evidenceDirectory, { recursive: true });
  await writeCanonical(resolve(evidenceDirectory, 'capture.json'), { capture: true });
  await writeCanonical(resolve(evidenceDirectory, 'raw-responses.json'), { raw: true });
  await writeCanonical(expectedBindingPath, { expected: true });

  const value = await readExternalRemotePublicationGateInput({
    repositoryRoot,
    evidenceDirectory,
    expectedBindingPath
  });
  assert.deepEqual(value.capture, { capture: true });
  assert.deepEqual(value.rawBundle, { raw: true });
  assert.deepEqual(value.externalExpected, { expected: true });

  await writeCanonical(resolve(evidenceDirectory, 'extra.json'), { extra: true });
  await assert.rejects(
    readExternalRemotePublicationGateInput({ repositoryRoot, evidenceDirectory, expectedBindingPath }),
    /exact two-file contract/
  );
});

test('expected remote binding must equal independently known local identity and privacy bytes', () => {
  const privacyBytes = Buffer.from('SiteWipe privacy policy\n');
  const version = '1.11.90';
  const currentHeadSha = 'a'.repeat(40);
  const privacySha256 = '8DCEEABDC6FE2498364A79806DF0FD4AC7B55678FB181257EDF78DE1195601AD';
  const externalExpected = {
    repository: 'NouraldinFarge/SiteWipe',
    version,
    candidateBranch: `candidate/sitewipe-${version}`,
    candidateHeadSha: currentHeadSha,
    candidateActorLogin: 'NouraldinFarge',
    mainBranch: 'main',
    mainHeadSha: 'b'.repeat(40),
    hostedPrivacyPolicyRawUrl:
      'https://gist.githubusercontent.com/NouraldinFarge/id/raw/cccccccccccccccccccccccccccccccccccccccc/PRIVACY.md',
    hostedPrivacyPolicySha256: privacySha256,
    hostedPrivacyPolicyVersion: version,
    releaseEnvironmentName: 'unreleased-candidate',
    requiredChecks: [
      {
        name: 'Static, safety, tests, coverage, and package parity',
        appId: 1,
        appSlug: 'github-actions',
        detailsUrl: 'https://github.com/NouraldinFarge/SiteWipe/actions/runs/1'
      },
      {
        name: 'Analyze JavaScript',
        appId: 2,
        appSlug: 'github-advanced-security',
        detailsUrl: 'https://github.com/NouraldinFarge/SiteWipe/security/code-scanning'
      }
    ]
  };
  const remoteDecision = {
    repositoryUrl: 'https://github.com/NouraldinFarge/SiteWipe.git',
    maintainerHandle: 'NouraldinFarge',
    defaultBranch: 'main',
    approvedPublicCandidateVersion: version,
    approvedPublicCandidateBranch: `candidate/sitewipe-${version}`,
    hostedPrivacyPolicyRawUrl: externalExpected.hostedPrivacyPolicyRawUrl,
    hostedPrivacyPolicyVersion: version,
    hostedPrivacyPolicySha256: privacySha256,
    hostedPrivacyPolicyExactByteParity: true,
    requiredReleaseEnvironmentName: 'unreleased-candidate'
  };
  assert.equal(
    resolveExpectedRemotePublicationBinding({
      externalExpected,
      remoteDecision,
      version,
      currentHeadSha,
      privacyBytes
    }).candidateHeadSha,
    currentHeadSha
  );
  assert.throws(
    () =>
      resolveExpectedRemotePublicationBinding({
        externalExpected: { ...externalExpected, candidateHeadSha: 'd'.repeat(40) },
        remoteDecision,
        version,
        currentHeadSha,
        privacyBytes
      }),
    /differs from the exact local head/
  );
});

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

async function writeCanonical(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, canonicalRemotePublicationJsonBytes(value));
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  REMOTE_PUBLICATION_RAW_BUNDLE_SCHEMA,
  REMOTE_PUBLICATION_TOKEN_ENVIRONMENT,
  collectRemotePublicationEvidence,
  computeRemotePublicationRawBundleSha256,
  exactRemoteCollectorHandleStat,
  exactRemoteCollectorPathStat,
  parseRemotePublicationCollectorArguments,
  sameRemoteCollectorFileIdentity,
  validateRemotePublicationEvidenceBundle,
  writeRemotePublicationEvidenceBundle
} from '../../scripts/collect-remote-publication-evidence.mjs';
import {
  GITHUB_REST_API_VERSION,
  REMOTE_PUBLICATION_CAPTURE_SOURCE,
  REQUIRED_REMOTE_PUBLICATION_CONTEXTS,
  validateRemotePublicationCapture
} from '../../scripts/remote-publication-evidence.mjs';

test('remote collector file identities are BigInt-exact and every stat route requests bigint', async () => {
  const [original, differentInode, differentDevice] = collidingExactStats();
  assert.equal(Number(original.dev), Number(differentDevice.dev));
  assert.equal(sameRemoteCollectorFileIdentity(original, differentInode), false);
  assert.equal(sameRemoteCollectorFileIdentity(original, differentDevice), false);
  assert.equal(sameRemoteCollectorFileIdentity({ ...original, dev: Number(original.dev) }, original), false);

  const pathCalls = [];
  await exactRemoteCollectorPathStat('collector-path', async (...args) => {
    pathCalls.push(args);
    return original;
  });
  assert.deepEqual(pathCalls, [['collector-path', { bigint: true }]]);
  const handleCalls = [];
  await exactRemoteCollectorHandleStat({ stat: async (options) => (handleCalls.push(options), original) });
  assert.deepEqual(handleCalls, [{ bigint: true }]);

  const source = await readFile(
    new URL('../../scripts/collect-remote-publication-evidence.mjs', import.meta.url),
    'utf8'
  );
  assert.doesNotMatch(source, /\bhandle\.stat\(\s*\)/u);
  assert.doesNotMatch(source, /\bnativeLstat\(/u);
  assert.doesNotMatch(source, /import\s*\{[^}]*\breadFile\b[^}]*\}\s*from\s*'node:fs\/promises'/su);
});

const TOKEN = 'github_pat_fixture_only_0123456789abcdef';
const FIXTURE_VERSION = '9.8.7';
const PRIVACY_BYTES = Buffer.from('SiteWipe 9.8.7 exact synthetic privacy fixture.\n', 'utf8');
const expected = Object.freeze({
  repository: 'NouraldinFarge/SiteWipe',
  version: FIXTURE_VERSION,
  candidateBranch: `candidate/sitewipe-${FIXTURE_VERSION}`,
  candidateHeadSha: 'a'.repeat(40),
  candidateActorLogin: 'candidate-actor',
  mainBranch: 'main',
  mainHeadSha: 'b'.repeat(40),
  hostedPrivacyPolicyRawUrl:
    'https://gist.githubusercontent.com/NouraldinFarge/privacy/raw/0123456789abcdef0123456789abcdef01234567/PRIVACY.md',
  hostedPrivacyPolicySha256: sha256(PRIVACY_BYTES),
  hostedPrivacyPolicyVersion: FIXTURE_VERSION,
  releaseEnvironmentName: 'unreleased-candidate',
  requiredChecks: Object.freeze([
    Object.freeze({
      name: REQUIRED_REMOTE_PUBLICATION_CONTEXTS[0],
      appId: 15368,
      appSlug: 'github-actions',
      detailsUrl: 'https://github.com/NouraldinFarge/SiteWipe/actions/runs/9000/job/10000'
    }),
    Object.freeze({
      name: REQUIRED_REMOTE_PUBLICATION_CONTEXTS[1],
      appId: 15368,
      appSlug: 'github-actions',
      detailsUrl: 'https://github.com/NouraldinFarge/SiteWipe/actions/runs/9001/job/10001'
    })
  ])
});

test('collector performs one authenticated GET-only double-bracket capture and retains exact raw bodies', async () => {
  const remote = createRemoteFixture();
  const result = await collectRemotePublicationEvidence({
    expected,
    token: TOKEN,
    fetchImpl: remote.fetch,
    clock: increasingClock()
  });

  assert.equal(
    validateRemotePublicationCapture(result.capture, expected, { now: result.capture.validatedAt }),
    result.capture
  );
  assert.equal(result.rawBundle.schema, REMOTE_PUBLICATION_RAW_BUNDLE_SCHEMA);
  assert.equal(result.rawBundle.captureSha256, result.capture.captureSha256);
  assert.equal(computeRemotePublicationRawBundleSha256(result.rawBundle), result.rawBundle.bundleSha256);
  assert.equal(
    validateRemotePublicationEvidenceBundle({
      ...result,
      expected,
      now: result.capture.validatedAt
    }),
    result.capture
  );
  assert.equal(result.rawBundle.responseCount, remote.calls.length);
  assert.equal(result.rawBundle.responses.length, remote.calls.length);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);

  assert.ok(remote.calls.length > 15);
  assert.ok(remote.calls.every(({ options }) => options.method === 'GET' && options.body === undefined));
  assert.ok(remote.calls.every(({ options }) => options.headers['Accept-Encoding'] === 'identity'));
  const apiCalls = remote.calls.filter(({ url }) => url.startsWith('https://api.github.com/'));
  const rawCalls = remote.calls.filter(({ url }) => url.startsWith('https://gist.githubusercontent.com/'));
  assert.ok(apiCalls.every(({ options }) => options.headers.Authorization === `Bearer ${TOKEN}`));
  assert.equal(REMOTE_PUBLICATION_CAPTURE_SOURCE.apiVersion, GITHUB_REST_API_VERSION);
  assert.ok(apiCalls.every(({ options }) => options.headers['X-GitHub-Api-Version'] === GITHUB_REST_API_VERSION));
  assert.ok(rawCalls.every(({ options }) => !Object.hasOwn(options.headers, 'Authorization')));
  assert.ok(rawCalls.every(({ options }) => !Object.hasOwn(options.headers, 'X-GitHub-Api-Version')));
  assert.equal(rawCalls.length, 1);

  const candidateRefUrl = api(
    `/repos/${expected.repository}/git/ref/heads/${encodeURIComponent(expected.candidateBranch)}`
  );
  const mainRefUrl = api(`/repos/${expected.repository}/git/ref/heads/${expected.mainBranch}`);
  assert.equal(remote.calls.filter(({ url }) => url === candidateRefUrl).length, 2);
  assert.equal(remote.calls.filter(({ url }) => url === mainRefUrl).length, 2);
  assert.ok(remote.calls.some(({ url }) => /state=dismissed.*page=2$/.test(url)));
  assert.ok(remote.calls.some(({ url }) => /collaborators.*page=2$/.test(url)));

  for (const response of result.rawBundle.responses) {
    const bytes = Buffer.from(response.contentBase64, 'base64');
    assert.equal(bytes.length, response.response.bodyBytes);
    assert.equal(sha256(bytes), response.response.rawBodySha256);
    assert.equal(response.request.method, 'GET');
  }
});

test('collector rejects malformed inputs before network access and never accepts a token argument', async () => {
  let calls = 0;
  await assert.rejects(
    collectRemotePublicationEvidence({
      expected: { ...expected, candidateBranch: 'candidate/sitewipe-wrong' },
      token: TOKEN,
      fetchImpl: async () => {
        calls += 1;
      },
      clock: increasingClock()
    }),
    /exact version-qualified/i
  );
  assert.equal(calls, 0);

  assert.throws(
    () =>
      parseRemotePublicationCollectorArguments([
        '--expected',
        resolve('expected.json'),
        '--token',
        TOKEN,
        '--output-directory',
        resolve('output')
      ]),
    /accepts exactly/i
  );
  assert.equal(REMOTE_PUBLICATION_TOKEN_ENVIRONMENT, 'SITEWIPE_GITHUB_READ_TOKEN');
});

test('transport and response failures are sanitized, bounded, and fail closed', async (t) => {
  const cases = [
    ['fetch throws a credential-bearing error', { throwWithToken: true }, /read-only remote request failed/i, true],
    ['HTTP status is not successful', { statusForRepository: 503 }, /HTTP 503/i],
    ['response Date is missing', { omitDateForRepository: true }, /missing Date/i],
    ['response is compressed despite identity request', { compressedRepository: true }, /identity encoding/i],
    ['response declares an oversized body', { oversizedRepositoryLength: true }, /bounded Content-Length/i],
    ['response declares the wrong body size', { mismatchedRepositoryLength: true }, /declared Content-Length/i],
    ['API response is not JSON', { nonJsonRepository: true }, /unexpected content type/i],
    ['JSON is malformed', { malformedRepositoryJson: true }, /not valid JSON/i],
    ['credential is reflected in a body', { echoTokenInRepository: true }, /contains the authentication credential/i],
    [
      'candidate ref changes inside the bracket',
      { driftCandidateAfter: true },
      /differs from the expected exact head/i
    ],
    ['pagination skips a page', { wrongDismissedNextLink: true }, /exact next-page sequence/i]
  ];

  for (const [name, fixtureOptions, pattern, assertRedaction = false] of cases) {
    await t.test(name, async () => {
      const remote = createRemoteFixture(fixtureOptions);
      let error;
      try {
        await collectRemotePublicationEvidence({
          expected,
          token: TOKEN,
          fetchImpl: remote.fetch,
          clock: increasingClock()
        });
      } catch (caught) {
        error = caught;
      }
      assert.ok(error);
      assert.match(error.message, pattern);
      if (assertRedaction) assert.equal(error.message.includes(TOKEN), false);
      assert.ok(remote.calls.every(({ options }) => options.method === 'GET'));
    });
  }
});

test('complete pagination and exact required-check identities cannot be substituted', async (t) => {
  const cases = [
    ['required check app changes', { wrongCheckApp: true }, /response differs from its exact binding/i],
    ['required check is duplicated', { duplicateCheckRun: true }, /exactly one latest run/i],
    ['dismissed alert repeats across pages', { duplicateDismissedAlert: true }, /repeat an alert/i],
    ['read-only collaborator cannot satisfy reviewer schema', { readOnlyReviewer: true }, /write-capable/i]
  ];
  for (const [name, fixtureOptions, pattern] of cases) {
    await t.test(name, async () => {
      const remote = createRemoteFixture(fixtureOptions);
      await assert.rejects(
        collectRemotePublicationEvidence({
          expected,
          token: TOKEN,
          fetchImpl: remote.fetch,
          clock: increasingClock()
        }),
        pattern
      );
    });
  }
});

test('create-only writer accepts only a direct child of the ignored external capture root', async (t) => {
  const remote = createRemoteFixture();
  const result = await collectRemotePublicationEvidence({
    expected,
    token: TOKEN,
    fetchImpl: remote.fetch,
    clock: increasingClock()
  });
  const root = await mkdtemp(resolve(tmpdir(), 'sitewipe-remote-collector-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = resolve(root, 'validation-output', 'remote-publication-captures', 'sitewipe-remote-fixture');
  const written = await writeRemotePublicationEvidenceBundle({
    ...result,
    outputDirectory: output,
    repositoryRoot: root
  });
  assert.equal(written.responseCount, result.rawBundle.responseCount);
  const storedCapture = JSON.parse(await readFile(written.capturePath, 'utf8'));
  const storedRaw = JSON.parse(await readFile(written.rawBundlePath, 'utf8'));
  assert.equal(storedCapture.captureSha256, result.capture.captureSha256);
  assert.equal(storedRaw.bundleSha256, result.rawBundle.bundleSha256);
  assert.equal(JSON.stringify(storedRaw).includes(TOKEN), false);

  await assert.rejects(
    writeRemotePublicationEvidenceBundle({
      ...result,
      outputDirectory: output,
      repositoryRoot: root
    }),
    /already exists|EEXIST/i
  );
  await assert.rejects(
    writeRemotePublicationEvidenceBundle({
      ...result,
      outputDirectory: resolve(root, 'outside', 'sitewipe-remote-escape'),
      repositoryRoot: root
    }),
    /direct child/i
  );
});

test('raw bundle digest detects any retained-body or metadata mutation', async () => {
  const remote = createRemoteFixture();
  const { capture, rawBundle } = await collectRemotePublicationEvidence({
    expected,
    token: TOKEN,
    fetchImpl: remote.fetch,
    clock: increasingClock()
  });
  const mutated = structuredClone(rawBundle);
  mutated.responses[0].response.etag = '"changed"';
  assert.notEqual(computeRemotePublicationRawBundleSha256(mutated), mutated.bundleSha256);

  const captureTimeMutation = structuredClone(rawBundle);
  captureTimeMutation.createdAt = '2026-08-25T12:00:59.000Z';
  captureTimeMutation.bundleSha256 = computeRemotePublicationRawBundleSha256(captureTimeMutation);
  assert.throws(
    () =>
      validateRemotePublicationEvidenceBundle({
        capture,
        rawBundle: captureTimeMutation,
        expected,
        now: '2026-08-25T12:01:00.000Z'
      }),
    /exact capture identity and time/i
  );
});

function createRemoteFixture(options = {}) {
  const calls = [];
  const counts = new Map();
  const repoPath = `/repos/${expected.repository}`;
  const candidateRefUrl = api(`${repoPath}/git/ref/heads/${encodeURIComponent(expected.candidateBranch)}`);
  const mainRefUrl = api(`${repoPath}/git/ref/heads/${expected.mainBranch}`);
  const dismissedPage1 = codeqlUrl(repoPath, `refs/heads/${expected.candidateBranch}`, 'dismissed', 1);
  const dismissedPage2 = codeqlUrl(repoPath, `refs/heads/${expected.candidateBranch}`, 'dismissed', 2);
  const collaboratorsPage1 = api(`${repoPath}/collaborators?affiliation=direct&per_page=100&page=1`);
  const collaboratorsPage2 = api(`${repoPath}/collaborators?affiliation=direct&per_page=100&page=2`);

  return {
    calls,
    async fetch(url, requestOptions) {
      calls.push({ url, options: structuredClone(requestOptions) });
      const count = (counts.get(url) || 0) + 1;
      counts.set(url, count);
      if (options.throwWithToken && calls.length === 1) throw new Error(`transport ${TOKEN}`);

      let body;
      let link = null;
      if (url === candidateRefUrl) {
        body = {
          ref: `refs/heads/${expected.candidateBranch}`,
          object: {
            type: 'commit',
            sha: options.driftCandidateAfter && count === 2 ? 'd'.repeat(40) : expected.candidateHeadSha
          }
        };
      } else if (url === mainRefUrl) {
        body = { ref: 'refs/heads/main', object: { type: 'commit', sha: expected.mainHeadSha } };
      } else if (url === api(repoPath)) {
        if (options.echoTokenInRepository) body = { reflected: TOKEN };
        else {
          body = {
            id: 123456789,
            full_name: expected.repository,
            html_url: `https://github.com/${expected.repository}`,
            default_branch: expected.mainBranch,
            visibility: 'public'
          };
        }
      } else if (url === api(`${repoPath}/branches/main/protection`)) {
        body = {
          required_status_checks: {
            strict: true,
            contexts: [...REQUIRED_REMOTE_PUBLICATION_CONTEXTS],
            checks: expected.requiredChecks.map((check) => ({ context: check.name, app_id: check.appId }))
          },
          enforce_admins: { enabled: true },
          required_conversation_resolution: { enabled: true },
          required_linear_history: { enabled: true },
          allow_force_pushes: { enabled: false },
          allow_deletions: { enabled: false }
        };
      } else if (expected.requiredChecks.some((check) => url === checkRunsUrl(repoPath, check))) {
        const index = expected.requiredChecks.findIndex((check) => url === checkRunsUrl(repoPath, check));
        const binding = expected.requiredChecks[index];
        const run = {
          id: 9000 + index,
          name: binding.name,
          app: { id: options.wrongCheckApp && index === 0 ? binding.appId + 1 : binding.appId, slug: binding.appSlug },
          details_url: binding.detailsUrl,
          head_sha: expected.candidateHeadSha,
          status: 'completed',
          conclusion: 'success',
          completed_at: `2026-08-25T11:5${index}:00Z`
        };
        body = {
          total_count: options.duplicateCheckRun && index === 0 ? 2 : 1,
          check_runs: options.duplicateCheckRun && index === 0 ? [run, { ...run, id: 9999 }] : [run]
        };
      } else if (url === api(`${repoPath}/private-vulnerability-reporting`)) {
        body = { enabled: true };
      } else if (url === api(`${repoPath}/actions/permissions/workflow`)) {
        body = { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false };
      } else if (url === api(`${repoPath}/actions/permissions`)) {
        body = { enabled: true, allowed_actions: 'selected', sha_pinning_required: true };
      } else if (url === codeqlUrl(repoPath, `refs/heads/${expected.candidateBranch}`, 'open', 1)) {
        body = [];
      } else if (url === dismissedPage1) {
        body = [dismissedAlert(7, '2026-08-25T11:30:00Z')];
        link = `<${options.wrongDismissedNextLink ? codeqlUrl(repoPath, `refs/heads/${expected.candidateBranch}`, 'dismissed', 3) : dismissedPage2}>; rel="next"`;
      } else if (url === dismissedPage2) {
        body = [
          options.duplicateDismissedAlert
            ? dismissedAlert(7, '2026-08-25T11:30:00Z')
            : dismissedAlert(8, '2026-08-25T11:31:00Z')
        ];
      } else if (url === expected.hostedPrivacyPolicyRawUrl) {
        return response(PRIVACY_BYTES, { contentType: 'text/plain; charset=utf-8' });
      } else if (url === api(`${repoPath}/environments/unreleased-candidate`)) {
        body = {
          name: 'unreleased-candidate',
          protection_rules: [
            {
              type: 'required_reviewers',
              prevent_self_review: true,
              reviewers: [{ type: 'User', reviewer: { login: 'independent-reviewer' } }]
            },
            { type: 'branch_policy' }
          ],
          deployment_branch_policy: { protected_branches: true, custom_branch_policies: false }
        };
      } else if (url === collaboratorsPage1) {
        body = [collaborator('candidate-actor', 'admin')];
        link = `<${collaboratorsPage2}>; rel="next"`;
      } else if (url === collaboratorsPage2) {
        body = [collaborator('independent-reviewer', options.readOnlyReviewer ? 'read' : 'maintain')];
      } else {
        throw new Error(`Unexpected fixture URL: ${url}`);
      }

      if (url === api(repoPath) && options.malformedRepositoryJson) {
        return response(Buffer.from('{', 'utf8'));
      }
      const status = url === api(repoPath) && options.statusForRepository ? options.statusForRepository : 200;
      return response(Buffer.from(JSON.stringify(body), 'utf8'), {
        status,
        link,
        omitDate: url === api(repoPath) && options.omitDateForRepository,
        contentEncoding: url === api(repoPath) && options.compressedRepository ? 'gzip' : null,
        contentLength:
          url === api(repoPath) && options.oversizedRepositoryLength
            ? String(17 * 1024 * 1024)
            : url === api(repoPath) && options.mismatchedRepositoryLength
              ? '1'
              : null,
        contentType:
          url === api(repoPath) && options.nonJsonRepository
            ? 'text/plain; charset=utf-8'
            : 'application/json; charset=utf-8'
      });
    }
  };
}

function response(
  bytes,
  {
    status = 200,
    link = null,
    contentType = 'application/json; charset=utf-8',
    omitDate = false,
    contentEncoding = null,
    contentLength = null
  } = {}
) {
  const headers = new Headers({
    'content-type': contentType,
    etag: '"fixture-etag"',
    'x-github-request-id': 'FIXTURE:0001:0002'
  });
  if (!omitDate) headers.set('date', 'Tue, 25 Aug 2026 12:00:00 GMT');
  if (link !== null) headers.set('link', link);
  if (contentEncoding !== null) headers.set('content-encoding', contentEncoding);
  if (contentLength !== null) headers.set('content-length', contentLength);
  return new Response(bytes, { status, headers });
}

function collaborator(login, permission) {
  return {
    login,
    permissions: {
      admin: permission === 'admin',
      maintain: permission === 'maintain',
      push: permission === 'write',
      triage: permission === 'triage',
      pull: true
    }
  };
}

function dismissedAlert(number, dismissedAt) {
  return {
    number,
    rule: { id: `js/fixture-${number}` },
    state: 'dismissed',
    dismissed_at: dismissedAt,
    dismissed_by: { login: 'security-maintainer' },
    dismissed_reason: 'false positive',
    dismissed_comment: `Exact synthetic dismissal ${number}.`
  };
}

function increasingClock() {
  let milliseconds = Date.parse('2026-08-25T12:00:00.000Z') - 1_000;
  return () => new Date((milliseconds += 1_000));
}

function api(path) {
  return `https://api.github.com${path}`;
}

function checkRunsUrl(repoPath, binding) {
  return api(
    `${repoPath}/commits/${expected.candidateHeadSha}/check-runs?check_name=${encodeURIComponent(binding.name)}&filter=latest&app_id=${binding.appId}&per_page=100`
  );
}

function codeqlUrl(repoPath, ref, state, page) {
  return api(
    `${repoPath}/code-scanning/alerts?ref=${encodeURIComponent(ref)}&state=${state}&tool_name=CodeQL&per_page=100&page=${page}`
  );
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

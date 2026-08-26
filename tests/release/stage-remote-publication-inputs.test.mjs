import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  GITHUB_REST_API_VERSION,
  REQUIRED_RELEASE_ENVIRONMENT_NAME,
  REQUIRED_REMOTE_PUBLICATION_CONTEXTS,
  canonicalRemotePublicationJsonBytes
} from '../../scripts/remote-publication-evidence.mjs';
import {
  REMOTE_PUBLICATION_EXPECTED_VARIABLE_NAME,
  REMOTE_PUBLICATION_TOKEN_SECRET_NAME,
  stageRemotePublicationInputs
} from '../../scripts/stage-remote-publication-inputs.mjs';

const TOKEN = 'github_pat_fixture_only_stage_0123456789abcdef';
const REPOSITORY = 'NouraldinFarge/SiteWipe';
const REPOSITORY_ID = '123456789';
const VERSION = '9.8.7';

test('protected remote-input preflight proves exact environment scope before create-only staging', async (t) => {
  const fixture = await createFilesystemFixture(t);
  const expected = expectedBinding();
  const expectedJson = canonicalOneLine(expected);
  const remote = createMetadataFixture({ expectedJson });
  const outputPath = resolve(fixture.external, 'sitewipe-remote-expected-binding.json');

  const result = await stageRemotePublicationInputs({
    repository: REPOSITORY,
    repositoryId: REPOSITORY_ID,
    environmentName: REQUIRED_RELEASE_ENVIRONMENT_NAME,
    expectedJson,
    token: TOKEN,
    outputPath,
    repositoryRoot: fixture.repository,
    fetchImpl: remote.fetch
  });

  assert.equal(result.apiVersion, GITHUB_REST_API_VERSION);
  assert.equal(result.outputPath, outputPath);
  assert.equal(result.repository, REPOSITORY);
  assert.equal(result.repositoryId, REPOSITORY_ID);
  assert.equal(result.variableName, REMOTE_PUBLICATION_EXPECTED_VARIABLE_NAME);
  assert.equal(result.secretName, REMOTE_PUBLICATION_TOKEN_SECRET_NAME);
  assert.deepEqual(await readFile(outputPath), canonicalRemotePublicationJsonBytes(expected));
  assert.equal(remote.calls.length, 3);
  assert.match(remote.calls[0].url, new RegExp(`/repositories/${REPOSITORY_ID}$`));
  assert.match(
    remote.calls[1].url,
    new RegExp(
      `/repos/${REPOSITORY}/environments/${REQUIRED_RELEASE_ENVIRONMENT_NAME}/variables/${REMOTE_PUBLICATION_EXPECTED_VARIABLE_NAME}$`
    )
  );
  assert.match(
    remote.calls[2].url,
    new RegExp(
      `/repos/${REPOSITORY}/environments/${REQUIRED_RELEASE_ENVIRONMENT_NAME}/secrets/${REMOTE_PUBLICATION_TOKEN_SECRET_NAME}$`
    )
  );
  for (const { options } of remote.calls) {
    assert.equal(options.method, 'GET');
    assert.equal(options.body, undefined);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(options.headers['X-GitHub-Api-Version'], GITHUB_REST_API_VERSION);
  }

  await assert.rejects(
    stageRemotePublicationInputs({
      repository: REPOSITORY,
      repositoryId: REPOSITORY_ID,
      environmentName: REQUIRED_RELEASE_ENVIRONMENT_NAME,
      expectedJson,
      token: TOKEN,
      outputPath,
      repositoryRoot: fixture.repository,
      fetchImpl: remote.fetch
    }),
    /already exists/i
  );
  assert.equal(remote.calls.length, 3);
});

test('protected remote-input preflight rejects fallback, mismatch, malformed, reflected, and unsafe inputs', async (t) => {
  const fixture = await createFilesystemFixture(t);
  const expected = expectedBinding();
  const expectedJson = canonicalOneLine(expected);
  let sequence = 0;

  async function rejects(overrides, pattern) {
    sequence += 1;
    const remote = createMetadataFixture({ expectedJson, ...(overrides.remote || {}) });
    const outputPath = overrides.outputPath || resolve(fixture.external, `expected-${sequence}.json`);
    await assert.rejects(
      stageRemotePublicationInputs({
        repository: REPOSITORY,
        repositoryId: REPOSITORY_ID,
        environmentName: REQUIRED_RELEASE_ENVIRONMENT_NAME,
        expectedJson,
        token: TOKEN,
        outputPath,
        repositoryRoot: fixture.repository,
        fetchImpl: remote.fetch,
        ...overrides.arguments
      }),
      pattern
    );
    return remote.calls;
  }

  assert.equal(
    (
      await rejects(
        { arguments: { environmentName: 'unprotected-environment' } },
        /must come from unreleased-candidate/i
      )
    ).length,
    0
  );
  assert.equal(
    (await rejects({ arguments: { expectedJson: JSON.stringify(expected, null, 2) } }, /canonical one-line JSON/i))
      .length,
    0
  );
  assert.equal((await rejects({ arguments: { repositoryId: '0' } }, /repository ID is invalid/i)).length, 0);
  assert.equal(
    (
      await rejects(
        { outputPath: resolve(fixture.repository, 'inside-repository.json') },
        /outside the source repository/i
      )
    ).length,
    0
  );
  assert.equal(
    (
      await rejects(
        { remote: { repository: { id: Number(REPOSITORY_ID), full_name: 'other/repository' } } },
        /repository identity differs/i
      )
    ).length,
    1
  );
  assert.equal(
    (
      await rejects(
        { remote: { variableValue: canonicalOneLine(expectedBinding({ mainHeadSha: 'c'.repeat(40) })) } },
        /variable metadata or value differs/i
      )
    ).length,
    2
  );
  assert.equal((await rejects({ remote: { secretStatus: 404 } }, /HTTP 404/i)).length, 3);
  assert.equal(
    (
      await rejects(
        { remote: { secret: { name: REMOTE_PUBLICATION_TOKEN_SECRET_NAME, reflected: TOKEN } } },
        /unexpectedly contains the credential/i
      )
    ).length,
    3
  );
  assert.equal(
    (await rejects({ remote: { secret: { name: 'SITEWIPE_OTHER_TOKEN' } } }, /secret metadata differs/i)).length,
    3
  );
});

function expectedBinding(overrides = {}) {
  return {
    candidateActorLogin: 'candidate-actor',
    candidateBranch: `candidate/sitewipe-${VERSION}`,
    candidateHeadSha: 'a'.repeat(40),
    hostedPrivacyPolicyRawUrl:
      'https://gist.githubusercontent.com/NouraldinFarge/privacy/raw/0123456789abcdef0123456789abcdef01234567/PRIVACY.md',
    hostedPrivacyPolicySha256: 'D'.repeat(64),
    hostedPrivacyPolicyVersion: VERSION,
    mainBranch: 'main',
    mainHeadSha: 'b'.repeat(40),
    releaseEnvironmentName: REQUIRED_RELEASE_ENVIRONMENT_NAME,
    repository: REPOSITORY,
    requiredChecks: REQUIRED_REMOTE_PUBLICATION_CONTEXTS.map((name, index) => ({
      appId: 15368,
      appSlug: 'github-actions',
      detailsUrl: `https://github.com/${REPOSITORY}/actions/runs/${9000 + index}/job/${10000 + index}`,
      name
    })),
    version: VERSION,
    ...overrides
  };
}

function canonicalOneLine(value) {
  return canonicalRemotePublicationJsonBytes(value).toString('utf8').slice(0, -1);
}

function createMetadataFixture({
  expectedJson,
  repository = { id: Number(REPOSITORY_ID), full_name: REPOSITORY },
  variableValue = expectedJson,
  variableStatus = 200,
  secret = { name: REMOTE_PUBLICATION_TOKEN_SECRET_NAME },
  secretStatus = 200
}) {
  const calls = [];
  return {
    calls,
    async fetch(url, options) {
      calls.push({ url, options });
      if (url.endsWith(`/repositories/${REPOSITORY_ID}`)) return jsonResponse(repository);
      if (url.includes('/variables/')) {
        return jsonResponse({ name: REMOTE_PUBLICATION_EXPECTED_VARIABLE_NAME, value: variableValue }, variableStatus);
      }
      if (url.includes('/secrets/')) return jsonResponse(secret, secretStatus);
      throw new Error('Unexpected synthetic metadata URL.');
    }
  };
}

function jsonResponse(value, status = 200) {
  const body = JSON.stringify(value);
  return new Response(body, {
    status,
    headers: {
      'content-length': String(Buffer.byteLength(body)),
      'content-type': 'application/json'
    }
  });
}

async function createFilesystemFixture(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'sitewipe-protected-remote-inputs-'));
  const repository = resolve(root, 'repository');
  const external = resolve(root, 'runner-temp');
  await mkdir(repository);
  await mkdir(external);
  t.after(() => rm(root, { force: true, recursive: true }));
  return { external, repository, root };
}

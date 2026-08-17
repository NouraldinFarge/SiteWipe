import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateIndependentGitHubReview,
  parseGitHubRepositorySlug,
  verifyLiveIndependentGitHubReview
} from '../../scripts/github-review.mjs';

const head = 'a'.repeat(40);

test('GitHub repository parsing accepts the approved HTTPS shape without credentials or lookalikes', () => {
  assert.equal(parseGitHubRepositorySlug('https://github.com/NouraldinFarge/SiteWipe'), 'NouraldinFarge/SiteWipe');
  assert.equal(parseGitHubRepositorySlug('https://github.com/NouraldinFarge/SiteWipe.git'), 'NouraldinFarge/SiteWipe');
  assert.equal(parseGitHubRepositorySlug('https://token@github.com/NouraldinFarge/SiteWipe'), null);
  assert.equal(parseGitHubRepositorySlug('https://github.example/NouraldinFarge/SiteWipe'), null);
  assert.equal(parseGitHubRepositorySlug('https://github.com/NouraldinFarge/SiteWipe/extra'), null);
});

test('a distinct write-capable current-head approval passes', () => {
  const result = evaluateIndependentGitHubReview({
    ...context(),
    reviews: [review({ login: 'IndependentReviewer' })],
    permissionsByLogin: { independentreviewer: { permission: 'write' } }
  });
  assert.equal(result.verified, true);
  assert.equal(result.reviewer, 'IndependentReviewer');
  assert.equal(result.permission, 'write');
  assert.equal(result.commitSha, head);
});

test('the maintainer and pull-request author cannot approve their own head', () => {
  const result = evaluateIndependentGitHubReview({
    ...context(),
    reviews: [review({ login: 'NouraldinFarge' })],
    permissionsByLogin: { NouraldinFarge: { permission: 'admin' } }
  });
  assert.equal(result.verified, false);
  assert.match(result.reason, /distinct write-capable reviewer/);
});

test('draft, stale-head, read-only, and malformed review evidence fail closed', () => {
  const validReview = review({ login: 'Reviewer' });
  for (const candidate of [
    { ...context(), pullRequest: { ...context().pullRequest, draft: true } },
    { ...context(), pullRequest: { ...context().pullRequest, head: { sha: 'b'.repeat(40) } } },
    { ...context(), reviews: [{ ...validReview, commit_id: 'b'.repeat(40) }] },
    { ...context(), reviews: [{ ...validReview, id: 0 }] },
    { ...context(), reviews: [{ ...validReview, html_url: 'https://example.test/review/77' }] }
  ]) {
    const result = evaluateIndependentGitHubReview({
      ...candidate,
      reviews: candidate.reviews || [validReview],
      permissionsByLogin: { Reviewer: { permission: 'read' } }
    });
    assert.equal(result.verified, false);
  }
});

test('a later changes-requested or dismissed review supersedes an earlier approval', () => {
  for (const state of ['CHANGES_REQUESTED', 'DISMISSED']) {
    const result = evaluateIndependentGitHubReview({
      ...context(),
      reviews: [
        review({ login: 'Reviewer', id: 7, submittedAt: '2026-08-17T20:00:00Z' }),
        review({ login: 'Reviewer', id: 8, state, submittedAt: '2026-08-17T20:05:00Z' })
      ],
      permissionsByLogin: { Reviewer: { permission: 'maintain' } }
    });
    assert.equal(result.verified, false);
  }
});

test('live verification reads the exact Git head, pull request, paginated reviews, and collaborator permission', () => {
  const calls = [];
  const execute = (program, args) => {
    calls.push([program, ...args]);
    if (program === 'git') return `${head}\n`;
    const endpoint = args.at(-1);
    if (endpoint === 'repos/NouraldinFarge/SiteWipe/pulls/1') return JSON.stringify(context().pullRequest);
    if (endpoint === 'repos/NouraldinFarge/SiteWipe/pulls/1/reviews') {
      return JSON.stringify([[review({ login: 'IndependentReviewer' })]]);
    }
    if (endpoint === 'repos/NouraldinFarge/SiteWipe/collaborators/IndependentReviewer/permission') {
      return JSON.stringify({ permission: 'write' });
    }
    throw new Error('Unexpected command');
  };
  const result = verifyLiveIndependentGitHubReview({
    repositoryUrl: 'https://github.com/NouraldinFarge/SiteWipe',
    pullRequestNumber: 1,
    maintainerHandle: 'NouraldinFarge',
    cwd: 'C:\\reviewed\\SiteWipe',
    execute
  });
  assert.equal(result.verified, true);
  assert.equal(result.reviewer, 'IndependentReviewer');
  assert.deepEqual(calls[0], ['git', 'rev-parse', 'HEAD']);
  assert.ok(calls.some((call) => call.includes('--paginate') && call.includes('--slurp')));
});

test('live verification fails closed for invalid configuration, malformed JSON, and unavailable GitHub data', () => {
  const invalid = verifyLiveIndependentGitHubReview({
    repositoryUrl: 'https://github.example/NouraldinFarge/SiteWipe',
    pullRequestNumber: 1,
    maintainerHandle: 'NouraldinFarge',
    cwd: '.',
    execute: () => {
      throw new Error('must not execute');
    }
  });
  assert.equal(invalid.verified, false);
  assert.match(invalid.reason, /repository or pull-request number is invalid/);

  const malformed = verifyLiveIndependentGitHubReview({
    repositoryUrl: 'https://github.com/NouraldinFarge/SiteWipe',
    pullRequestNumber: 1,
    maintainerHandle: 'NouraldinFarge',
    cwd: '.',
    execute: (program) => (program === 'git' ? `${head}\n` : '{not-json')
  });
  assert.equal(malformed.verified, false);
  assert.match(malformed.reason, /unavailable or returned malformed data/);
});

function context() {
  return {
    pullRequest: {
      state: 'open',
      draft: false,
      user: { login: 'NouraldinFarge' },
      head: { sha: head }
    },
    maintainerHandle: 'NouraldinFarge',
    currentHeadSha: head,
    reviews: [],
    permissionsByLogin: {}
  };
}

function review({ login, id = 7, state = 'APPROVED', submittedAt = '2026-08-17T20:00:00Z' }) {
  return {
    id,
    state,
    commit_id: head,
    submitted_at: submittedAt,
    html_url: `https://github.com/NouraldinFarge/SiteWipe/pull/1#pullrequestreview-${id}`,
    user: { login }
  };
}

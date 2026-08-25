import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REMOTE_PUBLICATION_CAPTURE_EXTERNAL_DIRECTORY,
  REMOTE_PUBLICATION_CAPTURE_SCHEMA,
  REMOTE_PUBLICATION_CAPTURE_SOURCE,
  REMOTE_PUBLICATION_CAPTURE_STORAGE_POLICY,
  REMOTE_PUBLICATION_NON_AUTOMATABLE_REQUIREMENTS,
  REQUIRED_REMOTE_PUBLICATION_CONTEXTS,
  canonicalRemotePublicationJsonBytes,
  computeCanonicalRemotePublicationSha256,
  computeRemotePublicationCaptureSha256,
  findRemotePublicationCaptureFindings,
  validateRemotePublicationCapture
} from '../../scripts/remote-publication-evidence.mjs';

const now = '2026-08-24T21:03:00.000Z';
// Deliberately synthetic validator identity; it must not track the package version.
const FIXTURE_VERSION = '9.8.7';
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
  hostedPrivacyPolicySha256: 'C'.repeat(64),
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
      appId: 57789,
      appSlug: 'github-advanced-security',
      detailsUrl: 'https://github.com/NouraldinFarge/SiteWipe/security/code-scanning/9001'
    })
  ])
});

test('strict external capture validates while non-automatable human requirements remain blocking', () => {
  const capture = validCapture();
  assert.equal(validateRemotePublicationCapture(capture, expected, { now }), capture);
  assert.equal(computeRemotePublicationCaptureSha256(capture), capture.captureSha256);
  assert.deepEqual(
    findRemotePublicationCaptureFindings({ capture, expected, now }),
    REMOTE_PUBLICATION_NON_AUTOMATABLE_REQUIREMENTS
  );
  assert.equal(canonicalRemotePublicationJsonBytes({ z: 1, a: 2 }).toString('utf8'), '{"a":2,"z":1}\n');
  assert.equal(REMOTE_PUBLICATION_CAPTURE_EXTERNAL_DIRECTORY, 'validation-output/remote-publication-captures');
  assert.deepEqual(REMOTE_PUBLICATION_CAPTURE_STORAGE_POLICY, {
    relativeDirectory: REMOTE_PUBLICATION_CAPTURE_EXTERNAL_DIRECTORY,
    rawResponsesRetainedExternally: true,
    trackedInGit: false
  });
  assert.equal(REMOTE_PUBLICATION_CAPTURE_SOURCE.captureDigestMeaning, 'integrity-only-not-source-authentication');
});

test('expected binding requires the exact version-qualified branch and privacy-policy version', async (t) => {
  const mismatchedVersion = '9.8.6';
  const cases = [
    [
      'candidate branch differs from the expected version',
      { ...expected, candidateBranch: `candidate/sitewipe-${mismatchedVersion}` },
      /exact version-qualified SiteWipe branch/i
    ],
    [
      'hosted privacy-policy version differs from the expected version',
      { ...expected, hostedPrivacyPolicyVersion: mismatchedVersion },
      /hosted privacy policy must be immutable and bound to the exact version and hash/i
    ]
  ];

  for (const [name, invalidExpected, pattern] of cases) {
    await t.test(name, () => {
      assert.throws(() => validateRemotePublicationCapture(validCapture(), invalidExpected, { now }), pattern);
    });
  }
});

test('missing capture, legacy booleans, and self-attested manual review block', () => {
  assert.match(findings(null), /capture is missing/i);
  assert.match(
    findings({
      branchProtectionVerified: true,
      requiredChecksVerified: true,
      hostedPrivacyPolicyExactByteParity: true
    }),
    /keys differ from the exact schema/i
  );

  const selfAttested = validCapture();
  selfAttested.localAttestations.independentPublicationReview = {
    status: 'passed',
    satisfiesPublicationGate: true
  };
  reseal(selfAttested);
  assert.match(findings(selfAttested), /cannot be self-attested/i);
});

test('capture integrity, ignored storage policy, and externally retained raw-response identity reject mutations', async (t) => {
  const cases = [
    [
      'unsealed projection mutation',
      (capture) => {
        capture.observations.repository.projection.visibility = 'private';
      },
      /capture SHA-256 does not match/i,
      false
    ],
    [
      'capture is marked Git tracked',
      (capture) => {
        capture.storage.trackedInGit = true;
      },
      /storage policy differs/i
    ],
    [
      'raw response body digest is malformed',
      (capture) => {
        capture.observations.repository.exchanges[0].response.rawBodySha256 = 'BAD';
      },
      /raw-body hash/i
    ],
    [
      'raw response bytes are absent',
      (capture) => {
        capture.observations.repository.exchanges[0].response.bodyBytes = 0;
      },
      /raw-body hash/i
    ],
    [
      'projection pretends to be the raw API response',
      (capture) => {
        capture.observations.repository.rawPayload = {};
      },
      /keys differ from the exact schema/i
    ]
  ];

  for (const [name, mutate, pattern, seal = true] of cases) {
    await t.test(name, () => {
      const capture = validCapture();
      mutate(capture);
      if (seal) reseal(capture);
      assert.match(findings(capture), pattern);
    });
  }
});

test('candidate and main refs must both bracket every API projection without actor/version invention', async (t) => {
  const capture = validCapture();
  assert.deepEqual(Object.keys(capture.observations.candidateRefBefore.projection).sort(), [
    'branch',
    'headSha',
    'ref'
  ]);
  assert.deepEqual(Object.keys(capture.observations.mainRefBefore.projection).sort(), ['branch', 'headSha', 'ref']);

  const cases = [
    [
      'candidate changes after observations',
      (value) => {
        value.observations.candidateRefAfter.projection.headSha = 'd'.repeat(40);
      },
      /exact branch and head/i
    ],
    [
      'main changes after observations',
      (value) => {
        value.observations.mainRefAfter.projection.headSha = 'd'.repeat(40);
      },
      /exact branch and head/i
    ],
    [
      'main protection is bound to another head',
      (value) => {
        value.observations.mainProtection.projection.headSha = 'd'.repeat(40);
      },
      /main branch protection/i
    ],
    [
      'main before observation occurs after an API projection',
      (value) => {
        setObservedAt(value.observations.mainRefBefore, '2026-08-24T21:01:50.000Z');
      },
      /double bracket|outside the candidate-and-main ref bracket/i
    ],
    [
      'candidate-after does not precede main-after',
      (value) => {
        setObservedAt(value.observations.candidateRefAfter, '2026-08-24T21:02:00.000Z');
      },
      /double bracket/i
    ]
  ];

  for (const [name, mutate, pattern] of cases) {
    await t.test(name, () => {
      const value = validCapture();
      mutate(value);
      reseal(value);
      assert.match(findings(value), pattern);
    });
  }
});

test('required check runs bind exact head, app id/slug, details URL, and success', async (t) => {
  const cases = [
    [
      'app id differs',
      (capture) => {
        capture.observations.candidateRequiredContexts.projection.requiredContexts[0].appId += 1;
      }
    ],
    [
      'app slug differs',
      (capture) => {
        capture.observations.candidateRequiredContexts.projection.requiredContexts[0].appSlug = 'unknown-app';
      }
    ],
    [
      'details URL differs',
      (capture) => {
        capture.observations.candidateRequiredContexts.projection.requiredContexts[0].detailsUrl += '?other=1';
      }
    ],
    [
      'check head differs',
      (capture) => {
        capture.observations.candidateRequiredContexts.projection.requiredContexts[0].headSha = 'd'.repeat(40);
      }
    ],
    [
      'check fails',
      (capture) => {
        capture.observations.candidateRequiredContexts.projection.requiredContexts[0].conclusion = 'failure';
      }
    ]
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const capture = validCapture();
      mutate(capture);
      reseal(capture);
      assert.match(findings(capture), /exact head, app, URL, or success identity/i);
    });
  }

  const wrongQuery = validCapture();
  wrongQuery.observations.candidateRequiredContexts.exchanges[1].request.url =
    wrongQuery.observations.candidateRequiredContexts.exchanges[0].request.url;
  reseal(wrongQuery);
  assert.match(findings(wrongQuery), /exact filtered query/i);

  const missingQuery = validCapture();
  missingQuery.observations.candidateRequiredContexts.exchanges.pop();
  reseal(missingQuery);
  assert.match(findings(missingQuery), /one exact filtered check-runs exchange/i);
});

test('main branch required checks bind each context to its expected GitHub App', () => {
  const capture = validCapture();
  capture.observations.mainProtection.projection.requiredStatusChecks.checks[0].appId += 1;
  reseal(capture);
  assert.match(findings(capture), /required control, head, or context set/i);
});

test('CodeQL observations require exact ref query, complete pagination, and API-only dismissal metadata', async (t) => {
  const open = validCapture().observations.codeqlOpenAlerts;
  const openUrl = new URL(open.exchanges[0].request.url);
  assert.equal(openUrl.searchParams.get('ref'), `refs/heads/${expected.candidateBranch}`);
  const dismissedAlert = validCapture().observations.codeqlDismissedAlerts.projection.alerts[0];
  assert.equal(Object.hasOwn(dismissedAlert, 'review'), false);

  const cases = [
    [
      'ref query is absent',
      (capture) => {
        capture.observations.codeqlOpenAlerts.exchanges[0].request.url =
          capture.observations.codeqlOpenAlerts.exchanges[0].request.url.replace(/ref=[^&]+&/, '');
      },
      /exact expected external resource/i
    ],
    [
      'ref projection differs',
      (capture) => {
        capture.observations.codeqlOpenAlerts.projection.ref = 'refs/heads/main';
      },
      /stale, unbound, or nonzero/i
    ],
    [
      'pagination is marked incomplete',
      (capture) => {
        capture.observations.codeqlOpenAlerts.projection.pagination.complete = false;
      },
      /pagination evidence is incomplete/i
    ],
    [
      'pagination claims an unretained second page',
      (capture) => {
        capture.observations.codeqlOpenAlerts.projection.pagination.pageCount = 2;
      },
      /pagination evidence is incomplete/i
    ],
    [
      'last page falsely advertises a next link',
      (capture) => {
        capture.observations.codeqlOpenAlerts.exchanges[0].response.link =
          '<https://api.github.com/repos/NouraldinFarge/SiteWipe/code-scanning/alerts?page=2>; rel="next"';
      },
      /Link header does not prove complete pagination/i
    ],
    [
      'dismissed alert embeds a local review claim',
      (capture) => {
        capture.observations.codeqlDismissedAlerts.projection.alerts[0].review = { status: 'passed' };
      },
      /keys differ from the exact schema/i
    ]
  ];

  for (const [name, mutate, pattern] of cases) {
    await t.test(name, () => {
      const capture = validCapture();
      mutate(capture);
      reseal(capture);
      assert.match(findings(capture), pattern);
    });
  }
});

test('immutable raw privacy response is not mislabeled as REST API traffic', async (t) => {
  const privacy = validCapture().observations.hostedPrivacyPolicy;
  assert.equal(privacy.exchanges[0].request.resourceKind, 'immutable-raw-https');
  assert.equal(privacy.exchanges[0].request.url, expected.hostedPrivacyPolicyRawUrl);

  const cases = [
    [
      'raw URL is relabeled as API',
      (capture) => {
        capture.observations.hostedPrivacyPolicy.exchanges[0].request.resourceKind = 'github-rest-api';
      },
      /declared resource kind/i
    ],
    [
      'mutable raw URL is used',
      (capture) => {
        capture.observations.hostedPrivacyPolicy.exchanges[0].request.url =
          'https://gist.githubusercontent.com/NouraldinFarge/privacy/raw/PRIVACY.md';
      },
      /exact expected external resource/i
    ],
    [
      'policy projection hash differs',
      (capture) => {
        capture.observations.hostedPrivacyPolicy.projection.sha256 = 'D'.repeat(64);
      },
      /immutable raw URL, version, and exact bytes/i
    ],
    [
      'retained response hash differs from the policy projection',
      (capture) => {
        capture.observations.hostedPrivacyPolicy.exchanges[0].response.rawBodySha256 = 'D'.repeat(64);
      },
      /immutable raw URL, version, and exact bytes/i
    ],
    [
      'retained response byte count differs from the policy projection',
      (capture) => {
        capture.observations.hostedPrivacyPolicy.exchanges[0].response.bodyBytes += 1;
      },
      /immutable raw URL, version, and exact bytes/i
    ]
  ];

  for (const [name, mutate, pattern] of cases) {
    await t.test(name, () => {
      const capture = validCapture();
      mutate(capture);
      reseal(capture);
      assert.match(findings(capture), pattern);
    });
  }
});

test('response Date, validatedAt, and caller-provided now make freshness deterministic', async (t) => {
  const cases = [
    ['caller omits now', (capture) => validateRemotePublicationCapture(capture, expected), /caller-provided now/i],
    [
      'capture is stale relative to now',
      (capture) => validateRemotePublicationCapture(capture, expected, { now: '2026-08-24T22:00:00.000Z' }),
      /capture is stale/i
    ],
    [
      'validatedAt precedes completion',
      (capture) => {
        capture.validatedAt = '2026-08-24T21:01:59.000Z';
        reseal(capture);
        return validateRemotePublicationCapture(capture, expected, { now });
      },
      /validatedAt/i
    ],
    [
      'response Date is stale relative to observation',
      (capture) => {
        capture.observations.repository.exchanges[0].response.date = 'Sun, 24 Aug 2026 20:00:00 GMT';
        reseal(capture);
        return validateRemotePublicationCapture(capture, expected, { now });
      },
      /response Date is not fresh/i
    ],
    [
      'response Date is missing',
      (capture) => {
        capture.observations.repository.exchanges[0].response.date = null;
        reseal(capture);
        return validateRemotePublicationCapture(capture, expected, { now });
      },
      /HTTP Date header/i
    ]
  ];

  for (const [name, invoke, pattern] of cases) {
    await t.test(name, () => {
      assert.throws(() => invoke(validCapture()), pattern);
    });
  }
});

test('reviewer APIs prove configuration and eligibility, never human availability', async (t) => {
  const eligibility = validCapture().observations.reviewerEligibility.projection;
  assert.deepEqual(eligibility.eligibleConfiguredReviewerLogins, ['independent-reviewer']);
  assert.equal(JSON.stringify(eligibility).includes('available'), false);

  const cases = [
    [
      'only candidate actor is configured',
      (capture) => {
        capture.observations.releaseEnvironment.projection.configuredReviewerLogins = [expected.candidateActorLogin];
        capture.observations.reviewerEligibility.projection.eligibleConfiguredReviewerLogins = [];
      },
      /no configured API-eligible reviewer is distinct/i
    ],
    [
      'eligible projection invents unavailable API identity',
      (capture) => {
        capture.observations.reviewerEligibility.projection.eligibleConfiguredReviewerLogins = ['invented-reviewer'];
      },
      /no configured API-eligible reviewer is distinct/i
    ],
    [
      'availability field is added to collaborator projection',
      (capture) => {
        capture.observations.reviewerEligibility.projection.directCollaborators[0].available = true;
      },
      /keys differ from the exact schema/i
    ]
  ];

  for (const [name, mutate, pattern] of cases) {
    await t.test(name, () => {
      const capture = validCapture();
      mutate(capture);
      reseal(capture);
      assert.match(findings(capture), pattern);
    });
  }
});

function validCapture() {
  const repoPath = `/repos/${expected.repository}`;
  const codeqlRef = `refs/heads/${expected.candidateBranch}`;
  const candidateRef = {
    branch: expected.candidateBranch,
    ref: `refs/heads/${expected.candidateBranch}`,
    headSha: expected.candidateHeadSha
  };
  const mainRef = {
    branch: expected.mainBranch,
    ref: `refs/heads/${expected.mainBranch}`,
    headSha: expected.mainHeadSha
  };
  const capture = {
    schema: REMOTE_PUBLICATION_CAPTURE_SCHEMA,
    source: structuredClone(REMOTE_PUBLICATION_CAPTURE_SOURCE),
    storage: { ...REMOTE_PUBLICATION_CAPTURE_STORAGE_POLICY },
    captureWindow: {
      startedAt: '2026-08-24T21:00:00.000Z',
      completedAt: '2026-08-24T21:02:00.000Z'
    },
    validatedAt: '2026-08-24T21:02:30.000Z',
    localAttestations: Object.fromEntries(
      ['codeqlDismissalIndependentReview', 'independentPublicationReview', 'independentReviewerAvailability'].map(
        (key) => [key, { status: 'not_evidenced_by_remote_capture', satisfiesPublicationGate: false }]
      )
    ),
    observations: {
      candidateRefBefore: observation(
        api(`${repoPath}/git/ref/heads/${encodeURIComponent(expected.candidateBranch)}`),
        '2026-08-24T21:00:00.000Z',
        candidateRef
      ),
      mainRefBefore: observation(
        api(`${repoPath}/git/ref/heads/${encodeURIComponent(expected.mainBranch)}`),
        '2026-08-24T21:00:05.000Z',
        mainRef
      ),
      repository: observation(api(repoPath), '2026-08-24T21:00:10.000Z', {
        fullName: expected.repository,
        htmlUrl: `https://github.com/${expected.repository}`,
        repositoryId: 123456789,
        defaultBranch: expected.mainBranch,
        visibility: 'public'
      }),
      mainProtection: observation(
        api(`${repoPath}/branches/${encodeURIComponent(expected.mainBranch)}/protection`),
        '2026-08-24T21:00:15.000Z',
        {
          branch: expected.mainBranch,
          headSha: expected.mainHeadSha,
          requiredStatusChecks: {
            strict: true,
            contexts: [...REQUIRED_REMOTE_PUBLICATION_CONTEXTS],
            checks: expected.requiredChecks.map((check) => ({ context: check.name, appId: check.appId }))
          },
          enforceAdmins: true,
          requiredConversationResolution: true,
          requiredLinearHistory: true,
          allowForcePushes: false,
          allowDeletions: false
        }
      ),
      candidateRequiredContexts: {
        exchanges: expected.requiredChecks.map((binding, index) =>
          exchange(
            checkRunsUrl(repoPath, expected.candidateHeadSha, binding),
            `2026-08-24T21:00:2${index}.000Z`,
            'github-rest-api'
          )
        ),
        projection: {
          headSha: expected.candidateHeadSha,
          requiredContexts: expected.requiredChecks.map((binding, index) => ({
            ...binding,
            headSha: expected.candidateHeadSha,
            status: 'completed',
            conclusion: 'success',
            completedAt: `2026-08-24T20:5${index}:00.000Z`,
            checkRunId: 9000 + index
          }))
        }
      },
      privateVulnerabilityReporting: observation(
        api(`${repoPath}/private-vulnerability-reporting`),
        '2026-08-24T21:00:25.000Z',
        { enabled: true }
      ),
      actionsWorkflowPermissions: observation(
        api(`${repoPath}/actions/permissions/workflow`),
        '2026-08-24T21:00:30.000Z',
        { defaultWorkflowPermissions: 'read', canApprovePullRequestReviews: false }
      ),
      actionsRepositoryPermissions: observation(api(`${repoPath}/actions/permissions`), '2026-08-24T21:00:35.000Z', {
        enabled: true,
        allowedActions: 'selected',
        shaPinningRequired: true
      }),
      codeqlOpenAlerts: paginatedObservation(codeqlUrl(repoPath, codeqlRef, 'open', 1), '2026-08-24T21:00:40.000Z', {
        candidateHeadSha: expected.candidateHeadSha,
        ref: codeqlRef,
        openAlertCount: 0,
        pagination: { complete: true, pageCount: 1, totalItems: 0 }
      }),
      codeqlDismissedAlerts: paginatedObservation(
        codeqlUrl(repoPath, codeqlRef, 'dismissed', 1),
        '2026-08-24T21:00:45.000Z',
        {
          candidateHeadSha: expected.candidateHeadSha,
          ref: codeqlRef,
          dismissedAlertCount: 1,
          pagination: { complete: true, pageCount: 1, totalItems: 1 },
          alerts: [
            {
              alertNumber: 7,
              ruleId: 'js/example-rule',
              state: 'dismissed',
              dismissedAt: '2026-08-24T20:30:00.000Z',
              dismissedBy: 'security-maintainer',
              dismissalReason: 'false positive',
              dismissalComment: 'The API records this maintainer-supplied dismissal explanation.'
            }
          ]
        }
      ),
      hostedPrivacyPolicy: observation(
        expected.hostedPrivacyPolicyRawUrl,
        '2026-08-24T21:00:50.000Z',
        {
          rawUrl: expected.hostedPrivacyPolicyRawUrl,
          version: expected.hostedPrivacyPolicyVersion,
          sha256: expected.hostedPrivacyPolicySha256,
          bytes: 20489
        },
        'immutable-raw-https',
        {
          bodyBytes: 20489,
          rawBodySha256: expected.hostedPrivacyPolicySha256
        }
      ),
      releaseEnvironment: observation(
        api(`${repoPath}/environments/${encodeURIComponent(expected.releaseEnvironmentName)}`),
        '2026-08-24T21:00:55.000Z',
        {
          name: expected.releaseEnvironmentName,
          preventSelfReview: true,
          protectedBranchesOnly: true,
          configuredReviewerLogins: ['independent-reviewer']
        }
      ),
      reviewerEligibility: paginatedObservation(
        api(`${repoPath}/collaborators?affiliation=direct&per_page=100&page=1`),
        '2026-08-24T21:01:00.000Z',
        {
          directCollaborators: [{ login: 'independent-reviewer', permission: 'maintain' }],
          eligibleConfiguredReviewerLogins: ['independent-reviewer'],
          pagination: { complete: true, pageCount: 1, totalItems: 1 }
        }
      ),
      candidateRefAfter: observation(
        api(`${repoPath}/git/ref/heads/${encodeURIComponent(expected.candidateBranch)}`),
        '2026-08-24T21:01:55.000Z',
        candidateRef
      ),
      mainRefAfter: observation(
        api(`${repoPath}/git/ref/heads/${encodeURIComponent(expected.mainBranch)}`),
        '2026-08-24T21:02:00.000Z',
        mainRef
      )
    },
    captureSha256: ''
  };
  return reseal(capture);
}

function observation(url, observedAt, projection, resourceKind = 'github-rest-api', responseOverrides = {}) {
  return {
    exchanges: [exchange(url, observedAt, resourceKind, responseOverrides)],
    projection: structuredClone(projection)
  };
}

function paginatedObservation(url, observedAt, projection) {
  return observation(url, observedAt, projection);
}

function exchange(url, observedAt, resourceKind, responseOverrides = {}) {
  return {
    observedAt,
    request: { method: 'GET', resourceKind, url },
    response: {
      status: 200,
      date: new Date(observedAt).toUTCString(),
      contentType: resourceKind === 'github-rest-api' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      etag: '"fixture-etag"',
      githubRequestId: resourceKind === 'github-rest-api' ? 'FIXTURE:0001:0002' : null,
      link: null,
      bodyBytes: 128,
      rawBodySha256: computeCanonicalRemotePublicationSha256({ retainedRawResponseFor: url, observedAt }),
      ...responseOverrides
    }
  };
}

function setObservedAt(observationValue, observedAt) {
  observationValue.exchanges[0].observedAt = observedAt;
  observationValue.exchanges[0].response.date = new Date(observedAt).toUTCString();
}

function reseal(capture) {
  capture.captureSha256 = computeRemotePublicationCaptureSha256(capture);
  return capture;
}

function findings(capture) {
  return findRemotePublicationCaptureFindings({ capture, expected, now }).join('\n');
}

function api(path) {
  return `https://api.github.com${path}`;
}

function checkRunsUrl(repoPath, headSha, binding) {
  return api(
    `${repoPath}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(binding.name)}&filter=latest&app_id=${binding.appId}&per_page=100`
  );
}

function codeqlUrl(repoPath, ref, state, page) {
  return api(
    `${repoPath}/code-scanning/alerts?ref=${encodeURIComponent(ref)}&state=${state}&tool_name=CodeQL&per_page=100&page=${page}`
  );
}

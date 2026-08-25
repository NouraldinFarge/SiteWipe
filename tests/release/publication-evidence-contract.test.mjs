import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  BROWSER_MATRIX_VERSION,
  CANONICAL_BROWSER_MATRIX_IDS,
  CANONICAL_BROWSER_MATRIX_SHA256
} from '../browser/installed/canonical-matrix.mjs';

import {
  BROWSER_PRIVATE_EVIDENCE_RETAINED_STATUS,
  BROWSER_PUBLICATION_BINDING_SCHEMA,
  BROWSER_PUBLICATION_NOT_RUN_STATUS,
  BROWSER_PUBLIC_SEMANTIC_REPLAY,
  findAccessibilitySourceContractFindings,
  findBrowserEvidenceFindings,
  findDependencyCandidateAuditFindings,
  findMediaEvidenceFindings,
  findPerformanceEvidenceFindings,
  findRemotePublicationFindings,
  findTrackedBrowserEvidencePrivacyFindings
} from '../../scripts/publication-evidence-contract.mjs';

const artifactSha256 = 'A'.repeat(64);
const releaseInputFingerprintSha256 = 'B'.repeat(64);
const runtimeFingerprintSha256 = 'C'.repeat(64);
const finalSource = Object.freeze({
  commitSha: 'c'.repeat(40),
  treeSha: 'd'.repeat(40),
  testedCommitIsAncestor: true,
  testedTreeSha: 'b'.repeat(40),
  testedHarnessManifestSha256: '8'.repeat(64),
  testedPackageLockSha256: '5'.repeat(64),
  testedRuntimeFingerprintSha256: runtimeFingerprintSha256,
  testedReleaseInputFingerprintSha256: releaseInputFingerprintSha256,
  changedPaths: ['docs/evidence/browser-validation.json']
});

test('browser publication accepts only the exact empty not_run commitment and still blocks', () => {
  const valid = browserEvidence(emptyInstalledCommitment());
  assert.deepEqual(browserFindings(valid), [
    'Installed browser execution is not_run; no private run commitment is retained.'
  ]);

  const missing = structuredClone(valid);
  delete missing.installedEvidence;
  assert.match(browserFindings(missing).join('\n'), /missing the strict private-run public commitment/i);

  const nonempty = structuredClone(valid);
  nonempty.installedEvidence.executionPlanSha256 = null;
  assert.match(browserFindings(nonempty).join('\n'), /exact empty shape/i);

  for (const [name, mutate, pattern] of [
    [
      'failed assertion',
      (value) => {
        value.chrome.assertions[0].status = 'failed';
      },
      /not passed/
    ],
    [
      'missing matrix coverage',
      (value) => {
        value.chrome.assertions[0].matrixCoverage = ['install'];
      },
      /do not cover every requiredMatrix/
    ],
    [
      'unknown matrix coverage',
      (value) => {
        value.brave.assertions[0].matrixCoverage.push('invented');
      },
      /unknown requiredMatrix/
    ],
    [
      'stale per-assertion artifact',
      (value) => {
        value.brave.assertions[0].artifactSha256 = 'C'.repeat(64);
      },
      /current runtime artifact/
    ],
    [
      'duplicate required matrix entry',
      (value) => {
        value.requiredMatrix.push('ART-01');
      },
      /immutable canonical 24-ID matrix/
    ],
    [
      'stale matrix version',
      (value) => {
        value.matrixVersion = 'sitewipe.installed-browser-matrix.v0';
      },
      /matrixVersion is missing or stale/
    ],
    [
      'stale matrix hash',
      (value) => {
        value.matrixSha256 = 'D'.repeat(64);
      },
      /matrix SHA-256 is missing or stale/
    ]
  ]) {
    const fixture = structuredClone(valid);
    mutate(fixture);
    assert.match(browserFindings(fixture).join('\n'), pattern, name);
  }
});

test('digest-only private-run commitment is structurally valid but can never establish passing public cells', () => {
  const valid = browserEvidence(privateInstalledCommitment());
  assert.deepEqual(browserFindings(valid), [
    'Private installed-browser evidence is retained, but public semantic replay is not implemented; digests and record counts cannot establish passing browser cells.'
  ]);
  assert.equal('plan' in valid.installedEvidence, false);
  assert.equal('aggregate' in valid.installedEvidence, false);
  assert.equal('resultRecords' in valid.installedEvidence, false);
  assert.equal('sourceProvenance' in valid.installedEvidence, false);
});

test('digest-only private-run identity, matrix, completion, and replay mutations block', () => {
  const valid = browserEvidence(privateInstalledCommitment());
  for (const [name, mutate, pattern] of [
    [
      'run id',
      (value) => {
        value.installedEvidence.runId = 'latest';
      },
      /canonical run and browser matrix identities/i
    ],
    [
      'matrix ids',
      (value) => {
        value.installedEvidence.requiredMatrixIds.pop();
      },
      /canonical run and browser matrix identities/i
    ],
    [
      'matrix hash',
      (value) => {
        value.installedEvidence.matrixSha256 = 'D'.repeat(64);
      },
      /canonical run and browser matrix identities/i
    ],
    [
      'plan digest',
      (value) => {
        value.installedEvidence.executionPlanSha256 = null;
      },
      /missing an exact plan, aggregate, or result-set digest/i
    ],
    [
      'aggregate digest',
      (value) => {
        value.installedEvidence.aggregateSha256 = 'not-a-digest';
      },
      /missing an exact plan, aggregate, or result-set digest/i
    ],
    [
      'result-set digest',
      (value) => {
        value.installedEvidence.resultSetSha256 = 'd'.repeat(64);
      },
      /missing an exact plan, aggregate, or result-set digest/i
    ],
    [
      'record count',
      (value) => {
        value.installedEvidence.resultRecordCount = 47;
      },
      /canonical record count/i
    ],
    [
      'completion timestamp',
      (value) => {
        value.installedEvidence.completedAt = null;
      },
      /completion time/i
    ],
    [
      'private retention',
      (value) => {
        value.installedEvidence.privateEvidenceRetained = false;
      },
      /private-retention proof/i
    ],
    [
      'public replay claim',
      (value) => {
        value.installedEvidence.publicSemanticReplay = 'passed';
      },
      /non-implemented public replay state/i
    ],
    [
      'artifact hash',
      (value) => {
        value.installedEvidence.identity.artifactSha256 = 'D'.repeat(64);
      },
      /stale for the current artifact/i
    ],
    [
      'identity extra field',
      (value) => {
        value.installedEvidence.identity.artifactBytes = 100;
      },
      /exact path-free hash\/version\/commit\/tree shape/i
    ]
  ]) {
    const fixture = structuredClone(valid);
    mutate(fixture);
    const result = browserFindings(fixture).join('\n');
    assert.match(result, pattern, name);
    assert.match(result, /public semantic replay is not implemented/i, name);
  }

  assert.match(
    browserFindings(valid, { ...finalSource, testedTreeSha: 'e'.repeat(40) }).join('\n'),
    /does not match the authoritative tested commit ancestry, tree, harness, lockfile, stable fingerprints/i
  );

  for (const [name, changedPaths] of [
    ['missing computed delta', undefined],
    ['empty delta', []],
    ['unrelated mutable evidence', ['docs/evidence/browser-validation.json', 'docs/evidence/performance-results.json']],
    ['cross-root delete and add', ['docs/evidence/browser-validation.json', 'tests/browser/installed/executor.mjs']]
  ]) {
    assert.match(
      browserFindings(valid, { ...finalSource, changedPaths }).join('\n'),
      /exact browser-evidence-only final delta/i,
      name
    );
  }
});

test('legacy full bindings and every tracked path, aggregate, record, raw, or base64 field are rejected', () => {
  const legacyEmpty = browserEvidence({
    schema: 'sitewipe.installed-browser-publication-binding.v1',
    status: 'not_run'
  });
  assert.match(browserFindings(legacyEmpty).join('\n'), /legacy or unknown public commitment schema/i);

  const legacy = browserEvidence({
    schema: 'sitewipe.installed-browser-publication-binding.v1',
    status: 'not_run',
    plan: null,
    planSha256: null,
    aggregate: null,
    aggregateSha256: null,
    resultSetSha256: null,
    sourceProvenance: null
  });
  assert.match(browserFindings(legacy).join('\n'), /must not contain plans, aggregates, result records/i);

  for (const [name, key, value] of [
    ['plan', 'plan', {}],
    ['aggregate', 'aggregate', {}],
    ['result records', 'resultRecords', []],
    ['raw evidence', 'rawEvidence', {}],
    ['base64', 'contentBase64', 'AA=='],
    ['artifact path', 'artifactPath', 'C:\\private\\artifact.zip'],
    ['workspace root', 'workspaceRoot', 'C:\\private\\run']
  ]) {
    const fixture = browserEvidence(privateInstalledCommitment());
    fixture.installedEvidence[key] = value;
    assert.match(browserFindings(fixture).join('\n'), /must not contain plans, aggregates, result records/i, name);
  }

  const unknown = browserEvidence(privateInstalledCommitment());
  unknown.installedEvidence.verified = true;
  assert.match(browserFindings(unknown).join('\n'), /differs from the exact digest-only public schema/i);
});

test('the complete tracked browser record is exact-schema and recursively privacy safe', async () => {
  const current = JSON.parse(await readFile('docs/evidence/browser-validation.json', 'utf8'));
  assert.deepEqual(findTrackedBrowserEvidencePrivacyFindings(current), []);

  const valid = browserEvidence(emptyInstalledCommitment());
  assert.deepEqual(findTrackedBrowserEvidencePrivacyFindings(valid), []);

  for (const [name, mutate, pattern] of [
    [
      'top-level extra',
      (value) => {
        value.privateRun = null;
      },
      /exact top-level publication schema/i
    ],
    [
      'Chrome assertion absolute path',
      (value) => {
        value.chrome.assertions[0].artifactPath = 'C:\\Users\\private\\artifact.zip';
      },
      /chrome\.assertions\.0\.artifactPath/i
    ],
    [
      'Brave assertion raw evidence',
      (value) => {
        value.brave.assertions[0].rawEvidence = { result: 'passed' };
      },
      /brave\.assertions\.0\.rawEvidence/i
    ],
    [
      'synthetic assertion base64 evidence',
      (value) => {
        value.syntheticInAppBrowser.assertions.push({ evidenceBase64: 'AA==' });
      },
      /syntheticInAppBrowser\.assertions\.0\.evidenceBase64/i
    ],
    [
      'base64 value hidden in an allowed statement field',
      (value) => {
        value.limitations[0] = Buffer.from('C:\\Users\\private\\browser-run.json', 'utf8').toString('base64');
      },
      /limitations\.0/i
    ],
    [
      'nested file URI',
      (value) => {
        value.installedEvidence.identity = { receipt: 'file:///C:/private/run.json' };
      },
      /installedEvidence\.identity\.receipt/i
    ],
    [
      'nested unapproved directory field',
      (value) => {
        value.priorCandidateObservation.captureDirectory = 'validation-output/private';
      },
      /priorCandidateObservation\.captureDirectory/i
    ],
    [
      'non-null automation attempt',
      (value) => {
        value.automationAttempt = { status: 'not_run' };
      },
      /automationAttempt must be exactly null/i
    ]
  ]) {
    const fixture = structuredClone(valid);
    mutate(fixture);
    assert.match(findTrackedBrowserEvidencePrivacyFindings(fixture).join('\n'), pattern, name);
  }

  for (const record of [
    '../private.json',
    'browser\\sitewipe-1.11.61-chrome-expiry-failure.json',
    'browser/unreviewed.json',
    '/tmp/private.json'
  ]) {
    const fixture = structuredClone(valid);
    fixture.priorExactArtifactEvidence.record = record;
    assert.match(
      findTrackedBrowserEvidencePrivacyFindings(fixture).join('\n'),
      /approved normalized repository-relative historical record/i,
      record
    );
  }
});

test('synthetic in-app Browser assertions use an exact path-free semantic schema', () => {
  const valid = browserEvidence(emptyInstalledCommitment());
  valid.syntheticInAppBrowser.status = 'passed';
  valid.syntheticInAppBrowser.attemptedAt = '2026-08-24T23:00:00.000Z';
  valid.syntheticInAppBrowser.assertions = [syntheticBrowserAssertion()];
  assert.deepEqual(findTrackedBrowserEvidencePrivacyFindings(valid), []);

  for (const [name, mutate, pattern] of [
    [
      'status laundering',
      (value) => {
        value.syntheticInAppBrowser.assertions[0].checks.focus = 'failed';
      },
      /status launders or contradicts/i
    ],
    [
      'section status laundering',
      (value) => {
        const assertion = value.syntheticInAppBrowser.assertions[0];
        assertion.status = 'failed';
        assertion.checks.focus = 'failed';
      },
      /section status launders or contradicts/i
    ],
    [
      'unknown overall status',
      (value) => {
        value.syntheticInAppBrowser.assertions[0].status = 'pending';
      },
      /unknown overall or semantic-check status/i
    ],
    [
      'unknown semantic check',
      (value) => {
        value.syntheticInAppBrowser.assertions[0].checks.network = 'passed';
      },
      /exact semantic-check schema/i
    ],
    [
      'malformed screenshot hash',
      (value) => {
        value.syntheticInAppBrowser.assertions[0].screenshotSha256 = 'not-a-hash';
      },
      /screenshot and sanitized-DOM SHA-256 digests/i
    ],
    [
      'malformed viewport dimension',
      (value) => {
        value.syntheticInAppBrowser.assertions[0].viewport.width = 0;
      },
      /malformed bounded viewport/i
    ],
    [
      'unknown surface',
      (value) => {
        value.syntheticInAppBrowser.assertions[0].surface = 'browser';
      },
      /unknown extension surface/i
    ],
    [
      'non-boolean mode flag',
      (value) => {
        value.syntheticInAppBrowser.assertions[0].modes.forcedColors = 'off';
      },
      /malformed exact synthetic mode flags/i
    ],
    [
      'fixture path leakage',
      (value) => {
        value.syntheticInAppBrowser.assertions[0].fixture = 'C:\\Users\\private\\fixture.html';
      },
      /syntheticInAppBrowser\.assertions\.0\.fixture/i
    ],
    [
      'duplicate assertion id',
      (value) => {
        value.syntheticInAppBrowser.assertions.push(structuredClone(value.syntheticInAppBrowser.assertions[0]));
      },
      /unique normalized public id/i
    ]
  ]) {
    const fixture = structuredClone(valid);
    mutate(fixture);
    assert.match(findTrackedBrowserEvidencePrivacyFindings(fixture).join('\n'), pattern, name);
  }

  for (const [status, checkStatus] of [
    ['failed', 'failed'],
    ['limited', 'limited'],
    ['not_run', 'not_run']
  ]) {
    const fixture = structuredClone(valid);
    const assertion = fixture.syntheticInAppBrowser.assertions[0];
    fixture.syntheticInAppBrowser.status = status;
    assertion.status = status;
    for (const key of Object.keys(assertion.checks)) assertion.checks[key] = checkStatus;
    assert.deepEqual(findTrackedBrowserEvidencePrivacyFindings(fixture), [], status);
  }
});

test('performance evidence rejects malformed fixtures, samples, summaries, and artifact bindings', () => {
  const valid = performanceEvidence();
  assert.deepEqual(findPerformanceEvidenceFindings({ performance: valid, runtimeArtifactSha256: artifactSha256 }), []);

  for (const [name, mutate, pattern] of [
    [
      'non-object fixture',
      (value) => {
        value.fixtures[0] = 'passed';
      },
      /result object/
    ],
    [
      'failed sample',
      (value) => {
        value.fixtures[0].samples[0].status = 'failed';
      },
      /sample 1 is not passed/
    ],
    [
      'sample count mismatch',
      (value) => {
        value.fixtures[0].sampleCount = 3;
      },
      /do not match sampleCount/
    ],
    [
      'tampered summary',
      (value) => {
        value.fixtures[0].summary.p95Ms = 999;
      },
      /summary does not match/
    ],
    [
      'stale fixture artifact',
      (value) => {
        value.fixtures[0].artifactSha256 = 'C'.repeat(64);
      },
      /current runtime artifact/
    ],
    [
      'invalid phase timing',
      (value) => {
        value.fixtures[0].samples[0].phaseTimingsMs.cleanup = -1;
      },
      /invalid phaseTimingsMs/
    ]
  ]) {
    const fixture = structuredClone(valid);
    mutate(fixture);
    assert.match(
      findPerformanceEvidenceFindings({ performance: fixture, runtimeArtifactSha256: artifactSha256 }).join('\n'),
      pattern,
      name
    );
  }
});

test('media evidence binds counts, objects, required assets, exact files, and every captured item', async () => {
  const { media, root, readAssetBytes } = mediaEvidence();
  assert.deepEqual(
    await findMediaEvidenceFindings({ media, root, runtimeArtifactSha256: artifactSha256, readAssetBytes }),
    []
  );

  for (const [name, mutate, pattern] of [
    [
      'count differs from objects',
      (value) => {
        value.authenticScreenshotCount = 5;
      },
      /equal the number of screenshot objects/
    ],
    [
      'demo is a scalar',
      (value) => {
        value.demo = 'demo.mp4';
      },
      /demo must be an object/
    ],
    [
      'required promotional asset missing',
      (value) => {
        value.storeAssets.promotionalTile440x280 = null;
      },
      /promotional tile must be an integrity-bound asset object/
    ],
    [
      'per-item hash differs',
      (value) => {
        value.screenshots[0].sha256 = 'C'.repeat(64);
      },
      /does not match its retained bytes/
    ],
    [
      'per-item artifact differs',
      (value) => {
        value.demo.artifactSha256 = 'C'.repeat(64);
      },
      /demo is not bound to the current runtime artifact/
    ],
    [
      'store screenshot set differs',
      (value) => {
        value.storeAssets.screenshots1280x800[0].path = 'media/not-approved.png';
      },
      /do not match the approved authentic screenshot set/
    ],
    [
      'required icon is not an object',
      (value) => {
        value.storeAssets.icon128 = 'src/assets/icons/icon128.png';
      },
      /icon128 must be an integrity-bound asset object/
    ]
  ]) {
    const fixture = structuredClone(media);
    mutate(fixture);
    assert.match(
      (
        await findMediaEvidenceFindings({
          media: fixture,
          root,
          runtimeArtifactSha256: artifactSha256,
          readAssetBytes
        })
      ).join('\n'),
      pattern,
      name
    );
  }
});

test('remote publication requires exact version authorization and current privacy bytes and review date', () => {
  const privacyBytes = Buffer.from('# Privacy Policy\n\nSiteWipe `2.0.1`.\n\nLast reviewed: 2026-08-21.\n', 'utf8');
  const valid = {
    approvedPublicCandidateVersion: '2.0.1',
    publicCandidateSourcePushAuthorized: true,
    approvedPublicCandidateBranch: 'candidate/sitewipe-2.0.1',
    publicCandidatePullRequestAuthorized: true,
    finalPublicationApproval: false,
    mergeToDefaultBranchAuthorized: false,
    tagCreationAuthorized: false,
    githubReleaseAuthorized: false,
    browserStoreSubmissionAuthorized: false,
    promotionalPublicationAuthorized: false,
    hostedPrivacyPolicyUrl: 'https://example.invalid/privacy',
    hostedPrivacyPolicyRawUrl: 'https://example.invalid/privacy/raw/immutable',
    hostedPrivacyPolicyVersion: '2.0.1',
    hostedPrivacyPolicySha256: sha256(privacyBytes),
    hostedPrivacyPolicyExactByteParity: true,
    hostedPrivacyPolicyReviewedAt: '2026-08-21'
  };
  assert.deepEqual(findRemotePublicationFindings({ remote: valid, version: '2.0.1', privacyBytes }), []);

  for (const [name, field, value, pattern] of [
    ['approved version', 'approvedPublicCandidateVersion', '2.0.0', /exact current package version/],
    ['source push authorization', 'publicCandidateSourcePushAuthorized', false, /not authorized/],
    ['candidate branch', 'approvedPublicCandidateBranch', 'candidate/sitewipe-2.0.0', /branch and pull request/],
    ['pull request authorization', 'publicCandidatePullRequestAuthorized', false, /branch and pull request/],
    ['merge boundary', 'mergeToDefaultBranchAuthorized', true, /no-merge/],
    ['tag boundary', 'tagCreationAuthorized', true, /no-merge/],
    ['release boundary', 'githubReleaseAuthorized', true, /no-merge/],
    ['store boundary', 'browserStoreSubmissionAuthorized', true, /no-merge/],
    ['promotion boundary', 'promotionalPublicationAuthorized', true, /no-merge/],
    ['hosted policy version', 'hostedPrivacyPolicyVersion', '2.0.0', /not byte-bound/],
    ['hosted policy hash', 'hostedPrivacyPolicySha256', 'C'.repeat(64), /not byte-bound/],
    ['hosted policy parity', 'hostedPrivacyPolicyExactByteParity', false, /not byte-bound/],
    ['hosted policy date', 'hostedPrivacyPolicyReviewedAt', '2026-08-20', /review date/]
  ]) {
    const fixture = { ...valid, [field]: value };
    assert.match(
      findRemotePublicationFindings({ remote: fixture, version: '2.0.1', privacyBytes }).join('\n'),
      pattern,
      name
    );
  }
});

test('accessibility source evidence requires a current review and exact stable-input binding', () => {
  const valid = {
    reviewedAt: '2026-08-21',
    sourceContracts: {
      status: 'passed',
      reviewedAt: '2026-08-21',
      binding: {
        version: '2.0.1',
        releaseInputFingerprintSha256
      },
      namedTests: 6,
      coverage: ['keyboard and labels']
    }
  };
  assert.deepEqual(
    findAccessibilitySourceContractFindings({
      accessibility: valid,
      version: '2.0.1',
      releaseInputFingerprintSha256
    }),
    []
  );

  for (const [name, mutate, pattern] of [
    [
      'missing review date',
      (value) => {
        value.reviewedAt = null;
      },
      /no current review date/
    ],
    [
      'pending source status',
      (value) => {
        value.sourceContracts.status = 'pending';
      },
      /source-contract results are incomplete/
    ],
    [
      'stale source version',
      (value) => {
        value.sourceContracts.binding.version = '2.0.0';
      },
      /not bound to the current stable release inputs/
    ],
    [
      'stale source fingerprint',
      (value) => {
        value.sourceContracts.binding.releaseInputFingerprintSha256 = 'C'.repeat(64);
      },
      /not bound to the current stable release inputs/
    ]
  ]) {
    const fixture = structuredClone(valid);
    mutate(fixture);
    assert.match(
      findAccessibilitySourceContractFindings({
        accessibility: fixture,
        version: '2.0.1',
        releaseInputFingerprintSha256
      }).join('\n'),
      pattern,
      name
    );
  }
});

test('dependency publication evidence cannot reuse a prior audit or SBOM', () => {
  const valid = {
    status: 'technical_inventory_complete_owner_acknowledged',
    candidateVersion: '2.0.1',
    inventoriedAt: '2026-08-21',
    lastAuditAt: '2026-08-21',
    npmAuditVulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
    developmentSbom: {
      status: 'passed',
      componentVersion: '2.0.1',
      components: 300,
      dependencyNodes: 350,
      bytes: 1000,
      sha256: 'C'.repeat(64),
      generatedAt: '2026-08-21T20:00:00.000Z'
    }
  };
  assert.deepEqual(findDependencyCandidateAuditFindings({ inventory: valid, version: '2.0.1' }), []);

  for (const [name, mutate, pattern] of [
    [
      'pending status',
      (value) => {
        value.status = 'pending_current_candidate_audit';
      },
      /not complete for the exact current candidate/
    ],
    [
      'stale candidate version',
      (value) => {
        value.candidateVersion = '2.0.0';
      },
      /not complete for the exact current candidate/
    ],
    [
      'missing audit result',
      (value) => {
        value.npmAuditVulnerabilities.total = null;
      },
      /does not record zero vulnerabilities/
    ],
    [
      'stale SBOM version',
      (value) => {
        value.developmentSbom.componentVersion = '2.0.0';
      },
      /not regenerated/
    ],
    [
      'pending SBOM status',
      (value) => {
        value.developmentSbom.status = 'pending';
      },
      /not regenerated/
    ]
  ]) {
    const fixture = structuredClone(valid);
    mutate(fixture);
    assert.match(
      findDependencyCandidateAuditFindings({ inventory: fixture, version: '2.0.1' }).join('\n'),
      pattern,
      name
    );
  }
});

function browserEvidence(installedEvidence) {
  const assertion = (id) => ({
    id,
    status: 'passed',
    observedAt: '2026-08-21T20:00:00.000Z',
    artifactSha256,
    matrixCoverage: [...CANONICAL_BROWSER_MATRIX_IDS]
  });
  return {
    schemaVersion: 1,
    status: 'complete',
    attemptedAt: '2026-08-21T20:00:00.000Z',
    artifact: {
      version: '1.11.77',
      runtimeZip: 'sitewipe-unreleased-candidate-1.11.77.zip',
      sha256: artifactSha256
    },
    priorExactArtifactEvidence: {
      version: '1.11.62',
      record: 'browser/sitewipe-1.11.62-chrome-target-partition-scope-failure.json',
      historicalPathNote: 'An exact historical failure record retained for audit context.',
      status: 'historical_failed_not_current',
      runtimeZipSha256: '1'.repeat(64)
    },
    olderExactArtifactEvidence: {
      version: '1.11.61',
      record: 'browser/sitewipe-1.11.61-chrome-expiry-failure.json',
      historicalPathNote: 'An older exact historical failure record retained for audit context.',
      status: 'historical_failed_not_current',
      runtimeZipSha256: '2'.repeat(64)
    },
    earlierExactArtifactEvidence: {
      version: '1.11.57',
      record: 'browser-validation-2026-08-22-v1.11.57.json',
      status: 'historical_failed_not_current'
    },
    priorCandidateObservation: {
      version: '1.11.56',
      artifactSha256: '3'.repeat(64),
      status: 'historical_prior_candidate_not_current',
      claimsReboundToCurrentArtifact: false,
      note: 'Earlier observations are not current-artifact evidence.'
    },
    matrixVersion: BROWSER_MATRIX_VERSION,
    matrixSha256: CANONICAL_BROWSER_MATRIX_SHA256,
    requiredMatrix: [...CANONICAL_BROWSER_MATRIX_IDS],
    chrome: {
      status: 'passed',
      version: '151.0.0.0',
      operatingSystem: 'Windows',
      disposableProfile: true,
      assertions: [assertion('chrome-matrix')]
    },
    brave: {
      status: 'passed',
      version: '1.0.0.0',
      operatingSystem: 'Windows',
      disposableProfile: true,
      assertions: [assertion('brave-matrix')]
    },
    syntheticInAppBrowser: {
      status: 'pending',
      attemptedAt: null,
      environment: 'ChatGPT in-app Browser',
      fixture: 'HTTP-served UI with synthetic APIs',
      assertions: [],
      qualifiesAsInstalledExtensionEvidence: false,
      limitations: ['Does not establish installed-extension behavior.']
    },
    automationAttempt: null,
    installedEvidence: structuredClone(installedEvidence),
    deferredBinaryPublicationMatrix: ['Installed-browser execution remains required.'],
    limitations: ['Public evidence is path-free.'],
    reviewerApproval: false
  };
}

function browserFindings(browser, finalSourceOverride = finalSource) {
  return findBrowserEvidenceFindings({
    browser,
    runtimeArtifactSha256: artifactSha256,
    runtimeFingerprintSha256,
    releaseInputFingerprintSha256,
    finalSource: finalSourceOverride
  });
}

function emptyInstalledCommitment() {
  return {
    schema: BROWSER_PUBLICATION_BINDING_SCHEMA,
    status: BROWSER_PUBLICATION_NOT_RUN_STATUS
  };
}

function privateInstalledCommitment() {
  return {
    schema: BROWSER_PUBLICATION_BINDING_SCHEMA,
    status: BROWSER_PRIVATE_EVIDENCE_RETAINED_STATUS,
    runId: `sitewipe-browser-${'a'.repeat(32)}`,
    matrixVersion: BROWSER_MATRIX_VERSION,
    matrixSha256: CANONICAL_BROWSER_MATRIX_SHA256,
    requiredMatrixIds: [...CANONICAL_BROWSER_MATRIX_IDS],
    executionPlanSha256: '4'.repeat(64),
    identity: {
      sourceCommitSha: 'a'.repeat(40),
      sourceTreeSha: 'b'.repeat(40),
      artifactVersion: '1.11.77',
      artifactSha256,
      gitExecutableSha256: '9'.repeat(64),
      harnessManifestSha256: '8'.repeat(64),
      nativeHelperSha256: '7'.repeat(64),
      nodeExecutableSha256: '6'.repeat(64),
      packageLockSha256: '5'.repeat(64),
      releaseInputFingerprintSha256,
      runtimeFingerprintSha256
    },
    aggregateSha256: '3'.repeat(64),
    resultSetSha256: '2'.repeat(64),
    resultRecordCount: CANONICAL_BROWSER_MATRIX_IDS.length * 2,
    completedAt: '2026-08-24T22:00:00.000Z',
    privateEvidenceRetained: true,
    publicSemanticReplay: BROWSER_PUBLIC_SEMANTIC_REPLAY
  };
}

function syntheticBrowserAssertion() {
  return {
    id: 'popup-standard-compact-default',
    surface: 'popup',
    fixture: 'synthetic browser API fixture',
    state: 'standard compact review',
    observedAt: '2026-08-24T23:00:00.000Z',
    viewport: { width: 400, height: 640, zoomPercent: 100 },
    modes: {
      cleanupMode: 'standard',
      colorScheme: 'dark',
      directCleanup: false,
      forcedColors: false,
      privateAccess: false,
      reducedMotion: false
    },
    checks: {
      accessibleNames: 'passed',
      focus: 'passed',
      forcedColors: 'passed',
      liveRegions: 'passed',
      overflow: 'passed',
      reducedMotion: 'passed',
      scroll: 'passed',
      wrapping: 'passed'
    },
    screenshotSha256: 'D'.repeat(64),
    domSha256: 'E'.repeat(64),
    status: 'passed'
  };
}

function performanceEvidence() {
  return {
    fixtures: [
      {
        id: 'chrome-small',
        status: 'passed',
        browser: 'Chrome 151',
        scale: 'small',
        observedAt: '2026-08-21T20:00:00.000Z',
        artifactSha256,
        sampleCount: 2,
        samples: [
          { id: 'run-1', status: 'passed', totalDurationMs: 10, phaseTimingsMs: { cleanup: 8 } },
          { id: 'run-2', status: 'passed', totalDurationMs: 20, phaseTimingsMs: { cleanup: 18 } }
        ],
        summary: { medianMs: 15, p95Ms: 20, maximumMs: 20 }
      }
    ]
  };
}

function mediaEvidence() {
  const root = resolve('C:/sitewipe-media-fixture');
  const bytesByPath = new Map();
  const makeAsset = (path, width, height, extra = {}) => {
    const bytes = Buffer.from(`fixture bytes for ${path}`, 'utf8');
    bytesByPath.set(resolve(root, path), bytes);
    return { path, width, height, bytes: bytes.length, sha256: sha256(bytes), ...extra };
  };
  const screenshots = Array.from({ length: 4 }, (_, index) =>
    makeAsset(`media/screenshot-${index + 1}.png`, 1280, 800, {
      artifactSha256,
      capturedAt: '2026-08-21T20:00:00.000Z'
    })
  );
  const demo = makeAsset('media/demo.mp4', 1920, 1080, {
    artifactSha256,
    capturedAt: '2026-08-21T20:00:00.000Z',
    durationSeconds: 75
  });
  return {
    root,
    readAssetBytes: async (path) => {
      const value = bytesByPath.get(path);
      if (!value) throw new Error('missing');
      return value;
    },
    media: {
      authenticScreenshotCount: 4,
      demoDurationSeconds: 75,
      screenshots,
      demo,
      storeAssets: {
        icon128: makeAsset('media/icon128.png', 128, 128),
        screenshots1280x800: structuredClone(screenshots),
        promotionalTile440x280: makeAsset('media/promo.png', 440, 280),
        marquee1400x560: makeAsset('media/marquee.png', 1400, 560),
        githubSocialPreview: makeAsset('media/social.png', 1280, 640)
      }
    }
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

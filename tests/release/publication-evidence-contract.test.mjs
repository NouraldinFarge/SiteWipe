import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';

import {
  BROWSER_MATRIX_VERSION,
  CANONICAL_BROWSER_MATRIX,
  CANONICAL_BROWSER_MATRIX_IDS,
  CANONICAL_BROWSER_MATRIX_SHA256,
  REQUIRED_BROWSERS
} from '../browser/installed/canonical-matrix.mjs';

import {
  BROWSER_PRIVATE_EVIDENCE_RETAINED_STATUS,
  BROWSER_PUBLICATION_BINDING_SCHEMA,
  BROWSER_PUBLICATION_NOT_RUN_STATUS,
  BROWSER_PUBLIC_SEMANTIC_REPLAY,
  findAccessibilitySourceContractFindings,
  findAutomatedDependencyProtocolFindings,
  findBrowserEvidenceFindings,
  findDependencyCandidateAuditFindings,
  findMediaEvidenceFindings,
  findPerformanceEvidenceFindings,
  findRemotePublicationFindings,
  findTrackedBrowserEvidencePrivacyFindings
} from '../../scripts/publication-evidence-contract.mjs';
import { BROWSER_SEMANTIC_RECEIPTS_SCHEMA } from '../../scripts/browser-semantic-receipts.mjs';
import {
  SEMANTIC_IMPLEMENTED_ASSERTION_COUNT,
  SEMANTIC_NOT_IMPLEMENTED_ASSERTION_COUNT
} from '../browser/installed/evidence-contract.mjs';
import {
  SEMANTIC_VALIDATOR_MANIFEST_SHA256,
  semanticScenarioImplementationStatus
} from '../browser/installed/semantic-validator.mjs';

const artifactSha256 = 'A'.repeat(64);
const mediaArtifactVersion = '1.11.77';
const releaseInputFingerprintSha256 = 'B'.repeat(64);
const runtimeFingerprintSha256 = 'C'.repeat(64);
const finalizedChangedPaths = Object.freeze([
  'docs/evidence/accessibility-results.json',
  'docs/evidence/browser-semantic-receipts.json',
  'docs/evidence/browser-validation.json',
  'docs/evidence/evidence-finalization-manifest.json',
  'docs/evidence/media-inventory.json',
  'docs/evidence/performance-results.json'
]);
const finalSource = Object.freeze({
  commitSha: 'c'.repeat(40),
  treeSha: 'd'.repeat(40),
  testedCommitIsAncestor: true,
  testedTreeSha: 'b'.repeat(40),
  testedHarnessManifestSha256: '8'.repeat(64),
  testedPackageLockSha256: '5'.repeat(64),
  testedRuntimeFingerprintSha256: runtimeFingerprintSha256,
  testedReleaseInputFingerprintSha256: releaseInputFingerprintSha256,
  evidenceFinalizationValidated: true,
  evidenceFinalizationChangedPaths: finalizedChangedPaths,
  changedPaths: finalizedChangedPaths
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

test('a valid path-free receipt exactly binds the private-run commitment without laundering not-run cells', () => {
  const valid = browserEvidence(privateInstalledCommitment());
  assert.deepEqual(browserFindings(valid), [
    'The path-free browser semantic receipt replay is not_run; every canonical Chrome and Brave cell must pass.'
  ]);
  assert.equal(valid.installedEvidence.publicSemanticReplay, BROWSER_PUBLIC_SEMANTIC_REPLAY);
  assert.notEqual(BROWSER_PUBLIC_SEMANTIC_REPLAY, 'not_implemented');
  assert.equal('plan' in valid.installedEvidence, false);
  assert.equal('aggregate' in valid.installedEvidence, false);
  assert.equal('resultRecords' in valid.installedEvidence, false);
  assert.equal('sourceProvenance' in valid.installedEvidence, false);
});

test('missing, malformed, stale, or cross-run semantic receipts fail closed', () => {
  const valid = browserEvidence(privateInstalledCommitment());
  assert.match(
    browserFindings(valid, finalSource, null).join('\n'),
    /browser-semantic-receipts\.json is missing or invalid/i
  );

  for (const [name, mutate, pattern] of [
    [
      'aggregate commitment',
      (value) => {
        value.aggregateSha256 = 'D'.repeat(64);
      },
      /does not exactly bind every retained private-run commitment/i
    ],
    [
      'completion commitment',
      (value) => {
        value.completedAt = '2026-08-24T22:00:01.000Z';
      },
      /does not exactly bind every retained private-run commitment/i
    ],
    [
      'identity commitment',
      (value) => {
        value.identity.launchPolicySha256 = 'D'.repeat(64);
      },
      /does not exactly bind every retained private-run commitment/i
    ],
    [
      'private path',
      (value) => {
        value.runId = 'C:\\Users\\private\\run';
      },
      /missing or invalid/i
    ]
  ]) {
    const receipt = semanticReceipt(valid.installedEvidence);
    mutate(receipt);
    assert.match(browserFindings(valid, finalSource, receipt).join('\n'), pattern, name);
  }
});

test('private-run identity, matrix, completion, and semantic-receipt mutations block', () => {
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
      /path-free semantic replay contract/i
    ],
    [
      'artifact hash',
      (value) => {
        value.installedEvidence.identity.artifactSha256 = 'D'.repeat(64);
      },
      /stale for the current artifact/i
    ],
    [
      'node runtime version',
      (value) => {
        value.installedEvidence.identity.nodeRuntimeVersion = '24.18.0';
      },
      /malformed byte\/count\/hash, runtime\/toolchain version/i
    ],
    [
      'toolchain count',
      (value) => {
        value.installedEvidence.identity.toolchainFileCount = 0;
      },
      /malformed byte\/count\/hash, runtime\/toolchain version/i
    ],
    [
      'private toolchain manifest',
      (value) => {
        value.installedEvidence.identity.toolchainManifestSha256 = 'D'.repeat(64);
      },
      /exact path-free hash\/version\/commit\/tree shape/i
    ],
    [
      'identity extra field',
      (value) => {
        value.installedEvidence.identity.unexpectedIdentity = true;
      },
      /exact path-free hash\/version\/commit\/tree shape/i
    ]
  ]) {
    const fixture = structuredClone(valid);
    mutate(fixture);
    const result = browserFindings(fixture).join('\n');
    assert.match(result, pattern, name);
    assert.match(result, /semantic[- ]receipt/i, name);
  }

  assert.match(
    browserFindings(valid, { ...finalSource, testedTreeSha: 'e'.repeat(40) }).join('\n'),
    /does not match the authoritative tested commit ancestry, tree, harness, lockfile, stable fingerprints/i
  );

  assert.match(
    browserFindings(valid, { ...finalSource, evidenceFinalizationValidated: false }).join('\n'),
    /validated evidence-finalization-only final delta/i,
    'missing independent finalization validation'
  );

  for (const [name, changedPaths] of [
    ['missing computed delta', undefined],
    ['empty delta', []],
    ['unrelated mutable evidence', [...finalizedChangedPaths, 'README.md']],
    ['cross-root delete and add', [...finalizedChangedPaths, 'tests/browser/installed/executor.mjs']]
  ]) {
    assert.match(
      browserFindings(valid, { ...finalSource, changedPaths }).join('\n'),
      /validated evidence-finalization-only final delta/i,
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
  const fixtureSet = mediaEvidence();
  const { media } = fixtureSet;
  assert.deepEqual(await mediaFindings(fixtureSet), []);

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
        value.storeAssets.screenshots1280x800[0].path = 'docs/evidence/media/not-approved.png';
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
    assert.match((await mediaFindings(fixtureSet, fixture)).join('\n'), pattern, name);
  }
});

test('media evidence requires exact current role paths, artifact dates, sizes, and hashes', async (t) => {
  for (const [name, mutate, pattern] of [
    [
      'stale screenshot version',
      (media) => {
        media.screenshots[0].path = 'docs/evidence/media/sitewipe-1.11.76-screenshot-1.png';
      },
      /exact current versioned media path pattern/
    ],
    [
      'wrong demo role path',
      (media) => {
        media.demo.path = `docs/evidence/media/sitewipe-${mediaArtifactVersion}-walkthrough.mp4`;
      },
      /Authentic demo must use the exact current path/
    ],
    [
      'wrong stable icon path',
      (media) => {
        media.storeAssets.icon128.path = `docs/evidence/media/sitewipe-${mediaArtifactVersion}-icon128.png`;
      },
      /Store icon128 must use the exact current path src\/assets\/icons\/icon128\.png/
    ],
    [
      'promotional role substitution',
      (media) => {
        media.storeAssets.promotionalTile440x280.path = `docs/evidence/media/sitewipe-${mediaArtifactVersion}-marquee-1400x560.png`;
      },
      /Store promotional tile must use the exact current path/
    ],
    [
      'marquee role substitution',
      (media) => {
        media.storeAssets.marquee1400x560.path = `docs/evidence/media/sitewipe-${mediaArtifactVersion}-github-social-preview-1280x640.png`;
      },
      /Store marquee must use the exact current path/
    ],
    [
      'social-preview role substitution',
      (media) => {
        media.storeAssets.githubSocialPreview.path = `docs/evidence/media/sitewipe-${mediaArtifactVersion}-promotional-tile-440x280.png`;
      },
      /GitHub social preview must use the exact current path/
    ],
    [
      'missing capture date',
      (media) => {
        media.screenshots[0].capturedAt = null;
      },
      /Authentic screenshot 1 has no valid capture date/
    ],
    [
      'declared byte count lies',
      (media) => {
        media.demo.bytes += 1;
      },
      /Authentic demo does not match its retained bytes and SHA-256/
    ]
  ]) {
    await t.test(name, async () => {
      const fixture = mediaEvidence();
      const media = structuredClone(fixture.media);
      mutate(media);
      assert.match((await mediaFindings(fixture, media)).join('\n'), pattern);
    });
  }

  await t.test('artifactVersion is mandatory and exact', async () => {
    const fixture = mediaEvidence();
    assert.match(
      (await mediaFindings(fixture, fixture.media, { artifactVersion: undefined })).join('\n'),
      /missing the exact current artifact version/
    );
  });
});

test('media evidence parses PNG signatures, chunks, CRCs, and byte dimensions', async (t) => {
  const exactCompressedScanlines = deflateSync(Buffer.alloc((1280 + 1) * 800), { level: 9 });
  for (const [name, replacement, pattern] of [
    ['text disguised as PNG', Buffer.from('not a png', 'utf8'), /structurally valid bounded PNG container/],
    [
      'truncated PNG chunk',
      minimalPng(1280, 800).subarray(0, minimalPng(1280, 800).length - 1),
      /structurally valid bounded PNG container/
    ],
    ['duplicate IHDR', minimalPng(1280, 800, { duplicateIhdr: true }), /structurally valid bounded PNG container/],
    [
      'CRC-valid arbitrary IDAT payload',
      minimalPng(1280, 800, { imageData: Buffer.from('arbitrary', 'utf8') }),
      /structurally valid bounded PNG container/
    ],
    [
      'zlib stream with trailing garbage',
      minimalPng(1280, 800, { imageData: Buffer.concat([exactCompressedScanlines, Buffer.from([0xde, 0xad])]) }),
      /structurally valid bounded PNG container/
    ],
    [
      'concatenated zlib streams',
      minimalPng(1280, 800, { imageData: Buffer.concat([exactCompressedScanlines, exactCompressedScanlines]) }),
      /structurally valid bounded PNG container/
    ],
    [
      'unknown critical chunk',
      minimalPng(1280, 800, { beforeIdat: [{ type: 'ABCD' }] }),
      /structurally valid bounded PNG container/
    ],
    [
      'lowercase reserved chunk bit',
      minimalPng(1280, 800, { beforeIdat: [{ type: 'ABcD' }] }),
      /structurally valid bounded PNG container/
    ],
    [
      'PLTE forbidden for grayscale',
      minimalPng(1280, 800, { palette: Buffer.from([0, 0, 0]) }),
      /structurally valid bounded PNG container/
    ],
    [
      'indexed pixel beyond one-entry palette',
      minimalPng(1280, 800, {
        colorType: 3,
        palette: Buffer.from([0, 0, 0]),
        scanlineByte: 0xff
      }),
      /structurally valid bounded PNG container/
    ],
    [
      'tRNS after IDAT',
      minimalPng(1280, 800, { afterIdat: [{ data: Buffer.alloc(2), type: 'tRNS' }] }),
      /structurally valid bounded PNG container/
    ],
    ['dimension lie', minimalPng(1279, 800), /declared dimensions do not match dimensions parsed/]
  ]) {
    await t.test(name, async () => {
      const fixture = mediaEvidence();
      fixture.replacePathBytes(fixture.media.screenshots[0].path, replacement);
      assert.match((await mediaFindings(fixture)).join('\n'), pattern);
    });
  }

  await t.test('corrupt IHDR CRC is rejected', async () => {
    const fixture = mediaEvidence();
    const bytes = minimalPng(1280, 800);
    bytes[29] ^= 0xff;
    fixture.replacePathBytes(fixture.media.screenshots[0].path, bytes);
    assert.match((await mediaFindings(fixture)).join('\n'), /structurally valid bounded PNG container/);
  });

  await t.test('bounded indexed PNG pixels inside their exact palette are accepted', async () => {
    const fixture = mediaEvidence();
    fixture.replacePathBytes(
      fixture.media.screenshots[0].path,
      minimalPng(1280, 800, { colorType: 3, palette: Buffer.from([0, 0, 0]) })
    );
    assert.deepEqual(await mediaFindings(fixture), []);
  });
});

test('media evidence structurally binds MP4 boxes and samples without claiming playback authenticity', async (t) => {
  for (const [name, replacement, pattern] of [
    ['text disguised as MP4', Buffer.from('not an mp4', 'utf8'), /structurally valid bounded MP4 container/],
    [
      'video dimension lie',
      minimalMp4({ durationSeconds: 75, height: 1080, width: 1919 }),
      /declared dimensions do not match dimensions parsed/
    ],
    [
      'mvhd duration lie',
      minimalMp4({ durationSeconds: 74.5, height: 1080, width: 1920 }),
      /declared duration differs from its mvhd duration/
    ],
    [
      'zero mvhd duration',
      minimalMp4({ durationSeconds: 0, height: 1080, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'duplicate ftyp',
      minimalMp4({ durationSeconds: 75, duplicateFtyp: true, height: 1080, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'duplicate mvhd',
      minimalMp4({ durationSeconds: 75, duplicateMvhd: true, height: 1080, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'ambiguous video tracks',
      minimalMp4({ durationSeconds: 75, height: 1080, videoTrackCount: 2, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'validated video plus malformed non-video track',
      minimalMp4({ durationSeconds: 75, extraNonVideoTrack: true, height: 1080, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'header-only movie with empty mdat',
      headerOnlyMp4({ durationSeconds: 75, height: 1080, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'duplicate required stsd',
      minimalMp4({ durationSeconds: 75, duplicateStsd: true, height: 1080, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'missing vmhd',
      minimalMp4({ durationSeconds: 75, height: 1080, omitVmhd: true, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'missing self-contained dref',
      minimalMp4({ durationSeconds: 75, height: 1080, omitDref: true, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'avc1 data reference index lie',
      minimalMp4({ dataReferenceIndex: 2, durationSeconds: 75, height: 1080, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'missing avcC codec configuration',
      minimalMp4({ durationSeconds: 75, height: 1080, omitAvcConfiguration: true, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'chunk offset outside mdat payload',
      minimalMp4({ chunkOffsetAdjustment: -1, durationSeconds: 75, height: 1080, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'sample-size inventory exceeds mdat payload',
      minimalMp4({ durationSeconds: 75, height: 1080, sampleSizeAdjustment: 1, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'mdhd duration differs from mvhd',
      minimalMp4({ durationSeconds: 75, height: 1080, mediaDurationSeconds: 1, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'stts duration differs from mvhd and mdhd',
      minimalMp4({ durationSeconds: 75, height: 1080, sttsDurationSeconds: 1, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'tkhd zero duration',
      minimalMp4({ durationSeconds: 75, height: 1080, trackDurationSeconds: 0, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'tkhd zero track_ID',
      minimalMp4({ durationSeconds: 75, height: 1080, trackId: 0, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'mvhd nonzero full-box flags',
      minimalMp4({ durationSeconds: 75, height: 1080, movieHeaderFlags: 1, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'mdhd nonzero full-box flags',
      minimalMp4({ durationSeconds: 75, height: 1080, mediaHeaderFlags: 1, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'hdlr nonzero full-box flags',
      minimalMp4({ durationSeconds: 75, handlerFlags: 1, height: 1080, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'composition-time table',
      minimalMp4({ durationSeconds: 75, height: 1080, includeCompositionTime: true, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'misplaced elst outside edts',
      minimalMp4({ durationSeconds: 75, height: 1080, misplacedEditList: true, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'malformed edit list',
      minimalMp4({ durationSeconds: 75, editListMode: 'malformed', height: 1080, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'edit list duration lie',
      minimalMp4({ durationSeconds: 75, editListMode: 'duration-lie', height: 1080, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'AUD-only samples without VCL payload',
      minimalMp4({ durationSeconds: 75, height: 1080, sampleNalHeader: 0x09, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'one-byte VCL NAL payload',
      minimalMp4({ durationSeconds: 75, height: 1080, shortSampleNal: true, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'SPS forbidden_zero_bit',
      minimalMp4({ durationSeconds: 75, height: 1080, spsNalHeader: 0xe7, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'SPS zero nal_ref_idc',
      minimalMp4({ durationSeconds: 75, height: 1080, spsNalHeader: 0x07, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'one-byte SPS payload',
      minimalMp4({ durationSeconds: 75, height: 1080, shortSps: true, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'one-byte PPS payload',
      minimalMp4({ durationSeconds: 75, height: 1080, shortPps: true, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'two-byte SPS with fake RBSP',
      minimalMp4({ durationSeconds: 75, fakeSpsRbsp: true, height: 1080, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'avcC profile differs from SPS',
      minimalMp4({ configurationProfile: 77, durationSeconds: 75, height: 1080, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'two-byte PPS with fake RBSP',
      minimalMp4({ durationSeconds: 75, fakePpsRbsp: true, height: 1080, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'two-byte VCL with fake RBSP',
      minimalMp4({ durationSeconds: 75, height: 1080, sampleRbspByte: 0, width: 1920 }),
      /structurally valid bounded MP4 container/
    ],
    [
      'non-MP4 brand',
      minimalMp4({
        compatibleBrands: ['junk'],
        durationSeconds: 75,
        height: 1080,
        majorBrand: 'text',
        width: 1920
      }),
      /structurally valid bounded MP4 container/
    ]
  ]) {
    await t.test(name, async () => {
      const fixture = mediaEvidence();
      fixture.replacePathBytes(fixture.media.demo.path, replacement);
      assert.match((await mediaFindings(fixture)).join('\n'), pattern);
    });
  }

  await t.test('canonical movie, track, media, handler, and sample-entry fields reject mutations', async (t) => {
    for (const [name, option, mutation] of [
      ['mvhd unity rate', 'movieHeaderMutation', 'rate'],
      ['mvhd normal volume', 'movieHeaderMutation', 'volume'],
      ['mvhd reserved bytes', 'movieHeaderMutation', 'reserved'],
      ['mvhd identity matrix', 'movieHeaderMutation', 'matrix'],
      ['mvhd pre_defined bytes', 'movieHeaderMutation', 'pre-defined'],
      ['mvhd next_track_ID', 'movieHeaderMutation', 'next-track-id'],
      ['tkhd reserved after track_ID', 'trackHeaderMutation', 'reserved-id'],
      ['tkhd reserved after duration', 'trackHeaderMutation', 'reserved-duration'],
      ['tkhd video volume', 'trackHeaderMutation', 'volume'],
      ['tkhd reserved after volume', 'trackHeaderMutation', 'reserved-volume'],
      ['tkhd identity matrix', 'trackHeaderMutation', 'matrix'],
      ['mdhd zero language', 'mediaHeaderMutation', 'language-zero'],
      ['mdhd invalid packed language', 'mediaHeaderMutation', 'language-invalid'],
      ['mdhd pre_defined', 'mediaHeaderMutation', 'pre-defined'],
      ['hdlr pre_defined', 'handlerMutation', 'pre-defined'],
      ['hdlr reserved bytes', 'handlerMutation', 'reserved'],
      ['vmhd graphicsmode', 'videoMediaHeaderMutation', 'graphicsmode'],
      ['vmhd opcolor', 'videoMediaHeaderMutation', 'opcolor'],
      ['VisualSampleEntry base reserved', 'sampleEntryMutation', 'reserved-base'],
      ['VisualSampleEntry pre_defined', 'sampleEntryMutation', 'pre-defined'],
      ['VisualSampleEntry reserved', 'sampleEntryMutation', 'reserved'],
      ['VisualSampleEntry pre_defined array', 'sampleEntryMutation', 'pre-defined-array'],
      ['VisualSampleEntry horizontal resolution', 'sampleEntryMutation', 'horizontal-resolution'],
      ['VisualSampleEntry vertical resolution', 'sampleEntryMutation', 'vertical-resolution'],
      ['VisualSampleEntry frame reserved', 'sampleEntryMutation', 'reserved-frame'],
      ['VisualSampleEntry frame count', 'sampleEntryMutation', 'frame-count'],
      ['VisualSampleEntry compressor length', 'sampleEntryMutation', 'compressor-length'],
      ['VisualSampleEntry compressor padding', 'sampleEntryMutation', 'compressor-padding'],
      ['VisualSampleEntry depth', 'sampleEntryMutation', 'depth'],
      ['VisualSampleEntry final pre_defined', 'sampleEntryMutation', 'final-pre-defined']
    ]) {
      await t.test(name, async () => {
        const fixture = mediaEvidence();
        fixture.replacePathBytes(
          fixture.media.demo.path,
          minimalMp4({ durationSeconds: 75, height: 1080, [option]: mutation, width: 1920 })
        );
        assert.match((await mediaFindings(fixture)).join('\n'), /structurally valid bounded MP4 container/);
      });
    }
  });

  await t.test('box size escaping the retained bytes is rejected', async () => {
    const fixture = mediaEvidence();
    const bytes = minimalMp4({ durationSeconds: 75, height: 1080, width: 1920 });
    bytes.writeUInt32BE(bytes.length + 1, 0);
    fixture.replacePathBytes(fixture.media.demo.path, bytes);
    assert.match((await mediaFindings(fixture)).join('\n'), /structurally valid bounded MP4 container/);
  });

  await t.test('mvhd duration within the documented 0.1-second tolerance is accepted', async () => {
    const fixture = mediaEvidence();
    fixture.replacePathBytes(
      fixture.media.demo.path,
      minimalMp4({ durationSeconds: 75.05, height: 1080, width: 1920 })
    );
    assert.deepEqual(await mediaFindings(fixture), []);
  });

  await t.test('even a rate-1 duration-preserving edit list is rejected by the narrow profile', async () => {
    const fixture = mediaEvidence();
    fixture.replacePathBytes(
      fixture.media.demo.path,
      minimalMp4({ durationSeconds: 75, editListMode: 'valid', height: 1080, width: 1920 })
    );
    assert.match((await mediaFindings(fixture)).join('\n'), /structurally valid bounded MP4 container/);
  });
});

test('finalized media entries exactly equal and bind the referenced post-browser asset set', async (t) => {
  for (const [name, mutate, pattern] of [
    [
      'missing referenced entry',
      (entries, fixture) => {
        const path = fixture.media.screenshots[0].path;
        entries.splice(
          entries.findIndex((entry) => entry.path === path),
          1
        );
      },
      /must exactly equal the distinct current post-browser media references/
    ],
    [
      'wrong entry kind',
      (entries, fixture) => {
        entries.find((entry) => entry.path === fixture.media.demo.path).kind = 'browser';
      },
      /malformed or not exactly kind=media/
    ],
    [
      'entry digest drift',
      (entries, fixture) => {
        entries.find((entry) => entry.path === fixture.media.demo.path).sha256 = 'F'.repeat(64);
      },
      /differs from its exact finalization entry/
    ],
    [
      'duplicate entry',
      (entries, fixture) => {
        entries.push(structuredClone(entries.find((entry) => entry.path === fixture.media.demo.path)));
      },
      /duplicate or ambiguous paths/
    ],
    [
      'unreferenced optional asset',
      (entries) => {
        const bytes = minimalPng(1280, 800);
        entries.push({
          bytes: bytes.length,
          kind: 'media',
          path: `docs/evidence/media/sitewipe-${mediaArtifactVersion}-unreferenced.png`,
          sha256: sha256(bytes)
        });
      },
      /must exactly equal the distinct current post-browser media references/
    ],
    [
      'missing media inventory metadata entry',
      (entries) => {
        entries.splice(
          entries.findIndex((entry) => entry.path === 'docs/evidence/media-inventory.json'),
          1
        );
      },
      /exactly one media-inventory metadata record/
    ],
    [
      'stable icon incorrectly added to delta',
      (entries, fixture) => {
        entries.push({
          bytes: fixture.media.storeAssets.icon128.bytes,
          kind: 'media',
          path: 'src/assets/icons/icon128.png',
          sha256: fixture.media.storeAssets.icon128.sha256
        });
      },
      /outside the exact media metadata\/asset boundary/
    ]
  ]) {
    await t.test(name, async () => {
      const fixture = mediaEvidence();
      const entries = structuredClone(fixture.finalizedMediaEntries);
      mutate(entries, fixture);
      assert.match(
        (await mediaFindings(fixture, fixture.media, { finalizedMediaEntries: entries })).join('\n'),
        pattern
      );
    });
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

test('automated dependency evidence requires the exact install and low-threshold JSON audit protocol', () => {
  const valid = {
    dependencyInstall: {
      command: 'npm ci --ignore-scripts --no-audit --no-fund',
      status: 'passed',
      installedPackages: 397,
      auditedPackagesIncludingRoot: null,
      lifecycleScriptsDisabled: true
    },
    dependencyAudit: {
      command: 'npm audit --audit-level=low --json',
      status: 'passed',
      auditedAt: '2026-08-25T19:54:03.9929002-05:00',
      knownVulnerabilities: 0,
      runtimeDependencies: 0,
      lockedDevelopmentGraph: 416,
      vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 }
    }
  };
  assert.deepEqual(findAutomatedDependencyProtocolFindings({ automated: valid, lockedDevelopmentGraph: 416 }), []);

  for (const [name, mutate, pattern] of [
    [
      'short install command',
      (value) => {
        value.dependencyInstall.command = 'npm ci --ignore-scripts';
      },
      /exact locked no-script\/no-audit\/no-fund protocol/
    ],
    [
      'implicit install audit claim',
      (value) => {
        value.dependencyInstall.auditedPackagesIncludingRoot = 417;
      },
      /exact locked no-script\/no-audit\/no-fund protocol/
    ],
    [
      'moderate audit command',
      (value) => {
        value.dependencyAudit.command = 'npm audit --audit-level=moderate --json';
      },
      /exact low-threshold JSON protocol/
    ],
    [
      'missing audit timestamp',
      (value) => {
        value.dependencyAudit.auditedAt = null;
      },
      /exact low-threshold JSON protocol/
    ],
    [
      'hidden low-severity result',
      (value) => {
        value.dependencyAudit.vulnerabilities.low = 1;
      },
      /zero findings at every severity/
    ]
  ]) {
    const fixture = structuredClone(valid);
    mutate(fixture);
    assert.match(
      findAutomatedDependencyProtocolFindings({ automated: fixture, lockedDevelopmentGraph: 416 }).join('\n'),
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

function browserFindings(browser, finalSourceOverride = finalSource, semanticReceiptsOverride = undefined) {
  const semanticReceipts =
    semanticReceiptsOverride === undefined &&
    browser?.installedEvidence?.status === BROWSER_PRIVATE_EVIDENCE_RETAINED_STATUS
      ? semanticReceipt(browser.installedEvidence)
      : (semanticReceiptsOverride ?? null);
  return findBrowserEvidenceFindings({
    browser,
    semanticReceipts,
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
      artifactBytes: 1234,
      artifactSha256,
      browserRuntimeSetSha256: '0'.repeat(64),
      gitExecutableSha256: '9'.repeat(64),
      harnessManifestSha256: '8'.repeat(64),
      launchPolicySha256: '4'.repeat(64),
      nativeHelperSha256: '7'.repeat(64),
      nodeExecutableSha256: '6'.repeat(64),
      nodeRuntimeVersion: 'v24.18.0',
      packageLockSha256: '5'.repeat(64),
      powerShellExecutableSha256: 'E'.repeat(64),
      processObserverHelperSha256: 'F'.repeat(64),
      releaseInputFingerprintSha256,
      runtimeFingerprintSha256,
      toolchainBytes: 123456,
      toolchainFileCount: 321,
      toolchainPackageCount: 23,
      toolchainPuppeteerVersion: '25.8.0',
      toolchainSetSha256: '1'.repeat(64)
    },
    aggregateSha256: '3'.repeat(64),
    resultSetSha256: '2'.repeat(64),
    resultRecordCount: CANONICAL_BROWSER_MATRIX_IDS.length * 2,
    completedAt: '2026-08-24T22:00:00.000Z',
    privateEvidenceRetained: true,
    publicSemanticReplay: BROWSER_PUBLIC_SEMANTIC_REPLAY
  };
}

function semanticReceipt(binding) {
  const cells = [];
  let recordIndex = 0;
  for (const scenario of CANONICAL_BROWSER_MATRIX) {
    for (const browser of REQUIRED_BROWSERS) {
      cells.push({
        scenarioId: scenario.id,
        browser,
        state: 'not_run',
        implementationStatus: semanticScenarioImplementationStatus(scenario.id),
        resultRecordSha256: sha256(`record-${recordIndex}`),
        assertionCounts: {
          passed: 0,
          failed: 0,
          limited: 0,
          notRun: scenario.requiredAssertions.length,
          total: scenario.requiredAssertions.length
        }
      });
      recordIndex += 1;
    }
  }
  return {
    schema: BROWSER_SEMANTIC_RECEIPTS_SCHEMA,
    status: 'not_run',
    runId: binding.runId,
    completedAt: binding.completedAt,
    matrixVersion: binding.matrixVersion,
    matrixSha256: binding.matrixSha256,
    semanticValidatorManifestSha256: SEMANTIC_VALIDATOR_MANIFEST_SHA256,
    executionPlanSha256: binding.executionPlanSha256,
    aggregateSha256: binding.aggregateSha256,
    resultSetSha256: binding.resultSetSha256,
    resultRecordCount: binding.resultRecordCount,
    semanticValidatorCounts: {
      implemented: SEMANTIC_IMPLEMENTED_ASSERTION_COUNT,
      notImplemented: SEMANTIC_NOT_IMPLEMENTED_ASSERTION_COUNT,
      total: SEMANTIC_IMPLEMENTED_ASSERTION_COUNT + SEMANTIC_NOT_IMPLEMENTED_ASSERTION_COUNT
    },
    cells,
    browsers: REQUIRED_BROWSERS.map((browser) => ({
      browser,
      version: browser === 'brave' ? '151.1.93.138' : '151.0.7922.174',
      executableSha256: browser === 'brave' ? 'D'.repeat(64) : 'E'.repeat(64),
      runtimeManifestSha256: browser === 'brave' ? 'F'.repeat(64) : '0'.repeat(64),
      state: 'not_run',
      scenarioCounts: {
        passed: 0,
        failed: 0,
        limited: 0,
        notRun: CANONICAL_BROWSER_MATRIX.length,
        total: CANONICAL_BROWSER_MATRIX.length
      }
    })),
    identity: structuredClone(binding.identity),
    privateEvidenceRetained: binding.privateEvidenceRetained,
    publicSemanticReplay: binding.publicSemanticReplay,
    recordedByAutomation: true
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
  const bytesByAbsolutePath = new Map();
  const bytesByRepositoryPath = new Map();
  const makeAsset = (path, width, height, bytes, extra = {}) => {
    bytesByAbsolutePath.set(resolve(root, ...path.split('/')), bytes);
    bytesByRepositoryPath.set(path, bytes);
    return { path, width, height, bytes: bytes.length, sha256: sha256(bytes), ...extra };
  };
  const screenshots = Array.from({ length: 4 }, (_, index) =>
    makeAsset(
      `docs/evidence/media/sitewipe-${mediaArtifactVersion}-screenshot-${index + 1}.png`,
      1280,
      800,
      minimalPng(1280, 800),
      {
        artifactSha256,
        capturedAt: '2026-08-21T20:00:00.000Z'
      }
    )
  );
  const demo = makeAsset(
    `docs/evidence/media/sitewipe-${mediaArtifactVersion}-demo.mp4`,
    1920,
    1080,
    minimalMp4({ durationSeconds: 75, height: 1080, width: 1920 }),
    {
      artifactSha256,
      capturedAt: '2026-08-21T20:00:00.000Z',
      durationSeconds: 75
    }
  );
  const media = {
    authenticScreenshotCount: 4,
    demoDurationSeconds: 75,
    screenshots,
    demo,
    storeAssets: {
      icon128: makeAsset('src/assets/icons/icon128.png', 128, 128, minimalPng(128, 128)),
      screenshots1280x800: structuredClone(screenshots),
      promotionalTile440x280: makeAsset(
        `docs/evidence/media/sitewipe-${mediaArtifactVersion}-promotional-tile-440x280.png`,
        440,
        280,
        minimalPng(440, 280)
      ),
      marquee1400x560: makeAsset(
        `docs/evidence/media/sitewipe-${mediaArtifactVersion}-marquee-1400x560.png`,
        1400,
        560,
        minimalPng(1400, 560)
      ),
      githubSocialPreview: makeAsset(
        `docs/evidence/media/sitewipe-${mediaArtifactVersion}-github-social-preview-1280x640.png`,
        1280,
        640,
        minimalPng(1280, 640)
      )
    }
  };
  const inventoryBytes = Buffer.from('synthetic media inventory', 'utf8');
  const finalizedMediaEntries = [
    {
      bytes: inventoryBytes.length,
      kind: 'media',
      path: 'docs/evidence/media-inventory.json',
      sha256: sha256(inventoryBytes)
    },
    ...[...bytesByRepositoryPath.entries()]
      .filter(([path]) => path.startsWith('docs/evidence/media/'))
      .map(([path, bytes]) => ({ bytes: bytes.length, kind: 'media', path, sha256: sha256(bytes) }))
  ].sort((left, right) => left.path.localeCompare(right.path));
  const fixture = {
    root,
    readAssetBytes: async (path) => {
      const value = bytesByAbsolutePath.get(path);
      if (!value) throw new Error('missing');
      return value;
    },
    finalizedMediaEntries,
    media,
    replacePathBytes(path, bytes) {
      if (!bytesByRepositoryPath.has(path)) throw new Error(`Unknown synthetic media path: ${path}`);
      bytesByRepositoryPath.set(path, bytes);
      bytesByAbsolutePath.set(resolve(root, ...path.split('/')), bytes);
      updateMediaAssetsAtPath(media, path, bytes);
      const entry = finalizedMediaEntries.find((candidate) => candidate.path === path);
      if (entry) {
        entry.bytes = bytes.length;
        entry.sha256 = sha256(bytes);
      }
    }
  };
  return fixture;
}

function mediaFindings(fixture, media = fixture.media, overrides = {}) {
  return findMediaEvidenceFindings({
    artifactVersion: mediaArtifactVersion,
    finalizedMediaEntries: fixture.finalizedMediaEntries,
    media,
    readAssetBytes: fixture.readAssetBytes,
    root: fixture.root,
    runtimeArtifactSha256: artifactSha256,
    ...overrides
  });
}

function updateMediaAssetsAtPath(value, path, bytes) {
  if (!value || typeof value !== 'object') return;
  if (value.path === path) {
    value.bytes = bytes.length;
    value.sha256 = sha256(bytes);
  }
  for (const child of Object.values(value)) updateMediaAssetsAtPath(child, path, bytes);
}

function minimalPng(
  width,
  height,
  {
    afterIdat = [],
    beforeIdat = [],
    bitDepth = 8,
    colorType = 0,
    duplicateIhdr = false,
    imageData = null,
    palette = null,
    scanlineByte = 0
  } = {}
) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = bitDepth;
  header[9] = colorType;
  const channels = new Map([
    [0, 1],
    [2, 3],
    [3, 1],
    [4, 2],
    [6, 4]
  ]).get(colorType);
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8);
  const scanlines = Buffer.alloc((rowBytes + 1) * height);
  if (scanlineByte !== 0) {
    for (let row = 0; row < height; row += 1) {
      scanlines.fill(scanlineByte, row * (rowBytes + 1) + 1, (row + 1) * (rowBytes + 1));
    }
  }
  const chunks = [pngChunk('IHDR', header)];
  if (duplicateIhdr) chunks.push(pngChunk('IHDR', header));
  if (palette) chunks.push(pngChunk('PLTE', palette));
  chunks.push(
    ...beforeIdat.map(({ data = Buffer.alloc(0), type }) => pngChunk(type, data)),
    pngChunk('IDAT', imageData ?? deflateSync(scanlines, { level: 9 })),
    ...afterIdat.map(({ data = Buffer.alloc(0), type }) => pngChunk(type, data)),
    pngChunk('IEND', Buffer.alloc(0))
  );
  return Buffer.concat([signature, ...chunks]);
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

function minimalMp4({
  durationSeconds,
  height,
  width,
  chunkOffsetAdjustment = 0,
  configurationProfile = 66,
  dataReferenceIndex = 1,
  duplicateStsd = false,
  duplicateFtyp = false,
  duplicateMvhd = false,
  compatibleBrands = ['isom', 'mp42'],
  editListMode = 'none',
  extraNonVideoTrack = false,
  fakePpsRbsp = false,
  fakeSpsRbsp = false,
  handlerFlags = 0,
  handlerMutation = null,
  includeCompositionTime = false,
  majorBrand = 'isom',
  mediaHeaderFlags = 0,
  mediaHeaderMutation = null,
  mediaDurationSeconds = durationSeconds,
  misplacedEditList = false,
  movieHeaderFlags = 0,
  movieHeaderMutation = null,
  omitAvcConfiguration = false,
  omitDref = false,
  omitVmhd = false,
  sampleNalHeader = 0x65,
  sampleRbspByte = 0xbc,
  sampleEntryMutation = null,
  sampleSizeAdjustment = 0,
  shortPps = false,
  shortSampleNal = false,
  shortSps = false,
  spsNalHeader = 0x67,
  sttsDurationSeconds = durationSeconds,
  trackId = 1,
  trackHeaderMutation = null,
  trackDurationSeconds = durationSeconds,
  videoMediaHeaderMutation = null,
  videoTrackCount = 1
}) {
  const timescale = 1000;
  const sampleCount = 75;
  const nalPayload = Buffer.from(shortSampleNal ? [sampleNalHeader] : [sampleNalHeader, sampleRbspByte]);
  const nalLength = Buffer.alloc(4);
  nalLength.writeUInt32BE(nalPayload.length);
  const sample = Buffer.concat([nalLength, nalPayload]);
  const mediaPayload = Buffer.concat(Array.from({ length: sampleCount }, () => sample));
  const movieHeader = Buffer.alloc(100);
  movieHeader.writeUInt32BE(movieHeaderFlags, 0);
  movieHeader.writeUInt32BE(timescale, 12);
  movieHeader.writeUInt32BE(Math.round(durationSeconds * timescale), 16);
  movieHeader.writeUInt32BE(0x0001_0000, 20);
  movieHeader.writeUInt16BE(0x0100, 24);
  writeIdentityMatrix(movieHeader, 36);
  movieHeader.writeUInt32BE(trackId + 1, 96);
  mutateMovieHeader(movieHeader, movieHeaderMutation, trackId);
  const track = (chunkOffset) => {
    const trackHeader = Buffer.alloc(84);
    trackHeader.writeUInt32BE(3, 0);
    trackHeader.writeUInt32BE(trackId, 12);
    trackHeader.writeUInt32BE(Math.round(trackDurationSeconds * timescale), 20);
    writeIdentityMatrix(trackHeader, 40);
    trackHeader.writeUInt32BE(width * 65_536, 76);
    trackHeader.writeUInt32BE(height * 65_536, 80);
    mutateTrackHeader(trackHeader, trackHeaderMutation);
    const mediaHeader = Buffer.alloc(24);
    mediaHeader.writeUInt32BE(mediaHeaderFlags, 0);
    mediaHeader.writeUInt32BE(timescale, 12);
    mediaHeader.writeUInt32BE(Math.round(mediaDurationSeconds * timescale), 16);
    mediaHeader.writeUInt16BE(packIso639Language('und'), 20);
    mutateMediaHeader(mediaHeader, mediaHeaderMutation);
    const handler = Buffer.alloc(24);
    handler.writeUInt32BE(handlerFlags, 0);
    handler.write('vide', 8, 'ascii');
    mutateHandler(handler, handlerMutation);
    const sequenceParameterSet = Buffer.from(
      shortSps
        ? [spsNalHeader]
        : fakeSpsRbsp
          ? [spsNalHeader, 0]
          : [spsNalHeader, 0x42, 0x00, 0x1e, 0xe9, 0x01, 0x40, 0x7b, 0x20]
    );
    const pictureParameterSet = Buffer.from(shortPps ? [0x68] : fakePpsRbsp ? [0x68, 0] : [0x68, 0xce, 0x06, 0xe2]);
    const avcConfiguration = Buffer.concat([
      Buffer.from([1, configurationProfile, 0, 30, 0xff, 0xe1]),
      uint16(sequenceParameterSet.length),
      sequenceParameterSet,
      Buffer.from([1]),
      uint16(pictureParameterSet.length),
      pictureParameterSet
    ]);
    const visualSampleEntry = Buffer.alloc(78);
    visualSampleEntry.writeUInt16BE(dataReferenceIndex, 6);
    visualSampleEntry.writeUInt16BE(width, 24);
    visualSampleEntry.writeUInt16BE(height, 26);
    visualSampleEntry.writeUInt32BE(72 * 65_536, 28);
    visualSampleEntry.writeUInt32BE(72 * 65_536, 32);
    visualSampleEntry.writeUInt16BE(1, 40);
    visualSampleEntry.writeUInt16BE(24, 74);
    visualSampleEntry.writeInt16BE(-1, 76);
    mutateVisualSampleEntry(visualSampleEntry, sampleEntryMutation);
    const avc1 = mp4Box('avc1', visualSampleEntry, ...(omitAvcConfiguration ? [] : [mp4Box('avcC', avcConfiguration)]));
    const sampleDescriptionPayload = Buffer.concat([Buffer.alloc(4), uint32(1), avc1]);
    const sampleDescription = mp4Box('stsd', sampleDescriptionPayload);
    const timeToSample = Buffer.alloc(16);
    timeToSample.writeUInt32BE(1, 4);
    timeToSample.writeUInt32BE(sampleCount, 8);
    timeToSample.writeUInt32BE(Math.max(1, Math.round((sttsDurationSeconds * timescale) / sampleCount)), 12);
    const sampleToChunk = Buffer.alloc(20);
    sampleToChunk.writeUInt32BE(1, 4);
    sampleToChunk.writeUInt32BE(1, 8);
    sampleToChunk.writeUInt32BE(sampleCount, 12);
    sampleToChunk.writeUInt32BE(1, 16);
    const sampleSizes = Buffer.alloc(12);
    sampleSizes.writeUInt32BE(sample.length + sampleSizeAdjustment, 4);
    sampleSizes.writeUInt32BE(sampleCount, 8);
    const chunkOffsets = Buffer.alloc(12);
    chunkOffsets.writeUInt32BE(1, 4);
    chunkOffsets.writeUInt32BE(chunkOffset + chunkOffsetAdjustment, 8);
    const sampleTable = mp4Box(
      'stbl',
      sampleDescription,
      ...(duplicateStsd ? [sampleDescription] : []),
      mp4Box('stts', timeToSample),
      ...(includeCompositionTime ? [mp4Box('ctts', Buffer.from([1, 0, 0, 0, 0, 0, 0, 1]))] : []),
      mp4Box('stsc', sampleToChunk),
      mp4Box('stsz', sampleSizes),
      mp4Box('stco', chunkOffsets)
    );
    let editList = null;
    if (editListMode === 'malformed') {
      editList = mp4Box('edts', mp4Box('elst', Buffer.alloc(8)));
    } else if (editListMode !== 'none') {
      const editEntry = Buffer.alloc(20);
      editEntry.writeUInt32BE(1, 4);
      editEntry.writeUInt32BE(Math.round((editListMode === 'duration-lie' ? 1 : durationSeconds) * timescale), 8);
      editEntry.writeInt32BE(0, 12);
      editEntry.writeInt16BE(1, 16);
      editList = mp4Box('edts', mp4Box('elst', editEntry));
    }
    return mp4Box(
      'trak',
      mp4Box('tkhd', trackHeader),
      ...(editList ? [editList] : []),
      ...(misplacedEditList ? [mp4Box('elst', Buffer.alloc(8))] : []),
      mp4Box(
        'mdia',
        mp4Box('mdhd', mediaHeader),
        mp4Box('hdlr', handler),
        mp4Box(
          'minf',
          ...(omitVmhd ? [] : [videoMediaHeader(videoMediaHeaderMutation)]),
          ...(omitDref ? [] : [dataInformation()]),
          sampleTable
        )
      )
    );
  };
  const minorVersion = Buffer.alloc(4);
  minorVersion.writeUInt32BE(0x200);
  const fileType = mp4Box(
    'ftyp',
    Buffer.from(majorBrand, 'ascii'),
    minorVersion,
    Buffer.from(compatibleBrands.join(''), 'ascii')
  );
  const fileTypeBoxes = [fileType, ...(duplicateFtyp ? [fileType] : [])];
  const buildMovie = (chunkOffset) =>
    mp4Box(
      'moov',
      mp4Box('mvhd', movieHeader),
      ...(duplicateMvhd ? [mp4Box('mvhd', movieHeader)] : []),
      ...Array.from({ length: videoTrackCount }, () => track(chunkOffset)),
      ...(extraNonVideoTrack ? [malformedNonVideoTrack()] : [])
    );
  const provisionalMovie = buildMovie(Math.max(0, -chunkOffsetAdjustment));
  const chunkOffset = fileTypeBoxes.reduce((total, box) => total + box.length, 0) + provisionalMovie.length + 8;
  const movie = buildMovie(chunkOffset);
  return Buffer.concat([...fileTypeBoxes, movie, mp4Box('mdat', mediaPayload)]);
}

function malformedNonVideoTrack() {
  const trackHeader = Buffer.alloc(84);
  trackHeader.writeUInt32BE(3, 0);
  trackHeader.writeUInt32BE(2, 12);
  const handler = Buffer.alloc(24);
  handler.write('soun', 8, 'ascii');
  return mp4Box('trak', mp4Box('tkhd', trackHeader), mp4Box('mdia', mp4Box('hdlr', handler)));
}

function mutateMovieHeader(header, mutation, trackId) {
  if (mutation === 'rate') header.writeUInt32BE(0, 20);
  if (mutation === 'volume') header.writeUInt16BE(0, 24);
  if (mutation === 'reserved') header[26] = 1;
  if (mutation === 'matrix') header.writeUInt32BE(0, 36);
  if (mutation === 'pre-defined') header[72] = 1;
  if (mutation === 'next-track-id') header.writeUInt32BE(trackId, 96);
}

function mutateTrackHeader(header, mutation) {
  if (mutation === 'reserved-id') header[16] = 1;
  if (mutation === 'reserved-duration') header[24] = 1;
  if (mutation === 'volume') header.writeUInt16BE(0x0100, 36);
  if (mutation === 'reserved-volume') header[38] = 1;
  if (mutation === 'matrix') header.writeUInt32BE(0, 40);
}

function mutateMediaHeader(header, mutation) {
  if (mutation === 'language-zero') header.writeUInt16BE(0, 20);
  if (mutation === 'language-invalid') header.writeUInt16BE(0x7fff, 20);
  if (mutation === 'pre-defined') header.writeUInt16BE(1, 22);
}

function mutateHandler(handler, mutation) {
  if (mutation === 'pre-defined') handler.writeUInt32BE(1, 4);
  if (mutation === 'reserved') handler[12] = 1;
}

function mutateVisualSampleEntry(entry, mutation) {
  if (mutation === 'reserved-base') entry[0] = 1;
  if (mutation === 'pre-defined') entry.writeUInt16BE(1, 8);
  if (mutation === 'reserved') entry.writeUInt16BE(1, 10);
  if (mutation === 'pre-defined-array') entry[12] = 1;
  if (mutation === 'horizontal-resolution') entry.writeUInt32BE(0, 28);
  if (mutation === 'vertical-resolution') entry.writeUInt32BE(0, 32);
  if (mutation === 'reserved-frame') entry.writeUInt32BE(1, 36);
  if (mutation === 'frame-count') entry.writeUInt16BE(0, 40);
  if (mutation === 'compressor-length') entry[42] = 32;
  if (mutation === 'compressor-padding') entry[73] = 1;
  if (mutation === 'depth') entry.writeUInt16BE(0, 74);
  if (mutation === 'final-pre-defined') entry.writeInt16BE(0, 76);
}

function writeIdentityMatrix(bytes, offset) {
  for (const [index, value] of [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000].entries()) {
    bytes.writeUInt32BE(value, offset + index * 4);
  }
}

function packIso639Language(language) {
  return [...language].reduce((value, character) => (value << 5) | (character.charCodeAt(0) - 0x60), 0);
}

function videoMediaHeader(mutation = null) {
  const payload = Buffer.alloc(12);
  payload.writeUInt32BE(1, 0);
  if (mutation === 'graphicsmode') payload.writeUInt16BE(1, 4);
  if (mutation === 'opcolor') payload.writeUInt16BE(1, 6);
  return mp4Box('vmhd', payload);
}

function dataInformation() {
  const selfContainedUrl = Buffer.alloc(4);
  selfContainedUrl.writeUInt32BE(1);
  return mp4Box('dinf', mp4Box('dref', Buffer.alloc(4), uint32(1), mp4Box('url ', selfContainedUrl)));
}

function headerOnlyMp4({ durationSeconds, height, width }) {
  const timescale = 1000;
  const movieHeader = Buffer.alloc(100);
  movieHeader.writeUInt32BE(timescale, 12);
  movieHeader.writeUInt32BE(Math.round(durationSeconds * timescale), 16);
  const trackHeader = Buffer.alloc(84);
  trackHeader.writeUInt32BE(width * 65_536, 76);
  trackHeader.writeUInt32BE(height * 65_536, 80);
  const handler = Buffer.alloc(24);
  handler.write('vide', 8, 'ascii');
  const fileType = mp4Box('ftyp', Buffer.from('isom', 'ascii'), Buffer.alloc(4), Buffer.from('isommp42', 'ascii'));
  const movie = mp4Box(
    'moov',
    mp4Box('mvhd', movieHeader),
    mp4Box('trak', mp4Box('tkhd', trackHeader), mp4Box('mdia', mp4Box('hdlr', handler)))
  );
  return Buffer.concat([fileType, movie, mp4Box('mdat', Buffer.alloc(0))]);
}

function uint16(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);
  return bytes;
}

function uint32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
}

function mp4Box(type, ...payloads) {
  const payload = Buffer.concat(payloads);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + header.length);
  header.write(type, 4, 'ascii');
  return Buffer.concat([header, payload]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  findAccessibilitySourceContractFindings,
  findBrowserEvidenceFindings,
  findDependencyCandidateAuditFindings,
  findMediaEvidenceFindings,
  findPerformanceEvidenceFindings,
  findRemotePublicationFindings
} from '../../scripts/publication-evidence-contract.mjs';

const artifactSha256 = 'A'.repeat(64);
const releaseInputFingerprintSha256 = 'B'.repeat(64);

test('browser evidence requires every assertion to pass and each browser to cover the exact required matrix', () => {
  const valid = browserEvidence();
  assert.deepEqual(findBrowserEvidenceFindings({ browser: valid, runtimeArtifactSha256: artifactSha256 }), []);

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
        value.requiredMatrix.push('install');
      },
      /unique non-empty requirements/
    ]
  ]) {
    const fixture = structuredClone(valid);
    mutate(fixture);
    assert.match(
      findBrowserEvidenceFindings({ browser: fixture, runtimeArtifactSha256: artifactSha256 }).join('\n'),
      pattern,
      name
    );
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

function browserEvidence() {
  const assertion = (id) => ({
    id,
    status: 'passed',
    observedAt: '2026-08-21T20:00:00.000Z',
    artifactSha256,
    matrixCoverage: ['install', 'cleanup']
  });
  return {
    requiredMatrix: ['install', 'cleanup'],
    chrome: { assertions: [assertion('chrome-matrix')] },
    brave: { assertions: [assertion('brave-matrix')] }
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

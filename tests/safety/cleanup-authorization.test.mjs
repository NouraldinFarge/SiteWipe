import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLEANUP_AUTHORIZATION_SCHEMA_VERSION,
  initializeReviewedCleanupReport,
  isCleanupCancellationError
} from '../../src/background/cleanup-authorization.js';

const CREATED_AT_MS = Date.parse('2026-08-17T12:00:00.000Z');
const APPROVED_AT_MS = Date.parse('2026-08-17T12:00:09.000Z');

function approval(overrides = {}) {
  return {
    approvalMode: 'detailed_review',
    createdAtMs: CREATED_AT_MS,
    canonicalInput: 'alice.blogspot.com',
    sourceIncognito: false,
    target: {
      domain: 'alice.blogspot.com',
      displayName: 'alice.blogspot.com',
      matchMode: 'registrable_domain',
      associatedTargets: [
        {
          domain: 'accounts.example.net',
          displayName: 'accounts.example.net',
          matchMode: 'registrable_domain'
        }
      ]
    },
    associated: {
      applied: [{ input: 'accounts.example.net', matchMode: 'registrable_domain', exactOrigin: null }],
      errors: [],
      warnings: []
    },
    approvedDownloadFileIds: ['7', '9'],
    ...overrides
  };
}

test('reviewed authorization records distinct preflight and final-activation evidence', () => {
  const result = initializeReviewedCleanupReport({
    approval: approval(),
    settings: { cleanupMode: 'expert' },
    repair: { repaired: true, staleJobRecovered: true },
    now: () => APPROVED_AT_MS
  });

  assert.equal(result.report.summary.cleanupMode, 'expert');
  assert.equal(result.report.summary.cleanupApprovalMode, 'detailed_review');
  assert.equal(result.report.summary.cleanupApprovalSchemaVersion, CLEANUP_AUTHORIZATION_SCHEMA_VERSION);
  assert.equal(result.report.summary.cleanupPreflightCreatedAt, '2026-08-17T12:00:00.000Z');
  assert.equal(result.report.summary.scopeReviewCreatedAt, '2026-08-17T12:00:09.000Z');
  assert.equal(result.report.summary.scopeReviewApprovedFileCandidates, 2);
  assert.equal(result.report.summary.extensionStateRepaired, true);
  assert.equal(result.report.summary.staleJobRecovered, true);

  const reviewSection = result.report.sections.find((section) => section.key === 'cleanupReview');
  assert.equal(reviewSection.details.approvalMode, 'detailed_review');
  assert.equal(reviewSection.details.preflightAt, '2026-08-17T12:00:00.000Z');
  assert.equal(reviewSection.details.reviewedAt, '2026-08-17T12:00:09.000Z');
  const associatedSection = result.report.sections.find((section) => section.key === 'associatedDomains');
  assert.equal(associatedSection.details.applied.length, 1);
  assert.match(associatedSection.details.note, /displayed and approved associated domains/i);
});

test('reviewed authorization reports exact and broad preflight host grants truthfully', () => {
  const requiredOrigins = ['http://alice.blogspot.com/*', 'https://alice.blogspot.com/*'];
  const result = initializeReviewedCleanupReport({
    approval: approval({
      target: {
        ...approval().target,
        hostPermissionOrigins: requiredOrigins
      },
      preexistingHostPermissionOrigins: requiredOrigins,
      hostPermissionInventory: {
        grantedHostPermissionOrigins: ['<all_urls>', 'https://unrelated.example/*']
      }
    }),
    settings: { cleanupMode: 'standard' },
    now: () => APPROVED_AT_MS
  });

  assert.equal(result.report.summary.allSitesAccessGranted, true);
  assert.equal(result.report.summary.broadHostPermissionOriginsGranted, 1);
  assert.equal(result.report.summary.exactRequiredHostPermissionOriginsGranted, 0);
  assert.equal(JSON.stringify(result.report.hostPermissionInventory).includes('unrelated.example'), false);
  assert.deepEqual(result.report.hostPermissionInventory.reviewedPreflight.broadGrantedHostPermissionOrigins, [
    '<all_urls>'
  ]);
  const reviewSection = result.report.sections.find((section) => section.key === 'cleanupReview');
  assert.deepEqual(reviewSection.details.broadPreexistingHostPermissionOrigins, ['<all_urls>']);
  assert.deepEqual(reviewSection.details.exactPreexistingHostPermissionOrigins, []);
  assert.deepEqual(reviewSection.details.requiredOriginsCoveredByBroaderAccess, requiredOrigins);
});

test('settings-direct authorization reports a bound preflight without claiming a detailed review', () => {
  const result = initializeReviewedCleanupReport({
    approval: approval({ approvalMode: 'settings_direct' }),
    settings: { cleanupMode: 'expert', skipCleanupReview: true },
    now: () => APPROVED_AT_MS
  });

  assert.equal(result.report.summary.cleanupApprovalMode, 'settings_direct');
  assert.equal(result.report.summary.scopeReviewApproved, false);
  assert.equal(result.report.summary.settingsDirectCleanupAuthorized, true);
  assert.equal(result.report.summary.scopeReviewCreatedAt, null);
  assert.equal(result.report.summary.directCleanupAuthorizedAt, '2026-08-17T12:00:09.000Z');
  assert.equal(result.report.summary.scopeReviewApprovedFileCandidates, 0);
  assert.equal(result.report.summary.preflightBoundFileCandidates, 2);
  const authorizationSection = result.report.sections.find((section) => section.key === 'cleanupReview');
  assert.equal(authorizationSection.details.approvalMode, 'settings_direct');
  assert.equal(authorizationSection.details.reviewedAt, null);
  assert.equal(authorizationSection.details.directlyAuthorizedAt, '2026-08-17T12:00:09.000Z');
  assert.match(authorizationSection.label, /saved direct authorization/i);
  assert.match(authorizationSection.details.note, /fresh read-only preflight/i);

  assert.throws(
    () =>
      initializeReviewedCleanupReport({
        approval: approval({ approvalMode: 'settings_direct' }),
        settings: { cleanupMode: 'expert', skipCleanupReview: false },
        now: () => APPROVED_AT_MS
      }),
    /Direct cleanup is not enabled/i
  );
});

test('authorization boundary rejects retired, missing, and invented approval modes', () => {
  for (const approvalMode of ['quick', 'bypass', undefined, null]) {
    assert.throws(
      () =>
        initializeReviewedCleanupReport({
          approval: approval({ approvalMode }),
          settings: { cleanupMode: 'standard' },
          now: () => APPROVED_AT_MS
        }),
      /complete per-run cleanup review is required/i
    );
  }
});

test('only a typed AbortError is classified as an intentional cleanup cancellation', () => {
  const intentional = new Error('SiteWipe cleanup canceled before the next phase.');
  intentional.name = 'AbortError';
  assert.equal(isCleanupCancellationError(intentional), true);
  assert.equal(isCleanupCancellationError(new Error('Browser request was canceled unexpectedly.')), false);
  assert.equal(isCleanupCancellationError({ name: 'OperationTimeoutError', message: 'canceled by browser' }), false);
});

test('authorization boundary fails closed on missing targets and invalid or regressing clocks', () => {
  assert.throws(
    () =>
      initializeReviewedCleanupReport({
        approval: approval({ target: null }),
        settings: { cleanupMode: 'standard' },
        now: () => APPROVED_AT_MS
      }),
    /reviewed cleanup target is unavailable/i
  );
  assert.throws(
    () =>
      initializeReviewedCleanupReport({
        approval: approval({ createdAtMs: Number.NaN }),
        settings: { cleanupMode: 'standard' },
        now: () => APPROVED_AT_MS
      }),
    /reviewed cleanup timestamp is invalid/i
  );
  assert.throws(
    () =>
      initializeReviewedCleanupReport({
        approval: approval(),
        settings: { cleanupMode: 'standard' },
        now: () => CREATED_AT_MS - 1
      }),
    /final cleanup approval timestamp is invalid/i
  );
});

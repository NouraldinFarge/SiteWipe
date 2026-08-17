import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCleanupReview,
  buildFileDeletionConfirmation,
  isReviewedFileRemovalCandidate,
  reviewedFileIds,
  validateCleanupReviewApproval
} from '../../src/shared/cleanup-review.js';

const baseTarget = {
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
};

function build(overrides = {}) {
  return buildCleanupReview({
    enteredTarget: 'https://alice.blogspot.com/private?token=secret',
    target: baseTarget,
    settings: {
      cleanupMode: 'expert',
      temporaryDnrShield: true,
      verificationPass: true,
      deleteDownloadedFiles: true,
      includeProtectedWebOrigins: true,
      redactReports: true,
      latestReportRetentionMinutes: 30,
      keepHistory: false
    },
    sourceWindowId: 42,
    sourceIncognito: false,
    incognitoAccess: false,
    hostPermissionsGranted: true,
    impact: {
      matchingTabs: 2,
      matchingPrivateTabs: 0,
      matchingHistoryEntries: 3,
      matchingDownloadRecords: 4,
      matchedCompletedFileCount: 2,
      matchedCompletedFileIds: ['7', '9'],
      limitations: []
    },
    approvalToken: 'review-token',
    createdAt: '2026-08-16T12:00:00.000Z',
    expiresAt: '2026-08-16T12:05:00.000Z',
    ...overrides
  });
}

function buildStandard(overrides = {}) {
  return buildCleanupReview({
    enteredTarget: 'https://example.com/account',
    target: {
      domain: 'example.com',
      displayName: 'example.com',
      matchMode: 'registrable_domain',
      associatedTargets: []
    },
    settings: {
      cleanupMode: 'standard',
      temporaryDnrShield: true,
      verificationPass: true,
      deleteDownloadedFiles: false,
      includeProtectedWebOrigins: false,
      redactReports: true,
      latestReportRetentionMinutes: 30,
      keepHistory: false
    },
    sourceWindowId: 42,
    sourceIncognito: false,
    incognitoAccess: false,
    hostPermissionsGranted: true,
    impact: {
      matchingTabs: 1,
      matchingPrivateTabs: 0,
      matchingHistoryEntries: 2,
      matchingDownloadRecords: 0,
      matchedCompletedFileCount: 0,
      matchedCompletedFileIds: [],
      limitations: []
    },
    approvalToken: 'standard-review-token',
    createdAt: '2026-08-16T12:00:00.000Z',
    expiresAt: '2026-08-16T12:05:00.000Z',
    ...overrides
  });
}

test('scope review exposes the entered target, normalized scope, associated targets, and all required effects', () => {
  const review = build();
  assert.equal(review.enteredTarget, 'https://alice.blogspot.com/private?token=secret');
  assert.equal(review.normalizedTarget, 'alice.blogspot.com');
  assert.equal(review.scopeKind, 'registrable_site');
  assert.equal(review.includesSubdomains, true);
  assert.deepEqual(
    review.associatedTargets.map((item) => item.normalizedTarget),
    ['accounts.example.net']
  );
  assert.equal(review.effects.closeTabs.enabled, true);
  assert.equal(review.effects.removeHistory.enabled, true);
  assert.equal(review.effects.removeDownloadRecords.enabled, true);
  assert.equal(review.effects.removeDownloadedFiles.enabled, true);
  assert.equal(review.effects.requestShield.enabled, true);
  assert.equal(review.effects.verification.enabled, true);
  assert.equal(review.effects.localReport.retained, true);
  assert.equal(review.effects.localReport.retentionMinutes, 30);
  assert.equal(review.effects.localReport.redacted, true);
  assert.equal(review.effects.localReport.historyEnabled, false);
});

test('high-risk expansions require separate acknowledgements and exact typed file confirmation', () => {
  const review = build();
  assert.deepEqual(review.requirements, {
    reviewedScope: true,
    associatedTargets: true,
    localOrIpTarget: false,
    protectedWebOrigins: true,
    downloadedFiles: true,
    fileConfirmationText: 'DELETE 2 FILES FOR alice.blogspot.com'
  });

  const incomplete = validateCleanupReviewApproval(review.requirements, {
    reviewedScope: true
  });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.errors.length, 3);

  const complete = validateCleanupReviewApproval(review.requirements, {
    reviewedScope: true,
    associatedTargets: true,
    protectedWebOrigins: true,
    fileConfirmationText: 'DELETE 2 FILES FOR alice.blogspot.com'
  });
  assert.equal(complete.ok, true);
});

test('localhost/IP exact-origin review requires its own acknowledgement', () => {
  const review = build({
    target: {
      domain: 'localhost:3000',
      displayName: 'localhost:3000',
      exactHost: 'localhost',
      exactOrigin: 'http://localhost:3000',
      matchMode: 'exact_origin',
      associatedTargets: []
    },
    settings: {
      cleanupMode: 'expert',
      allowLocalTargets: true,
      deleteDownloadedFiles: false
    },
    impact: {
      matchingTabs: null,
      matchingPrivateTabs: null,
      matchedCompletedFileIds: []
    }
  });
  assert.equal(review.scopeKind, 'exact_origin');
  assert.equal(review.includesSubdomains, false);
  assert.equal(review.requirements.localOrIpTarget, true);
  assert.equal(review.effects.closeTabs.matchingCount, null);
});

test('file-removal authorization is bound to reviewed, complete, existing download IDs', () => {
  const items = [
    { id: 1, state: 'complete', exists: true },
    { id: 2, state: 'in_progress', exists: true },
    { id: 3, state: 'complete', exists: false },
    { id: 4, state: 'complete' }
  ];
  assert.deepEqual(reviewedFileIds(items), ['1', '4']);
  assert.equal(isReviewedFileRemovalCandidate(items[0], ['1', '4']), true);
  assert.equal(isReviewedFileRemovalCandidate(items[1], ['1', '4']), false);
  assert.equal(isReviewedFileRemovalCandidate({ id: 99, state: 'complete', exists: true }, ['1', '4']), false);
  assert.equal(buildFileDeletionConfirmation('example.com', 1), 'DELETE 1 FILE FOR example.com');
});

test('private-context review promises no persisted report and unknown preview counts stay unknown', () => {
  const review = build({
    sourceIncognito: true,
    incognitoAccess: true,
    impact: {
      matchingTabs: null,
      matchingPrivateTabs: null,
      matchingHistoryEntries: null,
      matchingDownloadRecords: null,
      matchedCompletedFileIds: null
    }
  });
  assert.equal(review.effects.localReport.retained, false);
  assert.equal(review.effects.localReport.retentionMinutes, 0);
  assert.equal(review.effects.closeTabs.matchingCount, null);
  assert.equal(review.effects.removeHistory.matchingCount, null);
  assert.equal(review.effects.removeDownloadedFiles.enabled, false);
  assert.equal(review.effects.removeDownloadedFiles.candidateReviewComplete, false);
});

test('enabled private-window access keeps reports transient even from a normal source window', () => {
  const review = build({
    sourceIncognito: false,
    incognitoAccess: true,
    impact: {
      matchingTabs: 1,
      matchingPrivateTabs: 0,
      matchingHistoryEntries: 0,
      matchingDownloadRecords: 0,
      matchedCompletedFileIds: []
    }
  });
  assert.equal(review.effects.localReport.retained, false);
  assert.equal(review.effects.localReport.conditional, false);
  assert.equal(review.effects.localReport.retentionMinutes, 0);
  assert.match(review.effects.localReport.summary, /affected private scope cannot be proven absent/i);
});

test('indefinite latest-report retention remains explicit instead of becoming 30 minutes', () => {
  const review = build({
    settings: {
      cleanupMode: 'standard',
      temporaryDnrShield: true,
      verificationPass: true,
      redactReports: true,
      latestReportRetentionMinutes: 0,
      keepHistory: false
    }
  });
  assert.equal(review.effects.localReport.retentionMinutes, 0);
  assert.equal(review.settingsSnapshot.latestReportRetentionMinutes, 0);
  assert.match(review.effects.localReport.summary, /indefinitely by explicit privacy opt-in/i);
});

test('post-wipe blocking is reviewed as an enabled request shield even if temporary shielding is toggled off', () => {
  const review = build({
    settings: {
      cleanupMode: 'expert',
      temporaryDnrShield: false,
      postWipeSessionBlock: true,
      verificationPass: true,
      redactReports: true,
      latestReportRetentionMinutes: 30,
      keepHistory: false
    }
  });
  assert.equal(review.effects.requestShield.enabled, true);
  assert.equal(review.effects.requestShield.remainsAfterCleanup, true);
  assert.equal(review.categoriesAttempted.includes('Temporary target request shield'), true);
});

test('Standard cleanup always requires a complete per-run review', () => {
  const review = buildStandard({
    settings: {
      cleanupMode: 'standard',
      // A retired profile/import field must not create bypass metadata or
      // weaken approval validation.
      skipCleanupReview: true,
      temporaryDnrShield: true,
      verificationPass: true,
      redactReports: true,
      latestReportRetentionMinutes: 30,
      keepHistory: false
    }
  });
  assert.equal(Object.hasOwn(review.settingsSnapshot, 'skipCleanupReview'), false);
  assert.equal(Object.hasOwn(review, 'quickCleanupAllowed'), false);
  assert.equal(Object.hasOwn(review, 'quickCleanupBlockedReasons'), false);

  const rejected = validateCleanupReviewApproval(review.requirements, {
    approvalMode: 'quick',
    reviewedScope: false
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.errors.join(' '), /complete per-run cleanup review is required/i);

  const approved = validateCleanupReviewApproval(review.requirements, {
    approvalMode: 'detailed_review',
    reviewedScope: true,
    associatedTargets: false,
    localOrIpTarget: false,
    protectedWebOrigins: false,
    fileConfirmationText: ''
  });
  assert.equal(approved.ok, true);
  assert.equal(approved.approvalMode, 'detailed_review');
});

test('elevated and uncertain Expert cleanup still requires every displayed acknowledgement', () => {
  const review = build({
    settings: {
      cleanupMode: 'expert',
      temporaryDnrShield: true,
      postWipeSessionBlock: true,
      verificationPass: true,
      deleteDownloadedFiles: true,
      includeProtectedWebOrigins: true,
      storageBucketScrub: true,
      opfsScrub: true,
      redactReports: true,
      latestReportRetentionMinutes: 30,
      keepHistory: false
    },
    sourceIncognito: true,
    incognitoAccess: true,
    hostPermissionsGranted: false,
    impact: {
      matchingTabs: null,
      matchingPrivateTabs: null,
      matchingHistoryEntries: null,
      matchingDownloadRecords: null,
      matchedCompletedFileCount: 2,
      matchedCompletedFileIds: ['7', '9'],
      limitations: ['One or more impact counts are unavailable.']
    }
  });

  assert.equal(review.settingsSnapshot.cleanupMode, 'expert');
  assert.equal(review.hostPermissionsGranted, false);
  assert.equal(review.privateWindowScope.included, true);
  assert.equal(review.requirements.associatedTargets, true);
  assert.equal(review.requirements.protectedWebOrigins, true);
  assert.equal(review.requirements.downloadedFiles, true);
  assert.equal(review.effects.requestShield.remainsAfterCleanup, true);
  assert.ok(review.previewLimitations.length > 0);

  const rejected = validateCleanupReviewApproval(review.requirements, {
    approvalMode: 'quick',
    reviewedScope: false
  });
  assert.equal(rejected.ok, false);

  const approved = validateCleanupReviewApproval(review.requirements, {
    approvalMode: 'detailed_review',
    reviewedScope: true,
    associatedTargets: true,
    localOrIpTarget: false,
    protectedWebOrigins: true,
    fileConfirmationText: 'DELETE 2 FILES FOR alice.blogspot.com'
  });
  assert.equal(approved.ok, true);
});

test('every non-detailed approval mode fails closed before acknowledgement evaluation', () => {
  const review = buildStandard();
  for (const approvalMode of ['quick', 'bypass', '', null, false]) {
    const approval = validateCleanupReviewApproval(review.requirements, {
      approvalMode,
      reviewedScope: true,
      associatedTargets: true,
      localOrIpTarget: true,
      protectedWebOrigins: true,
      fileConfirmationText: review.requiredFileConfirmation
    });
    assert.equal(approval.ok, false, `mode ${String(approvalMode)} must be rejected`);
    assert.match(approval.errors.join(' '), /complete per-run cleanup review is required/i);
  }
});

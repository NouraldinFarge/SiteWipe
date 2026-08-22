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
  assert.equal(review.effects.requestShield.enabled, false);
  assert.equal(review.effects.requestShield.disabledForNormalOnlyReview, true);
  assert.match(review.effects.requestShield.disabledReason, /normal-only safety/i);
  assert.equal(review.effects.verification.enabled, true);
  assert.equal(review.effects.localReport.retained, true);
  assert.equal(review.effects.localReport.retentionMinutes, 30);
  assert.equal(review.effects.localReport.redacted, true);
  assert.equal(review.effects.localReport.historyEnabled, false);
});

test('review binds and discloses cross-tab overlay scope plus every material Expert mutation/discovery option', () => {
  const review = build({
    incognitoAccess: true,
    settings: {
      cleanupMode: 'expert',
      temporaryDnrShield: true,
      postWipeSessionBlock: true,
      postWipeShieldExpiresMinutes: 60,
      progressOverlay: true,
      progressOverlayCancelButton: true,
      overlayScope: 'all_tabs',
      pageScriptScrub: true,
      storageBucketScrub: true,
      opfsScrub: true,
      serviceWorkerExtraScrub: true,
      appBadgeClear: true,
      embeddedFrameDiscovery: true,
      aggressiveCookieSweep: true,
      probePartitionedCookiesWithEmbeddingSites: true,
      exhaustiveCookieStoreScan: true,
      broadDiscoveryFallback: true,
      downloadRecentFallback: true,
      resetZoom: true,
      resetMutedTabs: true,
      unpinTargetTabs: true,
      includeProtectedWebOrigins: true,
      deleteDownloadedFiles: true,
      verificationPass: true,
      redactReports: true,
      latestReportRetentionMinutes: 30,
      keepHistory: false
    }
  });

  assert.deepEqual(review.effects.progressOverlay, {
    enabled: true,
    scope: 'all_tabs',
    scopeDescription: 'all accessible HTTP(S) tabs across browser windows',
    sourceWindowId: null,
    cancelButtonEnabled: true,
    maxTabsPerUpdate: 120,
    capAppliesPerUpdate: true,
    simultaneousVisibleLimitGuaranteed: false,
    temporary: true,
    watchdogMs: 15_000,
    warnings: review.effects.progressOverlay.warnings
  });
  assert.match(review.effects.progressOverlay.warnings.join(' '), /visibly change unrelated pages/i);
  assert.match(review.effects.progressOverlay.warnings.join(' '), /120 tabs per update/i);
  assert.match(review.effects.progressOverlay.warnings.join(' '), /not a guaranteed simultaneous-visible total/i);
  assert.match(review.effects.progressOverlay.warnings.join(' '), /cancel button is enabled/i);
  assert.equal(review.warnings.includes(review.effects.progressOverlay.warnings[0]), true);
  assert.equal(review.warnings.includes(review.effects.progressOverlay.warnings[1]), true);
  assert.deepEqual(review.effects.configuredCleanup, {
    livePageScrub: {
      enabled: true,
      storageBuckets: true,
      opfs: true,
      serviceWorkerExtras: true,
      appBadgeClear: true
    },
    embeddedFrameDiscovery: true,
    cookies: {
      browserCookieSweep: true,
      partitionedEmbeddingSiteProbes: true,
      exhaustiveAccessibleStoreScan: true
    },
    recordDiscovery: {
      broadSearchTermFallback: true,
      recentDownloadFallback: true
    },
    targetTabState: {
      resetZoom: true,
      resetMutedTabs: true,
      unpinTabs: true
    },
    protectedWebOrigins: true
  });
  assert.deepEqual(review.effects.requestShield, {
    requested: true,
    enabled: true,
    disabledForNormalOnlyReview: false,
    disabledReason: null,
    remainsAfterCleanup: true,
    expiresMinutes: 60
  });
});

test('review explicitly records a disabled overlay and normalizes an unsupported stored scope fail-closed', () => {
  const review = buildStandard({
    settings: {
      cleanupMode: 'standard',
      progressOverlay: false,
      progressOverlayCancelButton: true,
      overlayScope: 'invented_scope',
      redactReports: true,
      latestReportRetentionMinutes: 30,
      keepHistory: false
    }
  });
  assert.equal(review.effects.progressOverlay.enabled, false);
  assert.equal(review.effects.progressOverlay.scope, 'target_tabs');
  assert.equal(review.effects.progressOverlay.cancelButtonEnabled, false);
  assert.equal(review.effects.progressOverlay.temporary, false);
  assert.deepEqual(review.effects.progressOverlay.warnings, []);
});

test('review downgrades current-window overlay scope when the source window cannot be bound', () => {
  const review = buildStandard({
    settings: {
      cleanupMode: 'expert',
      progressOverlay: true,
      progressOverlayCancelButton: true,
      overlayScope: 'current_window',
      redactReports: true,
      latestReportRetentionMinutes: 30,
      keepHistory: false
    },
    sourceWindowId: null
  });
  assert.equal(review.effects.progressOverlay.scope, 'target_tabs');
  assert.equal(review.effects.progressOverlay.sourceWindowId, null);
  assert.equal(review.effects.progressOverlay.scopeDescription, 'matching accessible HTTP(S) target tabs only');
  assert.doesNotMatch(review.effects.progressOverlay.warnings.join(' '), /unrelated pages/i);
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
    approvalMode: 'detailed_review',
    reviewedScope: true
  });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.errors.length, 3);

  const complete = validateCleanupReviewApproval(review.requirements, {
    approvalMode: 'detailed_review',
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

test('normal-only review disables a requested post-wipe shield when temporary shielding is toggled off', () => {
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
  assert.equal(review.effects.requestShield.requested, true);
  assert.equal(review.effects.requestShield.enabled, false);
  assert.equal(review.effects.requestShield.disabledForNormalOnlyReview, true);
  assert.equal(review.effects.requestShield.remainsAfterCleanup, false);
  assert.equal(review.categoriesAttempted.includes('Temporary target request shield'), false);
  assert.match(review.warnings.join(' '), /target may recreate browser data/i);
});

test('review separates exact required patterns from broader pre-existing access', () => {
  const target = {
    domain: 'example.com',
    displayName: 'example.com',
    matchMode: 'registrable_domain',
    associatedTargets: [],
    hostPermissionOrigins: ['http://example.com/*', 'https://example.com/*']
  };
  const review = buildCleanupReview({
    enteredTarget: 'example.com',
    target,
    settings: { cleanupMode: 'standard', redactReports: true },
    hostPermissionsGranted: true,
    hostPermissionInventory: {
      coveredRequiredHostPermissionOrigins: target.hostPermissionOrigins,
      grantedHostPermissionOrigins: ['<all_urls>', 'https://unrelated.example/*']
    },
    impact: { matchedCompletedFileIds: [] },
    approvalToken: 'broad-review-token',
    createdAt: '2026-08-16T12:00:00.000Z',
    expiresAt: '2026-08-16T12:05:00.000Z'
  });

  assert.deepEqual(review.requiredHostPermissionOrigins, target.hostPermissionOrigins);
  assert.deepEqual(review.hostPermissionInventory.exactRequiredHostPermissionOrigins, []);
  assert.deepEqual(review.hostPermissionInventory.requiredCoveredByBroadHostPermissionOrigins, [
    'http://example.com/*',
    'https://example.com/*'
  ]);
  assert.deepEqual(review.hostPermissionInventory.broadGrantedHostPermissionOrigins, ['<all_urls>']);
  assert.equal(review.hostPermissionInventory.allSitesAccessGranted, true);
  assert.equal(JSON.stringify(review.hostPermissionInventory).includes('unrelated.example'), false);
  assert.match(review.warnings.join(' '), /broader user-controlled host permission/i);
  assert.match(review.warnings.join(' '), /preserved/i);
  assert.match(review.warnings.join(' '), /read-only preflight snapshot/i);
  assert.match(review.warnings.join(' '), /file removal remains limited.*preflight-bound file IDs/i);
});

test('Standard cleanup uses saved direct authorization only when explicitly enabled', () => {
  const review = buildStandard({
    settings: {
      cleanupMode: 'standard',
      skipCleanupReview: true,
      temporaryDnrShield: true,
      verificationPass: true,
      redactReports: true,
      latestReportRetentionMinutes: 30,
      keepHistory: false
    }
  });
  assert.equal(review.settingsSnapshot.skipCleanupReview, true);
  assert.equal(review.approvalMode, 'settings_direct');
  assert.equal(Object.hasOwn(review, 'quickCleanupAllowed'), false);
  assert.equal(Object.hasOwn(review, 'quickCleanupBlockedReasons'), false);

  const rejected = validateCleanupReviewApproval(
    review.requirements,
    {
      approvalMode: 'detailed_review',
      reviewedScope: true,
      associatedTargets: false,
      localOrIpTarget: false,
      protectedWebOrigins: false,
      fileConfirmationText: ''
    },
    review.approvalMode
  );
  assert.equal(rejected.ok, false);
  assert.match(rejected.errors.join(' '), /complete per-run cleanup review is required/i);

  const approved = validateCleanupReviewApproval(
    review.requirements,
    {
      approvalMode: 'settings_direct',
      reviewedScope: false,
      associatedTargets: false,
      localOrIpTarget: false,
      protectedWebOrigins: false,
      fileConfirmationText: ''
    },
    review.approvalMode
  );
  assert.equal(approved.ok, true);
  assert.equal(approved.approvalMode, 'settings_direct');
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

test('every unrecognized approval mode fails closed before acknowledgement evaluation', () => {
  const review = buildStandard();
  for (const approvalMode of ['quick', 'bypass', '', null, false, undefined]) {
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

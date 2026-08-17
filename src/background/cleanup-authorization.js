import { addSection, createReport } from './report.js';

export const CLEANUP_AUTHORIZATION_SCHEMA_VERSION = 1;

/**
 * Initializes the immutable report evidence for a consumed, detailed review.
 * Token validation and consumption happen in cleanup-preflight before this
 * function is reachable; this boundary deliberately rejects every other mode
 * again so a future routing refactor cannot silently reintroduce a shortcut.
 */
export function initializeReviewedCleanupReport({ approval, settings, repair = {}, now = () => Date.now() }) {
  if (!approval || typeof approval !== 'object' || approval.approvalMode !== 'detailed_review') {
    throw new Error('A complete per-run cleanup review is required. Start the cleanup again.');
  }
  if (!approval.target || typeof approval.target !== 'object') {
    throw new Error('The reviewed cleanup target is unavailable. Start the cleanup again.');
  }
  if (!Number.isSafeInteger(approval.createdAtMs)) {
    throw new Error('The reviewed cleanup timestamp is invalid. Start the cleanup again.');
  }
  const approvedAtMs = Number(now());
  if (!Number.isFinite(approvedAtMs) || approvedAtMs < approval.createdAtMs) {
    throw new Error('The final cleanup approval timestamp is invalid. Start the cleanup again.');
  }

  const target = approval.target;
  const associated = normalizeAssociatedEvidence(approval.associated);
  const approvedDownloadFileIds = Array.isArray(approval.approvedDownloadFileIds)
    ? approval.approvedDownloadFileIds
    : [];
  const cleanupPreflightCreatedAt = new Date(approval.createdAtMs).toISOString();
  const scopeReviewApprovedAt = new Date(approvedAtMs).toISOString();
  const report = createReport(target, approval.canonicalInput);

  report.sourceIncognito = Boolean(approval.sourceIncognito);
  report.summary.cleanupMode = settings?.cleanupMode === 'expert' ? 'expert' : 'standard';
  report.summary.cleanupApprovalMode = 'detailed_review';
  report.summary.cleanupApprovalSchemaVersion = CLEANUP_AUTHORIZATION_SCHEMA_VERSION;
  report.summary.cleanupPreflightApproved = true;
  report.summary.activeJobPersistent = true;
  report.summary.associatedTargetsIncluded = associated.applied.length;
  report.summary.cleanupPreflightCreatedAt = cleanupPreflightCreatedAt;
  report.summary.scopeReviewApproved = true;
  report.summary.scopeReviewCreatedAt = scopeReviewApprovedAt;
  report.summary.scopeReviewApprovedFileCandidates = approvedDownloadFileIds.length;
  report.summary.preflightBoundFileCandidates = approvedDownloadFileIds.length;
  report.summary.extensionStatePreflightRan = true;
  report.summary.extensionStateRepaired = Boolean(repair.repaired);
  report.summary.staleJobRecovered = Boolean(repair.staleJobRecovered);

  addSection(
    report,
    'extensionHealth',
    repair.repaired
      ? 'SiteWipe recovery preflight repaired extension-owned state'
      : 'SiteWipe recovery preflight found healthy extension-owned state',
    repair.repaired ? 'success' : 'info',
    repair
  );
  addSection(report, 'cleanupReview', 'Cleanup scope reviewed and approved', 'success', {
    target: target.matchMode === 'exact_origin' ? target.exactOrigin : target.domain,
    matchMode: target.matchMode || 'registrable_domain',
    associatedTargetCount: target.associatedTargets?.length || 0,
    sourceIncognito: Boolean(approval.sourceIncognito),
    approvalMode: 'detailed_review',
    approvalSchemaVersion: CLEANUP_AUTHORIZATION_SCHEMA_VERSION,
    preflightBoundDownloadedFileCandidates: approvedDownloadFileIds.length,
    preflightAt: cleanupPreflightCreatedAt,
    reviewedAt: scopeReviewApprovedAt,
    note: 'A complete per-run review and its single-use, short-lived approval were consumed before extension-state recovery, request shielding, or browser-data mutation began.'
  });
  if (associated.applied.length || associated.errors.length || associated.warnings.length) {
    addSection(
      report,
      'associatedDomains',
      associated.applied.length ? 'Associated-domain group applied' : 'Associated-domain groups checked',
      associated.errors.length || associated.warnings.length ? 'partial' : 'success',
      {
        ...associated,
        note: associated.applied.length
          ? 'These displayed and approved associated domains/origins are included in tabs, cookies, storage origins, history, downloads, and request shielding for this run after browser-service safety checks.'
          : 'No configured associated-domain group matched this target.'
      }
    );
  }

  return {
    report,
    target,
    associated,
    cleanupPreflightCreatedAt,
    scopeReviewApprovedAt
  };
}

function normalizeAssociatedEvidence(value) {
  return {
    applied: Array.isArray(value?.applied) ? value.applied : [],
    errors: Array.isArray(value?.errors) ? value.errors : [],
    warnings: Array.isArray(value?.warnings) ? value.warnings : []
  };
}

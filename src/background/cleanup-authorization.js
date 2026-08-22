import { addSection, createReport } from './report.js';
import { buildHostPermissionInventory } from '../shared/host-permissions.js';

export const CLEANUP_AUTHORIZATION_SCHEMA_VERSION = 1;

export function isCleanupCancellationError(error) {
  return error?.name === 'AbortError';
}

/**
 * Initializes immutable report evidence for a consumed, preflight-bound authorization.
 * Token validation and consumption happen in cleanup-preflight before this
 * function is reachable; this boundary accepts only the detailed-review and
 * explicit persisted direct-cleanup modes that preflight already bound.
 */
export function initializeReviewedCleanupReport({ approval, settings, repair = {}, now = () => Date.now() }) {
  const approvalMode = approval?.approvalMode;
  if (!approval || typeof approval !== 'object' || !['detailed_review', 'settings_direct'].includes(approvalMode)) {
    throw new Error(
      'A complete per-run cleanup review is required unless a valid settings-direct authorization was consumed. Start the cleanup again.'
    );
  }
  if (approvalMode === 'settings_direct' && settings?.skipCleanupReview !== true) {
    throw new Error('Direct cleanup is not enabled in the approved settings. Start the cleanup again.');
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
  const hostPermissionInventory = buildHostPermissionInventory({
    requiredOrigins: target.hostPermissionOrigins || [],
    coveredRequiredOrigins: approval.preexistingHostPermissionOrigins || [],
    grantedOrigins:
      approval.hostPermissionInventory?.grantedHostPermissionOrigins || approval.preexistingHostPermissionOrigins || []
  });

  report.sourceIncognito = Boolean(approval.sourceIncognito);
  report.hostPermissionInventory = {
    reviewedPreflight: hostPermissionInventory,
    beforeRelease: null,
    afterRelease: null
  };
  report.summary.cleanupMode = settings?.cleanupMode === 'expert' ? 'expert' : 'standard';
  const usedDetailedReview = approvalMode === 'detailed_review';
  report.summary.cleanupApprovalMode = approvalMode;
  report.summary.cleanupApprovalSchemaVersion = CLEANUP_AUTHORIZATION_SCHEMA_VERSION;
  report.summary.cleanupPreflightApproved = true;
  report.summary.activeJobPersistent = true;
  report.summary.associatedTargetsIncluded = associated.applied.length;
  report.summary.cleanupPreflightCreatedAt = cleanupPreflightCreatedAt;
  report.summary.scopeReviewApproved = usedDetailedReview;
  report.summary.settingsDirectCleanupAuthorized = !usedDetailedReview;
  report.summary.scopeReviewCreatedAt = usedDetailedReview ? scopeReviewApprovedAt : null;
  report.summary.directCleanupAuthorizedAt = usedDetailedReview ? null : scopeReviewApprovedAt;
  report.summary.scopeReviewApprovedFileCandidates = usedDetailedReview ? approvedDownloadFileIds.length : 0;
  report.summary.preflightBoundFileCandidates = approvedDownloadFileIds.length;
  report.summary.extensionStatePreflightRan = true;
  report.summary.extensionStateRepaired = Boolean(repair.repaired);
  report.summary.staleJobRecovered = Boolean(repair.staleJobRecovered);
  report.summary.allSitesAccessGranted = hostPermissionInventory.allSitesAccessGranted;
  report.summary.broadHostPermissionOriginsGranted = hostPermissionInventory.broadGrantedHostPermissionOrigins.length;
  report.summary.exactRequiredHostPermissionOriginsGranted =
    hostPermissionInventory.exactGrantedHostPermissionOrigins.length;

  addSection(
    report,
    'extensionHealth',
    repair.repaired
      ? 'SiteWipe recovery preflight repaired extension-owned state'
      : 'SiteWipe recovery preflight found healthy extension-owned state',
    repair.repaired ? 'success' : 'info',
    repair
  );
  addSection(
    report,
    'cleanupReview',
    usedDetailedReview ? 'Cleanup scope reviewed and approved' : 'Cleanup scope bound to saved direct authorization',
    'success',
    {
      target: target.matchMode === 'exact_origin' ? target.exactOrigin : target.domain,
      matchMode: target.matchMode || 'registrable_domain',
      associatedTargetCount: target.associatedTargets?.length || 0,
      sourceIncognito: Boolean(approval.sourceIncognito),
      approvalMode,
      approvalSchemaVersion: CLEANUP_AUTHORIZATION_SCHEMA_VERSION,
      requiredHostPermissionOrigins: hostPermissionInventory.requiredHostPermissionOrigins,
      exactPreexistingHostPermissionOrigins: hostPermissionInventory.exactRequiredHostPermissionOrigins,
      requiredOriginsCoveredByBroaderAccess: hostPermissionInventory.requiredCoveredByBroadHostPermissionOrigins,
      broadPreexistingHostPermissionOrigins: hostPermissionInventory.broadGrantedHostPermissionOrigins,
      allSitesAccessGranted: hostPermissionInventory.allSitesAccessGranted,
      privateWindowScopeIncluded: Boolean(approval.incognitoAccess),
      requestShieldRequested: Boolean(
        settings?.temporaryDnrShield !== false || settings?.postWipeSessionBlock === true
      ),
      requestShieldEligibleForReviewedScope: Boolean(
        approval.incognitoAccess === true &&
        (settings?.temporaryDnrShield !== false || settings?.postWipeSessionBlock === true)
      ),
      preflightBoundDownloadedFileCandidates: approvedDownloadFileIds.length,
      preflightAt: cleanupPreflightCreatedAt,
      reviewedAt: usedDetailedReview ? scopeReviewApprovedAt : null,
      directlyAuthorizedAt: usedDetailedReview ? null : scopeReviewApprovedAt,
      note: usedDetailedReview
        ? 'A complete per-run review and its single-use, short-lived approval were consumed before extension-state recovery, request shielding, or browser-data mutation began.'
        : 'The saved Skip detailed cleanup review completely setting authorized this run. A fresh read-only preflight still bound the exact target, settings, private scope, host access, impact, and downloaded-file candidates before the single-use authorization was consumed.'
    }
  );
  if (associated.applied.length || associated.errors.length || associated.warnings.length) {
    addSection(
      report,
      'associatedDomains',
      associated.applied.length ? 'Associated-domain group applied' : 'Associated-domain groups checked',
      associated.errors.length || associated.warnings.length ? 'partial' : 'success',
      {
        ...associated,
        note: associated.applied.length
          ? usedDetailedReview
            ? 'These displayed and approved associated domains/origins are included in tabs, cookies, storage origins, history, downloads, and request shielding for this run after browser-service safety checks.'
            : 'These associated domains/origins were freshly resolved and immutably bound under the saved direct-cleanup authorization, then included after browser-service safety checks.'
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

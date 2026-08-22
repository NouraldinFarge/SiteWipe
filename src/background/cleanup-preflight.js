import { normalizeSiteInput, applyAssociatedDomainGroups } from './domain.js';
import { findProtectedBrowserServiceTargets } from '../shared/safety.js';
import { getEffectiveCleanupSettings } from '../shared/cleanup-mode.js';
import { buildCleanupReview, validateCleanupReviewApproval } from '../shared/cleanup-review.js';
import { normalizeStoredSettings } from '../shared/storage.js';
import {
  buildHostPermissionInventory,
  canonicalizeHostPermissionOrigin,
  canonicalizeHostPermissionOrigins,
  normalizeHostPermissionInventory
} from '../shared/host-permissions.js';
import {
  markPermissionLeaseActive,
  markPermissionLeasePromptPending,
  getPermissionLease,
  preparePermissionLease,
  reconcilePermissionLease,
  restorePermissionLeasePromptOwnership
} from './permission-leases.js';

export const CLEANUP_REVIEW_STORAGE_KEY = 'sitewipe.cleanupReview.v1';
export const CLEANUP_REVIEW_TTL_MS = 5 * 60 * 1000;
export const CLEANUP_APPROVAL_HANDOFF_SCHEMA_VERSION = 1;
// Schema 8 also binds every review to the exact popup context Chrome reported
// at preparation time and to a worker-minted capability digest. Raw
// capabilities are never persisted. Legacy records are discarded before any
// cleanup can begin.
export const CLEANUP_REVIEW_SCHEMA_VERSION = 8;
const MAX_APPROVED_DOWNLOAD_FILE_IDS = 1000;
const MAX_PREVIEW_LIMITATIONS = 50;
const MAX_PREVIEW_LIMITATION_LENGTH = 1000;
const REVIEW_IDENTIFIER_PATTERN = /^[a-zA-Z0-9._:-]{8,128}$/;
const POPUP_PREPARATION_CAPABILITY_PATTERN = /^[a-f0-9]{64}$/;
const POPUP_PREPARATION_CAPABILITY_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export async function prepareCleanupReviewRequest(payload = {}, dependencies = {}) {
  const {
    getSettings,
    isIncognitoAllowed,
    inspectSourceWindow,
    hasHostPermissions,
    getAllHostPermissions,
    inspectImpact,
    storageSession,
    storageLocal: configuredStorageLocal,
    containsHostPermissions: configuredContainsHostPermissions,
    now = () => Date.now(),
    createToken = randomApprovalToken,
    createHandoffNonce = randomApprovalToken,
    createPopupPreparationCapability = randomPopupPreparationCapability
  } = dependencies;
  const storageLocal = configuredStorageLocal || storageSession?.durable;
  const containsHostPermissions = configuredContainsHostPermissions || hasHostPermissions;
  dependencies = { ...dependencies, storageLocal, containsHostPermissions };
  const preparationContextId = normalizePopupContextId(dependencies.preparationContextId);
  assertDependencies({
    getSettings,
    isIncognitoAllowed,
    inspectSourceWindow,
    hasHostPermissions,
    inspectImpact,
    storageSession,
    storageLocal,
    containsHostPermissions
  });

  const createdAtMs = Number(now());
  if (!Number.isFinite(createdAtMs)) throw new Error('Cleanup review clock is unavailable.');
  const { sourceWindowId, sourceIncognito } = await verifySourceWindowContext(payload, inspectSourceWindow);
  if (!preparationContextId) {
    throw new Error('The popup context preparing Chrome target access could not be verified. Reopen SiteWipe.');
  }
  const popupPreparationCapability = String(await createPopupPreparationCapability());
  if (!POPUP_PREPARATION_CAPABILITY_PATTERN.test(popupPreparationCapability)) {
    throw new Error('Cleanup popup capability generation failed.');
  }
  const popupPreparationCapabilityDigest = await digestCleanupPopupPreparationCapability(popupPreparationCapability);
  dependencies = {
    ...dependencies,
    preparationContextId,
    popupPreparationCapability,
    popupPreparationCapabilityDigest
  };
  const existingState = await readRecordState(storageSession);
  if (existingState.invalid) {
    const invalidRecovery = await discardInvalidCleanupReview(storageSession, dependencies);
    if (invalidRecovery?.recordRetained) {
      throw new Error(
        'An invalid cleanup review and unresolved temporary target-access lease were found. Retry maintenance or revoke SiteWipe site access in the browser before continuing.'
      );
    }
  }
  const existingRecord = existingState.record;
  if (existingRecord) {
    if (existingRecord.approvalHandoff?.status === 'prompt_tombstone') {
      throw new Error(
        'A canceled or expired Chrome target-access prompt is still being reconciled. Close any native prompt or restart the browser before reviewing again.'
      );
    }
    if (Number.isFinite(existingRecord.expiresAtMs) && createdAtMs <= existingRecord.expiresAtMs) {
      const resumed = await resumeEquivalentCleanupReview(payload, existingRecord, {
        ...dependencies,
        sourceWindowId,
        sourceIncognito
      });
      if (resumed) return resumed;
      throw new Error(
        'Another cleanup review is active. Reopen its original target to resume and cancel it. If a Chrome site-access prompt may still be open, close it or restart the browser before reviewing a different target.'
      );
    }
    if (cleanupReviewPromptMayStillSettle(existingRecord, dependencies)) {
      await storageSession.set({
        [CLEANUP_REVIEW_STORAGE_KEY]: createPromptTombstoneRecord(existingRecord, createdAtMs, 'cleanup_review_expired')
      });
      throw new Error(
        'An expired Chrome target-access prompt is still being reconciled. Close any native prompt or restart the browser before reviewing again.'
      );
    }
    const expiredRemoval = await removeReviewAndReleaseUnlessPromptOwnerArrived(existingRecord, dependencies, {
      tombstoneReason: 'cleanup_review_expired'
    });
    if (expiredRemoval.promptTombstoneRetained) {
      throw new Error(
        'An expired Chrome target-access prompt is still being reconciled. Close any native prompt or restart the browser before reviewing again.'
      );
    }
  }

  const orphanedLease = await reconcilePermissionLease(storageLocal, {
    containsHostPermissions,
    getAllHostPermissions,
    releaseHostPermissions: dependencies.releaseHostPermissions,
    now
  });
  if (orphanedLease.recordRetained) {
    throw new Error(
      'SiteWipe still has an unresolved temporary target-access lease. Revoke its site access in the browser extension settings or retry maintenance before starting another cleanup.'
    );
  }

  const scope = resolveCleanupReviewScope(payload.input, await getSettings());
  const { settings, normalized, associated, target } = scope;

  const incognitoAccess = Boolean(await isIncognitoAllowed());
  if (sourceIncognito && !incognitoAccess) {
    throw new Error(
      'Private-window cleanup requires Allow in incognito to be enabled for SiteWipe in chrome://extensions or brave://extensions. Chrome/Brave keep this permission under user control.'
    );
  }

  const requestedHostPermissionOrigins = normalizeOrigins(target.hostPermissionOrigins);
  const preexistingHostPermissionOrigins = await getGrantedHostPermissionOrigins(
    requestedHostPermissionOrigins,
    containsHostPermissions,
    { failOnError: true }
  );
  const grantedHostPermissionOrigins = await inspectGrantedHostPermissionOrigins(
    getAllHostPermissions,
    preexistingHostPermissionOrigins
  );
  const hostPermissionInventory = buildHostPermissionInventory({
    requiredOrigins: requestedHostPermissionOrigins,
    coveredRequiredOrigins: preexistingHostPermissionOrigins,
    grantedOrigins: grantedHostPermissionOrigins
  });
  const hostPermissionsGranted =
    requestedHostPermissionOrigins.length > 0 &&
    preexistingHostPermissionOrigins.length === requestedHostPermissionOrigins.length;
  if (sourceIncognito && !hostPermissionsGranted) {
    throw new Error(
      'Private-window cleanup requires the exact reviewed target site access to be granted before preflight. SiteWipe does not persist private target patterns in a durable permission lease.'
    );
  }
  const impact = normalizeImpactSnapshot(await inspectImpact(target, { ...settings, incognitoAccess }));
  const expiresAtMs = createdAtMs + CLEANUP_REVIEW_TTL_MS;
  const approvalToken = String(await createToken());
  if (!REVIEW_IDENTIFIER_PATTERN.test(approvalToken)) throw new Error('Cleanup approval token generation failed.');
  const approvalHandoffNonce = hostPermissionsGranted ? null : String(await createHandoffNonce());
  if (approvalHandoffNonce !== null && !REVIEW_IDENTIFIER_PATTERN.test(approvalHandoffNonce)) {
    throw new Error('Cleanup handoff nonce generation failed.');
  }
  const review = buildCleanupReview({
    enteredTarget: normalized.input,
    target,
    settings,
    sourceWindowId,
    sourceIncognito,
    incognitoAccess,
    hostPermissionsGranted,
    hostPermissionInventory,
    impact,
    approvalToken,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString()
  });
  review.temporaryHostPermissionOrigins = requestedHostPermissionOrigins.filter(
    (origin) => !preexistingHostPermissionOrigins.includes(origin)
  );
  if (approvalHandoffNonce) review.approvalHandoffNonce = approvalHandoffNonce;
  const approvedDownloadFileIds = Array.isArray(impact.matchedCompletedFileIds) ? impact.matchedCompletedFileIds : [];
  let permissionLease = await preparePermissionLease(storageLocal, {
    requestedOrigins: requestedHostPermissionOrigins,
    preexistingOrigins: preexistingHostPermissionOrigins,
    reviewExpiresAt: review.expiresAt,
    now
  });
  if (permissionLease) {
    try {
      permissionLease = await markPermissionLeasePromptPending(storageLocal, permissionLease.id, now);
      if (!permissionLease) throw new Error('The durable target-access prompt lease could not be armed.');
    } catch (error) {
      await reconcilePermissionLease(
        storageLocal,
        {
          containsHostPermissions,
          getAllHostPermissions,
          releaseHostPermissions: dependencies.releaseHostPermissions,
          forcePromptSettlement: true,
          now
        },
        permissionLease?.id
      ).catch(() => {});
      throw error;
    }
  }
  review.permissionLeaseId = permissionLease?.id || null;

  const record = {
    schemaVersion: CLEANUP_REVIEW_SCHEMA_VERSION,
    token: approvalToken,
    approvalMode: review.approvalMode,
    createdAtMs,
    expiresAtMs,
    canonicalInput: target.matchMode === 'exact_origin' ? target.exactOrigin : target.domain,
    target: cloneJson(target),
    settings: cloneJson(settings),
    associated: cloneJson({
      applied: associated.applied || [],
      errors: associated.errors || [],
      warnings: associated.warnings || []
    }),
    sourceWindowId,
    sourceIncognito,
    preparationContextId,
    popupPreparationCapabilityDigest,
    incognitoAccess,
    hostPermissionsGranted,
    preexistingHostPermissionOrigins: cloneJson(preexistingHostPermissionOrigins),
    hostPermissionInventory: cloneJson(hostPermissionInventory),
    requirements: cloneJson(review.requirements),
    impact: cloneJson(impact),
    // Bind the complete displayed authority without persisting a user-entered
    // path, query, or fragment. Those details are not part of cleanup scope.
    reviewSnapshot: cloneJson({ ...review, enteredTarget: recordSafeEnteredTarget(target) }),
    approvedDownloadFileIds: cloneJson(approvedDownloadFileIds),
    permissionLeaseId: review.permissionLeaseId,
    approvalHandoffNonce,
    approvalHandoff: null
  };
  try {
    await storageSession.set({ [CLEANUP_REVIEW_STORAGE_KEY]: record });
  } catch (error) {
    if (permissionLease) {
      await reconcilePermissionLease(
        storageLocal,
        {
          containsHostPermissions,
          getAllHostPermissions,
          releaseHostPermissions: dependencies.releaseHostPermissions,
          forcePromptSettlement: true,
          now
        },
        permissionLease.id
      ).catch(() => {});
    }
    throw error;
  }
  return { review, popupContextId: preparationContextId, popupPreparationCapability };
}

async function resumeEquivalentCleanupReview(payload, record, dependencies) {
  const {
    getSettings,
    isIncognitoAllowed,
    containsHostPermissions,
    storageLocal,
    storageSession,
    sourceWindowId,
    sourceIncognito
  } = dependencies;
  if (
    sourceWindowId !== record.sourceWindowId ||
    sourceIncognito !== Boolean(record.sourceIncognito) ||
    typeof getSettings !== 'function' ||
    typeof isIncognitoAllowed !== 'function'
  ) {
    return null;
  }

  const currentScope = resolveCleanupReviewScope(payload.input, await getSettings());
  const currentAssociated = {
    applied: currentScope.associated.applied || [],
    errors: currentScope.associated.errors || [],
    warnings: currentScope.associated.warnings || []
  };
  if (
    !settingsAuthorityEquivalent(currentScope.settings, record.settings) ||
    !jsonEquivalent(currentScope.target, record.target) ||
    !jsonEquivalent(currentAssociated, record.associated) ||
    Boolean(await isIncognitoAllowed()) !== record.incognitoAccess
  ) {
    return null;
  }

  const requestedOrigins = normalizeOrigins(currentScope.target.hostPermissionOrigins);
  const currentCoveredOrigins = await getGrantedHostPermissionOrigins(requestedOrigins, containsHostPermissions, {
    failOnError: true
  });
  if (record.permissionLeaseId) {
    const lease = await getPermissionLease(storageLocal);
    const expectedLeaseStatuses = record.approvalHandoff ? ['prompt_pending', 'active_cleanup'] : ['prompt_pending'];
    if (!lease || lease.id !== record.permissionLeaseId || !expectedLeaseStatuses.includes(lease.status)) {
      return null;
    }
    if (!permissionLeaseMatchesReview(lease, record, requestedOrigins)) return null;
  }
  const preflightAccessIsUnchanged = jsonEquivalent(currentCoveredOrigins, record.preexistingHostPermissionOrigins);
  if (!preflightAccessIsUnchanged && !record.approvalHandoff) return null;

  const preparationContextId = normalizePopupContextId(dependencies.preparationContextId);
  const popupPreparationCapabilityDigest = normalizePopupCapabilityDigest(
    dependencies.popupPreparationCapabilityDigest
  );
  if (!preparationContextId || !popupPreparationCapabilityDigest || !storageSession?.set) return null;

  // A final-click handoff owns prompt settlement and cannot be rebound or have
  // its capability rotated. The worker resumes it independently of popup
  // lifetime. Before a handoff, same-context retry may rotate its capability.
  if (record.approvalHandoff || getPendingPromptContextId(record, dependencies)) return null;
  if (preparationContextId !== record.preparationContextId) {
    if (typeof dependencies.isPreparationContextActive !== 'function') return null;
    if (await dependencies.isPreparationContextActive(record.preparationContextId)) return null;
    if (record.permissionLeaseId) {
      // A missing-access review may have invoked Chrome's native prompt just
      // before its popup disappeared. Without a retired-owner handshake, never
      // transfer it to a new context. Retain non-runnable settlement ownership
      // until the browser-session boundary can reconcile the lease.
      await storageSession.set({
        [CLEANUP_REVIEW_STORAGE_KEY]: createPromptTombstoneRecord(
          record,
          Number(typeof dependencies.now === 'function' ? dependencies.now() : Date.now()),
          'popup_context_retired_before_prompt_settlement'
        )
      });
      throw new Error(
        'The popup that prepared Chrome target access closed before settlement could be proven. Restart the browser before preparing a fresh review.'
      );
    }
  }
  const resumedRecord = {
    ...record,
    preparationContextId,
    popupPreparationCapabilityDigest
  };
  await storageSession.set({ [CLEANUP_REVIEW_STORAGE_KEY]: resumedRecord });
  if (getPendingPromptContextId(record, dependencies)) {
    await storageSession.set({ [CLEANUP_REVIEW_STORAGE_KEY]: record });
    return null;
  }

  const review = cloneJson(resumedRecord.reviewSnapshot);
  review.enteredTarget = String(currentScope.normalized.input || payload.input || '');
  if (resumedRecord.approvalHandoff) {
    review.approvalHandoffArmed = resumedRecord.approvalHandoff.status === 'armed';
    review.approvalHandoffStatus = resumedRecord.approvalHandoff.status;
    review.approvalHandoffNonce = resumedRecord.approvalHandoff.nonce;
  }
  return {
    review,
    resumed: true,
    popupContextId: preparationContextId,
    popupPreparationCapability: dependencies.popupPreparationCapability
  };
}

function permissionLeaseMatchesReview(lease, record, requestedOrigins) {
  const binding = permissionLeaseBindingForReview(record, requestedOrigins);
  return (
    jsonEquivalent(lease.requestedOrigins, binding.requestedOrigins) &&
    jsonEquivalent(lease.preexistingOrigins, binding.preexistingOrigins) &&
    jsonEquivalent(lease.temporaryOrigins, binding.temporaryOrigins) &&
    lease.reviewExpiresAt === binding.reviewExpiresAt
  );
}

function permissionLeaseBindingForReview(record, requestedOrigins) {
  const preexistingOrigins = normalizeOrigins(record.preexistingHostPermissionOrigins);
  const preexistingSet = new Set(preexistingOrigins);
  const temporaryOrigins = requestedOrigins.filter((origin) => !preexistingSet.has(origin));
  return {
    requestedOrigins,
    preexistingOrigins,
    temporaryOrigins,
    reviewExpiresAt: new Date(record.expiresAtMs).toISOString()
  };
}

async function inspectLeaseOwnedPromptGrantTransition({
  record,
  lease,
  requestedOrigins,
  currentCoveredOrigins,
  getAllHostPermissions,
  allowedLeaseStatuses = ['prompt_pending']
}) {
  if (
    !allowedLeaseStatuses.includes(lease?.status) ||
    typeof getAllHostPermissions !== 'function' ||
    !jsonEquivalent(currentCoveredOrigins, requestedOrigins)
  ) {
    return null;
  }

  const currentGrantedOrigins = await inspectGrantedHostPermissionOrigins(getAllHostPermissions);
  const currentExactGrants = new Set(currentGrantedOrigins);
  if (lease.temporaryOrigins.some((origin) => !currentExactGrants.has(origin))) return null;

  const expectedInventory = buildHostPermissionInventory({
    requiredOrigins: requestedOrigins,
    coveredRequiredOrigins: requestedOrigins,
    grantedOrigins: [...(record.hostPermissionInventory?.grantedHostPermissionOrigins || []), ...lease.temporaryOrigins]
  });
  const currentInventory = buildHostPermissionInventory({
    requiredOrigins: requestedOrigins,
    coveredRequiredOrigins: currentCoveredOrigins,
    grantedOrigins: currentGrantedOrigins
  });
  return jsonEquivalent(currentInventory, expectedInventory) ? currentInventory : null;
}

export async function assertLeaseOwnedCleanupPermissionInventory(record, dependencies = {}, options = {}) {
  if (!record?.permissionLeaseId || !record?.approvalHandoff) return null;
  const requestedOrigins = normalizeOrigins(record.target?.hostPermissionOrigins);
  const lease = dependencies.lease || (await getPermissionLease(dependencies.storageLocal));
  if (
    !lease ||
    lease.id !== record.permissionLeaseId ||
    !permissionLeaseMatchesReview(lease, record, requestedOrigins)
  ) {
    throw new Error('The durable target-access lease changed before cleanup admission. Start again.');
  }
  const currentCoveredOrigins = await getGrantedHostPermissionOrigins(
    requestedOrigins,
    dependencies.containsHostPermissions || dependencies.hasHostPermissions,
    { failOnError: true }
  );
  const inventory = await inspectLeaseOwnedPromptGrantTransition({
    record,
    lease,
    requestedOrigins,
    currentCoveredOrigins,
    getAllHostPermissions: dependencies.getAllHostPermissions,
    allowedLeaseStatuses: options.allowedLeaseStatuses || ['prompt_pending', 'active_cleanup']
  });
  if (!inventory) {
    throw new Error(
      'Chrome target access changed after final approval. SiteWipe requires the exact preflight-bound temporary patterns and did not admit cleanup.'
    );
  }
  return inventory;
}

export function resolveCleanupReviewScope(input, storedSettings = {}) {
  const settings = getEffectiveCleanupSettings(normalizeStoredSettings(storedSettings));
  const normalized = normalizeSiteInput(input, {
    allowLocalTargets: settings.allowLocalTargets
  });
  if (!normalized.ok) throw new Error(normalized.error);

  const associated = applyAssociatedDomainGroups(normalized.target, settings.associatedDomainGroups, {
    allowLocalTargets: settings.allowLocalTargets
  });
  if (settings.blockOnAssociatedGroupErrors !== false && associated.errors?.length) {
    throw new Error(
      `Associated-domain groups contain ${associated.errors.length} error(s). Fix them in Options or disable the associated-group error gate before starting cleanup.`
    );
  }

  const target = associated.target || normalized.target;
  const protectedTargets = findProtectedBrowserServiceTargets(target);
  if (protectedTargets.length) {
    throw new Error(
      `Cleanup is blocked for ${protectedTargets[0].targetHost} to protect browser Sync and browser-account state. SiteWipe never cleans browser-service targets.`
    );
  }
  return { settings, normalized, associated, target };
}

export async function cancelCleanupReviewRequest(payload = {}, dependencies = {}) {
  const storageSession = dependencies.storageSession;
  dependencies = {
    ...dependencies,
    storageLocal: dependencies.storageLocal || storageSession?.durable
  };
  if (!storageSession?.get || !storageSession?.set || !storageSession?.remove)
    throw new Error('Cleanup review session storage is unavailable.');
  const token = String(payload.approvalToken || '');
  const state = await readRecordState(storageSession);
  if (state.invalid) {
    return {
      canceled: false,
      invalidReviewDiscarded: true,
      hostPermissionCleanup: await discardInvalidCleanupReview(storageSession, dependencies)
    };
  }
  const record = state.record;
  if (!record || !token || record.token !== token) return { canceled: false };
  if (dependencies.requirePopupPreparationCapability === true) {
    await assertCleanupReviewPopupBinding(record, payload);
  }
  const pendingPromptContextId = getPendingPromptContextId(record, dependencies);
  const promptNotStartedByPreparingContext = Boolean(
    dependencies.promptNotStartedContextId &&
    normalizePopupContextId(dependencies.promptNotStartedContextId) === record.preparationContextId &&
    !record.approvalHandoff &&
    !pendingPromptContextId
  );
  if (promptNotStartedByPreparingContext) dependencies = { ...dependencies, promptNotStartedProven: true };
  if (cleanupReviewPromptMayStillSettle(record, dependencies) && dependencies.promptSettled !== true) {
    await storageSession.set({
      [CLEANUP_REVIEW_STORAGE_KEY]: createPromptTombstoneRecord(
        record,
        Number(typeof dependencies.now === 'function' ? dependencies.now() : Date.now()),
        dependencies.tombstoneReason || 'cleanup_review_canceled',
        getPendingPromptContextId(record, dependencies)
      )
    });
    return {
      canceled: true,
      authorityRevoked: true,
      promptTombstoneRetained: true,
      hostPermissionCleanup: promptSettlementPendingResult(record)
    };
  }
  const removal = await removeReviewAndReleaseUnlessPromptOwnerArrived(
    record,
    { ...dependencies, forcePromptSettlement: true },
    {
      tombstoneReason: dependencies.tombstoneReason || 'cleanup_review_canceled'
    }
  );
  return {
    canceled: true,
    ...(removal.promptTombstoneRetained ? { authorityRevoked: true, promptTombstoneRetained: true } : {}),
    hostPermissionCleanup: removal.hostPermissionCleanup
  };
}

export async function stageCleanupReviewApprovalRequest(payload = {}, dependencies = {}) {
  const storageSession = dependencies.storageSession;
  const now = dependencies.now || (() => Date.now());
  if (!storageSession?.get || !storageSession?.set) {
    throw new Error('Cleanup review session storage is unavailable.');
  }

  const token = String(payload.approvalToken || '');
  const state = await readRecordState(storageSession);
  if (state.invalid) {
    await discardInvalidCleanupReview(storageSession, dependencies);
    throw new Error('The stored cleanup approval failed integrity validation and was discarded. Start again.');
  }
  const record = state.record;
  if (!record || !token || record.token !== token) {
    throw new Error('This cleanup approval is missing, expired, or has already been used. Start again.');
  }
  if (dependencies.requirePopupPreparationCapability === true) {
    await assertCleanupReviewPopupBinding(record, payload);
  }
  if (!record.permissionLeaseId || record.hostPermissionsGranted) {
    throw new Error('A permission handoff is only available for the exact missing target access in this review.');
  }

  const normalizedApproval = normalizeApprovalForHandoff(payload.approval, record.approvalMode);
  const approvalValidation = normalizedApproval
    ? validateCleanupReviewApproval(record.requirements, normalizedApproval, record.approvalMode)
    : { ok: false };
  if (!normalizedApproval || !approvalValidation.ok) {
    throw new Error('The cleanup approval could not be armed safely. Start again.');
  }
  const nonce = String(payload.handoffNonce || '');
  if (!REVIEW_IDENTIFIER_PATTERN.test(nonce) || nonce !== record.approvalHandoffNonce) {
    throw new Error('The cleanup handoff no longer matches the prepared review. Start again.');
  }
  const promptContextId = normalizePopupContextId(payload.popupContextId || dependencies.promptContextId);
  if (!promptContextId) {
    throw new Error('The initiating popup context could not be bound to the Chrome permission prompt. Start again.');
  }

  if (!record.approvalHandoff && record.preparationContextId !== promptContextId) {
    // permissions.request() was already invoked by this mismatched popup. It
    // may still grant after this rejection, so retain exact, non-runnable
    // settlement ownership rather than merely denying the staged approval.
    await storageSession.set({
      [CLEANUP_REVIEW_STORAGE_KEY]: createPromptTombstoneRecord(
        record,
        Number(now()),
        'approval_preparation_context_changed',
        promptContextId
      )
    });
    throw new Error('The popup context preparing this cleanup changed. Start again after prompt settlement.');
  }

  if (record.approvalHandoff) {
    if (
      !['arming', 'armed'].includes(record.approvalHandoff.status) ||
      record.approvalHandoff.promptContextId !== promptContextId ||
      !approvalHandoffMatchesPayload(record.approvalHandoff, record, payload, normalizedApproval)
    ) {
      throw new Error('This cleanup approval is already continuing or no longer matches the final approval.');
    }
    return {
      approvalStaged: true,
      approvalArmed: record.approvalHandoff.status === 'armed',
      handoffStatus: record.approvalHandoff.status,
      handoffNonce: record.approvalHandoff.nonce,
      expiresAt: new Date(record.expiresAtMs).toISOString()
    };
  }

  const armingAtMs = Number(now());
  const boundedArmingAtMs = Number.isFinite(armingAtMs)
    ? Math.max(record.createdAtMs, Math.min(armingAtMs, record.expiresAtMs))
    : record.expiresAtMs;
  const armingHandoff = {
    schemaVersion: CLEANUP_APPROVAL_HANDOFF_SCHEMA_VERSION,
    status: 'arming',
    nonce,
    approvalToken: record.token,
    permissionLeaseId: record.permissionLeaseId,
    sourceWindowId: record.sourceWindowId,
    sourceIncognito: record.sourceIncognito,
    expiresAtMs: record.expiresAtMs,
    armedAtMs: boundedArmingAtMs,
    updatedAtMs: boundedArmingAtMs,
    promptContextId,
    approval: normalizedApproval
  };
  const armingRecord = { ...record, approvalHandoff: armingHandoff };
  if (!Number.isFinite(armingAtMs) || armingAtMs > record.expiresAtMs) {
    // The popup invokes Chrome's native permission request before dispatching
    // this marker. Even when the worker first observes the click after expiry,
    // retain exact prompt-settlement ownership so a late grant cannot escape.
    await storageSession.set({
      [CLEANUP_REVIEW_STORAGE_KEY]: createPromptTombstoneRecord(
        armingRecord,
        Number.isFinite(armingAtMs) ? armingAtMs : Date.now(),
        'approval_arrived_after_expiry'
      )
    });
    throw new Error('This cleanup approval expired. Start the cleanup again.');
  }
  await storageSession.set({ [CLEANUP_REVIEW_STORAGE_KEY]: armingRecord });
  return {
    approvalStaged: true,
    approvalArmed: false,
    handoffStatus: 'arming',
    handoffNonce: nonce,
    expiresAt: new Date(record.expiresAtMs).toISOString()
  };
}

export async function armCleanupReviewApprovalRequest(payload = {}, dependencies = {}) {
  const storageSession = dependencies.storageSession;
  dependencies = {
    ...dependencies,
    storageLocal: dependencies.storageLocal || storageSession?.durable
  };
  const now = dependencies.now || (() => Date.now());
  if (!storageSession?.get || !storageSession?.set || !storageSession?.remove) {
    throw new Error('Cleanup review session storage is unavailable.');
  }

  const staged = await stageCleanupReviewApprovalRequest(payload, dependencies);
  if (staged.approvalArmed) return staged;

  const state = await readRecordState(storageSession);
  if (state.invalid) {
    await discardInvalidCleanupReview(storageSession, dependencies);
    throw new Error('The stored cleanup approval failed integrity validation and was discarded. Start again.');
  }
  const record = state.record;
  const normalizedApproval = record ? normalizeApprovalForHandoff(payload.approval, record.approvalMode) : null;
  const promptContextId = normalizePopupContextId(payload.popupContextId || dependencies.promptContextId);
  if (
    !record ||
    !normalizedApproval ||
    record.token !== String(payload.approvalToken || '') ||
    record.approvalHandoff?.status !== 'arming' ||
    record.approvalHandoff.promptContextId !== promptContextId ||
    !approvalHandoffMatchesPayload(record.approvalHandoff, record, payload, normalizedApproval)
  ) {
    throw new Error('This cleanup approval changed before authority could be revalidated. Start again.');
  }
  const armingRecord = record;
  const armingHandoff = record.approvalHandoff;
  try {
    await revalidateCleanupReviewAuthority(armingRecord, payload, dependencies, {
      activatePermissionLease: false
    });
    const promptLease = await markPermissionLeasePromptPending(
      dependencies.storageLocal,
      record.permissionLeaseId,
      now
    );
    if (!promptLease) {
      throw new Error('The durable target-access prompt lease changed before the approval could be armed.');
    }
    const armedAtMs = Number(now());
    if (!Number.isFinite(armedAtMs) || armedAtMs > record.expiresAtMs) {
      throw new Error('This cleanup approval expired while Chrome target access was being requested.');
    }
    const approvalHandoff = {
      ...armingHandoff,
      status: 'armed',
      updatedAtMs: Math.max(armedAtMs, armingHandoff.armedAtMs)
    };
    await storageSession.set({
      [CLEANUP_REVIEW_STORAGE_KEY]: {
        ...record,
        approvalHandoff
      }
    });
  } catch (error) {
    await storageSession
      .set({
        [CLEANUP_REVIEW_STORAGE_KEY]: createPromptTombstoneRecord(
          armingRecord,
          Number(now()),
          'approval_authority_rejected'
        )
      })
      .catch(() => {});
    throw error;
  }
  return {
    approvalStaged: true,
    approvalArmed: true,
    handoffStatus: 'armed',
    handoffNonce: armingHandoff.nonce,
    expiresAt: new Date(record.expiresAtMs).toISOString()
  };
}

export async function getReadyArmedCleanupReview(dependencies = {}) {
  const storageSession = dependencies.storageSession;
  const storageLocal = dependencies.storageLocal || storageSession?.durable;
  if (!storageSession?.get || !storageLocal?.get) return null;
  const state = await readRecordState(storageSession);
  if (state.invalid || !state.record?.approvalHandoff) return null;
  const record = state.record;
  const handoff = record.approvalHandoff;
  if (handoff.status !== 'armed') return null;
  const nowMs = Number(typeof dependencies.now === 'function' ? dependencies.now() : Date.now());
  if (!Number.isFinite(nowMs) || nowMs > record.expiresAtMs) return null;

  const requestedOrigins = normalizeOrigins(record.target?.hostPermissionOrigins);
  const lease = await getPermissionLease(storageLocal);
  if (
    !lease ||
    lease.id !== record.permissionLeaseId ||
    lease.status !== 'prompt_pending' ||
    !permissionLeaseMatchesReview(lease, record, requestedOrigins)
  ) {
    return null;
  }
  const currentCoveredOrigins = await getGrantedHostPermissionOrigins(
    requestedOrigins,
    dependencies.containsHostPermissions || dependencies.hasHostPermissions,
    { failOnError: true }
  );
  const inventory = await inspectLeaseOwnedPromptGrantTransition({
    record,
    lease,
    requestedOrigins,
    currentCoveredOrigins,
    getAllHostPermissions: dependencies.getAllHostPermissions,
    allowedLeaseStatuses: ['prompt_pending']
  });
  if (!inventory) return null;
  return {
    handoffNonce: handoff.nonce,
    handoffStatus: handoff.status,
    expiresAt: new Date(record.expiresAtMs).toISOString(),
    payload: {
      approvalToken: record.token,
      approval: cloneJson(handoff.approval),
      sourceWindowId: handoff.sourceWindowId,
      sourceIncognito: handoff.sourceIncognito
    }
  };
}

export async function finalizeArmedCleanupReviewAdmission(payload = {}, storageSession) {
  if (!storageSession?.get || !storageSession?.remove) {
    throw new Error('Cleanup review session storage is unavailable.');
  }
  const state = await readRecordState(storageSession);
  if (state.invalid) throw new Error('The cleanup handoff record failed integrity validation.');
  const record = state.record;
  if (!record) throw new Error('The cleanup handoff record disappeared before durable job admission.');
  if (
    record.token !== String(payload.approvalToken || '') ||
    record.approvalHandoff?.nonce !== String(payload.handoffNonce || '') ||
    record.approvalHandoff?.status !== 'admitting'
  ) {
    throw new Error('The cleanup handoff changed before durable job admission.');
  }
  await storageSession.remove(CLEANUP_REVIEW_STORAGE_KEY);
  return { finalized: true };
}

export async function consumeCleanupReviewRequest(payload = {}, dependencies = {}) {
  const storageSession = dependencies.storageSession;
  dependencies = {
    ...dependencies,
    storageLocal: dependencies.storageLocal || storageSession?.durable
  };
  const now = dependencies.now || (() => Date.now());
  if (!storageSession?.get || !storageSession?.set || !storageSession?.remove)
    throw new Error('Cleanup review session storage is unavailable.');

  const token = String(payload.approvalToken || '');
  const state = await readRecordState(storageSession);
  if (state.invalid) {
    await discardInvalidCleanupReview(storageSession, dependencies);
    const error = new Error(
      'The stored cleanup approval failed integrity validation and was discarded. Start the cleanup again.'
    );
    error.name = 'InvalidCleanupReviewError';
    throw error;
  }
  const record = state.record;
  if (!record || !token || record.token !== token) {
    throw new Error('This cleanup approval is missing, expired, or has already been used. Start the cleanup again.');
  }
  if (dependencies.requirePopupPreparationCapability === true) {
    await assertCleanupReviewPopupBinding(record, payload);
  }

  try {
    let consumedRecord = record;
    if (record.approvalHandoff) {
      if (
        record.approvalHandoff.status !== 'armed' ||
        String(dependencies.expectedApprovalHandoffNonce || '') !== record.approvalHandoff.nonce ||
        !approvalHandoffMatchesPayload(
          record.approvalHandoff,
          record,
          payload,
          normalizeApprovalForHandoff(payload.approval, record.approvalMode)
        )
      ) {
        throw new Error('The worker-owned cleanup handoff is missing or does not match this approval.');
      }
      const admittingAtMs = Number(now());
      if (!Number.isFinite(admittingAtMs)) throw new Error('Cleanup handoff clock is unavailable.');
      consumedRecord = {
        ...record,
        approvalHandoff: {
          ...record.approvalHandoff,
          status: 'admitting',
          updatedAtMs: Math.max(admittingAtMs, record.approvalHandoff.armedAtMs)
        }
      };
      await storageSession.set({ [CLEANUP_REVIEW_STORAGE_KEY]: consumedRecord });
    } else {
      // Non-prompt approvals remain consume-before-validation and cannot be replayed.
      await storageSession.remove(CLEANUP_REVIEW_STORAGE_KEY);
    }

    const validation = await revalidateCleanupReviewAuthority(consumedRecord, payload, dependencies, {
      activatePermissionLease: true
    });
    return cloneJson({
      ...consumedRecord,
      approvalMode: validation.approvalMode,
      approvalHandoffNonce: consumedRecord.approvalHandoff?.nonce || null
    });
  } catch (error) {
    await storageSession.remove(CLEANUP_REVIEW_STORAGE_KEY).catch(() => {});
    await releaseTemporaryReviewAccess(record, {
      ...dependencies,
      forcePromptSettlement: true
    });
    throw error;
  }
}

async function revalidateCleanupReviewAuthority(
  record,
  payload,
  dependencies,
  { activatePermissionLease = false } = {}
) {
  const now = dependencies.now || (() => Date.now());
  if (!Number.isFinite(record.expiresAtMs) || Number(now()) > record.expiresAtMs) {
    throw new Error('This cleanup approval expired. Start the cleanup again.');
  }
  const { sourceWindowId, sourceIncognito } = await verifySourceWindowContext(
    payload,
    dependencies.inspectSourceWindow
  );
  if (sourceWindowId !== record.sourceWindowId || sourceIncognito !== Boolean(record.sourceIncognito)) {
    throw new Error('The cleanup context changed after preflight. Start again from this window.');
  }

  if (typeof dependencies.getSettings !== 'function' || typeof dependencies.isIncognitoAllowed !== 'function') {
    throw new Error('Cleanup authority revalidation is unavailable. Start the cleanup again.');
  }
  const currentScope = resolveCleanupReviewScope(record.canonicalInput, await dependencies.getSettings());
  const currentAssociated = {
    applied: currentScope.associated.applied || [],
    errors: currentScope.associated.errors || [],
    warnings: currentScope.associated.warnings || []
  };
  if (
    !settingsAuthorityEquivalent(currentScope.settings, record.settings) ||
    !jsonEquivalent(currentScope.target, record.target) ||
    !jsonEquivalent(currentAssociated, record.associated)
  ) {
    throw new Error('Cleanup settings or target scope changed after review. Start the cleanup again.');
  }
  const currentIncognitoAccess = Boolean(await dependencies.isIncognitoAllowed());
  if (currentIncognitoAccess !== record.incognitoAccess) {
    throw new Error('Private-window access changed after review. Start the cleanup again.');
  }

  if (
    record.approvalMode === 'settings_direct' &&
    (record.settings.skipCleanupReview !== true || currentScope.settings.skipCleanupReview !== true)
  ) {
    throw new Error('Direct cleanup is no longer enabled in current effective settings. Start the cleanup again.');
  }
  const validation = validateCleanupReviewApproval(record.requirements, payload.approval || {}, record.approvalMode);
  if (!validation.ok) throw new Error(validation.errors.join(' '));
  if (record.permissionLeaseId) {
    const lease = await getPermissionLease(dependencies.storageLocal);
    const requestedOrigins = normalizeOrigins(record.target?.hostPermissionOrigins);
    const admittingHandoff = record.approvalHandoff?.status === 'admitting';
    const leaseStatusAccepted =
      (!activatePermissionLease && lease?.status === 'prepared') ||
      lease?.status === 'prompt_pending' ||
      (admittingHandoff && lease?.status === 'active_cleanup');
    if (
      !lease ||
      lease.id !== record.permissionLeaseId ||
      !leaseStatusAccepted ||
      !permissionLeaseMatchesReview(lease, record, requestedOrigins)
    ) {
      throw new Error('The durable target-access lease changed after preflight. Start the cleanup again.');
    }
    if (admittingHandoff) {
      await assertLeaseOwnedCleanupPermissionInventory(
        record,
        {
          ...dependencies,
          lease
        },
        { allowedLeaseStatuses: ['prompt_pending', 'active_cleanup'] }
      );
    }
    if (activatePermissionLease && lease.status !== 'active_cleanup') {
      const activeLease = await markPermissionLeaseActive(
        dependencies.storageLocal,
        record.permissionLeaseId,
        dependencies.now || (() => Date.now()),
        permissionLeaseBindingForReview(record, requestedOrigins)
      );
      if (!activeLease) throw new Error('The durable target-access lease is missing. Start the cleanup again.');
    }
  }
  return validation;
}

function normalizeApprovalForHandoff(value, expectedMode) {
  if (!isPlainObject(value)) return null;
  const approval = {
    approvalMode: value.approvalMode,
    reviewedScope: value.reviewedScope,
    associatedTargets: value.associatedTargets,
    localOrIpTarget: value.localOrIpTarget,
    protectedWebOrigins: value.protectedWebOrigins,
    fileConfirmationText: value.fileConfirmationText
  };
  if (
    approval.approvalMode !== expectedMode ||
    !['reviewedScope', 'associatedTargets', 'localOrIpTarget', 'protectedWebOrigins'].every(
      (key) => typeof approval[key] === 'boolean'
    ) ||
    typeof approval.fileConfirmationText !== 'string'
  ) {
    return null;
  }
  return approval;
}

function approvalHandoffMatchesPayload(handoff, record, payload, normalizedApproval) {
  return Boolean(
    normalizedApproval &&
    handoff.nonce === record.approvalHandoffNonce &&
    handoff.approvalToken === record.token &&
    handoff.permissionLeaseId === record.permissionLeaseId &&
    handoff.sourceWindowId === payload.sourceWindowId &&
    handoff.sourceIncognito === payload.sourceIncognito &&
    handoff.expiresAtMs === record.expiresAtMs &&
    jsonEquivalent(handoff.approval, normalizedApproval)
  );
}

export async function clearExpiredCleanupReview(storageSession, now = Date.now(), dependencies = {}) {
  dependencies = {
    ...dependencies,
    storageSession,
    storageLocal: dependencies.storageLocal || storageSession?.durable
  };
  if (!storageSession?.get || !storageSession?.set || !storageSession?.remove) return false;
  const state = await readRecordState(storageSession);
  if (state.invalid) {
    return {
      expired: false,
      invalidReviewDiscarded: true,
      hostPermissionCleanup: await discardInvalidCleanupReview(storageSession, dependencies)
    };
  }
  const record = state.record;
  if (!record || (Number.isFinite(record.expiresAtMs) && Number(now) <= record.expiresAtMs)) return false;
  if (cleanupReviewPromptMayStillSettle(record, dependencies)) {
    await storageSession.set({
      [CLEANUP_REVIEW_STORAGE_KEY]: createPromptTombstoneRecord(
        record,
        Number(now),
        'cleanup_review_expired',
        getPendingPromptContextId(record, dependencies)
      )
    });
    return {
      expired: true,
      authorityRevoked: true,
      promptTombstoneRetained: true,
      hostPermissionCleanup: promptSettlementPendingResult(record)
    };
  }
  const removal = await removeReviewAndReleaseUnlessPromptOwnerArrived(record, dependencies, {
    tombstoneReason: 'cleanup_review_expired'
  });
  return {
    expired: true,
    ...(removal.promptTombstoneRetained ? { authorityRevoked: true, promptTombstoneRetained: true } : {}),
    hostPermissionCleanup: removal.hostPermissionCleanup
  };
}

export async function clearCleanupReviewState(storageSession, dependencies = {}) {
  dependencies = {
    ...dependencies,
    storageSession,
    storageLocal: dependencies.storageLocal || storageSession?.durable
  };
  if (!storageSession?.get || !storageSession?.set || !storageSession?.remove) {
    return { cleared: false, hostPermissionCleanup: null };
  }
  const state = await readRecordState(storageSession);
  if (state.invalid) {
    return {
      cleared: true,
      invalidReviewDiscarded: true,
      hostPermissionCleanup: await discardInvalidCleanupReview(storageSession, dependencies)
    };
  }
  const record = state.record;
  if (!record) return { cleared: false, hostPermissionCleanup: null };
  if (cleanupReviewPromptMayStillSettle(record, dependencies) && dependencies.promptSettled !== true) {
    await storageSession.set({
      [CLEANUP_REVIEW_STORAGE_KEY]: createPromptTombstoneRecord(
        record,
        Number(typeof dependencies.now === 'function' ? dependencies.now() : Date.now()),
        dependencies.tombstoneReason || 'cleanup_review_invalidated',
        getPendingPromptContextId(record, dependencies)
      )
    });
    return {
      cleared: true,
      authorityRevoked: true,
      promptTombstoneRetained: true,
      hostPermissionCleanup: promptSettlementPendingResult(record)
    };
  }
  const removal = await removeReviewAndReleaseUnlessPromptOwnerArrived(record, dependencies, {
    tombstoneReason: dependencies.tombstoneReason || 'cleanup_review_invalidated'
  });
  return {
    cleared: true,
    ...(removal.promptTombstoneRetained ? { authorityRevoked: true, promptTombstoneRetained: true } : {}),
    hostPermissionCleanup: removal.hostPermissionCleanup
  };
}

async function removeReviewAndReleaseUnlessPromptOwnerArrived(record, dependencies = {}, options = {}) {
  const storageSession = dependencies.storageSession;
  await storageSession.remove(CLEANUP_REVIEW_STORAGE_KEY);

  let hostPermissionCleanup;
  let releaseError = null;
  try {
    hostPermissionCleanup = await releaseTemporaryReviewAccess(record, dependencies);
  } catch (error) {
    releaseError = error;
  }

  // This is deliberately the final synchronous observation after every
  // awaited destructive step. The popup invokes the native request and then
  // dispatches its arm marker in one task; if that marker arrived while this
  // invalidation was removing the review or lease, restore both exact records
  // before releasing the serialized review mutation to the staged arm.
  const pendingPromptContextId = getPendingPromptContextId(record, dependencies);
  if (
    dependencies.promptSettled !== true &&
    pendingPromptContextId &&
    record?.permissionLeaseId &&
    record.hostPermissionsGranted !== true
  ) {
    await restorePermissionLeasePromptOwnership(dependencies.storageLocal, {
      id: record.permissionLeaseId,
      requestedOrigins: record.target?.hostPermissionOrigins || [],
      preexistingOrigins: record.preexistingHostPermissionOrigins || [],
      createdAt: new Date(record.createdAtMs).toISOString(),
      reviewExpiresAt: new Date(record.expiresAtMs).toISOString(),
      now: dependencies.now || (() => Date.now())
    });
    await storageSession.set({
      [CLEANUP_REVIEW_STORAGE_KEY]: createPromptTombstoneRecord(
        record,
        Number(typeof dependencies.now === 'function' ? dependencies.now() : Date.now()),
        options.tombstoneReason || 'cleanup_review_invalidated',
        pendingPromptContextId
      )
    });
    notifyPromptTombstoneRestored(record, dependencies);
    return {
      promptTombstoneRetained: true,
      hostPermissionCleanup: promptSettlementPendingResult(record)
    };
  }

  if (releaseError) throw releaseError;
  return { promptTombstoneRetained: false, hostPermissionCleanup };
}

function notifyPromptTombstoneRestored(record, dependencies = {}) {
  if (typeof dependencies.onPromptTombstoneRestored !== 'function') return;
  try {
    dependencies.onPromptTombstoneRestored(record.approvalHandoffNonce);
  } catch {
    // The durable tombstone and lease remain the authoritative recovery state.
  }
}

function cleanupReviewPromptMayStillSettle(record, dependencies = {}) {
  return Boolean(
    record?.permissionLeaseId &&
    record.hostPermissionsGranted !== true &&
    (['arming', 'armed', 'prompt_tombstone'].includes(record.approvalHandoff?.status) ||
      getPendingPromptContextId(record, dependencies) ||
      (dependencies.retainPreparedPromptOwnership === true &&
        !record.approvalHandoff &&
        record.preparationContextId &&
        dependencies.promptNotStartedProven !== true))
  );
}

function getPendingPromptContextId(record, dependencies = {}) {
  if (typeof dependencies.getPendingPromptContextId !== 'function') return null;
  try {
    return normalizePopupContextId(dependencies.getPendingPromptContextId(record));
  } catch {
    return null;
  }
}

function createPromptTombstoneRecord(record, requestedNowMs, reason, pendingPromptContextId = null) {
  const fallbackMs = Number.isFinite(requestedNowMs) ? requestedNowMs : Date.now();
  const tombstonedAtMs = Math.max(fallbackMs, record.createdAtMs);
  const existing = record.approvalHandoff;
  return {
    ...record,
    approvalHandoff: {
      schemaVersion: CLEANUP_APPROVAL_HANDOFF_SCHEMA_VERSION,
      status: 'prompt_tombstone',
      nonce: record.approvalHandoffNonce,
      approvalToken: record.token,
      permissionLeaseId: record.permissionLeaseId,
      sourceWindowId: record.sourceWindowId,
      sourceIncognito: record.sourceIncognito,
      expiresAtMs: record.expiresAtMs,
      armedAtMs: existing?.armedAtMs || record.createdAtMs,
      updatedAtMs: tombstonedAtMs,
      tombstonedAtMs,
      tombstoneReason: String(reason || 'cleanup_review_invalidated').slice(0, 128),
      promptContextId:
        existing?.promptContextId ||
        normalizePopupContextId(pendingPromptContextId) ||
        normalizePopupContextId(record.preparationContextId),
      approval: existing?.approval || null
    }
  };
}

function promptSettlementPendingResult(record) {
  return {
    found: true,
    released: false,
    accessRemains: null,
    recordRetained: true,
    leaseId: record.permissionLeaseId,
    reason: 'permission_prompt_settlement_pending'
  };
}

async function readRecordState(storageSession) {
  const data = await storageSession.get([CLEANUP_REVIEW_STORAGE_KEY]);
  const raw = data?.[CLEANUP_REVIEW_STORAGE_KEY];
  if (raw == null) return { record: null, invalid: false };
  const record = normalizeCleanupReviewRecord(raw);
  return { record, invalid: !record };
}

export function normalizeCleanupReviewRecord(value) {
  try {
    if (!isPlainObject(value) || value.schemaVersion !== CLEANUP_REVIEW_SCHEMA_VERSION) return null;
    const token = String(value.token || '');
    const createdAtMs = Number(value.createdAtMs);
    const expiresAtMs = Number(value.expiresAtMs);
    if (
      !REVIEW_IDENTIFIER_PATTERN.test(token) ||
      !Number.isSafeInteger(createdAtMs) ||
      !Number.isSafeInteger(expiresAtMs) ||
      expiresAtMs - createdAtMs !== CLEANUP_REVIEW_TTL_MS
    ) {
      return null;
    }
    const canonicalInput = String(value.canonicalInput || '');
    if (!canonicalInput || canonicalInput.length > 1024) return null;
    if (!isPlainObject(value.settings)) return null;
    const settingsNow =
      normalizeIsoTimestamp(value.settings.createdAt) ||
      normalizeIsoTimestamp(value.settings.updatedAt) ||
      new Date(createdAtMs).toISOString();
    const settings = normalizeStoredSettings(value.settings, settingsNow);
    if (!jsonEquivalent(value.settings, settings)) return null;

    const resolved = resolveCleanupReviewScope(canonicalInput, settings);
    if (!jsonEquivalent(value.target, resolved.target)) return null;
    const associated = {
      applied: resolved.associated.applied || [],
      errors: resolved.associated.errors || [],
      warnings: resolved.associated.warnings || []
    };
    if (!jsonEquivalent(value.associated, associated)) return null;

    const sourceWindowId = value.sourceWindowId;
    if (sourceWindowId !== null && (!Number.isInteger(sourceWindowId) || sourceWindowId < 0)) return null;
    if (typeof value.sourceIncognito !== 'boolean' || typeof value.incognitoAccess !== 'boolean') return null;
    const preparationContextId = normalizePopupContextId(value.preparationContextId);
    const popupPreparationCapabilityDigest = normalizePopupCapabilityDigest(value.popupPreparationCapabilityDigest);
    if (!preparationContextId || !popupPreparationCapabilityDigest) return null;

    const requestedOrigins = resolved.target.hostPermissionOrigins || [];
    const preexistingHostPermissionOrigins = normalizeExactStringArray(value.preexistingHostPermissionOrigins);
    if (
      !preexistingHostPermissionOrigins ||
      preexistingHostPermissionOrigins.some((origin) => !requestedOrigins.includes(origin))
    ) {
      return null;
    }
    const hostPermissionsGranted =
      requestedOrigins.length > 0 && preexistingHostPermissionOrigins.length === requestedOrigins.length;
    if (value.hostPermissionsGranted !== hostPermissionsGranted) return null;
    const hostPermissionInventory = normalizeHostPermissionInventory(value.hostPermissionInventory, {
      requiredOrigins: requestedOrigins,
      coveredRequiredOrigins: preexistingHostPermissionOrigins
    });
    if (!hostPermissionInventory) return null;

    const approvedDownloadFileIds = normalizeDownloadFileIds(value.approvedDownloadFileIds);
    if (!approvedDownloadFileIds) return null;
    const impact = normalizeImpactSnapshot(value.impact);
    if (!jsonEquivalent(value.impact, impact)) return null;
    const impactApprovedFileIds = Array.isArray(impact.matchedCompletedFileIds) ? impact.matchedCompletedFileIds : [];
    if (!jsonEquivalent(approvedDownloadFileIds, impactApprovedFileIds)) return null;
    const expectedReview = buildCleanupReview({
      enteredTarget: canonicalInput,
      target: resolved.target,
      settings,
      sourceWindowId,
      sourceIncognito: value.sourceIncognito,
      incognitoAccess: value.incognitoAccess,
      hostPermissionsGranted,
      hostPermissionInventory,
      impact,
      approvalToken: token,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString()
    });
    expectedReview.temporaryHostPermissionOrigins = requestedOrigins.filter(
      (origin) => !preexistingHostPermissionOrigins.includes(origin)
    );
    const temporaryOrigins = requestedOrigins.filter((origin) => !preexistingHostPermissionOrigins.includes(origin));
    const permissionLeaseId = value.permissionLeaseId == null ? null : String(value.permissionLeaseId);
    if (
      (permissionLeaseId !== null && !REVIEW_IDENTIFIER_PATTERN.test(permissionLeaseId)) ||
      temporaryOrigins.length > 0 !== Boolean(permissionLeaseId)
    ) {
      return null;
    }
    expectedReview.permissionLeaseId = permissionLeaseId;
    const approvalHandoffNonce = value.approvalHandoffNonce == null ? null : String(value.approvalHandoffNonce);
    if (
      (approvalHandoffNonce !== null && !REVIEW_IDENTIFIER_PATTERN.test(approvalHandoffNonce)) ||
      temporaryOrigins.length > 0 !== Boolean(approvalHandoffNonce)
    ) {
      return null;
    }
    if (approvalHandoffNonce) expectedReview.approvalHandoffNonce = approvalHandoffNonce;
    if (value.approvalMode !== expectedReview.approvalMode) return null;
    if (!jsonEquivalent(value.reviewSnapshot, expectedReview)) return null;
    if (!jsonEquivalent(value.requirements, expectedReview.requirements)) {
      return null;
    }
    const approvalHandoff = normalizeCleanupApprovalHandoff(value.approvalHandoff, {
      token,
      permissionLeaseId,
      sourceWindowId,
      sourceIncognito: value.sourceIncognito,
      expiresAtMs,
      createdAtMs,
      approvalHandoffNonce,
      approvalMode: expectedReview.approvalMode,
      requirements: expectedReview.requirements
    });
    if (value.approvalHandoff != null && !approvalHandoff) return null;

    return {
      schemaVersion: CLEANUP_REVIEW_SCHEMA_VERSION,
      token,
      approvalMode: expectedReview.approvalMode,
      createdAtMs,
      expiresAtMs,
      canonicalInput,
      target: cloneJson(resolved.target),
      settings: cloneJson(settings),
      associated: cloneJson(associated),
      sourceWindowId,
      sourceIncognito: value.sourceIncognito,
      preparationContextId,
      popupPreparationCapabilityDigest,
      incognitoAccess: value.incognitoAccess,
      hostPermissionsGranted,
      preexistingHostPermissionOrigins,
      hostPermissionInventory: cloneJson(hostPermissionInventory),
      requirements: cloneJson(expectedReview.requirements),
      impact: cloneJson(impact),
      reviewSnapshot: cloneJson(expectedReview),
      approvedDownloadFileIds,
      permissionLeaseId,
      approvalHandoffNonce,
      approvalHandoff
    };
  } catch {
    return null;
  }
}

function normalizeCleanupApprovalHandoff(value, binding) {
  if (value == null) return null;
  if (!isPlainObject(value) || value.schemaVersion !== CLEANUP_APPROVAL_HANDOFF_SCHEMA_VERSION) return null;
  if (!['arming', 'armed', 'admitting', 'prompt_tombstone'].includes(value.status)) return null;
  const promptTombstone = value.status === 'prompt_tombstone';
  const nonce = String(value.nonce || '');
  if (!REVIEW_IDENTIFIER_PATTERN.test(nonce)) return null;
  if (nonce !== binding.approvalHandoffNonce) return null;
  if (
    value.approvalToken !== binding.token ||
    value.permissionLeaseId !== binding.permissionLeaseId ||
    value.sourceWindowId !== binding.sourceWindowId ||
    value.sourceIncognito !== binding.sourceIncognito ||
    value.expiresAtMs !== binding.expiresAtMs
  ) {
    return null;
  }
  const armedAtMs = Number(value.armedAtMs);
  const updatedAtMs = Number(value.updatedAtMs);
  const promptContextId = normalizePopupContextId(value.promptContextId);
  if (
    !promptContextId ||
    !Number.isSafeInteger(armedAtMs) ||
    !Number.isSafeInteger(updatedAtMs) ||
    armedAtMs < binding.createdAtMs ||
    updatedAtMs < armedAtMs ||
    (!promptTombstone && updatedAtMs > binding.expiresAtMs)
  ) {
    return null;
  }
  const approval =
    value.approval == null && promptTombstone
      ? null
      : normalizeApprovalForHandoff(value.approval, binding.approvalMode);
  const validation = approval
    ? validateCleanupReviewApproval(binding.requirements, approval, binding.approvalMode)
    : { ok: false };
  if (!promptTombstone && !validation.ok) return null;
  let tombstonedAtMs = null;
  let tombstoneReason = null;
  if (promptTombstone) {
    tombstonedAtMs = Number(value.tombstonedAtMs);
    tombstoneReason = String(value.tombstoneReason || '');
    if (
      !Number.isSafeInteger(tombstonedAtMs) ||
      tombstonedAtMs !== updatedAtMs ||
      tombstonedAtMs < armedAtMs ||
      !tombstoneReason ||
      tombstoneReason.length > 128
    ) {
      return null;
    }
  }
  return {
    schemaVersion: CLEANUP_APPROVAL_HANDOFF_SCHEMA_VERSION,
    status: value.status,
    nonce,
    approvalToken: binding.token,
    permissionLeaseId: binding.permissionLeaseId,
    sourceWindowId: binding.sourceWindowId,
    sourceIncognito: binding.sourceIncognito,
    expiresAtMs: binding.expiresAtMs,
    armedAtMs,
    updatedAtMs,
    promptContextId,
    approval,
    ...(promptTombstone ? { tombstonedAtMs, tombstoneReason } : {})
  };
}

async function discardInvalidCleanupReview(storageSession, dependencies = {}) {
  await storageSession.remove(CLEANUP_REVIEW_STORAGE_KEY);
  const storageLocal = dependencies.storageLocal || storageSession?.durable;
  if (!storageLocal) {
    return {
      released: false,
      accessRemains: null,
      recordRetained: true,
      reason: 'durable_lease_storage_unavailable'
    };
  }
  try {
    return await reconcilePermissionLease(storageLocal, {
      containsHostPermissions: dependencies.containsHostPermissions || dependencies.hasHostPermissions,
      getAllHostPermissions: dependencies.getAllHostPermissions,
      releaseHostPermissions: dependencies.releaseHostPermissions,
      preserveLivePrepared: dependencies.preserveLivePrepared,
      forcePromptSettlement: dependencies.forcePromptSettlement,
      now: dependencies.now
    });
  } catch (error) {
    return {
      released: false,
      accessRemains: null,
      recordRetained: true,
      reason: 'invalid_or_unrecoverable_durable_lease',
      error: error?.message || String(error)
    };
  }
}

function normalizeExactStringArray(value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null;
  const normalized = [...new Set(value)];
  return jsonEquivalent(value, normalized) ? normalized : null;
}

function normalizeDownloadFileIds(value) {
  const normalized = normalizeExactStringArray(value);
  if (
    !normalized ||
    normalized.length > MAX_APPROVED_DOWNLOAD_FILE_IDS ||
    normalized.some((id) => !/^\d{1,16}$/.test(id))
  ) {
    return null;
  }
  return normalized;
}

function normalizeImpactSnapshot(value = {}) {
  const input = isPlainObject(value) ? value : {};
  const matchedCompletedFileIds = Array.isArray(input.matchedCompletedFileIds)
    ? [...new Set(input.matchedCompletedFileIds.map((id) => String(id)))].filter((id) => /^\d{1,16}$/.test(id))
    : null;
  const limitations = Array.isArray(input.limitations)
    ? input.limitations
        .slice(0, MAX_PREVIEW_LIMITATIONS)
        .map((item) => String(item).slice(0, MAX_PREVIEW_LIMITATION_LENGTH))
    : [];
  return {
    matchingTabs: normalizeImpactCount(input.matchingTabs),
    matchingPrivateTabs: normalizeImpactCount(input.matchingPrivateTabs),
    matchingHistoryEntries: normalizeImpactCount(input.matchingHistoryEntries),
    matchingDownloadRecords: normalizeImpactCount(input.matchingDownloadRecords),
    matchedCompletedFileCount: Array.isArray(matchedCompletedFileIds)
      ? matchedCompletedFileIds.length
      : normalizeImpactCount(input.matchedCompletedFileCount),
    matchedCompletedFileIds,
    limitations
  };
}

function normalizeImpactCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeIsoTimestamp(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function jsonEquivalent(left, right) {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right));
}

function settingsAuthorityEquivalent(left, right) {
  return jsonEquivalent(withoutSettingsMetadata(left), withoutSettingsMetadata(right));
}

function withoutSettingsMetadata(value = {}) {
  const {
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    stabilityDefaultsAppliedAt: _stabilityDefaultsAppliedAt,
    performanceDefaultsAppliedAt: _performanceDefaultsAppliedAt,
    privacyDefaultsAppliedAt: _privacyDefaultsAppliedAt,
    ...authoritySettings
  } = value;
  return authoritySettings;
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])])
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function randomApprovalToken() {
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function randomPopupPreparationCapability() {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function normalizePopupContextId(value) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > 256) return null;
  return value;
}

function normalizePopupCapabilityDigest(value) {
  const digest = typeof value === 'string' ? value.trim() : '';
  return POPUP_PREPARATION_CAPABILITY_DIGEST_PATTERN.test(digest) ? digest : null;
}

export async function digestCleanupPopupPreparationCapability(value) {
  const capability = typeof value === 'string' ? value.trim() : '';
  if (!POPUP_PREPARATION_CAPABILITY_PATTERN.test(capability)) {
    throw new Error('The cleanup popup capability is malformed. Reopen SiteWipe.');
  }
  if (!globalThis.crypto?.subtle?.digest) {
    throw new Error('The cleanup popup capability could not be verified. Reopen SiteWipe.');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(capability));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function assertCleanupReviewPopupBinding(record, payload = {}) {
  const popupContextId = normalizePopupContextId(payload.popupContextId);
  const expectedDigest = normalizePopupCapabilityDigest(record?.popupPreparationCapabilityDigest);
  if (!record || !popupContextId || popupContextId !== record.preparationContextId || !expectedDigest) {
    throw new Error('This popup no longer owns the prepared cleanup review. Reopen SiteWipe.');
  }
  const actualDigest = await digestCleanupPopupPreparationCapability(payload.popupPreparationCapability);
  let difference = 0;
  for (let index = 0; index < expectedDigest.length; index += 1) {
    difference |= expectedDigest.charCodeAt(index) ^ actualDigest.charCodeAt(index);
  }
  if (difference !== 0) {
    throw new Error('This popup no longer owns the prepared cleanup review. Reopen SiteWipe.');
  }
  return true;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function recordSafeEnteredTarget(target = {}) {
  return target.matchMode === 'exact_origin' ? String(target.exactOrigin || '') : String(target.domain || '');
}

async function releaseTemporaryReviewAccess(record, dependencies = {}) {
  if (record?.permissionLeaseId && dependencies.storageLocal) {
    try {
      const lease = await getPermissionLease(dependencies.storageLocal);
      if (
        lease?.id === record.permissionLeaseId &&
        !permissionLeaseMatchesReview(lease, record, normalizeOrigins(record.target?.hostPermissionOrigins))
      ) {
        return {
          found: true,
          released: false,
          accessRemains: null,
          recordRetained: true,
          leaseId: lease.id,
          reason: 'permission_lease_authority_mismatch'
        };
      }
    } catch (error) {
      return {
        found: true,
        released: false,
        accessRemains: null,
        recordRetained: true,
        leaseId: record.permissionLeaseId,
        reason: 'permission_lease_integrity_unavailable',
        error: error?.message || String(error)
      };
    }
    return reconcilePermissionLease(
      dependencies.storageLocal,
      {
        containsHostPermissions: dependencies.containsHostPermissions || dependencies.hasHostPermissions,
        getAllHostPermissions: dependencies.getAllHostPermissions,
        releaseHostPermissions: dependencies.releaseHostPermissions,
        preserveLivePrepared: dependencies.preserveLivePrepared,
        forcePromptSettlement: dependencies.forcePromptSettlement,
        now: dependencies.now
      },
      record.permissionLeaseId
    );
  }
  const origins = getTemporaryReviewHostPermissionOrigins(record);
  if (!origins.length) {
    return { attempted: false, accessRemains: true, reason: 'preexisting_access_preserved' };
  }
  if (typeof dependencies.releaseHostPermissions !== 'function') {
    return { attempted: false, accessRemains: null, reason: 'cleanup_adapter_unavailable' };
  }
  try {
    const grantedBefore =
      typeof dependencies.hasHostPermissions === 'function'
        ? await getGrantedHostPermissionOrigins(origins, dependencies.hasHostPermissions)
        : origins;
    const removeResult = grantedBefore.length
      ? Boolean(await dependencies.releaseHostPermissions(grantedBefore))
      : false;
    const grantedAfter =
      typeof dependencies.hasHostPermissions === 'function'
        ? await getGrantedHostPermissionOrigins(origins, dependencies.hasHostPermissions)
        : removeResult
          ? []
          : null;
    const accessRemains = Array.isArray(grantedAfter) ? grantedAfter.length > 0 : null;
    return {
      attempted: grantedBefore.length > 0,
      grantedBefore,
      grantedAfter,
      removeResult,
      accessRemains,
      released: accessRemains === false
    };
  } catch (error) {
    return {
      attempted: true,
      accessRemains: null,
      released: false,
      error: error?.message || String(error)
    };
  }
}

export function getTemporaryReviewHostPermissionOrigins(record = {}) {
  const requested = normalizeOrigins(record?.target?.hostPermissionOrigins);
  if (record?.hostPermissionsGranted === true) return [];
  const preserved = new Set(normalizeOrigins(record?.preexistingHostPermissionOrigins));
  return requested.filter((origin) => !preserved.has(origin));
}

export async function getGrantedHostPermissionOrigins(origins, hasHostPermissions, { failOnError = false } = {}) {
  const checks = await Promise.all(
    origins.map(async (origin) => {
      try {
        return (await hasHostPermissions([origin])) ? origin : null;
      } catch (error) {
        if (failOnError) {
          throw new Error(`Target site-access inspection failed for ${origin}: ${error?.message || String(error)}`, {
            cause: error
          });
        }
        return null;
      }
    })
  );
  return checks.filter(Boolean);
}

async function inspectGrantedHostPermissionOrigins(getAllHostPermissions, fallbackOrigins = []) {
  if (typeof getAllHostPermissions !== 'function') {
    // Pure unit consumers can omit the browser-wide inventory adapter. The
    // production service worker always supplies the strict permissions.getAll
    // adapter below, so shipped reviews never rely on this compatibility path.
    return canonicalizeHostPermissionOrigins(fallbackOrigins);
  }
  let snapshot;
  try {
    snapshot = await getAllHostPermissions();
  } catch (error) {
    throw new Error(`Host-permission inventory failed: ${error?.message || String(error)}`, { cause: error });
  }
  if (!isPlainObject(snapshot) || !Array.isArray(snapshot.origins)) {
    throw new Error('Host-permission inventory returned an invalid response.');
  }
  if (snapshot.origins.some((origin) => typeof origin !== 'string')) {
    throw new Error('Host-permission inventory contained an invalid origin pattern.');
  }
  if (snapshot.origins.some((origin) => !canonicalizeHostPermissionOrigin(origin))) {
    throw new Error('Host-permission inventory contained an unsupported origin pattern.');
  }
  return canonicalizeHostPermissionOrigins(snapshot.origins);
}

function normalizeOrigins(origins) {
  return Array.isArray(origins) ? [...new Set(origins.map(String).filter(Boolean))] : [];
}

async function verifySourceWindowContext(payload, inspectSourceWindow) {
  const sourceWindowId = payload?.sourceWindowId;
  if (!Number.isInteger(sourceWindowId) || sourceWindowId < 0) {
    throw new Error('The cleanup source window could not be verified. Reopen the popup and start the review again.');
  }
  if (typeof inspectSourceWindow !== 'function') {
    throw new Error('Cleanup source-window inspection is unavailable. Reopen the popup and start the review again.');
  }

  let inspected;
  try {
    inspected = await inspectSourceWindow(sourceWindowId);
  } catch (error) {
    throw new Error('The cleanup source window and private-window state could not be verified. Start again.', {
      cause: error
    });
  }
  if (
    !isPlainObject(inspected) ||
    inspected.sourceWindowId !== sourceWindowId ||
    typeof inspected.sourceIncognito !== 'boolean'
  ) {
    throw new Error('The cleanup source window returned an invalid private-window state. Start again.');
  }
  const sourceIncognito = payload?.sourceIncognito;
  if (typeof sourceIncognito !== 'boolean' || sourceIncognito !== inspected.sourceIncognito) {
    throw new Error('The cleanup source window or private-window state changed. Start again from this window.');
  }
  return { sourceWindowId, sourceIncognito };
}

function assertDependencies(dependencies) {
  for (const [name, value] of Object.entries(dependencies)) {
    if (name === 'storageSession' || name === 'storageLocal') {
      if (!value?.get || !value?.set || !value?.remove)
        throw new Error(
          name === 'storageSession'
            ? 'Cleanup review session storage is unavailable.'
            : 'Durable permission-lease storage is unavailable.'
        );
      continue;
    }
    if (typeof value !== 'function') throw new Error(`Cleanup review dependency ${name} is unavailable.`);
  }
}

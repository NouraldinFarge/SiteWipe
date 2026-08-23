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
  markPermissionLeasePromptGrantOwned,
  markPermissionLeasePromptPending,
  discardInvalidReviewPermissionLease,
  discardUninvokedPermissionLease,
  getPermissionLease,
  preparePermissionLease,
  reconcilePermissionLease,
  restorePermissionLeasePromptOwnership
} from './permission-leases.js';

export const CLEANUP_REVIEW_STORAGE_KEY = 'sitewipe.cleanupReview.v1';
export const CLEANUP_REVIEW_TTL_MS = 5 * 60 * 1000;
// Schema 3 retires the action-popup-bound permission protocol. Schema-2
// approvals are discarded as proofless legacy state and can never be rebound
// to the persistent extension-tab handoff.
export const CLEANUP_APPROVAL_HANDOFF_SCHEMA_VERSION = 3;
export const CLEANUP_PERMISSION_PROMPT_CONFIRM_GRACE_MS = 30 * 1000;
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
    if (cleanupReviewPromptIntentMayStillConfirm(existingRecord, createdAtMs)) {
      const retainedRecord =
        existingRecord.approvalHandoff.status === 'prompt_intent_tombstone'
          ? existingRecord
          : createPromptIntentTombstoneRecord(
              existingRecord,
              createdAtMs,
              'cleanup_review_replaced_while_permission_request_started'
            );
      await storageSession.set({ [CLEANUP_REVIEW_STORAGE_KEY]: retainedRecord });
      throw new Error(
        'A Chrome target-access request is still being confirmed. Wait briefly for it to settle before reviewing again.'
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
    if (cleanupReviewPromptMayStillSettle(existingRecord)) {
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

  // No valid session review exists to prove that SiteWipe owns any matching
  // browser grant. Retire only the orphaned bookkeeping and preserve access.
  const orphanedLease = await discardUninvokedPermissionLease(storageLocal, null);
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
      await discardUninvokedPermissionLease(storageLocal, permissionLease?.id).catch(() => {});
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
      await discardUninvokedPermissionLease(storageLocal, permissionLease.id).catch(() => {});
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

  // A durably armed handoff cannot be rebound or have its popup capability
  // rotated. If Chrome later grants the exact request, the worker can resume it
  // independently of popup lifetime. Before a handoff, same-context retry may
  // rotate its capability.
  if (record.approvalHandoff || getPendingPromptContextId(record, dependencies)) return null;
  if (preparationContextId !== record.preparationContextId) {
    if (typeof dependencies.isPreparationContextActive !== 'function') return null;
    if (await dependencies.isPreparationContextActive(record.preparationContextId)) return null;
    if (record.permissionLeaseId) {
      // A prepared review has not received the authenticated second-activation
      // marker and therefore cannot own any exact grant that appeared after its
      // popup retired. Drop only SiteWipe's bookkeeping; never turn that
      // externally controlled access into a prompt-settlement tombstone.
      await discardUninvokedCleanupReviewRecord(record, dependencies);
      throw new Error(
        'The popup that prepared Chrome target access closed before the reviewed prompt activation. Start the cleanup again.'
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

async function persistCleanupPermissionLeaseOwnership(record, dependencies = {}) {
  const handoff = record?.approvalHandoff;
  if (
    !record?.permissionLeaseId ||
    !handoff?.promptInvocation ||
    handoff.promptGrant?.complete !== true ||
    handoff.promptGrantOutcome?.granted !== true ||
    handoff.promptGrantOutcome.preRequestTemporaryOriginsAbsent !== true
  ) {
    return null;
  }
  const storageLocal = dependencies.storageLocal || dependencies.storageSession?.durable;
  if (!storageLocal?.get || !storageLocal?.set) {
    throw new Error('Cleanup permission lease storage is unavailable.');
  }
  const requestedOrigins = normalizeOrigins(record.target?.hostPermissionOrigins);
  const invalidateSplitOwnershipProof = async () => {
    // The complete session proof and durable ownership marker are one
    // authority boundary. If the marker cannot be committed (including at the
    // prompt TTL), erase the session half immediately and drop only proofless
    // bookkeeping. Any browser access is preserved; an already-owned lease is
    // retained solely for safe recovery.
    await discardUninvokedPermissionLease(storageLocal, record.permissionLeaseId).catch(() => {});
    if (dependencies.storageSession?.remove) {
      await dependencies.storageSession.remove(CLEANUP_REVIEW_STORAGE_KEY).catch(() => {});
    }
  };
  let ownedLease;
  try {
    ownedLease = await markPermissionLeasePromptGrantOwned(
      storageLocal,
      record.permissionLeaseId,
      dependencies.now || (() => Date.now()),
      permissionLeaseBindingForReview(record, requestedOrigins)
    );
  } catch (error) {
    // storage.set may reject either before or after Chrome accepted the write.
    // The safe rollback preserves any landed ownership marker for recovery,
    // but always erases the session half so cleanup cannot be admitted from an
    // uncertain split commit.
    await invalidateSplitOwnershipProof();
    throw error;
  }
  if (!ownedLease) {
    await invalidateSplitOwnershipProof();
    throw new Error('The durable target-access lease could not record reviewed prompt ownership. Start again.');
  }
  return ownedLease;
}

async function inspectLeaseOwnedPromptGrantTransition({
  record,
  lease,
  requestedOrigins,
  currentCoveredOrigins,
  getAllHostPermissions,
  allowedLeaseStatuses = ['prompt_pending']
}) {
  const ownershipProofMatchesStatus =
    (lease?.status === 'prompt_pending' && lease.ownershipProof === 'reviewed_prompt_grant') ||
    (lease?.status === 'active_cleanup' && lease.ownershipProof === 'admitted_cleanup');
  if (
    !allowedLeaseStatuses.includes(lease?.status) ||
    !ownershipProofMatchesStatus ||
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
  const canceledAtMs = Number(typeof dependencies.now === 'function' ? dependencies.now() : Date.now());
  if (dependencies.promptSettled !== true && cleanupReviewPromptIntentMayStillConfirm(record, canceledAtMs)) {
    const retainedRecord =
      record.approvalHandoff.status === 'prompt_intent_tombstone'
        ? record
        : createPromptIntentTombstoneRecord(
            record,
            canceledAtMs,
            dependencies.tombstoneReason || 'cleanup_review_canceled'
          );
    await storageSession.set({ [CLEANUP_REVIEW_STORAGE_KEY]: retainedRecord });
    return promptIntentConfirmationPendingResult(retainedRecord, { canceled: true });
  }
  if (cleanupReviewPromptMayStillSettle(record) && dependencies.promptSettled !== true) {
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
  dependencies = {
    ...dependencies,
    storageLocal: dependencies.storageLocal || storageSession?.durable
  };
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
    // Activation one never invokes permissions.request(). A mismatched popup
    // cannot inherit authority, and SiteWipe has no permission-removal
    // ownership to retain. Preserve any external grant and discard only the
    // stale review/lease bookkeeping.
    await discardUninvokedCleanupReviewRecord(record, dependencies);
    throw new Error('The popup context preparing this cleanup changed. Start the cleanup again.');
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
    promptIntent: null,
    promptInvocation: null,
    promptGrant: null,
    promptGrantOutcome: null,
    approval: normalizedApproval
  };
  const armingRecord = { ...record, approvalHandoff: armingHandoff };
  if (!Number.isFinite(armingAtMs) || armingAtMs > record.expiresAtMs) {
    // Activation one never invokes Chrome's permission UI. If its durable arm
    // arrives after expiry, SiteWipe has no prompt ownership to tombstone and
    // must preserve any exact grant that appeared independently meanwhile.
    await discardUninvokedCleanupReviewRecord(record, dependencies);
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
    // Revalidation and lease arming occur during activation one, before any
    // native permission request. A failure here must never manufacture prompt
    // ownership or revoke an independently granted exact pattern.
    await discardUninvokedCleanupReviewRecord(armingRecord, dependencies).catch(() => {});
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
  // A durable approval alone is deliberately non-runnable. Only the exact
  // popup that owns the one-use preparation capability must durably record both
  // the accepted invocation and the native request's resolved-true result. The
  // worker also needs the browser's exact complete host-only onAdded event.
  // Neither an external/manual grant nor a popup lost before reporting true can
  // turn the durable approval into cleanup authority.
  if (
    handoff.status !== 'armed' ||
    !handoff.promptInvocation ||
    handoff.promptGrant?.complete !== true ||
    handoff.promptGrantOutcome?.granted !== true ||
    handoff.promptGrantOutcome.preRequestTemporaryOriginsAbsent !== true
  ) {
    return null;
  }
  const nowMs = Number(typeof dependencies.now === 'function' ? dependencies.now() : Date.now());
  if (!Number.isFinite(nowMs) || nowMs > record.expiresAtMs) return null;

  const requestedOrigins = normalizeOrigins(record.target?.hostPermissionOrigins);
  const lease = await getPermissionLease(storageLocal);
  if (
    !lease ||
    lease.id !== record.permissionLeaseId ||
    lease.status !== 'prompt_pending' ||
    lease.ownershipProof !== 'reviewed_prompt_grant' ||
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

export async function recordCleanupPermissionPromptIntent(payload = {}, dependencies = {}) {
  const storageSession = dependencies.storageSession;
  const now = dependencies.now || (() => Date.now());
  if (!storageSession?.get || !storageSession?.set) {
    throw new Error('Cleanup review session storage is unavailable.');
  }
  const state = await readRecordState(storageSession);
  if (state.invalid) {
    await discardInvalidCleanupReview(storageSession, dependencies);
    throw new Error('The stored cleanup approval failed integrity validation and was discarded. Start again.');
  }
  const record = state.record;
  const handoffNonce = String(payload.handoffNonce || '');
  if (
    !record?.approvalHandoff ||
    record.approvalHandoff.status !== 'armed' ||
    record.approvalHandoff.nonce !== handoffNonce
  ) {
    throw new Error('The armed cleanup approval is missing or no longer matches this popup.');
  }
  if (dependencies.requirePopupPreparationCapability === true) {
    await assertCleanupReviewPopupBinding(record, payload);
  }
  const popupContextId = normalizePopupContextId(payload.popupContextId);
  if (!popupContextId || popupContextId !== record.approvalHandoff.promptContextId) {
    throw new Error('The Chrome target-access request changed popup context. Start again.');
  }
  const existing = record.approvalHandoff.promptIntent;
  if (existing) {
    return {
      promptIntentRecorded: true,
      handoffNonce,
      recordedAt: new Date(existing.recordedAtMs).toISOString(),
      confirmationDeadlineAt: new Date(existing.confirmationDeadlineMs).toISOString()
    };
  }
  const recordedAtMs = Number(now());
  const promptIntentAtMs = Number.isSafeInteger(recordedAtMs)
    ? Math.max(record.approvalHandoff.armedAtMs, Math.min(recordedAtMs, record.expiresAtMs))
    : Math.max(record.expiresAtMs, record.approvalHandoff.armedAtMs);
  const promptIntent = {
    popupContextId,
    recordedAtMs: promptIntentAtMs,
    confirmationDeadlineMs: promptIntentAtMs + CLEANUP_PERMISSION_PROMPT_CONFIRM_GRACE_MS
  };
  const intentRecord = {
    ...record,
    approvalHandoff: {
      ...record.approvalHandoff,
      updatedAtMs: promptIntent.recordedAtMs,
      promptIntent
    }
  };
  const authorityRevoked = !Number.isSafeInteger(recordedAtMs) || recordedAtMs > record.expiresAtMs;
  const retainedRecord = authorityRevoked
    ? createPromptIntentTombstoneRecord(
        intentRecord,
        promptIntent.recordedAtMs,
        'permission_prompt_intent_observed_after_cleanup_review_expiry'
      )
    : intentRecord;
  await storageSession.set({ [CLEANUP_REVIEW_STORAGE_KEY]: retainedRecord });
  return {
    promptIntentRecorded: true,
    handoffNonce,
    recordedAt: new Date(promptIntent.recordedAtMs).toISOString(),
    confirmationDeadlineAt: new Date(promptIntent.confirmationDeadlineMs).toISOString(),
    ...(authorityRevoked ? { authorityRevoked: true, handoffStatus: 'prompt_intent_tombstone' } : {})
  };
}

export async function recordCleanupPermissionPromptInvocation(payload = {}, dependencies = {}) {
  const storageSession = dependencies.storageSession;
  const now = dependencies.now || (() => Date.now());
  if (!storageSession?.get || !storageSession?.set) {
    throw new Error('Cleanup review session storage is unavailable.');
  }
  const state = await readRecordState(storageSession);
  if (state.invalid) {
    await discardInvalidCleanupReview(storageSession, dependencies);
    throw new Error('The stored cleanup approval failed integrity validation and was discarded. Start again.');
  }
  const record = state.record;
  const handoffNonce = String(payload.handoffNonce || '');
  if (
    !record?.approvalHandoff ||
    !['armed', 'prompt_intent_tombstone', 'prompt_tombstone'].includes(record.approvalHandoff.status) ||
    record.approvalHandoff.nonce !== handoffNonce
  ) {
    throw new Error('The armed cleanup approval is missing or no longer matches this popup.');
  }
  if (dependencies.requirePopupPreparationCapability === true) {
    await assertCleanupReviewPopupBinding(record, payload);
  }
  const popupContextId = normalizePopupContextId(payload.popupContextId);
  if (
    !popupContextId ||
    popupContextId !== record.approvalHandoff.promptContextId ||
    record.approvalHandoff.promptIntent?.popupContextId !== popupContextId
  ) {
    throw new Error('The accepted Chrome target-access request is missing its initiating popup intent. Start again.');
  }
  const existing = record.approvalHandoff.promptInvocation;
  if (existing) {
    return {
      promptInvocationRecorded: true,
      handoffNonce,
      recordedAt: new Date(existing.recordedAtMs).toISOString()
    };
  }
  const recordedAtMs = Number(now());
  if (
    !Number.isSafeInteger(recordedAtMs) ||
    recordedAtMs >= record.approvalHandoff.promptIntent.confirmationDeadlineMs
  ) {
    await discardUninvokedCleanupReviewRecord(record, dependencies);
    throw new Error('Chrome target-access confirmation arrived too late. Start again.');
  }
  if (record.approvalHandoff.status === 'prompt_intent_tombstone' || recordedAtMs > record.expiresAtMs) {
    // The exact popup confirms this marker immediately after
    // permissions.request() accepts the call, without awaiting its result. Even
    // when the worker observes confirmation just after expiry (or its clock
    // cannot be trusted), SiteWipe must retain non-runnable ownership long
    // enough to remove a grant produced by that same request. This is
    // intentionally different from activation-one expiry or an unconfirmed
    // activation-two intent, neither of which owns a prompt.
    const promptInvocationAtMs = Math.max(recordedAtMs, record.approvalHandoff.promptIntent.recordedAtMs);
    const invokedRecord = {
      ...record,
      approvalHandoff: {
        ...record.approvalHandoff,
        updatedAtMs: promptInvocationAtMs,
        promptInvocation: { popupContextId, recordedAtMs: promptInvocationAtMs }
      }
    };
    await storageSession.set({
      [CLEANUP_REVIEW_STORAGE_KEY]: createPromptTombstoneRecord(
        invokedRecord,
        promptInvocationAtMs,
        record.approvalHandoff.status === 'prompt_intent_tombstone'
          ? record.approvalHandoff.tombstoneReason
          : 'permission_prompt_invocation_observed_after_expiry'
      )
    });
    return {
      promptInvocationRecorded: true,
      authorityRevoked: true,
      handoffStatus: 'prompt_tombstone',
      handoffNonce,
      recordedAt: new Date(promptInvocationAtMs).toISOString()
    };
  }
  const promptInvocation = {
    popupContextId,
    recordedAtMs: Math.max(recordedAtMs, record.approvalHandoff.promptIntent.recordedAtMs)
  };
  await storageSession.set({
    [CLEANUP_REVIEW_STORAGE_KEY]: {
      ...record,
      approvalHandoff: {
        ...record.approvalHandoff,
        updatedAtMs: promptInvocation.recordedAtMs,
        promptInvocation
      }
    }
  });
  return {
    promptInvocationRecorded: true,
    handoffNonce,
    recordedAt: new Date(promptInvocation.recordedAtMs).toISOString()
  };
}

export async function recordCleanupPermissionGrantObservation(payload = {}, dependencies = {}) {
  const storageSession = dependencies.storageSession;
  const now = dependencies.now || (() => Date.now());
  if (!storageSession?.get || !storageSession?.set) {
    throw new Error('Cleanup review session storage is unavailable.');
  }
  const rawOrigins = payload?.origins;
  const rawNamedPermissions = payload?.permissions;
  if (
    !Array.isArray(rawOrigins) ||
    !rawOrigins.length ||
    rawOrigins.some((origin) => typeof origin !== 'string') ||
    new Set(rawOrigins).size !== rawOrigins.length ||
    (rawNamedPermissions != null &&
      (!Array.isArray(rawNamedPermissions) ||
        rawNamedPermissions.some((permission) => typeof permission !== 'string') ||
        rawNamedPermissions.length > 0))
  ) {
    return { promptGrantObserved: false, reason: 'invalid_or_non_host_only_permission_event' };
  }
  const addedOrigins = canonicalizeHostPermissionOrigins(rawOrigins);
  if (addedOrigins.length !== rawOrigins.length || rawOrigins.some((origin) => !addedOrigins.includes(origin))) {
    return { promptGrantObserved: false, reason: 'noncanonical_permission_event' };
  }

  const state = await readRecordState(storageSession);
  if (state.invalid || !state.record?.approvalHandoff) {
    return { promptGrantObserved: false, reason: 'no_valid_cleanup_handoff' };
  }
  const record = state.record;
  const handoff = record.approvalHandoff;
  if (!['armed', 'prompt_intent_tombstone', 'prompt_tombstone'].includes(handoff.status) || !handoff.promptIntent) {
    return { promptGrantObserved: false, reason: 'no_authenticated_permission_request_intent' };
  }

  const requestedOrigins = canonicalizeHostPermissionOrigins(record.target?.hostPermissionOrigins);
  const preexistingOrigins = new Set(canonicalizeHostPermissionOrigins(record.preexistingHostPermissionOrigins));
  const temporaryOrigins = requestedOrigins.filter((origin) => !preexistingOrigins.has(origin));
  if (!jsonEquivalent(addedOrigins, canonicalizeHostPermissionOrigins(temporaryOrigins))) {
    return { promptGrantObserved: false, reason: 'permission_event_not_exact_complete_reviewed_set' };
  }

  const observedOrigins = addedOrigins;
  const recordedAtMs = Number(now());
  if (!Number.isSafeInteger(recordedAtMs)) {
    throw new Error('Cleanup permission-grant observation clock is unavailable.');
  }
  if (!handoff.promptInvocation && recordedAtMs >= handoff.promptIntent.confirmationDeadlineMs) {
    await discardUninvokedCleanupReviewRecord(record, dependencies);
    return {
      promptGrantObserved: false,
      permissionsPreserved: true,
      reason: 'permission_event_after_unconfirmed_intent_deadline'
    };
  }
  const promptGrant = {
    observedOrigins,
    complete: true,
    recordedAtMs: Math.max(recordedAtMs, (handoff.promptInvocation || handoff.promptIntent).recordedAtMs)
  };
  const observedRecord = {
    ...record,
    approvalHandoff: {
      ...handoff,
      ...(handoff.status === 'armed' && recordedAtMs <= record.expiresAtMs
        ? { updatedAtMs: Math.max(handoff.updatedAtMs, recordedAtMs) }
        : {}),
      promptGrant
    }
  };
  let retainedRecord = observedRecord;
  if (handoff.status === 'armed' && recordedAtMs > record.expiresAtMs) {
    retainedRecord = handoff.promptInvocation
      ? createPromptTombstoneRecord(
          observedRecord,
          recordedAtMs,
          'permission_grant_observed_after_cleanup_review_expiry'
        )
      : createPromptIntentTombstoneRecord(
          observedRecord,
          recordedAtMs,
          'permission_grant_observed_before_request_confirmation_after_expiry'
        );
  }
  await storageSession.set({ [CLEANUP_REVIEW_STORAGE_KEY]: retainedRecord });
  await persistCleanupPermissionLeaseOwnership(retainedRecord, dependencies);
  return {
    promptGrantObserved: true,
    promptGrantComplete: promptGrant.complete,
    handoffNonce: handoff.nonce,
    observedOrigins: cloneJson(promptGrant.observedOrigins)
  };
}

export async function recordCleanupPermissionGrantOutcome(payload = {}, dependencies = {}) {
  const storageSession = dependencies.storageSession;
  const now = dependencies.now || (() => Date.now());
  if (!storageSession?.get || !storageSession?.set) {
    throw new Error('Cleanup review session storage is unavailable.');
  }
  if (payload.preRequestTemporaryOriginsAbsent !== true) {
    throw new Error('Chrome target access was not proved absent before the requested prompt. Start again.');
  }
  const state = await readRecordState(storageSession);
  if (state.invalid) {
    await discardInvalidCleanupReview(storageSession, dependencies);
    throw new Error('The stored cleanup approval failed integrity validation and was discarded. Start again.');
  }
  const record = state.record;
  const handoffNonce = String(payload.handoffNonce || '');
  if (
    !record?.approvalHandoff ||
    !['armed', 'prompt_tombstone'].includes(record.approvalHandoff.status) ||
    record.approvalHandoff.nonce !== handoffNonce ||
    !record.approvalHandoff.promptInvocation
  ) {
    throw new Error('The accepted Chrome target-access result has no matching invoked request. Start again.');
  }
  if (dependencies.requirePopupPreparationCapability === true) {
    await assertCleanupReviewPopupBinding(record, payload);
  }
  const popupContextId = normalizePopupContextId(payload.popupContextId);
  if (
    !popupContextId ||
    popupContextId !== record.approvalHandoff.promptContextId ||
    record.approvalHandoff.promptInvocation.popupContextId !== popupContextId
  ) {
    throw new Error('Only the initiating popup can confirm Chrome granted the requested target access.');
  }
  const existing = record.approvalHandoff.promptGrantOutcome;
  if (existing?.granted === true) {
    await persistCleanupPermissionLeaseOwnership(record, dependencies);
    return {
      promptGrantOutcomeRecorded: true,
      handoffNonce,
      recordedAt: new Date(existing.recordedAtMs).toISOString()
    };
  }
  const recordedAtMs = Number(now());
  if (!Number.isSafeInteger(recordedAtMs)) {
    throw new Error('Cleanup permission-result clock is unavailable.');
  }
  const promptGrantOutcome = {
    popupContextId,
    granted: true,
    preRequestTemporaryOriginsAbsent: true,
    recordedAtMs: Math.max(recordedAtMs, record.approvalHandoff.promptInvocation.recordedAtMs)
  };
  const outcomeRecord = {
    ...record,
    approvalHandoff: {
      ...record.approvalHandoff,
      ...(record.approvalHandoff.status === 'armed' && recordedAtMs <= record.expiresAtMs
        ? {
            updatedAtMs: Math.max(record.approvalHandoff.updatedAtMs, promptGrantOutcome.recordedAtMs)
          }
        : {}),
      promptGrantOutcome
    }
  };
  const retainedRecord =
    record.approvalHandoff.status === 'armed' && recordedAtMs > record.expiresAtMs
      ? createPromptTombstoneRecord(
          outcomeRecord,
          promptGrantOutcome.recordedAtMs,
          'permission_request_granted_after_cleanup_review_expiry'
        )
      : outcomeRecord;
  await storageSession.set({ [CLEANUP_REVIEW_STORAGE_KEY]: retainedRecord });
  await persistCleanupPermissionLeaseOwnership(retainedRecord, dependencies);
  return {
    promptGrantOutcomeRecorded: true,
    handoffNonce,
    authorityRevoked: retainedRecord.approvalHandoff.status === 'prompt_tombstone',
    recordedAt: new Date(promptGrantOutcome.recordedAtMs).toISOString()
  };
}

export async function discardCleanupPermissionPromptWithoutInvocation(payload = {}, dependencies = {}) {
  const storageSession = dependencies.storageSession;
  const storageLocal = dependencies.storageLocal || storageSession?.durable;
  if (!storageSession?.get || !storageSession?.set || !storageSession?.remove || !storageLocal) {
    throw new Error('Cleanup review session storage is unavailable.');
  }
  const state = await readRecordState(storageSession);
  if (state.invalid) throw new Error('The target-access prompt record failed integrity validation.');
  const record = state.record;
  const handoffNonce = String(payload.handoffNonce || '');
  if (
    !record?.approvalHandoff ||
    !['armed', 'prompt_intent_tombstone'].includes(record.approvalHandoff.status) ||
    !record.approvalHandoff.promptIntent ||
    record.approvalHandoff.promptInvocation ||
    record.approvalHandoff.nonce !== handoffNonce ||
    record.token !== String(payload.approvalToken || '') ||
    record.permissionLeaseId !== String(payload.permissionLeaseId || '')
  ) {
    throw new Error('The uninvoked target-access intent no longer matches this popup.');
  }
  if (dependencies.requirePopupPreparationCapability === true) {
    await assertCleanupReviewPopupBinding(record, payload);
  }
  const popupContextId = normalizePopupContextId(payload.popupContextId);
  if (record.approvalHandoff.promptIntent.popupContextId !== popupContextId) {
    throw new Error('Only the initiating popup can report that Chrome target access was not invoked.');
  }

  await storageSession.set({
    [CLEANUP_REVIEW_STORAGE_KEY]: {
      ...record,
      approvalHandoff: null
    }
  });
  const settlement = await discardUninvokedPermissionLease(storageLocal, record.permissionLeaseId);
  if (settlement.recordRetained === true || settlement.permissionsPreserved !== true) {
    throw new Error('The uninvoked target-access lease could not be discarded safely.');
  }
  await storageSession.remove(CLEANUP_REVIEW_STORAGE_KEY);
  return { ...settlement, promptNotInvoked: true, ownershipCleared: true };
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
        !record.approvalHandoff.promptInvocation ||
        record.approvalHandoff.promptGrant?.complete !== true ||
        record.approvalHandoff.promptGrantOutcome?.granted !== true ||
        record.approvalHandoff.promptGrantOutcome.preRequestTemporaryOriginsAbsent !== true ||
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
      (!activatePermissionLease && lease?.status === 'prepared' && lease.ownershipProof == null) ||
      (lease?.status === 'prompt_pending' &&
        (activatePermissionLease
          ? lease.ownershipProof === 'reviewed_prompt_grant'
          : [null, 'reviewed_prompt_grant'].includes(lease.ownershipProof))) ||
      (admittingHandoff && lease?.status === 'active_cleanup' && lease.ownershipProof === 'admitted_cleanup');
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
  if (!record) return false;
  const confirmationDeadlineMs = getCleanupPermissionPromptConfirmationDeadline(record);
  if (confirmationDeadlineMs !== null && Number(now) >= confirmationDeadlineMs) {
    const removal = await removeReviewAndReleaseUnlessPromptOwnerArrived(record, dependencies, {
      tombstoneReason: 'permission_prompt_confirmation_deadline_expired'
    });
    return {
      expired: false,
      authorityRevoked: true,
      promptIntentExpired: true,
      hostPermissionCleanup: removal.hostPermissionCleanup
    };
  }
  if (Number.isFinite(record.expiresAtMs) && Number(now) <= record.expiresAtMs) return false;
  if (cleanupReviewPromptIntentMayStillConfirm(record, now)) {
    const retainedRecord =
      record.approvalHandoff.status === 'prompt_intent_tombstone'
        ? record
        : createPromptIntentTombstoneRecord(record, Number(now), 'cleanup_review_expired');
    await storageSession.set({ [CLEANUP_REVIEW_STORAGE_KEY]: retainedRecord });
    return promptIntentConfirmationPendingResult(retainedRecord, { expired: true });
  }
  if (cleanupReviewPromptMayStillSettle(record)) {
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
  const invalidatedAtMs = Number(typeof dependencies.now === 'function' ? dependencies.now() : Date.now());
  if (dependencies.promptSettled !== true && cleanupReviewPromptIntentMayStillConfirm(record, invalidatedAtMs)) {
    const retainedRecord =
      record.approvalHandoff.status === 'prompt_intent_tombstone'
        ? record
        : createPromptIntentTombstoneRecord(
            record,
            invalidatedAtMs,
            dependencies.tombstoneReason || 'cleanup_review_invalidated'
          );
    await storageSession.set({ [CLEANUP_REVIEW_STORAGE_KEY]: retainedRecord });
    return promptIntentConfirmationPendingResult(retainedRecord, { cleared: true });
  }
  if (cleanupReviewPromptMayStillSettle(record) && dependencies.promptSettled !== true) {
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
  const retireReviewAfterSettledRelease = dependencies.promptSettled === true;
  if (!retireReviewAfterSettledRelease) {
    await storageSession.remove(CLEANUP_REVIEW_STORAGE_KEY);
  }

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
    record?.approvalHandoff?.promptInvocation &&
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
  if (retireReviewAfterSettledRelease) {
    await storageSession.remove(CLEANUP_REVIEW_STORAGE_KEY);
  }
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

function cleanupReviewPromptMayStillSettle(record) {
  const handoff = record?.approvalHandoff;
  return Boolean(
    record?.permissionLeaseId &&
    record.hostPermissionsGranted !== true &&
    (handoff?.status === 'prompt_tombstone' ||
      (['arming', 'armed'].includes(handoff?.status) && Boolean(handoff.promptInvocation)))
  );
}

export function getCleanupPermissionPromptConfirmationDeadline(record) {
  const handoff = record?.approvalHandoff;
  if (
    !['armed', 'prompt_intent_tombstone'].includes(handoff?.status) ||
    !handoff.promptIntent ||
    handoff.promptInvocation
  ) {
    return null;
  }
  const deadlineMs = Number(handoff.promptIntent.confirmationDeadlineMs);
  return Number.isSafeInteger(deadlineMs) ? deadlineMs : null;
}

function cleanupReviewPromptIntentMayStillConfirm(record, now = Date.now()) {
  const deadlineMs = getCleanupPermissionPromptConfirmationDeadline(record);
  const nowMs = Number(now);
  return deadlineMs !== null && Number.isFinite(nowMs) && nowMs < deadlineMs;
}

function createPromptIntentTombstoneRecord(record, requestedNowMs, reason) {
  const existing = record?.approvalHandoff;
  if (!existing?.promptIntent || existing.promptInvocation) {
    throw new Error('A target-access intent tombstone requires an unconfirmed authenticated prompt intent.');
  }
  const fallbackMs = Number.isFinite(requestedNowMs) ? requestedNowMs : Date.now();
  const tombstonedAtMs = Math.max(fallbackMs, existing.promptIntent.recordedAtMs, record.createdAtMs);
  return {
    ...record,
    approvalHandoff: {
      ...existing,
      status: 'prompt_intent_tombstone',
      updatedAtMs: tombstonedAtMs,
      tombstonedAtMs,
      tombstoneReason: String(reason || 'cleanup_review_invalidated').slice(0, 128),
      approval: null
    }
  };
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
  if (!existing?.promptInvocation) {
    throw new Error('A Chrome target-access settlement tombstone requires an authenticated prompt invocation.');
  }
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
      promptIntent: existing.promptIntent,
      promptInvocation: existing.promptInvocation,
      promptGrant: existing.promptGrant || null,
      promptGrantOutcome: existing.promptGrantOutcome || null,
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

function promptIntentConfirmationPendingResult(record, flags = {}) {
  const confirmationDeadlineMs = getCleanupPermissionPromptConfirmationDeadline(record);
  return {
    ...flags,
    authorityRevoked: true,
    promptIntentConfirmationPending: true,
    confirmationDeadlineAt: new Date(confirmationDeadlineMs).toISOString(),
    hostPermissionCleanup: {
      found: true,
      released: false,
      accessRemains: null,
      recordRetained: true,
      permissionsPreserved: true,
      leaseId: record.permissionLeaseId,
      reason: 'permission_prompt_confirmation_pending'
    }
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
      requirements: expectedReview.requirements,
      temporaryOrigins
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
  if (!['arming', 'armed', 'admitting', 'prompt_intent_tombstone', 'prompt_tombstone'].includes(value.status)) {
    return null;
  }
  const promptTombstone = value.status === 'prompt_tombstone';
  const promptIntentTombstone = value.status === 'prompt_intent_tombstone';
  const revokedTombstone = promptIntentTombstone || promptTombstone;
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
    (!revokedTombstone && updatedAtMs > binding.expiresAtMs)
  ) {
    return null;
  }
  const approval =
    value.approval == null && revokedTombstone
      ? null
      : normalizeApprovalForHandoff(value.approval, binding.approvalMode);
  const validation = approval
    ? validateCleanupReviewApproval(binding.requirements, approval, binding.approvalMode)
    : { ok: false };
  if (!revokedTombstone && !validation.ok) return null;
  let promptIntent = null;
  if (value.promptIntent != null) {
    if (!isPlainObject(value.promptIntent)) return null;
    const popupContextId = normalizePopupContextId(value.promptIntent.popupContextId);
    const recordedAtMs = Number(value.promptIntent.recordedAtMs);
    const confirmationDeadlineMs = Number(value.promptIntent.confirmationDeadlineMs);
    if (
      popupContextId !== promptContextId ||
      !Number.isSafeInteger(recordedAtMs) ||
      !Number.isSafeInteger(confirmationDeadlineMs) ||
      confirmationDeadlineMs !== recordedAtMs + CLEANUP_PERMISSION_PROMPT_CONFIRM_GRACE_MS ||
      recordedAtMs < armedAtMs ||
      recordedAtMs > binding.expiresAtMs ||
      recordedAtMs > updatedAtMs
    ) {
      return null;
    }
    promptIntent = { popupContextId, recordedAtMs, confirmationDeadlineMs };
  }
  let promptInvocation = null;
  if (value.promptInvocation != null) {
    if (!isPlainObject(value.promptInvocation)) return null;
    const popupContextId = normalizePopupContextId(value.promptInvocation.popupContextId);
    const recordedAtMs = Number(value.promptInvocation.recordedAtMs);
    if (
      popupContextId !== promptContextId ||
      !Number.isSafeInteger(recordedAtMs) ||
      !promptIntent ||
      recordedAtMs < promptIntent.recordedAtMs ||
      recordedAtMs > promptIntent.confirmationDeadlineMs ||
      (!promptTombstone && recordedAtMs > binding.expiresAtMs) ||
      recordedAtMs > updatedAtMs
    ) {
      return null;
    }
    promptInvocation = { popupContextId, recordedAtMs };
  }
  let promptGrant = null;
  if (value.promptGrant != null) {
    if (!isPlainObject(value.promptGrant) || !promptIntent) return null;
    const observedOrigins = canonicalizeHostPermissionOrigins(value.promptGrant.observedOrigins);
    const recordedAtMs = Number(value.promptGrant.recordedAtMs);
    const complete =
      binding.temporaryOrigins.length > 0 &&
      binding.temporaryOrigins.every((origin) => observedOrigins.includes(origin));
    if (
      !jsonEquivalent(value.promptGrant.observedOrigins, observedOrigins) ||
      observedOrigins.length === 0 ||
      observedOrigins.some((origin) => !binding.temporaryOrigins.includes(origin)) ||
      value.promptGrant.complete !== complete ||
      !Number.isSafeInteger(recordedAtMs) ||
      // An exact onAdded event may win the cross-process race with the popup's
      // confirmation message. It is authenticated by the already-durable intent
      // and remains non-runnable until promptInvocation exists, so its timestamp
      // may legitimately precede that later marker.
      recordedAtMs < promptIntent.recordedAtMs ||
      (!revokedTombstone && recordedAtMs > updatedAtMs)
    ) {
      return null;
    }
    promptGrant = { observedOrigins, complete, recordedAtMs };
  }
  let promptGrantOutcome = null;
  if (value.promptGrantOutcome != null) {
    if (!isPlainObject(value.promptGrantOutcome) || !promptInvocation) return null;
    const popupContextId = normalizePopupContextId(value.promptGrantOutcome.popupContextId);
    const recordedAtMs = Number(value.promptGrantOutcome.recordedAtMs);
    if (
      popupContextId !== promptContextId ||
      value.promptGrantOutcome.granted !== true ||
      value.promptGrantOutcome.preRequestTemporaryOriginsAbsent !== true ||
      !Number.isSafeInteger(recordedAtMs) ||
      recordedAtMs < promptInvocation.recordedAtMs ||
      (!revokedTombstone && recordedAtMs > updatedAtMs)
    ) {
      return null;
    }
    promptGrantOutcome = {
      popupContextId,
      granted: true,
      preRequestTemporaryOriginsAbsent: true,
      recordedAtMs
    };
  }
  if (
    (value.status === 'arming' && (promptIntent || promptInvocation || promptGrant || promptGrantOutcome)) ||
    (value.status === 'admitting' &&
      (!promptIntent || !promptInvocation || promptGrant?.complete !== true || promptGrantOutcome?.granted !== true)) ||
    (promptIntentTombstone && (!promptIntent || promptInvocation || promptGrantOutcome)) ||
    (promptTombstone && (!promptIntent || !promptInvocation))
  ) {
    return null;
  }
  let tombstonedAtMs = null;
  let tombstoneReason = null;
  if (revokedTombstone) {
    tombstonedAtMs = Number(value.tombstonedAtMs);
    tombstoneReason = String(value.tombstoneReason || '');
    if (
      !Number.isSafeInteger(tombstonedAtMs) ||
      tombstonedAtMs !== updatedAtMs ||
      tombstonedAtMs < armedAtMs ||
      (promptIntentTombstone && tombstonedAtMs > promptIntent.confirmationDeadlineMs) ||
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
    promptIntent,
    promptInvocation,
    promptGrant,
    promptGrantOutcome,
    approval,
    ...(revokedTombstone ? { tombstonedAtMs, tombstoneReason } : {})
  };
}

async function discardInvalidCleanupReview(storageSession, dependencies = {}) {
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
    // Invalid session bytes cannot authenticate any prompt-owned lease. First
    // neutralize the single durable non-admitted lease without touching browser
    // access; keep a valid admitted-cleanup lease for ordinary recovery. The
    // invalid session marker is removed only after that durable boundary is
    // proved, so maintenance cannot later reinterpret ambiguous provenance.
    const neutralized = await discardInvalidReviewPermissionLease(storageLocal);
    if (neutralized.recordRetained === true && neutralized.admittedCleanupRetained !== true) {
      return neutralized;
    }

    let removalError = null;
    try {
      await storageSession.remove(CLEANUP_REVIEW_STORAGE_KEY);
    } catch (error) {
      removalError = error;
    }
    let postRemoval;
    try {
      postRemoval = await storageSession.get([CLEANUP_REVIEW_STORAGE_KEY]);
    } catch (error) {
      return {
        ...neutralized,
        recordRetained: true,
        reason: 'invalid_review_marker_removal_unproven',
        error: error?.message || removalError?.message || String(error)
      };
    }
    if (postRemoval?.[CLEANUP_REVIEW_STORAGE_KEY] != null) {
      return {
        ...neutralized,
        recordRetained: true,
        reason: 'invalid_review_marker_removal_unproven',
        ...(removalError ? { error: removalError?.message || String(removalError) } : {})
      };
    }
    return neutralized;
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

async function discardUninvokedCleanupReviewRecord(record, dependencies = {}) {
  const storageSession = dependencies.storageSession;
  const storageLocal = dependencies.storageLocal || storageSession?.durable;
  if (!storageSession?.remove) {
    throw new Error('Cleanup review session storage is unavailable.');
  }
  let hostPermissionCleanup = {
    found: false,
    released: false,
    accessRemains: null,
    recordRetained: false,
    permissionsPreserved: true,
    reason: 'no_lease'
  };
  if (record?.permissionLeaseId) {
    if (!storageLocal) throw new Error('Cleanup permission lease storage is unavailable.');
    hostPermissionCleanup = await discardUninvokedPermissionLease(storageLocal, record.permissionLeaseId);
    if (hostPermissionCleanup.recordRetained === true) return hostPermissionCleanup;
  }
  await storageSession.remove(CLEANUP_REVIEW_STORAGE_KEY);
  return hostPermissionCleanup;
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
    storagePartitionDisclosureAppliedAt: _storagePartitionDisclosureAppliedAt,
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
    if (
      (record.approvalHandoff?.status !== 'prompt_tombstone' && !record.approvalHandoff?.promptInvocation) ||
      record.approvalHandoff?.promptGrant?.complete !== true ||
      record.approvalHandoff?.promptGrantOutcome?.granted !== true ||
      record.approvalHandoff.promptGrantOutcome.preRequestTemporaryOriginsAbsent !== true
    ) {
      return discardUninvokedPermissionLease(dependencies.storageLocal, record.permissionLeaseId);
    }
    return reconcilePermissionLease(
      dependencies.storageLocal,
      {
        containsHostPermissions: dependencies.containsHostPermissions || dependencies.hasHostPermissions,
        getAllHostPermissions: dependencies.getAllHostPermissions,
        releaseHostPermissions: dependencies.releaseHostPermissions,
        preserveLivePrepared: dependencies.preserveLivePrepared,
        forcePromptSettlement: dependencies.forcePromptSettlement,
        beforeLeaseRemoval: dependencies.beforePermissionLeaseRemoval,
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

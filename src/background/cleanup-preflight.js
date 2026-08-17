import { normalizeSiteInput, applyAssociatedDomainGroups } from './domain.js';
import { findProtectedBrowserServiceTargets } from '../shared/safety.js';
import { getEffectiveCleanupSettings } from '../shared/cleanup-mode.js';
import { buildCleanupReview, validateCleanupReviewApproval } from '../shared/cleanup-review.js';
import { normalizeStoredSettings } from '../shared/storage.js';
import { markPermissionLeaseActive, preparePermissionLease, reconcilePermissionLease } from './permission-leases.js';

export const CLEANUP_REVIEW_STORAGE_KEY = 'sitewipe.cleanupReview.v1';
export const CLEANUP_REVIEW_TTL_MS = 5 * 60 * 1000;
// Schema 3 deliberately invalidates every approval record created while the
// retired complete-review bypass existed. Legacy records are discarded before
// any cleanup can begin.
export const CLEANUP_REVIEW_SCHEMA_VERSION = 3;
const MAX_APPROVED_DOWNLOAD_FILE_IDS = 1000;
const REVIEW_IDENTIFIER_PATTERN = /^[a-zA-Z0-9._:-]{8,128}$/;

export async function prepareCleanupReviewRequest(payload = {}, dependencies = {}) {
  const {
    getSettings,
    isIncognitoAllowed,
    hasHostPermissions,
    inspectImpact,
    storageSession,
    storageLocal: configuredStorageLocal,
    containsHostPermissions: configuredContainsHostPermissions,
    now = () => Date.now(),
    createToken = randomApprovalToken
  } = dependencies;
  const storageLocal = configuredStorageLocal || storageSession?.durable;
  const containsHostPermissions = configuredContainsHostPermissions || hasHostPermissions;
  dependencies = { ...dependencies, storageLocal, containsHostPermissions };
  assertDependencies({
    getSettings,
    isIncognitoAllowed,
    hasHostPermissions,
    inspectImpact,
    storageSession,
    storageLocal,
    containsHostPermissions
  });

  const createdAtMs = Number(now());
  if (!Number.isFinite(createdAtMs)) throw new Error('Cleanup review clock is unavailable.');
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
    if (Number.isFinite(existingRecord.expiresAtMs) && createdAtMs <= existingRecord.expiresAtMs) {
      throw new Error(
        'Another cleanup review is active. Cancel it or wait for its short expiry before reviewing again.'
      );
    }
    await storageSession.remove(CLEANUP_REVIEW_STORAGE_KEY);
    await releaseTemporaryReviewAccess(existingRecord, dependencies);
  }

  const orphanedLease = await reconcilePermissionLease(storageLocal, {
    containsHostPermissions,
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

  const sourceIncognito = Boolean(payload.sourceIncognito);
  const sourceWindowId = Number.isInteger(payload.sourceWindowId) ? payload.sourceWindowId : null;
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
  const hostPermissionsGranted =
    requestedHostPermissionOrigins.length > 0 &&
    preexistingHostPermissionOrigins.length === requestedHostPermissionOrigins.length;

  const impact = await inspectImpact(target, settings);
  const expiresAtMs = createdAtMs + CLEANUP_REVIEW_TTL_MS;
  const approvalToken = String(await createToken());
  if (!REVIEW_IDENTIFIER_PATTERN.test(approvalToken)) throw new Error('Cleanup approval token generation failed.');
  const review = buildCleanupReview({
    enteredTarget: normalized.input,
    target,
    settings,
    sourceWindowId,
    sourceIncognito,
    incognitoAccess,
    hostPermissionsGranted,
    impact,
    approvalToken,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString()
  });

  const record = {
    schemaVersion: CLEANUP_REVIEW_SCHEMA_VERSION,
    token: approvalToken,
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
    incognitoAccess,
    hostPermissionsGranted,
    preexistingHostPermissionOrigins: cloneJson(preexistingHostPermissionOrigins),
    requirements: cloneJson(review.requirements),
    approvedDownloadFileIds: Array.isArray(impact.matchedCompletedFileIds)
      ? [...new Set(impact.matchedCompletedFileIds.map((id) => String(id)))]
      : []
  };

  const permissionLease = await preparePermissionLease(storageLocal, {
    requestedOrigins: requestedHostPermissionOrigins,
    preexistingOrigins: preexistingHostPermissionOrigins,
    reviewExpiresAt: review.expiresAt,
    now
  });
  record.permissionLeaseId = permissionLease?.id || null;
  try {
    await storageSession.set({ [CLEANUP_REVIEW_STORAGE_KEY]: record });
  } catch (error) {
    if (permissionLease) {
      await reconcilePermissionLease(
        storageLocal,
        {
          containsHostPermissions,
          releaseHostPermissions: dependencies.releaseHostPermissions,
          now
        },
        permissionLease.id
      ).catch(() => {});
    }
    throw error;
  }
  return { review };
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
  if (!storageSession?.get || !storageSession?.remove)
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
  await storageSession.remove(CLEANUP_REVIEW_STORAGE_KEY);
  return {
    canceled: true,
    hostPermissionCleanup: await releaseTemporaryReviewAccess(record, dependencies)
  };
}

export async function consumeCleanupReviewRequest(payload = {}, dependencies = {}) {
  const storageSession = dependencies.storageSession;
  dependencies = {
    ...dependencies,
    storageLocal: dependencies.storageLocal || storageSession?.durable
  };
  const now = dependencies.now || (() => Date.now());
  if (!storageSession?.get || !storageSession?.remove)
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

  // Consume before validation so a token cannot be replayed after any approval attempt.
  await storageSession.remove(CLEANUP_REVIEW_STORAGE_KEY);

  try {
    if (!Number.isFinite(record.expiresAtMs) || Number(now()) > record.expiresAtMs) {
      throw new Error('This cleanup approval expired. Start the cleanup again.');
    }
    const sourceWindowId = Number.isInteger(payload.sourceWindowId) ? payload.sourceWindowId : null;
    if (
      sourceWindowId !== record.sourceWindowId ||
      Boolean(payload.sourceIncognito) !== Boolean(record.sourceIncognito)
    ) {
      throw new Error('The cleanup context changed after preflight. Start again from this window.');
    }

    const validation = validateCleanupReviewApproval(record.requirements, payload.approval || {});
    if (!validation.ok) throw new Error(validation.errors.join(' '));
    if (record.permissionLeaseId) {
      const activeLease = await markPermissionLeaseActive(
        dependencies.storageLocal,
        record.permissionLeaseId,
        dependencies.now || (() => Date.now())
      );
      if (!activeLease) throw new Error('The durable target-access lease is missing. Start the cleanup again.');
    }
    return cloneJson({ ...record, approvalMode: validation.approvalMode });
  } catch (error) {
    await releaseTemporaryReviewAccess(record, dependencies);
    throw error;
  }
}

export async function clearExpiredCleanupReview(storageSession, now = Date.now(), dependencies = {}) {
  dependencies = {
    ...dependencies,
    storageSession,
    storageLocal: dependencies.storageLocal || storageSession?.durable
  };
  if (!storageSession?.get || !storageSession?.remove) return false;
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
  await storageSession.remove(CLEANUP_REVIEW_STORAGE_KEY);
  return {
    expired: true,
    hostPermissionCleanup: await releaseTemporaryReviewAccess(record, dependencies)
  };
}

export async function clearCleanupReviewState(storageSession, dependencies = {}) {
  dependencies = {
    ...dependencies,
    storageSession,
    storageLocal: dependencies.storageLocal || storageSession?.durable
  };
  if (!storageSession?.get || !storageSession?.remove) {
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
  await storageSession.remove(CLEANUP_REVIEW_STORAGE_KEY);
  return {
    cleared: true,
    hostPermissionCleanup: await releaseTemporaryReviewAccess(record, dependencies)
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

    const approvedDownloadFileIds = normalizeDownloadFileIds(value.approvedDownloadFileIds);
    if (!approvedDownloadFileIds) return null;
    const expectedReview = buildCleanupReview({
      enteredTarget: canonicalInput,
      target: resolved.target,
      settings,
      sourceWindowId,
      sourceIncognito: value.sourceIncognito,
      incognitoAccess: value.incognitoAccess,
      hostPermissionsGranted,
      impact: { matchedCompletedFileIds: approvedDownloadFileIds },
      approvalToken: token,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString()
    });
    if (!jsonEquivalent(value.requirements, expectedReview.requirements)) {
      return null;
    }

    const temporaryOrigins = requestedOrigins.filter((origin) => !preexistingHostPermissionOrigins.includes(origin));
    const permissionLeaseId = value.permissionLeaseId == null ? null : String(value.permissionLeaseId);
    if (
      (permissionLeaseId !== null && !REVIEW_IDENTIFIER_PATTERN.test(permissionLeaseId)) ||
      temporaryOrigins.length > 0 !== Boolean(permissionLeaseId)
    ) {
      return null;
    }

    return {
      schemaVersion: CLEANUP_REVIEW_SCHEMA_VERSION,
      token,
      createdAtMs,
      expiresAtMs,
      canonicalInput,
      target: cloneJson(resolved.target),
      settings: cloneJson(settings),
      associated: cloneJson(associated),
      sourceWindowId,
      sourceIncognito: value.sourceIncognito,
      incognitoAccess: value.incognitoAccess,
      hostPermissionsGranted,
      preexistingHostPermissionOrigins,
      requirements: cloneJson(expectedReview.requirements),
      approvedDownloadFileIds,
      permissionLeaseId
    };
  } catch {
    return null;
  }
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
      releaseHostPermissions: dependencies.releaseHostPermissions,
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

function normalizeIsoTimestamp(value) {
  const timestamp = Date.parse(String(value || ''));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function jsonEquivalent(left, right) {
  return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right));
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

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

async function releaseTemporaryReviewAccess(record, dependencies = {}) {
  if (record?.permissionLeaseId && dependencies.storageLocal) {
    return reconcilePermissionLease(
      dependencies.storageLocal,
      {
        containsHostPermissions: dependencies.containsHostPermissions || dependencies.hasHostPermissions,
        releaseHostPermissions: dependencies.releaseHostPermissions,
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

function normalizeOrigins(origins) {
  return Array.isArray(origins) ? [...new Set(origins.map(String).filter(Boolean))] : [];
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

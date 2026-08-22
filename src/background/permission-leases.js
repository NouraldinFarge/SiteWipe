import { STORAGE_KEYS } from '../shared/constants.js';
import { getRegistrableDomain } from '../shared/public-suffix.js';
import { findProtectedBrowserServiceTargets } from '../shared/safety.js';
import { scrubSensitiveText } from '../shared/report-redaction.js';

export const PERMISSION_LEASE_SCHEMA_VERSION = 2;
export const PERMISSION_PROMPT_PENDING_TTL_MS = 30 * 60 * 1000;
const MAX_PERMISSION_ORIGINS = 128;
/** @type {Promise<unknown>} */
let permissionLeaseMutation = Promise.resolve();

export async function getPermissionLease(storageLocal) {
  assertStorageArea(storageLocal);
  const data = await storageLocal.get([STORAGE_KEYS.permissionLease]);
  const raw = data?.[STORAGE_KEYS.permissionLease];
  if (raw == null) return null;
  const lease = normalizePermissionLease(raw);
  if (!lease) {
    throw new Error(
      'The durable target-access lease is invalid. Site access was not changed; review the extension site-access controls before continuing.'
    );
  }
  return lease;
}

export async function preparePermissionLease(
  storageLocal,
  {
    requestedOrigins = [],
    preexistingOrigins = [],
    reviewExpiresAt = null,
    now = () => Date.now(),
    createId = randomLeaseId
  } = {}
) {
  return serializePermissionLeaseMutation(async () => {
    assertStorageArea(storageLocal);
    const requested = normalizeOrigins(requestedOrigins, { strict: true });
    const preexistingSet = new Set(normalizeOrigins(preexistingOrigins, { strict: true }));
    const temporaryOrigins = requested.filter((origin) => !preexistingSet.has(origin));
    if (!temporaryOrigins.length) return null;

    const nowMs = Number(now());
    if (!Number.isFinite(nowMs)) throw new Error('Permission lease clock is unavailable.');
    const normalizedReviewExpiresAt = normalizeTimestamp(reviewExpiresAt);
    if (!normalizedReviewExpiresAt || Date.parse(normalizedReviewExpiresAt) <= nowMs) {
      throw new Error('Permission lease review expiration is invalid.');
    }
    const id = String(await createId());
    if (!/^[a-zA-Z0-9._:-]{8,128}$/.test(id)) throw new Error('Permission lease identifier is invalid.');
    const lease = {
      schemaVersion: PERMISSION_LEASE_SCHEMA_VERSION,
      id,
      status: 'prepared',
      requestedOrigins: requested,
      preexistingOrigins: requested.filter((origin) => preexistingSet.has(origin)),
      temporaryOrigins,
      createdAt: new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
      reviewExpiresAt: normalizedReviewExpiresAt,
      promptPendingUntil: null,
      releaseAttemptCount: 0,
      lastReleaseAttemptAt: null,
      lastError: null
    };
    await storageLocal.set({ [STORAGE_KEYS.permissionLease]: lease });
    return lease;
  });
}

export async function markPermissionLeaseActive(storageLocal, leaseId, now = () => Date.now(), expectedBinding = null) {
  return serializePermissionLeaseMutation(async () => {
    assertStorageArea(storageLocal);
    const lease = await getPermissionLease(storageLocal);
    if (!lease || lease.id !== String(leaseId || '')) return null;
    const binding = normalizePermissionLeaseBinding(expectedBinding);
    if (lease.status !== 'prompt_pending' || !binding || !permissionLeaseBindingMatches(lease, binding)) return null;
    const nowMs = Number(now());
    if (!Number.isFinite(nowMs)) throw new Error('Permission lease clock is unavailable.');
    const updated = {
      ...lease,
      status: 'active_cleanup',
      promptPendingUntil: null,
      updatedAt: new Date(Math.max(nowMs, Date.parse(lease.createdAt))).toISOString()
    };
    await storageLocal.set({ [STORAGE_KEYS.permissionLease]: updated });
    return updated;
  });
}

function normalizePermissionLeaseBinding(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const requestedOrigins = normalizeOrigins(value.requestedOrigins, { strict: true });
    const preexistingOrigins = normalizeOrigins(value.preexistingOrigins, { strict: true });
    const temporaryOrigins = normalizeOrigins(value.temporaryOrigins, { strict: true });
    const reviewExpiresAt = normalizeTimestamp(value.reviewExpiresAt);
    if (!requestedOrigins.length || !temporaryOrigins.length || !reviewExpiresAt) return null;
    const requested = new Set(requestedOrigins);
    const preexisting = new Set(preexistingOrigins);
    const temporary = new Set(temporaryOrigins);
    if (
      preexistingOrigins.some((origin) => !requested.has(origin) || temporary.has(origin)) ||
      temporaryOrigins.some((origin) => !requested.has(origin)) ||
      requestedOrigins.some((origin) => !preexisting.has(origin) && !temporary.has(origin))
    ) {
      return null;
    }
    return { requestedOrigins, preexistingOrigins, temporaryOrigins, reviewExpiresAt };
  } catch {
    return null;
  }
}

function permissionLeaseBindingMatches(lease, binding) {
  return (
    arraysEqual(lease.requestedOrigins, binding.requestedOrigins) &&
    arraysEqual(lease.preexistingOrigins, binding.preexistingOrigins) &&
    arraysEqual(lease.temporaryOrigins, binding.temporaryOrigins) &&
    lease.reviewExpiresAt === binding.reviewExpiresAt
  );
}

export async function markPermissionLeasePromptPending(
  storageLocal,
  leaseId,
  now = () => Date.now(),
  promptTtlMs = PERMISSION_PROMPT_PENDING_TTL_MS
) {
  return serializePermissionLeaseMutation(async () => {
    assertStorageArea(storageLocal);
    const lease = await getPermissionLease(storageLocal);
    if (!lease || lease.id !== String(leaseId || '')) return null;
    if (!['prepared', 'prompt_pending'].includes(lease.status)) return null;
    const nowMs = Number(now());
    const ttlMs = Number(promptTtlMs);
    if (!Number.isFinite(nowMs) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error('Permission-prompt tracking clock is unavailable.');
    }
    const promptPendingUntil = new Date(nowMs + ttlMs).toISOString();
    const updated = {
      ...lease,
      status: 'prompt_pending',
      updatedAt: new Date(Math.max(nowMs, Date.parse(lease.createdAt))).toISOString(),
      promptPendingUntil
    };
    await storageLocal.set({ [STORAGE_KEYS.permissionLease]: updated });
    return updated;
  });
}

/**
 * Restores the exact prompt-pending lease after a concurrent review
 * invalidation finished reconciling it just as the worker received the final
 * popup click. The caller supplies the immutable, normalized review binding;
 * an unrelated lease is never overwritten.
 *
 * @param {any} storageLocal
 * @param {{
 *   id?: string,
 *   requestedOrigins?: string[],
 *   preexistingOrigins?: string[],
 *   createdAt?: string | null,
 *   reviewExpiresAt?: string | null,
 *   now?: () => number
 * }} [leaseBinding]
 */
export async function restorePermissionLeasePromptOwnership(storageLocal, leaseBinding = {}) {
  const {
    id,
    requestedOrigins = [],
    preexistingOrigins = [],
    createdAt = null,
    reviewExpiresAt = null,
    now = () => Date.now()
  } = leaseBinding;
  return serializePermissionLeaseMutation(async () => {
    assertStorageArea(storageLocal);
    const leaseId = String(id || '');
    if (!/^[a-zA-Z0-9._:-]{8,128}$/.test(leaseId)) {
      throw new Error('Permission lease identifier is invalid.');
    }
    const requested = normalizeOrigins(requestedOrigins, { strict: true });
    const preexistingSet = new Set(normalizeOrigins(preexistingOrigins, { strict: true }));
    const preexisting = requested.filter((origin) => preexistingSet.has(origin));
    const temporaryOrigins = requested.filter((origin) => !preexistingSet.has(origin));
    if (!requested.length || !temporaryOrigins.length) {
      throw new Error('Permission prompt ownership requires an exact temporary target scope.');
    }

    const normalizedCreatedAt = normalizeTimestamp(createdAt);
    const normalizedReviewExpiresAt = normalizeTimestamp(reviewExpiresAt);
    if (
      !normalizedCreatedAt ||
      !normalizedReviewExpiresAt ||
      Date.parse(normalizedReviewExpiresAt) <= Date.parse(normalizedCreatedAt)
    ) {
      throw new Error('Permission prompt ownership timestamps are invalid.');
    }
    const nowMs = Number(now());
    if (!Number.isFinite(nowMs)) throw new Error('Permission-prompt tracking clock is unavailable.');

    const existing = await getPermissionLease(storageLocal);
    if (existing?.id && existing.id !== leaseId) {
      throw new Error('A different temporary target-access lease is already active.');
    }
    const binding = {
      requestedOrigins: requested,
      preexistingOrigins: preexisting,
      temporaryOrigins,
      reviewExpiresAt: normalizedReviewExpiresAt
    };
    if (existing && !permissionLeaseBindingMatches(existing, binding)) {
      throw new Error('The temporary target-access lease no longer matches the cleanup review.');
    }
    if (existing?.status === 'active_cleanup') {
      throw new Error('An admitted cleanup lease cannot be restored as a pending browser prompt.');
    }

    const createdAtMs = Date.parse(existing?.createdAt || normalizedCreatedAt);
    const updatedAtMs = Math.max(nowMs, createdAtMs);
    const restored = {
      schemaVersion: PERMISSION_LEASE_SCHEMA_VERSION,
      id: leaseId,
      status: 'prompt_pending',
      requestedOrigins: requested,
      preexistingOrigins: preexisting,
      temporaryOrigins,
      createdAt: new Date(createdAtMs).toISOString(),
      updatedAt: new Date(updatedAtMs).toISOString(),
      reviewExpiresAt: normalizedReviewExpiresAt,
      promptPendingUntil: new Date(updatedAtMs + PERMISSION_PROMPT_PENDING_TTL_MS).toISOString(),
      releaseAttemptCount: Number(existing?.releaseAttemptCount || 0),
      lastReleaseAttemptAt: existing?.lastReleaseAttemptAt || null,
      lastError: existing?.lastError || null
    };
    await storageLocal.set({ [STORAGE_KEYS.permissionLease]: restored });
    return restored;
  });
}

export function isPreparedPermissionLeaseLive(lease, now = Date.now()) {
  if (lease?.status !== 'prepared') return false;
  const expiresAt = Date.parse(lease.reviewExpiresAt || '');
  const nowMs = Number(now);
  return Number.isFinite(expiresAt) && Number.isFinite(nowMs) && nowMs <= expiresAt;
}

/**
 * Releases only host patterns that were absent before the review. The durable
 * record is removed only after the full permission inventory proves every
 * temporary exact pattern is absent. Isolated unit consumers may use the
 * contains() compatibility adapter; production supplies getAll() so a broader
 * user grant cannot masquerade as an independently held exact pattern.
 */
export async function reconcilePermissionLease(storageLocal, dependencies = {}, expectedLeaseId = null) {
  return serializePermissionLeaseMutation(async () => {
    assertStorageArea(storageLocal);
    const lease = await getPermissionLease(storageLocal);
    if (!lease) {
      return {
        found: false,
        released: true,
        accessRemains: false,
        recordRetained: false,
        reason: 'no_lease'
      };
    }
    if (expectedLeaseId && lease.id !== String(expectedLeaseId)) {
      return {
        found: true,
        released: false,
        accessRemains: null,
        recordRetained: true,
        reason: 'lease_mismatch',
        leaseId: lease.id
      };
    }
    if (dependencies.promptSettlementOnly === true && !['prepared', 'prompt_pending'].includes(lease.status)) {
      return {
        found: true,
        released: false,
        accessRemains: null,
        recordRetained: true,
        leaseId: lease.id,
        reason: 'lease_not_awaiting_permission_prompt'
      };
    }

    const nowMs = Number(typeof dependencies.now === 'function' ? dependencies.now() : Date.now());
    if (
      lease.status === 'prepared' &&
      dependencies.preserveLivePrepared === true &&
      isPreparedPermissionLeaseLive(lease, nowMs)
    ) {
      return {
        found: true,
        released: false,
        accessRemains: null,
        recordRetained: true,
        leaseId: lease.id,
        reason: 'prepared_authorization_live'
      };
    }
    if (
      lease.status === 'prompt_pending' &&
      dependencies.forcePromptSettlement !== true &&
      Number.isFinite(nowMs) &&
      nowMs <= Date.parse(lease.promptPendingUntil || '')
    ) {
      return {
        found: true,
        released: false,
        accessRemains: null,
        recordRetained: true,
        leaseId: lease.id,
        reason: 'permission_prompt_pending'
      };
    }

    const containsHostPermissions = dependencies.containsHostPermissions;
    const getAllHostPermissions = dependencies.getAllHostPermissions;
    const releaseHostPermissions = dependencies.releaseHostPermissions;
    if (
      typeof getAllHostPermissions !== 'function' &&
      (typeof containsHostPermissions !== 'function' || typeof releaseHostPermissions !== 'function')
    ) {
      return retainLease(storageLocal, lease, 'Permission cleanup adapters are unavailable.', dependencies.now);
    }
    if (typeof releaseHostPermissions !== 'function') {
      return retainLease(storageLocal, lease, 'Permission cleanup adapters are unavailable.', dependencies.now);
    }

    const before = await queryGrantedOrigins(lease.temporaryOrigins, containsHostPermissions, getAllHostPermissions);
    if (!before.ok) return retainLease(storageLocal, lease, before.error, dependencies.now);
    if (!before.granted.length) {
      await storageLocal.remove(STORAGE_KEYS.permissionLease);
      return {
        found: true,
        attempted: false,
        released: true,
        accessRemains: false,
        grantedBefore: [],
        grantedAfter: [],
        recordRetained: false,
        leaseId: lease.id,
        reason: 'already_absent'
      };
    }

    let removeResult = false;
    let removeError = null;
    try {
      removeResult = Boolean(await releaseHostPermissions(before.granted));
    } catch (error) {
      removeError = readableMessage(error);
    }

    const after = await queryGrantedOrigins(lease.temporaryOrigins, containsHostPermissions, getAllHostPermissions);
    if (!after.ok) {
      return retainLease(
        storageLocal,
        lease,
        removeError || `Permission state could not be verified after release: ${after.error}`,
        dependencies.now,
        true
      );
    }
    if (!after.granted.length) {
      await storageLocal.remove(STORAGE_KEYS.permissionLease);
      return {
        found: true,
        attempted: true,
        removeResult,
        released: true,
        accessRemains: false,
        grantedBefore: before.granted,
        grantedAfter: [],
        recordRetained: false,
        leaseId: lease.id,
        reason: 'absence_proved'
      };
    }

    const retained = await retainLease(
      storageLocal,
      lease,
      removeError || 'One or more temporary target permissions remain after release.',
      dependencies.now,
      true
    );
    return {
      ...retained,
      attempted: true,
      removeResult,
      grantedBefore: before.granted,
      grantedAfter: after.granted,
      accessRemains: true
    };
  });
}

async function retainLease(storageLocal, lease, error, now = () => Date.now(), attempted = false) {
  const requestedNowMs = Number(typeof now === 'function' ? now() : Date.now());
  const fallbackNowMs = Number.isFinite(requestedNowMs) ? requestedNowMs : Date.now();
  const nowMs = Math.max(fallbackNowMs, Date.parse(lease.createdAt));
  const retained = {
    ...lease,
    status: 'release_pending',
    promptPendingUntil: null,
    updatedAt: new Date(nowMs).toISOString(),
    releaseAttemptCount: Number(lease.releaseAttemptCount || 0) + (attempted ? 1 : 0),
    lastReleaseAttemptAt: attempted ? new Date(nowMs).toISOString() : lease.lastReleaseAttemptAt,
    lastError: scrubSensitiveText(error || 'Temporary permission release remains uncertain.').slice(0, 500)
  };
  await storageLocal.set({ [STORAGE_KEYS.permissionLease]: retained });
  return {
    found: true,
    attempted,
    released: false,
    accessRemains: null,
    recordRetained: true,
    leaseId: lease.id,
    reason: 'release_pending',
    error: retained.lastError
  };
}

async function queryGrantedOrigins(origins, containsHostPermissions, getAllHostPermissions) {
  const granted = [];
  try {
    if (typeof getAllHostPermissions === 'function') {
      const snapshot = await getAllHostPermissions();
      if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.origins)) {
        throw new Error('Host-permission inventory returned an invalid response.');
      }
      if (snapshot.origins.some((origin) => typeof origin !== 'string')) {
        throw new Error('Host-permission inventory contained an invalid origin pattern.');
      }
      const exactGranted = new Set(snapshot.origins);
      return {
        ok: true,
        granted: normalizeOrigins(origins).filter((origin) => exactGranted.has(origin))
      };
    }
    for (const origin of normalizeOrigins(origins)) {
      if (await containsHostPermissions([origin])) granted.push(origin);
    }
    return { ok: true, granted };
  } catch (error) {
    return { ok: false, granted: [], error: readableMessage(error) };
  }
}

function normalizePermissionLease(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (Number(value.schemaVersion) !== PERMISSION_LEASE_SCHEMA_VERSION) return null;
    const id = String(value.id || '');
    const statuses = ['prepared', 'prompt_pending', 'active_cleanup', 'release_pending'];
    if (!/^[a-zA-Z0-9._:-]{8,128}$/.test(id) || !statuses.includes(value.status)) return null;

    const requestedOrigins = normalizeOrigins(value.requestedOrigins, { strict: true });
    const preexistingOrigins = normalizeOrigins(value.preexistingOrigins, { strict: true });
    const temporaryOrigins = normalizeOrigins(value.temporaryOrigins, { strict: true });
    if (!requestedOrigins.length || !temporaryOrigins.length) return null;
    const requested = new Set(requestedOrigins);
    const preexisting = new Set(preexistingOrigins);
    const temporary = new Set(temporaryOrigins);
    if (
      preexistingOrigins.some((origin) => !requested.has(origin) || temporary.has(origin)) ||
      temporaryOrigins.some((origin) => !requested.has(origin)) ||
      requestedOrigins.some((origin) => !preexisting.has(origin) && !temporary.has(origin))
    ) {
      return null;
    }

    const createdAt = normalizeTimestamp(value.createdAt);
    const updatedAt = normalizeTimestamp(value.updatedAt);
    const reviewExpiresAt = normalizeTimestamp(value.reviewExpiresAt);
    if (!createdAt || !updatedAt || !reviewExpiresAt) return null;
    const createdAtMs = Date.parse(createdAt);
    const updatedAtMs = Date.parse(updatedAt);
    const reviewExpiresAtMs = Date.parse(reviewExpiresAt);
    if (updatedAtMs < createdAtMs || reviewExpiresAtMs <= createdAtMs) return null;
    const promptPendingUntil = normalizeTimestamp(value.promptPendingUntil);
    if (
      (value.status === 'prompt_pending' && (!promptPendingUntil || Date.parse(promptPendingUntil) <= updatedAtMs)) ||
      (value.status !== 'prompt_pending' && value.promptPendingUntil != null)
    ) {
      return null;
    }
    const releaseAttemptCount = Number(value.releaseAttemptCount);
    if (!Number.isSafeInteger(releaseAttemptCount) || releaseAttemptCount < 0) return null;
    const lastReleaseAttemptAt = normalizeTimestamp(value.lastReleaseAttemptAt);
    if (value.lastReleaseAttemptAt != null && !lastReleaseAttemptAt) return null;
    if (
      (releaseAttemptCount === 0 && lastReleaseAttemptAt) ||
      (releaseAttemptCount > 0 && !lastReleaseAttemptAt) ||
      (lastReleaseAttemptAt &&
        (Date.parse(lastReleaseAttemptAt) < createdAtMs || Date.parse(lastReleaseAttemptAt) > updatedAtMs))
    ) {
      return null;
    }
    if (value.lastError != null && typeof value.lastError !== 'string') return null;

    return {
      schemaVersion: PERMISSION_LEASE_SCHEMA_VERSION,
      id,
      status: value.status,
      requestedOrigins,
      preexistingOrigins,
      temporaryOrigins,
      createdAt,
      updatedAt,
      reviewExpiresAt,
      promptPendingUntil,
      releaseAttemptCount,
      lastReleaseAttemptAt,
      lastError: value.lastError ? scrubSensitiveText(value.lastError).slice(0, 500) : null
    };
  } catch {
    return null;
  }
}

function normalizeOrigins(origins, { strict = false } = {}) {
  if (!Array.isArray(origins)) {
    if (strict) throw new Error('Target host-permission patterns must be an array.');
    return [];
  }
  if (origins.length > MAX_PERMISSION_ORIGINS) {
    if (strict) throw new Error('Too many target host-permission patterns were provided.');
    origins = origins.slice(0, MAX_PERMISSION_ORIGINS);
  }
  if (strict && origins.some((value) => typeof value !== 'string' || !value)) {
    throw new Error('A target host-permission pattern is invalid.');
  }
  const values = origins.map(String).filter(Boolean);
  const valid = values.filter((value) => canonicalHostPermissionPattern(value) === value);
  if (strict && valid.length !== values.length) throw new Error('A target host-permission pattern is invalid.');
  const unique = [...new Set(valid)];
  if (strict && unique.length !== values.length) {
    throw new Error('Target host-permission patterns must be unique.');
  }
  return unique;
}

function arraysEqual(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function canonicalHostPermissionPattern(value) {
  const match = String(value).match(/^(https?):\/\/(\*\.)?([^/]+)\/\*$/i);
  if (!match || match[3].includes('*')) return null;
  const wildcard = Boolean(match[2]);
  try {
    const parsed = new URL(`${match[1].toLowerCase()}://${wildcard ? 'wildcard.' : ''}${match[3]}/`);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || !parsed.hostname)
      return null;
    const hostname = wildcard ? parsed.hostname.replace(/^wildcard\./, '') : parsed.hostname;
    if (!isReviewedTargetHostname(hostname, wildcard)) return null;
    if (findProtectedBrowserServiceTargets({ domain: hostname, associatedTargets: [] }).length) return null;
    if (wildcard && parsed.port) return null;
    const host = wildcard ? `*.${hostname}` : parsed.host;
    const canonical = `${parsed.protocol}//${host}/*`;
    return String(value) === canonical ? canonical : null;
  } catch {
    return null;
  }
}

function isReviewedTargetHostname(value, wildcard) {
  const hostname = String(value || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (!hostname || hostname === '*') return false;
  const isLocal = hostname === 'localhost' || hostname.endsWith('.localhost');
  const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
  const isIpv6 = hostname.includes(':');
  if (isLocal || isIpv4 || isIpv6) return !wildcard;
  return Boolean(getRegistrableDomain(hostname));
}

function normalizeTimestamp(value) {
  if (!value) return null;
  const timestamp = Date.parse(String(value));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function randomLeaseId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(24);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
}

/**
 * @template T
 * @param {() => Promise<T> | T} operation
 * @returns {Promise<T>}
 */
function serializePermissionLeaseMutation(operation) {
  const result = permissionLeaseMutation.catch(() => {}).then(operation);
  permissionLeaseMutation = result.catch(() => {});
  return result;
}

function assertStorageArea(storageArea) {
  if (!storageArea?.get || !storageArea?.set || !storageArea?.remove) {
    throw new Error('Durable permission-lease storage is unavailable.');
  }
}

function readableMessage(error) {
  return error?.message || String(error);
}

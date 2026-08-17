export const CLEANUP_JOB_STATUSES = Object.freeze(['running', 'completed', 'failed', 'cancelled', 'interrupted']);

const JOB_STATUS_SET = new Set(CLEANUP_JOB_STATUSES);
const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const SAME_JOB_TRANSITIONS = Object.freeze({
  running: new Set(['running', 'completed', 'failed', 'cancelled', 'interrupted']),
  completed: new Set(['completed']),
  failed: new Set(['failed']),
  cancelled: new Set(['cancelled']),
  interrupted: new Set(['interrupted'])
});

const REPORT_STATUSES = new Set([
  'running',
  'completed',
  'completed_with_warnings',
  'failed',
  'cancelled',
  'interrupted'
]);
const SHIELD_MODES = new Set(['cleanup-only', 'post-wipe-session']);
const SHIELD_LIFECYCLES = new Set(['installing', 'active', 'unknown']);
const DNR_RULE_MIN = 730000;
const DNR_RULE_MAX = 730499;
const MAX_STORED_REPORT_BYTES = 2 * 1024 * 1024;

export function normalizeCleanupJob(value) {
  if (!isPlainObject(value)) return null;
  const id = boundedText(value.id, 128);
  const status = boundedText(value.status, 32);
  const startedAt = validTimestamp(value.startedAt);
  const updatedAt = validTimestamp(value.updatedAt);
  if (!id || !JOB_STATUS_SET.has(status) || !startedAt || !updatedAt) return null;

  const output = {
    id,
    status,
    targetDomain: boundedText(value.targetDomain, 512) || '[redacted-target]',
    startedAt,
    updatedAt,
    percent: clampNumber(value.percent, 0, 100, status === 'completed' ? 100 : 0),
    phase: boundedText(value.phase, 128) || status,
    label: boundedText(value.label, 256) || status,
    detail: boundedText(value.detail, 1600) || '',
    cancelRequested: Boolean(value.cancelRequested)
  };
  for (const key of ['completedAt', 'failedAt', 'canceledAt', 'interruptedAt']) {
    const timestamp = validTimestamp(value[key]);
    if (timestamp) output[key] = timestamp;
  }
  const recoveryReason = boundedText(value.recoveryReason, 128);
  if (recoveryReason) output.recoveryReason = recoveryReason;
  return output;
}

export function assertCleanupJobTransition(previousValue, nextValue) {
  const previous = previousValue == null ? null : normalizeCleanupJob(previousValue);
  const next = normalizeCleanupJob(nextValue);
  if (!next) throw new Error('Cleanup job state is invalid.');
  if (!previous) {
    if (next.status !== 'running') throw new Error('A new cleanup job must begin in the running state.');
    return next;
  }
  if (previous.id !== next.id) {
    if (next.status !== 'running') throw new Error('A replacement cleanup job must begin in the running state.');
    return next;
  }
  if (!SAME_JOB_TRANSITIONS[previous.status]?.has(next.status)) {
    throw new Error(`Invalid cleanup job transition: ${previous.status} -> ${next.status}.`);
  }
  if (TERMINAL_JOB_STATUSES.has(previous.status) && next.status === previous.status) return next;
  return next;
}

export function normalizeActiveShield(value) {
  if (!isPlainObject(value)) return null;
  const ruleIds = [
    ...new Set(
      (Array.isArray(value.ruleIds) ? value.ruleIds : [])
        .map(Number)
        .filter((id) => Number.isInteger(id) && id >= DNR_RULE_MIN && id <= DNR_RULE_MAX)
    )
  ].slice(0, DNR_RULE_MAX - DNR_RULE_MIN + 1);
  const mode = boundedText(value.mode, 64);
  const lifecycle = boundedText(value.lifecycle, 32) || 'active';
  const startedAt = validTimestamp(value.startedAt);
  if (!ruleIds.length || !SHIELD_MODES.has(mode) || !SHIELD_LIFECYCLES.has(lifecycle) || !startedAt) return null;
  const expiresAt = value.expiresAt == null ? null : validTimestamp(value.expiresAt);
  if (value.expiresAt != null && !expiresAt) return null;
  return {
    domain: boundedText(value.domain, 512) || '[redacted]',
    displayName: boundedText(value.displayName, 512) || '[redacted]',
    associatedTargets: Array.isArray(value.associatedTargets)
      ? value.associatedTargets.slice(0, 120).map((item) => boundedText(item, 512) || '[redacted]')
      : [],
    ruleIds,
    urlFilters: Array.isArray(value.urlFilters)
      ? value.urlFilters
          .slice(0, 500)
          .map((item) => boundedText(item, 1024))
          .filter(Boolean)
      : [],
    mode,
    lifecycle,
    expiresAt,
    startedAt,
    jobId: boundedText(value.jobId, 128) || null
  };
}

export function isStoredReport(value) {
  if (!isPlainObject(value)) return false;
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return false;
  }
  if (serialized.length > MAX_STORED_REPORT_BYTES) return false;
  if (!boundedText(value.id, 256) || !boundedText(value.appVersion, 64)) return false;
  if (!boundedText(value.targetDomain, 1024) || !validTimestamp(value.startedAt)) return false;
  if (value.finishedAt != null && !validTimestamp(value.finishedAt)) return false;
  if (!REPORT_STATUSES.has(value.status)) return false;
  if (!isPlainObject(value.summary)) return false;
  for (const key of ['sections', 'errors', 'skipped', 'unavailable']) {
    if (!Array.isArray(value[key])) return false;
  }
  return value.integrity == null || isPlainObject(value.integrity);
}

export function normalizeMaintenanceSnapshot(value) {
  if (!isPlainObject(value)) return null;
  const at = validTimestamp(value.at);
  if (!at) return null;
  return {
    reason: boundedText(value.reason, 128) || 'unknown',
    at,
    shieldExpired: Boolean(value.shieldExpired),
    reportExpired: Boolean(value.reportExpired),
    staleJobRecovered: Boolean(value.staleJobRecovered),
    orphanShieldRepaired: Boolean(value.orphanShieldRepaired),
    cleanupReviewExpired: Boolean(value.cleanupReviewExpired),
    temporaryHostAccessReleased: Boolean(value.temporaryHostAccessReleased),
    temporaryHostAccessRecoveryPending: Boolean(value.temporaryHostAccessRecoveryPending)
  };
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedText(value, maxLength) {
  return typeof value === 'string' ? value.slice(0, maxLength) : '';
}

function validTimestamp(value) {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function clampNumber(value, minimum, maximum, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

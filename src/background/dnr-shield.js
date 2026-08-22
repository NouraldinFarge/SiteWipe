import { addError, addSection, addUnavailable } from './report.js';
import { listCleanupTargets } from '../shared/target-scope.js';

export const DNR_RULE_BASE_ID = 730000;
export const DNR_RULE_RANGE_SIZE = 500;
export const SITEWIPE_DNR_RULE_IDS = Object.freeze(
  Array.from({ length: DNR_RULE_RANGE_SIZE }, (_, index) => DNR_RULE_BASE_ID + index)
);

/** @type {NonNullable<chrome.declarativeNetRequest.RuleCondition['resourceTypes']>} */
const DNR_RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other'
];

const DEFAULT_DNR_UPDATE_TIMEOUT_MS = 15000;
const DNR_TIMEOUT = Symbol('sitewipe-dnr-timeout');
const pendingDnrMutationOperations = new Set();

export function hasPendingSiteWipeDnrMutation() {
  return pendingDnrMutationOperations.size > 0;
}

/**
 * Builds only rules inside SiteWipe's reserved session-rule range.
 * @param {object} target normalized cleanup target
 * @returns {{rules: chrome.declarativeNetRequest.Rule[], ruleIds: number[], urlFilters: string[]}}
 */
export function buildTemporaryDnrShieldRules(target) {
  const shieldTargets = listCleanupTargets(target).slice(0, DNR_RULE_RANGE_SIZE);
  /** @type {chrome.declarativeNetRequest.Rule[]} */
  const rules = [];
  const urlFilters = [];
  let nextRuleId = DNR_RULE_BASE_ID;
  for (const item of shieldTargets) {
    const exactOrigin = item.matchMode === 'exact_origin' ? String(item.exactOrigin || '').replace(/\/$/, '') : '';
    const urlFilter = exactOrigin ? `|${exactOrigin}/` : `||${item.domain}^`;
    urlFilters.push(urlFilter);
    rules.push({
      id: nextRuleId++,
      priority: 1,
      action: { type: 'block' },
      condition: { urlFilter, resourceTypes: [...DNR_RESOURCE_TYPES] }
    });
  }
  return { rules, ruleIds: rules.map((rule) => rule.id), urlFilters };
}

/**
 * Atomically replaces SiteWipe-owned session rules. A timeout never means the
 * browser rejected the operation; callers must retain recovery state.
 * @param {chrome.declarativeNetRequest.Rule[]} rules
 * @param {{timeoutMs?: number, onMutationSettled?:(settlement: Record<string, unknown>) => (Promise<void> | void)}} [options]
 */
export async function replaceSiteWipeDnrShieldRules(rules, options = {}) {
  if (!chrome.declarativeNetRequest?.updateSessionRules) throw new Error('chrome.declarativeNetRequest is unavailable');
  const addRules = Array.isArray(rules) ? rules : [];
  const operation = chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [...SITEWIPE_DNR_RULE_IDS],
    addRules
  });
  try {
    return await withDnrTimeout(operation, options.timeoutMs, 'DNR shield replace');
  } catch (error) {
    trackTimedOutDnrMutation(operation, error, options.onMutationSettled);
    throw error;
  }
}

/**
 * Removes only IDs in SiteWipe's reserved range. Passing foreign IDs cannot
 * remove another feature's or extension's rules.
 */
export async function clearSiteWipeDnrRules(ruleIds = SITEWIPE_DNR_RULE_IDS, options = {}) {
  if (!chrome.declarativeNetRequest?.updateSessionRules)
    return { ok: false, reason: 'chrome.declarativeNetRequest unavailable' };
  const requested = Array.isArray(ruleIds) && ruleIds.length ? ruleIds : SITEWIPE_DNR_RULE_IDS;
  const ids = [
    ...new Set(
      requested
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id >= DNR_RULE_BASE_ID && id < DNR_RULE_BASE_ID + DNR_RULE_RANGE_SIZE)
    )
  ];
  if (!ids.length) return { ok: true, ruleIds: [] };
  const operation = chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: ids
  });
  try {
    await withDnrTimeout(operation, options.timeoutMs, 'DNR shield clear');
  } catch (error) {
    trackTimedOutDnrMutation(operation, error, options.onMutationSettled);
    throw error;
  }
  return { ok: true, ruleIds: ids };
}

export async function getSiteWipeDnrDiagnostics(activeShield = null) {
  const diagnostics = {
    available: Boolean(chrome.declarativeNetRequest?.getSessionRules),
    rangeStart: DNR_RULE_BASE_ID,
    rangeEnd: DNR_RULE_BASE_ID + DNR_RULE_RANGE_SIZE - 1,
    trackedRuleIds: Array.isArray(activeShield?.ruleIds) ? activeShield.ruleIds.filter(isSiteWipeRuleId) : [],
    activeRuleIds: [],
    orphanRuleIds: [],
    missingTrackedRuleIds: [],
    siteWipeRuleCount: 0,
    activeShieldRecorded: Boolean(activeShield),
    lifecycle: activeShield?.lifecycle || null,
    expiresAt: activeShield?.expiresAt || null,
    expired: Boolean(activeShield?.expiresAt && Date.parse(activeShield.expiresAt) <= Date.now()),
    healthy: true,
    note: ''
  };
  if (!diagnostics.available) {
    diagnostics.healthy = false;
    diagnostics.note = 'chrome.declarativeNetRequest.getSessionRules is unavailable in this browser context.';
    return diagnostics;
  }
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const siteWipeRules = (rules || []).filter((rule) => isSiteWipeRuleId(rule?.id));
    diagnostics.activeRuleIds = siteWipeRules.map((rule) => rule.id).sort((a, b) => a - b);
    diagnostics.siteWipeRuleCount = diagnostics.activeRuleIds.length;
    const tracked = new Set(diagnostics.trackedRuleIds);
    const active = new Set(diagnostics.activeRuleIds);
    diagnostics.orphanRuleIds = diagnostics.activeRuleIds.filter((id) => !tracked.has(id));
    diagnostics.missingTrackedRuleIds = diagnostics.trackedRuleIds.filter((id) => !active.has(id));
    diagnostics.healthy =
      diagnostics.orphanRuleIds.length === 0 &&
      diagnostics.missingTrackedRuleIds.length === 0 &&
      activeShield?.lifecycle !== 'unknown';
    diagnostics.note = diagnostics.healthy
      ? 'Recorded SiteWipe shield state matches currently installed SiteWipe DNR session rules.'
      : 'Recorded shield state does not exactly match installed SiteWipe DNR session rules. Repair clears the complete SiteWipe-owned rule range and resets the local record.';
    if (!activeShield && diagnostics.activeRuleIds.length) {
      diagnostics.healthy = false;
      diagnostics.orphanRuleIds = diagnostics.activeRuleIds;
      diagnostics.note =
        'SiteWipe DNR session rules are installed but no active shield record exists. Repair clears the orphan rules.';
    }
    if (diagnostics.expired) {
      diagnostics.healthy = false;
      diagnostics.note =
        'The active post-wipe shield has passed its configured expiration. Maintenance will clear SiteWipe-owned rules.';
    }
    return diagnostics;
  } catch (error) {
    diagnostics.healthy = false;
    diagnostics.error = readableMessage(error);
    diagnostics.note = 'Failed to read current DNR session rules.';
    return diagnostics;
  }
}

/**
 * Installs a tracked request shield. The recovery record is persisted before
 * calling Chrome so worker termination or an API timeout cannot create an
 * untracked block.
 */
export async function installTemporaryDnrShield(target, report, options = {}) {
  const enabled = options.temporaryDnrShield !== false || options.postWipeSessionBlock === true;
  if (!enabled) {
    addSection(report, 'dnrShield', 'Temporary request shield disabled', 'skipped', {
      reason: 'Disabled in settings.'
    });
    return { installed: false, uncertain: false, ruleIds: [] };
  }
  if (options.incognitoAccess !== true) {
    report.summary.temporaryDnrShieldSkippedForNormalOnlyReview = true;
    addSection(report, 'dnrShield', 'Request shield skipped for normal-only safety', 'skipped', {
      reason:
        'The reviewed cleanup excludes private-window scope. SiteWipe cannot bind shared DNR session rules to normal windows only, so it installs no request shield and cannot affect private target traffic if browser private-access settings change during the run.',
      requestedTemporaryShield: options.temporaryDnrShield !== false,
      requestedPostWipeShield: Boolean(options.postWipeSessionBlock)
    });
    return { installed: false, uncertain: false, ruleIds: [], skippedForNormalOnlyReview: true };
  }
  if (hasPendingSiteWipeDnrMutation()) {
    addUnavailable(
      report,
      'Temporary request shield',
      'A previous SiteWipe DNR mutation is still settling. SiteWipe refused to install a newer shield that the older operation could overwrite.'
    );
    return { installed: false, uncertain: false, ruleIds: [], blockedByPendingMutation: true };
  }
  if (!chrome.declarativeNetRequest?.updateSessionRules) {
    addUnavailable(
      report,
      'Temporary request shield',
      'chrome.declarativeNetRequest is unavailable, so target network requests cannot be blocked during cleanup.'
    );
    return { installed: false, uncertain: false, ruleIds: [] };
  }
  if (typeof options.onShieldPrepared !== 'function') {
    addUnavailable(
      report,
      'Temporary request shield',
      'Persistent recovery state is unavailable, so SiteWipe refused to install a request block that could become orphaned.'
    );
    return { installed: false, uncertain: false, ruleIds: [] };
  }

  const { rules, ruleIds, urlFilters } = buildTemporaryDnrShieldRules(target);
  const shieldExpiresAt =
    options.postWipeSessionBlock && Number(options.postWipeShieldExpiresMinutes) > 0
      ? new Date(Date.now() + Number(options.postWipeShieldExpiresMinutes) * 60 * 1000).toISOString()
      : null;
  const baseRecord = {
    domain: target.domain,
    displayName: target.displayName || target.domain,
    associatedTargets: target.associatedDisplayNames || [],
    ruleIds,
    urlFilters,
    mode: options.postWipeSessionBlock ? 'post-wipe-session' : 'cleanup-only',
    pendingMutation: false,
    expiresAt: shieldExpiresAt,
    startedAt: new Date().toISOString(),
    jobId: options.shieldJobId || null
  };

  let operationPromise = null;
  try {
    // This write is part of the safety boundary: do not start the browser
    // mutation if its recovery intent cannot be persisted first.
    await options.onShieldPrepared({ ...baseRecord, lifecycle: 'installing', pendingMutation: true });
    operationPromise = chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [...SITEWIPE_DNR_RULE_IDS],
      addRules: rules
    });
    await withDnrTimeout(operationPromise, options.dnrTimeoutMs, 'DNR shield replace');
    if (typeof options.onShieldInstalled === 'function') {
      await options.onShieldInstalled({ ...baseRecord, lifecycle: 'active', pendingMutation: false });
    }
    report.summary.temporaryDnrShieldInstalled = true;
    report.summary.postWipeSessionBlockKept = Boolean(options.postWipeSessionBlock);
    addSection(report, 'dnrShield', 'Temporary request shield installed', 'success', {
      ruleIds,
      urlFilters,
      keptAfterCleanup: Boolean(options.postWipeSessionBlock),
      expiresAt: shieldExpiresAt,
      note: 'A recovery record was persisted before the atomic session-rule update. The rules block preflight-bound target requests while cleanup runs.'
    });
    return {
      installed: true,
      uncertain: false,
      operationPromise,
      ruleIds,
      keptAfterCleanup: Boolean(options.postWipeSessionBlock),
      expiresAt: shieldExpiresAt
    };
  } catch (error) {
    report.summary.temporaryDnrShieldInstalled = false;
    const typedError = /** @type {Error & {operationMayContinue?: boolean}} */ (error);
    const uncertain = Boolean(typedError?.operationMayContinue && operationPromise);
    if (uncertain && typeof options.onShieldUncertain === 'function') {
      await options.onShieldUncertain({ ...baseRecord, lifecycle: 'unknown', pendingMutation: true }).catch(() => {});
    }
    if (uncertain) trackPendingInstallSettlement(operationPromise, options);
    if (!uncertain && operationPromise) {
      await reconcileFailedInstall(options).catch(() => {});
    }
    addError(report, 'Install temporary request shield', error);
    addSection(
      report,
      'dnrShieldRecovery',
      uncertain ? 'Request-shield installation outcome is unknown' : 'Request-shield installation failed safely',
      uncertain ? 'partial' : 'error',
      {
        ruleIds,
        recoveryTracked: uncertain,
        note: uncertain
          ? 'Chrome did not settle the session-rule update before the timeout. SiteWipe retained the pre-mutation recovery record and will reconcile the owned rule range during finalization or maintenance.'
          : 'The update failed. SiteWipe attempted to clear its reserved rule range and local recovery record.'
      }
    );
    return {
      installed: false,
      uncertain,
      operationPromise,
      ruleIds,
      keptAfterCleanup: false,
      expiresAt: shieldExpiresAt
    };
  }
}

export async function finalizeTemporaryDnrShield(shield, report, options = {}) {
  if (!shield || (!shield.installed && !shield.uncertain)) return;

  if (shield.uncertain) {
    const settlement = await observeSettlement(shield.operationPromise, options.dnrReconcileTimeoutMs);
    if (settlement.state === 'fulfilled') shield.installed = true;
    if (settlement.state === 'rejected') shield.installed = false;

    // Unknown installs are never kept as a post-wipe feature. Do not start a
    // second rule mutation while the original install can still settle: both
    // calls share the owned range, and a worker loss between their settlements
    // would otherwise strand an untracked late mutation. The install's tracked
    // settlement callback schedules exclusive maintenance, which performs the
    // clear under a fresh durable marker only after this promise is terminal.
    const installStillPending = settlement.state === 'pending';
    if (installStillPending) {
      if (typeof options.onShieldUncertain === 'function') {
        await options.onShieldUncertain({ lifecycle: 'unknown', pendingMutation: true }).catch(() => {});
      }
      const diagnostics = await getSiteWipeDnrDiagnostics(null);
      report.summary.temporaryDnrShieldRemoved = false;
      addSection(report, 'dnrShieldFinal', 'Request-shield reconciliation awaits browser settlement', 'partial', {
        operationSettlement: settlement.state,
        activeRuleIdsAfterReconciliation: diagnostics.activeRuleIds,
        pointInTimeRangeEmpty: diagnostics.available && !diagnostics.error && diagnostics.activeRuleIds.length === 0,
        recoveryRecordRetained: true,
        note: 'The original install call is still pending. SiteWipe retained its recovery marker and deferred the clear so two unresolved browser mutations cannot overlap.'
      });
      return;
    }

    const reconciliation = await reconcileOwnedRange(options, {
      forgetIfCleared: true
    });
    const recoveryComplete = reconciliation.cleared;
    report.summary.temporaryDnrShieldRemoved = recoveryComplete;
    addSection(
      report,
      'dnrShieldFinal',
      recoveryComplete ? 'Uncertain request shield reconciled' : 'Request-shield reconciliation remains incomplete',
      recoveryComplete ? 'success' : 'partial',
      {
        operationSettlement: settlement.state,
        activeRuleIdsAfterReconciliation: reconciliation.activeRuleIds,
        pointInTimeRangeEmpty: reconciliation.pointInTimeRangeEmpty,
        recoveryRecordRetained: !recoveryComplete,
        note: recoveryComplete
          ? 'The complete SiteWipe-owned session-rule range is empty and the local recovery record was cleared.'
          : 'The browser did not prove the SiteWipe-owned range empty. Recovery state remains so maintenance can retry without losing track of a possible block.'
      }
    );
    return;
  }

  if (options.postWipeSessionBlock || shield.keptAfterCleanup) {
    addSection(report, 'dnrShieldFinal', 'Post-wipe request shield kept', 'success', {
      ruleIds: shield.ruleIds,
      expiresAt: shield.expiresAt || null,
      note: 'The preflight-bound target-domain session block remains active because the post-wipe shield setting is enabled. Options and scheduled maintenance expose and expire this extension-owned state.'
    });
    return;
  }

  try {
    if (typeof options.onShieldRemovalPrepared === 'function') {
      await options.onShieldRemovalPrepared({ reason: 'finalize-temporary-shield', shield });
    }
    const clearResult = await clearSiteWipeDnrRules(shield.ruleIds, {
      timeoutMs: options.dnrTimeoutMs,
      onMutationSettled: options.onShieldMutationSettled
    });
    if (clearResult?.ok !== true) {
      throw new Error('Chrome did not accept the SiteWipe request-shield removal. Recovery state was retained.');
    }
    const diagnostics = await getSiteWipeDnrDiagnostics(null);
    if (diagnostics.available !== true || diagnostics.error || diagnostics.activeRuleIds.length) {
      throw new Error(
        'SiteWipe could not prove its request-shield range empty after removal. Recovery state was retained.'
      );
    }
    if (typeof options.onShieldCleared === 'function') await options.onShieldCleared();
    report.summary.temporaryDnrShieldRemoved = true;
    addSection(report, 'dnrShieldFinal', 'Temporary request shield removed', 'success', { ruleIds: shield.ruleIds });
  } catch (error) {
    report.summary.temporaryDnrShieldRemoved = false;
    if (typeof options.onShieldUncertain === 'function') {
      const typedError = /** @type {Error & {operationMayContinue?: boolean}} */ (error);
      await options
        .onShieldUncertain({ lifecycle: 'unknown', pendingMutation: Boolean(typedError?.operationMayContinue) })
        .catch(() => {});
    }
    addError(report, 'Remove temporary request shield', error);
  }
}

async function reconcileFailedInstall(options) {
  const result = await reconcileOwnedRange(options);
  if (!result.cleared) throw new Error('Could not prove the SiteWipe-owned DNR range empty after a failed install.');
  return result;
}

async function reconcileOwnedRange(options, { forgetIfCleared = true } = {}) {
  try {
    if (typeof options.onShieldRemovalPrepared === 'function') {
      await options.onShieldRemovalPrepared({ reason: 'reconcile-owned-range' });
    }
    await clearSiteWipeDnrRules(SITEWIPE_DNR_RULE_IDS, {
      timeoutMs: options.dnrTimeoutMs,
      onMutationSettled: options.onShieldMutationSettled
    });
  } catch {
    // A timed-out removal may still complete. Diagnostics below decides whether
    // it is safe to clear the persistent recovery record.
  }
  const diagnostics = await getSiteWipeDnrDiagnostics(null);
  const pointInTimeRangeEmpty = diagnostics.available && !diagnostics.error && diagnostics.activeRuleIds.length === 0;
  const pendingMutation = hasPendingSiteWipeDnrMutation();
  const cleared = pointInTimeRangeEmpty && !pendingMutation;
  if (cleared && forgetIfCleared && typeof options.onShieldCleared === 'function') {
    await options.onShieldCleared();
  }
  return {
    cleared,
    pointInTimeRangeEmpty,
    pendingMutation,
    activeRuleIds: diagnostics.activeRuleIds,
    diagnostics
  };
}

async function observeSettlement(promise, timeoutMs = 30000) {
  if (!promise || typeof promise.then !== 'function') return { state: 'unavailable' };
  const result = await Promise.race([
    promise.then(
      () => ({ state: 'fulfilled' }),
      (error) => ({ state: 'rejected', error: readableMessage(error) })
    ),
    new Promise((resolve) => setTimeout(() => resolve({ state: 'pending' }), safeTimeout(timeoutMs, 30000)))
  ]);
  return result;
}

function trackPendingInstallSettlement(operationPromise, options) {
  if (!operationPromise || typeof operationPromise.then !== 'function') return;
  pendingDnrMutationOperations.add(operationPromise);
  void Promise.resolve(operationPromise)
    .then(
      () => ({ state: 'fulfilled' }),
      (error) => ({ state: 'rejected', error: readableMessage(error) })
    )
    .then(async (settlement) => {
      pendingDnrMutationOperations.delete(operationPromise);
      if (typeof options.onShieldMutationSettled === 'function') {
        await options.onShieldMutationSettled(settlement);
        return;
      }
      await reconcileOwnedRange(options);
    })
    .catch(() => {
      // A failed settlement callback is not evidence that every follow-up DNR
      // mutation has settled or that safety proof completed. Keep the durable
      // pending record and marker conservative; a later exclusive maintenance
      // pass or browser-session boundary owns reconciliation.
    });
}

function trackTimedOutDnrMutation(operationPromise, error, onMutationSettled) {
  const typedError = /** @type {Error & {operationMayContinue?: boolean}} */ (error);
  if (!typedError?.operationMayContinue || !operationPromise || typeof operationPromise.then !== 'function') return;
  if (pendingDnrMutationOperations.has(operationPromise)) return;
  pendingDnrMutationOperations.add(operationPromise);
  void Promise.resolve(operationPromise)
    .then(
      () => ({ state: 'fulfilled' }),
      (settlementError) => ({ state: 'rejected', error: readableMessage(settlementError) })
    )
    .then(async (settlement) => {
      pendingDnrMutationOperations.delete(operationPromise);
      if (typeof onMutationSettled === 'function') await onMutationSettled(settlement);
    })
    .catch(() => {
      // The browser mutation itself has settled; callback failure must not make
      // it look pending forever in this worker. Durable recovery state remains
      // responsible for any reconciliation that the callback could not run.
      pendingDnrMutationOperations.delete(operationPromise);
    });
}

async function withDnrTimeout(promise, timeoutMs, label) {
  const ms = safeTimeout(timeoutMs, DEFAULT_DNR_UPDATE_TIMEOUT_MS);
  let timerId;
  try {
    const result = await Promise.race([
      promise,
      new Promise((resolve) => {
        timerId = setTimeout(() => resolve(DNR_TIMEOUT), ms);
      })
    ]);
    if (result === DNR_TIMEOUT) {
      const error = new Error(
        `${label} timed out after ${ms}ms. Chrome may still finish the underlying update, so recovery state must be retained until reconciliation proves the owned rule range empty.`
      );
      error.name = 'OperationTimeoutError';
      /** @type {Error & {operationMayContinue?: boolean}} */ (error).operationMayContinue = true;
      throw error;
    }
    return result;
  } finally {
    if (timerId !== undefined) clearTimeout(timerId);
  }
}

function isSiteWipeRuleId(id) {
  return Number.isInteger(id) && id >= DNR_RULE_BASE_ID && id < DNR_RULE_BASE_ID + DNR_RULE_RANGE_SIZE;
}

function safeTimeout(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.max(1, number) : fallback;
}

function readableMessage(error) {
  return error?.message || String(error);
}

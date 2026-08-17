import { clearSiteWipeDnrRules, getSiteWipeDnrDiagnostics } from './dnr-shield.js';
import { clearActiveShieldRecord, getActiveShield, setActiveShield } from '../shared/storage.js';

/**
 * Clears the complete SiteWipe-owned DNR range and removes the recovery record
 * only after diagnostics prove that range empty. A failed or uncertain clear
 * instead retains (or reconstructs) an `unknown` recovery record.
 */
export async function reconcileOwnedShieldState(options = {}) {
  const getShield = options.getShield || getActiveShield;
  const clearRules = options.clearRules || clearSiteWipeDnrRules;
  const diagnose = options.diagnose || getSiteWipeDnrDiagnostics;
  const forget = options.forget || clearActiveShieldRecord;
  const retain = options.retain || setActiveShield;
  const activeShield = options.activeShield === undefined ? await getShield() : options.activeShield;
  let clearResult = null;
  let clearError = null;

  try {
    clearResult = await clearRules();
  } catch (error) {
    clearError = readableMessage(error);
  }

  let diagnostics;
  let diagnosticsError = null;
  try {
    diagnostics = await diagnose(activeShield);
  } catch (error) {
    diagnosticsError = readableMessage(error);
    diagnostics = {
      available: false,
      error: diagnosticsError,
      activeRuleIds: [],
      orphanRuleIds: [],
      missingTrackedRuleIds: []
    };
  }

  const activeRuleIds = [...new Set((diagnostics?.activeRuleIds || []).filter(Number.isInteger))];
  const provenEmpty = Boolean(diagnostics?.available && !diagnostics?.error && activeRuleIds.length === 0);
  if (provenEmpty) {
    await forget();
    return {
      cleared: true,
      clearResult,
      clearError,
      diagnostics,
      diagnosticsError,
      recordRetained: false,
      recoveryRecord: null
    };
  }

  const trackedRuleIds = Array.isArray(activeShield?.ruleIds) ? activeShield.ruleIds : [];
  const recoverableRuleIds = [...new Set([...trackedRuleIds, ...activeRuleIds].filter(Number.isInteger))];
  let recoveryRecord = null;
  let retentionError = null;
  if (recoverableRuleIds.length) {
    recoveryRecord = {
      domain: activeShield?.domain || '[orphaned-sitewipe-shield]',
      displayName: activeShield?.displayName || '[orphaned-sitewipe-shield]',
      associatedTargets: activeShield?.associatedTargets || [],
      ruleIds: recoverableRuleIds,
      urlFilters: activeShield?.urlFilters || [],
      mode: activeShield?.mode || 'cleanup-only',
      lifecycle: 'unknown',
      expiresAt: activeShield?.expiresAt || null,
      startedAt: activeShield?.startedAt || new Date().toISOString(),
      jobId: activeShield?.jobId || null
    };
    try {
      recoveryRecord = await retain(recoveryRecord);
    } catch (error) {
      retentionError = readableMessage(error);
    }
  }

  return {
    cleared: false,
    clearResult,
    clearError,
    diagnostics,
    diagnosticsError,
    recordRetained: Boolean(recoveryRecord && !retentionError),
    retentionError,
    recoveryRecord
  };
}

function readableMessage(error) {
  return error?.message || String(error);
}

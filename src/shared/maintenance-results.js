const LOCAL_RESET_STATUSES = new Set(['complete', 'partial', 'failed']);

export function describeLocalStateResetResponse(response) {
  const reset = response?.reset;
  if (!reset || typeof reset !== 'object' || Array.isArray(reset) || !LOCAL_RESET_STATUSES.has(reset.status)) {
    return unverified('SiteWipe did not return a verifiable local-state reset result.');
  }
  const failures = Array.isArray(reset.resetFailures) ? reset.resetFailures : null;
  const recoveryFailures = Array.isArray(reset.recoveryFailures) ? reset.recoveryFailures : null;
  const optionalPermission = reset.optionalFramePermission;
  const optionalPermissionAbsent = optionalPermission?.verifiedAbsent === true;
  const internallyComplete =
    reset.status === 'complete' &&
    reset.localStateResetComplete === true &&
    reset.dataCleared === true &&
    reset.recoveryObligationsRetained === false &&
    optionalPermissionAbsent &&
    failures?.length === 0 &&
    recoveryFailures?.length === 0;
  const internallyPartial =
    reset.status === 'partial' &&
    reset.localStateResetComplete === false &&
    reset.dataCleared === true &&
    reset.recoveryObligationsRetained === true &&
    failures?.length === 0 &&
    recoveryFailures !== null;
  const internallyFailed =
    reset.status === 'failed' &&
    reset.localStateResetComplete === false &&
    reset.dataCleared === false &&
    Boolean(failures?.length) &&
    recoveryFailures !== null;
  if (!internallyComplete && !internallyPartial && !internallyFailed) {
    return unverified('SiteWipe returned an inconsistent local-state reset result. Treat the reset as incomplete.');
  }
  return {
    status: reset.status,
    tone: reset.status === 'complete' ? 'success' : reset.status === 'partial' ? 'warning' : 'error',
    message: safeNote(reset.note, fallbackLocalResetMessage(reset.status))
  };
}

export function describeSettingsResetResponse(response) {
  const optionalPermission = response?.optionalFramePermission;
  if (optionalPermission?.verifiedAbsent === true) {
    return {
      status: 'complete',
      tone: 'success',
      message: 'Settings reset. Optional webNavigation access is absent.'
    };
  }
  return {
    status: 'partial',
    tone: 'warning',
    message:
      'Settings reset, but Chrome/Brave did not prove optional webNavigation access absent. Review SiteWipe permissions in the browser extension details.'
  };
}

function unverified(message) {
  return { status: 'failed', tone: 'error', message };
}

function safeNote(value, fallback) {
  const note = typeof value === 'string' ? value.trim().slice(0, 2000) : '';
  return note || fallback;
}

function fallbackLocalResetMessage(status) {
  if (status === 'complete') return 'SiteWipe local state was fully reset.';
  if (status === 'partial') return 'Resettable local data was cleared, but a recovery obligation remains.';
  return 'One or more SiteWipe local-state reset steps failed.';
}

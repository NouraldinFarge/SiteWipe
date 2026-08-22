import { VERIFICATION_STATES } from '../shared/verification-evidence.js';

const REQUIRED_VERIFICATION_CATEGORIES = Object.freeze(['cookies', 'tabs', 'history', 'downloads']);
const COMPLETED_VERIFICATION_STATES = new Set([VERIFICATION_STATES.verifiedZero, VERIFICATION_STATES.residueFound]);

/**
 * Normalizes the report summary without turning missing verification evidence
 * into zero. New reports carry an explicit completion flag; the narrow legacy
 * fallback accepts a terminal status only when a numeric total was retained.
 */
export function assessReportVerification(summary = {}) {
  const status = String(summary.verificationStatus || VERIFICATION_STATES.unknown).toLowerCase();
  const categories = summary.verificationCategories || {};
  const surfaceCounts = {
    cookies: asCount(summary.verificationCookiesRemaining),
    tabs: asCount(summary.verificationTabsRemaining),
    history: asCount(summary.verificationHistoryRemaining),
    downloads: asCount(summary.verificationDownloadsRemaining)
  };
  const hasCategoryEvidence = REQUIRED_VERIFICATION_CATEGORIES.some((name) =>
    Object.prototype.hasOwnProperty.call(categories, name)
  );
  const incompleteChecks = hasCategoryEvidence
    ? REQUIRED_VERIFICATION_CATEGORIES.flatMap((name) => {
        const evidence = categories[name];
        const state = String(evidence?.state || VERIFICATION_STATES.unknown).toLowerCase();
        const count = asCount(evidence?.count);
        if (!COMPLETED_VERIFICATION_STATES.has(state)) return [{ name, state }];
        if (state === VERIFICATION_STATES.verifiedZero && count !== 0) {
          return [{ name, state: 'invalid_verified_zero_count' }];
        }
        if (state === VERIFICATION_STATES.residueFound && (count == null || count === 0)) {
          return [{ name, state: 'invalid_residue_count' }];
        }
        if (surfaceCounts[name] !== count) return [{ name, state: 'summary_mismatch' }];
        return [];
      })
    : [];
  const reportedTotal = asCount(summary.verificationRemainingTotal);
  const categoryResidueReported = Object.values(categories).some(
    (evidence) => evidence?.state === VERIFICATION_STATES.residueFound
  );
  const categoryResidue = Object.values(categories).reduce(
    (total, evidence) =>
      evidence?.state === VERIFICATION_STATES.residueFound ? total + (asCount(evidence.count) ?? 0) : total,
    0
  );
  const surfacedResidue = Object.values(surfaceCounts).reduce((total, value) => total + (value ?? 0), 0);
  const knownResidueCount = Math.max(categoryResidue, surfacedResidue, reportedTotal ?? 0);
  const hasKnownResidue =
    status === VERIFICATION_STATES.residueFound || categoryResidueReported || knownResidueCount > 0;
  const completionFlag = summary.verificationAllRequiredChecksSucceeded;
  const terminalStatus = [VERIFICATION_STATES.verifiedZero, VERIFICATION_STATES.residueFound].includes(status);
  const legacyComplete = completionFlag == null && terminalStatus && reportedTotal != null;
  const terminalEvidenceConsistent =
    (status === VERIFICATION_STATES.verifiedZero && reportedTotal === 0 && knownResidueCount === 0) ||
    (status === VERIFICATION_STATES.residueFound &&
      reportedTotal != null &&
      reportedTotal > 0 &&
      knownResidueCount > 0 &&
      reportedTotal === Math.max(categoryResidue, surfacedResidue));
  const allRequiredChecksSucceeded =
    (completionFlag === true || legacyComplete) &&
    terminalStatus &&
    terminalEvidenceConsistent &&
    incompleteChecks.length === 0;
  const verifiedZero =
    status === VERIFICATION_STATES.verifiedZero &&
    allRequiredChecksSucceeded &&
    reportedTotal === 0 &&
    knownResidueCount === 0;

  let kind = 'incomplete';
  if (verifiedZero) kind = 'verified_zero';
  else if (hasKnownResidue && allRequiredChecksSucceeded) kind = 'residue_complete';
  else if (hasKnownResidue) kind = 'residue_incomplete';
  else if (status === VERIFICATION_STATES.notAttempted) kind = 'not_attempted';

  return {
    kind,
    status,
    allRequiredChecksSucceeded,
    incompleteChecks,
    knownResidueCount,
    reportedTotal
  };
}

export function formatVerificationStatus(summary = {}) {
  const assessment = assessReportVerification(summary);
  if (assessment.kind === 'verified_zero') return 'Verified zero — all four checks completed';
  if (assessment.kind === 'residue_complete') return 'Residue found — all four checks completed';
  if (assessment.kind === 'residue_incomplete') {
    return `Residue found — ${formatIncompleteChecks(assessment)}`;
  }
  if (assessment.kind === 'not_attempted') return 'Not attempted';
  return `Incomplete — ${formatIncompleteChecks(assessment)}`;
}

export function formatKnownResidue(summary = {}) {
  const assessment = assessReportVerification(summary);
  if (assessment.kind === 'verified_zero') return '0 — all four checks complete';
  if (assessment.kind === 'residue_complete') {
    return `${assessment.reportedTotal} — all four checks complete`;
  }
  if (assessment.kind === 'residue_incomplete') {
    return assessment.knownResidueCount > 0
      ? `At least ${assessment.knownResidueCount} — full total unknown`
      : 'Found — count and full total unknown';
  }
  if (assessment.kind === 'not_attempted') return 'Unknown — verification not attempted';
  return 'No known residue in completed checks — full total unknown';
}

export function formatReportOutcome(report = {}) {
  const summary = report.summary || {};
  const verification = assessReportVerification(summary);
  const status = String(report.status || 'unknown').toLowerCase();
  const errorCount = getReportRuntimeErrorCount(report);
  const unavailableCount = getReportUnavailableCount(report);

  if (errorCount > 0) {
    return {
      tone: 'danger',
      badge: 'Runtime errors',
      title: 'Cleanup finished with runtime errors',
      copy: `${errorCount} runtime ${errorCount === 1 ? 'error was' : 'errors were'} recorded. Post-clean verification: ${formatVerificationStatus(summary)}. Review both evidence areas before relying on this result.`
    };
  }
  if (status.includes('fail') || status.includes('error')) {
    return {
      tone: 'danger',
      badge: 'Runtime failed',
      title: 'Cleanup did not fully run',
      copy: `The runtime status is ${formatRuntimeStatus(status)}. Post-clean verification: ${formatVerificationStatus(summary)}.`
    };
  }
  if (status.includes('cancel')) {
    return {
      tone: 'warning',
      badge: 'Canceled',
      title: 'Cleanup stopped early',
      copy: 'Earlier phases may already have changed browser data. Verification cannot establish a complete cleanup result.'
    };
  }
  if (verification.kind === 'residue_complete') {
    return {
      tone: 'danger',
      badge: 'Residue found',
      title: 'Cleanup ran; exposed residue remains',
      copy: `All four exposed checks completed and found ${verification.reportedTotal} remaining ${verification.reportedTotal === 1 ? 'item' : 'items'}. Review the verification details before retrying or relying on the result.`
    };
  }
  if (verification.kind === 'residue_incomplete') {
    const countText =
      verification.knownResidueCount > 0
        ? `at least ${verification.knownResidueCount} remaining ${verification.knownResidueCount === 1 ? 'item' : 'items'}`
        : 'remaining residue';
    return {
      tone: 'danger',
      badge: 'Residue + unknowns',
      title: 'Residue found; verification incomplete',
      copy: `Completed checks found ${countText}, but ${formatIncompleteChecks(verification)}. The full four-surface residue total is unknown.`
    };
  }
  if (verification.kind === 'not_attempted') {
    return {
      tone: 'warning',
      badge: 'Not verified',
      title: 'Cleanup ran without post-clean verification',
      copy: 'The four exposed surfaces were not rechecked, so the remaining residue is unknown.'
    };
  }
  if (verification.kind === 'incomplete') {
    return {
      tone: 'warning',
      badge: 'Verification incomplete',
      title: 'Cleanup ran; result is not fully verified',
      copy: `${formatVerificationStatus(summary)}. No known residue was recorded by completed checks, but the full four-surface total remains unknown.`
    };
  }
  if (status === 'completed_with_warnings' || status.includes('warning')) {
    return {
      tone: 'warning',
      badge: 'Runtime warning',
      title: 'Cleanup completed with a warning status',
      copy: `All four exposed checks returned zero, but the runtime recorded a warning status. ${unavailableLimitsCopy(unavailableCount)}`
    };
  }
  if (status === 'completed' && verification.kind === 'verified_zero') {
    return {
      tone: 'success',
      badge: 'Verified zero',
      title: 'Cleanup ran; four checks verified zero',
      copy: `Cookies, matching tabs, history URLs, and download records all returned zero through exposed browser APIs. ${unavailableLimitsCopy(unavailableCount)}`
    };
  }
  return {
    tone: 'neutral',
    badge: formatRuntimeStatus(status),
    title: 'Cleanup report available',
    copy: `Runtime status: ${formatRuntimeStatus(status)}. Post-clean verification: ${formatVerificationStatus(summary)}.`
  };
}

export function getReportRuntimeErrorCount(report = {}) {
  const detailedCount = Array.isArray(report.errors) ? report.errors.length : 0;
  return Math.max(detailedCount, asCount(report.summary?.errors) ?? 0);
}

export function getReportUnavailableCount(report = {}) {
  const detailedCount = Array.isArray(report.unavailable) ? report.unavailable.length : 0;
  return Math.max(detailedCount, asCount(report.summary?.unavailable) ?? 0);
}

export function summarizeHistoryVerification(reports = []) {
  const assessments = reports.map((report) => assessReportVerification(report?.summary || {}));
  const complete = assessments.filter((item) => item.allRequiredChecksSucceeded);
  const verifiedZero = assessments.filter((item) => item.kind === 'verified_zero').length;
  const completeResidue = assessments.filter((item) => item.kind === 'residue_complete').length;
  const incomplete = assessments.length - complete.length;
  const incompleteWithResidue = assessments.filter((item) => item.kind === 'residue_incomplete').length;
  const knownResidue = assessments.reduce((total, item) => total + item.knownResidueCount, 0);
  const reportLabel = assessments.length === 1 ? 'report' : 'reports';
  const completeSentence = `${complete.length} of ${assessments.length} ${reportLabel} completed all four exposed checks (${verifiedZero} verified zero; ${completeResidue} found residue).`;
  const residueSentence = knownResidue
    ? `${incomplete ? 'At least ' : ''}${knownResidue} known ${knownResidue === 1 ? 'residue item was' : 'residue items were'} recorded by completed checks.`
    : incompleteWithResidue
      ? `Residue was reported without a valid count in ${incompleteWithResidue} incomplete ${incompleteWithResidue === 1 ? 'report' : 'reports'}.`
      : incomplete
        ? 'No known residue was recorded by completed checks.'
        : 'The completed checks recorded no exposed residue.';
  const incompleteSentence = incomplete
    ? `${incomplete} ${incomplete === 1 ? 'report has' : 'reports have'} incomplete or unknown verification; ${incomplete === 1 ? 'its' : 'their'} full residue ${incomplete === 1 ? 'total remains' : 'totals remain'} unknown${incompleteWithResidue ? `, including ${incompleteWithResidue} with residue evidence` : ''}.`
    : 'No report has an unknown four-surface total.';
  return {
    complete: complete.length,
    verifiedZero,
    completeResidue,
    incomplete,
    incompleteWithResidue,
    knownResidue,
    text: `${completeSentence} ${residueSentence} ${incompleteSentence}`
  };
}

function asCount(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
}

function formatCategoryName(value) {
  return String(value || 'required').replaceAll('_', ' ');
}

function formatIncompleteChecks(assessment) {
  if (assessment.incompleteChecks.length === 1) {
    const [{ name, state }] = assessment.incompleteChecks;
    return `${formatCategoryName(name)} check ${formatEvidenceState(state)}`;
  }
  if (assessment.incompleteChecks.length > 1) {
    return `${assessment.incompleteChecks.length} required checks are unresolved`;
  }
  return 'required checks are incomplete or unknown';
}

function formatEvidenceState(value) {
  const state = String(value || VERIFICATION_STATES.unknown).replaceAll('_', ' ');
  if (state === 'invalid residue count') return 'reported residue without a valid positive count';
  if (state === 'invalid verified zero count') return 'claimed zero without a valid zero count';
  if (state === 'summary mismatch') return 'does not agree with the report summary';
  if (state === 'timed out') return 'timed out';
  if (state === 'not supported') return 'is unsupported';
  if (state === 'not attempted') return 'was not attempted';
  if (state === 'failed') return 'failed';
  return 'is unknown';
}

function formatRuntimeStatus(value) {
  const normalized = String(value || 'unknown')
    .replaceAll('_', ' ')
    .trim();
  return normalized ? `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}` : 'Unknown';
}

function unavailableLimitsCopy(count) {
  return `${count} unavailable browser ${count === 1 ? 'limit is' : 'limits are'} documented separately; those surfaces are outside this verification claim.`;
}

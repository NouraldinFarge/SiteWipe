export const VERIFICATION_STATES = Object.freeze({
  verifiedZero: 'verified_zero',
  residueFound: 'residue_found',
  notSupported: 'not_supported',
  notAttempted: 'not_attempted',
  timedOut: 'timed_out',
  failed: 'failed',
  unknown: 'unknown'
});

export function verificationFromCount(count) {
  const numeric = Number(count);
  if (!Number.isInteger(numeric) || numeric < 0)
    return verificationUnknown('Verification returned a non-count result.');
  return {
    state: numeric === 0 ? VERIFICATION_STATES.verifiedZero : VERIFICATION_STATES.residueFound,
    count: numeric,
    reason:
      numeric === 0
        ? 'Check completed and returned zero exposed items.'
        : `Check completed and found ${numeric} exposed item(s).`
  };
}

export function verificationFailure(error) {
  const message = readable(error);
  return {
    state: /timed out/i.test(message) ? VERIFICATION_STATES.timedOut : VERIFICATION_STATES.failed,
    count: null,
    reason: message
  };
}

export function verificationNotSupported(reason) {
  return {
    state: VERIFICATION_STATES.notSupported,
    count: null,
    reason: String(reason || 'The browser API is unavailable.')
  };
}

export function verificationNotAttempted(reason) {
  return {
    state: VERIFICATION_STATES.notAttempted,
    count: null,
    reason: String(reason || 'The check was not attempted.')
  };
}

export function verificationUnknown(reason) {
  return {
    state: VERIFICATION_STATES.unknown,
    count: null,
    reason: String(reason || 'The result is unknown.')
  };
}

export function summarizeVerification(categories, requiredNames = Object.keys(categories || {})) {
  const required = requiredNames.map((name) => [
    name,
    categories?.[name] || verificationUnknown('Missing verification evidence.')
  ]);
  const states = required.map(([, evidence]) => evidence.state);
  const residue = required.reduce(
    (total, [, evidence]) =>
      evidence.state === VERIFICATION_STATES.residueFound ? total + Number(evidence.count || 0) : total,
    0
  );
  const incomplete = required
    .filter(
      ([, evidence]) => ![VERIFICATION_STATES.verifiedZero, VERIFICATION_STATES.residueFound].includes(evidence.state)
    )
    .map(([name, evidence]) => ({
      name,
      state: evidence.state,
      reason: evidence.reason
    }));
  const allRequiredChecksSucceeded = required.length > 0 && incomplete.length === 0;

  let status = 'incomplete';
  if (required.length && states.every((state) => state === VERIFICATION_STATES.verifiedZero)) status = 'verified_zero';
  else if (states.some((state) => state === VERIFICATION_STATES.residueFound)) status = 'residue_found';
  else if (states.every((state) => state === VERIFICATION_STATES.notAttempted)) status = 'not_attempted';

  return {
    status,
    allRequiredChecksSucceeded,
    noExposedResidueFound: status === 'verified_zero',
    residueCount: residue,
    incomplete
  };
}

function readable(error) {
  if (!error) return 'Unknown verification failure.';
  if (typeof error === 'string') return error;
  if (error.message) return error.message;
  return String(error);
}

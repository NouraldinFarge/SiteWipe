import { MESSAGE_TYPES } from '../shared/constants.js';
import { buildHostPermissionInventory, canonicalizeHostPermissionOrigins } from '../shared/host-permissions.js';
import { formatError, onceDomReady, sendMessage } from '../shared/messaging.js';

let handoff = null;
let busy = false;

onceDomReady(init);

async function init() {
  document.querySelector('#grantAccess').addEventListener('click', runReviewedPermissionHandoff);
  try {
    const claimed = await sendMessage(MESSAGE_TYPES.claimCleanupPermissionHandoff);
    if (
      claimed?.handoffClaimed !== true ||
      !/^[a-zA-Z0-9._:-]{8,128}$/.test(String(claimed.handoffNonce || '')) ||
      !/^[a-f0-9]{64}$/.test(String(claimed.handoffCapability || ''))
    ) {
      throw new Error('SiteWipe did not bind this exact handoff document.');
    }
    const origins = canonicalizeHostPermissionOrigins(claimed.temporaryHostPermissionOrigins);
    if (!origins.length || origins.length !== claimed.temporaryHostPermissionOrigins?.length) {
      throw new Error('The reviewed target-access patterns are unavailable.');
    }
    handoff = Object.freeze({
      nonce: claimed.handoffNonce,
      capability: claimed.handoffCapability,
      origins
    });
    document.querySelector('#targetName').textContent = claimed.targetDisplayName || 'Reviewed target';
    renderOrigins(origins);
    renderReviewedEffects(claimed.reviewedEffects);
    setStatus(`Ready. This reviewed approval expires at ${formatExpiry(claimed.expiresAt)}.`);
    document.querySelector('#grantAccess').disabled = false;
  } catch (error) {
    failClosed(error);
  }
}

async function runReviewedPermissionHandoff() {
  if (!handoff || busy) return;
  if (globalThis.navigator?.userActivation && globalThis.navigator.userActivation.isActive !== true) {
    return showError('Chrome/Brave requires a fresh activation. Select the button again; no cleanup has started.');
  }
  busy = true;
  setButtonBusy(true);
  showError('');
  setStatus('Requesting only the reviewed target patterns…');

  const authority = {
    handoffNonce: handoff.nonce,
    handoffCapability: handoff.capability
  };
  const intentPromise = sendMessage(MESSAGE_TYPES.beginCleanupPermissionHandoff, authority).then(
    (value) => ({ ok: value?.promptIntentRecorded === true, value }),
    (error) => ({ ok: false, error })
  );
  let snapshotPromise;
  let permissionRequest;
  try {
    // These two browser APIs must be started synchronously in the fresh click.
    // The inventory proves the exact temporary patterns were absent before the
    // native request; the worker separately requires the exact host-only event.
    snapshotPromise = chrome.permissions.getAll();
    permissionRequest = chrome.permissions.request({ origins: handoff.origins });
  } catch (error) {
    const intent = await intentPromise;
    if (intent.ok) await settleHandoff('not_invoked');
    return failClosed(error);
  }

  const invocationPromise = sendMessage(MESSAGE_TYPES.confirmCleanupPermissionHandoffInvocation, authority).then(
    (value) => ({ ok: value?.promptInvocationRecorded === true, value }),
    (error) => ({ ok: false, error })
  );
  const [intent, invocation, snapshot, request] = await Promise.all([
    intentPromise,
    invocationPromise,
    Promise.resolve(snapshotPromise).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error })
    ),
    Promise.resolve(permissionRequest).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error })
    )
  ]);

  const preRequestTemporaryOriginsAbsent = snapshot.ok && temporaryHostAccessWasAbsent(snapshot.value, handoff.origins);
  if (!intent.ok || !invocation.ok || !snapshot.ok || !preRequestTemporaryOriginsAbsent || !request.ok) {
    await settleHandoff(request.ok && request.value === false ? 'denied' : 'abandoned');
    return failClosed(
      intent.error ||
        invocation.error ||
        snapshot.error ||
        request.error ||
        new Error('Browser target access was already present or could not be proved absent before this request.')
    );
  }
  if (request.value !== true) {
    await settleHandoff(request.value === false ? 'denied' : 'abandoned');
    return failClosed(
      new Error(
        request.value === false
          ? 'Site access was not granted. No cleanup has started.'
          : 'The browser returned an invalid target-access result. No cleanup has started.'
      )
    );
  }

  setStatus('Access granted. Verifying the exact browser event and consuming the one-use approval…');
  try {
    const result = await sendMessage(MESSAGE_TYPES.confirmCleanupPermissionHandoffGrant, {
      ...authority,
      preRequestTemporaryOriginsAbsent: true
    });
    renderOutcome(result);
  } catch (error) {
    try {
      const resumed = await sendMessage(MESSAGE_TYPES.resumeCleanupPermissionHandoff, authority);
      renderOutcome(resumed);
    } catch {
      failClosed(error, { cleanupMayHaveStarted: true });
    }
  }
}

async function settleHandoff(outcome) {
  try {
    return await sendMessage(MESSAGE_TYPES.settleCleanupPermissionHandoff, {
      handoffNonce: handoff.nonce,
      handoffCapability: handoff.capability,
      outcome
    });
  } catch {
    return null;
  }
}

function temporaryHostAccessWasAbsent(snapshot, requiredOrigins) {
  if (
    !snapshot ||
    typeof snapshot !== 'object' ||
    Array.isArray(snapshot) ||
    !Array.isArray(snapshot.origins) ||
    snapshot.origins.some((origin) => typeof origin !== 'string')
  ) {
    return false;
  }
  const canonicalOrigins = canonicalizeHostPermissionOrigins(snapshot.origins);
  if (
    canonicalOrigins.length !== snapshot.origins.length ||
    snapshot.origins.some((origin) => !canonicalOrigins.includes(origin))
  ) {
    return false;
  }
  const inventory = buildHostPermissionInventory({
    requiredOrigins,
    coveredRequiredOrigins: [],
    grantedOrigins: canonicalOrigins
  });
  return (
    inventory.exactGrantedHostPermissionOrigins.length === 0 && inventory.broadGrantedHostPermissionOrigins.length === 0
  );
}

function renderOutcome(result) {
  if (result?.report || result?.resumedCompletedResult === true) {
    setStatus('Cleanup finished. Reopen SiteWipe to inspect the final report and any retained target-access recovery.');
  } else if (result?.cleanupStarted === true || result?.approvalHandoffRunning === true) {
    setStatus(
      'Cleanup started from the exact reviewed handoff. This tab does not live-update after handoff; reopen SiteWipe to inspect the current job or report, and do not repeat the cleanup.'
    );
  } else if (result?.approvalHandoffCanceled === true) {
    setStatus(
      result.temporaryAccessReleased === true
        ? 'No cleanup started. SiteWipe proved the temporary target access absent.'
        : result.externalAccessPreserved === true
          ? 'No cleanup started. SiteWipe preserved access that it could not prove this review created.'
          : 'No cleanup started. Reopen SiteWipe to inspect target-access recovery before trying again.'
    );
  } else {
    setStatus('SiteWipe is still reconciling this exact reviewed handoff. Do not repeat the cleanup yet.');
  }
  busy = false;
  setButtonBusy(false);
  document.querySelector('#grantAccess').disabled = true;
}

function renderReviewedEffects(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The reviewed cleanup effects are unavailable.');
  }
  const associatedTargetCount = Number(value.associatedTargetCount);
  if (!Number.isInteger(associatedTargetCount) || associatedTargetCount < 0) {
    throw new Error('The reviewed associated-target count is invalid.');
  }
  document.querySelector('#reviewedMode').textContent =
    `${String(value.cleanupMode || 'Unknown')} · ${String(value.approvalPath || 'Approval path unavailable')}`;
  document.querySelector('#reviewedWindowScope').textContent = String(
    value.windowScope || 'Browser-window scope unavailable.'
  );
  document.querySelector('#reviewedAssociatedTargets').textContent = associatedTargetCount
    ? `${associatedTargetCount} additional reviewed target${associatedTargetCount === 1 ? '' : 's'} included.`
    : 'None.';
  document.querySelector('#reviewedDownloadedFiles').textContent = String(
    value.downloadedFileSummary || 'Downloaded-file scope unavailable.'
  );
  document.querySelector('#reviewedStorageScope').textContent = String(
    value.storageSummary || 'Storage scope unavailable.'
  );
  document.querySelector('#reviewedCategories').textContent = String(
    value.categorySummary || 'Cleanup categories unavailable.'
  );
  document.querySelector('#reviewedBrowserRecords').textContent = String(
    value.browserRecordSummary || 'Browser-record scope unavailable.'
  );
  document.querySelector('#reviewedRequestShield').textContent = String(
    value.requestShieldSummary || 'Request-shield effect unavailable.'
  );
  document.querySelector('#reviewedProgressOverlay').textContent = String(
    value.progressOverlaySummary || 'Page-overlay effect unavailable.'
  );
  document.querySelector('#reviewedProtectedOrigins').textContent = String(
    value.protectedOriginSummary || 'Protected-origin scope unavailable.'
  );
  document.querySelector('#reviewedEvidence').textContent = String(
    value.evidenceSummary || 'Verification and report behavior unavailable.'
  );
  document.querySelector('#reviewedMatchingTabs').textContent =
    value.matchingTabsClose === true ? 'Matching tabs close as reviewed.' : 'Matching-tab closure is off.';
}

function renderOrigins(origins) {
  const list = document.querySelector('#originList');
  list.replaceChildren();
  for (const origin of origins) {
    const item = document.createElement('li');
    item.textContent = origin;
    list.append(item);
  }
}

function formatExpiry(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'the displayed review deadline' : date.toLocaleTimeString();
}

function failClosed(error, { cleanupMayHaveStarted = false } = {}) {
  const hadBoundHandoff = Boolean(handoff);
  handoff = null;
  busy = false;
  setButtonBusy(false);
  document.querySelector('#grantAccess').disabled = true;
  if (!hadBoundHandoff) renderUnavailableReview();
  setStatus(
    cleanupMayHaveStarted
      ? 'SiteWipe could not confirm the cleanup outcome. Do not repeat the cleanup; reopen this tab or SiteWipe to inspect the active job.'
      : 'No cleanup started. Close this tab and reopen SiteWipe to prepare a fresh review.'
  );
  showError(
    cleanupMayHaveStarted
      ? `${formatError(error)} The worker may still be completing or reconciling this exact cleanup.`
      : formatError(error)
  );
}

function renderUnavailableReview() {
  document.querySelector('#targetName').textContent = 'Unavailable';
  document.querySelector('#originSummary').textContent =
    'No target patterns are available because this handoff could not be verified.';
  renderOrigins([]);
  const unavailable = 'Unavailable because this handoff could not be verified.';
  for (const selector of [
    '#reviewedMode',
    '#reviewedWindowScope',
    '#reviewedAssociatedTargets',
    '#reviewedDownloadedFiles',
    '#reviewedStorageScope',
    '#reviewedCategories',
    '#reviewedBrowserRecords',
    '#reviewedRequestShield',
    '#reviewedProgressOverlay',
    '#reviewedProtectedOrigins',
    '#reviewedEvidence',
    '#reviewedMatchingTabs'
  ]) {
    document.querySelector(selector).textContent = unavailable;
  }
}

function setButtonBusy(value) {
  const button = document.querySelector('#grantAccess');
  button.setAttribute('aria-busy', String(Boolean(value)));
  button.textContent = value ? 'Waiting for Chrome/Brave…' : 'Grant reviewed access and run';
}

function setStatus(message) {
  document.querySelector('#status').textContent = message;
}

function showError(message) {
  const element = document.querySelector('#error');
  element.textContent = message || '';
  element.hidden = !message;
}

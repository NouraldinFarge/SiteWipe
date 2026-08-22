import { MESSAGE_TYPES, STORAGE_KEYS } from '../shared/constants.js';
import { sendMessage, formatError, onceDomReady, onStorageChange } from '../shared/messaging.js';
import { resolveReviewedSourceContext } from '../shared/target-scope.js';

let normalized = null;
let busy = false;
let activeTabTarget = null;
let cleanupReview = null;
let reviewSourceContext = { sourceWindowId: null, sourceIncognito: false };
let reviewInvalidatedBySettings = false;
let effectiveSettings = {};
let directCleanupReview = null;
let directSourceContext = { sourceWindowId: null, sourceIncognito: false };
let directPreparedInput = '';
let directPreparationGeneration = 0;
let directPreparationPending = false;
let directPreparationOperation = null;
let directInvalidatedBySettings = false;
let permissionPromptInFlight = false;
let initiatedPermissionPrompt = null;
let latestReportVisible = false;
let displayedReportBinding = null;
let displayedReportBindingGeneration = 0;
let reviewApprovalRuntimeError = '';
let cleanupReviewExpiryTimerId = null;
let directCleanupReviewExpiryTimerId = null;
const popupPreparationBindings = new Map();
const popupAuthorityContinuations = new Set();

const DIRECT_PREPARATION_RETRY_DELAY_MS = 750;
const DIRECT_PREPARATION_MAX_ATTEMPTS = 2;

const SETTINGS_CHANGED_REVIEW_MESSAGE =
  'Settings changed. No cleanup started. Review the current scope again before approving.';

onceDomReady(init);
globalThis.addEventListener?.('pagehide', clearPopupLifetimeTimers, { once: true });

function clearPopupLifetimeTimers() {
  clearPreparedReviewExpiry(false);
  clearPreparedReviewExpiry(true);
  popupPreparationBindings.clear();
  popupAuthorityContinuations.clear();
}

async function init() {
  bindEvents();
  const shouldFocusInput = await hydrateState();
  onStorageChange((changes, area) => {
    if (area !== 'local') return;
    if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.settings)) {
      void handleStoredSettingsChange(changes[STORAGE_KEYS.settings].newValue || {});
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'sitewipe.activeJob.v1'))
      renderActiveJob(changes['sitewipe.activeJob.v1'].newValue || null);
    if (changes[STORAGE_KEYS.activeReport]?.newValue) {
      renderSummary(changes[STORAGE_KEYS.activeReport].newValue, { focus: true, persisted: true });
    }
  });
  if (shouldFocusInput) focusInput();
}

function bindEvents() {
  qs('#targetForm').addEventListener('submit', onSubmit);
  qs('#targetInput').addEventListener('input', () => {
    if (cleanupReview) void discardCleanupReview({ announce: false, focus: false });
    if (directCleanupReview || directPreparationPending) {
      void discardDirectCleanupPreparation({ settleLease: !permissionPromptInFlight });
    }
    if (normalized?.input !== qs('#targetInput').value.trim()) {
      normalized = null;
      setNormalized(null);
    }
  });
  qs('#targetInput').addEventListener('input', debounce(onInput, 250));
  qs('#openOptions').addEventListener('click', openOptionsFromPopup);
  qs('#useActiveTab').addEventListener('click', () => useActiveTabTarget(true));
  qs('#openSidePanel').addEventListener('click', openSidePanel);
  qs('#startAnotherCleanup').addEventListener('click', startAnotherCleanup);
  qs('#forgetLatestReport').addEventListener('click', forgetLatestReport);
  qs('#cancelActiveJob').addEventListener('click', cancelActiveJob);
  qs('#cancelCleanupReview').addEventListener('click', () => discardCleanupReview({ announce: true, focus: true }));
  qs('#approveCleanup').addEventListener('click', runApprovedCleanup);
  for (const selector of [
    '#reviewScopeAcknowledge',
    '#reviewAssociatedAcknowledge',
    '#reviewLocalAcknowledge',
    '#reviewProtectedAcknowledge',
    '#reviewFileConfirmation'
  ]) {
    qs(selector).addEventListener('input', handleApprovalInput);
    qs(selector).addEventListener('change', handleApprovalInput);
  }
}

async function hydrateState() {
  try {
    const state = await sendMessage(MESSAGE_TYPES.getPopupState);
    applySettings(state.settings);
    renderIncognito(state.incognitoAccess);
    const cleanupRunning = state.activeJob?.status === 'running';
    await hydrateActiveTabTarget({ autoSelect: !state.report && !cleanupRunning });
    if (state.activeJob?.status === 'running') renderActiveJob(state.activeJob);
    if (state.report) renderSummary(state.report, { focus: !cleanupRunning, persisted: true });
    return !state.report && !cleanupRunning;
  } catch (error) {
    showError(formatError(error));
    return true;
  }
}

function renderActiveJob(job) {
  if (!job) {
    busy = false;
    setBusy(false);
    if (directCleanupEnabled() && !latestReportVisible) void prepareDirectCleanup(qs('#targetInput').value.trim());
    return;
  }
  if (job.status === 'running') {
    if (cleanupReview && !popupAuthorityContinuations.has(cleanupReview.approvalToken)) {
      popupPreparationBindings.delete(cleanupReview.approvalToken);
      clearPreparedReviewExpiry(false);
      cleanupReview = null;
    }
    if (directCleanupReview && !popupAuthorityContinuations.has(directCleanupReview.approvalToken)) {
      popupPreparationBindings.delete(directCleanupReview.approvalToken);
      clearPreparedReviewExpiry(true);
      directCleanupReview = null;
      directPreparedInput = '';
    }
    directPreparationPending = false;
    directPreparationGeneration += 1;
    qs('#reviewCard').hidden = true;
    busy = true;
    setBusy(true, 'Cleaning…');
    showProgress(
      job.percent || 0,
      job.label || 'Cleanup running…',
      job.detail || 'SiteWipe is still running this cleanup job.',
      { cancelable: true }
    );
    qs('#cancelActiveJob').disabled = Boolean(job.cancelRequested);
    qs('#cancelActiveJob').textContent = job.cancelRequested ? 'Cancel requested' : 'Request cancel';
    return;
  }
  if (['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) {
    const localAuthorityContinuationInFlight = Boolean(
      (cleanupReview && popupAuthorityContinuations.has(cleanupReview.approvalToken)) ||
      (directCleanupReview && popupAuthorityContinuations.has(directCleanupReview.approvalToken))
    );
    if (cleanupReview && !popupAuthorityContinuations.has(cleanupReview.approvalToken)) {
      popupPreparationBindings.delete(cleanupReview.approvalToken);
    }
    if (directCleanupReview && !popupAuthorityContinuations.has(directCleanupReview.approvalToken)) {
      popupPreparationBindings.delete(directCleanupReview.approvalToken);
    }
    if (!localAuthorityContinuationInFlight) {
      busy = false;
      setBusy(false);
      if (directCleanupEnabled() && !latestReportVisible) void prepareDirectCleanup(qs('#targetInput').value.trim());
    }
  }
}

async function hydrateActiveTabTarget({ autoSelect = true } = {}) {
  const card = qs('#activeTabCard');
  const title = qs('#activeTabTitle');
  const domain = qs('#activeTabDomain');
  const button = qs('#useActiveTab');

  try {
    const response = await sendMessage(MESSAGE_TYPES.getActiveTabTarget);
    activeTabTarget = response.activeTab;
    card.hidden = false;
    if (activeTabTarget?.supported && activeTabTarget.normalized?.ok) {
      card.classList.remove('is-unsupported');
      title.textContent = trimText(activeTabTarget.tab?.title || 'Current page', 56);
      domain.textContent = activeTabTarget.normalized.target.domain;
      button.disabled = false;
      button.textContent = 'Use active tab';
      if (autoSelect && !qs('#targetInput').value.trim()) useActiveTabTarget(false);
      return;
    }
    card.classList.add('is-unsupported');
    title.textContent = 'Active tab unavailable';
    domain.textContent = activeTabTarget?.reason || 'Open an http or https website tab.';
    button.disabled = true;
    button.textContent = 'Unsupported';
  } catch (error) {
    card.hidden = false;
    card.classList.add('is-unsupported');
    title.textContent = 'Active tab unavailable';
    domain.textContent = formatError(error);
    button.disabled = true;
    button.textContent = 'Unavailable';
  }
}

function useActiveTabTarget(announce) {
  if (!activeTabTarget?.supported || !activeTabTarget.normalized?.ok) return;
  if (cleanupReview) void discardCleanupReview({ announce: false, focus: false });
  if (directCleanupReview || directPreparationPending) {
    void discardDirectCleanupPreparation({ settleLease: !permissionPromptInFlight });
  }
  const input = activeTabTarget.normalized.target.domain;
  qs('#targetInput').value = input;
  normalized = activeTabTarget.normalized;
  setNormalized(normalized.target.domain);
  showError('');
  void prepareDirectCleanup(input);
  if (!announce) return;
  const button = qs('#useActiveTab');
  button.textContent = 'Selected';
  setTimeout(() => {
    if (activeTabTarget?.supported) button.textContent = 'Use active tab';
  }, 900);
}

function applySettings(settings) {
  effectiveSettings = { ...(settings || {}) };
  document.body.classList.toggle('reduced-motion', Boolean(settings?.reducedMotion));
  document.body.classList.toggle('high-contrast', Boolean(settings?.highContrast));
  document.body.classList.toggle('direct-cleanup-enabled', directCleanupEnabled());
  qs('#directCleanupNotice').hidden = !directCleanupEnabled();
  const mode = settings?.cleanupMode === 'expert' ? 'Expert' : 'Standard';
  qs('#cleanupModeBadge').textContent = `${mode} · ${directCleanupEnabled() ? 'One click' : 'Review'}`;
  qs('#directCleanupMode').textContent =
    `Clean now uses your current ${mode} settings and eligible normal/private scope. A browser site-access prompt may still appear.`;
  updatePrimaryAction();
}

async function handleStoredSettingsChange(settings) {
  const detailedReviewWasActive = Boolean(cleanupReview);
  const directReviewWasActive = Boolean(directCleanupReview || directPreparationPending);
  applySettings(settings);
  if (detailedReviewWasActive) {
    reviewInvalidatedBySettings = true;
    await discardCleanupReview({ announce: false, focus: false });
    announceSettingsChangedReview();
  }
  if (directReviewWasActive) {
    directInvalidatedBySettings = true;
    await discardDirectCleanupPreparation({ settleLease: !permissionPromptInFlight });
  }
  if (directCleanupEnabled() && !permissionPromptInFlight && !latestReportVisible) {
    void prepareDirectCleanup(qs('#targetInput').value.trim());
  }
}

function renderIncognito(allowed) {
  const badge = qs('#incognitoBadge');
  badge.textContent = allowed ? 'Private access: on' : 'Private access: off';
  badge.className = `badge ${allowed ? 'success' : ''}`.trim();
}

async function onInput() {
  const input = qs('#targetInput').value.trim();
  if (!input) {
    normalized = null;
    setNormalized(null);
    showError('');
    updatePrimaryAction();
    return;
  }
  try {
    const response = await sendMessage(MESSAGE_TYPES.normalizeTarget, {
      input
    });
    if (qs('#targetInput').value.trim() !== input) return;
    normalized = response.normalized;
    if (!normalized.ok) {
      setNormalized(null);
      showError(normalized.error);
      return;
    }
    const canonicalInput = normalized.target.domain;
    if (qs('#targetInput').value.trim() === input && canonicalInput) {
      qs('#targetInput').value = canonicalInput;
      normalized = { ...normalized, input: canonicalInput };
    }
    showError('');
    setNormalized(normalized.target.domain);
    await prepareDirectCleanup(canonicalInput);
  } catch (error) {
    if (qs('#targetInput').value.trim() === input) showError(formatError(error));
  }
}

async function prepareDirectCleanup(input) {
  if (directPreparationPending && directPreparationOperation) return directPreparationOperation;
  const operation = performDirectCleanupPreparation(input);
  directPreparationOperation = operation;
  void operation
    .finally(() => {
      if (directPreparationOperation === operation) directPreparationOperation = null;
    })
    .catch(() => {});
  return operation;
}

async function performDirectCleanupPreparation(input) {
  const currentInput = String(input || '').trim();
  if (
    !directCleanupEnabled() ||
    busy ||
    directPreparationPending ||
    !currentInput ||
    !normalized?.ok ||
    qs('#targetInput').value.trim() !== currentInput
  ) {
    updatePrimaryAction();
    return;
  }
  if (directCleanupReview && directPreparedInput === currentInput) {
    updatePrimaryAction();
    return;
  }

  const generation = ++directPreparationGeneration;
  directPreparationPending = true;
  directInvalidatedBySettings = false;
  updatePrimaryAction();
  setReadyStatus('Preparing direct cleanup', 'warning');
  let preparedReview = null;
  try {
    let sourceContext = await getSourceContext();
    if (!directPreparationIsCurrent(generation, currentInput)) return;
    for (let attempt = 1; attempt <= DIRECT_PREPARATION_MAX_ATTEMPTS; attempt += 1) {
      try {
        const response = await sendMessage(MESSAGE_TYPES.prepareCleanupReview, {
          input: currentInput,
          ...sourceContext
        });
        preparedReview = acceptPreparedReviewResponse(response);
        break;
      } catch (error) {
        const retryAllowed =
          attempt < DIRECT_PREPARATION_MAX_ATTEMPTS &&
          directPreparationReadinessIsRetryable(error) &&
          directPreparationIsCurrent(generation, currentInput);
        if (!retryAllowed) throw error;
        showError('');
        setReadyStatus('Waiting for SiteWipe startup', 'warning');
        await waitForDirectPreparationRetry();
        if (!directPreparationIsCurrent(generation, currentInput)) return;
        const retrySourceContext = await getSourceContext();
        if (!directPreparationIsCurrent(generation, currentInput)) return;
        if (!sourceContextsMatch(sourceContext, retrySourceContext)) {
          throw new Error('The popup window or its private-window state changed during startup. Reopen SiteWipe.', {
            cause: error
          });
        }
        sourceContext = retrySourceContext;
        setReadyStatus('Preparing direct cleanup', 'warning');
      }
    }
    if (!directPreparationIsCurrent(generation, currentInput)) {
      await cancelCleanupReviewToken(preparedReview?.approvalToken, { promptNotStarted: true });
      await settleCleanupPermissionPrompt(preparedReview, 'abandoned');
      if (preparedReview?.approvalToken) popupPreparationBindings.delete(preparedReview.approvalToken);
      return;
    }
    if (preparedReview?.approvalMode !== 'settings_direct') {
      throw new Error('Direct cleanup is no longer enabled in current settings.');
    }
    directCleanupReview = preparedReview;
    schedulePreparedReviewExpiry(preparedReview, true);
    directSourceContext = sourceContext;
    directPreparedInput = currentInput;
    normalized = {
      ok: true,
      input: currentInput,
      target: {
        domain: preparedReview.normalizedTarget,
        hostPermissionOrigins: []
      }
    };
    setNormalized(preparedReview.normalizedTarget);
    showError('');
    if (preparedReview.approvalHandoffStatus) {
      showProgress(
        20,
        'Cleanup approved',
        'Chrome target access is settling. SiteWipe will continue automatically; do not approve again.',
        { cancelable: false }
      );
    }
  } catch (error) {
    if (directPreparationIsCurrent(generation, currentInput)) {
      directCleanupReview = null;
      directPreparedInput = '';
      showError(formatError(error));
    }
    if (preparedReview?.approvalToken) {
      await cancelCleanupReviewToken(preparedReview.approvalToken, { promptNotStarted: true });
      await settleCleanupPermissionPrompt(preparedReview, 'abandoned');
      popupPreparationBindings.delete(preparedReview.approvalToken);
    }
  } finally {
    if (generation === directPreparationGeneration) {
      directPreparationPending = false;
      updatePrimaryAction();
      if (directCleanupReview) setReadyStatus('Direct cleanup ready', 'success');
    }
  }
}

async function openOptionsFromPopup() {
  if (permissionPromptInFlight) {
    showError('Finish the Chrome site-access prompt before opening SiteWipe settings.');
    return;
  }

  // A direct-mode preflight can still be returning when Settings is clicked.
  // Wait for that exact operation so its same-document, prompt-not-started
  // cancellation settles before Options can change the reviewed settings.
  const pendingDirectPreparation = directPreparationOperation;
  if (pendingDirectPreparation) await pendingDirectPreparation.catch(() => {});

  const continuingReview = directCleanupReview || cleanupReview;
  if (continuingReview?.approvalHandoffStatus) {
    showError('Cleanup approval is already continuing. Wait for it to finish before opening SiteWipe settings.');
    return;
  }

  if (directCleanupReview) {
    await discardDirectCleanupPreparation({ settleLease: true });
  }
  if (cleanupReview) {
    await discardCleanupReview({ announce: false, focus: false });
  }

  await chrome.runtime.openOptionsPage();
}

function directPreparationReadinessIsRetryable(error) {
  if (error?.code === 'lifecycle_not_ready' && error?.retryable === true) return true;
  return (
    error?.code === 'sitewipe_action_failed' &&
    /^SiteWipe is still trying to run (?:service-worker-load|startup) maintenance\./.test(formatError(error))
  );
}

function waitForDirectPreparationRetry() {
  return new Promise((resolve) => setTimeout(resolve, DIRECT_PREPARATION_RETRY_DELAY_MS));
}

function sourceContextsMatch(left, right) {
  return left?.sourceWindowId === right?.sourceWindowId && left?.sourceIncognito === right?.sourceIncognito;
}

function directPreparationIsCurrent(generation, input) {
  return (
    generation === directPreparationGeneration && directCleanupEnabled() && qs('#targetInput').value.trim() === input
  );
}

async function onSubmit(event) {
  event.preventDefault();
  if (busy) return;
  const input = qs('#targetInput').value.trim();
  if (!input) {
    showError('Enter a domain or URL.');
    return;
  }
  if (directCleanupEnabled()) {
    if (!directCleanupReview || directPreparedInput !== input || directPreparationPending) {
      showError('Direct cleanup is still preparing the current target. Wait for Clean now to become available.');
      return;
    }
    void runPreparedDirectCleanup();
    return;
  }
  if (cleanupReview) return;

  busy = true;
  setBusy(true, 'Reviewing…');
  showProgress(
    10,
    'Calculating cleanup scope…',
    'Only read-only browser queries are running. No site data is being changed.',
    { cancelable: false }
  );
  try {
    reviewSourceContext = await getSourceContext();
    const response = await sendMessage(MESSAGE_TYPES.prepareCleanupReview, {
      input,
      ...reviewSourceContext
    });
    cleanupReview = acceptPreparedReviewResponse(response);
    if (cleanupReview?.approvalMode !== 'detailed_review') {
      throw new Error('Cleanup settings changed while preparing the review. Start again.');
    }
    reviewInvalidatedBySettings = false;
    normalized = {
      ok: true,
      input: cleanupReview.normalizedTarget,
      target: {
        domain: cleanupReview.normalizedTarget,
        hostPermissionOrigins: []
      }
    };
    qs('#targetInput').value = cleanupReview.normalizedTarget;
    setNormalized(cleanupReview.normalizedTarget);
    showError('');
    renderCleanupReview(cleanupReview);
  } catch (error) {
    const failedReview = cleanupReview;
    cleanupReview = null;
    if (failedReview?.approvalToken) {
      await cancelCleanupReviewToken(failedReview.approvalToken, { promptNotStarted: true });
      await settleCleanupPermissionPrompt(failedReview, 'abandoned');
      popupPreparationBindings.delete(failedReview.approvalToken);
    }
    showError(formatError(error));
  } finally {
    busy = false;
    setBusy(false);
    setReviewMode(Boolean(cleanupReview));
    if (cleanupReview) focusReviewHeading();
  }
}

async function runApprovedCleanup() {
  if (!cleanupReview || cleanupReview.approvalHandoffStatus || busy || !approvalIsComplete()) return;
  if (cleanupReviewIsExpired(cleanupReview)) return expirePreparedCleanupReview(cleanupReview, false);
  return runPreparedCleanup(cleanupReview, reviewSourceContext, collectApproval(), false);
}

async function runPreparedDirectCleanup() {
  if (!directCleanupReview || busy || directPreparationPending) return;
  if (directCleanupReview.approvalHandoffStatus) return;
  if (cleanupReviewIsExpired(directCleanupReview)) {
    return expirePreparedCleanupReview(directCleanupReview, true);
  }
  return runPreparedCleanup(
    directCleanupReview,
    directSourceContext,
    {
      approvalMode: 'settings_direct',
      reviewedScope: false,
      associatedTargets: false,
      localOrIpTarget: false,
      protectedWebOrigins: false,
      fileConfirmationText: ''
    },
    true
  );
}

async function runPreparedCleanup(review, sourceContext, approval, direct) {
  let invalidatedBySettings = false;
  let permissionRequestGranted = false;
  let permissionRequestDenied = false;
  let permissionRequestInvoked = false;
  let permissionPromptSettlementSubmitted = false;
  let reviewExpiredDuringPermissionPrompt = false;
  let postPromptHandoffOutcome = null;
  let detailedReviewRetryError = '';
  let approvalHandoffPromise = null;
  // Keep the review deadline live while Chrome's native permission prompt is
  // open. A prompt may outlive the five-minute cleanup authority even though
  // its eventual grant still needs exact temporary-access reconciliation.
  if (review.hostPermissionsGranted) clearPreparedReviewExpiry(direct);
  if (!direct) setReviewApprovalError('');
  busy = true;
  setBusy(true, review.hostPermissionsGranted ? 'Cleaning…' : 'Requesting access…');
  showProgress(
    2,
    review.hostPermissionsGranted ? 'Consuming authorization…' : 'Requesting target site access…',
    review.hostPermissionsGranted
      ? 'The single-use authorization is being validated before any browser data changes.'
      : direct
        ? 'Chrome/Brave may require its own confirmation for the exact preflight-bound target patterns. No cleanup has started.'
        : 'Chrome/Brave will request only the target patterns shown in this review. No cleanup has started.',
    { cancelable: false }
  );
  try {
    if (!review.hostPermissionsGranted) {
      const popupBinding = requirePopupPreparationBinding(review);
      const origins = review.temporaryHostPermissionOrigins || [];
      if (!origins.length) throw new Error('The reviewed target did not produce a valid site-access request.');
      if (!review.permissionLeaseId) {
        throw new Error('The durable target-access recovery lease is unavailable. Start the cleanup again.');
      }
      if (!review.approvalHandoffNonce) {
        throw new Error('The worker-owned cleanup handoff is unavailable. Start the cleanup again.');
      }
      if (globalThis.navigator?.userActivation && globalThis.navigator.userActivation.isActive !== true) {
        throw new Error(
          'Chrome/Brave requires a fresh user activation for target site access. Activate Clean now again; no cleanup has started.'
        );
      }
      popupAuthorityContinuations.add(review.approvalToken);
      // Invoke Chrome's gesture-gated permission request first, then dispatch
      // the worker-owned approval marker without awaiting it in the same
      // synchronous JS task. The first await remains the native prompt; Chrome
      // cannot tear down this popup task between these two invocations.
      initiatedPermissionPrompt = {
        approvalToken: review.approvalToken,
        handoffNonce: review.approvalHandoffNonce,
        permissionLeaseId: review.permissionLeaseId
      };
      permissionPromptInFlight = true;
      let permissionRequest;
      try {
        permissionRequest = chrome.permissions.request({ origins });
        permissionRequestInvoked = true;
        approvalHandoffPromise = sendMessage(MESSAGE_TYPES.armCleanupApproval, {
          approvalToken: review.approvalToken,
          handoffNonce: review.approvalHandoffNonce,
          approval,
          ...popupBinding,
          ...sourceContext
        });
        void approvalHandoffPromise.catch(() => {});
      } catch (error) {
        permissionPromptInFlight = false;
        initiatedPermissionPrompt = null;
        if (direct) {
          directCleanupReview = null;
          directPreparedInput = '';
        } else {
          cleanupReview = null;
        }
        throw error;
      }
      let granted;
      try {
        granted = await permissionRequest;
        // Record Chrome's native decision before awaiting the worker handoff.
        // If the popup survives a grant but the arm rejects, the worker still
        // owns terminal reconciliation; the popup must not revoke access while
        // an onAdded-driven admission may already be running.
        permissionRequestGranted = granted === true;
        permissionRequestDenied = granted === false;
        const armed = await approvalHandoffPromise;
        if (armed.handoffNonce !== review.approvalHandoffNonce) {
          throw new Error('The worker-owned cleanup handoff changed before Chrome target access settled.');
        }
      } catch (error) {
        await approvalHandoffPromise.catch(() => null);
        if (direct) {
          directCleanupReview = null;
          directPreparedInput = '';
        } else {
          cleanupReview = null;
        }
        if (permissionRequestDenied) {
          // A native false result is conclusive even if the worker arm reply
          // timed out or rejected. Transfer that exact initiating-document
          // settlement to the worker before leaving this error path; no
          // onAdded event will arrive to repair a denied prompt later.
          permissionPromptSettlementSubmitted = true;
          await settleCleanupPermissionPrompt(review, 'denied');
        }
        if (permissionRequestGranted && cleanupReviewIsExpired(review)) {
          reviewExpiredDuringPermissionPrompt = true;
          permissionPromptSettlementSubmitted = true;
          retireExpiredPermissionPromptReview(direct);
          postPromptHandoffOutcome = await reconcileExpiredPermissionHandoff(review);
          forgetResolvedPermissionHandoffBinding(review, postPromptHandoffOutcome);
          renderPermissionHandoffOutcome(postPromptHandoffOutcome, { focus: true });
          return;
        }
        throw error;
      } finally {
        permissionPromptInFlight = false;
      }
      if (!granted) {
        await approvalHandoffPromise.catch(() => null);
        if (direct) {
          directCleanupReview = null;
          directPreparedInput = '';
        } else {
          cleanupReview = null;
        }
        permissionPromptSettlementSubmitted = true;
        await settleCleanupPermissionPrompt(review, 'denied');
        throw new Error('Site access was not granted. No cleanup has started.');
      }
      if (cleanupReviewIsExpired(review)) {
        reviewExpiredDuringPermissionPrompt = true;
        permissionPromptSettlementSubmitted = true;
        retireExpiredPermissionPromptReview(direct);
        postPromptHandoffOutcome = await reconcileExpiredPermissionHandoff(review);
        forgetResolvedPermissionHandoffBinding(review, postPromptHandoffOutcome);
        renderPermissionHandoffOutcome(postPromptHandoffOutcome, { focus: true });
        return;
      }
      review.hostPermissionsGranted = true;
    }
    clearPreparedReviewExpiry(direct);
    if ((direct ? directCleanupReview : cleanupReview) !== review) {
      invalidatedBySettings = direct ? directInvalidatedBySettings : reviewInvalidatedBySettings;
      throw new Error(
        invalidatedBySettings
          ? SETTINGS_CHANGED_REVIEW_MESSAGE
          : 'This cleanup review is no longer current. Review the current scope again before retrying.'
      );
    }
    if (direct) {
      directCleanupReview = null;
      directPreparedInput = '';
    } else {
      cleanupReview = null;
    }
    qs('#reviewCard').hidden = true;
    showProgress(
      3,
      'Consuming approval…',
      'The single-use authorization is being validated before any browser data changes.',
      { cancelable: false }
    );
    if (approvalHandoffPromise) {
      const response = await sendMessage(MESSAGE_TYPES.resumeArmedCleanup, {
        handoffNonce: review.approvalHandoffNonce,
        ...requirePopupPreparationBinding(review)
      });
      postPromptHandoffOutcome = classifyPermissionHandoffResponse(response, review);
      forgetResolvedPermissionHandoffBinding(review, postPromptHandoffOutcome);
      renderPermissionHandoffOutcome(postPromptHandoffOutcome, { focus: true });
      return;
    }
    const response = await sendMessage(MESSAGE_TYPES.runDeepClean, {
      approvalToken: review.approvalToken,
      approval,
      ...sourceContext,
      ...requirePopupPreparationBinding(review)
    });
    showProgress(100, 'Cleanup attempt finished', 'The cleanup and verification report is ready.', {
      cancelable: false
    });
    renderSummary(response.report, { focus: true, persisted: response.reportPersisted === true });
    popupPreparationBindings.delete(review.approvalToken);
  } catch (error) {
    const reviewStillUsable = (direct ? directCleanupReview : cleanupReview) === review;
    // Once Chrome grants access after the arm dispatch, only the worker may
    // reconcile the nonce-bound lease. The initiating popup may submit the
    // exact terminal prompt-settlement message after local review expiry, but
    // it never mutates permissions itself. Other popup errors can be a stale
    // or delayed view of an automatically admitted cleanup.
    const handedOffPromptIsWorkerOwned =
      Boolean(approvalHandoffPromise) && (permissionRequestGranted || permissionPromptSettlementSubmitted);
    if (!reviewStillUsable && !handedOffPromptIsWorkerOwned) {
      await cancelCleanupReviewToken(review.approvalToken, { promptNotStarted: !permissionRequestInvoked });
    }
    if (!reviewStillUsable) popupPreparationBindings.delete(review.approvalToken);
    invalidatedBySettings ||=
      (direct ? directInvalidatedBySettings : reviewInvalidatedBySettings) && !reviewStillUsable;
    const approvalError = reviewStillUsable
      ? formatError(error)
      : `${formatError(error)} Review the current scope again before retrying.`;
    if (reviewExpiredDuringPermissionPrompt) showError('');
    else if (invalidatedBySettings) showError('');
    else if (reviewStillUsable && !direct) showError('');
    else showError(approvalError);
    if (reviewStillUsable && !direct) {
      qs('#reviewCard').hidden = false;
      updateApprovalAvailability();
      detailedReviewRetryError = approvalError;
    }
    if (reviewStillUsable) schedulePreparedReviewExpiry(review, direct);
  } finally {
    popupAuthorityContinuations.delete(review.approvalToken);
    setTimeout(() => {
      busy = false;
      setBusy(false);
      setReviewMode(Boolean(cleanupReview));
      if (postPromptHandoffOutcome) {
        if (!direct) retireDetailedReviewUi();
        if (postPromptHandoffOutcome?.kind !== 'terminal') {
          renderPermissionHandoffOutcome(postPromptHandoffOutcome);
        }
      }
      if (detailedReviewRetryError && cleanupReview === review) {
        setReviewApprovalError(detailedReviewRetryError, { runtime: true });
        qs('#approveCleanup').focus({ preventScroll: true });
      }
      if (invalidatedBySettings) {
        announceSettingsChangedReview();
      } else if (
        direct &&
        directCleanupEnabled() &&
        !directCleanupReview &&
        !latestReportVisible &&
        (!postPromptHandoffOutcome || postPromptHandoffOutcome.kind === 'released')
      ) {
        void prepareDirectCleanup(qs('#targetInput').value.trim());
      }
    }, 250);
  }
}

function renderCleanupReview(review) {
  schedulePreparedReviewExpiry(review, false);
  qs('#reviewCard').hidden = false;
  qs('#reviewEnteredTarget').textContent =
    'Only the canonical domain is shown. Any path, query, credentials, or fragment from the input is ignored.';
  qs('#reviewNormalizedTarget').textContent = review.normalizedTarget || '';
  qs('#reviewScope').textContent = review.scopeLabel || 'Unknown';
  qs('#reviewCleanupMode').textContent = review.settingsSnapshot?.cleanupMode === 'expert' ? 'Expert' : 'Standard';
  qs('#reviewSubdomains').textContent = review.includesSubdomains ? 'Included' : 'Not included';
  qs('#reviewNormalScope').textContent = review.normalWindowScope?.summary || 'Included';
  qs('#reviewPrivateScope').textContent = review.privateWindowScope?.summary || 'Unknown';

  const associatedSection = qs('#reviewAssociatedSection');
  const associatedTargets = review.associatedTargets || [];
  associatedSection.hidden = associatedTargets.length === 0;
  replaceList(
    '#reviewAssociatedList',
    associatedTargets.map(
      (item) =>
        `${item.normalizedTarget} — ${item.scopeLabel}; subdomains ${item.includesSubdomains ? 'included' : 'not included'}`
    )
  );
  replaceList('#reviewAttemptedList', review.categoriesAttempted || []);
  replaceList('#reviewProtectedList', review.categoriesProtected || []);
  replaceList('#reviewUnavailableList', review.categoriesUnavailable || []);
  replaceList('#reviewWarnings', [...(review.warnings || []), ...(review.previewLimitations || [])]);

  renderReviewEffects(review);
  renderHostPermissionOrigins(review);

  const requirements = review.requirements || {};
  qs('#reviewHostPermission').hidden = Boolean(review.hostPermissionsGranted);
  setConditionalAcknowledgement(
    '#reviewAssociatedAcknowledgeWrap',
    '#reviewAssociatedAcknowledge',
    requirements.associatedTargets
  );
  setConditionalAcknowledgement('#reviewLocalAcknowledgeWrap', '#reviewLocalAcknowledge', requirements.localOrIpTarget);
  setConditionalAcknowledgement(
    '#reviewProtectedAcknowledgeWrap',
    '#reviewProtectedAcknowledge',
    requirements.protectedWebOrigins
  );
  qs('#reviewScopeAcknowledge').checked = false;
  const fileWrap = qs('#reviewFileConfirmationWrap');
  fileWrap.hidden = !requirements.downloadedFiles;
  qs('#reviewFileConfirmationPhrase').textContent = review.requiredFileConfirmation || '';
  qs('#reviewFileConfirmation').value = '';
  qs('#reviewFileConfirmation').setAttribute('aria-describedby', 'reviewFileConfirmationPhrase');
  qs('#reviewFileConfirmation').required = Boolean(requirements.downloadedFiles);
  qs('#reviewFileConfirmation').setAttribute('aria-required', String(Boolean(requirements.downloadedFiles)));
  const expiry = new Date(review.expiresAt);
  qs('#reviewExpiry').textContent = Number.isNaN(expiry.getTime())
    ? 'This approval is short-lived and single-use.'
    : `This single-use review expires at ${expiry.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}.`;
  updateApprovalAvailability();
  if (review.approvalHandoffStatus) {
    showProgress(
      20,
      'Cleanup approved',
      'Chrome target access is settling. SiteWipe will continue automatically; do not approve again.',
      { cancelable: false }
    );
  }
  setReviewMode(true);
  focusReviewHeading();
}

function focusReviewHeading() {
  setTimeout(() => {
    if (!cleanupReview || qs('#reviewCard').hidden) return;
    qs('#reviewHeading').focus({ preventScroll: true });
    qs('.popup-shell').scrollTop = 0;
  });
}

function renderHostPermissionOrigins(review) {
  const origins = Array.isArray(review.requiredHostPermissionOrigins)
    ? review.requiredHostPermissionOrigins.filter((origin) => typeof origin === 'string')
    : [];
  const inventory = review.hostPermissionInventory || {};
  const exactRequired = Array.isArray(inventory.exactRequiredHostPermissionOrigins)
    ? inventory.exactRequiredHostPermissionOrigins.filter((origin) => typeof origin === 'string')
    : [];
  const coveredByBroad = Array.isArray(inventory.requiredCoveredByBroadHostPermissionOrigins)
    ? inventory.requiredCoveredByBroadHostPermissionOrigins.filter((origin) => typeof origin === 'string')
    : [];
  const broadOrigins = Array.isArray(inventory.broadGrantedHostPermissionOrigins)
    ? inventory.broadGrantedHostPermissionOrigins.filter((origin) => typeof origin === 'string')
    : [];
  qs('#reviewHostPermissionOriginsSummary').textContent = review.hostPermissionsGranted
    ? `${origins.length} exact target pattern(s) are required: ${exactRequired.length} exist as exact grants and ${coveredByBroad.length} are covered by broader pre-existing access.`
    : `Chrome/Brave will be asked only for missing patterns in this ${origins.length}-pattern exact target scope after final approval.`;
  replaceList(
    '#reviewHostPermissionOrigins',
    origins.length ? origins : ['No valid target site-access pattern was provided. Cleanup cannot start.']
  );

  const broadSection = qs('#reviewBroadHostPermissionSection');
  broadSection.hidden = broadOrigins.length === 0;
  qs('#reviewBroadHostPermissionOriginsSummary').textContent = inventory.allSitesAccessGranted
    ? 'Preflight found all-site host access. It is user-controlled, is not requested by this cleanup, and will be preserved while cleanup remains limited to the reviewed target.'
    : 'Preflight found broader host access. It is user-controlled, is not requested by this cleanup, and will be preserved while cleanup remains limited to the reviewed target.';
  replaceList('#reviewBroadHostPermissionOrigins', broadOrigins);
}

async function discardCleanupReview({ announce = false, focus = false } = {}) {
  const review = cleanupReview;
  const token = review?.approvalToken;
  clearPreparedReviewExpiry(false);
  cleanupReview = null;
  qs('#reviewCard').hidden = true;
  resetReviewInputs();
  setReviewMode(false);
  if (token && !permissionPromptInFlight) {
    await cancelCleanupReviewToken(token, { promptNotStarted: true });
    await settleCleanupPermissionPrompt(review, 'abandoned');
    popupPreparationBindings.delete(token);
  }
  if (announce) {
    showError('');
    showProgress(0, 'Cleanup review canceled', 'No cleanup job was created and no website data was changed.', {
      cancelable: false
    });
    setTimeout(() => {
      if (!busy) qs('#progressCard').hidden = true;
    }, 1600);
  }
  if (focus) focusInput();
}

async function discardDirectCleanupPreparation({ settleLease = true } = {}) {
  const review = directCleanupReview;
  clearPreparedReviewExpiry(true);
  directCleanupReview = null;
  directPreparedInput = '';
  directPreparationPending = false;
  directPreparationGeneration += 1;
  updatePrimaryAction();
  if (!review || !settleLease) return;
  await cancelCleanupReviewToken(review.approvalToken, { promptNotStarted: true });
  await settleCleanupPermissionPrompt(review, 'abandoned');
  popupPreparationBindings.delete(review.approvalToken);
}

function schedulePreparedReviewExpiry(review, direct) {
  clearPreparedReviewExpiry(direct);
  const expiresAtMs = Date.parse(review?.expiresAt || '');
  if (!Number.isFinite(expiresAtMs)) return;
  const timerId = setTimeout(
    () => void expirePreparedCleanupReview(review, direct),
    Math.max(0, expiresAtMs - Date.now()) + 25
  );
  if (direct) directCleanupReviewExpiryTimerId = timerId;
  else cleanupReviewExpiryTimerId = timerId;
}

function clearPreparedReviewExpiry(direct) {
  const timerId = direct ? directCleanupReviewExpiryTimerId : cleanupReviewExpiryTimerId;
  if (timerId !== null) clearTimeout(timerId);
  if (direct) directCleanupReviewExpiryTimerId = null;
  else cleanupReviewExpiryTimerId = null;
}

function cleanupReviewIsExpired(review, now = Date.now()) {
  const expiresAtMs = Date.parse(review?.expiresAt || '');
  return !Number.isFinite(expiresAtMs) || Number(now) > expiresAtMs;
}

async function reconcileExpiredPermissionHandoff(review) {
  let resumeWarning;
  try {
    const response = await sendMessage(MESSAGE_TYPES.resumeArmedCleanup, {
      handoffNonce: review.approvalHandoffNonce,
      ...requirePopupPreparationBinding(review)
    });
    const outcome = classifyPermissionHandoffResponse(response, review);
    if (outcome.kind !== 'unknown') return outcome;
    resumeWarning = outcome.warning;
  } catch (error) {
    resumeWarning = formatError(error);
  }

  const popupSettlement = await settleCleanupPermissionPrompt(review, 'abandoned', {
    retainBindingUntilReleaseProof: true
  });
  if (permissionSettlementProvesRelease(popupSettlement)) return { kind: 'released' };
  return {
    kind: 'unknown',
    warning:
      resumeWarning ||
      'SiteWipe could not prove whether the reviewed cleanup started or whether temporary target access was released.'
  };
}

function classifyPermissionHandoffResponse(response, review) {
  const matchingNonce = response?.approvalHandoffNonce === review.approvalHandoffNonce;
  if (matchingNonce && response.report && typeof response.report === 'object') {
    return { kind: 'terminal', response };
  }
  if (
    matchingNonce &&
    response.approvalHandoffRunning === true &&
    response.cleanupStarted === true &&
    response.activeJob?.status === 'running' &&
    response.activeJob.admissionPhase === 'admitted' &&
    response.activeJob.approvalHandoffNonce === review.approvalHandoffNonce
  ) {
    return { kind: 'running', activeJob: response.activeJob };
  }
  if (
    matchingNonce &&
    response.approvalHandoffCanceled === true &&
    response.cleanupStarted === false &&
    response.temporaryAccessReleased === true &&
    permissionSettlementProvesRelease(response)
  ) {
    return { kind: 'released' };
  }
  return {
    kind: 'unknown',
    warning:
      typeof response?.warning === 'string' && response.warning
        ? response.warning
        : 'SiteWipe could not prove whether the reviewed cleanup started or whether temporary target access was released.'
  };
}

function forgetResolvedPermissionHandoffBinding(review, outcome) {
  if (['terminal', 'released'].includes(outcome?.kind)) {
    popupPreparationBindings.delete(review.approvalToken);
  }
}

function permissionSettlementProvesRelease(value) {
  const settlement = value?.settlement;
  return Boolean(
    settlement?.released === true && settlement.accessRemains === false && settlement.recordRetained === false
  );
}

function renderPermissionHandoffOutcome(outcome, { focus = false } = {}) {
  if (outcome?.kind === 'terminal') {
    showProgress(100, 'Cleanup attempt finished', 'The nonce-bound cleanup and verification outcome was recovered.', {
      cancelable: false
    });
    renderSummary(outcome.response.report, {
      focus,
      persisted: outcome.response.reportPersisted === true
    });
    return;
  }
  if (outcome?.kind === 'running') {
    renderActiveJob(outcome.activeJob);
    return;
  }
  if (outcome?.kind === 'released') {
    showExpiredPermissionPromptSettlement();
    return;
  }

  showError('');
  showProgress(
    0,
    'Cleanup status needs verification',
    'SiteWipe could not prove whether this cleanup started or whether temporary target access was released. Do not start another cleanup yet. Reopen SiteWipe to check the current job or report, or open Options to finish access recovery.',
    { cancelable: false }
  );
  setReviewMode(true);
  setReadyStatus('Check cleanup status', 'warning');
}

function showExpiredPermissionPromptSettlement() {
  showError('');
  showProgress(
    0,
    'Cleanup review expired',
    'No cleanup started. SiteWipe released the temporary target access. Prepare a fresh review so the scope, impact, and browser access are checked again.',
    { cancelable: false }
  );
  setReadyStatus('Review expired', 'warning');
}

function retireExpiredPermissionPromptReview(direct) {
  clearPreparedReviewExpiry(direct);
  if (direct) {
    directCleanupReview = null;
    directPreparedInput = '';
    return;
  }
  cleanupReview = null;
  retireDetailedReviewUi();
}

function retireDetailedReviewUi() {
  clearPreparedReviewExpiry(false);
  qs('#reviewCard').hidden = true;
  resetReviewInputs();
  setReviewMode(false);
}

async function expirePreparedCleanupReview(review, direct) {
  if ((direct ? directCleanupReview : cleanupReview) !== review || !cleanupReviewIsExpired(review)) {
    return { expired: false, promptSettlement: null };
  }
  const nativePermissionPromptStillOpen = permissionPromptInFlight;
  clearPreparedReviewExpiry(direct);
  if (direct) {
    directCleanupReview = null;
    directPreparedInput = '';
    directPreparationPending = false;
    directPreparationGeneration += 1;
  } else {
    cleanupReview = null;
    retireDetailedReviewUi();
  }
  setBusy(false);
  updatePrimaryAction();
  showError('');
  showProgress(
    0,
    'Cleanup review expired',
    nativePermissionPromptStillOpen
      ? 'Chrome target access is still settling. SiteWipe will verify the nonce-bound cleanup or permission-release outcome before saying what happened. Do not start another cleanup yet.'
      : 'No cleanup started. Prepare a fresh review so the scope, impact, and browser access are checked again.',
    { cancelable: false }
  );
  setReadyStatus('Review expired', 'warning');
  await cancelCleanupReviewToken(review.approvalToken, {
    promptNotStarted: !nativePermissionPromptStillOpen
  });
  // The final-click marker remains the only owner of a native prompt that can
  // still settle after this popup is torn down. Do not discard that tombstone
  // until Chrome returns granted/denied, onAdded observes the exact grant, or
  // a real browser-session startup proves the old prompt cannot survive.
  let promptSettlement = null;
  if (!nativePermissionPromptStillOpen) {
    promptSettlement = await settleCleanupPermissionPrompt(review, 'abandoned');
    popupPreparationBindings.delete(review.approvalToken);
  }
  if (direct && !nativePermissionPromptStillOpen && directCleanupEnabled() && !latestReportVisible) {
    void prepareDirectCleanup(qs('#targetInput').value.trim());
  }
  return { expired: true, promptSettlement };
}

async function settleCleanupPermissionPrompt(review, outcome, { retainBindingUntilReleaseProof = false } = {}) {
  if (
    !review?.permissionLeaseId ||
    initiatedPermissionPrompt?.approvalToken !== review.approvalToken ||
    initiatedPermissionPrompt?.handoffNonce !== review.approvalHandoffNonce ||
    initiatedPermissionPrompt?.permissionLeaseId !== review.permissionLeaseId
  ) {
    if (review?.approvalToken && !retainBindingUntilReleaseProof) {
      popupPreparationBindings.delete(review.approvalToken);
    }
    return null;
  }
  let settlementResponse = null;
  try {
    const popupBinding = requirePopupPreparationBinding(review);
    const response = await sendMessage(MESSAGE_TYPES.settleCleanupPermissionPrompt, {
      approvalToken: review.approvalToken,
      handoffNonce: review.approvalHandoffNonce,
      permissionLeaseId: review.permissionLeaseId,
      ...popupBinding,
      outcome
    });
    settlementResponse = response;
    return response;
  } catch {
    // The durable lease remains the recovery obligation when prompt settlement
    // cannot be confirmed in this popup lifetime.
    return null;
  } finally {
    if (!retainBindingUntilReleaseProof || permissionSettlementProvesRelease(settlementResponse)) {
      popupPreparationBindings.delete(review.approvalToken);
    }
  }
}

async function cancelCleanupReviewToken(token, { promptNotStarted = false } = {}) {
  if (!token) return;
  try {
    const popupBinding = requirePopupPreparationBinding(token);
    await sendMessage(MESSAGE_TYPES.cancelCleanupReview, {
      approvalToken: token,
      ...popupBinding,
      promptNotStarted
    });
  } catch {
    // Closing the UI still prevents approval; the unusable session token expires automatically.
  }
}

function acceptPreparedReviewResponse(response) {
  const review = response?.review;
  const approvalToken = String(review?.approvalToken || '');
  const popupContextId = response?.popupContextId;
  const popupPreparationCapability = response?.popupPreparationCapability;
  if (
    !/^[a-f0-9]{48}$/.test(approvalToken) ||
    typeof popupContextId !== 'string' ||
    popupContextId !== popupContextId.trim() ||
    !popupContextId ||
    popupContextId.length > 256 ||
    typeof popupPreparationCapability !== 'string' ||
    !/^[a-f0-9]{64}$/.test(popupPreparationCapability)
  ) {
    throw new Error('SiteWipe could not bind this review to the current popup. Reopen SiteWipe.');
  }
  popupPreparationBindings.set(approvalToken, Object.freeze({ popupContextId, popupPreparationCapability }));
  return review;
}

function requirePopupPreparationBinding(reviewOrToken) {
  const approvalToken = typeof reviewOrToken === 'string' ? reviewOrToken : String(reviewOrToken?.approvalToken || '');
  const binding = popupPreparationBindings.get(approvalToken);
  if (!binding) throw new Error('This popup no longer owns the prepared cleanup review. Reopen SiteWipe.');
  return binding;
}

function announceSettingsChangedReview() {
  showError('');
  showProgress(0, 'Cleanup review canceled', SETTINGS_CHANGED_REVIEW_MESSAGE, {
    cancelable: false
  });
  setReadyStatus('Review again', 'warning');
  focusInput();
}

function collectApproval() {
  return {
    approvalMode: 'detailed_review',
    reviewedScope: qs('#reviewScopeAcknowledge').checked,
    associatedTargets: qs('#reviewAssociatedAcknowledge').checked,
    localOrIpTarget: qs('#reviewLocalAcknowledge').checked,
    protectedWebOrigins: qs('#reviewProtectedAcknowledge').checked,
    fileConfirmationText: qs('#reviewFileConfirmation').value.trim()
  };
}

function approvalIsComplete() {
  if (!cleanupReview) return false;
  const requirements = cleanupReview.requirements || {};
  const approval = collectApproval();
  return (
    approval.reviewedScope &&
    (!requirements.associatedTargets || approval.associatedTargets) &&
    (!requirements.localOrIpTarget || approval.localOrIpTarget) &&
    (!requirements.protectedWebOrigins || approval.protectedWebOrigins) &&
    (!requirements.downloadedFiles || approval.fileConfirmationText === requirements.fileConfirmationText)
  );
}

function updateApprovalAvailability() {
  const complete = approvalIsComplete();
  const approvalContinuing = Boolean(cleanupReview?.approvalHandoffStatus);
  const approveButton = qs('#approveCleanup');
  approveButton.disabled = approvalContinuing || !complete;
  approveButton.setAttribute('aria-disabled', String(approvalContinuing || !complete));
  updateApprovalButtonLabel();
  const requirements = cleanupReview?.requirements || {};
  for (const [selector, required] of [
    ['#reviewScopeAcknowledge', Boolean(cleanupReview)],
    ['#reviewAssociatedAcknowledge', Boolean(requirements.associatedTargets)],
    ['#reviewLocalAcknowledge', Boolean(requirements.localOrIpTarget)],
    ['#reviewProtectedAcknowledge', Boolean(requirements.protectedWebOrigins)]
  ]) {
    const input = qs(selector);
    input.setAttribute('aria-invalid', String(required && !input.checked));
  }
  const fileInput = qs('#reviewFileConfirmation');
  const fileInvalid =
    Boolean(requirements.downloadedFiles) && fileInput.value.trim() !== requirements.fileConfirmationText;
  fileInput.setAttribute('aria-invalid', String(fileInvalid));
  if (approvalContinuing) {
    setReviewApprovalError('Approval received. SiteWipe will continue automatically after Chrome settles access.');
  } else if (!reviewApprovalRuntimeError) {
    setReviewApprovalError(
      cleanupReview && !complete ? 'Complete every displayed acknowledgement before cleanup can begin.' : ''
    );
  }
}

function handleApprovalInput() {
  if (reviewApprovalRuntimeError) setReviewApprovalError('');
  updateApprovalAvailability();
}

function updateApprovalButtonLabel() {
  const approveButton = qs('#approveCleanup');
  if (cleanupReview?.approvalHandoffStatus) {
    approveButton.textContent = 'Cleanup approved — continuing';
    return;
  }
  if (reviewApprovalRuntimeError) {
    approveButton.textContent = cleanupReview?.hostPermissionsGranted
      ? 'Retry approval and run'
      : 'Retry approval, grant access, and run';
    return;
  }
  approveButton.textContent = cleanupReview?.hostPermissionsGranted
    ? 'Approve and run cleanup'
    : 'Approve, grant access, and run';
}

function setReviewApprovalError(message, { runtime = false } = {}) {
  reviewApprovalRuntimeError = runtime ? String(message || '') : '';
  qs('#reviewApprovalError').textContent = message || '';
  updateApprovalButtonLabel();
}

function setConditionalAcknowledgement(wrapperSelector, inputSelector, required) {
  qs(wrapperSelector).hidden = !required;
  const input = qs(inputSelector);
  input.checked = false;
  input.required = Boolean(required);
  input.setAttribute('aria-required', String(Boolean(required)));
  input.setAttribute('aria-invalid', String(Boolean(required)));
}

function resetReviewInputs() {
  for (const selector of [
    '#reviewScopeAcknowledge',
    '#reviewAssociatedAcknowledge',
    '#reviewLocalAcknowledge',
    '#reviewProtectedAcknowledge'
  ])
    qs(selector).checked = false;
  for (const selector of ['#reviewAssociatedAcknowledge', '#reviewLocalAcknowledge', '#reviewProtectedAcknowledge']) {
    qs(selector).required = false;
    qs(selector).setAttribute('aria-required', 'false');
    qs(selector).setAttribute('aria-invalid', 'false');
  }
  qs('#reviewScopeAcknowledge').setAttribute('aria-invalid', 'false');
  qs('#reviewFileConfirmation').value = '';
  qs('#reviewFileConfirmation').required = false;
  qs('#reviewFileConfirmation').setAttribute('aria-required', 'false');
  qs('#reviewFileConfirmation').setAttribute('aria-invalid', 'false');
  setReviewApprovalError('');
  qs('#approveCleanup').disabled = true;
}

function replaceList(selector, items) {
  qs(selector).replaceChildren(
    ...items.map((item) => {
      const li = document.createElement('li');
      li.textContent = String(item);
      return li;
    })
  );
}

function createEffectRow(label, value) {
  const row = document.createElement('div');
  row.className = 'review-effect';
  row.setAttribute('role', 'listitem');
  const name = document.createElement('span');
  name.textContent = label;
  const detail = document.createElement('strong');
  detail.textContent = value;
  row.append(name, detail);
  return row;
}

function renderReviewEffects(review) {
  const effects = review.effects || {};
  const configured = effects.configuredCleanup || {};
  const rows = [
    [
      'Target site access',
      review.approvalHandoffStatus
        ? 'Approval committed; continuing automatically'
        : review.hostPermissionsGranted
          ? 'Already available'
          : 'Requested with final approval'
    ],
    ['Tabs will close', formatEnabledCount(effects.closeTabs, 'currently matched')],
    ['Target-tab state changes', formatTargetTabState(configured.targetTabState)],
    ['Live page scrub', formatLivePageScrub(configured.livePageScrub)],
    [
      'Embedded-frame discovery',
      formatEnabledDetail(configured.embeddedFrameDiscovery, 'matching target frames across accessible tabs')
    ],
    ['Cookie discovery/removal', formatCookieDiscovery(configured.cookies)],
    ['History/download discovery', formatRecordDiscovery(configured.recordDiscovery)],
    [
      'Protected web-app origins',
      configured.protectedWebOrigins ? 'Included — separately acknowledged below' : 'Not included'
    ],
    ['History entries removed', formatEnabledCount(effects.removeHistory, 'currently matched')],
    ['Download records removed', formatEnabledCount(effects.removeDownloadRecords, 'currently matched')],
    ['Downloaded files removed', formatFileEffect(effects.removeDownloadedFiles)],
    ['Cleanup progress overlay', formatProgressOverlay(effects.progressOverlay)],
    ['In-page overlay cancel button', formatProgressOverlayCancel(effects.progressOverlay)],
    ['Request shield installed', formatRequestShield(effects.requestShield)],
    ['Post-clean verification', effects.verification?.enabled ? 'Yes' : 'No'],
    ['Local report', effects.localReport?.summary || 'Unknown']
  ];
  qs('#reviewEffects').replaceChildren(...rows.map(([label, value]) => createEffectRow(label, value)));
}

function formatEnabledCount(effect, suffix) {
  if (!effect?.enabled) return 'No';
  return Number.isInteger(effect.matchingCount) ? `Yes — ${effect.matchingCount} ${suffix}` : 'Yes — count unavailable';
}

function formatFileEffect(effect) {
  if (!effect?.enabled) {
    if (effect?.settingEnabled && effect?.candidateReviewComplete === false)
      return 'No — candidate preflight unavailable';
    if (effect?.settingEnabled) return 'No — 0 preflight-bound completed files';
    return 'No — disabled';
  }
  return `Yes — ${effect.matchingCompletedFileCount} preflight-bound completed file(s)`;
}

function formatProgressOverlay(effect = {}) {
  if (!effect.enabled) return 'Disabled — no page overlay will be injected';
  const cap = Number.isInteger(effect.maxTabsPerUpdate) ? effect.maxTabsPerUpdate : 'bounded';
  const watchdogSeconds = Number.isFinite(Number(effect.watchdogMs))
    ? Math.round(Number(effect.watchdogMs) / 1000)
    : 15;
  return `Temporary — ${effect.scopeDescription || 'accessible reviewed tabs'}; cap ${cap} tabs per update (not a guaranteed simultaneous-visible limit); stale UI and its listener are removed by an approximately ${watchdogSeconds}s watchdog`;
}

function formatProgressOverlayCancel(effect = {}) {
  if (!effect.enabled) return 'Not shown — overlay disabled';
  return effect.cancelButtonEnabled
    ? 'Shown — requests cancellation before the next major phase'
    : 'Hidden — cancellation remains available from SiteWipe';
}

function formatLivePageScrub(effect = {}) {
  if (!effect.enabled) return 'Disabled';
  return `Enabled for matching target pages/frames — Storage Buckets ${onOff(effect.storageBuckets)}, OPFS ${onOff(effect.opfs)}, push/periodic-sync cleanup ${onOff(effect.serviceWorkerExtras)}, app-badge clear ${onOff(effect.appBadgeClear)}`;
}

function formatCookieDiscovery(effect = {}) {
  return `Browser cookie sweep ${onOff(effect.browserCookieSweep)}; partitioned embedding-site probes ${onOff(effect.partitionedEmbeddingSiteProbes)}; exhaustive accessible-store scan ${onOff(effect.exhaustiveAccessibleStoreScan)}`;
}

function formatRecordDiscovery(effect = {}) {
  return `Broader bounded search-term fallback ${onOff(effect.broadSearchTermFallback)}; bounded recent-download fallback ${onOff(effect.recentDownloadFallback)}; only exact target matches are changed`;
}

function formatTargetTabState(effect = {}) {
  return `Zoom reset ${onOff(effect.resetZoom)}; unmute ${onOff(effect.resetMutedTabs)}; unpin ${onOff(effect.unpinTabs)}`;
}

function formatEnabledDetail(enabled, detail) {
  return enabled ? `Enabled — ${detail}` : 'Disabled';
}

function formatRequestShield(effect = {}) {
  if (!effect.enabled) return effect.disabledReason || 'No';
  if (!effect.remainsAfterCleanup) return 'Yes — temporary during cleanup';
  return effect.expiresMinutes > 0
    ? `Yes — remains for up to ${effect.expiresMinutes} minute(s), or until browser restart`
    : 'Yes — remains until browser restart';
}

function onOff(value) {
  return value ? 'on' : 'off';
}

async function getSourceContext() {
  let currentWindow = null;
  try {
    currentWindow = await chrome.windows.getCurrent();
  } catch {
    // The validated active-tab observation below is the only safe fallback.
  }
  return resolveReviewedSourceContext(currentWindow, activeTabTarget?.tab || null);
}

function setReviewMode(active) {
  const locked = Boolean(active || busy);
  document.body.classList.toggle('review-active', Boolean(active));
  qs('#targetInput').disabled = locked;
  qs('#deepCleanButton').disabled = locked;
  qs('#useActiveTab').disabled = locked || !activeTabTarget?.supported;
  qs('#targetForm').setAttribute('aria-busy', String(busy));
}

function renderSummary(report, { focus = false, persisted = false } = {}) {
  if (!report) return;
  const card = qs('#summaryCard');
  card.hidden = false;
  card.querySelector('.summary-details').open = false;
  latestReportVisible = true;
  bindDisplayedReport(report, persisted);
  document.body.classList.add('has-summary');
  qs('#summaryTitle').textContent = cleanupOutcomeTitle(report);
  qs('#summaryTarget').textContent = report.targetDomain || 'Target unavailable';
  const badge = qs('#summaryStatus');
  const s = report.summary || {};
  const needsAttention =
    report.status !== 'completed' || (report.errors?.length || 0) > 0 || s.verificationStatus !== 'verified_zero';
  card.classList.toggle('has-attention', needsAttention);
  badge.textContent = needsAttention ? 'Review findings' : 'Complete';
  badge.className = `badge ${needsAttention ? 'warning' : 'success'}`;
  const metrics = [
    ['Verification', formatVerificationStatus(s.verificationStatus)],
    ['Cookies', `${s.cookiesRemoved || 0} removed`],
    ['History', `${s.historyEntriesRemoved || 0} removed`],
    ['Duration', formatDuration(s.totalDurationMs)]
  ];
  qs('#summaryMetrics').replaceChildren(...metrics.map(([label, value]) => createSummaryMetric(label, value)));
  const rows = [
    ['Mode', `${s.cleanupMode === 'expert' ? 'Expert' : 'Standard'} cleanup`],
    [
      'Approval',
      s.cleanupApprovalMode === 'settings_direct'
        ? 'Settings direct cleanup'
        : s.cleanupApprovalMode === 'quick'
          ? 'Legacy unreviewed cleanup (retired)'
          : 'Detailed review'
    ],
    [
      'Associated targets included',
      s.associatedTargetsIncluded || findSectionDetail(report, 'targetDiagnostics', 'associatedTargetCount') || 0
    ],
    ['Non-deduplicated operation events', formatOperationEventCount(s)],
    [
      'Verification evidence confidence',
      s.cleanupConfidenceScore == null
        ? s.cleanupConfidenceLabel || 'N/A'
        : `${s.cleanupConfidenceLabel || 'N/A'} (${s.cleanupConfidenceScore}/100)`
    ],
    ['Four-surface verification', formatVerificationStatus(s.verificationStatus)],
    ['Known four-surface residue', formatVerificationCount(s.verificationRemainingTotal)],
    ['Total duration', formatDuration(s.totalDurationMs)],
    ['Cookies removed', s.cookiesRemoved || 0],
    ['History entries removed', s.historyEntriesRemoved || 0],
    ['Download records erased', s.downloadHistoryEntriesRemoved || 0],
    [
      'Recovery preflight',
      s.extensionStatePreflightRan
        ? s.extensionStateRepaired
          ? 'Repaired SiteWipe-owned state'
          : 'Healthy'
        : 'Not run'
    ],
    ['Known limits / errors', `${report.unavailable?.length || 0} / ${report.errors?.length || 0}`]
  ];
  qs('#summaryRows').replaceChildren(...rows.map(([label, value]) => createSummaryRow(label, value)));
  const canUseStoredReportActions = displayedReportBinding?.persisted === true;
  qs('#summaryAnnouncement').textContent = `${cleanupOutcomeTitle(report)} for ${
    report.targetDomain || 'the selected target'
  }. ${
    needsAttention
      ? canUseStoredReportActions
        ? 'Open the full report to review the findings.'
        : 'Review the details shown here. This transient report was not saved locally.'
      : 'Verification found no residue in the four browser surfaces checked.'
  }`;
  if (focus) focusSummary();
}

function bindDisplayedReport(report, persisted) {
  const reportId = typeof report?.id === 'string' && report.id.trim() ? report.id : null;
  const generation = displayedReportBindingGeneration + 1;
  displayedReportBindingGeneration = generation;
  displayedReportBinding = {
    reportId,
    persisted: Boolean(persisted && reportId),
    sidePanelWindowId: null,
    sidePanelBindingExpiresAt: null,
    generation
  };
  const storedActionsAvailable = displayedReportBinding.persisted;
  qs('#summaryCard').classList.toggle('is-transient', !storedActionsAvailable);
  qs('#openSidePanel').hidden = !storedActionsAvailable;
  qs('#openSidePanel').disabled = storedActionsAvailable;
  qs('#forgetLatestReport').hidden = !storedActionsAvailable;
  qs('#summaryReportActionsNote').textContent = storedActionsAvailable
    ? 'Full-report and forget actions are bound to this exact locally stored report.'
    : 'This report is available only in this popup and was not saved locally. Open full report and Forget report are unavailable.';
  setSummaryActionStatus('');
  if (storedActionsAvailable) {
    void prepareDisplayedReportSidePanelBinding({ ...displayedReportBinding });
  }
}

function clearDisplayedReportBinding() {
  displayedReportBindingGeneration += 1;
  displayedReportBinding = null;
  qs('#openSidePanel').disabled = true;
  setSummaryActionStatus('');
}

function getDisplayedStoredReportBinding() {
  const binding = displayedReportBinding;
  if (!binding?.persisted || !binding.reportId) {
    throw new Error('This report was not saved locally, so stored-report actions are unavailable.');
  }
  return { ...binding };
}

function displayedReportStillMatches(binding) {
  return Boolean(
    binding?.persisted &&
    binding.reportId &&
    displayedReportBinding?.persisted &&
    displayedReportBinding.reportId === binding.reportId &&
    displayedReportBinding.generation === binding.generation
  );
}

async function prepareDisplayedReportSidePanelBinding(binding) {
  if (!displayedReportStillMatches(binding)) return;
  qs('#openSidePanel').disabled = true;
  try {
    if (typeof chrome.windows?.getCurrent !== 'function') {
      throw new Error('The current browser window could not be verified. Reopen SiteWipe and try again.');
    }
    const currentWindow = await chrome.windows.getCurrent();
    const windowId = currentWindow?.id;
    if (!Number.isInteger(windowId) || windowId < 0) {
      throw new Error('The current browser window could not be verified. Reopen SiteWipe and try again.');
    }
    const response = await sendMessage(MESSAGE_TYPES.openSidePanel, {
      reportId: binding.reportId,
      windowId
    });
    if (
      response.reportId !== binding.reportId ||
      response.windowId !== windowId ||
      !Number.isFinite(Date.parse(response.expiresAt)) ||
      Date.parse(response.expiresAt) <= Date.now() ||
      !displayedReportStillMatches(binding)
    ) {
      throw new Error('The stored report or browser window changed before the full report was bound.');
    }
    displayedReportBinding = {
      ...displayedReportBinding,
      sidePanelWindowId: response.windowId,
      sidePanelBindingExpiresAt: response.expiresAt
    };
    qs('#openSidePanel').disabled = false;
    setSummaryActionStatus('');
  } catch (error) {
    if (!displayedReportStillMatches(binding)) return;
    qs('#openSidePanel').disabled = false;
    setSummaryActionStatus(formatError(error));
  }
}

function setSummaryActionStatus(message) {
  qs('#summaryActionStatus').textContent = message || '';
}

function cleanupOutcomeTitle(report) {
  if (report.status === 'cancelled') return 'Cleanup cancelled';
  if (report.status === 'failed' || report.status === 'interrupted') return 'Cleanup did not complete';
  if ((report.errors?.length || 0) > 0 || report.summary?.verificationStatus !== 'verified_zero') {
    return 'Cleanup completed with findings';
  }
  return 'Cleanup complete';
}

function formatVerificationStatus(value) {
  return String(value || 'unknown').replaceAll('_', ' ');
}

function formatVerificationCount(value) {
  return Number.isFinite(Number(value)) && value !== null ? String(Number(value)) : 'Unknown';
}

function formatOperationEventCount(summary) {
  const value = summary?.browserOperationEventCount;
  return Number.isFinite(Number(value)) && value !== null ? String(Number(value)) : 'Not available';
}

async function forgetLatestReport() {
  let binding;
  try {
    binding = getDisplayedStoredReportBinding();
    const response = await sendMessage(MESSAGE_TYPES.forgetLatestReport, { reportId: binding.reportId });
    if (response.forgottenReportId !== binding.reportId) {
      throw new Error('The stored report changed before it could be forgotten. No different report was removed.');
    }
    if (!displayedReportStillMatches(binding)) return;
    qs('#summaryCard').hidden = true;
    latestReportVisible = false;
    clearDisplayedReportBinding();
    document.body.classList.remove('has-summary');
    showProgress(
      0,
      'Report forgotten',
      'This report was removed from the latest-report slot and optional local history.'
    );
    setTimeout(() => {
      qs('#progressCard').hidden = true;
      focusInput();
    }, 1200);
  } catch (error) {
    if (binding && !displayedReportStillMatches(binding)) return;
    setSummaryActionStatus(formatError(error));
  }
}

async function startAnotherCleanup() {
  if (directCleanupReview || directPreparationPending) {
    await discardDirectCleanupPreparation({ settleLease: !permissionPromptInFlight });
  }
  latestReportVisible = false;
  clearDisplayedReportBinding();
  document.body.classList.remove('has-summary');
  qs('#summaryCard').hidden = true;
  qs('#targetInput').value = '';
  normalized = null;
  setNormalized(null);
  showError('');
  qs('.popup-shell').scrollTop = 0;
  focusInput();
}

async function cancelActiveJob() {
  try {
    const response = await sendMessage(MESSAGE_TYPES.cancelActiveJob);
    if (response.canceled) {
      qs('#cancelActiveJob').disabled = true;
      qs('#cancelActiveJob').textContent = 'Cancel requested';
      showProgress(
        response.activeJob?.percent || 0,
        'Cancel requested',
        'SiteWipe will stop before the next major phase.',
        { cancelable: true }
      );
    }
  } catch (error) {
    showError(formatError(error));
  }
}

function openSidePanel() {
  let binding;
  try {
    binding = getDisplayedStoredReportBinding();
    const bindingExpiresAt = Date.parse(binding.sidePanelBindingExpiresAt);
    if (
      !Number.isInteger(binding.sidePanelWindowId) ||
      binding.sidePanelWindowId < 0 ||
      !Number.isFinite(bindingExpiresAt) ||
      Date.now() >= bindingExpiresAt
    ) {
      if (displayedReportStillMatches(binding)) {
        displayedReportBinding = {
          ...displayedReportBinding,
          sidePanelWindowId: null,
          sidePanelBindingExpiresAt: null
        };
      }
      qs('#openSidePanel').disabled = true;
      setSummaryActionStatus('Preparing the exact stored report. Select Open full report again in a moment.');
      void prepareDisplayedReportSidePanelBinding({ ...displayedReportBinding });
      return;
    }
    if (typeof chrome.sidePanel?.open !== 'function') throw new Error('The browser side panel is unavailable.');
    // This must be invoked synchronously in the click handler. Awaiting a
    // message first consumes Chrome's user activation and makes sidePanel.open
    // reject even though the user selected the button.
    // Use the positive window ID already inspected by the service worker so
    // the panel cannot drift to a different newly focused browser window.
    const opening = chrome.sidePanel.open({ windowId: binding.sidePanelWindowId });
    void Promise.resolve(opening).catch((error) => {
      if (displayedReportStillMatches(binding)) setSummaryActionStatus(formatError(error));
    });
  } catch (error) {
    if (!binding || displayedReportStillMatches(binding)) setSummaryActionStatus(formatError(error));
  }
}

function setBusy(isBusy, busyLabel = 'Working…') {
  const lockedForReview = Boolean(cleanupReview);
  document.body.classList.toggle('cleanup-active', Boolean(isBusy));
  qs('#deepCleanButton').disabled = isBusy || lockedForReview;
  qs('#targetInput').disabled = isBusy || lockedForReview;
  qs('#useActiveTab').disabled = isBusy || lockedForReview || !activeTabTarget?.supported;
  qs('#targetForm').setAttribute('aria-busy', String(isBusy));
  qs('#deepCleanSpinner').hidden = !isBusy;
  qs('#deepCleanLabel').textContent = isBusy ? busyLabel : primaryActionLabel();
  const hasError = Boolean(qs('#targetError').textContent);
  const readyLabel = isBusy
    ? 'Working'
    : hasError
      ? 'Needs attention'
      : lockedForReview
        ? 'Awaiting approval'
        : 'Ready';
  const readyTone = isBusy || lockedForReview ? 'warning' : hasError ? 'danger' : 'success';
  setReadyStatus(readyLabel, readyTone);
  qs('#progressCard').hidden = !isBusy;
  if (!isBusy) qs('#cancelActiveJob').hidden = true;
  if (!isBusy) {
    qs('#progressBar').style.width = '0%';
    qs('#progressTrack').setAttribute('aria-valuenow', '0');
  }
}

function showProgress(percent, title, detail, { cancelable = false } = {}) {
  const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
  qs('#progressCard').hidden = false;
  qs('#cancelActiveJob').hidden = !cancelable;
  qs('#progressBar').style.width = `${safePercent}%`;
  qs('#progressTrack').setAttribute('aria-valuenow', String(Math.round(safePercent)));
  qs('#progressTitle').textContent = title;
  qs('#progressDetail').textContent = detail;
}

function setNormalized(domain) {
  const card = qs('#normalizedCard');
  card.hidden = !domain;
  qs('#normalizedDomain').textContent = domain || '';
  updatePrimaryAction();
}

function primaryActionLabel() {
  return directCleanupEnabled() ? 'Clean now' : 'Review cleanup';
}

function updatePrimaryAction() {
  if (busy) return;
  const preparing = directCleanupEnabled() && directPreparationPending;
  qs('#deepCleanSpinner').hidden = !preparing;
  qs('#deepCleanButton').setAttribute('aria-busy', String(preparing));
  qs('#deepCleanLabel').textContent = preparing ? 'Preparing…' : primaryActionLabel();
  if (cleanupReview) return;
  qs('#deepCleanButton').disabled = directCleanupEnabled()
    ? directPreparationPending ||
      !directCleanupReview ||
      Boolean(directCleanupReview.approvalHandoffStatus) ||
      !normalized?.ok
    : false;
}

function directCleanupEnabled() {
  return effectiveSettings.skipCleanupReview === true;
}

function showError(message) {
  qs('#targetError').textContent = message || '';
  qs('#targetInput').setAttribute('aria-invalid', message ? 'true' : 'false');
  if (!busy) setReadyStatus(message ? 'Needs attention' : 'Ready', message ? 'danger' : 'success');
}

function setReadyStatus(label, tone) {
  const badge = qs('#readyBadge');
  badge.textContent = label;
  badge.className = `badge ${tone}`;
}

function createSummaryRow(label, value) {
  const row = document.createElement('div');
  row.className = 'report-row';
  const name = document.createElement('span');
  name.textContent = String(label);
  const content = document.createElement('strong');
  content.textContent = String(value);
  row.append(name, content);
  return row;
}

function createSummaryMetric(label, value) {
  const metric = document.createElement('div');
  metric.className = 'summary-metric';
  metric.setAttribute('role', 'listitem');
  const name = document.createElement('span');
  name.textContent = String(label);
  const content = document.createElement('strong');
  content.textContent = String(value);
  metric.append(name, content);
  return metric;
}

function focusSummary() {
  setTimeout(() => {
    if (!latestReportVisible || qs('#summaryCard').hidden) return;
    qs('.popup-shell').scrollTop = 0;
    qs('#summaryTitle').focus({ preventScroll: true });
  }, 320);
}

function focusInput() {
  setTimeout(() => qs('#targetInput').focus(), 40);
}

function qs(selector) {
  return document.querySelector(selector);
}
function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}
function findSectionDetail(report, key, detailKey) {
  const section = (report.sections || []).find((item) => item.key === key);
  return section?.details?.[detailKey];
}
function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return 'N/A';
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}s`;
  return `${Math.floor(value / 60000)}m ${Math.round((value % 60000) / 1000)}s`;
}
function trimText(value, maxLength) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

import { MESSAGE_TYPES, STORAGE_KEYS } from '../shared/constants.js';
import { sendMessage, formatError, onceDomReady, onStorageChange } from '../shared/messaging.js';

let normalized = null;
let busy = false;
let activeTabTarget = null;
let cleanupReview = null;
let reviewSourceContext = { sourceWindowId: null, sourceIncognito: false };

onceDomReady(init);

async function init() {
  bindEvents();
  await hydrateState();
  onStorageChange((changes, area) => {
    if (area !== 'local') return;
    if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.settings)) {
      void handleStoredSettingsChange(changes[STORAGE_KEYS.settings].newValue || {});
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'sitewipe.activeJob.v1'))
      renderActiveJob(changes['sitewipe.activeJob.v1'].newValue || null);
    if (changes['sitewipe.activeReport.v1']?.newValue) renderSummary(changes['sitewipe.activeReport.v1'].newValue);
  });
  focusInput();
}

function bindEvents() {
  qs('#targetForm').addEventListener('submit', onSubmit);
  qs('#targetInput').addEventListener('input', () => {
    if (cleanupReview) void discardCleanupReview({ announce: false, focus: false });
    if (normalized?.input !== qs('#targetInput').value.trim()) {
      normalized = null;
      setNormalized(null);
    }
  });
  qs('#targetInput').addEventListener('input', debounce(onInput, 250));
  qs('#openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  qs('#useActiveTab').addEventListener('click', () => useActiveTabTarget(true));
  qs('#openSidePanel').addEventListener('click', openSidePanel);
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
    qs(selector).addEventListener('input', updateApprovalAvailability);
    qs(selector).addEventListener('change', updateApprovalAvailability);
  }
}

async function hydrateState() {
  try {
    const state = await sendMessage(MESSAGE_TYPES.getPopupState);
    applySettings(state.settings);
    renderIncognito(state.incognitoAccess);
    await hydrateActiveTabTarget();
    if (state.activeJob?.status === 'running') renderActiveJob(state.activeJob);
    if (state.report) renderSummary(state.report);
  } catch (error) {
    showError(formatError(error));
  }
}

function renderActiveJob(job) {
  if (!job) {
    busy = false;
    setBusy(false);
    return;
  }
  if (job.status === 'running') {
    cleanupReview = null;
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
    busy = false;
    setBusy(false);
  }
}

async function hydrateActiveTabTarget() {
  const card = qs('#activeTabCard');
  const title = qs('#activeTabTitle');
  const domain = qs('#activeTabDomain');
  const button = qs('#useActiveTab');

  try {
    const response = await sendMessage(MESSAGE_TYPES.getActiveTabTarget);
    activeTabTarget = response.activeTab;
    card.hidden = false;
    if (activeTabTarget?.supported && activeTabTarget.normalized?.ok) {
      title.textContent = trimText(activeTabTarget.tab?.title || 'Current page', 56);
      domain.textContent = activeTabTarget.normalized.target.domain;
      button.disabled = false;
      button.textContent = 'Use active tab';
      if (!qs('#targetInput').value.trim()) useActiveTabTarget(false);
      return;
    }
    title.textContent = 'Active tab unavailable';
    domain.textContent = activeTabTarget?.reason || 'Open an http or https website tab.';
    button.disabled = true;
    button.textContent = 'Unsupported';
  } catch (error) {
    card.hidden = false;
    title.textContent = 'Active tab unavailable';
    domain.textContent = formatError(error);
    button.disabled = true;
    button.textContent = 'Unavailable';
  }
}

function useActiveTabTarget(announce) {
  if (!activeTabTarget?.supported || !activeTabTarget.normalized?.ok) return;
  const input = activeTabTarget.tab?.url || activeTabTarget.normalized.target.domain;
  qs('#targetInput').value = input;
  normalized = activeTabTarget.normalized;
  setNormalized(normalized.target.domain);
  showError('');
  if (!announce) return;
  const button = qs('#useActiveTab');
  button.textContent = 'Selected';
  setTimeout(() => {
    if (activeTabTarget?.supported) button.textContent = 'Use active tab';
  }, 900);
}

function applySettings(settings) {
  document.body.classList.toggle('reduced-motion', Boolean(settings?.reducedMotion));
  document.body.classList.toggle('high-contrast', Boolean(settings?.highContrast));
  updatePrimaryAction();
}

function handleStoredSettingsChange(settings) {
  applySettings(settings);
}

function renderIncognito(allowed) {
  const badge = qs('#incognitoBadge');
  badge.textContent = allowed ? 'Private: enabled' : 'Private: not enabled';
  badge.className = `badge ${allowed ? 'success' : 'warning'}`;
}

async function onInput() {
  const input = qs('#targetInput').value.trim();
  if (!input) {
    normalized = null;
    setNormalized(null);
    showError('');
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
    showError('');
    setNormalized(normalized.target.domain);
  } catch (error) {
    if (qs('#targetInput').value.trim() === input) showError(formatError(error));
  }
}

async function onSubmit(event) {
  event.preventDefault();
  if (busy || cleanupReview) return;
  const input = qs('#targetInput').value.trim();
  if (!input) {
    showError('Enter a domain or URL.');
    return;
  }

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
    cleanupReview = response.review;
    normalized = {
      ok: true,
      input,
      target: {
        domain: cleanupReview.normalizedTarget,
        hostPermissionOrigins: []
      }
    };
    setNormalized(cleanupReview.normalizedTarget);
    showError('');
    renderCleanupReview(cleanupReview);
  } catch (error) {
    cleanupReview = null;
    showError(formatError(error));
  } finally {
    busy = false;
    setBusy(false);
    setReviewMode(Boolean(cleanupReview));
  }
}

async function runApprovedCleanup() {
  if (!cleanupReview || busy || !approvalIsComplete()) return;
  const review = cleanupReview;
  const sourceContext = reviewSourceContext;
  const approval = collectApproval();
  busy = true;
  setBusy(true, review.hostPermissionsGranted ? 'Cleaning…' : 'Requesting access…');
  showProgress(
    2,
    review.hostPermissionsGranted ? 'Consuming approval…' : 'Requesting reviewed site access…',
    review.hostPermissionsGranted
      ? 'The single-use review is being validated before any browser data changes.'
      : 'Chrome will request only the target patterns shown in this review. No cleanup has started.',
    { cancelable: false }
  );
  try {
    if (!review.hostPermissionsGranted) {
      const origins = review.requiredHostPermissionOrigins || [];
      if (!origins.length) throw new Error('The reviewed target did not produce a valid site-access request.');
      // Keep permissions.request as the first asynchronous browser call in
      // this final approval handler. This minimizes the time temporary host
      // access can exist before the single-use cleanup request is consumed.
      const granted = await chrome.permissions.request({ origins });
      if (!granted) throw new Error('Site access was not granted. No cleanup has started.');
      review.hostPermissionsGranted = true;
    }
    cleanupReview = null;
    qs('#reviewCard').hidden = true;
    showProgress(
      3,
      'Consuming approval…',
      'The single-use review is being validated before any browser data changes.',
      { cancelable: false }
    );
    const response = await sendMessage(MESSAGE_TYPES.runDeepClean, {
      approvalToken: review.approvalToken,
      approval,
      ...sourceContext
    });
    showProgress(100, 'Cleanup attempt finished', 'The detailed cleanup and verification report is ready.', {
      cancelable: false
    });
    renderSummary(response.report);
  } catch (error) {
    const reviewStillUsable = cleanupReview === review;
    if (!reviewStillUsable) await cancelCleanupReviewToken(review.approvalToken);
    showError(
      reviewStillUsable ? formatError(error) : `${formatError(error)} Review the current scope again before retrying.`
    );
    if (reviewStillUsable) {
      qs('#reviewCard').hidden = false;
      updateApprovalAvailability();
    }
  } finally {
    setTimeout(() => {
      busy = false;
      setBusy(false);
      setReviewMode(Boolean(cleanupReview));
    }, 250);
  }
}

function renderCleanupReview(review) {
  qs('#reviewCard').hidden = false;
  qs('#reviewEnteredTarget').textContent = review.enteredTarget || '';
  qs('#reviewNormalizedTarget').textContent = review.normalizedTarget || '';
  qs('#reviewScope').textContent = review.scopeLabel || 'Unknown';
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
  setReviewMode(true);
  qs('#reviewHeading').focus();
}

async function discardCleanupReview({ announce = false, focus = false } = {}) {
  const token = cleanupReview?.approvalToken;
  cleanupReview = null;
  qs('#reviewCard').hidden = true;
  resetReviewInputs();
  setReviewMode(false);
  if (token) {
    await cancelCleanupReviewToken(token);
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

async function cancelCleanupReviewToken(token) {
  if (!token) return;
  try {
    await sendMessage(MESSAGE_TYPES.cancelCleanupReview, {
      approvalToken: token
    });
  } catch {
    // Closing the UI still prevents approval; the unusable session token expires automatically.
  }
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
  const approveButton = qs('#approveCleanup');
  approveButton.disabled = !complete;
  approveButton.setAttribute('aria-disabled', String(!complete));
  approveButton.textContent = cleanupReview?.hostPermissionsGranted
    ? 'Approve and run cleanup'
    : 'Approve, grant access, and run';
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
  qs('#reviewApprovalError').textContent =
    cleanupReview && !complete ? 'Complete every displayed acknowledgement before cleanup can begin.' : '';
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
  qs('#reviewApprovalError').textContent = '';
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
  const name = document.createElement('span');
  name.textContent = label;
  const detail = document.createElement('strong');
  detail.textContent = value;
  row.append(name, detail);
  return row;
}

function renderReviewEffects(review) {
  const effects = review.effects || {};
  const rows = [
    ['Target site access', review.hostPermissionsGranted ? 'Already available' : 'Requested with final approval'],
    ['Tabs will close', formatEnabledCount(effects.closeTabs, 'currently matched')],
    ['History entries removed', formatEnabledCount(effects.removeHistory, 'currently matched')],
    ['Download records removed', formatEnabledCount(effects.removeDownloadRecords, 'currently matched')],
    ['Downloaded files removed', formatFileEffect(effects.removeDownloadedFiles)],
    [
      'Request shield installed',
      effects.requestShield?.enabled
        ? effects.requestShield.remainsAfterCleanup
          ? 'Yes — remains after cleanup'
          : 'Yes — temporary'
        : 'No'
    ],
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

async function getSourceContext() {
  try {
    const currentWindow = await chrome.windows.getCurrent();
    return {
      sourceWindowId: Number.isInteger(currentWindow?.id) ? currentWindow.id : null,
      sourceIncognito: Boolean(currentWindow?.incognito)
    };
  } catch {
    return {
      sourceWindowId: null,
      sourceIncognito: Boolean(activeTabTarget?.tab?.incognito)
    };
  }
}

function setReviewMode(active) {
  const locked = Boolean(active || busy);
  qs('#targetInput').disabled = locked;
  qs('#deepCleanButton').disabled = locked;
  qs('#useActiveTab').disabled = locked || !activeTabTarget?.supported;
  qs('#targetForm').setAttribute('aria-busy', String(busy));
}

function renderSummary(report) {
  if (!report) return;
  qs('#summaryCard').hidden = false;
  qs('#summaryTitle').textContent = `${report.targetDomain} cleanup report`;
  const badge = qs('#summaryStatus');
  const s = report.summary || {};
  const needsAttention =
    report.status !== 'completed' || (report.errors?.length || 0) > 0 || s.verificationStatus !== 'verified_zero';
  badge.textContent = needsAttention ? 'Review warnings' : 'Cleanup complete';
  badge.className = `badge ${needsAttention ? 'warning' : 'success'}`;
  const rows = [
    ['Mode', `${s.cleanupMode === 'expert' ? 'Expert' : 'Standard'} cleanup`],
    ['Approval', s.cleanupApprovalMode === 'quick' ? 'Legacy unreviewed cleanup (retired)' : 'Detailed review'],
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
  try {
    await sendMessage(MESSAGE_TYPES.forgetLatestReport);
    qs('#summaryCard').hidden = true;
    showProgress(
      0,
      'Report forgotten',
      'This report was removed from the latest-report slot and optional local history.'
    );
    setTimeout(() => {
      qs('#progressCard').hidden = true;
    }, 1200);
  } catch (error) {
    showError(formatError(error));
  }
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

async function openSidePanel() {
  try {
    const currentWindow = await chrome.windows.getCurrent();
    if (chrome.sidePanel?.open && Number.isInteger(currentWindow?.id)) {
      await chrome.sidePanel.open({ windowId: currentWindow.id });
      return;
    }
    await sendMessage(MESSAGE_TYPES.openSidePanel);
  } catch {
    chrome.runtime.openOptionsPage();
  }
}

function setBusy(isBusy, busyLabel = 'Working…') {
  const lockedForReview = Boolean(cleanupReview);
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
  return 'Review cleanup';
}

function updatePrimaryAction() {
  if (busy) return;
  qs('#deepCleanLabel').textContent = primaryActionLabel();
  if (!cleanupReview) qs('#deepCleanButton').disabled = false;
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

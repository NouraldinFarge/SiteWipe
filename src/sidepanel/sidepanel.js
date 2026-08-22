import { CLEANUP_MATRIX, MESSAGE_TYPES, STORAGE_KEYS } from '../shared/constants.js';
import { sendMessage, onceDomReady, onStorageChange } from '../shared/messaging.js';
import { prepareReportForExport } from '../shared/report-redaction.js';
import { getReportIntegrityDigest, verifyReportIntegrity } from '../shared/report-integrity.js';
import {
  getSidePanelReportBindingStorageKey,
  normalizeSidePanelReportBinding
} from '../shared/side-panel-report-binding.js';
import {
  formatKnownResidue,
  formatReportOutcome,
  formatVerificationStatus,
  getReportRuntimeErrorCount,
  getReportUnavailableCount,
  summarizeHistoryVerification
} from './report-outcome.js';

let currentReport = null;
let currentReports = [];
let currentSettings = {};
let boundReportId = null;
let sidePanelBindingStorageKey = null;
let sidePanelWindowId = null;
let sidePanelBindingGeneration = 0;
let reportRefreshGeneration = 0;
let bindingExpiryTimer = null;
const REPORT_STORAGE_KEYS = new Set([STORAGE_KEYS.settings, STORAGE_KEYS.reports, STORAGE_KEYS.activeReport]);

onceDomReady(() =>
  init().catch((error) => announceStatus(`Side panel initialization failed: ${formatError(error)}`, 'error'))
);

async function init() {
  bindTabs();
  document.querySelector('#openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
  document.querySelector('#clearHistory').addEventListener('click', clearHistory);
  document.querySelector('#exportReport').addEventListener('click', () => exportReportJson(false));
  document.querySelector('#exportRedactedReport').addEventListener('click', () => exportReportJson(true));
  document.querySelector('#exportHtmlReport').addEventListener('click', exportReportHtml);
  document.querySelector('#exportTextReport').addEventListener('click', exportReportText);
  document.querySelector('#exportRedactedTextReport').addEventListener('click', exportRedactedReportText);
  document.querySelector('#copyTroubleshooting').addEventListener('click', copyTroubleshootingSummary);
  document.querySelector('#verifyDigest').addEventListener('click', verifyReportDigest);
  document.querySelector('#exportHistory').addEventListener('click', () => exportHistoryJson(false));
  document.querySelector('#exportRedactedHistory').addEventListener('click', () => exportHistoryJson(true));
  document.querySelector('#exportHistoryText').addEventListener('click', exportHistoryText);
  document.querySelector('#reportFilter').addEventListener('input', () => renderReport(currentReport));
  document.querySelector('#historyFilter').addEventListener('input', () => renderHistory(currentReports));
  document.querySelector('#matrixFilter').addEventListener('input', renderMatrix);
  document.querySelector('#matrixStatusFilter').addEventListener('change', renderMatrix);
  renderMatrix();
  clearBoundReportPresentation('Open a locally stored report from the SiteWipe popup.');
  await initializeSidePanelReportBinding();
}

async function initializeSidePanelReportBinding() {
  if (typeof chrome.windows?.getCurrent !== 'function' || typeof chrome.storage?.session?.get !== 'function') {
    throw new Error('The browser cannot verify an exact full-report binding for this side panel.');
  }
  const currentWindow = await chrome.windows.getCurrent();
  if (!Number.isInteger(currentWindow?.id) || currentWindow.id < 0) {
    throw new Error('The side panel could not verify its browser window.');
  }
  sidePanelWindowId = currentWindow.id;
  sidePanelBindingStorageKey = getSidePanelReportBindingStorageKey(sidePanelWindowId);
  const initialBindingGeneration = ++sidePanelBindingGeneration;
  onStorageChange(handleSidePanelStorageChange);
  const data = await chrome.storage.session.get([sidePanelBindingStorageKey]);
  if (initialBindingGeneration !== sidePanelBindingGeneration) return;
  const rawBinding = data?.[sidePanelBindingStorageKey];
  const binding = normalizeSidePanelReportBinding(rawBinding, sidePanelWindowId);
  if (!binding) {
    throw new Error('No live full-report binding was found. Open the locally stored report from the SiteWipe popup.');
  }
  await acceptSidePanelReportBinding(binding, initialBindingGeneration);
}

function handleSidePanelStorageChange(changes, area) {
  if (area === 'session' && sidePanelBindingStorageKey && changes?.[sidePanelBindingStorageKey]) {
    const bindingGeneration = ++sidePanelBindingGeneration;
    clearBindingExpiryTimer();
    boundReportId = null;
    clearBoundReportPresentation('Verifying the exact report selected in the popup…');
    const nextBinding = normalizeSidePanelReportBinding(
      changes[sidePanelBindingStorageKey].newValue,
      sidePanelWindowId
    );
    if (!nextBinding) {
      announceStatus('The full-report binding expired or became invalid. Open it again from the popup.', 'error');
      return;
    }
    void acceptSidePanelReportBinding(nextBinding, bindingGeneration).catch((error) => {
      if (bindingGeneration !== sidePanelBindingGeneration) return;
      clearBoundReportPresentation('The exact report could not be loaded. Open it again from the popup.');
      announceStatus(`Report refresh failed: ${formatError(error)}`, 'error');
    });
    return;
  }
  if (area === 'local' && Object.keys(changes || {}).some((key) => REPORT_STORAGE_KEYS.has(key))) {
    const bindingGeneration = sidePanelBindingGeneration;
    void refreshBoundReport(bindingGeneration).catch((error) => {
      if (bindingGeneration !== sidePanelBindingGeneration) return;
      clearBoundReportPresentation('The exact report is no longer available. Open it again from the popup.');
      announceStatus(`Report refresh failed: ${formatError(error)}`, 'error');
    });
  }
}

async function acceptSidePanelReportBinding(binding, bindingGeneration) {
  if (bindingGeneration !== sidePanelBindingGeneration) return;
  boundReportId = binding.reportId;
  scheduleBindingExpiry(binding, bindingGeneration);
  await refreshBoundReport(bindingGeneration);
}

function scheduleBindingExpiry(binding, bindingGeneration) {
  clearBindingExpiryTimer();
  const delay = Math.max(0, Date.parse(binding.expiresAt) - Date.now());
  bindingExpiryTimer = setTimeout(() => {
    if (bindingGeneration !== sidePanelBindingGeneration || boundReportId !== binding.reportId) return;
    sidePanelBindingGeneration += 1;
    boundReportId = null;
    clearBoundReportPresentation('The full-report binding expired. Open the report again from the popup.');
    announceStatus('The full-report binding expired. Open it again from the popup.', 'error');
  }, delay);
  bindingExpiryTimer?.unref?.();
}

function clearBindingExpiryTimer() {
  if (bindingExpiryTimer !== null) clearTimeout(bindingExpiryTimer);
  bindingExpiryTimer = null;
}

function bindTabs() {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  for (const button of tabs) {
    button.addEventListener('click', () => activateTab(button, { focus: false }));
    button.addEventListener('keydown', (event) => {
      const currentIndex = tabs.indexOf(button);
      let nextIndex = null;
      if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
      if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = tabs.length - 1;
      if (nextIndex == null) return;
      event.preventDefault();
      activateTab(tabs[nextIndex], { focus: true });
    });
  }
}

function activateTab(selected, { focus = false } = {}) {
  for (const item of document.querySelectorAll('[role="tab"]')) {
    const active = item === selected;
    item.classList.toggle('active', active);
    item.setAttribute('aria-selected', String(active));
    item.tabIndex = active ? 0 : -1;
    const panel = document.querySelector(`#${item.getAttribute('aria-controls')}`);
    if (panel) {
      panel.classList.toggle('active', active);
      panel.hidden = !active;
    }
  }
  if (focus) selected.focus();
}

async function refreshBoundReport(bindingGeneration = sidePanelBindingGeneration) {
  const expectedReportId = boundReportId;
  if (!expectedReportId) throw new Error('No exact popup report is bound to this side panel.');
  clearBoundReportPresentation('Loading the exact report selected in the popup…');
  const refreshGeneration = reportRefreshGeneration;
  const state = await sendMessage(MESSAGE_TYPES.getReportState, {
    reportId: expectedReportId,
    windowId: sidePanelWindowId
  });
  if (
    bindingGeneration !== sidePanelBindingGeneration ||
    refreshGeneration !== reportRefreshGeneration ||
    boundReportId !== expectedReportId
  ) {
    return;
  }
  if (state.report?.id !== expectedReportId) {
    throw new Error('The side panel refused a report that did not match the exact popup binding.');
  }
  currentSettings = state.settings || {};
  applySettings(state.settings);
  currentReport = state.report || null;
  currentReports = state.reports || [];
  renderReport(state.report);
  setReportControlAvailability(Boolean(currentReport), currentReports.length > 0);
  updateExportPrivacyNotes();
  renderHistory(currentReports);
}

function clearBoundReportPresentation(message) {
  reportRefreshGeneration += 1;
  currentReport = null;
  currentReports = [];
  document.querySelector('#reportOverview').innerHTML = `
    <div class="empty-state">
      <strong>Full report unavailable</strong>
      <p>${escapeHtml(message)}</p>
    </div>`;
  document.querySelector('#reportContainer').textContent = '';
  setReportControlAvailability(false, false);
  updateExportPrivacyNotes();
  renderHistory([]);
}

function setReportControlAvailability(hasReport, hasHistory) {
  document.querySelector('#reportTools').hidden = !hasReport;
  document.querySelector('#reportFilterWrap').hidden = !hasReport;
  for (const id of [
    'exportReport',
    'exportRedactedReport',
    'exportHtmlReport',
    'exportTextReport',
    'exportRedactedTextReport',
    'copyTroubleshooting',
    'verifyDigest'
  ]) {
    document.querySelector(`#${id}`).disabled = !hasReport;
  }
  document.querySelector('#historyTools').hidden = !hasHistory;
  document.querySelector('#historyFilterWrap').hidden = !hasHistory;
  document.querySelector('#clearHistory').hidden = !hasHistory;
  document.querySelector('#clearHistory').disabled = !hasHistory;
  for (const id of ['exportHistory', 'exportRedactedHistory', 'exportHistoryText']) {
    document.querySelector(`#${id}`).disabled = !hasHistory;
  }
}

function applySettings(settings) {
  document.body.classList.toggle('reduced-motion', Boolean(settings?.reducedMotion));
  document.body.classList.toggle('high-contrast', Boolean(settings?.highContrast));
}

function renderReport(report) {
  const root = document.querySelector('#reportContainer');
  const overviewRoot = document.querySelector('#reportOverview');
  if (!report) {
    overviewRoot.innerHTML = `
      <div class="empty-state">
        <strong>No cleanup report yet</strong>
        <p>Run a cleanup from the popup. Its latest locally retained report will appear here.</p>
      </div>`;
    root.textContent = '';
    return;
  }
  const s = report.summary || {};
  const filter = String(document.querySelector('#reportFilter')?.value || '')
    .trim()
    .toLowerCase();
  const filteredErrors = filterEvents(report.errors || [], filter);
  const filteredSkipped = filterEvents(report.skipped || [], filter);
  const filteredUnavailable = filterEvents(report.unavailable || [], filter);
  const filteredSections = filterEvents(report.sections || [], filter);
  const runtimeErrorCount = getReportRuntimeErrorCount(report);
  const unavailableLimitCount = getReportUnavailableCount(report);
  const outcome = formatReportOutcome(report);
  const confidence =
    s.cleanupConfidenceScore == null
      ? s.cleanupConfidenceLabel || 'Not available'
      : `${s.cleanupConfidenceLabel || 'Unrated'} · ${s.cleanupConfidenceScore}/100`;
  const groups = [
    {
      title: 'Scope and authorization',
      description: 'Target, mode, private-window reach, and approval path',
      open: true,
      rows: [
        ['Target domain', report.targetDomain],
        ['Target mode', findSectionDetail(report, 'targetDiagnostics', 'matchMode') || 'registrable_domain'],
        ['Exact origin', findSectionDetail(report, 'targetDiagnostics', 'exactOrigin') || 'N/A'],
        [
          'Associated targets included',
          s.associatedTargetsIncluded || findSectionDetail(report, 'targetDiagnostics', 'associatedTargetCount') || 0
        ],
        ['Cleanup mode', `${s.cleanupMode === 'expert' ? 'Expert' : 'Standard'} cleanup`],
        ['Approval', formatCleanupApprovalMode(s.cleanupApprovalMode)],
        ['Private access available', report.incognitoAccess ? 'Yes' : 'No'],
        ['Report started', report.startedAt || 'N/A'],
        ['Report finished', report.finishedAt || 'N/A']
      ]
    },
    {
      title: 'Browser data changes',
      description: 'Tabs, cookies, history, downloads, and discovered browser records',
      rows: [
        ['Normal tabs closed', s.normalTabsClosed || 0],
        ['Private tabs closed', s.incognitoTabsClosed || 0],
        ['Target tabs audited', s.targetTabsAudited || 0],
        ['Site zoom states read', s.siteZoomStatesRead || 0],
        ['Site zoom states reset', s.siteZoomStatesReset || 0],
        ['Muted target tabs', s.mutedTargetTabs || 0],
        ['Muted target tabs reset', s.mutedTargetTabsReset || 0],
        ['Pinned target tabs', s.pinnedTargetTabs || 0],
        ['Pinned target tabs reset', s.pinnedTargetTabsReset || 0],
        ['Grouped target tabs', s.groupedTargetTabs || 0],
        ['Discarded/frozen target tabs', `${s.discardedTargetTabs || 0}/${s.frozenTargetTabs || 0}`],
        ['Cookies removed', s.cookiesRemoved || 0],
        ['Discovered site origins', s.discoveredOrigins || 0],
        ['Discovered cookie hosts', s.discoveredCookieHosts || 0],
        ['Partition top-level sites probed', s.partitionTopLevelSitesProbed || 0],
        ['Partitioned cookie attempts', s.partitionedCookiesAttempted || 0],
        ['Partitioned cookies removed', s.partitionedCookiesRemoved || 0],
        [
          'Browser cookie sweep',
          s.browserCookieSweepAttempted ? (s.browserCookieSweepSucceeded ? 'Succeeded' : 'Partial') : 'Skipped'
        ],
        ['History entries removed', s.historyEntriesRemoved || 0],
        ['Download history erased', s.downloadHistoryEntriesRemoved || 0],
        ['Downloaded files removed', s.downloadedFilesRemoved || 0],
        ['Downloaded-file removal failures', s.downloadedFileRemovalFailures || 0]
      ]
    },
    {
      title: 'Page and origin storage',
      description: 'Live frames and origin-scoped storage exposed to SiteWipe',
      rows: [
        ['Matching frames discovered', s.matchingFramesDiscovered || 0],
        ['Live frames scrubbed', s.pageScriptFramesMatched || 0],
        ['Page localStorage keys cleared', s.pageScriptLocalStorageCleared || 0],
        ['Page sessionStorage keys cleared', s.pageScriptSessionStorageCleared || 0],
        ['Page IndexedDB DBs deleted', s.pageScriptIndexedDBDeleted || 0],
        ['Page Cache API entries deleted', s.pageScriptCachesDeleted || 0],
        ['Page service workers unregistered', s.pageScriptServiceWorkersUnregistered || 0],
        ['Push subscriptions unsubscribed', s.pageScriptPushSubscriptionsUnsubscribed || 0],
        ['Background sync tags observed', s.pageScriptBackgroundSyncTagsObserved || 0],
        ['Periodic sync tags removed', s.pageScriptPeriodicSyncTagsUnregistered || 0],
        ['Page Storage Buckets deleted', s.pageScriptStorageBucketsDeleted || 0],
        ['OPFS entries deleted', s.pageScriptOPFSEntriesDeleted || 0],
        ['App badges cleared', s.pageScriptAppBadgeCleared || 0],
        [
          'Persistent storage before',
          s.pageScriptPersistentStorageBefore == null ? 'Unknown' : s.pageScriptPersistentStorageBefore ? 'Yes' : 'No'
        ],
        [
          'Storage estimate usage before/after',
          `${formatBytes(s.pageScriptStorageEstimateBeforeUsage)} / ${formatBytes(s.pageScriptStorageEstimateAfterUsage)}`
        ],
        ['Visible page cookies expired', s.pageScriptCookiesExpired || 0],
        ['Page scrub worlds', s.pageScriptWorldsAttempted || 'None'],
        ['Storage cleanup attempted', s.storageCleanupAttempted ? 'Yes' : 'No'],
        ['Cache cleanup attempted', s.cacheCleanupAttempted ? 'Yes' : 'No'],
        ['Origin cleanup plans succeeded', s.originStorageTypesSucceeded || 0],
        ['Origin cleanup plans failed', s.originStorageTypesFailed || 0],
        ['Service workers cleared', s.serviceWorkersCleared ? 'Attempted' : 'No']
      ]
    },
    {
      title: 'Safety and access boundaries',
      description: 'Protected data, permission state, recovery, and temporary safeguards',
      rows: [
        ['Protected site data included', s.protectedWebCleanupAttempted ? 'Yes' : 'No'],
        ['Autofill and payment methods', 'Protected — global form-data removal is never called'],
        [
          'Browser permission rules',
          s.sitePermissionSettingsPreserved ? 'Preserved — manage manually in Chrome/Brave' : 'Not reported'
        ],
        [
          'Protected browser data',
          s.protectedBrowserDataGuardActive ? 'Passwords, bookmarks, and Sync protected' : 'Guard status unavailable'
        ],
        [
          'Recovery preflight',
          s.extensionStatePreflightRan
            ? s.extensionStateRepaired
              ? 'Repaired SiteWipe-owned state'
              : 'Healthy'
            : 'Not run'
        ],
        [
          'Temporary request shield',
          s.temporaryDnrShieldInstalled
            ? s.temporaryDnrShieldRemoved
              ? 'Used and removed'
              : s.postWipeSessionBlockKept
                ? 'Kept active'
                : 'Installed'
            : s.temporaryDnrShieldSkippedForNormalOnlyReview
              ? 'Skipped — normal-only safety boundary'
              : 'Skipped or unavailable'
        ],
        ['Host access mode', s.hostAccessMode || 'Preflight-bound target access'],
        [
          'Target site access available before cleanup',
          s.targetSiteAccessGranted || report.hostPermissionsGranted ? 'Yes' : 'No'
        ],
        [
          'Exact required host grants remaining after release',
          s.exactRequiredHostPermissionOriginsGranted ?? 'Unknown'
        ],
        ['Broader host grants remaining after release', s.broadHostPermissionOriginsGranted ?? 'Unknown'],
        [
          'All-site host access observed',
          s.allSitesAccessGranted == null ? 'Unknown' : s.allSitesAccessGranted ? 'Yes — preserved' : 'No'
        ]
      ]
    },
    {
      title: 'Verification and diagnostics',
      description: 'Measured residue, timings, progress UI, and local checksum',
      rows: [
        ['Report status', formatStatusLabel(report.status)],
        ['Non-deduplicated operation events', formatOperationEventCount(s)],
        ['Verification evidence confidence', confidence],
        ['Four-surface verification', formatVerificationStatus(s)],
        ['Total duration', formatDuration(s.totalDurationMs)],
        ['Slowest phase', s.slowestPhase || 'N/A'],
        [
          'Four-surface residue C/T/H/D',
          [
            s.verificationCookiesRemaining,
            s.verificationTabsRemaining,
            s.verificationHistoryRemaining,
            s.verificationDownloadsRemaining
          ]
            .map(formatVerificationCount)
            .join('/')
        ],
        ['Known four-surface residue total', formatVerificationCount(s.verificationRemainingTotal)],
        [
          'Page progress overlay',
          s.progressOverlayEnabled
            ? `${s.progressOverlayTabsShown || 0} shown / ${s.progressOverlayTabsHidden || 0} hidden`
            : 'Disabled'
        ],
        ['Overlay cancel button', s.progressOverlayCancelButtonEnabled ? 'Enabled' : 'Disabled'],
        ['Progress overlay injection errors', s.progressOverlayInjectionErrors || 0],
        ['Phase timing entries', report.phaseTimings ? Object.keys(report.phaseTimings).length : 0],
        ['Report checksum', report.integrity?.digest || 'N/A']
      ]
    }
  ];
  const detailGroups = groups.map((group) => renderReportGroup(group, filter)).filter(Boolean);
  const eventSections = [
    renderEventCategory({
      title: 'Runtime errors',
      description: 'Failures recorded while SiteWipe attempted this cleanup',
      events: filteredErrors,
      total: runtimeErrorCount,
      filter,
      tone: 'error',
      empty: runtimeErrorCount
        ? `${runtimeErrorCount} runtime ${runtimeErrorCount === 1 ? 'error is' : 'errors are'} recorded in the summary, but this retained report has no detailed error entries.`
        : 'No runtime errors were recorded for this cleanup.',
      showEmpty: true
    }),
    renderEventCategory({
      title: 'Skipped by safety or settings',
      description: 'Categories intentionally preserved or not selected',
      events: filteredSkipped,
      total: report.skipped?.length || 0,
      filter,
      empty: 'No intentionally skipped categories were recorded.'
    }),
    renderEventCategory({
      title: 'Unavailable browser limits',
      description: 'Browser or platform surfaces SiteWipe could not access; these are not runtime errors',
      events: filteredUnavailable,
      total: unavailableLimitCount,
      filter,
      tone: 'limit',
      empty: unavailableLimitCount
        ? `${unavailableLimitCount} unavailable browser ${unavailableLimitCount === 1 ? 'limit is' : 'limits are'} recorded in the summary, but this retained report has no detailed limit entries.`
        : 'No unavailable browser categories were recorded.'
    }),
    renderExecutionDetails(filteredSections, report.sections?.length || 0, filter)
  ].filter(Boolean);
  const filteredDetails = [...detailGroups, ...eventSections];
  overviewRoot.innerHTML = `
    <article class="card panel-card outcome-card ${outcome.tone}">
      <div class="outcome-header">
        <span class="outcome-badge ${outcome.tone}">${escapeHtml(outcome.badge)}</span>
        <div>
          <h2>${escapeHtml(outcome.title)}</h2>
          <p class="outcome-target">${escapeHtml(report.targetDomain || 'Unknown target')}</p>
          <p class="outcome-meta">${escapeHtml(report.finishedAt || report.startedAt || 'Time not recorded')} · ${report.redacted ? 'stored redacted' : 'stored with full details'}</p>
        </div>
        <p class="outcome-copy">${escapeHtml(outcome.copy)}</p>
      </div>
      <div class="outcome-metrics">
        ${metric('Runtime status', formatStatusLabel(report.status))}
        ${metric('Post-clean verification', formatVerificationStatus(s))}
        ${metric('Known residue', formatKnownResidue(s))}
        ${metric('Runtime errors', runtimeErrorCount)}
        ${metric('Evidence confidence', confidence)}
        ${metric('Total duration', formatDuration(s.totalDurationMs))}
      </div>
    </article>`;
  root.innerHTML = filteredDetails.length
    ? filteredDetails.join('')
    : `<div class="empty-state"><strong>No report details matched</strong><p>Try a broader search term or clear the filter.</p></div>`;
}

function renderReportGroup({ title, description, rows, open = false }, filter) {
  const visibleRows = filter
    ? rows.filter(([label, value]) => `${label} ${String(value ?? '')}`.toLowerCase().includes(filter))
    : rows;
  if (!visibleRows.length) return '';
  return `
    <details class="report-disclosure" ${open || filter ? 'open' : ''}>
      <summary>
        <span class="disclosure-title">${escapeHtml(title)}</span>
        <span class="disclosure-copy">${escapeHtml(description)} · ${visibleRows.length} ${visibleRows.length === 1 ? 'field' : 'fields'}</span>
      </summary>
      <div class="report-grid">${visibleRows.map(([label, value]) => row(label, value)).join('')}</div>
    </details>`;
}

function renderEventCategory({ title, description, events, total, filter, tone = '', empty, showEmpty = false }) {
  if (filter && !events.length) return '';
  if (!filter && !total && !showEmpty) return '';
  const successNote = !total && showEmpty ? ' success-note' : '';
  return `
    <article class="card event-section${successNote}">
      <div class="section-title">
        <span>${escapeHtml(title)}</span>
        <small>${total} ${total === 1 ? 'item' : 'items'}${filter ? ' · filtered' : ''}</small>
      </div>
      <p class="section-copy">${escapeHtml(description)}</p>
      <div class="errors-list">${renderEvents(events, empty, tone)}</div>
    </article>`;
}

function renderExecutionDetails(events, total, filter) {
  if (filter && !events.length) return '';
  return `
    <details class="report-disclosure" ${filter ? 'open' : ''}>
      <summary>
        <span class="disclosure-title">Execution details</span>
        <span class="disclosure-copy">Per-phase evidence · ${events.length}/${total} ${total === 1 ? 'step' : 'steps'}${filter ? ' matched' : ''}</span>
      </summary>
      <div class="errors-list event-section">${renderEvents(events, 'No execution sections were recorded.')}</div>
    </details>`;
}

function metric(label, value) {
  return `<div class="outcome-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value ?? ''))}</strong></div>`;
}

function historyFact(label, value) {
  return `<div class="history-fact"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value ?? ''))}</strong></div>`;
}

function updateExportPrivacyNotes() {
  const reportNote = document.querySelector('#storedReportPrivacyNote');
  const reportSummary = document.querySelector('#reportSensitiveSummary');
  if (currentReport?.redacted) {
    reportSummary.textContent = 'Full stored exports — source already redacted';
    reportNote.textContent =
      'This report was stored redacted. A full stored export preserves every remaining field, but it cannot restore browsing details that were removed before storage. Review the file before sharing.';
  } else {
    reportSummary.textContent = 'Full stored exports — review before sharing';
    reportNote.textContent =
      'This report was stored with full details. A full stored export may include domains, URLs, filenames, local paths, and detailed errors.';
  }
  const historyNote = document.querySelector('#storedHistoryPrivacyNote');
  const historySummary = document.querySelector('#historySensitiveSummary');
  const storedRedacted = reportsAreStoredRedacted();
  historySummary.textContent = storedRedacted
    ? 'Full stored history — all reports already redacted'
    : 'Full stored history — review before sharing';
  historyNote.textContent = storedRedacted
    ? 'Every retained report is already stored redacted. A full stored history export cannot restore removed details, but it preserves all remaining fields.'
    : 'At least one retained report may contain full browsing details. Prefer the redacted history exports for sharing.';
}

function reportsAreStoredRedacted() {
  return Boolean(currentReports.length && currentReports.every((report) => report?.redacted === true));
}

function renderMatrix() {
  const root = document.querySelector('#matrixContainer');
  const search = String(document.querySelector('#matrixFilter')?.value || '')
    .trim()
    .toLowerCase();
  const selectedStatus = document.querySelector('#matrixStatusFilter')?.value || 'all';
  const items = CLEANUP_MATRIX.filter((item) => {
    const searchable = [item.type, item.api, item.targeted, item.incognito, item.status].join(' ').toLowerCase();
    const supportLevel = matrixSupportLevel(item.status);
    return (!search || searchable.includes(search)) && (selectedStatus === 'all' || selectedStatus === supportLevel);
  });
  document.querySelector('#matrixCount').textContent =
    `Showing ${items.length} of ${CLEANUP_MATRIX.length} capabilities.`;
  if (!items.length) {
    root.innerHTML = `
      <div class="empty-state" role="listitem">
        <strong>No capabilities matched</strong>
        <p>Try a broader search term or choose a different support level.</p>
      </div>`;
    return;
  }
  root.innerHTML = `
    ${items
      .map(
        (item) => `
      <div class="matrix-list-item" role="listitem">
        <details class="matrix-item">
          <summary class="matrix-item-header">
            <span class="matrix-title">${escapeHtml(item.type)}</span>
            <span class="status-pill ${statusClass(item.status)}">${escapeHtml(formatMatrixStatus(item.status))}</span>
          </summary>
          <dl class="matrix-facts">
            <div><dt>Reported support</dt><dd>${escapeHtml(item.status)}</dd></div>
            <div><dt>Browser mechanism</dt><dd class="mono">${escapeHtml(item.api)}</dd></div>
            <div><dt>Target behavior</dt><dd>${escapeHtml(item.targeted)}</dd></div>
            <div><dt>Private windows</dt><dd>${escapeHtml(item.incognito)}</dd></div>
          </dl>
        </details>
      </div>
    `
      )
      .join('')}`;
}

function matrixSupportLevel(status) {
  const className = statusClass(String(status || ''));
  return className === 'skipped' ? 'unavailable' : className;
}

function formatMatrixStatus(status) {
  const value = String(status || 'unknown').toLowerCase();
  if (value.includes('unavailable')) return 'Unavailable';
  if (value.includes('manual')) return 'Manual only';
  if (value.includes('skipped')) return 'Skipped';
  if (value.includes('advanced')) return 'Advanced opt-in';
  if (value.includes('optional')) return 'Optional';
  if (value.includes('partial')) return 'Partial · pending';
  if (value.includes('pending')) return 'Validation pending';
  if (value.includes('fully')) return 'Fully supported';
  return formatStatusLabel(value);
}

function renderHistory(reports) {
  const root = document.querySelector('#historyContainer');
  const count = reports?.length || 0;
  document.querySelector('#historyCount').textContent = `${count} ${count === 1 ? 'report' : 'reports'}`;
  const filter = String(document.querySelector('#historyFilter')?.value || '')
    .trim()
    .toLowerCase();
  const items = filterEvents(reports || [], filter);
  if (!items.length) {
    root.innerHTML = filter
      ? '<div class="empty-state"><strong>No retained reports matched</strong><p>Try a broader search term or clear the filter.</p></div>'
      : `<div class="empty-state"><strong>No stored cleanup history</strong><p>${
          currentSettings.keepHistory
            ? 'History retention is enabled. Completed cleanups will appear here when the browser stores them.'
            : 'History retention is off. The latest report can still appear in the Report tab for its separate retention window.'
        }</p></div>`;
    return;
  }
  const verificationHistory = summarizeHistoryVerification(items);
  const header = `<div class="history-overview"><strong>${items.length} ${items.length === 1 ? 'report' : 'reports'} shown</strong><p>${escapeHtml(verificationHistory.text)}${filter ? ` · Filter: “${escapeHtml(filter)}”` : ''}</p></div>`;
  root.innerHTML =
    header +
    items
      .map((report) => {
        const s = report.summary || {};
        const confidence =
          s.cleanupConfidenceScore == null
            ? s.cleanupConfidenceLabel || 'N/A'
            : `${s.cleanupConfidenceLabel || 'N/A'} (${s.cleanupConfidenceScore}/100)`;
        const outcome = formatReportOutcome(report);
        return `
    <article class="history-item">
      <header class="history-item-header">
        <div>
          <strong>${escapeHtml(report.targetDomain || 'Unknown target')}</strong>
          <time datetime="${escapeHtml(report.finishedAt || report.startedAt || '')}">${escapeHtml(report.finishedAt || report.startedAt || 'Time not recorded')}</time>
        </div>
        <span class="outcome-badge ${outcome.tone}">${escapeHtml(outcome.badge)}</span>
      </header>
      <div class="history-facts">
        ${historyFact('Verification', formatVerificationStatus(s))}
        ${historyFact('Confidence', confidence)}
        ${historyFact('Duration', formatDuration(s.totalDurationMs))}
        ${historyFact('Known residue', formatKnownResidue(s))}
        ${historyFact('Operations', formatOperationEventCount(s))}
        ${historyFact('Origins / frames', `${formatDisplayCount(s.discoveredOrigins)} / ${formatDisplayCount(s.pageScriptFramesMatched)}`)}
        ${historyFact('Cookies / history', `${formatDisplayCount(s.cookiesRemoved)} / ${formatDisplayCount(s.historyEntriesRemoved)}`)}
        ${historyFact('Associated targets', formatDisplayCount(s.associatedTargetsIncluded))}
      </div>
    </article>`;
      })
      .join('');
}

async function exportHistoryJson(redacted = false) {
  if (!currentReports.length) return;
  if (!redacted && !confirmSensitiveExport('full stored cleanup history JSON', reportsAreStoredRedacted())) return;
  const output = await Promise.all(currentReports.map((report) => prepareReportForExport(report, { redacted })));
  downloadText(
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        redacted,
        reportCount: output.length,
        reports: output
      },
      null,
      2
    ),
    historyExportFilename({ redacted, extension: 'json' }),
    'application/json'
  );
}

async function exportHistoryText() {
  if (!currentReports.length) return;
  const reports = await Promise.all(currentReports.map((report) => prepareReportForExport(report, { redacted: true })));
  const lines = [
    'SiteWipe redacted cleanup history',
    '=================================',
    `Exported: ${new Date().toISOString()}`,
    `Reports: ${reports.length}`,
    ''
  ];
  for (const report of reports) {
    const s = report.summary || {};
    const confidence =
      s.cleanupConfidenceScore == null
        ? s.cleanupConfidenceLabel || 'N/A'
        : `${s.cleanupConfidenceLabel || 'N/A'} (${s.cleanupConfidenceScore}/100)`;
    lines.push(
      `${report.targetDomain || 'unknown'} · ${report.status || 'unknown'} · ${report.finishedAt || report.startedAt || 'unknown'}`
    );
    lines.push(
      `  Mode: ${s.cleanupMode === 'expert' ? 'expert' : 'standard'} cleanup · Approval: ${formatCleanupApprovalMode(s.cleanupApprovalMode)} · Verification evidence confidence: ${confidence} · Four-surface verification: ${formatVerificationStatus(s)} · Duration: ${formatDuration(s.totalDurationMs)} · Non-deduplicated operations: ${formatOperationEventCount(s)} · Known residue: ${formatKnownResidue(s)}`
    );
    lines.push(`  Checksum: ${report.integrity?.digest || 'N/A'}`);
    lines.push('');
  }
  downloadText(lines.join('\n'), historyExportFilename({ redacted: true, extension: 'txt' }), 'text/plain');
}

async function copyTroubleshootingSummary() {
  if (!currentReport) return;
  const report = await prepareReportForExport(currentReport, {
    redacted: true
  });
  const s = report.summary || {};
  const lines = [
    `SiteWipe ${report.appVersion || 'unknown'} redacted troubleshooting summary`,
    `Status: ${report.status}`,
    `Target: ${report.targetDomain}`,
    `Started: ${report.startedAt || 'unknown'}`,
    `Finished: ${report.finishedAt || 'unknown'}`,
    `Mode: ${s.cleanupMode === 'expert' ? 'expert' : 'standard'} cleanup`,
    `Approval: ${formatCleanupApprovalMode(s.cleanupApprovalMode)}`,
    `Target mode: ${findSectionDetail(report, 'targetDiagnostics', 'matchMode') || 'registrable_domain'}`,
    `Associated targets: ${s.associatedTargetsIncluded || findSectionDetail(report, 'targetDiagnostics', 'associatedTargetCount') || 0}`,
    `Non-deduplicated operation events: ${formatOperationEventCount(s)}`,
    `Verification evidence confidence: ${s.cleanupConfidenceScore == null ? s.cleanupConfidenceLabel || 'N/A' : `${s.cleanupConfidenceLabel || 'N/A'} (${s.cleanupConfidenceScore}/100)`}`,
    `Four-surface verification: ${formatVerificationStatus(s)}`,
    `Total duration: ${formatDuration(s.totalDurationMs)}`,
    `Slowest phase: ${s.slowestPhase || 'N/A'}`,
    `Known four-surface residue: ${formatKnownResidue(s)}`,
    `Tabs closed normal/incognito: ${s.normalTabsClosed || 0}/${s.incognitoTabsClosed || 0}`,
    `Cookies removed: ${s.cookiesRemoved || 0}`,
    `Origins discovered: ${s.discoveredOrigins || 0}`,
    `History removed: ${s.historyEntriesRemoved || 0}`,
    `Downloads erased: ${s.downloadHistoryEntriesRemoved || 0}`,
    `Four-surface residue C/T/H/D: ${[s.verificationCookiesRemaining, s.verificationTabsRemaining, s.verificationHistoryRemaining, s.verificationDownloadsRemaining].map(formatVerificationCount).join('/')}`,
    `Unavailable browser limits: ${getReportUnavailableCount(report)}`,
    `Runtime errors: ${getReportRuntimeErrorCount(report)}`,
    `Last phase timings: ${
      report.phaseTimings
        ? Object.entries(report.phaseTimings)
            .map(([key, value]) => `${key}=${value}ms`)
            .slice(-8)
            .join(', ')
        : 'none'
    }`
  ];
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
  } catch {
    const area = document.createElement('textarea');
    area.value = lines.join('\n');
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  announceStatus('Redacted troubleshooting summary copied.');
}

async function exportReportJson(redacted = false) {
  if (!currentReport) return;
  if (!redacted && !confirmSensitiveExport('full stored report JSON', Boolean(currentReport.redacted))) return;
  const output = await prepareReportForExport(currentReport, { redacted });
  const blob = new Blob([JSON.stringify(output, null, 2)], {
    type: 'application/json'
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = reportExportFilename(output, 'json');
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  announceStatus(
    redacted
      ? 'Redacted JSON report export started.'
      : currentReport.redacted
        ? 'Full stored JSON export started. This report was already stored redacted.'
        : 'Sensitive full JSON report export started.'
  );
}

async function exportReportHtml() {
  if (!currentReport) return;
  const report = await prepareReportForExport(currentReport, {
    redacted: true
  });
  const s = report.summary || {};
  const rows = [
    ['Target domain', report.targetDomain],
    ['Status', report.status],
    ['Mode', `${s.cleanupMode === 'expert' ? 'Expert' : 'Standard'} cleanup`],
    ['Approval', formatCleanupApprovalMode(s.cleanupApprovalMode)],
    ['Non-deduplicated operation events', formatOperationEventCount(s)],
    [
      'Verification evidence confidence',
      s.cleanupConfidenceScore == null
        ? s.cleanupConfidenceLabel || 'N/A'
        : `${s.cleanupConfidenceLabel || 'N/A'} (${s.cleanupConfidenceScore}/100)`
    ],
    ['Four-surface verification', formatVerificationStatus(s)],
    ['Total duration', formatDuration(s.totalDurationMs)],
    ['Slowest phase', s.slowestPhase || 'N/A'],
    ['Known four-surface residue', formatKnownResidue(s)],
    ['Report checksum', report.integrity?.digest || 'N/A'],
    ['Started', report.startedAt],
    ['Finished', report.finishedAt || 'N/A'],
    ['Associated targets included', s.associatedTargetsIncluded || 0],
    ['Runtime errors', getReportRuntimeErrorCount(report)],
    ['Unavailable browser limits', getReportUnavailableCount(report)]
  ];
  const sectionHtml = (report.sections || [])
    .map(
      (section) => `
    <section class="section ${escapeHtml(section.status || '')}">
      <h2>${escapeHtml(section.label || section.key || 'Section')}</h2>
      <p><strong>Status:</strong> ${escapeHtml(section.status || 'unknown')} · <strong>At:</strong> ${escapeHtml(section.at || '')}</p>
      <pre>${escapeHtml(JSON.stringify(section.details || {}, null, 2))}</pre>
    </section>`
    )
    .join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SiteWipe redacted report</title><style>
    body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:24px;line-height:1.45;color:#0f172a;background:#f8fafc}
    h1{margin:0 0 6px} .meta{color:#475569;margin:0 0 18px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px;margin:18px 0}
    .row,.section{background:white;border:1px solid #e2e8f0;border-radius:12px;padding:12px}.row span{display:block;color:#64748b;font-size:12px}.row strong{display:block;margin-top:4px}
    .section{margin:12px 0}.section h2{font-size:16px;margin:0 0 6px}.section.error{border-color:#fecaca}.section.partial{border-color:#fde68a}.section.success{border-color:#bbf7d0}.section.skipped{border-color:#cbd5e1}
    pre{white-space:pre-wrap;word-break:break-word;background:#0f172a;color:#e2e8f0;border-radius:10px;padding:12px;max-height:520px;overflow:auto}
  </style></head><body><h1>SiteWipe redacted report</h1><p class="meta">Generated locally from redacted extension data. No browser data is changed by this export.</p><div class="grid">${rows.map(([label, value]) => `<div class="row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value ?? ''))}</strong></div>`).join('')}</div>${sectionHtml}</body></html>`;
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = reportExportFilename(report, 'html');
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  announceStatus('Redacted HTML report export started.');
}

async function exportReportText() {
  if (!currentReport) return;
  if (!confirmSensitiveExport('full stored text report', Boolean(currentReport.redacted))) return;
  const report = await prepareReportForExport(currentReport, {
    redacted: false
  });
  const s = report.summary || {};
  const lines = [
    'SiteWipe report',
    '===============',
    `Target: ${report.targetDomain || 'unknown'}`,
    `Status: ${report.status || 'unknown'}`,
    `Mode: ${s.cleanupMode === 'expert' ? 'Expert' : 'Standard'} cleanup`,
    `Approval: ${formatCleanupApprovalMode(s.cleanupApprovalMode)}`,
    `Checksum: ${report.integrity?.digest || 'N/A'}`,
    `Started: ${report.startedAt || 'N/A'}`,
    `Finished: ${report.finishedAt || 'N/A'}`,
    '',
    'Summary',
    '-------',
    `Non-deduplicated operation events: ${formatOperationEventCount(s)}`,
    `Verification evidence confidence: ${s.cleanupConfidenceScore == null ? s.cleanupConfidenceLabel || 'N/A' : `${s.cleanupConfidenceLabel || 'N/A'} (${s.cleanupConfidenceScore}/100)`}`,
    `Four-surface verification: ${formatVerificationStatus(s)}`,
    `Total duration: ${formatDuration(s.totalDurationMs)}`,
    `Slowest phase: ${s.slowestPhase || 'N/A'}`,
    `Known four-surface residue: ${formatKnownResidue(s)}`,
    `Tabs closed normal/incognito: ${s.normalTabsClosed || 0}/${s.incognitoTabsClosed || 0}`,
    `Cookies removed: ${s.cookiesRemoved || 0}`,
    `History entries removed: ${s.historyEntriesRemoved || 0}`,
    `Download records erased: ${s.downloadHistoryEntriesRemoved || 0}`,
    `Unavailable browser limits: ${getReportUnavailableCount(report)}`,
    `Runtime errors: ${getReportRuntimeErrorCount(report)}`,
    '',
    'Sections',
    '--------'
  ];
  for (const section of report.sections || []) {
    lines.push(`[${section.status || 'unknown'}] ${section.label || section.key || 'Section'}`);
    lines.push(JSON.stringify(section.details || {}, null, 2));
    lines.push('');
  }
  downloadText(lines.join('\n'), reportExportFilename(report, 'txt'), 'text/plain');
}

async function exportRedactedReportText() {
  if (!currentReport) return;
  const report = await prepareReportForExport(currentReport, {
    redacted: true
  });
  const s = report.summary || {};
  const lines = [
    'SiteWipe redacted report',
    '========================',
    `Target: ${report.targetDomain || 'unknown'}`,
    `Status: ${report.status || 'unknown'}`,
    `Mode: ${s.cleanupMode === 'expert' ? 'Expert' : 'Standard'} cleanup`,
    `Approval: ${formatCleanupApprovalMode(s.cleanupApprovalMode)}`,
    `Checksum: ${report.integrity?.digest || 'N/A'}`,
    `Started: ${report.startedAt || 'N/A'}`,
    `Finished: ${report.finishedAt || 'N/A'}`,
    '',
    'Summary',
    '-------',
    `Non-deduplicated operation events: ${formatOperationEventCount(s)}`,
    `Verification evidence confidence: ${s.cleanupConfidenceScore == null ? s.cleanupConfidenceLabel || 'N/A' : `${s.cleanupConfidenceLabel || 'N/A'} (${s.cleanupConfidenceScore}/100)`}`,
    `Four-surface verification: ${formatVerificationStatus(s)}`,
    `Total duration: ${formatDuration(s.totalDurationMs)}`,
    `Slowest phase: ${s.slowestPhase || 'N/A'}`,
    `Known four-surface residue: ${formatKnownResidue(s)}`,
    `Tabs closed normal/incognito: ${s.normalTabsClosed || 0}/${s.incognitoTabsClosed || 0}`,
    `Cookies removed: ${s.cookiesRemoved || 0}`,
    `History entries removed: ${s.historyEntriesRemoved || 0}`,
    `Download records erased: ${s.downloadHistoryEntriesRemoved || 0}`,
    `Unavailable browser limits: ${getReportUnavailableCount(report)}`,
    `Runtime errors: ${getReportRuntimeErrorCount(report)}`,
    '',
    'Sections',
    '--------'
  ];
  for (const section of report.sections || []) {
    lines.push(`[${section.status || 'unknown'}] ${section.label || section.key || 'Section'}`);
    lines.push(JSON.stringify(section.details || {}, null, 2));
    lines.push('');
  }
  downloadText(lines.join('\n'), reportExportFilename(report, 'txt'), 'text/plain');
}

function downloadText(text, filename, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  announceStatus(`Export started: ${filename}`);
}

function reportExportFilename(report, extension) {
  return `${joinFilenameParts('sitewipe', 'report', safeFilename(report?.targetDomain || 'site'), Date.now())}.${extension}`;
}

function historyExportFilename({ redacted, extension }) {
  return `${joinFilenameParts('sitewipe', 'history', redacted ? 'redacted' : '', Date.now())}.${extension}`;
}

function joinFilenameParts(...parts) {
  return parts.map(safeFilename).filter(Boolean).join('-');
}

function safeFilename(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[^a-z0-9.-]+/gi, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80);
}

async function verifyReportDigest() {
  if (!currentReport) return;
  const expected = currentReport.integrity?.digest || '';
  const actual = await getReportIntegrityDigest(currentReport);
  const message = (await verifyReportIntegrity(currentReport))
    ? `Report checksum verified: ${actual}`
    : `Report checksum mismatch. Stored: ${expected || 'missing'} Recomputed: ${actual}`;
  announceStatus(message, message.includes('mismatch') ? 'error' : 'success');
}

function confirmSensitiveExport(kind, alreadyStoredRedacted = false) {
  const storedRedactionNote = alreadyStoredRedacted
    ? ' This report was stored redacted, so removed details cannot be restored; the export still preserves every remaining stored field.'
    : '';
  return confirm(
    `Export ${kind}?${storedRedactionNote} Full stored exports can contain browsing domains, URLs, filenames, local paths, and error details. Use a redacted export unless you have reviewed the destination and understand the privacy risk.`
  );
}

async function clearHistory() {
  if (
    !confirm(
      'Delete all stored cleanup-report history? The current report remains available until its separate retention timer expires or you choose Forget report. This cannot be undone.'
    )
  )
    return;
  const button = document.querySelector('#clearHistory');
  button.disabled = true;
  try {
    await sendMessage(MESSAGE_TYPES.clearHistory);
    await refreshBoundReport();
    announceStatus('Stored cleanup-report history deleted. The current report was preserved.', 'success');
  } catch (error) {
    announceStatus(`Report history could not be deleted: ${formatError(error)}`, 'error');
  } finally {
    button.disabled = false;
    (button.hidden ? document.querySelector('#historyTabButton') : button).focus();
  }
}

function formatError(error) {
  return error?.message || String(error || 'Unknown error');
}

function announceStatus(message, tone = 'info') {
  const status = document.querySelector('#panelStatus');
  status.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  status.setAttribute('aria-live', tone === 'error' ? 'assertive' : 'polite');
  status.className = `toast panel-status ${tone}`;
  status.hidden = false;
  status.textContent = '';
  requestAnimationFrame(() => {
    status.textContent = message;
  });
  clearTimeout(announceStatus.timer);
  announceStatus.timer = setTimeout(() => {
    status.hidden = true;
  }, 5000);
}

function filterEvents(events, filter) {
  if (!filter) return events || [];
  return (events || []).filter((event) =>
    JSON.stringify(event || {})
      .toLowerCase()
      .includes(filter)
  );
}

function renderEvents(events, empty, tone = '') {
  if (!events || !events.length) return `<div class="empty-state">${escapeHtml(empty)}</div>`;
  return events
    .map(
      (event) => `
    <div class="event-item ${escapeHtml(tone)}">
      <strong>${escapeHtml(event.label || event.key || event.message || 'Item')}</strong>
      <p>${escapeHtml(eventDetailText(event))}</p>
    </div>`
    )
    .join('');
}

function eventDetailText(event) {
  if (event.reason || event.message) return event.reason || event.message;
  const details = event.details || {};
  if (Array.isArray(details.origins)) {
    const preview = details.origins.slice(0, 8).join(', ');
    const extra = details.origins.length > 8 ? `, +${details.origins.length - 8} more` : '';
    return `${details.originCount || details.origins.length} origin(s): ${preview}${extra}`;
  }
  if (Array.isArray(details.attempted)) {
    return `${details.reset || details.attempted.length} content-setting operation(s) attempted.`;
  }
  if (Array.isArray(details.succeeded) || Array.isArray(details.failed)) {
    const succeeded = details.succeeded?.length || 0;
    const failed = details.failed?.length || 0;
    return `${succeeded} origin cleanup plan(s) succeeded, ${failed} failed. Protected web: ${details.protectedWebIncluded ? 'included' : 'not included'}.`;
  }
  if (event.key === 'pageScriptScrub') {
    return `Scrubbed ${details.framesMatched || 0} live frame(s): ${details.localStorageCleared || 0} localStorage key(s), ${details.sessionStorageCleared || 0} sessionStorage key(s), ${details.indexedDBDeleted || 0} IndexedDB database(s), ${details.cachesDeleted || 0} Cache API item(s), ${details.serviceWorkersUnregistered || 0} service worker(s), ${details.pushSubscriptionsUnsubscribed || 0} push subscription(s), ${details.backgroundSyncTagsObserved || 0} one-off sync tag(s) observed, ${details.periodicSyncTagsUnregistered || 0} periodic sync tag(s) removed, ${details.storageBucketsDeleted || 0} Storage Bucket(s), ${details.opfsEntriesDeleted || 0} OPFS item(s), ${details.appBadgeCleared || 0} app badge clear(s), ${details.cookiesExpired || 0} visible cookie name(s). Worlds: ${(details.worldsAttempted || []).join(', ') || 'none'}.`;
  }
  if (event.key === 'tabState') {
    return `Audited ${details.tabsAudited || 0} target tab(s): reset ${details.zoomReset || 0} zoom state(s), saw ${details.mutedTabs || 0} muted, ${details.pinnedTabs || 0} pinned, ${details.groupedTabs || 0} grouped, ${details.discardedTabs || 0} discarded, and ${details.frozenTabs || 0} frozen.`;
  }
  if (event.key === 'dnrShield' || event.key === 'dnrShieldFinal') {
    return details.note || `DNR rule ids: ${(details.ruleIds || []).join(', ')}`;
  }
  if (event.key === 'downloads') {
    return `${details.erased || 0} download-history record(s) erased; ${details.filesRemoved || 0} file(s) removed from disk; ${details.fileRemovalFailures?.length || 0} file-removal failure(s).`;
  }
  if (details.browserCookieSweep) {
    return `Manual cookie removals plus browser sweep: ${details.browserCookieSweep.ok ? 'succeeded' : 'partial/skipped'}.`;
  }
  return JSON.stringify(details);
}

function row(label, value) {
  return `<div class="report-row"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong></div>`;
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
  const minutes = Math.floor(value / 60000);
  const seconds = Math.round((value % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatStatusLabel(value) {
  const normalized = String(value || 'unknown')
    .replaceAll('_', ' ')
    .trim();
  return normalized ? `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}` : 'Unknown';
}

function formatVerificationCount(value) {
  return value !== null && Number.isFinite(Number(value)) ? String(Number(value)) : 'Unknown';
}

function formatDisplayCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? String(Math.floor(number)) : '0';
}

function formatOperationEventCount(summary) {
  const value = summary?.browserOperationEventCount;
  return value !== null && Number.isFinite(Number(value)) ? String(Math.floor(Number(value))) : 'Not available';
}

function formatCleanupApprovalMode(value) {
  if (value === 'settings_direct') return 'Settings direct cleanup';
  if (value === 'detailed_review') return 'Detailed review';
  if (value === 'quick') return 'Legacy unreviewed cleanup (retired)';
  return 'Unknown';
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return 'unknown';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${Math.round(value / (1024 * 1024))} MB`;
}
function statusClass(status) {
  if (status.includes('pending')) return 'partial';
  if (status.includes('fully')) return 'supported';
  if (status.includes('partial') || status.includes('optional')) return 'partial';
  if (status.includes('skipped')) return 'skipped';
  return 'unavailable';
}
function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
      })[char]
  );
}

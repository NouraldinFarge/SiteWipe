import { CLEANUP_MATRIX, MESSAGE_TYPES, STORAGE_KEYS } from '../shared/constants.js';
import { sendMessage, onceDomReady, onStorageChange } from '../shared/messaging.js';
import { prepareReportForExport } from '../shared/report-redaction.js';
import { getReportIntegrityDigest, verifyReportIntegrity } from '../shared/report-integrity.js';

let currentReport = null;
let currentReports = [];
const REPORT_STORAGE_KEYS = new Set([STORAGE_KEYS.settings, STORAGE_KEYS.reports, STORAGE_KEYS.activeReport]);
const refreshFromStorage = debounce(
  () => refresh().catch((error) => announceStatus(`Report refresh failed: ${formatError(error)}`, 'error')),
  80
);

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
  renderMatrix();
  await refresh();
  onStorageChange((changes, area) => {
    if (area !== 'local') return;
    if (Object.keys(changes || {}).some((key) => REPORT_STORAGE_KEYS.has(key))) refreshFromStorage();
  });
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

async function refresh() {
  const state = await sendMessage(MESSAGE_TYPES.getReportState);
  applySettings(state.settings);
  currentReport = state.report || null;
  currentReports = state.reports || [];
  renderReport(state.report);
  document.querySelector('#exportReport').disabled = !currentReport;
  document.querySelector('#exportRedactedReport').disabled = !currentReport;
  document.querySelector('#exportHtmlReport').disabled = !currentReport;
  document.querySelector('#exportTextReport').disabled = !currentReport;
  document.querySelector('#exportRedactedTextReport').disabled = !currentReport;
  document.querySelector('#copyTroubleshooting').disabled = !currentReport;
  document.querySelector('#verifyDigest').disabled = !currentReport;
  document.querySelector('#exportHistory').disabled = !currentReports.length;
  document.querySelector('#exportRedactedHistory').disabled = !currentReports.length;
  document.querySelector('#exportHistoryText').disabled = !currentReports.length;
  renderHistory(currentReports);
}

function applySettings(settings) {
  document.body.classList.toggle('reduced-motion', Boolean(settings?.reducedMotion));
  document.body.classList.toggle('high-contrast', Boolean(settings?.highContrast));
}

function renderReport(report) {
  const root = document.querySelector('#reportContainer');
  if (!report) {
    root.innerHTML = '<div class="empty-state">No cleanup report yet. Review and run a cleanup from the popup.</div>';
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
  const filterLabel = filter ? ` · filtered by “${escapeHtml(filter)}”` : '';
  root.innerHTML = `
    <article class="card panel-card">
      <div class="section-title"><span>Current report</span><small>${escapeHtml(report.finishedAt || report.startedAt)}</small></div>
      <div class="report-grid">
        ${row('Target domain', report.targetDomain)}
        ${row('Target mode', findSectionDetail(report, 'targetDiagnostics', 'matchMode') || 'registrable_domain')}
        ${row('Exact origin', findSectionDetail(report, 'targetDiagnostics', 'exactOrigin') || 'N/A')}
        ${row('Associated targets included', s.associatedTargetsIncluded || findSectionDetail(report, 'targetDiagnostics', 'associatedTargetCount') || 0)}
        ${row('Non-deduplicated operation events', formatOperationEventCount(s))}
        ${row('Verification evidence confidence', s.cleanupConfidenceScore == null ? s.cleanupConfidenceLabel || 'N/A' : `${s.cleanupConfidenceLabel || 'N/A'} (${s.cleanupConfidenceScore}/100)`)}
        ${row('Four-surface verification', formatVerificationStatus(s.verificationStatus))}
        ${row('Total duration', formatDuration(s.totalDurationMs))}
        ${row('Slowest phase', s.slowestPhase || 'N/A')}
        ${row('Status', report.status)}
        ${row('Report checksum', report.integrity?.digest || 'N/A')}
        ${row('Mode', `${s.cleanupMode === 'expert' ? 'Expert' : 'Standard'} cleanup`)}
        ${row('Private access available', report.incognitoAccess ? 'Yes' : 'No')}
        ${row('Normal tabs closed', s.normalTabsClosed || 0)}
        ${row('Private tabs closed', s.incognitoTabsClosed || 0)}
        ${row('Target tabs audited', s.targetTabsAudited || 0)}
        ${row('Site zoom states read', s.siteZoomStatesRead || 0)}
        ${row('Site zoom states reset', s.siteZoomStatesReset || 0)}
        ${row('Muted target tabs', s.mutedTargetTabs || 0)}
        ${row('Muted target tabs reset', s.mutedTargetTabsReset || 0)}
        ${row('Pinned target tabs', s.pinnedTargetTabs || 0)}
        ${row('Pinned target tabs reset', s.pinnedTargetTabsReset || 0)}
        ${row('Grouped target tabs', s.groupedTargetTabs || 0)}
        ${row('Discarded/frozen target tabs', String(s.discardedTargetTabs || 0) + '/' + String(s.frozenTargetTabs || 0))}
        ${row('Matching frames discovered', s.matchingFramesDiscovered || 0)}
        ${row('Live frames scrubbed', s.pageScriptFramesMatched || 0)}
        ${row('Page localStorage keys cleared', s.pageScriptLocalStorageCleared || 0)}
        ${row('Page sessionStorage keys cleared', s.pageScriptSessionStorageCleared || 0)}
        ${row('Page IndexedDB DBs deleted', s.pageScriptIndexedDBDeleted || 0)}
        ${row('Page Cache API entries deleted', s.pageScriptCachesDeleted || 0)}
        ${row('Page service workers unregistered', s.pageScriptServiceWorkersUnregistered || 0)}
        ${row('Push subscriptions unsubscribed', s.pageScriptPushSubscriptionsUnsubscribed || 0)}
        ${row('Background sync tags observed', s.pageScriptBackgroundSyncTagsObserved || 0)}
        ${row('Periodic sync tags removed', s.pageScriptPeriodicSyncTagsUnregistered || 0)}
        ${row('Page Storage Buckets deleted', s.pageScriptStorageBucketsDeleted || 0)}
        ${row('OPFS entries deleted', s.pageScriptOPFSEntriesDeleted || 0)}
        ${row('App badges cleared', s.pageScriptAppBadgeCleared || 0)}
        ${row('Persistent storage before', s.pageScriptPersistentStorageBefore == null ? 'Unknown' : s.pageScriptPersistentStorageBefore ? 'Yes' : 'No')}
        ${row('Storage estimate usage before/after', formatBytes(s.pageScriptStorageEstimateBeforeUsage) + '/' + formatBytes(s.pageScriptStorageEstimateAfterUsage))}
        ${row('Visible page cookies expired', s.pageScriptCookiesExpired || 0)}
        ${row('Page scrub worlds', s.pageScriptWorldsAttempted || 'None')}
        ${row('Cookies removed', s.cookiesRemoved || 0)}
        ${row('Discovered site origins', s.discoveredOrigins || 0)}
        ${row('Discovered cookie hosts', s.discoveredCookieHosts || 0)}
        ${row('Partition top-level sites probed', s.partitionTopLevelSitesProbed || 0)}
        ${row('Partitioned cookie attempts', s.partitionedCookiesAttempted || 0)}
        ${row('Partitioned cookies removed', s.partitionedCookiesRemoved || 0)}
        ${row('Browser cookie sweep', s.browserCookieSweepAttempted ? (s.browserCookieSweepSucceeded ? 'Succeeded' : 'Partial') : 'Skipped')}
        ${row('Storage cleanup attempted', s.storageCleanupAttempted ? 'Yes' : 'No')}
        ${row('Cache cleanup attempted', s.cacheCleanupAttempted ? 'Yes' : 'No')}
        ${row('Origin cleanup plans succeeded', s.originStorageTypesSucceeded || 0)}
        ${row('Origin cleanup plans failed', s.originStorageTypesFailed || 0)}
        ${row('Protected site data included', s.protectedWebCleanupAttempted ? 'Yes' : 'No')}
        ${row('Service workers cleared', s.serviceWorkersCleared ? 'Attempted' : 'No')}
        ${row('History entries removed', s.historyEntriesRemoved || 0)}
        ${row('Download history erased', s.downloadHistoryEntriesRemoved || 0)}
        ${row('Downloaded files removed', s.downloadedFilesRemoved || 0)}
        ${row('Downloaded-file removal failures', s.downloadedFileRemovalFailures || 0)}
        ${row('Autofill and payment methods', 'Protected (global form-data removal is never called)')}
        ${row('Browser permission rules', s.sitePermissionSettingsPreserved ? 'Preserved (manual in Chrome/Brave)' : 'Not reported')}
        ${row('Protected browser data', s.protectedBrowserDataGuardActive ? 'Passwords, bookmarks, and Sync protected' : 'Guard status unavailable')}
        ${row('Recovery preflight', s.extensionStatePreflightRan ? (s.extensionStateRepaired ? 'Repaired SiteWipe-owned state' : 'Healthy') : 'Not run')}
        ${row('Temporary request shield', s.temporaryDnrShieldInstalled ? (s.temporaryDnrShieldRemoved ? 'Used and removed' : s.postWipeSessionBlockKept ? 'Kept active' : 'Installed') : 'Skipped/failed')}
        ${row('Page progress overlay', s.progressOverlayEnabled ? String(s.progressOverlayTabsShown || 0) + ' shown / ' + String(s.progressOverlayTabsHidden || 0) + ' hidden' : 'Disabled')}
        ${row('Overlay cancel button', s.progressOverlayCancelButtonEnabled ? 'Enabled' : 'Disabled')}
        ${row('Progress overlay injection errors', s.progressOverlayInjectionErrors || 0)}
        ${row('Phase timing entries', report.phaseTimings ? Object.keys(report.phaseTimings).length : 0)}
        ${row('Four-surface residue C/T/H/D', [s.verificationCookiesRemaining, s.verificationTabsRemaining, s.verificationHistoryRemaining, s.verificationDownloadsRemaining].map(formatVerificationCount).join('/'))}
        ${row('Known four-surface residue total', formatVerificationCount(s.verificationRemainingTotal))}
        ${row('Host access mode', s.hostAccessMode || 'Preflight-bound target access')}
        ${row('Preflight-bound target access available', s.targetSiteAccessGranted || report.hostPermissionsGranted ? 'Yes' : 'No')}
      </div>
    </article>
    <article class="card panel-card">
      <div class="section-title"><span>Errors and skipped items</span><small>${report.errors?.length || 0} errors${filterLabel}</small></div>
      <div class="errors-list">
        ${renderEvents(filteredErrors, 'No runtime errors reported.')}
        ${renderEvents(filteredSkipped, 'No skipped safety categories reported.')}
        ${renderEvents(filteredUnavailable, 'No unavailable categories reported.')}
      </div>
    </article>
    <article class="card panel-card">
      <div class="section-title"><span>Execution details</span><small>${filteredSections.length}/${report.sections?.length || 0} steps${filterLabel}</small></div>
      <div class="errors-list">${renderEvents(filteredSections, 'No execution sections yet.')}</div>
    </article>`;
}

function renderMatrix() {
  const root = document.querySelector('#matrixContainer');
  root.innerHTML = `
    <div class="matrix-row header-row"><span>Data type</span><span>API used</span><span>Targeted by domain?</span><span>Incognito?</span><span>Status</span></div>
    ${CLEANUP_MATRIX.map(
      (item) => `
      <div class="matrix-row">
        <span>${escapeHtml(item.type)}</span>
        <span class="mono">${escapeHtml(item.api)}</span>
        <span>${escapeHtml(item.targeted)}</span>
        <span>${escapeHtml(item.incognito)}</span>
        <span class="status-pill ${statusClass(item.status)}">${escapeHtml(item.status)}</span>
      </div>
    `
    ).join('')}`;
}

function renderHistory(reports) {
  const root = document.querySelector('#historyContainer');
  const filter = String(document.querySelector('#historyFilter')?.value || '')
    .trim()
    .toLowerCase();
  const items = filterEvents(reports || [], filter);
  if (!items.length) {
    root.innerHTML = filter
      ? '<div class="empty-state">No local cleanup history matched the filter.</div>'
      : '<div class="empty-state">No local cleanup history stored.</div>';
    return;
  }
  const completeVerificationReports = items.filter((report) =>
    ['verified_zero', 'residue_found'].includes(report.summary?.verificationStatus)
  );
  const incompleteVerificationReports = items.length - completeVerificationReports.length;
  const knownResidue = completeVerificationReports.reduce(
    (sum, report) => sum + (Number(report.summary?.verificationRemainingTotal) || 0),
    0
  );
  const header = `<div class="event-item"><strong>${items.length} report(s) shown</strong><p>${knownResidue} known cookie/tab/history/download-record residue item(s) across ${completeVerificationReports.length} complete four-surface verification report(s) · ${incompleteVerificationReports} report(s) incomplete or unknown${filter ? ` · filtered by “${escapeHtml(filter)}”` : ''}</p></div>`;
  root.innerHTML =
    header +
    items
      .map((report) => {
        const s = report.summary || {};
        const confidence =
          s.cleanupConfidenceScore == null
            ? s.cleanupConfidenceLabel || 'N/A'
            : `${s.cleanupConfidenceLabel || 'N/A'} (${s.cleanupConfidenceScore}/100)`;
        return `
    <div class="event-item">
      <strong>${escapeHtml(report.targetDomain)}</strong>
      <p>${escapeHtml(report.finishedAt || report.startedAt)} · ${escapeHtml(report.status)} · confidence ${escapeHtml(confidence)} · four-surface verification ${escapeHtml(formatVerificationStatus(s.verificationStatus))} · duration ${escapeHtml(formatDuration(s.totalDurationMs))} · non-deduplicated operations ${escapeHtml(formatOperationEventCount(s))} · known residue ${escapeHtml(formatVerificationCount(s.verificationRemainingTotal))} · origins ${formatDisplayCount(s.discoveredOrigins)} · frames ${formatDisplayCount(s.pageScriptFramesMatched)} · cookies ${formatDisplayCount(s.cookiesRemoved)} · associated ${formatDisplayCount(s.associatedTargetsIncluded)} · history ${formatDisplayCount(s.historyEntriesRemoved)}</p>
    </div>`;
      })
      .join('');
}

async function exportHistoryJson(redacted = false) {
  if (!currentReports.length) return;
  if (!redacted && !confirmSensitiveExport('full cleanup history JSON')) return;
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
    `sitewipe-history-${redacted ? 'redacted-' : ''}${Date.now()}.json`,
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
      `  Mode: ${s.cleanupMode === 'expert' ? 'expert' : 'standard'} cleanup · Verification evidence confidence: ${confidence} · Four-surface verification: ${formatVerificationStatus(s.verificationStatus)} · Duration: ${formatDuration(s.totalDurationMs)} · Non-deduplicated operations: ${formatOperationEventCount(s)} · Known residue: ${formatVerificationCount(s.verificationRemainingTotal)}`
    );
    lines.push(`  Checksum: ${report.integrity?.digest || 'N/A'}`);
    lines.push('');
  }
  downloadText(lines.join('\n'), `sitewipe-history-${Date.now()}.txt`, 'text/plain');
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
    `Target mode: ${findSectionDetail(report, 'targetDiagnostics', 'matchMode') || 'registrable_domain'}`,
    `Associated targets: ${s.associatedTargetsIncluded || findSectionDetail(report, 'targetDiagnostics', 'associatedTargetCount') || 0}`,
    `Non-deduplicated operation events: ${formatOperationEventCount(s)}`,
    `Verification evidence confidence: ${s.cleanupConfidenceScore == null ? s.cleanupConfidenceLabel || 'N/A' : `${s.cleanupConfidenceLabel || 'N/A'} (${s.cleanupConfidenceScore}/100)`}`,
    `Four-surface verification: ${formatVerificationStatus(s.verificationStatus)}`,
    `Total duration: ${formatDuration(s.totalDurationMs)}`,
    `Slowest phase: ${s.slowestPhase || 'N/A'}`,
    `Known four-surface residue total: ${formatVerificationCount(s.verificationRemainingTotal)}`,
    `Tabs closed normal/incognito: ${s.normalTabsClosed || 0}/${s.incognitoTabsClosed || 0}`,
    `Cookies removed: ${s.cookiesRemoved || 0}`,
    `Origins discovered: ${s.discoveredOrigins || 0}`,
    `History removed: ${s.historyEntriesRemoved || 0}`,
    `Downloads erased: ${s.downloadHistoryEntriesRemoved || 0}`,
    `Four-surface residue C/T/H/D: ${[s.verificationCookiesRemaining, s.verificationTabsRemaining, s.verificationHistoryRemaining, s.verificationDownloadsRemaining].map(formatVerificationCount).join('/')}`,
    `Warnings/errors: ${(report.unavailable || []).length}/${(report.errors || []).length}`,
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
  if (!redacted && !confirmSensitiveExport('full report JSON')) return;
  const output = await prepareReportForExport(currentReport, { redacted });
  const safeDomain =
    String(output.targetDomain || currentReport.targetDomain || 'site')
      .replace(/[^a-z0-9.-]+/gi, '-')
      .slice(0, 80) || 'site';
  const blob = new Blob([JSON.stringify(output, null, 2)], {
    type: 'application/json'
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `sitewipe-report-${redacted ? 'redacted-' : ''}${safeDomain}-${Date.now()}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  announceStatus(`${redacted ? 'Redacted' : 'Sensitive full'} JSON report export started.`);
}

async function exportReportHtml() {
  if (!currentReport) return;
  const report = await prepareReportForExport(currentReport, {
    redacted: true
  });
  const s = report.summary || {};
  const safeDomain = safeFilename(report.targetDomain || 'site');
  const rows = [
    ['Target domain', report.targetDomain],
    ['Status', report.status],
    ['Mode', `${s.cleanupMode === 'expert' ? 'Expert' : 'Standard'} cleanup`],
    ['Non-deduplicated operation events', formatOperationEventCount(s)],
    [
      'Verification evidence confidence',
      s.cleanupConfidenceScore == null
        ? s.cleanupConfidenceLabel || 'N/A'
        : `${s.cleanupConfidenceLabel || 'N/A'} (${s.cleanupConfidenceScore}/100)`
    ],
    ['Four-surface verification', formatVerificationStatus(s.verificationStatus)],
    ['Total duration', formatDuration(s.totalDurationMs)],
    ['Slowest phase', s.slowestPhase || 'N/A'],
    ['Known four-surface residue total', formatVerificationCount(s.verificationRemainingTotal)],
    ['Report checksum', report.integrity?.digest || 'N/A'],
    ['Started', report.startedAt],
    ['Finished', report.finishedAt || 'N/A'],
    ['Associated targets included', s.associatedTargetsIncluded || 0],
    ['Errors', (report.errors || []).length],
    ['Manual/unavailable notes', (report.unavailable || []).length]
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
  a.download = `sitewipe-report-${safeDomain}-${Date.now()}.html`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  announceStatus('Redacted HTML report export started.');
}

async function exportReportText() {
  if (!currentReport) return;
  if (!confirmSensitiveExport('full text report')) return;
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
    `Checksum: ${report.integrity?.digest || 'N/A'}`,
    `Started: ${report.startedAt || 'N/A'}`,
    `Finished: ${report.finishedAt || 'N/A'}`,
    '',
    'Summary',
    '-------',
    `Non-deduplicated operation events: ${formatOperationEventCount(s)}`,
    `Verification evidence confidence: ${s.cleanupConfidenceScore == null ? s.cleanupConfidenceLabel || 'N/A' : `${s.cleanupConfidenceLabel || 'N/A'} (${s.cleanupConfidenceScore}/100)`}`,
    `Four-surface verification: ${formatVerificationStatus(s.verificationStatus)}`,
    `Total duration: ${formatDuration(s.totalDurationMs)}`,
    `Slowest phase: ${s.slowestPhase || 'N/A'}`,
    `Known four-surface residue total: ${formatVerificationCount(s.verificationRemainingTotal)}`,
    `Tabs closed normal/incognito: ${s.normalTabsClosed || 0}/${s.incognitoTabsClosed || 0}`,
    `Cookies removed: ${s.cookiesRemoved || 0}`,
    `History entries removed: ${s.historyEntriesRemoved || 0}`,
    `Download records erased: ${s.downloadHistoryEntriesRemoved || 0}`,
    `Warnings/errors: ${(report.unavailable || []).length}/${(report.errors || []).length}`,
    '',
    'Sections',
    '--------'
  ];
  for (const section of report.sections || []) {
    lines.push(`[${section.status || 'unknown'}] ${section.label || section.key || 'Section'}`);
    lines.push(JSON.stringify(section.details || {}, null, 2));
    lines.push('');
  }
  downloadText(
    lines.join('\n'),
    `sitewipe-report-${safeFilename(report.targetDomain || 'site')}-${Date.now()}.txt`,
    'text/plain'
  );
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
    `Checksum: ${report.integrity?.digest || 'N/A'}`,
    `Started: ${report.startedAt || 'N/A'}`,
    `Finished: ${report.finishedAt || 'N/A'}`,
    '',
    'Summary',
    '-------',
    `Non-deduplicated operation events: ${formatOperationEventCount(s)}`,
    `Verification evidence confidence: ${s.cleanupConfidenceScore == null ? s.cleanupConfidenceLabel || 'N/A' : `${s.cleanupConfidenceLabel || 'N/A'} (${s.cleanupConfidenceScore}/100)`}`,
    `Four-surface verification: ${formatVerificationStatus(s.verificationStatus)}`,
    `Total duration: ${formatDuration(s.totalDurationMs)}`,
    `Slowest phase: ${s.slowestPhase || 'N/A'}`,
    `Known four-surface residue total: ${formatVerificationCount(s.verificationRemainingTotal)}`,
    `Tabs closed normal/incognito: ${s.normalTabsClosed || 0}/${s.incognitoTabsClosed || 0}`,
    `Cookies removed: ${s.cookiesRemoved || 0}`,
    `History entries removed: ${s.historyEntriesRemoved || 0}`,
    `Download records erased: ${s.downloadHistoryEntriesRemoved || 0}`,
    `Warnings/errors: ${(report.unavailable || []).length}/${(report.errors || []).length}`,
    '',
    'Sections',
    '--------'
  ];
  for (const section of report.sections || []) {
    lines.push(`[${section.status || 'unknown'}] ${section.label || section.key || 'Section'}`);
    lines.push(JSON.stringify(section.details || {}, null, 2));
    lines.push('');
  }
  downloadText(
    lines.join('\n'),
    `sitewipe-report-redacted-${safeFilename(report.targetDomain || 'site')}-${Date.now()}.txt`,
    'text/plain'
  );
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

function safeFilename(value) {
  return (
    String(value || 'site')
      .replace(/[^a-z0-9.-]+/gi, '-')
      .slice(0, 80) || 'site'
  );
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

function confirmSensitiveExport(kind) {
  return confirm(
    `Export ${kind}? It may contain browsing domains, URLs, filenames, local paths, and error details. Use a redacted export unless you have reviewed the destination and understand the privacy risk.`
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
    await refresh();
    announceStatus('Stored cleanup-report history deleted. The current report was preserved.', 'success');
  } catch (error) {
    announceStatus(`Report history could not be deleted: ${formatError(error)}`, 'error');
  } finally {
    button.disabled = false;
    button.focus();
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

function renderEvents(events, empty) {
  if (!events || !events.length) return `<div class="empty-state">${escapeHtml(empty)}</div>`;
  return events
    .map(
      (event) => `
    <div class="event-item">
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

function formatVerificationStatus(value) {
  return String(value || 'unknown').replaceAll('_', ' ');
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

function formatBytes(value) {
  if (!Number.isFinite(value)) return 'unknown';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${Math.round(value / (1024 * 1024))} MB`;
}
function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
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

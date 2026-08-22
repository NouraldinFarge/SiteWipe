import { tabMatchesReviewedCleanupTarget } from '../shared/target-scope.js';
import { addError, addSection, addUnavailable, createAdapterOutcome } from './report.js';
import {
  mapWithConcurrency,
  readableMessage,
  sleep,
  throwIfCancellationRequested,
  withTimeoutReject,
  yieldEvery
} from './operation-control.js';

const MAX_TAB_STATE_AUDIT_TABS = 100;
const TAB_STATE_CONCURRENCY = 6;
const TAB_REMOVE_TIMEOUT_MS = 15_000;
const OPERATION_YIELD_EVERY = 10;
const REPORT_SAMPLE_LIMIT = 50;

export async function auditAndResetTabState(target, report, context, options = {}) {
  const candidates = (Array.isArray(context?.matchingTabs) ? context.matchingTabs : [])
    .filter((tab) => Number.isInteger(tab.id))
    .slice(0, MAX_TAB_STATE_AUDIT_TABS);
  if (!candidates.length) {
    addSection(report, 'tabState', 'No open target tab UI state to audit', 'skipped', {
      reason: 'No open target tabs were discovered.'
    });
    return;
  }
  if (!chrome.tabs) {
    addUnavailable(
      report,
      'Target tab UI state',
      'chrome.tabs is unavailable, so zoom, mute, pin, group, opener, and window state cannot be audited.'
    );
    return;
  }
  if (typeof chrome.tabs.get !== 'function') {
    addUnavailable(
      report,
      'Target tab UI state',
      'chrome.tabs.get is unavailable, so SiteWipe refused to mutate tab state without live target revalidation.'
    );
    return;
  }

  const revalidationResults = await mapWithConcurrency(candidates, TAB_STATE_CONCURRENCY, async (candidate, index) => {
    await yieldEvery(index, OPERATION_YIELD_EVERY);
    await throwIfCancellationRequested(options.shouldCancel, 'the next tab-state operation');
    options.operationBudget?.claimQuery('tab-state revalidation');
    try {
      const current = await chrome.tabs.get(candidate.id);
      return tabMatchesReviewedCleanupTarget(current, target, options.incognitoAccess === true) ? current : null;
    } catch {
      return null;
    }
  });
  const matching = revalidationResults.filter(Boolean);
  const skippedAfterRevalidation = candidates.length - matching.length;
  if (!matching.length) {
    addSection(report, 'tabState', 'No live target tab UI state to mutate', 'skipped', {
      discoveredCandidates: candidates.length,
      skippedAfterRevalidation,
      reason: 'Every discovered candidate closed, became unavailable, or no longer matched before tab-state mutation.'
    });
    return;
  }

  const totals = {
    tabsAudited: 0,
    zoomRead: 0,
    zoomReset: 0,
    mutedTabs: 0,
    mutedReset: 0,
    pinnedTabs: 0,
    pinnedReset: 0,
    groupedTabs: 0,
    discardedTabs: 0,
    frozenTabs: 0,
    openerTabs: 0,
    splitViewTabs: 0,
    faviconUrls: 0,
    samples: [],
    errors: []
  };

  await mapWithConcurrency(matching, TAB_STATE_CONCURRENCY, async (tab, index) => {
    await yieldEvery(index, OPERATION_YIELD_EVERY);
    const sample = {
      url: tab.url || '',
      incognito: Boolean(tab.incognito),
      pinned: Boolean(tab.pinned),
      muted: Boolean(tab.mutedInfo?.muted),
      groupId: Number.isInteger(tab.groupId) ? tab.groupId : -1,
      discarded: Boolean(tab.discarded),
      frozen: Boolean(tab.frozen),
      openerTabId: Number.isInteger(tab.openerTabId) ? tab.openerTabId : null,
      // Chrome uses -1 (tabs.SPLIT_VIEW_ID_NONE) when the tab is not in a
      // split view. Keep only real, non-negative split-view identities so the
      // report does not turn that sentinel into a positive count.
      splitViewId: Number.isInteger(tab.splitViewId) && tab.splitViewId >= 0 ? tab.splitViewId : null,
      windowId: tab.windowId,
      windowType: '',
      favIconUrlPresent: Boolean(tab.favIconUrl),
      zoomBefore: null,
      zoomScope: '',
      zoomMode: '',
      actions: []
    };
    totals.tabsAudited += 1;
    if (sample.muted) totals.mutedTabs += 1;
    if (sample.pinned) totals.pinnedTabs += 1;
    if (sample.groupId >= 0) totals.groupedTabs += 1;
    if (sample.discarded) totals.discardedTabs += 1;
    if (sample.frozen) totals.frozenTabs += 1;
    if (sample.openerTabId != null) totals.openerTabs += 1;
    if (sample.splitViewId != null) totals.splitViewTabs += 1;
    if (sample.favIconUrlPresent) totals.faviconUrls += 1;

    options.operationBudget?.claimQuery('tab zoom inspection');
    try {
      const zoom = await chrome.tabs.getZoom(tab.id);
      let zoomSettings = null;
      if (chrome.tabs.getZoomSettings) {
        options.operationBudget?.claimQuery('tab zoom-settings inspection');
        zoomSettings = await chrome.tabs.getZoomSettings(tab.id);
      }
      sample.zoomBefore = zoom;
      sample.zoomScope = zoomSettings?.scope || '';
      sample.zoomMode = zoomSettings?.mode || '';
      totals.zoomRead += 1;
      if (options.resetZoom === true && zoom !== 1) {
        options.operationBudget?.claimQuery('tab zoom revalidation');
        const liveTab = await getLiveMatchingTab(tab.id, target, options.incognitoAccess);
        if (liveTab) {
          options.operationBudget?.check('tab zoom reset');
          await chrome.tabs.setZoom(tab.id, 0);
          sample.actions.push('zoom-reset-to-default');
          totals.zoomReset += 1;
        } else {
          sample.actions.push('zoom-skipped-after-navigation');
        }
      }
    } catch (error) {
      rethrowControlError(error);
      totals.errors.push({
        tabId: tab.id,
        action: 'zoom',
        message: readableMessage(error)
      });
    }

    if (options.resetMutedTabs === true && sample.muted) {
      options.operationBudget?.claimQuery('tab mute revalidation');
      try {
        const liveTab = await getLiveMatchingTab(tab.id, target, options.incognitoAccess);
        if (liveTab) {
          options.operationBudget?.check('tab mute reset');
          await chrome.tabs.update(tab.id, { muted: false });
          sample.actions.push('unmuted');
          totals.mutedReset += 1;
        } else {
          sample.actions.push('unmute-skipped-after-navigation');
        }
      } catch (error) {
        rethrowControlError(error);
        totals.errors.push({
          tabId: tab.id,
          action: 'unmute',
          message: readableMessage(error)
        });
      }
    }

    if (options.unpinTargetTabs === true && sample.pinned) {
      options.operationBudget?.claimQuery('tab pin revalidation');
      try {
        const liveTab = await getLiveMatchingTab(tab.id, target, options.incognitoAccess);
        if (liveTab) {
          options.operationBudget?.check('tab pin reset');
          await chrome.tabs.update(tab.id, { pinned: false });
          sample.actions.push('unpinned');
          totals.pinnedReset += 1;
        } else {
          sample.actions.push('unpin-skipped-after-navigation');
        }
      } catch (error) {
        rethrowControlError(error);
        totals.errors.push({
          tabId: tab.id,
          action: 'unpin',
          message: readableMessage(error)
        });
      }
    }

    try {
      if (chrome.windows?.get && Number.isInteger(tab.windowId)) {
        options.operationBudget?.claimQuery('tab window inspection');
        const win = await chrome.windows.get(tab.windowId);
        sample.windowType = win?.type || '';
      }
    } catch (error) {
      rethrowControlError(error);
      // Window type is best-effort reporting only.
    }

    if (totals.samples.length < REPORT_SAMPLE_LIMIT) totals.samples.push(sample);
  });

  report.summary.targetTabsAudited = totals.tabsAudited;
  report.summary.siteZoomStatesRead = totals.zoomRead;
  report.summary.siteZoomStatesReset = totals.zoomReset;
  report.summary.mutedTargetTabs = totals.mutedTabs;
  report.summary.mutedTargetTabsReset = totals.mutedReset;
  report.summary.pinnedTargetTabs = totals.pinnedTabs;
  report.summary.pinnedTargetTabsReset = totals.pinnedReset;
  report.summary.groupedTargetTabs = totals.groupedTabs;
  report.summary.discardedTargetTabs = totals.discardedTabs;
  report.summary.frozenTargetTabs = totals.frozenTabs;
  report.summary.targetTabsWithOpener = totals.openerTabs;
  report.summary.targetTabsInSplitView = totals.splitViewTabs;
  report.summary.targetTabsWithFavicon = totals.faviconUrls;

  addSection(
    report,
    'tabState',
    'Target tab UI state audited and normalized',
    totals.errors.length ? 'partial' : 'success',
    {
      ...totals,
      resetZoomEnabled: options.resetZoom === true,
      resetMutedTabsEnabled: Boolean(options.resetMutedTabs),
      unpinTargetTabsEnabled: Boolean(options.unpinTargetTabs),
      note: 'Audits small browser UI residues for open target tabs, including site zoom, tab mute/pin, groups, discarded/frozen state, opener relationship, split view, popup/app window type, and favicon presence. Zoom is reset by default. Mute and pin changes are opt-in because they may be intentional user choices.',
      discoveredCandidates: candidates.length,
      skippedAfterRevalidation
    }
  );
}

export async function closeMatchingTabs(target, report, incognitoAccess, context, options = {}) {
  let matching;
  try {
    if (context?.matchingTabs) matching = context.matchingTabs;
    else {
      await throwIfCancellationRequested(options.shouldCancel, 'target-tab discovery');
      options.operationBudget?.claimQuery('target-tab discovery');
      const tabs = await chrome.tabs.query({});
      options.operationBudget?.observeRecords(tabs?.length || 0, 'target-tab discovery results');
      matching = tabs.filter((tab) => tab.id && tabMatchesReviewedCleanupTarget(tab, target, incognitoAccess === true));
    }
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'OperationBudgetExceededError') throw error;
    addError(report, 'Find matching tabs to close', error);
    return;
  }

  if (typeof chrome.tabs?.get !== 'function') {
    addUnavailable(
      report,
      'Close matching tabs',
      'chrome.tabs.get is unavailable, so SiteWipe refused to close tabs without live target revalidation.'
    );
    return;
  }

  const candidates = matching.filter((tab) => Number.isInteger(tab.id));
  let normalClosed = 0;
  let incognitoClosed = 0;
  const failures = [];
  const timeouts = [];
  let skippedAfterRevalidation = 0;
  const removeTimeoutMs = Math.max(1, Number(options.tabRemoveTimeoutMs) || TAB_REMOVE_TIMEOUT_MS);
  const closeResults = await mapWithConcurrency(candidates, TAB_STATE_CONCURRENCY, async (candidate, index) => {
    await yieldEvery(index, OPERATION_YIELD_EVERY);
    await throwIfCancellationRequested(options.shouldCancel, 'the next target-tab closure');
    options.operationBudget?.claimQuery('target-tab close revalidation');
    try {
      const current = await getLiveMatchingTab(candidate.id, target, incognitoAccess);
      if (!current) return { closed: false, skipped: true, incognito: false };
      options.operationBudget?.check('target-tab closure');
      await withTimeoutReject(chrome.tabs.remove(candidate.id), removeTimeoutMs, 'tabs.remove');
      return { closed: true, skipped: false, timedOut: false, incognito: Boolean(current.incognito) };
    } catch (error) {
      if (error?.name === 'AbortError' || error?.name === 'OperationBudgetExceededError') throw error;
      if (error?.name === 'OperationTimeoutError') {
        timeouts.push({ tabId: candidate.id, message: readableMessage(error) });
        return { closed: false, skipped: false, timedOut: true, incognito: false };
      }
      failures.push({ tabId: candidate.id, message: readableMessage(error) });
      addError(report, `Close matching tab ${candidate.id}`, error);
      return { closed: false, skipped: false, timedOut: false, incognito: false };
    }
  });
  for (const result of closeResults) {
    if (result?.skipped) skippedAfterRevalidation += 1;
    if (!result?.closed) continue;
    if (result.incognito) incognitoClosed += 1;
    else normalClosed += 1;
  }
  await sleep(0);
  report.summary.normalTabsClosed = normalClosed;
  report.summary.incognitoTabsClosed = incognitoClosed;
  addSection(report, 'tabs', 'Matching tabs closed', failures.length || timeouts.length ? 'partial' : 'success', {
    normal: normalClosed,
    incognito: incognitoClosed,
    attempted: candidates.length - skippedAfterRevalidation,
    discoveredCandidates: candidates.length,
    skippedAfterRevalidation,
    failures: failures.slice(0, 10),
    timeouts: timeouts.slice(0, 10),
    removeTimeoutMs,
    outcome: createAdapterOutcome({
      attempted: candidates.length - skippedAfterRevalidation,
      succeeded: normalClosed + incognitoClosed,
      failed: failures.length,
      timedOut: timeouts.length,
      unknown: timeouts.length,
      skipped: skippedAfterRevalidation
    }),
    incognitoAccess,
    note: 'Each discovered tab was re-read and matched against the approved target and reviewed private-window scope immediately before individual closure. A close timeout remains an unknown outcome because Chrome may finish it later.'
  });
}

async function getLiveMatchingTab(tabId, target, incognitoAccess = false) {
  try {
    const current = await chrome.tabs.get(tabId);
    return tabMatchesReviewedCleanupTarget(current, target, incognitoAccess === true) ? current : null;
  } catch {
    return null;
  }
}

function rethrowControlError(error) {
  if (error?.name === 'AbortError' || error?.name === 'OperationBudgetExceededError') throw error;
}

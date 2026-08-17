import { urlMatchesTarget } from './domain.js';
import { mapWithConcurrency, readableMessage } from './operation-control.js';
import { addSection } from './report.js';

const MAX_PROGRESS_OVERLAY_TABS = 120;
const PROGRESS_OVERLAY_CONCURRENCY = 8;
const OVERLAY_MESSAGE_TYPE = 'sitewipe.progressOverlay.render.v1';

export function createCleanupProgressOverlay(target, report, options = {}) {
  const enabled = options.progressOverlay === true && Boolean(chrome.tabs && chrome.scripting?.executeScript);
  const scope = normalizeOverlayScope(options.overlayScope);
  const channelId = createOverlayChannelId();
  const stats = {
    enabled,
    scope,
    updatesAttempted: 0,
    showUpdates: 0,
    hideUpdates: 0,
    tabsConsidered: 0,
    tabsShown: 0,
    tabsHidden: 0,
    tabsSkipped: 0,
    injectionErrors: 0,
    lastPercent: 0,
    lastLabel: '',
    cancelButtonEnabled: options.progressOverlayCancelButton === true,
    directInjections: 0,
    receiverUpdates: 0,
    sampleErrors: []
  };
  const visibleTabIds = new Set();
  let cachedTabIds = null;
  let lastPayloadKey = '';

  async function render(action, percent, label, detail) {
    if (!enabled) return;
    const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));
    const payload = {
      action,
      percent: safePercent,
      label: String(label || ''),
      detail: String(detail || ''),
      domain: target.domain,
      at: Date.now(),
      watchdogMs: 15_000,
      cancelEnabled: options.progressOverlayCancelButton === true,
      channelId
    };
    const payloadKey = `${action}:${safePercent}:${payload.label}:${payload.detail}`;
    if (payloadKey === lastPayloadKey && action !== 'hide') return;
    lastPayloadKey = payloadKey;

    stats.updatesAttempted += 1;
    if (action === 'hide') stats.hideUpdates += 1;
    else stats.showUpdates += 1;
    stats.lastPercent = safePercent;
    stats.lastLabel = payload.label;

    let tabs;
    try {
      if (action === 'hide' && visibleTabIds.size) {
        tabs = [...visibleTabIds].map((id) => ({ id }));
      } else if (scope !== 'target_tabs' && cachedTabIds && stats.showUpdates > 1 && stats.showUpdates % 4 !== 1) {
        tabs = [...cachedTabIds].map((id) => ({ id }));
      } else {
        const queryInfo =
          scope === 'current_window'
            ? Number.isInteger(options.sourceWindowId)
              ? { windowId: options.sourceWindowId }
              : { currentWindow: true }
            : {};
        const queried = await chrome.tabs.query(queryInfo);
        const candidates = queried
          .filter((tab) => isProgressOverlayInjectableTab(tab, options.incognitoAccess))
          .filter((tab) => overlayScopeAllowsTab(tab, target, scope));
        const capped = candidates.slice(0, MAX_PROGRESS_OVERLAY_TABS);
        cachedTabIds = new Set(capped.map((tab) => tab.id).filter((id) => Number.isInteger(id)));
        tabs = capped;
        stats.tabsConsidered += queried.length;
        stats.tabsSkipped +=
          Math.max(0, queried.length - candidates.length) + Math.max(0, candidates.length - capped.length);
      }
    } catch (error) {
      stats.injectionErrors += 1;
      if (stats.sampleErrors.length < 12) {
        stats.sampleErrors.push({
          action: 'query-tabs',
          message: readableMessage(error)
        });
      }
      return;
    }

    let shownThisRound = 0;
    let hiddenThisRound = 0;
    await mapWithConcurrency(tabs, PROGRESS_OVERLAY_CONCURRENCY, async (tab) => {
      if (!Number.isInteger(tab.id)) return;
      try {
        if (scope === 'target_tabs') {
          const liveTab = await chrome.tabs.get(tab.id);
          if (!liveTab?.url || !urlMatchesTarget(liveTab.url, target)) {
            stats.tabsSkipped += 1;
            visibleTabIds.delete(tab.id);
            return;
          }
        }
        let deliveredToReceiver = false;
        if (visibleTabIds.has(tab.id) && chrome.tabs.sendMessage) {
          try {
            await chrome.tabs.sendMessage(tab.id, {
              protocolVersion: 1,
              type: OVERLAY_MESSAGE_TYPE,
              channelId,
              payload
            });
            deliveredToReceiver = true;
            stats.receiverUpdates += 1;
          } catch {
            // A navigation removes the isolated-world receiver. Reinstall it below.
          }
        }
        if (!deliveredToReceiver) {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'ISOLATED',
            func: renderSiteWipeProgressOverlay,
            args: [payload]
          });
          stats.directInjections += 1;
        }
        if (action === 'hide') {
          hiddenThisRound += 1;
          visibleTabIds.delete(tab.id);
        } else {
          shownThisRound += 1;
          visibleTabIds.add(tab.id);
        }
      } catch (error) {
        stats.injectionErrors += 1;
        visibleTabIds.delete(tab.id);
        if (stats.sampleErrors.length < 12) {
          stats.sampleErrors.push({
            action,
            tabId: tab.id,
            url: redactUrlForReport(tab.url),
            message: readableMessage(error)
          });
        }
      }
    });
    stats.tabsShown = Math.max(stats.tabsShown, visibleTabIds.size, shownThisRound);
    stats.tabsHidden += hiddenThisRound;
  }

  return {
    update(percent, label, detail) {
      return render('show', percent, label, detail);
    },
    async hide(status = 'complete') {
      if (enabled) {
        await render(
          'hide',
          100,
          status === 'complete' ? 'Cleanup finished' : 'Cleanup stopped',
          'The cleanup progress overlay is being removed.'
        );
      }
      report.summary.progressOverlayEnabled = enabled;
      report.summary.progressOverlayUpdates = stats.updatesAttempted;
      report.summary.progressOverlayTabsShown = stats.tabsShown;
      report.summary.progressOverlayTabsHidden = stats.tabsHidden;
      report.summary.progressOverlayInjectionErrors = stats.injectionErrors;
      report.summary.progressOverlayCancelButtonEnabled = stats.cancelButtonEnabled;
      addSection(
        report,
        'progressOverlay',
        enabled ? 'Cross-tab cleanup progress overlay used' : 'Cross-tab cleanup progress overlay skipped',
        enabled && stats.injectionErrors ? 'partial' : enabled ? 'success' : 'skipped',
        {
          ...stats,
          completionStatus: status,
          maxTabsPerUpdate: MAX_PROGRESS_OVERLAY_TABS,
          note: enabled
            ? 'SiteWipe injects a small bottom-right progress overlay into accessible http/https tabs while cleanup is running, then reuses a versioned isolated-world receiver for phase updates instead of reinjecting the renderer each time. It removes both the overlay and receiver at the end. Chrome blocks injection on restricted pages such as chrome://, extension pages, the Web Store, unloaded/discarded pages, and incognito pages when incognito access is not allowed.'
            : 'Progress overlay is disabled in settings or chrome.scripting/chrome.tabs is unavailable.'
        }
      );
    }
  };
}

function createOverlayChannelId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `overlay-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeOverlayScope(value) {
  return ['all_tabs', 'current_window', 'target_tabs'].includes(value) ? value : 'target_tabs';
}

function overlayScopeAllowsTab(tab, target, scope) {
  if (scope === 'target_tabs') return Boolean(tab?.url && urlMatchesTarget(tab.url, target));
  return true;
}

function isProgressOverlayInjectableTab(tab, incognitoAccess) {
  if (!tab || !Number.isInteger(tab.id)) return false;
  if (tab.incognito && !incognitoAccess) return false;
  if (tab.discarded) return false;
  const url = String(tab.url || '');
  return url.startsWith('http://') || url.startsWith('https://');
}

function redactUrlForReport(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/…`;
  } catch {
    return '';
  }
}

export function renderSiteWipeProgressOverlay(payload) {
  const hostId = '__sitewipe_cleanup_progress_overlay__';
  const timerKey = '__sitewipe_cleanup_progress_overlay_timer__';
  const rootKey = '__sitewipe_cleanup_progress_overlay_root__';
  const listenerKey = '__sitewipe_cleanup_progress_overlay_listener__';
  const channelKey = '__sitewipe_cleanup_progress_overlay_channel__';
  const messageType = 'sitewipe.progressOverlay.render.v1';
  let existing = document.getElementById(hostId);

  if (
    payload?.action !== 'hide' &&
    typeof payload?.channelId === 'string' &&
    typeof chrome !== 'undefined' &&
    chrome.runtime?.onMessage &&
    !window[listenerKey]
  ) {
    window[channelKey] = payload.channelId;
    const listener = (message, sender) => {
      if (
        message?.protocolVersion !== 1 ||
        message?.type !== messageType ||
        message?.channelId !== window[channelKey] ||
        sender?.id !== chrome.runtime.id
      ) {
        return false;
      }
      renderSiteWipeProgressOverlay(message.payload);
      return false;
    };
    window[listenerKey] = listener;
    chrome.runtime.onMessage.addListener(listener);
  }

  if (payload?.action === 'hide') {
    clearTimeout(window[timerKey]);
    if (window[listenerKey] && chrome.runtime?.onMessage?.removeListener) {
      chrome.runtime.onMessage.removeListener(window[listenerKey]);
    }
    delete window[listenerKey];
    delete window[channelKey];
    if (existing) {
      existing.style.opacity = '0';
      existing.style.transform = 'translateY(8px) scale(0.98)';
      setTimeout(() => {
        existing.remove();
        delete window[rootKey];
      }, 240);
    }
    return;
  }

  let host = existing;
  if (host && !window[rootKey]) {
    // A page can create an element with the public host ID, but it cannot gain
    // access to the isolated-world root reference or cancel capability.
    host.remove();
    host = null;
    existing = null;
  }
  if (!host) {
    host = document.createElement('div');
    host.id = hostId;
    host.style.position = 'fixed';
    host.style.right = '18px';
    host.style.bottom = '18px';
    host.style.width = 'min(360px, calc(100vw - 36px))';
    host.style.zIndex = '2147483647';
    host.style.pointerEvents = 'none';
    host.style.opacity = '0';
    host.style.transform = 'translateY(8px) scale(0.98)';
    host.style.transition = 'opacity 160ms ease, transform 160ms ease';
    host.style.colorScheme = 'dark';
    const root = host.attachShadow({ mode: 'closed' });
    window[rootKey] = root;
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .card {
        pointer-events: auto;
        box-sizing: border-box;
        width: 100%;
        padding: 14px 14px 13px;
        border: 1px solid rgba(255,255,255,0.18);
        border-radius: 16px;
        background: linear-gradient(145deg, rgba(15, 23, 42, 0.96), rgba(2, 6, 23, 0.94));
        box-shadow: 0 20px 56px rgba(0,0,0,0.42), inset 0 1px 0 rgba(255,255,255,0.09);
        backdrop-filter: blur(14px) saturate(130%);
        -webkit-backdrop-filter: blur(14px) saturate(130%);
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .brand { display: flex; align-items: center; gap: 9px; min-width: 0; }
      .dot {
        width: 9px; height: 9px; border-radius: 999px;
        background: #35d07f;
        box-shadow: 0 0 0 5px rgba(53,208,127,0.14), 0 0 18px rgba(53,208,127,0.58);
        flex: 0 0 auto;
      }
      .title {
        color: #f8fafc;
        font-size: 13px;
        line-height: 1.2;
        font-weight: 750;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .percent { color: #dbeafe; font-size: 12px; line-height: 1; font-weight: 750; flex: 0 0 auto; }
      .detail {
        color: rgba(226,232,240,0.78);
        font-size: 11px;
        line-height: 1.35;
        margin: 7px 0 10px;
        overflow: hidden;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }
      .domain {
        color: rgba(147,197,253,0.9);
        font-size: 10px;
        line-height: 1;
        margin-top: 7px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; pointer-events: auto; }
      .cancel { border: 1px solid rgba(248,113,113,.45); background: rgba(127,29,29,.48); color: #fecaca; border-radius: 999px; padding: 4px 10px; font-size: 11px; line-height: 1.2; font-weight: 750; cursor: pointer; }
      .cancel:hover { background: rgba(153,27,27,.74); }
      .cancel[disabled] { opacity: .68; cursor: default; }
      .track {
        height: 8px;
        overflow: hidden;
        border-radius: 999px;
        background: rgba(148,163,184,0.22);
      }
      .bar {
        height: 100%;
        border-radius: inherit;
        width: 0%;
        background: linear-gradient(90deg, #60a5fa, #35d07f);
        transition: width 220ms ease;
        box-shadow: 0 0 18px rgba(96,165,250,0.36);
      }
      @media (prefers-reduced-motion: reduce) {
        .bar, :host { transition: none !important; }
      }
    `;
    const card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('role', 'status');
    card.setAttribute('aria-live', 'polite');

    const top = document.createElement('div');
    top.className = 'top';
    const brand = document.createElement('div');
    brand.className = 'brand';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');
    const title = document.createElement('div');
    title.className = 'title';
    title.id = 'sitewipe-progress-title';
    brand.append(dot, title);
    const percent = document.createElement('div');
    percent.className = 'percent';
    percent.id = 'sitewipe-progress-percent';
    top.append(brand, percent);

    const detail = document.createElement('div');
    detail.className = 'detail';
    detail.id = 'sitewipe-progress-detail';
    const track = document.createElement('div');
    track.className = 'track';
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.id = 'sitewipe-progress-bar';
    track.append(bar);
    const domain = document.createElement('div');
    domain.className = 'domain';
    domain.id = 'sitewipe-progress-domain';
    const actions = document.createElement('div');
    actions.className = 'actions';
    const cancel = document.createElement('button');
    cancel.id = 'sitewipe-progress-cancel';
    cancel.className = 'cancel';
    cancel.type = 'button';
    cancel.textContent = 'Request cancel';
    cancel.addEventListener('click', async () => {
      cancel.disabled = true;
      cancel.textContent = 'Cancel requested';
      try {
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          const response = await chrome.runtime.sendMessage({
            protocolVersion: 1,
            requestId: `overlay-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            type: 'sitewipe.cancelActiveJob',
            payload: {}
          });
          if (!response?.ok) throw new Error(response?.error || 'Cancellation request failed.');
        }
      } catch {
        cancel.textContent = 'Cancel unavailable';
      }
    });
    actions.append(cancel);

    card.append(top, detail, track, domain, actions);
    root.append(style, card);
    (document.documentElement || document.body).append(host);
    requestAnimationFrame(() => {
      host.style.opacity = '1';
      host.style.transform = 'translateY(0) scale(1)';
    });
  }

  const root = window[rootKey];
  if (!root) return;
  const percent = Math.max(0, Math.min(100, Number(payload?.percent) || 0));
  const label = String(payload?.label || 'SiteWipe cleanup…');
  const detail = String(payload?.detail || 'Cleaning browser-accessible site data.');
  const domain = String(payload?.domain || '');
  const titleEl = root.getElementById('sitewipe-progress-title');
  const percentEl = root.getElementById('sitewipe-progress-percent');
  const detailEl = root.getElementById('sitewipe-progress-detail');
  const barEl = root.getElementById('sitewipe-progress-bar');
  const domainEl = root.getElementById('sitewipe-progress-domain');
  const cancelEl = root.getElementById('sitewipe-progress-cancel');
  if (cancelEl) cancelEl.hidden = payload?.cancelEnabled === false || payload?.action === 'hide';
  if (titleEl) titleEl.textContent = label;
  if (percentEl) percentEl.textContent = `${Math.round(percent)}%`;
  if (detailEl) detailEl.textContent = detail;
  if (barEl) barEl.style.width = `${percent}%`;
  if (domainEl) domainEl.textContent = domain ? `Target: ${domain}` : 'SiteWipe';
  clearTimeout(window[timerKey]);
  window[timerKey] = setTimeout(
    () => {
      const el = document.getElementById(hostId);
      if (el) {
        el.style.opacity = '0';
        el.style.transform = 'translateY(8px) scale(0.98)';
        setTimeout(() => {
          el.remove();
          delete window[rootKey];
        }, 240);
      }
    },
    Math.max(8_000, Number(payload?.watchdogMs) || 15_000)
  );
}

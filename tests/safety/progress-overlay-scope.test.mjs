import test from 'node:test';
import assert from 'node:assert/strict';

import { createCleanupProgressOverlay, renderSiteWipeProgressOverlay } from '../../src/background/progress-overlay.js';

const target = {
  domain: 'example.com',
  displayName: 'example.com',
  matchMode: 'registrable_domain',
  associatedTargets: []
};

test('disabled overlay reports its cancel affordance as disabled and never inspects tabs', async (t) => {
  const liveTab = { id: 9, windowId: 7, url: 'https://example.com/', incognito: false, discarded: false };
  const calls = installChromeOverlayMock(t, liveTab);
  const report = { summary: {}, sections: [] };
  const overlay = createCleanupProgressOverlay(target, report, {
    progressOverlay: false,
    progressOverlayCancelButton: true,
    overlayScope: 'all_tabs',
    incognitoAccess: false,
    sourceWindowId: 7
  });

  await overlay.update(10, 'Disabled update', 'Synthetic test');
  await overlay.hide('stopped');
  assert.equal(calls.query.length, 0);
  assert.equal(calls.get.length, 0);
  assert.equal(calls.executeScript.length, 0);
  assert.equal(report.summary.progressOverlayEnabled, false);
  assert.equal(report.summary.progressOverlayCancelButtonEnabled, false);
});

test('a repeated direct injection refreshes the reused isolated-world receiver channel', (t) => {
  const previousChrome = globalThis.chrome;
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const listeners = [];
  const root = { getElementById: () => null };
  const host = { remove() {} };
  globalThis.window = { __sitewipe_cleanup_progress_overlay_root__: root };
  globalThis.document = { getElementById: () => host };
  globalThis.chrome = {
    runtime: {
      id: 'synthetic-sitewipe',
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        }
      }
    }
  };
  t.after(() => {
    clearTimeout(globalThis.window?.__sitewipe_cleanup_progress_overlay_timer__);
    globalThis.chrome = previousChrome;
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  });

  renderSiteWipeProgressOverlay({ action: 'show', channelId: 'stale-channel', watchdogMs: 8_000 });
  renderSiteWipeProgressOverlay({ action: 'show', channelId: 'fresh-channel', watchdogMs: 8_000 });

  assert.equal(listeners.length, 1, 'the isolated-world receiver should be reused');
  assert.equal(globalThis.window.__sitewipe_cleanup_progress_overlay_channel__, 'fresh-channel');
});

test('watchdog removal clears the isolated-world listener and channel before a later direct reinjection', (t) => {
  const previousChrome = globalThis.chrome;
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousSetTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  const listeners = [];
  const removedListeners = [];
  const scheduled = [];
  let hostRemovals = 0;
  const root = { getElementById: () => null };
  const host = {
    style: {},
    remove() {
      hostRemovals += 1;
    }
  };
  globalThis.window = { __sitewipe_cleanup_progress_overlay_root__: root };
  globalThis.document = { getElementById: () => host };
  globalThis.chrome = {
    runtime: {
      id: 'synthetic-sitewipe',
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        },
        removeListener(listener) {
          removedListeners.push(listener);
        }
      }
    }
  };
  globalThis.setTimeout = (callback) => {
    scheduled.push(callback);
    return scheduled.length;
  };
  globalThis.clearTimeout = () => {};
  const restore = () => {
    globalThis.chrome = previousChrome;
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.setTimeout = previousSetTimeout;
    globalThis.clearTimeout = previousClearTimeout;
  };
  t.after(restore);

  renderSiteWipeProgressOverlay({ action: 'show', channelId: 'expired-channel', watchdogMs: 8_000 });
  assert.equal(listeners.length, 1);
  assert.equal(scheduled.length, 1);
  scheduled.shift()();
  assert.deepEqual(removedListeners, [listeners[0]]);
  assert.equal(globalThis.window.__sitewipe_cleanup_progress_overlay_listener__, undefined);
  assert.equal(globalThis.window.__sitewipe_cleanup_progress_overlay_channel__, undefined);
  assert.equal(globalThis.window.__sitewipe_cleanup_progress_overlay_root__, undefined);
  assert.equal(hostRemovals, 1);

  globalThis.window.__sitewipe_cleanup_progress_overlay_root__ = root;
  renderSiteWipeProgressOverlay({ action: 'show', channelId: 'replacement-channel', watchdogMs: 8_000 });
  assert.equal(listeners.length, 2, 'a later direct injection must install a fresh receiver');
  assert.equal(globalThis.window.__sitewipe_cleanup_progress_overlay_channel__, 'replacement-channel');
  restore();
});

test('query reordering among still-eligible tabs stays within the reviewed 120-tab per-update cap', async (t) => {
  const previousChrome = globalThis.chrome;
  const tabs = Array.from({ length: 121 }, (_, index) => ({
    id: index + 1,
    windowId: 7,
    url: `https://unrelated-${index + 1}.example/page`,
    incognito: false,
    discarded: false
  }));
  let queries = 0;
  globalThis.chrome = {
    tabs: {
      async query() {
        queries += 1;
        return structuredClone(queries === 1 ? tabs : [tabs[120], ...tabs.slice(0, 120)]);
      },
      async get(tabId) {
        return structuredClone(tabs[tabId - 1]);
      },
      async sendMessage() {}
    },
    scripting: {
      async executeScript() {
        return [];
      }
    }
  };
  t.after(() => {
    globalThis.chrome = previousChrome;
  });
  const report = { summary: {}, sections: [] };
  const overlay = createCleanupProgressOverlay(target, report, {
    progressOverlay: true,
    progressOverlayCancelButton: true,
    overlayScope: 'all_tabs',
    incognitoAccess: false,
    sourceWindowId: 7
  });

  for (let update = 1; update <= 5; update += 1) {
    await overlay.update(update * 10, `Update ${update}`, 'Synthetic cap test');
  }
  await overlay.hide('complete');

  assert.equal(queries, 2, 'the fifth show update should perform the reordered live query');
  assert.equal(report.summary.progressOverlayTabsShown, 120);
  assert.equal(report.sections.find((section) => section.key === 'progressOverlay')?.details.maxTabsPerUpdate, 120);
});

test('moved current-window tab plus rotation keeps every update capped while disclosing stale watchdog overlap', async (t) => {
  const previousChrome = globalThis.chrome;
  const tabs = Array.from({ length: 121 }, (_, index) => ({
    id: index + 1,
    windowId: 7,
    url: `https://unrelated-${index + 1}.example/page`,
    incognito: false,
    discarded: false
  }));
  const calls = { sendMessage: [], executeScript: [] };
  globalThis.chrome = {
    tabs: {
      async query({ windowId } = {}) {
        return structuredClone(tabs.filter((tab) => windowId == null || tab.windowId === windowId));
      },
      async get(tabId) {
        return structuredClone(tabs[tabId - 1]);
      },
      async sendMessage(tabId, message) {
        calls.sendMessage.push({ tabId, message: structuredClone(message) });
      }
    },
    scripting: {
      async executeScript(details) {
        calls.executeScript.push(details);
        return [];
      }
    }
  };
  t.after(() => {
    globalThis.chrome = previousChrome;
  });
  const report = { summary: {}, sections: [] };
  const overlay = createCleanupProgressOverlay(target, report, {
    progressOverlay: true,
    progressOverlayCancelButton: true,
    overlayScope: 'current_window',
    incognitoAccess: false,
    sourceWindowId: 7
  });

  await overlay.update(10, 'Update 1', 'Synthetic moved-window cap test');
  tabs[0].windowId = 8;
  for (let update = 2; update <= 5; update += 1) {
    await overlay.update(update * 10, `Update ${update}`, 'Synthetic moved-window cap test');
  }
  await overlay.hide('complete');

  assert.equal(
    calls.sendMessage.some((call) => call.tabId === 1),
    false,
    'the moved tab must receive no message after live current-window revalidation'
  );
  const distinctInjectedTabs = new Set(calls.executeScript.map((call) => call.target.tabId));
  assert.equal(
    distinctInjectedTabs.size,
    121,
    'a replacement may be admitted while the moved page waits for its watchdog'
  );
  const targetedByLabel = new Map();
  for (const call of calls.executeScript) {
    const label = call.args[0].label;
    targetedByLabel.set(label, (targetedByLabel.get(label) || 0) + 1);
  }
  for (const call of calls.sendMessage) {
    const label = call.message.payload.label;
    targetedByLabel.set(label, (targetedByLabel.get(label) || 0) + 1);
  }
  for (const [label, count] of targetedByLabel) {
    assert.ok(count <= 120, `${label} targeted ${count} tabs, exceeding the per-update cap`);
  }
  const details = report.sections.find((section) => section.key === 'progressOverlay')?.details;
  assert.equal(details.maxTabsPerUpdate, 120);
  assert.equal(details.perUpdateCapDoesNotGuaranteeSimultaneousVisibleTotal, true);
  assert.match(details.note, /not a guaranteed simultaneous-visible total/i);
});

test('all-tabs overlay revalidates a cached tab and skips it after navigation to a restricted page', async (t) => {
  const liveTab = { id: 1, windowId: 7, url: 'https://unrelated.example/page', incognito: false, discarded: false };
  const calls = installChromeOverlayMock(t, liveTab);
  const overlay = createCleanupProgressOverlay(
    target,
    { summary: {}, sections: [] },
    {
      progressOverlay: true,
      progressOverlayCancelButton: true,
      overlayScope: 'all_tabs',
      incognitoAccess: false,
      sourceWindowId: 7
    }
  );

  await overlay.update(10, 'First update', 'Synthetic test');
  assert.equal(calls.executeScript.length, 1);

  liveTab.url = 'chrome://settings/';
  await overlay.update(20, 'Second update', 'Synthetic test');
  assert.equal(calls.sendMessage.length, 0, 'restricted live tabs must be rejected before receiver messaging');
  assert.equal(calls.executeScript.length, 1, 'restricted live tabs must not receive another injection');
});

test('a tab that disappears during a cached overlay update is a skip, not an injection error', async (t) => {
  const previousChrome = globalThis.chrome;
  const liveTab = { id: 91, windowId: 7, url: 'https://example.com/page', incognito: false, discarded: false };
  let available = true;
  globalThis.chrome = {
    tabs: {
      async query() {
        return [structuredClone(liveTab)];
      },
      async get() {
        if (!available) throw new Error('No tab with id: 91.');
        return structuredClone(liveTab);
      },
      async sendMessage() {}
    },
    scripting: {
      async executeScript() {
        return [];
      }
    }
  };
  t.after(() => {
    globalThis.chrome = previousChrome;
  });
  const report = { summary: {}, sections: [] };
  const overlay = createCleanupProgressOverlay(target, report, {
    progressOverlay: true,
    progressOverlayCancelButton: true,
    overlayScope: 'all_tabs',
    incognitoAccess: false,
    sourceWindowId: 7
  });

  await overlay.update(10, 'First update', 'Synthetic disappearing-tab test');
  available = false;
  await overlay.update(20, 'Second update', 'Synthetic disappearing-tab test');
  await overlay.hide('complete');

  assert.equal(report.summary.progressOverlayInjectionErrors, 0);
  const section = report.sections.find((item) => item.key === 'progressOverlay');
  assert.equal(section.status, 'success');
  assert.ok(section.details.tabsSkipped >= 1);
  assert.deepEqual(section.details.sampleErrors, []);
});

test('current-window overlay skips a cached tab that moved out of the reviewed source window', async (t) => {
  const liveTab = { id: 2, windowId: 4, url: 'https://unrelated.example/page', incognito: false, discarded: false };
  const calls = installChromeOverlayMock(t, liveTab);
  const overlay = createCleanupProgressOverlay(
    target,
    { summary: {}, sections: [] },
    {
      progressOverlay: true,
      progressOverlayCancelButton: false,
      overlayScope: 'current_window',
      incognitoAccess: false,
      sourceWindowId: 4
    }
  );

  await overlay.update(10, 'First update', 'Synthetic test');
  assert.equal(calls.executeScript.length, 1);

  liveTab.windowId = 5;
  await overlay.update(20, 'Second update', 'Synthetic test');
  assert.equal(calls.sendMessage.length, 0, 'moved tabs must be rejected before receiver messaging');
  assert.equal(calls.executeScript.length, 1, 'moved tabs must not receive another injection');
});

test('current-window overlay fails closed to matching target tabs when no source window can be bound', async (t) => {
  const liveTab = { id: 4, windowId: 6, url: 'https://unrelated.example/page', incognito: false, discarded: false };
  const calls = installChromeOverlayMock(t, liveTab);
  const report = { summary: {}, sections: [] };
  const overlay = createCleanupProgressOverlay(target, report, {
    progressOverlay: true,
    progressOverlayCancelButton: true,
    overlayScope: 'current_window',
    incognitoAccess: false,
    sourceWindowId: null
  });

  await overlay.update(10, 'First update', 'Synthetic test');
  assert.deepEqual(calls.query, [{}]);
  assert.equal(calls.get.length, 0);
  assert.equal(calls.executeScript.length, 0, 'an unrelated tab must not inherit unbound current-window authority');
  await overlay.hide('stopped');
  assert.equal(report.sections.find((section) => section.key === 'progressOverlay')?.details.scope, 'target_tabs');
});

test('overlay revalidates again after receiver failure before reinjecting into a navigated/private tab', async (t) => {
  const liveTab = { id: 3, windowId: 8, url: 'https://unrelated.example/page', incognito: false, discarded: false };
  const calls = installChromeOverlayMock(t, liveTab, {
    onSendMessage() {
      liveTab.url = 'https://private.example/';
      liveTab.incognito = true;
      throw new Error('Synthetic receiver disappeared during navigation.');
    }
  });
  const overlay = createCleanupProgressOverlay(
    target,
    { summary: {}, sections: [] },
    {
      progressOverlay: true,
      progressOverlayCancelButton: true,
      overlayScope: 'all_tabs',
      incognitoAccess: false,
      sourceWindowId: 8
    }
  );

  await overlay.update(10, 'First update', 'Synthetic test');
  assert.equal(calls.executeScript.length, 1);

  await overlay.update(20, 'Second update', 'Synthetic test');
  assert.equal(calls.sendMessage.length, 1);
  assert.equal(calls.executeScript.length, 1, 'a receiver failure must not bypass fresh private-scope validation');
  assert.ok(calls.get.length >= 3, 'the tab must be read again after receiver failure');
});

function installChromeOverlayMock(t, liveTab, { onSendMessage = null } = {}) {
  const previousChrome = globalThis.chrome;
  const calls = {
    query: [],
    get: [],
    sendMessage: [],
    executeScript: []
  };
  globalThis.chrome = {
    tabs: {
      async query(queryInfo) {
        calls.query.push(structuredClone(queryInfo));
        return [structuredClone(liveTab)];
      },
      async get(tabId) {
        calls.get.push(tabId);
        if (tabId !== liveTab.id) throw new Error('Unknown synthetic tab.');
        return structuredClone(liveTab);
      },
      async sendMessage(tabId, message) {
        calls.sendMessage.push({ tabId, message: structuredClone(message) });
        if (onSendMessage) return onSendMessage();
        return undefined;
      }
    },
    scripting: {
      async executeScript(details) {
        calls.executeScript.push(details);
        return [];
      }
    }
  };
  t.after(() => {
    globalThis.chrome = previousChrome;
  });
  return calls;
}

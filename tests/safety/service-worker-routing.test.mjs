import test from 'node:test';
import assert from 'node:assert/strict';

import { createChromeMock, dispatchRuntimeMessage } from '../helpers/chrome-mock.mjs';
import { APP, MESSAGE_TYPES, STORAGE_KEYS } from '../../src/shared/constants.js';

test('central Chrome mock covers every audited API namespace', async () => {
  const chrome = await createChromeMock();
  const required = {
    browsingData: ['remove'],
    cookies: ['getAllCookieStores', 'getAll', 'remove'],
    tabs: ['query', 'get', 'update', 'remove', 'sendMessage'],
    history: ['search', 'deleteUrl'],
    downloads: ['search', 'erase', 'removeFile'],
    scripting: ['executeScript', 'insertCSS', 'removeCSS'],
    webNavigation: ['getAllFrames'],
    declarativeNetRequest: ['getSessionRules', 'updateSessionRules'],
    storage: ['local', 'session'],
    sessions: ['getRecentlyClosed'],
    alarms: ['create', 'clear', 'getAll'],
    sidePanel: ['open'],
    extension: ['isAllowedIncognitoAccess']
  };
  for (const [namespace, methods] of Object.entries(required)) {
    assert.ok(chrome[namespace], `${namespace} namespace is missing`);
    for (const method of methods) assert.ok(chrome[namespace][method], `${namespace}.${method} is missing`);
  }
});

test('service-worker message boundary runs against the centralized Chrome mock', async () => {
  const chrome = await createChromeMock({
    tabs: [
      {
        id: 7,
        windowId: 1,
        active: true,
        currentWindow: true,
        lastFocusedWindow: true,
        title: 'Synthetic tenant fixture',
        url: 'https://alice.blogspot.com/synthetic',
        incognito: false
      }
    ]
  });
  globalThis.chrome = chrome;
  await import(`../../src/background/service-worker.js?mock=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(chrome.runtime.onMessage.listenerCount, 1);
  assert.equal(chrome.runtime.onInstalled.listenerCount, 1);
  assert.equal(chrome.alarms.onAlarm.listenerCount, 1);

  const sender = {
    id: chrome.runtime.id,
    documentUrl: chrome.runtime.getURL('popup/popup.html')
  };
  const normalized = await dispatchRuntimeMessage(
    chrome,
    {
      type: MESSAGE_TYPES.normalizeTarget,
      payload: { input: 'https://alice.blogspot.com/synthetic?token=canary' }
    },
    sender
  );
  assert.equal(normalized.ok, true);
  assert.equal(normalized.normalized.ok, true);
  assert.equal(normalized.normalized.target.domain, 'alice.blogspot.com');

  const active = await dispatchRuntimeMessage(chrome, { type: MESSAGE_TYPES.getActiveTabTarget, payload: {} }, sender);
  assert.equal(active.ok, true);
  assert.equal(active.activeTab.supported, true);
  assert.equal(active.activeTab.normalized.target.domain, 'alice.blogspot.com');

  const rejected = await dispatchRuntimeMessage(
    chrome,
    { type: MESSAGE_TYPES.getSettings, payload: {} },
    { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', documentUrl: 'chrome-extension://bbbb/settings.html' }
  );
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /sender is not this extension/i);

  await chrome.runtime.onInstalled.emitAsync({ reason: 'install' });
  assert.equal(chrome.__state.local[STORAGE_KEYS.settings].redactReports, true);
  assert.equal(chrome.__state.local[STORAGE_KEYS.settings].keepHistory, false);
  assert.ok(chrome.__state.alarms.has('sitewipe.maintenance'));

  delete globalThis.chrome;
});

test('completed browser cleanup is not relabeled failed when report persistence fails', async () => {
  const chrome = await createChromeMock({
    localState: {
      [STORAGE_KEYS.settings]: {
        cleanupMode: 'standard',
        progressOverlay: false,
        pageScriptScrub: false,
        temporaryDnrShield: false,
        verificationPass: false,
        aggressiveCookieSweep: false,
        redactReports: true,
        keepHistory: false,
        createdAt: '2026-08-16T12:00:00.000Z',
        updatedAt: '2026-08-16T12:00:00.000Z'
      }
    }
  });
  globalThis.chrome = chrome;
  await import(`../../src/background/service-worker.js?completion-fault=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const sender = {
    id: chrome.runtime.id,
    documentUrl: chrome.runtime.getURL('popup/popup.html')
  };

  const prepared = await dispatchRuntimeMessage(
    chrome,
    {
      type: MESSAGE_TYPES.prepareCleanupReview,
      payload: { input: 'example.com', sourceWindowId: 1, sourceIncognito: false }
    },
    sender
  );
  assert.equal(prepared.ok, true);
  assert.equal(Object.hasOwn(prepared.review, 'quickCleanupAllowed'), false);
  for (const origin of prepared.review.requiredHostPermissionOrigins) chrome.__state.originPermissions.add(origin);

  const originalSet = chrome.storage.local.set;
  chrome.storage.local.set = async (values) => {
    if (Object.hasOwn(values || {}, STORAGE_KEYS.activeReport)) throw new Error('synthetic report persistence failure');
    return originalSet(values);
  };

  const completed = await dispatchRuntimeMessage(
    chrome,
    {
      type: MESSAGE_TYPES.runDeepClean,
      payload: {
        approvalToken: prepared.review.approvalToken,
        sourceWindowId: 1,
        sourceIncognito: false,
        approval: {
          approvalMode: 'detailed_review',
          reviewedScope: true,
          associatedTargets: false,
          localOrIpTarget: false,
          protectedWebOrigins: false,
          fileConfirmationText: ''
        }
      }
    },
    sender
  );

  assert.equal(completed.ok, true);
  assert.equal(completed.report.status, 'completed_with_warnings');
  assert.ok(completed.completionWarnings.some((warning) => /Persist cleanup report/.test(warning)));
  assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob].status, 'completed');
  assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
  delete globalThis.chrome;
});

test('failure to persist the running job stops before browser mutation and records the failed report', async () => {
  const chrome = await createChromeMock({
    localState: {
      [STORAGE_KEYS.settings]: {
        cleanupMode: 'standard',
        progressOverlay: false,
        pageScriptScrub: false,
        temporaryDnrShield: false,
        verificationPass: false,
        aggressiveCookieSweep: false,
        redactReports: true,
        keepHistory: false,
        createdAt: '2026-08-16T12:00:00.000Z',
        updatedAt: '2026-08-16T12:00:00.000Z'
      }
    }
  });
  globalThis.chrome = chrome;
  await import(`../../src/background/service-worker.js?job-persistence-fault=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const sender = {
    id: chrome.runtime.id,
    documentUrl: chrome.runtime.getURL('popup/popup.html')
  };

  const prepared = await dispatchRuntimeMessage(
    chrome,
    {
      type: MESSAGE_TYPES.prepareCleanupReview,
      payload: { input: 'example.com', sourceWindowId: 1, sourceIncognito: false }
    },
    sender
  );
  assert.equal(prepared.ok, true);
  for (const origin of prepared.review.requiredHostPermissionOrigins) chrome.__state.originPermissions.add(origin);

  const originalSet = chrome.storage.local.set;
  let rejectedRunningJob = false;
  chrome.storage.local.set = async (values) => {
    if (!rejectedRunningJob && values?.[STORAGE_KEYS.activeJob]?.status === 'running') {
      rejectedRunningJob = true;
      throw new Error('synthetic running-job persistence failure');
    }
    return originalSet(values);
  };
  chrome.__calls.length = 0;

  const result = await dispatchRuntimeMessage(
    chrome,
    {
      type: MESSAGE_TYPES.runDeepClean,
      payload: {
        approvalToken: prepared.review.approvalToken,
        sourceWindowId: 1,
        sourceIncognito: false,
        approval: {
          approvalMode: 'detailed_review',
          reviewedScope: true,
          associatedTargets: false,
          localOrIpTarget: false,
          protectedWebOrigins: false,
          fileConfirmationText: ''
        }
      }
    },
    sender
  );

  assert.equal(result.ok, false);
  assert.match(result.error, /synthetic running-job persistence failure/i);
  assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
  assert.equal(chrome.__state.local[STORAGE_KEYS.activeReport].status, 'failed');
  assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
  for (const origin of prepared.review.requiredHostPermissionOrigins) {
    assert.equal(chrome.__state.originPermissions.has(origin), false);
  }
  assert.deepEqual(
    chrome.__calls
      .map((call) => call.api)
      .filter((api) =>
        [
          'browsingData.remove',
          'cookies.remove',
          'tabs.update',
          'tabs.remove',
          'history.deleteUrl',
          'downloads.erase',
          'downloads.removeFile',
          'scripting.executeScript'
        ].includes(api)
      ),
    []
  );
  delete globalThis.chrome;
});

test('maintenance interrupts a stale job and extension-local reset never deletes website data', async () => {
  const chrome = await createChromeMock();
  globalThis.chrome = chrome;
  await import(`../../src/background/service-worker.js?maintenance-reset=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const sender = {
    id: chrome.runtime.id,
    documentUrl: chrome.runtime.getURL('options/options.html'),
    tab: { windowId: 7 }
  };
  const staleAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  await chrome.storage.local.set({
    [STORAGE_KEYS.activeJob]: {
      id: 'synthetic-stale-job',
      status: 'running',
      targetDomain: 'example.com',
      startedAt: staleAt,
      updatedAt: staleAt,
      percent: 41,
      phase: 'originStorage',
      label: 'Running',
      detail: 'Synthetic stale job'
    },
    [STORAGE_KEYS.activeReport]: {
      id: 'synthetic-report',
      appVersion: APP.version,
      startedAt: staleAt,
      finishedAt: staleAt,
      status: 'failed',
      redacted: true,
      summary: {},
      sections: [],
      errors: [],
      skipped: [],
      unavailable: []
    },
    [STORAGE_KEYS.debugLog]: [{ at: staleAt, level: 'info', message: 'synthetic' }]
  });
  chrome.__calls.length = 0;

  const maintenance = await dispatchRuntimeMessage(
    chrome,
    { type: MESSAGE_TYPES.runMaintenanceNow, payload: {} },
    sender
  );
  assert.equal(maintenance.ok, true);
  assert.equal(maintenance.maintenance.staleJobRecovered, true);
  assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob].status, 'interrupted');
  assert.equal(maintenance.maintenanceStatus.activeJobStatus, 'interrupted');

  const opened = await dispatchRuntimeMessage(chrome, { type: MESSAGE_TYPES.openSidePanel, payload: {} }, sender);
  assert.equal(opened.ok, true);
  assert.ok(
    chrome.__calls.some((call) => call.api === 'sidePanel.open' && call.args[0]?.windowId === sender.tab.windowId)
  );

  const reset = await dispatchRuntimeMessage(
    chrome,
    { type: MESSAGE_TYPES.resetExtensionLocalState, payload: {} },
    sender
  );
  assert.equal(reset.ok, true);
  assert.equal(reset.reset.browserWebsiteDataChanged, false);
  assert.equal(reset.reset.localStateResetComplete, true);
  assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], null);
  assert.equal(chrome.__state.local[STORAGE_KEYS.activeReport], null);
  assert.deepEqual(chrome.__state.local[STORAGE_KEYS.debugLog], []);
  assert.deepEqual(
    chrome.__calls
      .map((call) => call.api)
      .filter((api) =>
        [
          'browsingData.remove',
          'cookies.remove',
          'tabs.update',
          'tabs.remove',
          'history.deleteUrl',
          'downloads.erase',
          'downloads.removeFile',
          'scripting.executeScript'
        ].includes(api)
      ),
    []
  );
  delete globalThis.chrome;
});

test('maintenance status reports a malformed permission lease without attempting permission removal', async () => {
  const chrome = await createChromeMock();
  globalThis.chrome = chrome;
  await import(`../../src/background/service-worker.js?invalid-permission-lease=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await chrome.storage.local.set({
    [STORAGE_KEYS.permissionLease]: {
      id: 'malformed-lease-without-required-fields'
    }
  });
  chrome.__calls.length = 0;
  const sender = {
    id: chrome.runtime.id,
    documentUrl: chrome.runtime.getURL('options/options.html')
  };

  const status = await dispatchRuntimeMessage(
    chrome,
    { type: MESSAGE_TYPES.getMaintenanceStatus, payload: {} },
    sender
  );
  assert.equal(status.ok, true);
  assert.equal(status.maintenanceStatus.temporaryHostAccess.state, 'invalid_record');
  assert.equal(status.maintenanceStatus.temporaryHostAccess.recoveryPending, true);
  assert.equal(
    chrome.__calls.some((call) => call.api === 'permissions.remove'),
    false
  );
  assert.ok(chrome.__state.local[STORAGE_KEYS.permissionLease]);
  delete globalThis.chrome;
});

test('extension update drops the legacy content-setting preference and applies safer defaults', async () => {
  const chrome = await createChromeMock({
    localState: {
      [STORAGE_KEYS.settings]: {
        cleanupMode: 'expert',
        contentSettingReset: true,
        keepHistory: true,
        redactReports: false,
        createdAt: '2026-08-15T12:00:00.000Z',
        updatedAt: '2026-08-15T12:00:00.000Z'
      }
    }
  });
  globalThis.chrome = chrome;
  await import(`../../src/background/service-worker.js?update-migration=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 0));

  await chrome.runtime.onInstalled.emitAsync({ reason: 'update' });
  const settings = chrome.__state.local[STORAGE_KEYS.settings];
  assert.equal(Object.hasOwn(settings, 'contentSettingReset'), false);
  assert.equal(settings.redactReports, true);
  assert.equal(settings.keepHistory, false);
  assert.equal(settings.latestReportRetentionMinutes, 30);
  assert.equal(settings.includeProtectedWebOrigins, false);
  assert.equal(settings.embeddedFrameDiscovery, false);
  assert.ok(settings.stabilityDefaultsAppliedAt);
  assert.ok(settings.performanceDefaultsAppliedAt);
  assert.ok(settings.privacyDefaultsAppliedAt);
  assert.ok(chrome.__state.alarms.has('sitewipe.maintenance'));
  delete globalThis.chrome;
});

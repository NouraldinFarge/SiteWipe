import test from 'node:test';
import assert from 'node:assert/strict';

import { createChromeMock, dispatchRuntimeMessage } from '../helpers/chrome-mock.mjs';
import { MESSAGE_TYPES, STORAGE_KEYS } from '../../src/shared/constants.js';

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

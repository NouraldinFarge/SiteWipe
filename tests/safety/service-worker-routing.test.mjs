import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createChromeActionPopupContext, createChromeMock, dispatchRuntimeMessage } from '../helpers/chrome-mock.mjs';
import { DEFAULT_SETTINGS, MESSAGE_TYPES, STORAGE_KEYS } from '../../src/shared/constants.js';
import {
  CLEANUP_REVIEW_STORAGE_KEY,
  digestCleanupPopupPreparationCapability,
  normalizeCleanupReviewRecord
} from '../../src/background/cleanup-preflight.js';

const PLACEHOLDER_POPUP_BINDING = Object.freeze({
  popupContextId: 'placeholder-popup-context',
  popupPreparationCapability: 'f'.repeat(64)
});

function popupPreparationBinding(prepared) {
  return {
    popupContextId: prepared.popupContextId,
    popupPreparationCapability: prepared.popupPreparationCapability
  };
}

test('stale request-shield callbacks cannot clear a newer job shield', async () => {
  const source = await readFile(new URL('../../src/background/service-worker.js', import.meta.url), 'utf8');
  const uncertainStart = source.indexOf('onShieldUncertain: async (patch) =>');
  const uncertainEnd = source.indexOf('onShieldCleared: async () =>', uncertainStart);
  const uncertainHandler = source.slice(uncertainStart, uncertainEnd);
  assert.ok(uncertainStart >= 0 && uncertainEnd > uncertainStart);
  assert.match(uncertainHandler, /currentShield\?\.jobId === job\.id/);
  assert.match(uncertainHandler, /:\s*undefined/);
  assert.doesNotMatch(uncertainHandler, /:\s*null/);
  assert.match(source.slice(uncertainEnd, source.indexOf('onShieldMutationSettled:', uncertainEnd)), /:\s*undefined/);
});

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
    windows: ['getCurrent', 'get'],
    extension: ['isAllowedIncognitoAccess'],
    permissions: ['contains', 'request', 'remove', 'getAll']
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
    documentUrl: chrome.runtime.getURL('popup/popup.html'),
    documentId: 'popup-document-message-boundary'
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

test('popup preparation accepts Chrome action-popup sentinel ids while verifying the source window separately', async () => {
  const chrome = await createChromeMock();
  assert.deepEqual(
    chrome.__state.runtimeContexts.map(({ contextType, tabId, windowId }) => ({ contextType, tabId, windowId })),
    [{ contextType: 'POPUP', tabId: -1, windowId: -1 }]
  );
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?action-popup-sentinel-${Date.now()}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sender = {
      id: chrome.runtime.id,
      url: chrome.runtime.getURL('popup/popup.html')
    };
    const prepared = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.prepareCleanupReview,
        payload: { input: 'example.com', sourceWindowId: 1, sourceIncognito: false }
      },
      sender
    );

    assert.equal(prepared.ok, true, prepared.error);
    assert.equal(prepared.popupContextId, chrome.__state.runtimeContexts[0].contextId);
    assert.equal(
      JSON.stringify(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY]).includes(
        chrome.__state.runtimeContexts[0].documentId
      ),
      false
    );
    assert.deepEqual(chrome.__calls.find((call) => call.api === 'runtime.getContexts')?.args[0], {
      contextTypes: ['POPUP'],
      documentUrls: [chrome.runtime.getURL('popup/popup.html')]
    });
    assert.ok(chrome.__calls.some((call) => call.api === 'windows.get' && call.args[0] === 1));
    const stored = normalizeCleanupReviewRecord(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY]);
    assert.equal(stored?.sourceWindowId, 1);
    assert.equal(stored?.sourceIncognito, false);

    const canceled = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.cancelCleanupReview,
        payload: {
          approvalToken: prepared.review.approvalToken,
          ...popupPreparationBinding(prepared),
          promptNotStarted: true
        }
      },
      sender
    );
    assert.equal(canceled.ok, true, canceled.error);
  } finally {
    delete globalThis.chrome;
  }
});

test('a spanning popup keeps its shared-profile flag separate from an incognito source window', async () => {
  const chrome = await createChromeMock({
    currentWindow: { id: 4, incognito: true },
    incognitoAllowed: true,
    originPermissions: [
      'http://example.com/*',
      'https://example.com/*',
      'http://*.example.com/*',
      'https://*.example.com/*'
    ]
  });
  assert.equal(chrome.runtime.getManifest().incognito, 'spanning');
  assert.equal(chrome.__state.runtimeContexts[0].incognito, false);
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?spanning-popup-private-source-${Date.now()}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sender = {
      id: chrome.runtime.id,
      url: chrome.runtime.getURL('popup/popup.html')
    };
    const prepared = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.prepareCleanupReview,
        payload: { input: 'example.com', sourceWindowId: 4, sourceIncognito: true }
      },
      sender
    );

    assert.equal(prepared.ok, true, prepared.error);
    assert.equal(prepared.review.privateWindowScope.sourceIncognito, true);
    assert.ok(chrome.__calls.some((call) => call.api === 'windows.get' && call.args[0] === 4));
    const stored = normalizeCleanupReviewRecord(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY]);
    assert.equal(stored?.sourceWindowId, 4);
    assert.equal(stored?.sourceIncognito, true);

    const canceled = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.cancelCleanupReview,
        payload: {
          approvalToken: prepared.review.approvalToken,
          ...popupPreparationBinding(prepared),
          promptNotStarted: true
        }
      },
      sender
    );
    assert.equal(canceled.ok, true, canceled.error);
  } finally {
    delete globalThis.chrome;
  }
});

test('popup preparation fails closed for ambiguous contexts and non-popup senders without relying on documentId', async () => {
  const cases = [
    {
      name: 'zero popup contexts',
      runtimeContexts: [],
      expected: /exactly one SiteWipe popup context/i
    },
    {
      name: 'multiple exact-url popup contexts',
      runtimeContexts: [
        createChromeActionPopupContext({ contextId: 'popup-context-a' }),
        createChromeActionPopupContext({ contextId: 'popup-context-b' })
      ],
      expected: /exactly one SiteWipe popup context/i
    },
    {
      name: 'missing popup context id',
      runtimeContexts: [createChromeActionPopupContext({ contextId: undefined })],
      expected: /malformed or mismatched/i
    },
    {
      name: 'empty popup context id',
      runtimeContexts: [createChromeActionPopupContext({ contextId: '' })],
      expected: /malformed or mismatched/i
    },
    {
      name: 'wrong extension context type',
      runtimeContexts: [createChromeActionPopupContext({ contextType: 'TAB' })],
      expected: /exactly one SiteWipe popup context/i
    },
    {
      name: 'missing popup document URL',
      runtimeContexts: [
        (() => {
          const context = createChromeActionPopupContext();
          delete context.documentUrl;
          return context;
        })()
      ],
      expected: /exactly one SiteWipe popup context/i
    },
    {
      name: 'wrong popup document URL',
      runtimeContexts: [createChromeActionPopupContext({ documentUrl: 'chrome-extension://invalid/popup/popup.html' })],
      expected: /exactly one SiteWipe popup context/i
    },
    {
      name: 'malformed popup context',
      runtimeContexts: [createChromeActionPopupContext({ contextId: 'popup-context-tab-shaped', tabId: 9 })],
      expected: /malformed or mismatched/i
    },
    {
      name: 'popup context incorrectly attributed to the source browser window',
      runtimeContexts: [createChromeActionPopupContext({ contextId: 'popup-context-window-shaped', windowId: 1 })],
      expected: /malformed or mismatched/i
    },
    {
      name: 'spanning popup context is incorrectly marked off-the-record',
      runtimeContexts: [createChromeActionPopupContext({ contextId: 'popup-context-private', incognito: true })],
      expected: /malformed or mismatched/i
    },
    {
      name: 'wrong auxiliary sender origin',
      senderPatch: { origin: 'https://example.invalid' },
      expected: /only the exact SiteWipe popup/i
    },
    {
      name: 'tab-shaped sender',
      senderPatch: { tab: { id: 7 } },
      expected: /only the exact SiteWipe popup/i
    }
  ];

  for (const [index, scenario] of cases.entries()) {
    const chrome = await createChromeMock(
      scenario.runtimeContexts === undefined ? {} : { runtimeContexts: scenario.runtimeContexts }
    );
    globalThis.chrome = chrome;
    try {
      await import(`../../src/background/service-worker.js?popup-context-fail-closed-${index}-${Date.now()}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const response = await dispatchRuntimeMessage(
        chrome,
        {
          type: MESSAGE_TYPES.prepareCleanupReview,
          payload: { input: 'example.com', sourceWindowId: 1, sourceIncognito: false }
        },
        {
          id: chrome.runtime.id,
          documentUrl: chrome.runtime.getURL('popup/popup.html'),
          ...scenario.senderPatch
        }
      );
      assert.equal(response.ok, false, scenario.name);
      assert.match(response.error, scenario.expected, scenario.name);
      assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined, scenario.name);
      assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined, scenario.name);
      assert.equal(cleanupMutationCallCount(chrome), 0, scenario.name);
    } finally {
      delete globalThis.chrome;
    }
  }
});

test('popup preparation fails closed when Chrome context inspection is unavailable, rejects, or is malformed', async () => {
  const scenarios = [
    {
      name: 'unavailable API',
      configure(chrome) {
        delete chrome.runtime.getContexts;
      }
    },
    {
      name: 'rejected inspection',
      configure(chrome) {
        chrome.runtime.getContexts = async () => {
          throw new Error('synthetic getContexts rejection');
        };
      }
    },
    {
      name: 'non-array inspection',
      configure(chrome) {
        chrome.runtime.getContexts = async () => ({ contextId: 'not-an-array' });
      }
    }
  ];

  for (const [index, scenario] of scenarios.entries()) {
    const chrome = await createChromeMock();
    scenario.configure(chrome);
    globalThis.chrome = chrome;
    try {
      await import(`../../src/background/service-worker.js?popup-context-api-failure-${index}-${Date.now()}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const response = await dispatchRuntimeMessage(
        chrome,
        {
          type: MESSAGE_TYPES.prepareCleanupReview,
          payload: { input: 'example.com', sourceWindowId: 1, sourceIncognito: false }
        },
        {
          id: chrome.runtime.id,
          url: chrome.runtime.getURL('popup/popup.html')
        }
      );

      assert.equal(response.ok, false, scenario.name);
      assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined, scenario.name);
      assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined, scenario.name);
      assert.equal(cleanupMutationCallCount(chrome), 0, scenario.name);
    } finally {
      delete globalThis.chrome;
    }
  }
});

test('service-worker-load recovery reserves cleanup startup and cannot overwrite a replacement job', async () => {
  const now = new Date().toISOString();
  const staleJob = {
    id: 'stale-load-job',
    status: 'running',
    targetDomain: '[redacted-target]',
    startedAt: now,
    updatedAt: now,
    percent: 20,
    phase: 'synthetic-stale',
    label: 'Synthetic stale cleanup',
    detail: '',
    cancelRequested: false
  };
  const replacementJob = {
    ...staleJob,
    id: 'replacement-job',
    percent: 0,
    phase: 'replacement',
    label: 'Replacement cleanup'
  };
  const chrome = await createChromeMock({
    localState: {
      [STORAGE_KEYS.settings]: {
        ...DEFAULT_SETTINGS,
        createdAt: now,
        updatedAt: now,
        stabilityDefaultsAppliedAt: now,
        performanceDefaultsAppliedAt: now,
        privacyDefaultsAppliedAt: now
      },
      [STORAGE_KEYS.activeJob]: staleJob
    }
  });
  const staleReadStarted = deferred();
  const releaseStaleRead = deferred();
  const originalGet = chrome.storage.local.get;
  let activeJobReads = 0;
  chrome.storage.local.get = async (keys) => {
    if (Array.isArray(keys) && keys.length === 1 && keys[0] === STORAGE_KEYS.activeJob) {
      activeJobReads += 1;
      if (activeJobReads === 2) {
        const staleSnapshot = await originalGet(keys);
        staleReadStarted.resolve();
        await releaseStaleRead.promise;
        return staleSnapshot;
      }
    }
    return originalGet(keys);
  };

  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?load-recovery-reservation=${Date.now()}`);
    await staleReadStarted.promise;
    const sender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('popup/popup.html'),
      documentId: 'popup-document-handoff-a'
    };
    const runPromise = dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.prepareCleanupReview,
        payload: { input: 'example.com', sourceWindowId: 1, sourceIncognito: false }
      },
      sender
    );
    await chrome.storage.local.set({ [STORAGE_KEYS.activeJob]: replacementJob });
    releaseStaleRead.resolve();
    const runResponse = await runPromise;
    assert.equal(runResponse.ok, false);
    assert.match(runResponse.error, /safety-proof/i);
    assert.equal(runResponse.errorCode, 'lifecycle_not_ready');
    await waitFor(() => activeJobReads >= 3);
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob].id, replacementJob.id);
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob].status, 'running');
  } finally {
    releaseStaleRead.resolve();
    delete globalThis.chrome;
  }
});

test('an unresolved durable DNR install remains blocked until a browser-session boundary is proved', async () => {
  const now = new Date().toISOString();
  const chrome = await createChromeMock({
    localState: {
      [STORAGE_KEYS.settings]: {
        ...DEFAULT_SETTINGS,
        createdAt: now,
        updatedAt: now,
        stabilityDefaultsAppliedAt: now,
        performanceDefaultsAppliedAt: now,
        privacyDefaultsAppliedAt: now
      },
      [STORAGE_KEYS.activeShield]: {
        domain: 'pending.example',
        displayName: 'pending.example',
        associatedTargets: [],
        ruleIds: [730000],
        urlFilters: ['||pending.example^'],
        mode: 'cleanup-only',
        lifecycle: 'unknown',
        pendingMutation: true,
        expiresAt: null,
        startedAt: now,
        jobId: 'cleanup-a'
      }
    }
  });
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?pending-dnr-gate=${Date.now()}`);
    await waitFor(() => chrome.__state.alarms.has('sitewipe.maintenance'));
    await Promise.resolve();
    const sender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('popup/popup.html'),
      documentId: 'popup-document-expiry-a'
    };
    const mutationCallsBefore = cleanupMutationCallCount(chrome);
    const blocked = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.prepareCleanupReview,
        payload: { input: 'example.com', sourceWindowId: 1, sourceIncognito: false }
      },
      sender
    );
    assert.equal(blocked.ok, false);
    assert.equal(blocked.errorCode, 'lifecycle_not_ready');
    assert.match(blocked.error, /request-shield-session-boundary/i);
    assert.equal(cleanupMutationCallCount(chrome), mutationCallsBefore);
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeShield].jobId, 'cleanup-a');
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeShield].pendingMutation, true);

    const maintenance = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.runMaintenanceNow, payload: {} },
      sender
    );
    assert.equal(maintenance.ok, false);
    assert.equal(maintenance.errorCode, 'sitewipe_action_failed');
    assert.match(maintenance.error, /restart the browser/i);
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeShield].pendingMutation, true);
  } finally {
    delete globalThis.chrome;
  }
});

test('pre-cleanup fails closed when the owned DNR range cannot be proved empty', async () => {
  const now = new Date().toISOString();
  const chrome = await createChromeMock({
    originPermissions: ['<all_urls>'],
    dnrRules: [
      {
        id: 730000,
        priority: 1,
        action: { type: 'block' },
        condition: { urlFilter: '||stale.example^', resourceTypes: ['main_frame'] }
      }
    ],
    localState: {
      [STORAGE_KEYS.settings]: {
        ...DEFAULT_SETTINGS,
        cleanupMode: 'standard',
        progressOverlay: false,
        pageScriptScrub: false,
        temporaryDnrShield: false,
        verificationPass: false,
        aggressiveCookieSweep: false,
        createdAt: now,
        updatedAt: now,
        stabilityDefaultsAppliedAt: now,
        performanceDefaultsAppliedAt: now,
        privacyDefaultsAppliedAt: now
      },
      [STORAGE_KEYS.activeShield]: {
        domain: 'stale.example',
        displayName: 'stale.example',
        associatedTargets: [],
        ruleIds: [730000],
        urlFilters: ['||stale.example^'],
        mode: 'cleanup-only',
        lifecycle: 'unknown',
        pendingMutation: false,
        expiresAt: null,
        startedAt: now,
        jobId: 'stale-shield-job'
      }
    }
  });
  chrome.declarativeNetRequest.updateSessionRules = async (details) => {
    chrome.__calls.push({ api: 'declarativeNetRequest.updateSessionRules', args: [structuredClone(details)] });
    throw new Error('synthetic DNR clear failure');
  };
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?dnr-pre-cleanup-fail-closed=${Date.now()}`);
    await waitFor(() => chrome.__state.alarms.has('sitewipe.maintenance'));
    const sender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('popup/popup.html'),
      documentId: 'popup-document-handoff-a'
    };
    const prepared = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.prepareCleanupReview,
        payload: { input: 'example.com', sourceWindowId: 1, sourceIncognito: false }
      },
      sender
    );
    assert.equal(prepared.ok, false);
    assert.equal(prepared.errorCode, 'lifecycle_not_ready');
    assert.match(prepared.error, /safety-proof/i);
    assert.equal(cleanupMutationCallCount(chrome), 0);
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
    assert.equal(chrome.__state.dnrRules.length, 1);
  } finally {
    delete globalThis.chrome;
  }
});

test('Standard mode persists frame discovery off and releases webNavigation until a fresh Expert enablement', async () => {
  const now = new Date().toISOString();
  const chrome = await createChromeMock({
    localState: {
      [STORAGE_KEYS.settings]: {
        ...DEFAULT_SETTINGS,
        cleanupMode: 'expert',
        embeddedFrameDiscovery: true,
        createdAt: now,
        updatedAt: now,
        stabilityDefaultsAppliedAt: now,
        performanceDefaultsAppliedAt: now,
        privacyDefaultsAppliedAt: now
      }
    }
  });
  chrome.__state.namedPermissions.add('webNavigation');
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?settings-lifecycle=${Date.now()}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('popup/popup.html'),
      documentId: 'popup-document-live-job-guard'
    };

    const standard = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.saveSettings, payload: { settings: { cleanupMode: 'standard' } } },
      sender
    );
    assert.equal(standard.ok, true, standard.error);
    assert.equal(standard.settings.cleanupMode, 'standard');
    assert.equal(standard.settings.embeddedFrameDiscovery, false);
    assert.equal(chrome.__state.local[STORAGE_KEYS.settings].embeddedFrameDiscovery, false);
    assert.equal(chrome.__state.namedPermissions.has('webNavigation'), false);

    const enteringExpert = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.saveSettings,
        payload: { settings: { cleanupMode: 'expert', embeddedFrameDiscovery: true } }
      },
      sender
    );
    assert.equal(enteringExpert.ok, true, enteringExpert.error);
    assert.equal(enteringExpert.settings.cleanupMode, 'expert');
    assert.equal(enteringExpert.settings.embeddedFrameDiscovery, false);

    await chrome.permissions.request({ permissions: ['webNavigation'] });
    const explicitlyEnabled = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.saveSettings,
        payload: { settings: { cleanupMode: 'expert', embeddedFrameDiscovery: true } }
      },
      sender
    );
    assert.equal(explicitlyEnabled.ok, true, explicitlyEnabled.error);
    assert.equal(explicitlyEnabled.settings.embeddedFrameDiscovery, true);
    assert.equal(chrome.__state.namedPermissions.has('webNavigation'), true);
  } finally {
    delete globalThis.chrome;
  }
});

test('settings, shield, maintenance, and local reset routes reject a live cleanup job', async () => {
  const now = new Date().toISOString();
  const chrome = await createChromeMock({
    localState: {
      [STORAGE_KEYS.settings]: {
        ...DEFAULT_SETTINGS,
        createdAt: now,
        updatedAt: now,
        stabilityDefaultsAppliedAt: now,
        performanceDefaultsAppliedAt: now,
        privacyDefaultsAppliedAt: now
      }
    }
  });
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?live-options-guards=${Date.now()}`);
    const ready = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.prepareCleanupReview,
        payload: { input: 'example.com', sourceWindowId: 1, sourceIncognito: false }
      },
      {
        id: chrome.runtime.id,
        documentUrl: chrome.runtime.getURL('popup/popup.html'),
        documentId: 'popup-document-live-options-prepare'
      }
    );
    assert.equal(ready.ok, true, ready.error);
    await chrome.storage.local.set({
      [STORAGE_KEYS.activeJob]: {
        id: 'live-options-guard-job',
        status: 'running',
        targetDomain: '[redacted-target]',
        startedAt: now,
        updatedAt: new Date().toISOString(),
        percent: 25,
        phase: 'synthetic-test',
        label: 'Synthetic live cleanup',
        detail: '',
        cancelRequested: false
      }
    });
    const sender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('popup/popup.html'),
      documentId: 'popup-document-live-job-guard'
    };
    const guardedMessages = [
      {
        type: MESSAGE_TYPES.cancelCleanupReview,
        payload: { approvalToken: 'a'.repeat(48), ...PLACEHOLDER_POPUP_BINDING }
      },
      {
        type: MESSAGE_TYPES.settleCleanupPermissionPrompt,
        payload: {
          approvalToken: 'a'.repeat(48),
          handoffNonce: 'c'.repeat(48),
          permissionLeaseId: 'b'.repeat(48),
          ...PLACEHOLDER_POPUP_BINDING,
          outcome: 'denied'
        }
      },
      { type: MESSAGE_TYPES.clearHistory, payload: {} },
      { type: MESSAGE_TYPES.clearDebugLog, payload: {} },
      { type: MESSAGE_TYPES.saveSettings, payload: { settings: { reducedMotion: true } } },
      { type: MESSAGE_TYPES.resetSettings, payload: {} },
      { type: MESSAGE_TYPES.clearActiveShield, payload: {} },
      { type: MESSAGE_TYPES.repairActiveShield, payload: {} },
      { type: MESSAGE_TYPES.expireActiveShield, payload: {} },
      { type: MESSAGE_TYPES.forgetLatestReport, payload: { reportId: 'sitewipe-synthetic-report' } },
      { type: MESSAGE_TYPES.clearActiveJobRecord, payload: {} },
      { type: MESSAGE_TYPES.runMaintenanceNow, payload: {} },
      { type: MESSAGE_TYPES.resetExtensionLocalState, payload: {} }
    ];
    for (const message of guardedMessages) {
      const response = await dispatchRuntimeMessage(chrome, message, sender);
      assert.equal(response.ok, false, `${message.type} unexpectedly succeeded`);
      assert.match(response.error, /cleanup is still running/i);
    }
  } finally {
    delete globalThis.chrome;
  }
});

test('an admitted administrative mutation reserves the lifecycle before cleanup or review can start', async () => {
  const now = new Date().toISOString();
  const chrome = await createChromeMock({
    originPermissions: ['<all_urls>'],
    localState: {
      [STORAGE_KEYS.settings]: {
        ...DEFAULT_SETTINGS,
        createdAt: now,
        updatedAt: now,
        stabilityDefaultsAppliedAt: now,
        performanceDefaultsAppliedAt: now,
        privacyDefaultsAppliedAt: now
      }
    }
  });
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?admin-reservation=${Date.now()}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('options/options.html')
    };
    const popupSender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('popup/popup.html')
    };
    const prepared = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.prepareCleanupReview,
        payload: { input: 'example.com', sourceWindowId: 1, sourceIncognito: false }
      },
      popupSender
    );
    assert.equal(prepared.ok, true, prepared.error);
    const guardReadStarted = deferred();
    const releaseGuardRead = deferred();
    const originalGet = chrome.storage.local.get;
    let blockGuardRead = true;
    chrome.storage.local.get = async (keys) => {
      if (blockGuardRead && Array.isArray(keys) && keys.length === 1 && keys[0] === STORAGE_KEYS.activeJob) {
        blockGuardRead = false;
        guardReadStarted.resolve();
        await releaseGuardRead.promise;
      }
      return originalGet(keys);
    };

    const savePromise = dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.saveSettings, payload: { settings: { reducedMotion: true } } },
      sender
    );
    await guardReadStarted.promise;

    const runResponse = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.runDeepClean,
        payload: {
          approvalToken: prepared.review.approvalToken,
          sourceWindowId: 1,
          sourceIncognito: false,
          ...popupPreparationBinding(prepared),
          approval: completeApproval()
        }
      },
      popupSender
    );
    assert.equal(runResponse.ok, false);
    assert.match(runResponse.error, /still trying to change settings/i);

    const reviewResponse = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.prepareCleanupReview,
        payload: { input: 'example.com', sourceWindowId: 1, sourceIncognito: false }
      },
      {
        id: chrome.runtime.id,
        documentUrl: chrome.runtime.getURL('popup/popup.html')
      }
    );
    assert.equal(reviewResponse.ok, false);
    assert.match(reviewResponse.error, /still trying to change settings/i);

    const readResponse = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.getPopupState, payload: {} },
      sender
    );
    assert.equal(readResponse.ok, true, readResponse.error);

    releaseGuardRead.resolve();
    const saved = await savePromise;
    assert.equal(saved.ok, true, saved.error);
    assert.equal(saved.settings.reducedMotion, true);
    assert.equal(
      chrome.__calls.some((call) =>
        [
          'browsingData.remove',
          'cookies.remove',
          'tabs.remove',
          'history.deleteUrl',
          'downloads.erase',
          'downloads.removeFile'
        ].includes(call.api)
      ),
      false
    );
  } finally {
    delete globalThis.chrome;
  }
});

test('a cleanup reservation rejects every administrative route and defers alarm maintenance before job persistence', async () => {
  const now = new Date().toISOString();
  const chrome = await createChromeMock({
    originPermissions: ['<all_urls>'],
    localState: {
      [STORAGE_KEYS.settings]: {
        ...DEFAULT_SETTINGS,
        cleanupMode: 'standard',
        progressOverlay: false,
        pageScriptScrub: false,
        temporaryDnrShield: false,
        verificationPass: false,
        aggressiveCookieSweep: false,
        redactReports: true,
        keepHistory: false,
        createdAt: now,
        updatedAt: now,
        stabilityDefaultsAppliedAt: now,
        performanceDefaultsAppliedAt: now,
        privacyDefaultsAppliedAt: now
      }
    }
  });
  globalThis.chrome = chrome;
  const releaseCleanupGuard = deferred();
  try {
    await import(`../../src/background/service-worker.js?cleanup-reservation=${Date.now()}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('popup/popup.html'),
      documentId: 'popup-document-cleanup-reservation'
    };
    const prepared = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.prepareCleanupReview,
        payload: { input: 'example.com', sourceWindowId: 1, sourceIncognito: false }
      },
      sender
    );
    assert.equal(prepared.ok, true, prepared.error);

    const cleanupGuardStarted = deferred();
    const originalLocalGet = chrome.storage.local.get;
    let blockCleanupGuard = true;
    chrome.storage.local.get = async (keys) => {
      if (blockCleanupGuard && Array.isArray(keys) && keys.length === 1 && keys[0] === STORAGE_KEYS.activeShield) {
        blockCleanupGuard = false;
        cleanupGuardStarted.resolve();
        await releaseCleanupGuard.promise;
      }
      return originalLocalGet(keys);
    };

    const runPromise = dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.runDeepClean,
        payload: {
          approvalToken: prepared.review.approvalToken,
          sourceWindowId: 1,
          sourceIncognito: false,
          ...popupPreparationBinding(prepared),
          approval: completeApproval()
        }
      },
      sender
    );
    await cleanupGuardStarted.promise;

    const guardedMessages = [
      {
        type: MESSAGE_TYPES.cancelCleanupReview,
        payload: { approvalToken: prepared.review.approvalToken, ...popupPreparationBinding(prepared) }
      },
      {
        type: MESSAGE_TYPES.settleCleanupPermissionPrompt,
        payload: {
          approvalToken: prepared.review.approvalToken,
          handoffNonce: 'c'.repeat(48),
          permissionLeaseId: 'b'.repeat(48),
          ...popupPreparationBinding(prepared),
          outcome: 'denied'
        }
      },
      { type: MESSAGE_TYPES.clearHistory, payload: {} },
      { type: MESSAGE_TYPES.clearDebugLog, payload: {} },
      { type: MESSAGE_TYPES.saveSettings, payload: { settings: { reducedMotion: true } } },
      { type: MESSAGE_TYPES.resetSettings, payload: {} },
      { type: MESSAGE_TYPES.clearActiveShield, payload: {} },
      { type: MESSAGE_TYPES.repairActiveShield, payload: {} },
      { type: MESSAGE_TYPES.expireActiveShield, payload: {} },
      { type: MESSAGE_TYPES.forgetLatestReport, payload: { reportId: 'sitewipe-synthetic-report' } },
      { type: MESSAGE_TYPES.clearActiveJobRecord, payload: {} },
      { type: MESSAGE_TYPES.runMaintenanceNow, payload: {} },
      { type: MESSAGE_TYPES.resetExtensionLocalState, payload: {} }
    ];
    for (const message of guardedMessages) {
      const response = await dispatchRuntimeMessage(chrome, message, sender);
      assert.equal(response.ok, false, `${message.type} unexpectedly succeeded`);
      assert.match(response.error, /cleanup is still running/i);
    }

    const secondReview = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.prepareCleanupReview,
        payload: { input: 'example.net', sourceWindowId: 1, sourceIncognito: false }
      },
      sender
    );
    assert.equal(secondReview.ok, false);
    assert.match(secondReview.error, /cleanup is still running/i);

    const cancellation = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.cancelActiveJob, payload: {} },
      sender
    );
    assert.equal(cancellation.ok, true, cancellation.error);
    const readResponse = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.getPopupState, payload: {} },
      sender
    );
    assert.equal(readResponse.ok, true, readResponse.error);
    for (const type of [MESSAGE_TYPES.getShieldDiagnostics, MESSAGE_TYPES.getActiveJob]) {
      const response = await dispatchRuntimeMessage(chrome, { type, payload: {} }, sender);
      assert.equal(response.ok, true, `${type}: ${response.error || 'read unexpectedly failed'}`);
    }

    await chrome.__events.runtimeStartup.emitAsync();
    await chrome.__events.alarm.emitAsync({ name: 'sitewipe.maintenance' });
    assert.equal(chrome.__state.local[STORAGE_KEYS.lastMaintenance], undefined);

    releaseCleanupGuard.resolve();
    const completed = await runPromise;
    assert.equal(completed.ok, true, completed.error);
    await waitFor(() => Boolean(chrome.__state.local[STORAGE_KEYS.lastMaintenance]));
    assert.match(chrome.__state.local[STORAGE_KEYS.lastMaintenance].reason, /^deferred:/);
  } finally {
    releaseCleanupGuard.resolve();
    delete globalThis.chrome;
  }
});

test('service worker inventories and preserves user-controlled all-site access through completion', async () => {
  const chrome = await createChromeMock({
    originPermissions: ['<all_urls>'],
    localState: {
      [STORAGE_KEYS.settings]: {
        cleanupMode: 'standard',
        progressOverlay: false,
        pageScriptScrub: false,
        temporaryDnrShield: false,
        verificationPass: false,
        aggressiveCookieSweep: false,
        redactReports: false,
        keepHistory: false,
        createdAt: '2026-08-16T12:00:00.000Z',
        updatedAt: '2026-08-16T12:00:00.000Z'
      }
    }
  });
  globalThis.chrome = chrome;
  await import(`../../src/background/service-worker.js?broad-permission=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const sender = {
    id: chrome.runtime.id,
    documentUrl: chrome.runtime.getURL('popup/popup.html'),
    documentId: 'popup-document-all-sites-inventory'
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
  assert.equal(prepared.review.hostPermissionsGranted, true);
  assert.deepEqual(prepared.review.hostPermissionInventory.broadGrantedHostPermissionOrigins, ['<all_urls>']);
  assert.equal(prepared.review.hostPermissionInventory.allSitesAccessGranted, true);

  const completed = await dispatchRuntimeMessage(
    chrome,
    {
      type: MESSAGE_TYPES.runDeepClean,
      payload: {
        approvalToken: prepared.review.approvalToken,
        sourceWindowId: 1,
        sourceIncognito: false,
        ...popupPreparationBinding(prepared),
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
  assert.equal(completed.reportPersisted, true);
  assert.equal(completed.report.summary.allSitesAccessGranted, true);
  assert.equal(completed.report.summary.broadHostPermissionOriginsGranted, 1);
  assert.deepEqual(completed.report.hostPermissionInventory.beforeRelease.broadGrantedHostPermissionOrigins, [
    '[redacted]'
  ]);
  assert.deepEqual(chrome.__state.originPermissions, new Set(['<all_urls>']));
  const removedOriginCalls = chrome.__calls.filter(
    (call) => call.api === 'permissions.remove' && Array.isArray(call.args?.[0]?.origins)
  );
  assert.deepEqual(removedOriginCalls, []);
  assert.ok(chrome.__calls.some((call) => call.api === 'permissions.getAll'));
  delete globalThis.chrome;
});

test('an exact native grant continues an armed Standard cleanup after the popup is destroyed', async () => {
  const now = new Date().toISOString();
  const chrome = await createChromeMock({
    incognitoAllowed: false,
    localState: {
      [STORAGE_KEYS.settings]: {
        ...DEFAULT_SETTINGS,
        cleanupMode: 'standard',
        progressOverlay: false,
        pageScriptScrub: false,
        temporaryDnrShield: false,
        verificationPass: false,
        aggressiveCookieSweep: false,
        deleteDownloadedFiles: false,
        redactReports: false,
        keepHistory: false,
        createdAt: now,
        updatedAt: now,
        stabilityDefaultsAppliedAt: now,
        performanceDefaultsAppliedAt: now,
        privacyDefaultsAppliedAt: now
      }
    }
  });
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?popup-loss-handoff=${Date.now()}`);
    await waitFor(() => chrome.__state.alarms.has('sitewipe.maintenance'));
    const sender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('popup/popup.html'),
      documentId: 'popup-document-handoff-a'
    };
    const prepared = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.prepareCleanupReview,
        payload: { input: 'example.com', sourceWindowId: 1, sourceIncognito: false }
      },
      sender
    );
    assert.equal(prepared.ok, true, prepared.error);
    assert.equal(prepared.review.hostPermissionsGranted, false);
    assert.equal(prepared.review.temporaryHostPermissionOrigins.length, 4);
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease].status, 'prompt_pending');

    // Mirror the popup's single activation task: invoke the native request
    // first, then dispatch the non-awaited arm marker before awaiting either.
    // The mock emits onAdded synchronously, proving event-before-arm converges.
    const permissionRequest = chrome.permissions.request({
      origins: prepared.review.temporaryHostPermissionOrigins
    });
    const armedPromise = dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.armCleanupApproval,
        payload: {
          approvalToken: prepared.review.approvalToken,
          handoffNonce: prepared.review.approvalHandoffNonce,
          approval: completeApproval(),
          ...popupPreparationBinding(prepared),
          sourceWindowId: 1,
          sourceIncognito: false
        }
      },
      sender
    );
    const [granted, armed] = await Promise.all([permissionRequest, armedPromise]);
    assert.equal(armed.ok, true, armed.error);
    assert.equal(armed.handoffNonce, prepared.review.approvalHandoffNonce);

    // Do not send resumeArmedCleanup: the onAdded wake must finish the one-click
    // transaction after popup loss, even though it arrived before arm settled.
    assert.equal(granted, true);
    await waitFor(() => chrome.__state.local[STORAGE_KEYS.activeJob]?.status === 'completed', 3_000);

    const job = chrome.__state.local[STORAGE_KEYS.activeJob];
    assert.equal(job.approvalHandoffNonce, prepared.review.approvalHandoffNonce);
    assert.equal(job.admissionPhase, 'admitted');
    assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
    assert.deepEqual(chrome.__state.originPermissions, new Set());
    assert.ok(chrome.__calls.some((call) => call.api === 'browsingData.remove'));
    assert.equal(
      chrome.__calls.some((call) => call.api === 'downloads.removeFile'),
      false
    );
    const requestedOrigins = chrome.__calls.find((call) => call.api === 'permissions.request').args[0].origins;
    assert.deepEqual(requestedOrigins, prepared.review.temporaryHostPermissionOrigins);
    await waitFor(() => chrome.__state.local[STORAGE_KEYS.activeReport]?.id === job.id, 3_000);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const latePopupContinuation = await dispatchTerminalResume(
      chrome,
      prepared.review.approvalHandoffNonce,
      sender,
      popupPreparationBinding(prepared)
    );
    assert.equal(latePopupContinuation.ok, true, latePopupContinuation.error);
    assert.equal(latePopupContinuation.resumedCompletedResult, true);
    assert.equal(latePopupContinuation.report.id, job.id);
  } finally {
    delete globalThis.chrome;
  }
});

test('a native grant arriving after armed review expiry is revoked and never creates a cleanup job', async () => {
  const now = new Date().toISOString();
  const chrome = await createChromeMock({
    incognitoAllowed: false,
    localState: {
      [STORAGE_KEYS.settings]: {
        ...DEFAULT_SETTINGS,
        cleanupMode: 'standard',
        progressOverlay: false,
        pageScriptScrub: false,
        temporaryDnrShield: false,
        verificationPass: false,
        deleteDownloadedFiles: false,
        createdAt: now,
        updatedAt: now,
        stabilityDefaultsAppliedAt: now,
        performanceDefaultsAppliedAt: now,
        privacyDefaultsAppliedAt: now
      }
    }
  });
  const originalDateNow = Date.now;
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?late-expired-grant=${Date.now()}`);
    await waitFor(() => chrome.__state.alarms.has('sitewipe.maintenance'));
    const sender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('popup/popup.html'),
      documentId: 'popup-document-expiry-a'
    };
    const prepared = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.prepareCleanupReview,
        payload: { input: 'example.com', sourceWindowId: 1, sourceIncognito: false }
      },
      sender
    );
    assert.equal(prepared.ok, true, prepared.error);
    const armed = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.armCleanupApproval,
        payload: {
          approvalToken: prepared.review.approvalToken,
          handoffNonce: prepared.review.approvalHandoffNonce,
          approval: completeApproval(),
          ...popupPreparationBinding(prepared),
          sourceWindowId: 1,
          sourceIncognito: false
        }
      },
      sender
    );
    assert.equal(armed.ok, true, armed.error);

    const expiredNow = Date.parse(prepared.review.expiresAt) + 1;
    Date.now = () => expiredNow;
    // Model Chrome's exact grant becoming observable after expiry without a
    // usable permission-event wake. The authenticated popup replay must return
    // proof of cancellation/release rather than an error string that guesses
    // whether cleanup started.
    for (const origin of prepared.review.temporaryHostPermissionOrigins) {
      chrome.__state.originPermissions.add(origin);
    }
    const expiredResume = await dispatchTerminalResume(
      chrome,
      prepared.review.approvalHandoffNonce,
      sender,
      popupPreparationBinding(prepared)
    );
    assert.equal(expiredResume.ok, true, expiredResume.error);
    // The arm-scheduled queue may finish the exact release before this explicit
    // continuation drains. Once that transient proof is consumed, the later
    // response must stay conservative instead of inferring release from absent
    // state alone.
    assert.equal(expiredResume.approvalHandoffUncertain, true, JSON.stringify(expiredResume));
    assert.equal(expiredResume.approvalHandoffNonce, prepared.review.approvalHandoffNonce);
    assert.equal(expiredResume.cleanupStarted, null);
    assert.equal(expiredResume.temporaryAccessReleased, null);
    assert.doesNotMatch(expiredResume.warning, /No cleanup started/i);

    assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
    assert.deepEqual(chrome.__state.originPermissions, new Set());
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeReport], undefined);
    assert.equal(cleanupMutationCallCount(chrome), 0, 'no cleanup mutation may run in this path');
    assert.equal(
      chrome.__calls.some((call) => call.api === 'downloads.removeFile'),
      false
    );
  } finally {
    Date.now = originalDateNow;
    delete globalThis.chrome;
  }
});

test('same-nonce popup continuations share one in-flight conclusive expiry settlement', async () => {
  const now = new Date().toISOString();
  const chrome = await createChromeMock({
    incognitoAllowed: false,
    localState: {
      [STORAGE_KEYS.settings]: {
        ...DEFAULT_SETTINGS,
        cleanupMode: 'standard',
        progressOverlay: false,
        pageScriptScrub: false,
        temporaryDnrShield: false,
        verificationPass: false,
        deleteDownloadedFiles: false,
        createdAt: now,
        updatedAt: now,
        stabilityDefaultsAppliedAt: now,
        performanceDefaultsAppliedAt: now,
        privacyDefaultsAppliedAt: now
      }
    }
  });
  const originalDateNow = Date.now;
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?shared-expiry-settlement=${Date.now()}`);
    await waitFor(() => chrome.__state.alarms.has('sitewipe.maintenance'));
    // Let the load-readiness wake-only pass drain before creating the review;
    // this case isolates two authenticated explicit-nonce continuations.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const sender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('popup/popup.html'),
      documentId: 'popup-document-shared-expiry-settlement'
    };
    const prepared = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.prepareCleanupReview,
        payload: { input: 'example.com', sourceWindowId: 1, sourceIncognito: false }
      },
      sender
    );
    assert.equal(prepared.ok, true, prepared.error);

    const approvalTimer = suppressNextUndelayedTimeout();
    let armed;
    try {
      armed = await dispatchRuntimeMessage(
        chrome,
        {
          type: MESSAGE_TYPES.armCleanupApproval,
          payload: {
            approvalToken: prepared.review.approvalToken,
            handoffNonce: prepared.review.approvalHandoffNonce,
            approval: completeApproval(),
            ...popupPreparationBinding(prepared),
            sourceWindowId: 1,
            sourceIncognito: false
          }
        },
        sender
      );
    } finally {
      approvalTimer.restore();
    }
    assert.equal(approvalTimer.suppressed(), true, 'the synthetic arm wake must be held for deterministic ordering');
    assert.equal(armed.ok, true, armed.error);

    const containsBefore = chrome.__calls.filter((call) => call.api === 'permissions.contains').length;
    const firstResume = dispatchTerminalResume(
      chrome,
      prepared.review.approvalHandoffNonce,
      sender,
      popupPreparationBinding(prepared)
    );
    await waitFor(
      () => chrome.__calls.filter((call) => call.api === 'permissions.contains').length > containsBefore,
      3_000
    );
    const secondResume = dispatchTerminalResume(
      chrome,
      prepared.review.approvalHandoffNonce,
      sender,
      popupPreparationBinding(prepared)
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    Date.now = () => Date.parse(prepared.review.expiresAt) + 1;
    for (const origin of prepared.review.temporaryHostPermissionOrigins) {
      chrome.__state.originPermissions.add(origin);
    }

    const responses = await Promise.all([firstResume, secondResume]);
    for (const response of responses) {
      assert.equal(response.ok, true, response.error);
      assert.equal(response.approvalHandoffCanceled, true, JSON.stringify(responses));
      assert.equal(response.approvalHandoffNonce, prepared.review.approvalHandoffNonce);
      assert.equal(response.cleanupStarted, false);
      assert.equal(response.temporaryAccessReleased, true);
      assert.equal(response.settlement.released, true);
      assert.equal(response.settlement.accessRemains, false);
      assert.equal(response.settlement.recordRetained, false);
    }
    assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
    assert.deepEqual(chrome.__state.originPermissions, new Set());
    assert.equal(cleanupMutationCallCount(chrome), 0);
  } finally {
    Date.now = originalDateNow;
    delete globalThis.chrome;
  }
});

test('same-nonce uncertainty does not consume a later actionable grant retry', async () => {
  const now = new Date().toISOString();
  const chrome = await createChromeMock({
    incognitoAllowed: false,
    localState: {
      [STORAGE_KEYS.settings]: {
        ...DEFAULT_SETTINGS,
        cleanupMode: 'standard',
        progressOverlay: false,
        pageScriptScrub: false,
        temporaryDnrShield: false,
        verificationPass: false,
        deleteDownloadedFiles: false,
        createdAt: now,
        updatedAt: now,
        stabilityDefaultsAppliedAt: now,
        performanceDefaultsAppliedAt: now,
        privacyDefaultsAppliedAt: now
      }
    }
  });
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?uncertain-retry=${Date.now()}`);
    await waitFor(() => chrome.__state.alarms.has('sitewipe.maintenance'));
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const sender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('popup/popup.html'),
      documentId: 'popup-document-uncertain-retry'
    };
    const prepared = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.prepareCleanupReview,
        payload: { input: 'example.com', sourceWindowId: 1, sourceIncognito: false }
      },
      sender
    );
    assert.equal(prepared.ok, true, prepared.error);

    const approvalTimer = suppressNextUndelayedTimeout();
    let armed;
    try {
      armed = await dispatchRuntimeMessage(
        chrome,
        {
          type: MESSAGE_TYPES.armCleanupApproval,
          payload: {
            approvalToken: prepared.review.approvalToken,
            handoffNonce: prepared.review.approvalHandoffNonce,
            approval: completeApproval(),
            ...popupPreparationBinding(prepared),
            sourceWindowId: 1,
            sourceIncognito: false
          }
        },
        sender
      );
    } finally {
      approvalTimer.restore();
    }
    assert.equal(approvalTimer.suppressed(), true, 'the synthetic arm wake must be held for deterministic ordering');
    assert.equal(armed.ok, true, armed.error);

    const containsBefore = chrome.__calls.filter((call) => call.api === 'permissions.contains').length;
    const firstResume = dispatchTerminalResume(
      chrome,
      prepared.review.approvalHandoffNonce,
      sender,
      popupPreparationBinding(prepared)
    );
    await waitFor(
      () => chrome.__calls.filter((call) => call.api === 'permissions.contains').length > containsBefore,
      3_000
    );
    const secondResume = dispatchTerminalResume(
      chrome,
      prepared.review.approvalHandoffNonce,
      sender,
      popupPreparationBinding(prepared)
    );

    const firstResponse = await firstResume;
    assert.equal(firstResponse.ok, true, firstResponse.error);
    assert.equal(firstResponse.approvalHandoffUncertain, true, JSON.stringify(firstResponse));
    assert.equal(firstResponse.cleanupStarted, null);
    assert.equal(firstResponse.temporaryAccessReleased, null);
    assert.doesNotMatch(firstResponse.warning, /No cleanup started/i);

    for (const origin of prepared.review.temporaryHostPermissionOrigins) {
      chrome.__state.originPermissions.add(origin);
    }
    const secondResponse = await secondResume;
    assert.equal(secondResponse.ok, true, secondResponse.error);
    assert.equal(secondResponse.approvalHandoffNonce, prepared.review.approvalHandoffNonce);
    assert.ok(
      secondResponse.report,
      `the later same-nonce signal must run a fresh actionable pass: ${JSON.stringify({ firstResponse, secondResponse })}`
    );
    assert.equal(secondResponse.report.status, 'completed');
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob].status, 'completed');
    assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
    assert.deepEqual(chrome.__state.originPermissions, new Set());
    assert.ok(cleanupMutationCallCount(chrome) > 0);
    assert.equal(
      chrome.__calls.some((call) => call.api === 'downloads.removeFile'),
      false
    );
  } finally {
    delete globalThis.chrome;
  }
});

test('a grant emitted before an expired first arm is tombstoned is immediately revoked without cleanup', async () => {
  const now = new Date().toISOString();
  const chrome = await createChromeMock({
    incognitoAllowed: false,
    localState: {
      [STORAGE_KEYS.settings]: {
        ...DEFAULT_SETTINGS,
        cleanupMode: 'standard',
        progressOverlay: false,
        pageScriptScrub: false,
        temporaryDnrShield: false,
        verificationPass: false,
        deleteDownloadedFiles: false,
        createdAt: now,
        updatedAt: now,
        stabilityDefaultsAppliedAt: now,
        performanceDefaultsAppliedAt: now,
        privacyDefaultsAppliedAt: now
      }
    }
  });
  const originalDateNow = Date.now;
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?expired-first-arm=${Date.now()}`);
    await waitFor(() => chrome.__state.alarms.has('sitewipe.maintenance'));
    const sender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('popup/popup.html'),
      documentId: 'popup-document-expired-first-arm'
    };
    const prepared = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.prepareCleanupReview,
        payload: { input: 'example.com', sourceWindowId: 1, sourceIncognito: false }
      },
      sender
    );
    assert.equal(prepared.ok, true, prepared.error);

    // Chrome settles the native request and emits its sole onAdded wake while
    // the worker still has only the prepared review. The worker then first
    // observes the arm after the review deadline.
    assert.equal(await chrome.permissions.request({ origins: prepared.review.temporaryHostPermissionOrigins }), true);
    Date.now = () => Date.parse(prepared.review.expiresAt) + 1;
    const expiredArm = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.armCleanupApproval,
        payload: {
          approvalToken: prepared.review.approvalToken,
          handoffNonce: prepared.review.approvalHandoffNonce,
          approval: completeApproval(),
          ...popupPreparationBinding(prepared),
          sourceWindowId: 1,
          sourceIncognito: false
        }
      },
      sender
    );
    assert.equal(expiredArm.ok, false);
    assert.match(expiredArm.error, /expired/i);

    await waitFor(
      () =>
        chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY] === undefined &&
        chrome.__state.local[STORAGE_KEYS.permissionLease] === undefined &&
        chrome.__state.originPermissions.size === 0,
      3_000
    );
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeReport], undefined);
    assert.equal(
      chrome.__calls.some((call) => call.api === 'browsingData.remove' || call.api === 'downloads.removeFile'),
      false
    );
  } finally {
    Date.now = originalDateNow;
    delete globalThis.chrome;
  }
});

test('replacement preparation cannot overwrite an expired prompt-pending review before its late grant settles', async () => {
  const originalDateNow = Date.now;
  const initialNowMs = Date.parse('2026-08-21T18:00:00.000Z');
  Date.now = () => initialNowMs;
  const now = new Date(initialNowMs).toISOString();
  const chrome = await createChromeMock({
    incognitoAllowed: false,
    localState: {
      [STORAGE_KEYS.settings]: {
        ...DEFAULT_SETTINGS,
        cleanupMode: 'standard',
        progressOverlay: false,
        pageScriptScrub: false,
        temporaryDnrShield: false,
        verificationPass: false,
        deleteDownloadedFiles: false,
        createdAt: now,
        updatedAt: now,
        stabilityDefaultsAppliedAt: now,
        performanceDefaultsAppliedAt: now,
        privacyDefaultsAppliedAt: now
      }
    }
  });
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?expired-replacement-prompt=${initialNowMs}`);
    await waitFor(() => chrome.__state.alarms.has('sitewipe.maintenance'));
    const preparingSender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('popup/popup.html'),
      documentId: 'popup-document-expired-replacement-a'
    };
    const replacementSender = {
      ...preparingSender,
      documentId: 'popup-document-expired-replacement-b'
    };
    const prepared = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.prepareCleanupReview,
        payload: { input: 'example.com', sourceWindowId: 1, sourceIncognito: false }
      },
      preparingSender
    );
    assert.equal(prepared.ok, true, prepared.error);
    const originalLeaseId = prepared.review.permissionLeaseId;

    Date.now = () => Date.parse(prepared.review.expiresAt) + 1;
    const replacement = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.prepareCleanupReview,
        payload: { input: 'replacement.example', sourceWindowId: 1, sourceIncognito: false }
      },
      replacementSender
    );
    assert.equal(replacement.ok, false);
    assert.match(replacement.error, /prompt is still being reconciled/i);
    const retained = normalizeCleanupReviewRecord(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY]);
    assert.equal(retained?.token, prepared.review.approvalToken);
    assert.equal(retained?.approvalHandoff?.status, 'prompt_tombstone');
    assert.equal(retained?.approvalHandoff?.promptContextId, prepared.popupContextId);
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease]?.id, originalLeaseId);

    const lateArm = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.armCleanupApproval,
        payload: {
          approvalToken: prepared.review.approvalToken,
          handoffNonce: prepared.review.approvalHandoffNonce,
          approval: completeApproval(),
          ...popupPreparationBinding(prepared),
          sourceWindowId: 1,
          sourceIncognito: false
        }
      },
      preparingSender
    );
    assert.equal(lateArm.ok, false);
    assert.equal(await chrome.permissions.request({ origins: prepared.review.temporaryHostPermissionOrigins }), true);
    await waitFor(
      () =>
        chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY] === undefined &&
        chrome.__state.local[STORAGE_KEYS.permissionLease] === undefined &&
        chrome.__state.originPermissions.size === 0,
      3_000
    );
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
    assert.equal(
      chrome.__calls.some((call) => call.api === 'browsingData.remove' || call.api === 'downloads.removeFile'),
      false
    );
  } finally {
    Date.now = originalDateNow;
    delete globalThis.chrome;
  }
});

test('same-context retry rotates popup authority and a missing-access review never transfers cross-context', async () => {
  const now = new Date().toISOString();
  const chrome = await createChromeMock({
    incognitoAllowed: false,
    runtimeContexts: [createChromeActionPopupContext({ contextId: 'popup-context-plain-review-a' })],
    localState: {
      [STORAGE_KEYS.settings]: {
        ...DEFAULT_SETTINGS,
        cleanupMode: 'standard',
        skipCleanupReview: true,
        progressOverlay: false,
        pageScriptScrub: false,
        temporaryDnrShield: false,
        verificationPass: false,
        deleteDownloadedFiles: false,
        createdAt: now,
        updatedAt: now,
        stabilityDefaultsAppliedAt: now,
        performanceDefaultsAppliedAt: now,
        privacyDefaultsAppliedAt: now
      }
    }
  });
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?plain-review-rebind=${Date.now()}`);
    await waitFor(() => chrome.__state.alarms.has('sitewipe.maintenance'));
    const preparingSender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('popup/popup.html')
    };
    const prepare = () =>
      dispatchRuntimeMessage(
        chrome,
        {
          type: MESSAGE_TYPES.prepareCleanupReview,
          payload: { input: 'example.com', sourceWindowId: 1, sourceIncognito: false }
        },
        preparingSender
      );
    const cancel = (prepared) =>
      dispatchRuntimeMessage(
        chrome,
        {
          type: MESSAGE_TYPES.cancelCleanupReview,
          payload: {
            approvalToken: prepared.review.approvalToken,
            ...popupPreparationBinding(prepared),
            promptNotStarted: true
          }
        },
        preparingSender
      );

    const first = await prepare();
    assert.equal(first.ok, true, first.error);
    assert.equal(first.review.approvalMode, 'settings_direct');
    assert.equal(first.popupContextId, 'popup-context-plain-review-a');
    assert.match(first.popupPreparationCapability, /^[a-f0-9]{64}$/);
    const firstRecord = normalizeCleanupReviewRecord(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY]);
    assert.equal(firstRecord.preparationContextId, first.popupContextId);
    assert.match(firstRecord.popupPreparationCapabilityDigest, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(firstRecord).includes(first.popupPreparationCapability), false);
    const firstCancel = await cancel(first);
    assert.equal(firstCancel.ok, true, firstCancel.error);
    assert.equal(firstCancel.promptTombstoneRetained, undefined);
    assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);

    const optionsSender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('options/options.html'),
      documentId: 'options-document-after-direct-cancel'
    };
    const savedAfterPopupOpenedSettings = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.saveSettings,
        payload: { settings: { reducedMotion: true } }
      },
      optionsSender
    );
    assert.equal(savedAfterPopupOpenedSettings.ok, true, savedAfterPopupOpenedSettings.error);
    assert.equal(savedAfterPopupOpenedSettings.settings.skipCleanupReview, true);
    const freshAfterSettings = await prepare();
    assert.equal(freshAfterSettings.ok, true, freshAfterSettings.error);
    assert.notEqual(freshAfterSettings.review.approvalToken, first.review.approvalToken);
    const freshAfterSettingsCancel = await cancel(freshAfterSettings);
    assert.equal(freshAfterSettingsCancel.ok, true, freshAfterSettingsCancel.error);
    assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);

    const second = await prepare();
    assert.equal(second.ok, true, second.error);
    const sameContextRetry = await prepare();
    assert.equal(sameContextRetry.ok, true, sameContextRetry.error);
    assert.equal(sameContextRetry.resumed, true);
    assert.equal(sameContextRetry.review.approvalToken, second.review.approvalToken);
    assert.notEqual(sameContextRetry.popupPreparationCapability, second.popupPreparationCapability);
    const staleCapabilityCancel = await cancel(second);
    assert.equal(staleCapabilityCancel.ok, false);
    assert.match(staleCapabilityCancel.error, /no longer owns/i);
    const rotatedCapabilityCancel = await cancel(sameContextRetry);
    assert.equal(rotatedCapabilityCancel.ok, true, rotatedCapabilityCancel.error);
    assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);

    const third = await prepare();
    assert.equal(third.ok, true, third.error);
    chrome.__state.runtimeContexts.splice(
      0,
      1,
      createChromeActionPopupContext({ contextId: 'opaque popup/context #B' })
    );
    const crossContextRetry = await prepare();
    assert.equal(crossContextRetry.ok, false);
    assert.match(crossContextRetry.error, /closed before settlement|restart the browser/i);
    const retainedTombstone = normalizeCleanupReviewRecord(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY]);
    assert.equal(retainedTombstone?.preparationContextId, third.popupContextId);
    assert.equal(retainedTombstone?.approvalHandoff?.status, 'prompt_tombstone');
    assert.equal(retainedTombstone?.approvalHandoff?.promptContextId, third.popupContextId);
    assert.deepEqual(chrome.__calls.findLast((call) => call.api === 'runtime.getContexts')?.args[0], {
      contextIds: [third.popupContextId]
    });
    assert.equal(await chrome.permissions.request({ origins: third.review.temporaryHostPermissionOrigins }), true);
    await waitFor(
      () =>
        chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY] === undefined &&
        chrome.__state.local[STORAGE_KEYS.permissionLease] === undefined &&
        chrome.__state.originPermissions.size === 0,
      3_000
    );
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
    assert.equal(
      chrome.__calls.some((call) => call.api === 'browsingData.remove' || call.api === 'downloads.removeFile'),
      false
    );
  } finally {
    delete globalThis.chrome;
  }
});

test('a rebound pre-granted review rejects stale and non-popup cleanup messages before one exact popup run', async () => {
  const now = new Date().toISOString();
  const chrome = await createChromeMock({
    originPermissions: ['<all_urls>'],
    runtimeContexts: [createChromeActionPopupContext({ contextId: 'pregranted-popup-context-a' })],
    localState: {
      [STORAGE_KEYS.settings]: {
        ...DEFAULT_SETTINGS,
        cleanupMode: 'standard',
        skipCleanupReview: true,
        progressOverlay: false,
        pageScriptScrub: false,
        temporaryDnrShield: false,
        verificationPass: false,
        aggressiveCookieSweep: false,
        deleteDownloadedFiles: false,
        redactReports: true,
        keepHistory: false,
        createdAt: now,
        updatedAt: now,
        stabilityDefaultsAppliedAt: now,
        performanceDefaultsAppliedAt: now,
        privacyDefaultsAppliedAt: now
      }
    }
  });
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?pregranted-popup-rebind=${Date.now()}`);
    await waitFor(() => chrome.__state.alarms.has('sitewipe.maintenance'));
    const popupSender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('popup/popup.html')
    };
    const prepare = () =>
      dispatchRuntimeMessage(
        chrome,
        {
          type: MESSAGE_TYPES.prepareCleanupReview,
          payload: { input: 'example.com', sourceWindowId: 1, sourceIncognito: false }
        },
        popupSender
      );
    const approval = {
      approvalMode: 'settings_direct',
      reviewedScope: false,
      associatedTargets: false,
      localOrIpTarget: false,
      protectedWebOrigins: false,
      fileConfirmationText: ''
    };
    const runMessage = (prepared, patch = {}) => ({
      type: MESSAGE_TYPES.runDeepClean,
      payload: {
        approvalToken: prepared.review.approvalToken,
        sourceWindowId: 1,
        sourceIncognito: false,
        approval,
        ...popupPreparationBinding(prepared),
        ...patch
      }
    });

    const preparedA = await prepare();
    assert.equal(preparedA.ok, true, preparedA.error);
    assert.equal(preparedA.review.hostPermissionsGranted, true);
    chrome.__state.runtimeContexts.splice(
      0,
      1,
      createChromeActionPopupContext({ contextId: 'pregranted-popup-context-b' })
    );
    const preparedB = await prepare();
    assert.equal(preparedB.ok, true, preparedB.error);
    assert.equal(preparedB.resumed, true);
    assert.equal(preparedB.review.approvalToken, preparedA.review.approvalToken);
    assert.equal(preparedB.popupContextId, 'pregranted-popup-context-b');
    assert.notEqual(preparedB.popupPreparationCapability, preparedA.popupPreparationCapability);

    const reboundRecord = structuredClone(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY]);
    const browsingMutationsBefore = chrome.__calls.filter((call) => call.api === 'browsingData.remove').length;
    const rejectedAttempts = [
      ['stale popup authority', runMessage(preparedA), popupSender, /no longer owns/i],
      [
        'wrong capability',
        runMessage(preparedB, { popupPreparationCapability: '0'.repeat(64) }),
        popupSender,
        /no longer owns/i
      ],
      [
        'missing capability',
        (() => {
          const message = runMessage(preparedB);
          delete message.payload.popupPreparationCapability;
          return message;
        })(),
        popupSender,
        /popupPreparationCapability is invalid/i
      ],
      [
        'payload-selected internal bypass',
        runMessage(preparedB, { expectedApprovalHandoffNonce: 'a'.repeat(48) }),
        popupSender,
        /Unexpected payload field/i
      ],
      [
        'options sender',
        runMessage(preparedB),
        { id: chrome.runtime.id, documentUrl: chrome.runtime.getURL('options/options.html') },
        /only the exact SiteWipe popup/i
      ],
      [
        'side-panel sender',
        runMessage(preparedB),
        { id: chrome.runtime.id, documentUrl: chrome.runtime.getURL('sidepanel/sidepanel.html') },
        /only the exact SiteWipe popup/i
      ],
      [
        'tab-shaped popup sender',
        runMessage(preparedB),
        { ...popupSender, tab: { id: 7 } },
        /only the exact SiteWipe popup/i
      ]
    ];
    for (const [label, message, sender, expectedError] of rejectedAttempts) {
      const rejected = await dispatchRuntimeMessage(chrome, message, sender);
      assert.equal(rejected.ok, false, label);
      assert.match(rejected.error, expectedError, label);
      assert.deepEqual(
        chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY],
        reboundRecord,
        `${label} consumed authority`
      );
      assert.equal(
        chrome.__calls.filter((call) => call.api === 'browsingData.remove').length,
        browsingMutationsBefore,
        `${label} reached browser cleanup`
      );
    }

    const originalSessionGet = chrome.storage.session.get;
    const concurrentlyRotatedDigest = await digestCleanupPopupPreparationCapability('e'.repeat(64));
    let rotateAfterExternalPrecheck = true;
    chrome.storage.session.get = async (keys) => {
      const snapshot = await originalSessionGet(keys);
      if (
        rotateAfterExternalPrecheck &&
        Array.isArray(keys) &&
        keys.length === 1 &&
        keys[0] === CLEANUP_REVIEW_STORAGE_KEY
      ) {
        rotateAfterExternalPrecheck = false;
        chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY] = {
          ...chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY],
          popupPreparationCapabilityDigest: concurrentlyRotatedDigest
        };
      }
      return snapshot;
    };
    const raced = await dispatchRuntimeMessage(chrome, runMessage(preparedB), popupSender);
    chrome.storage.session.get = originalSessionGet;
    assert.equal(raced.ok, false);
    assert.match(raced.error, /no longer owns/i);
    assert.equal(
      chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY].popupPreparationCapabilityDigest,
      concurrentlyRotatedDigest,
      'the atomic consume check must retain concurrently rotated authority'
    );
    assert.equal(chrome.__calls.filter((call) => call.api === 'browsingData.remove').length, browsingMutationsBefore);

    const preparedAfterRace = await prepare();
    assert.equal(preparedAfterRace.ok, true, preparedAfterRace.error);
    assert.equal(preparedAfterRace.review.approvalToken, preparedB.review.approvalToken);
    assert.notEqual(preparedAfterRace.popupPreparationCapability, preparedB.popupPreparationCapability);
    const completed = await dispatchRuntimeMessage(chrome, runMessage(preparedAfterRace), popupSender);
    assert.equal(completed.ok, true, completed.error);
    assert.equal(completed.report.status, 'completed');
    assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
    const browsingMutationsAfter = chrome.__calls.filter((call) => call.api === 'browsingData.remove').length;
    assert.ok(browsingMutationsAfter > browsingMutationsBefore);
    const terminalJobId = chrome.__state.local[STORAGE_KEYS.activeJob].id;

    const replay = await dispatchRuntimeMessage(chrome, runMessage(preparedAfterRace), popupSender);
    assert.equal(replay.ok, false);
    assert.match(replay.error, /missing, expired, or has already been used/i);
    assert.equal(replay.report, undefined);
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob].id, terminalJobId);
    assert.equal(chrome.__calls.filter((call) => call.api === 'browsingData.remove').length, browsingMutationsAfter);
  } finally {
    delete globalThis.chrome;
  }
});

test('a staged arm cannot resurrect authority across a concurrent cancellation', async () => {
  const now = new Date().toISOString();
  const chrome = await createChromeMock({
    incognitoAllowed: false,
    localState: {
      [STORAGE_KEYS.settings]: {
        ...DEFAULT_SETTINGS,
        cleanupMode: 'standard',
        progressOverlay: false,
        pageScriptScrub: false,
        temporaryDnrShield: false,
        verificationPass: false,
        deleteDownloadedFiles: false,
        createdAt: now,
        updatedAt: now,
        stabilityDefaultsAppliedAt: now,
        performanceDefaultsAppliedAt: now,
        privacyDefaultsAppliedAt: now
      }
    }
  });
  const releaseStageRead = deferred();
  const stageReadStarted = deferred();
  const originalSessionGet = chrome.storage.session.get;
  let holdNextReviewRead = false;
  chrome.storage.session.get = async (keys) => {
    if (holdNextReviewRead && Array.isArray(keys) && keys.length === 1 && keys[0] === CLEANUP_REVIEW_STORAGE_KEY) {
      holdNextReviewRead = false;
      stageReadStarted.resolve();
      await releaseStageRead.promise;
    }
    return originalSessionGet(keys);
  };

  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?staged-cancel-race=${Date.now()}`);
    await waitFor(() => chrome.__state.alarms.has('sitewipe.maintenance'));
    const initiatingSender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('popup/popup.html'),
      documentId: 'popup-document-staged-cancel-owner'
    };
    const cancelingSender = {
      ...initiatingSender,
      documentId: 'popup-document-staged-cancel-peer'
    };
    const prepared = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.prepareCleanupReview,
        payload: { input: 'example.com', sourceWindowId: 1, sourceIncognito: false }
      },
      initiatingSender
    );
    assert.equal(prepared.ok, true, prepared.error);
    assert.equal(await chrome.permissions.request({ origins: prepared.review.temporaryHostPermissionOrigins }), true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    holdNextReviewRead = true;
    const armPromise = dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.armCleanupApproval,
        payload: {
          approvalToken: prepared.review.approvalToken,
          handoffNonce: prepared.review.approvalHandoffNonce,
          approval: completeApproval(),
          ...popupPreparationBinding(prepared),
          sourceWindowId: 1,
          sourceIncognito: false
        }
      },
      initiatingSender
    );
    await stageReadStarted.promise;
    let cancelSettled = false;
    const cancelPromise = dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.cancelCleanupReview,
        payload: { approvalToken: prepared.review.approvalToken, ...popupPreparationBinding(prepared) }
      },
      cancelingSender
    ).then((response) => {
      cancelSettled = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(cancelSettled, false, 'cancellation must serialize behind the final-click marker transition');

    releaseStageRead.resolve();
    const [armed, canceled] = await Promise.all([armPromise, cancelPromise]);
    assert.equal(canceled.ok, true, canceled.error);
    assert.equal(canceled.canceled, true);
    assert.equal(armed.ok, false);
    await waitFor(
      () =>
        chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY] === undefined &&
        chrome.__state.local[STORAGE_KEYS.permissionLease] === undefined &&
        chrome.__state.originPermissions.size === 0,
      3_000
    );

    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
    assert.equal(
      chrome.__calls.some((call) => call.api === 'browsingData.remove' || call.api === 'downloads.removeFile'),
      false
    );
  } finally {
    releaseStageRead.resolve();
    delete globalThis.chrome;
  }
});

for (const invalidationBoundary of [
  {
    name: 'review read',
    install(chrome, started, release) {
      const original = chrome.storage.session.get;
      let held = false;
      chrome.storage.session.get = async (keys) => {
        if (!held && Array.isArray(keys) && keys.length === 1 && keys[0] === CLEANUP_REVIEW_STORAGE_KEY) {
          held = true;
          started.resolve();
          await release.promise;
        }
        return original(keys);
      };
    }
  },
  {
    name: 'session removal',
    promptNotStarted: true,
    install(chrome, started, release) {
      const original = chrome.storage.session.remove;
      let held = false;
      chrome.storage.session.remove = async (keys) => {
        if (!held && keys === CLEANUP_REVIEW_STORAGE_KEY) {
          held = true;
          started.resolve();
          await release.promise;
        }
        return original(keys);
      };
    }
  },
  {
    name: 'permission reconciliation',
    promptNotStarted: true,
    install(chrome, started, release) {
      const original = chrome.permissions.getAll;
      let held = false;
      chrome.permissions.getAll = async () => {
        if (!held) {
          held = true;
          started.resolve();
          await release.promise;
        }
        return original();
      };
    }
  }
]) {
  test(`an invalidator that reaches ${invalidationBoundary.name} first retains a later final-click prompt`, async () => {
    const now = new Date().toISOString();
    const chrome = await createChromeMock({
      incognitoAllowed: false,
      localState: {
        [STORAGE_KEYS.settings]: {
          ...DEFAULT_SETTINGS,
          cleanupMode: 'standard',
          progressOverlay: false,
          pageScriptScrub: false,
          temporaryDnrShield: false,
          verificationPass: false,
          deleteDownloadedFiles: false,
          createdAt: now,
          updatedAt: now,
          stabilityDefaultsAppliedAt: now,
          performanceDefaultsAppliedAt: now,
          privacyDefaultsAppliedAt: now
        }
      }
    });
    const invalidationStarted = deferred();
    const releaseInvalidation = deferred();
    globalThis.chrome = chrome;
    try {
      await import(
        `../../src/background/service-worker.js?invalidation-first-${invalidationBoundary.name.replaceAll(' ', '-')}-${Date.now()}`
      );
      await waitFor(() => chrome.__state.alarms.has('sitewipe.maintenance'));
      const initiatingSender = {
        id: chrome.runtime.id,
        documentUrl: chrome.runtime.getURL('popup/popup.html'),
        documentId: `popup-document-invalidation-first-${invalidationBoundary.name.replaceAll(' ', '-')}`
      };
      const prepared = await dispatchRuntimeMessage(
        chrome,
        {
          type: MESSAGE_TYPES.prepareCleanupReview,
          payload: { input: 'example.com', sourceWindowId: 1, sourceIncognito: false }
        },
        initiatingSender
      );
      assert.equal(prepared.ok, true, prepared.error);

      invalidationBoundary.install(chrome, invalidationStarted, releaseInvalidation);
      const cancelPromise = dispatchRuntimeMessage(
        chrome,
        {
          type: MESSAGE_TYPES.cancelCleanupReview,
          payload: {
            approvalToken: prepared.review.approvalToken,
            ...popupPreparationBinding(prepared),
            ...(invalidationBoundary.promptNotStarted ? { promptNotStarted: true } : {})
          }
        },
        invalidationBoundary.promptNotStarted
          ? initiatingSender
          : { ...initiatingSender, documentId: `${initiatingSender.documentId}-cancel-peer` }
      );
      await invalidationStarted.promise;

      // The native request has been invoked but remains unresolved. Its arm
      // event reaches the worker while the earlier invalidator is suspended.
      const armPromise = dispatchRuntimeMessage(
        chrome,
        {
          type: MESSAGE_TYPES.armCleanupApproval,
          payload: {
            approvalToken: prepared.review.approvalToken,
            handoffNonce: prepared.review.approvalHandoffNonce,
            approval: completeApproval(),
            ...popupPreparationBinding(prepared),
            sourceWindowId: 1,
            sourceIncognito: false
          }
        },
        initiatingSender
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      releaseInvalidation.resolve();

      const [canceled, armed] = await Promise.all([cancelPromise, armPromise]);
      assert.equal(canceled.ok, true, canceled.error);
      assert.equal(canceled.canceled, true);
      assert.equal(canceled.promptTombstoneRetained, true);
      assert.equal(armed.ok, false);
      const tombstone = normalizeCleanupReviewRecord(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY]);
      assert.equal(tombstone?.approvalHandoff?.status, 'prompt_tombstone');
      assert.equal(tombstone?.approvalHandoff?.promptContextId, prepared.popupContextId);
      assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease]?.status, 'prompt_pending');

      // Chrome may resolve the original native prompt only after both worker
      // requests have ended. The restored exact lease must own and revoke it.
      assert.equal(await chrome.permissions.request({ origins: prepared.review.temporaryHostPermissionOrigins }), true);
      await waitFor(
        () =>
          chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY] === undefined &&
          chrome.__state.local[STORAGE_KEYS.permissionLease] === undefined &&
          chrome.__state.originPermissions.size === 0,
        3_000
      );
      assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
      assert.equal(chrome.__state.local[STORAGE_KEYS.activeReport], undefined);
      assert.equal(
        chrome.__calls.some((call) => call.api === 'browsingData.remove' || call.api === 'downloads.removeFile'),
        false
      );
    } finally {
      releaseInvalidation.resolve();
      delete globalThis.chrome;
    }
  });
}

test('only the initiating popup document can settle an armed native prompt and immediately revoke a late grant', async () => {
  const now = new Date().toISOString();
  const chrome = await createChromeMock({
    incognitoAllowed: false,
    localState: {
      [STORAGE_KEYS.settings]: {
        ...DEFAULT_SETTINGS,
        cleanupMode: 'standard',
        progressOverlay: false,
        pageScriptScrub: false,
        temporaryDnrShield: false,
        verificationPass: false,
        deleteDownloadedFiles: false,
        createdAt: now,
        updatedAt: now,
        stabilityDefaultsAppliedAt: now,
        performanceDefaultsAppliedAt: now,
        privacyDefaultsAppliedAt: now
      }
    }
  });
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?prompt-document-binding=${Date.now()}`);
    await waitFor(() => chrome.__state.alarms.has('sitewipe.maintenance'));
    const initiatingSender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('popup/popup.html'),
      documentId: 'popup-document-native-prompt-a'
    };
    const reopenedSender = {
      ...initiatingSender,
      documentId: 'popup-document-reopened-b'
    };
    const optionsSender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('options/options.html'),
      documentId: 'options-document-c'
    };
    const prepared = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.prepareCleanupReview,
        payload: { input: 'example.com', sourceWindowId: 1, sourceIncognito: false }
      },
      initiatingSender
    );
    assert.equal(prepared.ok, true, prepared.error);
    const armed = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.armCleanupApproval,
        payload: {
          approvalToken: prepared.review.approvalToken,
          handoffNonce: prepared.review.approvalHandoffNonce,
          approval: completeApproval(),
          ...popupPreparationBinding(prepared),
          sourceWindowId: 1,
          sourceIncognito: false
        }
      },
      initiatingSender
    );
    assert.equal(armed.ok, true, armed.error);

    const canceledFromReopenedPopup = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.cancelCleanupReview,
        payload: {
          approvalToken: prepared.review.approvalToken,
          popupContextId: prepared.popupContextId,
          popupPreparationCapability: '0'.repeat(64)
        }
      },
      reopenedSender
    );
    assert.equal(canceledFromReopenedPopup.ok, false);
    assert.match(canceledFromReopenedPopup.error, /no longer owns/i);

    const canceledByOwner = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.cancelCleanupReview,
        payload: {
          approvalToken: prepared.review.approvalToken,
          ...popupPreparationBinding(prepared)
        }
      },
      initiatingSender
    );
    assert.equal(canceledByOwner.ok, true, canceledByOwner.error);
    assert.equal(canceledByOwner.promptTombstoneRetained, true);

    const settlementPayload = {
      approvalToken: prepared.review.approvalToken,
      handoffNonce: prepared.review.approvalHandoffNonce,
      permissionLeaseId: prepared.review.permissionLeaseId,
      ...popupPreparationBinding(prepared),
      outcome: 'abandoned'
    };
    const reopenedSettlement = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.settleCleanupPermissionPrompt,
        payload: { ...settlementPayload, popupPreparationCapability: '0'.repeat(64) }
      },
      reopenedSender
    );
    assert.equal(reopenedSettlement.ok, false);
    assert.match(reopenedSettlement.error, /no longer owns/i);

    const optionsSettlement = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.settleCleanupPermissionPrompt, payload: settlementPayload },
      optionsSender
    );
    assert.equal(optionsSettlement.ok, false);
    assert.match(optionsSettlement.error, /only the exact SiteWipe popup/i);

    assert.equal(
      normalizeCleanupReviewRecord(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY]).approvalHandoff.status,
      'prompt_tombstone'
    );
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease].status, 'prompt_pending');

    // Model Chrome returning true after the sole permission event was missed by
    // the admission wake. The initiating popup's terminal settlement must be a
    // sufficient second signal: it releases the exact late grant and clears the
    // prompt-pending lease without waiting for maintenance.
    for (const origin of prepared.review.temporaryHostPermissionOrigins) {
      chrome.__state.originPermissions.add(origin);
    }
    assert.equal(chrome.__state.originPermissions.size, prepared.review.temporaryHostPermissionOrigins.length);

    const ownerSettlement = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.settleCleanupPermissionPrompt, payload: settlementPayload },
      initiatingSender
    );
    assert.equal(ownerSettlement.ok, true, ownerSettlement.error);
    assert.equal(ownerSettlement.settlement.released, true);
    assert.equal(ownerSettlement.settlement.recordRetained, false);
    assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);

    assert.deepEqual(chrome.__state.originPermissions, new Set());
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
    assert.equal(
      chrome.__calls.some((call) => call.api === 'browsingData.remove'),
      false
    );
    assert.equal(
      chrome.__calls.some((call) => call.api === 'downloads.removeFile'),
      false
    );
  } finally {
    delete globalThis.chrome;
  }
});

test('serialized armed-cleanup signals never cross-resolve distinct popup nonces', async () => {
  const now = new Date().toISOString();
  const chrome = await createChromeMock({
    incognitoAllowed: false,
    localState: {
      [STORAGE_KEYS.settings]: {
        ...DEFAULT_SETTINGS,
        cleanupMode: 'standard',
        progressOverlay: false,
        pageScriptScrub: false,
        temporaryDnrShield: false,
        verificationPass: false,
        deleteDownloadedFiles: false,
        createdAt: now,
        updatedAt: now,
        stabilityDefaultsAppliedAt: now,
        performanceDefaultsAppliedAt: now,
        privacyDefaultsAppliedAt: now
      }
    }
  });
  const cleanupStarted = deferred();
  const releaseCleanup = deferred();
  const originalBrowsingDataRemove = chrome.browsingData.remove;
  chrome.browsingData.remove = async (...args) => {
    cleanupStarted.resolve();
    await releaseCleanup.promise;
    return originalBrowsingDataRemove(...args);
  };
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?nonce-cohort-queue=${Date.now()}`);
    await waitFor(() => chrome.__state.alarms.has('sitewipe.maintenance'));
    const sender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('popup/popup.html'),
      documentId: 'popup-document-nonce-cohort'
    };
    const prepared = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.prepareCleanupReview,
        payload: { input: 'example.com', sourceWindowId: 1, sourceIncognito: false }
      },
      sender
    );
    assert.equal(prepared.ok, true, prepared.error);
    const armed = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.armCleanupApproval,
        payload: {
          approvalToken: prepared.review.approvalToken,
          handoffNonce: prepared.review.approvalHandoffNonce,
          approval: completeApproval(),
          ...popupPreparationBinding(prepared),
          sourceWindowId: 1,
          sourceIncognito: false
        }
      },
      sender
    );
    assert.equal(armed.ok, true, armed.error);

    assert.equal(await chrome.permissions.request({ origins: prepared.review.temporaryHostPermissionOrigins }), true);
    await cleanupStarted.promise;
    const wrongNonce = 'stale-popup-handoff-nonce';
    chrome.__events.permissionAdded.emit({ origins: prepared.review.temporaryHostPermissionOrigins });
    const wrongResumePromise = dispatchTerminalResume(chrome, wrongNonce, sender, popupPreparationBinding(prepared));
    const exactResumePromise = dispatchTerminalResume(
      chrome,
      prepared.review.approvalHandoffNonce,
      sender,
      popupPreparationBinding(prepared)
    );

    releaseCleanup.resolve();
    const [wrongResume, exactResume] = await Promise.all([wrongResumePromise, exactResumePromise]);
    assert.equal(wrongResume.ok, false);
    assert.equal(Object.hasOwn(wrongResume, 'report'), false);
    assert.equal(exactResume.ok, true, exactResume.error);
    assert.equal(exactResume.approvalHandoffNonce, prepared.review.approvalHandoffNonce);
    assert.equal(exactResume.report.id, chrome.__state.local[STORAGE_KEYS.activeJob].id);
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob].status, 'completed');
    assert.equal(
      chrome.__calls.filter((call) => call.api === 'browsingData.remove').length,
      2,
      'queue tail passes must recover the durable result without running cleanup again'
    );
  } finally {
    releaseCleanup.resolve();
    delete globalThis.chrome;
  }
});

test('a stale explicit nonce queued before the sole grant wake cannot consume the valid armed cleanup', async () => {
  const now = new Date().toISOString();
  const chrome = await createChromeMock({
    incognitoAllowed: false,
    localState: {
      [STORAGE_KEYS.settings]: {
        ...DEFAULT_SETTINGS,
        cleanupMode: 'standard',
        progressOverlay: false,
        pageScriptScrub: false,
        temporaryDnrShield: false,
        verificationPass: false,
        deleteDownloadedFiles: false,
        createdAt: now,
        updatedAt: now,
        stabilityDefaultsAppliedAt: now,
        performanceDefaultsAppliedAt: now,
        privacyDefaultsAppliedAt: now
      }
    }
  });
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?stale-before-grant-wake=${Date.now()}`);
    await waitFor(() => chrome.__state.alarms.has('sitewipe.maintenance'));
    const sender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('popup/popup.html'),
      documentId: 'popup-document-stale-before-wake'
    };
    const prepared = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.prepareCleanupReview,
        payload: { input: 'example.com', sourceWindowId: 1, sourceIncognito: false }
      },
      sender
    );
    assert.equal(prepared.ok, true, prepared.error);
    const armed = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.armCleanupApproval,
        payload: {
          approvalToken: prepared.review.approvalToken,
          handoffNonce: prepared.review.approvalHandoffNonce,
          approval: completeApproval(),
          ...popupPreparationBinding(prepared),
          sourceWindowId: 1,
          sourceIncognito: false
        }
      },
      sender
    );
    assert.equal(armed.ok, true, armed.error);
    await new Promise((resolve) => setTimeout(resolve, 2_100));

    const staleResumePromise = dispatchTerminalResume(
      chrome,
      'different-popup-handoff-nonce',
      sender,
      popupPreparationBinding(prepared)
    );
    for (const origin of prepared.review.temporaryHostPermissionOrigins) {
      chrome.__state.originPermissions.add(origin);
    }
    chrome.__events.permissionAdded.emit({ origins: prepared.review.temporaryHostPermissionOrigins });

    const staleResume = await staleResumePromise;
    assert.equal(staleResume.ok, false);
    assert.equal(Object.hasOwn(staleResume, 'report'), false);
    await waitFor(() => chrome.__state.local[STORAGE_KEYS.activeJob]?.status === 'completed', 3_000);
    assert.equal(
      chrome.__state.local[STORAGE_KEYS.activeJob].approvalHandoffNonce,
      prepared.review.approvalHandoffNonce
    );
    assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
    assert.deepEqual(chrome.__state.originPermissions, new Set());
    assert.equal(chrome.__calls.filter((call) => call.api === 'browsingData.remove').length, 2);
  } finally {
    delete globalThis.chrome;
  }
});

for (const scenario of [
  { name: 'broad replacement', origins: ['<all_urls>'], preserved: ['<all_urls>'] },
  {
    name: 'partial exact plus broad replacement',
    origins: ['<all_urls>', 'https://example.com/*'],
    preserved: ['<all_urls>']
  },
  {
    name: 'unrelated-only replacement',
    origins: ['https://unrelated.example/*'],
    preserved: ['https://unrelated.example/*']
  }
]) {
  test(`armed admission rejects ${scenario.name} swapped in after the ready inventory proof`, async () => {
    const now = new Date().toISOString();
    const chrome = await createChromeMock({
      incognitoAllowed: false,
      localState: {
        [STORAGE_KEYS.settings]: {
          ...DEFAULT_SETTINGS,
          cleanupMode: 'standard',
          progressOverlay: false,
          pageScriptScrub: false,
          temporaryDnrShield: false,
          verificationPass: false,
          deleteDownloadedFiles: false,
          createdAt: now,
          updatedAt: now,
          stabilityDefaultsAppliedAt: now,
          performanceDefaultsAppliedAt: now,
          privacyDefaultsAppliedAt: now
        }
      }
    });
    globalThis.chrome = chrome;
    try {
      await import(`../../src/background/service-worker.js?permission-inventory-swap-${scenario.name}=${Date.now()}`);
      await waitFor(() => chrome.__state.alarms.has('sitewipe.maintenance'));
      const sender = {
        id: chrome.runtime.id,
        documentUrl: chrome.runtime.getURL('popup/popup.html'),
        documentId: `popup-document-inventory-${scenario.name.replaceAll(' ', '-')}`
      };
      const prepared = await dispatchRuntimeMessage(
        chrome,
        {
          type: MESSAGE_TYPES.prepareCleanupReview,
          payload: { input: 'example.com', sourceWindowId: 1, sourceIncognito: false }
        },
        sender
      );
      assert.equal(prepared.ok, true, prepared.error);
      const armed = await dispatchRuntimeMessage(
        chrome,
        {
          type: MESSAGE_TYPES.armCleanupApproval,
          payload: {
            approvalToken: prepared.review.approvalToken,
            handoffNonce: prepared.review.approvalHandoffNonce,
            approval: completeApproval(),
            ...popupPreparationBinding(prepared),
            sourceWindowId: 1,
            sourceIncognito: false
          }
        },
        sender
      );
      assert.equal(armed.ok, true, armed.error);

      // Let the arm-only wake exhaust its no-grant retries, then seed the exact
      // grant without emitting onAdded so this explicit resume owns one
      // deterministic ready->consume pass.
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      for (const origin of prepared.review.temporaryHostPermissionOrigins) {
        chrome.__state.originPermissions.add(origin);
      }
      const originalPermissionsGetAll = chrome.permissions.getAll;
      let readyInventoryProved = false;
      chrome.permissions.getAll = async (...args) => {
        const snapshot = await originalPermissionsGetAll(...args);
        if (prepared.review.temporaryHostPermissionOrigins.every((origin) => snapshot.origins.includes(origin))) {
          readyInventoryProved = true;
        }
        return snapshot;
      };
      const originalSessionGet = chrome.storage.session.get;
      let inventorySwapped = false;
      chrome.storage.session.get = async (keys) => {
        const result = await originalSessionGet(keys);
        if (
          !inventorySwapped &&
          readyInventoryProved &&
          Array.isArray(keys) &&
          keys.length === 1 &&
          keys[0] === CLEANUP_REVIEW_STORAGE_KEY
        ) {
          inventorySwapped = true;
          chrome.__state.originPermissions.clear();
          for (const origin of scenario.origins) chrome.__state.originPermissions.add(origin);
        }
        return result;
      };

      const resumed = await dispatchTerminalResume(
        chrome,
        prepared.review.approvalHandoffNonce,
        sender,
        popupPreparationBinding(prepared)
      );
      assert.equal(resumed.ok, false);
      assert.match(resumed.error, /exact preflight-bound|target access changed/i);
      assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
      assert.equal(chrome.__state.local[STORAGE_KEYS.activeReport], undefined);
      assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
      assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
      assert.deepEqual(chrome.__state.originPermissions, new Set(scenario.preserved));
      assert.equal(
        chrome.__calls.some((call) => call.api === 'browsingData.remove'),
        false
      );
      assert.equal(
        chrome.__calls.some((call) => call.api === 'downloads.removeFile'),
        false
      );
    } finally {
      delete globalThis.chrome;
    }
  });
}

test('installed-shaped Expert review survives the service-worker storage boundary and remains single-use', async () => {
  const timestamp = '2026-08-20T20:03:45.000Z';
  const broadOrigins = ['http://*/*', 'https://*/*'];
  const chrome = await createChromeMock({
    incognitoAllowed: true,
    originPermissions: broadOrigins,
    currentWindow: { id: 91, incognito: false },
    tabs: [
      {
        id: 701,
        windowId: 91,
        active: true,
        currentWindow: true,
        lastFocusedWindow: true,
        title: 'Reddit',
        url: 'https://www.reddit.com/',
        incognito: false
      }
    ],
    localState: {
      [STORAGE_KEYS.settings]: {
        ...DEFAULT_SETTINGS,
        cleanupMode: 'expert',
        includeProtectedWebOrigins: true,
        pageScriptScrub: false,
        temporaryDnrShield: false,
        progressOverlay: false,
        verificationPass: false,
        aggressiveCookieSweep: false,
        resetZoom: false,
        createdAt: timestamp,
        updatedAt: timestamp,
        stabilityDefaultsAppliedAt: timestamp,
        performanceDefaultsAppliedAt: timestamp,
        privacyDefaultsAppliedAt: timestamp
      }
    }
  });
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?installed-shaped-review=${Date.now()}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('popup/popup.html'),
      documentId: 'popup-document-installed-expert'
    };

    const prepared = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.prepareCleanupReview,
        payload: {
          input: 'https://www.reddit.com/',
          sourceWindowId: 91,
          sourceIncognito: false
        }
      },
      sender
    );

    assert.equal(prepared.ok, true, prepared.error);
    assert.equal(prepared.review.enteredTarget, 'https://www.reddit.com/');
    assert.equal(prepared.review.normalizedTarget, 'reddit.com');
    assert.equal(prepared.review.settingsSnapshot.cleanupMode, 'expert');
    assert.equal(prepared.review.privateWindowScope.included, true);
    assert.equal(prepared.review.privateWindowScope.sourceIncognito, false);
    assert.equal(prepared.review.effects.closeTabs.matchingCount, 1);
    assert.equal(prepared.review.requirements.protectedWebOrigins, true);
    assert.equal(prepared.review.requirements.downloadedFiles, false);
    assert.equal(prepared.review.requiredFileConfirmation, '');
    assert.equal(prepared.review.hostPermissionsGranted, true);
    assert.deepEqual(prepared.review.hostPermissionInventory.broadGrantedHostPermissionOrigins, broadOrigins);
    assert.deepEqual(prepared.review.temporaryHostPermissionOrigins, []);

    const stored = structuredClone(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY]);
    assert.equal(stored.canonicalInput, 'reddit.com');
    assert.equal(stored.reviewSnapshot.enteredTarget, 'reddit.com');
    assert.equal(stored.sourceWindowId, 91);
    assert.equal(stored.sourceIncognito, false);
    assert.equal(stored.incognitoAccess, true);
    assert.equal(stored.permissionLeaseId, null);
    assert.deepEqual(stored.hostPermissionInventory.broadGrantedHostPermissionOrigins, broadOrigins);
    assert.ok(normalizeCleanupReviewRecord(stored), 'the serialized service-worker review must normalize before use');

    const approvalPayload = {
      approvalToken: prepared.review.approvalToken,
      sourceWindowId: 91,
      sourceIncognito: false,
      ...popupPreparationBinding(prepared),
      approval: {
        approvalMode: 'detailed_review',
        reviewedScope: true,
        associatedTargets: false,
        localOrIpTarget: false,
        protectedWebOrigins: true,
        fileConfirmationText: ''
      }
    };
    const completed = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.runDeepClean, payload: approvalPayload },
      sender
    );

    assert.equal(completed.ok, true, completed.error);
    assert.equal(completed.reportPersisted, false);
    assert.equal(completed.report.status, 'completed');
    assert.equal(completed.report.summary.cleanupMode, 'expert');
    assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
    assert.deepEqual(chrome.__state.originPermissions, new Set(broadOrigins));
    assert.equal(
      chrome.__calls.some((call) => call.api === 'permissions.request'),
      false,
      'pre-existing broad grants must not be requested again'
    );
    assert.deepEqual(
      chrome.__calls.filter((call) => call.api === 'permissions.remove' && Array.isArray(call.args?.[0]?.origins)),
      [],
      'pre-existing broad grants must never be removed'
    );

    const replay = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.runDeepClean, payload: approvalPayload },
      sender
    );
    assert.equal(replay.ok, false);
    assert.match(replay.error, /missing, expired, or has already been used/i);
  } finally {
    delete globalThis.chrome;
  }
});

test('a broad grant added after review is preserved and does not strand the exact temporary lease', async () => {
  const chrome = await createChromeMock({
    localState: {
      [STORAGE_KEYS.settings]: {
        cleanupMode: 'standard',
        progressOverlay: false,
        pageScriptScrub: false,
        temporaryDnrShield: false,
        verificationPass: false,
        aggressiveCookieSweep: false,
        redactReports: false,
        keepHistory: false,
        createdAt: '2026-08-16T12:00:00.000Z',
        updatedAt: '2026-08-16T12:00:00.000Z'
      }
    }
  });
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?broad-after-review=${Date.now()}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('popup/popup.html'),
      documentId: 'popup-document-broad-after-review'
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
    assert.equal(prepared.review.hostPermissionsGranted, false);
    assert.ok(chrome.__state.local[STORAGE_KEYS.permissionLease]);

    chrome.__state.originPermissions.add('<all_urls>');
    const completed = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.runDeepClean,
        payload: {
          approvalToken: prepared.review.approvalToken,
          sourceWindowId: 1,
          sourceIncognito: false,
          ...popupPreparationBinding(prepared),
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
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
    assert.deepEqual(chrome.__state.originPermissions, new Set(['<all_urls>']));
    assert.equal(completed.report.summary.hostPermissionsReleased, true);
    assert.equal(completed.report.summary.allSitesAccessGranted, true);
    assert.deepEqual(
      completed.report.sections.find((section) => section.key === 'hostPermissions').details
        .temporaryOriginsGrantedAfterRelease,
      []
    );
  } finally {
    delete globalThis.chrome;
  }
});

test('a post-run permission inventory failure remains unknown instead of reusing preflight truth', async () => {
  const chrome = await createChromeMock({
    originPermissions: ['<all_urls>'],
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
  const getAll = chrome.permissions.getAll;
  let inventoryCalls = 0;
  chrome.permissions.getAll = async () => {
    inventoryCalls += 1;
    if (inventoryCalls === 3) throw new Error('synthetic post-run inventory failure');
    return getAll();
  };
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?post-run-inventory-failure=${Date.now()}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('popup/popup.html'),
      documentId: 'popup-document-post-run-inventory'
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
    assert.equal(prepared.review.hostPermissionInventory.allSitesAccessGranted, true);

    const completed = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.runDeepClean,
        payload: {
          approvalToken: prepared.review.approvalToken,
          sourceWindowId: 1,
          sourceIncognito: false,
          ...popupPreparationBinding(prepared),
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
    assert.equal(completed.report.summary.allSitesAccessGranted, null);
    assert.equal(completed.report.summary.broadHostPermissionOriginsGranted, null);
    assert.equal(completed.report.summary.exactRequiredHostPermissionOriginsGranted, null);
    assert.equal(completed.report.hostPermissionInventory.afterRelease, null);
  } finally {
    delete globalThis.chrome;
  }
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
    documentUrl: chrome.runtime.getURL('popup/popup.html'),
    documentId: 'popup-document-report-persistence'
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
        ...popupPreparationBinding(prepared),
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
  assert.equal(completed.reportPersisted, false);
  assert.equal(completed.report.status, 'completed_with_warnings');
  assert.ok(completed.completionWarnings.some((warning) => /Persist cleanup report/.test(warning)));
  assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob].status, 'completed');
  assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
  delete globalThis.chrome;
});

function completeApproval() {
  return {
    approvalMode: 'detailed_review',
    reviewedScope: true,
    associatedTargets: false,
    localOrIpTarget: false,
    protectedWebOrigins: false,
    fileConfirmationText: ''
  };
}

function cleanupMutationCallCount(chrome) {
  return chrome.__calls.filter((call) =>
    [
      'permissions.request',
      'browsingData.remove',
      'cookies.remove',
      'tabs.remove',
      'history.deleteUrl',
      'downloads.erase',
      'downloads.removeFile',
      'scripting.executeScript'
    ].includes(call.api)
  ).length;
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function suppressNextUndelayedTimeout() {
  const originalSetTimeout = globalThis.setTimeout;
  let didSuppress = false;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (!didSuppress && delay === undefined) {
      didSuppress = true;
      return 0;
    }
    return originalSetTimeout(callback, delay, ...args);
  };
  return {
    restore() {
      globalThis.setTimeout = originalSetTimeout;
    },
    suppressed() {
      return didSuppress;
    }
  };
}

async function waitFor(predicate, timeoutMs = 750) {
  const startedAt = performance.now();
  while (!predicate()) {
    if (performance.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for deferred maintenance.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('explicit nonce replay distinguishes an admitted running cleanup from an unresolved admission gap', async () => {
  for (const [index, admissionPhase] of ['admitted', 'handoff_admitting'].entries()) {
    const now = new Date(Date.now() + index * 1_000).toISOString();
    const nonce = `running-handoff-${index}-nonce`;
    const popupBinding = {
      popupContextId: `running-popup-context-${index}`,
      popupPreparationCapability: (index + 8).toString(16).repeat(64)
    };
    const activeJob = {
      id: `running-handoff-${index}-job`,
      status: 'running',
      targetDomain: '[redacted-target]',
      startedAt: now,
      updatedAt: now,
      percent: admissionPhase === 'admitted' ? 35 : 0,
      phase: admissionPhase,
      label: admissionPhase === 'admitted' ? 'Cleanup running' : 'Cleanup admission settling',
      detail: '',
      cancelRequested: false,
      approvalHandoffNonce: nonce,
      admissionPhase,
      popupContextId: popupBinding.popupContextId,
      popupPreparationCapabilityDigest: await digestCleanupPopupPreparationCapability(
        popupBinding.popupPreparationCapability
      )
    };
    const chrome = await createChromeMock({
      localState: {
        [STORAGE_KEYS.settings]: {
          ...DEFAULT_SETTINGS,
          createdAt: now,
          updatedAt: now,
          stabilityDefaultsAppliedAt: now,
          performanceDefaultsAppliedAt: now,
          privacyDefaultsAppliedAt: now
        }
      }
    });
    globalThis.chrome = chrome;
    try {
      await import(`../../src/background/service-worker.js?running-handoff-replay-${index}=${Date.now()}`);
      await waitFor(() => chrome.__state.alarms.has('sitewipe.maintenance'), 3_000);
      // Inject the live state after startup recovery so this models the exact
      // in-worker handoff interleaving rather than a stale job from a prior
      // service-worker lifetime (which startup correctly marks interrupted).
      chrome.__state.local[STORAGE_KEYS.activeJob] = activeJob;
      const sender = {
        id: chrome.runtime.id,
        documentUrl: chrome.runtime.getURL('popup/popup.html'),
        documentId: `popup-running-replay-${index}`
      };

      const replay = await dispatchTerminalResume(chrome, nonce, sender, popupBinding);
      assert.equal(replay.ok, true, replay.error);
      assert.equal(replay.approvalHandoffNonce, nonce);
      if (admissionPhase === 'admitted') {
        assert.equal(replay.approvalHandoffRunning, true, JSON.stringify(replay));
        assert.equal(replay.cleanupStarted, true);
        assert.equal(replay.activeJob.id, activeJob.id);
        assert.equal(replay.activeJob.admissionPhase, 'admitted');
      } else {
        assert.equal(replay.approvalHandoffUncertain, true);
        assert.equal(replay.cleanupStarted, null);
        assert.equal(replay.temporaryAccessReleased, null);
        assert.doesNotMatch(replay.warning, /No cleanup started/i);
      }
      assert.equal(
        chrome.__calls.some((call) => call.api === 'browsingData.remove' || call.api === 'downloads.removeFile'),
        false
      );
    } finally {
      delete globalThis.chrome;
    }
  }
});

test('late popup continuation replays every nonce-bound terminal handoff outcome without another cleanup', async () => {
  const scenarios = [
    {
      name: 'completed',
      jobStatus: 'completed',
      reportStatus: 'completed',
      admissionPhase: 'admitted',
      persistedReport: true,
      label: 'Cleanup finished'
    },
    {
      name: 'completed-with-warning-without-persisted-report',
      jobStatus: 'completed',
      reportStatus: 'completed_with_warnings',
      admissionPhase: 'admitted',
      persistedReport: false,
      label: 'Cleanup finished with warnings',
      detail: 'Browser cleanup finished, but report persistence failed.',
      expectWarnings: true
    },
    {
      name: 'failed',
      jobStatus: 'failed',
      reportStatus: 'failed',
      admissionPhase: 'admitted',
      persistedReport: true,
      label: 'Cleanup failed',
      detail: 'Synthetic cleanup failure.'
    },
    {
      name: 'cancelled',
      jobStatus: 'cancelled',
      reportStatus: 'cancelled',
      admissionPhase: 'admitted',
      persistedReport: true,
      label: 'Cleanup cancelled',
      detail: 'Synthetic cleanup cancellation.'
    },
    {
      name: 'interrupted-after-admission',
      jobStatus: 'interrupted',
      reportStatus: 'interrupted',
      admissionPhase: 'admitted',
      persistedReport: false,
      label: 'Cleanup interrupted',
      detail: 'The service worker stopped after cleanup admission.'
    },
    {
      name: 'interrupted-during-admission',
      jobStatus: 'interrupted',
      reportStatus: 'interrupted',
      admissionPhase: 'handoff_admitting',
      persistedReport: false,
      label: 'Cleanup interrupted',
      detail: 'The service worker stopped before cleanup admission completed.'
    }
  ];

  for (const [index, scenario] of scenarios.entries()) {
    const now = new Date(Date.now() + index * 1_000).toISOString();
    const nonce = `terminal-handoff-${index}-nonce`;
    const jobId = `terminal-handoff-${index}-job`;
    const terminalPopupBinding = {
      popupContextId: `terminal-popup-context-${index}`,
      popupPreparationCapability: index.toString(16).padStart(2, '0').repeat(32)
    };
    const terminalTimestampKey =
      scenario.jobStatus === 'completed'
        ? 'completedAt'
        : scenario.jobStatus === 'failed'
          ? 'failedAt'
          : scenario.jobStatus === 'cancelled'
            ? 'canceledAt'
            : 'interruptedAt';
    const activeJob = {
      id: jobId,
      status: scenario.jobStatus,
      targetDomain: '[redacted-target]',
      startedAt: now,
      updatedAt: now,
      percent: scenario.jobStatus === 'completed' ? 100 : 40,
      phase: scenario.jobStatus,
      label: scenario.label,
      detail: scenario.detail || '',
      cancelRequested: scenario.jobStatus === 'cancelled',
      approvalHandoffNonce: nonce,
      admissionPhase: scenario.admissionPhase,
      popupContextId: terminalPopupBinding.popupContextId,
      popupPreparationCapabilityDigest: await digestCleanupPopupPreparationCapability(
        terminalPopupBinding.popupPreparationCapability
      ),
      [terminalTimestampKey]: now
    };
    const activeReport = scenario.persistedReport
      ? {
          id: jobId,
          appVersion: '1.11.38',
          input: '[redacted]',
          targetDomain: '[redacted-target]',
          startedAt: now,
          finishedAt: now,
          status: scenario.reportStatus,
          redacted: true,
          summary: { verificationStatus: scenario.reportStatus === 'completed' ? 'verified_zero' : 'unknown' },
          sections: [],
          errors: scenario.reportStatus === 'failed' ? [{ label: 'Cleanup failed', message: scenario.detail }] : [],
          skipped:
            scenario.reportStatus === 'cancelled' ? [{ label: 'Cleanup cancelled', reason: scenario.detail }] : [],
          unavailable: [],
          integrity: null
        }
      : undefined;
    const chrome = await createChromeMock({
      localState: {
        [STORAGE_KEYS.settings]: {
          ...DEFAULT_SETTINGS,
          createdAt: now,
          updatedAt: now,
          stabilityDefaultsAppliedAt: now,
          performanceDefaultsAppliedAt: now,
          privacyDefaultsAppliedAt: now
        },
        [STORAGE_KEYS.activeJob]: activeJob,
        ...(activeReport ? { [STORAGE_KEYS.activeReport]: activeReport } : {})
      }
    });
    globalThis.chrome = chrome;
    try {
      await import(`../../src/background/service-worker.js?terminal-handoff-${index}=${Date.now()}`);
      await waitFor(() => chrome.__state.alarms.has('sitewipe.maintenance'), 3_000);
      const sender = {
        id: chrome.runtime.id,
        documentUrl: chrome.runtime.getURL('popup/popup.html'),
        documentId: `popup-terminal-${index}`
      };
      const browsingDataCallsBefore = chrome.__calls.filter((call) => call.api === 'browsingData.remove').length;

      if (index === 0) {
        const wrongNonce = await dispatchTerminalResume(
          chrome,
          'different-terminal-handoff-nonce',
          sender,
          terminalPopupBinding
        );
        assert.equal(wrongNonce.ok, false);
        assert.match(wrongNonce.error, /missing or no longer matches/i);
        assert.equal(Object.hasOwn(wrongNonce, 'report'), false);
      }

      const recovered = await dispatchTerminalResume(chrome, nonce, sender, terminalPopupBinding);
      assert.equal(recovered.ok, true, `${scenario.name}: ${recovered.error || 'terminal replay failed'}`);
      assert.equal(recovered.approvalHandoffNonce, nonce);
      assert.equal(recovered.resumedCompletedResult, scenario.jobStatus === 'completed');
      assert.equal(recovered.resumedTerminalResult, true);
      assert.equal(recovered.report.id, jobId);
      assert.equal(recovered.report.status, scenario.reportStatus);
      assert.equal(recovered.reportPersisted, scenario.persistedReport);
      assert.equal(recovered.completionWarnings.length > 0, scenario.expectWarnings === true);
      assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob].id, jobId);
      assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob].status, scenario.jobStatus);
      assert.equal(
        chrome.__calls.filter((call) => call.api === 'browsingData.remove').length,
        browsingDataCallsBefore,
        `${scenario.name} must replay the durable outcome without rerunning browser cleanup`
      );
    } finally {
      delete globalThis.chrome;
    }
  }
});

function dispatchTerminalResume(chrome, handoffNonce, sender, popupBinding) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) reject(new Error('Timed out waiting for terminal handoff recovery.'));
    }, 6_000);
    const sendResponse = (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(structuredClone(response));
    };
    try {
      chrome.runtime.onMessage.emit(
        {
          type: MESSAGE_TYPES.resumeArmedCleanup,
          payload: { handoffNonce, ...popupBinding }
        },
        sender,
        sendResponse
      );
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

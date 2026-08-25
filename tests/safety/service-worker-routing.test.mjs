import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  createChromeActionPopupContext,
  createChromeMock,
  createEvent,
  dispatchRuntimeMessage
} from '../helpers/chrome-mock.mjs';
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
const PERMISSION_HANDOFF_STORAGE_KEY = 'sitewipe.cleanupPermissionHandoff.v1';
let nextPermissionHandoffTabId = 40_000;
let nextPermissionHandoffContextId = 1;

function popupPreparationBinding(prepared) {
  return {
    popupContextId: prepared.popupContextId,
    popupPreparationCapability: prepared.popupPreparationCapability
  };
}

function installPersistentPermissionHandoffTabSupport(chrome) {
  chrome.tabs.onRemoved ||= createEvent();
  chrome.tabs.create ||= async (properties) => {
    while (chrome.__state.tabs.has(nextPermissionHandoffTabId)) nextPermissionHandoffTabId += 1;
    const tab = {
      id: nextPermissionHandoffTabId,
      windowId: properties.windowId,
      active: properties.active === true,
      incognito: false,
      url: properties.url
    };
    nextPermissionHandoffTabId += 1;
    chrome.__calls.push({ api: 'tabs.create', args: [structuredClone(properties)] });
    chrome.__state.tabs.set(tab.id, structuredClone(tab));
    return structuredClone(tab);
  };
}

async function openAndClaimPersistentPermissionHandoff(chrome, prepared, popupSender, options = {}) {
  installPersistentPermissionHandoffTabSupport(chrome);
  const opened = await dispatchRuntimeMessage(
    chrome,
    {
      type: MESSAGE_TYPES.openCleanupPermissionHandoff,
      payload: {
        approvalToken: prepared.review.approvalToken,
        handoffNonce: prepared.review.approvalHandoffNonce,
        ...popupPreparationBinding(prepared)
      }
    },
    popupSender
  );
  assert.equal(opened.ok, true, opened.error);
  assert.equal(opened.handoffOpened, true);

  const tab = chrome.__state.tabs.get(opened.tabId);
  assert.ok(tab, 'the worker-created permission handoff tab must exist');
  const handoffUrl = chrome.runtime.getURL('handoff/handoff.html');
  const contextId = options.contextId || `routing-permission-handoff-context-${nextPermissionHandoffContextId++}`;
  const documentId = options.omitDocumentId ? null : options.documentId || `${contextId}-document`;
  chrome.__state.runtimeContexts.push({
    contextId,
    contextType: 'TAB',
    ...(documentId ? { documentId } : {}),
    ...(options.omitDocumentOrigin ? {} : { documentOrigin: chrome.runtime.getURL('').replace(/\/$/, '') }),
    documentUrl: handoffUrl,
    frameId: 0,
    tabId: tab.id,
    windowId: tab.windowId,
    incognito: false
  });
  const handoffSender = {
    id: chrome.runtime.id,
    url: handoffUrl,
    documentUrl: handoffUrl,
    origin: chrome.runtime.getURL('').replace(/\/$/, ''),
    ...(documentId ? { documentId } : {}),
    frameId: 0,
    tab: {
      id: tab.id,
      windowId: tab.windowId,
      incognito: false,
      url: handoffUrl
    }
  };
  const claimed = await dispatchRuntimeMessage(
    chrome,
    { type: MESSAGE_TYPES.claimCleanupPermissionHandoff, payload: {} },
    handoffSender
  );
  assert.equal(claimed.ok, true, claimed.error);
  assert.equal(claimed.handoffClaimed, true);
  assert.ok(claimed.reviewedEffects && typeof claimed.reviewedEffects === 'object');
  assert.match(claimed.reviewedEffects.approvalPath, /review|direct/i);
  assert.equal(Number.isInteger(claimed.reviewedEffects.associatedTargetCount), true);
  assert.equal(typeof claimed.reviewedEffects.downloadedFileSummary, 'string');
  assert.equal(typeof claimed.reviewedEffects.categorySummary, 'string');
  assert.equal(typeof claimed.reviewedEffects.browserRecordSummary, 'string');
  assert.equal(typeof claimed.reviewedEffects.requestShieldSummary, 'string');
  assert.equal(typeof claimed.reviewedEffects.progressOverlaySummary, 'string');
  assert.equal(typeof claimed.reviewedEffects.protectedOriginSummary, 'string');
  assert.equal(typeof claimed.reviewedEffects.evidenceSummary, 'string');
  return {
    opened,
    claimed,
    sender: handoffSender,
    authority: {
      handoffNonce: prepared.review.approvalHandoffNonce,
      handoffCapability: claimed.handoffCapability
    }
  };
}

async function installRetainedPersistentPermissionHandoff(chrome, handoffNonce, options = {}) {
  installPersistentPermissionHandoffTabSupport(chrome);
  while (chrome.__state.tabs.has(nextPermissionHandoffTabId)) nextPermissionHandoffTabId += 1;
  const tabId = nextPermissionHandoffTabId++;
  const windowId = options.windowId || 1;
  const contextId = options.contextId || `retained-permission-handoff-context-${nextPermissionHandoffContextId++}`;
  const documentId = options.documentId || `${contextId}-document`;
  const handoffCapability = options.handoffCapability || 'e'.repeat(64);
  const handoffUrl = chrome.runtime.getURL('handoff/handoff.html');
  chrome.__state.tabs.set(tabId, {
    id: tabId,
    windowId,
    active: true,
    incognito: false,
    url: handoffUrl
  });
  chrome.__state.runtimeContexts.push({
    contextId,
    contextType: 'TAB',
    documentId,
    documentOrigin: chrome.runtime.getURL('').replace(/\/$/, ''),
    documentUrl: handoffUrl,
    frameId: 0,
    tabId,
    windowId,
    incognito: false
  });
  chrome.__state.session[PERMISSION_HANDOFF_STORAGE_KEY] = {
    schemaVersion: 1,
    status: 'used',
    handoffNonce,
    approvalToken: options.approvalToken || 'a'.repeat(48),
    permissionLeaseId: options.permissionLeaseId || 'retained-permission-handoff-lease',
    tabId,
    windowId,
    documentId,
    contextId,
    capabilityDigest: await digestCleanupPopupPreparationCapability(handoffCapability),
    capabilityUsedAtMs: Date.now(),
    openedAtMs: Date.now(),
    expiresAtMs: Date.now() + 5 * 60_000
  };
  return {
    authority: { handoffNonce, handoffCapability },
    sender: {
      id: chrome.runtime.id,
      url: handoffUrl,
      documentUrl: handoffUrl,
      documentId,
      origin: chrome.runtime.getURL('').replace(/\/$/, ''),
      frameId: 0,
      tab: { id: tabId, windowId, incognito: false, url: handoffUrl }
    }
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

test('malformed host-permission inventories cannot settle removal poison', async () => {
  const source = await readFile(new URL('../../src/background/service-worker.js', import.meta.url), 'utf8');
  const functionStart = source.indexOf('async function getAllHostPermissionsStrict()');
  const functionEnd = source.indexOf('\nasync function hasNamedPermission(', functionStart);
  const implementation = source.slice(functionStart, functionEnd);
  const validityCheck = implementation.indexOf(
    "throw new Error('Host-permission inventory returned an invalid response.');"
  );
  const settlement = implementation.indexOf('settleSelfRemovalReservationsFromInventory(snapshot);');
  assert.ok(functionStart >= 0 && functionEnd > functionStart);
  assert.ok(validityCheck >= 0, 'the permission inventory must be structurally validated');
  assert.ok(settlement > validityCheck, 'removal poison may settle only after a valid permission inventory');
});

test('permission contains and removal adapters require literal browser booleans', async () => {
  const source = await readFile(new URL('../../src/background/service-worker.js', import.meta.url), 'utf8');
  const hostContains = source.slice(
    source.indexOf('async function containsHostPermissionsStrict('),
    source.indexOf('async function getAllHostPermissionsStrict(')
  );
  const namedContains = source.slice(
    source.indexOf('async function containsNamedPermissionStrict('),
    source.indexOf('async function removeNamedPermissionStrict(')
  );
  const namedRemove = source.slice(
    source.indexOf('async function removeNamedPermissionStrict('),
    source.indexOf('async function removeNamedPermission(')
  );
  const hostRemove = source.slice(
    source.indexOf('async function releaseTemporaryHostPermissions('),
    source.indexOf('async function getActiveTabTarget(')
  );
  for (const implementation of [hostContains, namedContains, namedRemove, hostRemove]) {
    assert.match(implementation, /!== true && [a-zA-Z]+ !== false/);
    assert.match(implementation, /invalid response/);
  }
  const privateInspection = source.slice(
    source.indexOf('async function isIncognitoAllowed('),
    source.indexOf('async function inspectSourceWindow(')
  );
  assert.match(privateInspection, /allowed !== true && allowed !== false/);
  assert.match(privateInspection, /non-boolean result/);
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
        privacyDefaultsAppliedAt: now,
        storagePartitionDisclosureAppliedAt: now
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
        privacyDefaultsAppliedAt: now,
        storagePartitionDisclosureAppliedAt: now
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
    assert.equal(chrome.__state.local[STORAGE_KEYS.settings].embeddedFrameDiscovery, true);
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
      { type: MESSAGE_TYPES.clearReports, payload: {} },
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
      assert.match(
        response.error,
        message.type === MESSAGE_TYPES.settleCleanupPermissionPrompt
          ? /popup target-access continuation is retired/i
          : /cleanup is still running/i
      );
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
    assert.equal(readResponse.temporaryHostAccess.state, 'none');

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
      { type: MESSAGE_TYPES.clearReports, payload: {} },
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
      assert.match(
        response.error,
        message.type === MESSAGE_TYPES.settleCleanupPermissionPrompt
          ? /popup target-access continuation is retired/i
          : /cleanup is still running/i
      );
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

test('an exact native grant continues after the persistent handoff durably reports the resolved-true outcome', async () => {
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
    const pendingPopupState = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.getPopupState, payload: {} },
      sender
    );
    assert.equal(pendingPopupState.ok, true, pendingPopupState.error);
    assert.equal(pendingPopupState.temporaryHostAccess.state, 'prompt_pending');
    assert.equal(pendingPopupState.temporaryHostAccess.temporaryOriginCount, 4);
    assert.equal(pendingPopupState.temporaryHostAccess.recoveryPending, false);
    assert.equal(
      Object.hasOwn(pendingPopupState.temporaryHostAccess, 'leaseId'),
      false,
      'popup state must not expose the durable recovery lease identifier'
    );

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
    assert.equal(armed.handoffNonce, prepared.review.approvalHandoffNonce);
    const handoff = await openAndClaimPersistentPermissionHandoff(chrome, prepared, sender, {
      omitDocumentId: true,
      omitDocumentOrigin: true
    });

    const intent = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.beginCleanupPermissionHandoff,
        payload: handoff.authority
      },
      handoff.sender
    );
    assert.equal(intent.ok, true, intent.error);
    // The browser event may persist before the immediate invocation marker.
    // Cleanup still remains non-runnable until the native request resolves true
    // and this same popup durably reports that distinct outcome.
    const permissionRequest = chrome.permissions.request({
      origins: prepared.review.temporaryHostPermissionOrigins
    });
    const promptInvocation = dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.confirmCleanupPermissionHandoffInvocation,
        payload: handoff.authority
      },
      handoff.sender
    );
    const [invoked, granted] = await Promise.all([promptInvocation, permissionRequest]);
    assert.equal(invoked.ok, true, invoked.error);
    assert.equal(invoked.promptInvocationRecorded, true);
    assert.equal(granted, true);
    // Let the exact event-first proof outlive the worker's immediate retry
    // budget. It must remain non-runnable and non-removable until this same
    // popup reports the separate literal-true result.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
    assert.notEqual(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
    assert.notEqual(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
    assert.equal(
      chrome.__calls.some((call) => call.api === 'permissions.remove'),
      false
    );
    assert.equal(
      chrome.__calls.some((call) => call.api === 'browsingData.remove'),
      false
    );
    const grantOutcome = dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.confirmCleanupPermissionHandoffGrant,
        payload: {
          ...handoff.authority,
          preRequestTemporaryOriginsAbsent: true
        }
      },
      handoff.sender
    );
    // Do not send resumeArmedCleanup. The resolved-true message itself is the
    // authenticated worker takeover point and survives popup destruction.
    await waitFor(() => chrome.__state.local[STORAGE_KEYS.activeJob]?.status === 'completed', 3_000);
    const grantOutcomeResponse = await grantOutcome;
    assert.equal(grantOutcomeResponse.ok, true, grantOutcomeResponse.error);
    assert.equal(grantOutcomeResponse.promptGrantOutcomeRecorded, true);

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

    const retiredPopupContinuation = await dispatchTerminalResume(
      chrome,
      prepared.review.approvalHandoffNonce,
      sender,
      popupPreparationBinding(prepared)
    );
    assert.equal(retiredPopupContinuation.ok, false);
    assert.match(retiredPopupContinuation.error, /popup target-access continuation is retired/i);
  } finally {
    delete globalThis.chrome;
  }
});

for (const removalFailureMode of [
  null,
  'session-read',
  'session-remove',
  'local-revoke-write',
  'persistent-local-authority'
]) {
  test(`an intersecting onRemoved event permanently invalidates reviewed ownership before a manual regrant${
    removalFailureMode ? ` after a transient ${removalFailureMode} failure` : ''
  }`, async () => {
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
    const originalGetAll = chrome.permissions.getAll;
    const releaseBlockedInventory = deferred();
    let blockNextInventory = false;
    let blockedInventoryStarted = false;
    let persistentRevocationWriteFailures = 0;
    let persistentLeaseDiscardFailures = 0;
    chrome.permissions.getAll = async (...args) => {
      if (blockNextInventory) {
        blockNextInventory = false;
        blockedInventoryStarted = true;
        await releaseBlockedInventory.promise;
      }
      return originalGetAll(...args);
    };

    globalThis.chrome = chrome;
    try {
      await import(`../../src/background/service-worker.js?permission-revoke-regrant=${Date.now()}`);
      await waitFor(() => chrome.__state.alarms.has('sitewipe.maintenance'));
      const sender = {
        id: chrome.runtime.id,
        documentUrl: chrome.runtime.getURL('popup/popup.html'),
        documentId: 'popup-document-permission-revoke-regrant'
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
      const temporaryOrigins = prepared.review.temporaryHostPermissionOrigins;
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
      const handoff = await openAndClaimPersistentPermissionHandoff(chrome, prepared, sender, {
        omitDocumentId: true
      });
      const intent = await dispatchRuntimeMessage(
        chrome,
        {
          type: MESSAGE_TYPES.beginCleanupPermissionHandoff,
          payload: handoff.authority
        },
        handoff.sender
      );
      assert.equal(intent.ok, true, intent.error);

      const permissionRequest = chrome.permissions.request({ origins: temporaryOrigins });
      const invocation = dispatchRuntimeMessage(
        chrome,
        {
          type: MESSAGE_TYPES.confirmCleanupPermissionHandoffInvocation,
          payload: handoff.authority
        },
        handoff.sender
      );
      const [granted, invoked] = await Promise.all([permissionRequest, invocation]);
      assert.equal(granted, true);
      assert.equal(invoked.ok, true, invoked.error);
      await waitFor(
        () => chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY]?.approvalHandoff?.promptGrant?.complete === true,
        3_000
      );

      blockNextInventory = true;
      const outcome = dispatchRuntimeMessage(
        chrome,
        {
          type: MESSAGE_TYPES.confirmCleanupPermissionHandoffGrant,
          payload: {
            ...handoff.authority,
            preRequestTemporaryOriginsAbsent: true
          }
        },
        handoff.sender
      );
      await waitFor(() => blockedInventoryStarted, 3_000);
      assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease]?.ownershipProof, 'reviewed_prompt_grant');

      const removedOrigin = temporaryOrigins[0];
      if (removalFailureMode === 'session-read') {
        const originalSessionGet = chrome.storage.session.get.bind(chrome.storage.session);
        let rejected = false;
        chrome.storage.session.get = async (keys) => {
          if (!rejected && Array.isArray(keys) && keys.length === 1 && keys[0] === CLEANUP_REVIEW_STORAGE_KEY) {
            rejected = true;
            throw new Error('Injected session review read failure');
          }
          return originalSessionGet(keys);
        };
      }
      if (removalFailureMode === 'session-remove') {
        const originalSessionRemove = chrome.storage.session.remove.bind(chrome.storage.session);
        let rejected = false;
        chrome.storage.session.remove = async (keys) => {
          if (
            !rejected &&
            (keys === CLEANUP_REVIEW_STORAGE_KEY || (Array.isArray(keys) && keys.includes(CLEANUP_REVIEW_STORAGE_KEY)))
          ) {
            rejected = true;
            throw new Error('Injected session review removal failure');
          }
          return originalSessionRemove(keys);
        };
      }
      if (removalFailureMode === 'local-revoke-write') {
        const originalLocalSet = chrome.storage.local.set.bind(chrome.storage.local);
        let rejected = false;
        chrome.storage.local.set = async (values) => {
          if (!rejected && values?.[STORAGE_KEYS.permissionLease]?.ownershipProof === 'revoked') {
            rejected = true;
            throw new Error('Injected local lease revocation write failure');
          }
          return originalLocalSet(values);
        };
      }
      if (removalFailureMode === 'persistent-local-authority') {
        const originalLocalSet = chrome.storage.local.set.bind(chrome.storage.local);
        const originalLocalRemove = chrome.storage.local.remove.bind(chrome.storage.local);
        chrome.storage.local.set = async (values) => {
          if (values?.[STORAGE_KEYS.permissionLease]?.ownershipProof === 'revoked') {
            persistentRevocationWriteFailures += 1;
            throw new Error('Injected persistent local lease revocation write failure');
          }
          return originalLocalSet(values);
        };
        chrome.storage.local.remove = async (keys) => {
          if (
            keys === STORAGE_KEYS.permissionLease ||
            (Array.isArray(keys) && keys.includes(STORAGE_KEYS.permissionLease))
          ) {
            persistentLeaseDiscardFailures += 1;
            throw new Error('Injected persistent local lease discard failure');
          }
          return originalLocalRemove(keys);
        };
      }
      chrome.__state.originPermissions.delete(removedOrigin);
      chrome.__events.permissionRemoved.emit({
        origins: ['<all_urls>', removedOrigin, removedOrigin, 'malformed pattern'],
        permissions: ['tabs']
      });
      await waitFor(
        () =>
          chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY] === undefined &&
          (removalFailureMode === 'persistent-local-authority' ||
            chrome.__state.local[STORAGE_KEYS.permissionLease] === undefined),
        3_000
      );

      // This is a fresh external/manual grant. It must not be combinable with
      // any stale event/result proof from the now-revoked SiteWipe handoff.
      for (const origin of temporaryOrigins) chrome.__state.originPermissions.add(origin);
      chrome.__events.permissionAdded.emit({ origins: temporaryOrigins });
      if (removalFailureMode === 'persistent-local-authority') {
        // Both the original onRemoved invalidation and the onAdded retry make
        // two bounded attempts at each durable authority operation. Wait for
        // those exact fail-closed attempts before releasing the held inventory;
        // a fixed delay can let a heavily loaded run observe only half of the
        // intended invalidation race.
        await waitFor(() => persistentRevocationWriteFailures >= 4 && persistentLeaseDiscardFailures >= 4, 3_000);
      }
      releaseBlockedInventory.resolve();
      const outcomeResponse = await outcome;
      assert.equal(outcomeResponse.ok, true, outcomeResponse.error);
      assert.equal(outcomeResponse.promptGrantOutcomeRecorded, true);
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.deepEqual(
        chrome.__state.originPermissions,
        new Set(temporaryOrigins),
        JSON.stringify({
          removalFailureMode,
          persistentRevocationWriteFailures,
          persistentLeaseDiscardFailures,
          permissionRemovals: chrome.__calls.filter((call) => call.api === 'permissions.remove'),
          debugLog: chrome.__state.local[STORAGE_KEYS.debugLog],
          activeJob: chrome.__state.local[STORAGE_KEYS.activeJob],
          permissionLease: chrome.__state.local[STORAGE_KEYS.permissionLease],
          review: chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY],
          outcomeResponse
        })
      );
      assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
      if (removalFailureMode === 'persistent-local-authority') {
        assert.equal(
          chrome.__state.local[STORAGE_KEYS.permissionLease]?.ownershipProof,
          'reviewed_prompt_grant',
          'the injected persistent storage failure should leave only poisoned bookkeeping'
        );
      } else {
        assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
      }
      assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
      assert.equal(
        chrome.__calls.some((call) => call.api === 'permissions.remove'),
        false,
        'revoked ownership must preserve a later manual grant'
      );
      assert.equal(
        chrome.__calls.some((call) => call.api === 'browsingData.remove'),
        false
      );
      assert.equal(
        chrome.__calls.some((call) => call.api === 'downloads.removeFile'),
        false
      );
    } finally {
      releaseBlockedInventory.resolve();
      delete globalThis.chrome;
    }
  });
}

test('a durable Standard approval preserves a preexisting manual grant instead of claiming cleanup authority', async () => {
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
    await import(`../../src/background/service-worker.js?two-activation-handoff=${Date.now()}`);
    await waitFor(() => chrome.__state.alarms.has('sitewipe.maintenance'));
    const sender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('popup/popup.html'),
      documentId: 'popup-document-two-activation'
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

    const beforeApproval = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.getPopupState, payload: {} },
      sender
    );
    assert.equal(beforeApproval.ok, true, beforeApproval.error);
    assert.equal(beforeApproval.temporaryHostAccess.state, 'prompt_pending');
    assert.equal(Object.hasOwn(beforeApproval.temporaryHostAccess, 'leaseId'), false);

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
    assert.equal(armed.approvalArmed, true);
    assert.equal(armed.handoffStatus, 'armed');
    assert.equal(armed.handoffNonce, prepared.review.approvalHandoffNonce);
    assert.deepEqual(chrome.__state.originPermissions, new Set());
    assert.equal(
      chrome.__calls.some((call) => call.api === 'permissions.request'),
      false,
      'durable SiteWipe approval must not itself open or grant Chrome access'
    );

    const waitingForGrant = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.getPopupState, payload: {} },
      sender
    );
    assert.equal(waitingForGrant.ok, true, waitingForGrant.error);
    assert.equal(waitingForGrant.temporaryHostAccess.state, 'prompt_pending');
    assert.equal(Object.hasOwn(waitingForGrant.temporaryHostAccess, 'leaseId'), false);
    const handoff = await openAndClaimPersistentPermissionHandoff(chrome, prepared, sender, {
      omitDocumentId: true
    });

    // An external/manual exact grant after activation one must be neither
    // claimed nor runnable as a SiteWipe prompt.
    for (const origin of prepared.review.temporaryHostPermissionOrigins) {
      chrome.__state.originPermissions.add(origin);
    }
    chrome.__events.permissionAdded.emit({ origins: prepared.review.temporaryHostPermissionOrigins });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
    assert.equal(
      chrome.__calls.some((call) => call.api === 'browsingData.remove'),
      false
    );
    assert.deepEqual(chrome.__state.originPermissions, new Set(prepared.review.temporaryHostPermissionOrigins));
    assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY].approvalHandoff.promptInvocation, null);

    const rawResume = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.resumeCleanupPermissionHandoff, payload: handoff.authority },
      handoff.sender
    );
    assert.equal(rawResume.ok, false);
    assert.match(rawResume.error, /has not initiated browser access/i);
    const retiredPopupResume = await dispatchTerminalResume(
      chrome,
      prepared.review.approvalHandoffNonce,
      sender,
      popupPreparationBinding(prepared)
    );
    assert.equal(retiredPopupResume.ok, false);
    assert.match(retiredPopupResume.error, /popup target-access continuation is retired/i);
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
    assert.deepEqual(chrome.__state.originPermissions, new Set(prepared.review.temporaryHostPermissionOrigins));

    const intent = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.beginCleanupPermissionHandoff,
        payload: handoff.authority
      },
      handoff.sender
    );
    assert.equal(intent.ok, true, intent.error);
    // This models the fresh second SiteWipe activation after a manual pregrant.
    // permissions.request() resolves true but emits no onAdded transition. The
    // popup's pre-request getAll snapshot detects that access was already
    // present, so it must settle abandoned without attesting a grant outcome.
    const permissionRequest = chrome.permissions.request({ origins: prepared.review.temporaryHostPermissionOrigins });
    const promptInvocation = dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.confirmCleanupPermissionHandoffInvocation,
        payload: handoff.authority
      },
      handoff.sender
    );
    const [invoked, granted] = await Promise.all([promptInvocation, permissionRequest]);
    assert.equal(invoked.ok, true, invoked.error);
    assert.equal(invoked.promptInvocationRecorded, true);
    assert.equal(granted, true);
    const pregrantSettlement = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.settleCleanupPermissionHandoff,
        payload: {
          ...handoff.authority,
          outcome: 'abandoned'
        }
      },
      handoff.sender
    );
    assert.equal(pregrantSettlement.ok, true, pregrantSettlement.error);
    assert.equal(pregrantSettlement.settlement.permissionsPreserved, true);
    assert.equal(pregrantSettlement.settlement.recordRetained, false);
    assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
    assert.deepEqual(chrome.__state.originPermissions, new Set(prepared.review.temporaryHostPermissionOrigins));
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
    assert.equal(
      chrome.__calls.some((call) => call.api === 'permissions.remove'),
      false
    );
    assert.equal(
      chrome.__calls.some((call) => call.api === 'browsingData.remove'),
      false
    );
    assert.equal(
      chrome.__calls.some((call) => call.api === 'downloads.removeFile'),
      false,
      'Standard cleanup must preserve downloaded files'
    );
  } finally {
    delete globalThis.chrome;
  }
});

test('an external grant arriving after uninvoked armed-review expiry is preserved and never creates a cleanup job', async () => {
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
    // Model an exact external/manual grant becoming observable after expiry.
    // Activation one never recorded an accepted prompt invocation, so the event may retire
    // SiteWipe's bookkeeping but must neither run cleanup nor remove the grant.
    for (const origin of prepared.review.temporaryHostPermissionOrigins) {
      chrome.__state.originPermissions.add(origin);
    }
    chrome.__events.permissionAdded.emit({ origins: prepared.review.temporaryHostPermissionOrigins });
    await waitFor(
      () =>
        chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY] === undefined &&
        chrome.__state.local[STORAGE_KEYS.permissionLease] === undefined,
      3_000
    );

    assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
    assert.deepEqual(chrome.__state.originPermissions, new Set(prepared.review.temporaryHostPermissionOrigins));
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

test('same-nonce handoff confirmations stay non-runnable while one expiry settlement releases access', async () => {
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
  const removalStarted = deferred();
  const releaseRemoval = deferred();
  const originalPermissionRemove = chrome.permissions.remove;
  chrome.permissions.remove = async (...args) => {
    removalStarted.resolve();
    await releaseRemoval.promise;
    return originalPermissionRemove(...args);
  };
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
    const handoff = await openAndClaimPersistentPermissionHandoff(chrome, prepared, sender, {
      omitDocumentId: true
    });
    const intent = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.beginCleanupPermissionHandoff,
        payload: handoff.authority
      },
      handoff.sender
    );
    assert.equal(intent.ok, true, intent.error);
    const invoked = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.confirmCleanupPermissionHandoffInvocation,
        payload: handoff.authority
      },
      handoff.sender
    );
    assert.equal(invoked.ok, true, invoked.error);
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    Date.now = () => Date.parse(prepared.review.expiresAt) + 1;
    for (const origin of prepared.review.temporaryHostPermissionOrigins) {
      chrome.__state.originPermissions.add(origin);
    }
    chrome.__events.permissionAdded.emit({
      permissions: [],
      origins: prepared.review.temporaryHostPermissionOrigins
    });
    await waitFor(
      () => chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY]?.approvalHandoff?.promptGrant?.complete === true,
      3_000
    );
    const firstConfirmation = dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.confirmCleanupPermissionHandoffGrant,
        payload: { ...handoff.authority, preRequestTemporaryOriginsAbsent: true }
      },
      handoff.sender
    );
    const secondConfirmation = dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.confirmCleanupPermissionHandoffGrant,
        payload: { ...handoff.authority, preRequestTemporaryOriginsAbsent: true }
      },
      handoff.sender
    );
    await removalStarted.promise;

    releaseRemoval.resolve();
    const responses = await Promise.all([firstConfirmation, secondConfirmation]);
    for (const response of responses) {
      assert.equal(response.ok, true, response.error);
      assert.equal(response.promptGrantOutcomeRecorded, true, JSON.stringify(responses));
      assert.equal(response.approvalHandoffNonce, prepared.review.approvalHandoffNonce);
      if (response.approvalHandoffUncertain === true) {
        assert.equal(response.cleanupStarted, null);
        assert.equal(response.temporaryAccessReleased, null);
      } else {
        assert.equal(response.approvalHandoffCanceled, true, JSON.stringify(responses));
        assert.equal(response.cleanupStarted, false);
        assert.equal(response.temporaryAccessReleased, true);
        assert.equal(response.settlement?.released, true);
      }
    }
    await waitFor(
      () =>
        chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY] === undefined &&
        chrome.__state.local[STORAGE_KEYS.permissionLease] === undefined,
      3_000
    );
    assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
    assert.deepEqual(chrome.__state.originPermissions, new Set());
    assert.equal(cleanupMutationCallCount(chrome), 0);
  } finally {
    releaseRemoval.resolve();
    Date.now = originalDateNow;
    delete globalThis.chrome;
  }
});

test('a resolved-true marker may precede the exact onAdded event without being consumed', async () => {
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
    const handoff = await openAndClaimPersistentPermissionHandoff(chrome, prepared, sender, {
      omitDocumentId: true
    });
    const intent = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.beginCleanupPermissionHandoff,
        payload: handoff.authority
      },
      handoff.sender
    );
    assert.equal(intent.ok, true, intent.error);
    const invoked = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.confirmCleanupPermissionHandoffInvocation,
        payload: handoff.authority
      },
      handoff.sender
    );
    assert.equal(invoked.ok, true, invoked.error);
    await new Promise((resolve) => setTimeout(resolve, 1_100));

    // The browser has already granted access and resolved the initiating
    // request, but delivery of its exact onAdded callback is delayed beyond the
    // worker's finite immediate retry budget.
    for (const origin of prepared.review.temporaryHostPermissionOrigins) {
      chrome.__state.originPermissions.add(origin);
    }
    const firstOutcome = dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.confirmCleanupPermissionHandoffGrant,
        payload: {
          ...handoff.authority,
          preRequestTemporaryOriginsAbsent: true
        }
      },
      handoff.sender
    );
    const firstResponse = await firstOutcome;
    assert.equal(firstResponse.ok, true, firstResponse.error);
    assert.equal(firstResponse.promptGrantOutcomeRecorded, true);
    assert.equal(firstResponse.approvalHandoffUncertain, true, JSON.stringify(firstResponse));
    assert.equal(firstResponse.cleanupStarted, null);
    assert.equal(firstResponse.temporaryAccessReleased, null);
    assert.doesNotMatch(firstResponse.warning, /No cleanup started/i);
    assert.notEqual(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
    assert.notEqual(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
    assert.deepEqual(chrome.__state.originPermissions, new Set(prepared.review.temporaryHostPermissionOrigins));
    assert.equal(
      chrome.__calls.some((call) => call.api === 'permissions.remove'),
      false
    );
    assert.equal(
      chrome.__calls.some((call) => call.api === 'browsingData.remove'),
      false
    );

    chrome.__events.permissionAdded.emit({
      permissions: [],
      origins: prepared.review.temporaryHostPermissionOrigins
    });
    await waitFor(() => chrome.__state.local[STORAGE_KEYS.activeJob]?.status === 'completed', 3_000);
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

test('a grant emitted before an expired first arm is preserved without cleanup', async () => {
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
        chrome.__state.local[STORAGE_KEYS.permissionLease] === undefined,
      3_000
    );
    assert.deepEqual(chrome.__state.originPermissions, new Set(prepared.review.temporaryHostPermissionOrigins));
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

test('replacement preparation retires an expired uninvoked review without claiming a later external grant', async () => {
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
        payload: { input: 'example.org', sourceWindowId: 1, sourceIncognito: false }
      },
      replacementSender
    );
    assert.equal(replacement.ok, true, replacement.error);
    const retained = normalizeCleanupReviewRecord(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY]);
    assert.equal(retained?.token, replacement.review.approvalToken);
    assert.notEqual(retained?.token, prepared.review.approvalToken);
    assert.equal(retained?.approvalHandoff, null);
    assert.notEqual(chrome.__state.local[STORAGE_KEYS.permissionLease]?.id, originalLeaseId);

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
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(
      normalizeCleanupReviewRecord(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY])?.token,
      replacement.review.approvalToken
    );
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease]?.id, replacement.review.permissionLeaseId);
    assert.deepEqual(chrome.__state.originPermissions, new Set(prepared.review.temporaryHostPermissionOrigins));
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
        privacyDefaultsAppliedAt: now,
        storagePartitionDisclosureAppliedAt: now
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
    assert.match(crossContextRetry.error, /closed before the reviewed prompt activation|start the cleanup again/i);
    assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
    assert.deepEqual(chrome.__calls.findLast((call) => call.api === 'runtime.getContexts')?.args[0], {
      contextIds: [third.popupContextId]
    });
    assert.equal(await chrome.permissions.request({ origins: third.review.temporaryHostPermissionOrigins }), true);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.deepEqual(
      chrome.__state.originPermissions,
      new Set(third.review.temporaryHostPermissionOrigins),
      'a grant appearing after the uninvoked review was discarded remains externally controlled'
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

test('closed YouTube direct popup context is retired once before a fresh Reddit direct preflight', async () => {
  const now = new Date().toISOString();
  const chrome = await createChromeMock({
    originPermissions: ['<all_urls>'],
    runtimeContexts: [createChromeActionPopupContext({ contextId: 'popup-context-youtube-abandoned' })],
    localState: {
      [STORAGE_KEYS.settings]: {
        ...DEFAULT_SETTINGS,
        cleanupMode: 'expert',
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
        privacyDefaultsAppliedAt: now,
        storagePartitionDisclosureAppliedAt: now
      }
    }
  });
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?closed-direct-retarget=${Date.now()}`);
    await waitFor(() => chrome.__state.alarms.has('sitewipe.maintenance'));
    const popupSender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('popup/popup.html')
    };
    const prepare = (input) =>
      dispatchRuntimeMessage(
        chrome,
        {
          type: MESSAGE_TYPES.prepareCleanupReview,
          payload: { input, sourceWindowId: 1, sourceIncognito: false }
        },
        popupSender
      );

    const youtube = await prepare('youtube.com');
    assert.equal(youtube.ok, true, youtube.error);
    assert.equal(youtube.review.approvalMode, 'settings_direct');
    assert.equal(youtube.review.normalizedTarget, 'youtube.com');
    assert.equal(youtube.review.permissionLeaseId, null);
    const removeCallsBeforeRetarget = chrome.__calls.length;

    chrome.__state.runtimeContexts.splice(
      0,
      1,
      createChromeActionPopupContext({ contextId: 'popup-context-reddit-fresh' })
    );
    const hydratedRedditPopup = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.getPopupState, payload: {} },
      popupSender
    );
    assert.equal(hydratedRedditPopup.ok, true, hydratedRedditPopup.error);
    assert.equal(hydratedRedditPopup.temporaryHostAccess.state, 'none');
    assert.equal(
      chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY],
      undefined,
      'fresh-popup hydration retires the abandoned pregranted YouTube authority before selecting Reddit'
    );
    const reddit = await prepare('reddit.com');
    assert.equal(reddit.ok, true, reddit.error);
    assert.equal(reddit.resumed, undefined);
    assert.equal(reddit.review.approvalMode, 'settings_direct');
    assert.equal(reddit.review.normalizedTarget, 'reddit.com');
    assert.notEqual(reddit.review.approvalToken, youtube.review.approvalToken);
    assert.equal(reddit.popupContextId, 'popup-context-reddit-fresh');
    assert.ok(
      chrome.__calls.some(
        (call) =>
          call.api === 'runtime.getContexts' &&
          JSON.stringify(call.args[0]) === JSON.stringify({ contextIds: ['popup-context-youtube-abandoned'] })
      ),
      'hydration must authoritatively prove the exact old popup context absent'
    );

    const retirementRemovals = chrome.__calls
      .slice(removeCallsBeforeRetarget)
      .filter(
        (call) =>
          call.api === 'storage.session.remove' &&
          (call.args[0] === CLEANUP_REVIEW_STORAGE_KEY || call.args[0]?.includes?.(CLEANUP_REVIEW_STORAGE_KEY))
      );
    assert.equal(
      retirementRemovals.length,
      1,
      'the live abandoned token is retired once and never processed again as an expired review'
    );
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
    assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY].token, reddit.review.approvalToken);
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
    assert.equal(cleanupMutationCallCount(chrome), 0);

    const staleRun = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.runDeepClean,
        payload: {
          approvalToken: youtube.review.approvalToken,
          sourceWindowId: 1,
          sourceIncognito: false,
          approval: {
            approvalMode: 'settings_direct',
            reviewedScope: false,
            associatedTargets: false,
            localOrIpTarget: false,
            protectedWebOrigins: false,
            fileConfirmationText: ''
          },
          ...popupPreparationBinding(youtube)
        }
      },
      popupSender
    );
    assert.equal(staleRun.ok, false);
    assert.match(staleRun.error, /missing, expired, or has already been used/i);
    assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY].token, reddit.review.approvalToken);
    assert.equal(cleanupMutationCallCount(chrome), 0);
  } finally {
    delete globalThis.chrome;
  }
});

test('fresh popup hydration retires only an exact proofless YouTube lease before preparing Reddit', async () => {
  const now = new Date().toISOString();
  const chrome = await createChromeMock({
    runtimeContexts: [createChromeActionPopupContext({ contextId: 'popup-context-youtube-proofless' })],
    localState: {
      [STORAGE_KEYS.settings]: {
        ...DEFAULT_SETTINGS,
        cleanupMode: 'expert',
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
        privacyDefaultsAppliedAt: now,
        storagePartitionDisclosureAppliedAt: now
      }
    }
  });
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?proofless-popup-hydration=${Date.now()}`);
    await waitFor(() => chrome.__state.alarms.has('sitewipe.maintenance'));
    const popupSender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('popup/popup.html')
    };
    const prepare = (input) =>
      dispatchRuntimeMessage(
        chrome,
        {
          type: MESSAGE_TYPES.prepareCleanupReview,
          payload: { input, sourceWindowId: 1, sourceIncognito: false }
        },
        popupSender
      );

    const youtube = await prepare('youtube.com');
    assert.equal(youtube.ok, true, youtube.error);
    const youtubeLease = structuredClone(chrome.__state.local[STORAGE_KEYS.permissionLease]);
    assert.equal(youtubeLease.id, youtube.review.permissionLeaseId);
    assert.equal(youtubeLease.status, 'prompt_pending');
    assert.equal(youtubeLease.ownershipProof, null);
    const callsBeforeHydration = chrome.__calls.length;

    chrome.__state.runtimeContexts.splice(
      0,
      1,
      createChromeActionPopupContext({ contextId: 'popup-context-reddit-after-proofless' })
    );
    const hydrated = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.getPopupState, payload: {} },
      popupSender
    );
    assert.equal(hydrated.ok, true, hydrated.error);
    assert.equal(hydrated.temporaryHostAccess.state, 'none');
    assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
    assert.ok(
      chrome.__calls.some(
        (call) =>
          call.api === 'runtime.getContexts' &&
          JSON.stringify(call.args[0]) === JSON.stringify({ contextIds: ['popup-context-youtube-proofless'] })
      )
    );
    assert.equal(
      chrome.__calls
        .slice(callsBeforeHydration)
        .some((call) => call.api === 'permissions.remove' || call.api === 'permissions.request'),
      false,
      'hydration only removes proofless SiteWipe bookkeeping and never mutates browser access'
    );

    const reddit = await prepare('reddit.com');
    assert.equal(reddit.ok, true, reddit.error);
    const redditLease = chrome.__state.local[STORAGE_KEYS.permissionLease];
    assert.notEqual(redditLease.id, youtubeLease.id);
    assert.equal(redditLease.id, reddit.review.permissionLeaseId);
    assert.equal(redditLease.status, 'prompt_pending');
    assert.equal(redditLease.ownershipProof, null);
    assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY].token, reddit.review.approvalToken);
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
    assert.equal(cleanupMutationCallCount(chrome), 0);
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
        privacyDefaultsAppliedAt: now,
        storagePartitionDisclosureAppliedAt: now
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
        chrome.__state.local[STORAGE_KEYS.permissionLease] === undefined,
      3_000
    );
    assert.deepEqual(chrome.__state.originPermissions, new Set(prepared.review.temporaryHostPermissionOrigins));

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
  }
]) {
  test(`an invalidator that reaches ${invalidationBoundary.name} first does not claim a later external grant`, async () => {
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

      // Activation-one approval reaches the worker while the earlier
      // invalidator is suspended. No authenticated prompt invocation exists.
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
      assert.notEqual(canceled.promptTombstoneRetained, true);
      assert.equal(canceled.hostPermissionCleanup?.permissionsPreserved, true);
      assert.equal(armed.ok, false);
      assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
      assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);

      // A later exact grant is external to SiteWipe because the authenticated
      // second-activation marker was never recorded. It must remain untouched.
      assert.equal(await chrome.permissions.request({ origins: prepared.review.temporaryHostPermissionOrigins }), true);
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      assert.deepEqual(chrome.__state.originPermissions, new Set(prepared.review.temporaryHostPermissionOrigins));
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

test('only the exact persistent handoff document can settle an invoked prompt without revoking a proofless late grant', async () => {
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
    // Let the load-readiness wake-only retry drain before creating the review.
    // Otherwise its 0/40/120/240/480 ms probes can observe the synthetic late
    // grant and reconcile it before this test's explicit popup settlement.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const initiatingSender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('popup/popup.html'),
      documentId: 'popup-document-native-prompt-a'
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
        initiatingSender
      );
    } finally {
      approvalTimer.restore();
    }
    assert.equal(approvalTimer.suppressed(), true, 'the missed automatic admission wake must be deterministic');
    assert.equal(armed.ok, true, armed.error);
    const handoff = await openAndClaimPersistentPermissionHandoff(chrome, prepared, initiatingSender, {
      documentId: 'handoff-document-native-prompt-a'
    });
    const reopenedSender = {
      ...handoff.sender,
      documentId: 'handoff-document-reopened-b'
    };
    const promptIntent = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.beginCleanupPermissionHandoff,
        payload: handoff.authority
      },
      handoff.sender
    );
    assert.equal(promptIntent.ok, true, promptIntent.error);
    const promptInvocation = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.confirmCleanupPermissionHandoffInvocation,
        payload: handoff.authority
      },
      handoff.sender
    );
    assert.equal(promptInvocation.ok, true, promptInvocation.error);

    const settlementPayload = {
      ...handoff.authority,
      outcome: 'abandoned'
    };
    const wrongCapabilitySettlement = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.settleCleanupPermissionHandoff,
        payload: { ...settlementPayload, handoffCapability: '0'.repeat(64) }
      },
      handoff.sender
    );
    assert.equal(wrongCapabilitySettlement.ok, false);
    assert.match(wrongCapabilitySettlement.error, /capability is invalid/i);

    const reopenedSettlement = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.settleCleanupPermissionHandoff, payload: settlementPayload },
      reopenedSender
    );
    assert.equal(reopenedSettlement.ok, false);
    assert.match(reopenedSettlement.error, /exact SiteWipe handoff document/i);

    const optionsSettlement = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.settleCleanupPermissionHandoff, payload: settlementPayload },
      optionsSender
    );
    assert.equal(optionsSettlement.ok, false);
    assert.match(optionsSettlement.error, /exact SiteWipe handoff document/i);

    const retiredPopupSettlement = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.settleCleanupPermissionPrompt,
        payload: {
          approvalToken: prepared.review.approvalToken,
          handoffNonce: prepared.review.approvalHandoffNonce,
          permissionLeaseId: prepared.review.permissionLeaseId,
          ...popupPreparationBinding(prepared),
          outcome: 'abandoned'
        }
      },
      initiatingSender
    );
    assert.equal(retiredPopupSettlement.ok, false);
    assert.match(retiredPopupSettlement.error, /popup target-access continuation is retired/i);

    assert.equal(
      normalizeCleanupReviewRecord(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY]).approvalHandoff.status,
      'armed'
    );
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease].status, 'prompt_pending');

    // Model a late exact grant with neither a qualifying onAdded event nor the
    // popup's authenticated literal-true result. Even the initiating popup's
    // terminal settlement may discard only bookkeeping; it cannot revoke the
    // externally controlled access.
    for (const origin of prepared.review.temporaryHostPermissionOrigins) {
      chrome.__state.originPermissions.add(origin);
    }
    assert.equal(chrome.__state.originPermissions.size, prepared.review.temporaryHostPermissionOrigins.length);

    const ownerSettlement = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.settleCleanupPermissionHandoff, payload: settlementPayload },
      handoff.sender
    );
    assert.equal(ownerSettlement.ok, true, ownerSettlement.error);
    assert.equal(ownerSettlement.settlement.released, false);
    assert.equal(ownerSettlement.settlement.permissionsPreserved, true);
    assert.equal(ownerSettlement.settlement.recordRetained, false);
    assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);

    assert.deepEqual(chrome.__state.originPermissions, new Set(prepared.review.temporaryHostPermissionOrigins));
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
    assert.equal(
      chrome.__calls.some((call) => call.api === 'permissions.remove'),
      false
    );
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

test('serialized armed-cleanup signals never cross-resolve distinct handoff nonces', async () => {
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
    const handoff = await openAndClaimPersistentPermissionHandoff(chrome, prepared, sender, {
      omitDocumentId: true
    });

    const promptIntent = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.beginCleanupPermissionHandoff,
        payload: handoff.authority
      },
      handoff.sender
    );
    assert.equal(promptIntent.ok, true, promptIntent.error);
    const permissionRequest = chrome.permissions.request({ origins: prepared.review.temporaryHostPermissionOrigins });
    const promptInvocation = dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.confirmCleanupPermissionHandoffInvocation,
        payload: handoff.authority
      },
      handoff.sender
    );
    const [invoked, granted] = await Promise.all([promptInvocation, permissionRequest]);
    assert.equal(invoked.ok, true, invoked.error);
    assert.equal(granted, true);
    const grantOutcomePromise = dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.confirmCleanupPermissionHandoffGrant,
        payload: {
          ...handoff.authority,
          preRequestTemporaryOriginsAbsent: true
        }
      },
      handoff.sender
    );
    await cleanupStarted.promise;
    const wrongNonce = 'stale-persistent-handoff-nonce';
    const wrongResumePromise = dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.resumeCleanupPermissionHandoff,
        payload: { ...handoff.authority, handoffNonce: wrongNonce }
      },
      handoff.sender
    );
    const exactResumePromise = dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.resumeCleanupPermissionHandoff, payload: handoff.authority },
      handoff.sender
    );

    releaseCleanup.resolve();
    const [grantOutcome, wrongResume, exactResume] = await Promise.all([
      grantOutcomePromise,
      wrongResumePromise,
      exactResumePromise
    ]);
    assert.equal(grantOutcome.ok, true, grantOutcome.error);
    assert.equal(grantOutcome.report.id, chrome.__state.local[STORAGE_KEYS.activeJob].id);
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
    const handoff = await openAndClaimPersistentPermissionHandoff(chrome, prepared, sender, {
      omitDocumentId: true
    });

    const promptIntent = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.beginCleanupPermissionHandoff,
        payload: handoff.authority
      },
      handoff.sender
    );
    assert.equal(promptIntent.ok, true, promptIntent.error);
    const promptInvocation = await dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.confirmCleanupPermissionHandoffInvocation,
        payload: handoff.authority
      },
      handoff.sender
    );
    assert.equal(promptInvocation.ok, true, promptInvocation.error);

    const staleResumePromise = dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.resumeCleanupPermissionHandoff,
        payload: { ...handoff.authority, handoffNonce: 'different-persistent-handoff-nonce' }
      },
      handoff.sender
    );
    for (const origin of prepared.review.temporaryHostPermissionOrigins) {
      chrome.__state.originPermissions.add(origin);
    }
    chrome.__events.permissionAdded.emit({ origins: prepared.review.temporaryHostPermissionOrigins });
    const grantOutcomePromise = dispatchRuntimeMessage(
      chrome,
      {
        type: MESSAGE_TYPES.confirmCleanupPermissionHandoffGrant,
        payload: {
          ...handoff.authority,
          preRequestTemporaryOriginsAbsent: true
        }
      },
      handoff.sender
    );

    const [staleResume, grantOutcome] = await Promise.all([staleResumePromise, grantOutcomePromise]);
    assert.equal(staleResume.ok, false);
    assert.equal(Object.hasOwn(staleResume, 'report'), false);
    assert.equal(grantOutcome.ok, true, grantOutcome.error);
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
      const handoff = await openAndClaimPersistentPermissionHandoff(chrome, prepared, sender, {
        omitDocumentId: true
      });
      const intent = await dispatchRuntimeMessage(
        chrome,
        {
          type: MESSAGE_TYPES.beginCleanupPermissionHandoff,
          payload: handoff.authority
        },
        handoff.sender
      );
      assert.equal(intent.ok, true, intent.error);
      const invoked = await dispatchRuntimeMessage(
        chrome,
        {
          type: MESSAGE_TYPES.confirmCleanupPermissionHandoffInvocation,
          payload: handoff.authority
        },
        handoff.sender
      );
      assert.equal(invoked.ok, true, invoked.error);

      // Let the arm-only wake exhaust its no-grant retries, then seed the exact
      // grant without emitting onAdded so this explicit resume owns one
      // deterministic ready->consume pass.
      await new Promise((resolve) => setTimeout(resolve, 2_100));
      for (const origin of prepared.review.temporaryHostPermissionOrigins) {
        chrome.__state.originPermissions.add(origin);
      }
      chrome.__events.permissionAdded.emit({
        permissions: [],
        origins: prepared.review.temporaryHostPermissionOrigins
      });
      await new Promise((resolve) => setTimeout(resolve, 1_100));
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

      const resumed = await dispatchRuntimeMessage(
        chrome,
        {
          type: MESSAGE_TYPES.confirmCleanupPermissionHandoffGrant,
          payload: {
            ...handoff.authority,
            preRequestTemporaryOriginsAbsent: true
          }
        },
        handoff.sender
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

test('a broad grant added after review invalidates cleanup while preserving external access', async () => {
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

    assert.equal(completed.ok, false);
    assert.match(completed.error, /target access changed|permission|preflight/i);
    assert.equal(chrome.__state.local[STORAGE_KEYS.permissionLease], undefined);
    assert.deepEqual(chrome.__state.originPermissions, new Set(['<all_urls>']));
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeJob], undefined);
    assert.equal(
      chrome.__calls.some((call) => call.api === 'browsingData.remove'),
      false
    );
    assert.equal(
      chrome.__calls.some((call) => call.api === 'permissions.remove'),
      false,
      'a grant added outside the reviewed prompt must remain browser-owned'
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

test('persistent handoff replay distinguishes an admitted running cleanup from an unresolved admission gap', async () => {
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
      const handoff = await installRetainedPersistentPermissionHandoff(chrome, nonce, {
        contextId: `running-handoff-context-${index}`
      });

      const replay = await dispatchRuntimeMessage(
        chrome,
        { type: MESSAGE_TYPES.resumeCleanupPermissionHandoff, payload: handoff.authority },
        handoff.sender
      );
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

test('retained persistent handoff continuation replays every nonce-bound terminal outcome without another cleanup', async () => {
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
      const handoff = await installRetainedPersistentPermissionHandoff(chrome, nonce, {
        contextId: `terminal-handoff-context-${index}`
      });
      const browsingDataCallsBefore = chrome.__calls.filter((call) => call.api === 'browsingData.remove').length;

      if (index === 0) {
        const wrongNonce = await dispatchRuntimeMessage(
          chrome,
          {
            type: MESSAGE_TYPES.resumeCleanupPermissionHandoff,
            payload: { ...handoff.authority, handoffNonce: 'different-terminal-handoff-nonce' }
          },
          handoff.sender
        );
        assert.equal(wrongNonce.ok, false);
        assert.match(wrongNonce.error, /handoff no longer matches/i);
        assert.equal(Object.hasOwn(wrongNonce, 'report'), false);

        const retiredPopupResume = await dispatchTerminalResume(chrome, nonce, sender, terminalPopupBinding);
        assert.equal(retiredPopupResume.ok, false);
        assert.match(retiredPopupResume.error, /popup target-access continuation is retired/i);
      }

      const recovered = await dispatchRuntimeMessage(
        chrome,
        { type: MESSAGE_TYPES.resumeCleanupPermissionHandoff, payload: handoff.authority },
        handoff.sender
      );
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

test('Options report deletion and reset routes return truthful complete, partial, and failed outcomes', async () => {
  const chrome = await createChromeMock();
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?truthful-options-maintenance=${Date.now()}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('options/options.html'),
      documentId: 'options-truthful-maintenance'
    };
    await chrome.storage.local.set({
      [STORAGE_KEYS.activeReport]: { id: 'synthetic-latest-report' },
      [STORAGE_KEYS.reports]: [{ id: 'synthetic-history-report' }]
    });

    const cleared = await dispatchRuntimeMessage(chrome, { type: MESSAGE_TYPES.clearReports, payload: {} }, sender);
    assert.equal(cleared.ok, true, cleared.error);
    assert.equal(cleared.report, null);
    assert.deepEqual(cleared.reports, []);
    assert.equal(chrome.__state.local[STORAGE_KEYS.activeReport], null);
    assert.deepEqual(chrome.__state.local[STORAGE_KEYS.reports], []);

    chrome.__state.namedPermissions.add('webNavigation');
    const complete = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.resetExtensionLocalState, payload: {} },
      sender
    );
    assert.equal(complete.ok, true, complete.error);
    assert.equal(complete.reset.status, 'complete');
    assert.equal(complete.reset.localStateResetComplete, true);
    assert.equal(complete.reset.optionalFramePermission.verifiedAbsent, true);
    assert.deepEqual(complete.reset.recoveryFailures, []);
    assert.equal(chrome.__state.namedPermissions.has('webNavigation'), false);
    assert.deepEqual(chrome.__state.local[STORAGE_KEYS.debugLog], []);

    chrome.__state.namedPermissions.add('webNavigation');
    const removePermission = chrome.permissions.remove;
    chrome.permissions.remove = async () => false;
    const partial = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.resetExtensionLocalState, payload: {} },
      sender
    );
    assert.equal(partial.ok, true, partial.error);
    assert.equal(partial.reset.status, 'partial');
    assert.equal(partial.reset.localStateResetComplete, false);
    assert.equal(partial.reset.dataCleared, true);
    assert.equal(partial.reset.recoveryObligationsRetained, true);
    assert.equal(partial.reset.optionalFramePermission.verifiedAbsent, false);
    assert.deepEqual(partial.reset.recoveryFailures, []);
    assert.match(partial.reset.note, /optional webNavigation access/);

    const settingsReset = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.resetSettings, payload: {} },
      sender
    );
    assert.equal(settingsReset.ok, true, settingsReset.error);
    assert.equal(settingsReset.optionalFramePermission.verifiedAbsent, false);

    chrome.permissions.remove = removePermission;
    const setLocalState = chrome.storage.local.set;
    let debugResetFailureInjected = false;
    chrome.storage.local.set = async (values) => {
      if (!debugResetFailureInjected && Object.hasOwn(values || {}, STORAGE_KEYS.debugLog)) {
        debugResetFailureInjected = true;
        throw new Error('Synthetic debug-log reset failure');
      }
      return setLocalState(values);
    };
    const failed = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.resetExtensionLocalState, payload: {} },
      sender
    );
    assert.equal(failed.ok, true, failed.error);
    assert.equal(failed.reset.status, 'failed');
    assert.equal(failed.reset.localStateResetComplete, false);
    assert.equal(failed.reset.dataCleared, false);
    assert.equal(failed.reset.resetFailures.length, 1);
    assert.equal(failed.reset.resetFailures[0].step, 'debug log');
    assert.match(failed.reset.note, /debug log/);
  } finally {
    delete globalThis.chrome;
  }
});

test('local-state reset remains partial when cleanup-review recovery inspection fails', async () => {
  const chrome = await createChromeMock();
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?truthful-reset-recovery-failure=${Date.now()}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sender = {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('options/options.html'),
      documentId: 'options-reset-recovery-failure'
    };
    const originalGet = chrome.storage.session.get;
    let cleanupReviewReads = 0;
    chrome.storage.session.get = async (keys) => {
      const requested = Array.isArray(keys) ? keys : [keys];
      if (requested.includes(CLEANUP_REVIEW_STORAGE_KEY) && ++cleanupReviewReads === 2) {
        throw new Error('Synthetic cleanup-review recovery inspection failure');
      }
      return originalGet(keys);
    };

    const response = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.resetExtensionLocalState, payload: {} },
      sender
    );
    assert.equal(response.ok, true, response.error);
    assert.equal(response.reset.status, 'partial');
    assert.equal(response.reset.dataCleared, true);
    assert.equal(response.reset.localStateResetComplete, false);
    assert.equal(response.reset.recoveryObligationsRetained, true);
    assert.equal(response.reset.cleanupReviewRecoveryRetained, true);
    assert.deepEqual(response.reset.recoveryFailures, [
      {
        step: 'cleanup-review recovery inspection',
        message: 'Synthetic cleanup-review recovery inspection failure'
      }
    ]);
    assert.match(response.reset.note, /target-access recovery obligation/i);
    assert.match(response.reset.note, /one or more recovery checks/i);
    assert.doesNotMatch(response.reset.note, /disprove\s+\./i);
  } finally {
    delete globalThis.chrome;
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

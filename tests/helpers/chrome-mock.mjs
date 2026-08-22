import { readFile } from 'node:fs/promises';

const manifestUrl = new URL('../../src/manifest.json', import.meta.url);
const DEFAULT_RUNTIME_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

export function createChromeActionPopupContext(overrides = {}) {
  const runtimeId = overrides.runtimeId || DEFAULT_RUNTIME_ID;
  const { runtimeId: _runtimeId, ...contextOverrides } = overrides;
  return {
    contextId: 'mock-action-popup-context',
    contextType: 'POPUP',
    documentId: 'mock-action-popup-document',
    documentOrigin: `chrome-extension://${runtimeId}`,
    documentUrl: `chrome-extension://${runtimeId}/popup/popup.html`,
    frameId: 0,
    tabId: -1,
    windowId: -1,
    incognito: false,
    ...clone(contextOverrides)
  };
}

export async function createChromeMock(options = {}) {
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
  const runtimeId = options.runtimeId || DEFAULT_RUNTIME_ID;
  const currentWindow = options.currentWindow || { id: 1, incognito: false };
  const calls = [];
  const localState = clone(options.localState || {});
  const sessionState = clone(options.sessionState || {});
  const tabState = new Map((options.tabs || []).map((tab) => [tab.id, clone(tab)]));
  const cookieState = [...(options.cookies || [])].map(clone);
  const historyState = [...(options.history || [])].map(clone);
  const downloadState = [...(options.downloads || [])].map(clone);
  const dnrRules = [...(options.dnrRules || [])].map(clone);
  const namedPermissions = new Set(options.namedPermissions || manifest.permissions || []);
  const originPermissions = new Set(options.originPermissions || []);
  const configuredRuntimeContexts =
    options.runtimeContexts === undefined
      ? [
          createChromeActionPopupContext({
            runtimeId,
            incognito: manifest.incognito === 'split' && Boolean(currentWindow.incognito)
          })
        ]
      : options.runtimeContexts;
  const runtimeContexts = [...configuredRuntimeContexts].map(clone);
  const alarms = new Map();

  const events = {
    runtimeInstalled: createEvent(),
    runtimeStartup: createEvent(),
    runtimeMessage: createEvent(),
    storageChanged: createEvent(),
    alarm: createEvent(),
    permissionAdded: createEvent()
  };

  const chrome = {
    __calls: calls,
    __events: events,
    __state: {
      local: localState,
      session: sessionState,
      tabs: tabState,
      cookies: cookieState,
      history: historyState,
      downloads: downloadState,
      dnrRules,
      namedPermissions,
      originPermissions,
      runtimeContexts,
      alarms
    },
    runtime: {
      id: runtimeId,
      onInstalled: events.runtimeInstalled,
      onStartup: events.runtimeStartup,
      onMessage: events.runtimeMessage,
      getManifest: () => clone(manifest),
      getContexts: async (filter = {}) =>
        record(
          calls,
          'runtime.getContexts',
          [filter],
          runtimeContexts.filter(
            (context) =>
              (!Array.isArray(filter.contextIds) || filter.contextIds.includes(context.contextId)) &&
              (!Array.isArray(filter.documentIds) || filter.documentIds.includes(context.documentId)) &&
              (!Array.isArray(filter.contextTypes) || filter.contextTypes.includes(context.contextType)) &&
              (!Array.isArray(filter.documentOrigins) || filter.documentOrigins.includes(context.documentOrigin)) &&
              (!Array.isArray(filter.documentUrls) || filter.documentUrls.includes(context.documentUrl)) &&
              (!Array.isArray(filter.frameIds) || filter.frameIds.includes(context.frameId)) &&
              (typeof filter.incognito !== 'boolean' || filter.incognito === context.incognito) &&
              (!Array.isArray(filter.tabIds) || filter.tabIds.includes(context.tabId)) &&
              (!Array.isArray(filter.windowIds) || filter.windowIds.includes(context.windowId))
          )
        ),
      openOptionsPage: async () => record(calls, 'runtime.openOptionsPage', [], undefined),
      getURL: (path = '') => `chrome-extension://${chrome.runtime.id}/${String(path).replace(/^\//, '')}`
    },
    storage: {
      local: createStorageArea(localState, 'local', events.storageChanged, calls),
      session: createStorageArea(sessionState, 'session', events.storageChanged, calls),
      onChanged: events.storageChanged
    },
    permissions: {
      onAdded: events.permissionAdded,
      contains: async (request = {}) => {
        record(calls, 'permissions.contains', [request]);
        return (
          everyPresent(request.permissions, namedPermissions) &&
          everyHostPermissionPresent(request.origins, originPermissions)
        );
      },
      request: async (request = {}) => {
        record(calls, 'permissions.request', [request]);
        if (options.permissionRequestResult === false) return false;
        for (const permission of request.permissions || []) namedPermissions.add(permission);
        for (const origin of request.origins || []) originPermissions.add(origin);
        events.permissionAdded.emit(clone(request));
        return true;
      },
      remove: async (request = {}) => {
        record(calls, 'permissions.remove', [request]);
        for (const permission of request.permissions || []) namedPermissions.delete(permission);
        for (const origin of request.origins || []) originPermissions.delete(origin);
        return true;
      },
      getAll: async () =>
        record(calls, 'permissions.getAll', [], {
          permissions: [...namedPermissions],
          origins: [...originPermissions]
        })
    },
    alarms: {
      onAlarm: events.alarm,
      create: async (name, info) => {
        record(calls, 'alarms.create', [name, info]);
        alarms.set(name, { name, ...clone(info) });
      },
      clear: async (name) => {
        record(calls, 'alarms.clear', [name]);
        return alarms.delete(name);
      },
      get: async (name) => clone(alarms.get(name) || null),
      getAll: async () => [...alarms.values()].map(clone)
    },
    extension: {
      isAllowedIncognitoAccess: (...args) => {
        const allowed = Boolean(options.incognitoAllowed);
        record(calls, 'extension.isAllowedIncognitoAccess', []);
        const callback = args.at(-1);
        if (typeof callback === 'function') {
          callback(allowed);
          return undefined;
        }
        return Promise.resolve(allowed);
      }
    },
    browsingData: {
      remove: async (removalOptions, dataTypes) =>
        record(calls, 'browsingData.remove', [removalOptions, dataTypes], undefined)
    },
    cookies: {
      getAllCookieStores: async () => clone(options.cookieStores || [{ id: '0', tabIds: [] }]),
      getAll: async (details = {}) => {
        record(calls, 'cookies.getAll', [details]);
        return clone(cookieState.filter((cookie) => !details.storeId || cookie.storeId === details.storeId));
      },
      remove: async (details) => {
        record(calls, 'cookies.remove', [details]);
        const index = cookieState.findIndex(
          (cookie) => cookie.name === details.name && cookie.storeId === details.storeId
        );
        if (index < 0) return null;
        const [removed] = cookieState.splice(index, 1);
        return { url: details.url, name: removed.name, storeId: removed.storeId };
      }
    },
    tabs: {
      query: async (queryInfo = {}) => {
        record(calls, 'tabs.query', [queryInfo]);
        return [...tabState.values()].filter((tab) => matchesTabQuery(tab, queryInfo)).map(clone);
      },
      get: async (tabId) => {
        record(calls, 'tabs.get', [tabId]);
        if (!tabState.has(tabId)) throw new Error(`No tab with id ${tabId}.`);
        return clone(tabState.get(tabId));
      },
      update: async (tabId, updateProperties) => {
        record(calls, 'tabs.update', [tabId, updateProperties]);
        if (!tabState.has(tabId)) throw new Error(`No tab with id ${tabId}.`);
        const next = { ...tabState.get(tabId), ...clone(updateProperties) };
        tabState.set(tabId, next);
        return clone(next);
      },
      remove: async (tabIds) => {
        record(calls, 'tabs.remove', [tabIds]);
        for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) tabState.delete(tabId);
      },
      sendMessage: async (tabId, message, sendOptions) =>
        record(calls, 'tabs.sendMessage', [tabId, message, sendOptions], { ok: true }),
      getZoom: async () => 1,
      setZoom: async (tabId, zoomFactor) => record(calls, 'tabs.setZoom', [tabId, zoomFactor], undefined)
    },
    history: {
      search: async (query) => {
        record(calls, 'history.search', [query]);
        return clone(historyState);
      },
      deleteUrl: async (details) => {
        record(calls, 'history.deleteUrl', [details]);
        for (let index = historyState.length - 1; index >= 0; index -= 1) {
          if (historyState[index].url === details.url) historyState.splice(index, 1);
        }
      }
    },
    downloads: {
      search: async (query) => {
        record(calls, 'downloads.search', [query]);
        return clone(downloadState);
      },
      erase: async (query) => {
        record(calls, 'downloads.erase', [query]);
        const erased = downloadState.filter((item) => query.id == null || item.id === query.id).map((item) => item.id);
        for (let index = downloadState.length - 1; index >= 0; index -= 1) {
          if (query.id == null || downloadState[index].id === query.id) downloadState.splice(index, 1);
        }
        return erased;
      },
      removeFile: async (downloadId) => record(calls, 'downloads.removeFile', [downloadId], undefined)
    },
    scripting: {
      executeScript: async (injection) => record(calls, 'scripting.executeScript', [injection], []),
      insertCSS: async (injection) => record(calls, 'scripting.insertCSS', [injection], undefined),
      removeCSS: async (injection) => record(calls, 'scripting.removeCSS', [injection], undefined)
    },
    webNavigation: {
      getAllFrames: async (details) => record(calls, 'webNavigation.getAllFrames', [details], [])
    },
    declarativeNetRequest: {
      getSessionRules: async () => clone(dnrRules),
      updateSessionRules: async ({ removeRuleIds = [], addRules = [] } = {}) => {
        record(calls, 'declarativeNetRequest.updateSessionRules', [{ removeRuleIds, addRules }]);
        const removed = new Set(removeRuleIds);
        for (let index = dnrRules.length - 1; index >= 0; index -= 1) {
          if (removed.has(dnrRules[index].id)) dnrRules.splice(index, 1);
        }
        dnrRules.push(...addRules.map(clone));
      }
    },
    sessions: {
      getRecentlyClosed: async (filter) => record(calls, 'sessions.getRecentlyClosed', [filter], [])
    },
    sidePanel: {
      open: async (details) => record(calls, 'sidePanel.open', [details], undefined)
    },
    windows: {
      getCurrent: async () => clone(options.currentWindow || { id: 1, incognito: false }),
      get: async (windowId) => {
        record(calls, 'windows.get', [windowId]);
        const current = options.currentWindow || { id: 1, incognito: false };
        return clone({
          id: windowId,
          incognito: current.id === windowId ? Boolean(current.incognito) : false
        });
      }
    },
    action: {
      setBadgeText: async (details) => record(calls, 'action.setBadgeText', [details], undefined),
      setBadgeBackgroundColor: async (details) => record(calls, 'action.setBadgeBackgroundColor', [details], undefined)
    }
  };

  chrome.runtime.sendMessage = (message) =>
    dispatchRuntimeMessage(chrome, message, {
      id: chrome.runtime.id,
      documentUrl: chrome.runtime.getURL('test.html')
    });

  return chrome;
}

export function createEvent() {
  const listeners = new Set();
  return {
    addListener(listener) {
      listeners.add(listener);
    },
    removeListener(listener) {
      listeners.delete(listener);
    },
    hasListener(listener) {
      return listeners.has(listener);
    },
    get listenerCount() {
      return listeners.size;
    },
    emit(...args) {
      return [...listeners].map((listener) => listener(...args));
    },
    async emitAsync(...args) {
      return Promise.all([...listeners].map((listener) => listener(...args)));
    }
  };
}

export async function dispatchRuntimeMessage(chrome, message, sender = {}) {
  const listeners = chrome.runtime.onMessage.emit;
  if (typeof listeners !== 'function' || chrome.runtime.onMessage.listenerCount === 0) {
    throw new Error('No runtime message listener is registered.');
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) reject(new Error('Mock runtime message timed out.'));
    }, 1000);
    const sendResponse = (response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(clone(response));
    };
    try {
      chrome.runtime.onMessage.emit(message, sender, sendResponse);
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

function createStorageArea(state, areaName, changedEvent, calls) {
  return {
    async get(keys) {
      record(calls, `storage.${areaName}.get`, [keys]);
      if (keys == null) return clone(state);
      if (typeof keys === 'string') return Object.hasOwn(state, keys) ? { [keys]: clone(state[keys]) } : {};
      if (Array.isArray(keys)) {
        return Object.fromEntries(
          keys.filter((key) => Object.hasOwn(state, key)).map((key) => [key, clone(state[key])])
        );
      }
      if (keys && typeof keys === 'object') {
        return Object.fromEntries(
          Object.entries(keys).map(([key, fallback]) => [
            key,
            Object.hasOwn(state, key) ? clone(state[key]) : clone(fallback)
          ])
        );
      }
      return {};
    },
    async set(values) {
      record(calls, `storage.${areaName}.set`, [values]);
      const changes = {};
      for (const [key, value] of Object.entries(values || {})) {
        changes[key] = { oldValue: clone(state[key]), newValue: clone(value) };
        state[key] = clone(value);
      }
      changedEvent.emit(changes, areaName);
    },
    async remove(keys) {
      record(calls, `storage.${areaName}.remove`, [keys]);
      const changes = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (!Object.hasOwn(state, key)) continue;
        changes[key] = { oldValue: clone(state[key]), newValue: undefined };
        delete state[key];
      }
      changedEvent.emit(changes, areaName);
    },
    async clear() {
      record(calls, `storage.${areaName}.clear`, []);
      const changes = {};
      for (const [key, value] of Object.entries(state)) changes[key] = { oldValue: clone(value) };
      for (const key of Object.keys(state)) delete state[key];
      changedEvent.emit(changes, areaName);
    }
  };
}

function matchesTabQuery(tab, queryInfo) {
  if (queryInfo.active != null && Boolean(tab.active) !== Boolean(queryInfo.active)) return false;
  if (queryInfo.currentWindow && tab.currentWindow === false) return false;
  if (queryInfo.lastFocusedWindow && tab.lastFocusedWindow === false) return false;
  if (Number.isInteger(queryInfo.windowId) && tab.windowId !== queryInfo.windowId) return false;
  return true;
}

function everyPresent(values, set) {
  return (values || []).every((value) => set.has(value));
}

function everyHostPermissionPresent(values, set) {
  return (values || []).every((value) => {
    if (set.has(value) || set.has('<all_urls>') || set.has('*://*/*')) return true;
    if (String(value).startsWith('http://') && set.has('http://*/*')) return true;
    if (String(value).startsWith('https://') && set.has('https://*/*')) return true;
    return false;
  });
}

function record(calls, api, args, result) {
  calls.push({ api, args: clone(args) });
  return clone(result);
}

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

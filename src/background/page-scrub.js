import {
  buildPageScrubScope,
  tabIsWithinReviewedPrivateScope,
  tabMatchesReviewedCleanupTarget
} from '../shared/target-scope.js';
import { readableMessage, throwIfCancellationRequested, withTimeoutReject, yieldEvery } from './operation-control.js';
import { addSection, addUnavailable, createAdapterOutcome } from './report.js';

const MAX_PAGE_SCRIPT_TABS = 25;
const PAGE_SCRIPT_TIMEOUT_MS = 2_000;
const PAGE_INJECTION_TIMEOUT_MS = 10_000;
const MAX_PAGE_SCRIPT_INDEXED_DBS = 20;
const MAX_PAGE_SCRIPT_CACHES = 30;
const MAX_PAGE_SCRIPT_BUCKETS = 20;
const MAX_PAGE_SCRIPT_OPFS_ENTRIES = 100;

export async function scrubOpenPageData(target, report, context, options = {}) {
  if (options.pageScriptScrub !== true) {
    addSection(report, 'pageScriptScrub', 'Live page-visible storage scrub disabled', 'skipped', {
      reason: 'Disabled in settings.'
    });
    return;
  }
  if (!chrome.scripting?.executeScript) {
    addUnavailable(
      report,
      'Live page-visible storage scrub',
      'chrome.scripting.executeScript is unavailable in this browser context.'
    );
    return;
  }

  const frameGroups = new Map();
  const matchingFrames = Array.isArray(context?.matchingFrames) ? context.matchingFrames : [];
  for (const frame of matchingFrames) {
    if (!Number.isInteger(frame.tabId) || !Number.isInteger(frame.frameId)) continue;
    const current = frameGroups.get(frame.tabId) || {
      frameIds: new Set(),
      urls: []
    };
    current.frameIds.add(frame.frameId);
    current.urls.push(frame.url);
    frameGroups.set(frame.tabId, current);
  }

  const matchingTabs = Array.isArray(context?.matchingTabs) ? context.matchingTabs : [];
  const fallbackTabs = matchingTabs.map((tab) => tab.id).filter((id) => Number.isInteger(id) && !frameGroups.has(id));

  const targets = [
    ...[...frameGroups.entries()].map(([tabId, info]) => ({
      tabId,
      frameIds: [...info.frameIds],
      mode: 'matchedFrames',
      requiresTargetTabMatch: false,
      urls: info.urls
    })),
    ...fallbackTabs.map((tabId) => ({
      tabId,
      allFrames: true,
      mode: 'allFramesFallback',
      requiresTargetTabMatch: true,
      urls: []
    }))
  ].slice(0, MAX_PAGE_SCRIPT_TABS);

  if (!targets.length) {
    addSection(report, 'pageScriptScrub', 'No open matching page frames to scrub', 'skipped', {
      reason: 'No matching open page or frame was visible to the extension before cleanup.'
    });
    return;
  }
  if (typeof chrome.tabs?.get !== 'function') {
    addUnavailable(
      report,
      'Live page-visible storage scrub',
      'chrome.tabs.get is unavailable, so SiteWipe refused to inject a cleanup script without live target and private-scope revalidation.'
    );
    return;
  }

  const totals = {
    tabsAttempted: 0,
    injectionsCompleted: 0,
    injectionFailures: 0,
    injectionTimeouts: 0,
    injectionResults: 0,
    framesMatched: 0,
    localStorageCleared: 0,
    sessionStorageCleared: 0,
    indexedDBDeleted: 0,
    cachesDeleted: 0,
    serviceWorkersUnregistered: 0,
    pushSubscriptionsUnsubscribed: 0,
    backgroundSyncTagsObserved: 0,
    periodicSyncTagsUnregistered: 0,
    storageBucketsDeleted: 0,
    opfsEntriesDeleted: 0,
    opfsFilesDeleted: 0,
    opfsDirectoriesDeleted: 0,
    appBadgeCleared: 0,
    permissionStates: {},
    targetsSkippedAfterRevalidation: 0,
    storageEstimateBeforeUsage: null,
    storageEstimateAfterUsage: null,
    persistentStorageBefore: null,
    cookiesExpired: 0,
    worldsAttempted: [],
    worldResults: {},
    timedOutFrames: 0,
    unknownOutcomeFrames: 0,
    errors: []
  };

  // Page JavaScript can monkeypatch MAIN-world APIs and fabricate evidence.
  // Keep every live-page mutation and observation in Chrome's isolated world.
  const worlds = ['ISOLATED'];
  totals.worldsAttempted = worlds;

  for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
    await yieldEvery(targetIndex, 5);
    await throwIfCancellationRequested(options.shouldCancel, 'the next live-page scrub');
    options.operationBudget?.check('the next live-page scrub');
    const item = targets[targetIndex];
    let liveTab;
    try {
      options.operationBudget?.claimQuery('live-page scrub tab revalidation');
      liveTab = await chrome.tabs.get(item.tabId);
    } catch (error) {
      totals.targetsSkippedAfterRevalidation += 1;
      totals.errors.push({
        tabId: item.tabId,
        mode: item.mode,
        world: 'revalidation',
        message: readableMessage(error)
      });
      continue;
    }
    const privateScopeAllowed = tabIsWithinReviewedPrivateScope(liveTab, options.incognitoAccess === true);
    const targetStillAllowed =
      item.requiresTargetTabMatch !== true ||
      tabMatchesReviewedCleanupTarget(liveTab, target, options.incognitoAccess === true);
    if (!privateScopeAllowed || !targetStillAllowed) {
      totals.targetsSkippedAfterRevalidation += 1;
      continue;
    }
    totals.tabsAttempted += 1;
    const targetSpec = item.frameIds?.length
      ? { tabId: item.tabId, frameIds: item.frameIds }
      : { tabId: item.tabId, allFrames: true };

    for (const world of worlds) {
      try {
        const results = await withTimeoutReject(
          chrome.scripting.executeScript({
            target: targetSpec,
            world,
            func: pageVisibleStorageScrubber,
            args: [
              buildPageScrubScope(target),
              options.storageBucketScrub === true,
              {
                timeoutMs: PAGE_SCRIPT_TIMEOUT_MS,
                maxIndexedDB: MAX_PAGE_SCRIPT_INDEXED_DBS,
                maxCaches: MAX_PAGE_SCRIPT_CACHES,
                maxBuckets: MAX_PAGE_SCRIPT_BUCKETS,
                maxOPFSEntries: MAX_PAGE_SCRIPT_OPFS_ENTRIES,
                includeOPFS: options.opfsScrub === true,
                includeServiceWorkerExtras: options.serviceWorkerExtraScrub === true,
                includeAppBadgeClear: options.appBadgeClear === true,
                includePermissionAudit: options.permissionAudit === true
              }
            ]
          }),
          PAGE_INJECTION_TIMEOUT_MS,
          'scripting.executeScript live-page scrub'
        );
        const worldStats = totals.worldResults[world] || {
          injections: 0,
          matchedFrames: 0
        };
        totals.injectionsCompleted += 1;
        worldStats.injections += Array.isArray(results) ? results.length : 0;
        totals.injectionResults += Array.isArray(results) ? results.length : 0;
        for (const result of results || []) {
          const value = result?.result;
          if (!value?.matched) continue;
          totals.framesMatched += 1;
          worldStats.matchedFrames += 1;
          totals.localStorageCleared += value.localStorageCleared || 0;
          totals.sessionStorageCleared += value.sessionStorageCleared || 0;
          totals.indexedDBDeleted += value.indexedDBDeleted || 0;
          totals.cachesDeleted += value.cachesDeleted || 0;
          totals.serviceWorkersUnregistered += value.serviceWorkersUnregistered || 0;
          totals.pushSubscriptionsUnsubscribed += value.pushSubscriptionsUnsubscribed || 0;
          totals.backgroundSyncTagsObserved += value.backgroundSyncTagsObserved || 0;
          totals.periodicSyncTagsUnregistered += value.periodicSyncTagsUnregistered || 0;
          totals.storageBucketsDeleted += value.storageBucketsDeleted || 0;
          totals.opfsEntriesDeleted += value.opfsEntriesDeleted || 0;
          totals.opfsFilesDeleted += value.opfsFilesDeleted || 0;
          totals.opfsDirectoriesDeleted += value.opfsDirectoriesDeleted || 0;
          totals.appBadgeCleared += value.appBadgeCleared ? 1 : 0;
          mergePermissionStates(totals.permissionStates, value.permissionStates);
          if (value.storageEstimateBefore?.usage != null && totals.storageEstimateBeforeUsage == null) {
            totals.storageEstimateBeforeUsage = value.storageEstimateBefore.usage;
          }
          if (value.storageEstimateAfter?.usage != null && totals.storageEstimateAfterUsage == null) {
            totals.storageEstimateAfterUsage = value.storageEstimateAfter.usage;
          }
          if (value.persistentStorageBefore != null && totals.persistentStorageBefore == null) {
            totals.persistentStorageBefore = value.persistentStorageBefore;
          }
          totals.cookiesExpired += value.cookiesExpired || 0;
          if (value.timedOut) totals.timedOutFrames += 1;
          if (value.outcomeUnknown) totals.unknownOutcomeFrames += 1;
          if (Array.isArray(value.errors) && value.errors.length) {
            totals.errors.push(
              ...value.errors.map((message) => ({
                tabId: item.tabId,
                frameId: result.frameId,
                world,
                message
              }))
            );
          }
        }
        totals.worldResults[world] = worldStats;
      } catch (error) {
        if (error?.name === 'AbortError' || error?.name === 'OperationBudgetExceededError') throw error;
        if (error?.name === 'OperationTimeoutError') {
          totals.injectionTimeouts += 1;
          totals.unknownOutcomeFrames += 1;
        } else {
          totals.injectionFailures += 1;
        }
        totals.errors.push({
          tabId: item.tabId,
          mode: item.mode,
          world,
          message: readableMessage(error)
        });
      }
    }
  }

  report.summary.pageScriptTabsAttempted = totals.tabsAttempted;
  report.summary.pageScriptFramesMatched = totals.framesMatched;
  report.summary.pageScriptLocalStorageCleared = totals.localStorageCleared;
  report.summary.pageScriptSessionStorageCleared = totals.sessionStorageCleared;
  report.summary.pageScriptIndexedDBDeleted = totals.indexedDBDeleted;
  report.summary.pageScriptCachesDeleted = totals.cachesDeleted;
  report.summary.pageScriptServiceWorkersUnregistered = totals.serviceWorkersUnregistered;
  report.summary.pageScriptPushSubscriptionsUnsubscribed = totals.pushSubscriptionsUnsubscribed;
  report.summary.pageScriptBackgroundSyncTagsObserved = totals.backgroundSyncTagsObserved;
  report.summary.pageScriptBackgroundSyncTagsUnregistered = 0;
  report.summary.pageScriptPeriodicSyncTagsUnregistered = totals.periodicSyncTagsUnregistered;
  report.summary.pageScriptStorageBucketsDeleted = totals.storageBucketsDeleted;
  report.summary.pageScriptOPFSEntriesDeleted = totals.opfsEntriesDeleted;
  report.summary.pageScriptOPFSFilesDeleted = totals.opfsFilesDeleted;
  report.summary.pageScriptOPFSDirectoriesDeleted = totals.opfsDirectoriesDeleted;
  report.summary.pageScriptAppBadgeCleared = totals.appBadgeCleared;
  report.summary.pageScriptPersistentStorageBefore = totals.persistentStorageBefore;
  report.summary.pageScriptStorageEstimateBeforeUsage = totals.storageEstimateBeforeUsage;
  report.summary.pageScriptStorageEstimateAfterUsage = totals.storageEstimateAfterUsage;
  report.summary.pageScriptCookiesExpired = totals.cookiesExpired;
  report.summary.pageScriptWorldsAttempted = totals.worldsAttempted.join(', ');

  addSection(
    report,
    'pageScriptScrub',
    'Live page-visible storage scrubbed before tab close',
    totals.errors.length ||
      totals.unknownOutcomeFrames ||
      totals.targetsSkippedAfterRevalidation ||
      frameGroups.size + fallbackTabs.length > MAX_PAGE_SCRIPT_TABS
      ? 'partial'
      : 'success',
    {
      ...totals,
      targetCount: targets.length,
      targetLimitReached: frameGroups.size + fallbackTabs.length > MAX_PAGE_SCRIPT_TABS,
      injectionTimeoutMs: PAGE_INJECTION_TIMEOUT_MS,
      outcome: createAdapterOutcome({
        attempted: totals.tabsAttempted * worlds.length,
        succeeded: totals.injectionsCompleted,
        failed: totals.injectionFailures,
        timedOut: totals.injectionTimeouts,
        unknown: totals.unknownOutcomeFrames,
        capped: frameGroups.size + fallbackTabs.length > MAX_PAGE_SCRIPT_TABS
      }),
      note: 'This pre-close pass runs only in the isolated extension world so target-page JavaScript cannot replace the APIs used by the scrubber or fabricate its evidence. It clears page-visible localStorage/sessionStorage, Cache API entries, IndexedDB databases, Storage Buckets API buckets where exposed, OPFS files where exposed, visible document cookies, service-worker registrations, push subscriptions, periodic-sync tags, and app badges. One-off Background Sync tags are observed for evidence but have no tag-level unregister API; unregistering the owning service worker is attempted. HttpOnly cookies and closed-page storage are handled by chrome.cookies and chrome.browsingData passes.'
    }
  );
}

function mergePermissionStates(target, states) {
  if (!states || typeof states !== 'object') return;
  for (const [name, state] of Object.entries(states)) {
    const bucket = target[name] || {
      granted: 0,
      prompt: 0,
      denied: 0,
      unavailable: 0,
      unknown: 0
    };
    const key = ['granted', 'prompt', 'denied', 'unavailable'].includes(state) ? state : 'unknown';
    bucket[key] += 1;
    target[name] = bucket;
  }
}

// This function is serialized by chrome.scripting.executeScript. It must stay
// completely self-contained: imported helpers are not available in the page.
export async function pageVisibleStorageScrubber(targetScope, includeStorageBuckets = false, limits = {}) {
  const errors = [];
  const timeoutMs = Math.max(500, Number(limits?.timeoutMs) || 2_000);
  const maxIndexedDB = Math.max(0, Number(limits?.maxIndexedDB) || 50);
  const maxCaches = Math.max(0, Number(limits?.maxCaches) || 75);
  const maxBuckets = Math.max(0, Number(limits?.maxBuckets) || 50);
  const maxOPFSEntries = Math.max(0, Number(limits?.maxOPFSEntries) || 100);
  const includeOPFS = limits?.includeOPFS === true;
  const includeServiceWorkerExtras = limits?.includeServiceWorkerExtras === true;
  const includeAppBadgeClear = limits?.includeAppBadgeClear === true;
  const includePermissionAudit = limits?.includePermissionAudit === true;
  const host = String(location.hostname || '')
    .toLowerCase()
    .replace(/\.$/, '');
  const origin = String(location.origin || '')
    .toLowerCase()
    .replace(/\/$/, '');
  const scopes = Array.isArray(targetScope) ? targetScope : [];
  const matched = scopes.some((item) => {
    if (item?.matchMode === 'exact_origin') {
      return Boolean(
        origin &&
        origin ===
          String(item.exactOrigin || '')
            .toLowerCase()
            .replace(/\/$/, '')
      );
    }
    const domain = String(item?.domain || '')
      .toLowerCase()
      .replace(/\.$/, '');
    return Boolean(host && domain && (host === domain || host.endsWith(`.${domain}`)));
  });
  const result = {
    matched,
    origin: location.origin,
    localStorageCleared: 0,
    sessionStorageCleared: 0,
    indexedDBDeleted: 0,
    cachesDeleted: 0,
    serviceWorkersUnregistered: 0,
    pushSubscriptionsUnsubscribed: 0,
    backgroundSyncTagsObserved: 0,
    periodicSyncTagsUnregistered: 0,
    storageBucketsDeleted: 0,
    opfsEntriesDeleted: 0,
    opfsFilesDeleted: 0,
    opfsDirectoriesDeleted: 0,
    cookiesExpired: 0,
    appBadgeCleared: false,
    permissionStates: {},
    persistentStorageBefore: null,
    storageEstimateBefore: null,
    storageEstimateAfter: null,
    timedOut: false,
    outcomeUnknown: false,
    lateOperationsMayContinue: false,
    errors
  };
  if (!matched) return result;

  const cleanup = (async () => {
    await captureStorageMetadata('Before');
    if (includePermissionAudit) await auditPagePermissions();

    try {
      const count = localStorage.length;
      localStorage.clear();
      result.localStorageCleared = count;
    } catch (error) {
      errors.push(`localStorage: ${error?.message || String(error)}`);
    }

    try {
      const count = sessionStorage.length;
      sessionStorage.clear();
      result.sessionStorageCleared = count;
    } catch (error) {
      errors.push(`sessionStorage: ${error?.message || String(error)}`);
    }

    try {
      const cookieNames = [
        ...new Set(
          document.cookie
            .split(';')
            .map((part) => part.split('=')[0]?.trim())
            .filter(Boolean)
        )
      ];
      const domains = cookieDomainVariants(location.hostname, scopes);
      const paths = cookiePathVariants(location.pathname);
      for (const name of cookieNames) {
        for (const path of paths) {
          document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; max-age=0; path=${path}`;
          for (const cookieDomain of domains) {
            document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; max-age=0; path=${path}; domain=${cookieDomain}`;
          }
        }
      }
      result.cookiesExpired = cookieNames.length;
    } catch (error) {
      errors.push(`document.cookie: ${error?.message || String(error)}`);
    }

    const asyncTasks = [];
    if (typeof caches !== 'undefined' && caches?.keys) {
      asyncTasks.push(
        caches
          .keys()
          .then((keys) =>
            Promise.all((keys || []).slice(0, maxCaches).map((key) => caches.delete(key))).then((deleted) => {
              result.cachesDeleted = deleted.filter(Boolean).length;
              if ((keys || []).length > maxCaches) errors.push(`Cache API: capped at ${maxCaches} entries this run`);
            })
          )
          .catch((error) => errors.push(`Cache API: ${error?.message || String(error)}`))
      );
    }

    if (typeof indexedDB !== 'undefined' && indexedDB?.databases) {
      asyncTasks.push(
        indexedDB
          .databases()
          .then((databases) => {
            const names = (databases || []).map((database) => database?.name).filter(Boolean);
            return Promise.all(names.slice(0, maxIndexedDB).map(deleteIndexedDBDatabase)).then((deleted) => {
              result.indexedDBDeleted = deleted.filter(Boolean).length;
              if (names.length > maxIndexedDB) errors.push(`IndexedDB: capped at ${maxIndexedDB} databases this run`);
            });
          })
          .catch((error) => errors.push(`IndexedDB: ${error?.message || String(error)}`))
      );
    }

    if (navigator.serviceWorker?.getRegistrations) {
      asyncTasks.push(
        navigator.serviceWorker
          .getRegistrations()
          .then((registrations) =>
            Promise.all(registrations.map((registration) => cleanupServiceWorkerRegistration(registration))).then(
              (stats) => {
                for (const item of stats) {
                  result.serviceWorkersUnregistered += item.unregistered ? 1 : 0;
                  result.pushSubscriptionsUnsubscribed += item.pushUnsubscribed ? 1 : 0;
                  result.backgroundSyncTagsObserved += item.syncTagsObserved || 0;
                  result.periodicSyncTagsUnregistered += item.periodicSyncTags || 0;
                }
              }
            )
          )
          .catch((error) => errors.push(`ServiceWorker: ${error?.message || String(error)}`))
      );
    }

    if (includeStorageBuckets && navigator.storageBuckets?.keys && navigator.storageBuckets?.delete) {
      asyncTasks.push(
        navigator.storageBuckets
          .keys()
          .then((bucketNames) => {
            const names = (bucketNames || []).filter(Boolean);
            return Promise.all(
              names.slice(0, maxBuckets).map((bucketName) =>
                navigator.storageBuckets.delete(bucketName).then(
                  () => true,
                  () => false
                )
              )
            ).then((deleted) => {
              result.storageBucketsDeleted = deleted.filter(Boolean).length;
              if (names.length > maxBuckets) errors.push(`Storage Buckets: capped at ${maxBuckets} buckets this run`);
            });
          })
          .catch((error) => errors.push(`Storage Buckets: ${error?.message || String(error)}`))
      );
    }

    if (includeOPFS && navigator.storage?.getDirectory) {
      asyncTasks.push(
        deleteOPFSRoot(maxOPFSEntries)
          .then((stats) => {
            result.opfsEntriesDeleted = stats.entries;
            result.opfsFilesDeleted = stats.files;
            result.opfsDirectoriesDeleted = stats.directories;
            if (stats.capped) errors.push(`OPFS: capped at ${maxOPFSEntries} entries this run`);
          })
          .catch((error) => errors.push(`OPFS: ${error?.message || String(error)}`))
      );
    }

    if (includeAppBadgeClear && navigator.clearAppBadge) {
      asyncTasks.push(
        Promise.resolve()
          .then(() => navigator.clearAppBadge())
          .then(() => {
            result.appBadgeCleared = true;
          })
          .catch((error) => errors.push(`Badging API: ${error?.message || String(error)}`))
      );
    }

    await Promise.all(asyncTasks);
    await captureStorageMetadata('After');
    return result;
  })();

  let timeoutId = null;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      errors.push(`Live scrub timed out after ${timeoutMs}ms; remaining async page cleanup may be skipped by Chrome.`);
      result.timedOut = true;
      result.outcomeUnknown = true;
      result.lateOperationsMayContinue = true;
      resolve(JSON.parse(JSON.stringify(result)));
    }, timeoutMs);
  });
  const outcome = await Promise.race([cleanup, timeout]);
  if (timeoutId !== null) clearTimeout(timeoutId);
  return outcome;

  async function captureStorageMetadata(when) {
    if (navigator.storage?.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        result[`storageEstimate${when}`] = compactStorageEstimate(estimate);
      } catch (error) {
        errors.push(`Storage estimate ${when.toLowerCase()}: ${error?.message || String(error)}`);
      }
    }
    if (when === 'Before' && navigator.storage?.persisted) {
      try {
        result.persistentStorageBefore = await navigator.storage.persisted();
      } catch (error) {
        errors.push(`Persistent storage status: ${error?.message || String(error)}`);
      }
    }
  }

  async function auditPagePermissions() {
    if (!navigator.permissions?.query) return;
    const names = [
      'geolocation',
      'notifications',
      'camera',
      'microphone',
      'clipboard-read',
      'clipboard-write',
      'persistent-storage',
      'midi'
    ];
    for (const name of names) {
      try {
        const status = await navigator.permissions.query({ name });
        result.permissionStates[name] = status?.state || 'unknown';
      } catch {
        result.permissionStates[name] = 'unavailable';
      }
    }
  }

  async function cleanupServiceWorkerRegistration(registration) {
    const stats = {
      unregistered: false,
      pushUnsubscribed: false,
      syncTagsObserved: 0,
      periodicSyncTags: 0
    };
    if (includeServiceWorkerExtras) {
      try {
        const subscription = await registration.pushManager?.getSubscription?.();
        if (subscription?.unsubscribe) stats.pushUnsubscribed = Boolean(await subscription.unsubscribe());
      } catch (error) {
        errors.push(`Push subscription: ${error?.message || String(error)}`);
      }
      try {
        const tags = await registration.sync?.getTags?.();
        stats.syncTagsObserved = Array.isArray(tags) ? tags.length : 0;
      } catch (error) {
        errors.push(`Background Sync: ${error?.message || String(error)}`);
      }
      try {
        const tags = await registration.periodicSync?.getTags?.();
        for (const tag of tags || []) {
          try {
            await registration.periodicSync.unregister(tag);
            stats.periodicSyncTags += 1;
          } catch {
            // Continue with the remaining registrations.
          }
        }
      } catch (error) {
        errors.push(`Periodic Background Sync: ${error?.message || String(error)}`);
      }
    }
    try {
      stats.unregistered = Boolean(await registration.unregister());
    } catch (error) {
      errors.push(`ServiceWorker unregister: ${error?.message || String(error)}`);
    }
    return stats;
  }

  async function deleteOPFSRoot(limit) {
    const stats = { entries: 0, files: 0, directories: 0, capped: false };
    const root = await navigator.storage.getDirectory();
    await deleteDirectoryContents(root, stats, limit);
    return stats;
  }

  async function deleteDirectoryContents(directory, stats, limit) {
    if (!directory?.entries) return;
    for await (const [name, handle] of directory.entries()) {
      if (stats.entries >= limit) {
        stats.capped = true;
        return;
      }
      if (handle.kind === 'directory') {
        await deleteDirectoryContents(handle, stats, limit);
        if (stats.capped) return;
        if (directory.removeEntry) {
          try {
            await directory.removeEntry(name, { recursive: true });
            stats.entries += 1;
            stats.directories += 1;
          } catch {
            // A nested OPFS entry can remain locked; continue.
          }
        }
      } else if (directory.removeEntry) {
        try {
          await directory.removeEntry(name);
          stats.entries += 1;
          stats.files += 1;
        } catch {
          // A locked OPFS file remains best-effort residue.
        }
      }
    }
  }

  function compactStorageEstimate(estimate) {
    if (!estimate || typeof estimate !== 'object') return null;
    return {
      usage: Number.isFinite(estimate.usage) ? estimate.usage : null,
      quota: Number.isFinite(estimate.quota) ? estimate.quota : null
    };
  }

  function deleteIndexedDBDatabase(name) {
    return new Promise((resolve) => {
      let request;
      try {
        request = indexedDB.deleteDatabase(name);
      } catch {
        resolve(false);
        return;
      }
      request.onsuccess = () => resolve(true);
      request.onerror = () => resolve(false);
      request.onblocked = () => resolve(false);
    });
  }

  function cookieDomainVariants(hostname, scopeEntries) {
    const cleanHost = String(hostname || '')
      .toLowerCase()
      .replace(/\.$/, '');
    const variants = [cleanHost, `.${cleanHost}`];
    for (const scopeEntry of scopeEntries || []) {
      if (scopeEntry?.matchMode === 'exact_origin') continue;
      const rootDomain = String(scopeEntry?.domain || '')
        .toLowerCase()
        .replace(/\.$/, '');
      if (rootDomain && (cleanHost === rootDomain || cleanHost.endsWith(`.${rootDomain}`))) {
        variants.push(rootDomain, `.${rootDomain}`);
      }
    }
    return [...new Set(variants.filter(Boolean))];
  }

  function cookiePathVariants(pathname) {
    const path = String(pathname || '/');
    const parts = path.split('/').filter(Boolean);
    const paths = ['/'];
    let current = '';
    for (const part of parts) {
      current += `/${part}`;
      paths.push(current);
    }
    return [...new Set(paths)];
  }
}

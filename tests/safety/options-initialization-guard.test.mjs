import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const optionsRoot = new URL('../../src/options/', import.meta.url);

async function source(name) {
  return readFile(new URL(name, optionsRoot), 'utf8');
}

test('Options is fail-closed in markup and every mutating path checks authoritative initialization', async () => {
  const [html, script, fixture] = await Promise.all([
    source('options.html'),
    source('options.js'),
    readFile(new URL('../browser/fixtures/options-browser-mock.js', import.meta.url), 'utf8')
  ]);

  const controls = [...html.matchAll(/<(?:input|select|textarea|button)\b[^>]*>/g)].map((match) => match[0]);
  assert.ok(controls.length > 40, 'the contract must cover the complete Options control surface');
  for (const control of controls) {
    assert.match(control, /\bdisabled\b/, `control must start natively disabled: ${control}`);
  }

  assert.match(
    html,
    /id="optionsLoadError"[\s\S]*?role="alert"[\s\S]*?aria-labelledby="optionsLoadErrorTitle"[\s\S]*?aria-describedby="optionsLoadErrorDetail"/
  );
  assert.match(html, /id="retryOptionsLoad"[\s\S]*?Try loading settings again/);
  assert.match(script, /typeof permissionObservation !== 'boolean'/);
  assert.match(script, /setOptionsLoadFailed\(message\)/);
  assert.match(script, /setOptionsLoading\(\{ afterFailure: true \}\)/);
  assert.match(script, /if \(state\) setOptionsReady\(\{ afterRetry: true \}\)/);

  for (const functionName of [
    'saveFromForm',
    'runMaintenanceNow',
    'resetExtensionState',
    'clearActiveJobRecord',
    'clearActiveShield',
    'repairActiveShield',
    'clearReports',
    'runSelfTests',
    'exportSettingsBackup',
    'importSettingsBackup',
    'copySettingsSummary',
    'clearDebugLog',
    'resetSettings'
  ]) {
    const start = script.indexOf(`function ${functionName}(`);
    const next = script.indexOf('\nfunction ', start + 1);
    const handler = script.slice(start, next < 0 ? script.length : next);
    assert.ok(start >= 0, `${functionName} must exist`);
    assert.match(handler, /requireAuthoritativeState\(\)/, `${functionName} must fail closed before acting`);
  }

  const saveHandler = script.slice(
    script.indexOf('async function saveFromForm('),
    script.indexOf('\nfunction authoritativeFrameDiscoveryEnabled')
  );
  assert.ok(
    saveHandler.indexOf('requireAuthoritativeState()') < saveHandler.indexOf('sendMessage(MESSAGE_TYPES.saveSettings'),
    'the initialization guard must precede saveSettings'
  );
  assert.match(fixture, /fixtureParams\.get\('load'\) === 'fail-once'/);
  assert.match(fixture, /optionsLoadFailuresRemaining -= 1/);
});

test('Options keeps controls disabled through load failure, blocks attempted actions, and hydrates after retry', async () => {
  const html = await source('options.html');
  const controlTags = [...html.matchAll(/<(input|select|textarea|button)\b[^>]*\bid="([^"]+)"[^>]*>/g)];
  const controlIds = controlTags.map((match) => match[2]);
  const document = createFakeDocument(controlIds);
  let rejectInitialLoad;
  const initialLoad = new Promise((_, reject) => {
    rejectInitialLoad = reject;
  });
  let optionsLoads = 0;
  let saveCalls = 0;
  let destructiveCalls = 0;
  let confirmCalls = 0;
  const settings = defaultSettings();

  const previousGlobals = new Map();
  for (const [key, value] of Object.entries({
    document,
    location: { hash: '' },
    requestAnimationFrame: (callback) => callback(),
    addEventListener: () => {},
    confirm: () => {
      confirmCalls += 1;
      return true;
    },
    chrome: {
      runtime: {
        lastError: null,
        async sendMessage(request) {
          if (request.type === 'sitewipe.getOptionsState') {
            optionsLoads += 1;
            if (optionsLoads === 1) return initialLoad;
            return envelope(request, optionsState(settings));
          }
          if (request.type === 'sitewipe.saveSettings') {
            saveCalls += 1;
            Object.assign(settings, structuredClone(request.payload?.settings || {}));
            return envelope(request, { settings: structuredClone(settings) });
          }
          if (
            [
              'sitewipe.clearHistory',
              'sitewipe.clearActiveShield',
              'sitewipe.repairActiveShield',
              'sitewipe.clearActiveJobRecord',
              'sitewipe.runMaintenanceNow',
              'sitewipe.resetExtensionLocalState',
              'sitewipe.clearDebugLog',
              'sitewipe.resetSettings'
            ].includes(request.type)
          ) {
            destructiveCalls += 1;
          }
          if (request.type === 'sitewipe.validateAssociatedGroups') {
            return envelope(request, { validation: { errors: [], warnings: [], groups: [] } });
          }
          return envelope(request, {});
        }
      },
      permissions: {
        contains: async () => false,
        request: async () => false,
        remove: async () => true
      },
      storage: { onChanged: { addListener: () => {} } }
    }
  })) {
    previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  try {
    await import(`${new URL('../../src/options/options.js', import.meta.url).href}?initialization-guard-runtime`);
    const initialization = document.fireDomReady();
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(document.byId('mainContent').getAttribute('aria-busy'), 'true');
    assert.equal(document.byId('settingsStateBadge').textContent, 'Loading settings…');
    for (const id of controlIds) assert.equal(document.byId(id).disabled, true, `${id} must be disabled while loading`);

    rejectInitialLoad(new Error('Synthetic authoritative state failure.'));
    await initialization;

    assert.equal(document.byId('mainContent').getAttribute('aria-busy'), 'false');
    assert.equal(document.byId('settingsStateBadge').textContent, 'Load failed · controls locked');
    assert.equal(document.byId('cleanupModeBadge').textContent, 'Mode: unavailable');
    assert.equal(document.byId('reviewModeBadge').textContent, 'Review: unavailable');
    assert.equal(document.byId('incognitoBadge').textContent, 'Private: unavailable');
    assert.equal(document.byId('optionsLoadError').hidden, false);
    assert.equal(document.byId('retryOptionsLoad').disabled, false);
    for (const id of controlIds.filter((id) => id !== 'retryOptionsLoad')) {
      assert.equal(document.byId(id).disabled, true, `${id} must remain disabled after load failure`);
    }

    document.byId('skipCleanupReview').checked = true;
    await document.byId('skipCleanupReview').emit('change');
    await document.byId('importSettings').emit('click');
    await document.byId('clearReports').emit('click');
    assert.equal(saveCalls, 0, 'an attempted disabled setting change must not save');
    assert.equal(destructiveCalls, 0, 'attempted disabled actions must not reach the service worker');
    assert.equal(confirmCalls, 0, 'blocked actions must not even open a confirmation dialog');

    await document.byId('retryOptionsLoad').emit('click');
    assert.equal(optionsLoads, 2);
    assert.equal(document.byId('mainContent').getAttribute('aria-busy'), 'false');
    assert.equal(document.byId('settingsStateBadge').textContent, 'Settings ready');
    assert.equal(document.byId('optionsLoadError').hidden, true);
    assert.equal(document.byId('skipCleanupReview').checked, false, 'retry must hydrate authoritative values');
    assert.equal(document.byId('skipCleanupReview').disabled, false);
    assert.equal(document.byId('cleanupMode').disabled, false);
    assert.equal(document.byId('clearReports').disabled, false);
    assert.equal(document.byId('importSettings').disabled, false);
    assert.equal(
      document.byId('deleteDownloadedFiles').disabled,
      true,
      'successful retry must retain the normal Standard-mode dependency lock'
    );

    document.byId('skipCleanupReview').checked = true;
    await document.byId('skipCleanupReview').emit('change');
    assert.equal(saveCalls, 1, 'saving becomes available only after successful authoritative hydration');
  } finally {
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

function envelope(request, payload = {}) {
  return {
    protocolVersion: request.protocolVersion,
    requestId: request.requestId,
    ok: true,
    ...payload
  };
}

function optionsState(settings) {
  return {
    settings: structuredClone(settings),
    incognitoAccess: false,
    debugLog: [],
    activeJob: null,
    activeShield: null,
    shieldDiagnostics: {
      siteWipeRuleCount: 0,
      orphanRuleIds: [],
      missingTrackedRuleIds: [],
      healthy: true
    },
    maintenanceStatus: null
  };
}

function defaultSettings() {
  return {
    cleanupMode: 'standard',
    skipCleanupReview: false,
    keepHistory: false,
    reportRetentionDays: 7,
    latestReportRetentionMinutes: 30,
    aggressiveCookieSweep: true,
    includeProtectedWebOrigins: false,
    pageScriptScrub: true,
    storageBucketScrub: false,
    embeddedFrameDiscovery: false,
    probePartitionedCookiesWithEmbeddingSites: false,
    exhaustiveCookieStoreScan: false,
    downloadRecentFallback: false,
    broadDiscoveryFallback: false,
    verificationPass: true,
    temporaryDnrShield: true,
    progressOverlay: true,
    progressOverlayCancelButton: true,
    overlayScope: 'target_tabs',
    postWipeSessionBlock: false,
    postWipeShieldExpiresMinutes: 0,
    autoRepairOrphanedShields: true,
    resetZoom: true,
    resetMutedTabs: false,
    unpinTargetTabs: false,
    opfsScrub: false,
    serviceWorkerExtraScrub: false,
    appBadgeClear: false,
    permissionAudit: true,
    redactReports: true,
    deleteDownloadedFiles: false,
    allowLocalTargets: false,
    blockOnAssociatedGroupErrors: true,
    associatedDomainGroups: '',
    reducedMotion: false,
    highContrast: false,
    debugLog: false
  };
}

function createFakeDocument(controlIds) {
  const elements = new Map();
  const listeners = new Map();
  const document = {
    readyState: 'loading',
    activeElement: null,
    documentElement: { clientHeight: 800 },
    addEventListener(type, callback) {
      listeners.set(type, callback);
    },
    querySelector(selector) {
      if (selector.startsWith('#')) return elements.get(selector.slice(1)) || null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '.setting-row' || selector.startsWith('.rail-nav') || selector === '[data-options-section]') {
        return [];
      }
      if (selector.includes('#mainContent input')) return controlIds.map((id) => elements.get(id));
      return [];
    },
    getElementById(id) {
      return elements.get(id) || null;
    },
    byId(id) {
      return elements.get(id);
    },
    fireDomReady() {
      return listeners.get('DOMContentLoaded')?.();
    }
  };
  document.body = new FakeElement('body', document);
  document.body.classList.add('options-loading');

  for (const id of new Set([
    ...controlIds,
    'mainContent',
    'settingsStateBadge',
    'cleanupModeBadge',
    'reviewModeBadge',
    'incognitoBadge',
    'optionsLoadError',
    'optionsLoadErrorTitle',
    'optionsLoadErrorDetail',
    'permissionCards',
    'activeShieldText',
    'maintenanceText',
    'activeJobText',
    'advancedCleanupGroup',
    'associatedGroupsDiagnostics',
    'debugOutput',
    'settingsPortabilityOutput',
    'selfTestOutput',
    'cleanupModeHelp',
    'toast'
  ])) {
    elements.set(id, new FakeElement(id, document));
  }
  elements.get('optionsLoadError').hidden = true;
  elements.get('toast').hidden = true;
  for (const id of controlIds) elements.get(id).disabled = true;
  elements.get('cleanupMode').value = 'standard';
  elements.get('reportRetentionDays').value = '7';
  elements.get('latestReportRetentionMinutes').value = '30';
  elements.get('overlayScope').value = 'target_tabs';
  elements.get('postWipeShieldExpiresMinutes').value = '0';
  return document;
}

class FakeElement {
  constructor(id, document) {
    this.id = id;
    this.ownerDocument = document;
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.dataset = {};
    this.listeners = new Map();
    this.disabled = false;
    this.hidden = false;
    this.checked = false;
    this.value = '';
    this.textContent = '';
    this.className = '';
    this.files = [];
    this.open = false;
    this.clickCount = 0;
    this.row = { classList: new FakeClassList() };
  }

  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }

  async emit(type) {
    for (const callback of this.listeners.get(type) || []) {
      await callback({ currentTarget: this, target: this });
    }
  }

  click() {
    this.clickCount += 1;
    return this.emit('click');
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  closest(selector) {
    if (selector === '.setting-row') return this.row;
    return null;
  }

  focus() {
    this.ownerDocument.activeElement = this;
  }
}

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...values) {
    for (const value of values) this.values.add(value);
  }

  remove(...values) {
    for (const value of values) this.values.delete(value);
  }

  toggle(value, force) {
    if (force === undefined) {
      if (this.values.has(value)) this.values.delete(value);
      else this.values.add(value);
      return this.values.has(value);
    }
    if (force) this.values.add(value);
    else this.values.delete(value);
    return force;
  }
}

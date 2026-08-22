import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createSidePanelReportBinding } from '../../src/shared/side-panel-report-binding.js';

const sidePanelUrl = new URL('../../src/sidepanel/sidepanel.js', import.meta.url);
const sidePanelHtmlUrl = new URL('../../src/sidepanel/sidepanel.html', import.meta.url);
let importSequence = 0;

test('side panel never falls back to latest when its exact binding is absent', async () => {
  const harness = await createSidePanelHarness({ binding: null });
  try {
    assert.equal(harness.reportStateCalls().length, 0);
    assert.match(harness.element('reportOverview').innerHTML, /Full report unavailable/);
    assert.doesNotMatch(harness.element('reportOverview').innerHTML, /latest local report/i);
    assert.equal(harness.element('reportTools').hidden, true);
    assert.equal(harness.element('exportReport').disabled, true);
    assert.match(harness.element('panelStatus').textContent, /No live full-report binding/i);
  } finally {
    harness.dispose();
  }
});

test('a report replacement between binding and load cannot flash or enable the replacement', async () => {
  const reportB = report('report-b', 'replacement.example');
  const harness = await createSidePanelHarness({
    binding: liveBinding('report-a'),
    reportResponder: (request) => successEnvelope(request, { report: reportB, reports: [reportB], settings: {} })
  });
  try {
    assert.deepEqual(harness.reportStateCalls()[0].payload, { reportId: 'report-a', windowId: 7 });
    assert.doesNotMatch(harness.element('reportOverview').innerHTML, /replacement\.example/);
    assert.doesNotMatch(harness.element('reportContainer').innerHTML, /replacement\.example/);
    assert.equal(harness.element('reportTools').hidden, true);
    assert.equal(harness.element('exportReport').disabled, true);
    assert.match(harness.element('panelStatus').textContent, /did not match the exact popup binding/i);
  } finally {
    harness.dispose();
  }
});

test('forget/replacement invalidation clears stale report and exports before awaiting the service worker', async () => {
  const reportA = report('report-a', 'original.example');
  const delayed = deferred();
  const harness = await createSidePanelHarness({
    binding: liveBinding(reportA.id),
    reportResponder: (request, callIndex) =>
      callIndex === 0
        ? successEnvelope(request, { report: reportA, reports: [reportA], settings: {} })
        : delayed.promise
  });
  try {
    assert.match(harness.element('reportOverview').innerHTML, /original\.example/);
    assert.equal(harness.element('exportReport').disabled, false);

    harness.emitStorageChange({ 'sitewipe.activeReport.v1': { newValue: null } }, 'local');
    assert.doesNotMatch(harness.element('reportOverview').innerHTML, /original\.example/);
    assert.equal(harness.element('reportTools').hidden, true);
    assert.equal(harness.element('exportReport').disabled, true);

    delayed.resolve(
      errorEnvelope(harness.reportStateCalls().at(-1), 'The bound report was forgotten before it could be read.')
    );
    await flush();
    assert.doesNotMatch(harness.element('reportOverview').innerHTML, /original\.example/);
    assert.equal(harness.element('exportReport').disabled, true);
    assert.match(harness.element('panelStatus').textContent, /forgotten before it could be read/i);
  } finally {
    harness.dispose();
  }
});

test('removing a live binding clears the currently rendered report and export authority synchronously', async () => {
  const reportA = report('report-a', 'original.example');
  const harness = await createSidePanelHarness({
    binding: liveBinding(reportA.id),
    reportResponder: (request) => successEnvelope(request, { report: reportA, reports: [reportA], settings: {} })
  });
  try {
    assert.match(harness.element('reportOverview').innerHTML, /original\.example/);
    assert.equal(harness.element('exportReport').disabled, false);
    const readCount = harness.reportStateCalls().length;

    harness.emitBinding(null);
    assert.doesNotMatch(harness.element('reportOverview').innerHTML, /original\.example/);
    assert.equal(harness.element('reportTools').hidden, true);
    assert.equal(harness.element('exportReport').disabled, true);
    assert.equal(harness.reportStateCalls().length, readCount, 'a missing binding must not trigger an unbound read');
    assert.match(harness.element('panelStatus').textContent, /binding expired or became invalid/i);
  } finally {
    harness.dispose();
  }
});

test('a binding change during the initial report read prevents the old response from rendering', async () => {
  const reportA = report('report-a', 'first.example');
  const reportB = report('report-b', 'second.example');
  const responseA = deferred();
  const harness = await createSidePanelHarness({
    binding: liveBinding(reportA.id),
    awaitInitialization: false,
    reportResponder: (request) =>
      request.payload.reportId === reportA.id
        ? responseA.promise
        : successEnvelope(request, { report: reportB, reports: [reportB], settings: {} })
  });
  try {
    await waitFor(() => harness.reportStateCalls().some((call) => call.payload.reportId === reportA.id));
    harness.emitBinding(liveBinding(reportB.id));
    await waitFor(() => /second\.example/.test(harness.element('reportOverview').innerHTML));

    responseA.resolve(
      successEnvelope(harness.callForReport(reportA.id), { report: reportA, reports: [reportA], settings: {} })
    );
    await harness.initialization;
    await flush();
    assert.match(harness.element('reportOverview').innerHTML, /second\.example/);
    assert.doesNotMatch(harness.element('reportOverview').innerHTML, /first\.example/);
    assert.equal(harness.element('exportReport').disabled, false);
  } finally {
    responseA.resolve(
      successEnvelope(harness.callForReport(reportA.id), { report: reportA, reports: [reportA], settings: {} })
    );
    harness.dispose();
  }
});

test('rebinding clears old output and ignores late out-of-order report responses', async () => {
  const reportA = report('report-a', 'first.example');
  const reportB = report('report-b', 'second.example');
  const reportC = report('report-c', 'third.example');
  const responseB = deferred();
  const responseC = deferred();
  const harness = await createSidePanelHarness({
    binding: liveBinding(reportA.id),
    reportResponder: (request) => {
      if (request.payload.reportId === reportA.id) {
        return successEnvelope(request, { report: reportA, reports: [reportA], settings: {} });
      }
      if (request.payload.reportId === reportB.id) return responseB.promise;
      if (request.payload.reportId === reportC.id) return responseC.promise;
      throw new Error('Unexpected report request.');
    }
  });
  try {
    assert.match(harness.element('reportOverview').innerHTML, /first\.example/);

    harness.emitBinding(liveBinding(reportB.id));
    assert.doesNotMatch(harness.element('reportOverview').innerHTML, /first\.example/);
    assert.equal(harness.element('exportReport').disabled, true);
    await waitFor(() => harness.reportStateCalls().some((call) => call.payload.reportId === reportB.id));

    harness.emitBinding(liveBinding(reportC.id));
    await waitFor(() => harness.reportStateCalls().some((call) => call.payload.reportId === reportC.id));
    responseC.resolve(
      successEnvelope(harness.callForReport(reportC.id), { report: reportC, reports: [reportC], settings: {} })
    );
    await waitFor(() => /third\.example/.test(harness.element('reportOverview').innerHTML));
    assert.equal(harness.element('exportReport').disabled, false);

    responseB.resolve(
      successEnvelope(harness.callForReport(reportB.id), { report: reportB, reports: [reportB], settings: {} })
    );
    await flush();
    assert.match(harness.element('reportOverview').innerHTML, /third\.example/);
    assert.doesNotMatch(harness.element('reportOverview').innerHTML, /second\.example/);
    assert.equal(harness.element('exportReport').disabled, false);
  } finally {
    harness.dispose();
  }
});

async function createSidePanelHarness(options) {
  const html = await readFile(sidePanelHtmlUrl, 'utf8');
  const document = createFakeDocument([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const storageListeners = [];
  const reportStateCalls = [];
  let binding = options.binding;
  const responder =
    options.reportResponder ||
    (() => {
      throw new Error('No report request was expected.');
    });
  const chrome = {
    runtime: {
      sendMessage(request) {
        if (request.type !== 'sitewipe.getReportState') {
          return Promise.resolve(successEnvelope(request, {}));
        }
        const call = structuredClone(request);
        reportStateCalls.push(call);
        return Promise.resolve(responder(call, reportStateCalls.length - 1));
      },
      openOptionsPage: async () => {}
    },
    windows: {
      getCurrent: async () => ({ id: 7, incognito: false })
    },
    storage: {
      session: {
        async get(keys) {
          const key = Array.isArray(keys) ? keys[0] : keys;
          return binding ? { [key]: structuredClone(binding) } : {};
        }
      },
      onChanged: {
        addListener(listener) {
          storageListeners.push(listener);
        }
      }
    }
  };
  const restoreGlobals = installGlobals({
    chrome,
    document,
    requestAnimationFrame(callback) {
      callback();
      return 1;
    }
  });
  let initialization;

  try {
    importSequence += 1;
    await import(`${sidePanelUrl.href}?bound-report-runtime=${importSequence}`);
    initialization = document.fireDomReady();
    if (options.awaitInitialization !== false) await initialization;
    await flush();
  } catch (error) {
    restoreGlobals();
    throw error;
  }

  const bindingStorageKey = 'sitewipe.sidePanelReportBinding.v1.7';
  return {
    element: (id) => document.byId(id),
    initialization,
    reportStateCalls: () => reportStateCalls.map((call) => structuredClone(call)),
    callForReport(reportId) {
      return reportStateCalls.find((call) => call.payload.reportId === reportId);
    },
    emitStorageChange(changes, area) {
      for (const listener of storageListeners) listener(structuredClone(changes), area);
    },
    emitBinding(nextBinding) {
      const oldValue = binding;
      binding = structuredClone(nextBinding);
      for (const listener of storageListeners) {
        listener({ [bindingStorageKey]: { oldValue, newValue: structuredClone(binding) } }, 'session');
      }
    },
    dispose: restoreGlobals
  };
}

function liveBinding(reportId) {
  return createSidePanelReportBinding(reportId, 7, Date.now());
}

function report(id, targetDomain) {
  const now = new Date().toISOString();
  return {
    id,
    appVersion: '1.11.34',
    targetDomain,
    startedAt: now,
    finishedAt: now,
    status: 'completed',
    redacted: true,
    summary: {
      cleanupMode: 'standard',
      cleanupApprovalMode: 'detailed_review',
      cleanupConfidenceLabel: 'High',
      cleanupConfidenceScore: 95,
      verificationStatus: 'verified_zero',
      verificationAllRequiredChecksSucceeded: true,
      verificationNoExposedResidueFound: true,
      verificationRemainingTotal: 0,
      totalDurationMs: 10
    },
    sections: [],
    errors: [],
    skipped: [],
    unavailable: []
  };
}

function successEnvelope(request, payload) {
  return {
    protocolVersion: request.protocolVersion,
    requestId: request.requestId,
    ok: true,
    ...structuredClone(payload)
  };
}

function errorEnvelope(request, message) {
  return {
    protocolVersion: request.protocolVersion,
    requestId: request.requestId,
    ok: false,
    error: message,
    errorCode: 'sitewipe_action_failed',
    retryable: false
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function installGlobals(values) {
  const descriptors = new Map();
  for (const [key, value] of Object.entries(values)) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  return () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
}

function createFakeDocument(ids) {
  const elements = new Map();
  const listeners = new Map();
  const document = {
    readyState: 'loading',
    activeElement: null,
    addEventListener(type, callback) {
      listeners.set(type, callback);
    },
    querySelector(selector) {
      if (selector.startsWith('#')) return elements.get(selector.slice(1)) || null;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === '[role="tab"]') return [];
      return [];
    },
    byId(id) {
      return elements.get(id);
    },
    async fireDomReady() {
      document.readyState = 'complete';
      await listeners.get('DOMContentLoaded')?.();
    }
  };
  document.body = new FakeElement('body', document);
  for (const id of new Set(ids)) elements.set(id, new FakeElement(id, document));
  return document;
}

class FakeElement {
  constructor(id, document) {
    this.id = id;
    this.ownerDocument = document;
    this.listeners = new Map();
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.textContent = '';
    this.innerHTML = '';
    this.className = '';
    this.tabIndex = 0;
  }

  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
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
    if (force === undefined) force = !this.values.has(value);
    if (force) this.values.add(value);
    else this.values.delete(value);
    return force;
  }
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for side-panel test state.');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function flush() {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

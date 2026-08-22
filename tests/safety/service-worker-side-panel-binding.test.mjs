import test from 'node:test';
import assert from 'node:assert/strict';

import { createChromeMock, dispatchRuntimeMessage } from '../helpers/chrome-mock.mjs';
import { DEFAULT_SETTINGS, MESSAGE_TYPES, STORAGE_KEYS } from '../../src/shared/constants.js';
import { getSidePanelReportBindingStorageKey } from '../../src/shared/side-panel-report-binding.js';

test('service worker binds without opening UI and enforces popup, report, window, and side-panel identity', async () => {
  const now = new Date().toISOString();
  const report = storedReport('report-a', now);
  const chrome = await createChromeMock({
    currentWindow: { id: 7, incognito: false },
    tabs: [
      {
        id: 71,
        windowId: 7,
        active: true,
        currentWindow: true,
        lastFocusedWindow: true,
        incognito: false,
        url: 'https://example.com/'
      }
    ],
    localState: {
      [STORAGE_KEYS.settings]: readySettings(now),
      [STORAGE_KEYS.activeReport]: report,
      [STORAGE_KEYS.reports]: [report]
    }
  });
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?side-panel-binding=${Date.now()}`);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const popupSender = {
      id: chrome.runtime.id,
      url: chrome.runtime.getURL('popup/popup.html')
    };
    const sidePanelSender = {
      id: chrome.runtime.id,
      url: chrome.runtime.getURL('sidepanel/sidepanel.html')
    };
    const storageKey = getSidePanelReportBindingStorageKey(7);
    const bound = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.openSidePanel, payload: { reportId: report.id, windowId: 7 } },
      popupSender
    );

    assert.equal(bound.ok, true);
    assert.equal(bound.reportId, report.id);
    assert.equal(bound.windowId, 7);
    assert.ok(Date.parse(bound.expiresAt) > Date.now());
    assert.equal(chrome.__state.session[storageKey].reportId, report.id);
    assert.deepEqual(
      chrome.__calls.filter((call) => call.api === 'sidePanel.open'),
      [],
      'the service worker must not attempt a gesture-gated UI call'
    );
    assert.deepEqual(chrome.__calls.find((call) => call.api === 'tabs.query')?.args[0], { active: true, windowId: 7 });

    const exact = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.getReportState, payload: { reportId: report.id, windowId: 7 } },
      sidePanelSender
    );
    assert.equal(exact.ok, true);
    assert.equal(exact.report.id, report.id);

    const wrongReader = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.getReportState, payload: { reportId: report.id, windowId: 7 } },
      popupSender
    );
    assert.equal(wrongReader.ok, false);
    assert.match(wrongReader.error, /only the SiteWipe side panel/i);

    const wrongWindow = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.openSidePanel, payload: { reportId: report.id, windowId: 8 } },
      popupSender
    );
    assert.equal(wrongWindow.ok, false);
    assert.match(wrongWindow.error, /browser window changed/i);

    const wrongBinder = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.openSidePanel, payload: { reportId: report.id, windowId: 7 } },
      sidePanelSender
    );
    assert.equal(wrongBinder.ok, false);
    assert.match(wrongBinder.error, /only the SiteWipe popup/i);

    const replacement = storedReport('report-b', now);
    await chrome.storage.local.set({ [STORAGE_KEYS.activeReport]: replacement });
    const staleBindingRead = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.getReportState, payload: { reportId: report.id, windowId: 7 } },
      sidePanelSender
    );
    assert.equal(staleBindingRead.ok, false);
    assert.match(staleBindingRead.error, /no longer the latest stored report/i);

    const stalePopup = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.openSidePanel, payload: { reportId: report.id, windowId: 7 } },
      popupSender
    );
    assert.equal(stalePopup.ok, false);
    assert.match(stalePopup.error, /no longer the latest stored report/i);
    assert.equal(chrome.__state.session[storageKey].reportId, report.id, 'a failed bind must not replace authority');

    await chrome.storage.local.set({ [STORAGE_KEYS.activeReport]: report });
    await chrome.storage.session.remove(storageKey);
    chrome.storage.session.set = async () => {
      throw new Error('Synthetic session binding write failed.');
    };
    const writeFailure = await dispatchRuntimeMessage(
      chrome,
      { type: MESSAGE_TYPES.openSidePanel, payload: { reportId: report.id, windowId: 7 } },
      popupSender
    );
    assert.equal(writeFailure.ok, false);
    assert.match(writeFailure.error, /session binding write failed/i);
    assert.equal(chrome.__state.session[storageKey], undefined);
    assert.deepEqual(
      chrome.__calls.filter((call) => call.api === 'sidePanel.open'),
      []
    );
  } finally {
    delete globalThis.chrome;
  }
});

function readySettings(now) {
  return {
    ...DEFAULT_SETTINGS,
    createdAt: now,
    updatedAt: now,
    stabilityDefaultsAppliedAt: now,
    performanceDefaultsAppliedAt: now,
    privacyDefaultsAppliedAt: now
  };
}

function storedReport(id, now) {
  return {
    id,
    appVersion: '1.11.34',
    targetDomain: 'example.com',
    startedAt: now,
    finishedAt: now,
    status: 'completed',
    summary: { verificationStatus: 'verified_zero' },
    sections: [],
    errors: [],
    skipped: [],
    unavailable: []
  };
}

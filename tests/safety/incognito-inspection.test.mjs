import test from 'node:test';
import assert from 'node:assert/strict';

import { createChromeMock, dispatchRuntimeMessage } from '../helpers/chrome-mock.mjs';
import { MESSAGE_TYPES } from '../../src/shared/constants.js';
import { CLEANUP_REVIEW_STORAGE_KEY } from '../../src/background/cleanup-preflight.js';

test('private-window capability inspection failure aborts preflight without creating cleanup authority', async () => {
  const chrome = await createChromeMock();
  chrome.extension.isAllowedIncognitoAccess = () => {
    throw new Error('synthetic capability inspection failure');
  };
  globalThis.chrome = chrome;
  try {
    await import(`../../src/background/service-worker.js?incognito-inspection=${Date.now()}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const response = await dispatchRuntimeMessage(
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

    assert.equal(response.ok, false);
    assert.match(response.error, /private-window access state could not be verified/i);
    assert.equal(chrome.__state.session[CLEANUP_REVIEW_STORAGE_KEY], undefined);
    assert.equal(chrome.__state.dnrRules.length, 0);
    assert.equal(
      chrome.__calls.some((call) => call.api === 'permissions.request'),
      false
    );
  } finally {
    delete globalThis.chrome;
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { MESSAGE_PROTOCOL_VERSION, MESSAGE_TYPES } from '../../src/shared/constants.js';
import { sendMessage } from '../../src/shared/messaging.js';

test('messaging client requires a matching versioned response envelope', async () => {
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => ({
        protocolVersion: message.protocolVersion,
        requestId: message.requestId,
        ok: true,
        marker: 'accepted'
      })
    }
  };

  const response = await sendMessage(MESSAGE_TYPES.getPopupState);
  assert.equal(response.protocolVersion, MESSAGE_PROTOCOL_VERSION);
  assert.equal(response.marker, 'accepted');

  chrome.runtime.sendMessage = async (message) => ({
    protocolVersion: message.protocolVersion,
    requestId: `${message.requestId}-stale`,
    ok: true
  });
  await assert.rejects(sendMessage(MESSAGE_TYPES.getPopupState), /incompatible or stale response envelope/);
});

test('messaging client preserves structured error classification', async () => {
  globalThis.chrome = {
    runtime: {
      sendMessage: async (message) => ({
        protocolVersion: message.protocolVersion,
        requestId: message.requestId,
        ok: false,
        error: 'Operation budget exhausted.',
        errorCode: 'operation_budget_exhausted',
        retryable: true
      })
    }
  };

  await assert.rejects(sendMessage(MESSAGE_TYPES.getPopupState), (error) => {
    assert.equal(error.code, 'operation_budget_exhausted');
    assert.equal(error.retryable, true);
    return true;
  });
});

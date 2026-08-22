import test from 'node:test';
import assert from 'node:assert/strict';

import { MESSAGE_PROTOCOL_VERSION, MESSAGE_TYPES } from '../../src/shared/constants.js';
import { isAcceptedMessageType, validateMessageEnvelope } from '../../src/shared/message-contracts.js';

const runtimeId = 'abcdefghijklmnopabcdefghijklmnop';
const extensionSender = {
  id: runtimeId,
  url: `chrome-extension://${runtimeId}/popup/popup.html`
};

test('message boundary has an explicit allowlist covering every declared message type', () => {
  for (const type of Object.values(MESSAGE_TYPES)) assert.equal(isAcceptedMessageType(type), true, type);
  assert.equal(isAcceptedMessageType('sitewipe.not-real'), false);
});

test('message boundary accepts only complete reviewed extension-page approval payloads', () => {
  const token = 'a'.repeat(48);
  const prepared = validateMessageEnvelope(
    {
      type: MESSAGE_TYPES.prepareCleanupReview,
      payload: {
        input: 'https://example.com/path',
        sourceWindowId: 7,
        sourceIncognito: false
      }
    },
    extensionSender,
    runtimeId
  );
  assert.equal(prepared.payload.input, 'https://example.com/path');

  const run = validateMessageEnvelope(
    {
      type: MESSAGE_TYPES.runDeepClean,
      payload: {
        approvalToken: token,
        sourceWindowId: 7,
        sourceIncognito: false,
        popupContextId: 'popup-context-reviewed',
        popupPreparationCapability: 'c'.repeat(64),
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
    extensionSender,
    runtimeId
  );
  assert.equal(run.type, MESSAGE_TYPES.runDeepClean);

  assert.throws(
    () =>
      validateMessageEnvelope(
        {
          type: MESSAGE_TYPES.runDeepClean,
          payload: {
            approvalToken: token,
            sourceWindowId: 7,
            sourceIncognito: false,
            popupContextId: 'popup-context-reviewed',
            popupPreparationCapability: 'c'.repeat(64),
            approval: {
              approvalMode: 'quick',
              reviewedScope: false,
              associatedTargets: false,
              localOrIpTarget: false,
              protectedWebOrigins: false,
              fileConfirmationText: ''
            }
          }
        },
        extensionSender,
        runtimeId
      ),
    /approvalMode must be detailed_review/
  );
});

test('every popup authority continuation requires an opaque context id and a 256-bit capability', () => {
  const binding = {
    popupContextId: 'opaque popup/context #1',
    popupPreparationCapability: 'c'.repeat(64)
  };
  const approval = {
    approvalMode: 'detailed_review',
    reviewedScope: true,
    associatedTargets: false,
    localOrIpTarget: false,
    protectedWebOrigins: false,
    fileConfirmationText: ''
  };
  const cases = [
    {
      type: MESSAGE_TYPES.cancelCleanupReview,
      payload: { approvalToken: 'a'.repeat(48), promptNotStarted: true, ...binding }
    },
    {
      type: MESSAGE_TYPES.settleCleanupPermissionPrompt,
      payload: {
        approvalToken: 'a'.repeat(48),
        handoffNonce: 'b'.repeat(48),
        permissionLeaseId: 'd'.repeat(48),
        outcome: 'denied',
        ...binding
      }
    },
    {
      type: MESSAGE_TYPES.armCleanupApproval,
      payload: {
        approvalToken: 'a'.repeat(48),
        handoffNonce: 'b'.repeat(48),
        approval,
        sourceWindowId: 7,
        sourceIncognito: false,
        ...binding
      }
    },
    {
      type: MESSAGE_TYPES.resumeArmedCleanup,
      payload: { handoffNonce: 'b'.repeat(48), ...binding }
    },
    {
      type: MESSAGE_TYPES.runDeepClean,
      payload: {
        approvalToken: 'a'.repeat(48),
        approval,
        sourceWindowId: 7,
        sourceIncognito: false,
        ...binding
      }
    }
  ];

  for (const message of cases) {
    assert.equal(validateMessageEnvelope(message, extensionSender, runtimeId).type, message.type);
    const { popupPreparationCapability: _missing, ...withoutCapability } = message.payload;
    assert.throws(
      () => validateMessageEnvelope({ ...message, payload: withoutCapability }, extensionSender, runtimeId),
      /popupPreparationCapability is invalid/
    );
    assert.throws(
      () =>
        validateMessageEnvelope(
          { ...message, payload: { ...message.payload, popupPreparationCapability: 'c'.repeat(48) } },
          extensionSender,
          runtimeId
        ),
      /popupPreparationCapability is invalid/
    );
    assert.throws(
      () =>
        validateMessageEnvelope(
          { ...message, payload: { ...message.payload, popupContextId: ' trailing-space ' } },
          extensionSender,
          runtimeId
        ),
      /popupContextId is invalid/
    );
  }
});

test('message envelopes validate protocol and correlation identifiers while retaining legacy compatibility', () => {
  const versioned = validateMessageEnvelope(
    {
      protocolVersion: MESSAGE_PROTOCOL_VERSION,
      requestId: 'request-1234',
      type: MESSAGE_TYPES.getPopupState,
      payload: {}
    },
    extensionSender,
    runtimeId
  );
  assert.equal(versioned.requestId, 'request-1234');
  assert.equal(versioned.legacyEnvelope, false);

  const legacy = validateMessageEnvelope(
    { type: MESSAGE_TYPES.getPopupState, payload: {} },
    extensionSender,
    runtimeId
  );
  assert.equal(legacy.legacyEnvelope, true);
  assert.equal(legacy.requestId, `legacy:${MESSAGE_TYPES.getPopupState}`);

  assert.throws(
    () =>
      validateMessageEnvelope(
        {
          protocolVersion: MESSAGE_PROTOCOL_VERSION + 1,
          requestId: 'request-1234',
          type: MESSAGE_TYPES.getPopupState,
          payload: {}
        },
        extensionSender,
        runtimeId
      ),
    /Unsupported message protocol version/
  );
  assert.throws(
    () =>
      validateMessageEnvelope(
        {
          protocolVersion: MESSAGE_PROTOCOL_VERSION,
          requestId: 'short',
          type: MESSAGE_TYPES.getPopupState,
          payload: {}
        },
        extensionSender,
        runtimeId
      ),
    /requestId is invalid/
  );
});

test('stored-report actions require an exact displayed report ID', () => {
  for (const type of [MESSAGE_TYPES.forgetLatestReport]) {
    const validated = validateMessageEnvelope(
      { type, payload: { reportId: 'sitewipe-displayed-report' } },
      extensionSender,
      runtimeId
    );
    assert.equal(validated.payload.reportId, 'sitewipe-displayed-report');
    assert.throws(() => validateMessageEnvelope({ type, payload: {} }, extensionSender, runtimeId), /reportId/);
    assert.throws(
      () => validateMessageEnvelope({ type, payload: { reportId: '' } }, extensionSender, runtimeId),
      /reportId/
    );
  }

  const sidePanel = validateMessageEnvelope(
    {
      type: MESSAGE_TYPES.openSidePanel,
      payload: { reportId: 'sitewipe-displayed-report', windowId: 7 }
    },
    extensionSender,
    runtimeId
  );
  assert.deepEqual(sidePanel.payload, { reportId: 'sitewipe-displayed-report', windowId: 7 });
  assert.throws(
    () =>
      validateMessageEnvelope(
        { type: MESSAGE_TYPES.openSidePanel, payload: { reportId: 'sitewipe-displayed-report' } },
        extensionSender,
        runtimeId
      ),
    /windowId/
  );
  assert.throws(
    () =>
      validateMessageEnvelope(
        {
          type: MESSAGE_TYPES.openSidePanel,
          payload: { reportId: 'sitewipe-displayed-report', windowId: -1 }
        },
        extensionSender,
        runtimeId
      ),
    /windowId/
  );
});

test('side-panel report state requires an exact report and window binding', () => {
  assert.deepEqual(
    validateMessageEnvelope(
      {
        type: MESSAGE_TYPES.getReportState,
        payload: { reportId: 'sitewipe-bound-report', windowId: 7 }
      },
      extensionSender,
      runtimeId
    ).payload,
    { reportId: 'sitewipe-bound-report', windowId: 7 }
  );
  assert.throws(
    () => validateMessageEnvelope({ type: MESSAGE_TYPES.getReportState, payload: {} }, extensionSender, runtimeId),
    /reportId/
  );
  assert.throws(
    () =>
      validateMessageEnvelope(
        { type: MESSAGE_TYPES.getReportState, payload: { reportId: '', windowId: 7 } },
        extensionSender,
        runtimeId
      ),
    /reportId/
  );
});

test('unknown messages, unexpected fields, oversized input, and malformed approval tokens fail closed', () => {
  assert.throws(
    () => validateMessageEnvelope({ type: 'sitewipe.not-real', payload: {} }, extensionSender, runtimeId),
    /Unknown or missing message type/
  );
  assert.throws(
    () =>
      validateMessageEnvelope(
        { type: MESSAGE_TYPES.getState, payload: { surprise: true } },
        extensionSender,
        runtimeId
      ),
    /Unexpected payload field/
  );
  assert.throws(
    () =>
      validateMessageEnvelope(
        {
          type: MESSAGE_TYPES.normalizeTarget,
          payload: { input: 'x'.repeat(4097) }
        },
        extensionSender,
        runtimeId
      ),
    /between 1 and 4096/
  );
  assert.throws(
    () =>
      validateMessageEnvelope(
        {
          type: MESSAGE_TYPES.cancelCleanupReview,
          payload: { approvalToken: 'guessable' }
        },
        extensionSender,
        runtimeId
      ),
    /approvalToken is invalid/
  );
  assert.throws(
    () =>
      validateMessageEnvelope(
        {
          type: MESSAGE_TYPES.runDeepClean,
          payload: {
            approvalToken: 'a'.repeat(48),
            sourceWindowId: null,
            sourceIncognito: false,
            popupContextId: 'popup-context-reviewed',
            popupPreparationCapability: 'c'.repeat(64),
            approval: {
              approvalMode: 'bypass',
              reviewedScope: false,
              associatedTargets: false,
              localOrIpTarget: false,
              protectedWebOrigins: false,
              fileConfirmationText: ''
            }
          }
        },
        extensionSender,
        runtimeId
      ),
    /approvalMode must be detailed_review/
  );
});

test('other extensions are rejected and injected target pages may request only cooperative cancellation', () => {
  assert.throws(
    () => validateMessageEnvelope({ type: MESSAGE_TYPES.getState, payload: {} }, { id: 'other-extension' }, runtimeId),
    /not this extension/
  );
  const injectedSender = {
    id: runtimeId,
    url: 'https://fixture.example/',
    tab: { id: 12 }
  };
  const cancel = validateMessageEnvelope({ type: MESSAGE_TYPES.cancelActiveJob }, injectedSender, runtimeId);
  assert.equal(cancel.type, MESSAGE_TYPES.cancelActiveJob);
  assert.throws(
    () => validateMessageEnvelope({ type: MESSAGE_TYPES.resetExtensionLocalState }, injectedSender, runtimeId),
    /only request cancellation/
  );
});

import { MESSAGE_PROTOCOL_VERSION, MESSAGE_TYPES } from './constants.js';

/** @type {Set<string>} */
const ACCEPTED_MESSAGE_TYPES = new Set(Object.values(MESSAGE_TYPES));
const EMPTY_PAYLOAD_TYPES = new Set([
  MESSAGE_TYPES.getActiveTabTarget,
  MESSAGE_TYPES.getState,
  MESSAGE_TYPES.getPopupState,
  MESSAGE_TYPES.getOptionsState,
  MESSAGE_TYPES.getReportState,
  MESSAGE_TYPES.getReport,
  MESSAGE_TYPES.getHistory,
  MESSAGE_TYPES.clearHistory,
  MESSAGE_TYPES.getSettings,
  MESSAGE_TYPES.resetSettings,
  MESSAGE_TYPES.clearDebugLog,
  MESSAGE_TYPES.getIncognitoStatus,
  MESSAGE_TYPES.openSidePanel,
  MESSAGE_TYPES.clearActiveShield,
  MESSAGE_TYPES.repairActiveShield,
  MESSAGE_TYPES.getShieldDiagnostics,
  MESSAGE_TYPES.expireActiveShield,
  MESSAGE_TYPES.forgetLatestReport,
  MESSAGE_TYPES.getActiveJob,
  MESSAGE_TYPES.cancelActiveJob,
  MESSAGE_TYPES.clearActiveJobRecord,
  MESSAGE_TYPES.getSelfTestResults,
  MESSAGE_TYPES.getMaintenanceStatus,
  MESSAGE_TYPES.runMaintenanceNow,
  MESSAGE_TYPES.resetExtensionLocalState
]);

const MAX_MESSAGE_BYTES = 128 * 1024;
const MAX_INPUT_LENGTH = 4096;
const MAX_ASSOCIATED_GROUPS_LENGTH = 25_000;
const MAX_CONFIRMATION_LENGTH = 1024;
const APPROVAL_TOKEN_PATTERN = /^[a-f0-9]{48}$/;

export function validateMessageEnvelope(message, sender, runtimeId) {
  if (!isPlainObject(message)) fail('Messages must be plain objects.');
  const protocolVersion = message.protocolVersion ?? MESSAGE_PROTOCOL_VERSION;
  if (protocolVersion !== MESSAGE_PROTOCOL_VERSION) {
    fail(`Unsupported message protocol version: ${String(protocolVersion)}.`);
  }
  const requestId =
    message.requestId == null ? `legacy:${String(message.type || 'unknown')}` : validateRequestId(message.requestId);
  const type = message.type;
  if (typeof type !== 'string' || !ACCEPTED_MESSAGE_TYPES.has(type)) fail('Unknown or missing message type.');
  validateSender(sender, runtimeId, type);

  let serialized;
  try {
    serialized = JSON.stringify(message);
  } catch {
    fail('Message payload must be serializable.');
  }
  if (serialized.length > MAX_MESSAGE_BYTES) fail('Message payload is too large.');

  const payload = message.payload === undefined ? {} : message.payload;
  if (!isPlainObject(payload)) fail('Message payload must be a plain object.');
  validatePayload(type, payload);
  return {
    protocolVersion,
    requestId,
    legacyEnvelope: message.protocolVersion == null || message.requestId == null,
    type,
    payload
  };
}

export function isAcceptedMessageType(type) {
  return ACCEPTED_MESSAGE_TYPES.has(type);
}

function validateSender(sender, runtimeId, type) {
  const expectedId = String(runtimeId || '');
  if (!expectedId || sender?.id !== expectedId) fail('Message sender is not this extension.');

  const senderUrl = String(sender?.documentUrl || sender?.url || '');
  const extensionOrigin = `chrome-extension://${expectedId}/`;
  const fromExtensionPage = senderUrl.startsWith(extensionOrigin) || (!sender?.tab && sender?.id === expectedId);
  const fromInjectedTargetPage = Boolean(sender?.tab && !senderUrl.startsWith(extensionOrigin));
  if (fromInjectedTargetPage && type !== MESSAGE_TYPES.cancelActiveJob) {
    fail('Target-page contexts may only request cancellation of an active cleanup.');
  }
  if (!fromExtensionPage && !fromInjectedTargetPage) fail('Message sender context is not trusted.');
}

function validatePayload(type, payload) {
  if (EMPTY_PAYLOAD_TYPES.has(type)) {
    assertKeys(payload, []);
    return;
  }

  switch (type) {
    case MESSAGE_TYPES.normalizeTarget:
      assertKeys(payload, ['input']);
      assertString(payload.input, 'input', 1, MAX_INPUT_LENGTH);
      return;
    case MESSAGE_TYPES.prepareCleanupReview:
      assertKeys(payload, ['input', 'sourceWindowId', 'sourceIncognito']);
      assertString(payload.input, 'input', 1, MAX_INPUT_LENGTH);
      assertNullableWindowId(payload.sourceWindowId);
      if (typeof payload.sourceIncognito !== 'boolean') fail('sourceIncognito must be a boolean.');
      return;
    case MESSAGE_TYPES.cancelCleanupReview:
      assertKeys(payload, ['approvalToken']);
      assertApprovalToken(payload.approvalToken);
      return;
    case MESSAGE_TYPES.runDeepClean:
      assertKeys(payload, ['approvalToken', 'approval', 'sourceWindowId', 'sourceIncognito']);
      assertApprovalToken(payload.approvalToken);
      assertNullableWindowId(payload.sourceWindowId);
      if (typeof payload.sourceIncognito !== 'boolean') fail('sourceIncognito must be a boolean.');
      validateApproval(payload.approval);
      return;
    case MESSAGE_TYPES.validateAssociatedGroups:
      assertKeys(payload, ['groupsText']);
      assertString(payload.groupsText, 'groupsText', 0, MAX_ASSOCIATED_GROUPS_LENGTH);
      return;
    case MESSAGE_TYPES.saveSettings:
      assertKeys(payload, ['settings']);
      if (!isPlainObject(payload.settings)) fail('settings must be a plain object.');
      return;
    default:
      fail('No payload contract exists for this message type.');
  }
}

function validateApproval(value) {
  if (!isPlainObject(value)) fail('approval must be a plain object.');
  assertKeys(value, [
    'approvalMode',
    'reviewedScope',
    'associatedTargets',
    'localOrIpTarget',
    'protectedWebOrigins',
    'fileConfirmationText'
  ]);
  for (const key of ['reviewedScope', 'associatedTargets', 'localOrIpTarget', 'protectedWebOrigins']) {
    if (typeof value[key] !== 'boolean') fail(`approval.${key} must be a boolean.`);
  }
  if (value.approvalMode !== 'detailed_review') {
    fail('approval.approvalMode must be detailed_review.');
  }
  assertString(value.fileConfirmationText, 'approval.fileConfirmationText', 0, MAX_CONFIRMATION_LENGTH);
}

function assertApprovalToken(value) {
  if (typeof value !== 'string' || !APPROVAL_TOKEN_PATTERN.test(value)) {
    fail('approvalToken is invalid.');
  }
}

function validateRequestId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{8,128}$/.test(value)) {
    fail('requestId is invalid.');
  }
  return value;
}

function assertNullableWindowId(value) {
  if (value !== null && (!Number.isInteger(value) || value < 0))
    fail('sourceWindowId must be a non-negative integer or null.');
}

function assertString(value, name, minimum, maximum) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) {
    fail(`${name} must be a string between ${minimum} and ${maximum} characters.`);
  }
}

function assertKeys(value, allowedKeys) {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) fail(`Unexpected payload field(s): ${unknown.join(', ')}.`);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(message) {
  const error = new Error(message);
  error.name = 'MessageValidationError';
  throw error;
}

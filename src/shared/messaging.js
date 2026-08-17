import { MESSAGE_PROTOCOL_VERSION, MESSAGE_TYPES } from './constants.js';

export async function sendMessage(type, payload = {}) {
  const requestId = createRequestId();
  const timeoutMs =
    type === MESSAGE_TYPES.runDeepClean ? 270_000 : type === MESSAGE_TYPES.prepareCleanupReview ? 60_000 : 30_000;
  let timerId = null;
  const timeout = new Promise((_, reject) => {
    timerId = setTimeout(() => {
      const error = new Error(
        `SiteWipe did not respond within ${Math.round(timeoutMs / 1000)} seconds. The browser operation may still be running; do not repeat a destructive action until the active-job state is checked.`
      );
      error.name = 'MessageTimeoutError';
      reject(error);
    }, timeoutMs);
  });
  let response;
  try {
    response = await Promise.race([
      chrome.runtime.sendMessage({
        protocolVersion: MESSAGE_PROTOCOL_VERSION,
        requestId,
        type,
        payload
      }),
      timeout
    ]);
  } finally {
    if (timerId !== null) clearTimeout(timerId);
  }
  if (!response) throw new Error('No response from SiteWipe service worker.');
  if (response.protocolVersion !== MESSAGE_PROTOCOL_VERSION || response.requestId !== requestId) {
    throw new Error('SiteWipe returned an incompatible or stale response envelope.');
  }
  if (typeof response.ok !== 'boolean') throw new Error('SiteWipe returned an invalid response envelope.');
  if (response.ok === false) {
    /** @type {Error & {code?: string, retryable?: boolean}} */
    const error = new Error(response.error || 'SiteWipe action failed.');
    error.code = response.errorCode || 'sitewipe_action_failed';
    error.retryable = response.retryable === true;
    throw error;
  }
  return response;
}

function createRequestId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `req-${[...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

export function formatError(error) {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  return error.message || String(error);
}

export function onceDomReady(callback) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', callback, { once: true });
  } else {
    callback();
  }
}

export function onStorageChange(callback) {
  chrome.storage.onChanged.addListener((changes, areaName) => callback(changes, areaName));
}

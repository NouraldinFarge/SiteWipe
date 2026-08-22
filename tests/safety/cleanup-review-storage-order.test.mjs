import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLEANUP_REVIEW_STORAGE_KEY,
  consumeCleanupReviewRequest,
  normalizeCleanupReviewRecord,
  prepareCleanupReviewRequest
} from '../../src/background/cleanup-preflight.js';

test('an installed-shaped review survives storage dictionary key canonicalization', async () => {
  const storage = createCanonicalizingStorage();
  const nowMs = Date.parse('2026-08-20T20:03:45.000Z');
  const settings = {
    cleanupMode: 'expert',
    includeProtectedWebOrigins: true,
    progressOverlay: true,
    progressOverlayCancelButton: true,
    overlayScope: 'target_tabs',
    temporaryDnrShield: true,
    redactReports: true,
    createdAt: '2026-08-20T19:50:00.000Z',
    updatedAt: '2026-08-20T20:00:00.000Z'
  };
  const dependencies = {
    getSettings: async () => settings,
    isIncognitoAllowed: async () => true,
    inspectSourceWindow: async (sourceWindowId) => ({ sourceWindowId, sourceIncognito: false }),
    hasHostPermissions: async () => true,
    containsHostPermissions: async () => true,
    getAllHostPermissions: async () => ({ origins: ['http://*/*', 'https://*/*'] }),
    releaseHostPermissions: async () => true,
    inspectImpact: async () => ({
      matchingTabs: 1,
      matchingPrivateTabs: 0,
      matchingHistoryEntries: 0,
      matchingDownloadRecords: 0,
      matchedCompletedFileIds: [],
      limitations: []
    }),
    storageSession: storage,
    storageLocal: storage,
    preparationContextId: 'storage-order-popup-context',
    now: () => nowMs,
    createToken: async () => 'chrome-storage-order-review-token'
  };

  const prepared = await prepareCleanupReviewRequest(
    { input: 'https://www.reddit.com/', sourceWindowId: 91, sourceIncognito: false },
    dependencies
  );
  const stored = storage.values[CLEANUP_REVIEW_STORAGE_KEY];
  assert.deepEqual(Object.keys(stored.hostPermissionInventory), Object.keys(stored.hostPermissionInventory).sort());
  assert.ok(normalizeCleanupReviewRecord(stored));

  const consumed = await consumeCleanupReviewRequest(
    {
      approvalToken: prepared.review.approvalToken,
      sourceWindowId: 91,
      sourceIncognito: false,
      approval: {
        approvalMode: 'detailed_review',
        reviewedScope: true,
        associatedTargets: false,
        localOrIpTarget: false,
        protectedWebOrigins: true,
        fileConfirmationText: ''
      }
    },
    dependencies
  );
  assert.equal(consumed.target.domain, 'reddit.com');
  assert.equal(consumed.incognitoAccess, true);
  assert.deepEqual(consumed.hostPermissionInventory.broadGrantedHostPermissionOrigins, ['http://*/*', 'https://*/*']);
});

function createCanonicalizingStorage() {
  const values = {};
  return {
    values,
    async get(keys) {
      const result = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (Object.prototype.hasOwnProperty.call(values, key)) {
          result[key] = canonicalizeDictionaryKeyOrder(values[key]);
        }
      }
      return result;
    },
    async set(patch) {
      for (const [key, value] of Object.entries(patch)) {
        values[key] = canonicalizeDictionaryKeyOrder(value);
      }
    },
    async remove(key) {
      delete values[key];
    }
  };
}

function canonicalizeDictionaryKeyOrder(value) {
  if (Array.isArray(value)) return value.map(canonicalizeDictionaryKeyOrder);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalizeDictionaryKeyOrder(value[key])])
  );
}

import test from 'node:test';
import assert from 'node:assert/strict';

import { getEffectiveCleanupSettings } from '../../src/shared/cleanup-mode.js';

test('effective policy turns off child features when their parent is disabled', () => {
  const effective = getEffectiveCleanupSettings({
    cleanupMode: 'expert',
    pageScriptScrub: false,
    storageBucketScrub: true,
    opfsScrub: true,
    serviceWorkerExtraScrub: true,
    appBadgeClear: true,
    permissionAudit: true,
    progressOverlay: false,
    progressOverlayCancelButton: true,
    overlayScope: 'all_tabs',
    postWipeSessionBlock: false,
    postWipeShieldExpiresMinutes: 240
  });

  assert.equal(effective.storageBucketScrub, false);
  assert.equal(effective.opfsScrub, false);
  assert.equal(effective.serviceWorkerExtraScrub, false);
  assert.equal(effective.appBadgeClear, false);
  assert.equal(effective.permissionAudit, false);
  assert.equal(effective.progressOverlayCancelButton, false);
  assert.equal(effective.overlayScope, 'target_tabs');
  assert.equal(effective.postWipeShieldExpiresMinutes, 0);
});

test('Expert child features remain enabled only while their parent is enabled', () => {
  const effective = getEffectiveCleanupSettings({
    cleanupMode: 'expert',
    pageScriptScrub: true,
    storageBucketScrub: true,
    opfsScrub: true,
    serviceWorkerExtraScrub: true,
    appBadgeClear: true,
    permissionAudit: true,
    progressOverlay: true,
    progressOverlayCancelButton: true,
    overlayScope: 'current_window',
    postWipeSessionBlock: true,
    postWipeShieldExpiresMinutes: 240
  });

  assert.equal(effective.storageBucketScrub, true);
  assert.equal(effective.opfsScrub, true);
  assert.equal(effective.serviceWorkerExtraScrub, true);
  assert.equal(effective.appBadgeClear, true);
  assert.equal(effective.permissionAudit, true);
  assert.equal(effective.progressOverlayCancelButton, true);
  assert.equal(effective.overlayScope, 'current_window');
  assert.equal(effective.postWipeShieldExpiresMinutes, 240);
});

test('cleanup-review skip is an explicit boolean and remains available in Standard and Expert mode', () => {
  const standard = getEffectiveCleanupSettings({
    cleanupMode: 'standard',
    skipCleanupReview: true
  });
  const expert = getEffectiveCleanupSettings({
    cleanupMode: 'expert',
    skipCleanupReview: true
  });
  const unsafeTruthyValue = getEffectiveCleanupSettings({
    cleanupMode: 'expert',
    skipCleanupReview: 'true'
  });

  assert.equal(standard.skipCleanupReview, true);
  assert.equal(expert.skipCleanupReview, true);
  assert.equal(unsafeTruthyValue.skipCleanupReview, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const popupUrl = new URL('../../src/popup/popup.js', import.meta.url);
const popupHtmlUrl = new URL('../../src/popup/popup.html', import.meta.url);
const popupCssUrl = new URL('../../src/popup/popup.css', import.meta.url);
const handoffUrl = new URL('../../src/handoff/handoff.js', import.meta.url);
const handoffHtmlUrl = new URL('../../src/handoff/handoff.html', import.meta.url);
let importSequence = 0;

test('popup preparation capabilities remain memory-only and are erased at every popup lifetime boundary', async () => {
  const source = await readFile(popupUrl, 'utf8');
  assert.match(source, /const popupPreparationBindings = new Map\(\);/);
  assert.match(
    source,
    /function clearPopupLifetimeTimers\(\) \{[\s\S]*?popupPreparationBindings\.clear\(\);[\s\S]*?\}/,
    'pagehide must erase every raw popup capability even if the document survives in a page cache'
  );
  assert.match(
    source,
    /MESSAGE_TYPES\.openCleanupPermissionHandoff[\s\S]*?popupPreparationBindings\.delete\(review\.approvalToken\);/,
    'opening the worker-owned handoff tab must retire the popup preparation capability'
  );
  assert.match(
    source,
    /armed = await sendMessage\(MESSAGE_TYPES\.armCleanupApproval[\s\S]*?const opened = await sendMessage\(MESSAGE_TYPES\.openCleanupPermissionHandoff/,
    'the popup must await durable arm before delegating handoff creation or focus to the worker'
  );
  assert.doesNotMatch(source, /chrome\.permissions\./, 'the action popup must not invoke native permission APIs');
  assert.doesNotMatch(source, /chrome\.tabs\./, 'the action popup must not create or focus the handoff tab itself');
  assert.doesNotMatch(
    source,
    /beginCleanupPermissionPrompt|confirmCleanupPermissionPromptInvocation|confirmCleanupPermissionGrantOutcome|resumeArmedCleanup|settleCleanupPermissionPrompt/,
    'the action popup must not retain any retired native-prompt continuation route'
  );
});

test('Open full report is prebound and opens synchronously in the exact verified window', async () => {
  const harness = await createPopupHarness({
    storedReport: completedStoredReport(),
    activeTabWindowId: 99
  });
  try {
    await waitFor(() => harness.sidePanelBindingCalls().length === 1);
    await waitFor(() => harness.element('openSidePanel').disabled === false);
    assert.deepEqual(harness.sidePanelBindingCalls()[0].payload, {
      reportId: 'stored-report-exact',
      windowId: 7
    });
    assert.deepEqual(harness.sidePanelOpenCalls(), [], 'prebinding must not open browser UI');

    assert.equal(await harness.clickFullReport(), true);
    await waitFor(() => harness.sidePanelOpenCalls().length === 1);

    const opening = harness.sidePanelOpenCalls()[0];
    assert.deepEqual(opening.payload, { windowId: 7 });
    assert.equal(opening.userActivation, true, 'sidePanel.open must run inside the original click activation');
    assert.equal(
      harness.sidePanelBindingCalls().length,
      1,
      'the click path must not await or send another runtime message before opening'
    );
    assert.ok(
      harness.callIndex('sitewipe.openSidePanel') < harness.callIndex('sidePanel.open'),
      'exact report/window binding must settle before the user can click Open full report'
    );
  } finally {
    await harness.dispose();
  }
});

test('Open full report surfaces direct side-panel failures in the completed-report status', async () => {
  const gestureError = '`sidePanel.open()` may only be called in response to a user gesture.';
  const harness = await createPopupHarness({
    storedReport: completedStoredReport(),
    sidePanelOpenError: gestureError
  });
  try {
    await waitFor(() => harness.element('openSidePanel').disabled === false);
    assert.equal(await harness.clickFullReport(), true);
    await waitFor(() => harness.element('summaryActionStatus').textContent === gestureError);
    assert.equal(harness.sidePanelOpenCalls().length, 1);
    assert.equal(harness.sidePanelOpenCalls()[0].userActivation, true);
  } finally {
    await harness.dispose();
  }
});

test('an expired popup binding is re-armed and never synchronously opens stale authority', async () => {
  const harness = await createPopupHarness({
    storedReport: completedStoredReport(),
    sidePanelBindingLifetimes: [80, 5 * 60 * 1000]
  });
  try {
    await waitFor(() => harness.element('openSidePanel').disabled === false);
    await wait(110);

    assert.equal(await harness.clickFullReport(), true);
    assert.deepEqual(harness.sidePanelOpenCalls(), [], 'an expired binding must not open the side panel');
    await waitFor(() => harness.sidePanelBindingCalls().length === 2);
    await waitFor(() => harness.element('openSidePanel').disabled === false);
    assert.match(harness.element('summaryActionStatus').textContent, /^$/);

    assert.equal(await harness.clickFullReport(), true);
    await waitFor(() => harness.sidePanelOpenCalls().length === 1);
    assert.deepEqual(harness.sidePanelOpenCalls()[0].payload, { windowId: 7 });
  } finally {
    await harness.dispose();
  }
});

for (const [cleanupMode, startupFailure] of [
  [
    'standard',
    {
      errorCode: 'lifecycle_not_ready',
      retryable: true,
      error: 'SiteWipe startup maintenance has not settled yet.'
    }
  ],
  [
    'expert',
    {
      errorCode: 'sitewipe_action_failed',
      retryable: false,
      error:
        'SiteWipe is still trying to run service-worker-load maintenance. Wait for that action to finish before you prepare a cleanup review.'
    }
  ]
]) {
  test(`${cleanupMode} direct cleanup waits through fresh-worker readiness and separates approval from target access`, async () => {
    const harness = await createPopupHarness({
      cleanupMode,
      directCleanup: true,
      handoffFocused: cleanupMode === 'expert',
      hostPermissionsGranted: false,
      prepareResponses: [startupFailure, { review: directReview({ cleanupMode, hostPermissionsGranted: false }) }]
    });
    try {
      await waitFor(() => harness.prepareCalls().length === 1);
      assert.equal(harness.element('deepCleanButton').disabled, true);
      assert.equal(harness.element('deepCleanButton').getAttribute('aria-busy'), 'true');
      assert.equal(harness.element('readyBadge').textContent, 'Waiting for SiteWipe startup');
      assert.deepEqual(harness.mutationCalls(), [], 'startup preparation must remain read-only');

      await waitFor(() => harness.prepareCalls().length === 2, 2_000);
      await waitFor(() => harness.element('deepCleanButton').disabled === false);
      assert.equal(harness.element('deepCleanLabel').textContent, 'Clean now');
      assert.equal(harness.element('readyBadge').textContent, 'Direct cleanup ready');
      assert.deepEqual(harness.mutationCalls(), [], 'the completed hidden preflight must not begin cleanup');

      assert.equal(await harness.clickPrimary(), true);
      await waitFor(() => harness.openHandoffCalls().length === 1);
      assert.deepEqual(
        harness.activationBatches()[0],
        ['sitewipe.armCleanupApproval'],
        'the popup must not pretend the post-await handoff open still has the original browser activation'
      );
      assert.ok(
        harness.callIndex('sitewipe.armCleanupApproval') < harness.callIndex('sitewipe.openCleanupPermissionHandoff'),
        'the popup must await the durable arm before asking the worker to open its handoff tab'
      );
      assert.equal(harness.permissionCalls().length, 0, 'saving approval must not open browser permission UI');
      assert.equal(harness.permissionSnapshotCalls().length, 0);
      assert.equal(harness.retiredPromptRouteCalls().length, 0);
      assert.equal(harness.armCalls().length, 1);
      assert.equal(harness.runCalls().length, 0);
      assert.deepEqual(
        harness.activationEvents(),
        ['sitewipe.armCleanupApproval'],
        'the worker-owned tab open must not depend on browser activation surviving the awaited arm'
      );
      assert.equal(harness.armCalls()[0].payload.approval.approvalMode, 'settings_direct');
      assertPopupAuthorityBinding(harness.armCalls()[0].payload);
      assert.deepEqual(
        popupAuthorityBinding(harness.openHandoffCalls()[0].payload),
        popupAuthorityBinding(harness.armCalls()[0].payload),
        'arm and handoff-open must use the exact worker-minted popup preparation authority'
      );
      const reviewedPrompt = directReview({ cleanupMode, hostPermissionsGranted: false });
      assert.equal(harness.armCalls()[0].payload.handoffNonce, reviewedPrompt.approvalHandoffNonce);
      assert.equal(harness.openHandoffCalls()[0].payload.handoffNonce, reviewedPrompt.approvalHandoffNonce);
      await waitFor(() => harness.element('progressTitle').textContent === 'Continue in the SiteWipe access tab');
      assert.equal(harness.element('progressTitle').textContent, 'Continue in the SiteWipe access tab');
      assert.match(harness.element('progressDetail').textContent, /persistent SiteWipe tab/i);
    } finally {
      await harness.dispose();
    }
  });
}

test('a delayed durable-arm acknowledgement cannot open target access early', async () => {
  const harness = await createPopupHarness({
    directCleanup: true,
    armResponseDeferred: true,
    prepareResponses: [{ review: directReview({ hostPermissionsGranted: false }) }]
  });
  try {
    await waitFor(() => harness.element('deepCleanButton').disabled === false);
    const click = harness.clickPrimary();
    await waitFor(() => harness.armCalls().length === 1);

    assert.deepEqual(harness.activationBatches()[0], ['sitewipe.armCleanupApproval']);
    assert.equal(harness.permissionCalls().length, 0);
    assert.equal(
      harness.openHandoffCalls().length,
      0,
      'the handoff tab cannot open before durable arm acknowledgement'
    );
    assert.equal(await harness.clickPrimary(), false, 'the popup must remain locked before the arm reply');

    harness.settleArmResponse();
    await waitFor(() => harness.openHandoffCalls().length === 1);
    assert.equal(await click, true);
    assert.deepEqual(harness.activationBatches()[0], ['sitewipe.armCleanupApproval']);
    assert.equal(harness.permissionCalls().length, 0);
    assert.equal(harness.retiredPromptRouteCalls().length, 0);
    assert.deepEqual(popupAuthorityBinding(harness.openHandoffCalls()[0].payload), {
      popupContextId: 'opaque popup/context #test',
      popupPreparationCapability: '1'.repeat(64)
    });
    assert.equal(harness.element('progressTitle').textContent, 'Continue in the SiteWipe access tab');
  } finally {
    harness.settleArmResponse();
    await harness.dispose();
  }
});

test('a pre-granted direct cleanup submits the exact worker-minted popup authority', async () => {
  const harness = await createPopupHarness({
    directCleanup: true,
    prepareResponses: [{ review: directReview({ hostPermissionsGranted: true }) }]
  });
  try {
    await waitFor(() => harness.element('deepCleanButton').disabled === false);
    assert.equal(await harness.clickPrimary(), true);
    await waitFor(() => harness.runCalls().length === 1);

    assert.equal(harness.permissionCalls().length, 0);
    assert.equal(harness.armCalls().length, 0);
    assert.equal(harness.retiredPromptRouteCalls().length, 0);
    assertPopupAuthorityBinding(harness.runCalls()[0].payload);
    assert.deepEqual(popupAuthorityBinding(harness.runCalls()[0].payload), {
      popupContextId: 'opaque popup/context #test',
      popupPreparationCapability: '1'.repeat(64)
    });
  } finally {
    await harness.dispose();
  }
});

test('a native prompt can outlive the popup because only the persistent handoff document invokes it', async () => {
  const popup = await createPopupHarness({
    directCleanup: true,
    prepareResponses: [{ review: directReview({ hostPermissionsGranted: false }) }]
  });
  try {
    await waitFor(() => popup.element('deepCleanButton').disabled === false);
    assert.equal(await popup.clickPrimary(), true);
    await waitFor(() => popup.openHandoffCalls().length === 1);
    assert.equal(popup.permissionCalls().length, 0);
    assert.equal(popup.permissionSnapshotCalls().length, 0);
    assert.equal(popup.retiredPromptRouteCalls().length, 0);
    assert.equal(popup.runCalls().length, 0);
  } finally {
    await popup.dispose();
  }

  const handoff = await createHandoffHarness({ permissionRequestDeferred: true });
  try {
    await waitFor(() => handoff.element('grantAccess').disabled === false);
    const activation = await handoff.clickGrant();
    assert.equal(activation.accepted, true);
    await waitFor(() => handoff.permissionCalls().length === 1);
    assert.deepEqual(handoff.activationEvents(), [
      'sitewipe.beginCleanupPermissionHandoff',
      'permissions.getAll',
      'permissions.request',
      'sitewipe.confirmCleanupPermissionHandoffInvocation'
    ]);
    assert.equal(handoff.permissionSnapshotCalls()[0].userActivation, true);
    assert.equal(handoff.permissionCalls()[0].userActivation, true);
    assert.equal(handoff.grantCalls().length, 0, 'document destruction before result cannot invent outcome proof');
    assert.equal(handoff.resumeCalls().length, 0);
    assert.equal(handoff.settlementCalls().length, 0);
  } finally {
    await handoff.dispose();
  }
});

test('a replacement popup exposes and locks an unresolved target-access recovery obligation', async () => {
  const harness = await createPopupHarness({
    directCleanup: false,
    prepareResponses: [
      {
        review: detailedReview({
          hostPermissionsGranted: false,
          permissionLeaseId: 'lease-armed-in-another-popup',
          approvalHandoffStatus: 'armed'
        })
      }
    ],
    temporaryHostAccess: {
      state: 'prompt_pending',
      recoveryPending: false,
      reviewExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      temporaryOriginCount: 4,
      releaseAttemptCount: 0,
      lastReleaseAttemptAt: null,
      lastError: null
    }
  });
  try {
    await waitFor(() => harness.element('readyBadge').textContent === 'Recovery pending');
    assert.equal(harness.element('progressCard').hidden, false);
    assert.equal(harness.bodyHasClass('recovery-active'), true);
    assert.equal(harness.bodyHasClass('review-active'), false);
    assert.equal(harness.element('progressTitle').textContent, 'Previous target access needs recovery');
    assert.match(harness.element('progressDetail').textContent, /prompt pending; 4 exact pattern\(s\)/i);
    assert.match(harness.element('progressDetail').textContent, /Options.*Maintenance/i);
    assert.equal(harness.element('targetInput').disabled, true);
    assert.equal(harness.element('deepCleanButton').disabled, true);
    assert.equal(harness.prepareCalls().length, 0, "another popup's armed review must not transfer document authority");
    assert.equal(harness.permissionCalls().length, 0);
    assert.equal(harness.runCalls().length, 0);
  } finally {
    await harness.dispose();
  }
});

test('the dedicated recovery layout cannot hide its own status card', async () => {
  const css = await readFile(popupCssUrl, 'utf8');
  const recoverySelector = css.match(/body\.recovery-active :is\(([^)]*)\)\s*,/);
  assert.ok(recoverySelector, 'recovery mode must have an explicit isolation selector');
  assert.doesNotMatch(
    recoverySelector[1],
    /progress-card/,
    'recovery isolation must keep the only recovery explanation visible'
  );
});

test('an open popup follows prompt, cleanup, release, and proven-clear lease transitions', async () => {
  const harness = await createPopupHarness({
    temporaryHostAccess: {
      state: 'prompt_pending',
      recoveryPending: false,
      temporaryOriginCount: 4
    }
  });
  try {
    await waitFor(() => harness.element('readyBadge').textContent === 'Recovery pending');
    harness.emitPermissionLeaseChange({
      state: 'active_cleanup',
      recoveryPending: false,
      temporaryOriginCount: 4
    });
    await waitFor(() => /active cleanup; 4 exact pattern\(s\)/i.test(harness.element('progressDetail').textContent));

    harness.emitPermissionLeaseChange({
      state: 'release_pending',
      recoveryPending: true,
      temporaryOriginCount: 4
    });
    await waitFor(() => /release pending; 4 exact pattern\(s\)/i.test(harness.element('progressDetail').textContent));

    harness.emitPermissionLeaseChange({ state: 'none', recoveryPending: false, temporaryOriginCount: 0 });
    await waitFor(() => harness.element('readyBadge').textContent === 'Ready');
    assert.equal(harness.bodyHasClass('recovery-active'), false);
    assert.equal(harness.element('progressCard').hidden, true);
    assert.equal(harness.element('targetInput').disabled, false);
    assert.equal(harness.element('deepCleanButton').disabled, false);
  } finally {
    await harness.dispose();
  }
});

test('Clean another site re-proves temporary-access absence before leaving a report', async () => {
  const harness = await createPopupHarness({ storedReport: completedStoredReport() });
  try {
    await waitFor(() => harness.element('summaryCard').hidden === false);
    harness.setTemporaryHostAccess({
      state: 'release_pending',
      recoveryPending: true,
      temporaryOriginCount: 4
    });
    assert.equal(await harness.clickStartAnother(), true);
    await waitFor(() => harness.element('progressTitle').textContent === 'Previous target access needs recovery');
    assert.equal(harness.bodyHasClass('recovery-active'), true);
    assert.equal(
      harness.element('summaryCard').hidden,
      false,
      'the stored report must remain available underneath recovery'
    );
    assert.equal(harness.element('targetInput').disabled, true);
    assert.equal(harness.element('deepCleanButton').disabled, true);
  } finally {
    await harness.dispose();
  }
});

test('the exact handoff capability authenticates grant confirmation and one worker-owned resume', async () => {
  const error = new Error('Synthetic grant-confirmation response loss.');
  const harness = await createHandoffHarness({
    grantMessageError: error,
    resumeResponse: { resumedCompletedResult: true }
  });
  try {
    const activation = await harness.clickGrant();
    assert.equal(activation.accepted, true);
    await activation.completion;
    assert.equal(harness.grantCalls().length, 1);
    assert.equal(harness.resumeCalls().length, 1);
    assert.deepEqual(
      handoffAuthorityBinding(harness.resumeCalls()[0].payload),
      handoffAuthorityBinding(harness.grantCalls()[0].payload)
    );
    assert.match(harness.element('status').textContent, /Cleanup finished/i);
    assert.equal(harness.element('grantAccess').disabled, true);
  } finally {
    await harness.dispose();
  }
});

test('every granted handoff error remains exclusively worker-owned', async (t) => {
  const cases = [
    ['client message timeout', { name: 'MessageTimeoutError' }],
    ['worker operation unknown', { code: 'browser_operation_unknown' }],
    ['retryable lifecycle handoff', { code: 'lifecycle_not_ready', retryable: true }]
  ];
  for (const [label, classification] of cases) {
    await t.test(label, async () => {
      const error = Object.assign(
        new Error('SiteWipe could not return a terminal result; the worker may still be continuing.'),
        classification
      );
      const harness = await createHandoffHarness({ grantMessageError: error, resumeMessageError: error });
      try {
        const activation = await harness.clickGrant();
        await activation.completion;
        assert.equal(harness.permissionCalls().length, 1);
        assert.equal(harness.grantCalls().length, 1);
        assert.equal(harness.resumeCalls().length, 1, 'the exact handoff may attempt one worker-owned resume');
        assert.equal(harness.settlementCalls().length, 0);
        assert.match(harness.element('error').textContent, /worker may still be continuing/i);
        assert.equal(harness.element('grantAccess').disabled, true);
      } finally {
        await harness.dispose();
      }
    });
  }
});

test('a conclusive native denial settles only the exact bound handoff', async () => {
  const harness = await createHandoffHarness({ permissionRequestGranted: false });
  try {
    const activation = await harness.clickGrant();
    await activation.completion;
    assert.equal(harness.permissionCalls().length, 1);
    assert.equal(harness.settlementCalls().length, 1);
    assert.equal(harness.settlementCalls()[0].payload.outcome, 'denied');
    assertHandoffAuthorityBinding(harness.settlementCalls()[0].payload);
    assert.equal(harness.grantCalls().length, 0);
    assert.equal(harness.resumeCalls().length, 0);
    assert.match(harness.element('error').textContent, /not granted/i);
  } finally {
    await harness.dispose();
  }
});

for (const scenario of [
  {
    name: 'an exact pre-request grant',
    options: { permissionSnapshot: { permissions: [], origins: ['https://example.com/*'] } }
  },
  {
    name: 'a broad pre-request grant',
    options: { permissionSnapshot: { permissions: [], origins: ['<all_urls>'] } }
  },
  {
    name: 'a malformed pre-request inventory',
    options: { permissionSnapshot: { permissions: [], origins: 'not-an-array' } }
  },
  {
    name: 'a rejected pre-request inventory',
    options: { permissionSnapshotError: new Error('Synthetic pre-request inventory rejection.') }
  }
]) {
  test(`${scenario.name} cannot be composed with a true request result`, async () => {
    const harness = await createHandoffHarness({ permissionRequestGranted: true, ...scenario.options });
    try {
      const activation = await harness.clickGrant();
      await activation.completion;
      assert.equal(harness.permissionSnapshotCalls().length, 1);
      assert.equal(harness.permissionCalls().length, 1);
      assert.ok(harness.callIndex('permissions.getAll') < harness.callIndex('permissions.request'));
      assert.equal(harness.permissionSnapshotCalls()[0].userActivation, true);
      assert.equal(harness.permissionCalls()[0].userActivation, true);
      assert.equal(harness.settlementCalls().length, 1);
      assert.equal(harness.settlementCalls()[0].payload.outcome, 'abandoned');
      assert.equal(harness.grantCalls().length, 0);
      assert.equal(harness.resumeCalls().length, 0);
    } finally {
      await harness.dispose();
    }
  });
}

test('a truthy non-boolean native permission result cannot become handoff grant authority', async () => {
  const harness = await createHandoffHarness({ permissionRequestResult: 'granted' });
  try {
    const activation = await harness.clickGrant();
    await activation.completion;
    assert.equal(harness.settlementCalls().length, 1);
    assert.equal(harness.settlementCalls()[0].payload.outcome, 'abandoned');
    assert.equal(harness.grantCalls().length, 0);
    assert.equal(harness.resumeCalls().length, 0);
    assert.match(harness.element('error').textContent, /invalid target-access result/i);
  } finally {
    await harness.dispose();
  }
});

test('failure to persist authenticated handoff intent never admits a granted cleanup', async () => {
  const harness = await createHandoffHarness({
    permissionRequestGranted: true,
    beginMessageError: new Error('Synthetic prompt-intent persistence failure.')
  });
  try {
    const activation = await harness.clickGrant();
    await activation.completion;
    assert.equal(harness.beginCalls().length, 1);
    assert.equal(harness.permissionCalls().length, 1);
    assert.equal(harness.settlementCalls().length, 1);
    assert.equal(harness.settlementCalls()[0].payload.outcome, 'abandoned');
    assert.equal(harness.grantCalls().length, 0);
    assert.match(harness.element('error').textContent, /prompt-intent persistence failure/i);
  } finally {
    await harness.dispose();
  }
});

test('an asynchronously rejected native request abandons its authenticated handoff intent fail-closed', async () => {
  const harness = await createHandoffHarness({
    permissionRequestError: new Error('Synthetic ambiguous native request rejection.')
  });
  try {
    const activation = await harness.clickGrant();
    await activation.completion;
    assert.equal(harness.beginCalls().length, 1);
    assert.equal(harness.invocationCalls().length, 1);
    assert.equal(harness.settlementCalls().length, 1);
    assert.equal(harness.settlementCalls()[0].payload.outcome, 'abandoned');
    assertHandoffAuthorityBinding(harness.settlementCalls()[0].payload);
    assert.equal(harness.grantCalls().length, 0);
  } finally {
    await harness.dispose();
  }
});

test('a synchronous native-request invocation failure records no handoff invocation and settles not-invoked', async () => {
  const harness = await createHandoffHarness({
    permissionRequestThrows: new Error('Synthetic synchronous native request failure.')
  });
  try {
    const activation = await harness.clickGrant();
    await activation.completion;
    assert.equal(harness.beginCalls().length, 1);
    assert.equal(harness.permissionSnapshotCalls().length, 1);
    assert.equal(harness.permissionCalls().length, 1);
    assert.equal(harness.invocationCalls().length, 0);
    assert.equal(harness.settlementCalls().length, 1);
    assert.equal(harness.settlementCalls()[0].payload.outcome, 'not_invoked');
    assert.match(harness.element('error').textContent, /synchronous native request failure/i);
  } finally {
    await harness.dispose();
  }
});

test('an unrecorded late handoff begin cannot settle an unowned synchronous request failure', async () => {
  const harness = await createHandoffHarness({
    promptIntentRecorded: false,
    permissionRequestThrows: new Error('Synthetic synchronous request failure after late begin.')
  });
  try {
    const activation = await harness.clickGrant();
    await activation.completion;
    assert.equal(harness.beginCalls().length, 1);
    assert.equal(harness.permissionCalls().length, 1);
    assert.equal(harness.invocationCalls().length, 0);
    assert.equal(harness.settlementCalls().length, 0);
    assert.equal(harness.grantCalls().length, 0);
  } finally {
    await harness.dispose();
  }
});

test('Settings waits for an in-flight direct preflight and conclusively retires it before Options opens', async () => {
  const harness = await createPopupHarness({
    directCleanup: true,
    prepareResponseDeferred: true,
    prepareResponses: [{ review: directReview({ hostPermissionsGranted: false }) }]
  });
  try {
    await waitFor(() => harness.prepareCalls().length === 1);
    const opening = harness.clickOptions();
    await wait(20);
    assert.equal(harness.optionsCalls().length, 0, 'Options must not race the still-pending review preparation');

    harness.settlePreparation();
    assert.equal(await opening, true);
    await waitFor(() => harness.optionsCalls().length === 1);

    assert.equal(harness.cancelReviewCalls().length, 1);
    assert.equal(harness.cancelReviewCalls()[0].payload.promptNotStarted, true);
    assert.ok(
      harness.callIndex('sitewipe.cancelCleanupReview') < harness.callIndex('runtime.openOptionsPage'),
      'the exact same-document prompt-not-started cancellation must settle before Options opens'
    );
    assert.equal(harness.permissionCalls().length, 0);
    assert.equal(harness.armCalls().length, 0);
    assert.equal(harness.runCalls().length, 0);
  } finally {
    harness.settlePreparation();
    await harness.dispose();
  }
});

test('a target or settings change invalidates a pending startup retry without mutation', async (t) => {
  await t.test('target change', async () => {
    const harness = await createPopupHarness({
      directCleanup: true,
      prepareResponses: [
        lifecycleNotReady(),
        { errorCode: 'invalid_message', retryable: false, error: 'Synthetic replacement-target rejection.' }
      ]
    });
    try {
      await waitFor(() => harness.prepareCalls().length === 1);
      harness.element('targetInput').value = 'replacement.example';
      await harness.element('targetInput').emit('input');
      await waitFor(() => harness.prepareCalls().some((call) => call.payload.input === 'replacement.example'), 2_000);
      await wait(800);

      assert.equal(
        harness.prepareCalls().filter((call) => call.payload.input === 'example.com').length,
        1,
        'the superseded target must not consume the bounded retry'
      );
      assert.deepEqual(harness.mutationCalls(), []);
    } finally {
      await harness.dispose();
    }
  });

  await t.test('settings change', async () => {
    const harness = await createPopupHarness({ directCleanup: true, prepareResponses: [lifecycleNotReady()] });
    try {
      await waitFor(() => harness.prepareCalls().length === 1);
      harness.emitSettingsChange({ cleanupMode: 'expert', skipCleanupReview: false });
      await wait(800);

      assert.equal(harness.prepareCalls().length, 1, 'disabled direct mode must cancel the pending bounded retry');
      assert.equal(harness.element('deepCleanLabel').textContent, 'Review cleanup');
      assert.deepEqual(harness.mutationCalls(), []);
    } finally {
      await harness.dispose();
    }
  });
});

test('terminal preparation errors do not retry, enable cleanup, request access, or mutate', async () => {
  const harness = await createPopupHarness({
    directCleanup: true,
    prepareResponses: [
      {
        errorCode: 'invalid_message',
        retryable: false,
        error: 'Synthetic terminal preflight failure.'
      }
    ]
  });
  try {
    await waitFor(() => harness.prepareCalls().length === 1);
    await wait(800);

    assert.equal(harness.prepareCalls().length, 1);
    assert.equal(harness.element('deepCleanButton').disabled, true);
    assert.equal(harness.element('targetError').textContent, 'Synthetic terminal preflight failure.');
    assert.deepEqual(harness.mutationCalls(), []);
    assert.equal(await harness.clickPrimary(), false);
  } finally {
    await harness.dispose();
  }
});

test('a changed popup window or private state cannot inherit the delayed preparation', async () => {
  const harness = await createPopupHarness({ directCleanup: true, prepareResponses: [lifecycleNotReady()] });
  try {
    await waitFor(() => harness.prepareCalls().length === 1);
    harness.setCurrentWindow({ id: 7, incognito: true });
    await wait(800);

    assert.equal(harness.prepareCalls().length, 1);
    assert.match(harness.element('targetError').textContent, /private-window state changed during startup/i);
    assert.equal(harness.element('deepCleanButton').disabled, true);
    assert.deepEqual(harness.mutationCalls(), []);
  } finally {
    await harness.dispose();
  }
});

test('detailed review remains click-prepared and never routes directly to cleanup', async () => {
  const harness = await createPopupHarness({
    directCleanup: false,
    prepareResponses: [{ review: detailedReview() }]
  });
  try {
    await wait(20);
    assert.equal(harness.prepareCalls().length, 0, 'detailed review must not use the hidden direct preflight');
    assert.equal(harness.element('deepCleanLabel').textContent, 'Review cleanup');

    assert.equal(await harness.clickPrimary(), true);
    await waitFor(() => harness.prepareCalls().length === 1);
    await waitFor(() => harness.element('reviewCard').hidden === false);
    assert.equal(harness.runCalls().length, 0);
    assert.equal(harness.permissionCalls().length, 0);
  } finally {
    await harness.dispose();
  }
});

test("an armed status without this document's acknowledgement remains non-clickable", async () => {
  const review = detailedReview({
    hostPermissionsGranted: false,
    permissionLeaseId: 'lease-exact-prompt-reopen',
    approvalHandoffStatus: 'armed'
  });
  const harness = await createPopupHarness({
    directCleanup: false,
    prepareResponses: [{ review }]
  });
  try {
    assert.equal(await harness.clickPrimary(), true);
    await waitFor(() => harness.element('reviewCard').hidden === false);
    assert.equal(harness.element('reviewHostPermission').hidden, false);
    assert.equal(harness.element('reviewApprovalCommitted').hidden, true);
    assert.equal(harness.element('approveCleanup').textContent, 'Saving reviewed approval…');
    assert.equal(harness.element('approveCleanup').disabled, true);

    harness.element('reviewScopeAcknowledge').checked = true;
    await harness.element('reviewScopeAcknowledge').emit('change');
    assert.equal(await harness.clickApprove(), false);

    assert.equal(harness.permissionCalls().length, 0, 'status alone must not open a native prompt');
    assert.equal(harness.runCalls().length, 0, 'status alone must not submit the single-use token again');
    assert.equal(harness.retiredPromptRouteCalls().length, 0);
  } finally {
    await harness.dispose();
  }
});

test('expiry in a reopened armed popup revokes cleanup authority without claiming another handoff outcome', async () => {
  const review = detailedReview({
    hostPermissionsGranted: false,
    permissionLeaseId: 'lease-reopened-expiring-prompt',
    approvalHandoffStatus: 'armed',
    expiresAt: new Date(Date.now() + 80).toISOString()
  });
  const harness = await createPopupHarness({
    directCleanup: false,
    prepareResponses: [{ review }]
  });
  try {
    assert.equal(await harness.clickPrimary(), true);
    await waitFor(() => harness.element('reviewCard').hidden === false);
    await waitFor(() => harness.element('progressTitle').textContent === 'Cleanup review expired', 1_000);

    assert.equal(harness.cancelReviewCalls().length, 1, 'expiry must revoke the stale cleanup approval');
    assert.equal(harness.retiredPromptRouteCalls().length, 0, 'a reopened popup must not use retired prompt routes');
    assert.equal(harness.permissionCalls().length, 0);
    assert.equal(harness.openHandoffCalls().length, 0);
    assert.equal(harness.runCalls().length, 0);
  } finally {
    await harness.dispose();
  }
});

test('a visible detailed review expires closed before it can request access or submit cleanup', async () => {
  const harness = await createPopupHarness({
    directCleanup: false,
    prepareResponses: [
      {
        review: detailedReview({
          hostPermissionsGranted: false,
          permissionLeaseId: 'lease-expiring-visible-review',
          expiresAt: new Date(Date.now() + 80).toISOString()
        })
      }
    ]
  });
  try {
    assert.equal(await harness.clickPrimary(), true);
    await waitFor(() => harness.element('reviewCard').hidden === false);
    harness.element('reviewScopeAcknowledge').checked = true;
    await harness.element('reviewScopeAcknowledge').emit('change');
    assert.equal(harness.element('approveCleanup').disabled, false);

    await waitFor(() => harness.element('progressTitle').textContent === 'Cleanup review expired', 1_000);

    assert.equal(harness.element('reviewCard').hidden, true);
    assert.equal(harness.element('approveCleanup').disabled, true);
    assert.equal(harness.element('deepCleanLabel').textContent, 'Review cleanup');
    assert.match(harness.element('progressDetail').textContent, /No cleanup started/i);
    assert.equal(harness.permissionCalls().length, 0);
    assert.equal(harness.runCalls().length, 0);
    assert.equal(harness.cancelReviewCalls().length, 1);
    assert.equal(await harness.clickApprove(), false);
  } finally {
    await harness.dispose();
  }
});

test('a handoff-open failure remains a retryable popup error without invoking native access', async () => {
  const harness = await createPopupHarness({
    directCleanup: false,
    openHandoffMessageError: new Error('The persistent reviewed-access tab could not be opened.'),
    prepareResponses: [
      {
        review: detailedReview({
          hostPermissionsGranted: false,
          permissionLeaseId: 'lease-handoff-open-retry'
        })
      }
    ]
  });
  try {
    assert.equal(await harness.clickPrimary(), true);
    await waitFor(() => harness.element('reviewCard').hidden === false);
    harness.element('reviewScopeAcknowledge').checked = true;
    await harness.element('reviewScopeAcknowledge').emit('change');

    assert.equal(await harness.clickApprove(), true);
    await waitFor(() => harness.openHandoffCalls().length === 1);
    await waitFor(() => harness.element('approveCleanup').disabled === false);

    assert.equal(harness.armCalls().length, 1);
    assert.equal(harness.permissionSnapshotCalls().length, 0);
    assert.equal(harness.permissionCalls().length, 0);
    assert.equal(harness.retiredPromptRouteCalls().length, 0);
    assert.equal(harness.runCalls().length, 0);
    assert.equal(harness.element('reviewCard').hidden, false);
    assert.equal(harness.element('approveCleanup').textContent, 'Grant reviewed access and run');
    await waitFor(() => /could not be opened/i.test(harness.element('reviewApprovalError').textContent));
    assert.match(harness.element('reviewApprovalError').textContent, /could not be opened/i);

    assert.equal(await harness.clickApprove(), true, 'the armed review may retry only the worker-owned handoff open');
    await waitFor(() => harness.openHandoffCalls().length === 2);
    assert.equal(harness.armCalls().length, 1, 'retry must not re-arm the durable approval');
    assert.equal(harness.permissionCalls().length, 0);
  } finally {
    await harness.dispose();
  }
});

test('an expired persistent handoff claim fails closed before any native permission API', async () => {
  const harness = await createHandoffHarness({
    claimMessageError: new Error('This reviewed handoff expired. Reopen SiteWipe to prepare a fresh review.')
  });
  try {
    assert.equal(harness.claimCalls().length, 1);
    assert.equal(harness.element('grantAccess').disabled, true);
    assert.equal((await harness.clickGrant()).accepted, false);
    assert.equal(harness.permissionSnapshotCalls().length, 0);
    assert.equal(harness.permissionCalls().length, 0);
    assert.match(harness.element('status').textContent, /No cleanup started/i);
    assert.match(harness.element('error').textContent, /handoff expired/i);
  } finally {
    await harness.dispose();
  }
});

test('a rejected durable arm never opens the native permission prompt or starts cleanup', async () => {
  const review = detailedReview({
    hostPermissionsGranted: false,
    permissionLeaseId: 'lease-rejected-arm',
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
  const harness = await createPopupHarness({
    directCleanup: false,
    armMessageError: new Error('The worker could not durably save this exact cleanup approval.'),
    prepareResponses: [{ review }]
  });
  try {
    assert.equal(await harness.clickPrimary(), true);
    await waitFor(() => harness.element('reviewCard').hidden === false);
    harness.element('reviewScopeAcknowledge').checked = true;
    await harness.element('reviewScopeAcknowledge').emit('change');

    assert.equal(await harness.clickApprove(), true);
    await waitFor(() => harness.armCalls().length === 1);
    await waitFor(() => harness.cancelReviewCalls().length === 1);
    await wait(320);

    assert.equal(harness.permissionCalls().length, 0);
    assert.equal(harness.retiredPromptRouteCalls().length, 0);
    assert.equal(harness.openHandoffCalls().length, 0);
    assert.equal(harness.runCalls().length, 0);
    assert.equal(harness.cancelReviewCalls()[0].payload.promptNotStarted, true);
    assert.equal(harness.element('reviewCard').hidden, true, 'an unconfirmed approval must be retired');
    assert.equal(harness.element('approveCleanup').disabled, true);
    assert.match(harness.element('targetError').textContent, /could not durably save/i);
    assert.equal(await harness.clickApprove(), false);
  } finally {
    await harness.dispose();
  }
});

for (const scenario of [
  {
    name: 'a completed cleanup',
    grantResponse: { report: { id: 'handoff-report' }, resumedCompletedResult: true },
    status: /Cleanup finished.*temporary target access was reconciled/i
  },
  {
    name: 'an admitted running cleanup',
    grantResponse: { cleanupStarted: true, approvalHandoffRunning: true },
    status: /Cleanup started from the exact reviewed handoff/i
  },
  {
    name: 'an expired approval reconciled after a late grant',
    grantResponse: { approvalHandoffCanceled: true, cleanupStarted: false },
    status: /No cleanup started.*reconciled the temporary target access/i
  },
  {
    name: 'an outcome still under worker reconciliation',
    grantResponse: { approvalHandoffPending: true, approvalHandoffUncertain: true },
    status: /still reconciling this exact reviewed handoff.*Do not repeat/i
  }
]) {
  test(`the persistent handoff renders ${scenario.name} and remains single-use`, async () => {
    const harness = await createHandoffHarness({ grantResponse: scenario.grantResponse });
    try {
      const activation = await harness.clickGrant();
      assert.equal(activation.accepted, true);
      await activation.completion;

      assert.equal(harness.permissionCalls().length, 1);
      assert.equal(harness.grantCalls().length, 1);
      assert.equal(harness.resumeCalls().length, 0);
      assert.equal(harness.settlementCalls().length, 0);
      assert.match(harness.element('status').textContent, scenario.status);
      assert.equal(harness.element('grantAccess').disabled, true);
      assert.equal((await harness.clickGrant()).accepted, false, 'a terminal handoff document cannot run twice');
    } finally {
      await harness.dispose();
    }
  });
}

function popupAuthorityBinding(payload) {
  return {
    popupContextId: payload?.popupContextId,
    popupPreparationCapability: payload?.popupPreparationCapability
  };
}

function assertPopupAuthorityBinding(payload) {
  assert.equal(typeof payload?.popupContextId, 'string');
  assert.equal(payload.popupContextId, payload.popupContextId.trim());
  assert.ok(payload.popupContextId.length > 0 && payload.popupContextId.length <= 256);
  assert.match(payload.popupPreparationCapability, /^[a-f0-9]{64}$/);
}

function handoffAuthorityBinding(payload) {
  return {
    handoffNonce: payload?.handoffNonce,
    handoffCapability: payload?.handoffCapability
  };
}

function assertHandoffAuthorityBinding(payload) {
  assert.match(payload?.handoffNonce, /^[a-zA-Z0-9._:-]{8,128}$/);
  assert.match(payload?.handoffCapability, /^[a-f0-9]{64}$/);
}

function lifecycleNotReady() {
  return {
    errorCode: 'lifecycle_not_ready',
    retryable: true,
    error: 'SiteWipe startup maintenance has not settled yet.'
  };
}

function directReview({ cleanupMode = 'standard', hostPermissionsGranted = true } = {}) {
  const exactOrigins = [
    'http://example.com/*',
    'https://example.com/*',
    'http://*.example.com/*',
    'https://*.example.com/*'
  ];
  return {
    approvalToken: (cleanupMode === 'expert' ? 'b' : 'a').repeat(48),
    approvalMode: 'settings_direct',
    normalizedTarget: 'example.com',
    createdAt: '2026-08-20T12:00:00.000Z',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    hostPermissionsGranted,
    requiredHostPermissionOrigins: exactOrigins,
    temporaryHostPermissionOrigins: hostPermissionsGranted ? [] : exactOrigins,
    permissionLeaseId: hostPermissionsGranted ? null : `${cleanupMode}-lease`,
    approvalHandoffNonce: hostPermissionsGranted ? null : `${cleanupMode}-handoff-nonce`
  };
}

function detailedReview({
  hostPermissionsGranted = true,
  promptGrantResumed = false,
  permissionLeaseId = null,
  approvalHandoffStatus = null,
  expiresAt = new Date(Date.now() + 60_000).toISOString()
} = {}) {
  const requiredHostPermissionOrigins = [
    'http://example.com/*',
    'https://example.com/*',
    'http://*.example.com/*',
    'https://*.example.com/*'
  ];
  return {
    approvalToken: 'd'.repeat(48),
    approvalMode: 'detailed_review',
    normalizedTarget: 'example.com',
    scopeLabel: 'example.com and subdomains',
    includesSubdomains: true,
    hostPermissionsGranted,
    promptGrantResumed,
    permissionLeaseId,
    approvalHandoffNonce: permissionLeaseId ? 'detailed-handoff-nonce' : null,
    approvalHandoffStatus,
    requiredHostPermissionOrigins,
    temporaryHostPermissionOrigins: permissionLeaseId ? requiredHostPermissionOrigins : [],
    hostPermissionInventory: {
      exactRequiredHostPermissionOrigins: hostPermissionsGranted ? requiredHostPermissionOrigins : [],
      requiredCoveredByBroadHostPermissionOrigins: [],
      broadGrantedHostPermissionOrigins: [],
      allSitesAccessGranted: false
    },
    associatedTargets: [],
    categoriesAttempted: [],
    categoriesProtected: [],
    categoriesUnavailable: [],
    warnings: [],
    previewLimitations: [],
    effects: {},
    requirements: {},
    expiresAt
  };
}

function completedStoredReport() {
  return {
    id: 'stored-report-exact',
    status: 'completed',
    targetDomain: 'example.com',
    startedAt: '2026-08-21T12:00:00.000Z',
    finishedAt: '2026-08-21T12:00:01.000Z',
    errors: [],
    skipped: [],
    unavailable: [],
    sections: [],
    summary: {
      cleanupMode: 'standard',
      cleanupApprovalMode: 'detailed_review',
      verificationStatus: 'verified_zero',
      totalDurationMs: 1_000,
      cookiesRemoved: 1,
      historyEntriesRemoved: 0
    }
  };
}

async function createPopupHarness(options = {}) {
  const html = await readFile(popupHtmlUrl, 'utf8');
  const document = createFakeDocument([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const calls = [];
  const activationEvents = [];
  const settingsListeners = [];
  const pagehideListeners = [];
  const prepareResponses = [...(options.prepareResponses || [])];
  const sidePanelBindingLifetimes = [...(options.sidePanelBindingLifetimes || [5 * 60 * 1000])];
  const userActivation = { isActive: true };
  let settleDeferredPreparation = null;
  let settleDeferredArm = null;
  let trackingActivation = false;
  let activeActivationBatch = null;
  const activationBatches = [];
  let preparationSequence = 0;
  let currentWindow = { id: 7, incognito: false };
  let storedReport = options.storedReport ? structuredClone(options.storedReport) : null;
  const activeJob = options.activeJob ? structuredClone(options.activeJob) : null;
  let temporaryHostAccess = structuredClone(
    options.temporaryHostAccess || { state: 'none', recoveryPending: false, temporaryOriginCount: 0 }
  );
  const settings = {
    cleanupMode: options.cleanupMode || 'standard',
    skipCleanupReview: options.directCleanup === true,
    reducedMotion: false,
    highContrast: false
  };
  const chrome = {
    runtime: {
      async sendMessage(request) {
        calls.push({ type: request.type, payload: structuredClone(request.payload || {}) });
        if (activeActivationBatch) activeActivationBatch.push(request.type);
        if (
          trackingActivation &&
          userActivation.isActive &&
          ['sitewipe.armCleanupApproval', 'sitewipe.openCleanupPermissionHandoff', 'sitewipe.runDeepClean'].includes(
            request.type
          )
        ) {
          activationEvents.push(request.type);
        }
        if (request.type === 'sitewipe.getPopupState') {
          return envelope(request, {
            settings: structuredClone(settings),
            report: storedReport ? structuredClone(storedReport) : null,
            incognitoAccess: true,
            activeJob: activeJob ? structuredClone(activeJob) : null,
            temporaryHostAccess: structuredClone(temporaryHostAccess)
          });
        }
        if (request.type === 'sitewipe.getActiveTabTarget') {
          return envelope(request, {
            activeTab: {
              supported: true,
              tab: {
                id: 3,
                windowId: options.activeTabWindowId ?? 7,
                incognito: false,
                title: 'Synthetic target',
                url: 'https://example.com/path?private=redacted'
              },
              normalized: {
                ok: true,
                input: 'example.com',
                target: { domain: 'example.com' }
              }
            }
          });
        }
        if (request.type === 'sitewipe.normalizeTarget') {
          const domain = String(request.payload?.input || '')
            .trim()
            .toLowerCase();
          return envelope(request, { normalized: { ok: true, input: domain, target: { domain } } });
        }
        if (request.type === 'sitewipe.prepareCleanupReview') {
          const response = prepareResponses.shift() || {
            errorCode: 'invalid_message',
            retryable: false,
            error: 'Unexpected extra preparation attempt.'
          };
          preparationSequence += 1;
          const preparedResponse = response.review
            ? {
                ...response,
                popupContextId: response.popupContextId || 'opaque popup/context #test',
                popupPreparationCapability:
                  response.popupPreparationCapability || (preparationSequence % 16).toString(16).repeat(64)
              }
            : response;
          if (options.prepareResponseDeferred && !settleDeferredPreparation) {
            return new Promise((resolve) => {
              settleDeferredPreparation = () =>
                resolve(
                  preparedResponse.error
                    ? errorEnvelope(request, preparedResponse)
                    : envelope(request, preparedResponse)
                );
            });
          }
          return preparedResponse.error
            ? errorEnvelope(request, preparedResponse)
            : envelope(request, preparedResponse);
        }
        if (request.type === 'sitewipe.openSidePanel') {
          if (
            !options.storedReport ||
            request.payload.reportId !== options.storedReport.id ||
            request.payload.windowId !== 7
          ) {
            return errorEnvelope(request, {
              errorCode: 'sitewipe_action_failed',
              retryable: false,
              error: 'Synthetic exact report/window binding rejected.'
            });
          }
          const lifetime = sidePanelBindingLifetimes.shift() ?? 5 * 60 * 1000;
          return envelope(request, {
            reportId: options.storedReport.id,
            windowId: 7,
            expiresAt: new Date(Date.now() + lifetime).toISOString()
          });
        }
        if (request.type === 'sitewipe.armCleanupApproval') {
          if (options.armMessageError) throw options.armMessageError;
          const armedResponse = envelope(request, {
            approvalArmed: true,
            handoffStatus: 'armed',
            handoffNonce: request.payload.handoffNonce,
            expiresAt: new Date(Date.now() + 60_000).toISOString()
          });
          if (options.armResponseDeferred && !settleDeferredArm) {
            return new Promise((resolve) => {
              settleDeferredArm = () => resolve(armedResponse);
            });
          }
          return armedResponse;
        }
        if (request.type === 'sitewipe.openCleanupPermissionHandoff') {
          if (options.openHandoffMessageError) throw options.openHandoffMessageError;
          const openedResponse = envelope(request, {
            handoffOpened: true,
            handoffFocused: options.handoffFocused === true,
            tabId: 41
          });
          return openedResponse;
        }
        if (request.type === 'sitewipe.runDeepClean') {
          const terminalResponse = {
            reportPersisted: false,
            report: {
              id: 'synthetic-report',
              status: 'completed',
              targetDomain: 'example.com',
              errors: [],
              unavailable: [],
              sections: [],
              summary: {
                cleanupMode: settings.cleanupMode,
                cleanupApprovalMode: 'settings_direct',
                verificationStatus: 'verified_zero',
                totalDurationMs: 12
              }
            }
          };
          return envelope(request, terminalResponse);
        }
        if (
          [
            'sitewipe.beginCleanupPermissionPrompt',
            'sitewipe.confirmCleanupPermissionPromptInvocation',
            'sitewipe.confirmCleanupPermissionGrantOutcome',
            'sitewipe.resumeArmedCleanup',
            'sitewipe.settleCleanupPermissionPrompt'
          ].includes(request.type)
        ) {
          throw new Error(`The popup invoked retired permission route ${request.type}.`);
        }
        return envelope(request, {});
      },
      openOptionsPage: async () => {
        calls.push({ type: 'runtime.openOptionsPage', payload: {} });
      }
    },
    windows: {
      getCurrent: async () => structuredClone(currentWindow)
    },
    sidePanel: {
      open(details) {
        calls.push({
          type: 'sidePanel.open',
          payload: structuredClone(details),
          userActivation: userActivation.isActive
        });
        if (!userActivation.isActive) {
          return Promise.reject(new Error('`sidePanel.open()` may only be called in response to a user gesture.'));
        }
        if (options.sidePanelOpenError) return Promise.reject(new Error(options.sidePanelOpenError));
        return Promise.resolve();
      }
    },
    permissions: {
      getAll: () => {
        calls.push({ type: 'permissions.getAll', userActivation: userActivation.isActive });
        throw new Error('The popup must not inspect native permissions.');
      },
      request: (request) => {
        calls.push({
          type: 'permissions.request',
          payload: structuredClone(request),
          userActivation: userActivation.isActive
        });
        throw new Error('The popup must not request native permissions.');
      },
      contains: () => {
        calls.push({ type: 'permissions.contains', userActivation: userActivation.isActive });
        throw new Error('The popup must not inspect native permissions.');
      },
      remove: (request) => {
        calls.push({ type: 'permissions.remove', payload: structuredClone(request) });
        throw new Error('The popup must not remove native permissions.');
      }
    },
    storage: {
      onChanged: {
        addListener(listener) {
          settingsListeners.push(listener);
        }
      }
    }
  };
  const restoreGlobals = installGlobals({
    chrome,
    document,
    navigator: { userActivation },
    addEventListener(type, listener) {
      if (type === 'pagehide') pagehideListeners.push(listener);
    }
  });

  try {
    importSequence += 1;
    await import(`${popupUrl.href}?direct-startup-retry=${importSequence}`);
    await document.fireDomReady();
    userActivation.isActive = false;
  } catch (error) {
    restoreGlobals();
    throw error;
  }

  return {
    element: (id) => document.byId(id),
    bodyHasClass: (name) => document.body.classList.values.has(name),
    prepareCalls: () => calls.filter((call) => call.type === 'sitewipe.prepareCleanupReview'),
    sidePanelBindingCalls: () => calls.filter((call) => call.type === 'sitewipe.openSidePanel'),
    sidePanelOpenCalls: () => calls.filter((call) => call.type === 'sidePanel.open'),
    callIndex: (type) => calls.findIndex((call) => call.type === type),
    permissionCalls: () => calls.filter((call) => call.type === 'permissions.request'),
    permissionSnapshotCalls: () => calls.filter((call) => call.type === 'permissions.getAll'),
    armCalls: () => calls.filter((call) => call.type === 'sitewipe.armCleanupApproval'),
    openHandoffCalls: () => calls.filter((call) => call.type === 'sitewipe.openCleanupPermissionHandoff'),
    retiredPromptRouteCalls: () =>
      calls.filter((call) =>
        [
          'sitewipe.beginCleanupPermissionPrompt',
          'sitewipe.confirmCleanupPermissionPromptInvocation',
          'sitewipe.confirmCleanupPermissionGrantOutcome',
          'sitewipe.resumeArmedCleanup',
          'sitewipe.settleCleanupPermissionPrompt'
        ].includes(call.type)
      ),
    runCalls: () => calls.filter((call) => call.type === 'sitewipe.runDeepClean'),
    cancelReviewCalls: () => calls.filter((call) => call.type === 'sitewipe.cancelCleanupReview'),
    optionsCalls: () => calls.filter((call) => call.type === 'runtime.openOptionsPage'),
    mutationCalls: () => calls.filter((call) => ['permissions.request', 'sitewipe.runDeepClean'].includes(call.type)),
    activationEvents: () => [...activationEvents],
    activationBatches: () => activationBatches.map((batch) => [...batch]),
    async clickPrimary() {
      if (document.byId('deepCleanButton').disabled) return false;
      const activationBatch = [];
      activationBatches.push(activationBatch);
      activeActivationBatch = activationBatch;
      trackingActivation = true;
      userActivation.isActive = true;
      const emission = document.byId('targetForm').emit('submit');
      userActivation.isActive = false;
      activeActivationBatch = null;
      await emission;
      return true;
    },
    async clickFullReport() {
      if (document.byId('openSidePanel').disabled || document.byId('openSidePanel').hidden) return false;
      userActivation.isActive = true;
      const emission = document.byId('openSidePanel').emit('click');
      userActivation.isActive = false;
      await emission;
      await Promise.resolve();
      return true;
    },
    async clickApprove() {
      if (document.byId('approveCleanup').disabled) return false;
      const activationBatch = [];
      activationBatches.push(activationBatch);
      activeActivationBatch = activationBatch;
      trackingActivation = true;
      userActivation.isActive = true;
      const emission = document.byId('approveCleanup').emit('click');
      userActivation.isActive = false;
      activeActivationBatch = null;
      await emission;
      return true;
    },
    async clickOptions() {
      if (document.byId('openOptions').disabled) return false;
      await document.byId('openOptions').emit('click');
      return true;
    },
    async clickStartAnother() {
      if (document.byId('startAnotherCleanup').disabled) return false;
      await document.byId('startAnotherCleanup').emit('click');
      return true;
    },
    emitSettingsChange(nextSettings) {
      Object.assign(settings, structuredClone(nextSettings));
      for (const listener of settingsListeners) {
        listener(
          {
            'sitewipe.settings.v1': {
              newValue: structuredClone(settings)
            }
          },
          'local'
        );
      }
    },
    setTemporaryHostAccess(access) {
      temporaryHostAccess = structuredClone(access);
    },
    emitPermissionLeaseChange(access) {
      temporaryHostAccess = structuredClone(access);
      const newValue = access?.state === 'none' ? undefined : { status: access?.state || 'invalid' };
      for (const listener of settingsListeners) {
        listener(
          {
            'sitewipe.permissionLease.v1': {
              newValue
            }
          },
          'local'
        );
      }
    },
    setCurrentWindow(nextWindow) {
      currentWindow = structuredClone(nextWindow);
    },
    settlePreparation() {
      const settle = settleDeferredPreparation;
      settleDeferredPreparation = null;
      settle?.();
    },
    settleArmResponse() {
      const settle = settleDeferredArm;
      settleDeferredArm = null;
      settle?.();
    },
    async dispose() {
      for (const listener of pagehideListeners) listener();
      await wait(380);
      restoreGlobals();
    }
  };
}

async function createHandoffHarness(options = {}) {
  const html = await readFile(handoffHtmlUrl, 'utf8');
  const document = createFakeDocument([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  document.byId('grantAccess').disabled = true;
  document.byId('error').hidden = true;
  const calls = [];
  const activationEvents = [];
  const pagehideListeners = [];
  const userActivation = { isActive: false };
  const origins = [
    'http://example.com/*',
    'https://example.com/*',
    'http://*.example.com/*',
    'https://*.example.com/*'
  ];
  const handoffNonce = options.handoffNonce || 'handoff-nonce-test';
  const handoffCapability = options.handoffCapability || 'c'.repeat(64);
  let settleDeferredPermission = null;

  const responseFor = (request, payload = {}) => envelope(request, payload);
  const chrome = {
    runtime: {
      async sendMessage(request) {
        calls.push({
          type: request.type,
          payload: structuredClone(request.payload || {}),
          userActivation: userActivation.isActive
        });
        if (userActivation.isActive) activationEvents.push(request.type);
        if (request.type === 'sitewipe.claimCleanupPermissionHandoff') {
          if (options.claimMessageError) throw options.claimMessageError;
          return responseFor(request, {
            handoffClaimed: options.handoffClaimed !== false,
            handoffNonce,
            handoffCapability,
            temporaryHostPermissionOrigins: structuredClone(options.origins || origins),
            targetDisplayName: 'example.com',
            expiresAt: new Date(Date.now() + 60_000).toISOString()
          });
        }
        if (request.type === 'sitewipe.beginCleanupPermissionHandoff') {
          if (options.beginMessageError) throw options.beginMessageError;
          return responseFor(request, {
            promptIntentRecorded: options.promptIntentRecorded !== false,
            handoffNonce
          });
        }
        if (request.type === 'sitewipe.confirmCleanupPermissionHandoffInvocation') {
          if (options.invocationMessageError) throw options.invocationMessageError;
          return responseFor(request, {
            promptInvocationRecorded: options.promptInvocationRecorded !== false,
            handoffNonce
          });
        }
        if (request.type === 'sitewipe.confirmCleanupPermissionHandoffGrant') {
          if (options.grantMessageError) throw options.grantMessageError;
          return responseFor(
            request,
            options.grantResponse || {
              approvalHandoffRunning: true,
              cleanupStarted: true,
              approvalHandoffNonce: handoffNonce
            }
          );
        }
        if (request.type === 'sitewipe.resumeCleanupPermissionHandoff') {
          if (options.resumeMessageError) throw options.resumeMessageError;
          return responseFor(
            request,
            options.resumeResponse || {
              approvalHandoffPending: true,
              approvalHandoffUncertain: true,
              approvalHandoffNonce: handoffNonce
            }
          );
        }
        if (request.type === 'sitewipe.settleCleanupPermissionHandoff') {
          if (options.settlementMessageError) throw options.settlementMessageError;
          return responseFor(request, {
            settlement: options.settlementResponse || {
              released: true,
              accessRemains: false,
              recordRetained: false
            }
          });
        }
        throw new Error(`Unexpected handoff message: ${request.type}`);
      }
    },
    permissions: {
      getAll() {
        calls.push({ type: 'permissions.getAll', userActivation: userActivation.isActive });
        if (userActivation.isActive) activationEvents.push('permissions.getAll');
        if (options.permissionSnapshotThrows) throw options.permissionSnapshotThrows;
        if (options.permissionSnapshotError) return Promise.reject(options.permissionSnapshotError);
        return Promise.resolve(structuredClone(options.permissionSnapshot || { permissions: [], origins: [] }));
      },
      request(request) {
        calls.push({
          type: 'permissions.request',
          payload: structuredClone(request),
          userActivation: userActivation.isActive
        });
        if (userActivation.isActive) activationEvents.push('permissions.request');
        if (options.permissionRequestThrows) throw options.permissionRequestThrows;
        if (options.permissionRequestDeferred) {
          return new Promise((resolve, reject) => {
            settleDeferredPermission = { resolve, reject };
          });
        }
        if (options.permissionRequestError) return Promise.reject(options.permissionRequestError);
        return Promise.resolve(
          Object.hasOwn(options, 'permissionRequestResult')
            ? options.permissionRequestResult
            : options.permissionRequestGranted !== false
        );
      }
    }
  };
  const restoreGlobals = installGlobals({
    chrome,
    document,
    navigator: { userActivation },
    addEventListener(type, listener) {
      if (type === 'pagehide') pagehideListeners.push(listener);
    }
  });

  try {
    importSequence += 1;
    await import(`${handoffUrl.href}?direct-startup-retry=${importSequence}`);
    await document.fireDomReady();
    userActivation.isActive = false;
  } catch (error) {
    restoreGlobals();
    throw error;
  }

  const byType = (type) => calls.filter((call) => call.type === type);
  return {
    element: (id) => document.byId(id),
    calls: () => structuredClone(calls),
    claimCalls: () => byType('sitewipe.claimCleanupPermissionHandoff'),
    beginCalls: () => byType('sitewipe.beginCleanupPermissionHandoff'),
    invocationCalls: () => byType('sitewipe.confirmCleanupPermissionHandoffInvocation'),
    grantCalls: () => byType('sitewipe.confirmCleanupPermissionHandoffGrant'),
    resumeCalls: () => byType('sitewipe.resumeCleanupPermissionHandoff'),
    settlementCalls: () => byType('sitewipe.settleCleanupPermissionHandoff'),
    permissionSnapshotCalls: () => byType('permissions.getAll'),
    permissionCalls: () => byType('permissions.request'),
    activationEvents: () => [...activationEvents],
    callIndex: (type) => calls.findIndex((call) => call.type === type),
    async clickGrant() {
      if (document.byId('grantAccess').disabled) return { accepted: false, completion: Promise.resolve() };
      userActivation.isActive = true;
      const completion = document.byId('grantAccess').emit('click');
      userActivation.isActive = false;
      return { accepted: true, completion };
    },
    settlePermissionRequest(value) {
      const settlement = settleDeferredPermission;
      settleDeferredPermission = null;
      settlement?.resolve(value);
    },
    rejectPermissionRequest(error) {
      const settlement = settleDeferredPermission;
      settleDeferredPermission = null;
      settlement?.reject(error);
    },
    async dispose() {
      settleDeferredPermission = null;
      for (const listener of pagehideListeners) listener();
      await Promise.resolve();
      restoreGlobals();
    }
  };
}

function envelope(request, payload = {}) {
  return {
    protocolVersion: request.protocolVersion,
    requestId: request.requestId,
    ok: true,
    ...structuredClone(payload)
  };
}

function errorEnvelope(request, error) {
  return {
    protocolVersion: request.protocolVersion,
    requestId: request.requestId,
    ok: false,
    error: error.error,
    errorCode: error.errorCode,
    retryable: error.retryable === true
  };
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
      if (selector === '.popup-shell') return elements.get('popup-shell');
      return null;
    },
    createElement(tagName) {
      return new FakeElement(tagName, document);
    },
    byId(id) {
      return elements.get(id);
    },
    fireDomReady() {
      document.readyState = 'complete';
      return listeners.get('DOMContentLoaded')?.();
    }
  };
  document.body = new FakeElement('body', document);
  elements.set('popup-shell', new FakeElement('popup-shell', document));
  for (const id of new Set(ids)) elements.set(id, new FakeElement(id, document));
  for (const id of [
    'summaryCard',
    'normalizedCard',
    'directCleanupNotice',
    'activeTabCard',
    'reviewCard',
    'progressCard',
    'cancelActiveJob',
    'deepCleanSpinner'
  ]) {
    const element = elements.get(id);
    if (element) element.hidden = true;
  }
  return document;
}

class FakeElement {
  constructor(id, document) {
    this.id = id;
    this.ownerDocument = document;
    this.listeners = new Map();
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.style = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.required = false;
    this.value = '';
    this.textContent = '';
    this.className = '';
    this.open = false;
    this.scrollTop = 0;
  }

  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }

  async emit(type) {
    const event = {
      currentTarget: this,
      target: this,
      preventDefault() {}
    };
    for (const callback of this.listeners.get(type) || []) await callback(event);
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

  append(...children) {
    this.children = [...(this.children || []), ...children];
  }

  replaceChildren(...children) {
    this.children = children;
  }

  querySelector(selector) {
    if (selector === '.summary-details') {
      this.summaryDetails ||= new FakeElement('summary-details', this.ownerDocument);
      return this.summaryDetails;
    }
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
    if (force === undefined) force = !this.values.has(value);
    if (force) this.values.add(value);
    else this.values.delete(value);
    return force;
  }
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Timed out waiting for popup test state.');
    await wait(5);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

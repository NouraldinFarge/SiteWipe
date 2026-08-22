import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const popupUrl = new URL('../../src/popup/popup.js', import.meta.url);
const popupHtmlUrl = new URL('../../src/popup/popup.html', import.meta.url);
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
    /if \(\['completed', 'failed', 'cancelled', 'interrupted'\]\.includes\(job\.status\)\) \{[\s\S]*?popupPreparationBindings\.delete/,
    'terminal worker state must retire any surviving popup capability'
  );
  assert.match(
    source,
    /function forgetResolvedPermissionHandoffBinding[\s\S]*?\['terminal', 'released'\]\.includes[\s\S]*?popupPreparationBindings\.delete\(review\.approvalToken\);/,
    'a returned terminal or conclusively released handoff must erase the raw capability'
  );
  assert.match(
    source,
    /async function settleCleanupPermissionPrompt[\s\S]*?!retainBindingUntilReleaseProof \|\| permissionSettlementProvesRelease\(settlementResponse\)[\s\S]*?popupPreparationBindings\.delete\(review\.approvalToken\);/,
    'confirmed settlement must erase the raw capability while an unresolved replay may retain it'
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
  test(`${cleanupMode} direct cleanup waits through fresh-worker readiness and retains one final activation`, async () => {
    const harness = await createPopupHarness({
      cleanupMode,
      directCleanup: true,
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

      const firstAccepted = await harness.clickPrimary();
      const duplicateAccepted = await harness.clickPrimary();
      assert.equal(firstAccepted, true);
      assert.equal(duplicateAccepted, false, 'the first activation must synchronously lock duplicate clicks');

      await waitFor(() => harness.resumeCalls().length === 1);
      assert.equal(harness.permissionCalls().length, 1);
      assert.equal(harness.armCalls().length, 1);
      assert.equal(harness.runCalls().length, 0);
      assert.deepEqual(
        harness.activationEvents().slice(0, 3),
        ['permissions.request', 'sitewipe.armCleanupApproval', 'sitewipe.resumeArmedCleanup'],
        'the native request and non-awaited approval dispatch must both occur before the post-prompt continuation'
      );
      assert.equal(harness.armCalls()[0].payload.approval.approvalMode, 'settings_direct');
      assertPopupAuthorityBinding(harness.armCalls()[0].payload);
      assertPopupAuthorityBinding(harness.resumeCalls()[0].payload);
      assert.deepEqual(
        popupAuthorityBinding(harness.resumeCalls()[0].payload),
        popupAuthorityBinding(harness.armCalls()[0].payload),
        'arm and resume must use the exact worker-minted one-use popup authority'
      );
      const reviewedPrompt = directReview({ cleanupMode, hostPermissionsGranted: false });
      assert.equal(harness.armCalls()[0].payload.handoffNonce, reviewedPrompt.approvalHandoffNonce);
      assert.deepEqual(harness.permissionCalls()[0].payload.origins, reviewedPrompt.temporaryHostPermissionOrigins);
    } finally {
      await harness.dispose();
    }
  });
}

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
    assert.equal(harness.resumeCalls().length, 0);
    assertPopupAuthorityBinding(harness.runCalls()[0].payload);
    assert.deepEqual(popupAuthorityBinding(harness.runCalls()[0].payload), {
      popupContextId: 'opaque popup/context #test',
      popupPreparationCapability: '1'.repeat(64)
    });
  } finally {
    await harness.dispose();
  }
});

test('job events cannot retire popup authority before post-prompt terminal replay settles', async () => {
  const harness = await createPopupHarness({
    directCleanup: true,
    permissionRequestDeferred: true,
    resumeResponseDeferred: true,
    prepareResponses: [{ review: directReview({ hostPermissionsGranted: false }) }]
  });
  try {
    await waitFor(() => harness.element('deepCleanButton').disabled === false);
    const cleanup = harness.clickPrimary();
    await waitFor(() => harness.permissionCalls().length === 1 && harness.armCalls().length === 1);

    harness.emitActiveJob({
      id: 'event-before-resume-job',
      status: 'running',
      percent: 20,
      label: 'Cleanup running',
      detail: 'Synthetic worker-owned cleanup.'
    });
    harness.settlePermissionRequest(true);
    await waitFor(() => harness.resumeCalls().length === 1);
    assertPopupAuthorityBinding(harness.resumeCalls()[0].payload);

    harness.emitActiveJob({
      id: 'event-before-resume-job',
      status: 'completed',
      percent: 100,
      label: 'Cleanup finished',
      detail: 'Synthetic terminal job event before the resume response.'
    });
    assert.equal(
      harness.element('deepCleanButton').disabled,
      true,
      'a terminal storage event must not unlock a duplicate click while the correlated resume is pending'
    );
    harness.settleResumeResponse();
    await cleanup;
    await waitFor(() => harness.element('summaryCard').hidden === false);
    assert.equal(harness.resumeCalls().length, 1);
    assert.deepEqual(
      popupAuthorityBinding(harness.resumeCalls()[0].payload),
      popupAuthorityBinding(harness.armCalls()[0].payload),
      'the exact raw authority must survive both job events until terminal replay authenticates'
    );
  } finally {
    harness.settlePermissionRequest(false);
    harness.settleResumeResponse();
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
      const harness = await createPopupHarness({
        directCleanup: true,
        permissionRequestGranted: true,
        armMessageError: error,
        prepareResponses: [{ review: directReview({ hostPermissionsGranted: false }) }]
      });
      try {
        await waitFor(() => harness.element('deepCleanButton').disabled === false);
        assert.equal(await harness.clickPrimary(), true);
        await waitFor(() => harness.armCalls().length === 1);

        assert.equal(harness.permissionCalls().length, 1);
        assert.equal(harness.resumeCalls().length, 0);
        assert.equal(harness.permissionRemovalCalls().length, 0);
        assert.equal(harness.promptSettlementCalls().length, 0);
        assert.equal(harness.cancelReviewCalls().length, 0);
      } finally {
        await harness.dispose();
      }
    });
  }
});

test('a conclusive native denial settles its staged handoff even when the arm reply fails', async () => {
  const armError = Object.assign(new Error('Synthetic staged arm peer timeout.'), {
    code: 'lifecycle_not_ready',
    retryable: true
  });
  const harness = await createPopupHarness({
    directCleanup: true,
    permissionRequestGranted: false,
    armMessageError: armError,
    prepareResponses: [{ review: directReview({ hostPermissionsGranted: false }) }]
  });
  try {
    await waitFor(() => harness.element('deepCleanButton').disabled === false);
    assert.equal(await harness.clickPrimary(), true);
    await waitFor(() => harness.promptSettlementCalls().length === 1);

    assert.equal(harness.permissionCalls().length, 1);
    assert.equal(harness.armCalls().length, 1);
    assert.equal(harness.promptSettlementCalls()[0].payload.outcome, 'denied');
    assertPopupAuthorityBinding(harness.armCalls()[0].payload);
    assert.deepEqual(
      popupAuthorityBinding(harness.promptSettlementCalls()[0].payload),
      popupAuthorityBinding(harness.armCalls()[0].payload),
      'the conclusive prompt settlement must authenticate with the initiating popup capability'
    );
    assert.equal(harness.cancelReviewCalls().length, 0);
    assert.equal(harness.permissionRemovalCalls().length, 0);
    assert.equal(harness.resumeCalls().length, 0);
    assert.equal(harness.runCalls().length, 0);
  } finally {
    await harness.dispose();
  }
});

test('an asynchronously rejected native request never claims that the prompt was not started', async () => {
  const harness = await createPopupHarness({
    directCleanup: true,
    permissionRequestError: new Error('Synthetic ambiguous native request rejection.'),
    prepareResponses: [{ review: directReview({ hostPermissionsGranted: false }) }]
  });
  try {
    await waitFor(() => harness.element('deepCleanButton').disabled === false);
    assert.equal(await harness.clickPrimary(), true);
    await waitFor(() => harness.cancelReviewCalls().length === 1);

    assert.equal(harness.permissionCalls().length, 1);
    assert.equal(harness.armCalls().length, 1);
    assert.equal(harness.cancelReviewCalls()[0].payload.promptNotStarted, false);
    assertPopupAuthorityBinding(harness.cancelReviewCalls()[0].payload);
    assert.deepEqual(
      popupAuthorityBinding(harness.cancelReviewCalls()[0].payload),
      popupAuthorityBinding(harness.armCalls()[0].payload),
      'ambiguous native-request cancellation must retain the exact initiating popup authority'
    );
    assert.equal(harness.promptSettlementCalls().length, 0);
    assert.equal(harness.permissionRemovalCalls().length, 0);
    assert.equal(harness.resumeCalls().length, 0);
    assert.equal(harness.runCalls().length, 0);
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

test('a reopened armed detailed review is non-clickable and continues without a second native prompt', async () => {
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
    assert.match(harness.element('reviewApprovalError').textContent, /continue automatically/i);
    assert.equal(harness.element('approveCleanup').textContent, 'Cleanup approved — continuing');
    assert.equal(harness.element('approveCleanup').disabled, true);

    harness.element('reviewScopeAcknowledge').checked = true;
    await harness.element('reviewScopeAcknowledge').emit('change');
    assert.equal(await harness.clickApprove(), false);

    assert.equal(harness.permissionCalls().length, 0, 'reopening must not open a redundant prompt');
    assert.equal(harness.runCalls().length, 0, 'reopening must not submit the single-use token again');
    assert.equal(harness.resumeCalls().length, 0, 'worker-owned continuation does not need another popup action');
  } finally {
    await harness.dispose();
  }
});

test('expiry in a reopened armed popup revokes cleanup authority without settling another document prompt', async () => {
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
    assert.equal(
      harness.promptSettlementCalls().length,
      0,
      'a reopened popup must not claim that the initiating document prompt settled'
    );
    assert.equal(harness.permissionCalls().length, 0);
    assert.equal(harness.resumeCalls().length, 0);
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

test('review expiry during an unresolved native permission prompt releases a late grant through the worker', async () => {
  const review = detailedReview({
    hostPermissionsGranted: false,
    permissionLeaseId: 'lease-expiring-native-prompt',
    expiresAt: new Date(Date.now() + 120).toISOString()
  });
  const freshReview = detailedReview({ hostPermissionsGranted: true });
  const harness = await createPopupHarness({
    directCleanup: false,
    permissionRequestDeferred: true,
    resumeMessageError: new Error('The expired handoff has no admitted cleanup result.'),
    prepareResponses: [{ review }, { review: freshReview }]
  });
  try {
    assert.equal(await harness.clickPrimary(), true);
    await waitFor(() => harness.element('reviewCard').hidden === false);
    harness.element('reviewScopeAcknowledge').checked = true;
    await harness.element('reviewScopeAcknowledge').emit('change');

    const approvalClick = harness.clickApprove();
    await waitFor(() => harness.permissionCalls().length === 1);
    await waitFor(() => harness.element('progressTitle').textContent === 'Cleanup review expired', 1_000);

    assert.equal(harness.cancelReviewCalls().length, 1, 'expiry must revoke cleanup authority immediately');
    assert.equal(
      harness.promptSettlementCalls().length,
      0,
      'an unresolved native prompt must keep its worker-owned tombstone'
    );
    assert.equal(harness.resumeCalls().length, 0);
    assert.equal(harness.runCalls().length, 0);

    harness.settlePermissionRequest(true);
    await approvalClick;
    assert.equal(
      harness.promptSettlementCalls().length,
      1,
      'the initiating popup must tell the worker that the expired native prompt settled'
    );
    assert.equal(harness.promptSettlementCalls()[0].payload.outcome, 'abandoned');
    assert.equal(harness.promptSettlementCalls()[0].payload.permissionLeaseId, review.permissionLeaseId);
    assert.equal(
      harness.permissionRemovalCalls().length,
      0,
      'the popup must leave exact revocation to the worker rather than mutating permissions itself'
    );
    assert.equal(harness.resumeCalls().length, 1, 'the nonce-bound outcome must be checked before claiming no cleanup');
    assert.equal(harness.runCalls().length, 0);
    assert.equal(harness.element('progressTitle').textContent, 'Cleanup review expired');
    assert.match(harness.element('progressDetail').textContent, /released the temporary target access/i);
    assert.match(harness.element('progressDetail').textContent, /Prepare a fresh review/i);
    await wait(320);
    assert.equal(harness.element('reviewCard').hidden, true, 'the stale reviewed scope must remain hidden');
    assert.equal(harness.element('approveCleanup').disabled, true, 'the stale approval must remain non-actionable');
    assert.equal(harness.element('progressCard').hidden, false, 'the finalizer must retain the expiry outcome');
    assert.equal(harness.element('targetInput').disabled, false);
    assert.equal(harness.element('deepCleanButton').disabled, false);
    assert.equal(harness.element('deepCleanLabel').textContent, 'Review cleanup');
    assert.equal(await harness.clickApprove(), false);

    assert.equal(await harness.clickPrimary(), true, 'the composer must allow a fresh review');
    await waitFor(() => harness.prepareCalls().length === 2);
    await waitFor(() => harness.element('reviewCard').hidden === false);
    assert.equal(harness.element('approveCleanup').disabled, true);
  } finally {
    harness.settlePermissionRequest(false);
    await harness.dispose();
  }
});

test('an expired native grant still reaches worker settlement when the arm reply rejects', async () => {
  const originalDateNow = Date.now;
  const review = detailedReview({
    hostPermissionsGranted: false,
    permissionLeaseId: 'lease-expired-rejected-arm',
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
  const harness = await createPopupHarness({
    directCleanup: false,
    permissionRequestDeferred: true,
    armMessageError: new Error('This cleanup approval expired while Chrome target access was being requested.'),
    resumeMessageError: new Error('The rejected arm has no admitted cleanup result.'),
    prepareResponses: [{ review }]
  });
  try {
    assert.equal(await harness.clickPrimary(), true);
    await waitFor(() => harness.element('reviewCard').hidden === false);
    harness.element('reviewScopeAcknowledge').checked = true;
    await harness.element('reviewScopeAcknowledge').emit('change');

    const approvalClick = harness.clickApprove();
    await waitFor(() => harness.permissionCalls().length === 1);
    assert.equal(harness.element('reviewCard').hidden, false);

    Date.now = () => Date.parse(review.expiresAt) + 1;
    harness.settlePermissionRequest(true);
    await approvalClick;

    assert.equal(harness.promptSettlementCalls().length, 1);
    assert.equal(harness.promptSettlementCalls()[0].payload.outcome, 'abandoned');
    assert.equal(harness.promptSettlementCalls()[0].payload.handoffNonce, review.approvalHandoffNonce);
    assert.equal(harness.resumeCalls().length, 1);
    assert.equal(harness.runCalls().length, 0);
    assert.equal(harness.permissionRemovalCalls().length, 0);
    assert.equal(harness.element('progressTitle').textContent, 'Cleanup review expired');
    assert.match(harness.element('progressDetail').textContent, /released the temporary target access/i);
    assert.match(harness.element('progressDetail').textContent, /Prepare a fresh review/i);
    await wait(320);
    assert.equal(harness.element('reviewCard').hidden, true, 'the rejected arm must retire the stale review card');
    assert.equal(harness.element('approveCleanup').disabled, true, 'the expired approval must not be re-enabled');
    assert.equal(harness.element('progressCard').hidden, false, 'the finalizer must not hide expiry guidance');
    assert.equal(harness.element('targetInput').disabled, false);
    assert.equal(harness.element('deepCleanButton').disabled, false);
    assert.equal(harness.element('deepCleanLabel').textContent, 'Review cleanup');
    assert.equal(await harness.clickApprove(), false);
  } finally {
    Date.now = originalDateNow;
    harness.settlePermissionRequest(false);
    await harness.dispose();
  }
});

test('post-arm expiry recovers an already admitted cleanup instead of claiming that no cleanup started', async () => {
  const originalDateNow = Date.now;
  const review = detailedReview({
    hostPermissionsGranted: false,
    permissionLeaseId: 'lease-expired-after-admission',
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
  const harness = await createPopupHarness({
    directCleanup: false,
    permissionRequestDeferred: true,
    prepareResponses: [{ review }]
  });
  try {
    assert.equal(await harness.clickPrimary(), true);
    await waitFor(() => harness.element('reviewCard').hidden === false);
    harness.element('reviewScopeAcknowledge').checked = true;
    await harness.element('reviewScopeAcknowledge').emit('change');

    const approvalClick = harness.clickApprove();
    await waitFor(() => harness.permissionCalls().length === 1);
    Date.now = () => Date.parse(review.expiresAt) + 1;
    harness.settlePermissionRequest(true);
    await approvalClick;

    assert.equal(harness.resumeCalls().length, 1);
    assert.equal(harness.promptSettlementCalls().length, 0, 'an admitted cleanup must not be settled as abandoned');
    assert.equal(harness.runCalls().length, 0);
    assert.equal(harness.element('reviewCard').hidden, true);
    assert.equal(harness.element('approveCleanup').disabled, true);
    assert.equal(harness.element('summaryCard').hidden, false, 'the nonce-bound cleanup result must be rendered');
    assert.equal(harness.element('summaryTitle').textContent, 'Cleanup complete');
    assert.doesNotMatch(harness.element('progressDetail').textContent, /No cleanup started/i);
    assert.doesNotMatch(
      harness.element('progressDetail').textContent,
      /SiteWipe released the temporary target access/i
    );
    await wait(320);
    assert.equal(harness.element('summaryCard').hidden, false);
    assert.equal(harness.element('reviewCard').hidden, true);
  } finally {
    Date.now = originalDateNow;
    harness.settlePermissionRequest(false);
    await harness.dispose();
  }
});

test('unprovable post-arm expiry stays explicit and locks the composer without a no-cleanup claim', async () => {
  const originalDateNow = Date.now;
  const review = detailedReview({
    hostPermissionsGranted: false,
    permissionLeaseId: 'lease-expired-unknown-outcome',
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  });
  const harness = await createPopupHarness({
    directCleanup: false,
    permissionRequestDeferred: true,
    resumeResponse: {
      approvalHandoffNonce: review.approvalHandoffNonce,
      approvalHandoffPending: true,
      approvalHandoffUncertain: true,
      cleanupStarted: null,
      temporaryAccessReleased: null,
      warning: 'Synthetic nonce-bound outcome gap.'
    },
    promptSettlementResponse: {
      released: true,
      accessRemains: false
    },
    prepareResponses: [{ review }]
  });
  try {
    assert.equal(await harness.clickPrimary(), true);
    await waitFor(() => harness.element('reviewCard').hidden === false);
    harness.element('reviewScopeAcknowledge').checked = true;
    await harness.element('reviewScopeAcknowledge').emit('change');

    const approvalClick = harness.clickApprove();
    await waitFor(() => harness.permissionCalls().length === 1);
    Date.now = () => Date.parse(review.expiresAt) + 1;
    harness.settlePermissionRequest(true);
    await approvalClick;
    await wait(320);

    assert.equal(harness.resumeCalls().length, 1);
    assert.equal(harness.promptSettlementCalls().length, 1);
    assert.equal(harness.runCalls().length, 0);
    assert.equal(harness.element('reviewCard').hidden, true);
    assert.equal(harness.element('approveCleanup').disabled, true);
    assert.equal(harness.element('progressCard').hidden, false);
    assert.equal(harness.element('progressTitle').textContent, 'Cleanup status needs verification');
    assert.match(harness.element('progressDetail').textContent, /could not prove whether this cleanup started/i);
    assert.match(harness.element('progressDetail').textContent, /current job or report/i);
    assert.match(harness.element('progressDetail').textContent, /Options/i);
    assert.doesNotMatch(harness.element('progressDetail').textContent, /No cleanup started/i);
    assert.doesNotMatch(
      harness.element('progressDetail').textContent,
      /SiteWipe released the temporary target access/i
    );
    assert.equal(harness.element('targetInput').disabled, true);
    assert.equal(harness.element('deepCleanButton').disabled, true);
    assert.equal(await harness.clickPrimary(), false);
    assert.deepEqual(
      harness.consumePagehidePopupBindingTokens(),
      [review.approvalToken],
      'an incomplete successful settlement must retain the raw nonce-replay capability until popup teardown'
    );
  } finally {
    Date.now = originalDateNow;
    harness.settlePermissionRequest(false);
    await harness.dispose();
  }
});

test('ordinary post-prompt resume renders a matching admitted running job and keeps cleanup locked', async () => {
  const review = detailedReview({
    hostPermissionsGranted: false,
    permissionLeaseId: 'lease-normal-running-replay'
  });
  const activeJob = {
    id: 'running-handoff-job',
    status: 'running',
    admissionPhase: 'admitted',
    approvalHandoffNonce: review.approvalHandoffNonce,
    percent: 42,
    label: 'Nonce-bound cleanup is running',
    detail: 'The worker admitted this exact reviewed cleanup.',
    cancelRequested: false
  };
  const harness = await createPopupHarness({
    directCleanup: false,
    resumeResponse: {
      approvalHandoffNonce: review.approvalHandoffNonce,
      approvalHandoffPending: false,
      approvalHandoffRunning: true,
      cleanupStarted: true,
      temporaryAccessReleased: false,
      activeJob
    },
    prepareResponses: [{ review }]
  });
  try {
    assert.equal(await harness.clickPrimary(), true);
    await waitFor(() => harness.element('reviewCard').hidden === false);
    harness.element('reviewScopeAcknowledge').checked = true;
    await harness.element('reviewScopeAcknowledge').emit('change');
    assert.equal(await harness.clickApprove(), true);
    await wait(320);

    assert.equal(harness.resumeCalls().length, 1);
    assert.equal(harness.promptSettlementCalls().length, 0);
    assert.equal(harness.runCalls().length, 0);
    assert.equal(harness.element('reviewCard').hidden, true);
    assert.equal(harness.element('summaryCard').hidden, true);
    assert.equal(harness.element('progressCard').hidden, false);
    assert.equal(harness.element('progressTitle').textContent, activeJob.label);
    assert.equal(harness.element('progressDetail').textContent, activeJob.detail);
    assert.doesNotMatch(harness.element('progressDetail').textContent, /No cleanup started/i);
    assert.equal(harness.element('targetInput').disabled, true);
    assert.equal(harness.element('deepCleanButton').disabled, true);
  } finally {
    await harness.dispose();
  }
});

test('ordinary post-prompt uncertainty remains visible and locked after the finalizer', async () => {
  const review = detailedReview({
    hostPermissionsGranted: false,
    permissionLeaseId: 'lease-normal-unknown-replay'
  });
  const harness = await createPopupHarness({
    directCleanup: false,
    resumeResponse: {
      approvalHandoffNonce: review.approvalHandoffNonce,
      approvalHandoffPending: true,
      approvalHandoffUncertain: true,
      cleanupStarted: null,
      temporaryAccessReleased: null,
      warning: 'Synthetic ordinary nonce-bound outcome gap.'
    },
    prepareResponses: [{ review }]
  });
  try {
    assert.equal(await harness.clickPrimary(), true);
    await waitFor(() => harness.element('reviewCard').hidden === false);
    harness.element('reviewScopeAcknowledge').checked = true;
    await harness.element('reviewScopeAcknowledge').emit('change');
    assert.equal(await harness.clickApprove(), true);
    await wait(320);

    assert.equal(harness.resumeCalls().length, 1);
    assert.equal(harness.promptSettlementCalls().length, 0);
    assert.equal(harness.runCalls().length, 0);
    assert.equal(harness.element('reviewCard').hidden, true);
    assert.equal(harness.element('summaryCard').hidden, true);
    assert.equal(harness.element('progressCard').hidden, false);
    assert.equal(harness.element('progressTitle').textContent, 'Cleanup status needs verification');
    assert.match(harness.element('progressDetail').textContent, /could not prove whether this cleanup started/i);
    assert.match(harness.element('progressDetail').textContent, /current job or report/i);
    assert.doesNotMatch(harness.element('progressDetail').textContent, /No cleanup started/i);
    assert.doesNotMatch(
      harness.element('progressDetail').textContent,
      /SiteWipe released the temporary target access/i
    );
    assert.equal(harness.element('targetInput').disabled, true);
    assert.equal(harness.element('deepCleanButton').disabled, true);
    assert.equal(await harness.clickPrimary(), false);
  } finally {
    await harness.dispose();
  }
});

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
  let settleDeferredPermission = null;
  let settleDeferredPreparation = null;
  let settleDeferredResume = null;
  let trackingActivation = false;
  let preparationSequence = 0;
  let currentWindow = { id: 7, incognito: false };
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
        if (
          trackingActivation &&
          ['sitewipe.armCleanupApproval', 'sitewipe.runDeepClean', 'sitewipe.resumeArmedCleanup'].includes(request.type)
        ) {
          activationEvents.push(request.type);
        }
        if (request.type === 'sitewipe.getPopupState') {
          return envelope(request, {
            settings: structuredClone(settings),
            report: options.storedReport ? structuredClone(options.storedReport) : null,
            incognitoAccess: true,
            activeJob: null
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
          return envelope(request, {
            approvalArmed: true,
            handoffNonce: request.payload.handoffNonce,
            expiresAt: new Date(Date.now() + 60_000).toISOString()
          });
        }
        if (request.type === 'sitewipe.settleCleanupPermissionPrompt') {
          if (options.promptSettlementMessageError) throw options.promptSettlementMessageError;
          return envelope(request, {
            settlement: options.promptSettlementResponse || {
              released: true,
              accessRemains: false,
              recordRetained: false
            }
          });
        }
        if (['sitewipe.runDeepClean', 'sitewipe.resumeArmedCleanup'].includes(request.type)) {
          if (request.type === 'sitewipe.resumeArmedCleanup' && options.resumeMessageError) {
            throw options.resumeMessageError;
          }
          if (request.type === 'sitewipe.resumeArmedCleanup' && options.resumeResponse) {
            return envelope(request, options.resumeResponse);
          }
          const terminalResponse = {
            ...(request.type === 'sitewipe.resumeArmedCleanup'
              ? {
                  approvalHandoffNonce: request.payload.handoffNonce,
                  resumedCompletedResult: true,
                  resumedTerminalResult: true
                }
              : {}),
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
          if (request.type === 'sitewipe.resumeArmedCleanup' && options.resumeResponseDeferred) {
            return new Promise((resolve) => {
              settleDeferredResume = () => resolve(envelope(request, terminalResponse));
            });
          }
          return envelope(request, terminalResponse);
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
      request: (request) => {
        calls.push({ type: 'permissions.request', payload: structuredClone(request) });
        if (trackingActivation) activationEvents.push('permissions.request');
        if (options.permissionRequestDeferred) {
          return new Promise((resolve) => {
            settleDeferredPermission = resolve;
          });
        }
        if (options.permissionRequestError) return Promise.reject(options.permissionRequestError);
        return Promise.resolve(options.permissionRequestGranted !== false);
      },
      contains: async () => false,
      remove: async (request) => {
        calls.push({ type: 'permissions.remove', payload: structuredClone(request) });
        return true;
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
    prepareCalls: () => calls.filter((call) => call.type === 'sitewipe.prepareCleanupReview'),
    sidePanelBindingCalls: () => calls.filter((call) => call.type === 'sitewipe.openSidePanel'),
    sidePanelOpenCalls: () => calls.filter((call) => call.type === 'sidePanel.open'),
    callIndex: (type) => calls.findIndex((call) => call.type === type),
    permissionCalls: () => calls.filter((call) => call.type === 'permissions.request'),
    armCalls: () => calls.filter((call) => call.type === 'sitewipe.armCleanupApproval'),
    resumeCalls: () => calls.filter((call) => call.type === 'sitewipe.resumeArmedCleanup'),
    runCalls: () => calls.filter((call) => call.type === 'sitewipe.runDeepClean'),
    cancelReviewCalls: () => calls.filter((call) => call.type === 'sitewipe.cancelCleanupReview'),
    promptSettlementCalls: () => calls.filter((call) => call.type === 'sitewipe.settleCleanupPermissionPrompt'),
    permissionRemovalCalls: () => calls.filter((call) => call.type === 'permissions.remove'),
    optionsCalls: () => calls.filter((call) => call.type === 'runtime.openOptionsPage'),
    mutationCalls: () => calls.filter((call) => ['permissions.request', 'sitewipe.runDeepClean'].includes(call.type)),
    activationEvents: () => [...activationEvents],
    consumePagehidePopupBindingTokens() {
      const bindingTokens = [];
      const originalMapClear = Map.prototype.clear;
      Map.prototype.clear = function clearTrackedPopupBindingMap() {
        bindingTokens.push(...this.keys());
        return originalMapClear.call(this);
      };
      try {
        for (const listener of pagehideListeners) listener();
        pagehideListeners.length = 0;
      } finally {
        Map.prototype.clear = originalMapClear;
      }
      return bindingTokens;
    },
    async clickPrimary() {
      if (document.byId('deepCleanButton').disabled) return false;
      trackingActivation = true;
      userActivation.isActive = true;
      const emission = document.byId('targetForm').emit('submit');
      userActivation.isActive = false;
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
      trackingActivation = true;
      userActivation.isActive = true;
      const emission = document.byId('approveCleanup').emit('click');
      userActivation.isActive = false;
      await emission;
      return true;
    },
    async clickOptions() {
      if (document.byId('openOptions').disabled) return false;
      await document.byId('openOptions').emit('click');
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
    emitActiveJob(job) {
      for (const listener of settingsListeners) {
        listener(
          {
            'sitewipe.activeJob.v1': {
              newValue: structuredClone(job)
            }
          },
          'local'
        );
      }
    },
    setCurrentWindow(nextWindow) {
      currentWindow = structuredClone(nextWindow);
    },
    settlePermissionRequest(granted) {
      const settle = settleDeferredPermission;
      settleDeferredPermission = null;
      settle?.(granted === true);
    },
    settlePreparation() {
      const settle = settleDeferredPreparation;
      settleDeferredPreparation = null;
      settle?.();
    },
    settleResumeResponse() {
      const settle = settleDeferredResume;
      settleDeferredResume = null;
      settle?.();
    },
    async dispose() {
      for (const listener of pagehideListeners) listener();
      await wait(380);
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
    elements.get(id).hidden = true;
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

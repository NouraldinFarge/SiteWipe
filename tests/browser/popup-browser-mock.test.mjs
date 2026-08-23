import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const popupMockSource = await readFile(new URL('./fixtures/popup-browser-mock.js', import.meta.url), 'utf8');

test('popup fixture models the exact two-activation, four-proof permission handoff', async () => {
  const fixture = loadPopupFixture('?mode=standard');
  const prepared = await fixture.send('sitewipe.prepareCleanupReview');

  assert.match(prepared.review.approvalToken, /^[a-f0-9]{48}$/);
  assert.match(prepared.popupPreparationCapability, /^[a-f0-9]{64}$/);
  assert.equal(prepared.review.settingsSnapshot.cleanupMode, 'standard');
  assert.equal(prepared.review.associatedTargets.length, 0);
  assert.equal(prepared.review.requirements.downloadedFiles, false);
  assert.equal(prepared.review.hostPermissionsGranted, false);
  assert.equal(prepared.review.hostPermissionInventory.allSitesAccessGranted, false);
  assert.equal(prepared.review.hostPermissionInventory.grantedHostPermissionOrigins.length, 0);
  assert.match(prepared.review.approvalHandoffNonce, /^[a-f0-9]{48}$/);
  assert.equal(Date.parse(prepared.review.expiresAt) - Date.parse(prepared.review.createdAt), 5 * 60 * 1000);

  const approval = completeApproval();
  const armed = await fixture.send('sitewipe.armCleanupApproval', {
    approvalToken: prepared.review.approvalToken,
    handoffNonce: prepared.review.approvalHandoffNonce,
    approval
  });

  assert.equal(armed.approvalArmed, true);
  assert.equal(armed.handoffStatus, 'armed');
  assert.equal(armed.handoffNonce, prepared.review.approvalHandoffNonce);
  assert.equal(fixture.state.permissionRequests.length, 0);

  const activation = await runPermissionActivation(fixture, prepared);
  assert.equal(activation.intent.promptIntentRecorded, true);
  assert.deepEqual([...activation.snapshot.origins], []);
  assert.equal(activation.granted, true);
  assert.equal(activation.invocation.promptInvocationRecorded, true);
  assert.equal(fixture.state.permissionRequests.length, 1);
  assert.equal(fixture.state.permissionEvents.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.state.permissionEvents[0])), {
    permissions: [],
    origins: [...prepared.review.temporaryHostPermissionOrigins]
  });
  const outcome = await fixture.send('sitewipe.confirmCleanupPermissionGrantOutcome', {
    handoffNonce: prepared.review.approvalHandoffNonce,
    preRequestTemporaryOriginsAbsent: true
  });
  assert.equal(outcome.promptGrantOutcomeRecorded, true);
  assert.equal(fixture.state.grantOutcomes, 1);
  assert.deepEqual([...fixture.state.permissionOperations].slice(0, 5), [
    'begin',
    'getAll',
    'request',
    'confirm-invocation',
    'confirm-outcome'
  ]);

  const completed = await fixture.send('sitewipe.resumeArmedCleanup', {
    handoffNonce: prepared.review.approvalHandoffNonce
  });
  assert.equal(completed.approvalHandoffNonce, prepared.review.approvalHandoffNonce);
  assert.equal(completed.report.status, 'completed');
  assert.equal(completed.report.summary.cleanupMode, 'standard');
  assert.equal(completed.report.summary.cleanupApprovalMode, 'detailed_review');
  assert.equal(completed.report.summary.verificationStatus, 'verified_zero');
  assert.equal(fixture.state.approvedRuns, 1);
  assert.equal(fixture.state.permissionRemovals.length, 1);
  assert.deepEqual([...fixture.state.grantedOrigins], []);
  assert.equal(fixture.root.dataset.fixtureArmAttempts, '1');
  assert.equal(fixture.root.dataset.fixtureResumeAttempts, '1');
  assert.equal(fixture.root.dataset.fixturePromptIntents, '1');
  assert.equal(fixture.root.dataset.fixturePromptInvocations, '1');
  assert.equal(fixture.root.dataset.fixtureGrantOutcomes, '1');
  assert.equal(fixture.root.dataset.fixtureCleanupMode, 'standard');
});

test('popup fixture releases a fully proved grant after review expiry but never completes cleanup', async () => {
  const fixture = loadPopupFixture('?mode=standard&permission=expire-after-grant');
  const prepared = await fixture.send('sitewipe.prepareCleanupReview');
  const armed = await fixture.send('sitewipe.armCleanupApproval', {
    approvalToken: prepared.review.approvalToken,
    handoffNonce: prepared.review.approvalHandoffNonce,
    approval: completeApproval()
  });

  assert.equal(armed.approvalArmed, true);
  const activation = await runPermissionActivation(fixture, prepared);
  assert.equal(activation.granted, true);
  assert.equal(activation.invocation.promptInvocationRecorded, true);
  assert.equal(activation.invocation.authorityRevoked, true);
  assert.ok(Date.parse(prepared.review.expiresAt) < Date.now());

  const settled = await fixture.send('sitewipe.confirmCleanupPermissionGrantOutcome', {
    handoffNonce: prepared.review.approvalHandoffNonce,
    preRequestTemporaryOriginsAbsent: true
  });
  assert.equal(settled.promptGrantOutcomeRecorded, true);
  assert.equal(settled.cleanupStarted, false);
  assert.equal(settled.temporaryAccessReleased, true);
  assert.equal(settled.settlement.released, true);
  assert.equal(settled.settlement.accessRemains, false);
  assert.equal(settled.settlement.recordRetained, false);
  assert.equal(fixture.state.promptSettlements.length, 0);
  assert.equal(fixture.state.permissionRemovals.length, 1);
  assert.deepEqual([...fixture.state.grantedOrigins], []);
  assert.equal(fixture.state.approvedRuns, 0);
  assert.equal(fixture.root.dataset.fixturePromptIntents, '1');
  assert.equal(fixture.root.dataset.fixturePromptInvocations, '1');
  assert.equal(fixture.root.dataset.fixtureGrantOutcomes, '1');
  assert.equal(fixture.root.dataset.fixturePromptSettlements, '0');
  assert.equal(fixture.root.dataset.fixturePermissionRemovals, '1');
  assert.equal(fixture.root.dataset.fixtureExpireAfterNativeGrant, 'true');

  await assert.rejects(
    fixture.send('sitewipe.resumeArmedCleanup', {
      handoffNonce: prepared.review.approvalHandoffNonce
    }),
    /refused to resume an expired cleanup review/i
  );
  assert.equal(fixture.state.approvedRuns, 0);
});

test('popup fixture denial records no event or outcome and preserves browser access', async () => {
  const fixture = loadPopupFixture('?mode=standard&permission=deny');
  const prepared = await fixture.send('sitewipe.prepareCleanupReview');
  await fixture.send('sitewipe.armCleanupApproval', {
    approvalToken: prepared.review.approvalToken,
    handoffNonce: prepared.review.approvalHandoffNonce,
    approval: completeApproval()
  });
  const activation = await runPermissionActivation(fixture, prepared);
  assert.equal(activation.granted, false);
  assert.equal(activation.invocation.promptInvocationRecorded, true);
  assert.equal(fixture.state.permissionEvents.length, 0);
  assert.equal(fixture.state.grantOutcomes, 0);
  const settled = await fixture.send('sitewipe.settleCleanupPermissionPrompt', {
    approvalToken: prepared.review.approvalToken,
    handoffNonce: prepared.review.approvalHandoffNonce,
    permissionLeaseId: prepared.review.permissionLeaseId,
    outcome: 'denied'
  });
  assert.equal(settled.settlement.permissionsPreserved, true);
  assert.equal(settled.settlement.released, false);
  assert.equal(fixture.state.permissionRemovals.length, 0);
  assert.equal(fixture.state.approvedRuns, 0);
});

test('popup fixture rejects a true result composed with pre-existing broad access', async () => {
  const fixture = loadPopupFixture('?mode=standard');
  const prepared = await fixture.send('sitewipe.prepareCleanupReview');
  await fixture.send('sitewipe.armCleanupApproval', {
    approvalToken: prepared.review.approvalToken,
    handoffNonce: prepared.review.approvalHandoffNonce,
    approval: completeApproval()
  });
  fixture.fixture.grantExternally(['<all_urls>']);
  const activation = await runPermissionActivation(fixture, prepared);
  assert.equal(activation.granted, true);
  assert.deepEqual([...activation.snapshot.origins], ['<all_urls>']);
  assert.equal(fixture.state.permissionEvents.length, 1, 'only the external broad grant event is recorded');
  assert.equal(fixture.state.grantOutcomes, 0);
  const settled = await fixture.send('sitewipe.settleCleanupPermissionPrompt', {
    approvalToken: prepared.review.approvalToken,
    handoffNonce: prepared.review.approvalHandoffNonce,
    permissionLeaseId: prepared.review.permissionLeaseId,
    outcome: 'abandoned'
  });
  assert.equal(settled.settlement.permissionsPreserved, true);
  assert.deepEqual([...fixture.state.grantedOrigins], ['<all_urls>']);
  assert.equal(fixture.state.permissionRemovals.length, 0);
  assert.equal(fixture.state.approvedRuns, 0);
});

test('popup fixture treats scheme-specific and wildcard-scheme host patterns as pre-request coverage', async (t) => {
  const cases = [
    {
      pattern: 'https://*.blogspot.com/*',
      coveredOrigins: ['https://alice.blogspot.com/*', 'https://*.alice.blogspot.com/*'],
      newlyGrantedOrigins: ['http://alice.blogspot.com/*', 'http://*.alice.blogspot.com/*']
    },
    {
      pattern: '*://*.blogspot.com/*',
      coveredOrigins: [
        'http://alice.blogspot.com/*',
        'https://alice.blogspot.com/*',
        'http://*.alice.blogspot.com/*',
        'https://*.alice.blogspot.com/*'
      ],
      newlyGrantedOrigins: []
    }
  ];

  for (const { pattern, coveredOrigins, newlyGrantedOrigins } of cases) {
    await t.test(pattern, async () => {
      const fixture = loadPopupFixture('?mode=standard');
      const prepared = await fixture.send('sitewipe.prepareCleanupReview');
      await fixture.send('sitewipe.armCleanupApproval', {
        approvalToken: prepared.review.approvalToken,
        handoffNonce: prepared.review.approvalHandoffNonce,
        approval: completeApproval()
      });
      fixture.fixture.grantExternally([pattern]);

      assert.equal(await fixture.context.chrome.permissions.contains({ origins: coveredOrigins }), true);
      const activation = await runPermissionActivation(fixture, prepared);
      assert.equal(activation.granted, true);
      assert.deepEqual([...activation.snapshot.origins], [pattern]);
      assert.equal(fixture.state.armedApproval.preRequestTemporaryOriginsAbsent, false);
      assert.deepEqual(
        [...fixture.state.grantedOrigins],
        [pattern, ...newlyGrantedOrigins],
        'the synthetic request must add only reviewed origins not already covered by the broad pattern'
      );
      assert.equal(
        fixture.state.permissionEvents.length,
        1,
        'a partial or fully precovered request must not fabricate the exact complete prompt-owned onAdded event'
      );
      await assert.rejects(
        fixture.send('sitewipe.confirmCleanupPermissionGrantOutcome', {
          handoffNonce: prepared.review.approvalHandoffNonce,
          preRequestTemporaryOriginsAbsent: true
        }),
        /without the exact literal-true request proof/i
      );

      const settled = await fixture.send('sitewipe.settleCleanupPermissionPrompt', {
        approvalToken: prepared.review.approvalToken,
        handoffNonce: prepared.review.approvalHandoffNonce,
        permissionLeaseId: prepared.review.permissionLeaseId,
        outcome: 'abandoned'
      });
      assert.equal(settled.settlement.permissionsPreserved, true);
      assert.equal(fixture.state.permissionRemovals.length, 0);
      assert.deepEqual([...fixture.state.grantedOrigins], [pattern, ...newlyGrantedOrigins]);
      assert.equal(fixture.state.approvedRuns, 0);
    });
  }
});

test('popup-loss fixture cannot resume from event and invocation proof without the literal-true outcome marker', async () => {
  const fixture = loadPopupFixture('?mode=standard');
  const prepared = await fixture.send('sitewipe.prepareCleanupReview');
  await fixture.send('sitewipe.armCleanupApproval', {
    approvalToken: prepared.review.approvalToken,
    handoffNonce: prepared.review.approvalHandoffNonce,
    approval: completeApproval()
  });
  const activation = await runPermissionActivation(fixture, prepared);
  assert.equal(activation.granted, true);
  assert.equal(fixture.state.permissionEvents.length, 1);
  await assert.rejects(
    fixture.send('sitewipe.resumeArmedCleanup', {
      handoffNonce: prepared.review.approvalHandoffNonce
    }),
    /complete independent permission proof/i
  );
  assert.equal(fixture.state.approvedRuns, 0);
  assert.equal(fixture.state.permissionRemovals.length, 0);
  assert.deepEqual([...fixture.state.grantedOrigins], [...prepared.review.temporaryHostPermissionOrigins]);
  const settlement = await fixture.send('sitewipe.settleCleanupPermissionPrompt', {
    approvalToken: prepared.review.approvalToken,
    handoffNonce: prepared.review.approvalHandoffNonce,
    permissionLeaseId: prepared.review.permissionLeaseId,
    outcome: 'abandoned'
  });
  assert.equal(settlement.settlement.permissionsPreserved, true);
  assert.deepEqual([...fixture.state.grantedOrigins], [...prepared.review.temporaryHostPermissionOrigins]);
});

async function runPermissionActivation(fixture, prepared) {
  const intentPromise = fixture.send('sitewipe.beginCleanupPermissionPrompt', {
    handoffNonce: prepared.review.approvalHandoffNonce
  });
  const snapshotPromise = fixture.context.chrome.permissions.getAll();
  const permissionPromise = fixture.context.chrome.permissions.request({
    origins: prepared.review.temporaryHostPermissionOrigins
  });
  const invocationPromise = fixture.send('sitewipe.confirmCleanupPermissionPromptInvocation', {
    handoffNonce: prepared.review.approvalHandoffNonce
  });
  const [intent, snapshot, granted, invocation] = await Promise.all([
    intentPromise,
    snapshotPromise,
    permissionPromise,
    invocationPromise
  ]);
  return { intent, snapshot, granted, invocation };
}

function completeApproval() {
  return {
    approvalMode: 'detailed_review',
    reviewedScope: true,
    associatedTargets: false,
    localOrIpTarget: false,
    protectedWebOrigins: false,
    fileConfirmationText: ''
  };
}

function loadPopupFixture(search) {
  const root = { dataset: {}, style: {} };
  const body = {
    style: {},
    append() {}
  };
  const context = vm.createContext({
    URL,
    URLSearchParams,
    Date,
    clearTimeout,
    console,
    document: {
      body,
      documentElement: root,
      createElement() {
        return {
          style: {},
          addEventListener() {},
          setAttribute() {}
        };
      }
    },
    innerHeight: 600,
    innerWidth: 380,
    location: {
      href: `http://127.0.0.1:43819/popup/popup.html${search}`,
      search
    },
    navigator: { userAgent: 'SiteWipe synthetic fixture contract test' },
    setTimeout,
    structuredClone
  });
  vm.runInContext(popupMockSource, context, { filename: 'popup-browser-mock.js' });
  let requestSequence = 0;
  return {
    context,
    root,
    fixture: context.__sitewipeBrowserFixture,
    state: context.__sitewipeBrowserFixture.state,
    send(type, payload = {}) {
      requestSequence += 1;
      return context.chrome.runtime.sendMessage({
        protocolVersion: 1,
        requestId: `fixture-contract-${requestSequence}`,
        type,
        payload
      });
    }
  };
}

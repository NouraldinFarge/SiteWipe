import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const popupMockSource = await readFile(new URL('./fixtures/popup-browser-mock.js', import.meta.url), 'utf8');

test('popup fixture completes the missing-permission handoff as a Standard reviewed cleanup', async () => {
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
  assert.match(prepared.review.approvalHandoffNonce, /^[a-f0-9]{64}$/);
  assert.equal(Date.parse(prepared.review.expiresAt) - Date.parse(prepared.review.createdAt), 5 * 60 * 1000);

  const permissionResult = fixture.context.chrome.permissions.request({
    origins: prepared.review.temporaryHostPermissionOrigins
  });
  const approval = {
    approvalMode: 'detailed_review',
    reviewedScope: true,
    associatedTargets: false,
    localOrIpTarget: false,
    protectedWebOrigins: false,
    fileConfirmationText: ''
  };
  const armed = await fixture.send('sitewipe.armCleanupApproval', {
    approvalToken: prepared.review.approvalToken,
    handoffNonce: prepared.review.approvalHandoffNonce,
    approval
  });

  assert.equal(await permissionResult, true);
  assert.equal(armed.handoffNonce, prepared.review.approvalHandoffNonce);

  const completed = await fixture.send('sitewipe.resumeArmedCleanup', {
    handoffNonce: prepared.review.approvalHandoffNonce
  });
  assert.equal(completed.approvalHandoffNonce, prepared.review.approvalHandoffNonce);
  assert.equal(completed.report.status, 'completed');
  assert.equal(completed.report.summary.cleanupMode, 'standard');
  assert.equal(completed.report.summary.cleanupApprovalMode, 'detailed_review');
  assert.equal(completed.report.summary.verificationStatus, 'verified_zero');
  assert.equal(fixture.state.approvedRuns, 1);
  assert.equal(fixture.root.dataset.fixtureArmAttempts, '1');
  assert.equal(fixture.root.dataset.fixtureResumeAttempts, '1');
  assert.equal(fixture.root.dataset.fixtureCleanupMode, 'standard');
});

test('popup fixture makes a granted prompt expire before a rejected arm settles and never completes cleanup', async () => {
  const fixture = loadPopupFixture('?mode=standard&permission=expire-after-grant');
  const prepared = await fixture.send('sitewipe.prepareCleanupReview');
  const permissionResult = fixture.context.chrome.permissions.request({
    origins: prepared.review.temporaryHostPermissionOrigins
  });
  const armResult = fixture.send('sitewipe.armCleanupApproval', {
    approvalToken: prepared.review.approvalToken,
    handoffNonce: prepared.review.approvalHandoffNonce,
    approval: {
      approvalMode: 'detailed_review',
      reviewedScope: true,
      associatedTargets: false,
      localOrIpTarget: false,
      protectedWebOrigins: false,
      fileConfirmationText: ''
    }
  });

  await assert.rejects(armResult, /expired while target access was being requested/i);
  assert.equal(await permissionResult, true);
  assert.ok(Date.parse(prepared.review.expiresAt) < Date.now());

  const settled = await fixture.send('sitewipe.settleCleanupPermissionPrompt', {
    approvalToken: prepared.review.approvalToken,
    handoffNonce: prepared.review.approvalHandoffNonce,
    permissionLeaseId: prepared.review.permissionLeaseId,
    outcome: 'abandoned'
  });
  assert.equal(settled.settlement.released, true);
  assert.equal(settled.settlement.accessRemains, false);
  assert.equal(settled.settlement.recordRetained, false);
  assert.equal(fixture.state.promptSettlements.length, 1);
  assert.equal(fixture.state.promptSettlements[0].outcome, 'abandoned');
  assert.equal(fixture.state.permissionRemovals.length, 0);
  assert.equal(fixture.state.approvedRuns, 0);
  assert.equal(fixture.root.dataset.fixtureArmRejections, '1');
  assert.equal(fixture.root.dataset.fixturePromptSettlements, '1');
  assert.equal(fixture.root.dataset.fixturePermissionRemovals, '0');
  assert.equal(fixture.root.dataset.fixtureExpireAfterNativeGrant, 'true');

  await assert.rejects(
    fixture.send('sitewipe.resumeArmedCleanup', {
      handoffNonce: prepared.review.approvalHandoffNonce
    }),
    /refused to resume an expired cleanup review/i
  );
  assert.equal(fixture.state.approvedRuns, 0);
});

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

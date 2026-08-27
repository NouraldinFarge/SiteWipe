(() => {
  const fixtureParameters = new URLSearchParams(location.search);
  const outcome = fixtureParameters.get('outcome') || 'complete';
  const state = {
    messages: [],
    permissionSnapshots: 0,
    permissionRequests: 0,
    settlements: [],
    cleanupConfirmations: 0
  };
  const reviewedOrigins = [
    'http://*.example.com/*',
    'http://example.com/*',
    'https://*.example.com/*',
    'https://example.com/*'
  ];
  const syncEvidence = () => {
    document.documentElement.dataset.fixtureHandoffOutcome = outcome;
    document.documentElement.dataset.fixtureHandoffMessages = state.messages.join(',');
    document.documentElement.dataset.fixtureHandoffPermissionSnapshots = String(state.permissionSnapshots);
    document.documentElement.dataset.fixtureHandoffPermissionRequests = String(state.permissionRequests);
    document.documentElement.dataset.fixtureHandoffSettlements = state.settlements.join(',');
    document.documentElement.dataset.fixtureHandoffCleanupConfirmations = String(state.cleanupConfirmations);
  };
  const envelope = (request, payload = {}) => ({
    protocolVersion: request.protocolVersion,
    requestId: request.requestId,
    ok: true,
    ...payload
  });

  async function sendMessage(request) {
    state.messages.push(request.type);
    syncEvidence();
    switch (request.type) {
      case 'sitewipe.claimCleanupPermissionHandoff':
        if (outcome === 'claim-failure') {
          throw new Error('Synthetic fixture: this reviewed handoff is unavailable or expired.');
        }
        return envelope(request, {
          handoffClaimed: true,
          handoffNonce: 'synthetic-reviewed-handoff-000000000001',
          handoffCapability: 'a'.repeat(64),
          temporaryHostPermissionOrigins: reviewedOrigins,
          targetDisplayName: 'example.com',
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          reviewedEffects: {
            cleanupMode: 'Standard',
            approvalPath: 'Detailed review',
            windowScope: 'Matching data exposed in normal browser windows is included; private windows are excluded.',
            associatedTargetCount: 0,
            downloadedFileSummary: 'Downloaded files on disk are preserved.',
            storageSummary:
              'Browser-exposed origin storage is selected; embedded third-party partitions and hidden internals are not claimed.',
            categorySummary:
              'Matching tabs, cookies, browser-exposed origin storage, history URLs, and download-list records.',
            browserRecordSummary: 'Matching browsing-history URLs and download-list records are selected.',
            requestShieldSummary:
              'The temporary target request shield runs only where the reviewed window scope permits it.',
            progressOverlaySummary: 'A temporary progress overlay may appear in matching accessible target tabs.',
            protectedOriginSummary: 'Installed and protected web-app origins remain excluded.',
            evidenceSummary:
              'Four exposed surfaces are rechecked; incomplete checks or known residue are reported without a zero-residue claim.',
            matchingTabsClose: true
          }
        });
      case 'sitewipe.beginCleanupPermissionHandoff':
        return envelope(request, { promptIntentRecorded: true });
      case 'sitewipe.confirmCleanupPermissionHandoffInvocation':
        return envelope(request, { promptInvocationRecorded: true });
      case 'sitewipe.settleCleanupPermissionHandoff':
        state.settlements.push(String(request.payload.outcome || 'unknown'));
        syncEvidence();
        return envelope(request, {
          settlement: { released: false, accessRemains: false, recordRetained: false, permissionsPreserved: true }
        });
      case 'sitewipe.confirmCleanupPermissionHandoffGrant':
        state.cleanupConfirmations += 1;
        syncEvidence();
        if (outcome === 'reconcile') throw new Error('Synthetic fixture: confirmation response was interrupted.');
        return envelope(
          request,
          outcome === 'started'
            ? { cleanupStarted: true, approvalHandoffRunning: true }
            : { report: { id: 'synthetic-handoff-report', status: 'completed' } }
        );
      case 'sitewipe.resumeCleanupPermissionHandoff':
        return envelope(request, { resumedCompletedResult: true, report: { id: 'synthetic-resumed-report' } });
      default:
        return envelope(request);
    }
  }

  globalThis.chrome = {
    runtime: { lastError: null, sendMessage },
    permissions: {
      async getAll() {
        state.permissionSnapshots += 1;
        syncEvidence();
        return { permissions: [], origins: [] };
      },
      async request(request) {
        state.permissionRequests += 1;
        syncEvidence();
        if (JSON.stringify(request?.origins) !== JSON.stringify(reviewedOrigins)) {
          throw new Error('Synthetic fixture refused a changed permission request.');
        }
        return outcome !== 'deny';
      }
    }
  };
  syncEvidence();
})();

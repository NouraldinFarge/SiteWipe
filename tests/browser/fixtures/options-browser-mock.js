(() => {
  const fixtureParams = new URLSearchParams(globalThis.location?.search || '');
  let optionsLoadFailuresRemaining = fixtureParams.get('load') === 'fail-once' ? 1 : 0;
  const storageListeners = [];
  const state = {
    optionsLoads: 0,
    saves: 0,
    permissionRequests: 0,
    permissionContainsChecks: 0,
    permissionRemovals: 0,
    namedPermissionGranted: false,
    permissionCalls: [],
    lastPermissionRequestHadUserActivation: false,
    activeJob: null,
    settings: {
      cleanupMode: 'standard',
      keepHistory: false,
      reportRetentionDays: 7,
      latestReportRetentionMinutes: 30,
      aggressiveCookieSweep: true,
      includeProtectedWebOrigins: false,
      pageScriptScrub: true,
      storageBucketScrub: false,
      embeddedFrameDiscovery: false,
      probePartitionedCookiesWithEmbeddingSites: false,
      exhaustiveCookieStoreScan: false,
      downloadRecentFallback: false,
      broadDiscoveryFallback: false,
      verificationPass: true,
      temporaryDnrShield: true,
      progressOverlay: true,
      progressOverlayCancelButton: true,
      overlayScope: 'target_tabs',
      postWipeSessionBlock: false,
      postWipeShieldExpiresMinutes: 0,
      autoRepairOrphanedShields: true,
      resetZoom: true,
      resetMutedTabs: false,
      unpinTargetTabs: false,
      opfsScrub: false,
      serviceWorkerExtraScrub: false,
      appBadgeClear: false,
      permissionAudit: true,
      redactReports: true,
      deleteDownloadedFiles: false,
      allowLocalTargets: false,
      blockOnAssociatedGroupErrors: true,
      associatedDomainGroups: '',
      reducedMotion: false,
      highContrast: false,
      debugLog: false
    }
  };

  const syncEvidence = () => {
    document.documentElement.dataset.fixtureOptionsLoads = String(state.optionsLoads);
    document.documentElement.dataset.fixtureOptionsLoadFailuresRemaining = String(optionsLoadFailuresRemaining);
    document.documentElement.dataset.fixtureOptionsSaves = String(state.saves);
    document.documentElement.dataset.fixtureNamedPermissionRequests = String(state.permissionRequests);
    document.documentElement.dataset.fixtureNamedPermissionContains = String(state.permissionContainsChecks);
    document.documentElement.dataset.fixtureNamedPermissionRemovals = String(state.permissionRemovals);
    document.documentElement.dataset.fixtureNamedPermissionGranted = String(state.namedPermissionGranted);
    document.documentElement.dataset.fixtureNamedPermissionCallSequence = state.permissionCalls.slice(-20).join(',');
    document.documentElement.dataset.fixtureNamedPermissionRequestUserActivation = String(
      state.lastPermissionRequestHadUserActivation
    );
    document.documentElement.dataset.fixtureCleanupMode = state.settings.cleanupMode;
    document.documentElement.dataset.fixtureEmbeddedFrameDiscovery = String(state.settings.embeddedFrameDiscovery);
    document.documentElement.dataset.fixtureOverlayScope = state.settings.overlayScope;
    document.documentElement.dataset.fixtureActiveJob = state.activeJob?.status || 'none';
  };
  syncEvidence();

  const envelope = (request, payload = {}) => ({
    protocolVersion: request.protocolVersion,
    requestId: request.requestId,
    ok: true,
    ...payload
  });
  const maintenanceStatus = () => ({
    alarmsAvailable: true,
    autoRepairOrphanedShields: true,
    shieldDiagnostics: { orphanRuleIds: [] },
    temporaryHostAccess: { state: 'none', recoveryPending: false },
    alarms: [],
    activeJobAgeMs: state.activeJob ? 1_000 : null
  });

  async function sendMessage(request) {
    switch (request.type) {
      case 'sitewipe.getOptionsState':
        state.optionsLoads += 1;
        if (optionsLoadFailuresRemaining > 0) {
          optionsLoadFailuresRemaining -= 1;
          syncEvidence();
          throw new Error('Synthetic fixture: authoritative Options state is temporarily unavailable.');
        }
        syncEvidence();
        return envelope(request, {
          settings: structuredClone(state.settings),
          incognitoAccess: false,
          debugLog: [],
          activeJob: structuredClone(state.activeJob),
          activeShield: null,
          shieldDiagnostics: {
            siteWipeRuleCount: 0,
            orphanRuleIds: [],
            missingTrackedRuleIds: [],
            healthy: true
          },
          maintenanceStatus: maintenanceStatus()
        });
      case 'sitewipe.saveSettings': {
        const previousMode = state.settings.cleanupMode;
        state.settings = { ...state.settings, ...structuredClone(request.payload.settings || {}) };
        if (state.settings.cleanupMode !== 'expert' || previousMode !== 'expert') {
          state.settings.embeddedFrameDiscovery = false;
        }
        if (!state.settings.embeddedFrameDiscovery && state.namedPermissionGranted) {
          state.namedPermissionGranted = false;
          state.permissionRemovals += 1;
          state.permissionCalls.push('background-remove');
        }
        state.saves += 1;
        syncEvidence();
        return envelope(request, { settings: structuredClone(state.settings) });
      }
      case 'sitewipe.validateAssociatedGroups':
        return envelope(request, { validation: { errors: [], warnings: [], groups: [] } });
      case 'sitewipe.getActiveJob':
        return envelope(request, {
          activeJob: structuredClone(state.activeJob),
          activeShield: null,
          shieldDiagnostics: {
            siteWipeRuleCount: 0,
            orphanRuleIds: [],
            missingTrackedRuleIds: [],
            healthy: true
          }
        });
      case 'sitewipe.getMaintenanceStatus':
        return envelope(request, { maintenanceStatus: maintenanceStatus() });
      default:
        return envelope(request, {
          settings: structuredClone(state.settings),
          maintenanceStatus: maintenanceStatus()
        });
    }
  }

  globalThis.chrome = {
    runtime: { lastError: null, sendMessage },
    storage: {
      onChanged: {
        addListener(listener) {
          storageListeners.push(listener);
        }
      }
    },
    permissions: {
      async contains({ permissions = [] } = {}) {
        state.permissionContainsChecks += 1;
        state.permissionCalls.push('contains');
        syncEvidence();
        return permissions.every((permission) => permission === 'webNavigation' && state.namedPermissionGranted);
      },
      async request() {
        state.permissionRequests += 1;
        state.namedPermissionGranted = true;
        state.permissionCalls.push('request');
        state.lastPermissionRequestHadUserActivation = Boolean(navigator.userActivation?.isActive);
        syncEvidence();
        return true;
      },
      async remove() {
        state.permissionRemovals += 1;
        state.namedPermissionGranted = false;
        state.permissionCalls.push('remove');
        syncEvidence();
        return true;
      }
    }
  };

  const activeJobButton = document.createElement('button');
  activeJobButton.type = 'button';
  activeJobButton.textContent = 'Synthetic fixture: start cleanup job';
  activeJobButton.setAttribute('aria-description', 'Test-only control; it does not exist in the packaged extension.');
  activeJobButton.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:9999;font-size:12px';
  activeJobButton.addEventListener('click', () => {
    state.activeJob = {
      id: 'synthetic-running-job',
      status: 'running',
      targetDomain: '[synthetic-target]',
      percent: 25,
      label: 'Synthetic cleanup running',
      updatedAt: '2026-08-20T12:00:00.000Z'
    };
    syncEvidence();
    for (const listener of storageListeners) {
      listener({ 'sitewipe.activeJob.v1': { newValue: structuredClone(state.activeJob) } }, 'local');
    }
  });
  document.body.append(activeJobButton);
})();

(() => {
  const fixtureParameters = new URLSearchParams(location.search);
  const requestedView = fixtureParameters.get('view') || 'report';
  const requestedWidth = Number(fixtureParameters.get('width'));
  const requestedMatrixSearch = fixtureParameters.get('matrixSearch') || '';
  const requestedMatrixStatus = fixtureParameters.get('matrixStatus') || 'all';
  const verificationScenario = fixtureParameters.get('verification') || 'verified-zero';
  const emptyHistory = fixtureParameters.get('history') === 'empty';
  const storeFullDetails = fixtureParameters.get('stored') === 'full';
  const runtimeErrorOutcome = ['warning', 'runtime-error'].includes(fixtureParameters.get('outcome'));
  const storageListeners = [];
  const state = {
    clearedHistory: 0,
    optionsOpened: 0,
    reports: []
  };

  if (Number.isFinite(requestedWidth) && requestedWidth >= 220 && requestedWidth <= 700) {
    const width = `${Math.round(requestedWidth)}px`;
    document.documentElement.style.width = width;
    document.documentElement.style.maxWidth = width;
    document.body.style.width = width;
    document.body.style.maxWidth = width;
    document.documentElement.dataset.fixtureRequestedWidth = String(Math.round(requestedWidth));
  }

  const targetDomain = storeFullDetails
    ? 'synthetic-long-tenant-name.for-responsive-layout-testing.example.test'
    : '[redacted-target]';
  const report = {
    id: 'sitewipe-synthetic-sidepanel-report',
    appVersion: '1.11.46',
    status: runtimeErrorOutcome ? 'completed_with_warnings' : 'completed',
    startedAt: '2026-08-20T22:25:13.089Z',
    finishedAt: '2026-08-20T22:25:13.899Z',
    targetDomain,
    input: storeFullDetails ? 'https://synthetic.example.test/path?test=responsive' : '[redacted]',
    incognitoAccess: false,
    sourceIncognito: false,
    privateContextTouched: false,
    hostPermissionsGranted: true,
    redacted: !storeFullDetails,
    redactionProfile: storeFullDetails ? null : 'storage',
    redactedForExport: false,
    phaseTimings: {
      'cleanup-started': 0,
      'preflight-complete': 80,
      'browser-data-complete': 350,
      'verification-complete': 690,
      'cleanup-finished': 810
    },
    summary: {
      cleanupMode: 'expert',
      cleanupApprovalMode: 'settings_direct',
      cleanupConfidenceLabel: 'Partial',
      cleanupConfidenceScore: 69,
      verificationStatus: 'verified_zero',
      verificationAllRequiredChecksSucceeded: true,
      verificationNoExposedResidueFound: true,
      verificationCategories: {
        cookies: verificationEvidence('verified_zero', 0),
        tabs: verificationEvidence('verified_zero', 0),
        history: verificationEvidence('verified_zero', 0),
        downloads: verificationEvidence('verified_zero', 0)
      },
      totalDurationMs: 810,
      slowestPhase: 'cleanup-finished (460ms)',
      browserOperationEventCount: 37,
      associatedTargetsIncluded: 0,
      normalTabsClosed: 1,
      incognitoTabsClosed: 0,
      targetTabsAudited: 1,
      siteZoomStatesRead: 1,
      siteZoomStatesReset: 0,
      mutedTargetTabs: 0,
      mutedTargetTabsReset: 0,
      pinnedTargetTabs: 0,
      pinnedTargetTabsReset: 0,
      groupedTargetTabs: 0,
      discardedTargetTabs: 0,
      frozenTargetTabs: 0,
      matchingFramesDiscovered: 1,
      pageScriptFramesMatched: 1,
      pageScriptLocalStorageCleared: 5,
      pageScriptSessionStorageCleared: 4,
      pageScriptIndexedDBDeleted: 0,
      pageScriptCachesDeleted: 0,
      pageScriptServiceWorkersUnregistered: 1,
      pageScriptPushSubscriptionsUnsubscribed: 0,
      pageScriptBackgroundSyncTagsObserved: 0,
      pageScriptPeriodicSyncTagsUnregistered: 0,
      pageScriptStorageBucketsDeleted: 0,
      pageScriptOPFSEntriesDeleted: 0,
      pageScriptAppBadgeCleared: 1,
      pageScriptPersistentStorageBefore: false,
      pageScriptStorageEstimateBeforeUsage: 7586,
      pageScriptStorageEstimateAfterUsage: 2468,
      pageScriptCookiesExpired: 10,
      pageScriptWorldsAttempted: 'ISOLATED, MAIN',
      cookiesRemoved: 11,
      discoveredOrigins: 4,
      discoveredCookieHosts: 2,
      partitionTopLevelSitesProbed: 0,
      partitionedCookiesAttempted: 0,
      partitionedCookiesRemoved: 0,
      browserCookieSweepAttempted: true,
      browserCookieSweepSucceeded: true,
      storageCleanupAttempted: true,
      cacheCleanupAttempted: true,
      originStorageTypesSucceeded: 2,
      originStorageTypesFailed: 0,
      protectedWebCleanupAttempted: false,
      serviceWorkersCleared: true,
      historyEntriesRemoved: 2,
      downloadHistoryEntriesRemoved: 0,
      downloadedFilesRemoved: 0,
      downloadedFileRemovalFailures: 0,
      sitePermissionSettingsPreserved: true,
      protectedBrowserDataGuardActive: true,
      extensionStatePreflightRan: true,
      extensionStateRepaired: false,
      temporaryDnrShieldInstalled: false,
      temporaryDnrShieldSkippedForNormalOnlyReview: true,
      progressOverlayEnabled: true,
      progressOverlayTabsShown: 1,
      progressOverlayTabsHidden: 0,
      progressOverlayCancelButtonEnabled: true,
      progressOverlayInjectionErrors: 2,
      verificationCookiesRemaining: 0,
      verificationTabsRemaining: 0,
      verificationHistoryRemaining: 0,
      verificationDownloadsRemaining: 0,
      verificationRemainingTotal: 0,
      hostAccessMode: 'pre_existing_broad_access',
      targetSiteAccessGranted: true,
      exactRequiredHostPermissionOriginsGranted: 0,
      broadHostPermissionOriginsGranted: 2,
      allSitesAccessGranted: true
    },
    errors: runtimeErrorOutcome
      ? [
          {
            key: 'syntheticRuntimeWarning',
            label: 'Synthetic runtime warning',
            message:
              'A synthetic fixture phase reported a recoverable warning. This is intentionally long to verify narrow-panel wrapping.'
          }
        ]
      : [],
    skipped: [
      {
        key: 'passwords',
        label: 'Saved passwords and credentials',
        reason: 'Protected browser data is never included in SiteWipe cleanup.'
      },
      {
        key: 'downloadedFiles',
        label: 'Downloaded files on disk',
        reason: 'File deletion was not enabled for this cleanup.'
      }
    ],
    unavailable: [
      {
        key: 'networkLogs',
        label: 'ISP, DNS, VPN, router, and remote service logs',
        reason: 'These records are outside browser-extension APIs and were not attempted.'
      },
      {
        key: 'browserInternals',
        label: 'HSTS, Alt-Svc, DNS, socket, and TLS caches',
        reason: 'Chrome/Brave does not expose a safe target-scoped extension API for these browser internals.'
      }
    ],
    sections: [
      {
        key: 'targetDiagnostics',
        label: 'Target diagnostics',
        status: 'success',
        at: '2026-08-20T22:25:13.120Z',
        details: {
          matchMode: 'registrable_domain',
          exactOrigin: storeFullDetails ? 'https://synthetic.example.test' : '[redacted]',
          associatedTargetCount: 0
        }
      },
      {
        key: 'verification',
        label: 'Four-surface verification',
        status: 'success',
        at: '2026-08-20T22:25:13.779Z',
        details: {
          status: 'verified_zero',
          note: 'Cookies, matching tabs, history URLs, and download records were rechecked through exposed APIs.'
        }
      },
      {
        key: 'browserResidueLimits',
        label: 'Browser residue limits',
        status: 'partial',
        at: '2026-08-20T22:25:13.780Z',
        details: {
          note: 'Origin storage and hidden browser internals are outside the four-surface zero-residue claim.'
        }
      }
    ]
  };

  applyVerificationScenario(report, verificationScenario);

  state.reports = emptyHistory
    ? []
    : [
        structuredClone(report),
        {
          ...structuredClone(report),
          id: 'sitewipe-synthetic-sidepanel-history-report',
          finishedAt: '2026-08-19T15:12:08.010Z',
          summary: {
            ...structuredClone(report.summary),
            cleanupMode: 'standard',
            cleanupApprovalMode: 'detailed_review',
            cleanupConfidenceLabel: 'High',
            cleanupConfidenceScore: 94,
            totalDurationMs: 1240,
            browserOperationEventCount: 18,
            cookiesRemoved: 3,
            historyEntriesRemoved: 1
          }
        }
      ];
  if (!emptyHistory && verificationScenario !== 'verified-zero') {
    applyVerificationScenario(state.reports[1], 'verified-zero');
  }

  const envelope = (request, payload = {}) => ({
    protocolVersion: request.protocolVersion,
    requestId: request.requestId,
    ok: true,
    ...payload
  });

  async function ensureIntegrity(item) {
    const copy = structuredClone(item);
    delete copy.integrity;
    const bytes = new TextEncoder().encode(stableStringify(copy));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    item.integrity = {
      algorithm: 'sha256',
      digest: `sha256-${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`,
      note: 'Synthetic local checksum for fixture verification only.'
    };
  }

  async function sendMessage(request) {
    switch (request.type) {
      case 'sitewipe.getReportState':
        if (request.payload.reportId !== report.id || request.payload.windowId !== 7) {
          throw new Error('Synthetic fixture refused to disclose a different report.');
        }
        await ensureIntegrity(report);
        for (const historyReport of state.reports) await ensureIntegrity(historyReport);
        return envelope(request, {
          settings: {
            keepHistory: !emptyHistory,
            reducedMotion: false,
            highContrast: false,
            redactReports: !storeFullDetails
          },
          report: structuredClone(report),
          reports: structuredClone(state.reports)
        });
      case 'sitewipe.clearHistory':
        state.reports = [];
        state.clearedHistory += 1;
        syncEvidence();
        return envelope(request, { cleared: true });
      default:
        return envelope(request);
    }
  }

  function applyVerificationScenario(item, scenario) {
    const summary = item.summary;
    const verificationSection = item.sections.find((section) => section.key === 'verification');
    if (scenario === 'residue-incomplete') {
      summary.cleanupConfidenceLabel = 'Partial';
      summary.cleanupConfidenceScore = 61;
      summary.verificationStatus = 'residue_found';
      summary.verificationAllRequiredChecksSucceeded = false;
      summary.verificationNoExposedResidueFound = false;
      summary.verificationCategories = {
        cookies: verificationEvidence('residue_found', 3),
        tabs: verificationEvidence('verified_zero', 0),
        history: verificationEvidence('failed', null, 'Synthetic history verification failed.'),
        downloads: verificationEvidence('verified_zero', 0)
      };
      summary.verificationCookiesRemaining = 3;
      summary.verificationTabsRemaining = 0;
      summary.verificationHistoryRemaining = null;
      summary.verificationDownloadsRemaining = 0;
      summary.verificationRemainingTotal = null;
      verificationSection.status = 'partial';
      verificationSection.details = {
        status: 'residue_found',
        allRequiredChecksSucceeded: false,
        residueCount: 3,
        note: 'Three cookies remained, and the required history check failed. The full residue total is unknown.'
      };
      return;
    }
    if (scenario === 'incomplete-zero') {
      summary.cleanupConfidenceLabel = 'Partial';
      summary.cleanupConfidenceScore = 64;
      summary.verificationStatus = 'incomplete';
      summary.verificationAllRequiredChecksSucceeded = false;
      summary.verificationNoExposedResidueFound = false;
      summary.verificationCategories = {
        cookies: verificationEvidence('verified_zero', 0),
        tabs: verificationEvidence('verified_zero', 0),
        history: verificationEvidence('timed_out', null, 'Synthetic history verification timed out.'),
        downloads: verificationEvidence('verified_zero', 0)
      };
      summary.verificationCookiesRemaining = 0;
      summary.verificationTabsRemaining = 0;
      summary.verificationHistoryRemaining = null;
      summary.verificationDownloadsRemaining = 0;
      summary.verificationRemainingTotal = null;
      verificationSection.status = 'partial';
      verificationSection.details = {
        status: 'incomplete',
        allRequiredChecksSucceeded: false,
        residueCount: 0,
        note: 'Completed checks returned zero, but the required history check timed out. The full residue total is unknown.'
      };
      return;
    }
    summary.verificationStatus = 'verified_zero';
    summary.verificationAllRequiredChecksSucceeded = true;
    summary.verificationNoExposedResidueFound = true;
    summary.verificationCategories = {
      cookies: verificationEvidence('verified_zero', 0),
      tabs: verificationEvidence('verified_zero', 0),
      history: verificationEvidence('verified_zero', 0),
      downloads: verificationEvidence('verified_zero', 0)
    };
    summary.verificationCookiesRemaining = 0;
    summary.verificationTabsRemaining = 0;
    summary.verificationHistoryRemaining = 0;
    summary.verificationDownloadsRemaining = 0;
    summary.verificationRemainingTotal = 0;
    verificationSection.status = 'success';
    verificationSection.details = {
      status: 'verified_zero',
      allRequiredChecksSucceeded: true,
      residueCount: 0,
      note: 'Cookies, matching tabs, history URLs, and download records all returned zero through exposed APIs.'
    };
  }

  function verificationEvidence(state, count, reason = '') {
    return { state, count, reason: reason || `Synthetic ${state.replaceAll('_', ' ')} evidence.` };
  }

  function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  }

  function syncEvidence() {
    document.documentElement.dataset.fixtureSidepanelView = requestedView;
    document.documentElement.dataset.fixtureVerificationScenario = verificationScenario;
    document.documentElement.dataset.fixtureStoredReportRedacted = String(!storeFullDetails);
    document.documentElement.dataset.fixtureHistoryEmpty = String(state.reports.length === 0);
    document.documentElement.dataset.fixtureHistoryClears = String(state.clearedHistory);
    document.documentElement.dataset.fixtureOptionsOpened = String(state.optionsOpened);
    requestAnimationFrame(() => {
      const root = document.documentElement;
      const shell = document.querySelector('.side-shell');
      const clientWidth = Math.round(document.body.getBoundingClientRect().width || root.clientWidth);
      const scrollWidth = Math.max(document.body.scrollWidth, shell?.scrollWidth || 0);
      root.dataset.fixtureClientWidth = String(clientWidth);
      root.dataset.fixtureScrollWidth = String(scrollWidth);
      root.dataset.fixtureHorizontalOverflow = String(scrollWidth > clientWidth + 1);
      root.dataset.fixtureMatrixVisible = String(document.querySelectorAll('.matrix-item').length);
      root.dataset.fixtureMatrixExpanded = String(document.querySelectorAll('.matrix-item[open]').length);
      root.dataset.fixtureOutcomeBadge =
        document.querySelector('.outcome-card .outcome-badge')?.textContent?.trim() || '';
      root.dataset.fixtureOutcomeTitle = document.querySelector('.outcome-card h2')?.textContent?.trim() || '';
      root.dataset.fixtureHistoryOverview = document.querySelector('.history-overview p')?.textContent?.trim() || '';
      root.dataset.fixtureMatrixCount = document.querySelector('#matrixCount')?.textContent || '';
    });
  }

  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage,
      openOptionsPage() {
        state.optionsOpened += 1;
        syncEvidence();
      }
    },
    storage: {
      session: {
        async get(keys) {
          const key = Array.isArray(keys) ? keys[0] : keys;
          const bindingNow = Date.now();
          return {
            [key]: {
              schemaVersion: 1,
              reportId: report.id,
              windowId: 7,
              createdAt: new Date(bindingNow - 1_000).toISOString(),
              expiresAt: new Date(bindingNow + 299_000).toISOString()
            }
          };
        }
      },
      onChanged: {
        addListener(listener) {
          storageListeners.push(listener);
        }
      }
    },
    windows: {
      async getCurrent() {
        return { id: 7, incognito: false };
      }
    }
  };

  globalThis.__sitewipeSidepanelFixture = Object.freeze({ state, report });
  syncEvidence();

  window.addEventListener('resize', syncEvidence);
  document.addEventListener(
    'DOMContentLoaded',
    () => {
      const observer = new MutationObserver(syncEvidence);
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['hidden']
      });
      setTimeout(() => {
        const matrixFilter = document.querySelector('#matrixFilter');
        if (matrixFilter && requestedMatrixSearch) {
          matrixFilter.value = requestedMatrixSearch;
          matrixFilter.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const matrixStatusFilter = document.querySelector('#matrixStatusFilter');
        if (matrixStatusFilter && ['all', 'supported', 'partial', 'unavailable'].includes(requestedMatrixStatus)) {
          matrixStatusFilter.value = requestedMatrixStatus;
          matrixStatusFilter.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const selected = document.querySelector(`#${requestedView}TabButton`);
        if (selected && requestedView !== 'report') selected.click();
        syncEvidence();
      }, 80);
    },
    { once: true }
  );
})();

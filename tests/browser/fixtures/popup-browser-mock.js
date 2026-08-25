(() => {
  const fixtureParameters = new URLSearchParams(location.search);
  const simulatedZoom = fixtureParameters.get('zoom');
  const unsupportedActiveTab = fixtureParameters.get('active') === 'unsupported';
  const directCleanup = fixtureParameters.get('direct') === '1';
  const cleanupMode = fixtureParameters.get('mode') === 'standard' ? 'standard' : 'expert';
  const privateAccess = fixtureParameters.get('private') === '1';
  const transientReport = fixtureParameters.get('transient') === '1' || privateAccess;
  const denyPermission = fixtureParameters.get('permission') === 'deny';
  const expireAfterNativeGrant = fixtureParameters.get('permission') === 'expire-after-grant';
  const pregrantedHostAccess = fixtureParameters.get('pregranted') === '1' || privateAccess;
  const showFixtureControls = fixtureParameters.get('fixtureControls') === '1';
  const directOpenSurface = fixtureParameters.get('surface') === 'tab';
  const simulatedZoomScale = simulatedZoom === '200' ? 2 : simulatedZoom === '400' ? 4 : 1;
  if (simulatedZoomScale > 1) {
    const simulatedPopupWidth = 380 / simulatedZoomScale;
    document.documentElement.style.width = `${simulatedPopupWidth}px`;
    document.documentElement.style.maxWidth = `${simulatedPopupWidth}px`;
    document.body.style.width = `${simulatedPopupWidth}px`;
    document.body.style.maxWidth = `${simulatedPopupWidth}px`;
    document.body.style.zoom = String(simulatedZoomScale);
    document.documentElement.dataset.fixtureSimulatedZoom = simulatedZoom;
  }
  const settingsListeners = [];
  const permissionAddedListeners = [];
  const permissionRemovedListeners = [];
  const state = {
    messages: [],
    permissionOperations: [],
    permissionSnapshots: [],
    permissionRequests: [],
    permissionEvents: [],
    permissionRemovals: [],
    promptSettlements: [],
    armAttempts: 0,
    armRejections: 0,
    promptIntents: 0,
    promptInvocations: 0,
    grantOutcomes: 0,
    resumeAttempts: 0,
    handoffOpenAttempts: 0,
    approvedRuns: 0,
    canceledReviews: 0,
    preparationSequence: 0,
    activePreparedReview: null,
    armedApproval: null,
    lastApprovalMode: null,
    lastReviewedScope: null,
    latestReport: null,
    grantedOrigins: new Set(pregrantedHostAccess ? ['<all_urls>'] : [])
  };
  const syncEvidence = () => {
    document.documentElement.dataset.fixtureUserAgent = navigator.userAgent;
    document.documentElement.dataset.fixtureViewport = `${innerWidth}x${innerHeight}`;
    document.documentElement.dataset.fixtureApprovedRuns = String(state.approvedRuns);
    document.documentElement.dataset.fixturePermissionRequests = String(state.permissionRequests.length);
    document.documentElement.dataset.fixturePermissionRemovals = String(state.permissionRemovals.length);
    document.documentElement.dataset.fixtureCanceledReviews = String(state.canceledReviews);
    document.documentElement.dataset.fixturePromptSettlements = String(state.promptSettlements.length);
    document.documentElement.dataset.fixtureArmAttempts = String(state.armAttempts);
    document.documentElement.dataset.fixtureArmRejections = String(state.armRejections);
    document.documentElement.dataset.fixturePromptIntents = String(state.promptIntents);
    document.documentElement.dataset.fixturePromptInvocations = String(state.promptInvocations);
    document.documentElement.dataset.fixtureGrantOutcomes = String(state.grantOutcomes);
    document.documentElement.dataset.fixtureResumeAttempts = String(state.resumeAttempts);
    document.documentElement.dataset.fixtureHandoffOpenAttempts = String(state.handoffOpenAttempts);
    document.documentElement.dataset.fixtureLastApprovalMode = String(state.lastApprovalMode || '');
    document.documentElement.dataset.fixtureLastReviewedScope = String(state.lastReviewedScope ?? '');
    document.documentElement.dataset.fixtureDirectCleanup = String(directCleanup);
    document.documentElement.dataset.fixtureCleanupMode = cleanupMode;
    document.documentElement.dataset.fixturePrivateAccess = String(privateAccess);
    document.documentElement.dataset.fixturePregrantedHostAccess = String(pregrantedHostAccess);
    document.documentElement.dataset.fixtureTransientReport = String(transientReport);
    document.documentElement.dataset.fixturePermissionDenied = String(denyPermission);
    document.documentElement.dataset.fixtureExpireAfterNativeGrant = String(expireAfterNativeGrant);
    document.documentElement.dataset.fixtureDirectOpenSurface = String(directOpenSurface);
    document.documentElement.dataset.fixtureMessageTypes = state.messages.map((item) => item.type).join(',');
  };
  syncEvidence();

  const targetOrigins = [
    'http://alice.blogspot.com/*',
    'https://alice.blogspot.com/*',
    'http://*.alice.blogspot.com/*',
    'https://*.alice.blogspot.com/*'
  ];
  const fixtureLoadedAt = Date.now();
  const review = {
    schemaVersion: 1,
    approvalMode: directCleanup ? 'settings_direct' : 'detailed_review',
    approvalToken: '0'.repeat(48),
    approvalHandoffNonce: pregrantedHostAccess ? null : '0'.repeat(48),
    permissionLeaseId: pregrantedHostAccess ? null : 'synthetic-permission-lease',
    createdAt: new Date(fixtureLoadedAt).toISOString(),
    expiresAt: new Date(fixtureLoadedAt + 5 * 60 * 1000).toISOString(),
    enteredTarget: 'https://alice.blogspot.com/synthetic?fixture=non-personal',
    normalizedTarget: 'alice.blogspot.com',
    primaryTarget: {
      normalizedTarget: 'alice.blogspot.com',
      scopeKind: 'registrable_site',
      scopeLabel: 'Registrable site',
      includesSubdomains: true
    },
    scopeKind: 'registrable_site',
    scopeLabel: 'Registrable site',
    includesSubdomains: true,
    associatedTargets:
      cleanupMode === 'expert'
        ? [
            {
              normalizedTarget: 'accounts.example.net',
              scopeKind: 'registrable_site',
              scopeLabel: 'Registrable site',
              includesSubdomains: true
            }
          ]
        : [],
    normalWindowScope: { included: true, summary: 'Matching data exposed in normal browser windows is included.' },
    privateWindowScope: {
      included: privateAccess,
      sourceIncognito: privateAccess,
      matchingTabs: 0,
      summary: privateAccess
        ? 'Matching data exposed in private windows is included. Chrome/Brave may expose less private data than normal-profile data.'
        : 'Private-window data is not accessible because private-window access is not enabled.'
    },
    categoriesAttempted: [
      'Open matching tabs',
      'Unpartitioned and exposed partitioned cookies',
      'Origin-scoped storage, caches, file-system data, and service workers',
      'Matching browsing-history entries',
      'Matching download-history records',
      ...(cleanupMode === 'expert' ? ['Preflight-bound completed downloaded files on disk'] : [])
    ],
    categoriesProtected: [
      'Saved passwords, passkeys, and other credentials',
      'Bookmarks',
      'Browser Sync and browser-account data'
    ],
    categoriesUnavailable: ['Website-server and operating-system logs'],
    effects: {
      closeTabs: { enabled: true, matchingCount: 2 },
      removeHistory: { enabled: true, matchingCount: 3 },
      removeDownloadRecords: { enabled: true, matchingCount: 1 },
      removeDownloadedFiles: {
        settingEnabled: cleanupMode === 'expert',
        enabled: cleanupMode === 'expert',
        matchingCompletedFileCount: cleanupMode === 'expert' ? 1 : 0,
        candidateReviewComplete: cleanupMode === 'expert'
      },
      requestShield: {
        requested: true,
        enabled: false,
        disabledForNormalOnlyReview: true,
        disabledReason:
          'Skipped for normal-only safety: SiteWipe cannot constrain shared DNR session rules to normal windows, so no target request block will be installed.',
        remainsAfterCleanup: false,
        expiresMinutes: null
      },
      progressOverlay: {
        enabled: true,
        scope: 'all_tabs',
        scopeDescription: 'all accessible HTTP(S) tabs across browser windows',
        sourceWindowId: null,
        cancelButtonEnabled: true,
        maxTabsPerUpdate: 120,
        capAppliesPerUpdate: true,
        simultaneousVisibleLimitGuaranteed: false,
        temporary: true,
        watchdogMs: 15_000,
        warnings: [
          'A temporary cleanup progress overlay will be shown in all accessible HTTP(S) tabs across browser windows, capped at 120 tabs per update.'
        ]
      },
      configuredCleanup: {
        livePageScrub: {
          enabled: true,
          storageBuckets: true,
          opfs: true,
          serviceWorkerExtras: true,
          appBadgeClear: true
        },
        embeddedFrameDiscovery: true,
        cookies: {
          browserCookieSweep: true,
          partitionedEmbeddingSiteProbes: true,
          exhaustiveAccessibleStoreScan: true
        },
        recordDiscovery: {
          broadSearchTermFallback: true,
          recentDownloadFallback: true
        },
        targetTabState: {
          resetZoom: true,
          resetMutedTabs: true,
          unpinTabs: true
        },
        protectedWebOrigins: cleanupMode === 'expert'
      },
      verification: { enabled: true },
      localReport: {
        retained: true,
        redacted: true,
        summary: 'A redacted latest report is retained locally for up to 30 minutes.'
      }
    },
    settingsSnapshot: {
      cleanupMode,
      skipCleanupReview: directCleanup,
      includeProtectedWebOrigins: cleanupMode === 'expert',
      deleteDownloadedFiles: cleanupMode === 'expert',
      reportRedaction: true,
      latestReportRetentionMinutes: 30,
      historyEnabled: false
    },
    sourceWindowId: 7,
    hostPermissionsGranted: pregrantedHostAccess,
    requiredHostPermissionOrigins: targetOrigins,
    temporaryHostPermissionOrigins: pregrantedHostAccess ? [] : targetOrigins,
    hostPermissionInventory: {
      schemaVersion: 1,
      requiredHostPermissionOrigins: targetOrigins,
      coveredRequiredHostPermissionOrigins: pregrantedHostAccess ? targetOrigins : [],
      exactRequiredHostPermissionOrigins: [],
      requiredCoveredByBroadHostPermissionOrigins: pregrantedHostAccess ? targetOrigins : [],
      grantedHostPermissionOrigins: pregrantedHostAccess ? ['<all_urls>'] : [],
      exactGrantedHostPermissionOrigins: [],
      broadGrantedHostPermissionOrigins: pregrantedHostAccess ? ['<all_urls>'] : [],
      allSitesAccessGranted: pregrantedHostAccess
    },
    previewLimitations: ['Synthetic fixture: installed-extension API effects are intentionally not exercised.'],
    warnings: [
      'Approved cleanup removes matching browser data. Completed changes cannot be undone by SiteWipe.',
      'Skipped for normal-only safety: SiteWipe cannot constrain shared DNR session rules to normal windows, so no target request block will be installed. The target may recreate browser data while cleanup runs.',
      'A temporary cleanup progress overlay will be shown in all accessible HTTP(S) tabs across browser windows, capped at 120 tabs per update. This can visibly change unrelated pages.',
      'The in-page cancel button is enabled. Restricted, inaccessible, discarded, or out-of-reviewed-private-scope tabs are skipped. Tab eligibility can change between updates, so a stale overlay may remain until the approximately 15-second watchdog removes its UI and listener; the 120-tab per-update cap is not a guaranteed simultaneous-visible total.'
    ],
    requirements: {
      reviewedScope: true,
      associatedTargets: cleanupMode === 'expert',
      localOrIpTarget: false,
      protectedWebOrigins: cleanupMode === 'expert',
      downloadedFiles: cleanupMode === 'expert',
      fileConfirmationText: cleanupMode === 'expert' ? 'DELETE 1 FILE FOR alice.blogspot.com' : ''
    },
    requiredFileConfirmation: cleanupMode === 'expert' ? 'DELETE 1 FILE FOR alice.blogspot.com' : '',
    readyForApproval: true
  };
  if (fixtureParameters.get('overlay') === 'off') {
    review.effects.progressOverlay = {
      enabled: false,
      scope: 'target_tabs',
      scopeDescription: 'matching accessible HTTP(S) target tabs only',
      sourceWindowId: null,
      cancelButtonEnabled: false,
      maxTabsPerUpdate: 120,
      capAppliesPerUpdate: true,
      simultaneousVisibleLimitGuaranteed: false,
      temporary: false,
      watchdogMs: 15_000,
      warnings: []
    };
    review.warnings = review.warnings.filter(
      (warning) => !warning.includes('cleanup progress overlay') && !warning.includes('in-page cancel button')
    );
  }

  const envelope = (request, payload = {}) => ({
    protocolVersion: request.protocolVersion,
    requestId: request.requestId,
    ok: true,
    ...payload
  });

  function prepareSyntheticReview() {
    state.preparationSequence += 1;
    const sequenceHex = state.preparationSequence.toString(16);
    const preparedReview = structuredClone(review);
    preparedReview.approvalToken = sequenceHex.padStart(48, '0');
    preparedReview.approvalHandoffNonce = pregrantedHostAccess ? null : sequenceHex.padStart(48, '0');
    preparedReview.permissionLeaseId = pregrantedHostAccess
      ? null
      : `synthetic-permission-lease-${state.preparationSequence}`;
    const preparedAt = Date.now();
    preparedReview.createdAt = new Date(preparedAt).toISOString();
    preparedReview.expiresAt = new Date(preparedAt + 5 * 60 * 1000).toISOString();
    state.activePreparedReview = preparedReview;
    return preparedReview;
  }

  function completeSyntheticCleanup(request, approval, handoffResult = {}) {
    state.approvedRuns += 1;
    state.activePreparedReview = null;
    state.lastApprovalMode = approval.approvalMode;
    state.lastReviewedScope = approval.reviewedScope;
    const startedAt = new Date();
    const report = {
      id: 'sitewipe-synthetic-popup-report',
      appVersion: 'synthetic-fixture',
      targetDomain: review.normalizedTarget,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date(startedAt.getTime() + 1000).toISOString(),
      status: 'completed',
      redacted: true,
      summary: {
        cleanupMode,
        cleanupApprovalMode: approval.approvalMode,
        verificationStatus: 'verified_zero',
        verificationRemainingTotal: 0,
        cookiesRemoved: 0,
        historyEntriesRemoved: 0,
        downloadHistoryEntriesRemoved: 0
      },
      sections: [],
      errors: [],
      skipped: [],
      unavailable: []
    };
    state.latestReport = transientReport ? null : structuredClone(report);
    syncEvidence();
    return envelope(request, {
      report,
      reportPersisted: !transientReport,
      ...handoffResult
    });
  }

  function arraysEqual(left, right) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  }

  function currentPermissionSnapshot() {
    return { permissions: [], origins: [...state.grantedOrigins] };
  }

  function snapshotCoversTemporaryOrigins(snapshot, origins) {
    const grantedOrigins = Array.isArray(snapshot?.origins) ? snapshot.origins : [];
    return origins.some((origin) => grantedOrigins.some((granted) => hostPermissionPatternCovers(granted, origin)));
  }

  function hostPermissionPatternCovers(grantedPattern, requiredPattern) {
    if (grantedPattern === '<all_urls>') return true;
    const granted = parseHostPermissionPattern(grantedPattern);
    const required = parseHostPermissionPattern(requiredPattern);
    if (!granted || !required) return false;
    if (
      granted.scheme !== required.scheme &&
      !(granted.scheme === '*' && (required.scheme === 'http' || required.scheme === 'https'))
    ) {
      return false;
    }
    if (granted.path !== '/*' && granted.path !== required.path) return false;
    if (granted.host === '*') return true;
    if (granted.host.startsWith('*.')) {
      const grantedBase = granted.host.slice(2);
      const requiredBase = required.host.startsWith('*.') ? required.host.slice(2) : required.host;
      return requiredBase === grantedBase || requiredBase.endsWith(`.${grantedBase}`);
    }
    return !required.host.startsWith('*.') && granted.host === required.host;
  }

  function parseHostPermissionPattern(pattern) {
    const match = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/i.exec(String(pattern || ''));
    if (!match) return null;
    return { scheme: match[1].toLowerCase(), host: match[2].toLowerCase(), path: match[3] };
  }

  function grantedOriginsCover(origin) {
    return [...state.grantedOrigins].some((granted) => hostPermissionPatternCovers(granted, origin));
  }

  function emitPermissionAdded(event) {
    const payload = structuredClone(event);
    state.permissionEvents.push(payload);
    for (const listener of permissionAddedListeners) listener(structuredClone(payload));
    syncEvidence();
  }

  function emitPermissionRemoved(event) {
    const payload = structuredClone(event);
    for (const listener of permissionRemovedListeners) listener(structuredClone(payload));
    syncEvidence();
  }

  function releaseSyntheticTemporaryAccess() {
    const removedOrigins = targetOrigins.filter((origin) => state.grantedOrigins.delete(origin));
    if (!removedOrigins.length) return false;
    const request = { origins: removedOrigins };
    state.permissionRemovals.push(structuredClone(request));
    state.permissionOperations.push('remove');
    emitPermissionRemoved({ permissions: [], origins: removedOrigins });
    return true;
  }

  async function sendMessage(request) {
    state.messages.push(structuredClone(request));
    syncEvidence();
    switch (request.type) {
      case 'sitewipe.getPopupState':
        return envelope(request, {
          settings: {
            cleanupMode,
            skipCleanupReview: directCleanup,
            reducedMotion: false,
            highContrast: false
          },
          incognitoAccess: privateAccess,
          activeJob: null,
          report: null
        });
      case 'sitewipe.getActiveTabTarget':
        if (unsupportedActiveTab) {
          return envelope(request, {
            activeTab: {
              ok: false,
              supported: false,
              reason: 'Unsupported scheme chrome-extension:. Use http or https domains only.',
              tab: {
                id: 77,
                title: 'SiteWipe Options',
                url: 'chrome-extension://synthetic-sitewipe/options/options.html',
                incognito: false
              },
              normalized: {
                ok: false,
                error: 'Unsupported scheme chrome-extension:. Use http or https domains only.'
              }
            }
          });
        }
        return envelope(request, {
          activeTab: {
            supported: true,
            reason: '',
            tab: {
              id: 77,
              title: 'Synthetic SiteWipe tenant fixture',
              url: review.enteredTarget,
              incognito: privateAccess
            },
            normalized: { ok: true, input: review.enteredTarget, target: { domain: review.normalizedTarget } }
          }
        });
      case 'sitewipe.normalizeTarget':
        return envelope(request, {
          normalized: {
            ok: true,
            input: request.payload.input,
            target: { domain: review.normalizedTarget, hostPermissionOrigins: targetOrigins }
          }
        });
      case 'sitewipe.prepareCleanupReview': {
        const preparedReview = prepareSyntheticReview();
        return envelope(request, {
          review: preparedReview,
          popupContextId: `synthetic-popup-context-${state.preparationSequence}`,
          popupPreparationCapability: state.preparationSequence.toString(16).padStart(64, '0')
        });
      }
      case 'sitewipe.cancelCleanupReview':
        state.canceledReviews += 1;
        syncEvidence();
        return envelope(request, { canceled: true });
      case 'sitewipe.settleCleanupPermissionPrompt':
        state.promptSettlements.push(structuredClone(request.payload));
        state.activePreparedReview = null;
        state.armedApproval = null;
        syncEvidence();
        return envelope(request, {
          settlement: {
            released: false,
            accessRemains: null,
            recordRetained: false,
            permissionsPreserved: true
          }
        });
      case 'sitewipe.armCleanupApproval':
        state.armAttempts += 1;
        state.armedApproval = {
          approval: structuredClone(request.payload.approval),
          handoffNonce: request.payload.handoffNonce,
          promptIntentRecorded: false,
          promptInvocationRecorded: false,
          preRequestSnapshotStarted: false,
          preRequestTemporaryOriginsAbsent: false,
          nativeRequestResult: null,
          promptGrantObserved: false,
          grantOutcomeRecorded: false
        };
        syncEvidence();
        return envelope(request, {
          approvalArmed: true,
          handoffStatus: 'armed',
          handoffNonce: request.payload.handoffNonce
        });
      case 'sitewipe.openCleanupPermissionHandoff':
        if (!state.armedApproval || request.payload.handoffNonce !== state.armedApproval.handoffNonce) {
          throw new Error('Synthetic fixture refused to open a missing or different cleanup handoff.');
        }
        state.handoffOpenAttempts += 1;
        syncEvidence();
        return envelope(request, { handoffOpened: true, handoffFocused: true, tabId: 88 });
      case 'sitewipe.beginCleanupPermissionPrompt':
        if (!state.armedApproval || request.payload.handoffNonce !== state.armedApproval.handoffNonce) {
          throw new Error('Synthetic fixture refused a missing or different cleanup handoff.');
        }
        if (
          expireAfterNativeGrant &&
          state.activePreparedReview &&
          Date.parse(state.activePreparedReview.expiresAt) < Date.now()
        ) {
          state.armRejections += 1;
          syncEvidence();
          throw new Error('This synthetic cleanup review expired before target-access invocation was recorded.');
        }
        state.promptIntents += 1;
        state.armedApproval.promptIntentRecorded = true;
        state.permissionOperations.push('begin');
        syncEvidence();
        return envelope(request, {
          promptIntentRecorded: true,
          handoffNonce: request.payload.handoffNonce
        });
      case 'sitewipe.confirmCleanupPermissionPromptInvocation':
        if (
          !state.armedApproval ||
          request.payload.handoffNonce !== state.armedApproval.handoffNonce ||
          state.armedApproval.promptIntentRecorded !== true
        ) {
          throw new Error('Synthetic fixture refused an invocation marker without its authenticated prompt intent.');
        }
        state.promptInvocations += 1;
        state.armedApproval.promptInvocationRecorded = true;
        state.permissionOperations.push('confirm-invocation');
        syncEvidence();
        return envelope(request, {
          promptInvocationRecorded: true,
          handoffNonce: request.payload.handoffNonce,
          ...(state.activePreparedReview && Date.parse(state.activePreparedReview.expiresAt) < Date.now()
            ? { authorityRevoked: true, handoffStatus: 'prompt_tombstone' }
            : {})
        });
      case 'sitewipe.confirmCleanupPermissionGrantOutcome':
        if (
          !state.armedApproval ||
          request.payload.handoffNonce !== state.armedApproval.handoffNonce ||
          state.armedApproval.promptInvocationRecorded !== true ||
          state.armedApproval.nativeRequestResult !== true ||
          state.armedApproval.preRequestTemporaryOriginsAbsent !== true ||
          request.payload.preRequestTemporaryOriginsAbsent !== true
        ) {
          throw new Error('Synthetic fixture refused a grant outcome without the exact literal-true request proof.');
        }
        state.grantOutcomes += 1;
        state.armedApproval.grantOutcomeRecorded = true;
        state.permissionOperations.push('confirm-outcome');
        if (
          expireAfterNativeGrant &&
          state.activePreparedReview &&
          Date.parse(state.activePreparedReview.expiresAt) < Date.now()
        ) {
          releaseSyntheticTemporaryAccess();
          state.activePreparedReview = null;
          state.armedApproval = null;
          syncEvidence();
          return envelope(request, {
            promptGrantOutcomeRecorded: true,
            handoffNonce: request.payload.handoffNonce,
            cleanupStarted: false,
            temporaryAccessReleased: true,
            grantObservationTerminal: true,
            settlement: { released: true, accessRemains: false, recordRetained: false }
          });
        }
        syncEvidence();
        return envelope(request, {
          promptGrantOutcomeRecorded: true,
          handoffNonce: request.payload.handoffNonce
        });
      case 'sitewipe.resumeArmedCleanup':
        state.resumeAttempts += 1;
        syncEvidence();
        if (expireAfterNativeGrant) {
          throw new Error('Synthetic fixture refused to resume an expired cleanup review.');
        }
        if (!state.armedApproval || request.payload.handoffNonce !== state.armedApproval.handoffNonce) {
          throw new Error('Synthetic fixture refused a missing or different cleanup handoff.');
        }
        if (
          state.armedApproval.promptIntentRecorded !== true ||
          state.armedApproval.promptInvocationRecorded !== true ||
          state.armedApproval.promptGrantObserved !== true ||
          state.armedApproval.nativeRequestResult !== true ||
          state.armedApproval.preRequestTemporaryOriginsAbsent !== true ||
          state.armedApproval.grantOutcomeRecorded !== true
        ) {
          throw new Error('Synthetic fixture refused cleanup without the complete independent permission proof.');
        }
        {
          const { approval } = state.armedApproval;
          state.armedApproval = null;
          releaseSyntheticTemporaryAccess();
          return completeSyntheticCleanup(request, approval, {
            approvalHandoffNonce: request.payload.handoffNonce
          });
        }
      case 'sitewipe.runDeepClean':
        return completeSyntheticCleanup(request, request.payload.approval);
      case 'sitewipe.openSidePanel':
        if (
          !state.latestReport ||
          request.payload.reportId !== state.latestReport.id ||
          request.payload.windowId !== 7
        ) {
          throw new Error('Synthetic fixture refused to open a different stored report.');
        }
        return envelope(request, {
          reportId: state.latestReport.id,
          windowId: 7,
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
        });
      case 'sitewipe.getActiveJob':
        return envelope(request, { activeJob: null });
      case 'sitewipe.forgetLatestReport':
        if (!state.latestReport || request.payload.reportId !== state.latestReport.id) {
          throw new Error('Synthetic fixture refused to forget a different stored report.');
        }
        state.latestReport = null;
        return envelope(request, { report: null, forgottenReportId: request.payload.reportId });
      default:
        return envelope(request);
    }
  }

  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage,
      openOptionsPage() {},
      getURL(path = '') {
        return new URL(String(path).replace(/^\//, ''), location.href).href;
      }
    },
    storage: {
      onChanged: {
        addListener(listener) {
          settingsListeners.push(listener);
        }
      }
    },
    permissions: {
      onAdded: {
        addListener(listener) {
          permissionAddedListeners.push(listener);
        }
      },
      onRemoved: {
        addListener(listener) {
          permissionRemovedListeners.push(listener);
        }
      },
      async getAll() {
        const snapshot = currentPermissionSnapshot();
        state.permissionOperations.push('getAll');
        state.permissionSnapshots.push(structuredClone(snapshot));
        if (state.armedApproval) {
          state.armedApproval.preRequestSnapshotStarted = true;
          state.armedApproval.preRequestSnapshot = structuredClone(snapshot);
        }
        syncEvidence();
        return snapshot;
      },
      async request(request) {
        state.permissionRequests.push(structuredClone(request));
        const snapshot = state.armedApproval?.preRequestSnapshot;
        const snapshotStartedImmediatelyBeforeRequest = state.permissionOperations.at(-1) === 'getAll';
        state.permissionOperations.push('request');
        if (!state.armedApproval || state.armedApproval.promptIntentRecorded !== true) {
          throw new Error('Synthetic fixture refused permissions.request without authenticated prompt intent.');
        }
        if (!snapshotStartedImmediatelyBeforeRequest || !snapshot) {
          throw new Error('Synthetic fixture refused permissions.request without a synchronous pre-request inventory.');
        }
        state.armedApproval.preRequestTemporaryOriginsAbsent = !snapshotCoversTemporaryOrigins(
          snapshot,
          request.origins || []
        );
        if (denyPermission) {
          state.armedApproval.nativeRequestResult = false;
          syncEvidence();
          return false;
        }
        const newlyGrantedOrigins = (request.origins || []).filter((origin) => !grantedOriginsCover(origin));
        for (const origin of newlyGrantedOrigins) state.grantedOrigins.add(origin);
        if (arraysEqual(newlyGrantedOrigins, targetOrigins)) {
          const event = { permissions: [], origins: newlyGrantedOrigins };
          state.armedApproval.promptGrantObserved = true;
          emitPermissionAdded(event);
        }
        state.armedApproval.nativeRequestResult = true;
        if (expireAfterNativeGrant && state.activePreparedReview) {
          // Keep the review usable for manual inspection, then make only the
          // synthetic native-grant settlement late. The production popup owns
          // the expiry decision and terminal worker settlement that follow.
          state.activePreparedReview.expiresAt = new Date(Date.now() - 1000).toISOString();
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        syncEvidence();
        return true;
      },
      async remove(request) {
        state.permissionOperations.push('remove');
        const removedOrigins = (request.origins || []).filter((origin) => state.grantedOrigins.delete(origin));
        state.permissionRemovals.push({ ...structuredClone(request), origins: removedOrigins });
        if (removedOrigins.length) emitPermissionRemoved({ permissions: [], origins: removedOrigins });
        syncEvidence();
        return true;
      },
      async contains(request = {}) {
        return (request.origins || []).every((origin) => grantedOriginsCover(origin));
      }
    },
    windows: {
      async getCurrent() {
        return { id: 7, incognito: privateAccess };
      }
    },
    tabs: {
      async getCurrent() {
        return directOpenSurface ? { id: 77, windowId: 7, url: location.href, incognito: privateAccess } : undefined;
      }
    },
    sidePanel: {
      async open() {}
    }
  };

  globalThis.__sitewipeBrowserFixture = Object.freeze({
    state,
    review,
    grantExternally(origins = ['<all_urls>']) {
      const newlyGrantedOrigins = origins.filter((origin) => !state.grantedOrigins.has(origin));
      for (const origin of newlyGrantedOrigins) state.grantedOrigins.add(origin);
      if (newlyGrantedOrigins.length) {
        emitPermissionAdded({ permissions: [], origins: newlyGrantedOrigins });
      }
      return currentPermissionSnapshot();
    },
    expireActiveReview() {
      if (state.activePreparedReview) {
        state.activePreparedReview.expiresAt = new Date(Date.now() - 1000).toISOString();
      }
    },
    emitSettingsChange(
      next = { cleanupMode: cleanupMode === 'standard' ? 'expert' : 'standard', skipCleanupReview: false }
    ) {
      for (const listener of settingsListeners) {
        listener(
          {
            'sitewipe.settings.v1': {
              oldValue: { cleanupMode, skipCleanupReview: directCleanup },
              newValue: next
            }
          },
          'local'
        );
      }
    }
  });
  const settingsChangeButton = document.createElement('button');
  settingsChangeButton.type = 'button';
  settingsChangeButton.textContent = 'Synthetic fixture: change settings';
  settingsChangeButton.setAttribute(
    'aria-description',
    'Test-only control; it does not exist in the packaged extension.'
  );
  settingsChangeButton.style.cssText = 'position:fixed;right:8px;bottom:8px;z-index:9999;font-size:12px';
  settingsChangeButton.addEventListener('click', () => {
    globalThis.__sitewipeBrowserFixture.emitSettingsChange();
  });
  if (showFixtureControls) document.body.append(settingsChangeButton);
})();

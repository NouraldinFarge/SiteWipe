import { describeTargetMode } from './domain.js';
import { addSection, addSkipped, addUnavailable } from './report.js';
import { verificationNotAttempted } from '../shared/verification-evidence.js';
import { finalizeTemporaryDnrShield, installTemporaryDnrShield } from './dnr-shield.js';
import { verifyExposedResidue } from './verification.js';
import { removeHistory } from './history.js';
import { eraseDownloadHistory } from './downloads.js';
import { discoverCookiesOnly, removeCookies } from './cookies.js';
import { removeOriginScopedStorage } from './origin-storage.js';
import { scrubOpenPageData } from './page-scrub.js';
import { createCleanupProgressOverlay } from './progress-overlay.js';
import { discoverMatchingDownloads, discoverMatchingHistory } from './record-discovery.js';
import { discoverCleanupScope } from './scope-discovery.js';
import { auditAndResetTabState, closeMatchingTabs } from './tab-state.js';
import { createOperationBudget, sleep } from './operation-control.js';
export {
  buildTemporaryDnrShieldRules,
  clearSiteWipeDnrRules,
  getSiteWipeDnrDiagnostics,
  replaceSiteWipeDnrShieldRules
} from './dnr-shield.js';
export { boundCleanupOrigins, inspectCleanupImpact } from './scope-discovery.js';
export { pageVisibleStorageScrubber } from './page-scrub.js';

export async function runDeepClean(target, report, options = {}) {
  const operationBudget =
    options.operationBudget ||
    createOperationBudget({
      label: 'cleanup',
      maxDurationMs: 210_000,
      maxQueries: 1_000,
      maxRecords: 250_000
    });
  options = { ...options, operationBudget };
  report.incognitoAccess = Boolean(options.incognitoAccess);
  report.hostPermissionsGranted = Boolean(options.hostPermissionsGranted);
  addSection(report, 'targetDiagnostics', 'Target matching mode', 'info', {
    target: target.displayName || target.domain,
    matchMode: target.matchMode || 'registrable_domain',
    exactOrigin: target.exactOrigin || null,
    publicSuffix: target.publicSuffix || null,
    baseOrigins: target.baseOrigins || [],
    associatedTargets: target.associatedDisplayNames || [],
    associatedTargetCount: target.associatedTargets?.length || 0,
    note: describeTargetMode(target)
  });
  const progress = createCleanupProgressOverlay(target, report, options);
  const phaseTimer = createPhaseTimer(report);
  async function updateProgress(percent, label, detail) {
    phaseTimer.mark(label);
    await progress.update(percent, label, detail);
    if (typeof options.onProgress === 'function') {
      try {
        await options.onProgress({
          percent,
          label,
          detail,
          phase: phaseKey(label),
          at: new Date().toISOString()
        });
      } catch {
        // Progress persistence must never break cleanup.
      }
    }
  }
  async function checkCanceled(phase) {
    operationBudget.check(phase);
    if (typeof options.shouldCancel === 'function') {
      const shouldCancel = await options.shouldCancel();
      if (shouldCancel) {
        report.summary.cancelRequested = true;
        const error = new Error(`SiteWipe cleanup canceled before ${phase}.`);
        error.name = 'AbortError';
        throw error;
      }
    }
  }

  let completed = false;

  try {
    await updateProgress(3, 'Preparing cleanup…', 'SiteWipe is starting the target-domain cleanup.');

    addSkipped(
      report,
      'Saved passwords',
      'Never requested or modified. Password deletion is unavailable through current Chrome extension APIs and intentionally outside SiteWipe scope.'
    );
    addSkipped(report, 'Bookmarks', 'Never requested or modified.');
    addSkipped(
      report,
      'Autofill profiles and payment methods',
      'Protected. Chrome exposes autofill removal only as a browser-profile-wide form-data operation that can also remove saved payment cards, so SiteWipe never calls it.'
    );
    addSkipped(
      report,
      'Passkeys / WebAuthn credentials',
      'Credential material is intentionally outside SiteWipe scope, even when a site uses passkeys instead of passwords.'
    );
    addSkipped(
      report,
      'Browser Sync',
      'SiteWipe never uses browser-sync APIs or extension sync storage, and its safety guard blocks browser-sync service targets before cleanup starts.'
    );
    if (options.deleteDownloadedFiles) {
      addSection(report, 'downloadFilesSafety', 'Downloaded-file deletion enabled', 'partial', {
        approvedCandidateCount: Array.isArray(options.approvedDownloadFileIds)
          ? options.approvedDownloadFileIds.length
          : 0,
        warning:
          'Only completed downloaded files bound to the immediately preceding cleanup preflight are eligible for removal. SiteWipe cannot undo an on-disk file removal.'
      });
    } else {
      addSkipped(
        report,
        'Downloaded files on disk',
        'Download history entries may be erased, but files are never deleted unless the optional destructive downloaded-file cleanup setting is enabled.'
      );
    }
    addUnavailable(
      report,
      'External and remote logs',
      'ISP, DNS, router, VPN, OS, antivirus, enterprise, firewall, CDN, and website-server records are outside browser extension APIs.'
    );

    await checkCanceled('request shield installation');
    await updateProgress(
      8,
      'Installing request shield…',
      'Blocking target requests while cleanup runs so the site cannot immediately recreate data.'
    );
    const shield = await installTemporaryDnrShield(target, report, options);
    let context = null;
    try {
      await checkCanceled('discovery');
      await updateProgress(
        16,
        'Discovering site traces…',
        'Finding matching tabs, frames, cookies, origins, history entries, downloads, and related records.'
      );
      context = await discoverCleanupScope(target, report, options);

      await checkCanceled('tab-state audit');
      await updateProgress(
        28,
        'Auditing tab state…',
        'Checking site zoom, muted/pinned tabs, groups, discarded/frozen tabs, window type, and favicon presence.'
      );
      await auditAndResetTabState(target, report, context, options);

      await checkCanceled('live-page scrub');
      await updateProgress(
        40,
        'Scrubbing live pages…',
        'Clearing page-visible storage, OPFS, service workers, push/sync registrations, badges, and permission-state evidence where supported.'
      );
      await scrubOpenPageData(target, report, context, options);

      await checkCanceled('tab close');
      await updateProgress(
        50,
        'Closing target tabs…',
        'Closing open tabs whose URL matches the selected target domain or subdomain.'
      );
      await closeMatchingTabs(target, report, options.incognitoAccess, context, options);

      await checkCanceled('cookie removal');
      await updateProgress(
        62,
        'Removing cookies…',
        'Deleting unpartitioned cookies, exposed partitioned cookies, and running the optional browser cookie sweep.'
      );
      await removeCookies(target, report, options.incognitoAccess, context, options);

      await checkCanceled('origin storage cleanup');
      await updateProgress(
        72,
        'Clearing origin storage…',
        'Removing origin-scoped cache, LocalStorage, IndexedDB, Cache Storage, file-system storage, service workers, WebSQL, and protected data if enabled.'
      );
      await removeOriginScopedStorage(target, report, context, options);

      await checkCanceled('history removal');
      await updateProgress(
        82,
        'Removing history…',
        'Deleting matching browser-history URLs for the target domain and subdomains.'
      );
      await removeHistory(target, report, context, options);

      await checkCanceled('download cleanup');
      await updateProgress(
        88,
        'Erasing download records…',
        'Erasing matching download-history records and deleting files only if the destructive file option is enabled.'
      );
      await eraseDownloadHistory(target, report, context, options);

      await checkCanceled('site-permission review');
      await updateProgress(
        94,
        'Preserving site permission settings…',
        'SiteWipe leaves browser permission and content-setting rules under your control.'
      );
      recordSitePermissionLimitation(report);

      if (options.verificationPass === true) {
        await checkCanceled('verification pass');
        await updateProgress(
          96,
          'Verifying cleanup…',
          'Re-checking exposed cookies, open target tabs, history URLs, and download records.'
        );
        await verifyExposedResidue(target, report, options, {
          discoverCookies: discoverCookiesOnly,
          discoverHistory: discoverMatchingHistory,
          discoverDownloads: discoverMatchingDownloads
        });
      } else {
        const skippedEvidence = {
          cookies: verificationNotAttempted('Verification was disabled in settings.'),
          tabs: verificationNotAttempted('Verification was disabled in settings.'),
          history: verificationNotAttempted('Verification was disabled in settings.'),
          downloads: verificationNotAttempted('Verification was disabled in settings.')
        };
        report.summary.verificationPassEnabled = false;
        report.summary.verificationStatus = 'not_attempted';
        report.summary.verificationAllRequiredChecksSucceeded = false;
        report.summary.verificationNoExposedResidueFound = false;
        report.summary.verificationRemainingTotal = null;
        report.summary.verificationCategories = skippedEvidence;
        addSection(report, 'verification', 'Post-clean verification skipped', 'skipped', {
          reason: 'Disabled in settings.',
          categories: skippedEvidence
        });
      }

      await updateProgress(
        97,
        'Recording unsupported residue…',
        'Documenting browser/network/site details that Chrome MV3 cannot safely reset per target.'
      );
      addKnownUnsupportedResidues(report, context, options);
    } finally {
      await updateProgress(
        98,
        'Finalizing cleanup…',
        'Removing temporary shields unless the post-wipe session block is enabled.'
      );
      await finalizeTemporaryDnrShield(shield, report, options);
    }

    await updateProgress(100, 'Cleanup finished', 'SiteWipe is removing the page progress overlay now.');
    completed = true;
    await sleep(450);
  } finally {
    await progress.hide(completed ? 'complete' : 'stopped');
    phaseTimer.finish();
    const budget = operationBudget.snapshot();
    report.summary.operationBudgetExhausted = Boolean(budget.exhausted);
    report.summary.operationBudgetQueriesUsed = budget.queriesUsed;
    report.summary.operationBudgetRecordsObserved = budget.recordsObserved;
    addSection(
      report,
      'operationBudget',
      budget.exhausted ? 'Cleanup operation budget exhausted' : 'Cleanup operation budget remained within limits',
      budget.exhausted ? 'partial' : 'info',
      budget
    );
  }
  return report;
}

function createPhaseTimer(report) {
  const timings = report.phaseTimings || {};
  report.phaseTimings = timings;
  let lastKey = null;
  let lastAt = performanceNowSafe();
  return {
    mark(label) {
      const now = performanceNowSafe();
      if (lastKey) timings[lastKey] = Math.round((timings[lastKey] || 0) + Math.max(0, now - lastAt));
      lastKey = phaseKey(label);
      lastAt = now;
    },
    finish() {
      const now = performanceNowSafe();
      if (lastKey) timings[lastKey] = Math.round((timings[lastKey] || 0) + Math.max(0, now - lastAt));
      lastKey = null;
      lastAt = now;
    }
  };
}

function phaseKey(label) {
  return (
    String(label || 'phase')
      .replace(/[.。…]+/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'phase'
  );
}

function performanceNowSafe() {
  try {
    return performance.now();
  } catch {
    return Date.now();
  }
}

function addKnownUnsupportedResidues(report, context, options = {}) {
  const reportOnly = [
    [
      'Protocol handlers',
      'Websites can register protocol handlers, but Chrome does not expose a safe target-domain removal API to extensions. Review browser site settings manually if needed.'
    ],
    [
      'Favicon cache',
      'Site favicons may remain in browser UI/cache. Extensions can see current favIconUrl on open tabs, but Chrome does not expose a target-safe favicon-cache deletion API.'
    ],
    [
      'Top Sites / New Tab suggestions',
      'History cleanup can reduce suggestions, but Chrome does not expose a reliable targeted top-sites deletion API.'
    ],
    [
      'Omnibox autocomplete',
      'Address-bar suggestions may also come from open tabs, bookmarks, synced data, search-provider suggestions, or remote suggestions; SiteWipe only removes target browser history and open tabs.'
    ],
    [
      'Recently closed tab/session metadata',
      'Chrome exposes recently closed entries only with an additional sessions permission and provides no targeted forget API. SiteWipe does not request that permission merely for discovery.'
    ],
    [
      'HSTS, Alt-Svc, DNS cache, socket pools, TLS session tickets',
      'Chrome MV3 does not expose safe per-site cleanup APIs for these low-level network caches. Restarting the browser clears some transient network state.'
    ],
    [
      'NEL / Reporting endpoints',
      'Network Error Logging and Reporting API state is not exposed through a reliable target-scoped extension cleanup API.'
    ],
    [
      'Storage Access / Related identity grants',
      'Some identity and storage-access grants are browser-controlled and not exposed as target-scoped extension deletion APIs.'
    ],
    [
      'FedCM identity state',
      'Federated sign-in state is not a password, but Chrome does not expose a safe target-specific cleanup API for all FedCM/identity state.'
    ],
    [
      'Private State Tokens / autoVerify',
      'Chrome exposes autoVerify as a global setting rather than a normal target-domain reset; SiteWipe reports it instead of changing a global setting.'
    ],
    [
      'Payment handlers and payment methods',
      'Payment data and handlers are intentionally skipped unless the browser exposes a future safe target-specific API.'
    ],
    [
      'Device grants',
      'USB, Bluetooth, Serial, HID, MIDI, local-font, window-management, display-capture, and File System Access handles may require manual browser settings review when the browser does not expose target revocation to extensions.'
    ]
  ];

  for (const [label, reason] of reportOnly) addUnavailable(report, label, reason);

  addSection(report, 'browserResidueLimits', 'Extra browser residue limits reported', 'partial', {
    matchingRecentlyClosedSessions: context?.matchingRecentlyClosed?.length || 0,
    matchingOpenTabs: context?.matchingTabs?.length || 0,
    temporaryDnrShieldEnabled: options.temporaryDnrShield !== false,
    postWipeSessionBlockEnabled: Boolean(options.postWipeSessionBlock),
    note: 'This section is intentionally explicit about small browser/site residues that are observable, indirect, global-only, manual-only, or not safely targetable through Chrome MV3 APIs.'
  });
}

function recordSitePermissionLimitation(report) {
  report.summary.sitePermissionSettingsPreserved = true;
  addSkipped(
    report,
    'Browser permission and content-setting rules',
    'Preserved under user control. SiteWipe does not add default-like rules because that could override an intentional user, policy, or another-extension setting.'
  );
  addUnavailable(
    report,
    'Targeted site-permission reset',
    'Chrome MV3 does not provide a safe API to delete arbitrary user-managed browser permission or content-setting rules for only one target without creating new extension-controlled rules. Use Chrome or Brave site settings for manual changes.'
  );
  addSection(report, 'contentSettings', 'Browser permission and content-setting rules preserved', 'skipped', {
    note: 'SiteWipe intentionally does not change browser permission or content-setting rules. Website data is still removed through the scoped cookies, browsingData, history, downloads, tabs, and page-scrub paths.'
  });
}

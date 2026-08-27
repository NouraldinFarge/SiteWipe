import { addError, addSection, addUnavailable } from './report.js';
import { readableMessage, throwIfCancellationRequested, withTimeoutReject } from './operation-control.js';
import { downloadMatchesReviewedCleanupTarget, tabMatchesReviewedCleanupTarget } from '../shared/target-scope.js';
import {
  summarizeVerification,
  verificationFailure,
  verificationFromCount,
  verificationNotAttempted,
  verificationNotSupported,
  verificationUnknown
} from '../shared/verification-evidence.js';

const VERIFICATION_TIMEOUT_MS = 15000;

/**
 * Verifies only browser-visible residue. Discovery functions are injected so
 * the evidence state machine can be tested without a browser profile.
 */
export async function verifyExposedResidue(target, report, options = {}, dependencies = {}) {
  const { discoverCookies, discoverHistory, discoverDownloads } = dependencies;
  const categories = {
    cookies: verificationNotAttempted('Cookie verification has not started.'),
    tabs: verificationNotAttempted('Tab verification has not started.'),
    history: verificationNotAttempted('History verification has not started.'),
    downloads: verificationNotAttempted('Download verification has not started.')
  };
  const samples = { tabs: [], cookieHosts: [], historyUrls: [], downloadUrls: [] };
  const errors = [];
  report.summary.verificationPassEnabled = true;
  report.summary.verificationScope = 'cookies_tabs_history_download_records';
  report.summary.verificationScopeLabel = 'Cookies, tabs, history, and download records only';

  await runVerificationCheck('tabs', Boolean(chrome.tabs?.query), 'chrome.tabs.query is unavailable.', async () => {
    options.operationBudget?.claimQuery('verification tab discovery');
    const tabs = await chrome.tabs.query({});
    options.operationBudget?.observeRecords(tabs?.length || 0, 'verification tab discovery results');
    const matchingTabs = tabs.filter((tab) =>
      tabMatchesReviewedCleanupTarget(tab, target, options.incognitoAccess === true)
    );
    samples.tabs = matchingTabs.slice(0, 10).map((tab) => ({
      id: tab.id,
      incognito: Boolean(tab.incognito),
      url: redactUrlForReport(tab.url)
    }));
    return matchingTabs.length;
  });

  await runVerificationCheck(
    'cookies',
    Boolean(chrome.cookies && typeof discoverCookies === 'function'),
    chrome.cookies ? 'Cookie verification adapter is unavailable.' : 'chrome.cookies is unavailable.',
    async () => {
      const candidates = await discoverCookies(target, options.incognitoAccess, {
        ...options,
        strict: true
      });
      samples.cookieHosts = [
        ...new Set(candidates.map((item) => item.cookie?.domain || item.cookie?.host || '').filter(Boolean))
      ].slice(0, 20);
      return candidates.length;
    }
  );

  await runVerificationCheck(
    'history',
    Boolean(chrome.history?.search && typeof discoverHistory === 'function'),
    chrome.history?.search ? 'History verification adapter is unavailable.' : 'chrome.history.search is unavailable.',
    async () => {
      const result = normalizeDiscoveryResult(await discoverHistory(target, options), 'history');
      const matches = result.items;
      samples.historyUrls = matches.slice(0, 10).map((item) => redactUrlForReport(item.url));
      return verificationFromDiscoveryResult(result, 'History');
    }
  );

  await runVerificationCheck(
    'downloads',
    Boolean(chrome.downloads?.search && typeof discoverDownloads === 'function'),
    chrome.downloads?.search
      ? 'Download verification adapter is unavailable.'
      : 'chrome.downloads.search is unavailable.',
    async () => {
      const result = normalizeDiscoveryResult(
        await discoverDownloads(target, { ...options, downloadRecentFallback: false }),
        'downloads'
      );
      const matches = result.items.filter((item) =>
        downloadMatchesReviewedCleanupTarget(item, target, options.incognitoAccess === true)
      );
      samples.downloadUrls = matches
        .slice(0, 10)
        .map((item) => redactUrlForReport(item.finalUrl || item.url || item.referrer));
      return verificationFromDiscoveryResult({ ...result, items: matches }, 'Download');
    }
  );

  const evidence = summarizeVerification(categories, ['cookies', 'tabs', 'history', 'downloads']);
  report.summary.verificationCookiesRemaining = categories.cookies.count;
  report.summary.verificationTabsRemaining = categories.tabs.count;
  report.summary.verificationHistoryRemaining = categories.history.count;
  report.summary.verificationDownloadsRemaining = categories.downloads.count;
  report.summary.verificationRemainingTotal = evidence.allRequiredChecksSucceeded ? evidence.residueCount : null;
  report.summary.verificationStatus = evidence.status;
  report.summary.verificationAllRequiredChecksSucceeded = evidence.allRequiredChecksSucceeded;
  report.summary.verificationNoExposedResidueFound = evidence.noExposedResidueFound;
  report.summary.verificationCategories = categories;
  addSection(
    report,
    'verification',
    'Four-surface post-clean verification',
    evidence.status === 'verified_zero' ? 'success' : 'partial',
    {
      evidenceStatus: evidence.status,
      allRequiredChecksSucceeded: evidence.allRequiredChecksSucceeded,
      noExposedResidueFound: evidence.noExposedResidueFound,
      residueCount: evidence.residueCount,
      categories,
      samples,
      errors,
      scope: ['cookies', 'tabs', 'history', 'download records'],
      unverifiedCleanupSurfaces: [
        'origin storage and cache',
        'IndexedDB and Cache Storage',
        'OPFS and Storage Buckets',
        'page service workers and registrations',
        'zoom, mute, pin, badge, and page permission evidence',
        'request-shield side effects'
      ],
      note: 'Best-effort four-surface verification reports explicit evidence states. Failed, timed-out, unsupported, skipped, capped, and unknown checks are never converted to zero. Verified zero means only that cookies, open target tabs, matching history URLs, and matching download records returned zero through exposed browser extension APIs.'
    }
  );

  async function runVerificationCheck(name, supported, unsupportedReason, operation) {
    if (!supported) {
      categories[name] = verificationNotSupported(unsupportedReason);
      addUnavailable(report, `Verification: ${name}`, unsupportedReason);
      return;
    }
    try {
      await throwIfCancellationRequested(options.shouldCancel, `verification of ${name}`);
      options.operationBudget?.check(`verification of ${name}`);
      const result = await withTimeoutReject(
        Promise.resolve().then(operation),
        Number(options.verificationTimeoutMs) || VERIFICATION_TIMEOUT_MS,
        `Verification ${name}`
      );
      categories[name] = isVerificationEvidence(result) ? result : verificationFromCount(result);
    } catch (error) {
      categories[name] = verificationFailure(error);
      errors.push({ area: name, state: categories[name].state, message: readableMessage(error) });
      addError(report, `Verification failed: ${name}`, error);
    }
  }
}

function normalizeDiscoveryResult(value, expectedKind) {
  // Legacy injected adapters in focused tests may still return an array. The
  // runtime adapters return an evidence-bearing result so browser caps cannot
  // be mistaken for a complete zero.
  if (Array.isArray(value)) return { items: value, evidence: { kind: expectedKind, complete: true } };
  if (!value || typeof value !== 'object' || !Array.isArray(value.items)) {
    throw new Error(`${expectedKind} verification returned a malformed discovery result.`);
  }
  const evidence = value.evidence && typeof value.evidence === 'object' ? value.evidence : {};
  const complete =
    evidence.complete === true &&
    evidence.queryResultCapReached !== true &&
    evidence.matchCapReached !== true &&
    !(Number(evidence.queryFailures) > 0) &&
    !(
      Number.isSafeInteger(evidence.queriesPlanned) &&
      Number.isSafeInteger(evidence.queriesRun) &&
      evidence.queriesRun < evidence.queriesPlanned
    );
  return {
    items: value.items,
    evidence: {
      ...evidence,
      kind: evidence.kind || expectedKind,
      complete
    }
  };
}

function verificationFromDiscoveryResult(result, label) {
  const count = result.items.length;
  if (result.evidence.complete === true) return verificationFromCount(count);
  const limitations = Array.isArray(result.evidence.limitations)
    ? result.evidence.limitations.map(String).filter(Boolean)
    : [];
  const reason =
    limitations.join(' ') ||
    `${label} discovery was incomplete, so the observed count is only a lower bound and cannot prove zero.`;
  if (count > 0) {
    return {
      state: 'residue_found',
      count,
      observedCount: count,
      complete: false,
      lowerBound: true,
      reason,
      discoveryEvidence: result.evidence
    };
  }
  return {
    ...verificationUnknown(reason),
    observedCount: 0,
    complete: false,
    lowerBound: true,
    discoveryEvidence: result.evidence
  };
}

function isVerificationEvidence(value) {
  return Boolean(value && typeof value === 'object' && typeof value.state === 'string');
}

function redactUrlForReport(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}/…`;
  } catch {
    return '[invalid-url]';
  }
}

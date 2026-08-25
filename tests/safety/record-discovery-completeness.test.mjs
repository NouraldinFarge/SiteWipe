import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSiteInput } from '../../src/background/domain.js';
import {
  discoverMatchingDownloadsWithEvidence,
  discoverMatchingHistoryWithEvidence
} from '../../src/background/record-discovery.js';
import { discoverCleanupScope, inspectCleanupImpact } from '../../src/background/scope-discovery.js';
import { createReport, finishReport } from '../../src/background/report.js';
import { verifyExposedResidue } from '../../src/background/verification.js';
import { assessReportVerification } from '../../src/sidepanel/report-outcome.js';
import { buildCleanupReview } from '../../src/shared/cleanup-review.js';

function targetFixture() {
  const normalized = normalizeSiteInput('example.com');
  assert.equal(normalized.ok, true);
  return normalized.target;
}

async function withChrome(chromeValue, callback) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: chromeValue });
  try {
    return await callback();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'chrome', descriptor);
    else delete globalThis.chrome;
  }
}

function cappedHistoryInventory() {
  return [
    ...Array.from({ length: 5000 }, (_, index) => ({
      id: `noise-${index}`,
      url: `https://unrelated.test/history/${index}?searched=example.com`,
      title: `example.com distractor ${index}`
    })),
    { id: 'omitted-target', url: 'https://example.com/omitted-target' }
  ];
}

function cappedDownloadInventory() {
  return [
    ...Array.from({ length: 1000 }, (_, index) => ({
      id: index,
      url: `https://unrelated.test/download/${index}?searched=example.com`,
      filename: `C:\\Synthetic\\noise-${index}.bin`
    })),
    {
      id: 1001,
      state: 'complete',
      exists: true,
      url: 'https://example.com/omitted-target.zip',
      filename: 'C:\\Synthetic\\omitted-target.zip'
    }
  ];
}

test('a 5,000-result history window is incomplete even when its exposed matches are zero', async () => {
  const target = targetFixture();
  const inventory = cappedHistoryInventory();
  const result = await withChrome(
    {
      history: {
        search: async ({ maxResults }) => inventory.slice(0, maxResults)
      }
    },
    () => discoverMatchingHistoryWithEvidence(target)
  );

  assert.deepEqual(result.items, []);
  assert.equal(result.evidence.queryResultCapReached, true);
  assert.equal(result.evidence.cappedQueries, result.evidence.queriesPlanned);
  assert.equal(result.evidence.complete, false);
  assert.equal(result.evidence.truncated, true);
  assert.match(result.evidence.limitations.join(' '), /lower bound/i);
});

test('a 1,000-result download window is incomplete and cannot bind on-disk file candidates', async () => {
  const target = targetFixture();
  const historyInventory = cappedHistoryInventory();
  const downloadInventory = cappedDownloadInventory();

  await withChrome(
    {
      tabs: { query: async () => [] },
      history: { search: async ({ maxResults }) => historyInventory.slice(0, maxResults) },
      downloads: { search: async ({ limit }) => downloadInventory.slice(0, limit) }
    },
    async () => {
      const result = await discoverMatchingDownloadsWithEvidence(target);
      assert.deepEqual(result.items, []);
      assert.equal(result.evidence.queryResultCapReached, true);
      assert.equal(result.evidence.complete, false);

      const impact = await inspectCleanupImpact(target);
      assert.equal(impact.matchingHistoryEntries, null);
      assert.equal(impact.matchingHistoryEntriesLowerBound, 0);
      assert.equal(impact.matchingDownloadRecords, null);
      assert.equal(impact.matchingDownloadRecordsLowerBound, 0);
      assert.equal(impact.matchedCompletedFileIds, null);
      assert.equal(impact.matchedCompletedFileCount, null);
      assert.equal(impact.discoveryEvidence.history.complete, false);
      assert.equal(impact.discoveryEvidence.downloads.complete, false);
      assert.match(impact.limitations.join(' '), /lower bound/i);

      const review = buildCleanupReview({
        enteredTarget: 'example.com',
        target,
        settings: { cleanupMode: 'expert', deleteDownloadedFiles: true },
        impact,
        approvalToken: 'capped-impact-review',
        createdAt: '2026-08-24T12:00:00.000Z',
        expiresAt: '2026-08-24T12:05:00.000Z'
      });
      assert.equal(review.effects.removeHistory.matchingCount, null);
      assert.equal(review.effects.removeHistory.matchingCountLowerBound, 0);
      assert.equal(review.effects.removeHistory.countComplete, false);
      assert.equal(review.effects.removeDownloadedFiles.candidateReviewComplete, false);
      assert.equal(review.effects.removeDownloadedFiles.enabled, false);
      assert.match(review.warnings.join(' '), /prevented preflight from proving.*zero matches/i);
      assert.match(
        review.warnings.join(' '),
        /no on-disk file deletion or matching download-record erasure is authorized/i
      );

      const report = createReport(target, 'example.com');
      const context = await discoverCleanupScope(target, report);
      const section = report.sections.find((item) => item.key === 'scopeDiscovery');
      assert.equal(section.status, 'partial');
      assert.equal(section.details.matchingHistoryCountComplete, false);
      assert.equal(section.details.matchingDownloadCountComplete, false);
      assert.equal(section.details.discoveryEvidence.history.complete, false);
      assert.equal(section.details.discoveryEvidence.downloads.complete, false);
      assert.equal(context.discoveryEvidence.history.complete, false);
      assert.equal(context.discoveryEvidence.downloads.complete, false);
    }
  );
});

test('malformed resolved history and download values attach incomplete evidence and never become exact zero', async () => {
  const target = targetFixture();
  for (const scenario of [
    {
      kind: 'history',
      chrome: { history: { search: async () => null } },
      discover: discoverMatchingHistoryWithEvidence,
      pattern: /history\.search returned a non-array/i
    },
    {
      kind: 'downloads',
      chrome: { downloads: { search: async () => ({}) } },
      discover: discoverMatchingDownloadsWithEvidence,
      pattern: /downloads\.search returned a non-array/i
    }
  ]) {
    const error = await withChrome(scenario.chrome, async () => {
      try {
        await scenario.discover(target);
        assert.fail(`${scenario.kind} discovery must reject a malformed resolved value.`);
      } catch (caught) {
        return caught;
      }
    });
    assert.match(error.message, scenario.pattern);
    assert.equal(error.discoveryEvidence.kind, scenario.kind);
    assert.equal(error.discoveryEvidence.complete, false);
    assert.equal(error.discoveryEvidence.truncated, true);
    assert.equal(error.discoveryEvidence.queryFailures, 1);
    assert.match(error.discoveryEvidence.limitations.join(' '), /did not complete every browser query/i);
  }

  await withChrome(
    {
      tabs: { query: async () => [] },
      history: { search: async () => null },
      downloads: { search: async () => ({}) }
    },
    async () => {
      const impact = await inspectCleanupImpact(target);
      assert.equal(impact.matchingHistoryEntries, null);
      assert.equal(impact.matchingDownloadRecords, null);
      assert.equal(impact.discoveryEvidence.history.complete, false);
      assert.equal(impact.discoveryEvidence.downloads.complete, false);
      assert.match(impact.limitations.join(' '), /non-array result/i);
    }
  );
});

test('capped history and download adapters can never produce verified_zero', async () => {
  const target = targetFixture();
  const report = createReport(target, 'example.com');
  const historyInventory = cappedHistoryInventory();
  const downloadInventory = cappedDownloadInventory();

  await withChrome(
    {
      tabs: { query: async () => [] },
      cookies: {},
      history: { search: async ({ maxResults }) => historyInventory.slice(0, maxResults) },
      downloads: { search: async ({ limit }) => downloadInventory.slice(0, limit) }
    },
    () =>
      verifyExposedResidue(
        target,
        report,
        { verificationTimeoutMs: 5_000 },
        {
          discoverCookies: async () => [],
          discoverHistory: discoverMatchingHistoryWithEvidence,
          discoverDownloads: discoverMatchingDownloadsWithEvidence
        }
      )
  );

  assert.equal(report.summary.verificationCategories.history.state, 'unknown');
  assert.equal(report.summary.verificationCategories.history.count, null);
  assert.equal(report.summary.verificationCategories.history.complete, false);
  assert.equal(report.summary.verificationCategories.downloads.state, 'unknown');
  assert.equal(report.summary.verificationCategories.downloads.count, null);
  assert.equal(report.summary.verificationCategories.downloads.complete, false);
  assert.equal(report.summary.verificationStatus, 'incomplete');
  assert.equal(report.summary.verificationAllRequiredChecksSucceeded, false);
  assert.equal(report.summary.verificationNoExposedResidueFound, false);
  assert.equal(report.summary.verificationRemainingTotal, null);
});

test('residue observed through a capped query remains known but its full total stays incomplete', async () => {
  const target = targetFixture();
  const report = createReport(target, 'example.com');
  const incompleteEvidence = {
    kind: 'history',
    // A contradictory adapter claim cannot override concrete cap evidence.
    complete: true,
    queryResultCapReached: true,
    matchCapReached: false,
    limitations: ['History discovery reached a browser query-result limit.']
  };

  await withChrome(
    {
      tabs: { query: async () => [] },
      cookies: {},
      history: { search: async () => [] },
      downloads: { search: async () => [] }
    },
    () =>
      verifyExposedResidue(
        target,
        report,
        { verificationTimeoutMs: 100 },
        {
          discoverCookies: async () => [],
          discoverHistory: async () => ({
            items: [{ url: 'https://example.com/remaining' }],
            evidence: incompleteEvidence
          }),
          discoverDownloads: async () => ({
            items: [],
            evidence: { kind: 'downloads', complete: true }
          })
        }
      )
  );

  assert.equal(report.summary.verificationStatus, 'residue_found');
  assert.equal(report.summary.verificationCategories.history.count, 1);
  assert.equal(report.summary.verificationCategories.history.complete, false);
  assert.equal(report.summary.verificationAllRequiredChecksSucceeded, false);
  assert.equal(report.summary.verificationRemainingTotal, null);
  const assessment = assessReportVerification(report.summary);
  assert.equal(assessment.kind, 'residue_incomplete');
  assert.deepEqual(assessment.incompleteChecks, [{ name: 'history', state: 'capped' }]);
  assert.equal(assessment.knownResidueCount, 1);
  await finishReport(report);
  assert.ok(report.summary.cleanupConfidenceScore <= 65);
  assert.equal(
    report.summary.cleanupConfidenceReasons.some((reason) => /history:residue_found/i.test(reason)),
    true
  );
});

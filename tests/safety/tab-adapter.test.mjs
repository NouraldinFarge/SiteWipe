import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSiteInput } from '../../src/background/domain.js';
import { createReport } from '../../src/background/report.js';
import { auditAndResetTabState, closeMatchingTabs } from '../../src/background/tab-state.js';
import { discoverCleanupScope } from '../../src/background/scope-discovery.js';
import { resolveReviewedSourceContext } from '../../src/shared/target-scope.js';

function targetAndReport() {
  const normalized = normalizeSiteInput('alice.blogspot.com');
  assert.equal(normalized.ok, true);
  return {
    target: normalized.target,
    report: createReport(normalized.target, normalized.input)
  };
}

test('popup source context fails closed unless a window or tab proves id and private state', () => {
  assert.deepEqual(resolveReviewedSourceContext({ id: 7, incognito: true }), {
    sourceWindowId: 7,
    sourceIncognito: true
  });
  assert.deepEqual(resolveReviewedSourceContext(null, { windowId: 8, incognito: false }), {
    sourceWindowId: 8,
    sourceIncognito: false
  });
  assert.throws(() => resolveReviewedSourceContext(null, null), /could not verify this popup window/i);
  assert.throws(
    () => resolveReviewedSourceContext({ id: 7 }, { incognito: false }),
    /could not verify this popup window/i
  );
});

test('tab closure skips a discovered target tab that navigated to a sibling tenant', async () => {
  const { target, report } = targetAndReport();
  const removed = [];
  globalThis.chrome = {
    tabs: {
      get: async (id) =>
        id === 1
          ? { id, url: 'https://bob.blogspot.com/after-discovery', incognito: false }
          : { id, url: 'https://sub.alice.blogspot.com/still-target', incognito: false },
      remove: async (ids) => removed.push(...(Array.isArray(ids) ? ids : [ids]))
    }
  };

  await closeMatchingTabs(target, report, false, {
    matchingTabs: [
      { id: 1, url: 'https://alice.blogspot.com/before-navigation' },
      { id: 2, url: 'https://alice.blogspot.com/still-target' }
    ]
  });

  assert.deepEqual(removed, [2]);
  assert.equal(report.summary.normalTabsClosed, 1);
  const section = report.sections.find((item) => item.key === 'tabs');
  assert.equal(section.details.skippedAfterRevalidation, 1);
});

test('tab-state changes skip candidates that no longer match at mutation time', async () => {
  const { target, report } = targetAndReport();
  const zoomReads = [];
  const zoomWrites = [];
  globalThis.chrome = {
    tabs: {
      get: async (id) =>
        id === 1
          ? { id, url: 'https://unrelated.example/' }
          : { id, url: 'https://alice.blogspot.com/', mutedInfo: { muted: false }, pinned: false },
      getZoom: async (id) => {
        zoomReads.push(id);
        return 1.25;
      },
      getZoomSettings: async () => ({ scope: 'per-origin', mode: 'automatic' }),
      setZoom: async (id, value) => zoomWrites.push([id, value])
    }
  };

  await auditAndResetTabState(
    target,
    report,
    {
      matchingTabs: [
        { id: 1, url: 'https://alice.blogspot.com/before-navigation' },
        { id: 2, url: 'https://alice.blogspot.com/still-target' }
      ]
    },
    { resetZoom: true }
  );

  assert.deepEqual(zoomReads, [2]);
  assert.deepEqual(zoomWrites, [[2, 0]]);
  const section = report.sections.find((item) => item.key === 'tabState');
  assert.equal(section.details.skippedAfterRevalidation, 1);
});

test('Chrome split-view none sentinel is not reported as an active split view', async () => {
  const { target, report } = targetAndReport();
  globalThis.chrome = {
    tabs: {
      get: async (id) => ({
        id,
        url: 'https://alice.blogspot.com/',
        incognito: false,
        mutedInfo: { muted: false },
        pinned: false,
        splitViewId: -1
      }),
      getZoom: async () => 1,
      getZoomSettings: async () => ({ scope: 'per-origin', mode: 'automatic' })
    }
  };

  await auditAndResetTabState(target, report, {
    matchingTabs: [{ id: 9, url: 'https://alice.blogspot.com/' }]
  });

  const details = report.sections.find((item) => item.key === 'tabState').details;
  assert.equal(details.splitViewTabs, 0);
  assert.equal(details.samples[0].splitViewId, null);
  assert.equal(report.summary.targetTabsInSplitView, 0);
});

test('tab discovery excludes private targets when the reviewed scope did not include private access', async () => {
  const { target, report } = targetAndReport();
  globalThis.chrome = {
    tabs: {
      query: async () => [
        { id: 1, url: 'https://alice.blogspot.com/normal', incognito: false },
        { id: 2, url: 'https://alice.blogspot.com/private', incognito: true }
      ]
    }
  };

  const context = await discoverCleanupScope(target, report, { incognitoAccess: false });

  assert.deepEqual(
    context.matchingTabs.map((tab) => tab.id),
    [1]
  );
  assert.equal(report.summary.incognitoScopeObserved, false);
});

test('tab mutation revalidation rejects a private target outside the reviewed scope', async () => {
  const { target, report } = targetAndReport();
  const removed = [];
  const zoomReads = [];
  globalThis.chrome = {
    tabs: {
      get: async (id) => ({
        id,
        url: 'https://alice.blogspot.com/private-after-review',
        incognito: true,
        mutedInfo: { muted: false },
        pinned: false
      }),
      getZoom: async (id) => {
        zoomReads.push(id);
        return 1.5;
      },
      remove: async (id) => removed.push(id)
    }
  };
  const context = { matchingTabs: [{ id: 3, url: 'https://alice.blogspot.com/reviewed' }] };

  await auditAndResetTabState(target, report, context, { incognitoAccess: false, resetZoom: true });
  await closeMatchingTabs(target, report, false, context);

  assert.deepEqual(zoomReads, []);
  assert.deepEqual(removed, []);
  assert.equal(report.summary.normalTabsClosed, 0);
  assert.equal(report.summary.incognitoTabsClosed, 0);
});

test('a timed-out tab close remains an explicit unknown outcome', async () => {
  const { target, report } = targetAndReport();
  let settleRemoval;
  const pendingRemoval = new Promise((resolve) => {
    settleRemoval = resolve;
  });
  globalThis.chrome = {
    tabs: {
      get: async (id) => ({ id, url: 'https://alice.blogspot.com/late-close', incognito: false }),
      remove: async () => pendingRemoval
    }
  };

  await closeMatchingTabs(
    target,
    report,
    false,
    { matchingTabs: [{ id: 11, url: 'https://alice.blogspot.com/reviewed' }] },
    { tabRemoveTimeoutMs: 1 }
  );

  const details = report.sections.find((item) => item.key === 'tabs').details;
  assert.equal(details.failures.length, 0);
  assert.equal(details.timeouts.length, 1);
  assert.equal(details.outcome.failed, 0);
  assert.equal(details.outcome.timedOut, 1);
  assert.equal(details.outcome.unknown, 1);
  assert.equal(report.summary.normalTabsClosed, 0);
  settleRemoval();
  await pendingRemoval;
});

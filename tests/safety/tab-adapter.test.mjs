import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSiteInput } from '../../src/background/domain.js';
import { createReport } from '../../src/background/report.js';
import { auditAndResetTabState, closeMatchingTabs } from '../../src/background/tab-state.js';

function targetAndReport() {
  const normalized = normalizeSiteInput('alice.blogspot.com');
  assert.equal(normalized.ok, true);
  return {
    target: normalized.target,
    report: createReport(normalized.target, normalized.input)
  };
}

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

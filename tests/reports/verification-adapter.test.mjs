import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSiteInput } from '../../src/background/domain.js';
import { createReport } from '../../src/background/report.js';
import { verifyExposedResidue } from '../../src/background/verification.js';

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

function fixture() {
  const normalized = normalizeSiteInput('synthetic.example.com');
  assert.equal(normalized.ok, true);
  return {
    target: normalized.target,
    report: createReport(normalized.target, 'synthetic.example.com')
  };
}

const zeroAdapters = Object.freeze({
  discoverCookies: async () => [],
  discoverHistory: async () => [],
  discoverDownloads: async () => []
});

test('browser verification records verified zero only when all adapters complete', async () => {
  const { target, report } = fixture();
  await withChrome(
    {
      tabs: { query: async () => [] },
      cookies: {},
      history: { search: async () => [] },
      downloads: { search: async () => [] }
    },
    () => verifyExposedResidue(target, report, { verificationTimeoutMs: 50 }, zeroAdapters)
  );

  assert.equal(report.summary.verificationStatus, 'verified_zero');
  assert.equal(report.summary.verificationAllRequiredChecksSucceeded, true);
  assert.equal(report.summary.verificationNoExposedResidueFound, true);
  assert.equal(report.summary.verificationRemainingTotal, 0);
});

test('a missing Chrome API remains not_supported and makes verification incomplete', async () => {
  const { target, report } = fixture();
  await withChrome(
    {
      tabs: { query: async () => [] },
      history: { search: async () => [] },
      downloads: { search: async () => [] }
    },
    () => verifyExposedResidue(target, report, { verificationTimeoutMs: 50 }, zeroAdapters)
  );

  assert.equal(report.summary.verificationCategories.cookies.state, 'not_supported');
  assert.equal(report.summary.verificationStatus, 'incomplete');
  assert.equal(report.summary.verificationRemainingTotal, null);
  assert.equal(report.summary.verificationNoExposedResidueFound, false);
});

test('adapter exceptions remain failed and cannot become a zero count', async () => {
  const { target, report } = fixture();
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
        { verificationTimeoutMs: 50 },
        {
          ...zeroAdapters,
          discoverHistory: async () => {
            throw new Error('synthetic history failure');
          }
        }
      )
  );

  assert.equal(report.summary.verificationCategories.history.state, 'failed');
  assert.equal(report.summary.verificationCategories.history.count, null);
  assert.equal(report.summary.verificationStatus, 'incomplete');
  assert.equal(report.summary.verificationRemainingTotal, null);
});

test('browser API timeout is explicit and the underlying unknown operation is not counted as zero', async () => {
  const { target, report } = fixture();
  await withChrome(
    {
      tabs: { query: () => new Promise(() => {}) },
      cookies: {},
      history: { search: async () => [] },
      downloads: { search: async () => [] }
    },
    () => verifyExposedResidue(target, report, { verificationTimeoutMs: 2 }, zeroAdapters)
  );

  assert.equal(report.summary.verificationCategories.tabs.state, 'timed_out');
  assert.equal(report.summary.verificationCategories.tabs.count, null);
  assert.equal(report.summary.verificationStatus, 'incomplete');
  assert.equal(report.summary.verificationNoExposedResidueFound, false);
});

test('download verification excludes private records outside the reviewed scope', async () => {
  const { target, report } = fixture();
  const adapters = {
    ...zeroAdapters,
    discoverDownloads: async () => [{ id: 30, incognito: true, url: 'https://synthetic.example.com/private.zip' }]
  };
  await withChrome(
    {
      tabs: { query: async () => [] },
      cookies: {},
      history: { search: async () => [] },
      downloads: { search: async () => [] }
    },
    () => verifyExposedResidue(target, report, { verificationTimeoutMs: 50, incognitoAccess: false }, adapters)
  );

  assert.equal(report.summary.verificationCategories.downloads.state, 'verified_zero');
  assert.equal(report.summary.verificationCategories.downloads.count, 0);
});

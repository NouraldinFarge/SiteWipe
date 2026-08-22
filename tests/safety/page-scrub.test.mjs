import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSiteInput } from '../../src/background/domain.js';
import { scrubOpenPageData, pageVisibleStorageScrubber } from '../../src/background/page-scrub.js';
import { createReport } from '../../src/background/report.js';

async function withLocation(locationValue, callback) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: locationValue
  });
  try {
    return await callback();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'location', descriptor);
    else delete globalThis.location;
  }
}

test('live-page scrub rejects a sibling private tenant even when the selected tenant begins with www', async () => {
  const result = await withLocation(
    {
      hostname: 'alice.blogspot.com',
      origin: 'https://alice.blogspot.com',
      pathname: '/synthetic-canary'
    },
    () => pageVisibleStorageScrubber([{ matchMode: 'registrable_domain', domain: 'www.blogspot.com' }])
  );

  assert.equal(result.matched, false);
  assert.equal(result.localStorageCleared, 0);
  assert.deepEqual(result.errors, []);
});

test('live-page scrub exact-origin guard retains scheme and explicit port', async () => {
  const scope = [{ matchMode: 'exact_origin', exactOrigin: 'http://localhost:4317' }];

  const wrongScheme = await withLocation(
    { hostname: 'localhost', origin: 'https://localhost:4317', pathname: '/' },
    () => pageVisibleStorageScrubber(scope)
  );
  const wrongPort = await withLocation({ hostname: 'localhost', origin: 'http://localhost:4318', pathname: '/' }, () =>
    pageVisibleStorageScrubber(scope)
  );

  assert.equal(wrongScheme.matched, false);
  assert.equal(wrongPort.matched, false);
});

test('live-page injection rejects a private tab outside the reviewed scope immediately before mutation', async () => {
  const normalized = normalizeSiteInput('alice.blogspot.com');
  assert.equal(normalized.ok, true);
  const report = createReport(normalized.target, normalized.input);
  const injections = [];
  globalThis.chrome = {
    tabs: {
      get: async (id) => ({ id, url: 'https://alice.blogspot.com/private', incognito: true })
    },
    scripting: {
      executeScript: async (details) => {
        injections.push(details);
        return [];
      }
    }
  };

  await scrubOpenPageData(
    normalized.target,
    report,
    { matchingTabs: [{ id: 9, url: 'https://alice.blogspot.com/reviewed', incognito: false }] },
    { pageScriptScrub: true, incognitoAccess: false }
  );

  assert.deepEqual(injections, []);
  const section = report.sections.find((item) => item.key === 'pageScriptScrub');
  assert.equal(section.details.targetsSkippedAfterRevalidation, 1);
  assert.equal(section.details.tabsAttempted, 0);
});

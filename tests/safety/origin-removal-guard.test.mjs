import test from 'node:test';
import assert from 'node:assert/strict';

import { removeAllowedOriginScopedData, removeOriginScopedStorage } from '../../src/background/origin-storage.js';
import { assertSafeOriginScopedRemoval } from '../../src/shared/safety.js';
import { selectBrowserLevelStorageOrigins } from '../../src/shared/storage-partition-policy.js';

test('origin removal guard accepts only exact canonical http/https origins and allowlisted buckets', () => {
  const safe = assertSafeOriginScopedRemoval(
    {
      origins: ['https://synthetic.example', 'http://localhost:4317'],
      originTypes: { unprotectedWeb: true }
    },
    { localStorage: true, indexedDB: true }
  );
  assert.deepEqual(safe.options.origins, ['https://synthetic.example', 'http://localhost:4317']);
  assert.deepEqual(safe.dataTypes, { localStorage: true, indexedDB: true });

  const reviewedTarget = {
    domain: 'alice.blogspot.com',
    matchMode: 'registrable_domain',
    associatedTargets: [
      {
        domain: 'api.synthetic.example',
        matchMode: 'exact_origin',
        exactOrigin: 'https://api.synthetic.example:8443'
      }
    ]
  };
  assert.doesNotThrow(() =>
    assertSafeOriginScopedRemoval(
      {
        origins: ['https://sub.alice.blogspot.com'],
        originTypes: { unprotectedWeb: true }
      },
      { cache: true },
      reviewedTarget
    )
  );
  assert.doesNotThrow(() =>
    assertSafeOriginScopedRemoval(
      {
        origins: ['https://api.synthetic.example:8443'],
        originTypes: { unprotectedWeb: true }
      },
      { cookies: true },
      reviewedTarget
    )
  );
  assert.throws(
    () =>
      assertSafeOriginScopedRemoval(
        {
          origins: ['https://api.synthetic.example:8443'],
          originTypes: { unprotectedWeb: true }
        },
        { cache: true },
        reviewedTarget
      ),
    /port-safe selected-site scope/
  );
  for (const unrelatedOrigin of [
    'https://bob.blogspot.com',
    'http://api.synthetic.example:8443',
    'https://api.synthetic.example'
  ]) {
    assert.throws(
      () =>
        assertSafeOriginScopedRemoval(
          { origins: [unrelatedOrigin], originTypes: { unprotectedWeb: true } },
          { cache: true },
          reviewedTarget
        ),
      /outside the preflight-bound cleanup target/
    );
  }

  assert.throws(
    () => assertSafeOriginScopedRemoval({ originTypes: { unprotectedWeb: true } }, { localStorage: true }),
    /without explicit target origins/
  );
  assert.throws(
    () =>
      assertSafeOriginScopedRemoval(
        { origins: ['https://synthetic.example'], since: 0, originTypes: { unprotectedWeb: true } },
        { localStorage: true }
      ),
    /time-based/
  );
  assert.throws(
    () =>
      assertSafeOriginScopedRemoval(
        { origins: ['https://user:secret@synthetic.example'], originTypes: { unprotectedWeb: true } },
        { localStorage: true }
      ),
    /non-web or non-origin/
  );
  assert.throws(
    () =>
      assertSafeOriginScopedRemoval(
        { origins: ['https://synthetic.example/path'], originTypes: { unprotectedWeb: true } },
        { localStorage: true }
      ),
    /non-web or non-origin/
  );
  assert.throws(
    () =>
      assertSafeOriginScopedRemoval(
        { origins: ['https://synthetic.example'], originTypes: { unprotectedWeb: true } },
        { formData: true }
      ),
    /outside the SiteWipe allowlist/
  );
  assert.throws(
    () =>
      assertSafeOriginScopedRemoval(
        { origins: ['https://synthetic.example'], originTypes: { extension: true } },
        { localStorage: true }
      ),
    /unsafe browsing-data origin type/
  );
});

test('origin-storage adapter forwards only the safety guard output to Chrome', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const calls = [];
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      browsingData: {
        remove: async (options, dataTypes) => {
          calls.push({ options, dataTypes });
        }
      }
    }
  });
  try {
    await removeAllowedOriginScopedData(
      { origins: ['https://synthetic.example'], originTypes: { protectedWeb: true } },
      { cache: true },
      { domain: 'synthetic.example', matchMode: 'registrable_domain' }
    );
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'chrome', descriptor);
    else delete globalThis.chrome;
  }

  assert.deepEqual(calls, [
    {
      options: { origins: ['https://synthetic.example'], originTypes: { protectedWeb: true } },
      dataTypes: { cache: true }
    }
  ]);
});

test('final origin-storage mutation boundary rejects exact-origin storage but permits the disclosed cookie-only sweep', async () => {
  const target = {
    domain: 'localhost:3000',
    matchMode: 'exact_origin',
    exactHost: 'localhost',
    exactOrigin: 'http://localhost:3000',
    baseOrigins: ['http://localhost:3000'],
    associatedTargets: []
  };
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const calls = [];
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      browsingData: {
        remove: async (options, dataTypes) => calls.push({ options, dataTypes })
      }
    }
  });
  try {
    assert.throws(
      () =>
        removeAllowedOriginScopedData(
          { origins: target.baseOrigins, originTypes: { unprotectedWeb: true } },
          { localStorage: true, indexedDB: true },
          target
        ),
      /port-safe selected-site scope/
    );
    assert.deepEqual(calls, []);
    await removeAllowedOriginScopedData(
      { origins: target.baseOrigins, originTypes: { unprotectedWeb: true } },
      { cookies: true },
      target
    );
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'chrome', descriptor);
    else delete globalThis.chrome;
  }
  assert.deepEqual(calls, [
    {
      options: { origins: target.baseOrigins, originTypes: { unprotectedWeb: true } },
      dataTypes: { cookies: true }
    }
  ]);
});

test('exact-origin cleanup never reaches Chrome browser-level storage removal because ports cannot be preserved', async () => {
  const target = {
    domain: 'localhost:3000',
    matchMode: 'exact_origin',
    exactHost: 'localhost',
    exactOrigin: 'http://localhost:3000',
    baseOrigins: ['http://localhost:3000'],
    associatedTargets: []
  };
  assert.deepEqual(selectBrowserLevelStorageOrigins(target, target.baseOrigins), {
    reviewedOrigins: ['http://localhost:3000'],
    browserOrigins: [],
    skippedExactOrigins: ['http://localhost:3000'],
    registrableScopeCount: 0
  });

  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const calls = [];
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      browsingData: {
        remove: async (options, dataTypes) => calls.push({ options, dataTypes })
      }
    }
  });
  const report = { summary: {}, sections: [], errors: [], unavailable: [] };
  try {
    await removeOriginScopedStorage(target, report, { origins: target.baseOrigins });
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'chrome', descriptor);
    else delete globalThis.chrome;
  }

  assert.deepEqual(calls, []);
  assert.equal(report.summary.storageCleanupAttempted, false);
  assert.equal(report.summary.cacheCleanupAttempted, false);
  assert.equal(report.summary.originStorageExactOriginsSkipped, 1);
  assert.equal(report.sections.find((section) => section.key === 'originStorage')?.status, 'partial');
  assert.match(report.unavailable.map((item) => item.reason).join(' '), /do not preserve port boundaries/i);
});

test('mixed reviewed scope sends only registrable-site origins to Chrome and reports exact-only storage as partial', async () => {
  const target = {
    domain: 'example.com',
    matchMode: 'registrable_domain',
    baseOrigins: ['https://example.com', 'http://localhost:3000'],
    associatedTargets: [
      {
        domain: 'localhost:3000',
        matchMode: 'exact_origin',
        exactHost: 'localhost',
        exactOrigin: 'http://localhost:3000',
        baseOrigins: ['http://localhost:3000']
      }
    ]
  };
  const origins = ['https://app.example.com', 'http://localhost:3000'];
  assert.deepEqual(selectBrowserLevelStorageOrigins(target, origins), {
    reviewedOrigins: origins,
    browserOrigins: ['https://app.example.com'],
    skippedExactOrigins: ['http://localhost:3000'],
    registrableScopeCount: 1
  });

  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const calls = [];
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      browsingData: {
        remove: async (options, dataTypes) => calls.push({ options, dataTypes })
      }
    }
  });
  const report = { summary: {}, sections: [], errors: [], unavailable: [] };
  try {
    await removeOriginScopedStorage(target, report, { origins });
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'chrome', descriptor);
    else delete globalThis.chrome;
  }

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.origins, ['https://app.example.com']);
  assert.equal(report.summary.storageCleanupAttempted, true);
  assert.equal(report.summary.originStorageBrowserOrigins, 1);
  assert.equal(report.summary.originStorageExactOriginsSkipped, 1);
  const section = report.sections.find((item) => item.key === 'originStorage');
  assert.equal(section?.status, 'partial');
  assert.match(section?.details?.partitionSemantics || '', /embedded third parties/i);
  assert.match(section?.details?.exactOriginLimitation || '', /port boundaries/i);
});

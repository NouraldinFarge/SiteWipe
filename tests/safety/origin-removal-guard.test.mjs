import test from 'node:test';
import assert from 'node:assert/strict';

import { removeAllowedOriginScopedData } from '../../src/background/origin-storage.js';
import { assertSafeOriginScopedRemoval } from '../../src/shared/safety.js';

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
        origins: ['https://sub.alice.blogspot.com', 'https://api.synthetic.example:8443'],
        originTypes: { unprotectedWeb: true }
      },
      { cache: true },
      reviewedTarget
    )
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

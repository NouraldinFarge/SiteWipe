import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  assertDirectDevelopmentDependencyTuplesMatchEvidence,
  assertDependencyInventoryMatchesLockfile,
  collectDirectDevelopmentDependencyTuples,
  normalizeDirectDevelopmentDependencyTuples
} from '../../scripts/dependency-license-contract.mjs';

test('dependency evidence must match the exact pre-bump lockfile before it can be rebound', () => {
  const lockfile = '{"lockfileVersion":3}\n';
  const evidence = { lockfileSha256: sha256(lockfile) };
  assert.equal(assertDependencyInventoryMatchesLockfile(evidence, lockfile), evidence.lockfileSha256);
  assert.throws(
    () => assertDependencyInventoryMatchesLockfile(evidence, `${lockfile} `),
    /stale for the pre-bump package-lock/
  );
});

test('direct development evidence binds exact name, version, and license tuples', () => {
  const pkg = { devDependencies: { beta: '2.0.0', alpha: '1.0.0' } };
  const lock = {
    packages: {
      '': { devDependencies: { alpha: '1.0.0', beta: '2.0.0' } },
      'node_modules/alpha': { version: '1.0.0', license: 'MIT', dev: true },
      'node_modules/beta': { version: '2.0.0', license: 'Apache-2.0', dev: true }
    }
  };
  const expected = [
    { name: 'alpha', version: '1.0.0', license: 'MIT' },
    { name: 'beta', version: '2.0.0', license: 'Apache-2.0' }
  ];
  assert.deepEqual(collectDirectDevelopmentDependencyTuples(pkg, lock), expected);
  assert.deepEqual(normalizeDirectDevelopmentDependencyTuples([...expected].reverse()), expected);
  assert.deepEqual(
    assertDirectDevelopmentDependencyTuplesMatchEvidence(pkg, lock, {
      directDevelopmentDependencies: [...expected].reverse()
    }),
    expected
  );
});

test('direct development dependencies reject ranges, missing lock entries, and stale tuples', () => {
  assert.throws(
    () =>
      collectDirectDevelopmentDependencyTuples(
        { devDependencies: { alpha: '^1.0.0' } },
        {
          packages: {
            '': { devDependencies: { alpha: '^1.0.0' } },
            'node_modules/alpha': { version: '1.1.0', license: 'MIT', dev: true }
          }
        }
      ),
    /must be pinned exactly/
  );
  assert.throws(
    () =>
      collectDirectDevelopmentDependencyTuples(
        { devDependencies: { alpha: '1.0.0' } },
        { packages: { '': { devDependencies: { alpha: '1.0.0' } } } }
      ),
    /missing from the lockfile/
  );
  assert.throws(
    () =>
      assertDirectDevelopmentDependencyTuplesMatchEvidence(
        { devDependencies: { alpha: '1.0.0' } },
        {
          packages: {
            '': { devDependencies: { alpha: '1.0.0' } },
            'node_modules/alpha': { version: '1.0.0', license: 'MIT', dev: true }
          }
        },
        { directDevelopmentDependencies: [{ name: 'alpha', version: '0.9.0', license: 'MIT' }] }
      ),
    /name\/version\/license tuples differ/
  );
});

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

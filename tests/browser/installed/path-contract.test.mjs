import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertNativeAbsolutePath,
  isDriveQualifiedWindowsAbsolutePath,
  isNativeLocalAbsolutePath,
  isPortableLocalAbsolutePath
} from './path-contract.mjs';

test('serialized local absolute paths are classified independently of the current host', () => {
  for (const value of ['C:\\sitewipe\\repository', 'D:/sitewipe/browser-runs', '/var/tmp/sitewipe/repository']) {
    assert.equal(isPortableLocalAbsolutePath(value), true, value);
  }
  assert.equal(isDriveQualifiedWindowsAbsolutePath('C:\\sitewipe\\repository'), true);
  assert.equal(isDriveQualifiedWindowsAbsolutePath('D:/sitewipe/browser-runs'), true);
  assert.equal(isDriveQualifiedWindowsAbsolutePath('/var/tmp/sitewipe/repository'), false);
});

test('serialized local absolute paths reject ambiguous or widened authority', () => {
  for (const value of [
    '',
    ' ',
    'relative/path',
    './relative/path',
    '../relative/path',
    'C:drive-relative',
    '\\rooted-without-drive',
    '\\\\server\\share\\sitewipe',
    '\\\\?\\C:\\device-path',
    '//network/share',
    ' C:\\sitewipe\\repository',
    'C:\\sitewipe\\repository ',
    'C:\\sitewipe\0repository'
  ]) {
    assert.equal(isPortableLocalAbsolutePath(value), false, JSON.stringify(value));
    assert.equal(isDriveQualifiedWindowsAbsolutePath(value), false, JSON.stringify(value));
  }
});

test('physical path use remains bound to the current host grammar', () => {
  const nativePath = process.platform === 'win32' ? 'C:\\sitewipe\\repository' : '/var/tmp/sitewipe/repository';
  const foreignPath = process.platform === 'win32' ? '/var/tmp/sitewipe/repository' : 'C:\\sitewipe\\repository';
  assert.equal(isNativeLocalAbsolutePath(nativePath), true);
  assert.equal(isNativeLocalAbsolutePath(foreignPath), false);
  assert.equal(assertNativeAbsolutePath(nativePath, 'Fixture path'), nativePath);
  assert.throws(() => assertNativeAbsolutePath(foreignPath, 'Fixture path'), /current host/);
});

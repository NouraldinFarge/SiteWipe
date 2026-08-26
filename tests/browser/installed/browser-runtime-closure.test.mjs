import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  BROWSER_RUNTIME_CLOSURE_SCHEMA,
  browserRuntimeClosureSummary,
  captureBrowserRuntimeClosure,
  computeBrowserRuntimeSetSha256,
  validateBrowserRuntimeClosure,
  validateBrowserRuntimeSummary
} from './browser-runtime-closure.mjs';

test('browser runtime closure binds every exact physical file and produces a strict summary', async (t) => {
  const parent = await mkdtemp(resolve(tmpdir(), 'sitewipe-browser-runtime-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = resolve(parent, '151.0.7922.174');
  await mkdir(resolve(root, 'locales'), { recursive: true });
  await writeFile(resolve(root, 'chrome.dll'), Buffer.from('runtime dll'));
  await writeFile(resolve(root, 'locales', 'en-US.pak'), Buffer.from('locale pack'));

  const closure = await captureBrowserRuntimeClosure({
    runtimeRootPath: root,
    runtimeVersion: '151.0.7922.174'
  });
  assert.equal(closure.schema, BROWSER_RUNTIME_CLOSURE_SCHEMA);
  assert.equal(closure.fileCount, 2);
  assert.deepEqual(
    closure.files.map(({ relativePath }) => relativePath),
    ['chrome.dll', 'locales/en-US.pak']
  );
  assert.equal(validateBrowserRuntimeClosure(closure), closure);
  const summary = browserRuntimeClosureSummary(closure);
  assert.equal(validateBrowserRuntimeSummary(summary), summary);
  assert.equal(summary.runtimeManifestSha256, closure.manifestSha256);
  assert.match(
    computeBrowserRuntimeSetSha256([
      { name: 'brave', ...summary },
      { name: 'chrome', ...summary }
    ]),
    /^[A-F0-9]{64}$/
  );
});

test('browser runtime closure rejects byte drift, reordered manifests, and widened summaries', async (t) => {
  const parent = await mkdtemp(resolve(tmpdir(), 'sitewipe-browser-runtime-tamper-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = resolve(parent, '151.1.93.138');
  await mkdir(root);
  await writeFile(resolve(root, 'a.bin'), Buffer.from('a'));
  await writeFile(resolve(root, 'b.bin'), Buffer.from('b'));
  const closure = await captureBrowserRuntimeClosure({
    runtimeRootPath: root,
    runtimeVersion: '151.1.93.138'
  });
  assert.throws(() => validateBrowserRuntimeClosure({ ...closure, bytes: closure.bytes + 1 }), /byte total differs/);
  assert.throws(
    () => validateBrowserRuntimeClosure({ ...closure, files: [...closure.files].reverse() }),
    /unique and sorted/
  );
  assert.throws(
    () => validateBrowserRuntimeSummary({ ...browserRuntimeClosureSummary(closure), executablePath: root }),
    /keys differ/
  );
});

test('browser runtime closure rejects multiply linked files and case-insensitive path collisions', async (t) => {
  const parent = await mkdtemp(resolve(tmpdir(), 'sitewipe-browser-runtime-links-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = resolve(parent, '151.0.7922.174');
  await mkdir(root);
  const first = resolve(root, 'runtime.bin');
  await writeFile(first, Buffer.from('runtime'));
  await link(first, resolve(root, 'runtime-copy.bin'));
  await assert.rejects(
    captureBrowserRuntimeClosure({ runtimeRootPath: root, runtimeVersion: '151.0.7922.174' }),
    /multiply linked/
  );

  const caseRoot = resolve(parent, '151.0.7922.175');
  await mkdir(caseRoot);
  await writeFile(resolve(caseRoot, 'A.bin'), Buffer.from('A'));
  try {
    await writeFile(resolve(caseRoot, 'a.bin'), Buffer.from('a'), { flag: 'wx' });
  } catch (error) {
    if (error?.code === 'EEXIST') return;
    throw error;
  }
  await assert.rejects(
    captureBrowserRuntimeClosure({ runtimeRootPath: caseRoot, runtimeVersion: '151.0.7922.175' }),
    /case-insensitive path collision/
  );
});

test('browser runtime closure rejects directory additions during a walk and all final-replay substitutions', async (t) => {
  await t.test('entry added after nested-directory enumeration', async (nested) => {
    const fixture = await createRuntimeFixture(nested, 'walk-addition');
    let mutated = false;
    await assert.rejects(
      captureBrowserRuntimeClosure(
        { runtimeRootPath: fixture.root, runtimeVersion: fixture.runtimeVersion },
        {
          afterDirectoryEnumeration: async ({ currentPath }) => {
            if (mutated || currentPath !== fixture.nestedPath) return;
            mutated = true;
            await writeFile(resolve(fixture.nestedPath, 'late.pak'), Buffer.from('late locale'));
          },
          afterInitialManifest: null
        }
      ),
      /directory drifted/
    );
    assert.equal(mutated, true);
  });

  await t.test('same-byte physical replacement after the initial manifest', async (nested) => {
    const fixture = await createRuntimeFixture(nested, 'replacement');
    const parkedPath = resolve(fixture.parent, 'parked-runtime.bin');
    await assert.rejects(
      captureBrowserRuntimeClosure(
        { runtimeRootPath: fixture.root, runtimeVersion: fixture.runtimeVersion },
        {
          afterDirectoryEnumeration: null,
          afterInitialManifest: async () => {
            await rename(fixture.runtimeFilePath, parkedPath);
            await writeFile(fixture.runtimeFilePath, fixture.runtimeBytes);
          }
        }
      ),
      /identity.*drifted|drifted.*replay/
    );
  });

  await t.test('same-size byte mutation after the initial manifest', async (nested) => {
    const fixture = await createRuntimeFixture(nested, 'same-size');
    const changed = Buffer.alloc(fixture.runtimeBytes.length, 0x5a);
    assert.notDeepEqual(changed, fixture.runtimeBytes);
    await assert.rejects(
      captureBrowserRuntimeClosure(
        { runtimeRootPath: fixture.root, runtimeVersion: fixture.runtimeVersion },
        {
          afterDirectoryEnumeration: null,
          afterInitialManifest: () => writeFile(fixture.runtimeFilePath, changed)
        }
      ),
      /identity or bytes drifted|drifted.*replay/
    );
  });
});

async function createRuntimeFixture(t, name) {
  const parent = await mkdtemp(resolve(tmpdir(), `sitewipe-browser-runtime-${name}-`));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const runtimeVersion = '151.0.7922.174';
  const root = resolve(parent, runtimeVersion);
  const nestedPath = resolve(root, 'locales');
  const runtimeFilePath = resolve(root, 'runtime.bin');
  const runtimeBytes = Buffer.from('exact runtime bytes');
  await mkdir(nestedPath, { recursive: true });
  await writeFile(runtimeFilePath, runtimeBytes);
  await writeFile(resolve(nestedPath, 'en-US.pak'), Buffer.from('locale pack'));
  return { parent, root, runtimeVersion, nestedPath, runtimeFilePath, runtimeBytes };
}

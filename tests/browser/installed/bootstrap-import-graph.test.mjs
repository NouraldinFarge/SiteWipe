import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const installedDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(installedDirectory, '..', '..', '..');
const TARGETS = Object.freeze([
  ['installed-browser CLI core', 'scripts/run-installed-browser-validation-core.mjs'],
  ['unattended coordinator', 'tests/browser/installed/unattended-coordinator.mjs'],
  ['authentic scenario executor', 'tests/browser/installed/authentic-scenario-executor.mjs'],
  ['runtime executor', 'tests/browser/installed/runtime-executor.mjs']
]);

test('preflight module graphs import without resolving or evaluating installed packages', async (subtest) => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'sitewipe-bootstrap-imports-'));
  subtest.after(() => rm(temporary, { recursive: true, force: true }));
  const loaderPath = resolve(temporary, 'builtins-and-relative-only-loader.mjs');
  const requireGuardPath = resolve(temporary, 'builtins-and-relative-only-require.cjs');
  await writeFile(
    loaderPath,
    `export async function resolve(specifier, context, nextResolve) {
  if (
    !specifier.startsWith('node:') &&
    !specifier.startsWith('./') &&
    !specifier.startsWith('../') &&
    !specifier.startsWith('/') &&
    !specifier.startsWith('file:') &&
    !specifier.startsWith('data:')
  ) {
    throw new Error('SITEWIPE_EXTERNAL_BOOTSTRAP_IMPORT_REFUSED:' + specifier);
  }
  return nextResolve(specifier, context);
}
`,
    { encoding: 'utf8', flag: 'wx' }
  );
  await writeFile(
    requireGuardPath,
    `const Module = require('node:module');
const originalLoad = Module._load;
const builtins = new Set(Module.builtinModules.flatMap((name) => [name, 'node:' + name]));
Module._load = function guardedLoad(request, parent, isMain) {
  if (
    !builtins.has(request) &&
    !request.startsWith('./') &&
    !request.startsWith('../') &&
    !request.startsWith('/') &&
    !/^[A-Za-z]:[\\\\/]/.test(request)
  ) {
    throw new Error('SITEWIPE_EXTERNAL_BOOTSTRAP_REQUIRE_REFUSED:' + request);
  }
  return originalLoad.call(this, request, parent, isMain);
};
`,
    { encoding: 'utf8', flag: 'wx' }
  );

  for (const [label, relativePath] of TARGETS) {
    await subtest.test(label, async () => {
      const targetUrl = pathToFileURL(resolve(repositoryRoot, relativePath)).href;
      const invocation = await execFileAsync(
        process.execPath,
        [
          '--no-warnings',
          '--experimental-loader',
          pathToFileURL(loaderPath).href,
          '--require',
          requireGuardPath,
          '--input-type=module',
          '--eval',
          `await import(${JSON.stringify(targetUrl)});`
        ],
        {
          cwd: repositoryRoot,
          env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
          maxBuffer: 1024 * 1024,
          timeout: 30_000,
          windowsHide: true
        }
      );
      assert.equal(invocation.stdout, '');
      assert.equal(invocation.stderr, '');
    });
  }
});

import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  INSTALLED_BROWSER_TOOLCHAIN_CLOSURE_SCHEMA,
  PINNED_PUPPETEER_CORE_VERSION,
  captureInstalledBrowserToolchainClosure,
  computeInstalledBrowserToolchainSetSha256,
  installedBrowserToolchainClosureSummary,
  validateInstalledBrowserToolchainClosure,
  validateInstalledBrowserToolchainSummary,
  verifyInstalledBrowserToolchainClosure
} from './toolchain-closure.mjs';

test('captures only exact reachable production packages and emits a path-free deterministic summary', async (t) => {
  const first = await createToolchainFixture(t, 'first');
  const second = await createToolchainFixture(t, 'second');
  const firstClosure = await captureFixture(first);
  const secondClosure = await captureFixture(second);

  assert.equal(firstClosure.schema, INSTALLED_BROWSER_TOOLCHAIN_CLOSURE_SCHEMA);
  assert.equal(firstClosure.puppeteerVersion, PINNED_PUPPETEER_CORE_VERSION);
  assert.deepEqual(
    firstClosure.packages.map(({ lockPath }) => lockPath),
    [
      'node_modules/@scope/runtime',
      'node_modules/puppeteer-core',
      'node_modules/puppeteer-core/node_modules/nested-runtime'
    ]
  );
  assert.ok(!firstClosure.packages.some(({ name }) => name === 'unrelated-package'));
  assert.equal(validateInstalledBrowserToolchainClosure(firstClosure), firstClosure);
  assert.equal(computeInstalledBrowserToolchainSetSha256(firstClosure), firstClosure.setSha256);
  assert.equal(firstClosure.setSha256, secondClosure.setSha256);
  assert.notEqual(firstClosure.manifestSha256, secondClosure.manifestSha256);

  const summary = installedBrowserToolchainClosureSummary(firstClosure);
  assert.equal(validateInstalledBrowserToolchainSummary(summary), summary);
  assert.deepEqual(Object.keys(summary).sort(), [
    'toolchainBytes',
    'toolchainFileCount',
    'toolchainManifestSha256',
    'toolchainPackageCount',
    'toolchainPuppeteerVersion',
    'toolchainSetSha256'
  ]);
  assert.equal(summary.toolchainPackageCount, 3);
  assert.equal(summary.toolchainPuppeteerVersion, '25.8.0');
  assert.ok(!JSON.stringify(summary).includes(first.root));
  assert.ok(!JSON.stringify(summary).includes(process.version));
});

test('verifier rejects owned-file and relevant lock drift but ignores unrelated package bytes', async (t) => {
  const fixture = await createToolchainFixture(t, 'drift');
  const closure = await captureFixture(fixture);
  await writeFile(resolve(fixture.root, 'node_modules', 'unrelated-package', 'index.js'), 'unrelated drift\n');
  assert.equal(await verifyInstalledBrowserToolchainClosure(closure), closure);

  const runtimeFile = resolve(fixture.root, 'node_modules', '@scope', 'runtime', 'index.js');
  await writeFile(runtimeFile, 'reachable drift\n');
  await assert.rejects(verifyInstalledBrowserToolchainClosure(closure), /drifted/);

  await writeFile(runtimeFile, 'export const runtime = true;\n');
  const lock = JSON.parse(await readFile(fixture.packageLockPath, 'utf8'));
  lock.packages['node_modules/puppeteer-core'].dependencies['@scope/runtime'] = '^1.0.1';
  await writeFile(fixture.packageLockPath, `${JSON.stringify(lock, null, 2)}\n`);
  await assert.rejects(
    verifyInstalledBrowserToolchainClosure(closure),
    /runtime dependency declarations differ|drifted/
  );
});

test('capture rejects additions, replacements, same-size drift, and mutations to earlier packages', async (t) => {
  await t.test('file added after the initial complete manifest', async (nested) => {
    const fixture = await createToolchainFixture(nested, 'replay-addition');
    const packagePath = resolve(fixture.root, 'node_modules', '@scope', 'runtime');
    await assert.rejects(
      captureFixture(fixture, {
        afterInitialManifest: () => writeFile(resolve(packagePath, 'late.js'), 'late addition\n'),
        afterPackageCaptured: null
      }),
      /package manifest drifted|entry set drifted/
    );
  });

  await t.test('same-byte physical replacement after the initial complete manifest', async (nested) => {
    const fixture = await createToolchainFixture(nested, 'replay-replacement');
    const runtimeFile = resolve(fixture.root, 'node_modules', '@scope', 'runtime', 'index.js');
    const runtimeBytes = await readFile(runtimeFile);
    const parkedPath = `${fixture.root}-parked-runtime-index.js`;
    nested.after(() => rm(parkedPath, { force: true }));
    await assert.rejects(
      captureFixture(fixture, {
        afterInitialManifest: async () => {
          await rename(runtimeFile, parkedPath);
          await writeFile(runtimeFile, runtimeBytes);
        },
        afterPackageCaptured: null
      }),
      /directory identity drifted|file identity.*drifted/
    );
  });

  await t.test('same-size byte mutation after the initial complete manifest', async (nested) => {
    const fixture = await createToolchainFixture(nested, 'replay-same-size');
    const runtimeFile = resolve(fixture.root, 'node_modules', '@scope', 'runtime', 'index.js');
    const runtimeBytes = await readFile(runtimeFile);
    const changed = Buffer.alloc(runtimeBytes.length, 0x58);
    assert.notDeepEqual(changed, runtimeBytes);
    await assert.rejects(
      captureFixture(fixture, {
        afterInitialManifest: () => writeFile(runtimeFile, changed),
        afterPackageCaptured: null
      }),
      /package manifest drifted|file identity.*drifted/
    );
  });

  await t.test('earlier package changes while a later package is captured', async (nested) => {
    const fixture = await createToolchainFixture(nested, 'earlier-package');
    const runtimeFile = resolve(fixture.root, 'node_modules', '@scope', 'runtime', 'index.js');
    const runtimeBytes = await readFile(runtimeFile);
    const changed = Buffer.alloc(runtimeBytes.length, 0x59);
    assert.notDeepEqual(changed, runtimeBytes);
    let mutated = false;
    await assert.rejects(
      captureFixture(fixture, {
        afterInitialManifest: null,
        afterPackageCaptured: async ({ lockPath }) => {
          if (mutated || lockPath !== 'node_modules/puppeteer-core') return;
          mutated = true;
          await writeFile(runtimeFile, changed);
        }
      }),
      /file identity drifted before manifest settlement|package manifest drifted/
    );
    assert.equal(mutated, true);
  });
});

test('capture rejects multiply linked package files', async (t) => {
  const fixture = await createToolchainFixture(t, 'hardlink');
  const source = resolve(fixture.root, 'node_modules', '@scope', 'runtime', 'index.js');
  await link(source, resolve(fixture.root, 'node_modules', '@scope', 'runtime', 'copy.js'));
  await assert.rejects(captureFixture(fixture), /multiply linked/);
});

test('capture rejects symbolic package entries when the host supports creating them', async (t) => {
  const fixture = await createToolchainFixture(t, 'symlink');
  const packagePath = resolve(fixture.root, 'node_modules', '@scope', 'runtime');
  try {
    await symlink(resolve(packagePath, 'index.js'), resolve(packagePath, 'alias.js'), 'file');
  } catch (error) {
    if (error?.code === 'EPERM' || error?.code === 'EACCES') {
      t.skip('This host does not permit creation of a disposable symbolic link.');
      return;
    }
    throw error;
  }
  await assert.rejects(captureFixture(fixture), /symbolic link|reparse alias/);
});

test('capture rejects case collisions when the host filesystem can represent them', async (t) => {
  const fixture = await createToolchainFixture(t, 'case-collision');
  const packagePath = resolve(fixture.root, 'node_modules', '@scope', 'runtime');
  await writeFile(resolve(packagePath, 'CASE.js'), 'upper\n');
  try {
    await writeFile(resolve(packagePath, 'case.js'), 'lower\n', { flag: 'wx' });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      t.skip('This host filesystem is case-insensitive.');
      return;
    }
    throw error;
  }
  await assert.rejects(captureFixture(fixture), /case-insensitive file-path collision/);
});

test('capture rejects untracked or missing required dependency installations', async (t) => {
  const untracked = await createToolchainFixture(t, 'untracked');
  const untrackedLock = JSON.parse(await readFile(untracked.packageLockPath, 'utf8'));
  delete untrackedLock.packages['node_modules/@scope/runtime'];
  await writeFile(untracked.packageLockPath, `${JSON.stringify(untrackedLock, null, 2)}\n`);
  await assert.rejects(captureFixture(untracked), /not represented by its exact package-lock path/);

  const missing = await createToolchainFixture(t, 'missing');
  await rm(resolve(missing.root, 'node_modules', '@scope', 'runtime'), { recursive: true });
  await assert.rejects(captureFixture(missing), /Required runtime dependency is not physically installed/);
});

test('capture accepts absent optional edges and rejects package-json graph divergence', async (t) => {
  const fixture = await createToolchainFixture(t, 'optional');
  const closure = await captureFixture(fixture);
  const puppeteer = closure.packages.find(({ name }) => name === 'puppeteer-core');
  assert.deepEqual(
    puppeteer.runtimeDependencies.find(({ name }) => name === 'optional-runtime'),
    {
      kind: 'optionalDependency',
      name: 'optional-runtime',
      requested: '^3.0.0',
      resolvedLockPath: null
    }
  );

  const packageJsonPath = resolve(fixture.root, 'node_modules', 'puppeteer-core', 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  packageJson.dependencies['@scope/runtime'] = '^2.0.0';
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  await assert.rejects(captureFixture(fixture), /runtime dependency declarations differ/);
});

test('strict validators reject reordered, widened, unreachable, and case-colliding manifests', async (t) => {
  const fixture = await createToolchainFixture(t, 'validation');
  const closure = await captureFixture(fixture);
  assert.throws(
    () => validateInstalledBrowserToolchainClosure({ ...closure, packages: [...closure.packages].reverse() }),
    /unique and sorted/
  );
  assert.throws(
    () =>
      validateInstalledBrowserToolchainSummary({
        ...installedBrowserToolchainClosureSummary(closure),
        nodeVersion: process.version
      }),
    /keys differ/
  );

  const duplicated = structuredClone(closure);
  const source = duplicated.packages[0];
  duplicated.packages.splice(1, 0, structuredClone(source));
  duplicated.packageCount += 1;
  duplicated.fileCount += source.fileCount;
  duplicated.bytes += source.bytes;
  assert.throws(() => validateInstalledBrowserToolchainClosure(duplicated), /case-insensitive package-path collision/);

  const unreachable = structuredClone(closure);
  const root = unreachable.packages.find(({ name }) => name === 'puppeteer-core');
  root.runtimeDependencies = root.runtimeDependencies.filter(({ name }) => name !== 'nested-runtime');
  assert.throws(() => validateInstalledBrowserToolchainClosure(unreachable), /outside the reachable runtime graph/);
});

test('capture rejects every puppeteer-core version other than exact 25.8.0', async (t) => {
  const fixture = await createToolchainFixture(t, 'version');
  const lock = JSON.parse(await readFile(fixture.packageLockPath, 'utf8'));
  lock.packages[''].devDependencies['puppeteer-core'] = '25.8.1';
  lock.packages['node_modules/puppeteer-core'].version = '25.8.1';
  await writeFile(fixture.packageLockPath, `${JSON.stringify(lock, null, 2)}\n`);
  const packageJsonPath = resolve(fixture.root, 'node_modules', 'puppeteer-core', 'package.json');
  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
  packageJson.version = '25.8.1';
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  await assert.rejects(captureFixture(fixture), /exact puppeteer-core 25\.8\.0/);
});

async function createToolchainFixture(t, name) {
  const root = await mkdtemp(resolve(tmpdir(), `sitewipe-toolchain-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageLockPath = resolve(root, 'package-lock.json');
  const nodeModulesPath = resolve(root, 'node_modules');
  await mkdir(nodeModulesPath);

  const puppeteerDependencies = {
    '@scope/runtime': '^1.0.0',
    'nested-runtime': '2.0.0'
  };
  const puppeteerOptionalDependencies = { 'optional-runtime': '^3.0.0' };
  const lock = {
    name: 'toolchain-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'toolchain-fixture',
        version: '1.0.0',
        devDependencies: { 'puppeteer-core': '25.8.0' }
      },
      'node_modules/puppeteer-core': {
        version: '25.8.0',
        dependencies: puppeteerDependencies,
        optionalDependencies: puppeteerOptionalDependencies
      },
      'node_modules/@scope/runtime': {
        version: '1.0.0'
      },
      'node_modules/puppeteer-core/node_modules/nested-runtime': {
        version: '2.0.0',
        peerDependencies: { '@scope/runtime': '^1.0.0' }
      },
      'node_modules/optional-runtime': {
        version: '3.0.0',
        optional: true
      },
      'node_modules/unrelated-package': {
        version: '9.0.0'
      }
    }
  };
  await writeFile(packageLockPath, `${JSON.stringify(lock, null, 2)}\n`);
  await writePackage(
    resolve(nodeModulesPath, 'puppeteer-core'),
    {
      name: 'puppeteer-core',
      version: '25.8.0',
      dependencies: puppeteerDependencies,
      optionalDependencies: puppeteerOptionalDependencies
    },
    'export const puppeteer = true;\n'
  );
  await writePackage(
    resolve(nodeModulesPath, '@scope', 'runtime'),
    { name: '@scope/runtime', version: '1.0.0' },
    'export const runtime = true;\n'
  );
  await writePackage(
    resolve(nodeModulesPath, 'puppeteer-core', 'node_modules', 'nested-runtime'),
    {
      name: 'nested-runtime',
      version: '2.0.0',
      peerDependencies: { '@scope/runtime': '^1.0.0' }
    },
    'export const nested = true;\n'
  );
  await writePackage(
    resolve(nodeModulesPath, 'unrelated-package'),
    { name: 'unrelated-package', version: '9.0.0' },
    'export const unrelated = true;\n'
  );
  return { root, packageLockPath, nodeModulesPath };
}

async function writePackage(packagePath, packageJson, source) {
  await mkdir(packagePath, { recursive: true });
  await writeFile(resolve(packagePath, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  await writeFile(resolve(packagePath, 'index.js'), source);
}

function captureFixture(fixture, testHooks = null) {
  return captureInstalledBrowserToolchainClosure(
    {
      packageLockPath: fixture.packageLockPath,
      nodeModulesPath: fixture.nodeModulesPath
    },
    testHooks
  );
}

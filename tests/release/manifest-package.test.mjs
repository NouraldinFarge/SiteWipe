import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FORBIDDEN_PACKAGE_PATTERNS, RUNTIME_FILES } from '../../scripts/release-files.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const src = resolve(root, 'src');

test('manifest version, description, permissions, and entry points satisfy the reviewed contract', async () => {
  const manifest = JSON.parse(await readFile(resolve(src, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, pkg.version);
  assert.ok(manifest.description.length <= 132);
  assert.equal(manifest.minimum_chrome_version, '119');
  assert.equal(Object.hasOwn(manifest, 'host_permissions'), false);
  assert.deepEqual([...manifest.optional_host_permissions].sort(), ['http://*/*', 'https://*/*']);
  assert.deepEqual([...manifest.optional_permissions].sort(), ['webNavigation']);
  assert.deepEqual([...manifest.permissions].sort(), [
    'alarms',
    'browsingData',
    'cookies',
    'declarativeNetRequest',
    'downloads',
    'history',
    'scripting',
    'sidePanel',
    'storage',
    'tabs'
  ]);
  assert.equal(Object.hasOwn(manifest, 'content_scripts'), false);
  assert.equal(Object.hasOwn(manifest, 'externally_connectable'), false);
  assert.match(manifest.content_security_policy.extension_pages, /script-src 'self'/);
  assert.doesNotMatch(manifest.content_security_policy.extension_pages, /unsafe-|https?:/);
});

test('every manifest and extension-page resource exists inside the runtime allowlist', async () => {
  const manifest = JSON.parse(await readFile(resolve(src, 'manifest.json'), 'utf8'));
  const manifestResources = [
    manifest.action.default_popup,
    manifest.background.service_worker,
    manifest.side_panel.default_path,
    manifest.options_page,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon)
  ];
  for (const resource of manifestResources) await assertRuntimeFile(resource);

  for (const htmlPath of RUNTIME_FILES.filter((path) => path.endsWith('.html'))) {
    const html = await readFile(resolve(src, htmlPath), 'utf8');
    for (const match of html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
      const reference = match[1];
      if (!reference || reference.startsWith('#') || /^[a-z]+:/i.test(reference)) continue;
      const absolute = resolve(dirname(resolve(src, htmlPath)), reference);
      const relative = absolute.slice(src.length + 1).replaceAll('\\', '/');
      await assertRuntimeFile(relative);
    }
  }
});

test('all static runtime imports resolve to allowlisted local modules', async () => {
  for (const modulePath of RUNTIME_FILES.filter((path) => path.endsWith('.js'))) {
    const source = await readFile(resolve(src, modulePath), 'utf8');
    for (const match of source.matchAll(/\b(?:import|export)\s+(?:[^'";]+?\s+from\s+)?["']([^"']+)["']/g)) {
      const reference = match[1];
      assert.match(reference, /^\.\.?\//, `${modulePath} has non-local import ${reference}`);
      const resolved = resolve(dirname(resolve(src, modulePath)), reference);
      const relative = resolved.slice(src.length + 1).replaceAll('\\', '/');
      await assertRuntimeFile(relative);
    }
  }
});

test('runtime package allowlist excludes source-only and forbidden material', async () => {
  assert.equal(RUNTIME_FILES[0] <= RUNTIME_FILES.at(-1), true, 'allowlist must be stable and sorted');
  assert.equal(new Set(RUNTIME_FILES).size, RUNTIME_FILES.length);
  assert.equal(RUNTIME_FILES.includes('manifest.json'), true);
  for (const path of RUNTIME_FILES) {
    assert.equal(
      FORBIDDEN_PACKAGE_PATTERNS.some((pattern) => pattern.test(path)),
      false,
      path
    );
    assert.equal(path.includes('..'), false);
    assert.equal(path.startsWith('/'), false);
    await assertRuntimeFile(path);
  }
  for (const forbidden of ['package.json', 'README.md', 'test-harness/release-selftest.mjs']) {
    assert.equal(RUNTIME_FILES.includes(forbidden), false);
  }
});

test('runtime pages contain no inline handlers, inline scripts, or remote resources', async () => {
  for (const path of RUNTIME_FILES.filter((item) => /\.(?:html|css)$/.test(item))) {
    const source = await readFile(resolve(src, path), 'utf8');
    assert.doesNotMatch(source, /\son[a-z]+\s*=/i, path);
    assert.doesNotMatch(source, /<(?:script|link)\b[^>]*(?:src|href)=["'](?:https?:)?\/\//i, path);
    assert.doesNotMatch(source, /url\(\s*["']?(?:https?:)?\/\//i, path);
    if (path.endsWith('.html')) {
      assert.doesNotMatch(source, /<script\b(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/i, path);
    }
  }
});

async function assertRuntimeFile(relative) {
  assert.equal(RUNTIME_FILES.includes(relative), true, `${relative} is not in the runtime allowlist`);
  const info = await stat(resolve(src, relative));
  assert.equal(info.isFile(), true, relative);
  assert.ok(info.size > 0, relative);
}

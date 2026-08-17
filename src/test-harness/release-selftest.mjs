import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';

const storage = new Map();
const dnrUpdates = [];

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter((key) => storage.has(key)).map((key) => [key, clone(storage.get(key))]));
      },
      async set(values) {
        for (const [key, value] of Object.entries(values)) storage.set(key, clone(value));
      }
    }
  },
  declarativeNetRequest: {
    async updateSessionRules(options) {
      dnrUpdates.push(clone(options));
    }
  }
};

const { APP, DEFAULT_SETTINGS, STORAGE_KEYS } = await import('../shared/constants.js');
const { applyAssociatedDomainGroups, normalizeSiteInput, runDomainSelfTests } = await import('../background/domain.js');
const { createReport, finishReport } = await import('../background/report.js');
const { verifyReportIntegrity } = await import('../shared/report-integrity.js');
const { assertSafeOriginScopedRemoval, findProtectedBrowserServiceTargets } = await import('../shared/safety.js');
const { getEffectiveCleanupSettings } = await import('../shared/cleanup-mode.js');
const { normalizeStoredSettings, saveReport } = await import('../shared/storage.js');
const { buildPageScrubScope, matchingOriginFromUrl, matchingOriginsForHost } =
  await import('../shared/target-scope.js');
const { buildTemporaryDnrShieldRules, replaceSiteWipeDnrShieldRules } = await import('../background/cleanup.js');

const domainResults = runDomainSelfTests();
assert.equal(domainResults.ok, true, 'domain self-tests must pass');

const targetResult = normalizeSiteInput('https://app.example.com/path');
assert.equal(targetResult.ok, true, 'example target must normalize');

const safeRemoval = assertSafeOriginScopedRemoval(
  { origins: ['https://example.com'], originTypes: { unprotectedWeb: true } },
  { cache: true, localStorage: true, serviceWorkers: true }
);
assert.deepEqual(
  Object.keys(safeRemoval.dataTypes).sort(),
  ['cache', 'localStorage', 'serviceWorkers'],
  'only allowlisted origin-scoped data types may be removed'
);
assert.throws(
  () =>
    assertSafeOriginScopedRemoval(
      {
        origins: ['https://example.com'],
        originTypes: { unprotectedWeb: true }
      },
      { passwords: true }
    ),
  /allowlist/,
  'password removal must be rejected'
);
assert.throws(
  () =>
    assertSafeOriginScopedRemoval(
      {
        origins: ['https://example.com'],
        originTypes: { unprotectedWeb: true }
      },
      { formData: true }
    ),
  /allowlist/,
  'autofill/payment form-data removal must be rejected'
);
assert.throws(
  () => assertSafeOriginScopedRemoval({ since: 0, originTypes: { unprotectedWeb: true } }, { cache: true }),
  /explicit target origins/,
  'global time-based removal must be rejected'
);

const protectedTarget = normalizeSiteInput('accounts.google.com');
assert.equal(
  findProtectedBrowserServiceTargets(protectedTarget.target).length > 0,
  true,
  'browser Sync service target must be blocked'
);
assert.equal(
  findProtectedBrowserServiceTargets(targetResult.target).length,
  0,
  'ordinary website target must remain eligible'
);

const standardSettings = getEffectiveCleanupSettings({
  cleanupMode: 'standard',
  skipCleanupReview: true,
  overlayScope: 'all_tabs',
  deleteDownloadedFiles: true,
  associatedDomainGroups: 'example.com => cdn.example.net'
});
assert.equal(standardSettings.overlayScope, 'target_tabs', 'standard mode must limit page overlays to target tabs');
assert.equal(standardSettings.deleteDownloadedFiles, false, 'standard mode must disable downloaded-file deletion');
assert.equal(standardSettings.associatedDomainGroups, '', 'standard mode must disable associated-domain expansion');
assert.equal(
  Object.hasOwn(standardSettings, 'skipCleanupReview'),
  false,
  'standard mode must discard the retired cleanup-review bypass'
);
const expertSettings = getEffectiveCleanupSettings({
  cleanupMode: 'expert',
  skipCleanupReview: true,
  overlayScope: 'current_window',
  associatedDomainGroups: 'example.com => cdn.example.net',
  mainWorldPageScrub: true
});
assert.equal(expertSettings.overlayScope, 'current_window', 'expert mode must retain the selected overlay scope');
assert.equal(
  Object.hasOwn(expertSettings, 'skipCleanupReview'),
  false,
  'expert mode must also discard the retired cleanup-review bypass'
);
assert.equal(
  expertSettings.associatedDomainGroups,
  'example.com => cdn.example.net',
  'expert mode must retain reviewed associated-domain groups exactly'
);
assert.equal(
  expertSettings.mainWorldPageScrub,
  false,
  'legacy profiles must never reactivate MAIN-world destructive scripts'
);

const migratedSettings = normalizeStoredSettings(
  {
    deleteAutofill: true,
    overlayScope: 'invalid',
    cleanupMode: 'unexpected',
    keepHistory: 'true',
    skipCleanupReview: true,
    createdAt: 'not-a-date'
  },
  '2026-08-01T00:00:00.000Z'
);
assert.equal(
  Object.prototype.hasOwnProperty.call(migratedSettings, 'deleteAutofill'),
  false,
  'retired unsafe autofill setting must be dropped from stored settings'
);
assert.equal(migratedSettings.overlayScope, 'target_tabs', 'invalid stored overlay scope must fall back safely');
assert.equal(migratedSettings.cleanupMode, 'standard', 'invalid stored cleanup mode must fall back safely');
assert.equal(migratedSettings.keepHistory, true, 'known boolean strings must be sanitized');
assert.equal(
  Object.hasOwn(migratedSettings, 'skipCleanupReview'),
  false,
  'legacy cleanup-review bypass settings must be dropped during migration'
);
assert.equal(migratedSettings.createdAt, '2026-08-01T00:00:00.000Z', 'invalid stored timestamps must be repaired');

const associated = applyAssociatedDomainGroups(targetResult.target, 'example.com => http://localhost:3000', {
  allowLocalTargets: true
});
assert.equal(associated.errors.length, 0, 'associated exact-origin test target must parse');
const scrubScope = buildPageScrubScope(associated.target);
assert.deepEqual(
  scrubScope,
  [
    { matchMode: 'registrable_domain', domain: 'example.com' },
    { matchMode: 'exact_origin', exactOrigin: 'http://localhost:3000' }
  ],
  'page scrub scope must preserve associated exact-origin boundaries'
);
assert.equal(
  matchingOriginFromUrl('http://localhost:3000/path', associated.target),
  'http://localhost:3000',
  'associated exact origin must be discovered'
);
assert.equal(
  matchingOriginFromUrl('http://localhost:4000/path', associated.target),
  null,
  'wrong associated port must not be broadened'
);
assert.deepEqual(
  matchingOriginsForHost('localhost', associated.target),
  ['http://localhost:3000'],
  'cookie-host discovery must retain the exact associated origin'
);

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(manifest.version, '1.11.6', 'manifest version must match this release');
assert.equal(packageJson.version, manifest.version, 'package and manifest versions must match');
assert.equal(APP.version, manifest.version, 'runtime and manifest versions must match');
assert.equal(manifest.permissions.includes('bookmarks'), false, 'bookmark permission must never be requested');
assert.equal(
  manifest.permissions.includes('identity'),
  false,
  'browser-account identity permission must never be requested'
);
for (const permission of ['management', 'nativeMessaging', 'privacy', 'webRequest', 'webRequestBlocking']) {
  assert.equal(
    manifest.permissions.includes(permission),
    false,
    `unneeded high-impact permission must not be requested: ${permission}`
  );
}
assert.equal(
  Object.prototype.hasOwnProperty.call(manifest, 'host_permissions'),
  false,
  'install-time host access must not be required'
);
assert.deepEqual(
  manifest.optional_host_permissions,
  ['http://*/*', 'https://*/*'],
  'runtime host grants must be limited to web schemes and requested as target-specific subsets'
);
assert.deepEqual(
  manifest.optional_permissions,
  ['webNavigation'],
  'embedded-frame discovery must be the only optional named permission'
);
assert.equal(
  manifest.permissions.includes('contentSettings'),
  false,
  'retired content-setting migration permission must not remain'
);
assert.equal(
  manifest.permissions.includes('sessions'),
  false,
  'recently-closed discovery must not justify a default sessions permission'
);
assert.equal(
  manifest.permissions.includes('webNavigation'),
  false,
  'embedded-frame discovery permission must not be required at install time'
);
assert.ok(
  manifest.description.length <= 132,
  `manifest description must be at most 132 characters, received ${manifest.description.length}`
);
assert.equal(
  manifest.incognito,
  'spanning',
  'normal and approved incognito windows must share the cleanup service worker'
);
assert.doesNotMatch(
  manifest.content_security_policy?.extension_pages || '',
  /unsafe-eval|https?:/i,
  'extension-page CSP must forbid eval and remote script sources'
);

const referencedFiles = [
  manifest.action?.default_popup,
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  manifest.options_page,
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {})
].filter(Boolean);
for (const path of new Set(referencedFiles)) {
  const info = await stat(new URL(`../${path}`, import.meta.url));
  assert.equal(info.isFile(), true, `manifest reference must exist: ${path}`);
}
for (const [declaredSize, path] of Object.entries(manifest.icons || {})) {
  const bytes = await readFile(new URL(`../${path}`, import.meta.url));
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `icon must be a valid PNG: ${path}`);
  assert.equal(bytes.readUInt32BE(16), Number(declaredSize), `icon width must match manifest size: ${path}`);
  assert.equal(bytes.readUInt32BE(20), Number(declaredSize), `icon height must match manifest size: ${path}`);
}

const runtimeSources = await Promise.all(
  [
    '../background/cleanup.js',
    '../background/service-worker.js',
    '../shared/constants.js',
    '../shared/safety.js',
    '../shared/storage.js',
    '../popup/popup.js',
    '../popup/popup.html',
    '../options/options.js',
    '../options/options.html',
    '../sidepanel/sidepanel.js'
  ].map(async (path) => [path, await readFile(new URL(path, import.meta.url), 'utf8')])
);
const joinedRuntimeSources = runtimeSources.map(([, source]) => source).join('\n');
assert.doesNotMatch(
  joinedRuntimeSources,
  /\bdeleteAutofill\b|formData\s*:\s*true/,
  'runtime must not expose global autofill/payment form-data deletion'
);
const sidePanelSource = runtimeSources.find(([path]) => path.endsWith('sidepanel.js'))[1];
assert.match(
  sidePanelSource,
  /confirmSensitiveExport/,
  'full report exports must require an explicit sensitive-data warning'
);
const serviceWorkerSource = runtimeSources.find(([path]) => path.endsWith('service-worker.js'))[1];
assert.match(
  serviceWorkerSource,
  /maintenanceStatus:\s*await getMaintenanceStatusSnapshot\(/,
  'state reads must use the read-only maintenance snapshot'
);
assert.doesNotMatch(
  serviceWorkerSource,
  /runMaintenanceCycle\(["']state-read["']/,
  'state reads must not run maintenance or write maintenance snapshots'
);
assert.match(
  serviceWorkerSource,
  /if \(isActiveRunningJob\(activeJob\)\) return false;/,
  'maintenance must not misclassify a shield being installed by a live cleanup as orphaned'
);
for (const [path, source] of runtimeSources.filter(([path]) => path.endsWith('.html'))) {
  assert.doesNotMatch(source, /<script[^>]+src=["']https?:/i, `extension page must not load remote scripts: ${path}`);
  assert.doesNotMatch(source, /\son[a-z]+\s*=/i, `extension page must not use inline event handlers: ${path}`);
}

for (const [htmlPath, jsPath] of [
  ['../popup/popup.html', '../popup/popup.js'],
  ['../options/options.html', '../options/options.js'],
  ['../sidepanel/sidepanel.html', '../sidepanel/sidepanel.js']
]) {
  const html = await readFile(new URL(htmlPath, import.meta.url), 'utf8');
  const js = await readFile(new URL(jsPath, import.meta.url), 'utf8');
  const ids = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]));
  const queriedIds = new Set([...js.matchAll(/querySelector\(["']#([A-Za-z][\w:-]*)["']\)/g)].map((match) => match[1]));
  for (const id of queriedIds) assert.equal(ids.has(id), true, `${jsPath} references missing #${id}`);
  const localResources = [...html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((path) => path && !path.startsWith('#') && !/^[a-z]+:/i.test(path));
  for (const path of localResources) {
    const info = await stat(new URL(path, new URL(htmlPath, import.meta.url)));
    assert.equal(info.isFile(), true, `${htmlPath} references missing local resource ${path}`);
  }
}

const report = createReport(targetResult.target, targetResult.input);
await finishReport(report);
assert.equal(report.status, 'completed', 'finalized reports must receive their final status before hashing');
assert.equal(
  Object.prototype.hasOwnProperty.call(report.summary, 'autofillFormDataRemovalEnabled'),
  false,
  'new reports must not retain retired autofill deletion fields'
);
assert.equal(await verifyReportIntegrity(report), true, 'finalized report checksum must verify');

await chrome.storage.local.set({
  [STORAGE_KEYS.settings]: {
    ...DEFAULT_SETTINGS,
    redactReports: true,
    keepHistory: true
  }
});
await saveReport(report);
const storedReport = storage.get(STORAGE_KEYS.activeReport);
assert.equal(storedReport.redacted, true, 'stored report must be redacted when configured');
assert.equal(await verifyReportIntegrity(storedReport), true, 'redacted report checksum must be recomputed and verify');

const shield = buildTemporaryDnrShieldRules(targetResult.target);
assert.equal(shield.rules.length, 1, 'one ordinary target requires one blocking shield rule');
assert.equal(shield.rules[0].action.type, 'block', 'shield rule must block requests');
assert.equal(
  shield.rules.some((rule) => rule.action.type === 'upgradeScheme'),
  false,
  'blocking shields must not add redundant upgrade rules'
);
await replaceSiteWipeDnrShieldRules(shield.rules);
assert.equal(dnrUpdates.length, 1, 'shield replacement must issue one atomic DNR update');
assert.equal(dnrUpdates[0].removeRuleIds.length, 500, 'shield replacement must clear the complete SiteWipe rule range');
assert.deepEqual(dnrUpdates[0].addRules, shield.rules, 'shield replacement must install the generated rules');

console.log('SiteWipe release self-test: all checks passed.');

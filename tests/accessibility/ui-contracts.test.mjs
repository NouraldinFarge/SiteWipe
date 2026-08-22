import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../src/', import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('Options groups controls, wires visible labels/help, and exposes live outcomes', async () => {
  const [html, script] = await Promise.all([source('options/options.html'), source('options/options.js')]);
  assert.ok((html.match(/<fieldset\b/g) || []).length >= 4);
  assert.ok((html.match(/<legend\b/g) || []).length >= 4);
  assert.match(html, /id="toast"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(
    html,
    /id="associatedDomainGroups"[^>]+aria-describedby="associatedGroupsDiagnostics"[^>]+aria-invalid="false"/
  );
  assert.match(script, /function wireSettingAccessibility\(\)/);
  assert.match(script, /control\.setAttribute\('aria-labelledby'/);
  assert.match(script, /control\.setAttribute\('aria-describedby'/);
  assert.match(script, /associatedDomainGroups'\)\.setAttribute\('aria-invalid'/);
});

test('Options explains alarms and mirrors running-cleanup safeguards accessibly', async () => {
  const [html, script] = await Promise.all([source('options/options.html'), source('options/options.js')]);
  assert.match(script, /'alarms',[\s\S]*?Schedules extension-local maintenance/);
  assert.match(html, /id="activeJobText"[^>]+role="status"[^>]+aria-live="polite"[^>]+tabindex="-1"/);
  for (const id of ['clearShield', 'repairShield', 'runMaintenanceNow', 'resetExtensionState', 'resetSettings']) {
    assert.match(script, new RegExp(`'${id}'`));
  }
  assert.match(script, /cleanupJobRunning = job\?\.status === 'running'/);
  assert.match(script, /control\.setAttribute\('aria-disabled', String\(control\.disabled\)\)/);
  assert.match(script, /document\.querySelector\('#activeJobText'\)\.focus\(\)/);
  assert.match(script, /manual maintenance are disabled until this cleanup stops/);
});

test('Options makes embedded-frame discovery a fresh Expert-only permission choice', async () => {
  const [script, permissionLifecycle] = await Promise.all([
    source('options/options.js'),
    source('options/permission-lifecycle.js')
  ]);
  assert.match(script, /if \(!expert\) \{[\s\S]*?setChecked\('embeddedFrameDiscovery', false\)/);
  assert.match(script, /setValue\('overlayScope', 'target_tabs'\)/);
  assert.match(script, /'overlayScope',\s*'resetMutedTabs'/);
  assert.match(script, /if \(!isExpertCleanupMode\(settings\.cleanupMode\)\)/);
  assert.match(script, /settings\.embeddedFrameDiscovery && currentSettings\?\.embeddedFrameDiscovery !== true/);
  assert.match(script, /requestOptionalPermissionWithProvenance\('webNavigation', \{/);
  assert.match(script, /observedBeforeGesture: webNavigationPermissionObservation/);
  assert.match(script, /observeOptionalPermission\('webNavigation'\)/);
  assert.match(script, /reconcileNewOptionalPermissionGrant\(\{/);
  assert.doesNotMatch(script, /chrome\.permissions\.remove\(/);
  const requestStart = permissionLifecycle.indexOf('export async function requestOptionalPermissionWithProvenance');
  const reconcileStart = permissionLifecycle.indexOf(
    'export async function reconcileNewOptionalPermissionGrant',
    requestStart
  );
  const requestBody = permissionLifecycle.slice(requestStart, reconcileStart);
  assert.ok(requestStart >= 0 && reconcileStart > requestStart);
  assert.match(requestBody, /await permissionsApi\.request\(request\)/);
  assert.doesNotMatch(requestBody, /permissionsApi\.contains\(request\)/);
  assert.match(permissionLifecycle, /permissionsApi\.contains\(request\)/);
  assert.match(permissionLifecycle, /grantProvenance/);
  assert.match(permissionLifecycle, /grant_provenance_unknown/);
  assert.match(permissionLifecycle, /authoritativeFeatureEnabled/);
  assert.match(permissionLifecycle, /permissionsApi\.remove\(request\)/);
});

test('Options operational refreshes preserve unsaved settings-panel drafts', async () => {
  const script = await source('options/options.js');
  assert.match(script, /pendingSettingsPanelRefresh \|\|= changedKeys\.includes\(STORAGE_KEYS\.settings\)/);
  assert.match(script, /void refresh\(\{ renderSettingsPanel \}\)/);
  assert.match(script, /async function refresh\(\{ renderSettingsPanel = true \} = \{\}\)/);
  assert.match(script, /if \(renderSettingsPanel\) renderSettings\(state\.settings\)/);
});

test('Options keeps the prerelease warning readable when its content column narrows', async () => {
  const css = await source('options/options.css');
  assert.match(
    css,
    /@media \(max-width: 1100px\) \{\s*\.options-shell \.candidate-notice \{\s*display: grid;\s*align-items: stretch;\s*gap: 4px;/
  );
  assert.match(
    css,
    /\.options-shell \.candidate-notice strong,\s*\.options-shell \.candidate-notice span \{\s*min-width: 0;\s*max-width: 100%;\s*overflow-wrap: anywhere;/
  );
});

test('side panel implements the ARIA tab pattern and full keyboard navigation', async () => {
  const [html, script] = await Promise.all([source('sidepanel/sidepanel.html'), source('sidepanel/sidepanel.js')]);
  assert.match(html, /role="tablist"/);
  assert.equal((html.match(/role="tab"/g) || []).length, 4);
  assert.equal((html.match(/role="tabpanel"/g) || []).length, 4);
  assert.equal((html.match(/aria-selected="false"/g) || []).length, 3);
  assert.match(script, /event\.key === 'ArrowRight'/);
  assert.match(script, /event\.key === 'ArrowLeft'/);
  assert.match(script, /event\.key === 'Home'/);
  assert.match(script, /event\.key === 'End'/);
  assert.match(script, /item\.tabIndex = active \? 0 : -1/);
  assert.doesNotMatch(script, /alert\(/);
});

test('popup exposes required and invalid states for destructive approval controls', async () => {
  const [html, script, css] = await Promise.all([
    source('popup/popup.html'),
    source('popup/popup.js'),
    source('popup/popup.css')
  ]);
  assert.match(html, /id="targetInput"[^>]+required[^>]+aria-required="true"/);
  assert.match(html, /id="reviewScopeAcknowledge"[^>]+required[^>]+aria-required="true"/);
  assert.match(script, /fileInput\.setAttribute\('aria-invalid'/);
  assert.match(script, /input\.setAttribute\('aria-required'/);
  assert.match(html, /aria-label="Open options"/);
  assert.match(
    css,
    /\.active-tab-copy span \{\s*display: -webkit-box;\s*-webkit-box-orient: vertical;\s*-webkit-line-clamp: 3;[\s\S]*?white-space: normal;\s*overflow-wrap: anywhere;/
  );
});

test('popup preserves a definite extension width and reflows long review content in a narrow synthetic container', async () => {
  const [css, browserFixture] = await Promise.all([
    source('popup/popup.css'),
    source('../tests/browser/fixtures/popup-browser-mock.js')
  ]);

  assert.match(css, /html,\s*body \{\s*width: 380px;\s*max-width: 380px;/);
  assert.match(
    css,
    /\.popup-shell \{[\s\S]*?width: 100%;[\s\S]*?max-width: 380px;[\s\S]*?overflow: hidden auto;[\s\S]*?container: popup \/ inline-size;/
  );
  assert.match(
    css,
    /\.popup-shell \.candidate-notice \{\s*display: grid;\s*min-width: 0;\s*align-items: stretch;\s*gap: 4px;/
  );
  assert.match(
    css,
    /\.popup-shell \.candidate-notice strong,\s*\.popup-shell \.candidate-notice span \{\s*min-width: 0;\s*max-width: 100%;\s*overflow-wrap: anywhere;/
  );
  assert.match(browserFixture, /const simulatedPopupWidth = 380 \/ simulatedZoomScale;/);
  assert.match(browserFixture, /document\.documentElement\.style\.width = `\$\{simulatedPopupWidth\}px`;/);
  assert.match(browserFixture, /document\.body\.style\.width = `\$\{simulatedPopupWidth\}px`;/);
  assert.match(css, /@container popup \(max-width: 280px\) \{/);
  assert.match(css, /\.brand,[\s\S]*?\.review-effect \{\s*flex-direction: column;\s*align-items: stretch;/);
  assert.match(css, /\.review-facts > div,[\s\S]*?\.review-actions \{\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(css, /\.check-row \{\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(
    css,
    /\.help-text,\s*\.error-text \{\s*min-width: 0;\s*max-width: 100%;\s*overflow-wrap: anywhere;\s*word-break: break-all;/
  );
  assert.match(
    css,
    /\.review-facts dd \{[\s\S]*?min-width: 0;[\s\S]*?overflow-wrap: anywhere;[\s\S]*?word-break: break-all;/
  );
  assert.match(
    css,
    /\.review-list li \{\s*min-width: 0;\s*max-width: 100%;\s*overflow-wrap: anywhere;\s*word-break: break-all;/
  );
  assert.match(
    css,
    /\.review-effect strong \{\s*min-width: 0;[\s\S]*?overflow-wrap: anywhere;\s*word-break: break-all;/
  );
});

test('popup visibly and accessibly renders exact reviewed host-permission patterns with safe DOM APIs', async () => {
  const [html, script, css] = await Promise.all([
    source('popup/popup.html'),
    source('popup/popup.js'),
    source('popup/popup.css')
  ]);
  assert.match(html, /id="reviewHostPermissionOriginsHeading">Target site-access patterns/);
  assert.match(html, /id="reviewBroadHostPermissionOriginsHeading">Broader pre-existing site access/);
  assert.match(
    html,
    /id="reviewHostPermissionOrigins"[\s\S]*?aria-labelledby="reviewHostPermissionOriginsHeading"[\s\S]*?aria-describedby="reviewHostPermissionOriginsSummary"/
  );

  const start = script.indexOf('function renderHostPermissionOrigins(review)');
  const end = script.indexOf('async function discardCleanupReview', start);
  const renderer = script.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(renderer, /review\.requiredHostPermissionOrigins/);
  assert.match(renderer, /inventory\.broadGrantedHostPermissionOrigins/);
  assert.match(renderer, /#reviewHostPermissionOriginsSummary'\)\.textContent/);
  assert.match(renderer, /#reviewBroadHostPermissionOriginsSummary'\)\.textContent/);
  assert.match(renderer, /replaceList\(\s*'#reviewHostPermissionOrigins'/);
  assert.match(renderer, /replaceList\('#reviewBroadHostPermissionOrigins', broadOrigins\)/);
  assert.doesNotMatch(renderer, /innerHTML|outerHTML|insertAdjacentHTML/);
  assert.match(script, /li\.textContent = String\(item\)/);
  assert.match(css, /\.review-permission-origins li \{[\s\S]*?overflow-wrap: anywhere;/);
});

test('popup detailed review visibly identifies Standard or Expert mode', async () => {
  const [html, script] = await Promise.all([source('popup/popup.html'), source('popup/popup.js')]);
  assert.match(html, /<dt>Cleanup mode<\/dt>\s*<dd id="reviewCleanupMode"><\/dd>/);
  assert.match(
    script,
    /#reviewCleanupMode'\)\.textContent = review\.settingsSnapshot\?\.cleanupMode === 'expert' \? 'Expert' : 'Standard'/
  );
});

test('popup invalidates detailed and direct preparation when stored settings change', async () => {
  const script = await source('popup/popup.js');
  const start = script.indexOf('function handleStoredSettingsChange(settings)');
  const end = script.indexOf('function renderIncognito', start);
  const handler = script.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(handler, /detailedReviewWasActive = Boolean\(cleanupReview\)/);
  assert.match(handler, /directReviewWasActive = Boolean\(directCleanupReview \|\| directPreparationPending\)/);
  assert.match(handler, /reviewInvalidatedBySettings = true/);
  assert.match(handler, /discardCleanupReview\(\{ announce: false, focus: false \}\)/);
  assert.match(handler, /announceSettingsChangedReview\(\)/);
  assert.match(handler, /discardDirectCleanupPreparation\(\{ settleLease: !permissionPromptInFlight \}\)/);
  assert.match(handler, /prepareDirectCleanup\(qs\('#targetInput'\)\.value\.trim\(\)\)/);
  assert.match(script, /\(direct \? directCleanupReview : cleanupReview\) !== review/);
  assert.match(script, /Settings changed\. No cleanup started\. Review the current scope again before approving\./);
  assert.match(script, /handedOffPromptIsWorkerOwned/);
  assert.match(script, /announceSettingsChangedReview\(\)/);
});

test('motion, forced-colors, target size, and primary CTA contrast contracts pass', async () => {
  const [theme, components, optionsCss, popupCss, sidepanelCss] = await Promise.all([
    source('shared/theme.css'),
    source('shared/components.css'),
    source('options/options.css'),
    source('popup/popup.css'),
    source('sidepanel/sidepanel.css')
  ]);
  assert.match(theme, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(theme, /@media \(forced-colors: active\)/);
  assert.match(components, /\.btn \{[\s\S]*?min-height: 44px;/);
  assert.match(optionsCss, /\.switch \{[^}]*height: 44px;/);
  assert.match(popupCss, /\.btn\.compact \{[\s\S]*?min-height: 44px;/);
  assert.match(sidepanelCss, /\.segment \{[^}]*min-height: 44px;/);

  const primary = components.match(/\.btn\.primary \{[\s\S]*?background:\s*(#[0-9a-f]{6});/i)?.[1];
  assert.ok(primary, 'primary CTA must use a testable solid background');
  assert.ok(contrastRatio('#ffffff', primary) >= 4.5, `white on ${primary} must pass WCAG AA`);
});

test('disabling privacy-safe report redaction requires an explicit warning confirmation', async () => {
  const [optionsScript, backupScript] = await Promise.all([
    source('options/options.js'),
    source('shared/settings-backup.js')
  ]);
  assert.match(optionsScript, /#redactReports/);
  assert.match(optionsScript, /function confirmSensitiveReportStorage\(\)/);
  assert.match(optionsScript, /globalThis\.confirm/);
  assert.match(optionsScript, /Full unredacted reports can contain/);
  assert.match(optionsScript, /control\.checked = true/);
  assert.match(optionsScript, /buildSettingsImportConfirmation/);
  assert.match(backupScript, /settings\.latestReportRetentionMinutes === 0/);
  assert.match(backupScript, /settings\.reportRetentionDays === 0/);
  assert.match(backupScript, /settings\.keepHistory === true/);
  assert.match(backupScript, /settings\.redactReports === false/);
});

test('cleanup review defaults on and the explicit direct-cleanup option is disclosed and guarded', async () => {
  const [optionsHtml, optionsScript, popupHtml, popupScript, constants] = await Promise.all([
    source('options/options.html'),
    source('options/options.js'),
    source('popup/popup.html'),
    source('popup/popup.js'),
    source('shared/constants.js')
  ]);
  assert.match(constants, /skipCleanupReview:\s*false/);
  assert.match(optionsHtml, /id="skipCleanupReview"[^>]+type="checkbox"/);
  assert.match(optionsHtml, /Skip detailed cleanup review completely/);
  assert.match(optionsHtml, /Standard[\s\S]*Expert mode/);
  assert.match(optionsHtml, /permission prompts may still appear/i);
  assert.match(optionsHtml, /incognito data can be affected/i);
  assert.match(optionsScript, /setChecked\('skipCleanupReview', settings\.skipCleanupReview\)/);
  assert.match(optionsScript, /skipCleanupReview: isChecked\('skipCleanupReview'\)/);
  assert.match(optionsScript, /function confirmSkipCleanupReview\(\)/);
  assert.match(optionsScript, /'skipCleanupReview',[\s\S]*?'importSettings'/);
  assert.match(
    optionsScript,
    /for \(const id of \[\s*'skipCleanupReview',\s*'importSettings',[\s\S]*?control\.disabled = stateLocked \|\| cleanupJobRunning/
  );
  assert.match(optionsScript, /if \(cleanupJobRunning\) \{[\s\S]*?Settings cannot be imported while a cleanup job/);
  assert.match(optionsScript, /cleanup-review preference cannot change while a cleanup job is running/i);
  assert.match(popupHtml, /Required before cleanup/);
  assert.match(popupHtml, /Categories SiteWipe will attempt/);
  assert.match(popupHtml, /Protected categories/);
  assert.match(popupHtml, /Chrome\/Brave cannot safely remove/);
  assert.match(popupHtml, /Required acknowledgements/);
  assert.match(popupHtml, /Approve, grant access, and run/);
  assert.match(popupScript, /approvalMode: 'detailed_review'/);
});

test('popup and side-panel report surfaces label settings-direct authorization truthfully', async () => {
  const [popupScript, sidepanelScript] = await Promise.all([
    source('popup/popup.js'),
    source('sidepanel/sidepanel.js')
  ]);
  assert.match(popupScript, /s\.cleanupApprovalMode === 'settings_direct'[\s\S]*?'Settings direct cleanup'/);
  assert.match(sidepanelScript, /if \(value === 'settings_direct'\) return 'Settings direct cleanup'/);
  assert.match(sidepanelScript, /\['Approval', formatCleanupApprovalMode\(s\.cleanupApprovalMode\)\]/);
  assert.match(sidepanelScript, /`Approval: \$\{formatCleanupApprovalMode\(s\.cleanupApprovalMode\)\}`/);
});

function contrastRatio(first, second) {
  const high = Math.max(relativeLuminance(first), relativeLuminance(second));
  const low = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (high + 0.05) / (low + 0.05);
}

function relativeLuminance(hex) {
  const channels = [1, 3, 5]
    .map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

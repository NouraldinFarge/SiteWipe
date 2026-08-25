import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const root = new URL('../../src/', import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), 'utf8');
}

function withoutJavaScriptComments(value) {
  return value.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

async function collectRuntimeUiPaths(directory = root, prefix = '') {
  const paths = [];
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      paths.push(...(await collectRuntimeUiPaths(new URL(`${entry.name}/`, directory), path)));
    } else if (/\.(?:html|js)$/u.test(entry.name)) {
      paths.push(path);
    }
  }

  return paths;
}

test('Brave-reachable runtime copy uses browser-neutral branding', async () => {
  const paths = await collectRuntimeUiPaths();
  assert.ok(paths.length >= 50, 'the branding check must cover the complete shipped JavaScript and HTML surface');

  for (const path of paths) {
    const runtimeSource = withoutJavaScriptComments(await source(path));
    assert.doesNotMatch(
      runtimeSource,
      /\bChrome\b(?!\/Brave| or Brave)/,
      `${path} must reserve the Chrome name for explicit Chrome/Brave support copy or internal comments`
    );
  }
});

test('Options groups controls, wires visible labels/help, and exposes live outcomes', async () => {
  const [html, script] = await Promise.all([source('options/options.html'), source('options/options.js')]);
  assert.ok((html.match(/<fieldset\b/g) || []).length >= 4);
  assert.ok((html.match(/<legend\b/g) || []).length >= 4);
  assert.match(html, /id="toast"[^>]+class="toast"[^>]+hidden/);
  assert.match(html, /id="toastMessage"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(html, /id="dismissToast"[^>]+class="toast-dismiss"[^>]+type="button"[^>]*>Dismiss/);
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
  assert.match(script, /const SETTINGS_CONTROL_IDS = Object\.freeze\(\[[\s\S]*?'embeddedFrameDiscovery'/);
  assert.match(
    script,
    /for \(const id of SETTINGS_CONTROL_IDS\) \{[\s\S]*?control\.disabled = stateLocked \|\| cleanupJobRunning/
  );
  assert.match(script, /control\.setAttribute\('aria-disabled', String\(control\.disabled\)\)/);
  assert.match(script, /document\.querySelector\('#activeJobText'\)\.focus\(\)/);
  assert.match(script, /All settings,[\s\S]*?manual maintenance are disabled until this cleanup stops/);
});

test('Options separates optional access from the Expert-only embedded-frame setting', async () => {
  const [html, script, permissionLifecycle] = await Promise.all([
    source('options/options.html'),
    source('options/options.js'),
    source('options/permission-lifecycle.js')
  ]);
  assert.match(script, /if \(!expert\) \{[\s\S]*?setChecked\('embeddedFrameDiscovery', false\)/);
  assert.match(script, /setValue\('overlayScope', 'target_tabs'\)/);
  assert.match(script, /'overlayScope',\s*'resetMutedTabs'/);
  assert.match(script, /if \(!isExpertCleanupMode\(settings\.cleanupMode\)\)/);
  assert.match(html, /id="webNavigationAccessStatus" role="status" aria-live="polite"/);
  assert.match(html, /id="grantWebNavigationAccess"[\s\S]*?Grant optional access/);
  assert.match(html, /id="removeWebNavigationAccess"[\s\S]*?Remove access/);
  const saveStart = script.indexOf('async function saveFromForm');
  const saveEnd = script.indexOf('function renderActiveShield', saveStart);
  const grantStart = script.indexOf('async function grantWebNavigationAccess');
  const requestStart = script.indexOf("requestOptionalPermission('webNavigation')", grantStart);
  const grantLiveJobGuard = script.indexOf('if (cleanupJobRunning)', grantStart);
  const removeActionStart = script.indexOf('async function removeWebNavigationAccess');
  const removeSaveStart = script.indexOf('sendMessage(MESSAGE_TYPES.saveSettings', removeActionStart);
  const removePermissionStart = script.indexOf("removeOptionalPermission('webNavigation')", removeActionStart);
  assert.ok(
    saveStart >= 0 &&
      saveEnd > saveStart &&
      grantStart >= 0 &&
      requestStart > grantLiveJobGuard &&
      grantLiveJobGuard > grantStart &&
      removeSaveStart > removeActionStart &&
      removePermissionStart > removeSaveStart
  );
  assert.doesNotMatch(script.slice(saveStart, saveEnd), /requestOptionalPermission|permissions\.request/);
  assert.match(script.slice(grantLiveJobGuard, requestStart), /No browser permission was requested/);
  assert.match(script, /observeOptionalPermission\('webNavigation'\)/);
  assert.match(script, /removeOptionalPermission\('webNavigation'\)/);
  assert.match(script, /embedded-frame discovery is still off; enable its setting separately/i);
  assert.doesNotMatch(script, /reconcileOptionalPermissionGrant|grantProvenance|newly_granted/);
  assert.doesNotMatch(script, /chrome\.permissions\.remove\(/);
  const lifecycleRequestStart = permissionLifecycle.indexOf('export async function requestOptionalPermission');
  const lifecycleRemoveStart = permissionLifecycle.indexOf('export async function removeOptionalPermission');
  const requestBody = permissionLifecycle.slice(lifecycleRequestStart, lifecycleRemoveStart);
  assert.ok(lifecycleRequestStart >= 0 && lifecycleRemoveStart > lifecycleRequestStart);
  assert.match(requestBody, /await permissionsApi\.request\(request\)/);
  assert.doesNotMatch(requestBody, /permissionsApi\.contains\(request\)/);
  assert.match(permissionLifecycle, /permissionsApi\.contains\(request\)/);
  assert.match(permissionLifecycle, /await permissionsApi\.remove\(request\)/);
  assert.doesNotMatch(permissionLifecycle, /onAdded|addListener|removeListener|newly_granted|grantProvenance/);
});

test('Options states the request shield effective scope instead of promising a normal-only block', async () => {
  const [html, script] = await Promise.all([source('options/options.html'), source('options/options.js')]);

  assert.match(
    html,
    /id="temporaryDnrShieldHelp"[^>]+role="status"[^>]+aria-live="polite"[\s\S]*?availability is being checked/
  );
  assert.match(script, /function renderRequestShieldEffectiveState\(\)/);
  assert.match(script, /Configured on, but normal-only cleanup skips the shield/);
  assert.match(script, /browser session rules cannot be limited to normal windows/);
  assert.match(script, /reviewed scope includes normal and private windows/);
  assert.match(script, /Normal-only cleanup skips these shared rules so private traffic is never affected/);
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

test('disabled Options settings keep explanatory text readable', async () => {
  const css = await source('options/options.css');
  assert.doesNotMatch(css, /\.setting-row\.expert-disabled,[\s\S]*?opacity:\s*0\.52/);
  assert.doesNotMatch(css, /\.setting-row\.dependency-disabled[^}]*opacity:/);
  assert.match(css, /\.switch input:disabled \+ span \{[\s\S]*?opacity:\s*0\.55;/);
});

test('error notices persist until dismissed while non-errors retain bounded timing', async () => {
  const [components, optionsHtml, optionsScript, sidepanelHtml, sidepanelScript] = await Promise.all([
    source('shared/components.css'),
    source('options/options.html'),
    source('options/options.js'),
    source('sidepanel/sidepanel.html'),
    source('sidepanel/sidepanel.js')
  ]);
  assert.match(components, /\.toast-message \{[\s\S]*?overflow-wrap: anywhere;/);
  assert.match(components, /\.toast-dismiss \{[\s\S]*?min-height: 32px;/);
  assert.match(optionsHtml, /id="dismissToast"[^>]+type="button"[^>]*>Dismiss/);
  assert.match(sidepanelHtml, /id="dismissPanelStatus"[^>]+type="button"[^>]*>Dismiss/);
  assert.match(optionsScript, /const autoDismissMs = tone === 'error' \? null : tone === 'success' \? 3200 : 8000;/);
  assert.match(
    optionsScript,
    /hideToast\(el, dismissButton, dismissButton\?\.ownerDocument\?\.activeElement \|\| null\)/
  );
  assert.match(optionsScript, /function dismissToast\(\)/);
  assert.match(sidepanelScript, /const autoDismissMs = tone === 'error' \? null : tone === 'success' \? 3200 : 8000;/);
  assert.match(
    sidepanelScript,
    /hidePanelStatus\(status, dismissButton, dismissButton\?\.ownerDocument\?\.activeElement \|\| null\)/
  );
  assert.match(sidepanelScript, /function dismissPanelStatus\(\)/);
});

test('essential compact report and review text stays at least eleven pixels', async () => {
  const [optionsCss, popupCss, sidepanelCss] = await Promise.all([
    source('options/options.css'),
    source('popup/popup.css'),
    source('sidepanel/sidepanel.css')
  ]);
  for (const [label, block] of [
    ['Options disclosure count', optionsCss.match(/\.summary-meta \{[^}]+\}/)?.[0]],
    ['popup summary metric label', popupCss.match(/\.summary-metric span \{[^}]+\}/)?.[0]],
    ['popup file confirmation phrase', popupCss.match(/\.file-confirmation code \{[^}]+\}/)?.[0]],
    ['popup review expiry', popupCss.match(/\.review-expiry \{[^}]+\}/)?.[0]],
    ['side-panel history fact label', sidepanelCss.match(/\.history-fact span \{[^}]+\}/)?.[0]],
    ['side-panel matrix count', sidepanelCss.match(/\.matrix-count \{[^}]+\}/)?.[0]]
  ]) {
    assert.ok(block, `${label} style is present`);
    assert.match(block, /font-size:\s*11px;/, `${label} must remain readable at the default scale`);
  }
});

test('capacity errors lead with an actionable summary and disclose technical details separately', async () => {
  const [html, popupScript, capacityScript] = await Promise.all([
    source('popup/popup.html'),
    source('popup/popup.js'),
    source('background/cleanup-capacity.js')
  ]);
  assert.match(html, /id="targetErrorDetails"[^>]+class="target-error-details"[^>]+hidden/);
  assert.match(html, /<summary>Technical details<\/summary>/);
  assert.match(html, /id="targetErrorTechnical"[^>]+class="mono"/);
  assert.match(popupScript, /const TECHNICAL_ERROR_DETAILS_MARKER = ' Technical details: ';/);
  assert.match(popupScript, /function splitDisplayedError\(message\)/);
  assert.match(popupScript, /#targetErrorDetails'\)\.hidden = !displayed\.technicalDetails/);
  assert.match(capacityScript, /This cleanup is too large to review safely in one run\./);
  assert.match(capacityScript, /Technical details: \$\{reasons\.join/);
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

test('action popup preserves its preferred size but reflows within narrow viewport bounds', async () => {
  const [css, browserFixture] = await Promise.all([
    source('popup/popup.css'),
    source('../tests/browser/fixtures/popup-browser-mock.js')
  ]);

  assert.match(
    css,
    /html,\s*body \{\s*width: 380px;\s*max-width: 100vw;\s*min-width: 0;\s*height: 600px;\s*min-height: 0;\s*max-height: 100vh;/
  );
  assert.match(css, /html\.popup-opened-in-tab,\s*html\.popup-opened-in-tab body \{\s*width: min\(380px, 100vw\);/);
  assert.match(css, /body \{\s*container: popup-document \/ inline-size;\s*\}/);
  assert.match(
    css,
    /\.popup-shell \{[\s\S]*?width: 100%;[\s\S]*?max-width: 100%;[\s\S]*?overflow: hidden auto;[\s\S]*?container: popup \/ inline-size;/
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
  assert.match(css, /@container popup-document \(max-width: 340px\) \{\s*\.popup-shell \{\s*padding-inline: 10px;/);
  assert.match(css, /@container popup-document \(max-width: 280px\) \{\s*\.popup-shell \{\s*padding: 6px;/);
  assert.match(css, /\.popup-shell \.error-text \{\s*min-width: 0;\s*max-width: 100%;\s*overflow-wrap: anywhere;/);
  assert.match(css, /\.brand,[\s\S]*?\.review-effect \{\s*flex-direction: column;\s*align-items: stretch;/);
  assert.match(css, /\.review-facts > div,[\s\S]*?\.review-actions \{\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(css, /\.check-row \{\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(
    css,
    /\.help-text,\s*\.error-text \{\s*min-width: 0;\s*max-width: 100%;\s*overflow-wrap: anywhere;\s*word-break: normal;/
  );
  assert.doesNotMatch(css, /word-break:\s*break-all/);
  for (const [selector, block] of [
    ['review facts', css.match(/\.review-facts dd \{[^}]+\}/)?.[0]],
    ['review list', css.match(/\.review-list li \{[^}]+\}/)?.[0]],
    ['review effect', css.match(/\.review-effect strong \{[^}]+\}/)?.[0]]
  ]) {
    assert.ok(block, `${selector} wrapping rule is present`);
    assert.match(block, /min-width: 0;/);
    assert.match(block, /overflow-wrap: anywhere;/);
    assert.doesNotMatch(block, /word-break: break-all;/);
  }
});

test('400-percent action-popup source contract declares extreme-width whole-word reflow', async () => {
  const css = await source('popup/popup.css');

  assert.match(css, /@container popup \(max-width: 120px\) \{[\s\S]*?\.popup-shell \{\s*padding: 2px;/);
  assert.match(css, /@container popup \(max-width: 120px\) \{[\s\S]*?\.review-card \{\s*padding: 4px;/);
  assert.match(css, /@container popup \(max-width: 120px\) \{[\s\S]*?\.status-strip \{\s*padding-inline: 0;/);
  assert.match(
    css,
    /@container popup \(max-width: 120px\) \{[\s\S]*?\.status-strip \.badge \{[\s\S]*?gap: 3px;[\s\S]*?padding-inline: 3px;[\s\S]*?overflow: visible;[\s\S]*?text-overflow: clip;[\s\S]*?overflow-wrap: normal;[\s\S]*?word-break: normal;/
  );
  assert.match(
    css,
    /@container popup \(max-width: 120px\) \{[\s\S]*?\.review-actions \{[\s\S]*?gap: 4px;[\s\S]*?margin-inline: 0;[\s\S]*?padding: 4px 0 0;/
  );
  assert.match(
    css,
    /@container popup \(max-width: 120px\) \{[\s\S]*?\.review-actions \.btn \{[\s\S]*?padding-inline: 2px;[\s\S]*?overflow-wrap: normal;[\s\S]*?word-break: normal;/
  );
});

test('dynamic diagnostics and handoff outcomes contain long unbroken browser text', async () => {
  const [optionsCss, handoffCss] = await Promise.all([source('options/options.css'), source('handoff/handoff.css')]);
  assert.match(
    optionsCss,
    /\.diagnostic-box \{\s*min-width: 0;\s*max-width: 100%;[\s\S]*?white-space: pre-wrap;\s*overflow-wrap: anywhere;/
  );
  assert.match(handoffCss, /\.status,\s*\.error \{\s*min-width: 0;\s*max-width: 100%;[\s\S]*?overflow-wrap: anywhere;/);
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
  assert.match(handler, /await discardDirectCleanupPreparation\(\)/);
  assert.match(handler, /prepareDirectCleanup\(qs\('#targetInput'\)\.value\.trim\(\)\)/);
  assert.match(script, /\(direct \? directCleanupReview : cleanupReview\) !== review/);
  assert.match(script, /Settings changed\. No cleanup started\. Review the current scope again before approving\./);
  assert.match(script, /MESSAGE_TYPES\.openCleanupPermissionHandoff/);
  assert.match(script, /announceSettingsChangedReview\(\)/);
});

test('persistent permission handoff exposes an accessible exact-review action without resizing the browser', async () => {
  const [html, script, css] = await Promise.all([
    source('handoff/handoff.html'),
    source('handoff/handoff.js'),
    source('handoff/handoff.css')
  ]);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<title>SiteWipe reviewed access<\/title>/);
  assert.match(html, /<main[^>]+aria-labelledby="handoffTitle"/);
  assert.match(html, /<h1 id="handoffTitle">/);
  assert.ok(html.indexOf('id="status"') < html.indexOf('id="targetTitle"'));
  assert.match(script, /if \(!hadBoundHandoff\) renderUnavailableReview\(\)/);
  assert.match(script, /No target patterns are available because this handoff could not be verified/);
  assert.equal((html.match(/<section[^>]+aria-labelledby=/g) || []).length, 3);
  assert.match(html, /id="effectsTitle">Reviewed effects/);
  assert.match(html, /id="reviewedDownloadedFiles">Loading…/);
  assert.match(html, /id="reviewedBrowserRecords">Loading…/);
  assert.match(html, /id="reviewedRequestShield">Loading…/);
  assert.match(html, /id="reviewedProgressOverlay">Loading…/);
  assert.match(html, /id="reviewedProtectedOrigins">Loading…/);
  assert.match(html, /id="reviewedEvidence">Loading…/);
  assert.match(html, /id="status"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(html, /id="error"[^>]+role="alert"/);
  assert.match(html, /<button id="grantAccess"[^>]*>Grant reviewed access and run<\/button>/);
  assert.doesNotMatch(script, /#grantAccess'\)\.focus\(/);
  assert.match(script, /renderReviewedEffects\(claimed\.reviewedEffects\)/);
  assert.match(script, /This tab does not live-update after handoff/);
  assert.doesNotMatch(html, /will be released after this one cleanup/);
  assert.match(css, /button \{[\s\S]*?min-height: 3\.25rem;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /@media \(forced-colors: active\)/);
  assert.doesNotMatch(`${script}\n${css}`, /(?:window|chrome\.windows)\.(?:resize|maximize|update)/i);
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
  assert.match(theme, /@media \(forced-colors: active\)[\s\S]*?:focus-visible \{[\s\S]*?outline: 3px solid Highlight;/);
  assert.doesNotMatch(components, /\.input \{[^}]*outline:\s*none;/);
  assert.doesNotMatch(sidepanelCss, /\.tab-panel \{[^}]*outline:\s*none;/);
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
  assert.match(optionsHtml, /one activation durably[\s\S]*second fresh activation/i);
  assert.match(optionsHtml, /browser permission prompt/i);
  assert.match(optionsHtml, /incognito data[\s\S]*can be affected/i);
  assert.match(optionsHtml, /selected-top-level-site cleanup/i);
  assert.match(optionsHtml, /embedded third-party[\s\S]*IndexedDB/i);
  assert.match(optionsHtml, /exact-origin-only targets/i);
  assert.match(optionsScript, /SELECTED_SITE_PARTITION_STORAGE_DISCLOSURE/);
  assert.match(optionsScript, /EXACT_ORIGIN_BROWSER_STORAGE_LIMITATION/);
  assert.match(optionsScript, /setChecked\('skipCleanupReview', settings\.skipCleanupReview\)/);
  assert.match(optionsScript, /skipCleanupReview: isChecked\('skipCleanupReview'\)/);
  assert.match(optionsScript, /function confirmSkipCleanupReview\(\)/);
  assert.match(optionsScript, /const SETTINGS_CONTROL_IDS = Object\.freeze\(\[[\s\S]*?'skipCleanupReview'/);
  assert.match(optionsScript, /const JOB_GUARDED_CONTROL_IDS = Object\.freeze\(\[\s*\.\.\.SETTINGS_CONTROL_IDS,/);
  assert.match(optionsScript, /for \(const id of SETTINGS_CONTROL_IDS\) \{[\s\S]*?cleanupJobRunning/);
  assert.match(optionsScript, /if \(cleanupJobRunning\) \{[\s\S]*?Settings cannot be imported while a cleanup job/);
  assert.match(optionsScript, /cleanup-review preference cannot change while a cleanup job is running/i);
  assert.match(popupHtml, /Required before cleanup/);
  assert.match(popupHtml, /Categories SiteWipe will attempt/);
  assert.match(popupHtml, /Protected categories/);
  assert.match(popupHtml, /Chrome\/Brave cannot safely remove/);
  assert.match(popupHtml, /Required acknowledgements/);
  assert.match(popupHtml, /Approve reviewed cleanup/);
  assert.match(popupHtml, /Open reviewed access tab/);
  assert.match(popupHtml, /this popup may close/);
  assert.doesNotMatch(`${popupHtml}\n${popupScript}`, /Keep this popup open|Grant access and clean/);
  assert.match(popupScript, /Open reviewed access tab/);
  assert.match(popupScript, /approvalMode: 'detailed_review'/);
  assert.match(popupScript, /Browser-level storage\/cache/);
  assert.match(popupScript, /embedded third-party partitions under the selected site may also be deleted/i);
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

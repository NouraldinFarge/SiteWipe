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
  const [html, script] = await Promise.all([source('popup/popup.html'), source('popup/popup.js')]);
  assert.match(html, /id="targetInput"[^>]+required[^>]+aria-required="true"/);
  assert.match(html, /id="reviewScopeAcknowledge"[^>]+required[^>]+aria-required="true"/);
  assert.match(script, /fileInput\.setAttribute\('aria-invalid'/);
  assert.match(script, /input\.setAttribute\('aria-required'/);
  assert.match(html, /aria-label="Open options"/);
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
  const optionsScript = await source('options/options.js');
  assert.match(optionsScript, /#redactReports/);
  assert.match(optionsScript, /function confirmSensitiveReportStorage\(\)/);
  assert.match(optionsScript, /globalThis\.confirm/);
  assert.match(optionsScript, /Full unredacted reports can contain/);
  assert.match(optionsScript, /control\.checked = true/);
  assert.match(optionsScript, /importsIndefiniteLatestReport/);
});

test('mandatory cleanup review is visible, complete, and cannot be disabled in either mode', async () => {
  const [optionsHtml, optionsScript, popupHtml, popupScript, constants] = await Promise.all([
    source('options/options.html'),
    source('options/options.js'),
    source('popup/popup.html'),
    source('popup/popup.js'),
    source('shared/constants.js')
  ]);
  for (const text of [optionsHtml, optionsScript, popupHtml, popupScript, constants]) {
    assert.doesNotMatch(text, /skipCleanupReview/);
  }
  assert.match(optionsHtml, /Cleanup review is always required/);
  assert.match(optionsHtml, /Standard and Expert cleanup both show a fresh, read-only summary/);
  assert.match(optionsScript, /Every run still requires a fresh detailed scope and impact review/);
  assert.match(popupHtml, /Required before cleanup/);
  assert.match(popupHtml, /Categories SiteWipe will attempt/);
  assert.match(popupHtml, /Protected categories/);
  assert.match(popupHtml, /Chrome\/Brave cannot safely remove/);
  assert.match(popupHtml, /Required acknowledgements/);
  assert.match(popupHtml, /Approve, grant access, and run/);
  assert.match(popupScript, /approvalMode: 'detailed_review'/);
  assert.doesNotMatch(popupScript, /approvalMode: 'quick'/);
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

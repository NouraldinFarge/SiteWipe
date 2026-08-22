import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sourceRoot = new URL('../../src/', import.meta.url);

async function source(path) {
  return readFile(new URL(path, sourceRoot), 'utf8');
}

test('popup owns scrolling once and never flex-shrinks the completed report', async () => {
  const [html, css, script] = await Promise.all([
    source('popup/popup.html'),
    source('popup/popup.css'),
    source('popup/popup.js')
  ]);

  assert.match(css, /\.popup-shell \{[\s\S]*?overflow: hidden auto;/);
  assert.match(css, /\.popup-shell > \* \{\s*min-width: 0;\s*flex: 0 0 auto;/);
  assert.match(css, /\.summary-card \{[\s\S]*?flex-shrink: 0;[\s\S]*?max-height: none;[\s\S]*?overflow: visible;/);
  assert.doesNotMatch(css, /\.summary-card \{[^}]*overflow:\s*(?:auto|scroll)/);
  assert.match(html, /id="openSidePanel"[\s\S]*?>\s*Open full report\s*</);
  assert.match(html, /id="startAnotherCleanup"[\s\S]*?>Clean another site</);
  assert.match(script, /document\.body\.classList\.add\('has-summary'\)/);
  assert.match(script, /document\.body\.classList\.remove\('has-summary'\)/);
  assert.match(script, /qs\('#summaryTitle'\)\.focus\(\{ preventScroll: true \}\)/);
});

test('popup keeps path and query details out of automatic target and review rendering', async () => {
  const [html, script] = await Promise.all([source('popup/popup.html'), source('popup/popup.js')]);

  assert.match(html, /<dt>Input handling<\/dt>/);
  assert.doesNotMatch(html, /placeholder="[^"]*(?:\/page|\?|#)/);
  assert.match(script, /const input = activeTabTarget\.normalized\.target\.domain;/);
  assert.doesNotMatch(script, /const input = activeTabTarget\.tab\?\.url/);
  assert.match(script, /qs\('#targetInput'\)\.value = canonicalInput/);
  assert.match(
    script,
    /Only the canonical domain is shown\. Any path, query, credentials, or fragment from the input is ignored\./
  );
  assert.doesNotMatch(script, /#reviewEnteredTarget'\)\.textContent = review\.enteredTarget/);
});

test('popup exposes calm, named completion highlights and a distinct one-click mode', async () => {
  const [html, script] = await Promise.all([source('popup/popup.html'), source('popup/popup.js')]);

  assert.match(html, /id="summaryMetrics"[^>]+role="list"[^>]+aria-label="Cleanup highlights"/);
  assert.match(html, /id="summaryAnnouncement"[^>]+role="status"[^>]+aria-live="polite"/);
  assert.match(html, /id="summaryTitle"[^>]+tabindex="-1"/);
  assert.match(html, /id="cleanupModeBadge"[^>]+role="status"/);
  assert.match(script, /`\$\{mode\} · \$\{directCleanupEnabled\(\) \? 'One click' : 'Review'\}`/);
  assert.match(script, /function cleanupOutcomeTitle\(report\)/);
  assert.match(script, /metric\.setAttribute\('role', 'listitem'\)/);
});

test('popup binds stored-report actions to the exact displayed report and disables them for transient output', async () => {
  const [html, css, script] = await Promise.all([
    source('popup/popup.html'),
    source('popup/popup.css'),
    source('popup/popup.js')
  ]);

  assert.match(html, /id="summaryReportActionsNote"[^>]+role="note"/);
  assert.match(html, /id="summaryActionStatus"[\s\S]*?aria-live="polite"/);
  assert.match(
    script,
    /renderSummary\(response\.report, \{ focus: true, persisted: response\.reportPersisted === true \}\)/
  );
  assert.match(script, /qs\('#openSidePanel'\)\.hidden = !storedActionsAvailable/);
  assert.match(script, /qs\('#forgetLatestReport'\)\.hidden = !storedActionsAvailable/);
  assert.match(script, /classList\.toggle\('is-transient', !storedActionsAvailable\)/);
  assert.match(css, /\.summary-card\.is-transient \.summary-actions \{\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(
    script,
    /sendMessage\(MESSAGE_TYPES\.openSidePanel, \{\s*reportId: binding\.reportId,\s*windowId\s*\}\)/
  );
  assert.match(
    script,
    /function openSidePanel\(\)[\s\S]*?chrome\.sidePanel\.open\(\{ windowId: binding\.sidePanelWindowId \}\)/
  );
  assert.doesNotMatch(script.match(/function openSidePanel\(\) \{[\s\S]*?\n\}/)?.[0] || '', /await|sendMessage/);
  assert.match(script, /sendMessage\(MESSAGE_TYPES\.forgetLatestReport, \{ reportId: binding\.reportId \}\)/);
  assert.match(script, /This report is available only in this popup and was not saved locally/);
});

test('detailed-review approval failures stay visible and announced inside the open review', async () => {
  const [html, script] = await Promise.all([source('popup/popup.html'), source('popup/popup.js')]);

  assert.match(html, /id="reviewApprovalError"[^>]+role="alert"[^>]+aria-live="assertive"[^>]+aria-atomic="true"/);
  assert.match(html, /id="approveCleanup"[\s\S]*?aria-describedby="reviewApprovalError"/);
  assert.match(script, /else if \(reviewStillUsable && !direct\) showError\(''\)/);
  assert.match(
    script,
    /if \(reviewStillUsable && !direct\) \{[\s\S]*?qs\('#reviewCard'\)\.hidden = false;[\s\S]*?detailedReviewRetryError = approvalError/
  );
  assert.match(
    script,
    /setReviewMode\(Boolean\(cleanupReview\)\);[\s\S]*?setReviewApprovalError\(detailedReviewRetryError, \{ runtime: true \}\)/
  );
  assert.match(script, /Retry approval, grant access, and run/);
  assert.match(script, /qs\('#approveCleanup'\)\.focus\(\{ preventScroll: true \}\)/);
  assert.match(script, /if \(!direct\) setReviewApprovalError\(''\)/);
});

test('detailed review restores heading focus and shields content beneath sticky approval actions', async () => {
  const [css, script] = await Promise.all([source('popup/popup.css'), source('popup/popup.js')]);

  assert.match(script, /if \(cleanupReview\) focusReviewHeading\(\)/);
  assert.match(script, /qs\('#reviewHeading'\)\.focus\(\{ preventScroll: true \}\)/);
  assert.match(
    css,
    /\.review-actions \{[\s\S]*?position: sticky;[\s\S]*?border-top: 1px solid[\s\S]*?background: linear-gradient\(180deg, #151a25, var\(--bg-elevated\) 34%\);/
  );
  assert.match(css, /body\.review-active \.popup-shell \{\s*scroll-padding-bottom: 94px;/);
});

test('narrow popup overrides retain enough specificity to stack the candidate notice', async () => {
  const css = await source('popup/popup.css');

  assert.match(
    css,
    /@container popup \(max-width: 340px\) \{[\s\S]*?\.popup-shell \.candidate-notice \{\s*grid-template-columns: minmax\(0, 1fr\);/
  );
  assert.match(css, /\.candidate-label,\s*\.mode-chip \{\s*width: 100%;/);
  assert.match(css, /\.brand-title,\s*\.brand-subtitle \{[\s\S]*?overflow-wrap: anywhere;/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const sourceRoot = new URL('../../src/', import.meta.url);

async function source(path) {
  return readFile(new URL(path, sourceRoot), 'utf8');
}

test('popup exposes the complete configured-impact review as a named accessible list', async () => {
  const [html, popup] = await Promise.all([source('popup/popup.html'), source('popup/popup.js')]);
  assert.match(html, /id="reviewEffectsHeading">Expected impact and configured scope<\/h3>/);
  assert.match(html, /id="reviewEffects"[^>]+role="list"[^>]+aria-labelledby="reviewEffectsHeading"/);
  assert.match(popup, /row\.setAttribute\('role', 'listitem'\)/);
  for (const label of [
    'Target-tab state changes',
    'Live page scrub',
    'Embedded-frame discovery',
    'Cookie discovery/removal',
    'History/download discovery',
    'Protected web-app origins',
    'Cleanup progress overlay',
    'In-page overlay cancel button',
    'Request shield installed'
  ]) {
    assert.match(popup, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('popup discloses disabled and enabled overlay states, exact scope, cap, watchdog, and cancel affordance', async () => {
  const popup = await source('popup/popup.js');
  const start = popup.indexOf('function formatProgressOverlay(effect = {})');
  const end = popup.indexOf('function formatLivePageScrub', start);
  const formatter = popup.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(formatter, /Disabled — no page overlay will be injected/);
  assert.match(formatter, /effect\.scopeDescription/);
  assert.match(formatter, /effect\.maxTabsPerUpdate/);
  assert.match(formatter, /effect\.watchdogMs/);
  assert.match(formatter, /requests cancellation before the next major phase/);
});

test('review and runtime share one 120-tab overlay ceiling and bind exact scope descriptions', async () => {
  const [constants, review, runtime] = await Promise.all([
    source('shared/constants.js'),
    source('shared/cleanup-review.js'),
    source('background/progress-overlay.js')
  ]);
  assert.match(constants, /export const PROGRESS_OVERLAY_MAX_TABS = 120/);
  assert.match(review, /PROGRESS_OVERLAY_MAX_TABS/);
  assert.match(runtime, /prioritizedCandidates\.slice\(0, PROGRESS_OVERLAY_MAX_TABS\)/);
  assert.match(review, /all accessible HTTP\(S\) tabs across browser windows/);
  assert.match(review, /accessible HTTP\(S\) tabs in this popup\/source window/);
  assert.match(review, /matching accessible HTTP\(S\) target tabs only/);
  assert.match(review, /visibly change unrelated pages/);
});

test('normal-only DNR safety skip is bound into review data and rendered verbatim', async () => {
  const [review, popup] = await Promise.all([source('shared/cleanup-review.js'), source('popup/popup.js')]);
  assert.match(review, /Skipped for normal-only safety/);
  assert.match(review, /cannot constrain shared DNR session rules to normal windows/);
  assert.match(popup, /effect\.disabledReason \|\| 'No'/);
});

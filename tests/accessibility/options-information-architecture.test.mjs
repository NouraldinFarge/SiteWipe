import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../src/options/', import.meta.url);

async function source(name) {
  return readFile(new URL(name, root), 'utf8');
}

test('Options exposes a compact, keyboard-reachable section map', async () => {
  const [html, script] = await Promise.all([source('options.html'), source('options.js')]);
  const destinations = [
    'privacy',
    'permissions',
    'incognito',
    'accessibility',
    'shield',
    'maintenance',
    'job',
    'advanced'
  ];

  assert.match(html, /class="skip-link" href="#mainContent">Skip to settings/);
  assert.match(html, /id="mainContent"[^>]+tabindex="-1"[^>]+aria-busy="true"/);
  assert.match(html, /<nav class="rail-nav" aria-label="Options sections">/);
  assert.equal((html.match(/data-options-section/g) || []).length, destinations.length);
  assert.equal((html.match(/aria-current="location"/g) || []).length, 1);
  for (const id of destinations) {
    assert.match(html, new RegExp(`href="#${id}"`));
    assert.match(html, new RegExp(`id="${id}"[\\s\\S]*?data-options-section`));
  }

  assert.match(script, /function setupSectionNavigation\(\)/);
  assert.match(script, /link\.setAttribute\('aria-current', 'location'\)/);
  assert.match(script, /new IntersectionObserver\(/);
  assert.match(script, /target\.closest\('details'\)\?\.setAttribute\('open', ''\)/);
  assert.match(script, /let explicitSectionId = null;/);
  assert.match(script, /let explicitSectionSeen = false;/);
  assert.match(script, /activateExplicitSection\(id\)/);
  assert.match(script, /const explicitSectionIsVisible = \(\) =>/);
  assert.match(script, /rect\.bottom > 68 && rect\.top < viewportHeight/);
  assert.match(script, /if \(explicitSectionIsVisible\(\)\) \{[\s\S]*?setCurrent\(explicitSectionId\);[\s\S]*?return;/);
  assert.match(script, /function setOptionsReady\(\{ afterRetry = false \} = \{\}\)/);
  assert.match(script, /querySelector\('#mainContent'\)\.setAttribute\('aria-busy', 'false'\)/);
  assert.match(script, /function setOptionsLoadFailed\(message\)/);
  assert.match(script, /function retryOptionsLoad\(\)/);
});

test('Options keeps essential cleanup decisions visible and progressively discloses advanced groups', async () => {
  const html = await source('options.html');

  assert.match(html, /<strong>Skip detailed cleanup review completely<\/strong>/);
  assert.match(html, /id="skipCleanupReview" type="checkbox"/);
  assert.match(html, /id="advancedCleanupGroup" class="settings-cluster"/);
  assert.ok((html.match(/<details class="settings-cluster">/g) || []).length >= 5);
  assert.match(html, /<span class="risk-label">High-impact preference<\/span>/);
  assert.match(html, /class="high-impact-panel"/);
  assert.match(html, /class="danger-zone"/);

  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'Options markup must not contain duplicate IDs');
});

test('Options replaces the stacked mobile menu with horizontally scrollable section chips', async () => {
  const css = await source('options.css');
  const mobile = css.slice(css.indexOf('@media (max-width: 860px)'));
  const phone = css.slice(css.indexOf('@media (max-width: 560px)'));

  assert.ok(mobile.length > 0, 'The compact navigation breakpoint must exist');
  assert.match(mobile, /\.rail \{[\s\S]*?position: sticky;[\s\S]*?display: block;/);
  assert.match(mobile, /\.rail-brand,[\s\S]*?\.rail-note \{\s*display: none;/);
  assert.match(mobile, /\.rail-nav \{[\s\S]*?display: flex;[\s\S]*?overflow-x: auto;/);
  assert.match(mobile, /\.rail-nav a \{[\s\S]*?flex: 0 0 auto;[\s\S]*?min-height: 40px;/);
  assert.match(mobile, /\.rail-nav a\[aria-current='location'\]/);
  assert.match(css, /@media \(max-width: 700px\) \{[\s\S]*?\.support-grid,[\s\S]*?grid-template-columns: 1fr;/);
  assert.ok(phone.length > 0, 'The phone status-layout breakpoint must exist');
  assert.match(phone, /\.hero-status \{\s*flex-wrap: wrap;\s*overflow: visible;/);
  assert.doesNotMatch(phone, /\.rail-nav \{[^}]*overflow-x: visible;/);
});

test('Options provides concise save, cleanup-mode, review-mode, and active-job status', async () => {
  const [html, script] = await Promise.all([source('options.html'), source('options.js')]);

  for (const id of ['settingsStateBadge', 'cleanupModeBadge', 'reviewModeBadge', 'incognitoBadge']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /class="hero-status"[\s\S]*?role="group"[\s\S]*?aria-label="Current SiteWipe status"/);
  assert.match(script, /function renderSettingsSummary\(settings\)/);
  assert.match(script, /Review: skipped by setting/);
  assert.match(script, /setSettingsState\('Saving…', 'working'\)/);
  assert.match(
    script,
    /setSettingsState\(framePermissionDenied \|\| permissionWarning \? 'Saved · check access' : 'Saved'/
  );
  assert.match(script, /job\.detail/);
  assert.match(script, /formatDateTime\(job\.updatedAt\)/);
});

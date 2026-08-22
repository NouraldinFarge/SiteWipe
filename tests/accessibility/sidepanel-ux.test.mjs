import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../../', import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), 'utf8');
}

test('side panel makes privacy-safer exports primary and isolates full stored exports behind disclosure', async () => {
  const [html, script] = await Promise.all([
    source('src/sidepanel/sidepanel.html'),
    source('src/sidepanel/sidepanel.js')
  ]);
  const redactedAction = html.indexOf('id="exportRedactedReport" class="btn primary"');
  const sensitiveDisclosure = html.indexOf('class="sensitive-disclosure"', redactedAction);
  const fullAction = html.indexOf('id="exportReport"', sensitiveDisclosure);
  assert.ok(redactedAction >= 0, 'redacted JSON must be the primary report export');
  assert.ok(sensitiveDisclosure > redactedAction, 'full exports must follow the redacted actions');
  assert.ok(fullAction > sensitiveDisclosure, 'full JSON must live inside the sensitive disclosure');
  assert.match(html, /Full stored exports — review before sharing/);
  assert.match(html, /id="exportReport"[\s\S]*?aria-describedby="storedReportPrivacyNote"/);
  assert.match(html, /id="exportTextReport"[\s\S]*?aria-describedby="storedReportPrivacyNote"/);
  assert.match(script, /This report was stored redacted\.[\s\S]*?cannot restore browsing details/);
  assert.match(script, /Full stored exports — source already redacted/);
  assert.match(script, /confirmSensitiveExport\('full stored report JSON', Boolean\(currentReport\.redacted\)\)/);
});

test('side panel stacks report values and renders the capability matrix as responsive semantic disclosures', async () => {
  const [html, css, script] = await Promise.all([
    source('src/sidepanel/sidepanel.html'),
    source('src/sidepanel/sidepanel.css'),
    source('src/sidepanel/sidepanel.js')
  ]);
  assert.match(css, /html,\s*body \{[\s\S]*?max-width: 100%;[\s\S]*?overflow-x: clip;/);
  assert.match(css, /\.side-shell \.report-row \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(css, /\.side-shell \.report-row strong \{[\s\S]*?text-align: left;/);
  assert.match(css, /\.matrix \{\s*gap: 8px;\s*margin-top: 10px;\s*overflow: visible;/);
  assert.match(css, /\.matrix-item \{[\s\S]*?max-width: 100%;[\s\S]*?overflow: hidden;/);
  assert.doesNotMatch(css, /\.matrix-row \{[\s\S]*?min-width:\s*760px/);
  assert.match(script, /<div class="matrix-list-item" role="listitem">\s*<details class="matrix-item">/);
  assert.match(script, /<summary class="matrix-item-header">/);
  assert.match(script, /<dl class="matrix-facts">/);
  assert.match(script, /<dt>Reported support<\/dt><dd>\$\{escapeHtml\(item\.status\)\}<\/dd>/);
  assert.match(script, /<dt>Browser mechanism<\/dt>/);
  assert.match(script, /<dt>Target behavior<\/dt>/);
  assert.match(script, /<dt>Private windows<\/dt>/);
  assert.match(
    html,
    /id="matrixContainer"[\s\S]*?role="list"[\s\S]*?aria-labelledby="matrixHeading"[\s\S]*?aria-describedby="matrixCount"/
  );
});

test('capability matrix provides named search and support filters with a live concise result count', async () => {
  const [html, script, css] = await Promise.all([
    source('src/sidepanel/sidepanel.html'),
    source('src/sidepanel/sidepanel.js'),
    source('src/sidepanel/sidepanel.css')
  ]);
  assert.match(html, /class="matrix-controls" role="group" aria-label="Filter cleanup capabilities"/);
  assert.match(html, /<label for="matrixFilter">Search capabilities<\/label>/);
  assert.match(html, /id="matrixFilter"[\s\S]*?type="search"/);
  assert.match(html, /<label for="matrixStatusFilter">Support level<\/label>/);
  for (const value of ['all', 'supported', 'partial', 'unavailable']) {
    assert.match(html, new RegExp(`<option value="${value}">`));
  }
  assert.match(html, /id="matrixCount"[^>]+role="status"[^>]+aria-live="polite"[^>]+aria-atomic="true"/);
  assert.match(script, /'#matrixFilter'\)\.addEventListener\('input', renderMatrix\)/);
  assert.match(script, /'#matrixStatusFilter'\)\.addEventListener\('change', renderMatrix\)/);
  assert.match(script, /const items = CLEANUP_MATRIX\.filter/);
  assert.match(script, /Showing \$\{items\.length\} of \$\{CLEANUP_MATRIX\.length\} capabilities\./);
  assert.match(script, /function matrixSupportLevel\(status\)/);
  assert.match(script, /function formatMatrixStatus\(status\)/);
  assert.match(css, /\.matrix-controls \{[\s\S]*?grid-template-columns: repeat\(auto-fit, minmax\(150px, 1fr\)\);/);
  assert.match(css, /\.matrix-item-header \{[\s\S]*?cursor: pointer;[\s\S]*?list-style: none;/);
  assert.match(css, /\.matrix-item\[open\] \.matrix-item-header/);
});

test('side panel separates runtime failures, intentional skips, and unavailable browser limits', async () => {
  const [html, script] = await Promise.all([
    source('src/sidepanel/sidepanel.html'),
    source('src/sidepanel/sidepanel.js')
  ]);
  assert.match(script, /title: 'Runtime errors'/);
  assert.match(script, /title: 'Skipped by safety or settings'/);
  assert.match(script, /title: 'Unavailable browser limits'/);
  assert.match(script, /these are not runtime errors/);
  assert.match(script, /`Unavailable browser limits: \$\{getReportUnavailableCount\(report\)\}`/);
  assert.match(script, /`Runtime errors: \$\{getReportRuntimeErrorCount\(report\)\}`/);
  assert.doesNotMatch(script, /Warnings\/errors:/);
  assert.match(
    html,
    /An unavailable browser surface is a platform limit, not evidence that an attempted cleanup failed/
  );
});

test('empty history hides destructive and export controls while keeping retention semantics clear', async () => {
  const [html, script] = await Promise.all([
    source('src/sidepanel/sidepanel.html'),
    source('src/sidepanel/sidepanel.js')
  ]);
  assert.match(html, /id="historyTools" class="history-tools" hidden/);
  assert.match(html, /id="clearHistory" class="btn danger" type="button" hidden/);
  assert.match(script, /document\.querySelector\('#historyTools'\)\.hidden = !hasHistory/);
  assert.match(script, /document\.querySelector\('#clearHistory'\)\.hidden = !hasHistory/);
  assert.match(script, /History retention is off\.[\s\S]*?latest report/);
  assert.match(script, /button\.hidden \? document\.querySelector\('#historyTabButton'\) : button/);
});

test('side-panel filenames normalize separators and avoid doubled hyphens', async () => {
  const script = await source('src/sidepanel/sidepanel.js');
  assert.match(script, /function joinFilenameParts\([\s\S]*?\.filter\(Boolean\)\.join\('-'\)/);
  assert.match(script, /\.replace\(\/-\{2,\}\/g, '-'\)/);
  assert.match(script, /\.replace\(\/\^\[\.-\]\+\|\[\.-\]\+\$\/g, ''\)/);
  assert.doesNotMatch(script, /sitewipe-report-\$\{redacted \? 'redacted-' : ''\}/);
});

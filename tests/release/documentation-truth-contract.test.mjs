import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  findCurrentChangelogStageClaims,
  findCurrentStatusSurfaceFindings,
  findDeferredCurrentCandidateFindings,
  findReleaseGuideChronologyClaims
} from '../../scripts/documentation-truth-contract.mjs';

const version = '9.8.7';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const guardedSurfacePaths = [
  'docs/capability-matrix.md',
  'docs/claim-evidence.md',
  'docs/safety-case.md',
  'docs/release-readiness.md',
  'docs/testing.md',
  'docs/owner-review-packet.md',
  'docs/issue-register.md',
  'docs/decisions/0001-permission-reduction.md',
  'docs/decisions/0011-optional-direct-cleanup.md',
  'README.md',
  'CONTRIBUTING.md',
  'PRIVACY.md',
  'docs/git-history-plan.md',
  'docs/private-remote-plan.md'
];

test('current changelog stage claims reject transient phrasing families', () => {
  for (const claim of [
    'Fresh source stages have not yet run.',
    'Fresh validation has not run.',
    'Fresh source stages are pending.',
    'Current-version validation remains unrun.',
    'Current validation must restart.',
    'No current-version validation result exists.'
  ]) {
    const text = changelog(claim);
    assert.deepEqual(findCurrentChangelogStageClaims(text, version), [`- ${claim}`]);
  }
});

test('explicit transaction-boundary history remains stable after later validation', () => {
  const claim = `At the ${version} transaction boundary, fresh validation had not yet run; current results belong only to active evidence.`;
  assert.deepEqual(findCurrentChangelogStageClaims(changelog(claim), version), []);
});

test('a transaction-boundary clause cannot exempt a separate transient changelog clause', () => {
  const claim = `At the ${version} transaction boundary, fresh validation had not yet run; Current validation must restart.`;
  assert.deepEqual(findCurrentChangelogStageClaims(changelog(claim), version), ['Current validation must restart.']);
});

test('missing exact current-version changelog section fails closed', () => {
  assert.deepEqual(findCurrentChangelogStageClaims(changelog('Current evidence is authoritative.', '9.8.6'), version), [
    `exact current-version section ${version} is missing`
  ]);
});

test('release-guide chronology rejects transient restart instructions', () => {
  for (const claim of [
    'Complete validation must restart.',
    'Current-version validation, clean packaging, and exact-artifact execution must restart.',
    'Current validation and clean-commit packaging restart.'
  ]) {
    assert.deepEqual(findReleaseGuideChronologyClaims(releaseGuide(claim)), [claim]);
  }
});

test('release-guide chronology permits explicitly bounded history and ignores procedures', () => {
  assert.deepEqual(
    findReleaseGuideChronologyClaims(
      releaseGuide(`At the ${version} transaction boundary, complete validation must restart.`)
    ),
    []
  );
  assert.deepEqual(
    findReleaseGuideChronologyClaims(releaseGuide('Historical operator note: complete validation must restart.')),
    []
  );
  assert.deepEqual(
    findReleaseGuideChronologyClaims(
      releaseGuide('Recorded chronology is stable.', 'If recovery succeeds, the operator must restart validation.')
    ),
    []
  );
});

test('release-guide boundary and historical words do not exempt a separate transient clause', () => {
  for (const [claim, finding] of [
    [
      `At the ${version} transaction boundary, validation had not run; Current validation must restart.`,
      'Current validation must restart.'
    ],
    [
      'Although historical evidence exists, current validation must restart.',
      'Although historical evidence exists, current validation must restart.'
    ]
  ]) {
    assert.deepEqual(findReleaseGuideChronologyClaims(releaseGuide(claim)), [finding]);
  }
});

test('deferred register rejects no-result claims even when the exact evidence delegation is present', () => {
  assert.deepEqual(
    findDeferredCurrentCandidateFindings(
      'No browser result exists for the exact current candidate. Exact current browser status belongs only to `docs/evidence/browser-validation.json`.'
    ),
    ['exact current browser status must be delegated, not asserted as no result']
  );
});

test('deferred register requires delegation to the exact browser evidence path', () => {
  assert.deepEqual(
    findDeferredCurrentCandidateFindings('Exact current browser results belong only to `browser-validation.json`.'),
    ['exact current browser status delegation to docs/evidence/browser-validation.json is missing']
  );
  assert.deepEqual(
    findDeferredCurrentCandidateFindings(
      'Exact current browser results belong only to `docs/evidence/browser-validation.json.backup`.'
    ),
    ['exact current browser status delegation to docs/evidence/browser-validation.json is missing']
  );
  assert.deepEqual(
    findDeferredCurrentCandidateFindings(
      'Exact current browser results belong only to `docs/evidence/browser-validation.json`.'
    ),
    []
  );
});

test('normalized current-facing status surfaces satisfy the truth contract', async () => {
  for (const path of guardedSurfacePaths) {
    const text = await surfaceText(path);
    assert.deepEqual(findCurrentStatusSurfaceFindings(path, text), [], path);
  }
});

test('capability Browser evidence cells reject a live stage outcome without scanning adjacent limits', async () => {
  const path = 'docs/capability-matrix.md';
  const text = await surfaceText(path);
  const mutation = mutateTableRow(text, 'Tabs', 'See active browser evidence', 'Browser validation pending');
  assertFindings(path, mutation);
  assert.deepEqual(
    findCurrentStatusSurfaceFindings(
      path,
      mutateTableRow(
        text,
        'Tabs',
        "A tab can still change during Chrome's asynchronous mutation; close timeout is unknown",
        'A tab can retain `prompt_pending` settlement state; restart is a conditional prerequisite'
      )
    ),
    []
  );
});

test('claim-evidence current-status and Owner approval cells reject stale outcomes', async () => {
  const path = 'docs/claim-evidence.md';
  const text = await surfaceText(path);
  assertFindings(
    path,
    mutateTableRow(
      text,
      'Uses a bundled full PSL',
      'exact current status belongs to active browser/release evidence',
      'current browser validation remains pending'
    )
  );
  assertFindings(path, mutateTableRow(text, 'Uses a bundled full PSL', 'See active decisions', 'Approved'));
});

test('safety-case Browser evidence and Current judgement cells reject stale outcomes', async () => {
  const path = 'docs/safety-case.md';
  const text = await surfaceText(path);
  assertFindings(
    path,
    mutateTableRow(text, 'S1', 'exact current status belongs to active browser evidence', 'browser validation pending')
  );
  assertFindings(
    path,
    mutateTableRow(
      text,
      'S1',
      'Design and prerequisites retained; exact current source and installed status belongs to active evidence',
      'Code evidence passes; browser gate open'
    )
  );
});

test('release-readiness Status cells and Version transaction row remain outcome-neutral', async () => {
  const path = 'docs/release-readiness.md';
  const text = await surfaceText(path);
  assertFindings(
    path,
    mutateTableRow(text, 'Chrome integration', 'See active browser evidence', 'Forward exact-artifact run pending')
  );
  assertFindings(
    path,
    mutateTableRow(
      text,
      'Version transaction',
      'See active version-state and automated evidence',
      'See active 9.8.7 version-state and automated evidence'
    )
  );
});

test('testing Brave and performance status cells require their exact active evidence domains', async () => {
  const path = 'docs/testing.md';
  const text = await surfaceText(path);
  assertFindings(
    path,
    mutateTableRow(
      text,
      'Brave compatibility',
      'Exact current status belongs to active browser evidence',
      'Brave validation pending'
    )
  );
  assertFindings(
    path,
    mutateTableRow(
      text,
      'Performance',
      'Exact current status belongs to active performance evidence',
      'Exact current status belongs to active browser evidence'
    )
  );
});

test('owner-review Current state cells reject live stages while preserving durable decisions', async () => {
  const path = 'docs/owner-review-packet.md';
  const text = await surfaceText(path);
  assertFindings(
    path,
    mutateTableRow(
      text,
      'Initial Git history',
      'Published-baseline history retained; active remote evidence governs current alignment',
      'Default-branch recapture must restart'
    )
  );
  assertFindings(
    path,
    mutateTableRow(
      text,
      'Store submission',
      'Conditionally authorized; active stage-specific evidence governs eligibility',
      'Conditionally authorized; reviewer result remains open'
    )
  );
});

test('ADR Status lines require active installed-browser delegation', async () => {
  for (const path of [
    'docs/decisions/0001-permission-reduction.md',
    'docs/decisions/0011-optional-direct-cleanup.md'
  ]) {
    const text = await surfaceText(path);
    assertFindings(
      path,
      mutateOnce(
        text,
        'exact installed-browser status belongs only to active browser evidence',
        'installed-browser validation remains pending'
      )
    );
  }
});

test('stable prose surfaces require their normalized current-status pointers', async () => {
  const markers = new Map([
    [
      'README.md',
      'exact release, supported-binary, and browser-store-listing status belongs only to active publication evidence.'
    ],
    ['CONTRIBUTING.md', 'Exact current installed-browser status belongs only to the active browser evidence.'],
    [
      'PRIVACY.md',
      'Exact current default-branch and hosted-policy parity belongs only to the active remote and publication evidence; source availability alone does not establish that parity.'
    ],
    [
      'docs/git-history-plan.md',
      'exact current alignment and availability belong only to the active remote decision and a fresh authenticated external capture.'
    ],
    [
      'docs/private-remote-plan.md',
      'exact current authorization and remote status belong to the release-readiness ledger, `remote-publication.json`, and a fresh ignored authenticated external capture.'
    ]
  ]);
  for (const [path, marker] of markers) {
    assertFindings(path, mutateOnce(await surfaceText(path), marker, 'Current status remains pending.'));
  }
});

test('issue-register State accepts only normalized outcome-neutral vocabulary', async () => {
  const path = 'docs/issue-register.md';
  const text = await surfaceText(path);
  const normalizedState = 'Historical disposition retained; active candidate-scoped evidence governs current status';
  for (const staleState of [
    'Pending',
    'Open',
    'Blocked',
    'Incomplete',
    'Restart required',
    'Correction staged',
    'Complete check passed',
    'Current validation failed'
  ]) {
    assertFindings(path, mutateTableRow(text, 'SW-003', normalizedState, staleState));
  }
});

test('named status tables fail closed on changed headers, duplicate rows, and missing rows', async () => {
  const path = 'docs/capability-matrix.md';
  const text = await surfaceText(path);
  assertFindings(path, mutateOnce(text, '| Browser evidence ', '| Browser status   '));
  const tabsRow = text.split(/\r?\n/u).find((line) => line.startsWith('| Tabs '));
  assert.ok(tabsRow);
  assertFindings(path, mutateOnce(text, tabsRow, `${tabsRow}\n${tabsRow}`));
  assertFindings(path, mutateOnce(text, `${tabsRow}\n`, ''));
});

function changelog(claim, headingVersion = version) {
  return `# Changelog\n\n## Unreleased\n\n## ${headingVersion} — candidate\n\n- ${claim}\n\n## 9.8.5 — prior\n`;
}

function releaseGuide(chronology, procedure = 'Run the exact guarded sequence.') {
  return `# Release process\n\n${chronology}\n\n## Human prerequisites\n\n${procedure}\n`;
}

async function surfaceText(path) {
  return readFile(resolve(root, path), 'utf8');
}

function assertFindings(path, text) {
  assert.notDeepEqual(findCurrentStatusSurfaceFindings(path, text), [], `${path} mutation escaped the guard`);
}

function mutateOnce(text, before, after) {
  const first = text.indexOf(before);
  assert.notEqual(first, -1, `mutation source is missing: ${before}`);
  assert.equal(text.indexOf(before, first + before.length), -1, `mutation source is not unique: ${before}`);
  return `${text.slice(0, first)}${after}${text.slice(first + before.length)}`;
}

function mutateTableRow(text, rowKey, before, after) {
  const lines = text.split(/\r?\n/u);
  const indexes = [];
  const exactKey = /^(?:S|SW-)\d+$/u.test(rowKey);
  const exactKeyPattern = exactKey ? new RegExp(`^\\|\\s*${escapeRegex(rowKey)}\\s*\\|`, 'u') : null;
  for (let index = 0; index < lines.length; index += 1) {
    if (exactKeyPattern?.test(lines[index]) || (!exactKey && lines[index].startsWith(`| ${rowKey}`))) {
      indexes.push(index);
    }
  }
  assert.equal(indexes.length, 1, `expected one table row beginning ${rowKey}`);
  const index = indexes[0];
  assert.ok(lines[index].includes(before), `row ${rowKey} does not contain mutation source: ${before}`);
  lines[index] = lines[index].replace(before, after);
  return lines.join('\n');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

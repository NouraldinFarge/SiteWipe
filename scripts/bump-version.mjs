import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { format, resolveConfig } from 'prettier';

import {
  collectVersionFingerprintPaths,
  computeVersionFingerprintSnapshot,
  projectRoot,
  resolveNextVersion,
  runtimeArtifactBase
} from './versioning.mjs';
import { RUNTIME_FILES } from './release-files.mjs';
import { assertDependencyInventoryMatchesLockfile } from './dependency-license-contract.mjs';
import {
  resetAccessibilityEvidence,
  resetAutomatedValidationEvidence,
  resetDependencyLicenseInventoryEvidence,
  resetMediaEvidence,
  resetPerformanceEvidence,
  resetProvenanceTechnicalEvidence
} from './evidence-reset.mjs';
import { assertFileTransactionCanStart, transactionalWriteFiles } from './transactional-files.mjs';
import {
  BROWSER_MATRIX_VERSION,
  CANONICAL_BROWSER_MATRIX_IDS,
  CANONICAL_BROWSER_MATRIX_SHA256
} from './browser-validation-policy.mjs';
import {
  planValidationEvidenceVersionTransition,
  stageValidationEvidenceVersionTransition
} from './validation-evidence.mjs';

await assertFileTransactionCanStart(projectRoot, 'sitewipe-version-bump');

const updates = new Map();
const expectedOriginals = new Map();
const request = process.argv[2] || 'patch';
const currentStatus =
  'Public-source prerelease candidate undergoing safety, privacy, accessibility, and binary-release validation.';
const pkg = await json('package.json');
const previousVersion = pkg.version;
const nextVersion = resolveNextVersion(previousVersion, request);
const artifactBase = runtimeArtifactBase(nextVersion);
const date = localCalendarDate();

queueJson('package.json', { ...pkg, version: nextVersion });

const lockfileBefore = await source('package-lock.json');
const dependencyInventory = await json('docs/evidence/dependency-license-inventory.json');
assertDependencyInventoryMatchesLockfile(dependencyInventory, lockfileBefore);
const lock = JSON.parse(lockfileBefore);
lock.version = nextVersion;
if (!lock.packages?.['']) throw new Error('package-lock workspace record is missing.');
lock.packages[''].version = nextVersion;
queueJson('package-lock.json', lock);

const resetDependencyInventory = resetDependencyLicenseInventoryEvidence(dependencyInventory, {
  version: nextVersion,
  currentLockfileSha256: sha256(await source('package-lock.json'))
});
queueJson('docs/evidence/dependency-license-inventory.json', resetDependencyInventory);

for (const path of ['src/package.json', 'src/manifest.json']) {
  await queueRequiredReplacement(path, `"version": "${previousVersion}"`, `"version": "${nextVersion}"`);
}

for (const [path, before, after] of [
  ['src/shared/constants.js', `version: '${previousVersion}'`, `version: '${nextVersion}'`],
  [
    'src/test-harness/release-selftest.mjs',
    `manifest.version, '${previousVersion}'`,
    `manifest.version, '${nextVersion}'`
  ],
  [
    'tests/browser/fixtures/sidepanel-browser-mock.js',
    `appVersion: '${previousVersion}'`,
    `appVersion: '${nextVersion}'`
  ],
  ['README.md', `current candidate version \`${previousVersion}\``, `current candidate version \`${nextVersion}\``],
  ['PRIVACY.md', `SiteWipe \`${previousVersion}\``, `SiteWipe \`${nextVersion}\``],
  ['SECURITY.md', `public-source \`${previousVersion}\` prerelease`, `public-source \`${nextVersion}\` prerelease`],
  ['src/README.md', `Version \`${previousVersion}\``, `Version \`${nextVersion}\``],
  ['.github/ISSUE_TEMPLATE/bug.yml', `${previousVersion} / SHA-256`, `${nextVersion} / SHA-256`]
]) {
  await queueRequiredReplacement(path, before, after);
}

await assertRequiredMarker('docs/architecture.md', `forward ${nextVersion} transaction`);
await assertRequiredMarker('docs/threat-model.md', `the ${nextVersion} corrective working source`);
await assertRequiredSourceStateMarker('docs/release-readiness.md', nextVersion);

// Release-readiness prose is deliberately staged for the exact successor
// before the transaction. Requiring the next-version marker keeps the update
// fail-closed without coupling future patch bumps to one prior paragraph's
// wording or rewriting historical failed-version references.
updates.set('docs/release-readiness.md', await source('docs/release-readiness.md'));
updates.set('docs/architecture.md', await source('docs/architecture.md'));

updates.set('CHANGELOG.md', promoteUnreleased(await source('CHANGELOG.md'), nextVersion, date));

const browser = await json('docs/evidence/browser-validation.json');
browser.status = 'pending';
browser.attemptedAt = null;
delete browser.attemptedAtApproximate;
browser.artifact = { version: nextVersion, runtimeZip: `${artifactBase}.zip`, sha256: null };
browser.matrixVersion = BROWSER_MATRIX_VERSION;
browser.matrixSha256 = CANONICAL_BROWSER_MATRIX_SHA256;
browser.requiredMatrix = [...CANONICAL_BROWSER_MATRIX_IDS];
browser.chrome = emptyBrowserEvidence();
browser.brave = emptyBrowserEvidence();
browser.syntheticInAppBrowser = emptySyntheticInAppBrowserEvidence();
browser.automationAttempt = null;
browser.installedEvidence = emptyInstalledBrowserEvidence();
browser.limitations = [
  'Node tests and static checks do not establish installed Chrome behavior.',
  'Only canonical assertions with both an implemented semantic validator and authentic exact-artifact executor observations may pass; every unimplemented, unobserved, unsupported, ambiguous, or incomplete assertion remains non-passing in the mechanical 48-cell aggregate.',
  'Chrome evidence cannot be reused as Brave evidence.',
  'No browser version or extension artifact hash is approved until the matrix is actually run.',
  'Executable version discovery is not a disposable-profile run and must not satisfy any browser assertion.',
  'ChatGPT in-app Browser synthetic UI results are not installed-extension evidence and remain isolated in their separate evidence object.'
];
browser.reviewerApproval = false;
queueJson('docs/evidence/browser-validation.json', browser);

const performance = resetPerformanceEvidence(await json('docs/evidence/performance-results.json'), {
  version: nextVersion,
  artifactBase
});
queueJson('docs/evidence/performance-results.json', performance);

const accessibility = resetAccessibilityEvidence(await json('docs/evidence/accessibility-results.json'), {
  version: nextVersion,
  artifactBase
});
queueJson('docs/evidence/accessibility-results.json', accessibility);

const media = resetMediaEvidence(await json('docs/evidence/media-inventory.json'), {
  version: nextVersion,
  artifactBase
});
queueJson('docs/evidence/media-inventory.json', media);

await source('docs/evidence/automated-validation-current.json');
const validationEvidenceTransition = await planValidationEvidenceVersionTransition(projectRoot, {
  previousVersion,
  nextVersion,
  date
});
const automated = resetAutomatedValidationEvidence(validationEvidenceTransition.previousEvidence, {
  version: nextVersion,
  artifactBase,
  runtimeFileCount: RUNTIME_FILES.length,
  releaseState: currentStatus
});

const provenance = resetProvenanceTechnicalEvidence(await json('docs/evidence/provenance-audit.json'), {
  runtimeFileCount: RUNTIME_FILES.length
});
queueJson('docs/evidence/provenance-audit.json', provenance);

const prettierConfig = (await resolveConfig(resolve(projectRoot, 'package.json'))) || {};
for (const path of ['CHANGELOG.md', 'docs/architecture.md', 'docs/release-readiness.md']) {
  updates.set(
    path,
    await format(await source(path), {
      ...prettierConfig,
      filepath: resolve(projectRoot, path)
    })
  );
}

const fingerprintSnapshot = await computeVersionFingerprintSnapshot(projectRoot, updates);
const fingerprint = fingerprintSnapshot.runtimeFingerprintSha256;
const releaseInputFingerprint = fingerprintSnapshot.releaseInputFingerprint;
const validationRecordInputPath = validationEvidenceTransition.current.relativePath;
if (fingerprintSnapshot.inputs.has(validationRecordInputPath)) {
  throw new Error('Current validation evidence record unexpectedly entered the stable version fingerprint inventory.');
}
const versionTransactionInputSnapshot = new Map(fingerprintSnapshot.inputs);
versionTransactionInputSnapshot.set(validationRecordInputPath, validationEvidenceTransition.previousBytes);
await source('docs/evidence/version-state.json');
updates.set(
  'docs/evidence/version-state.json',
  `${JSON.stringify(
    {
      schemaVersion: 1,
      previousVersion,
      currentVersion: nextVersion,
      updatedAt: date,
      policy:
        'Every change to an allowlisted runtime file or stable release input requires a new extension version and changelog entry. Mutable post-build evidence and owner-approval records are excluded to prevent circular invalidation.',
      runtimeFileCount: RUNTIME_FILES.length,
      runtimeFingerprintSha256: fingerprint,
      releaseInputFileCount: releaseInputFingerprint.fileCount,
      releaseInputFingerprintSha256: releaseInputFingerprint.sha256
    },
    null,
    2
  )}\n`
);
const validationCreateOnlyPaths = stageValidationEvidenceVersionTransition(
  updates,
  validationEvidenceTransition,
  automated
);
await transactionalWriteFiles(projectRoot, updates, 'sitewipe-version-bump', {
  createOnlyPaths: validationCreateOnlyPaths,
  expectedOriginals: new Map(
    [...expectedOriginals].filter(([path]) => updates.has(path) && !validationCreateOnlyPaths.has(path))
  ),
  expectedInputSnapshot: versionTransactionInputSnapshot,
  resolveInputPaths: async () => {
    const { allPaths } = await collectVersionFingerprintPaths(projectRoot);
    if (allPaths.includes(validationRecordInputPath)) {
      throw new Error(
        'Current validation evidence record unexpectedly entered the stable version fingerprint inventory.'
      );
    }
    return [...allPaths, validationRecordInputPath].sort();
  }
});

console.log(
  JSON.stringify(
    {
      previousVersion,
      currentVersion: nextVersion,
      changelogDate: date,
      runtimeFingerprintSha256: fingerprint,
      releaseInputFingerprintSha256: releaseInputFingerprint.sha256,
      nextStep: 'Run npm run check, then rebuild the release candidate.'
    },
    null,
    2
  )
);

async function source(relative) {
  if (updates.has(relative)) return updates.get(relative);
  const value = await readFile(resolve(projectRoot, relative), 'utf8');
  if (!expectedOriginals.has(relative)) expectedOriginals.set(relative, value);
  return value;
}

async function json(relative) {
  return JSON.parse(await source(relative));
}

function queueJson(relative, value) {
  updates.set(relative, `${JSON.stringify(value, null, 2)}\n`);
}

async function queueRequiredReplacement(relative, before, after) {
  updates.set(relative, replaceRequired(await source(relative), before, after, relative));
}

async function assertRequiredMarker(relative, marker) {
  const value = await source(relative);
  const occurrences = value.split(marker).length - 1;
  if (occurrences !== 1) throw new Error(`${relative} must contain exactly one staged next-version marker: ${marker}`);
}

async function assertRequiredSourceStateMarker(relative, version) {
  const value = await source(relative);
  const sourceStateLines = value.split(/\r?\n/u).filter((line) => line.startsWith('Source state:'));
  const marker = `SiteWipe ${version} is the forward`;
  const occurrences = sourceStateLines.length === 1 ? sourceStateLines[0].split(marker).length - 1 : 0;
  if (sourceStateLines.length !== 1 || occurrences !== 1) {
    throw new Error(`${relative} Source state must contain exactly one staged next-version marker: ${marker}`);
  }
}

function replaceRequired(value, before, after, label) {
  const occurrences = value.split(before).length - 1;
  if (occurrences !== 1) throw new Error(`${label} must contain exactly one current-version marker: ${before}`);
  return value.replace(before, after);
}

function promoteUnreleased(value, version, releaseDate) {
  const marker = '## Unreleased';
  const markerAt = value.indexOf(marker);
  if (markerAt < 0) throw new Error('CHANGELOG.md is missing the Unreleased heading.');
  const notesStart = markerAt + marker.length;
  const nextHeading = value.indexOf('\n## ', notesStart);
  if (nextHeading < 0) throw new Error('CHANGELOG.md is missing a prior version heading.');
  const notes = value.slice(notesStart, nextHeading).trim();
  if (!notes) throw new Error('Add at least one Unreleased changelog entry before bumping the version.');
  return `${value.slice(0, markerAt)}${marker}\n\n## ${version} — public-source prerelease work — ${releaseDate}\n\n${notes}\n${value.slice(nextHeading)}`;
}

function localCalendarDate(value = new Date()) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

function emptyBrowserEvidence() {
  return {
    status: 'pending',
    version: null,
    operatingSystem: null,
    disposableProfile: null,
    assertions: []
  };
}

function emptySyntheticInAppBrowserEvidence() {
  return {
    status: 'pending',
    attemptedAt: null,
    environment: 'ChatGPT in-app Browser',
    fixture: 'HTTP-served SiteWipe UI with synthetic browser-API mocks',
    assertions: [],
    qualifiesAsInstalledExtensionEvidence: false,
    limitations: [
      'Does not load the runtime ZIP or a chrome-extension:// origin.',
      'Does not exercise native host-permission prompts, incognito spanning, MV3 worker lifecycle, or privileged browser-data mutation APIs.',
      'Cannot satisfy Chrome, Brave, installed accessibility, exact-artifact performance, compatibility, or store-media approval fields.'
    ]
  };
}

function emptyInstalledBrowserEvidence() {
  return {
    schema: 'sitewipe.private-installed-browser-run-commitment.v1',
    status: 'not_run'
  };
}

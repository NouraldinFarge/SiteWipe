import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  computeReleaseInputFingerprint,
  computeRuntimeFingerprint,
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
  resetProvenanceTechnicalEvidence
} from './evidence-reset.mjs';
import { transactionalWriteFiles } from './transactional-files.mjs';
import {
  planValidationEvidenceVersionTransition,
  stageValidationEvidenceVersionTransition
} from './validation-evidence.mjs';

const updates = new Map();
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
  [
    'docs/architecture.md',
    `\`${previousVersion}\` remains a public-source prerelease version`,
    `\`${nextVersion}\` remains a public-source prerelease version`
  ],
  ['docs/threat-model.md', `SiteWipe \`${previousVersion}\` candidate`, `SiteWipe \`${nextVersion}\` candidate`],
  ['.github/ISSUE_TEMPLATE/bug.yml', `${previousVersion} / SHA-256`, `${nextVersion} / SHA-256`]
]) {
  await queueRequiredReplacement(path, before, after);
}

let readiness = await source('docs/release-readiness.md');
readiness = replaceRequired(readiness, `v${previousVersion},`, `v${nextVersion},`, 'docs/release-readiness.md');
readiness = replaceRequired(
  readiness,
  `Public-source \`${previousVersion}\` prerelease`,
  `Public-source \`${nextVersion}\` prerelease`,
  'docs/release-readiness.md'
);
updates.set('docs/release-readiness.md', readiness);

updates.set('CHANGELOG.md', promoteUnreleased(await source('CHANGELOG.md'), nextVersion, date));

const browser = await json('docs/evidence/browser-validation.json');
browser.status = 'pending';
browser.attemptedAt = null;
delete browser.attemptedAtApproximate;
browser.artifact = { version: nextVersion, runtimeZip: `${artifactBase}.zip`, sha256: null };
browser.chrome = emptyBrowserEvidence();
browser.brave = emptyBrowserEvidence();
browser.syntheticInAppBrowser = emptySyntheticInAppBrowserEvidence();
browser.automationAttempt = null;
browser.limitations = [
  'Node tests and static checks do not establish installed Chrome behavior.',
  'Chrome evidence cannot be reused as Brave evidence.',
  'No browser version or extension artifact hash is approved until the matrix is actually run.',
  'Executable version discovery is not a disposable-profile run and must not satisfy any browser assertion.',
  'ChatGPT in-app Browser synthetic UI results are not installed-extension evidence and remain isolated in their separate evidence object.'
];
browser.reviewerApproval = false;
queueJson('docs/evidence/browser-validation.json', browser);

const performance = await json('docs/evidence/performance-results.json');
performance.status = 'pending';
performance.measuredAt = null;
performance.environment = {};
performance.artifact = { version: nextVersion, runtimeZip: `${artifactBase}.zip`, sha256: null };
performance.fixtures = [];
performance.reviewerApproval = false;
queueJson('docs/evidence/performance-results.json', performance);

const accessibility = resetAccessibilityEvidence(await json('docs/evidence/accessibility-results.json'), {
  version: nextVersion,
  artifactBase
});
queueJson('docs/evidence/accessibility-results.json', accessibility);

const media = await json('docs/evidence/media-inventory.json');
media.status = 'pending';
media.authenticScreenshotCount = 0;
media.demoDurationSeconds = 0;
media.screenshots = [];
media.demo = null;
media.artifact = { version: nextVersion, runtimeZip: `${artifactBase}.zip`, sha256: null };
media.storeAssets = {
  ...media.storeAssets,
  screenshots1280x800: [],
  promotionalTile440x280: null,
  marquee1400x560: null,
  githubSocialPreview: null
};
media.reviewerApproval = false;
queueJson('docs/evidence/media-inventory.json', media);

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

const fingerprint = await computeRuntimeFingerprint(projectRoot, updates);
const releaseInputFingerprint = await computeReleaseInputFingerprint(projectRoot, updates);
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
  createOnlyPaths: validationCreateOnlyPaths
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
  return updates.get(relative) ?? readFile(resolve(projectRoot, relative), 'utf8');
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

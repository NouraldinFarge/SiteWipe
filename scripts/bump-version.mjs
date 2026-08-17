import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { format, resolveConfig } from 'prettier';

import {
  computeReleaseInputFingerprint,
  computeRuntimeFingerprint,
  projectRoot,
  resolveNextVersion,
  runtimeArtifactBase
} from './versioning.mjs';
import { RUNTIME_FILES } from './release-files.mjs';
import { transactionalWriteFiles } from './transactional-files.mjs';
import { resolveCurrentValidationEvidence } from './validation-evidence.mjs';

const updates = new Map();
const request = process.argv[2] || 'patch';
const pkg = await json('package.json');
const previousVersion = pkg.version;
const nextVersion = resolveNextVersion(previousVersion, request);
const artifactBase = runtimeArtifactBase(nextVersion);
const date = localCalendarDate();

queueJson('package.json', { ...pkg, version: nextVersion });

const lock = await json('package-lock.json');
lock.version = nextVersion;
if (!lock.packages?.['']) throw new Error('package-lock workspace record is missing.');
lock.packages[''].version = nextVersion;
queueJson('package-lock.json', lock);

const dependencyInventory = await json('docs/evidence/dependency-license-inventory.json');
dependencyInventory.lockfileSha256 = sha256(await source('package-lock.json'));
queueJson('docs/evidence/dependency-license-inventory.json', dependencyInventory);

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
  ['README.md', `current candidate version \`${previousVersion}\``, `current candidate version \`${nextVersion}\``],
  ['PRIVACY.md', `SiteWipe \`${previousVersion}\``, `SiteWipe \`${nextVersion}\``],
  ['SECURITY.md', `private \`${previousVersion}\` candidate`, `private \`${nextVersion}\` candidate`],
  ['src/README.md', `Version \`${previousVersion}\``, `Version \`${nextVersion}\``],
  [
    'docs/architecture.md',
    `\`${previousVersion}\` remains a private candidate version`,
    `\`${nextVersion}\` remains a private candidate version`
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
  `private \`${previousVersion}\``,
  `private \`${nextVersion}\``,
  'docs/release-readiness.md'
);
const readinessPath = resolve(projectRoot, 'docs/release-readiness.md');
const prettierConfig = (await resolveConfig(readinessPath)) || {};
readiness = await format(readiness, { ...prettierConfig, filepath: readinessPath });
updates.set('docs/release-readiness.md', readiness);

updates.set('CHANGELOG.md', promoteUnreleased(await source('CHANGELOG.md'), nextVersion, date));

const browser = await json('docs/evidence/browser-validation.json');
browser.status = 'pending';
browser.attemptedAt = null;
browser.artifact = { version: nextVersion, runtimeZip: `${artifactBase}.zip`, sha256: null };
browser.chrome = emptyBrowserEvidence();
browser.brave = emptyBrowserEvidence();
browser.automationAttempt = null;
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

const accessibility = await json('docs/evidence/accessibility-results.json');
accessibility.status = 'pending_installed_validation';
accessibility.installedChecks = Object.fromEntries(
  Object.keys(accessibility.installedChecks || {}).map((key) => [key, 'pending'])
);
accessibility.browserVersions = {};
accessibility.artifact = { version: nextVersion, runtimeZip: `${artifactBase}.zip`, sha256: null };
delete accessibility.artifactSha256;
accessibility.reviewerApproval = false;
queueJson('docs/evidence/accessibility-results.json', accessibility);

const validationEvidence = await resolveCurrentValidationEvidence(projectRoot);
const automated = await json(validationEvidence.relativePath);
automated.status = 'version_bumped_pending_validation';
automated.validatedAt = null;
automated.fullCheck.status = 'pending';
automated.fullCheck.versionContract = {
  status: 'pending',
  version: nextVersion,
  runtimeFiles: RUNTIME_FILES.length,
  runtimeFingerprintSha256: null
};
automated.fullCheck.manifest.version = nextVersion;
automated.artifacts = {
  ...automated.artifacts,
  status: 'pending_rebuild',
  runtimeZip: `${artifactBase}.zip`,
  runtimeZipSha256: null,
  runtimeZipBytes: null,
  sourceZip: `${artifactBase}-source.zip`,
  sourceFiles: null,
  sourcePackageEquivalence: 'pending',
  checksumFilesVerified: 0,
  consecutiveBuildOutputsCompared: 0,
  byteIdenticalAcrossConsecutiveBuilds: false,
  runtimeSbom: `${artifactBase}.runtime-sbom.cdx.json`,
  unsignedProvenanceInput: `${artifactBase}.unsigned-provenance-input.json`
};
queueJson(validationEvidence.relativePath, automated);

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
await transactionalWriteFiles(projectRoot, updates);

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
  return `${value.slice(0, markerAt)}${marker}\n\n## ${version} — private release-candidate work — ${releaseDate}\n\n${notes}\n${value.slice(nextHeading)}`;
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

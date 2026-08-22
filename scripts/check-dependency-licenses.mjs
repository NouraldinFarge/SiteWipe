import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertDirectDevelopmentDependencyTuplesMatchEvidence,
  assertDependencyInventoryMatchesLockfile
} from './dependency-license-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageBytes = await readFile(resolve(root, 'package.json'));
const lockBytes = await readFile(resolve(root, 'package-lock.json'));
const pkg = JSON.parse(packageBytes);
const lock = JSON.parse(lockBytes);
const evidence = JSON.parse(await readFile(resolve(root, 'docs/evidence/dependency-license-inventory.json')));
const failures = [];

requireValue(lock.lockfileVersion === 3, 'package-lock.json must use lockfileVersion 3');
requireValue(Object.keys(pkg.dependencies || {}).length === 0, 'runtime npm dependencies must remain empty');
try {
  assertDependencyInventoryMatchesLockfile(evidence, lockBytes);
} catch (error) {
  failures.push(error.message);
}

try {
  assertDirectDevelopmentDependencyTuplesMatchEvidence(pkg, lock, evidence);
} catch (error) {
  failures.push(error.message);
}

const lockedPackages = Object.entries(lock.packages || {}).filter(([path]) => path.startsWith('node_modules/'));
requireValue(
  lockedPackages.length === evidence.lockedDevelopmentGraphCount,
  `locked development graph count differs: ${lockedPackages.length}/${evidence.lockedDevelopmentGraphCount}`
);
const nonDevelopmentPackages = lockedPackages.filter(([, value]) => value.dev !== true);
requireValue(
  nonDevelopmentPackages.length === 0,
  `non-development package entries found: ${nonDevelopmentPackages.map(([path]) => path).join(', ')}`
);

validateCandidateAuditState();

const licenseCounts = {};
const missingLicenseDeclarations = [];
const installScriptPackages = [];
for (const [path, value] of lockedPackages) {
  const declaredLicense = typeof value.license === 'string' && value.license.trim() ? value.license.trim() : null;
  if (declaredLicense) licenseCounts[declaredLicense] = (licenseCounts[declaredLicense] || 0) + 1;
  else {
    licenseCounts.MISSING = (licenseCounts.MISSING || 0) + 1;
    missingLicenseDeclarations.push({ path, version: value.version });
  }
  if (value.hasInstallScript === true) installScriptPackages.push({ path, version: value.version });
}

requireValue(
  JSON.stringify(sortObject(licenseCounts)) === JSON.stringify(sortObject(evidence.licenseCounts || {})),
  'transitive license counts differ from the reviewed evidence'
);
requireValue(
  JSON.stringify(missingLicenseDeclarations) ===
    JSON.stringify((evidence.metadataExceptions || []).map(({ path, version }) => ({ path, version }))),
  'license-metadata exceptions differ from the reviewed evidence'
);
requireValue(
  JSON.stringify(installScriptPackages) ===
    JSON.stringify((evidence.installScriptPackages || []).map(({ path, version }) => ({ path, version }))),
  'install-script package inventory differs from the reviewed evidence'
);

for (const exception of evidence.metadataExceptions || []) {
  const packageRoot = resolve(root, exception.path);
  const installedPackage = JSON.parse(await readFile(resolve(packageRoot, 'package.json')));
  const declared =
    installedPackage.license ||
    installedPackage.licenses
      ?.map((entry) => entry.type)
      .filter(Boolean)
      .join(' OR ');
  requireValue(
    installedPackage.version === exception.version,
    `installed exception version differs: ${exception.path}`
  );
  requireValue(declared === exception.resolvedLicense, `installed exception license differs: ${exception.path}`);
  const licenseBytes = await readFile(resolve(packageRoot, exception.licenseFile));
  requireValue(sha256(licenseBytes) === exception.licenseFileSha256, `license text differs: ${exception.path}`);
}

if (failures.length) {
  throw new Error(`Dependency-license validation failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
}

console.log(
  `Dependency-license inventory passed for ${lockedPackages.length} development packages; ${missingLicenseDeclarations.length} legacy metadata exception resolved from installed license text.`
);

function requireValue(condition, message) {
  if (!condition) failures.push(message);
}

function validateCandidateAuditState() {
  requireValue(evidence.candidateVersion === pkg.version, 'dependency evidence candidate version is stale');
  if (evidence.status === 'pending_current_candidate_audit') {
    requireValue(evidence.inventoriedAt === null, 'pending dependency inventory must not retain an inventory date');
    requireValue(evidence.lastAuditAt === null, 'pending dependency inventory must not retain an audit date');
    requireValue(
      Object.values(evidence.npmAuditVulnerabilities || {}).every((value) => value === null),
      'pending dependency inventory must not retain npm audit results'
    );
    requireValue(
      evidence.developmentSbom?.status === 'pending',
      'pending dependency inventory must mark its SBOM pending'
    );
    requireValue(
      evidence.developmentSbom?.componentVersion === pkg.version,
      'pending development SBOM target version is stale'
    );
    for (const field of ['components', 'dependencyNodes', 'bytes', 'sha256', 'generatedAt']) {
      requireValue(evidence.developmentSbom?.[field] === null, `pending development SBOM must not retain ${field}`);
    }
    return;
  }

  requireValue(
    evidence.status === 'technical_inventory_complete_owner_acknowledged',
    'dependency evidence status must be pending or technically complete'
  );
  requireValue(isCalendarDate(evidence.inventoriedAt), 'completed dependency inventory date is missing or malformed');
  requireValue(isCalendarDate(evidence.lastAuditAt), 'completed dependency audit date is missing or malformed');
  const audit = evidence.npmAuditVulnerabilities || {};
  for (const severity of ['info', 'low', 'moderate', 'high', 'critical', 'total']) {
    requireValue(Number.isInteger(audit[severity]) && audit[severity] >= 0, `npm audit ${severity} count is invalid`);
  }
  requireValue(
    audit.total === audit.info + audit.low + audit.moderate + audit.high + audit.critical,
    'npm audit total does not equal its severity counts'
  );
  const sbom = evidence.developmentSbom || {};
  requireValue(sbom.status === 'passed', 'completed dependency inventory must have a passed development SBOM');
  requireValue(sbom.componentVersion === pkg.version, 'development SBOM component version is stale');
  requireValue(Number.isInteger(sbom.components) && sbom.components > 0, 'development SBOM component count is invalid');
  requireValue(
    Number.isInteger(sbom.dependencyNodes) && sbom.dependencyNodes > 0,
    'development SBOM dependency-node count is invalid'
  );
  requireValue(Number.isInteger(sbom.bytes) && sbom.bytes > 0, 'development SBOM byte count is invalid');
  requireValue(/^[A-F0-9]{64}$/.test(sbom.sha256 || ''), 'development SBOM SHA-256 is missing or malformed');
  requireValue(isIsoTimestamp(sbom.generatedAt), 'development SBOM generation timestamp is missing or malformed');
}

function isCalendarDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function sortObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

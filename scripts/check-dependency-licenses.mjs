import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageBytes = await readFile(resolve(root, 'package.json'));
const lockBytes = await readFile(resolve(root, 'package-lock.json'));
const pkg = JSON.parse(packageBytes);
const lock = JSON.parse(lockBytes);
const evidence = JSON.parse(await readFile(resolve(root, 'docs/evidence/dependency-license-inventory.json')));
const failures = [];

requireValue(lock.lockfileVersion === 3, 'package-lock.json must use lockfileVersion 3');
requireValue(Object.keys(pkg.dependencies || {}).length === 0, 'runtime npm dependencies must remain empty');
requireValue(
  JSON.stringify(pkg.devDependencies || {}) === JSON.stringify(lock.packages?.['']?.devDependencies || {}),
  'package.json and package-lock.json direct development dependencies differ'
);
requireValue(
  evidence.lockfileSha256 === sha256(lockBytes),
  'dependency-license evidence is stale for the current package-lock.json'
);

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

function sortObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

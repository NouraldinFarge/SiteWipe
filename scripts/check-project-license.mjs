import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [licenseBytes, decision, pkg, lock, sourcePkg] = await Promise.all([
  readFile(resolve(root, 'LICENSE')),
  json('docs/decisions/license.json'),
  json('package.json'),
  json('package-lock.json'),
  json('src/package.json')
]);
const licenseText = licenseBytes.toString('utf8');
const failures = [];

requireValue(decision.status === 'owner_approved', 'license decision must be owner-approved');
requireValue(decision.ownerApproved === true, 'license decision ownerApproved must be true');
requireValue(decision.model === 'MIT', 'license decision model must be MIT');
requireValue(decision.spdxIdentifier === 'MIT', 'license decision SPDX identifier must be MIT');
requireValue(decision.licenseFileRequired === true, 'MIT decision must require a LICENSE file');
requireValue(decision.licenseFile === 'LICENSE', 'license decision must identify the root LICENSE file');
requireValue(
  decision.licenseFileSha256 === sha256(licenseBytes),
  'license decision hash does not match the root LICENSE bytes'
);
requireValue(pkg.license === 'MIT', 'root package metadata must declare MIT');
requireValue(lock.packages?.['']?.license === 'MIT', 'lockfile root package metadata must declare MIT');
requireValue(sourcePkg.license === 'MIT', 'extension source package metadata must declare MIT');
requireValue(licenseText.startsWith('MIT License\n\n'), 'LICENSE must contain the MIT license heading');
requireValue(
  licenseText.includes('Copyright (c) 2026 Nouraldin Farge'),
  'LICENSE must identify the confirmed copyright holder and year'
);
requireValue(
  licenseText.includes('THE SOFTWARE IS PROVIDED "AS IS"'),
  'LICENSE must include the MIT warranty disclaimer'
);

if (failures.length) {
  throw new Error(`Project-license validation failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
}

console.log(`Project license passed: MIT (${sha256(licenseBytes)}).`);

async function json(relative) {
  return JSON.parse(await readFile(resolve(root, relative), 'utf8'));
}

function requireValue(condition, message) {
  if (!condition) failures.push(message);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

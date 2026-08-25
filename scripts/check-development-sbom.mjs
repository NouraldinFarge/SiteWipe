import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertDevelopmentSbomEvidenceMatches, inspectDevelopmentSbom } from './development-sbom.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const inventory = JSON.parse(await readFile(resolve(root, 'docs/evidence/dependency-license-inventory.json'), 'utf8'));
const inspection = await inspectDevelopmentSbom({
  root,
  path: inventory.developmentSbom?.path,
  expectedName: pkg.name,
  expectedVersion: pkg.version
});

if (inventory.developmentSbom?.status === 'passed') {
  assertDevelopmentSbomEvidenceMatches(inventory.developmentSbom, inspection);
}

console.log(
  `Development SBOM passed concrete-file validation: ${inspection.components} components, ` +
    `${inspection.dependencyNodes} dependency nodes, SHA-256 ${inspection.sha256}.`
);

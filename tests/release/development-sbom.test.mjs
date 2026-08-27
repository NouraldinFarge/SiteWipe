import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { assertDevelopmentSbomEvidenceMatches, inspectDevelopmentSbom } from '../../scripts/development-sbom.mjs';

test('development SBOM inspection binds evidence to concrete bytes and graph counts', async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), 'sitewipe-development-sbom-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'validation-output'));
  const path = 'validation-output/sitewipe-development-sbom.cdx.json';
  await writeFile(
    resolve(root, path),
    `${JSON.stringify({
      bomFormat: 'CycloneDX',
      specVersion: '1.6',
      metadata: { component: { name: 'sitewipe-unreleased-candidate', version: '1.11.77' } },
      components: [{ type: 'library', name: 'eslint', version: '10.8.1' }],
      dependencies: [{ ref: 'pkg:npm/eslint@10.8.1', dependsOn: [] }]
    })}\n`
  );

  const inspection = await inspectDevelopmentSbom({
    root,
    path,
    expectedName: 'sitewipe-unreleased-candidate',
    expectedVersion: '1.11.77'
  });
  assert.equal(inspection.components, 1);
  assert.equal(inspection.dependencyNodes, 1);
  assert.match(inspection.sha256, /^[A-F0-9]{64}$/);
  assert.doesNotThrow(() => assertDevelopmentSbomEvidenceMatches({ ...inspection }, inspection));
  assert.throws(
    () => assertDevelopmentSbomEvidenceMatches({ ...inspection, sha256: '0'.repeat(64) }, inspection),
    /differs from the concrete file: sha256/i
  );
});

test('development SBOM inspection rejects path escape and stale component identity', async (context) => {
  const root = await mkdtemp(resolve(tmpdir(), 'sitewipe-development-sbom-invalid-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'validation-output'));
  await writeFile(resolve(root, 'outside.json'), '{}\n');
  await assert.rejects(
    inspectDevelopmentSbom({
      root,
      path: 'outside.json',
      expectedName: 'sitewipe-unreleased-candidate',
      expectedVersion: '1.11.77'
    }),
    /beneath the project validation-output directory/i
  );
});

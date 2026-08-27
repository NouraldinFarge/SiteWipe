import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

import { assertExactGeneratedFile } from '../../scripts/release-artifact-verification.mjs';
import {
  createCurrentReleaseIndex,
  createReleaseNotes,
  createRuntimeSbom,
  createSourcePackageEquivalence,
  createUnsignedProvenance,
  parsePublicSuffixMetadata,
  serializeReleaseJson
} from '../../scripts/release-metadata.mjs';

test('every derived release metadata payload rejects independently reindexed mutations', async (context) => {
  const directory = await mkdtemp(resolve(tmpdir(), 'sitewipe-release-metadata-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const digest = 'A'.repeat(64);
  const sourceCommit = 'b'.repeat(40);
  const runtimeEntries = [{ path: 'manifest.json', size: 12, sha256: 'C'.repeat(64) }];
  const outputs = [{ name: 'sitewipe-v9.9.9.zip', sha256: digest, bytes: 12 }];
  const publicSuffixMetadata = {
    source: 'https://publicsuffix.org/list/public_suffix_list.dat',
    version: 'fixture-version',
    sha256: 'E'.repeat(64),
    license: 'MPL-2.0'
  };
  const expected = new Map([
    [
      'sitewipe-v9.9.9.source-package-equivalence.json',
      serializeReleaseJson(
        createSourcePackageEquivalence({
          base: 'sitewipe-v9.9.9',
          runtimeArtifactSha256: digest,
          sourceCommit,
          runtimeEntries,
          packagedFileCount: 1,
          manifestAtZipRoot: true
        })
      )
    ],
    [
      'sitewipe-v9.9.9.runtime-sbom.cdx.json',
      serializeReleaseJson(createRuntimeSbom({ name: 'SiteWipe', version: '9.9.9', publicSuffixMetadata }))
    ],
    ['sitewipe-v9.9.9.release-notes.md', createReleaseNotes({ name: 'SiteWipe', version: '9.9.9' })],
    [
      'sitewipe-v9.9.9.unsigned-provenance-input.json',
      serializeReleaseJson(
        createUnsignedProvenance({
          base: 'sitewipe-v9.9.9',
          runtimeArtifactSha256: digest,
          version: '9.9.9',
          sourceCommit,
          runtimeEntries,
          nodeVersion: 'v24.0.0',
          platform: 'win32',
          architecture: 'x64',
          gitVersion: 'git version 2.55.0.windows.3',
          gitExecutableSha256: 'D'.repeat(64)
        })
      )
    ],
    [
      'current-release.json',
      serializeReleaseJson(
        createCurrentReleaseIndex({ base: 'sitewipe-v9.9.9', version: '9.9.9', sourceCommit, outputs })
      )
    ]
  ]);

  for (const [name, bytes] of expected) {
    await writeFile(resolve(directory, name), bytes, 'utf8');
    await assert.doesNotReject(assertExactGeneratedFile(directory, name, bytes));
    await writeFile(resolve(directory, name), `${bytes.trimEnd()} \\n`, 'utf8');
    await assert.rejects(assertExactGeneratedFile(directory, name, bytes), /canonical derivation/i, name);
  }
});

test('runtime SBOM metadata is derived from the exact committed PSL metadata record', () => {
  const committedSource = Buffer.from(
    `export const PUBLIC_SUFFIX_METADATA = Object.freeze(${JSON.stringify({
      source: 'https://publicsuffix.org/list/public_suffix_list.dat',
      version: 'fresh-snapshot',
      bytes: 123,
      sha256: 'F'.repeat(64),
      license: 'MPL-2.0'
    })});\n`,
    'utf8'
  );
  const metadata = parsePublicSuffixMetadata(committedSource);
  const sbom = createRuntimeSbom({ name: 'SiteWipe', version: '9.9.9', publicSuffixMetadata: metadata });
  assert.equal(sbom.components[0].version, 'fresh-snapshot');
  assert.equal(sbom.components[0].hashes[0].content, 'F'.repeat(64));
  assert.throws(
    () => createRuntimeSbom({ name: 'SiteWipe', version: '9.9.9' }),
    /requires exact committed public-suffix metadata/i
  );
  assert.throws(
    () => parsePublicSuffixMetadata(Buffer.from(committedSource.toString('utf8').replace('F'.repeat(64), 'stale'))),
    /incomplete or invalid/i
  );
});

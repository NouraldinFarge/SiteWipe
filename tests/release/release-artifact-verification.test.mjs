import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('release verification consumes one captured directory snapshot and performs a terminal complete replay', async () => {
  const source = await readFile(new URL('../../scripts/release-artifact-verification.mjs', import.meta.url), 'utf8');
  const verifier = source.slice(
    source.indexOf('export async function verifyReleaseCandidate'),
    source.indexOf('export async function assertExactGeneratedFile')
  );

  assert.match(verifier, /captureExactDirectorySnapshot\(releaseDirectory\)/u);
  assert.match(verifier, /readExactDirectorySnapshotFiles\(artifactSnapshot\)/u);
  assert.match(verifier, /committedSourceEntries:\s*expectedSourceEntries/u);
  assert.match(verifier, /runtimeArtifactBytes:\s*runtimeZipBytes/u);
  assert.match(verifier, /readZipEntriesFromBuffer\(runtimeZipBytes\)/u);
  assert.match(verifier, /readZipEntriesFromBuffer\(sourceZipBytes\)/u);
  assert.match(verifier, /replayExactDirectorySnapshot\(artifactSnapshot\)/u);
  assert.doesNotMatch(verifier, /\breadZipEntries\s*\(/u);
  assert.doesNotMatch(verifier, /\breadFile\s*\(/u);
  assert.doesNotMatch(verifier, /\breaddir\s*\(/u);
});

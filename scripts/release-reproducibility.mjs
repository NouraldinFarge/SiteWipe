import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function snapshotReleaseDirectory(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const snapshot = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile()) throw new Error(`Release snapshot contains a non-file entry: ${entry.name}`);
    const bytes = await readFile(resolve(directory, entry.name));
    snapshot.push({ name: entry.name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  if (!snapshot.length) throw new Error('Release snapshot is empty.');
  return snapshot;
}

export function assertReleaseSnapshotsEqual(first, second) {
  if (!Array.isArray(first) || !Array.isArray(second)) throw new TypeError('Release snapshots must be arrays.');
  if (first.length !== second.length) {
    throw new Error(`Consecutive release builds have different file counts: ${first.length}/${second.length}`);
  }
  for (let index = 0; index < first.length; index += 1) {
    const left = first[index];
    const right = second[index];
    if (left.name !== right.name || left.bytes !== right.bytes || left.sha256 !== right.sha256) {
      throw new Error(
        `Consecutive release builds differ at ${left.name || '<missing>'}/${right.name || '<missing>'}: ` +
          `${left.sha256 || 'missing'} != ${right.sha256 || 'missing'}`
      );
    }
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

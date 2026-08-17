import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const provenance = JSON.parse(await readFile(resolve(root, 'assets/brand/icon-provenance.json'), 'utf8'));
const failures = [];
const source = await readFile(resolve(root, provenance.source));
compareHash(provenance.source, source, provenance.sourceSha256);

for (const output of provenance.outputs || []) {
  const bytes = await readFile(resolve(root, output.path));
  compareHash(output.path, bytes, output.sha256);
  if (bytes.toString('ascii', 1, 4) !== 'PNG') failures.push(`${output.path}: not a PNG file`);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (`${width}x${height}` !== output.dimensions)
    failures.push(`${output.path}: dimensions ${width}x${height} do not match ${output.dimensions}`);
  if (bytes.length !== output.bytes)
    failures.push(`${output.path}: size ${bytes.length} does not match ${output.bytes}`);
}
if ((provenance.outputs || []).length !== 4) failures.push('Exactly four runtime icon outputs must be recorded.');
if ((provenance.externalAssets || []).length) failures.push('Candidate icon unexpectedly declares external assets.');

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exit(1);
}
console.log('Editable icon source and four generated PNG provenance checks passed.');

function compareHash(label, bytes, expected) {
  const actual = createHash('sha256').update(bytes).digest('hex').toUpperCase();
  if (actual !== String(expected || '').toUpperCase()) failures.push(`${label}: SHA-256 mismatch ${actual}`);
}

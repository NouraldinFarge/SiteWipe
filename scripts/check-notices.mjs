import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(await readFile(resolve(root, 'third_party/public-suffix-list/metadata.json'), 'utf8'));
const notices = await readFile(resolve(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
const psl = await readFile(resolve(root, 'third_party/public-suffix-list/public_suffix_list.dat'));
const corpus = await readFile(resolve(root, 'tests/fixtures/public-suffix-list/test_psl.txt'));
const license = await readFile(resolve(root, 'third_party/public-suffix-list/LICENSE'));
const failures = [];

checkHash('PSL data', psl, metadata.sha256);
checkHash('PSL corpus', corpus, metadata.testCorpus?.sha256);
checkHash('PSL license', license, metadata.license?.sha256);
for (const required of [
  metadata.version,
  metadata.commit,
  metadata.sha256,
  metadata.testCorpus?.sha256,
  'MPL-2.0',
  'CC0-1.0'
]) {
  if (!required || !notices.toUpperCase().includes(String(required).toUpperCase()))
    failures.push(`THIRD_PARTY_NOTICES.md is missing ${required || 'required metadata'}`);
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exit(1);
}
console.log('Third-party notice and pinned PSL hash checks passed.');

function checkHash(label, bytes, expected) {
  const actual = createHash('sha256').update(bytes).digest('hex').toUpperCase();
  if (actual !== String(expected || '').toUpperCase()) failures.push(`${label} SHA-256 mismatch: ${actual}`);
}

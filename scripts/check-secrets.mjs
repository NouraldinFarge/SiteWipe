import { readFile } from 'node:fs/promises';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSourceArchivePaths } from './source-archive.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const patterns = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g, 'private key'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AWS access key'],
  [/\bgh[opurs]_[A-Za-z0-9_]{36,}\b/g, 'GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, 'GitHub fine-grained token'],
  [/\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/g, 'Stripe-style secret'],
  [/[A-Za-z]:\\(?:Users|Documents|Extensions_Programs)\\/gi, 'absolute private Windows path'],
  [/\/(?:Users|home)\/[A-Za-z0-9._-]+\//g, 'absolute private home path']
];
const textExtensions = new Set(['.css', '.html', '.js', '.json', '.md', '.mjs', '.svg', '.txt', '.yml', '.yaml']);
const files = await collectSourceArchivePaths(root);
const failures = [];

for (const path of files) {
  if (!textExtensions.has(extname(path).toLowerCase())) continue;
  const text = await readFile(path, 'utf8');
  for (const [pattern, label] of patterns) {
    if (pattern.test(text)) failures.push(`${relative(root, path)}: possible ${label}`);
    pattern.lastIndex = 0;
  }
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exit(1);
}
console.log(`Secret/private-path scan passed for ${files.length} repository files.`);

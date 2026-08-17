import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflows = resolve(root, '.github', 'workflows');
const failures = [];
let checked = 0;

for (const entry of await readdir(workflows, { withFileTypes: true })) {
  if (!entry.isFile() || !/\.ya?ml$/i.test(entry.name)) continue;
  const text = await readFile(resolve(workflows, entry.name), 'utf8');
  for (const match of text.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#.*)?$/gm)) {
    const reference = match[1];
    if (reference.startsWith('./') || reference.startsWith('docker://')) continue;
    checked += 1;
    if (!/@[0-9a-f]{40}$/i.test(reference))
      failures.push(`${entry.name}: action is not pinned to a full commit: ${reference}`);
  }
}

if (!checked) failures.push('No external GitHub Actions references were found.');
if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exit(1);
}
console.log(`GitHub Actions pin check passed for ${checked} references.`);

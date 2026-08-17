import { lstat, readFile, readdir } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const markdown = [...(await filesBelow(root, (path) => path.endsWith('.md')))].filter((path) => !ignored(path));
const failures = [];
const exactStatus =
  'Private release candidate undergoing safety, privacy, accessibility, and release-readiness validation.';
const statusRequired = new Set([
  'README.md',
  'PRIVACY.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'SUPPORT.md',
  'CHANGELOG.md',
  'docs/architecture.md',
  'docs/threat-model.md',
  'docs/safety-case.md',
  'docs/permissions.md',
  'docs/privacy-data-flow.md',
  'docs/testing.md',
  'docs/performance.md',
  'docs/releasing.md',
  'docs/capability-matrix.md',
  'docs/claim-evidence.md',
  'docs/release-readiness.md',
  'docs/provenance.md'
]);

for (const path of markdown) {
  const repoPath = relative(root, path).replaceAll('\\', '/');
  const text = await readFile(path, 'utf8');
  if (statusRequired.has(repoPath) && !text.includes(exactStatus))
    failures.push(`${repoPath}: exact release status missing`);
  for (const match of text.matchAll(/!?(?:\[[^\]]*\])\(([^)]+)\)/g)) {
    let target = match[1].trim().replace(/^<|>$/g, '');
    if (!target || /^(?:https?:|mailto:|#)/i.test(target)) continue;
    target = decodeURIComponent(target.split('#')[0]);
    if (!target) continue;
    try {
      await lstat(resolve(dirname(path), target));
    } catch {
      failures.push(`${repoPath}: missing local link ${match[1]}`);
    }
  }
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exit(1);
}
console.log(`Documentation check passed for ${markdown.length} Markdown files.`);

async function filesBelow(directory, predicate) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (ignored(path)) continue;
    if (entry.isDirectory()) output.push(...(await filesBelow(path, predicate)));
    else if (entry.isFile() && predicate(path)) output.push(path);
  }
  return output;
}

function ignored(path) {
  return /[\\/](?:node_modules|coverage|dist|\.git)(?:[\\/]|$)/i.test(path);
}

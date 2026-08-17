import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isLocalGeneratedPath } from './release-files.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = (await discover(root)).filter((path) => ['.js', '.mjs'].includes(extname(path))).sort();

for (const path of files) {
  const result = spawnSync(process.execPath, ['--check', path], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${path}\n`);
    process.exit(result.status || 1);
  }
}
console.log(`Syntax check passed for ${files.length} JavaScript modules.`);

async function discover(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.name === '.git' || entry.name === 'third_party' || isLocalGeneratedPath(path)) continue;
    if (entry.isDirectory()) found.push(...(await discover(path)));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

import { spawnSync } from 'node:child_process';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectSourceArchivePaths } from './source-archive.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = (await collectSourceArchivePaths(root)).filter((path) => ['.js', '.mjs'].includes(extname(path))).sort();

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

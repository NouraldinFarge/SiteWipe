import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = await discover(resolve(root, 'tests'));
if (!files.length) throw new Error('No test files were discovered.');

const result = await new Promise((resolveResult, reject) => {
  const child = spawn(process.execPath, ['--test', ...files], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true
  });
  child.once('error', reject);
  child.once('close', (code, signal) => resolveResult({ code, signal }));
});
if (result.signal) console.error(`Test runner terminated by ${result.signal}.`);
if (result.signal || result.code !== 0) process.exitCode = result.code || 1;

async function discover(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await discover(path)));
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) found.push(path);
  }
  return found;
}

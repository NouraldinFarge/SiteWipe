import { lstat, readdir } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORBIDDEN_PACKAGE_PATTERNS, RUNTIME_FILES, SOURCE_ONLY_FILES } from './release-files.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'src');
const sourceRootInfo = await lstat(src);
if (sourceRootInfo.isSymbolicLink() || !sourceRootInfo.isDirectory()) {
  throw new Error(`The runtime source root must be a real directory, not a symbolic link: ${src}`);
}
const actual = (await discover(src)).map((path) => relative(src, path).split(sep).join('/')).sort();
const expected = [...RUNTIME_FILES, ...SOURCE_ONLY_FILES].sort();
const unknown = actual.filter((path) => !expected.includes(path));
const missing = expected.filter((path) => !actual.includes(path));
const forbidden = actual.filter((path) => FORBIDDEN_PACKAGE_PATTERNS.some((pattern) => pattern.test(path)));
const errors = [];
if (unknown.length) errors.push(`Unclassified source files:\n${unknown.map((path) => `  ${path}`).join('\n')}`);
if (missing.length) errors.push(`Allowlisted files are missing:\n${missing.map((path) => `  ${path}`).join('\n')}`);
if (forbidden.length)
  errors.push(`Forbidden source/package files:\n${forbidden.map((path) => `  ${path}`).join('\n')}`);
if (!RUNTIME_FILES.includes('manifest.json')) errors.push('manifest.json must be explicitly packaged at the ZIP root.');
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(
  `Package allowlist passed: ${RUNTIME_FILES.length} runtime files, ${SOURCE_ONLY_FILES.length} source-only files.`
);

async function discover(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Symbolic links are prohibited: ${path}`);
    if (entry.isDirectory()) found.push(...(await discover(path)));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

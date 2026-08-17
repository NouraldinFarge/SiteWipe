import { execFile as execFileCallback } from 'node:child_process';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { auditPublicationScope, parseGitIndexEntries, parseNullPaths } from './publication-scope.mjs';
import { collectSourceArchivePaths } from './source-archive.mjs';

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const canonicalRoot = await realpath(root);
const gitRoot = await realGitPath(['rev-parse', '--show-toplevel']);
const gitDirectory = await realGitPath(['rev-parse', '--absolute-git-dir']);
const parentRepository = await optionalGitText(['rev-parse', '--show-toplevel'], resolve(root, '..'));
const indexEntries = parseGitIndexEntries(await gitBuffer(['ls-files', '--cached', '--stage', '-z']));
const publicationPaths = parseNullPaths(
  await gitBuffer(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
);
const sourcePaths = (await collectSourceArchivePaths(root)).map((path) => repositoryPath(path));
const remoteDecision = JSON.parse(await readFile(resolve(root, 'docs/decisions/remote-publication.json'), 'utf8'));
const remoteNames = lines(await gitText(['remote']));
const fetchRemoteUrls = remoteNames.includes('origin')
  ? lines(await gitText(['remote', 'get-url', '--all', 'origin']))
  : [];
const pushRemoteUrls = remoteNames.includes('origin')
  ? lines(await gitText(['remote', 'get-url', '--push', '--all', 'origin']))
  : [];
const nestedGitMarkers = await findNestedGitMarkers(root);

const audit = auditPublicationScope({
  indexEntries,
  publicationPaths,
  sourcePaths,
  rootMatches: samePath(canonicalRoot, gitRoot),
  gitDirectoryInsideRoot: isInside(canonicalRoot, gitDirectory),
  parentRepositoryDetected: Boolean(parentRepository),
  nestedGitMarkers,
  remoteDecisionApproved: remoteDecision?.ownerApproved === true && remoteDecision?.repositoryCreated === true,
  expectedRepositoryUrl: remoteDecision?.repositoryUrl,
  remoteNames,
  fetchRemoteUrls,
  pushRemoteUrls
});

if (audit.failures.length) {
  console.error(audit.failures.map((failure) => `- ${failure}`).join('\n'));
  process.exit(1);
}

console.log(
  `Git publication scope passed: ${audit.trackedFiles} tracked files, ${audit.publicationFiles} Git-visible files, ` +
    `${audit.sourceFiles} source-closure files, one approved remote, no outer/nested Git metadata, and no prohibited index modes or paths.`
);

async function gitBuffer(args) {
  const { stdout } = await execFile('git', args, {
    cwd: root,
    encoding: null,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  });
  return stdout;
}

async function gitText(args) {
  const { stdout } = await execFile('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true
  });
  return stdout.trim();
}

async function optionalGitText(args, cwd) {
  try {
    const { stdout } = await execFile('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function realGitPath(args) {
  return realpath(resolve(await gitText(args)));
}

function repositoryPath(absolute) {
  const path = relative(root, absolute);
  if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error('Source closure escaped the SiteWipe repository root.');
  }
  return path.split(sep).join('/');
}

function lines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function samePath(left, right) {
  const normalize = (value) => (process.platform === 'win32' ? value.toLocaleLowerCase('en-US') : value);
  return normalize(resolve(left)) === normalize(resolve(right));
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return Boolean(path) && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function findNestedGitMarkers(directory) {
  const ignoredDirectories = new Set([
    'node_modules',
    'coverage',
    'dist',
    'test-results',
    'playwright-report',
    'browser-profiles',
    '.pnpm-store'
  ]);
  const markers = [];
  await visit(directory, true);
  return markers;

  async function visit(current, isRoot) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = resolve(current, entry.name);
      if (entry.name === '.git') {
        if (!isRoot) markers.push(repositoryPath(absolute));
        continue;
      }
      if (!entry.isDirectory() || entry.isSymbolicLink() || ignoredDirectories.has(entry.name)) continue;
      const info = await lstat(absolute);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      await visit(absolute, false);
    }
  }
}

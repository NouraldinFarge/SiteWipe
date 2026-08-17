import { posix } from 'node:path';

import { FORBIDDEN_PACKAGE_PATTERNS } from './release-files.mjs';

const FORBIDDEN_PUBLICATION_PATTERNS = Object.freeze([
  ...FORBIDDEN_PACKAGE_PATTERNS,
  /(^|\/)\.env(?:\.|$)/i,
  /(^|\/)(?:\.agents|\.codex)(\/|$)/i,
  /\.(?:db|har|kdbx|sqlite|sqlite3)$/i
]);

const WINDOWS_RESERVED_SEGMENT = /^(?:aux|con|nul|prn|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const WINDOWS_FORBIDDEN_CHARACTERS = /[<>:"|?*]/;
const ALLOWED_INDEX_MODES = new Set(['100644', '100755']);

export function parseGitIndexEntries(value) {
  const records = splitNullRecords(value);
  return records.map((record) => {
    const separator = record.indexOf('\t');
    if (separator <= 0) throw new Error('Malformed Git index record.');
    const metadata = record.slice(0, separator);
    const path = record.slice(separator + 1);
    const match = /^(\d{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])$/.exec(metadata);
    if (!match) throw new Error('Malformed Git index metadata.');
    return { mode: match[1], objectId: match[2], stage: Number(match[3]), path };
  });
}

export function parseNullPaths(value) {
  return splitNullRecords(value);
}

export function normalizeGitHubRepositoryUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const scp = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i.exec(raw);
  if (scp) return repositoryIdentity(scp[1], scp[2]);

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!['https:', 'ssh:'].includes(parsed.protocol) || parsed.hostname.toLowerCase() !== 'github.com') return null;
  if (parsed.password || parsed.search || parsed.hash || parsed.port) return null;
  if (parsed.protocol === 'https:' && parsed.username) return null;
  if (parsed.protocol === 'ssh:' && parsed.username && parsed.username !== 'git') return null;
  const segments = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (segments.length !== 2) return null;
  return repositoryIdentity(segments[0], segments[1].replace(/\.git$/i, ''));
}

export function auditPublicationScope({
  indexEntries,
  publicationPaths,
  sourcePaths,
  rootMatches,
  gitDirectoryInsideRoot,
  parentRepositoryDetected,
  nestedGitMarkers,
  remoteDecisionApproved,
  expectedRepositoryUrl,
  remoteNames,
  fetchRemoteUrls,
  pushRemoteUrls
}) {
  const failures = [];
  if (!rootMatches) failures.push('Git worktree root does not match the SiteWipe publication root.');
  if (!gitDirectoryInsideRoot) failures.push('Git metadata is outside the SiteWipe publication root.');
  if (parentRepositoryDetected) failures.push('The private outer container is also inside a Git worktree.');
  for (const marker of nestedGitMarkers || []) failures.push(`Nested Git metadata is present: ${marker}`);

  const canonicalPublication = validatePathCollection(publicationPaths, 'Git publication candidate', failures);
  const canonicalSource = validatePathCollection(sourcePaths, 'Source archive', failures);
  const publicationSet = new Set(canonicalPublication);
  const sourceSet = new Set(canonicalSource);
  const trackedSet = new Set();

  for (const entry of indexEntries || []) {
    const path = validatePublicationPath(entry.path, 'Git index', failures);
    if (!path) continue;
    trackedSet.add(path);
    if (entry.stage !== 0) failures.push(`Git index contains an unresolved merge stage: ${path}`);
    if (!ALLOWED_INDEX_MODES.has(entry.mode)) {
      const type = entry.mode === '120000' ? 'symbolic link' : entry.mode === '160000' ? 'Git submodule' : entry.mode;
      failures.push(`Git index contains a prohibited ${type}: ${path}`);
    }
    if (!publicationSet.has(path)) failures.push(`Tracked path is absent from the publication candidate set: ${path}`);
  }

  for (const path of canonicalPublication) {
    if (!trackedSet.has(path)) failures.push(`Git-visible path is not tracked in the publication index: ${path}`);
    if (!sourceSet.has(path)) failures.push(`Git-visible path is omitted from the reviewed source closure: ${path}`);
  }
  for (const path of canonicalSource) {
    if (!trackedSet.has(path)) failures.push(`Reviewed source path is not tracked in the publication index: ${path}`);
    if (!publicationSet.has(path))
      failures.push(`Reviewed source path is excluded from Git publication candidates: ${path}`);
  }

  const expectedIdentity = remoteDecisionApproved ? normalizeGitHubRepositoryUrl(expectedRepositoryUrl) : null;
  if (!expectedIdentity) failures.push('The owner-approved GitHub repository identity is missing or invalid.');
  if (remoteNames?.length !== 1 || remoteNames[0] !== 'origin') {
    failures.push('Git publication requires exactly one remote named origin.');
  }
  for (const [label, urls] of [
    ['fetch', fetchRemoteUrls],
    ['push', pushRemoteUrls]
  ]) {
    if (!Array.isArray(urls) || urls.length !== 1) {
      failures.push(`Git origin must have exactly one ${label} URL.`);
      continue;
    }
    const identity = normalizeGitHubRepositoryUrl(urls[0]);
    if (!identity || identity !== expectedIdentity) {
      failures.push(`Git origin ${label} destination does not match the owner-approved repository.`);
    }
  }

  return {
    failures: [...new Set(failures)],
    trackedFiles: trackedSet.size,
    publicationFiles: publicationSet.size,
    sourceFiles: sourceSet.size,
    expectedRepositoryIdentity: expectedIdentity
  };
}

function validatePathCollection(values, label, failures) {
  const paths = [];
  const exact = new Set();
  const caseInsensitive = new Map();
  for (const value of values || []) {
    const path = validatePublicationPath(value, label, failures);
    if (!path) continue;
    if (exact.has(path)) failures.push(`${label} contains a duplicate path: ${path}`);
    exact.add(path);
    const folded = path.toLocaleLowerCase('en-US');
    const previous = caseInsensitive.get(folded);
    if (previous && previous !== path)
      failures.push(`${label} contains a case-insensitive path collision: ${previous}`);
    else caseInsensitive.set(folded, path);
    paths.push(path);
  }
  return paths;
}

function validatePublicationPath(value, label, failures) {
  const path = String(value || '');
  const segments = path.split('/');
  if (
    !path ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    hasControlCharacters(path) ||
    path !== path.normalize('NFC') ||
    path !== posix.normalize(path) ||
    WINDOWS_FORBIDDEN_CHARACTERS.test(path) ||
    segments.some((segment) => !segment || segment === '.' || segment === '..' || /[. ]$/.test(segment)) ||
    segments.some((segment) => WINDOWS_RESERVED_SEGMENT.test(segment))
  ) {
    failures.push(`${label} contains a non-portable or escaping path.`);
    return null;
  }
  if (FORBIDDEN_PUBLICATION_PATTERNS.some((pattern) => pattern.test(path))) {
    failures.push(`${label} contains a prohibited private/generated path: ${path}`);
  }
  return path;
}

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function repositoryIdentity(owner, repository) {
  if (!owner || !repository || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repository)) return null;
  return `github.com/${owner}/${repository}`.toLowerCase();
}

function splitNullRecords(value) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value || '');
  if (text.includes('\uFFFD')) throw new Error('Git path output is not valid UTF-8.');
  const records = text.split('\0');
  if (records.at(-1) === '') records.pop();
  return records;
}

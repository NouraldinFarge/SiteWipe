import { createHash } from 'node:crypto';
import { lstat as nativeLstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path';

export const EVIDENCE_FINALIZATION_MANIFEST_SCHEMA = 'sitewipe.evidence-finalization-manifest.v2';
export const EVIDENCE_FINALIZATION_MANIFEST_PATH = 'docs/evidence/evidence-finalization-manifest.json';

const REQUIRED_RECORD_PATHS = Object.freeze([
  'docs/evidence/accessibility-results.json',
  'docs/evidence/browser-semantic-receipts.json',
  'docs/evidence/browser-validation.json',
  'docs/evidence/media-inventory.json',
  'docs/evidence/performance-results.json'
]);
const REQUIRED_RECORD_KINDS = Object.freeze(
  new Map([
    ['docs/evidence/accessibility-results.json', 'accessibility'],
    ['docs/evidence/browser-semantic-receipts.json', 'browser'],
    ['docs/evidence/browser-validation.json', 'browser'],
    ['docs/evidence/media-inventory.json', 'media'],
    ['docs/evidence/performance-results.json', 'performance']
  ])
);
const ENTRY_KEYS = Object.freeze(['bytes', 'kind', 'path', 'sha256']);
const IDENTITY_KEYS = Object.freeze([
  'artifactSha256',
  'artifactVersion',
  'browserAggregateSha256',
  'browserResultSetSha256',
  'browserRuntimeSetSha256',
  'gitExecutableSha256',
  'harnessManifestSha256',
  'launchPolicySha256',
  'nativeHelperSha256',
  'nodeExecutableSha256',
  'nodeRuntimeVersion',
  'packageLockSha256',
  'powerShellExecutableSha256',
  'processObserverHelperSha256',
  'publicReceiptSetSha256',
  'releaseInputFingerprintSha256',
  'runtimeFingerprintSha256',
  'semanticValidatorManifestSha256',
  'testedCommitSha',
  'testedTreeSha',
  'toolchainBytes',
  'toolchainFileCount',
  'toolchainPackageCount',
  'toolchainPuppeteerVersion',
  'toolchainSetSha256'
]);
const MANIFEST_KEYS = Object.freeze([
  'completedAt',
  'entries',
  'identity',
  'recordedByAutomation',
  'schema',
  'version'
]);
const ENTRY_KINDS = Object.freeze(new Set(['accessibility', 'automated', 'browser', 'media', 'performance']));
const EXACT_STAT_OPTIONS = Object.freeze({ bigint: true });

export async function validateEvidenceFinalizationManifest({
  repositoryRoot,
  manifest,
  changedPaths,
  expectedIdentity = undefined,
  deriveExpectedIdentityFromSnapshot = undefined,
  snapshotRecordPaths = undefined,
  testOnlyAfterFirstPass = undefined,
  testOnlyAfterManifestRead = undefined
}) {
  validateManifestShape(manifest);
  if ((expectedIdentity === undefined) === (deriveExpectedIdentityFromSnapshot === undefined)) {
    throw new Error(
      'Evidence finalization requires exactly one expected identity or final-snapshot identity derivation.'
    );
  }
  if (deriveExpectedIdentityFromSnapshot !== undefined && typeof deriveExpectedIdentityFromSnapshot !== 'function') {
    throw new Error('Final-snapshot evidence identity derivation must be a function.');
  }
  if (deriveExpectedIdentityFromSnapshot === undefined && snapshotRecordPaths !== undefined) {
    throw new Error('Finalized snapshot-record paths require final-snapshot identity derivation.');
  }
  assertExactStringArray(changedPaths, 'Post-browser changed paths');
  const root = await exactPhysicalDirectory(repositoryRoot, 'Evidence-finalization repository root');
  const manifestPath = resolveContainedRepositoryPath(root.path, EVIDENCE_FINALIZATION_MANIFEST_PATH);
  const manifestDirectories = await captureEvidenceDirectories(root, [EVIDENCE_FINALIZATION_MANIFEST_PATH]);
  const diskManifest = await readCanonicalManifest(manifestPath);
  await runTestOnlyHook(testOnlyAfterManifestRead, 'after-manifest-read');
  await revalidateEvidenceDirectories(manifestDirectories);
  if (!diskManifest.bytes.equals(canonicalJsonBytes(manifest))) {
    throw new Error('Supplied evidence finalization manifest differs from the exact canonical on-disk manifest.');
  }
  const exactSnapshotRecordPaths =
    deriveExpectedIdentityFromSnapshot === undefined
      ? Object.freeze([])
      : validateSnapshotRecordPaths(snapshotRecordPaths, diskManifest.value);
  const expectedChangedPaths = [
    EVIDENCE_FINALIZATION_MANIFEST_PATH,
    ...diskManifest.value.entries.map(({ path }) => path)
  ].sort();
  if (!exactArray(changedPaths, expectedChangedPaths)) {
    throw new Error('Post-browser changed paths differ from the exact hash-listed evidence finalization delta.');
  }

  const directories = await captureEvidenceDirectories(root, [
    EVIDENCE_FINALIZATION_MANIFEST_PATH,
    ...diskManifest.value.entries.map(({ path }) => path)
  ]);
  assertDirectoryIdentityExtension(manifestDirectories, directories);
  const firstPass = await replayManifestEntries(root.path, diskManifest.value.entries);
  await revalidateEvidenceDirectories(directories);
  await runTestOnlyHook(testOnlyAfterFirstPass, 'after-first-pass');
  const finalPass = await replayManifestEntries(root.path, diskManifest.value.entries);
  for (const [index, observed] of finalPass.entries()) {
    const earlier = firstPass[index];
    if (
      !observed.bytes.equals(earlier.bytes) ||
      observed.sha256 !== earlier.sha256 ||
      !sameEvidenceFileIdentity(observed.information, earlier.information)
    ) {
      throw new Error(`Finalized evidence changed between complete replay passes: ${observed.path}.`);
    }
  }
  await revalidateEvidenceDirectories(directories);
  const records = parseFinalReplayRecords(finalPass, exactSnapshotRecordPaths);
  const finalManifest = await readCanonicalManifest(manifestPath);
  if (
    !finalManifest.bytes.equals(diskManifest.bytes) ||
    !sameEvidenceFileIdentity(finalManifest.information, diskManifest.information)
  ) {
    throw new Error('Evidence finalization manifest changed during final replay.');
  }
  await revalidateEvidenceDirectories(directories);
  const snapshot = deepFreeze({
    manifestSha256: sha256(finalManifest.bytes),
    manifest: finalManifest.value,
    changedPaths: Object.freeze(expectedChangedPaths),
    entries: finalManifest.value.entries.map((entry) => ({ ...entry })),
    records
  });
  const resolvedExpectedIdentity =
    deriveExpectedIdentityFromSnapshot === undefined ? expectedIdentity : deriveExpectedIdentityFromSnapshot(snapshot);
  assertPlainJson(resolvedExpectedIdentity, 'Expected evidence finalization identity');
  assertExactKeys(resolvedExpectedIdentity, IDENTITY_KEYS, 'Expected evidence finalization identity');
  if (stableJson(resolvedExpectedIdentity) !== stableJson(snapshot.manifest.identity)) {
    throw new Error('Evidence finalization identity differs from independently computed expected values.');
  }
  return snapshot;
}

export function canonicalEvidenceFinalizationJsonBytes(value) {
  return canonicalJsonBytes(value);
}

export function canonicalFinalizedEvidenceRecordJson(value, label = 'Finalized evidence record') {
  assertPlainJson(value, label);
  return canonicalJsonBytes(value).toString('utf8');
}

export function validateManifestShape(manifest) {
  assertPlainJson(manifest, 'Evidence finalization manifest');
  assertExactKeys(manifest, MANIFEST_KEYS, 'Evidence finalization manifest');
  if (
    manifest.schema !== EVIDENCE_FINALIZATION_MANIFEST_SCHEMA ||
    !/^\d+\.\d+\.\d+$/.test(String(manifest.version || '')) ||
    !isIsoTimestamp(manifest.completedAt) ||
    manifest.recordedByAutomation !== true ||
    !Array.isArray(manifest.entries) ||
    !manifest.entries.length
  ) {
    throw new Error('Evidence finalization manifest has an invalid schema, version, time, origin, or entry list.');
  }
  assertExactKeys(manifest.identity, IDENTITY_KEYS, 'Evidence finalization identity');
  if (
    manifest.identity.artifactVersion !== manifest.version ||
    !isGitObjectId(manifest.identity.testedCommitSha) ||
    !isGitObjectId(manifest.identity.testedTreeSha) ||
    !isNodeRuntimeVersion(manifest.identity.nodeRuntimeVersion) ||
    !isPackageVersion(manifest.identity.toolchainPuppeteerVersion) ||
    !isPositiveSafeInteger(manifest.identity.toolchainPackageCount) ||
    !isPositiveSafeInteger(manifest.identity.toolchainFileCount) ||
    !isPositiveSafeInteger(manifest.identity.toolchainBytes) ||
    IDENTITY_KEYS.filter((key) => key.endsWith('Sha256')).some((key) => !isSha256(manifest.identity[key]))
  ) {
    throw new Error('Evidence finalization identity is incomplete or inconsistent with its version.');
  }

  const paths = [];
  for (const entry of manifest.entries) {
    assertExactKeys(entry, ENTRY_KEYS, 'Evidence finalization entry');
    if (
      !isApprovedFinalizationPath(entry.path, manifest.version) ||
      !ENTRY_KINDS.has(entry.kind) ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes <= 0 ||
      !isSha256(entry.sha256)
    ) {
      throw new Error(
        `Evidence finalization entry is malformed or outside the exact allowlist: ${String(entry.path)}.`
      );
    }
    if (entry.kind !== expectedFinalizationKind(entry.path, manifest.version)) {
      throw new Error(`Evidence finalization record ${entry.path} has the wrong evidence kind.`);
    }
    paths.push(entry.path);
  }
  const sorted = [...paths].sort();
  if (new Set(paths).size !== paths.length || !exactArray(paths, sorted)) {
    throw new Error('Evidence finalization entries must be unique and sorted by normalized path.');
  }
  for (const requiredPath of REQUIRED_RECORD_PATHS) {
    if (!paths.includes(requiredPath))
      throw new Error(`Evidence finalization is missing required record ${requiredPath}.`);
    if (manifest.entries.find(({ path }) => path === requiredPath)?.kind !== REQUIRED_RECORD_KINDS.get(requiredPath)) {
      throw new Error(`Evidence finalization record ${requiredPath} has the wrong evidence kind.`);
    }
  }
  if (findPrivateString(manifest)) {
    throw new Error(
      'Evidence finalization manifest contains a private path, file URI, capability, token, or encoded payload.'
    );
  }
  return manifest;
}

export function isApprovedFinalizationPath(value, version) {
  return expectedFinalizationKind(value, version) !== null;
}

export function expectedFinalizationKind(value, version) {
  if (!isNormalizedRepositoryPath(value) || value === EVIDENCE_FINALIZATION_MANIFEST_PATH) return null;
  if (REQUIRED_RECORD_PATHS.includes(value)) return REQUIRED_RECORD_KINDS.get(value);
  if (value === 'docs/evidence/automated-validation-current.json' || value === 'docs/evidence/provenance-audit.json') {
    return 'automated';
  }
  if (
    new RegExp(`^docs/evidence/automated-validation-\\d{4}-\\d{2}-\\d{2}-v${escapeRegExp(version)}\\.json$`).test(value)
  ) {
    return 'automated';
  }
  if (
    new RegExp(`^docs/evidence/media/sitewipe-${escapeRegExp(version)}-[a-z0-9][a-z0-9-]{1,95}\\.(?:png|mp4)$`).test(
      value
    )
  ) {
    return 'media';
  }
  return null;
}

function isNormalizedRepositoryPath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 240 &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    value === value.trim() &&
    value === posix.normalize(value) &&
    !value.startsWith('/') &&
    !value.split('/').includes('..')
  );
}

function resolveContainedRepositoryPath(repositoryRoot, path) {
  const absolute = resolve(repositoryRoot, ...path.split('/'));
  const relation = relative(repositoryRoot, absolute);
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`Finalized evidence path escapes or equals its repository root: ${path}.`);
  }
  return absolute;
}

async function readCanonicalManifest(path) {
  let identity;
  try {
    identity = await exactFileIdentity(path, 'On-disk evidence finalization manifest');
  } catch (error) {
    throw new Error('The exact on-disk evidence finalization manifest is missing or physically unsafe.', {
      cause: error
    });
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(identity.bytes));
  } catch (error) {
    throw new Error('The on-disk evidence finalization manifest is not exact UTF-8 JSON.', { cause: error });
  }
  validateManifestShape(value);
  if (!identity.bytes.equals(canonicalJsonBytes(value))) {
    throw new Error('The on-disk evidence finalization manifest is not canonical JSON.');
  }
  return Object.freeze({ ...identity, value });
}

async function replayManifestEntries(repositoryRoot, entries) {
  const observed = [];
  for (const entry of entries) {
    const absolute = resolveContainedRepositoryPath(repositoryRoot, entry.path);
    const identity = await exactFileIdentity(absolute, `Finalized evidence ${entry.path}`);
    if (identity.bytes.length !== entry.bytes || identity.sha256 !== entry.sha256) {
      throw new Error(`Finalized evidence bytes changed or differ from the manifest: ${entry.path}.`);
    }
    observed.push(Object.freeze({ ...identity, kind: entry.kind, path: entry.path }));
  }
  return Object.freeze(observed);
}

function parseFinalReplayRecords(finalPass, snapshotRecordPaths) {
  const records = {};
  for (const observed of finalPass) {
    if (!snapshotRecordPaths.includes(observed.path)) continue;
    let value;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(observed.bytes));
    } catch (error) {
      throw new Error(`Finalized evidence record is not exact UTF-8 JSON: ${observed.path}.`, { cause: error });
    }
    assertPlainJson(value, `Finalized evidence record ${observed.path}`);
    const canonicalJson = canonicalJsonBytes(value).toString('utf8');
    records[observed.path] = {
      bytes: observed.bytes.length,
      canonicalJson,
      canonicalSha256: sha256(Buffer.from(canonicalJson, 'utf8')),
      kind: observed.kind,
      path: observed.path,
      sha256: observed.sha256,
      value
    };
  }
  return deepFreeze(records);
}

function validateSnapshotRecordPaths(value, manifest) {
  assertExactStringArray(value, 'Finalized snapshot-record paths');
  const sorted = [...value].sort();
  if (!value.length || new Set(value).size !== value.length || !exactArray(value, sorted)) {
    throw new Error('Finalized snapshot-record paths must be non-empty, unique, and sorted exactly.');
  }
  for (const path of value) {
    const entry = manifest.entries.find((candidate) => candidate.path === path);
    if (!entry || !path.endsWith('.json') || !isApprovedFinalizationPath(path, manifest.version)) {
      throw new Error(`Finalized publication snapshot record is not one exact hash-listed JSON entry: ${path}.`);
    }
  }
  return Object.freeze([...value]);
}

async function captureEvidenceDirectories(root, paths) {
  const identities = new Map([[normalizedHostPath(root.path), root]]);
  for (const repositoryPath of paths) {
    const absolute = resolveContainedRepositoryPath(root.path, repositoryPath);
    const parent = dirname(absolute);
    const relation = relative(root.path, parent);
    if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
      throw new Error(`Finalized evidence parent escapes its exact repository root: ${repositoryPath}.`);
    }
    let current = root.path;
    for (const segment of relation ? relation.split(sep) : []) {
      current = resolve(current, segment);
      const key = normalizedHostPath(current);
      if (!identities.has(key)) {
        identities.set(key, await exactPhysicalDirectory(current, `Finalized evidence ancestor ${current}`));
      }
    }
  }
  return Object.freeze([...identities.values()]);
}

async function revalidateEvidenceDirectories(directories) {
  for (const expected of directories) {
    const observed = await exactPhysicalDirectory(expected.path, `Finalized evidence ancestor ${expected.path}`);
    if (!sameEvidenceDirectoryIdentity(expected.information, observed.information)) {
      throw new Error(`Finalized evidence directory identity changed during replay: ${expected.path}.`);
    }
  }
}

async function runTestOnlyHook(callback, phase) {
  if (callback === undefined) return;
  if (
    typeof callback !== 'function' ||
    typeof process.env.NODE_TEST_CONTEXT !== 'string' ||
    !process.env.NODE_TEST_CONTEXT
  ) {
    throw new Error('The evidence replay mutation hook is available only to the Node test runner.');
  }
  await callback(phase);
}

function assertDirectoryIdentityExtension(required, observed) {
  const observedByPath = new Map(observed.map((identity) => [normalizedHostPath(identity.path), identity]));
  for (const expected of required) {
    const current = observedByPath.get(normalizedHostPath(expected.path));
    if (!current || !sameEvidenceDirectoryIdentity(expected.information, current.information)) {
      throw new Error(`Finalized evidence directory identity changed before complete replay: ${expected.path}.`);
    }
  }
}

async function exactPhysicalDirectory(path, label) {
  const expected = resolve(path);
  const information = await exactEvidencePathStat(expected);
  if (
    !information.isDirectory() ||
    information.isSymbolicLink() ||
    !hasExactBigIntFields(information, ['birthtimeNs', 'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink'])
  ) {
    throw new Error(`${label} must be one physical non-reparse directory.`);
  }
  if (!samePath(await realpath(expected), expected)) throw new Error(`${label} is aliased.`);
  return Object.freeze({ path: expected, information });
}

async function exactFileIdentity(path, label) {
  const expected = resolve(path);
  const information = await exactEvidencePathStat(expected);
  assertExactEvidenceFile(information, label);
  if (!samePath(await realpath(expected), expected)) throw new Error(`${label} is aliased.`);
  const handle = await open(expected, 'r');
  try {
    const opened = await exactEvidenceHandleStat(handle);
    assertExactEvidenceFile(opened, label);
    const bytes = await handle.readFile();
    const after = await exactEvidenceHandleStat(handle);
    assertExactEvidenceFile(after, label);
    const pathAfter = await exactEvidencePathStat(expected);
    assertExactEvidenceFile(pathAfter, label);
    if (
      !sameEvidenceFileIdentity(information, opened) ||
      !sameEvidenceFileIdentity(opened, after) ||
      !sameEvidenceFileIdentity(after, pathAfter) ||
      after.size !== BigInt(bytes.length) ||
      !samePath(await realpath(expected), expected)
    ) {
      throw new Error(`${label} identity changed while hashing.`);
    }
    return Object.freeze({ bytes, information: after, sha256: sha256(bytes) });
  } finally {
    await handle.close();
  }
}

export async function exactEvidencePathStat(path, statImplementation = nativeLstat) {
  if (typeof statImplementation !== 'function')
    throw new Error('Exact evidence path-stat implementation is unavailable.');
  return statImplementation(path, EXACT_STAT_OPTIONS);
}

export async function exactEvidenceHandleStat(handle) {
  if (!handle || typeof handle.stat !== 'function')
    throw new Error('Exact evidence handle-stat capability is unavailable.');
  return handle.stat(EXACT_STAT_OPTIONS);
}

function assertExactEvidenceFile(information, label) {
  if (
    !information?.isFile() ||
    information.isSymbolicLink() ||
    !hasExactBigIntFields(information, ['birthtimeNs', 'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink', 'size']) ||
    information.nlink !== 1n ||
    information.size < 0n
  ) {
    throw new Error(`${label} must be one singly linked regular non-reparse file with exact bigint identity.`);
  }
}

function findPrivateString(value, key = '') {
  if (typeof value === 'string') {
    if (key === 'path') return false;
    const text = value.trim();
    return (
      /^file:/i.test(text) ||
      /(?:^|[\s('"`])(?:[A-Za-z]:[\\/]|\\\\|\/(?:home|Users|tmp|var)\/)/u.test(value) ||
      /(?:capability|fixture|run)[_-]?token/i.test(key) ||
      /base64/i.test(key) ||
      (text.length >= 32 &&
        text.length % 4 === 0 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(text) &&
        !isSha256(text) &&
        !isGitObjectId(text))
    );
  }
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([childKey, child]) => findPrivateString(child, childKey));
}

function assertExactKeys(value, expected, label) {
  if (!isPlainRecord(value)) throw new Error(`${label} must be an object.`);
  if (!exactArray(Object.keys(value).sort(), [...expected].sort())) {
    throw new Error(`${label} keys differ from the exact schema.`);
  }
}

function assertPlainJson(value, label) {
  if (!isPlainRecord(value)) throw new Error(`${label} must be one plain JSON object.`);
  visitPlainJson(value, label, new Set());
}

function assertExactStringArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be one exact dense string array.`);
  assertDensePlainArray(value, label);
  if (value.some((entry) => typeof entry !== 'string')) {
    throw new Error(`${label} must contain only exact strings.`);
  }
}

function assertDensePlainArray(value, label) {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const keys = Object.keys(value);
  if (
    Object.getPrototypeOf(value) !== Array.prototype ||
    keys.length !== value.length ||
    keys.some((key, index) => key !== String(index)) ||
    Reflect.ownKeys(value).length !== value.length + 1 ||
    !Object.hasOwn(descriptors, 'length') ||
    lengthDescriptor?.enumerable !== false ||
    Object.entries(descriptors).some(
      ([key, descriptor]) => key !== 'length' && (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)
    )
  ) {
    throw new Error(`${label} contains a sparse, accessor-backed, subclassed, or extended array.`);
  }
}

function visitPlainJson(value, label, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new Error(`${label} contains a non-exact number.`);
    }
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) {
    throw new Error(`${label} is not an acyclic JSON value.`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    assertDensePlainArray(value, label);
    for (const child of value) visitPlainJson(child, label, seen);
    seen.delete(value);
    return;
  }
  if (!isPlainRecord(value)) throw new Error(`${label} contains a non-plain value.`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Object.values(descriptors).some(
      (descriptor) => !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true
    ) ||
    Object.keys(descriptors).length !== Object.keys(value).length
  ) {
    throw new Error(`${label} contains accessors or hidden properties.`);
  }
  for (const child of Object.values(value)) visitPlainJson(child, label, seen);
  seen.delete(value);
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function canonicalJsonBytes(value) {
  return Buffer.from(`${stableJson(value)}\n`, 'utf8');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function samePath(left, right) {
  return normalizedHostPath(left) === normalizedHostPath(right);
}

function normalizedHostPath(value) {
  const exact = resolve(value);
  return process.platform === 'win32' ? exact.toLowerCase() : exact;
}

function sameEvidenceDirectoryIdentity(left, right) {
  const fields = ['birthtimeNs', 'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink'];
  if (!hasExactBigIntFields(left, fields) || !hasExactBigIntFields(right, fields)) return false;
  return (
    fields.every((field) => left[field] === right[field]) && (left.ino !== 0n || left.birthtimeNs === right.birthtimeNs)
  );
}

export function sameEvidenceFileIdentity(left, right) {
  const fields = ['birthtimeNs', 'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink', 'size'];
  if (!hasExactBigIntFields(left, fields) || !hasExactBigIntFields(right, fields)) return false;
  return fields.every((field) => left[field] === right[field]);
}

function hasExactBigIntFields(value, fields) {
  return Boolean(value) && fields.every((field) => typeof value[field] === 'bigint');
}

function isGitObjectId(value) {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(String(value || ''));
}

function isSha256(value) {
  return /^[A-F0-9]{64}$/.test(String(value || ''));
}

function isIsoTimestamp(value) {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function isNodeRuntimeVersion(value) {
  return typeof value === 'string' && /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

function isPackageVersion(value) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function exactArray(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

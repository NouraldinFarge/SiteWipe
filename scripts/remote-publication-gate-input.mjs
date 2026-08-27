import { createHash } from 'node:crypto';
import { lstat as nativeLstat, open, readdir, realpath } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

import {
  REMOTE_PUBLICATION_CAPTURE_EXTERNAL_DIRECTORY,
  REQUIRED_RELEASE_ENVIRONMENT_NAME,
  REQUIRED_REMOTE_PUBLICATION_CONTEXTS,
  canonicalRemotePublicationJsonBytes
} from './remote-publication-evidence.mjs';

export const REMOTE_PUBLICATION_EVIDENCE_DIRECTORY_ENVIRONMENT = 'SITEWIPE_REMOTE_PUBLICATION_EVIDENCE_DIRECTORY';
export const REMOTE_PUBLICATION_EXPECTED_BINDING_ENVIRONMENT = 'SITEWIPE_REMOTE_PUBLICATION_EXPECTED_BINDING';

const EVIDENCE_FILES = Object.freeze(['capture.json', 'raw-responses.json']);
const EXACT_STAT_OPTIONS = Object.freeze({ bigint: true });
const EXPECTED_KEYS = Object.freeze([
  'candidateActorLogin',
  'candidateBranch',
  'candidateHeadSha',
  'hostedPrivacyPolicyRawUrl',
  'hostedPrivacyPolicySha256',
  'hostedPrivacyPolicyVersion',
  'mainBranch',
  'mainHeadSha',
  'releaseEnvironmentName',
  'repository',
  'requiredChecks',
  'version'
]);

export async function readExternalRemotePublicationGateInput({
  repositoryRoot,
  evidenceDirectory,
  expectedBindingPath
}) {
  const repository = await exactPhysicalDirectory(repositoryRoot, 'Remote-publication repository root');
  const captureRoot = resolve(repository.path, ...REMOTE_PUBLICATION_CAPTURE_EXTERNAL_DIRECTORY.split('/'));
  const captureParent = await exactPhysicalDirectory(captureRoot, 'Remote-publication external capture root');
  const directory = await exactPhysicalDirectory(evidenceDirectory, 'Remote-publication evidence directory');
  if (
    dirname(directory.path) !== captureParent.path ||
    !/^sitewipe-remote-[a-z0-9][a-z0-9._-]{0,96}$/.test(directory.path.slice(captureParent.path.length + 1))
  ) {
    throw new Error('Remote-publication evidence directory is not one exact approved direct child.');
  }
  const entries = (await readdir(directory.path)).sort(compareStrings);
  if (JSON.stringify(entries) !== JSON.stringify([...EVIDENCE_FILES].sort(compareStrings))) {
    throw new Error('Remote-publication evidence directory differs from the exact two-file contract.');
  }
  const [capture, rawBundle] = await Promise.all(
    EVIDENCE_FILES.map((name) => readCanonicalJsonFile(resolve(directory.path, name), `Remote-publication ${name}`))
  );

  const expectedPath = resolve(expectedBindingPath);
  const relation = relative(repository.path, expectedPath);
  if (!relation || (!relation.startsWith(`..${sep}`) && relation !== '..')) {
    throw new Error('Remote-publication expected binding must remain outside the source repository.');
  }
  const expected = await readCanonicalJsonFile(expectedPath, 'Remote-publication expected binding');
  return Object.freeze({ capture, rawBundle, externalExpected: expected, evidenceDirectory: directory.path });
}

export function resolveExpectedRemotePublicationBinding({
  externalExpected,
  remoteDecision,
  version,
  currentHeadSha,
  privacyBytes
}) {
  assertExactKeys(externalExpected, EXPECTED_KEYS, 'External remote-publication expected binding');
  const repository = repositoryFullName(remoteDecision?.repositoryUrl);
  const candidateBranch = `candidate/sitewipe-${version}`;
  const hostedPrivacyPolicySha256 = sha256(privacyBytes);
  if (
    externalExpected.repository !== repository ||
    externalExpected.version !== version ||
    externalExpected.candidateBranch !== candidateBranch ||
    externalExpected.candidateHeadSha !== currentHeadSha ||
    externalExpected.candidateActorLogin !== remoteDecision?.maintainerHandle ||
    externalExpected.mainBranch !== remoteDecision?.defaultBranch ||
    externalExpected.hostedPrivacyPolicyRawUrl !== remoteDecision?.hostedPrivacyPolicyRawUrl ||
    externalExpected.hostedPrivacyPolicySha256 !== hostedPrivacyPolicySha256 ||
    externalExpected.hostedPrivacyPolicyVersion !== version ||
    externalExpected.releaseEnvironmentName !== remoteDecision?.requiredReleaseEnvironmentName ||
    externalExpected.releaseEnvironmentName !== REQUIRED_RELEASE_ENVIRONMENT_NAME ||
    remoteDecision?.approvedPublicCandidateVersion !== version ||
    remoteDecision?.approvedPublicCandidateBranch !== candidateBranch ||
    remoteDecision?.hostedPrivacyPolicyVersion !== version ||
    remoteDecision?.hostedPrivacyPolicySha256 !== hostedPrivacyPolicySha256 ||
    remoteDecision?.hostedPrivacyPolicyExactByteParity !== true
  ) {
    throw new Error(
      'External remote-publication expectation differs from the exact local head, version, decision, or privacy bytes.'
    );
  }
  if (
    !isGitObjectId(externalExpected.mainHeadSha) ||
    !Array.isArray(externalExpected.requiredChecks) ||
    JSON.stringify(externalExpected.requiredChecks.map(({ name }) => name)) !==
      JSON.stringify(REQUIRED_REMOTE_PUBLICATION_CONTEXTS)
  ) {
    throw new Error('External remote-publication expectation lacks the exact main head or required-context order.');
  }
  return Object.freeze(structuredClone(externalExpected));
}

async function readCanonicalJsonFile(path, label) {
  const expected = resolve(path);
  const actual = await realpath(expected);
  if (!samePath(actual, expected)) throw new Error(`${label} is aliased.`);
  const before = await exactRemoteGatePathStat(actual);
  assertExactRemoteGateFile(before, label);
  const handle = await open(actual, 'r');
  try {
    const opened = await exactRemoteGateHandleStat(handle);
    assertExactRemoteGateFile(opened, label);
    const bytes = await handle.readFile();
    const after = await exactRemoteGateHandleStat(handle);
    assertExactRemoteGateFile(after, label);
    const pathAfter = await exactRemoteGatePathStat(expected);
    assertExactRemoteGateFile(pathAfter, label);
    if (
      !sameRemoteGateFileIdentity(before, opened) ||
      !sameRemoteGateFileIdentity(opened, after) ||
      !sameRemoteGateFileIdentity(after, pathAfter) ||
      after.size !== BigInt(bytes.length) ||
      !samePath(await realpath(expected), expected)
    ) {
      throw new Error(`${label} identity changed while reading.`);
    }
    let value;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (error) {
      throw new Error(`${label} is not exact UTF-8 JSON.`, { cause: error });
    }
    if (!bytes.equals(canonicalRemotePublicationJsonBytes(value))) {
      throw new Error(`${label} is not canonical JSON.`);
    }
    return value;
  } finally {
    await handle.close();
  }
}

async function exactPhysicalDirectory(path, label) {
  const expected = resolve(path);
  const information = await exactRemoteGatePathStat(expected);
  if (
    !information.isDirectory() ||
    information.isSymbolicLink() ||
    !hasExactBigIntFields(information, ['birthtimeNs', 'dev', 'ino', 'mode', 'nlink'])
  ) {
    throw new Error(`${label} must be one physical non-reparse directory.`);
  }
  if (!samePath(await realpath(expected), expected)) throw new Error(`${label} is aliased.`);
  return Object.freeze({ path: expected, information });
}

function repositoryFullName(value) {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
    if (
      url.origin !== 'https://github.com' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path)
    ) {
      throw new Error('invalid');
    }
    return path;
  } catch {
    throw new Error('Remote-publication repository URL is not an exact GitHub owner/name URL.');
  }
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} keys differ from the exact schema.`);
  }
}

export async function exactRemoteGatePathStat(path, statImplementation = nativeLstat) {
  if (typeof statImplementation !== 'function') {
    throw new Error('Remote-publication gate exact path-stat implementation is unavailable.');
  }
  return statImplementation(path, EXACT_STAT_OPTIONS);
}

export async function exactRemoteGateHandleStat(handle) {
  if (!handle || typeof handle.stat !== 'function') {
    throw new Error('Remote-publication gate exact handle-stat capability is unavailable.');
  }
  return handle.stat(EXACT_STAT_OPTIONS);
}

function assertExactRemoteGateFile(information, label) {
  if (
    !information?.isFile() ||
    information.isSymbolicLink() ||
    !hasExactBigIntFields(information, ['birthtimeNs', 'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink', 'size']) ||
    information.nlink !== 1n ||
    information.size < 0n
  ) {
    throw new Error(`${label} must be one singly linked regular file with exact bigint identity.`);
  }
}

export function sameRemoteGateFileIdentity(left, right) {
  const fields = ['birthtimeNs', 'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink', 'size'];
  if (!hasExactBigIntFields(left, fields) || !hasExactBigIntFields(right, fields)) return false;
  return fields.every((field) => left[field] === right[field]);
}

function hasExactBigIntFields(value, fields) {
  return Boolean(value) && fields.every((field) => typeof value[field] === 'bigint');
}

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isGitObjectId(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

import { lstat as nativeLstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  GITHUB_REST_API_VERSION,
  REQUIRED_RELEASE_ENVIRONMENT_NAME,
  canonicalRemotePublicationJsonBytes
} from './remote-publication-evidence.mjs';
import {
  REMOTE_PUBLICATION_TOKEN_ENVIRONMENT,
  validateCollectorExpectedBinding
} from './collect-remote-publication-evidence.mjs';

export const REMOTE_PUBLICATION_EXPECTED_JSON_ENVIRONMENT = 'SITEWIPE_REMOTE_PUBLICATION_EXPECTED_BINDING_JSON';
export const REMOTE_PUBLICATION_EXPECTED_PATH_ENVIRONMENT = 'SITEWIPE_REMOTE_PUBLICATION_EXPECTED_BINDING';
export const REMOTE_PUBLICATION_REPOSITORY_ENVIRONMENT = 'SITEWIPE_GITHUB_REPOSITORY';
export const REMOTE_PUBLICATION_REPOSITORY_ID_ENVIRONMENT = 'SITEWIPE_GITHUB_REPOSITORY_ID';
export const REMOTE_PUBLICATION_RELEASE_ENVIRONMENT = 'SITEWIPE_RELEASE_ENVIRONMENT_NAME';
export const REMOTE_PUBLICATION_EXPECTED_VARIABLE_NAME = 'SITEWIPE_REMOTE_PUBLICATION_EXPECTED_BINDING_JSON';
export const REMOTE_PUBLICATION_TOKEN_SECRET_NAME = 'SITEWIPE_GITHUB_READ_TOKEN';

const API_ROOT = 'https://api.github.com';
const MAX_RESPONSE_BODY_BYTES = 256 * 1024;
const EXACT_STAT_OPTIONS = Object.freeze({ bigint: true });
const directory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(directory, '..');

/**
 * Proves that the injected expected binding and credential have same-named
 * entries in the protected GitHub environment before staging the exact
 * expectation outside the repository. GitHub does not expose secret values;
 * existence of the environment secret is sufficient because environment
 * secrets take precedence over same-named repository or organization values.
 * The credential and every request remain read-only and are never persisted.
 */
export async function stageRemotePublicationInputs({
  repository,
  repositoryId,
  environmentName,
  expectedJson,
  token,
  outputPath,
  repositoryRoot = projectRoot,
  fetchImpl = globalThis.fetch
}) {
  const binding = parseCanonicalExpectedJson(expectedJson);
  const exactRepository = requiredRepository(repository);
  const exactRepositoryId = requiredRepositoryId(repositoryId);
  if (environmentName !== REQUIRED_RELEASE_ENVIRONMENT_NAME) {
    throw new Error(`Protected remote inputs must come from ${REQUIRED_RELEASE_ENVIRONMENT_NAME}.`);
  }
  if (binding.repository !== exactRepository || binding.releaseEnvironmentName !== REQUIRED_RELEASE_ENVIRONMENT_NAME) {
    throw new Error('Protected remote expectation differs from the exact repository or release environment.');
  }
  assertCredential(token);
  assertSecretAbsent(token, expectedJson, binding);
  if (typeof fetchImpl !== 'function') throw new Error('Protected remote-input staging requires fetch.');

  const target = await validateCreateOnlyTarget({ outputPath, repositoryRoot });
  const encodedEnvironment = encodeURIComponent(REQUIRED_RELEASE_ENVIRONMENT_NAME);
  const repositoryUrl = `${API_ROOT}/repositories/${exactRepositoryId}`;
  const variableUrl = `${API_ROOT}/repos/${exactRepository}/environments/${encodedEnvironment}/variables/${REMOTE_PUBLICATION_EXPECTED_VARIABLE_NAME}`;
  const secretUrl = `${API_ROOT}/repos/${exactRepository}/environments/${encodedEnvironment}/secrets/${REMOTE_PUBLICATION_TOKEN_SECRET_NAME}`;

  const repositoryMetadata = await readGithubJson(repositoryUrl, { fetchImpl, token });
  if (
    !isPlainObject(repositoryMetadata) ||
    repositoryMetadata.id !== Number(exactRepositoryId) ||
    repositoryMetadata.full_name !== exactRepository
  ) {
    throw new Error('Protected remote-input repository identity differs from the trusted workflow context.');
  }

  const variable = await readGithubJson(variableUrl, { fetchImpl, token });
  if (
    !isPlainObject(variable) ||
    variable.name !== REMOTE_PUBLICATION_EXPECTED_VARIABLE_NAME ||
    typeof variable.value !== 'string' ||
    variable.value !== expectedJson
  ) {
    throw new Error('Protected environment variable metadata or value differs from the injected expectation.');
  }
  parseCanonicalExpectedJson(variable.value);

  const secret = await readGithubJson(secretUrl, { fetchImpl, token });
  if (!isPlainObject(secret) || secret.name !== REMOTE_PUBLICATION_TOKEN_SECRET_NAME) {
    throw new Error('Protected environment secret metadata differs from the required credential name.');
  }
  assertSecretAbsent(token, variable, secret);

  const bytes = canonicalRemotePublicationJsonBytes(binding);
  const handle = await open(target, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    const opened = await handle.stat(EXACT_STAT_OPTIONS);
    if (!isExactRegularFile(opened) || opened.size !== BigInt(bytes.length)) {
      throw new Error('Staged protected expectation does not have exact regular-file identity.');
    }
  } finally {
    await handle.close();
  }
  const final = await nativeLstat(target, EXACT_STAT_OPTIONS);
  if (!isExactRegularFile(final) || final.size !== BigInt(bytes.length) || !samePath(await realpath(target), target)) {
    throw new Error('Staged protected expectation changed after its create-only write.');
  }

  return Object.freeze({
    apiVersion: GITHUB_REST_API_VERSION,
    environmentName: REQUIRED_RELEASE_ENVIRONMENT_NAME,
    outputPath: target,
    repository: exactRepository,
    repositoryId: exactRepositoryId,
    secretName: REMOTE_PUBLICATION_TOKEN_SECRET_NAME,
    variableName: REMOTE_PUBLICATION_EXPECTED_VARIABLE_NAME
  });
}

function parseCanonicalExpectedJson(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_RESPONSE_BODY_BYTES) {
    throw new Error('Protected remote expectation must be bounded canonical JSON text.');
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Protected remote expectation is not valid JSON.');
  }
  const binding = validateCollectorExpectedBinding(parsed);
  const canonical = canonicalRemotePublicationJsonBytes(binding).toString('utf8').slice(0, -1);
  if (value !== canonical) throw new Error('Protected remote expectation is not canonical one-line JSON.');
  return binding;
}

async function validateCreateOnlyTarget({ outputPath, repositoryRoot }) {
  if (typeof outputPath !== 'string' || !isAbsolute(outputPath)) {
    throw new Error('Protected remote expectation output must be an absolute path.');
  }
  const repository = resolve(repositoryRoot);
  if (!samePath(await realpath(repository), repository)) {
    throw new Error('Protected remote-input repository root is aliased.');
  }
  const target = resolve(outputPath);
  const relation = relative(repository, target);
  if (!relation || (!relation.startsWith(`..${sep}`) && relation !== '..')) {
    throw new Error('Protected remote expectation output must remain outside the source repository.');
  }
  const parent = dirname(target);
  const parentInformation = await nativeLstat(parent, EXACT_STAT_OPTIONS);
  if (
    !parentInformation.isDirectory() ||
    parentInformation.isSymbolicLink() ||
    !samePath(await realpath(parent), parent)
  ) {
    throw new Error('Protected remote expectation parent must be one physical directory.');
  }
  try {
    await nativeLstat(target, EXACT_STAT_OPTIONS);
    throw new Error('Protected remote expectation output already exists.');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return target;
}

async function readGithubJson(url, { fetchImpl, token }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        'Accept-Encoding': 'identity',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'SiteWipe-protected-remote-input-provenance',
        'X-GitHub-Api-Version': GITHUB_REST_API_VERSION
      },
      redirect: 'error',
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer'
    });
  } catch {
    throw new Error(`Protected remote-input metadata request failed for ${url}.`);
  }
  if (!response?.headers?.get || !response.body || typeof response.body.getReader !== 'function') {
    throw new Error(`Protected remote-input metadata response is malformed for ${url}.`);
  }
  if (response.redirected === true || (response.url && response.url !== url)) {
    throw new Error(`Protected remote-input metadata response redirected away from ${url}.`);
  }
  const encoding = response.headers.get('content-encoding');
  if (encoding !== null && encoding.toLowerCase() !== 'identity') {
    throw new Error(`Protected remote-input metadata response ignored identity encoding for ${url}.`);
  }
  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) <= 0 || Number(declaredLength) > MAX_RESPONSE_BODY_BYTES)
  ) {
    throw new Error(`Protected remote-input metadata response has an invalid bounded length for ${url}.`);
  }
  const body = await readBoundedBody(response, url);
  if (declaredLength !== null && Number(declaredLength) !== body.length) {
    throw new Error(`Protected remote-input metadata response differs from its declared length for ${url}.`);
  }
  if (body.includes(Buffer.from(token, 'utf8'))) {
    throw new Error('Protected remote-input metadata response unexpectedly contains the credential.');
  }
  if (response.status !== 200) {
    throw new Error(`Protected remote-input metadata request returned HTTP ${String(response.status)} for ${url}.`);
  }
  const contentType = response.headers.get('content-type');
  if (typeof contentType !== 'string' || !/^application\/(?:json|vnd\.github\+json)\b/i.test(contentType)) {
    throw new Error(`Protected remote-input metadata response has an unexpected content type for ${url}.`);
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new Error(`Protected remote-input metadata response is not exact UTF-8 JSON for ${url}.`);
  }
}

async function readBoundedBody(response, url) {
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      let result;
      try {
        result = await reader.read();
      } catch {
        throw new Error(`Protected remote-input metadata body could not be read for ${url}.`);
      }
      if (!isPlainObject(result) || typeof result.done !== 'boolean') {
        throw new Error(`Protected remote-input metadata body is malformed for ${url}.`);
      }
      if (result.done) break;
      if (!(result.value instanceof Uint8Array) || result.value.byteLength <= 0) {
        throw new Error(`Protected remote-input metadata body is malformed for ${url}.`);
      }
      const chunk = Buffer.from(result.value);
      length += chunk.length;
      if (length > MAX_RESPONSE_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The bounded read has already failed closed.
        }
        throw new Error(`Protected remote-input metadata body exceeds its bound for ${url}.`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  if (length <= 0) throw new Error(`Protected remote-input metadata body is empty for ${url}.`);
  return Buffer.concat(chunks, length);
}

function requiredRepository(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error('Protected remote-input repository must use exact owner/name form.');
  }
  return value;
}

function requiredRepositoryId(value) {
  const text = String(value ?? '');
  const number = Number(text);
  if (!/^[1-9]\d{0,15}$/.test(text) || !Number.isSafeInteger(number)) {
    throw new Error('Protected remote-input repository ID is invalid.');
  }
  return text;
}

function assertCredential(token) {
  if (
    typeof token !== 'string' ||
    token.length < 20 ||
    token.length > 512 ||
    token.trim() !== token ||
    hasControlCharacters(token)
  ) {
    throw new Error(`A read-only GitHub credential is required through ${REMOTE_PUBLICATION_TOKEN_ENVIRONMENT}.`);
  }
}

function hasControlCharacters(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint < 33 || codePoint === 127;
  });
}

function assertSecretAbsent(token, ...values) {
  for (const value of values) {
    if (JSON.stringify(value).includes(token)) {
      throw new Error('Protected remote-input value unexpectedly contains the authentication credential.');
    }
  }
}

function isExactRegularFile(information) {
  return (
    information?.isFile() === true &&
    information.isSymbolicLink() === false &&
    typeof information.nlink === 'bigint' &&
    information.nlink === 1n &&
    typeof information.size === 'bigint' &&
    information.size >= 0n
  );
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function main() {
  const result = await stageRemotePublicationInputs({
    repository: process.env[REMOTE_PUBLICATION_REPOSITORY_ENVIRONMENT],
    repositoryId: process.env[REMOTE_PUBLICATION_REPOSITORY_ID_ENVIRONMENT],
    environmentName: process.env[REMOTE_PUBLICATION_RELEASE_ENVIRONMENT],
    expectedJson: process.env[REMOTE_PUBLICATION_EXPECTED_JSON_ENVIRONMENT],
    token: process.env[REMOTE_PUBLICATION_TOKEN_ENVIRONMENT],
    outputPath: process.env[REMOTE_PUBLICATION_EXPECTED_PATH_ENVIRONMENT]
  });
  console.log(
    JSON.stringify({
      status: 'protected_remote_inputs_verified_and_staged',
      apiVersion: result.apiVersion,
      environmentName: result.environmentName,
      outputPath: result.outputPath,
      repository: result.repository,
      repositoryId: result.repositoryId,
      secretName: result.secretName,
      variableName: result.variableName
    })
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  });
}

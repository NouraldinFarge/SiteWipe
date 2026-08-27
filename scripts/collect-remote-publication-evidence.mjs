import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat as nativeLstat, mkdir, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  GITHUB_REST_API_VERSION,
  REMOTE_PUBLICATION_CAPTURE_EXTERNAL_DIRECTORY,
  REMOTE_PUBLICATION_CAPTURE_SCHEMA,
  REMOTE_PUBLICATION_CAPTURE_SOURCE,
  REMOTE_PUBLICATION_CAPTURE_STORAGE_POLICY,
  REQUIRED_REMOTE_PUBLICATION_CONTEXTS,
  computeCanonicalRemotePublicationSha256,
  computeRemotePublicationCaptureSha256,
  validateRemotePublicationCapture
} from './remote-publication-evidence.mjs';

export const REMOTE_PUBLICATION_RAW_BUNDLE_SCHEMA = 'sitewipe.remote-publication-raw-response-bundle.v1';
export const REMOTE_PUBLICATION_TOKEN_ENVIRONMENT = 'SITEWIPE_GITHUB_READ_TOKEN';

const API_ROOT = 'https://api.github.com';
const MAX_PAGES = 100;
const MAX_HEADER_LENGTH = 16_384;
const MAX_RESPONSE_BODY_BYTES = 16 * 1024 * 1024;
const EXACT_STAT_OPTIONS = Object.freeze({ bigint: true });
const WRITE_CAPABLE_PERMISSIONS = Object.freeze(['admin', 'maintain', 'write']);
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
const LOCAL_ATTESTATIONS = Object.freeze([
  'codeqlDismissalIndependentReview',
  'independentPublicationReview',
  'independentReviewerAvailability'
]);
const directory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(directory, '..');

/**
 * Collects one bounded, read-only GitHub observation window. Authentication is
 * applied only to api.github.com and is never returned, written, or included in
 * an error. Raw response bodies are returned only in the separate ignored-data
 * bundle; the publication capture contains their byte counts and SHA-256s.
 */
export async function collectRemotePublicationEvidence({
  expected,
  token,
  fetchImpl = globalThis.fetch,
  clock = defaultClock
}) {
  const binding = validateCollectorExpectedBinding(expected);
  assertCredential(token);
  assertSecretAbsent(token, binding);
  if (typeof fetchImpl !== 'function') throw new Error('Remote collector requires a fetch implementation.');
  if (typeof clock !== 'function') throw new Error('Remote collector requires a clock function.');

  const timeline = createTimeline(clock);
  const retained = [];
  const read = createReadOnlyFetcher({ fetchImpl, retained, timeline, token });
  const repoPath = `/repos/${binding.repository}`;
  const candidateRefUrl = apiUrl(`${repoPath}/git/ref/heads/${encodeURIComponent(binding.candidateBranch)}`);
  const mainRefUrl = apiUrl(`${repoPath}/git/ref/heads/${encodeURIComponent(binding.mainBranch)}`);

  const candidateRefBefore = await collectRefObservation(read, candidateRefUrl, binding.candidateBranch);
  const mainRefBefore = await collectRefObservation(read, mainRefUrl, binding.mainBranch);
  assertExpectedRef(candidateRefBefore.projection, binding.candidateHeadSha, 'Candidate ref before capture');
  assertExpectedRef(mainRefBefore.projection, binding.mainHeadSha, 'Main ref before capture');

  const repository = await collectRepositoryObservation(read, apiUrl(repoPath));
  const mainProtection = await collectMainProtectionObservation(
    read,
    apiUrl(`${repoPath}/branches/${encodeURIComponent(binding.mainBranch)}/protection`),
    binding,
    mainRefBefore.projection
  );
  const candidateRequiredContexts = await collectRequiredContextsObservation(read, repoPath, binding);
  const privateVulnerabilityReporting = await collectSingleJsonObservation(
    read,
    apiUrl(`${repoPath}/private-vulnerability-reporting`),
    (value) => ({ enabled: requiredBoolean(value?.enabled, 'Private vulnerability reporting enabled') })
  );
  const actionsWorkflowPermissions = await collectSingleJsonObservation(
    read,
    apiUrl(`${repoPath}/actions/permissions/workflow`),
    projectWorkflowPermissions
  );
  const actionsRepositoryPermissions = await collectSingleJsonObservation(
    read,
    apiUrl(`${repoPath}/actions/permissions`),
    projectActionsPermissions
  );

  const codeqlRef = `refs/heads/${binding.candidateBranch}`;
  const codeqlOpenAlerts = await collectCodeqlObservation(read, repoPath, codeqlRef, 'open', binding);
  const codeqlDismissedAlerts = await collectCodeqlObservation(read, repoPath, codeqlRef, 'dismissed', binding);
  const hostedPrivacyPolicy = await collectPrivacyObservation(read, binding);
  const releaseEnvironment = await collectEnvironmentObservation(
    read,
    apiUrl(`${repoPath}/environments/${encodeURIComponent(binding.releaseEnvironmentName)}`),
    binding
  );
  const reviewerEligibility = await collectReviewerEligibilityObservation(
    read,
    apiUrl(`${repoPath}/collaborators?affiliation=direct&per_page=100&page=1`),
    binding,
    releaseEnvironment.projection
  );

  const candidateRefAfter = await collectRefObservation(read, candidateRefUrl, binding.candidateBranch);
  const mainRefAfter = await collectRefObservation(read, mainRefUrl, binding.mainBranch);
  assertStableRef(candidateRefBefore.projection, candidateRefAfter.projection, binding.candidateHeadSha, 'Candidate');
  assertStableRef(mainRefBefore.projection, mainRefAfter.projection, binding.mainHeadSha, 'Main');

  const validatedAt = await timeline.validationTimestamp();
  const capture = {
    schema: REMOTE_PUBLICATION_CAPTURE_SCHEMA,
    source: structuredClone(REMOTE_PUBLICATION_CAPTURE_SOURCE),
    storage: { ...REMOTE_PUBLICATION_CAPTURE_STORAGE_POLICY },
    captureWindow: {
      startedAt: candidateRefBefore.exchanges[0].observedAt,
      completedAt: mainRefAfter.exchanges[0].observedAt
    },
    validatedAt,
    localAttestations: Object.fromEntries(
      LOCAL_ATTESTATIONS.map((key) => [
        key,
        { status: 'not_evidenced_by_remote_capture', satisfiesPublicationGate: false }
      ])
    ),
    observations: {
      actionsRepositoryPermissions,
      actionsWorkflowPermissions,
      candidateRefAfter,
      candidateRefBefore,
      candidateRequiredContexts,
      codeqlDismissedAlerts,
      codeqlOpenAlerts,
      hostedPrivacyPolicy,
      mainProtection,
      mainRefAfter,
      mainRefBefore,
      privateVulnerabilityReporting,
      releaseEnvironment,
      repository,
      reviewerEligibility
    },
    captureSha256: ''
  };
  capture.captureSha256 = computeRemotePublicationCaptureSha256(capture);

  // This validates the complete schema and policy projection without turning
  // any API result into a human-review attestation.
  validateRemotePublicationCapture(capture, binding, { now: validatedAt });
  const rawBundle = buildRemotePublicationRawBundle({ capture, retainedResponses: retained });
  assertSecretAbsent(token, capture, rawBundle);
  return Object.freeze({ capture: deepFreeze(capture), rawBundle: deepFreeze(rawBundle) });
}

export function buildRemotePublicationRawBundle({ capture, retainedResponses }) {
  if (
    !isPlainObject(capture) ||
    !isSha256(capture.captureSha256) ||
    computeRemotePublicationCaptureSha256(capture) !== capture.captureSha256
  ) {
    throw new Error('Raw response bundle requires one sealed remote publication capture.');
  }
  if (!Array.isArray(retainedResponses) || retainedResponses.length === 0) {
    throw new Error('Raw response bundle requires retained response bodies.');
  }

  const expectedExchanges = flattenCaptureExchanges(capture);
  if (expectedExchanges.length !== retainedResponses.length) {
    throw new Error('Raw response count differs from the capture exchange count.');
  }

  const used = new Set();
  const responses = expectedExchanges.map(({ observation, exchangeIndex, exchange }, index) => {
    const matchIndex = retainedResponses.findIndex(
      (entry, candidateIndex) => !used.has(candidateIndex) && stableJson(entry.exchange) === stableJson(exchange)
    );
    if (matchIndex < 0) throw new Error(`Raw body is missing for ${observation} exchange ${exchangeIndex + 1}.`);
    used.add(matchIndex);
    const retained = retainedResponses[matchIndex];
    const bytes = Buffer.from(retained.body);
    if (
      bytes.length !== exchange.response.bodyBytes ||
      sha256(bytes) !== exchange.response.rawBodySha256 ||
      stableJson(retained.exchange) !== stableJson(exchange)
    ) {
      throw new Error(`Raw body identity differs for ${observation} exchange ${exchangeIndex + 1}.`);
    }
    return {
      id: `response-${String(index + 1).padStart(4, '0')}-${exchange.response.rawBodySha256.slice(0, 12).toLowerCase()}`,
      observation,
      exchangeIndex,
      observedAt: exchange.observedAt,
      request: structuredClone(exchange.request),
      response: structuredClone(exchange.response),
      contentBase64: bytes.toString('base64')
    };
  });

  const bundle = {
    schema: REMOTE_PUBLICATION_RAW_BUNDLE_SCHEMA,
    captureSha256: capture.captureSha256,
    createdAt: capture.validatedAt,
    responseCount: responses.length,
    responses,
    bundleSha256: ''
  };
  bundle.bundleSha256 = computeRemotePublicationRawBundleSha256(bundle);
  validateRawBundleIntegrity(bundle);
  return bundle;
}

export function computeRemotePublicationRawBundleSha256(bundle) {
  if (!isPlainObject(bundle)) throw new Error('Remote publication raw bundle must be an object.');
  const unsigned = { ...bundle };
  delete unsigned.bundleSha256;
  return computeCanonicalRemotePublicationSha256(unsigned);
}

/**
 * Replays the complete local integrity contract for a stored capture/raw-body
 * pair. This is the read-only integration point for the publication gate: the
 * caller still supplies its independently trusted expected binding and clock.
 */
export function validateRemotePublicationEvidenceBundle({ capture, rawBundle, expected, now } = {}) {
  validateRemotePublicationCapture(capture, expected, { now });
  validateRawBundleIntegrity(rawBundle);
  if (rawBundle.captureSha256 !== capture.captureSha256 || rawBundle.createdAt !== capture.validatedAt) {
    throw new Error('Remote publication raw bundle is not bound to the exact capture identity and time.');
  }
  assertRawBundleMatchesCapture(rawBundle, capture);
  return capture;
}

export async function writeRemotePublicationEvidenceBundle({
  capture,
  rawBundle,
  outputDirectory,
  repositoryRoot = projectRoot
}) {
  if (!isAbsolute(String(outputDirectory || ''))) {
    throw new Error('Remote publication output directory must be an absolute path.');
  }
  if (
    computeRemotePublicationCaptureSha256(capture) !== capture?.captureSha256 ||
    rawBundle?.schema !== REMOTE_PUBLICATION_RAW_BUNDLE_SCHEMA ||
    rawBundle?.captureSha256 !== capture?.captureSha256 ||
    rawBundle?.createdAt !== capture?.validatedAt ||
    computeRemotePublicationRawBundleSha256(rawBundle) !== rawBundle?.bundleSha256
  ) {
    throw new Error('Remote publication raw bundle is not integrity-bound to the capture.');
  }
  validateRawBundleIntegrity(rawBundle);
  assertRawBundleMatchesCapture(rawBundle, capture);

  const root = await exactPhysicalDirectory(repositoryRoot, 'Repository root');
  const validationRoot = resolve(root.path, 'validation-output');
  await ensureDirectPhysicalDirectory(root.path, validationRoot, 'Validation output root');
  const externalRoot = resolve(root.path, REMOTE_PUBLICATION_CAPTURE_EXTERNAL_DIRECTORY);
  await ensureDirectPhysicalDirectory(validationRoot, externalRoot, 'Remote publication capture root');

  const output = resolve(outputDirectory);
  if (
    dirname(output) !== externalRoot ||
    !/^sitewipe-remote-[a-z0-9][a-z0-9._-]{0,96}$/.test(output.slice(externalRoot.length + 1))
  ) {
    throw new Error('Remote publication output must be one named direct child of the ignored capture root.');
  }
  await mkdir(output, { recursive: false, mode: 0o700 });
  const ownedOutput = await exactPhysicalDirectory(output, 'Remote publication run output');
  if (!samePath(dirname(ownedOutput.path), externalRoot)) {
    throw new Error('Remote publication output escaped its ignored capture root.');
  }

  const captureBytes = canonicalJsonBytes(capture);
  const rawBundleBytes = canonicalJsonBytes(rawBundle);
  const capturePath = resolve(ownedOutput.path, 'capture.json');
  const rawBundlePath = resolve(ownedOutput.path, 'raw-responses.json');
  await writeExclusiveRegularFile(capturePath, captureBytes, 'Remote publication capture');
  await writeExclusiveRegularFile(rawBundlePath, rawBundleBytes, 'Remote publication raw response bundle');

  return Object.freeze({
    outputDirectory: ownedOutput.path,
    capturePath,
    rawBundlePath,
    captureSha256: capture.captureSha256,
    rawBundleSha256: rawBundle.bundleSha256,
    responseCount: rawBundle.responseCount
  });
}

export function parseRemotePublicationCollectorArguments(argv) {
  if (!Array.isArray(argv)) throw new Error('Collector arguments must be an array.');
  const allowed = new Set(['--expected', '--output-directory']);
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(key) || typeof value !== 'string' || !value.trim() || Object.hasOwn(parsed, key)) {
      throw new Error('Collector accepts exactly one --expected path and one --output-directory path.');
    }
    parsed[key] = value;
  }
  if (Object.keys(parsed).length !== 2) {
    throw new Error('Collector requires --expected and --output-directory.');
  }
  if (!isAbsolute(parsed['--expected']) || !isAbsolute(parsed['--output-directory'])) {
    throw new Error('Collector input and output paths must be absolute.');
  }
  return Object.freeze({
    expectedPath: resolve(parsed['--expected']),
    outputDirectory: resolve(parsed['--output-directory'])
  });
}

async function collectRefObservation(read, url, branch) {
  return collectSingleJsonObservation(read, url, (value) => {
    const ref = requiredString(value?.ref, 'Git ref');
    const headSha = requiredGitObjectId(value?.object?.sha, 'Git ref object SHA');
    if (ref !== `refs/heads/${branch}` || value?.object?.type !== 'commit') {
      throw new Error('Git ref response is not the exact requested branch commit.');
    }
    return { branch, ref, headSha };
  });
}

async function collectRepositoryObservation(read, url) {
  return collectSingleJsonObservation(read, url, (value) => ({
    fullName: requiredString(value?.full_name, 'Repository full name'),
    htmlUrl: requiredHttpsUrl(value?.html_url, 'Repository HTML URL'),
    repositoryId: requiredPositiveInteger(value?.id, 'Repository ID'),
    defaultBranch: requiredString(value?.default_branch, 'Repository default branch'),
    visibility: requiredString(value?.visibility, 'Repository visibility')
  }));
}

async function collectMainProtectionObservation(read, url, expected, mainRef) {
  return collectSingleJsonObservation(read, url, (value) => {
    const rawChecks = requiredArray(value?.required_status_checks?.checks, 'Main required checks');
    const checks = expected.requiredChecks.map((binding) => {
      const matches = rawChecks.filter((entry) => entry?.context === binding.name && entry?.app_id === binding.appId);
      if (matches.length !== 1) throw new Error(`Main protection does not bind required check ${binding.name}.`);
      return { context: binding.name, appId: binding.appId };
    });
    if (rawChecks.length !== checks.length) throw new Error('Main protection contains an unexpected required check.');

    const rawContexts = requiredArray(value?.required_status_checks?.contexts, 'Main required contexts');
    if (!sameStringSet(rawContexts, REQUIRED_REMOTE_PUBLICATION_CONTEXTS)) {
      throw new Error('Main protection required-context names differ from the publication set.');
    }
    return {
      branch: expected.mainBranch,
      headSha: mainRef.headSha,
      requiredStatusChecks: {
        strict: requiredBoolean(value?.required_status_checks?.strict, 'Strict status checks'),
        contexts: [...REQUIRED_REMOTE_PUBLICATION_CONTEXTS],
        checks
      },
      enforceAdmins: requiredBoolean(value?.enforce_admins?.enabled, 'Admin enforcement'),
      requiredConversationResolution: requiredBoolean(
        value?.required_conversation_resolution?.enabled,
        'Conversation resolution'
      ),
      requiredLinearHistory: requiredBoolean(value?.required_linear_history?.enabled, 'Linear history'),
      allowForcePushes: requiredBoolean(value?.allow_force_pushes?.enabled, 'Force-push policy'),
      allowDeletions: requiredBoolean(value?.allow_deletions?.enabled, 'Deletion policy')
    };
  });
}

async function collectRequiredContextsObservation(read, repoPath, expected) {
  const exchanges = [];
  const requiredContexts = [];
  for (const binding of expected.requiredChecks) {
    const url = checkRunsUrl(repoPath, expected.candidateHeadSha, binding);
    const result = await read.json(url);
    exchanges.push(result.exchange);
    const value = result.value;
    const runs = requiredArray(value?.check_runs, `Check runs for ${binding.name}`);
    if (value?.total_count !== 1 || runs.length !== 1) {
      throw new Error(`Required check ${binding.name} does not have exactly one latest run.`);
    }
    const run = runs[0];
    const projected = {
      name: requiredString(run?.name, `Required check ${binding.name} name`),
      appId: requiredPositiveInteger(run?.app?.id, `Required check ${binding.name} app ID`),
      appSlug: requiredSlug(run?.app?.slug, `Required check ${binding.name} app slug`),
      detailsUrl: requiredHttpsUrl(run?.details_url, `Required check ${binding.name} details URL`),
      headSha: requiredGitObjectId(run?.head_sha, `Required check ${binding.name} head SHA`),
      status: requiredString(run?.status, `Required check ${binding.name} status`),
      conclusion: requiredString(run?.conclusion, `Required check ${binding.name} conclusion`),
      completedAt: canonicalTimestamp(run?.completed_at, `Required check ${binding.name} completedAt`),
      checkRunId: requiredPositiveInteger(run?.id, `Required check ${binding.name} ID`)
    };
    if (
      projected.name !== binding.name ||
      projected.appId !== binding.appId ||
      projected.appSlug !== binding.appSlug ||
      projected.detailsUrl !== binding.detailsUrl ||
      projected.headSha !== expected.candidateHeadSha
    ) {
      throw new Error(`Required check ${binding.name} response differs from its exact binding.`);
    }
    requiredContexts.push(projected);
  }
  return { exchanges, projection: { headSha: expected.candidateHeadSha, requiredContexts } };
}

async function collectCodeqlObservation(read, repoPath, ref, state, expected) {
  const firstUrl = codeqlUrl(repoPath, ref, state, 1);
  const pages = await collectPaginatedJsonArrays(read, firstUrl);
  const alerts = pages.items;
  const numbers = alerts.map((alert) => requiredPositiveInteger(alert?.number, 'CodeQL alert number'));
  if (new Set(numbers).size !== numbers.length) throw new Error(`CodeQL ${state} alert pages repeat an alert.`);
  const pagination = {
    complete: true,
    pageCount: pages.exchanges.length,
    totalItems: alerts.length
  };
  if (state === 'open') {
    return {
      exchanges: pages.exchanges,
      projection: {
        candidateHeadSha: expected.candidateHeadSha,
        ref,
        openAlertCount: alerts.length,
        pagination
      }
    };
  }
  return {
    exchanges: pages.exchanges,
    projection: {
      candidateHeadSha: expected.candidateHeadSha,
      ref,
      dismissedAlertCount: alerts.length,
      pagination,
      alerts: alerts.map((alert) => ({
        alertNumber: requiredPositiveInteger(alert?.number, 'Dismissed CodeQL alert number'),
        ruleId: requiredString(alert?.rule?.id, 'Dismissed CodeQL rule ID'),
        state: requiredString(alert?.state, 'Dismissed CodeQL alert state'),
        dismissedAt: canonicalTimestamp(alert?.dismissed_at, 'Dismissed CodeQL alert timestamp'),
        dismissedBy: requiredLogin(alert?.dismissed_by?.login, 'Dismissed CodeQL actor'),
        dismissalReason: requiredString(alert?.dismissed_reason, 'Dismissed CodeQL reason'),
        dismissalComment: requiredString(alert?.dismissed_comment, 'Dismissed CodeQL comment')
      }))
    }
  };
}

async function collectPrivacyObservation(read, expected) {
  const result = await read.raw(expected.hostedPrivacyPolicyRawUrl, 'immutable-raw-https');
  const digest = sha256(result.body);
  if (digest !== expected.hostedPrivacyPolicySha256) {
    throw new Error('Hosted privacy policy response differs from the expected exact SHA-256.');
  }
  return {
    exchanges: [result.exchange],
    projection: {
      rawUrl: expected.hostedPrivacyPolicyRawUrl,
      version: expected.hostedPrivacyPolicyVersion,
      sha256: digest,
      bytes: result.body.length
    }
  };
}

async function collectEnvironmentObservation(read, url, expected) {
  return collectSingleJsonObservation(read, url, (value) => {
    if (value?.name !== expected.releaseEnvironmentName) {
      throw new Error('Release environment response names a different environment.');
    }
    const rules = requiredArray(value?.protection_rules, 'Release environment protection rules');
    const reviewerRules = rules.filter((rule) => rule?.type === 'required_reviewers');
    if (reviewerRules.length !== 1) throw new Error('Release environment must expose one required-reviewer rule.');
    const reviewerRule = reviewerRules[0];
    const configuredReviewerLogins = requiredArray(reviewerRule.reviewers, 'Release environment configured reviewers')
      .map((entry) => {
        if (entry?.type !== 'User') throw new Error('Release environment reviewer must be a direct user identity.');
        return requiredLogin(entry?.reviewer?.login, 'Release environment reviewer login');
      })
      .sort((left, right) => left.localeCompare(right));
    assertUniqueCaseInsensitive(configuredReviewerLogins, 'Release environment reviewer');
    const branchPolicy = value?.deployment_branch_policy;
    const protectedBranchesOnly =
      requiredBoolean(branchPolicy?.protected_branches, 'Protected-branches-only environment policy') === true &&
      requiredBoolean(branchPolicy?.custom_branch_policies, 'Custom environment branch policy') === false;
    return {
      name: value.name,
      preventSelfReview: requiredBoolean(reviewerRule.prevent_self_review, 'Environment self-review policy'),
      protectedBranchesOnly,
      configuredReviewerLogins
    };
  });
}

async function collectReviewerEligibilityObservation(read, firstUrl, expected, environment) {
  const pages = await collectPaginatedJsonArrays(read, firstUrl);
  const directCollaborators = pages.items
    .map((entry) => ({
      login: requiredLogin(entry?.login, 'Direct collaborator login'),
      permission: highestPermission(entry?.permissions)
    }))
    .sort((left, right) => left.login.localeCompare(right.login));
  assertUniqueCaseInsensitive(
    directCollaborators.map(({ login }) => login),
    'Direct collaborator'
  );
  if (directCollaborators.some(({ permission }) => !WRITE_CAPABLE_PERMISSIONS.includes(permission))) {
    throw new Error('Direct collaborator response contains an identity without write-capable review authority.');
  }
  const byLogin = new Set(directCollaborators.map(({ login }) => login.toLowerCase()));
  const eligibleConfiguredReviewerLogins = environment.configuredReviewerLogins
    .filter((login) => login.toLowerCase() !== expected.candidateActorLogin.toLowerCase())
    .filter((login) => byLogin.has(login.toLowerCase()));
  return {
    exchanges: pages.exchanges,
    projection: {
      directCollaborators,
      eligibleConfiguredReviewerLogins,
      pagination: {
        complete: true,
        pageCount: pages.exchanges.length,
        totalItems: directCollaborators.length
      }
    }
  };
}

async function collectSingleJsonObservation(read, url, project) {
  const result = await read.json(url);
  return { exchanges: [result.exchange], projection: project(result.value) };
}

async function collectPaginatedJsonArrays(read, firstUrl) {
  const exchanges = [];
  const items = [];
  let page = 1;
  let url = firstUrl;
  while (true) {
    if (page > MAX_PAGES) throw new Error('Remote API pagination exceeds the bounded page limit.');
    const result = await read.json(url);
    if (!Array.isArray(result.value)) throw new Error('Paginated GitHub response must be a JSON array.');
    exchanges.push(result.exchange);
    items.push(...result.value);
    const expectedNext = replacePage(firstUrl, page + 1);
    const next = exactNextLink(result.exchange.response.link);
    if (next === null) break;
    if (next !== expectedNext) throw new Error('Remote API pagination changed from the exact next-page sequence.');
    page += 1;
    url = next;
  }
  return { exchanges, items };
}

function createReadOnlyFetcher({ fetchImpl, retained, timeline, token }) {
  async function request(url, resourceKind) {
    assertExactRequestUrl(url, resourceKind);
    const apiRequest = resourceKind === 'github-rest-api';
    const headers = apiRequest
      ? {
          Accept: 'application/vnd.github+json',
          'Accept-Encoding': 'identity',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'SiteWipe-remote-publication-evidence',
          'X-GitHub-Api-Version': GITHUB_REST_API_VERSION
        }
      : {
          Accept: 'text/plain, application/octet-stream;q=0.9',
          'Accept-Encoding': 'identity',
          'User-Agent': 'SiteWipe-remote-publication-evidence'
        };
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers,
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer'
      });
    } catch {
      throw new Error(`Read-only remote request failed for ${url}.`);
    }
    if (!response || !response.body || typeof response.body.getReader !== 'function' || !response.headers?.get) {
      throw new Error(`Read-only remote response is malformed for ${url}.`);
    }
    if (response.redirected === true || (response.url && response.url !== url)) {
      throw new Error(`Read-only remote response redirected away from the exact request URL ${url}.`);
    }
    const contentEncoding = optionalHeader(response, 'content-encoding');
    if (contentEncoding !== null && contentEncoding.toLowerCase() !== 'identity') {
      throw new Error(`Read-only remote response ignored the exact identity encoding for ${url}.`);
    }
    const declaredLength = optionalHeader(response, 'content-length');
    if (
      declaredLength !== null &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) <= 0 || Number(declaredLength) > MAX_RESPONSE_BODY_BYTES)
    ) {
      throw new Error(`Read-only remote response has an invalid bounded Content-Length for ${url}.`);
    }
    const body = await readBoundedResponseBody(response, url);
    if (body.length <= 0 || body.length > MAX_RESPONSE_BODY_BYTES) {
      throw new Error(`Read-only remote response body is outside the bounded size for ${url}.`);
    }
    if (declaredLength !== null && Number(declaredLength) !== body.length) {
      throw new Error(`Read-only remote response differs from its declared Content-Length for ${url}.`);
    }
    if (body.includes(Buffer.from(token, 'utf8'))) {
      throw new Error('Read-only remote response unexpectedly contains the authentication credential.');
    }
    const status = response.status;
    if (status !== 200) throw new Error(`Read-only remote request returned HTTP ${String(status)} for ${url}.`);
    const contentType = requiredHeader(response, 'content-type', 'Content-Type');
    if (apiRequest && !/^application\/(?:json|vnd\.github\+json)\b/i.test(contentType)) {
      throw new Error(`GitHub API response has an unexpected content type for ${url}.`);
    }
    const observedAt = await timeline.exchangeTimestamp();
    const date = requiredHeader(response, 'date', 'Date');
    if (!Number.isFinite(Date.parse(date)) || !/GMT$/.test(date)) {
      throw new Error(`Read-only remote response has an invalid Date header for ${url}.`);
    }
    const exchange = {
      observedAt,
      request: { method: 'GET', resourceKind, url },
      response: {
        status,
        date,
        contentType,
        etag: optionalHeader(response, 'etag'),
        githubRequestId: optionalHeader(response, 'x-github-request-id'),
        link: optionalHeader(response, 'link'),
        bodyBytes: body.length,
        rawBodySha256: sha256(body)
      }
    };
    retained.push({ exchange: structuredClone(exchange), body });
    return { exchange, body };
  }

  return Object.freeze({
    async json(url) {
      const result = await request(url, 'github-rest-api');
      return { ...result, value: decodeJson(result.body, url) };
    },
    raw(url, resourceKind) {
      return request(url, resourceKind);
    }
  });
}

async function readBoundedResponseBody(response, url) {
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      let result;
      try {
        result = await reader.read();
      } catch {
        throw new Error(`Read-only remote response body could not be retained for ${url}.`);
      }
      if (!isPlainObject(result) || typeof result.done !== 'boolean') {
        throw new Error(`Read-only remote response body stream is malformed for ${url}.`);
      }
      if (result.done) break;
      if (!(result.value instanceof Uint8Array) || result.value.byteLength <= 0) {
        throw new Error(`Read-only remote response body stream is malformed for ${url}.`);
      }
      const chunk = Buffer.from(result.value);
      bytes += chunk.length;
      if (bytes > MAX_RESPONSE_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The bounded read has already failed closed; transport cancellation
          // failure does not change that result and must not leak its message.
        }
        throw new Error(`Read-only remote response body is outside the bounded size for ${url}.`);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

function createTimeline(clock) {
  let lastExchange = Number.NEGATIVE_INFINITY;
  async function next({ strict }) {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const value = clock();
      const milliseconds = value instanceof Date ? value.getTime() : Date.parse(value);
      if (!Number.isFinite(milliseconds)) throw new Error('Remote collector clock returned an invalid timestamp.');
      if ((strict && milliseconds > lastExchange) || (!strict && milliseconds >= lastExchange)) {
        if (strict) lastExchange = milliseconds;
        return new Date(milliseconds).toISOString();
      }
      if (clock !== defaultClock) throw new Error('Injected remote collector clock is not strictly monotonic.');
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
    }
    throw new Error('Remote collector clock did not advance within the bounded interval.');
  }
  return Object.freeze({
    exchangeTimestamp: () => next({ strict: true }),
    validationTimestamp: () => next({ strict: false })
  });
}

export function validateCollectorExpectedBinding(value) {
  assertExactKeys(value, EXPECTED_KEYS, 'Expected collector binding');
  const copy = structuredClone(value);
  if (!isRepositoryFullName(copy.repository)) throw new Error('Expected repository must use owner/name form.');
  if (!isSemanticVersion(copy.version)) throw new Error('Expected version must use numeric major.minor.patch form.');
  if (copy.candidateBranch !== `candidate/sitewipe-${copy.version}` || !isBranchName(copy.candidateBranch)) {
    throw new Error('Expected candidate branch is not the exact version-qualified SiteWipe branch.');
  }
  if (copy.mainBranch !== 'main') throw new Error('Expected main branch must be main.');
  requiredGitObjectId(copy.candidateHeadSha, 'Expected candidate head SHA');
  requiredGitObjectId(copy.mainHeadSha, 'Expected main head SHA');
  requiredLogin(copy.candidateActorLogin, 'Expected candidate actor');
  if (
    copy.hostedPrivacyPolicyVersion !== copy.version ||
    !isSha256(copy.hostedPrivacyPolicySha256) ||
    !isImmutableRawUrl(copy.hostedPrivacyPolicyRawUrl)
  ) {
    throw new Error('Expected hosted privacy policy is not immutable and exact-version bound.');
  }
  if (copy.releaseEnvironmentName !== 'unreleased-candidate') {
    throw new Error('Expected release environment must be unreleased-candidate.');
  }
  if (
    !Array.isArray(copy.requiredChecks) ||
    copy.requiredChecks.length !== REQUIRED_REMOTE_PUBLICATION_CONTEXTS.length ||
    JSON.stringify(copy.requiredChecks.map(({ name }) => name)) !== JSON.stringify(REQUIRED_REMOTE_PUBLICATION_CONTEXTS)
  ) {
    throw new Error('Expected required checks differ from the canonical context set.');
  }
  const seenDetails = new Set();
  for (const check of copy.requiredChecks) {
    assertExactKeys(check, ['appId', 'appSlug', 'detailsUrl', 'name'], `Expected check ${check?.name || ''}`);
    requiredPositiveInteger(check.appId, `Expected check ${check.name} app ID`);
    requiredSlug(check.appSlug, `Expected check ${check.name} app slug`);
    requiredRepositoryDetailsUrl(check.detailsUrl, copy.repository, `Expected check ${check.name} details URL`);
    if (seenDetails.has(check.detailsUrl)) throw new Error('Expected required check details URLs must be unique.');
    seenDetails.add(check.detailsUrl);
  }
  return deepFreeze(copy);
}

function projectWorkflowPermissions(value) {
  return {
    defaultWorkflowPermissions: requiredString(value?.default_workflow_permissions, 'Default workflow permissions'),
    canApprovePullRequestReviews: requiredBoolean(
      value?.can_approve_pull_request_reviews,
      'Workflow pull-request-review permission'
    )
  };
}

function projectActionsPermissions(value) {
  return {
    enabled: requiredBoolean(value?.enabled, 'Repository Actions enabled'),
    allowedActions: requiredString(value?.allowed_actions, 'Repository allowed Actions policy'),
    shaPinningRequired: requiredBoolean(value?.sha_pinning_required, 'Action SHA-pinning policy')
  };
}

function highestPermission(permissions) {
  if (!isPlainObject(permissions)) throw new Error('Direct collaborator permissions are missing.');
  if (permissions.admin === true) return 'admin';
  if (permissions.maintain === true) return 'maintain';
  if (permissions.push === true) return 'write';
  if (permissions.triage === true) return 'triage';
  if (permissions.pull === true) return 'read';
  throw new Error('Direct collaborator has no recognized repository permission.');
}

function assertStableRef(before, after, expectedSha, label) {
  assertExpectedRef(before, expectedSha, `${label} ref before capture`);
  assertExpectedRef(after, expectedSha, `${label} ref after capture`);
  if (stableJson(before) !== stableJson(after)) throw new Error(`${label} ref changed during remote collection.`);
}

function assertExpectedRef(value, expectedSha, label) {
  if (value.headSha !== expectedSha) throw new Error(`${label} differs from the expected exact head.`);
}

function assertCredential(token) {
  if (
    typeof token !== 'string' ||
    token.length < 20 ||
    token.length > 512 ||
    token.trim() !== token ||
    hasControlCharacters(token, { includeSpace: true })
  ) {
    throw new Error(`A read-only GitHub credential is required through ${REMOTE_PUBLICATION_TOKEN_ENVIRONMENT}.`);
  }
}

function assertSecretAbsent(token, ...values) {
  for (const value of values) {
    if (stableJson(value).includes(token))
      throw new Error('Remote evidence output contains the authentication credential.');
  }
}

function assertExactRequestUrl(url, resourceKind) {
  const parsed = new URL(requiredHttpsUrl(url, 'Remote request URL'));
  if (parsed.username || parsed.password || parsed.hash)
    throw new Error('Remote request URL contains forbidden authority data.');
  if (resourceKind === 'github-rest-api' && parsed.origin !== API_ROOT) {
    throw new Error('GitHub REST requests must remain on api.github.com.');
  }
  if (resourceKind === 'immutable-raw-https' && !isImmutableRawUrl(url)) {
    throw new Error('Hosted privacy request must use the immutable raw GitHub URL.');
  }
}

function decodeJson(bytes, url) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`GitHub API response is not valid UTF-8 for ${url}.`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`GitHub API response is not valid JSON for ${url}.`);
  }
}

function exactNextLink(link) {
  if (link === null) return null;
  const matches = [...link.matchAll(/<([^>]+)>\s*;\s*rel="([^"]+)"/g)];
  const next = matches.filter(([, , relation]) => relation.split(/\s+/).includes('next'));
  if (next.length === 0) return null;
  if (next.length !== 1) throw new Error('Remote API Link header contains multiple next relations.');
  return requiredHttpsUrl(next[0][1], 'Remote API next-page URL');
}

function requiredHeader(response, key, label) {
  const value = optionalHeader(response, key);
  if (value === null || !value.trim()) throw new Error(`Read-only remote response is missing ${label}.`);
  return value;
}

function optionalHeader(response, key) {
  const value = response.headers.get(key);
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > MAX_HEADER_LENGTH || hasControlCharacters(value)) {
    throw new Error('Read-only remote response contains an unsafe header value.');
  }
  return value;
}

function flattenCaptureExchanges(capture) {
  if (!isPlainObject(capture.observations)) throw new Error('Capture observations are missing.');
  return Object.entries(capture.observations).flatMap(([observation, value]) => {
    if (!Array.isArray(value?.exchanges)) throw new Error(`Capture observation ${observation} has no exchanges.`);
    return value.exchanges.map((exchange, exchangeIndex) => ({ observation, exchangeIndex, exchange }));
  });
}

function validateRawBundleIntegrity(bundle) {
  assertExactKeys(
    bundle,
    ['bundleSha256', 'captureSha256', 'createdAt', 'responseCount', 'responses', 'schema'],
    'Remote publication raw bundle'
  );
  if (
    bundle.schema !== REMOTE_PUBLICATION_RAW_BUNDLE_SCHEMA ||
    !isSha256(bundle.captureSha256) ||
    !isSha256(bundle.bundleSha256) ||
    computeRemotePublicationRawBundleSha256(bundle) !== bundle.bundleSha256 ||
    !Array.isArray(bundle.responses) ||
    !Number.isSafeInteger(bundle.responseCount) ||
    bundle.responseCount <= 0 ||
    bundle.responseCount !== bundle.responses.length ||
    canonicalTimestamp(bundle.createdAt, 'Raw bundle createdAt') !== bundle.createdAt
  ) {
    throw new Error('Remote publication raw bundle has an invalid exact identity.');
  }
  const ids = new Set();
  for (const response of bundle.responses) {
    assertExactKeys(
      response,
      ['contentBase64', 'exchangeIndex', 'id', 'observation', 'observedAt', 'request', 'response'],
      'Retained remote response'
    );
    if (
      !/^response-\d{4}-[a-f0-9]{12}$/.test(response.id) ||
      ids.has(response.id) ||
      !Number.isSafeInteger(response.exchangeIndex) ||
      response.exchangeIndex < 0 ||
      !requiredString(response.observation, 'Retained response observation') ||
      canonicalTimestamp(response.observedAt, 'Retained response observedAt') !== response.observedAt ||
      typeof response.contentBase64 !== 'string'
    ) {
      throw new Error('Retained remote response has an invalid exact identity.');
    }
    ids.add(response.id);
    const bytes = Buffer.from(response.contentBase64, 'base64');
    if (
      bytes.length <= 0 ||
      bytes.length > MAX_RESPONSE_BODY_BYTES ||
      bytes.toString('base64') !== response.contentBase64 ||
      bytes.length !== response.response?.bodyBytes ||
      sha256(bytes) !== response.response?.rawBodySha256
    ) {
      throw new Error(`Retained remote response ${response.id} differs from its exact raw-body identity.`);
    }
  }
}

function assertRawBundleMatchesCapture(bundle, capture) {
  const exchanges = flattenCaptureExchanges(capture);
  if (exchanges.length !== bundle.responses.length) {
    throw new Error('Remote raw bundle response count differs from the sealed capture.');
  }
  for (let index = 0; index < exchanges.length; index += 1) {
    const expected = exchanges[index];
    const actual = bundle.responses[index];
    if (
      actual.observation !== expected.observation ||
      actual.exchangeIndex !== expected.exchangeIndex ||
      actual.observedAt !== expected.exchange.observedAt ||
      stableJson(actual.request) !== stableJson(expected.exchange.request) ||
      stableJson(actual.response) !== stableJson(expected.exchange.response)
    ) {
      throw new Error(`Remote raw bundle response ${index + 1} differs from its sealed capture exchange.`);
    }
  }
}

function checkRunsUrl(repoPath, headSha, check) {
  return apiUrl(
    `${repoPath}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(check.name)}&filter=latest&app_id=${check.appId}&per_page=100`
  );
}

function codeqlUrl(repoPath, ref, state, page) {
  return apiUrl(
    `${repoPath}/code-scanning/alerts?ref=${encodeURIComponent(ref)}&state=${state}&tool_name=CodeQL&per_page=100&page=${page}`
  );
}

function apiUrl(path) {
  return `${API_ROOT}${path}`;
}

function replacePage(url, page) {
  if (!/[?&]page=\d+/.test(url)) throw new Error('Paginated URL is missing its exact page parameter.');
  return url.replace(/([?&]page=)\d+/, `$1${page}`);
}

function canonicalTimestamp(value, label) {
  const milliseconds = Date.parse(value);
  if (typeof value !== 'string' || !Number.isFinite(milliseconds)) throw new Error(`${label} is invalid.`);
  return new Date(milliseconds).toISOString();
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value || value.length > 4_096) {
    throw new Error(`${label} must be a bounded non-empty string.`);
  }
  return value;
}

function requiredBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean.`);
  return value;
}

function requiredArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function requiredPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function requiredGitObjectId(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value)) {
    throw new Error(`${label} must be an exact lowercase Git object ID.`);
  }
  return value;
}

function requiredLogin(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value)) {
    throw new Error(`${label} is not a GitHub login.`);
  }
  return value;
}

function requiredSlug(value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error(`${label} is not a lowercase slug.`);
  }
  return value;
}

function requiredHttpsUrl(value, label) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error();
    return value;
  } catch {
    throw new Error(`${label} must be an HTTPS URL without embedded authority or fragment data.`);
  }
}

function requiredRepositoryDetailsUrl(value, repository, label) {
  requiredHttpsUrl(value, label);
  const url = new URL(value);
  if (url.origin !== 'https://github.com' || !url.pathname.startsWith(`/${repository}/`)) {
    throw new Error(`${label} must remain beneath the exact GitHub repository.`);
  }
  return value;
}

function assertUniqueCaseInsensitive(values, label) {
  if (new Set(values.map((value) => value.toLowerCase())).size !== values.length) {
    throw new Error(`${label} identities must be unique.`);
  }
}

function sameStringSet(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.every((entry) => typeof entry === 'string') &&
    new Set(actual).size === actual.length &&
    JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort())
  );
}

function assertExactKeys(value, expected, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object.`);
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} keys differ from the exact schema.`);
  }
}

function isRepositoryFullName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function isSemanticVersion(value) {
  return typeof value === 'string' && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value);
}

function isBranchName(value) {
  return (
    typeof value === 'string' &&
    value.length <= 160 &&
    !value.startsWith('/') &&
    !value.endsWith('/') &&
    !hasControlCharacters(value, { includeSpace: true }) &&
    ![...'~^:?*[]\\'].some((character) => value.includes(character)) &&
    !value.includes('..')
  );
}

function hasControlCharacters(value, { includeSpace = false } = {}) {
  return [...String(value)].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint < (includeSpace ? 33 : 32) || codePoint === 127;
  });
}

function isImmutableRawUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.origin === 'https://gist.githubusercontent.com' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search &&
      /\/raw\/[a-f0-9]{40,64}\//.test(url.pathname)
    );
  } catch {
    return false;
  }
}

function isSha256(value) {
  return typeof value === 'string' && /^[A-F0-9]{64}$/.test(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalJsonBytes(value) {
  return Buffer.from(`${stableJson(value)}\n`, 'utf8');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

async function ensureDirectPhysicalDirectory(parent, child, label) {
  const exactParent = await exactPhysicalDirectory(parent, `${label} parent`);
  const expected = resolve(child);
  if (dirname(expected) !== exactParent.path) throw new Error(`${label} must be a direct child of its exact parent.`);
  try {
    await mkdir(expected, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  return exactPhysicalDirectory(expected, label);
}

async function exactPhysicalDirectory(path, label) {
  const expected = resolve(path);
  const information = await exactRemoteCollectorPathStat(expected);
  if (
    !information.isDirectory() ||
    information.isSymbolicLink() ||
    !hasExactBigIntFields(information, ['birthtimeNs', 'dev', 'ino', 'mode', 'nlink'])
  ) {
    throw new Error(`${label} must be one physical directory.`);
  }
  const actual = await realpath(expected);
  if (!samePath(actual, expected)) throw new Error(`${label} must not be an aliased directory.`);
  return Object.freeze({ path: actual, information });
}

async function writeExclusiveRegularFile(path, bytes, label) {
  const value = Buffer.from(bytes);
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    const opened = await exactRemoteCollectorHandleStat(handle);
    assertExactRemoteCollectorFile(opened, label);
    const pathOpened = await exactRemoteCollectorPathStat(path);
    assertExactRemoteCollectorFile(pathOpened, label);
    if (!sameRemoteCollectorFileIdentity(opened, pathOpened) || !samePath(await realpath(path), path)) {
      throw new Error(`${label} exclusive path differs from its exact open handle.`);
    }
    await handle.writeFile(value);
    await handle.sync();
    const written = await exactRemoteCollectorHandleStat(handle);
    assertExactRemoteCollectorFile(written, label);
    const pathWritten = await exactRemoteCollectorPathStat(path);
    assertExactRemoteCollectorFile(pathWritten, label);
    if (
      !sameRemoteCollectorNodeIdentity(opened, written, { compareSize: false }) ||
      !sameRemoteCollectorFileIdentity(written, pathWritten) ||
      written.size !== BigInt(value.length) ||
      !samePath(await realpath(path), path)
    ) {
      throw new Error(`${label} identity changed during its create-only write.`);
    }
  } finally {
    await handle.close();
  }
  const stored = await readExactRegularFileBytes(path, label);
  if (!stored.equals(value)) throw new Error(`${label} changed after its create-only write.`);
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);
}

function defaultClock() {
  return new Date();
}

async function readExactJsonFile(path, label) {
  const bytes = await readExactRegularFileBytes(path, label);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new Error(`${label} must contain valid UTF-8 JSON.`);
  }
}

async function readExactRegularFileBytes(path, label) {
  const requested = resolve(path);
  const actual = await realpath(requested);
  if (!samePath(actual, requested)) throw new Error(`${label} must not be an aliased file.`);
  const before = await exactRemoteCollectorPathStat(requested);
  assertExactRemoteCollectorFile(before, label);
  const handle = await open(requested, 'r');
  try {
    const opened = await exactRemoteCollectorHandleStat(handle);
    assertExactRemoteCollectorFile(opened, label);
    const bytes = await handle.readFile();
    const after = await exactRemoteCollectorHandleStat(handle);
    assertExactRemoteCollectorFile(after, label);
    const pathAfter = await exactRemoteCollectorPathStat(requested);
    assertExactRemoteCollectorFile(pathAfter, label);
    if (
      !sameRemoteCollectorFileIdentity(before, opened) ||
      !sameRemoteCollectorFileIdentity(opened, after) ||
      !sameRemoteCollectorFileIdentity(after, pathAfter) ||
      after.size !== BigInt(bytes.length) ||
      !samePath(await realpath(requested), requested)
    ) {
      throw new Error(`${label} identity changed while reading.`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function exactRemoteCollectorPathStat(path, statImplementation = nativeLstat) {
  if (typeof statImplementation !== 'function') {
    throw new Error('Remote-publication collector exact path-stat implementation is unavailable.');
  }
  return statImplementation(path, EXACT_STAT_OPTIONS);
}

export async function exactRemoteCollectorHandleStat(handle) {
  if (!handle || typeof handle.stat !== 'function') {
    throw new Error('Remote-publication collector exact handle-stat capability is unavailable.');
  }
  return handle.stat(EXACT_STAT_OPTIONS);
}

function assertExactRemoteCollectorFile(information, label) {
  if (
    !information?.isFile() ||
    information.isSymbolicLink() ||
    !hasExactBigIntFields(information, ['birthtimeNs', 'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink', 'size']) ||
    information.nlink !== 1n ||
    information.size < 0n
  ) {
    throw new Error(`${label} must remain one singly linked regular file with exact bigint identity.`);
  }
}

function sameRemoteCollectorNodeIdentity(left, right, { compareSize }) {
  const fields = ['birthtimeNs', 'dev', 'ino', 'mode', 'nlink', 'size'];
  if (!hasExactBigIntFields(left, fields) || !hasExactBigIntFields(right, fields)) return false;
  if (left.dev !== right.dev || left.ino !== right.ino || left.mode !== right.mode || left.nlink !== right.nlink) {
    return false;
  }
  if (compareSize && left.size !== right.size) return false;
  return left.ino !== 0n || left.birthtimeNs === right.birthtimeNs;
}

export function sameRemoteCollectorFileIdentity(left, right) {
  const fields = ['birthtimeNs', 'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink', 'size'];
  if (!hasExactBigIntFields(left, fields) || !hasExactBigIntFields(right, fields)) return false;
  return fields.every((field) => left[field] === right[field]);
}

function hasExactBigIntFields(value, fields) {
  return Boolean(value) && fields.every((field) => typeof value[field] === 'bigint');
}

async function main() {
  const token = process.env[REMOTE_PUBLICATION_TOKEN_ENVIRONMENT];
  try {
    const options = parseRemotePublicationCollectorArguments(process.argv.slice(2));
    const expected = await readExactJsonFile(options.expectedPath, 'Expected remote-publication binding');
    const result = await collectRemotePublicationEvidence({ expected, token, clock: defaultClock });
    const written = await writeRemotePublicationEvidenceBundle({
      ...result,
      outputDirectory: options.outputDirectory,
      repositoryRoot: projectRoot
    });
    const relativeDirectory = relative(projectRoot, written.outputDirectory).split(sep).join('/');
    process.stdout.write(
      `${JSON.stringify(
        {
          captureSha256: written.captureSha256,
          rawBundleSha256: written.rawBundleSha256,
          responseCount: written.responseCount,
          relativeDirectory
        },
        null,
        2
      )}\n`
    );
  } catch (error) {
    const rawMessage = String(error?.message || 'Unknown collector failure.');
    const message = token ? rawMessage.replaceAll(token, '[REDACTED]') : rawMessage;
    process.stderr.write(`Remote publication collection failed: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();

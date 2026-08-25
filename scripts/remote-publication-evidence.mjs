import { createHash } from 'node:crypto';

export const REMOTE_PUBLICATION_CAPTURE_SCHEMA = 'sitewipe.remote-publication-exact-head-capture.v2';
export const REMOTE_PUBLICATION_CAPTURE_EXTERNAL_DIRECTORY = 'validation-output/remote-publication-captures';
export const REMOTE_PUBLICATION_CAPTURE_STORAGE_POLICY = Object.freeze({
  relativeDirectory: REMOTE_PUBLICATION_CAPTURE_EXTERNAL_DIRECTORY,
  rawResponsesRetainedExternally: true,
  trackedInGit: false
});
export const REMOTE_PUBLICATION_CAPTURE_SOURCE = Object.freeze({
  apiVersion: '2026-03-10',
  authentication: 'authenticated-read-only',
  captureDigestMeaning: 'integrity-only-not-source-authentication',
  provider: 'github',
  transportModes: Object.freeze(['github-rest-api', 'immutable-raw-https'])
});
export const REQUIRED_REMOTE_PUBLICATION_CONTEXTS = Object.freeze([
  'Static, safety, tests, coverage, and package parity',
  'Analyze JavaScript'
]);
export const REQUIRED_RELEASE_ENVIRONMENT_NAME = 'unreleased-candidate';
export const MAX_REMOTE_CAPTURE_WINDOW_MS = 15 * 60 * 1000;
export const MAX_REMOTE_CAPTURE_AGE_MS = 30 * 60 * 1000;
export const MAX_RESPONSE_DATE_SKEW_MS = 5 * 60 * 1000;
export const REMOTE_PUBLICATION_NON_AUTOMATABLE_REQUIREMENTS = Object.freeze([
  'A distinct eligible reviewer must be genuinely available; collaborator and environment APIs prove configuration and eligibility, not human availability.',
  'A distinct human must independently review the exact candidate and publication decision; this API capture cannot satisfy that review.',
  'Every dismissed CodeQL alert requires a separate exact-candidate human review; API dismissal metadata is not independent review evidence.'
]);

const CAPTURE_KEYS = Object.freeze([
  'captureSha256',
  'captureWindow',
  'localAttestations',
  'observations',
  'schema',
  'source',
  'storage',
  'validatedAt'
]);
const CAPTURE_WINDOW_KEYS = Object.freeze(['completedAt', 'startedAt']);
const OBSERVATION_KEYS = Object.freeze(['exchanges', 'projection']);
const EXCHANGE_KEYS = Object.freeze(['observedAt', 'request', 'response']);
const REQUEST_KEYS = Object.freeze(['method', 'resourceKind', 'url']);
const RESPONSE_KEYS = Object.freeze([
  'bodyBytes',
  'contentType',
  'date',
  'etag',
  'githubRequestId',
  'link',
  'rawBodySha256',
  'status'
]);
const OBSERVATIONS = Object.freeze([
  'actionsRepositoryPermissions',
  'actionsWorkflowPermissions',
  'candidateRefAfter',
  'candidateRefBefore',
  'candidateRequiredContexts',
  'codeqlDismissedAlerts',
  'codeqlOpenAlerts',
  'hostedPrivacyPolicy',
  'mainProtection',
  'mainRefAfter',
  'mainRefBefore',
  'privateVulnerabilityReporting',
  'releaseEnvironment',
  'repository',
  'reviewerEligibility'
]);
const LOCAL_ATTESTATION_KEYS = Object.freeze([
  'codeqlDismissalIndependentReview',
  'independentPublicationReview',
  'independentReviewerAvailability'
]);
const UNPROVED_ATTESTATION_KEYS = Object.freeze(['satisfiesPublicationGate', 'status']);
const WRITE_CAPABLE_REPOSITORY_PERMISSIONS = Object.freeze(['admin', 'maintain', 'write']);
const CODEQL_DISMISSAL_REASONS = Object.freeze(['false positive', "won't fix", 'used in tests', 'mitigated']);
const API_ROOT = 'https://api.github.com';

/**
 * Capture files and their raw HTTP response bodies belong only beneath the
 * exported ignored directory. A capture digest detects local mutation; it is
 * deliberately not a signature, GitHub attestation, or source-authentication
 * claim. The validator performs no collection and no network mutation.
 */
export function canonicalRemotePublicationJsonBytes(value) {
  return Buffer.from(`${stableJson(value)}\n`, 'utf8');
}

export function computeCanonicalRemotePublicationSha256(value) {
  return sha256(canonicalRemotePublicationJsonBytes(value));
}

export function computeRemotePublicationCaptureSha256(capture) {
  if (!isPlainObject(capture)) throw new Error('Remote publication capture must be an object.');
  const unsigned = { ...capture };
  delete unsigned.captureSha256;
  return computeCanonicalRemotePublicationSha256(unsigned);
}

export function findRemotePublicationCaptureFindings({ capture, expected, now } = {}) {
  if (!capture) return ['External exact-head remote-publication capture is missing.'];
  try {
    validateRemotePublicationCapture(capture, expected, { now });
    return [...REMOTE_PUBLICATION_NON_AUTOMATABLE_REQUIREMENTS];
  } catch (error) {
    return [`External exact-head remote-publication capture is invalid: ${error?.message || String(error)}`];
  }
}

export const findRemotePublicationEvidenceFindings = findRemotePublicationCaptureFindings;

export function validateRemotePublicationCapture(capture, expected, { now } = {}) {
  const nowMs = assertIsoTimestamp(now, 'Caller-provided now');
  assertExpectedBinding(expected);
  assertExactKeys(capture, CAPTURE_KEYS, 'Remote publication capture');
  if (capture.schema !== REMOTE_PUBLICATION_CAPTURE_SCHEMA) {
    throw new Error('Remote publication capture has an unknown schema.');
  }
  if (!isSha256(capture.captureSha256) || computeRemotePublicationCaptureSha256(capture) !== capture.captureSha256) {
    throw new Error('Remote publication capture SHA-256 does not match its canonical payload.');
  }
  assertExactObject(capture.source, REMOTE_PUBLICATION_CAPTURE_SOURCE, 'Remote capture source');
  assertExactObject(capture.storage, REMOTE_PUBLICATION_CAPTURE_STORAGE_POLICY, 'Remote capture storage policy');

  assertExactKeys(capture.captureWindow, CAPTURE_WINDOW_KEYS, 'Remote capture window');
  const startedAt = assertIsoTimestamp(capture.captureWindow.startedAt, 'Remote capture startedAt');
  const completedAt = assertIsoTimestamp(capture.captureWindow.completedAt, 'Remote capture completedAt');
  const validatedAt = assertIsoTimestamp(capture.validatedAt, 'Remote capture validatedAt');
  if (completedAt < startedAt || completedAt - startedAt > MAX_REMOTE_CAPTURE_WINDOW_MS) {
    throw new Error('Remote capture window is reversed or exceeds the bounded fifteen-minute interval.');
  }
  if (validatedAt < completedAt || validatedAt > nowMs || nowMs - completedAt > MAX_REMOTE_CAPTURE_AGE_MS) {
    throw new Error('Remote capture is stale or validatedAt is outside the completedAt-to-now interval.');
  }

  assertLocalAttestationsRemainUnproved(capture.localAttestations);
  assertExactKeys(capture.observations, OBSERVATIONS, 'Remote capture observations');
  const context = { completedAt, observedTimes: new Map(), startedAt };
  const repoPath = `/repos/${expected.repository}`;

  const candidateUrl = apiUrl(`${repoPath}/git/ref/heads/${encodeURIComponent(expected.candidateBranch)}`);
  const mainUrl = apiUrl(`${repoPath}/git/ref/heads/${encodeURIComponent(expected.mainBranch)}`);
  const candidateBefore = validateSingleObservation(
    capture.observations.candidateRefBefore,
    'Candidate ref before capture',
    context,
    candidateUrl
  );
  const mainBefore = validateSingleObservation(
    capture.observations.mainRefBefore,
    'Main ref before capture',
    context,
    mainUrl
  );
  const candidateAfter = validateSingleObservation(
    capture.observations.candidateRefAfter,
    'Candidate ref after capture',
    context,
    candidateUrl
  );
  const mainAfter = validateSingleObservation(
    capture.observations.mainRefAfter,
    'Main ref after capture',
    context,
    mainUrl
  );
  validateRef(candidateBefore, expected.candidateBranch, expected.candidateHeadSha, 'Candidate ref before capture');
  validateRef(candidateAfter, expected.candidateBranch, expected.candidateHeadSha, 'Candidate ref after capture');
  validateRef(mainBefore, expected.mainBranch, expected.mainHeadSha, 'Main ref before capture');
  validateRef(mainAfter, expected.mainBranch, expected.mainHeadSha, 'Main ref after capture');
  if (stableJson(candidateBefore) !== stableJson(candidateAfter) || stableJson(mainBefore) !== stableJson(mainAfter)) {
    throw new Error('Candidate or main ref changed while the external capture was collected.');
  }

  validateRepository(
    validateSingleObservation(capture.observations.repository, 'Repository', context, apiUrl(repoPath)),
    expected
  );
  validateMainProtection(
    validateSingleObservation(
      capture.observations.mainProtection,
      'Main protection',
      context,
      apiUrl(`${repoPath}/branches/${encodeURIComponent(expected.mainBranch)}/protection`)
    ),
    expected
  );
  validateRequiredContextsObservation(
    capture.observations.candidateRequiredContexts,
    'Candidate required contexts',
    context,
    repoPath,
    expected,
    completedAt
  );

  const pvr = validateSingleObservation(
    capture.observations.privateVulnerabilityReporting,
    'Private vulnerability reporting',
    context,
    apiUrl(`${repoPath}/private-vulnerability-reporting`)
  );
  assertExactKeys(pvr, ['enabled'], 'Private vulnerability reporting projection');
  if (pvr.enabled !== true) throw new Error('Private vulnerability reporting is not enabled.');

  validateWorkflowPermissions(
    validateSingleObservation(
      capture.observations.actionsWorkflowPermissions,
      'Actions workflow permissions',
      context,
      apiUrl(`${repoPath}/actions/permissions/workflow`)
    )
  );
  validateRepositoryActionsPermissions(
    validateSingleObservation(
      capture.observations.actionsRepositoryPermissions,
      'Actions repository permissions',
      context,
      apiUrl(`${repoPath}/actions/permissions`)
    )
  );

  const codeqlRef = `refs/heads/${expected.candidateBranch}`;
  validateCodeqlOpenAlerts(
    validatePaginatedObservation(
      capture.observations.codeqlOpenAlerts,
      'CodeQL open alerts',
      context,
      codeqlPageUrl(repoPath, codeqlRef, 'open', 1)
    ),
    expected,
    codeqlRef
  );
  validateCodeqlDismissedAlerts(
    validatePaginatedObservation(
      capture.observations.codeqlDismissedAlerts,
      'CodeQL dismissed alerts',
      context,
      codeqlPageUrl(repoPath, codeqlRef, 'dismissed', 1)
    ),
    expected,
    codeqlRef,
    completedAt
  );

  const privacyObservation = capture.observations.hostedPrivacyPolicy;
  const privacy = validateSingleObservation(
    privacyObservation,
    'Hosted privacy policy',
    context,
    expected.hostedPrivacyPolicyRawUrl,
    'immutable-raw-https'
  );
  validateHostedPrivacyPolicy(privacy, privacyObservation.exchanges[0].response, expected);

  const environment = validateSingleObservation(
    capture.observations.releaseEnvironment,
    'Protected release environment',
    context,
    apiUrl(`${repoPath}/environments/${encodeURIComponent(expected.releaseEnvironmentName)}`)
  );
  validateReleaseEnvironment(environment, expected);
  validateReviewerEligibility(
    validatePaginatedObservation(
      capture.observations.reviewerEligibility,
      'Configured and eligible reviewers',
      context,
      apiUrl(`${repoPath}/collaborators?affiliation=direct&per_page=100&page=1`)
    ),
    environment,
    expected
  );

  validateRefBrackets(context);
  return capture;
}

export const assertRemotePublicationCapture = validateRemotePublicationCapture;

function assertExpectedBinding(expected) {
  if (!isPlainObject(expected)) throw new Error('Expected remote-publication binding is missing.');
  assertExactKeys(
    expected,
    [
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
    ],
    'Expected remote-publication binding'
  );
  if (!isRepositoryFullName(expected.repository)) throw new Error('Expected repository must use owner/name form.');
  if (!isSemanticVersion(expected.version))
    throw new Error('Expected version must use numeric major.minor.patch form.');
  if (expected.candidateBranch !== `candidate/sitewipe-${expected.version}`) {
    throw new Error('Expected candidate branch is not the exact version-qualified SiteWipe branch.');
  }
  if (!isGitObjectId(expected.candidateHeadSha) || !isGitObjectId(expected.mainHeadSha)) {
    throw new Error('Expected candidate and main heads must be exact lowercase Git object IDs.');
  }
  if (expected.mainBranch !== 'main' || !isGitHubLogin(expected.candidateActorLogin)) {
    throw new Error('Expected main branch or candidate actor is invalid.');
  }
  if (
    expected.hostedPrivacyPolicyVersion !== expected.version ||
    !isSha256(expected.hostedPrivacyPolicySha256) ||
    !isImmutableRawUrl(expected.hostedPrivacyPolicyRawUrl)
  ) {
    throw new Error('Expected hosted privacy policy must be immutable and bound to the exact version and hash.');
  }
  if (expected.releaseEnvironmentName !== REQUIRED_RELEASE_ENVIRONMENT_NAME) {
    throw new Error(`Expected environment must be ${REQUIRED_RELEASE_ENVIRONMENT_NAME}.`);
  }
  if (
    !Array.isArray(expected.requiredChecks) ||
    expected.requiredChecks.length !== REQUIRED_REMOTE_PUBLICATION_CONTEXTS.length
  ) {
    throw new Error('Expected exact required-check app and details-URL bindings are missing.');
  }
  const names = expected.requiredChecks.map((check) => check?.name);
  if (!exactArray(names, REQUIRED_REMOTE_PUBLICATION_CONTEXTS)) {
    throw new Error('Expected required-check names differ from the publication context set.');
  }
  for (const check of expected.requiredChecks) {
    assertExactKeys(check, ['appId', 'appSlug', 'detailsUrl', 'name'], `Expected required check ${check?.name || ''}`);
    if (
      !Number.isSafeInteger(check.appId) ||
      check.appId <= 0 ||
      !isSlug(check.appSlug) ||
      !isRepositoryDetailsUrl(check.detailsUrl, expected.repository)
    ) {
      throw new Error(`Expected required check ${check.name} lacks exact app or details-URL identity.`);
    }
  }
}

function assertLocalAttestationsRemainUnproved(attestations) {
  assertExactKeys(attestations, LOCAL_ATTESTATION_KEYS, 'Local/manual attestations');
  for (const key of LOCAL_ATTESTATION_KEYS) {
    const value = attestations[key];
    assertExactKeys(value, UNPROVED_ATTESTATION_KEYS, `Local/manual attestation ${key}`);
    if (value.status !== 'not_evidenced_by_remote_capture' || value.satisfiesPublicationGate !== false) {
      throw new Error(`${key} cannot be self-attested by a remote API capture.`);
    }
  }
}

function validateSingleObservation(observation, label, context, expectedUrl, resourceKind = 'github-rest-api') {
  const projection = validateObservation(observation, label, context, { expectedFirstUrl: expectedUrl, resourceKind });
  if (observation.exchanges.length !== 1) throw new Error(`${label} must contain exactly one HTTP exchange.`);
  return projection;
}

function validatePaginatedObservation(observation, label, context, expectedFirstUrl) {
  const projection = validateObservation(observation, label, context, {
    expectedFirstUrl,
    resourceKind: 'github-rest-api'
  });
  const pagination = projection?.pagination;
  assertExactKeys(pagination, ['complete', 'pageCount', 'totalItems'], `${label} pagination projection`);
  if (
    pagination.complete !== true ||
    pagination.pageCount !== observation.exchanges.length ||
    !Number.isSafeInteger(pagination.totalItems) ||
    pagination.totalItems < 0
  ) {
    throw new Error(`${label} pagination evidence is incomplete.`);
  }
  for (let index = 0; index < observation.exchanges.length; index += 1) {
    const exchange = observation.exchanges[index];
    const page = index + 1;
    const expectedUrl = replacePage(expectedFirstUrl, page);
    if (exchange.request.url !== expectedUrl) throw new Error(`${label} page ${page} URL is not exact.`);
    const nextUrl = page < observation.exchanges.length ? replacePage(expectedFirstUrl, page + 1) : null;
    if (!linkHeaderMatchesNext(exchange.response.link, nextUrl)) {
      throw new Error(`${label} page ${page} Link header does not prove complete pagination.`);
    }
  }
  return projection;
}

function validateRequiredContextsObservation(observation, label, context, repoPath, expected, completedAt) {
  const projection = validateObservation(observation, label, context, {
    expectedFirstUrl: requiredCheckRunsUrl(repoPath, expected.candidateHeadSha, expected.requiredChecks[0]),
    resourceKind: 'github-rest-api'
  });
  if (observation.exchanges.length !== expected.requiredChecks.length) {
    throw new Error(`${label} must retain one exact filtered check-runs exchange per required context.`);
  }
  for (const [index, binding] of expected.requiredChecks.entries()) {
    const exactUrl = requiredCheckRunsUrl(repoPath, expected.candidateHeadSha, binding);
    if (observation.exchanges[index].request.url !== exactUrl) {
      throw new Error(`${label} exchange ${index + 1} is not the exact filtered query for ${binding.name}.`);
    }
  }
  validateRequiredContexts(projection, expected, completedAt);
}

function validateObservation(observation, label, context, { expectedFirstUrl, resourceKind }) {
  assertExactKeys(observation, OBSERVATION_KEYS, `${label} observation`);
  if (!Array.isArray(observation.exchanges) || observation.exchanges.length === 0) {
    throw new Error(`${label} has no retained HTTP exchanges.`);
  }
  for (const [index, exchange] of observation.exchanges.entries()) {
    validateExchange(exchange, `${label} exchange ${index + 1}`, context, resourceKind);
  }
  if (observation.exchanges[0].request.url !== expectedFirstUrl) {
    throw new Error(`${label} request URL is not the exact expected external resource.`);
  }
  if (!isPlainObject(observation.projection)) throw new Error(`${label} sanitized projection must be an object.`);
  return observation.projection;
}

function validateExchange(exchange, label, context, resourceKind) {
  assertExactKeys(exchange, EXCHANGE_KEYS, label);
  assertExactKeys(exchange.request, REQUEST_KEYS, `${label} request`);
  assertExactKeys(exchange.response, RESPONSE_KEYS, `${label} response`);
  if (
    exchange.request.method !== 'GET' ||
    exchange.request.resourceKind !== resourceKind ||
    !isHttpsUrl(exchange.request.url) ||
    (resourceKind === 'github-rest-api' && !exchange.request.url.startsWith(`${API_ROOT}/`))
  ) {
    throw new Error(`${label} is not an exact read-only request of the declared resource kind.`);
  }
  const observedAt = assertIsoTimestamp(exchange.observedAt, `${label} observedAt`);
  const responseDate = assertHttpDate(exchange.response.date, `${label} response Date`);
  if (observedAt < context.startedAt || observedAt > context.completedAt) {
    throw new Error(`${label} falls outside the capture window.`);
  }
  if (Math.abs(observedAt - responseDate) > MAX_RESPONSE_DATE_SKEW_MS) {
    throw new Error(`${label} response Date is not fresh relative to observedAt.`);
  }
  if (
    exchange.response.status !== 200 ||
    !Number.isSafeInteger(exchange.response.bodyBytes) ||
    exchange.response.bodyBytes <= 0 ||
    !isSha256(exchange.response.rawBodySha256) ||
    !isNullableString(exchange.response.etag) ||
    !isNullableString(exchange.response.githubRequestId) ||
    !isNullableString(exchange.response.link) ||
    !isNonEmptyString(exchange.response.contentType)
  ) {
    throw new Error(`${label} lacks successful response metadata or an externally retained raw-body hash.`);
  }
  context.observedTimes.set(label, observedAt);
}

function validateRef(ref, branch, headSha, label) {
  assertExactKeys(ref, ['branch', 'headSha', 'ref'], `${label} projection`);
  if (ref.branch !== branch || ref.ref !== `refs/heads/${branch}` || ref.headSha !== headSha) {
    throw new Error(`${label} is not bound to the exact branch and head.`);
  }
}

function validateRepository(repository, expected) {
  assertExactKeys(
    repository,
    ['defaultBranch', 'fullName', 'htmlUrl', 'repositoryId', 'visibility'],
    'Repository projection'
  );
  if (
    repository.fullName !== expected.repository ||
    repository.htmlUrl !== `https://github.com/${expected.repository}` ||
    repository.defaultBranch !== expected.mainBranch ||
    repository.visibility !== 'public' ||
    !Number.isSafeInteger(repository.repositoryId) ||
    repository.repositoryId <= 0
  ) {
    throw new Error('Repository projection is not the exact public repository and default branch.');
  }
}

function validateMainProtection(protection, expected) {
  assertExactKeys(
    protection,
    [
      'allowDeletions',
      'allowForcePushes',
      'branch',
      'enforceAdmins',
      'headSha',
      'requiredConversationResolution',
      'requiredLinearHistory',
      'requiredStatusChecks'
    ],
    'Main protection projection'
  );
  assertExactKeys(protection.requiredStatusChecks, ['checks', 'contexts', 'strict'], 'Main required status checks');
  const requiredCheckBindings = expected.requiredChecks.map((check) => ({
    context: check.name,
    appId: check.appId
  }));
  if (
    protection.branch !== expected.mainBranch ||
    protection.headSha !== expected.mainHeadSha ||
    protection.enforceAdmins !== true ||
    protection.requiredConversationResolution !== true ||
    protection.requiredLinearHistory !== true ||
    protection.allowForcePushes !== false ||
    protection.allowDeletions !== false ||
    protection.requiredStatusChecks.strict !== true ||
    !exactArray(protection.requiredStatusChecks.contexts, REQUIRED_REMOTE_PUBLICATION_CONTEXTS) ||
    !exactArray(protection.requiredStatusChecks.checks, requiredCheckBindings)
  ) {
    throw new Error('Main branch protection is missing an exact required control, head, or context set.');
  }
}

function validateRequiredContexts(checks, expected, completedAt) {
  assertExactKeys(checks, ['headSha', 'requiredContexts'], 'Candidate required-context projection');
  if (checks.headSha !== expected.candidateHeadSha || !Array.isArray(checks.requiredContexts)) {
    throw new Error('Required contexts are not bound to the exact candidate head.');
  }
  if (
    !exactArray(
      checks.requiredContexts.map((check) => check?.name),
      REQUIRED_REMOTE_PUBLICATION_CONTEXTS
    )
  ) {
    throw new Error('Candidate required contexts differ from the exact publication context set.');
  }
  for (const [index, check] of checks.requiredContexts.entries()) {
    assertExactKeys(
      check,
      ['appId', 'appSlug', 'checkRunId', 'completedAt', 'conclusion', 'detailsUrl', 'headSha', 'name', 'status'],
      `Required context ${index + 1}`
    );
    const binding = expected.requiredChecks[index];
    if (
      check.name !== binding.name ||
      check.appId !== binding.appId ||
      check.appSlug !== binding.appSlug ||
      check.detailsUrl !== binding.detailsUrl ||
      check.headSha !== expected.candidateHeadSha ||
      check.status !== 'completed' ||
      check.conclusion !== 'success' ||
      !Number.isSafeInteger(check.checkRunId) ||
      check.checkRunId <= 0 ||
      assertIsoTimestamp(check.completedAt, `Required context ${check.name} completedAt`) > completedAt
    ) {
      throw new Error(`Required context ${check.name || index + 1} lacks exact head, app, URL, or success identity.`);
    }
  }
}

function validateWorkflowPermissions(value) {
  assertExactKeys(
    value,
    ['canApprovePullRequestReviews', 'defaultWorkflowPermissions'],
    'Workflow permissions projection'
  );
  if (value.defaultWorkflowPermissions !== 'read' || value.canApprovePullRequestReviews !== false) {
    throw new Error('GitHub Actions workflow tokens are not restricted to read-only non-reviewing permissions.');
  }
}

function validateRepositoryActionsPermissions(value) {
  assertExactKeys(value, ['allowedActions', 'enabled', 'shaPinningRequired'], 'Actions permissions projection');
  if (
    value.enabled !== true ||
    !['all', 'local_only', 'selected'].includes(value.allowedActions) ||
    value.shaPinningRequired !== true
  ) {
    throw new Error('GitHub Actions is not configured to require full-SHA action pinning.');
  }
}

function validateCodeqlOpenAlerts(codeql, expected, ref) {
  assertExactKeys(codeql, ['candidateHeadSha', 'openAlertCount', 'pagination', 'ref'], 'CodeQL open-alert projection');
  if (codeql.candidateHeadSha !== expected.candidateHeadSha || codeql.ref !== ref || codeql.openAlertCount !== 0) {
    throw new Error('CodeQL open-alert capture is stale, unbound, or nonzero.');
  }
  if (codeql.pagination.totalItems !== codeql.openAlertCount) {
    throw new Error('CodeQL open-alert pagination total differs from the projection count.');
  }
}

function validateCodeqlDismissedAlerts(codeql, expected, ref, completedAt) {
  assertExactKeys(
    codeql,
    ['alerts', 'candidateHeadSha', 'dismissedAlertCount', 'pagination', 'ref'],
    'CodeQL dismissed-alert projection'
  );
  if (
    codeql.candidateHeadSha !== expected.candidateHeadSha ||
    codeql.ref !== ref ||
    !Array.isArray(codeql.alerts) ||
    codeql.dismissedAlertCount !== codeql.alerts.length ||
    codeql.pagination.totalItems !== codeql.alerts.length
  ) {
    throw new Error('CodeQL dismissed-alert capture is incomplete or not bound to the candidate head.');
  }
  const seen = new Set();
  for (const [index, alert] of codeql.alerts.entries()) {
    assertExactKeys(
      alert,
      ['alertNumber', 'dismissalComment', 'dismissalReason', 'dismissedAt', 'dismissedBy', 'ruleId', 'state'],
      `CodeQL dismissed alert ${index + 1}`
    );
    if (
      !Number.isSafeInteger(alert.alertNumber) ||
      alert.alertNumber <= 0 ||
      seen.has(alert.alertNumber) ||
      alert.state !== 'dismissed' ||
      !isNonEmptyString(alert.ruleId) ||
      !isGitHubLogin(alert.dismissedBy) ||
      !CODEQL_DISMISSAL_REASONS.includes(alert.dismissalReason) ||
      !isNonEmptyString(alert.dismissalComment) ||
      assertIsoTimestamp(alert.dismissedAt, `CodeQL alert ${alert.alertNumber} dismissedAt`) > completedAt
    ) {
      throw new Error(`CodeQL dismissed alert ${alert.alertNumber || index + 1} has invalid API dismissal metadata.`);
    }
    seen.add(alert.alertNumber);
  }
}

function validateHostedPrivacyPolicy(policy, response, expected) {
  assertExactKeys(policy, ['bytes', 'rawUrl', 'sha256', 'version'], 'Hosted privacy-policy projection');
  if (
    policy.rawUrl !== expected.hostedPrivacyPolicyRawUrl ||
    policy.version !== expected.hostedPrivacyPolicyVersion ||
    policy.sha256 !== expected.hostedPrivacyPolicySha256 ||
    policy.sha256 !== response.rawBodySha256 ||
    !Number.isSafeInteger(policy.bytes) ||
    policy.bytes <= 0 ||
    policy.bytes !== response.bodyBytes
  ) {
    throw new Error('Hosted privacy policy is not bound to the immutable raw URL, version, and exact bytes.');
  }
}

function validateReleaseEnvironment(environment, expected) {
  assertExactKeys(
    environment,
    ['configuredReviewerLogins', 'name', 'preventSelfReview', 'protectedBranchesOnly'],
    'Release environment projection'
  );
  if (
    environment.name !== expected.releaseEnvironmentName ||
    environment.preventSelfReview !== true ||
    environment.protectedBranchesOnly !== true ||
    !isUniqueLoginArray(environment.configuredReviewerLogins) ||
    environment.configuredReviewerLogins.length === 0
  ) {
    throw new Error('Protected release environment is not configured with the required restrictions and reviewers.');
  }
}

function validateReviewerEligibility(eligibility, environment, expected) {
  assertExactKeys(
    eligibility,
    ['directCollaborators', 'eligibleConfiguredReviewerLogins', 'pagination'],
    'Configured reviewer eligibility projection'
  );
  if (
    !Array.isArray(eligibility.directCollaborators) ||
    !isUniqueLoginArray(eligibility.eligibleConfiguredReviewerLogins)
  ) {
    throw new Error('Configured reviewer eligibility projection is malformed.');
  }
  const eligible = new Set();
  for (const collaborator of eligibility.directCollaborators) {
    assertExactKeys(collaborator, ['login', 'permission'], 'Direct collaborator projection');
    if (!isGitHubLogin(collaborator.login) || !WRITE_CAPABLE_REPOSITORY_PERMISSIONS.includes(collaborator.permission)) {
      throw new Error('Direct collaborator is not API-provably eligible to review repository changes.');
    }
    eligible.add(collaborator.login.toLowerCase());
  }
  const expectedEligible = environment.configuredReviewerLogins
    .filter((login) => login.toLowerCase() !== expected.candidateActorLogin.toLowerCase())
    .filter((login) => eligible.has(login.toLowerCase()));
  if (!exactArray(eligibility.eligibleConfiguredReviewerLogins, expectedEligible) || expectedEligible.length === 0) {
    throw new Error('No configured API-eligible reviewer is distinct from the candidate actor.');
  }
  if (eligibility.pagination.totalItems !== eligibility.directCollaborators.length) {
    throw new Error('Reviewer-eligibility pagination total differs from the collaborator projection.');
  }
}

function validateRefBrackets(context) {
  const time = (prefix) => context.observedTimes.get(`${prefix} exchange 1`);
  const candidateBefore = time('Candidate ref before capture');
  const mainBefore = time('Main ref before capture');
  const candidateAfter = time('Candidate ref after capture');
  const mainAfter = time('Main ref after capture');
  if (candidateBefore !== context.startedAt || mainAfter !== context.completedAt) {
    throw new Error('Candidate-before and main-after observations must open and close the exact capture window.');
  }
  if (!(candidateBefore < mainBefore && mainBefore < candidateAfter && candidateAfter < mainAfter)) {
    throw new Error('Candidate and main before/after ref observations do not form a valid double bracket.');
  }
  for (const [label, observedAt] of context.observedTimes) {
    if (label.includes('ref before') || label.includes('ref after')) continue;
    if (observedAt < mainBefore || observedAt > candidateAfter) {
      throw new Error(`${label} falls outside the candidate-and-main ref bracket.`);
    }
  }
}

function codeqlPageUrl(repoPath, ref, state, page) {
  return apiUrl(
    `${repoPath}/code-scanning/alerts?ref=${encodeURIComponent(ref)}&state=${state}&tool_name=CodeQL&per_page=100&page=${page}`
  );
}

function requiredCheckRunsUrl(repoPath, headSha, check) {
  return apiUrl(
    `${repoPath}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(check.name)}&filter=latest&app_id=${check.appId}&per_page=100`
  );
}

function apiUrl(path) {
  return `${API_ROOT}${path}`;
}

function replacePage(url, page) {
  return url.replace(/([?&]page=)\d+/, `$1${page}`);
}

function linkHeaderMatchesNext(link, nextUrl) {
  if (nextUrl === null) return link === null || !/rel="next"/.test(link);
  return typeof link === 'string' && link.includes(`<${nextUrl}>; rel="next"`);
}

function assertExactObject(actual, expected, label) {
  assertExactKeys(actual, Object.keys(expected), label);
  if (stableJson(actual) !== stableJson(expected)) throw new Error(`${label} differs from the required contract.`);
}

function assertExactKeys(value, keys, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (!exactArray(actual, expected)) throw new Error(`${label} keys differ from the exact schema.`);
}

function assertIsoTimestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error(`${label} must be an exact UTC ISO timestamp.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} is not a canonical UTC timestamp.`);
  }
  return parsed;
}

function assertHttpDate(value, label) {
  if (typeof value !== 'string' || !/GMT$/.test(value)) throw new Error(`${label} must be an HTTP Date header.`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is invalid.`);
  return parsed;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSha256(value) {
  return typeof value === 'string' && /^[A-F0-9]{64}$/.test(value);
}

function isGitObjectId(value) {
  return typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value);
}

function isRepositoryFullName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value);
}

function isSemanticVersion(value) {
  return typeof value === 'string' && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value);
}

function isGitHubLogin(value) {
  return typeof value === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value);
}

function isSlug(value) {
  return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNullableString(value) {
  return value === null || typeof value === 'string';
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function isImmutableRawUrl(value) {
  if (!isHttpsUrl(value)) return false;
  const url = new URL(value);
  return (
    url.origin === 'https://gist.githubusercontent.com' &&
    url.username === '' &&
    url.password === '' &&
    /\/raw\/[a-f0-9]{40,64}\//.test(url.pathname)
  );
}

function isRepositoryDetailsUrl(value, repository) {
  if (!isHttpsUrl(value)) return false;
  const url = new URL(value);
  return (
    url.origin === 'https://github.com' &&
    url.username === '' &&
    url.password === '' &&
    url.pathname.startsWith(`/${repository}/`)
  );
}

function isUniqueLoginArray(value) {
  if (!Array.isArray(value) || value.some((login) => !isGitHubLogin(login))) return false;
  return new Set(value.map((login) => login.toLowerCase())).size === value.length;
}

function exactArray(actual, expected) {
  return Array.isArray(actual) && Array.isArray(expected) && JSON.stringify(actual) === JSON.stringify(expected);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

import { execFileSync } from 'node:child_process';

const DECISIVE_REVIEW_STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);
const WRITE_CAPABLE_PERMISSIONS = new Set(['admin', 'maintain', 'write']);

export function parseGitHubRepositorySlug(value) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return null;
    if (url.username || url.password || url.search || url.hash) return null;
    const match = url.pathname.match(/^\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/);
    return match ? `${match[1]}/${match[2]}` : null;
  } catch {
    return null;
  }
}

export function evaluateIndependentGitHubReview({
  pullRequest,
  reviews = [],
  permissionsByLogin = {},
  maintainerHandle,
  currentHeadSha
}) {
  const head = normalizeSha(currentHeadSha);
  const maintainer = normalizeLogin(maintainerHandle);
  const author = normalizeLogin(pullRequest?.user?.login);

  if (!head || !maintainer || !author) return rejected('The review context is incomplete or malformed.');
  if (String(pullRequest?.state || '').toLowerCase() !== 'open')
    return rejected('The designated pull request is not open.');
  if (pullRequest?.draft !== false) return rejected('The designated pull request is still a draft.');
  if (normalizeSha(pullRequest?.head?.sha) !== head)
    return rejected('The designated pull request does not point to the exact current Git head.');

  const latestDecisiveByReviewer = new Map();
  for (const review of [...reviews].sort(compareReviews)) {
    const reviewer = normalizeLogin(review?.user?.login);
    const state = String(review?.state || '').toUpperCase();
    if (reviewer && DECISIVE_REVIEW_STATES.has(state)) latestDecisiveByReviewer.set(reviewer, review);
  }

  const excluded = new Set([maintainer, author]);
  const candidates = [];
  for (const [reviewer, review] of latestDecisiveByReviewer) {
    if (excluded.has(reviewer)) continue;
    if (String(review.state || '').toUpperCase() !== 'APPROVED') continue;
    if (normalizeSha(review.commit_id) !== head) continue;
    if (!Number.isSafeInteger(review.id) || review.id <= 0) continue;
    if (!isIsoTimestamp(review.submitted_at) || !isGitHubReviewUrl(review.html_url)) continue;
    const permission = normalizePermission(permissionFor(permissionsByLogin, reviewer));
    if (!WRITE_CAPABLE_PERMISSIONS.has(permission)) continue;
    candidates.push({
      reviewer: review.user.login,
      permission,
      reviewId: review.id,
      reviewUrl: review.html_url,
      submittedAt: review.submitted_at,
      commitSha: review.commit_id
    });
  }

  if (candidates.length === 0) {
    return rejected(
      'No distinct write-capable reviewer has an undismissed approving GitHub review for the exact current head.'
    );
  }

  candidates.sort((left, right) => left.reviewer.localeCompare(right.reviewer, 'en-US', { sensitivity: 'base' }));
  return { verified: true, ...candidates[0] };
}

export function verifyLiveIndependentGitHubReview({
  repositoryUrl,
  pullRequestNumber,
  maintainerHandle,
  cwd,
  execute = execFileSync
}) {
  const repository = parseGitHubRepositorySlug(repositoryUrl);
  if (!repository || !Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0) {
    return rejected('The configured GitHub repository or pull-request number is invalid.');
  }

  try {
    const options = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true };
    const currentHeadSha = execute('git', ['rev-parse', 'HEAD'], options).trim();
    const pullRequest = parseJson(
      execute('gh', ['api', `repos/${repository}/pulls/${pullRequestNumber}`], options),
      'pull-request response'
    );
    const reviewPages = parseJson(
      execute(
        'gh',
        ['api', '--paginate', '--slurp', `repos/${repository}/pulls/${pullRequestNumber}/reviews`],
        options
      ),
      'review response'
    );
    const reviews = Array.isArray(reviewPages?.[0]) ? reviewPages.flat() : reviewPages;
    if (!Array.isArray(reviews)) return rejected('The GitHub review response was not an array.');

    const permissionsByLogin = {};
    const excluded = new Set([normalizeLogin(maintainerHandle), normalizeLogin(pullRequest?.user?.login)]);
    for (const login of new Set(reviews.map((review) => String(review?.user?.login || '')).filter(Boolean))) {
      if (excluded.has(normalizeLogin(login))) continue;
      try {
        permissionsByLogin[login] = parseJson(
          execute('gh', ['api', `repos/${repository}/collaborators/${login}/permission`], options),
          'collaborator-permission response'
        );
      } catch {
        permissionsByLogin[login] = { permission: 'none' };
      }
    }

    return evaluateIndependentGitHubReview({
      pullRequest,
      reviews,
      permissionsByLogin,
      maintainerHandle,
      currentHeadSha
    });
  } catch {
    return rejected('Live GitHub review verification was unavailable or returned malformed data.');
  }
}

function compareReviews(left, right) {
  const leftTime = Date.parse(left?.submitted_at || '') || 0;
  const rightTime = Date.parse(right?.submitted_at || '') || 0;
  return leftTime - rightTime || Number(left?.id || 0) - Number(right?.id || 0);
}

function permissionFor(permissionsByLogin, normalizedLogin) {
  if (permissionsByLogin instanceof Map) {
    for (const [login, value] of permissionsByLogin) {
      if (normalizeLogin(login) === normalizedLogin) return value;
    }
    return null;
  }
  for (const [login, value] of Object.entries(permissionsByLogin || {})) {
    if (normalizeLogin(login) === normalizedLogin) return value;
  }
  return null;
}

function normalizePermission(value) {
  return String(typeof value === 'string' ? value : value?.permission || value?.role_name || '').toLowerCase();
}

function normalizeLogin(value) {
  const login = String(value || '');
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login) ? login.toLowerCase() : null;
}

function normalizeSha(value) {
  const sha = String(value || '');
  return /^[0-9a-f]{40}$/i.test(sha) ? sha.toLowerCase() : null;
}

function isIsoTimestamp(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(String(value || ''));
}

function isGitHubReviewUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return (
      url.protocol === 'https:' &&
      url.hostname.toLowerCase() === 'github.com' &&
      /^\/[^/]+\/[^/]+\/pull\/\d+#pullrequestreview-\d+$/.test(`${url.pathname}${url.hash}`)
    );
  } catch {
    return false;
  }
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function rejected(reason) {
  return { verified: false, reason };
}

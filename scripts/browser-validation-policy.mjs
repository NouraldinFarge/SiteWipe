// The installed-browser harness, publication gate, and version reset all import
// this single policy surface. The implementation lives with the harness so its
// exhaustive settings contract can bind the real production defaults.
import { createHash } from 'node:crypto';

import { runTrustedGit } from './trusted-git.mjs';

export const BROWSER_HARNESS_GIT_PATHS = Object.freeze([
  'package.json',
  'package-lock.json',
  'scripts/browser-validation-policy.mjs',
  'scripts/trusted-git.mjs',
  'tests/browser'
]);

export function computeCommittedBrowserHarnessManifestSha256(root, ref = 'HEAD') {
  const listing = runTrustedGit({
    root,
    args: ['ls-tree', '-r', '--full-tree', ref, '--', ...BROWSER_HARNESS_GIT_PATHS],
    encoding: 'utf8'
  });
  const lines = listing.split(/\r?\n/).filter(Boolean).sort();
  if (!lines.length || !lines.some((line) => line.endsWith('\ttests/browser/installed/canonical-matrix.mjs'))) {
    throw new Error('Exact Git source does not contain the canonical installed-browser harness.');
  }
  return createHash('sha256')
    .update(Buffer.from(`${lines.join('\n')}\n`, 'utf8'))
    .digest('hex')
    .toUpperCase();
}

export function listCommittedBrowserEvidenceDeltaPaths(root, testedCommitSha, finalCommitSha = 'HEAD') {
  return runTrustedGit({
    root,
    args: [
      'diff',
      '--no-renames',
      '--name-only',
      '-z',
      '--diff-filter=ACDMRTUXB',
      `${testedCommitSha}..${finalCommitSha}`,
      '--'
    ],
    encoding: 'utf8'
  })
    .split('\0')
    .filter(Boolean)
    .sort();
}

export {
  BROWSER_MATRIX_VERSION,
  CANONICAL_BROWSER_MATRIX,
  CANONICAL_BROWSER_MATRIX_IDS,
  CANONICAL_BROWSER_MATRIX_SHA256,
  INTERNAL_SETTINGS,
  REQUIRED_BROWSERS,
  SETTINGS_DEFAULTS,
  VISIBLE_SETTINGS,
  assertExactCanonicalMatrix,
  canonicalScenario
} from '../tests/browser/installed/canonical-matrix.mjs';

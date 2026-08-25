import assert from 'node:assert/strict';
import test from 'node:test';

import { validateAssociatedDomainGroupsForCleanup } from '../../src/background/cleanup-preflight.js';

const STRUCTURAL_SETTINGS = Object.freeze({
  cleanupMode: 'expert',
  verificationPass: true,
  resetZoom: true,
  progressOverlay: false,
  pageScriptScrub: false,
  temporaryDnrShield: false,
  postWipeSessionBlock: false,
  downloadRecentFallback: false,
  broadDiscoveryFallback: false,
  embeddedFrameDiscovery: false,
  probePartitionedCookiesWithEmbeddingSites: false,
  exhaustiveCookieStoreScan: false,
  allowLocalTargets: false
});

test('associated-domain validation rejects the first merged primary scope that structural preflight rejects', () => {
  const admitted = validateAssociatedDomainGroupsForCleanup(groupsForPrimary('example.com', 15), STRUCTURAL_SETTINGS);
  const rejected = validateAssociatedDomainGroupsForCleanup(groupsForPrimary('example.com', 16), STRUCTURAL_SETTINGS);

  assert.equal(admitted.ok, true);
  assert.equal(admitted.capacityChecked, true);
  assert.equal(admitted.capacityErrors.length, 0);
  assert.equal(admitted.capacityPlans.length, 1);
  assert.equal(admitted.capacityPlans[0].associatedTargetCount, 15);
  assert.equal(admitted.capacityPlans[0].cleanupPlannedQueries, 932);

  assert.equal(rejected.ok, false);
  assert.equal(rejected.capacityErrors.length, 1);
  assert.equal(rejected.capacityErrors[0].capacity, true);
  assert.equal(rejected.capacityErrors[0].input, 'example.com');
  assert.equal(rejected.capacityErrors[0].cleanupPlannedQueries, 980);
  assert.equal(rejected.capacityErrors[0].cleanupAdmissionLimit, 950);
  assert.match(rejected.capacityErrors[0].message, /cannot pass cleanup's structural preflight/i);
  assert.equal(rejected.errors.at(-1), rejected.capacityErrors[0]);
});

test('capacity validation merges repeated-primary lines but evaluates unrelated primaries independently', () => {
  const groups = [groupsForPrimary('example.com', 12), groupsForPrimary('example.org', 12, 40)].join('\n');
  const validation = validateAssociatedDomainGroupsForCleanup(groups, STRUCTURAL_SETTINGS);

  assert.equal(validation.ok, true);
  assert.equal(validation.capacityErrors.length, 0);
  assert.equal(validation.capacityPlans.length, 2);
  assert.deepEqual(
    validation.capacityPlans.map((plan) => [plan.primary, plan.associatedTargetCount]),
    [
      ['example.com', 12],
      ['example.org', 12]
    ]
  );
});

test('capacity validation preserves live private-access cost that stored-setting normalization excludes', () => {
  const groups = groupsForPrimary('example.com', 14, 0, 'r');
  const boundarySettings = {
    ...STRUCTURAL_SETTINGS,
    temporaryDnrShield: true,
    embeddedFrameDiscovery: true,
    downloadRecentFallback: true,
    broadDiscoveryFallback: true
  };
  const normalOnly = validateAssociatedDomainGroupsForCleanup(groups, {
    ...boundarySettings,
    incognitoAccess: false
  });
  const spanning = validateAssociatedDomainGroupsForCleanup(groups, {
    ...boundarySettings,
    incognitoAccess: true
  });

  assert.equal(normalOnly.ok, true);
  assert.equal(normalOnly.capacityPlans[0].cleanupPlannedQueries, 950);
  assert.equal(spanning.ok, false);
  assert.equal(spanning.capacityErrors[0].cleanupPlannedQueries, 951);
  assert.equal(spanning.capacityErrors[0].cleanupAdmissionLimit, 950);
});

test('Standard mode reports syntax but does not reject dormant Expert-only associated scope for capacity', () => {
  const validation = validateAssociatedDomainGroupsForCleanup(groupsForPrimary('example.com', 24), {
    ...STRUCTURAL_SETTINGS,
    cleanupMode: 'standard'
  });

  assert.equal(validation.ok, true);
  assert.equal(validation.capacityChecked, false);
  assert.deepEqual(validation.capacityErrors, []);
  assert.deepEqual(validation.capacityPlans, []);
});

test('capacity planning uses normalized duplicate and Unicode identities', () => {
  const validation = validateAssociatedDomainGroupsForCleanup(
    ['EXAMPLE.com => Related.com, RELATED.com.', 'bücher.de => café.fr, xn--caf-dma.fr'].join('\n'),
    STRUCTURAL_SETTINGS
  );

  assert.equal(validation.ok, true);
  assert.equal(validation.groupCount, 2);
  assert.equal(validation.associatedTargetCount, 2);
  assert.equal(validation.warnings.length, 2);
  assert.deepEqual(
    validation.capacityPlans.map((plan) => [plan.primary, plan.associatedTargetCount]),
    [
      ['example.com', 1],
      ['xn--bcher-kva.de', 1]
    ]
  );
  assert.equal(validation.groups[1].associated[0].target, 'xn--caf-dma.fr');
});

test('invalid entries fail closed while enabled local targets retain exact-origin capacity semantics', () => {
  const invalid = validateAssociatedDomainGroupsForCleanup('example.com => invalid_target', STRUCTURAL_SETTINGS);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.capacityErrors.length, 0);
  assert.match(invalid.errors[0].relatedErrors[0].message, /invalid characters or labels/i);

  const localGroups = 'http://localhost:3000 => http://127.0.0.1:5173, http://[::1]:8080';
  const localBlocked = validateAssociatedDomainGroupsForCleanup(localGroups, STRUCTURAL_SETTINGS);
  assert.equal(localBlocked.ok, false);
  assert.match(localBlocked.errors[0].message, /localhost and IP-address cleanup are disabled/i);

  const localAllowed = validateAssociatedDomainGroupsForCleanup(localGroups, {
    ...STRUCTURAL_SETTINGS,
    allowLocalTargets: true
  });
  assert.equal(localAllowed.ok, true);
  assert.equal(localAllowed.groups[0].primaryMode, 'exact_origin');
  assert.deepEqual(
    localAllowed.groups[0].associated.map((entry) => entry.exactOrigin),
    ['http://127.0.0.1:5173', 'http://[::1]:8080']
  );
  assert.equal(localAllowed.capacityPlans[0].associatedTargetCount, 2);
});

function groupsForPrimary(primary, count, offset = 0, labelPrefix = 'related-') {
  const domains = Array.from({ length: count }, (_, index) => `${labelPrefix}${offset + index + 1}.com`);
  const lines = [];
  for (let index = 0; index < domains.length; index += 12) {
    lines.push(`${primary} => ${domains.slice(index, index + 12).join(', ')}`);
  }
  return lines.join('\n');
}

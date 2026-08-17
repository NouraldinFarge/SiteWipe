import assert from 'node:assert/strict';
import test from 'node:test';

import { createReport, finishReport } from '../../src/background/report.js';
import {
  VERIFICATION_STATES,
  summarizeVerification,
  verificationFailure,
  verificationFromCount,
  verificationNotAttempted,
  verificationNotSupported,
  verificationUnknown
} from '../../src/shared/verification-evidence.js';

const REQUIRED = ['cookies', 'tabs', 'history', 'downloads'];

test('verified zero requires every required category to complete with zero', () => {
  const categories = Object.fromEntries(REQUIRED.map((name) => [name, verificationFromCount(0)]));
  assert.deepEqual(summarizeVerification(categories, REQUIRED), {
    status: 'verified_zero',
    allRequiredChecksSucceeded: true,
    noExposedResidueFound: true,
    residueCount: 0,
    incomplete: []
  });
});

test('verified residue remains distinct from incomplete verification', () => {
  const categories = Object.fromEntries(REQUIRED.map((name) => [name, verificationFromCount(0)]));
  categories.cookies = verificationFromCount(3);
  const summary = summarizeVerification(categories, REQUIRED);
  assert.equal(summary.status, 'residue_found');
  assert.equal(summary.allRequiredChecksSucceeded, true);
  assert.equal(summary.noExposedResidueFound, false);
  assert.equal(summary.residueCount, 3);
});

test('known residue plus a failed required check remains incomplete', async () => {
  const categories = Object.fromEntries(REQUIRED.map((name) => [name, verificationFromCount(0)]));
  categories.cookies = verificationFromCount(3);
  categories.history = verificationFailure(new Error('history query failed'));
  const summary = summarizeVerification(categories, REQUIRED);
  assert.equal(summary.status, 'residue_found');
  assert.equal(summary.allRequiredChecksSucceeded, false);
  assert.equal(summary.noExposedResidueFound, false);
  assert.equal(summary.residueCount, 3);
  assert.deepEqual(
    summary.incomplete.map((item) => [item.name, item.state]),
    [['history', 'failed']]
  );

  const report = createReport({ domain: 'evidence.example', matchMode: 'registrable_domain' }, 'evidence.example');
  report.hostPermissionsGranted = true;
  report.incognitoAccess = true;
  report.summary.verificationPassEnabled = true;
  report.summary.verificationStatus = summary.status;
  report.summary.verificationAllRequiredChecksSucceeded = summary.allRequiredChecksSucceeded;
  report.summary.verificationCategories = categories;
  report.summary.verificationCookiesRemaining = 3;
  report.summary.verificationTabsRemaining = 0;
  report.summary.verificationHistoryRemaining = null;
  report.summary.verificationDownloadsRemaining = 0;
  await finishReport(report);

  assert.equal(report.summary.verificationRemainingTotal, null);
  assert.ok(report.summary.cleanupConfidenceScore <= 65);
  assert.notEqual(report.summary.cleanupConfidenceLabel, 'High');
  assert.equal(
    report.summary.cleanupConfidenceReasons.some((reason) => /3 exposed residue item\(s\) were found/i.test(reason)),
    true
  );
  assert.equal(
    report.summary.cleanupConfidenceReasons.some((reason) => /other verification evidence is incomplete/i.test(reason)),
    true
  );
});

test('unsupported, skipped, timeout, failure, and unknown never become verified zero', () => {
  const incompleteCases = [
    verificationNotSupported('unsupported'),
    verificationNotAttempted('skipped'),
    verificationFailure(new Error('operation timed out after 1ms')),
    verificationFailure(new Error('permission denied')),
    verificationUnknown('unknown')
  ];
  assert.deepEqual(
    incompleteCases.map((item) => item.state),
    [
      VERIFICATION_STATES.notSupported,
      VERIFICATION_STATES.notAttempted,
      VERIFICATION_STATES.timedOut,
      VERIFICATION_STATES.failed,
      VERIFICATION_STATES.unknown
    ]
  );

  for (const incomplete of incompleteCases) {
    const categories = Object.fromEntries(REQUIRED.map((name) => [name, verificationFromCount(0)]));
    categories.cookies = incomplete;
    const summary = summarizeVerification(categories, REQUIRED);
    assert.equal(summary.status, 'incomplete');
    assert.equal(summary.allRequiredChecksSucceeded, false);
    assert.equal(summary.noExposedResidueFound, false);
    assert.equal(summary.incomplete[0].state, incomplete.state);
  }
});

test('incomplete verification caps confidence and never uses no-residue wording', async () => {
  const report = createReport({ domain: 'evidence.example', matchMode: 'registrable_domain' }, 'evidence.example');
  report.hostPermissionsGranted = true;
  report.incognitoAccess = true;
  report.summary.verificationPassEnabled = true;
  report.summary.verificationStatus = 'incomplete';
  report.summary.verificationAllRequiredChecksSucceeded = false;
  report.summary.verificationCategories = {
    cookies: verificationFailure(new Error('cookie query failed')),
    tabs: verificationFromCount(0),
    history: verificationFromCount(0),
    downloads: verificationFromCount(0)
  };
  await finishReport(report);

  assert.ok(report.summary.cleanupConfidenceScore <= 65);
  assert.notEqual(report.summary.cleanupConfidenceLabel, 'High');
  assert.equal(report.summary.verificationRemainingTotal, null);
  assert.equal(
    report.summary.cleanupConfidenceReasons.some((reason) => /found no exposed/i.test(reason)),
    false
  );
  assert.equal(
    report.summary.cleanupConfidenceReasons.some((reason) => /incomplete/i.test(reason)),
    true
  );
});

test('high confidence is available only after all required checks return verified zero', async () => {
  const report = createReport({ domain: 'evidence.example', matchMode: 'registrable_domain' }, 'evidence.example');
  report.hostPermissionsGranted = true;
  report.incognitoAccess = true;
  report.summary.verificationPassEnabled = true;
  report.summary.verificationStatus = 'verified_zero';
  report.summary.verificationAllRequiredChecksSucceeded = true;
  report.summary.verificationNoExposedResidueFound = true;
  report.summary.verificationCategories = Object.fromEntries(REQUIRED.map((name) => [name, verificationFromCount(0)]));
  report.summary.verificationCookiesRemaining = 0;
  report.summary.verificationTabsRemaining = 0;
  report.summary.verificationHistoryRemaining = 0;
  report.summary.verificationDownloadsRemaining = 0;
  await finishReport(report);

  assert.equal(report.summary.cleanupConfidenceScore, 100);
  assert.equal(report.summary.cleanupConfidenceLabel, 'High');
  assert.equal(report.summary.verificationRemainingTotal, 0);
  assert.equal(
    report.summary.cleanupConfidenceReasons.some((reason) => /all required/i.test(reason)),
    true
  );
});

test('runtime and origin failures prevent a High label even after zero-residue verification', async () => {
  for (const failure of ['runtime', 'origin']) {
    const report = createReport({ domain: 'evidence.example', matchMode: 'registrable_domain' }, 'evidence.example');
    report.hostPermissionsGranted = true;
    report.incognitoAccess = true;
    report.summary.verificationPassEnabled = true;
    report.summary.verificationStatus = 'verified_zero';
    report.summary.verificationAllRequiredChecksSucceeded = true;
    report.summary.verificationNoExposedResidueFound = true;
    report.summary.verificationCategories = Object.fromEntries(
      REQUIRED.map((name) => [name, verificationFromCount(0)])
    );
    report.summary.verificationCookiesRemaining = 0;
    report.summary.verificationTabsRemaining = 0;
    report.summary.verificationHistoryRemaining = 0;
    report.summary.verificationDownloadsRemaining = 0;
    if (failure === 'runtime') report.errors.push({ label: 'Synthetic failure', message: 'Synthetic failure' });
    else report.summary.originStorageTypesFailed = 1;

    await finishReport(report);

    assert.ok(report.summary.cleanupConfidenceScore <= 85);
    assert.notEqual(report.summary.cleanupConfidenceLabel, 'High');
  }
});

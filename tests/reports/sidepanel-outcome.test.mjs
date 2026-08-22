import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessReportVerification,
  formatKnownResidue,
  formatReportOutcome,
  formatVerificationStatus,
  getReportRuntimeErrorCount,
  getReportUnavailableCount,
  summarizeHistoryVerification
} from '../../src/sidepanel/report-outcome.js';

const zeroEvidence = () => ({ state: 'verified_zero', count: 0, reason: 'Completed with zero.' });

function verifiedZeroSummary() {
  return {
    verificationStatus: 'verified_zero',
    verificationAllRequiredChecksSucceeded: true,
    verificationNoExposedResidueFound: true,
    verificationCategories: {
      cookies: zeroEvidence(),
      tabs: zeroEvidence(),
      history: zeroEvidence(),
      downloads: zeroEvidence()
    },
    verificationCookiesRemaining: 0,
    verificationTabsRemaining: 0,
    verificationHistoryRemaining: 0,
    verificationDownloadsRemaining: 0,
    verificationRemainingTotal: 0
  };
}

function residueWithFailedCheckSummary() {
  return {
    verificationStatus: 'residue_found',
    verificationAllRequiredChecksSucceeded: false,
    verificationNoExposedResidueFound: false,
    verificationCategories: {
      cookies: { state: 'residue_found', count: 3, reason: 'Three cookies remain.' },
      tabs: zeroEvidence(),
      history: { state: 'failed', count: null, reason: 'History query failed.' },
      downloads: zeroEvidence()
    },
    verificationCookiesRemaining: 3,
    verificationTabsRemaining: 0,
    verificationHistoryRemaining: null,
    verificationDownloadsRemaining: 0,
    verificationRemainingTotal: null
  };
}

function incompleteZeroSummary() {
  return {
    verificationStatus: 'incomplete',
    verificationAllRequiredChecksSucceeded: false,
    verificationNoExposedResidueFound: false,
    verificationCategories: {
      cookies: zeroEvidence(),
      tabs: zeroEvidence(),
      history: { state: 'timed_out', count: null, reason: 'History query timed out.' },
      downloads: zeroEvidence()
    },
    verificationCookiesRemaining: 0,
    verificationTabsRemaining: 0,
    verificationHistoryRemaining: null,
    verificationDownloadsRemaining: 0,
    verificationRemainingTotal: null
  };
}

test('known residue plus a failed required check remains residue with an unknown full total', () => {
  const summary = residueWithFailedCheckSummary();
  const assessment = assessReportVerification(summary);

  assert.equal(assessment.kind, 'residue_incomplete');
  assert.equal(assessment.allRequiredChecksSucceeded, false);
  assert.equal(assessment.knownResidueCount, 3);
  assert.equal(assessment.reportedTotal, null);
  assert.deepEqual(assessment.incompleteChecks, [{ name: 'history', state: 'failed' }]);
  assert.equal(formatVerificationStatus(summary), 'Residue found — history check failed');
  assert.equal(formatKnownResidue(summary), 'At least 3 — full total unknown');

  const outcome = formatReportOutcome({ status: 'completed', summary, errors: [], unavailable: [] });
  assert.equal(outcome.tone, 'danger');
  assert.equal(outcome.badge, 'Residue + unknowns');
  assert.match(outcome.title, /Residue found; verification incomplete/);
  assert.match(outcome.copy, /at least 3 remaining items/);
  assert.match(outcome.copy, /history check failed/);
  assert.match(outcome.copy, /full four-surface residue total is unknown/);
});

test('zero from completed checks stays incomplete when one required check timed out', () => {
  const summary = incompleteZeroSummary();
  const assessment = assessReportVerification(summary);

  assert.equal(assessment.kind, 'incomplete');
  assert.equal(assessment.allRequiredChecksSucceeded, false);
  assert.equal(assessment.knownResidueCount, 0);
  assert.equal(assessment.reportedTotal, null);
  assert.equal(formatVerificationStatus(summary), 'Incomplete — history check timed out');
  assert.equal(formatKnownResidue(summary), 'No known residue in completed checks — full total unknown');

  const outcome = formatReportOutcome({ status: 'completed', summary, errors: [], unavailable: [] });
  assert.equal(outcome.tone, 'warning');
  assert.equal(outcome.badge, 'Verification incomplete');
  assert.doesNotMatch(outcome.title, /complete$/i);
  assert.match(outcome.copy, /full four-surface total remains unknown/);
});

test('green verified-zero outcome requires completed runtime and all four completed checks', () => {
  const summary = verifiedZeroSummary();
  const assessment = assessReportVerification(summary);
  const outcome = formatReportOutcome({
    status: 'completed',
    summary,
    errors: [],
    unavailable: [{ label: 'Hidden browser surface' }]
  });

  assert.equal(assessment.kind, 'verified_zero');
  assert.equal(assessment.allRequiredChecksSucceeded, true);
  assert.equal(formatKnownResidue(summary), '0 — all four checks complete');
  assert.equal(outcome.tone, 'success');
  assert.equal(outcome.badge, 'Verified zero');
  assert.match(outcome.title, /four checks verified zero/);
  assert.match(outcome.copy, /outside this verification claim/);
});

test('runtime errors override a completed status and verified-zero evidence', () => {
  const outcome = formatReportOutcome({
    status: 'completed',
    summary: verifiedZeroSummary(),
    errors: [{ label: 'Runtime failure' }],
    unavailable: []
  });

  assert.equal(outcome.tone, 'danger');
  assert.equal(outcome.badge, 'Runtime errors');
  assert.equal(outcome.title, 'Cleanup finished with runtime errors');
  assert.match(outcome.copy, /1 runtime error was recorded/);
  assert.match(outcome.copy, /Verified zero — all four checks completed/);
});

test('internally inconsistent terminal claims do not become complete verification', () => {
  const summary = verifiedZeroSummary();
  summary.verificationStatus = 'incomplete';
  assert.equal(assessReportVerification(summary).allRequiredChecksSucceeded, false);

  summary.verificationStatus = 'residue_found';
  assert.equal(assessReportVerification(summary).kind, 'residue_incomplete');
  assert.equal(formatKnownResidue(summary), 'Found — count and full total unknown');
});

test('explicit residue evidence with zero or null count overrides an overall verified-zero claim', () => {
  for (const count of [0, null]) {
    const summary = verifiedZeroSummary();
    summary.verificationCategories.cookies = {
      state: 'residue_found',
      count,
      reason: 'Contradictory synthetic residue evidence.'
    };
    summary.verificationCookiesRemaining = count;

    const assessment = assessReportVerification(summary);
    const outcome = formatReportOutcome({ status: 'completed', summary, errors: [], unavailable: [] });

    assert.equal(assessment.kind, 'residue_incomplete');
    assert.equal(assessment.allRequiredChecksSucceeded, false);
    assert.equal(assessment.reportedTotal, 0);
    assert.deepEqual(assessment.incompleteChecks, [{ name: 'cookies', state: 'invalid_residue_count' }]);
    assert.equal(
      formatVerificationStatus(summary),
      'Residue found — cookies check reported residue without a valid positive count'
    );
    assert.equal(formatKnownResidue(summary), 'Found — count and full total unknown');
    assert.equal(outcome.tone, 'danger');
    assert.notEqual(outcome.badge, 'Verified zero');
  }
});

test('verified-zero category counts must agree with the matching summary surface counts', () => {
  const summary = verifiedZeroSummary();
  summary.verificationTabsRemaining = 1;

  const assessment = assessReportVerification(summary);
  assert.equal(assessment.kind, 'residue_incomplete');
  assert.equal(assessment.allRequiredChecksSucceeded, false);
  assert.deepEqual(assessment.incompleteChecks, [{ name: 'tabs', state: 'summary_mismatch' }]);
  assert.equal(formatVerificationStatus(summary), 'Residue found — tabs check does not agree with the report summary');
  assert.notEqual(formatReportOutcome({ status: 'completed', summary, errors: [] }).tone, 'success');
});

test('summary runtime errors and unavailable limits cannot be suppressed by shorter detail arrays', () => {
  const report = {
    status: 'completed',
    summary: { ...verifiedZeroSummary(), errors: 1, unavailable: 3 },
    errors: [],
    unavailable: [{ label: 'Only retained limit detail' }]
  };

  assert.equal(getReportRuntimeErrorCount(report), 1);
  assert.equal(getReportUnavailableCount(report), 3);
  const outcome = formatReportOutcome(report);
  assert.equal(outcome.tone, 'danger');
  assert.equal(outcome.badge, 'Runtime errors');
  assert.match(outcome.copy, /1 runtime error was recorded/);
});

test('history aggregation never counts incomplete residue as a complete verification or null as zero', () => {
  const reports = [
    { summary: residueWithFailedCheckSummary() },
    { summary: verifiedZeroSummary() },
    { summary: incompleteZeroSummary() }
  ];
  const history = summarizeHistoryVerification(reports);

  assert.deepEqual(
    {
      complete: history.complete,
      verifiedZero: history.verifiedZero,
      completeResidue: history.completeResidue,
      incomplete: history.incomplete,
      incompleteWithResidue: history.incompleteWithResidue,
      knownResidue: history.knownResidue
    },
    {
      complete: 1,
      verifiedZero: 1,
      completeResidue: 0,
      incomplete: 2,
      incompleteWithResidue: 1,
      knownResidue: 3
    }
  );
  assert.match(history.text, /^1 of 3 reports completed all four exposed checks/);
  assert.match(history.text, /At least 3 known residue items were recorded/);
  assert.match(history.text, /2 reports have incomplete or unknown verification/);
  assert.match(history.text, /full residue totals remain unknown/);
  assert.doesNotMatch(history.text, /3 complete four-surface/);
});

test('history aggregation separates uncounted residue evidence from numeric known residue', () => {
  const contradictoryResidue = (count) => {
    const summary = verifiedZeroSummary();
    summary.verificationCategories.cookies = {
      state: 'residue_found',
      count,
      reason: 'Residue was reported without a valid count.'
    };
    summary.verificationCookiesRemaining = count;
    return { summary };
  };
  const history = summarizeHistoryVerification([
    contradictoryResidue(null),
    contradictoryResidue(0),
    { summary: verifiedZeroSummary() }
  ]);

  assert.equal(history.complete, 1);
  assert.equal(history.verifiedZero, 1);
  assert.equal(history.incomplete, 2);
  assert.equal(history.incompleteWithResidue, 2);
  assert.equal(history.knownResidue, 0);
  assert.match(history.text, /Residue was reported without a valid count in 2 incomplete reports\./);
  assert.match(history.text, /including 2 with residue evidence/);
  assert.doesNotMatch(history.text, /with known residue/);
  assert.doesNotMatch(history.text, /0 known residue/);
});

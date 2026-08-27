import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describeLocalStateResetResponse,
  describeSettingsResetResponse
} from '../../src/shared/maintenance-results.js';

function resetResult(overrides = {}) {
  return {
    reset: {
      status: 'complete',
      localStateResetComplete: true,
      dataCleared: true,
      recoveryObligationsRetained: false,
      optionalFramePermission: { verifiedAbsent: true },
      resetFailures: [],
      recoveryFailures: [],
      note: 'Synthetic complete reset.',
      ...overrides
    }
  };
}

test('local-state reset presentation distinguishes complete, partial, failed, and inconsistent results', () => {
  assert.deepEqual(describeLocalStateResetResponse(resetResult()), {
    status: 'complete',
    tone: 'success',
    message: 'Synthetic complete reset.'
  });
  assert.deepEqual(
    describeLocalStateResetResponse(
      resetResult({
        status: 'partial',
        localStateResetComplete: false,
        recoveryObligationsRetained: true,
        optionalFramePermission: { verifiedAbsent: false },
        note: 'Synthetic recovery retained.'
      })
    ),
    { status: 'partial', tone: 'warning', message: 'Synthetic recovery retained.' }
  );
  assert.deepEqual(
    describeLocalStateResetResponse(
      resetResult({
        status: 'partial',
        localStateResetComplete: false,
        recoveryObligationsRetained: true,
        recoveryFailures: [{ step: 'request-shield recovery', message: 'synthetic uncertainty' }],
        note: 'Synthetic recovery could not be completed.'
      })
    ),
    { status: 'partial', tone: 'warning', message: 'Synthetic recovery could not be completed.' }
  );
  assert.deepEqual(
    describeLocalStateResetResponse(
      resetResult({
        status: 'failed',
        localStateResetComplete: false,
        dataCleared: false,
        recoveryObligationsRetained: true,
        resetFailures: [{ step: 'reports', message: 'synthetic failure' }],
        note: 'Synthetic reset failed.'
      })
    ),
    { status: 'failed', tone: 'error', message: 'Synthetic reset failed.' }
  );
  assert.deepEqual(describeLocalStateResetResponse(resetResult({ recoveryObligationsRetained: true })), {
    status: 'failed',
    tone: 'error',
    message: 'SiteWipe returned an inconsistent local-state reset result. Treat the reset as incomplete.'
  });
  assert.equal(describeLocalStateResetResponse({}).tone, 'error');
});

test('settings reset reports optional permission absence separately from settings persistence', () => {
  assert.deepEqual(describeSettingsResetResponse({ optionalFramePermission: { verifiedAbsent: true } }), {
    status: 'complete',
    tone: 'success',
    message: 'Settings reset. Optional webNavigation access is absent.'
  });
  const partial = describeSettingsResetResponse({ optionalFramePermission: { verifiedAbsent: false } });
  assert.equal(partial.status, 'partial');
  assert.equal(partial.tone, 'warning');
  assert.match(partial.message, /did not prove optional webNavigation access absent/);
});

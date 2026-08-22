import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSidePanelReportBinding,
  getSidePanelReportBindingStorageKey,
  normalizeSidePanelReportBinding
} from '../../src/shared/side-panel-report-binding.js';

const NOW = Date.parse('2026-08-21T12:00:00.000Z');

test('side-panel report bindings are exact, window-scoped, and bounded', () => {
  const binding = createSidePanelReportBinding('report-exact', 7, NOW);

  assert.equal(getSidePanelReportBindingStorageKey(7), 'sitewipe.sidePanelReportBinding.v1.7');
  assert.deepEqual(binding, {
    schemaVersion: 1,
    reportId: 'report-exact',
    windowId: 7,
    createdAt: '2026-08-21T12:00:00.000Z',
    expiresAt: '2026-08-21T12:05:00.000Z'
  });
  assert.deepEqual(normalizeSidePanelReportBinding(binding, 7, NOW + 299_999), binding);
  assert.equal(normalizeSidePanelReportBinding(binding, 8, NOW), null, 'another window must not inherit the binding');
  assert.equal(
    normalizeSidePanelReportBinding(binding, 7, NOW + 300_000),
    null,
    'the binding must stop authorizing the report at its exact expiry'
  );
});

test('malformed, extended, backdated, and oversized side-panel bindings fail closed', () => {
  const valid = createSidePanelReportBinding('report-exact', 7, NOW);
  for (const value of [
    null,
    [],
    { ...valid, schemaVersion: 2 },
    { ...valid, reportId: '' },
    { ...valid, reportId: 'x'.repeat(257) },
    { ...valid, windowId: -1 },
    { ...valid, createdAt: 'not-a-date' },
    { ...valid, expiresAt: 'not-a-date' },
    { ...valid, expiresAt: '2026-08-21T12:05:00.001Z' }
  ]) {
    assert.equal(normalizeSidePanelReportBinding(value, 7, NOW), null);
  }

  assert.throws(() => createSidePanelReportBinding('', 7, NOW), /stored report/i);
  assert.throws(() => createSidePanelReportBinding('report-exact', -1, NOW), /browser window/i);
  assert.throws(() => getSidePanelReportBindingStorageKey(-1), /browser window/i);
});

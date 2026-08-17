import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OperationBudgetExceededError,
  OperationTimeoutError,
  chunk,
  createOperationBudget,
  mapWithConcurrency,
  throwIfCancellationRequested,
  withTimeoutReject,
  withTimeoutValue
} from '../../src/background/operation-control.js';

test('timeouts distinguish a still-running browser operation from an ordinary rejection', async () => {
  await assert.rejects(
    withTimeoutReject(new Promise(() => {}), 1, 'browser mutation'),
    (error) =>
      error instanceof OperationTimeoutError &&
      error.name === 'OperationTimeoutError' &&
      error.operationMayContinue === true &&
      error.timeoutMs === 1
  );
  await assert.rejects(withTimeoutReject(Promise.reject(new Error('rejected')), 50), /rejected/);
  assert.equal(await withTimeoutValue(new Promise(() => {}), 1, 'unknown'), 'unknown');
});

test('operation budgets stop new work at query, record, and duration ceilings', () => {
  let now = 1_000;
  const queryBudget = createOperationBudget({ maxDurationMs: 10_000, maxQueries: 2, maxRecords: 10, now: () => now });
  const { claimQuery } = queryBudget;
  claimQuery('query one');
  claimQuery('query two');
  assert.throws(() => claimQuery('query three'), OperationBudgetExceededError);
  assert.equal(queryBudget.snapshot().exhaustedReason, 'query three (query limit)');

  const recordBudget = createOperationBudget({ maxDurationMs: 10_000, maxQueries: 10, maxRecords: 2, now: () => now });
  assert.throws(() => recordBudget.observeRecords(3, 'oversized results'), OperationBudgetExceededError);
  assert.equal(recordBudget.snapshot().recordsObserved, 3);

  const durationBudget = createOperationBudget({
    maxDurationMs: 1_000,
    maxQueries: 10,
    maxRecords: 10,
    now: () => now
  });
  now = 2_000;
  assert.throws(() => durationBudget.check('late work'), OperationBudgetExceededError);
  assert.equal(durationBudget.snapshot().remainingMs, 0);
});

test('cooperative cancellation stops before the next scheduled operation and propagates check failures', async () => {
  await assert.rejects(
    throwIfCancellationRequested(async () => true, 'test mutation'),
    (error) => error?.name === 'AbortError' && /before test mutation/.test(error.message)
  );
  await assert.rejects(
    throwIfCancellationRequested(async () => {
      throw new Error('storage unavailable');
    }),
    /storage unavailable/
  );
});

test('bounded concurrency retains input order and never exceeds its worker limit', async () => {
  let active = 0;
  let peak = 0;
  const output = await mapWithConcurrency([4, 3, 2, 1], 2, async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, value));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(output, [8, 6, 4, 2]);
  assert.ok(peak <= 2);
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

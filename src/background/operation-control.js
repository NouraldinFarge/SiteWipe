export const OPERATION_TIMEOUT = Symbol('sitewipe-operation-timeout');

export class OperationTimeoutError extends Error {
  constructor(label, timeoutMs) {
    const ms = Math.max(1, Number(timeoutMs) || 1);
    super(
      `${label} timed out after ${ms}ms. The browser may still finish the underlying call; its final result is unknown and is not retried automatically.`
    );
    this.name = 'OperationTimeoutError';
    this.operationMayContinue = true;
    this.timeoutMs = ms;
  }
}

export class OperationBudgetExceededError extends Error {
  constructor(label, snapshot) {
    super(`The cleanup operation budget was exhausted before ${label}. No additional browser work was scheduled.`);
    this.name = 'OperationBudgetExceededError';
    this.snapshot = snapshot;
  }
}

export function createOperationBudget({
  label = 'cleanup',
  maxDurationMs = 210_000,
  maxQueries = 1_000,
  maxRecords = 250_000,
  now = () => Date.now()
} = {}) {
  const startedAtMs = Number(now());
  const safeStartedAtMs = Number.isFinite(startedAtMs) ? startedAtMs : Date.now();
  const state = {
    label: String(label),
    startedAtMs: safeStartedAtMs,
    deadlineAtMs: safeStartedAtMs + Math.max(1_000, Number(maxDurationMs) || 210_000),
    maxQueries: Math.max(1, Number(maxQueries) || 1_000),
    maxRecords: Math.max(1, Number(maxRecords) || 250_000),
    queriesUsed: 0,
    recordsObserved: 0,
    exhausted: false,
    exhaustedAt: null,
    exhaustedReason: null
  };

  function snapshot() {
    const nowMs = Number(now());
    const currentMs = Number.isFinite(nowMs) ? nowMs : Date.now();
    return {
      label: state.label,
      startedAt: new Date(state.startedAtMs).toISOString(),
      deadlineAt: new Date(state.deadlineAtMs).toISOString(),
      elapsedMs: Math.max(0, currentMs - state.startedAtMs),
      remainingMs: Math.max(0, state.deadlineAtMs - currentMs),
      maxQueries: state.maxQueries,
      queriesUsed: state.queriesUsed,
      maxRecords: state.maxRecords,
      recordsObserved: state.recordsObserved,
      exhausted: state.exhausted,
      exhaustedAt: state.exhaustedAt,
      exhaustedReason: state.exhaustedReason
    };
  }

  function fail(reason) {
    if (!state.exhausted) {
      const failedAtMs = Number(now());
      state.exhausted = true;
      state.exhaustedAt = new Date(Number.isFinite(failedAtMs) ? failedAtMs : Date.now()).toISOString();
      state.exhaustedReason = reason;
    }
    throw new OperationBudgetExceededError(reason, snapshot());
  }

  function checkBudget(labelValue = 'the next operation') {
    const nowMs = Number(now());
    if (!Number.isFinite(nowMs) || nowMs >= state.deadlineAtMs) fail(String(labelValue));
    if (state.queriesUsed >= state.maxQueries) fail(`${labelValue} (query limit)`);
    if (state.recordsObserved >= state.maxRecords) fail(`${labelValue} (record limit)`);
    return snapshot();
  }

  return Object.freeze({
    check: checkBudget,
    claimQuery(labelValue = 'the next browser query') {
      checkBudget(labelValue);
      state.queriesUsed += 1;
      if (state.queriesUsed > state.maxQueries) fail(`${labelValue} (query limit)`);
      return snapshot();
    },
    observeRecords(count, labelValue = 'browser query results') {
      const amount = Math.max(0, Number(count) || 0);
      state.recordsObserved += amount;
      if (state.recordsObserved > state.maxRecords) fail(`${labelValue} (record limit)`);
      return snapshot();
    },
    snapshot
  });
}

export async function withTimeoutValue(promise, timeoutMs, timeoutValue) {
  const ms = Math.max(1, Number(timeoutMs) || 1);
  let timerId = null;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timerId = setTimeout(() => resolve(timeoutValue), ms);
      })
    ]);
  } finally {
    if (timerId !== null) clearTimeout(timerId);
  }
}

export async function withTimeoutReject(promise, timeoutMs, label = 'operation') {
  const result = await withTimeoutValue(promise, timeoutMs, OPERATION_TIMEOUT);
  if (result === OPERATION_TIMEOUT) throw new OperationTimeoutError(label, timeoutMs);
  return result;
}

export function readableMessage(error) {
  if (!error) return 'Unknown error';
  if (error.message) return error.message;
  return String(error);
}

export async function throwIfCancellationRequested(shouldCancel, phase = 'the next operation') {
  if (typeof shouldCancel !== 'function') return;
  if (await shouldCancel()) {
    const error = new Error(`SiteWipe cleanup canceled before ${phase}.`);
    error.name = 'AbortError';
    throw error;
  }
}

export function sampleArray(values, limit = 50) {
  return Array.isArray(values) ? values.slice(0, limit) : [];
}

export async function mapWithConcurrency(values, limit, mapper) {
  const list = Array.isArray(values) ? values : [];
  const size = Math.max(1, Number(limit) || 1);
  const output = new Array(list.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < list.length) {
      const index = nextIndex;
      nextIndex += 1;
      output[index] = await mapper(list[index], index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(size, list.length) }, () => worker()));
  return output;
}

export async function yieldEvery(index, every = 10) {
  if (!Number.isFinite(index) || index <= 0 || index % every !== 0) return;
  await sleep(0);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

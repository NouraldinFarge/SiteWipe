import { assertSafeOriginScopedRemoval } from '../shared/safety.js';
import { addError, addSection, addUnavailable, createAdapterOutcome } from './report.js';
import {
  chunk,
  OPERATION_TIMEOUT,
  readableMessage,
  sampleArray,
  throwIfCancellationRequested,
  withTimeoutReject,
  withTimeoutValue,
  yieldEvery
} from './operation-control.js';

const BROWSING_DATA_BATCH_SIZE = 150;
const BROWSING_DATA_REMOVE_TIMEOUT_MS = 60_000;
const COOKIE_SWEEP_BATCH_TIMEOUT_MS = 15_000;
const REPORT_SAMPLE_LIMIT = 50;

export async function removeOriginScopedStorage(target, report, context, options = {}) {
  const origins = Array.isArray(context?.origins) && context.origins.length ? context.origins : target.baseOrigins;
  const includeProtectedWebOrigins = options.includeProtectedWebOrigins === true;
  const originBatches = chunk(origins, BROWSING_DATA_BATCH_SIZE);
  const originTypePlans = [
    {
      key: 'unprotectedWeb',
      label: 'regular web origins',
      originTypes: { unprotectedWeb: true }
    }
  ];
  if (includeProtectedWebOrigins) {
    originTypePlans.push({
      key: 'protectedWeb',
      label: 'installed/protected web origins',
      originTypes: { protectedWeb: true }
    });
  }

  const cleanupTypes = {
    cache: true,
    cacheStorage: true,
    fileSystems: true,
    indexedDB: true,
    localStorage: true,
    serviceWorkers: true,
    webSQL: true
  };
  const cleanupTypeLabels = Object.keys(cleanupTypes);
  const results = [];

  report.summary.storageCleanupAttempted = true;
  report.summary.cacheCleanupAttempted = true;
  report.summary.protectedWebCleanupAttempted = includeProtectedWebOrigins;

  for (const originTypePlan of originTypePlans) {
    let completedBatches = 0;
    const failures = [];
    const recoveredCombinedFailures = [];
    for (let batchIndex = 0; batchIndex < originBatches.length; batchIndex += 1) {
      await yieldEvery(batchIndex, 1);
      await throwIfCancellationRequested(options.shouldCancel, `origin-storage batch ${batchIndex + 1}`);
      options.operationBudget?.check(`origin-storage batch ${batchIndex + 1}`);
      const batch = originBatches[batchIndex];
      try {
        await withTimeoutReject(
          removeAllowedOriginScopedData(
            { origins: batch, originTypes: originTypePlan.originTypes },
            cleanupTypes,
            target
          ),
          BROWSING_DATA_REMOVE_TIMEOUT_MS,
          `browsingData.remove combined ${originTypePlan.label}`
        );
        completedBatches += 1;
      } catch (error) {
        const message = readableMessage(error);
        if (error?.name === 'OperationTimeoutError') {
          failures.push({
            batchIndex,
            combinedError: message,
            fallbackFailures: [],
            outcomeUnknown: true
          });
          addError(report, `Origin storage cleanup timed out (${originTypePlan.label})`, error);
          // Chrome does not expose cancellation for this API. Do not start
          // overlapping fallback mutations when the first outcome is unknown.
          continue;
        }

        const fallbackFailures = [];
        for (const key of cleanupTypeLabels) {
          await throwIfCancellationRequested(options.shouldCancel, `origin-storage fallback ${key}`);
          options.operationBudget?.check(`origin-storage fallback ${key}`);
          try {
            await withTimeoutReject(
              removeAllowedOriginScopedData(
                { origins: batch, originTypes: originTypePlan.originTypes },
                { [key]: true },
                target
              ),
              BROWSING_DATA_REMOVE_TIMEOUT_MS,
              `browsingData.remove ${key} ${originTypePlan.label}`
            );
          } catch (fallbackError) {
            fallbackFailures.push({
              batchIndex,
              key,
              message: readableMessage(fallbackError)
            });
          }
        }
        if (fallbackFailures.length) {
          failures.push({
            batchIndex,
            combinedError: message,
            fallbackFailures
          });
          addError(
            report,
            `Origin storage cleanup fallback (${originTypePlan.label})`,
            new Error(`${fallbackFailures.length} storage bucket(s) failed after the combined call failed: ${message}`)
          );
        } else {
          completedBatches += 1;
          recoveredCombinedFailures.push({ batchIndex, message });
        }
      }
    }
    results.push({
      originType: originTypePlan.key,
      originTypeLabel: originTypePlan.label,
      ok: failures.length === 0,
      completedBatches,
      recoveredCombinedFailures: recoveredCombinedFailures.slice(0, 20),
      failures: failures.slice(0, 20),
      outcome: createAdapterOutcome({
        attempted: originBatches.length,
        succeeded: completedBatches,
        failed: failures.filter((item) => !item.outcomeUnknown).length,
        timedOut: failures.filter((item) => item.outcomeUnknown).length,
        unknown: failures.filter((item) => item.outcomeUnknown).length
      })
    });
  }

  const failed = results.filter((item) => !item.ok);
  report.summary.serviceWorkersCleared = results.some((item) => item.completedBatches > 0);
  report.summary.originStorageTypesSucceeded = results.filter((item) => item.ok).length;
  report.summary.originStorageTypesFailed = failed.length;

  addSection(
    report,
    'originStorage',
    'Origin-scoped storage and cache removed',
    failed.length ? 'partial' : 'success',
    {
      originCount: origins.length,
      origins: sampleArray(origins),
      originsTruncated: origins.length > REPORT_SAMPLE_LIMIT,
      batches: originBatches.length,
      batchSize: BROWSING_DATA_BATCH_SIZE,
      cleanupTypes: cleanupTypeLabels,
      originTypePlans: originTypePlans.map((item) => item.key),
      protectedWebIncluded: includeProtectedWebOrigins,
      results,
      note: 'The engine prefers one combined browsingData.remove() call per origin batch. If a combined batch fails without timing out, it retries each allowed storage bucket independently so one unsupported bucket does not hide the others.'
    }
  );

  addUnavailable(
    report,
    'AppCache',
    'Chrome does not expose reliable origin-scoped AppCache cleanup in all versions; broad time-based deletion was skipped for safety.'
  );
}

export async function runOriginCookieSweep(target, origins, includeProtectedWebOrigins = false, options = {}) {
  if (!chrome.browsingData?.remove || !Array.isArray(origins) || !origins.length) {
    return {
      attempted: false,
      batches: 0,
      ok: false,
      skipped: 'browsingData origin cookie sweep unavailable.'
    };
  }
  const originTypePlans = [{ key: 'unprotectedWeb', originTypes: { unprotectedWeb: true } }];
  if (includeProtectedWebOrigins) {
    originTypePlans.push({
      key: 'protectedWeb',
      originTypes: { protectedWeb: true }
    });
  }
  let batches = 0;
  const failures = [];
  for (const plan of originTypePlans) {
    const planBatches = chunk(origins, BROWSING_DATA_BATCH_SIZE);
    for (let batchIndex = 0; batchIndex < planBatches.length; batchIndex += 1) {
      await yieldEvery(batchIndex, 1);
      await throwIfCancellationRequested(options.shouldCancel, `cookie-sweep batch ${batchIndex + 1}`);
      options.operationBudget?.check(`cookie-sweep batch ${batchIndex + 1}`);
      const batch = planBatches[batchIndex];
      try {
        const result = await withTimeoutValue(
          removeAllowedOriginScopedData({ origins: batch, originTypes: plan.originTypes }, { cookies: true }, target),
          COOKIE_SWEEP_BATCH_TIMEOUT_MS,
          OPERATION_TIMEOUT
        );
        if (result === OPERATION_TIMEOUT) {
          failures.push({
            originType: plan.key,
            batchIndex,
            error: `Cookie sweep timed out after ${COOKIE_SWEEP_BATCH_TIMEOUT_MS}ms`,
            outcomeUnknown: true
          });
          break;
        }
        batches += 1;
      } catch (error) {
        failures.push({ originType: plan.key, batchIndex, error: readableMessage(error) });
        break;
      }
    }
  }
  return {
    attempted: true,
    batches,
    ok: failures.length === 0,
    failures,
    originTypePlans: originTypePlans.map((item) => item.key)
  };
}

export function removeAllowedOriginScopedData(options, dataTypes, reviewedTarget) {
  if (!chrome.browsingData?.remove) throw new Error('chrome.browsingData.remove is unavailable.');
  if (!reviewedTarget)
    throw new Error('Safety guard requires the preflight-bound cleanup target at the mutation boundary.');
  const safeRemoval = assertSafeOriginScopedRemoval(options, dataTypes, reviewedTarget);
  return chrome.browsingData.remove(safeRemoval.options, safeRemoval.dataTypes);
}

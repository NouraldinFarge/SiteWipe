import { addError, addSection, addUnavailable, createAdapterOutcome } from './report.js';
import { discoverMatchingHistory } from './record-discovery.js';
import {
  mapWithConcurrency,
  OPERATION_TIMEOUT,
  throwIfCancellationRequested,
  withTimeoutValue,
  yieldEvery
} from './operation-control.js';

const HISTORY_DELETE_TIMEOUT_MS = 8000;
const HISTORY_DELETE_CONCURRENCY = 6;

export async function removeHistory(target, report, context, options = {}) {
  if (!chrome.history) {
    addUnavailable(report, 'Browsing history', 'chrome.history is unavailable.');
    return;
  }
  try {
    const matched = Array.isArray(context?.matchingHistory)
      ? context.matchingHistory
      : await discoverMatchingHistory(target, options);
    let failures = 0;
    let timeouts = 0;
    const deletionResults = await mapWithConcurrency(matched, HISTORY_DELETE_CONCURRENCY, async (item, index) => {
      await yieldEvery(index);
      await throwIfCancellationRequested(options.shouldCancel, 'the next history deletion batch');
      options.operationBudget?.check('the next history deletion');
      try {
        const result = await withTimeoutValue(
          chrome.history.deleteUrl({ url: item.url }),
          HISTORY_DELETE_TIMEOUT_MS,
          OPERATION_TIMEOUT
        );
        if (result === OPERATION_TIMEOUT) {
          timeouts += 1;
          return 0;
        }
        return 1;
      } catch (error) {
        failures += 1;
        addError(report, `History entry ${item.url}`, error);
        return 0;
      }
    });
    const removed = deletionResults.reduce((sum, value) => sum + value, 0);
    report.summary.historyEntriesRemoved = removed;
    report.summary.historyDeleteFailures = failures;
    report.summary.historyDeleteTimeouts = timeouts;
    addSection(report, 'history', 'Browsing history entries removed', failures || timeouts ? 'partial' : 'success', {
      removed,
      candidates: matched.length,
      failures,
      timeouts,
      outcome: createAdapterOutcome({
        attempted: matched.length,
        succeeded: removed,
        failed: failures,
        timedOut: timeouts,
        unknown: timeouts
      }),
      perCallTimeoutMs: HISTORY_DELETE_TIMEOUT_MS,
      note: timeouts
        ? 'Timed-out deletions remain unknown because Chrome may still complete the underlying call; SiteWipe does not count them as removed.'
        : 'Only exact target matches from bounded discovery were submitted for deletion.'
    });
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'OperationBudgetExceededError') throw error;
    addError(report, 'Browsing history', error);
  }
}

import { isReviewedFileRemovalCandidate } from '../shared/cleanup-review.js';
import { addError, addSection, addUnavailable, createAdapterOutcome } from './report.js';
import { discoverMatchingDownloads } from './record-discovery.js';
import {
  mapWithConcurrency,
  readableMessage,
  throwIfCancellationRequested,
  withTimeoutReject,
  yieldEvery
} from './operation-control.js';

const DOWNLOAD_API_TIMEOUT_MS = 15000;
const DOWNLOAD_CLEAN_CONCURRENCY = 4;

export async function eraseDownloadHistory(target, report, context, options = {}) {
  if (!chrome.downloads) {
    addUnavailable(report, 'Download history', 'chrome.downloads is unavailable.');
    return;
  }
  try {
    const matched = Array.isArray(context?.matchingDownloads)
      ? context.matchingDownloads
      : await discoverMatchingDownloads(target, options);
    let fileRemovalNotApproved = 0;
    const fileRemovalFailures = [];
    let recordEraseFailures = 0;
    let recordEraseTimeouts = 0;
    const deleteFiles = Boolean(options.deleteDownloadedFiles);
    const approvedDownloadFileIds = Array.isArray(options.approvedDownloadFileIds)
      ? options.approvedDownloadFileIds.map((id) => String(id))
      : [];

    const downloadResults = await mapWithConcurrency(matched, DOWNLOAD_CLEAN_CONCURRENCY, async (item, index) => {
      await yieldEvery(index);
      await throwIfCancellationRequested(options.shouldCancel, 'the next download cleanup batch');
      options.operationBudget?.check('the next download cleanup operation');
      let erasedCount = 0;
      let removedFile = 0;
      let preserveRecordForFileRecovery = false;
      if (deleteFiles) {
        if (!isReviewedFileRemovalCandidate(item, approvedDownloadFileIds)) {
          fileRemovalNotApproved += 1;
          preserveRecordForFileRecovery = true;
        } else {
          try {
            await withTimeoutReject(
              chrome.downloads.removeFile(item.id),
              DOWNLOAD_API_TIMEOUT_MS,
              'downloads.removeFile'
            );
            removedFile = 1;
          } catch (error) {
            preserveRecordForFileRecovery = true;
            fileRemovalFailures.push({
              id: item.id,
              filename: item.filename || '',
              message: readableMessage(error)
            });
          }
        }
      }
      if (!preserveRecordForFileRecovery) {
        try {
          options.operationBudget?.check('the next download-record erase');
          const result = await withTimeoutReject(
            chrome.downloads.erase({ id: item.id }),
            DOWNLOAD_API_TIMEOUT_MS,
            'downloads.erase'
          );
          erasedCount = result.length;
        } catch (error) {
          if (error?.name === 'OperationTimeoutError') recordEraseTimeouts += 1;
          else recordEraseFailures += 1;
          addError(report, `Download history ${item.id}`, error);
        }
      }
      return {
        erased: erasedCount,
        filesRemoved: removedFile,
        recordPreservedForRecovery: preserveRecordForFileRecovery ? 1 : 0
      };
    });
    const erased = downloadResults.reduce((sum, item) => sum + (item?.erased || 0), 0);
    const filesRemoved = downloadResults.reduce((sum, item) => sum + (item?.filesRemoved || 0), 0);
    const recordsPreservedForRecovery = downloadResults.reduce(
      (sum, item) => sum + (item?.recordPreservedForRecovery || 0),
      0
    );
    report.summary.downloadHistoryEntriesRemoved = erased;
    report.summary.downloadedFilesRemoved = filesRemoved;
    report.summary.downloadedFileRemovalFailures = fileRemovalFailures.length;
    report.summary.downloadedFileRemovalNotApproved = fileRemovalNotApproved;
    report.summary.downloadRecordEraseFailures = recordEraseFailures;
    report.summary.downloadRecordEraseTimeouts = recordEraseTimeouts;
    addSection(
      report,
      'downloads',
      deleteFiles ? 'Download files and history processed' : 'Download history entries erased',
      fileRemovalFailures.length || recordsPreservedForRecovery || recordEraseFailures || recordEraseTimeouts
        ? 'partial'
        : 'success',
      {
        erased,
        filesRemoved,
        approvedFileCandidates: approvedDownloadFileIds.length,
        fileRemovalNotApproved,
        fileRemovalFailures: fileRemovalFailures.slice(0, 25),
        recordsPreservedForRecovery,
        recordEraseFailures,
        recordEraseTimeouts,
        recordOutcome: createAdapterOutcome({
          attempted: matched.length - recordsPreservedForRecovery,
          succeeded: erased,
          failed: recordEraseFailures,
          timedOut: recordEraseTimeouts,
          unknown: recordEraseTimeouts,
          skipped: recordsPreservedForRecovery
        }),
        fileOutcome: createAdapterOutcome({
          attempted: deleteFiles ? matched.length : 0,
          succeeded: filesRemoved,
          failed: fileRemovalFailures.length,
          unknown: fileRemovalFailures.filter((item) => /timed out/i.test(item.message)).length,
          skipped: deleteFiles ? fileRemovalNotApproved : matched.length
        }),
        candidates: matched.length,
        deleteDownloadedFiles: deleteFiles,
        note: deleteFiles
          ? 'On-disk removal was attempted only for completed file IDs bound to the approved scope review. A download record is erased only after its approved file removal succeeds; records are preserved when removal is unapproved, fails, times out, or remains uncertain so the user retains recovery and retry context.'
          : 'Downloaded files were not deleted because optional destructive file cleanup is disabled.'
      }
    );
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'OperationBudgetExceededError') throw error;
    addError(report, 'Download history', error);
  }
}

import assert from 'node:assert/strict';
import test from 'node:test';

import { eraseDownloadHistory } from '../../src/background/downloads.js';
import { normalizeSiteInput } from '../../src/background/domain.js';
import { createReport } from '../../src/background/report.js';

function targetAndReport() {
  const normalized = normalizeSiteInput('example.com');
  assert.equal(normalized.ok, true);
  return {
    target: normalized.target,
    report: createReport(normalized.target, normalized.input)
  };
}

test('failed downloaded-file deletion preserves its browser record for recovery', async () => {
  const { target, report } = targetAndReport();
  const erased = [];
  globalThis.chrome = {
    downloads: {
      removeFile: async () => {
        throw new Error('file is locked');
      },
      erase: async ({ id }) => {
        erased.push(id);
        return [id];
      }
    }
  };
  const candidate = {
    id: 42,
    state: 'complete',
    exists: true,
    filename: 'C:\\Users\\Private\\Downloads\\example.txt',
    url: 'https://example.com/example.txt'
  };

  await eraseDownloadHistory(
    target,
    report,
    { matchingDownloads: [candidate] },
    { deleteDownloadedFiles: true, approvedDownloadFileIds: ['42'] }
  );

  assert.deepEqual(erased, []);
  assert.equal(report.summary.downloadedFilesRemoved, 0);
  assert.equal(report.summary.downloadedFileRemovalFailures, 1);
  const section = report.sections.find((item) => item.key === 'downloads');
  assert.equal(section.status, 'partial');
  assert.equal(section.details.recordsPreservedForRecovery, 1);
});

test('an approved file record is erased only after on-disk removal succeeds', async () => {
  const { target, report } = targetAndReport();
  const events = [];
  globalThis.chrome = {
    downloads: {
      removeFile: async (id) => events.push(`file:${id}`),
      erase: async ({ id }) => {
        events.push(`record:${id}`);
        return [id];
      }
    }
  };
  const candidate = {
    id: 7,
    state: 'complete',
    exists: true,
    filename: 'C:\\Users\\Private\\Downloads\\example.txt',
    url: 'https://example.com/example.txt'
  };

  await eraseDownloadHistory(
    target,
    report,
    { matchingDownloads: [candidate] },
    { deleteDownloadedFiles: true, approvedDownloadFileIds: ['7'] }
  );

  assert.deepEqual(events, ['file:7', 'record:7']);
  assert.equal(report.summary.downloadedFilesRemoved, 1);
  assert.equal(report.summary.downloadHistoryEntriesRemoved, 1);
  assert.equal(report.sections.find((item) => item.key === 'downloads').status, 'success');
});

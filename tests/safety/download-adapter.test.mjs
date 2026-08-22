import assert from 'node:assert/strict';
import test from 'node:test';

import { eraseDownloadHistory } from '../../src/background/downloads.js';
import { normalizeSiteInput } from '../../src/background/domain.js';
import { discoverMatchingDownloads } from '../../src/background/record-discovery.js';
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
      search: async ({ id }) => (id === candidate.id ? [candidate] : []),
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
      search: async ({ id }) => {
        events.push(`search:${id}`);
        return id === candidate.id ? [candidate] : [];
      },
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

  assert.deepEqual(events, ['search:7', 'file:7', 'search:7', 'record:7']);
  assert.equal(report.summary.downloadedFilesRemoved, 1);
  assert.equal(report.summary.downloadHistoryEntriesRemoved, 1);
  assert.equal(report.sections.find((item) => item.key === 'downloads').status, 'success');
});

test('downloaded-file deletion fails closed when the exact record disappears before removal', async () => {
  const { target, report } = targetAndReport();
  const mutations = [];
  globalThis.chrome = {
    downloads: {
      search: async () => [],
      removeFile: async (id) => mutations.push(`file:${id}`),
      erase: async ({ id }) => {
        mutations.push(`record:${id}`);
        return [id];
      }
    }
  };
  const candidate = {
    id: 8,
    state: 'complete',
    exists: true,
    filename: 'C:\\Users\\Private\\Downloads\\example.txt',
    url: 'https://example.com/example.txt'
  };

  await eraseDownloadHistory(
    target,
    report,
    { matchingDownloads: [candidate] },
    { deleteDownloadedFiles: true, approvedDownloadFileIds: ['8'] }
  );

  assert.deepEqual(mutations, []);
  assert.equal(report.summary.downloadedFilesRemoved, 0);
  assert.equal(report.summary.downloadHistoryEntriesRemoved, 0);
  const details = report.sections.find((item) => item.key === 'downloads').details;
  assert.equal(details.recordsPreservedForRecovery, 1);
  assert.match(details.fileRemovalFailures[0].message, /exact live browser record/i);
});

test('downloaded-file deletion fails closed when the live record changed or left the approved target', async () => {
  for (const current of [
    {
      id: 9,
      state: 'complete',
      exists: true,
      filename: 'C:\\Users\\Private\\Downloads\\other.txt',
      url: 'https://unrelated.example/other.txt'
    },
    {
      id: 9,
      state: 'interrupted',
      exists: true,
      filename: 'C:\\Users\\Private\\Downloads\\example.txt',
      url: 'https://example.com/example.txt'
    },
    {
      id: 9,
      state: 'complete',
      exists: true,
      filename: 'C:\\Users\\Private\\Downloads\\renamed.txt',
      url: 'https://example.com/example.txt'
    }
  ]) {
    const { target, report } = targetAndReport();
    const mutations = [];
    globalThis.chrome = {
      downloads: {
        search: async () => [current],
        removeFile: async (id) => mutations.push(`file:${id}`),
        erase: async ({ id }) => {
          mutations.push(`record:${id}`);
          return [id];
        }
      }
    };
    const discovered = {
      id: 9,
      state: 'complete',
      exists: true,
      filename: 'C:\\Users\\Private\\Downloads\\example.txt',
      url: 'https://example.com/example.txt'
    };

    await eraseDownloadHistory(
      target,
      report,
      { matchingDownloads: [discovered] },
      { deleteDownloadedFiles: true, approvedDownloadFileIds: ['9'] }
    );

    assert.deepEqual(mutations, []);
    assert.equal(report.summary.downloadedFilesRemoved, 0);
    assert.equal(report.summary.downloadHistoryEntriesRemoved, 0);
    assert.equal(report.sections.find((item) => item.key === 'downloads').details.recordsPreservedForRecovery, 1);
  }
});

test('downloaded-file deletion fails closed when live revalidation rejects or times out', async () => {
  for (const search of [
    async () => {
      throw new Error('download query unavailable');
    },
    () => new Promise(() => {})
  ]) {
    const { target, report } = targetAndReport();
    const mutations = [];
    globalThis.chrome = {
      downloads: {
        search,
        removeFile: async (id) => mutations.push(`file:${id}`),
        erase: async ({ id }) => {
          mutations.push(`record:${id}`);
          return [id];
        }
      }
    };
    const candidate = {
      id: 10,
      state: 'complete',
      exists: true,
      filename: 'C:\\Users\\Private\\Downloads\\example.txt',
      url: 'https://example.com/example.txt'
    };

    await eraseDownloadHistory(
      target,
      report,
      { matchingDownloads: [candidate] },
      { deleteDownloadedFiles: true, approvedDownloadFileIds: ['10'], downloadApiTimeoutMs: 1 }
    );

    assert.deepEqual(mutations, []);
    assert.equal(report.summary.downloadedFilesRemoved, 0);
    assert.equal(report.summary.downloadHistoryEntriesRemoved, 0);
    assert.equal(report.sections.find((item) => item.key === 'downloads').details.recordsPreservedForRecovery, 1);
  }
});

test('download discovery excludes private records unless private access was reviewed', async () => {
  const { target } = targetAndReport();
  globalThis.chrome = {
    downloads: {
      search: async () => [
        { id: 20, incognito: false, url: 'https://example.com/public.zip' },
        { id: 21, incognito: true, url: 'https://example.com/private.zip' }
      ]
    }
  };

  const publicOnly = await discoverMatchingDownloads(target, { incognitoAccess: false });
  const withPrivate = await discoverMatchingDownloads(target, { incognitoAccess: true });

  assert.deepEqual([...new Set(publicOnly.map((item) => item.id))], [20]);
  assert.deepEqual([...new Set(withPrivate.map((item) => item.id))].sort(), [20, 21]);
});

test('a download that becomes private after discovery is revalidated and never mutated', async () => {
  for (const deleteDownloadedFiles of [false, true]) {
    const { target, report } = targetAndReport();
    const mutations = [];
    const discovered = {
      id: 22,
      incognito: false,
      state: 'complete',
      exists: true,
      filename: 'C:\\Users\\Private\\Downloads\\example.txt',
      url: 'https://example.com/example.txt'
    };
    globalThis.chrome = {
      downloads: {
        search: async () => [{ ...discovered, incognito: true }],
        removeFile: async (id) => mutations.push(`file:${id}`),
        erase: async ({ id }) => {
          mutations.push(`record:${id}`);
          return [id];
        }
      }
    };

    await eraseDownloadHistory(
      target,
      report,
      { matchingDownloads: [discovered] },
      {
        deleteDownloadedFiles,
        approvedDownloadFileIds: ['22'],
        incognitoAccess: false
      }
    );

    assert.deepEqual(mutations, []);
    assert.equal(report.summary.downloadedFilesRemoved, 0);
    assert.equal(report.summary.downloadHistoryEntriesRemoved, 0);
  }
});

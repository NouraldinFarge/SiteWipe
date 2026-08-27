import assert from 'node:assert/strict';
import { link, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';

import { readZipEntries, readZipEntriesFromBuffer } from '../../scripts/zip-utils.mjs';

const UTF8_FLAG = 0x0800;
const UNIX_VERSION_MADE_BY = (3 << 8) | 30;
const REGULAR_0644_EXTERNAL_ATTRIBUTES = 0o100644 << 16;
const FIXED_TIMESTAMP_SECONDS = 315_532_800;

test('built-in ZIP reader preserves the release helper API and exposes strict in-memory metadata', async (context) => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'sitewipe-zip-utils-'));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const zipPath = resolve(temporary, 'fixture.zip');
  const archive = createZip([
    { path: 'folder/', bytes: Buffer.alloc(0), method: 0 },
    { path: 'folder/stored.txt', bytes: Buffer.from('stored fixture\n'), method: 0 },
    { path: 'unicode-π.txt', bytes: Buffer.from('deflated fixture\n'), method: 8 }
  ]);
  await writeFile(zipPath, archive);

  const fileEntries = await readZipEntries(zipPath);
  assert.deepEqual(
    fileEntries.map((entry) => entry.path),
    ['folder/stored.txt', 'unicode-π.txt']
  );
  assert.equal(fileEntries[0].bytes.toString('utf8'), 'stored fixture\n');
  assert.equal(fileEntries[1].bytes.toString('utf8'), 'deflated fixture\n');
  assert.equal(fileEntries[0].modifiedAt, '1980-01-01T00:00:00.000Z');
  assert.deepEqual(Object.keys(fileEntries[0]), ['path', 'bytes', 'compressedSize', 'uncompressedSize', 'modifiedAt']);

  const buffered = await readZipEntriesFromBuffer(archive, {
    includeDirectories: true,
    maxArchiveBytes: 1024 * 1024,
    maxEntryBytes: 1024,
    maxEntryCount: 10,
    maxExpandedBytes: 4096,
    strictFileNames: true
  });
  assert.equal(buffered.length, 3);
  assert.equal(buffered[0].isDirectory, true);
  assert.equal(buffered[1].versionMadeBy, UNIX_VERSION_MADE_BY);
  assert.equal(buffered[1].externalFileAttributes, REGULAR_0644_EXTERNAL_ATTRIBUTES >>> 0);
  assert.equal(buffered[1].generalPurposeBitFlag, UTF8_FLAG);
  assert.equal(buffered[1].localFileHeader.generalPurposeBitFlag, UTF8_FLAG);
  assert.equal(buffered[1].localFileHeader.crc32, buffered[1].crc32);
  assert.equal(buffered[1].fileNameRaw.toString('utf8'), 'folder/stored.txt');
});

test('file ZIP reader rejects multiply linked inputs and interprets DOS fallback timestamps in UTC', async (context) => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'sitewipe-zip-identity-'));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const zipPath = resolve(temporary, 'fixture.zip');
  const linkedPath = resolve(temporary, 'linked.zip');
  const archive = createZip([{ path: 'fixture.txt', bytes: Buffer.from('fixture'), extra: Buffer.alloc(0) }]);
  await writeFile(zipPath, archive);
  await link(zipPath, linkedPath);

  await assert.rejects(readZipEntries(linkedPath), /singly linked regular non-reparse file/i);
  await rm(linkedPath);
  const [entry] = await readZipEntries(zipPath);
  assert.equal(entry.modifiedAt, '1980-01-01T00:00:00.000Z');
});

test('in-memory ZIP reader owns its input before asynchronous decompression', async () => {
  const original = createZip([{ path: 'fixture.txt', bytes: Buffer.alloc(64 * 1024, 0x61), method: 8 }]);
  const expected = Buffer.from(original);
  const pending = readZipEntriesFromBuffer(original);
  original.fill(0);
  const entries = await pending;
  assert.equal(entries[0].bytes.length, 64 * 1024);
  assert.ok(entries[0].bytes.equals(Buffer.alloc(64 * 1024, 0x61)));
  assert.notDeepEqual(original, expected);
});

test('built-in ZIP reader validates a signed data descriptor before accepting its entry', async () => {
  const archive = createZip([
    { path: 'descriptor.txt', bytes: Buffer.from('descriptor fixture\n'), descriptor: true, method: 8 }
  ]);
  const [entry] = await readZipEntriesFromBuffer(archive);
  assert.equal(entry.bytes.toString('utf8'), 'descriptor fixture\n');
  assert.equal(entry.localFileHeader.crc32, 0);
  assert.notEqual(entry.crc32, 0);
});

test('built-in ZIP reader fails closed on malformed or ambiguous archive structures', async (subtest) => {
  const valid = createZip([{ path: 'fixture.txt', bytes: Buffer.from('fixture'), method: 0 }]);
  const cases = [
    {
      name: 'missing end-of-central-directory record',
      archive: valid.subarray(0, valid.length - 22),
      pattern: /end-of-central-directory/i
    },
    {
      name: 'central-directory bounds that do not meet the EOCD',
      archive: mutate(valid, (bytes) =>
        bytes.writeUInt32LE(bytes.readUInt32LE(bytes.length - 6) + 1, bytes.length - 6)
      ),
      pattern: /central-directory bounds/i
    },
    {
      name: 'ZIP64 sentinel without a supported bounded representation',
      archive: mutate(valid, (bytes) => bytes.writeUInt16LE(0xffff, bytes.length - 12)),
      pattern: /ZIP64/i
    },
    {
      name: 'encrypted entry flags',
      archive: createZip([{ path: 'fixture.txt', bytes: Buffer.from('fixture'), flags: UTF8_FLAG | 1 }]),
      pattern: /encryption|unsupported/i
    },
    {
      name: 'unsupported compression method',
      archive: createZip([{ path: 'fixture.txt', bytes: Buffer.from('fixture'), method: 12 }]),
      pattern: /compression method/i
    },
    {
      name: 'unsafe traversal path',
      archive: createZip([{ path: '../fixture.txt', bytes: Buffer.from('fixture') }]),
      pattern: /unsafe/i
    },
    {
      name: 'duplicate exact path',
      archive: createZip([
        { path: 'fixture.txt', bytes: Buffer.from('one') },
        { path: 'fixture.txt', bytes: Buffer.from('two') }
      ]),
      pattern: /duplicate/i
    },
    {
      name: 'local and central names that differ',
      archive: createZip([{ path: 'central.txt', localPath: 'local__.txt', bytes: Buffer.from('fixture') }]),
      pattern: /names disagree/i
    },
    {
      name: 'truncated extra-field payload',
      archive: createZip([{ path: 'fixture.txt', bytes: Buffer.from('fixture'), extra: Buffer.from([1]) }]),
      pattern: /extra-field header is truncated/i
    },
    {
      name: 'declared output smaller than the deflate stream',
      archive: createZip([
        {
          path: 'fixture.txt',
          bytes: Buffer.from('deflated fixture'),
          method: 8,
          declaredUncompressedSize: Buffer.byteLength('deflated fixture') - 1
        }
      ]),
      pattern: /deflate stream|output length/i
    },
    {
      name: 'CRC mismatch after otherwise valid expansion',
      archive: createZip([{ path: 'fixture.txt', bytes: Buffer.from('fixture'), declaredCrc32: 0x12345678 }]),
      pattern: /CRC-32/i
    },
    {
      name: 'strict backslash path',
      archive: createZip([{ path: 'folder\\fixture.txt', bytes: Buffer.from('fixture') }]),
      pattern: /backslash/i,
      options: { strictFileNames: true }
    }
  ];

  for (const fixture of cases) {
    await subtest.test(fixture.name, async () => {
      await assert.rejects(readZipEntriesFromBuffer(fixture.archive, fixture.options), fixture.pattern);
    });
  }
});

test('bounded ZIP reader refuses declarations beyond caller-selected entry and aggregate limits', async () => {
  const archive = createZip([
    { path: 'one.txt', bytes: Buffer.alloc(8, 1) },
    { path: 'two.txt', bytes: Buffer.alloc(8, 2) }
  ]);
  await assert.rejects(readZipEntriesFromBuffer(archive, { maxEntryBytes: 7, maxExpandedBytes: 32 }), /entry exceeds/i);
  await assert.rejects(readZipEntriesFromBuffer(archive, { maxEntryBytes: 8, maxExpandedBytes: 15 }), /expanded-size/i);
  await assert.rejects(readZipEntriesFromBuffer(archive, { maxEntryCount: 1 }), /entry-count/i);
});

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const definition of entries) {
    const bytes = Buffer.from(definition.bytes ?? Buffer.alloc(0));
    const path = Buffer.from(definition.path, 'utf8');
    const localPath = Buffer.from(definition.localPath ?? definition.path, 'utf8');
    if (localPath.length !== path.length) throw new Error('Synthetic local and central paths must have equal lengths.');
    const method = definition.method ?? 0;
    const flags = (definition.flags ?? UTF8_FLAG) | (definition.descriptor ? 0x0008 : 0);
    const compressed = method === 8 ? deflateRawSync(bytes) : Buffer.from(bytes);
    const declaredCrc32 = definition.declaredCrc32 ?? unsignedCrc32(bytes);
    const declaredUncompressedSize = definition.declaredUncompressedSize ?? bytes.length;
    const extra = definition.extra ?? timestampExtra();

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(definition.descriptor ? 0 : declaredCrc32, 14);
    local.writeUInt32LE(definition.descriptor ? 0 : compressed.length, 18);
    local.writeUInt32LE(definition.descriptor ? 0 : declaredUncompressedSize, 22);
    local.writeUInt16LE(localPath.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const descriptor = definition.descriptor
      ? createDataDescriptor(declaredCrc32, compressed.length, declaredUncompressedSize)
      : Buffer.alloc(0);
    localParts.push(local, localPath, extra, compressed, descriptor);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(UNIX_VERSION_MADE_BY, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(declaredCrc32, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(declaredUncompressedSize, 24);
    central.writeUInt16LE(path.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(REGULAR_0644_EXTERNAL_ATTRIBUTES >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, path, extra);
    localOffset += local.length + localPath.length + extra.length + compressed.length + descriptor.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function timestampExtra() {
  const extra = Buffer.alloc(9);
  extra.writeUInt16LE(0x5455, 0);
  extra.writeUInt16LE(5, 2);
  extra.writeUInt8(1, 4);
  extra.writeInt32LE(FIXED_TIMESTAMP_SECONDS, 5);
  return extra;
}

function createDataDescriptor(entryCrc32, compressedSize, uncompressedSize) {
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(entryCrc32, 4);
  descriptor.writeUInt32LE(compressedSize, 8);
  descriptor.writeUInt32LE(uncompressedSize, 12);
  return descriptor;
}

function unsignedCrc32(bytes) {
  return Number(crc32(bytes)) >>> 0;
}

function mutate(bytes, mutation) {
  const copy = Buffer.from(bytes);
  mutation(copy);
  return copy;
}

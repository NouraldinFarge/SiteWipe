import { lstat, open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { crc32, inflateRaw } from 'node:zlib';

const inflateRawAsync = promisify(inflateRaw);

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_FILE_HEADER_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const MINIMUM_END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const MAXIMUM_ZIP_COMMENT_BYTES = 0xffff;
const MAXIMUM_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAXIMUM_ENTRY_COUNT = 16_384;
const MAXIMUM_ENTRY_BYTES = 128 * 1024 * 1024;
const MAXIMUM_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAXIMUM_ENTRY_NAME_BYTES = 0xffff;
const ZIP64_UINT16_SENTINEL = 0xffff;
const ZIP64_UINT32_SENTINEL = 0xffffffff;
const GENERAL_PURPOSE_UTF8 = 0x0800;
const GENERAL_PURPOSE_DATA_DESCRIPTOR = 0x0008;
const GENERAL_PURPOSE_DEFLATE_OPTIONS = 0x0006;
const ALLOWED_GENERAL_PURPOSE_BITS =
  GENERAL_PURPOSE_UTF8 | GENERAL_PURPOSE_DATA_DESCRIPTOR | GENERAL_PURPOSE_DEFLATE_OPTIONS;
const COMPRESSION_STORED = 0;
const COMPRESSION_DEFLATE = 8;
const READ_OPTION_KEYS = Object.freeze([
  'includeDirectories',
  'maxArchiveBytes',
  'maxEntryBytes',
  'maxEntryCount',
  'maxExpandedBytes',
  'strictFileNames'
]);
const DEFAULT_READ_OPTIONS = Object.freeze({
  includeDirectories: false,
  maxArchiveBytes: MAXIMUM_ARCHIVE_BYTES,
  maxEntryBytes: MAXIMUM_ENTRY_BYTES,
  maxEntryCount: MAXIMUM_ENTRY_COUNT,
  maxExpandedBytes: MAXIMUM_EXPANDED_BYTES,
  strictFileNames: false
});
const CP437 =
  '\u0000☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼ !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~⌂ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

if (CP437.length !== 256) throw new Error('Internal CP437 decoding table is malformed.');

/**
 * Read a bounded, single-disk ZIP archive without evaluating any installed package.
 *
 * The returned shape intentionally matches the former yauzl-backed helper. SiteWipe
 * release archives are bounded well below ZIP64 thresholds; ZIP64 is refused instead
 * of accepting a partially understood representation.
 */
export async function readZipEntries(path) {
  const archive = await readBoundedArchive(path, DEFAULT_READ_OPTIONS.maxArchiveBytes);
  const entries = await readOwnedArchive(archive, DEFAULT_READ_OPTIONS);
  return entries.map(({ path: entryPath, bytes, compressedSize, uncompressedSize, modifiedAt }) => ({
    path: entryPath,
    bytes,
    compressedSize,
    uncompressedSize,
    modifiedAt
  }));
}

/**
 * Read an already captured archive with caller-selected, strictly bounded limits.
 * This is the dependency-free in-memory entry point used by installed-runtime
 * preflight. The input is copied before the first asynchronous decompression step.
 */
export async function readZipEntriesFromBuffer(value, options = {}) {
  const limits = validateReadOptions(options);
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new TypeError('ZIP buffer input must be a Buffer or Uint8Array.');
  }
  if (value.buffer instanceof SharedArrayBuffer) {
    throw new Error('ZIP buffer input cannot use shared mutable storage.');
  }
  if (value.byteLength < MINIMUM_END_OF_CENTRAL_DIRECTORY_BYTES) {
    throw new Error('ZIP input is shorter than an end-of-central-directory record.');
  }
  if (value.byteLength > limits.maxArchiveBytes) {
    throw new Error('ZIP input exceeds the bounded archive-size limit.');
  }
  return readOwnedArchive(Buffer.from(value), limits);
}

async function readOwnedArchive(archive, limits) {
  const directory = parseEndOfCentralDirectory(archive);
  const records = parseCentralDirectory(archive, directory, limits);
  validateLocalRecords(archive, directory, records);

  const entries = [];
  for (const record of records) {
    if (record.isDirectory && !limits.includeDirectories) continue;
    const compressed = archive.subarray(record.dataOffset, record.dataEnd);
    const bytes = await expandRecord(record, compressed, limits);
    if (unsignedCrc32(bytes) !== record.crc32) {
      throw new Error(`ZIP entry CRC-32 does not match its central-directory record: ${record.path}`);
    }
    entries.push({
      path: record.path,
      bytes,
      compressedSize: record.compressedSize,
      uncompressedSize: record.uncompressedSize,
      modifiedAt: record.modifiedAt,
      versionMadeBy: record.versionMadeBy,
      externalFileAttributes: record.externalFileAttributes,
      generalPurposeBitFlag: record.flags,
      compressionMethod: record.compressionMethod,
      crc32: record.crc32,
      fileNameRaw: Buffer.from(record.rawName),
      isDirectory: record.isDirectory,
      localFileHeader: Object.freeze({
        fileName: Buffer.from(record.local.fileName),
        generalPurposeBitFlag: record.local.flags,
        compressionMethod: record.local.compressionMethod,
        crc32: record.local.crc32,
        compressedSize: record.local.compressedSize,
        uncompressedSize: record.local.uncompressedSize
      })
    });
  }
  return entries;
}

async function readBoundedArchive(path, maxArchiveBytes) {
  const expected = resolve(path);
  const pathBefore = await lstat(expected, { bigint: true });
  assertExactArchiveFile(pathBefore);
  if (!samePath(await realpath(expected), expected)) {
    throw new Error('ZIP input path cannot be a symbolic link, junction, or alias.');
  }
  const handle = await open(expected, 'r');
  try {
    const opened = await handle.stat({ bigint: true });
    assertExactArchiveFile(opened);
    if (!sameArchiveFileIdentity(pathBefore, opened)) {
      throw new Error('ZIP input path changed before its exact file handle was opened.');
    }
    if (opened.size < BigInt(MINIMUM_END_OF_CENTRAL_DIRECTORY_BYTES)) {
      throw new Error('ZIP input is shorter than an end-of-central-directory record.');
    }
    if (opened.size > BigInt(maxArchiveBytes)) {
      throw new Error('ZIP input exceeds the bounded archive-size limit.');
    }
    const archive = await handle.readFile();
    const handleAfter = await handle.stat({ bigint: true });
    const pathAfter = await lstat(expected, { bigint: true });
    assertExactArchiveFile(handleAfter);
    assertExactArchiveFile(pathAfter);
    if (
      !sameArchiveFileIdentity(opened, handleAfter) ||
      !sameArchiveFileIdentity(handleAfter, pathAfter) ||
      BigInt(archive.length) !== handleAfter.size ||
      !samePath(await realpath(expected), expected)
    ) {
      throw new Error('ZIP input changed while it was being read.');
    }
    return archive;
  } finally {
    await handle.close();
  }
}

function parseEndOfCentralDirectory(archive) {
  const minimumOffset = Math.max(
    0,
    archive.length - MINIMUM_END_OF_CENTRAL_DIRECTORY_BYTES - MAXIMUM_ZIP_COMMENT_BYTES
  );
  let offset = -1;
  for (
    let candidate = archive.length - MINIMUM_END_OF_CENTRAL_DIRECTORY_BYTES;
    candidate >= minimumOffset;
    candidate -= 1
  ) {
    if (archive.readUInt32LE(candidate) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) continue;
    const commentLength = archive.readUInt16LE(candidate + 20);
    if (candidate + MINIMUM_END_OF_CENTRAL_DIRECTORY_BYTES + commentLength === archive.length) {
      offset = candidate;
      break;
    }
  }
  if (offset < 0) throw new Error('ZIP end-of-central-directory record is missing or malformed.');

  const diskNumber = archive.readUInt16LE(offset + 4);
  const centralDirectoryDisk = archive.readUInt16LE(offset + 6);
  const entriesOnDisk = archive.readUInt16LE(offset + 8);
  const entryCount = archive.readUInt16LE(offset + 10);
  const centralDirectorySize = archive.readUInt32LE(offset + 12);
  const centralDirectoryOffset = archive.readUInt32LE(offset + 16);
  if (
    entriesOnDisk === ZIP64_UINT16_SENTINEL ||
    entryCount === ZIP64_UINT16_SENTINEL ||
    centralDirectorySize === ZIP64_UINT32_SENTINEL ||
    centralDirectoryOffset === ZIP64_UINT32_SENTINEL
  ) {
    throw new Error('ZIP64 archives are outside the bounded SiteWipe ZIP contract.');
  }
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new Error('Multi-disk ZIP archives are outside the SiteWipe ZIP contract.');
  }
  if (entryCount > MAXIMUM_ENTRY_COUNT) throw new Error('ZIP archive exceeds the bounded entry-count limit.');
  if (centralDirectoryOffset + centralDirectorySize !== offset) {
    throw new Error('ZIP central-directory bounds do not meet the end-of-directory record exactly.');
  }
  return Object.freeze({ entryCount, offset, centralDirectoryOffset, centralDirectorySize });
}

function parseCentralDirectory(archive, directory, limits) {
  const records = [];
  const paths = new Set();
  let expandedBytes = 0;
  let cursor = directory.centralDirectoryOffset;
  if (directory.entryCount > limits.maxEntryCount) {
    throw new Error('ZIP archive exceeds the bounded entry-count limit.');
  }
  for (let index = 0; index < directory.entryCount; index += 1) {
    assertBoundedRange(cursor, 46, directory.offset, 'ZIP central-directory file header');
    if (archive.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_FILE_HEADER_SIGNATURE) {
      throw new Error('ZIP central-directory file-header signature is invalid.');
    }
    const versionMadeBy = archive.readUInt16LE(cursor + 4);
    const flags = archive.readUInt16LE(cursor + 8);
    const compressionMethod = archive.readUInt16LE(cursor + 10);
    const dosTime = archive.readUInt16LE(cursor + 12);
    const dosDate = archive.readUInt16LE(cursor + 14);
    const expectedCrc32 = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const fileNameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const diskStart = archive.readUInt16LE(cursor + 34);
    const externalFileAttributes = archive.readUInt32LE(cursor + 38);
    const localHeaderOffset = archive.readUInt32LE(cursor + 42);
    if (
      compressedSize === ZIP64_UINT32_SENTINEL ||
      uncompressedSize === ZIP64_UINT32_SENTINEL ||
      localHeaderOffset === ZIP64_UINT32_SENTINEL ||
      diskStart === ZIP64_UINT16_SENTINEL
    ) {
      throw new Error('ZIP64 entry records are outside the bounded SiteWipe ZIP contract.');
    }
    validateFlagsAndCompression(flags, compressionMethod);
    if (diskStart !== 0) throw new Error('ZIP entry refers to a non-primary archive disk.');
    if (fileNameLength === 0 || fileNameLength > MAXIMUM_ENTRY_NAME_BYTES) {
      throw new Error('ZIP entry has an invalid file-name length.');
    }
    if (uncompressedSize > limits.maxEntryBytes) {
      throw new Error('ZIP entry exceeds the bounded uncompressed-size limit.');
    }
    expandedBytes += uncompressedSize;
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > limits.maxExpandedBytes) {
      throw new Error('ZIP archive exceeds the bounded expanded-size limit.');
    }

    const variableLength = fileNameLength + extraLength + commentLength;
    assertBoundedRange(cursor + 46, variableLength, directory.offset, 'ZIP central-directory variable fields');
    const rawName = archive.subarray(cursor + 46, cursor + 46 + fileNameLength);
    const extraBytes = archive.subarray(cursor + 46 + fileNameLength, cursor + 46 + fileNameLength + extraLength);
    const extras = parseExtraFields(extraBytes);
    const path = validateEntryPath(decodeEntryName(rawName, flags, extras), limits.strictFileNames);
    if (paths.has(path)) throw new Error(`ZIP archive contains a duplicate entry path: ${path}`);
    paths.add(path);
    records.push({
      path,
      rawName,
      versionMadeBy,
      externalFileAttributes,
      flags,
      compressionMethod,
      crc32: expectedCrc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      modifiedAt: readModifiedAt(extras, dosDate, dosTime),
      isDirectory: path.endsWith('/'),
      dataOffset: null,
      dataEnd: null,
      regionEnd: null,
      local: null
    });
    cursor += 46 + variableLength;
  }
  if (cursor !== directory.offset) {
    throw new Error('ZIP central directory contains unaccounted or truncated bytes.');
  }
  return records;
}

function validateLocalRecords(archive, directory, records) {
  const offsets = new Set();
  for (const record of records) {
    if (offsets.has(record.localHeaderOffset)) {
      throw new Error('ZIP entries cannot share a local-file-header offset.');
    }
    offsets.add(record.localHeaderOffset);
    if (record.localHeaderOffset >= directory.centralDirectoryOffset) {
      throw new Error('ZIP local-file header overlaps the central directory.');
    }
    assertAvailable(archive, record.localHeaderOffset, 30, 'ZIP local-file header');
    if (archive.readUInt32LE(record.localHeaderOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
      throw new Error(`ZIP local-file-header signature is invalid: ${record.path}`);
    }
    const flags = archive.readUInt16LE(record.localHeaderOffset + 6);
    const compressionMethod = archive.readUInt16LE(record.localHeaderOffset + 8);
    const localCrc32 = archive.readUInt32LE(record.localHeaderOffset + 14);
    const localCompressedSize = archive.readUInt32LE(record.localHeaderOffset + 18);
    const localUncompressedSize = archive.readUInt32LE(record.localHeaderOffset + 22);
    const fileNameLength = archive.readUInt16LE(record.localHeaderOffset + 26);
    const extraLength = archive.readUInt16LE(record.localHeaderOffset + 28);
    if (flags !== record.flags || compressionMethod !== record.compressionMethod) {
      throw new Error(`ZIP local and central entry metadata disagree: ${record.path}`);
    }
    assertAvailable(
      archive,
      record.localHeaderOffset + 30,
      fileNameLength + extraLength,
      'ZIP local-file variable fields'
    );
    const localName = archive.subarray(record.localHeaderOffset + 30, record.localHeaderOffset + 30 + fileNameLength);
    if (!localName.equals(record.rawName)) {
      throw new Error(`ZIP local and central entry names disagree: ${record.path}`);
    }
    parseExtraFields(
      archive.subarray(
        record.localHeaderOffset + 30 + fileNameLength,
        record.localHeaderOffset + 30 + fileNameLength + extraLength
      )
    );
    record.local = {
      fileName: localName,
      flags,
      compressionMethod,
      crc32: localCrc32,
      compressedSize: localCompressedSize,
      uncompressedSize: localUncompressedSize
    };
    if ((flags & GENERAL_PURPOSE_DATA_DESCRIPTOR) === 0) {
      if (
        localCrc32 !== record.crc32 ||
        localCompressedSize !== record.compressedSize ||
        localUncompressedSize !== record.uncompressedSize
      ) {
        throw new Error(`ZIP local and central entry sizes or CRC disagree: ${record.path}`);
      }
    } else if (
      ![0, record.crc32].includes(localCrc32) ||
      ![0, record.compressedSize].includes(localCompressedSize) ||
      ![0, record.uncompressedSize].includes(localUncompressedSize)
    ) {
      throw new Error(`ZIP descriptor-mode local metadata is inconsistent: ${record.path}`);
    }

    record.dataOffset = record.localHeaderOffset + 30 + fileNameLength + extraLength;
    record.dataEnd = record.dataOffset + record.compressedSize;
    if (record.dataEnd > directory.centralDirectoryOffset) {
      throw new Error(`ZIP entry data overlaps the central directory: ${record.path}`);
    }
    record.regionEnd = record.dataEnd;
    if ((flags & GENERAL_PURPOSE_DATA_DESCRIPTOR) !== 0) {
      record.regionEnd = validateDataDescriptor(archive, record, directory.centralDirectoryOffset);
    }
  }

  const ordered = [...records].sort((left, right) => left.localHeaderOffset - right.localHeaderOffset);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index].localHeaderOffset < ordered[index - 1].regionEnd) {
      throw new Error('ZIP local entry regions overlap.');
    }
  }
}

function validateDataDescriptor(archive, record, centralDirectoryOffset) {
  let cursor = record.dataEnd;
  let length = 12;
  if (cursor + 4 <= centralDirectoryOffset && archive.readUInt32LE(cursor) === DATA_DESCRIPTOR_SIGNATURE) {
    cursor += 4;
    length = 16;
  }
  assertBoundedRange(cursor, 12, centralDirectoryOffset, 'ZIP data descriptor');
  if (
    archive.readUInt32LE(cursor) !== record.crc32 ||
    archive.readUInt32LE(cursor + 4) !== record.compressedSize ||
    archive.readUInt32LE(cursor + 8) !== record.uncompressedSize
  ) {
    throw new Error(`ZIP data descriptor does not match the central entry: ${record.path}`);
  }
  return record.dataEnd + length;
}

async function expandRecord(record, compressed, limits) {
  if (record.compressionMethod === COMPRESSION_STORED) {
    if (record.compressedSize !== record.uncompressedSize) {
      throw new Error(`Stored ZIP entry declares unequal compressed and uncompressed sizes: ${record.path}`);
    }
    return Buffer.from(compressed);
  }
  let expanded;
  try {
    expanded = await inflateRawAsync(compressed, {
      maxOutputLength: Math.min(limits.maxEntryBytes, record.uncompressedSize + 1)
    });
  } catch (error) {
    throw new Error(`ZIP entry deflate stream is invalid or exceeds its declared bound: ${record.path}`, {
      cause: error
    });
  }
  if (expanded.length !== record.uncompressedSize) {
    throw new Error(`ZIP entry output length does not match its central-directory record: ${record.path}`);
  }
  return expanded;
}

function validateFlagsAndCompression(flags, compressionMethod) {
  if ((flags & ~ALLOWED_GENERAL_PURPOSE_BITS) !== 0) {
    throw new Error('ZIP entry uses encryption, reserved flags, or unsupported processing options.');
  }
  if (compressionMethod !== COMPRESSION_STORED && compressionMethod !== COMPRESSION_DEFLATE) {
    throw new Error(`ZIP entry uses unsupported compression method ${compressionMethod}.`);
  }
  if (compressionMethod === COMPRESSION_STORED && (flags & GENERAL_PURPOSE_DEFLATE_OPTIONS) !== 0) {
    throw new Error('Stored ZIP entry sets deflate-only processing flags.');
  }
}

function parseExtraFields(bytes) {
  const fields = [];
  let cursor = 0;
  while (cursor < bytes.length) {
    if (cursor + 4 > bytes.length) throw new Error('ZIP extra-field header is truncated.');
    const id = bytes.readUInt16LE(cursor);
    const length = bytes.readUInt16LE(cursor + 2);
    cursor += 4;
    if (cursor + length > bytes.length) throw new Error('ZIP extra-field payload is truncated.');
    fields.push({ id, bytes: bytes.subarray(cursor, cursor + length) });
    cursor += length;
  }
  return fields;
}

function decodeEntryName(rawName, flags, extras) {
  for (const extra of extras) {
    if (extra.id !== 0x7075 || extra.bytes.length < 6 || extra.bytes[0] !== 1) continue;
    if (extra.bytes.readUInt32LE(1) !== unsignedCrc32(rawName)) continue;
    return decodeUtf8(extra.bytes.subarray(5), 'ZIP Unicode path extra field');
  }
  if ((flags & GENERAL_PURPOSE_UTF8) !== 0) return decodeUtf8(rawName, 'ZIP UTF-8 entry name');
  let decoded = '';
  for (const byte of rawName) decoded += CP437[byte];
  return decoded;
}

function decodeUtf8(bytes, label) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`${label} is malformed.`, { cause: error });
  }
}

function validateEntryPath(value, strictFileNames) {
  if (strictFileNames && value.includes('\\')) {
    throw new Error(`ZIP entry path contains a forbidden backslash: ${JSON.stringify(value)}`);
  }
  const path = value.replaceAll('\\', '/');
  if (
    !path ||
    path.includes('\u0000') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/u.test(path) ||
    path.split('/').some((segment) => segment === '..')
  ) {
    throw new Error(`ZIP entry path is unsafe: ${JSON.stringify(path)}`);
  }
  return path;
}

function validateReadOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('ZIP read options must be an object.');
  }
  const unknown = Object.keys(options).filter((key) => !READ_OPTION_KEYS.includes(key));
  if (unknown.length > 0) throw new Error(`ZIP read options contain unsupported keys: ${unknown.join(', ')}`);
  const resolved = { ...DEFAULT_READ_OPTIONS, ...options };
  for (const key of ['maxArchiveBytes', 'maxEntryBytes', 'maxEntryCount', 'maxExpandedBytes']) {
    if (!Number.isSafeInteger(resolved[key]) || resolved[key] < 1) {
      throw new Error(`ZIP read option ${key} must be a positive safe integer.`);
    }
  }
  if (resolved.maxEntryBytes > resolved.maxExpandedBytes) {
    throw new Error('ZIP per-entry byte limit cannot exceed its aggregate expanded-byte limit.');
  }
  if (typeof resolved.includeDirectories !== 'boolean' || typeof resolved.strictFileNames !== 'boolean') {
    throw new Error('ZIP directory and strict-file-name options must be booleans.');
  }
  return Object.freeze(resolved);
}

function readModifiedAt(extras, dosDate, dosTime) {
  for (const extra of extras) {
    if (extra.id === 0x5455 && extra.bytes.length >= 5 && (extra.bytes[0] & 1) !== 0) {
      return checkedDate(new Date(extra.bytes.readInt32LE(1) * 1000), 'ZIP extended timestamp');
    }
    if (
      extra.id === 0x000a &&
      extra.bytes.length === 32 &&
      extra.bytes.readUInt16LE(4) === 1 &&
      extra.bytes.readUInt16LE(6) === 24
    ) {
      const windowsTicks = extra.bytes.readBigUInt64LE(8);
      const milliseconds = (windowsTicks - 116_444_736_000_000_000n) / 10_000n;
      return checkedDate(new Date(Number(milliseconds)), 'ZIP NTFS timestamp');
    }
  }
  const day = dosDate & 0x1f;
  const month = (dosDate >> 5) & 0x0f;
  const year = ((dosDate >> 9) & 0x7f) + 1980;
  const second = (dosTime & 0x1f) * 2;
  const minute = (dosTime >> 5) & 0x3f;
  const hour = (dosTime >> 11) & 0x1f;
  if (day < 1 || month < 1 || month > 12 || second > 59 || minute > 59 || hour > 23) {
    throw new Error('ZIP DOS timestamp is invalid.');
  }
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, 0));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    throw new Error('ZIP DOS timestamp is not a real calendar time.');
  }
  return checkedDate(date, 'ZIP DOS timestamp');
}

function checkedDate(date, label) {
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} is outside the supported date range.`);
  return date.toISOString();
}

function unsignedCrc32(bytes) {
  return Number(crc32(bytes)) >>> 0;
}

function assertExactArchiveFile(information) {
  const fields = ['birthtimeNs', 'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink', 'size'];
  if (
    !information?.isFile() ||
    information.isSymbolicLink() ||
    information.nlink !== 1n ||
    information.size < 0n ||
    fields.some((field) => typeof information[field] !== 'bigint')
  ) {
    throw new Error('ZIP input must be one singly linked regular non-reparse file with exact bigint identity.');
  }
}

function sameArchiveFileIdentity(left, right) {
  const fields = ['birthtimeNs', 'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink', 'size'];
  return fields.every((field) => left[field] === right[field]);
}

function samePath(left, right) {
  const first = resolve(left);
  const second = resolve(right);
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function assertAvailable(bytes, offset, length, label) {
  assertBoundedRange(offset, length, bytes.length, label);
}

function assertBoundedRange(offset, length, upperBound, label) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > upperBound ||
    length > upperBound - offset
  ) {
    throw new Error(`${label} exceeds its containing ZIP bounds.`);
  }
}

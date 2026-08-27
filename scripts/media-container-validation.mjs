import { inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_MAX_BYTES = 64 * 1024 * 1024;
const PNG_MAX_INFLATED_BYTES = 128 * 1024 * 1024;
const MP4_MAX_BYTES = 512 * 1024 * 1024;
const MAX_CONTAINER_ITEMS = 4096;
const MAX_MEDIA_SAMPLES = 100_000;
const MAX_NAL_UNITS_PER_SAMPLE = 4096;
const MAX_RBSP_PROBE_BYTES = 4096;
const MAX_DIMENSION = 100_000;
const MAX_PIXELS = 100_000_000;
const MP4_BRANDS = Object.freeze(new Set(['avc1', 'iso2', 'isom', 'M4V ', 'mp41', 'mp42']));
const IDENTITY_TRANSFORMATION_MATRIX = Object.freeze([0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000]);

// One tenth of a second is narrower than ordinary one-second evidence rounding
// while allowing deterministic movie timescales to represent the declared value.
export const MP4_DURATION_TOLERANCE_SECONDS = 0.1;

// These inspectors establish bounded container, metadata, sample-table, and
// limited AVC syntax coherence only. They are not image/video decoders and do
// not prove intrinsic rendered dimensions, successful playback, or authentic
// visible content; the publication gate requires a separate human review.

export function inspectPngContainer(source) {
  const bytes = exactBytes(source, 'PNG');
  if (bytes.length < 45 || bytes.length > PNG_MAX_BYTES || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('PNG signature or bounded byte length is invalid.');
  }

  let offset = PNG_SIGNATURE.length;
  let chunkCount = 0;
  let header = null;
  let sawIdat = false;
  let idatSequenceEnded = false;
  let sawIend = false;
  let sawPalette = false;
  let sawTransparency = false;
  let paletteEntries = 0;
  const imageData = [];
  while (offset < bytes.length) {
    if (bytes.length - offset < 12 || ++chunkCount > MAX_CONTAINER_ITEMS) {
      throw new Error('PNG chunk inventory is truncated or exceeds its bound.');
    }
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd > bytes.length - 4 || chunkEnd > bytes.length) {
      throw new Error('PNG chunk size escapes the retained bytes.');
    }
    const typeBytes = bytes.subarray(typeStart, dataStart);
    const type = typeBytes.toString('ascii');
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error('PNG chunk type is malformed.');
    if (!/[A-Z]/.test(type[2])) throw new Error('PNG chunk uses the forbidden lowercase reserved bit.');
    if (/[A-Z]/.test(type[0]) && !new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']).has(type)) {
      throw new Error(`PNG contains unknown critical chunk ${type}.`);
    }
    if (bytes.readUInt32BE(dataEnd) !== crc32(bytes.subarray(typeStart, dataEnd))) {
      throw new Error(`PNG ${type} chunk CRC is invalid.`);
    }

    if (chunkCount === 1 && type !== 'IHDR') throw new Error('PNG IHDR is not the first chunk.');
    if (type === 'IHDR') {
      if (header !== null || length !== 13) throw new Error('PNG IHDR is duplicate or malformed.');
      header = parsePngHeader(bytes, dataStart);
    } else if (type === 'PLTE') {
      if (
        sawPalette ||
        sawTransparency ||
        sawIdat ||
        header === null ||
        [0, 4].includes(header.colorType) ||
        length === 0 ||
        length % 3 !== 0 ||
        length > 768 ||
        (header.colorType === 3 && length / 3 > 2 ** header.bitDepth)
      ) {
        throw new Error('PNG PLTE is duplicate, misplaced, or malformed.');
      }
      sawPalette = true;
      paletteEntries = length / 3;
    } else if (type === 'tRNS') {
      if (
        sawTransparency ||
        sawIdat ||
        header === null ||
        [4, 6].includes(header.colorType) ||
        (header.colorType === 0 && length !== 2) ||
        (header.colorType === 2 && length !== 6) ||
        (header.colorType === 3 && (!sawPalette || length === 0 || length > paletteEntries))
      ) {
        throw new Error('PNG tRNS is duplicate, misplaced, or malformed for its color type.');
      }
      sawTransparency = true;
    } else if (type === 'IDAT') {
      if (header === null || idatSequenceEnded) throw new Error('PNG IDAT ordering is invalid.');
      sawIdat = true;
      imageData.push(bytes.subarray(dataStart, dataEnd));
    } else if (sawIdat && type !== 'IEND') {
      idatSequenceEnded = true;
    }

    if (type === 'IEND') {
      if (sawIend || length !== 0 || !sawIdat || chunkEnd !== bytes.length) {
        throw new Error('PNG IEND is duplicate, premature, or malformed.');
      }
      sawIend = true;
    }
    offset = chunkEnd;
  }
  if (!header || !sawIdat || !sawIend || offset !== bytes.length || (header.colorType === 3 && !sawPalette)) {
    throw new Error('PNG is missing an exact IHDR, IDAT, or terminal IEND sequence.');
  }
  validatePngImageData(header, imageData, paletteEntries);
  return Object.freeze({ height: header.height, width: header.width });
}

export function inspectIsoBmffMp4Container(source) {
  const bytes = exactBytes(source, 'MP4');
  if (bytes.length < 32 || bytes.length > MP4_MAX_BYTES) {
    throw new Error('MP4 bounded byte length is invalid.');
  }
  const state = { count: 0 };
  const topLevel = parseBoxes(bytes, 0, bytes.length, state, 'top-level');
  rejectMisplacedEditLists(topLevel, 'top-level');
  if (topLevel[0]?.type !== 'ftyp' || boxesOfType(topLevel, 'ftyp').length !== 1) {
    throw new Error('MP4 requires exactly one leading ftyp box.');
  }
  const moovBoxes = boxesOfType(topLevel, 'moov');
  const mdatBoxes = boxesOfType(topLevel, 'mdat');
  if (moovBoxes.length !== 1 || mdatBoxes.length < 1 || mdatBoxes.every((box) => box.end === box.payloadStart)) {
    throw new Error('MP4 requires exactly one moov box and at least one mdat box.');
  }
  validateFtyp(bytes, topLevel[0]);

  const moovChildren = parseBoxChildren(bytes, moovBoxes[0], state, 'moov');
  rejectMisplacedEditLists(moovChildren, 'moov');
  const movieHeaders = boxesOfType(moovChildren, 'mvhd');
  const tracks = boxesOfType(moovChildren, 'trak');
  if (movieHeaders.length !== 1 || tracks.length !== 1) {
    throw new Error('MP4 narrow video profile requires exactly one mvhd box and one total trak box.');
  }
  const movieTiming = parseMovieDuration(bytes, movieHeaders[0]);
  const durationSeconds = movieTiming.durationSeconds;
  const videoDimensions = [];
  for (const [index, track] of tracks.entries()) {
    const trackChildren = parseBoxChildren(bytes, track, state, `trak ${index + 1}`);
    rejectMisplacedEditLists(trackChildren, `trak ${index + 1}`);
    const trackHeaders = boxesOfType(trackChildren, 'tkhd');
    const mediaBoxes = boxesOfType(trackChildren, 'mdia');
    if (trackHeaders.length !== 1 || mediaBoxes.length !== 1) {
      throw new Error(`MP4 trak ${index + 1} has duplicate or missing tkhd/mdia boxes.`);
    }
    const mediaChildren = parseBoxChildren(bytes, mediaBoxes[0], state, `trak ${index + 1} mdia`);
    rejectMisplacedEditLists(mediaChildren, `trak ${index + 1} mdia`);
    const handlers = boxesOfType(mediaChildren, 'hdlr');
    if (handlers.length !== 1) {
      throw new Error(`MP4 trak ${index + 1} has duplicate or missing hdlr boxes.`);
    }
    if (parseHandlerType(bytes, handlers[0]) === 'vide') {
      const editBoxes = boxesOfType(trackChildren, 'edts');
      if (editBoxes.length !== 0) {
        throw new Error(`MP4 video trak ${index + 1} uses an unsupported edit list.`);
      }
      const dimensions = parseTrackDimensions(bytes, trackHeaders[0], movieTiming);
      validateVideoSampleTable(bytes, mediaChildren, dimensions, movieTiming, mdatBoxes, state, index + 1);
      videoDimensions.push(dimensions);
    }
  }
  if (videoDimensions.length !== 1) {
    throw new Error('MP4 must contain exactly one unambiguous video track.');
  }
  return Object.freeze({ durationSeconds, ...videoDimensions[0] });
}

function parsePngHeader(bytes, offset) {
  const width = bytes.readUInt32BE(offset);
  const height = bytes.readUInt32BE(offset + 4);
  const bitDepth = bytes[offset + 8];
  const colorType = bytes[offset + 9];
  const validDepths = new Map([
    [0, [1, 2, 4, 8, 16]],
    [2, [8, 16]],
    [3, [1, 2, 4, 8]],
    [4, [8, 16]],
    [6, [8, 16]]
  ]);
  if (
    width === 0 ||
    height === 0 ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    width * height > MAX_PIXELS ||
    !validDepths.get(colorType)?.includes(bitDepth) ||
    bytes[offset + 10] !== 0 ||
    bytes[offset + 11] !== 0 ||
    bytes[offset + 12] !== 0
  ) {
    throw new Error('PNG IHDR dimensions or encoding fields are invalid.');
  }
  return { bitDepth, colorType, height, width };
}

function validatePngImageData(header, chunks, paletteEntries) {
  const channels = new Map([
    [0, 1],
    [2, 3],
    [3, 1],
    [4, 2],
    [6, 4]
  ]).get(header.colorType);
  const rowBytes = Math.ceil((header.width * channels * header.bitDepth) / 8);
  const expectedBytes = (rowBytes + 1) * header.height;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0 || expectedBytes > PNG_MAX_INFLATED_BYTES) {
    throw new Error('PNG decoded scanline inventory exceeds its exact bound.');
  }
  const compressed = Buffer.concat(chunks);
  let result;
  try {
    result = inflateSync(compressed, { info: true, maxOutputLength: expectedBytes + 1 });
  } catch (error) {
    throw new Error('PNG IDAT data is not one bounded zlib stream.', { cause: error });
  }
  if (!result?.engine || result.engine.bytesWritten !== compressed.length) {
    throw new Error('PNG IDAT contains bytes outside its one exact zlib stream.');
  }
  const decoded = result.buffer;
  if (decoded.length !== expectedBytes) throw new Error('PNG decoded scanline length differs from IHDR.');
  const bytesPerPixel = Math.max(1, Math.ceil((channels * header.bitDepth) / 8));
  let prior = Buffer.alloc(rowBytes);
  for (let offset = 0; offset < decoded.length; offset += rowBytes + 1) {
    const filter = decoded[offset];
    if (filter > 4) throw new Error('PNG scanline uses an invalid filter type.');
    const encoded = decoded.subarray(offset + 1, offset + rowBytes + 1);
    const row = Buffer.allocUnsafe(rowBytes);
    for (let index = 0; index < rowBytes; index += 1) {
      const left = index >= bytesPerPixel ? row[index - bytesPerPixel] : 0;
      const up = prior[index];
      const upperLeft = index >= bytesPerPixel ? prior[index - bytesPerPixel] : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : paethPredictor(left, up, upperLeft);
      row[index] = (encoded[index] + predictor) & 0xff;
    }
    if (header.colorType === 3) validatePaletteIndexes(row, header.width, header.bitDepth, paletteEntries);
    prior = row;
  }
}

function validatePaletteIndexes(row, width, bitDepth, paletteEntries) {
  const mask = (1 << bitDepth) - 1;
  for (let pixel = 0; pixel < width; pixel += 1) {
    const bitOffset = pixel * bitDepth;
    const paletteIndex = (row[Math.floor(bitOffset / 8)] >> (8 - bitDepth - (bitOffset % 8))) & mask;
    if (paletteIndex >= paletteEntries) throw new Error('PNG indexed pixel exceeds its exact PLTE entry count.');
  }
}

function paethPredictor(left, up, upperLeft) {
  const estimate = left + up - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const upDistance = Math.abs(estimate - up);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= upDistance && leftDistance <= upperLeftDistance
    ? left
    : upDistance <= upperLeftDistance
      ? up
      : upperLeft;
}

function parseBoxes(bytes, start, end, state, label) {
  const boxes = [];
  let offset = start;
  while (offset < end) {
    if (end - offset < 8 || ++state.count > MAX_CONTAINER_ITEMS) {
      throw new Error(`MP4 ${label} box inventory is truncated or exceeds its bound.`);
    }
    const size32 = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    if (!/^[\x20-\x7E]{4}$/.test(type)) throw new Error(`MP4 ${label} box type is malformed.`);
    let headerBytes = 8;
    let size = size32;
    if (size32 === 1) {
      if (end - offset < 16) throw new Error(`MP4 ${label} extended box header is truncated.`);
      const extended = bytes.readBigUInt64BE(offset + 8);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`MP4 ${label} box size is not exact.`);
      size = Number(extended);
      headerBytes = 16;
    } else if (size32 === 0) {
      throw new Error(`MP4 ${label} uses an ambiguous zero-sized box.`);
    }
    if (size < headerBytes || size > end - offset) {
      throw new Error(`MP4 ${label} box size escapes its parent bounds.`);
    }
    boxes.push(
      Object.freeze({
        end: offset + size,
        payloadStart: offset + headerBytes,
        start: offset,
        type
      })
    );
    offset += size;
  }
  if (offset !== end) throw new Error(`MP4 ${label} boxes do not exactly cover their parent.`);
  return Object.freeze(boxes);
}

function parseBoxChildren(bytes, box, state, label) {
  return parseBoxes(bytes, box.payloadStart, box.end, state, label);
}

function boxesOfType(boxes, type) {
  return boxes.filter((box) => box.type === type);
}

function validateFtyp(bytes, box) {
  const length = box.end - box.payloadStart;
  if (length < 12 || length % 4 !== 0) throw new Error('MP4 ftyp payload is malformed.');
  const brands = [];
  for (let offset = box.payloadStart; offset < box.end; offset += 4) {
    if (offset === box.payloadStart + 4) continue;
    brands.push(bytes.subarray(offset, offset + 4).toString('ascii'));
  }
  if (!brands.some((brand) => MP4_BRANDS.has(brand))) {
    throw new Error('ISO-BMFF container does not declare an accepted MP4 brand.');
  }
}

function parseMovieDuration(bytes, box) {
  const payloadLength = box.end - box.payloadStart;
  const version = bytes[box.payloadStart];
  let timescale;
  let duration;
  if (version === 0 && payloadLength === 100 && bytes.readUInt32BE(box.payloadStart) === 0) {
    timescale = bytes.readUInt32BE(box.payloadStart + 12);
    duration = bytes.readUInt32BE(box.payloadStart + 16);
  } else if (version === 1 && payloadLength === 112 && bytes.readUIntBE(box.payloadStart + 1, 3) === 0) {
    timescale = bytes.readUInt32BE(box.payloadStart + 20);
    duration = exactUInt64(bytes, box.payloadStart + 24, 'MP4 mvhd duration');
  } else {
    throw new Error('MP4 mvhd version or size is malformed.');
  }
  if (timescale === 0 || duration <= 0) throw new Error('MP4 mvhd duration or timescale is not positive.');
  const durationSeconds = duration / timescale;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('MP4 mvhd duration is not finite and positive.');
  }
  const rateOffset = box.payloadStart + (version === 0 ? 20 : 32);
  const volumeOffset = rateOffset + 4;
  const reservedOffset = volumeOffset + 2;
  const matrixOffset = reservedOffset + 10;
  const predefinedOffset = matrixOffset + 36;
  const nextTrackIdOffset = predefinedOffset + 24;
  const nextTrackId = bytes.readUInt32BE(nextTrackIdOffset);
  if (
    bytes.readUInt32BE(rateOffset) !== 0x0001_0000 ||
    bytes.readUInt16BE(volumeOffset) !== 0x0100 ||
    !allZero(bytes, reservedOffset, matrixOffset) ||
    !hasIdentityTransformationMatrix(bytes, matrixOffset) ||
    !allZero(bytes, predefinedOffset, nextTrackIdOffset) ||
    nextTrackId === 0
  ) {
    throw new Error('MP4 mvhd rate, volume, matrix, reserved fields, or next_track_ID is invalid.');
  }
  return Object.freeze({ durationSeconds, nextTrackId, timescale });
}

function parseHandlerType(bytes, box) {
  if (
    box.end - box.payloadStart < 24 ||
    bytes.readUInt32BE(box.payloadStart) !== 0 ||
    bytes.readUInt32BE(box.payloadStart + 4) !== 0 ||
    !allZero(bytes, box.payloadStart + 12, box.payloadStart + 24)
  ) {
    throw new Error('MP4 hdlr version or size is malformed.');
  }
  return bytes.subarray(box.payloadStart + 8, box.payloadStart + 12).toString('ascii');
}

function parseTrackDimensions(bytes, box, movieTiming) {
  const payloadLength = box.end - box.payloadStart;
  const version = bytes[box.payloadStart];
  const expectedLength = version === 0 ? 84 : version === 1 ? 96 : 0;
  if (payloadLength !== expectedLength || bytes.readUIntBE(box.payloadStart + 1, 3) !== 3) {
    throw new Error('MP4 tkhd version, flags, or size is malformed.');
  }
  const trackId = bytes.readUInt32BE(box.payloadStart + (version === 0 ? 12 : 20));
  if (trackId === 0 || trackId >= movieTiming.nextTrackId) {
    throw new Error('MP4 tkhd track_ID must be positive and below mvhd next_track_ID.');
  }
  const reservedAfterTrackId = box.payloadStart + (version === 0 ? 16 : 24);
  const durationOffset = box.payloadStart + (version === 0 ? 20 : 28);
  const reservedAfterDuration = box.payloadStart + (version === 0 ? 24 : 36);
  const volumeOffset = box.payloadStart + (version === 0 ? 36 : 48);
  const matrixOffset = box.payloadStart + (version === 0 ? 40 : 52);
  if (
    bytes.readUInt32BE(reservedAfterTrackId) !== 0 ||
    !allZero(bytes, reservedAfterDuration, reservedAfterDuration + 8) ||
    bytes.readUInt16BE(volumeOffset) !== 0 ||
    bytes.readUInt16BE(volumeOffset + 2) !== 0 ||
    !hasIdentityTransformationMatrix(bytes, matrixOffset)
  ) {
    throw new Error('MP4 video tkhd reserved fields, volume, or transformation matrix is invalid.');
  }
  const duration =
    version === 0 ? bytes.readUInt32BE(durationOffset) : exactUInt64(bytes, durationOffset, 'MP4 tkhd duration');
  const durationSeconds = duration / movieTiming.timescale;
  if (
    duration <= 0 ||
    !Number.isFinite(durationSeconds) ||
    Math.abs(durationSeconds - movieTiming.durationSeconds) > MP4_DURATION_TOLERANCE_SECONDS
  ) {
    throw new Error('MP4 tkhd duration does not match the exact movie duration.');
  }
  const rawWidth = bytes.readUInt32BE(box.end - 8);
  const rawHeight = bytes.readUInt32BE(box.end - 4);
  if (rawWidth % 65_536 !== 0 || rawHeight % 65_536 !== 0) {
    throw new Error('MP4 video dimensions are not exact integral 16.16 values.');
  }
  const width = rawWidth / 65_536;
  const height = rawHeight / 65_536;
  if (width <= 0 || height <= 0 || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    throw new Error('MP4 video dimensions are not positive and bounded.');
  }
  return Object.freeze({ height, width });
}

function validateVideoSampleTable(bytes, mediaChildren, dimensions, movieTiming, mdatBoxes, state, trackNumber) {
  const mediaHeaders = boxesOfType(mediaChildren, 'mdhd');
  if (mediaHeaders.length !== 1) {
    throw new Error(`MP4 video trak ${trackNumber} has duplicate or missing mdhd boxes.`);
  }
  const mediaDuration = parseMediaDuration(bytes, mediaHeaders[0], trackNumber);
  const mediaInformation = boxesOfType(mediaChildren, 'minf');
  if (mediaInformation.length !== 1) {
    throw new Error(`MP4 video trak ${trackNumber} has duplicate or missing minf boxes.`);
  }
  const mediaInformationChildren = parseBoxChildren(
    bytes,
    mediaInformation[0],
    state,
    `video trak ${trackNumber} minf`
  );
  rejectMisplacedEditLists(mediaInformationChildren, `video trak ${trackNumber} minf`);
  const dataReferenceIndex = validateVideoMediaInformation(bytes, mediaInformationChildren, state, trackNumber);
  const sampleTables = boxesOfType(mediaInformationChildren, 'stbl');
  if (sampleTables.length !== 1) {
    throw new Error(`MP4 video trak ${trackNumber} has duplicate or missing stbl boxes.`);
  }
  const sampleTableChildren = parseBoxChildren(bytes, sampleTables[0], state, `video trak ${trackNumber} stbl`);
  rejectMisplacedEditLists(sampleTableChildren, `video trak ${trackNumber} stbl`);
  if (boxesOfType(sampleTableChildren, 'ctts').length !== 0) {
    throw new Error(`MP4 video trak ${trackNumber} uses an unsupported composition-time table.`);
  }
  const required = Object.fromEntries(
    ['stsd', 'stts', 'stsc', 'stsz'].map((type) => [type, requireSingleBox(sampleTableChildren, type, trackNumber)])
  );
  const compactOffsets = boxesOfType(sampleTableChildren, 'stco');
  const extendedOffsets = boxesOfType(sampleTableChildren, 'co64');
  if (compactOffsets.length + extendedOffsets.length !== 1) {
    throw new Error(`MP4 video trak ${trackNumber} must have exactly one stco or co64 box.`);
  }

  const { nalLengthBytes } = parseVideoSampleDescription(
    bytes,
    required.stsd,
    dimensions,
    dataReferenceIndex,
    state,
    trackNumber
  );
  const sampleTiming = parseTimeToSample(bytes, required.stts, trackNumber);
  const sampleSizes = parseSampleSizes(bytes, required.stsz, trackNumber);
  if (sampleTiming.sampleCount !== sampleSizes.length) {
    throw new Error(`MP4 video trak ${trackNumber} stts and stsz sample counts differ.`);
  }
  const sampleDurationSeconds = sampleTiming.sampleTicks / mediaDuration.timescale;
  if (
    !Number.isFinite(sampleDurationSeconds) ||
    Math.abs(sampleDurationSeconds - mediaDuration.durationSeconds) > MP4_DURATION_TOLERANCE_SECONDS ||
    Math.abs(sampleDurationSeconds - movieTiming.durationSeconds) > MP4_DURATION_TOLERANCE_SECONDS ||
    Math.abs(mediaDuration.durationSeconds - movieTiming.durationSeconds) > MP4_DURATION_TOLERANCE_SECONDS
  ) {
    throw new Error(`MP4 video trak ${trackNumber} mvhd, mdhd, and stts durations do not agree.`);
  }
  const sampleToChunk = parseSampleToChunk(bytes, required.stsc, trackNumber);
  const chunkOffsets = parseChunkOffsets(bytes, compactOffsets[0] || extendedOffsets[0], trackNumber);
  const chunks = mapSamplesToChunks(sampleToChunk, chunkOffsets, sampleSizes, trackNumber);
  validateChunkPayloads(bytes, chunks, sampleSizes, mdatBoxes, nalLengthBytes, trackNumber);
}

function requireSingleBox(boxes, type, trackNumber) {
  const matches = boxesOfType(boxes, type);
  if (matches.length !== 1) {
    throw new Error(`MP4 video trak ${trackNumber} has duplicate or missing ${type} boxes.`);
  }
  return matches[0];
}

function validateVideoMediaInformation(bytes, children, state, trackNumber) {
  const videoHeaders = boxesOfType(children, 'vmhd');
  const dataInformation = boxesOfType(children, 'dinf');
  if (
    videoHeaders.length !== 1 ||
    videoHeaders[0].end - videoHeaders[0].payloadStart !== 12 ||
    bytes.readUInt32BE(videoHeaders[0].payloadStart) !== 1 ||
    !allZero(bytes, videoHeaders[0].payloadStart + 4, videoHeaders[0].end) ||
    dataInformation.length !== 1
  ) {
    throw new Error(`MP4 video trak ${trackNumber} requires one exact vmhd and dinf.`);
  }
  const dataInformationChildren = parseBoxChildren(bytes, dataInformation[0], state, `video trak ${trackNumber} dinf`);
  rejectMisplacedEditLists(dataInformationChildren, `video trak ${trackNumber} dinf`);
  if (dataInformationChildren.length !== 1 || dataInformationChildren[0].type !== 'dref') {
    throw new Error(`MP4 video trak ${trackNumber} dinf requires exactly one dref.`);
  }
  const dataReference = dataInformationChildren[0];
  if (
    dataReference.end - dataReference.payloadStart < 16 ||
    bytes.readUInt32BE(dataReference.payloadStart) !== 0 ||
    bytes.readUInt32BE(dataReference.payloadStart + 4) !== 1
  ) {
    throw new Error(`MP4 video trak ${trackNumber} dref header or entry count is malformed.`);
  }
  const entries = parseBoxes(
    bytes,
    dataReference.payloadStart + 8,
    dataReference.end,
    state,
    `video trak ${trackNumber} dref`
  );
  rejectMisplacedEditLists(entries, `video trak ${trackNumber} dref`);
  if (
    entries.length !== 1 ||
    entries[0].type !== 'url ' ||
    entries[0].end - entries[0].payloadStart !== 4 ||
    bytes.readUInt32BE(entries[0].payloadStart) !== 1
  ) {
    throw new Error(`MP4 video trak ${trackNumber} dref must be one self-contained url entry.`);
  }
  return 1;
}

function parseVideoSampleDescription(bytes, box, dimensions, dataReferenceIndex, state, trackNumber) {
  requireVersionZeroFullBox(bytes, box, `video trak ${trackNumber} stsd`);
  if (box.end - box.payloadStart < 16 || bytes.readUInt32BE(box.payloadStart + 4) !== 1) {
    throw new Error(`MP4 video trak ${trackNumber} stsd must declare exactly one sample entry.`);
  }
  const entries = parseBoxes(bytes, box.payloadStart + 8, box.end, state, `video trak ${trackNumber} stsd`);
  if (entries.length !== 1 || entries[0].type !== 'avc1') {
    throw new Error(`MP4 video trak ${trackNumber} requires one avc1 sample entry.`);
  }
  const entry = entries[0];
  const fixedSampleEntryBytes = 78;
  if (entry.end - entry.payloadStart < fixedSampleEntryBytes + 8) {
    throw new Error(`MP4 video trak ${trackNumber} avc1 sample entry is truncated.`);
  }
  const sampleWidth = bytes.readUInt16BE(entry.payloadStart + 24);
  const sampleHeight = bytes.readUInt16BE(entry.payloadStart + 26);
  const compressorNameLength = bytes[entry.payloadStart + 42];
  if (
    !allZero(bytes, entry.payloadStart, entry.payloadStart + 6) ||
    bytes.readUInt16BE(entry.payloadStart + 6) !== dataReferenceIndex ||
    bytes.readUInt16BE(entry.payloadStart + 8) !== 0 ||
    bytes.readUInt16BE(entry.payloadStart + 10) !== 0 ||
    !allZero(bytes, entry.payloadStart + 12, entry.payloadStart + 24) ||
    sampleWidth !== dimensions.width ||
    sampleHeight !== dimensions.height ||
    bytes.readUInt32BE(entry.payloadStart + 28) !== 72 * 65_536 ||
    bytes.readUInt32BE(entry.payloadStart + 32) !== 72 * 65_536 ||
    bytes.readUInt32BE(entry.payloadStart + 36) !== 0 ||
    bytes.readUInt16BE(entry.payloadStart + 40) !== 1 ||
    compressorNameLength > 31 ||
    !allZero(bytes, entry.payloadStart + 43 + compressorNameLength, entry.payloadStart + 74) ||
    bytes.readUInt16BE(entry.payloadStart + 74) !== 0x0018 ||
    bytes.readInt16BE(entry.payloadStart + 76) !== -1
  ) {
    throw new Error(`MP4 video trak ${trackNumber} avc1 fixed VisualSampleEntry fields are invalid.`);
  }
  const children = parseBoxes(
    bytes,
    entry.payloadStart + fixedSampleEntryBytes,
    entry.end,
    state,
    `video trak ${trackNumber} avc1`
  );
  rejectMisplacedEditLists(children, `video trak ${trackNumber} avc1`);
  const configurations = boxesOfType(children, 'avcC');
  if (configurations.length !== 1) {
    throw new Error(`MP4 video trak ${trackNumber} requires exactly one avcC codec configuration.`);
  }
  return parseAvcConfiguration(bytes, configurations[0], trackNumber);
}

function parseAvcConfiguration(bytes, box, trackNumber) {
  let offset = box.payloadStart;
  if (box.end - offset < 7 || bytes[offset] !== 1 || bytes[offset + 1] === 0) {
    throw new Error(`MP4 video trak ${trackNumber} avcC header is malformed.`);
  }
  const profile = bytes[offset + 1];
  if ((bytes[offset + 4] & 0xfc) !== 0xfc || (bytes[offset + 5] & 0xe0) !== 0xe0) {
    throw new Error(`MP4 video trak ${trackNumber} avcC reserved bits are malformed.`);
  }
  const nalLengthBytes = (bytes[offset + 4] & 0x03) + 1;
  if (nalLengthBytes === 3) {
    throw new Error(`MP4 video trak ${trackNumber} avcC uses the forbidden three-byte NAL length.`);
  }
  const sequenceParameterSetCount = bytes[offset + 5] & 0x1f;
  if (sequenceParameterSetCount === 0) {
    throw new Error(`MP4 video trak ${trackNumber} avcC has no sequence parameter set.`);
  }
  offset += 6;
  if (
    box.end - offset < 6 ||
    bytes.readUInt16BE(offset) < 4 ||
    bytes.readUInt16BE(offset) > box.end - offset - 2 ||
    bytes[offset + 3] !== bytes[box.payloadStart + 1] ||
    bytes[offset + 4] !== bytes[box.payloadStart + 2] ||
    bytes[offset + 5] !== bytes[box.payloadStart + 3]
  ) {
    throw new Error(`MP4 video trak ${trackNumber} avcC profile bytes differ from its first SPS.`);
  }
  offset = parseAvcParameterSets(bytes, offset, box.end, sequenceParameterSetCount, 7, 'SPS', trackNumber);
  if (offset >= box.end) throw new Error(`MP4 video trak ${trackNumber} avcC has no picture parameter set count.`);
  const pictureParameterSetCount = bytes[offset];
  if (pictureParameterSetCount === 0) {
    throw new Error(`MP4 video trak ${trackNumber} avcC has no picture parameter set.`);
  }
  offset = parseAvcParameterSets(bytes, offset + 1, box.end, pictureParameterSetCount, 8, 'PPS', trackNumber);

  const profilesWithExtensions = new Set([44, 83, 86, 100, 110, 118, 122, 128, 134, 135, 138, 139, 144]);
  if (offset < box.end) {
    if (!profilesWithExtensions.has(profile) || box.end - offset < 4) {
      throw new Error(`MP4 video trak ${trackNumber} avcC has unsupported trailing bytes.`);
    }
    if ((bytes[offset] & 0xfc) !== 0xfc || (bytes[offset + 1] & 0xf8) !== 0xf8 || (bytes[offset + 2] & 0xf8) !== 0xf8) {
      throw new Error(`MP4 video trak ${trackNumber} avcC extension reserved bits are malformed.`);
    }
    const extensionCount = bytes[offset + 3];
    offset = parseAvcParameterSets(bytes, offset + 4, box.end, extensionCount, 13, 'extended SPS', trackNumber);
  }
  if (offset !== box.end) throw new Error(`MP4 video trak ${trackNumber} avcC is not exactly bounded.`);
  return Object.freeze({ nalLengthBytes });
}

function parseAvcParameterSets(bytes, start, end, count, expectedNalType, label, trackNumber) {
  let offset = start;
  for (let index = 0; index < count; index += 1) {
    if (end - offset < 2) throw new Error(`MP4 video trak ${trackNumber} avcC ${label} length is truncated.`);
    const length = bytes.readUInt16BE(offset);
    offset += 2;
    if (
      length <= 1 ||
      length > end - offset ||
      (bytes[offset] & 0x80) !== 0 ||
      (bytes[offset] & 0x60) === 0 ||
      (bytes[offset] & 0x1f) !== expectedNalType
    ) {
      throw new Error(`MP4 video trak ${trackNumber} avcC ${label} is empty, truncated, or mistyped.`);
    }
    const payload = bytes.subarray(offset + 1, offset + length);
    if (expectedNalType === 7) validateSpsRbsp(payload, trackNumber);
    if (expectedNalType === 8) validatePpsRbsp(payload, trackNumber);
    offset += length;
  }
  return offset;
}

function parseTimeToSample(bytes, box, trackNumber) {
  requireVersionZeroFullBox(bytes, box, `video trak ${trackNumber} stts`);
  if (box.end - box.payloadStart < 8) throw new Error(`MP4 video trak ${trackNumber} stts is truncated.`);
  const entryCount = bytes.readUInt32BE(box.payloadStart + 4);
  if (entryCount === 0 || entryCount > MAX_MEDIA_SAMPLES || box.end - box.payloadStart !== 8 + entryCount * 8) {
    throw new Error(`MP4 video trak ${trackNumber} stts entry inventory is invalid.`);
  }
  let sampleCount = 0;
  let sampleTicks = 0;
  for (let index = 0; index < entryCount; index += 1) {
    const offset = box.payloadStart + 8 + index * 8;
    const count = bytes.readUInt32BE(offset);
    const delta = bytes.readUInt32BE(offset + 4);
    const runTicks = count * delta;
    if (
      count === 0 ||
      delta === 0 ||
      sampleCount + count > MAX_MEDIA_SAMPLES ||
      !Number.isSafeInteger(runTicks) ||
      !Number.isSafeInteger(sampleTicks + runTicks)
    ) {
      throw new Error(`MP4 video trak ${trackNumber} stts contains a nonpositive or excessive run.`);
    }
    sampleCount += count;
    sampleTicks += runTicks;
  }
  return Object.freeze({ sampleCount, sampleTicks });
}

function parseSampleSizes(bytes, box, trackNumber) {
  requireVersionZeroFullBox(bytes, box, `video trak ${trackNumber} stsz`);
  if (box.end - box.payloadStart < 12) throw new Error(`MP4 video trak ${trackNumber} stsz is truncated.`);
  const defaultSize = bytes.readUInt32BE(box.payloadStart + 4);
  const sampleCount = bytes.readUInt32BE(box.payloadStart + 8);
  const expectedLength = 12 + (defaultSize === 0 ? sampleCount * 4 : 0);
  if (sampleCount === 0 || sampleCount > MAX_MEDIA_SAMPLES || box.end - box.payloadStart !== expectedLength) {
    throw new Error(`MP4 video trak ${trackNumber} stsz sample inventory is invalid.`);
  }
  const sizes = [];
  let totalBytes = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const size = defaultSize || bytes.readUInt32BE(box.payloadStart + 12 + index * 4);
    if (size === 0 || totalBytes + size > MP4_MAX_BYTES) {
      throw new Error(`MP4 video trak ${trackNumber} stsz contains an empty or excessive sample.`);
    }
    sizes.push(size);
    totalBytes += size;
  }
  return Object.freeze(sizes);
}

function parseSampleToChunk(bytes, box, trackNumber) {
  requireVersionZeroFullBox(bytes, box, `video trak ${trackNumber} stsc`);
  if (box.end - box.payloadStart < 8) throw new Error(`MP4 video trak ${trackNumber} stsc is truncated.`);
  const entryCount = bytes.readUInt32BE(box.payloadStart + 4);
  if (entryCount === 0 || entryCount > MAX_MEDIA_SAMPLES || box.end - box.payloadStart !== 8 + entryCount * 12) {
    throw new Error(`MP4 video trak ${trackNumber} stsc entry inventory is invalid.`);
  }
  const entries = [];
  let previousFirstChunk = 0;
  for (let index = 0; index < entryCount; index += 1) {
    const offset = box.payloadStart + 8 + index * 12;
    const firstChunk = bytes.readUInt32BE(offset);
    const samplesPerChunk = bytes.readUInt32BE(offset + 4);
    const sampleDescriptionIndex = bytes.readUInt32BE(offset + 8);
    if (
      firstChunk <= previousFirstChunk ||
      (index === 0 && firstChunk !== 1) ||
      samplesPerChunk === 0 ||
      sampleDescriptionIndex !== 1
    ) {
      throw new Error(`MP4 video trak ${trackNumber} stsc mapping is malformed or ambiguous.`);
    }
    entries.push(Object.freeze({ firstChunk, samplesPerChunk }));
    previousFirstChunk = firstChunk;
  }
  return Object.freeze(entries);
}

function parseChunkOffsets(bytes, box, trackNumber) {
  requireVersionZeroFullBox(bytes, box, `video trak ${trackNumber} ${box.type}`);
  if (box.end - box.payloadStart < 8) throw new Error(`MP4 video trak ${trackNumber} ${box.type} is truncated.`);
  const entryCount = bytes.readUInt32BE(box.payloadStart + 4);
  const valueBytes = box.type === 'co64' ? 8 : 4;
  if (
    entryCount === 0 ||
    entryCount > MAX_MEDIA_SAMPLES ||
    box.end - box.payloadStart !== 8 + entryCount * valueBytes
  ) {
    throw new Error(`MP4 video trak ${trackNumber} ${box.type} entry inventory is invalid.`);
  }
  const offsets = [];
  let previous = -1;
  for (let index = 0; index < entryCount; index += 1) {
    const offset = box.payloadStart + 8 + index * valueBytes;
    const value =
      box.type === 'co64'
        ? exactUInt64(bytes, offset, `MP4 video trak ${trackNumber} co64 offset`)
        : bytes.readUInt32BE(offset);
    if (value <= previous) {
      throw new Error(`MP4 video trak ${trackNumber} chunk offsets are not strictly increasing.`);
    }
    offsets.push(value);
    previous = value;
  }
  return Object.freeze(offsets);
}

function mapSamplesToChunks(sampleToChunk, chunkOffsets, sampleSizes, trackNumber) {
  if (sampleToChunk.at(-1).firstChunk > chunkOffsets.length) {
    throw new Error(`MP4 video trak ${trackNumber} stsc refers beyond its chunk offset inventory.`);
  }
  const chunks = [];
  let mappingIndex = 0;
  let sampleIndex = 0;
  for (let chunkIndex = 0; chunkIndex < chunkOffsets.length; chunkIndex += 1) {
    const chunkNumber = chunkIndex + 1;
    while (sampleToChunk[mappingIndex + 1]?.firstChunk <= chunkNumber) mappingIndex += 1;
    const sampleCount = sampleToChunk[mappingIndex].samplesPerChunk;
    if (sampleIndex + sampleCount > sampleSizes.length) {
      throw new Error(`MP4 video trak ${trackNumber} stsc maps more samples than stsz declares.`);
    }
    let byteLength = 0;
    for (let index = 0; index < sampleCount; index += 1) byteLength += sampleSizes[sampleIndex + index];
    chunks.push(Object.freeze({ byteLength, offset: chunkOffsets[chunkIndex], sampleCount, sampleIndex }));
    sampleIndex += sampleCount;
  }
  if (sampleIndex !== sampleSizes.length) {
    throw new Error(`MP4 video trak ${trackNumber} stsc maps fewer samples than stsz declares.`);
  }
  return Object.freeze(chunks);
}

function validateChunkPayloads(bytes, chunks, sampleSizes, mdatBoxes, nalLengthBytes, trackNumber) {
  let previousEnd = -1;
  for (const chunk of chunks) {
    const chunkEnd = chunk.offset + chunk.byteLength;
    if (!Number.isSafeInteger(chunkEnd) || chunk.offset < previousEnd) {
      throw new Error(`MP4 video trak ${trackNumber} chunk ranges overlap or are not exactly bounded.`);
    }
    const matchingDataBoxes = mdatBoxes.filter(
      (box) => box.payloadStart < box.end && chunk.offset >= box.payloadStart && chunkEnd <= box.end
    );
    if (matchingDataBoxes.length !== 1) {
      throw new Error(`MP4 video trak ${trackNumber} chunk range is not inside one nonempty mdat payload.`);
    }
    let sampleOffset = chunk.offset;
    for (let index = 0; index < chunk.sampleCount; index += 1) {
      const sampleSize = sampleSizes[chunk.sampleIndex + index];
      const sampleEnd = sampleOffset + sampleSize;
      validateAvcSample(bytes.subarray(sampleOffset, sampleEnd), nalLengthBytes, trackNumber);
      sampleOffset = sampleEnd;
    }
    if (sampleOffset !== chunkEnd)
      throw new Error(`MP4 video trak ${trackNumber} sample sizes do not cover the chunk.`);
    previousEnd = chunkEnd;
  }
}

function validateAvcSample(sample, nalLengthBytes, trackNumber) {
  let offset = 0;
  let nalUnits = 0;
  let sawVideoCodingLayer = false;
  while (offset < sample.length) {
    if (sample.length - offset < nalLengthBytes || ++nalUnits > MAX_NAL_UNITS_PER_SAMPLE) {
      throw new Error(`MP4 video trak ${trackNumber} AVC sample NAL inventory is truncated or excessive.`);
    }
    const nalBytes = sample.readUIntBE(offset, nalLengthBytes);
    offset += nalLengthBytes;
    if (nalBytes === 0 || nalBytes > sample.length - offset) {
      throw new Error(`MP4 video trak ${trackNumber} AVC sample has an empty or escaping NAL unit.`);
    }
    const nalHeader = sample[offset];
    const nalType = nalHeader & 0x1f;
    if ((nalHeader & 0x80) !== 0 || nalType === 0 || nalType > 23) {
      throw new Error(`MP4 video trak ${trackNumber} AVC sample has an invalid NAL header.`);
    }
    if (nalType >= 1 && nalType <= 5 && nalBytes > 1) {
      validateSliceRbsp(sample.subarray(offset + 1, offset + nalBytes), trackNumber);
      sawVideoCodingLayer = true;
    }
    offset += nalBytes;
  }
  if (offset !== sample.length || nalUnits === 0 || !sawVideoCodingLayer) {
    throw new Error(`MP4 video trak ${trackNumber} AVC sample lacks exact VCL NAL coverage.`);
  }
}

function validateSpsRbsp(source, trackNumber) {
  const bits = new BoundedBitReader(decodeRbsp(source, `video trak ${trackNumber} SPS`));
  const profile = bits.readBits(8);
  const constraints = bits.readBits(8);
  bits.readBits(8);
  if (profile === 0 || (constraints & 0x03) !== 0 || bits.readUnsignedExpGolomb() > 31) {
    throw new Error(`MP4 video trak ${trackNumber} SPS header is malformed.`);
  }
  if (new Set([44, 83, 86, 100, 110, 118, 122, 128, 134, 135, 138, 139, 144]).has(profile)) {
    const chromaFormat = bits.readUnsignedExpGolomb();
    if (chromaFormat > 3) throw new Error(`MP4 video trak ${trackNumber} SPS chroma format is invalid.`);
    if (chromaFormat === 3) bits.readBit();
    if (bits.readUnsignedExpGolomb() > 6 || bits.readUnsignedExpGolomb() > 6) {
      throw new Error(`MP4 video trak ${trackNumber} SPS bit depth is excessive.`);
    }
    bits.readBit();
    if (bits.readBit() !== 0) {
      throw new Error(`MP4 video trak ${trackNumber} SPS scaling matrices are outside the bounded profile.`);
    }
  }
  if (bits.readUnsignedExpGolomb() > 12) {
    throw new Error(`MP4 video trak ${trackNumber} SPS frame-number bound is invalid.`);
  }
  const pictureOrderCountType = bits.readUnsignedExpGolomb();
  if (pictureOrderCountType === 0) {
    if (bits.readUnsignedExpGolomb() > 12) {
      throw new Error(`MP4 video trak ${trackNumber} SPS picture-order bound is invalid.`);
    }
  } else if (pictureOrderCountType === 1) {
    bits.readBit();
    bits.readSignedExpGolomb();
    bits.readSignedExpGolomb();
    const cycleCount = bits.readUnsignedExpGolomb();
    if (cycleCount > 255) throw new Error(`MP4 video trak ${trackNumber} SPS picture-order cycle is excessive.`);
    for (let index = 0; index < cycleCount; index += 1) bits.readSignedExpGolomb();
  } else if (pictureOrderCountType !== 2) {
    throw new Error(`MP4 video trak ${trackNumber} SPS picture-order type is invalid.`);
  }
  if (bits.readUnsignedExpGolomb() > 16) {
    throw new Error(`MP4 video trak ${trackNumber} SPS reference-frame count is excessive.`);
  }
  bits.readBit();
  if (bits.readUnsignedExpGolomb() > 6249 || bits.readUnsignedExpGolomb() > 6249) {
    throw new Error(`MP4 video trak ${trackNumber} SPS macroblock dimensions are excessive.`);
  }
  if (bits.readBit() === 0) bits.readBit();
  bits.readBit();
  if (bits.readBit() !== 0) {
    for (let index = 0; index < 4; index += 1) {
      if (bits.readUnsignedExpGolomb() > MAX_DIMENSION) {
        throw new Error(`MP4 video trak ${trackNumber} SPS crop is excessive.`);
      }
    }
  }
  bits.readBit();
}

function validatePpsRbsp(source, trackNumber) {
  const bits = new BoundedBitReader(decodeRbsp(source, `video trak ${trackNumber} PPS`));
  if (bits.readUnsignedExpGolomb() > 255 || bits.readUnsignedExpGolomb() > 31) {
    throw new Error(`MP4 video trak ${trackNumber} PPS identifiers are excessive.`);
  }
  bits.readBit();
  bits.readBit();
  if (bits.readUnsignedExpGolomb() !== 0) {
    throw new Error(`MP4 video trak ${trackNumber} PPS slice groups are outside the bounded profile.`);
  }
  if (bits.readUnsignedExpGolomb() > 31 || bits.readUnsignedExpGolomb() > 31) {
    throw new Error(`MP4 video trak ${trackNumber} PPS reference-index count is excessive.`);
  }
  bits.readBit();
  bits.readBits(2);
  for (let index = 0; index < 3; index += 1) {
    if (Math.abs(bits.readSignedExpGolomb()) > 51) {
      throw new Error(`MP4 video trak ${trackNumber} PPS quantizer offset is excessive.`);
    }
  }
  bits.readBit();
  bits.readBit();
  bits.readBit();
}

function validateSliceRbsp(source, trackNumber) {
  const bits = new BoundedBitReader(decodeRbsp(source, `video trak ${trackNumber} VCL sample`));
  if (
    bits.readUnsignedExpGolomb() > MAX_MEDIA_SAMPLES ||
    bits.readUnsignedExpGolomb() > 9 ||
    bits.readUnsignedExpGolomb() > 255
  ) {
    throw new Error(`MP4 video trak ${trackNumber} VCL slice header is malformed.`);
  }
}

function decodeRbsp(source, label) {
  const input = source.subarray(0, MAX_RBSP_PROBE_BYTES);
  const output = [];
  let zeroCount = 0;
  for (let index = 0; index < input.length; index += 1) {
    const byte = input[index];
    if (zeroCount >= 2 && byte <= 3) {
      if (byte !== 3 || index + 1 >= input.length || input[index + 1] > 3) {
        throw new Error(`MP4 ${label} has malformed RBSP emulation prevention.`);
      }
      zeroCount = 0;
      continue;
    }
    output.push(byte);
    zeroCount = byte === 0 ? zeroCount + 1 : 0;
  }
  if (output.length === 0) throw new Error(`MP4 ${label} has no retained RBSP payload.`);
  return Buffer.from(output);
}

class BoundedBitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }

  readBit() {
    if (this.offset >= this.bytes.length * 8) throw new Error('MP4 AVC RBSP syntax is truncated.');
    const value = (this.bytes[Math.floor(this.offset / 8)] >> (7 - (this.offset % 8))) & 1;
    this.offset += 1;
    return value;
  }

  readBits(count) {
    let value = 0;
    for (let index = 0; index < count; index += 1) value = value * 2 + this.readBit();
    return value;
  }

  readUnsignedExpGolomb() {
    let leadingZeroes = 0;
    while (this.readBit() === 0) {
      leadingZeroes += 1;
      if (leadingZeroes > 30) throw new Error('MP4 AVC Exp-Golomb value exceeds its exact bound.');
    }
    return 2 ** leadingZeroes - 1 + this.readBits(leadingZeroes);
  }

  readSignedExpGolomb() {
    const value = this.readUnsignedExpGolomb();
    return value % 2 === 0 ? -(value / 2) : (value + 1) / 2;
  }
}

function parseMediaDuration(bytes, box, trackNumber) {
  const payloadLength = box.end - box.payloadStart;
  const version = bytes[box.payloadStart];
  let timescale;
  let duration;
  if (version === 0 && payloadLength === 24 && bytes.readUInt32BE(box.payloadStart) === 0) {
    timescale = bytes.readUInt32BE(box.payloadStart + 12);
    duration = bytes.readUInt32BE(box.payloadStart + 16);
  } else if (version === 1 && payloadLength === 36 && bytes.readUIntBE(box.payloadStart + 1, 3) === 0) {
    timescale = bytes.readUInt32BE(box.payloadStart + 20);
    duration = exactUInt64(bytes, box.payloadStart + 24, `MP4 video trak ${trackNumber} mdhd duration`);
  } else {
    throw new Error(`MP4 video trak ${trackNumber} mdhd version or size is malformed.`);
  }
  if (timescale === 0 || duration <= 0) {
    throw new Error(`MP4 video trak ${trackNumber} mdhd duration or timescale is not positive.`);
  }
  const durationSeconds = duration / timescale;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`MP4 video trak ${trackNumber} mdhd duration is not finite and positive.`);
  }
  const languageOffset = box.payloadStart + (version === 0 ? 20 : 32);
  const language = bytes.readUInt16BE(languageOffset);
  if (!isPackedIso639Language(language) || bytes.readUInt16BE(languageOffset + 2) !== 0) {
    throw new Error(`MP4 video trak ${trackNumber} mdhd language or pre_defined field is invalid.`);
  }
  return Object.freeze({ durationSeconds, timescale });
}

function rejectMisplacedEditLists(boxes, label) {
  if (boxesOfType(boxes, 'elst').length !== 0) {
    throw new Error(`MP4 ${label} contains an unsupported elst box.`);
  }
}

function allZero(bytes, start, end) {
  for (let offset = start; offset < end; offset += 1) {
    if (bytes[offset] !== 0) return false;
  }
  return true;
}

function hasIdentityTransformationMatrix(bytes, start) {
  return IDENTITY_TRANSFORMATION_MATRIX.every((value, index) => bytes.readUInt32BE(start + index * 4) === value);
}

function isPackedIso639Language(value) {
  if (value === 0 || (value & 0x8000) !== 0) return false;
  return [10, 5, 0].every((shift) => {
    const character = (value >> shift) & 0x1f;
    return character >= 1 && character <= 26;
  });
}

function requireVersionZeroFullBox(bytes, box, label) {
  if (box.end - box.payloadStart < 4 || bytes.readUInt32BE(box.payloadStart) !== 0) {
    throw new Error(`MP4 ${label} full-box version or flags are malformed.`);
  }
}

function exactUInt64(bytes, offset, label) {
  const value = bytes.readBigUInt64BE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} is not exactly representable.`);
  return Number(value);
}

function exactBytes(value, label) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new Error(`${label} bytes are unavailable.`);
  }
  return Buffer.from(value);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

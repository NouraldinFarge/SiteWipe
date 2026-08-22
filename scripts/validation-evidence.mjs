import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const VALIDATION_EVIDENCE_POINTER_PATH = 'docs/evidence/automated-validation-current.json';

const VALIDATION_RECORD_PATTERN =
  /^automated-validation-(\d{4}-\d{2}-\d{2})(?:-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)))?\.json$/;
const SEMANTIC_VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

export async function resolveCurrentValidationEvidence(root) {
  const pointer = parseJson(
    await readFile(resolve(root, VALIDATION_EVIDENCE_POINTER_PATH), 'utf8'),
    VALIDATION_EVIDENCE_POINTER_PATH
  );
  const record = String(pointer?.record || '');
  const match = VALIDATION_RECORD_PATTERN.exec(record);
  if (!match) {
    throw new Error(
      `${VALIDATION_EVIDENCE_POINTER_PATH} does not name a valid dated or version-qualified validation record.`
    );
  }
  const [, recordDate, recordVersion = null] = match;
  const pointerVersion = pointer?.version == null ? null : assertSemanticVersion(pointer.version, 'pointer version');
  if (pointerVersion && recordVersion && pointerVersion !== recordVersion) {
    throw new Error(`${VALIDATION_EVIDENCE_POINTER_PATH} version ${pointerVersion} does not match record ${record}.`);
  }
  return {
    pointer,
    pointerPath: VALIDATION_EVIDENCE_POINTER_PATH,
    pointerVersion,
    record,
    recordDate,
    recordVersion,
    relativePath: `docs/evidence/${record}`,
    absolutePath: resolve(root, 'docs', 'evidence', record)
  };
}

export async function planValidationEvidenceVersionTransition(root, { previousVersion, nextVersion, date }) {
  const previous = assertSemanticVersion(previousVersion, 'previous validation version');
  const next = assertSemanticVersion(nextVersion, 'next validation version');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw new Error('Validation evidence date must use YYYY-MM-DD form.');
  }

  const current = await resolveCurrentValidationEvidence(root);
  if (current.recordVersion && current.recordVersion !== previous) {
    throw new Error(
      `Current validation record ${current.record} is version-qualified for ${current.recordVersion}, not ${previous}.`
    );
  }
  if (current.pointerVersion && current.pointerVersion !== previous) {
    throw new Error(
      `Current validation pointer identifies ${current.pointerVersion}, not previous version ${previous}.`
    );
  }

  const previousBytes = await readFile(current.absolutePath, 'utf8');
  const previousEvidence = parseJson(previousBytes, current.relativePath);
  const recordedVersion = String(previousEvidence?.fullCheck?.versionContract?.version || '');
  if (recordedVersion !== previous) {
    throw new Error(
      `Current validation record ${current.record} is bound to ${recordedVersion || 'no version'}, not ${previous}.`
    );
  }

  const previousRecord = validationEvidenceRecordName(current.recordDate, previous);
  const previousRelativePath = `docs/evidence/${previousRecord}`;
  const nextRecord = validationEvidenceRecordName(date, next);
  const nextRelativePath = `docs/evidence/${nextRecord}`;
  if (previousRelativePath === nextRelativePath) {
    throw new Error('Previous and next validation evidence records must be distinct.');
  }

  const historicalCreations = new Map();
  if (current.relativePath !== previousRelativePath) {
    historicalCreations.set(previousRelativePath, previousBytes);
  }

  return {
    current,
    previousBytes,
    previousEvidence,
    previousRecord,
    previousRelativePath,
    nextRecord,
    nextRelativePath,
    historicalCreations,
    pointer: {
      ...current.pointer,
      schemaVersion: current.pointer?.schemaVersion || 1,
      version: next,
      record: nextRecord
    },
    baseline: {
      beforeState: `The ${previous} record remains unchanged in ${previousRecord}.`,
      baselineVersion: previous,
      baselineRecord: previousRelativePath
    },
    previousVersion: previous,
    nextVersion: next
  };
}

export function stageValidationEvidenceVersionTransition(updates, transition, nextEvidence) {
  const nextRecordVersion = String(nextEvidence?.fullCheck?.versionContract?.version || '');
  if (nextRecordVersion !== transition.nextVersion) {
    throw new Error(
      `Next validation record is bound to ${nextRecordVersion || 'no version'}, not ${transition.nextVersion}.`
    );
  }

  const createOnlyPaths = new Set();
  for (const [path, bytes] of transition.historicalCreations) {
    queueUnique(updates, path, bytes);
    createOnlyPaths.add(path);
  }

  const nextRecord = { ...nextEvidence, baseline: transition.baseline };
  queueUnique(updates, transition.nextRelativePath, serializeJson(nextRecord));
  createOnlyPaths.add(transition.nextRelativePath);
  queueUnique(updates, transition.current.pointerPath, serializeJson(transition.pointer));
  return createOnlyPaths;
}

export function validationEvidenceRecordName(date, version) {
  const normalizedDate = String(date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) {
    throw new Error('Validation evidence date must use YYYY-MM-DD form.');
  }
  return `automated-validation-${normalizedDate}-v${assertSemanticVersion(version, 'validation version')}.json`;
}

function queueUnique(updates, path, value) {
  if (updates.has(path)) throw new Error(`Validation evidence transaction already contains ${path}.`);
  updates.set(path, value);
}

function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Cannot parse validation evidence JSON: ${label}`, { cause: error });
  }
}

function assertSemanticVersion(value, label) {
  const normalized = String(value || '');
  if (!SEMANTIC_VERSION_PATTERN.test(normalized)) {
    throw new Error(`${label} must use numeric major.minor.patch form without leading zeroes.`);
  }
  return normalized;
}

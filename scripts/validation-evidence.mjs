import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const POINTER_PATH = 'docs/evidence/automated-validation-current.json';

export async function resolveCurrentValidationEvidence(root) {
  const pointer = JSON.parse(await readFile(resolve(root, POINTER_PATH), 'utf8'));
  const record = String(pointer?.record || '');
  if (!/^automated-validation-\d{4}-\d{2}-\d{2}\.json$/.test(record)) {
    throw new Error(`${POINTER_PATH} does not name a valid dated validation record.`);
  }
  return {
    pointerPath: POINTER_PATH,
    record,
    relativePath: `docs/evidence/${record}`,
    absolutePath: resolve(root, 'docs', 'evidence', record)
  };
}

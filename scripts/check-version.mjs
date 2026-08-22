import { resolve } from 'node:path';

import { validateArtifactDirectory, validateVersionContract, VersionContractError } from './version-contract-check.mjs';
import { projectRoot } from './versioning.mjs';

const requireArtifact = process.argv.includes('--require-artifact');
const artifactDirectory = resolveArtifactDirectory();

try {
  const result = await validateVersionContract({ root: projectRoot, requireArtifact, artifactDirectory });
  console.log(result.message);
} catch (error) {
  if (!(error instanceof VersionContractError)) throw error;
  console.error(error.errors.map((message) => `- ${message}`).join('\n'));
  process.exitCode = 1;
}

function resolveArtifactDirectory() {
  const index = process.argv.indexOf('--artifact-dir');
  const requested = index >= 0 ? process.argv[index + 1] : resolve(projectRoot, 'dist', 'current');
  if (!requested) throw new Error('--artifact-dir requires a path.');
  return validateArtifactDirectory(projectRoot, requested);
}

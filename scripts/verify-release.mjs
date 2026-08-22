import { verifyReleaseCandidate } from './release-artifact-verification.mjs';

try {
  console.log(JSON.stringify(await verifyReleaseCandidate(), null, 2));
} catch (error) {
  console.error(error?.message || String(error));
  process.exitCode = 1;
}

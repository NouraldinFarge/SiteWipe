import { createHash } from 'node:crypto';

export function assertDependencyInventoryMatchesLockfile(evidence, lockfileBytes) {
  const expected = sha256(lockfileBytes);
  if (evidence?.lockfileSha256 !== expected) {
    throw new Error(
      'Dependency-license evidence is stale for the pre-bump package-lock.json. Re-run and review the dependency inventory before changing the version.'
    );
  }
  return expected;
}

export function collectDirectDevelopmentDependencyTuples(pkg, lock) {
  const declared = pkg?.devDependencies || {};
  const lockedDeclared = lock?.packages?.['']?.devDependencies || {};
  if (JSON.stringify(sortedEntries(declared)) !== JSON.stringify(sortedEntries(lockedDeclared))) {
    throw new Error('package.json and package-lock.json direct development dependencies differ');
  }

  return Object.entries(declared)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, requestedVersion]) => {
      const locked = lock?.packages?.[`node_modules/${name}`];
      if (!locked || typeof locked.version !== 'string') {
        throw new Error(`Direct development dependency is missing from the lockfile: ${name}`);
      }
      if (requestedVersion !== locked.version) {
        throw new Error(
          `Direct development dependency ${name} must be pinned exactly to locked version ${locked.version}; found ${requestedVersion}`
        );
      }
      const license = typeof locked.license === 'string' && locked.license.trim() ? locked.license.trim() : 'MISSING';
      return { name, version: locked.version, license };
    });
}

export function normalizeDirectDevelopmentDependencyTuples(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => ({
      name: String(entry?.name || ''),
      version: String(entry?.version || ''),
      license: String(entry?.license || '')
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function assertDirectDevelopmentDependencyTuplesMatchEvidence(pkg, lock, evidence) {
  const actual = collectDirectDevelopmentDependencyTuples(pkg, lock);
  const recorded = normalizeDirectDevelopmentDependencyTuples(evidence?.directDevelopmentDependencies);
  if (JSON.stringify(actual) !== JSON.stringify(recorded)) {
    throw new Error('Direct development dependency name/version/license tuples differ from the reviewed evidence');
  }
  return actual;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex').toUpperCase();
}

function sortedEntries(value) {
  return Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
}

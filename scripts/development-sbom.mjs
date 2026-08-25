import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

export async function inspectDevelopmentSbom({ root, path, expectedName, expectedVersion }) {
  const absolute = resolve(root, path);
  const outputRoot = resolve(root, 'validation-output');
  const child = relative(outputRoot, absolute);
  if (!child || child === '..' || child.startsWith(`..${sep}`)) {
    throw new Error('Development SBOM must be a file beneath the project validation-output directory.');
  }
  const outputInfo = await lstat(outputRoot);
  if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink()) {
    throw new Error('Development SBOM output root must be a physical directory.');
  }
  const fileInfo = await lstat(absolute);
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.nlink !== 1) {
    throw new Error('Development SBOM must be a single-link physical file.');
  }
  const [physicalRoot, physicalFile] = await Promise.all([realpath(outputRoot), realpath(absolute)]);
  const physicalChild = relative(physicalRoot, physicalFile);
  if (
    !samePath(outputRoot, physicalRoot) ||
    !samePath(absolute, physicalFile) ||
    !physicalChild ||
    physicalChild === '..' ||
    physicalChild.startsWith(`..${sep}`)
  ) {
    throw new Error('Development SBOM path traverses a symbolic link, junction, or alias.');
  }

  const bytes = await readFile(absolute);
  if (!bytes.length) throw new Error('Development SBOM is empty.');
  let sbom;
  try {
    sbom = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error('Development SBOM is not valid JSON.', { cause: error });
  }

  if (sbom.bomFormat !== 'CycloneDX') throw new Error('Development SBOM format is not CycloneDX.');
  if (sbom.specVersion !== '1.6') throw new Error(`Development SBOM spec version is stale: ${sbom.specVersion}`);
  if (sbom.metadata?.component?.name !== expectedName) {
    throw new Error(`Development SBOM component name is stale: ${sbom.metadata?.component?.name}`);
  }
  if (sbom.metadata?.component?.version !== expectedVersion) {
    throw new Error(`Development SBOM component version is stale: ${sbom.metadata?.component?.version}`);
  }
  if (!Array.isArray(sbom.components) || sbom.components.length === 0) {
    throw new Error('Development SBOM has no component inventory.');
  }
  if (!Array.isArray(sbom.dependencies) || sbom.dependencies.length === 0) {
    throw new Error('Development SBOM has no dependency graph.');
  }

  return {
    path: relative(root, absolute).split(sep).join('/'),
    bomFormat: sbom.bomFormat,
    specVersion: sbom.specVersion,
    componentName: sbom.metadata.component.name,
    componentVersion: sbom.metadata.component.version,
    components: sbom.components.length,
    dependencyNodes: sbom.dependencies.length,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex').toUpperCase()
  };
}

function samePath(left, right) {
  const first = resolve(left);
  const second = resolve(right);
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}

export function assertDevelopmentSbomEvidenceMatches(evidence, inspection) {
  const fields = [
    'path',
    'bomFormat',
    'specVersion',
    'componentVersion',
    'components',
    'dependencyNodes',
    'bytes',
    'sha256'
  ];
  const mismatches = fields.filter((field) => evidence?.[field] !== inspection?.[field]);
  if (mismatches.length) {
    throw new Error(`Development SBOM evidence differs from the concrete file: ${mismatches.join(', ')}`);
  }
}

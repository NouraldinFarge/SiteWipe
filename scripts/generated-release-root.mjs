import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const GENERATED_RELEASE_ROOT_MARKER = '.sitewipe-generated-release-root.json';

const MARKER = Object.freeze({
  schema: 'sitewipe.generated-release-root.v1',
  owner: 'scripts/build-release.mjs',
  recursiveDeletionScope: 'fixed-child-directories-only'
});
const MARKER_BYTES = `${JSON.stringify(MARKER, null, 2)}\n`;
const ALLOWED_CHILDREN = new Set(['.current-staging', '.current-previous', 'current']);

/**
 * Claims only a missing or physically empty dist directory. A non-empty
 * unmarked directory is never adopted as generated output.
 */
export async function ensureGeneratedReleaseRoot(distRoot) {
  const root = resolve(distRoot);
  try {
    await mkdir(root, { recursive: false });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  await assertPhysicalDirectory(root, 'Generated release root');
  const entries = await readdir(root);
  const markerPath = resolve(root, GENERATED_RELEASE_ROOT_MARKER);
  if (!entries.includes(GENERATED_RELEASE_ROOT_MARKER)) {
    if (entries.length) {
      throw new Error(`Refusing to adopt a non-empty unmarked generated release root: ${root}`);
    }
    await writeFile(markerPath, MARKER_BYTES, { encoding: 'utf8', flag: 'wx' });
  }
  await assertMarker(markerPath);
  await assertAllowedRootEntries(root);
  return root;
}

export async function assertGeneratedReleaseChild(distRoot, childName, { allowMissing = true } = {}) {
  const root = await assertGeneratedReleaseRoot(distRoot);
  if (!ALLOWED_CHILDREN.has(childName)) {
    throw new Error(`Refusing generated release-directory operation for unknown child: ${childName}`);
  }
  const child = resolve(root, childName);
  assertDescendant(root, child, 'Generated release child');
  let info;
  try {
    info = await lstat(child);
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return child;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Generated release child is not a physical directory: ${child}`);
  }
  await assertPhysicalDirectory(child, 'Generated release child');
  await assertSafeGeneratedTree(root, child);
  return child;
}

export async function removeGeneratedReleaseChild(distRoot, childName) {
  const child = await assertGeneratedReleaseChild(distRoot, childName, { allowMissing: true });
  try {
    await lstat(child);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  await rm(child, { recursive: true, force: false });
}

export async function createGeneratedReleaseChild(distRoot, childName) {
  const child = await assertGeneratedReleaseChild(distRoot, childName, { allowMissing: true });
  try {
    await mkdir(child, { recursive: false });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`Generated release child already exists: ${child}`, { cause: error });
    }
    throw error;
  }
  await assertPhysicalDirectory(child, 'Generated release child');
  return child;
}

async function assertGeneratedReleaseRoot(distRoot) {
  const root = resolve(distRoot);
  await assertPhysicalDirectory(root, 'Generated release root');
  await assertMarker(resolve(root, GENERATED_RELEASE_ROOT_MARKER));
  await assertAllowedRootEntries(root);
  return root;
}

async function assertMarker(markerPath) {
  const info = await lstat(markerPath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    throw new Error(`Generated release ownership marker is not a single-link regular file: ${markerPath}`);
  }
  const bytes = await readFile(markerPath, 'utf8');
  if (bytes !== MARKER_BYTES) {
    throw new Error(`Generated release ownership marker has unexpected bytes: ${markerPath}`);
  }
}

async function assertAllowedRootEntries(root) {
  const entries = await readdir(root);
  for (const name of entries) {
    if (name !== GENERATED_RELEASE_ROOT_MARKER && !ALLOWED_CHILDREN.has(name)) {
      throw new Error(`Generated release root contains an unowned entry: ${name}`);
    }
  }
}

async function assertSafeGeneratedTree(root, directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    assertDescendant(root, path, 'Generated release entry');
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new Error(`Generated release tree contains a symbolic link or junction: ${path}`);
    }
    if (info.isDirectory()) {
      await assertPhysicalDirectory(path, 'Generated release directory');
      await assertSafeGeneratedTree(root, path);
      continue;
    }
    if (!info.isFile() || info.nlink !== 1) {
      throw new Error(`Generated release tree contains a non-regular or multiply linked file: ${path}`);
    }
  }
}

async function assertPhysicalDirectory(path, label) {
  const exact = resolve(path);
  const info = await lstat(exact);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} is not a physical directory: ${exact}`);
  }
  const physical = await realpath(exact);
  if (!samePath(exact, physical)) {
    throw new Error(`${label} traverses a symbolic link, junction, or alias: ${exact} != ${physical}`);
  }
}

function assertDescendant(parent, child, label) {
  const relation = relative(resolve(parent), resolve(child));
  if (!relation || relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`${label} escapes or equals its owned root: ${child}`);
  }
}

function samePath(left, right) {
  const first = resolve(left);
  const second = resolve(right);
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Resolves and re-hashes Git without consulting PATH. Default candidates are
 * fixed, administrator-controlled system installation locations. Environment
 * or caller-selected executable paths are intentionally unsupported.
 *
 * This function deliberately has no identity cache. Every caller observes the
 * executable bytes that exist at the moment of use.
 */
export function resolveTrustedGitExecutable({ root, platform = process.platform } = {}) {
  const projectRoot = resolve(root);
  if (process.env.SITEWIPE_GIT_EXECUTABLE || process.env.SITEWIPE_GIT_EXECUTABLE_SHA256) {
    throw new Error(
      'Custom Git executable overrides are prohibited for release provenance; use the fixed system tool policy.'
    );
  }
  const requestedCandidates = defaultGitCandidates(platform);
  const available = requestedCandidates.filter((candidate) => isAbsolute(candidate) && existsSync(candidate));
  if (!available.length) {
    throw new Error('No trusted absolute Git executable was found; PATH lookup is intentionally disabled.');
  }
  const requestedExecutable = available[0];
  if (lstatSync(requestedExecutable).isSymbolicLink()) {
    throw new Error(`Trusted Git candidate cannot be a symbolic link: ${requestedExecutable}`);
  }
  const executable = realpathSync(requestedExecutable);
  const info = lstatSync(executable);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Trusted Git candidate is not a regular file: ${executable}`);
  }
  if (isWithin(projectRoot, executable)) {
    throw new Error(`Trusted Git executable cannot be loaded from the project worktree: ${executable}`);
  }
  const sha256 = hashFile(executable);
  const version = execFileSync(executable, ['--version'], {
    encoding: 'utf8',
    env: trustedGitEnvironment({ platform }),
    maxBuffer: 1024 * 1024,
    windowsHide: true
  }).trim();
  if (!/^git version \d+\.\d+/.test(version)) {
    throw new Error(`Trusted Git executable returned an invalid identity: ${version}`);
  }
  if (hashFile(executable) !== sha256) {
    throw new Error('Trusted Git executable changed while its identity was being established.');
  }

  return Object.freeze({ path: executable, sha256, version });
}

/**
 * Runs an absolute, freshly re-hashed Git executable with replacement objects,
 * inherited Git configuration/environment, hooks, fsmonitor, and the untracked
 * cache disabled. Callers cannot weaken these global controls through args.
 */
export function runTrustedGit({ root, args, encoding = 'buffer', maxBuffer = GIT_MAX_BUFFER } = {}) {
  const projectRoot = resolve(root);
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) {
    throw new TypeError('Trusted Git arguments must be an array of strings.');
  }
  const git = resolveTrustedGitExecutable({ root: projectRoot });
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const controlledArgs = [
    '--no-replace-objects',
    '--literal-pathspecs',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'core.untrackedCache=false',
    '-c',
    `core.excludesFile=${nullDevice}`,
    '-c',
    `core.hooksPath=${nullDevice}`,
    '-C',
    projectRoot,
    ...args
  ];
  const result = execFileSync(git.path, controlledArgs, {
    encoding,
    env: trustedGitEnvironment(),
    maxBuffer,
    windowsHide: true
  });
  assertTrustedGitExecutableUnchanged(git);
  return result;
}

export function assertTrustedGitExecutableUnchanged(identity) {
  if (
    !identity ||
    !isAbsolute(identity.path || '') ||
    !/^[A-F0-9]{64}$/.test(identity.sha256 || '') ||
    hashFile(identity.path) !== identity.sha256
  ) {
    throw new Error('Trusted Git executable changed after identity validation.');
  }
}

/**
 * Binds the requested worktree to its physical .git control path and physical
 * common directory. A caller-provided GIT_DIR/GIT_WORK_TREE cannot redirect the
 * snapshot, and junction/symlink aliases in the repository metadata path fail
 * closed.
 */
export function assertTrustedGitRepository(root) {
  const requested = resolve(root);
  assertCanonicalPath(requested, 'Git worktree');
  const output = runTrustedGit({
    root: requested,
    args: ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'],
    encoding: 'utf8'
  });
  const lines = output.trim().split(/\r?\n/);
  if (lines.length !== 3) throw new Error('Git returned an invalid repository identity record.');
  const [reportedGitDir, reportedCommonDir, reportedRoot] = lines.map((value) => resolve(value));
  if (!samePath(requested, reportedRoot)) {
    throw new Error(`Source archive root must be the Git worktree root: ${requested} != ${reportedRoot}`);
  }

  const dotGit = resolve(requested, '.git');
  const dotGitInfo = lstatSync(dotGit);
  if (dotGitInfo.isSymbolicLink()) throw new Error(`Git control path cannot be a symbolic link: ${dotGit}`);
  let expectedGitDir;
  if (dotGitInfo.isDirectory()) {
    expectedGitDir = dotGit;
  } else if (dotGitInfo.isFile()) {
    const control = readFileSync(dotGit, 'utf8');
    const match = control.match(/^gitdir: ([^\r\n]+)\r?\n?$/);
    if (!match) throw new Error(`Git worktree control file is malformed: ${dotGit}`);
    expectedGitDir = isAbsolute(match[1]) ? resolve(match[1]) : resolve(dirname(dotGit), match[1]);
  } else {
    throw new Error(`Git control path is not a regular file or directory: ${dotGit}`);
  }
  assertCanonicalPath(expectedGitDir, 'Git metadata directory');
  if (!samePath(expectedGitDir, reportedGitDir)) {
    throw new Error('Git metadata directory does not match the physical worktree control path.');
  }

  const commonControl = resolve(expectedGitDir, 'commondir');
  let expectedCommonDir = expectedGitDir;
  if (existsSync(commonControl)) {
    const commonInfo = lstatSync(commonControl);
    if (!commonInfo.isFile() || commonInfo.isSymbolicLink()) {
      throw new Error(`Git common-directory control is not a regular file: ${commonControl}`);
    }
    const commonReference = readFileSync(commonControl, 'utf8').trim();
    if (!commonReference || /[\r\n]/.test(commonReference)) {
      throw new Error(`Git common-directory control is malformed: ${commonControl}`);
    }
    expectedCommonDir = isAbsolute(commonReference)
      ? resolve(commonReference)
      : resolve(expectedGitDir, commonReference);
  }
  assertCanonicalPath(expectedCommonDir, 'Git common metadata directory');
  if (!samePath(expectedCommonDir, reportedCommonDir)) {
    throw new Error('Git common metadata directory does not match its physical control path.');
  }

  return Object.freeze({ root: requested, gitDir: reportedGitDir, commonDir: reportedCommonDir });
}

function trustedGitEnvironment({ source = process.env, platform = process.platform } = {}) {
  const environment = {};
  for (const name of ['SystemRoot', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR']) {
    if (typeof source[name] === 'string' && source[name]) environment[name] = source[name];
  }
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_CONFIG_GLOBAL = platform === 'win32' ? 'NUL' : '/dev/null';
  environment.GIT_OPTIONAL_LOCKS = '0';
  environment.GIT_TERMINAL_PROMPT = '0';
  environment.LC_ALL = 'C';
  environment.LANG = 'C';
  return environment;
}

function defaultGitCandidates(platform) {
  if (platform === 'win32') {
    return [
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files\\Git\\bin\\git.exe',
      'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
      'C:\\Program Files (x86)\\Git\\bin\\git.exe'
    ];
  }
  if (platform === 'darwin') return ['/usr/bin/git'];
  return ['/usr/bin/git'];
}

function assertCanonicalPath(path, label) {
  const exact = resolve(path);
  const info = lstatSync(exact);
  if ((!info.isDirectory() && !info.isFile()) || info.isSymbolicLink()) {
    throw new Error(`${label} is not a physical regular path: ${exact}`);
  }
  const physical = realpathSync(exact);
  if (!samePath(exact, physical)) {
    throw new Error(`${label} traverses a symbolic link, junction, or alias: ${exact} != ${physical}`);
  }
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase();
}

function samePath(left, right) {
  const first = resolve(left);
  const second = resolve(right);
  return process.platform === 'win32' ? first.toLowerCase() === second.toLowerCase() : first === second;
}

function isWithin(root, path) {
  const child = relative(root, path);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CORE_MODULE_URL = new URL('./run-installed-browser-validation-core.mjs', import.meta.url);

export async function runInstalledBrowserValidationEntrypoint(options = {}) {
  let stderr = process.stderr;
  try {
    if (options === null || !['function', 'object'].includes(typeof options)) {
      throw new TypeError('Installed-browser validation entrypoint options must be an object.');
    }
    stderr = options.stderr ?? process.stderr;
    const argv = options.argv ?? process.argv.slice(2);
    const environment = options.environment ?? process.env;
    const loadCore = options.loadCore ?? (() => import(CORE_MODULE_URL));
    const stdout = options.stdout ?? process.stdout;
    const core = await loadCore();
    if (typeof core?.executeInstalledBrowserValidationCliForEntrypoint !== 'function') {
      throw new Error('Installed-browser validation core lacks its exact entrypoint capability.');
    }
    const bytes = await core.executeInstalledBrowserValidationCliForEntrypoint({ argv, environment });
    await writeOutput(stdout, bytes);
    return 0;
  } catch (error) {
    try {
      await writeOutput(stderr, formatInstalledBrowserValidationRefusal(error));
    } catch {
      // Refusal-output failure cannot replace the original fail-closed exit state.
    }
    return 1;
  }
}

export async function runInstalledBrowserValidationMain(options = {}) {
  let stderr = process.stderr;
  try {
    if (options === null || !['function', 'object'].includes(typeof options)) {
      throw new TypeError('Installed-browser validation main options must be an object.');
    }
    stderr = options.stderr ?? process.stderr;
    const processArgv = options.processArgv ?? process.argv;
    const moduleUrl = options.moduleUrl ?? import.meta.url;
    const resolveMainPath = options.resolveMainPath ?? resolve;
    const toFileUrl = options.toFileUrl ?? pathToFileURL;
    const runEntrypoint = options.runEntrypoint ?? runInstalledBrowserValidationEntrypoint;
    if (!Array.isArray(processArgv)) throw new TypeError('Installed-browser validation process argv must be an array.');
    if (typeof moduleUrl !== 'string' || !moduleUrl) {
      throw new TypeError('Installed-browser validation module URL must be a non-empty string.');
    }
    if (
      typeof resolveMainPath !== 'function' ||
      typeof toFileUrl !== 'function' ||
      typeof runEntrypoint !== 'function'
    ) {
      throw new TypeError('Installed-browser validation main capabilities are malformed.');
    }
    if (!processArgv[1] || toFileUrl(resolveMainPath(processArgv[1])).href !== moduleUrl) return null;
    return await runEntrypoint({ argv: processArgv.slice(2), stderr });
  } catch (error) {
    try {
      await writeOutput(stderr, formatInstalledBrowserValidationRefusal(error));
    } catch {
      // Main-refusal output failure cannot replace the exact fail-closed exit state.
    }
    return 1;
  }
}

export function formatInstalledBrowserValidationRefusal(error) {
  const digest = createHash('sha256')
    .update(`sitewipe.installed-browser-cli-refusal.v1\0${typeof error}`)
    .digest('hex')
    .toUpperCase();
  return `Installed-browser validation refused [SITEWIPE_BROWSER_VALIDATION_REFUSED:${digest}]. Private diagnostic text was withheld.\n`;
}

async function writeOutput(destination, bytes) {
  if (!destination || typeof destination.write !== 'function') {
    throw new Error('Installed-browser validation output destination is unavailable.');
  }
  await destination.write(bytes);
}

const mainExitCode = await runInstalledBrowserValidationMain();
if (mainExitCode !== null) process.exitCode = mainExitCode;

import { DEFAULT_SETTINGS } from '../../src/shared/constants.js';

export function createOptionsFixtureDefaults() {
  return structuredClone(DEFAULT_SETTINGS);
}

export function optionsFixtureDefaultsScript() {
  return `globalThis.__SITEWIPE_OPTIONS_FIXTURE_DEFAULTS__ = Object.freeze(${JSON.stringify(
    createOptionsFixtureDefaults()
  )});\n`;
}

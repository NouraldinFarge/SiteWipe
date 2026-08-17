import js from '@eslint/js';
import globals from 'globals';

import { LOCAL_GENERATED_DIRECTORIES } from './scripts/release-files.mjs';

export default [
  {
    ignores: [
      ...LOCAL_GENERATED_DIRECTORIES.map((directory) => `${directory}/**`),
      'src/shared/public-suffix-data.js',
      'third_party/**'
    ]
  },
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.webextensions
      }
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['scripts/**/*.mjs', 'tests/**/*.mjs', 'src/test-harness/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.webextensions
      }
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['tests/browser/fixtures/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.serviceworker
      }
    }
  }
];

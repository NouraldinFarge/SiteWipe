import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'browser-profiles/**',
      'coverage/**',
      'dist/**',
      'node_modules/**',
      'playwright-report/**',
      'src/shared/public-suffix-data.js',
      'test-results/**',
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

// ESLint 9 flat config. ESM, because package.json is "type": "module".
//
// The one rule here that is not taste is the layering rule on src/core and
// src/contracts: they may not import Electron, a Node builtin, or anything else
// that needs an operating system. windows/scripts/gate.sh greps for the same thing
// and is the authority; this block exists so a worker finds out in the editor
// instead of at the gate.
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

/** Node builtins and OS surfaces that must never appear in pure code. */
const forbiddenInPureCode = [
  'electron',
  'fs',
  'node:fs',
  'fs/promises',
  'node:fs/promises',
  'path',
  'node:path',
  'os',
  'node:os',
  'child_process',
  'node:child_process',
  'worker_threads',
  'node:worker_threads',
  'crypto',
  'node:crypto',
  'http',
  'node:http',
  'https',
  'node:https',
  'net',
  'node:net',
  'process',
  'node:process',
];

export default [
  {
    ignores: ['dist/**', 'release/**', 'node_modules/**', 'native/**', 'fixtures/**'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // A stub's parameters are the deliverable; it never uses them.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { args: 'none', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'off',
      'no-undef': 'off', // TypeScript already does this, and better.
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
    },
  },
  {
    files: ['src/core/**/*.ts', 'src/contracts/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: forbiddenInPureCode.map((name) => ({
            name,
            message:
              'src/core and src/contracts are pure functions over plain data. ' +
              'Move anything that needs an OS into src/engines, src/audio, src/platform or src/main.',
          })),
        },
      ],
    },
  },
  {
    files: ['vitest.config.ts', 'eslint.config.js', 'scripts/**/*.mjs'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
];

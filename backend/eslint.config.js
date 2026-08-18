// ESLint 9 flat config for the WorkLens backend.
//
// The rules that are errors rather than warnings are the ones that have a security or
// correctness consequence in this codebase specifically — see the comments on each.

import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['artifacts/**', 'dist/**', 'coverage/**', '.build/**', 'node_modules/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },

    rules: {
      // Unused variables are an error, with the conventional underscore escape hatch for
      // deliberately ignored positional arguments.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],

      // `any` defeats the point of validating input with Zod at the boundary. Handler
      // code that genuinely needs to widen a type should use `unknown` and narrow.
      '@typescript-eslint/no-explicit-any': 'error',

      // A floating promise in a Lambda handler is a silently dropped database write.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      'require-atomic-updates': 'error',

      // Template literals in SQL are how injection gets in. All queries use positional
      // parameters; this makes an accidental interpolation visible in review.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: false, allowNullish: false },
      ],

      // Explicit over implicit at module boundaries, so a refactor cannot silently change
      // an exported function's return type.
      '@typescript-eslint/explicit-module-boundary-types': 'warn',

      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],

      // `==` against null is the one loose comparison worth keeping.
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      'no-console': 'off', // CloudWatch is the log sink; console is the correct API.
      'no-restricted-syntax': [
        'error',
        {
          // Math.random() is not a source of security-relevant randomness. Nonces, tokens,
          // and enrollment secrets must come from node:crypto.
          selector:
            "CallExpression[callee.object.name='Math'][callee.property.name='random']",
          message:
            'Math.random() is not cryptographically secure. Use randomBytes/randomUUID from node:crypto.',
        },
      ],
    },
  },

  // This config file is JavaScript and is not part of the TypeScript project, so the
  // type-aware rules cannot run against it.
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // Tests may reach for looser types when constructing fixtures.
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },

  // Build tooling runs on the developer's machine, not in a request path.
  {
    files: ['scripts/**/*.ts', 'eslint.config.js'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
    },
  },
);

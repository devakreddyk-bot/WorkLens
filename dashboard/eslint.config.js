import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // `coverage/` is generated: v8's HTML report ships its own vendored scripts, which the linter
  // reads as source and reports on. Already gitignored; ignored here so `npm run lint` after
  // `npm run coverage` does not fail on somebody else's code.
  { ignores: ['.next/**', 'node_modules/**', 'coverage/**', 'next-env.d.ts', 'postcss.config.mjs'] },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // The tokens carry the design. A hardcoded hex is how a flat, disciplined palette drifts into
      // eleven slightly different greens.
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value=/^#[0-9a-fA-F]{3,8}$/]",
          message:
            'Use a design token from globals.css rather than a hex literal. The palette is small on purpose.',
        },
      ],
    },
  },

  {
    files: ['**/*.js', 'eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);

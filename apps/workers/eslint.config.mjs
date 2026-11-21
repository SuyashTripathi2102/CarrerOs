// @ts-check
// ESLint 9 flat config. Mirrors apps/api/eslint.config.mjs so the workers are
// held to the same rules. Without this file ESLint 9 refused to run at all
// ("couldn't find an eslint.config.(js|mjs|cjs) file"), so the workers had no
// lint since the ESLint 9 upgrade.
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs', 'dist/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        // tsconfig.json excludes *.spec.ts from the build, so type-aware rules
        // could not parse the tests; tsconfig.eslint.json includes them.
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // A leading underscore marks a parameter a signature requires but the
      // body does not use (BullMQ processors receive `_job`).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // A variable read in a closure declared before its single assignment
      // (fetchText's `req`) cannot be const; this is the documented option.
      'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
);

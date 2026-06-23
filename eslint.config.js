// Flat config (ESLint v9). Lenient TypeScript ruleset: a working gate that
// passes on today's code, to be tightened in follow-ups. See issue #5.
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // The codebase has intentional `as any` casts that other plans address.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Intentional dynamic `require()` (e.g. p-limit ESM import for Jest compat).
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);

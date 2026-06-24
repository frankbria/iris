// Flat config (ESLint v9). Strict TypeScript ruleset for src/, with a
// documented relaxation for test files. See issues #5 and #15.
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  ...tseslint.configs.recommended,
  {
    // Production code is held to the strict bar: no implicit `any`, no dead
    // vars, no CommonJS `require()`. Genuine exceptions carry scoped
    // `eslint-disable-next-line` comments explaining why.
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-require-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Test files legitimately use `any` for partial mocks/casts and
    // `require()` for Jest's mock-hoisting idiom; enforcing src-grade rules
    // here would mean hundreds of noisy disable comments. Dead code is still
    // an error (unused-vars stays on) so tests don't rot.
    files: ['__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);

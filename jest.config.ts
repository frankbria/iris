import type { Config } from '@jest/types';

const config: Config.InitialOptions = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: [
    '**/__tests__/**/*.test.ts',
    '!**/__tests__/**/*.bench.ts',
    '!**/__tests__/**/bench-utils.ts',
    '!**/__tests__/**/report-generator.ts'
  ],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**',
    '!src/**/index.ts', // Exclude index files from coverage as they're mainly exports
    // a11y browser-context modules: their functions are serialized into
    // Playwright page.evaluate() and run in the browser, where Istanbul's
    // injected cov_* counters don't exist (ReferenceError). Excluded so e2e
    // tests pass under --coverage and the report isn't deflated by code that
    // inherently can't be instrumented. These are e2e-covered, not unit-covered.
    '!src/a11y/keyboard-tester.ts',
    '!src/a11y/a11y-runner.ts',
    // MCP process entry point: 25 lines of wiring whose only reachable form is a
    // spawned `node dist/mcp/server.js`, which the parent Jest process cannot
    // instrument. It is covered by the protocol test in __tests__/mcp/server.test.ts.
    // The tool logic it wires up (src/mcp/tools.ts) IS instrumented, in-process,
    // by __tests__/mcp/tools.test.ts — only this shell is exempt.
    '!src/mcp/server.ts'
  ],
  // Never instrument the browser-context a11y modules (see collectCoverageFrom).
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '<rootDir>/src/a11y/keyboard-tester.ts',
    '<rootDir>/src/a11y/a11y-runner.ts',
    '<rootDir>/src/mcp/server.ts'
  ],
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80
    }
  }
};

export default config;

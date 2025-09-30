/**
 * Jest setup file for IRIS Phase 2 testing
 *
 * This file configures global test environment settings for:
 * - Visual regression testing with image fixtures
 * - Accessibility testing with mock browser APIs
 * - Database testing with temporary SQLite instances
 * - Performance testing with timing mocks
 */

import fs from 'fs';
import path from 'path';

// Increase Jest timeout for integration tests that may involve browser automation
jest.setTimeout(30000);

// Mock console methods to reduce noise in test output while preserving error logging
const originalError = console.error;
const originalWarn = console.warn;

beforeAll(() => {
  // Only suppress non-error console output in tests
  console.log = jest.fn();
  console.info = jest.fn();
  console.debug = jest.fn();

  // Keep error and warn for important test debugging
  console.error = originalError;
  console.warn = originalWarn;
});

afterAll(() => {
  // Restore original console methods
  console.log = console.log;
  console.info = console.info;
  console.debug = console.debug;
});

// Global test utilities for Phase 2 modules
declare global {
  namespace jest {
    interface Matchers<R> {
      toBeValidImage(): R;
      toHaveAccessibilityViolations(count?: number): R;
      toBeWithinThreshold(expected: number, threshold: number): R;
    }
  }
}

// Custom Jest matchers for Phase 2 testing
expect.extend({
  toBeValidImage(received: string) {
    const pass = fs.existsSync(received) && ['.png', '.jpg', '.jpeg', '.webp'].some(ext =>
      received.toLowerCase().endsWith(ext)
    );

    if (pass) {
      return {
        message: () => `expected ${received} not to be a valid image file`,
        pass: true,
      };
    } else {
      return {
        message: () => `expected ${received} to be a valid image file`,
        pass: false,
      };
    }
  },

  toHaveAccessibilityViolations(received: any[], expected?: number) {
    const violationCount = received.length;
    const pass = expected !== undefined ? violationCount === expected : violationCount > 0;

    if (pass) {
      return {
        message: () => expected !== undefined
          ? `expected ${violationCount} violations not to equal ${expected}`
          : `expected no accessibility violations but found ${violationCount}`,
        pass: true,
      };
    } else {
      return {
        message: () => expected !== undefined
          ? `expected ${violationCount} violations to equal ${expected}`
          : `expected accessibility violations but found none`,
        pass: false,
      };
    }
  },

  toBeWithinThreshold(received: number, expected: number, threshold: number) {
    const difference = Math.abs(received - expected);
    const pass = difference <= threshold;

    if (pass) {
      return {
        message: () => `expected ${received} not to be within ${threshold} of ${expected}`,
        pass: true,
      };
    } else {
      return {
        message: () => `expected ${received} to be within ${threshold} of ${expected}, but difference was ${difference}`,
        pass: false,
      };
    }
  },
});

// Create test fixtures directory if it doesn't exist
const testFixturesDir = path.join(__dirname, '__tests__', 'fixtures');
if (!fs.existsSync(testFixturesDir)) {
  fs.mkdirSync(testFixturesDir, { recursive: true });
}

// Create subdirectories for different types of test fixtures
const fixtureSubdirs = ['images', 'data', 'screenshots', 'baselines'];
fixtureSubdirs.forEach(subdir => {
  const subdirPath = path.join(testFixturesDir, subdir);
  if (!fs.existsSync(subdirPath)) {
    fs.mkdirSync(subdirPath, { recursive: true });
  }
});

// Global test helpers
global.testHelpers = {
  /**
   * Create a temporary test database file
   */
  createTempDb: () => {
    const tempPath = path.join(__dirname, '__tests__', 'temp', `test-${Date.now()}-${Math.random()}.db`);
    const tempDir = path.dirname(tempPath);
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    return tempPath;
  },

  /**
   * Clean up temporary test files
   */
  cleanupTempFiles: (patterns: string[]) => {
    patterns.forEach(pattern => {
      const files = require('glob').sync(pattern);
      files.forEach((file: string) => {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
        }
      });
    });
  },

  /**
   * Create a mock image buffer for testing
   */
  createMockImageBuffer: (width: number = 100, height: number = 100) => {
    // Create a minimal PNG buffer for testing
    // This is a simple 1x1 transparent PNG encoded as base64
    const base64PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChAGA60e6kgAAAABJRU5ErkJggg==';
    return Buffer.from(base64PNG, 'base64');
  },

  /**
   * Wait for a specified amount of time
   */
  wait: (ms: number) => new Promise(resolve => setTimeout(resolve, ms)),

  /**
   * Generate test data with consistent structure
   */
  generateTestData: {
    visualTestConfig: (overrides: any = {}) => ({
      testName: 'test-visual-component',
      url: 'https://example.com/test',
      viewport: { width: 1920, height: 1080 },
      threshold: 0.1,
      disableAnimations: true,
      fullPage: false,
      ...overrides
    }),

    a11yTestConfig: (overrides: any = {}) => ({
      testName: 'test-a11y-component',
      url: 'https://example.com/test',
      rules: {
        wcag2a: true,
        wcag2aa: true,
        wcag2aaa: false
      },
      timeout: 10000,
      ...overrides
    }),

    performanceMetric: (overrides: any = {}) => ({
      name: 'first-contentful-paint',
      value: 1250.5,
      unit: 'ms',
      timestamp: new Date(),
      category: 'timing',
      ...overrides
    })
  }
};

// Declare global test helpers type
declare global {
  var testHelpers: {
    createTempDb: () => string;
    cleanupTempFiles: (patterns: string[]) => void;
    createMockImageBuffer: (width?: number, height?: number) => Buffer;
    wait: (ms: number) => Promise<void>;
    generateTestData: {
      visualTestConfig: (overrides?: any) => any;
      a11yTestConfig: (overrides?: any) => any;
      performanceMetric: (overrides?: any) => any;
    };
  };
}

// Clean up any temporary files after each test suite
afterEach(() => {
  const tempDir = path.join(__dirname, '__tests__', 'temp');
  if (fs.existsSync(tempDir)) {
    const tempFiles = fs.readdirSync(tempDir);
    tempFiles.forEach(file => {
      const filePath = path.join(tempDir, file);
      if (fs.statSync(filePath).isFile()) {
        fs.unlinkSync(filePath);
      }
    });
  }
});
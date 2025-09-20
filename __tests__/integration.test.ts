import { FileWatcher, WatchOptions } from '../src/watcher';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock the translator to avoid actual translation
jest.mock('../src/translator', () => ({
  translate: jest.fn().mockResolvedValue({
    actions: [{ type: 'click', selector: '#test' }],
    method: 'pattern',
    confidence: 0.9,
    reasoning: 'Test translation'
  }),
}));

// Mock the database
jest.mock('../src/db', () => ({
  initializeDatabase: jest.fn().mockReturnValue({ close: jest.fn() }),
  insertTestRun: jest.fn(),
}));

// Mock the executor to avoid actual browser
jest.mock('../src/executor', () => ({
  ActionExecutor: jest.fn().mockImplementation(() => ({
    launchBrowser: jest.fn().mockResolvedValue({}),
    createPage: jest.fn().mockResolvedValue({}),
    executeAction: jest.fn().mockResolvedValue({
      success: true,
      action: { type: 'click', selector: '#test' },
      duration: 100,
      context: { url: 'http://example.com', timestamp: Date.now() }
    }),
    cleanup: jest.fn().mockResolvedValue(undefined),
  })),
}));

describe('FileWatcher Integration', () => {
  let tempDir: string;
  let tempFile: string;

  beforeEach(async () => {
    // Create temporary directory for testing
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-test-'));
    tempFile = path.join(tempDir, 'test.js');

    // Create initial test file
    fs.writeFileSync(tempFile, 'console.log("initial");');
  });

  afterEach(async () => {
    // Clean up temporary directory
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should integrate watcher with execution options', async () => {
    const options: WatchOptions = {
      patterns: ['test.js'],
      cwd: tempDir,
      debounceMs: 100,
      instruction: 'click test button',
      execute: true,
      headless: true,
      browserTimeout: 15000,
      retryAttempts: 1,
      retryDelay: 500,
      persistent: false, // Don't persist for tests
    };

    const watcher = new FileWatcher(options);
    const status = watcher.getStatus();

    // Verify configuration
    expect(status.options.execute).toBe(true);
    expect(status.options.headless).toBe(true);
    expect(status.options.browserTimeout).toBe(15000);
    expect(status.options.retryAttempts).toBe(1);
    expect(status.options.retryDelay).toBe(500);
    expect(status.options.instruction).toBe('click test button');
    expect(status.browserSessionActive).toBe(false);

    // Verify watcher can be created and configured properly
    expect(watcher).toBeInstanceOf(FileWatcher);
  });

  it('should respect default execution options', () => {
    const watcher = new FileWatcher({
      cwd: tempDir,
    });

    const status = watcher.getStatus();

    // Verify defaults
    expect(status.options.execute).toBe(false);
    expect(status.options.headless).toBe(true);
    expect(status.options.browserTimeout).toBe(30000);
    expect(status.options.retryAttempts).toBe(2);
    expect(status.options.retryDelay).toBe(1000);
    expect(status.browserSessionActive).toBe(false);
  });

  it('should validate execution options boundaries', () => {
    const options: WatchOptions = {
      cwd: tempDir,
      execute: true,
      browserTimeout: 60000,
      retryAttempts: 5,
      retryDelay: 2000,
    };

    const watcher = new FileWatcher(options);
    const status = watcher.getStatus();

    expect(status.options.browserTimeout).toBe(60000);
    expect(status.options.retryAttempts).toBe(5);
    expect(status.options.retryDelay).toBe(2000);
  });
});
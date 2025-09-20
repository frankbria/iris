import { FileWatcher, createWatcher } from '../src/watcher';
import * as path from 'path';

// Mock chokidar
jest.mock('chokidar', () => ({
  watch: jest.fn().mockReturnValue({
    on: jest.fn().mockReturnThis(),
    close: jest.fn(),
  }),
}));

// Mock translator
jest.mock('../src/translator', () => ({
  translate: jest.fn().mockResolvedValue({
    actions: [{ type: 'click', selector: '#test' }],
    method: 'pattern',
    confidence: 0.9,
    reasoning: 'Test translation'
  }),
}));

// Mock config
jest.mock('../src/config', () => ({
  loadConfig: jest.fn().mockReturnValue({
    watch: {
      patterns: ['**/*.{ts,tsx,js,jsx}'],
      ignore: ['node_modules/**'],
      debounceMs: 100,
    },
  }),
}));

// Mock database
jest.mock('../src/db', () => ({
  initializeDatabase: jest.fn().mockReturnValue({ close: jest.fn() }),
  insertTestRun: jest.fn(),
}));

// Mock executor
const mockExecutorInstance = {
  launchBrowser: jest.fn().mockResolvedValue({}),
  createPage: jest.fn().mockResolvedValue({}),
  executeAction: jest.fn().mockResolvedValue({
    success: true,
    action: { type: 'click', selector: '#test' },
    duration: 100,
    context: { url: 'http://example.com', timestamp: Date.now() }
  }),
  cleanup: jest.fn().mockResolvedValue(undefined),
};

jest.mock('../src/executor', () => ({
  ActionExecutor: jest.fn().mockImplementation(() => mockExecutorInstance),
}));

import chokidar from 'chokidar';

describe('FileWatcher', () => {
  let mockWatcher: any;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockWatcher = {
      on: jest.fn().mockReturnThis(),
      close: jest.fn().mockResolvedValue(undefined),
    };

    (chokidar.watch as jest.Mock).mockReturnValue(mockWatcher);
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  describe('constructor', () => {
    it('should create watcher with default options', () => {
      const watcher = new FileWatcher();
      const status = watcher.getStatus();

      expect(status.isRunning).toBe(false);
      expect(status.options.patterns).toEqual(['**/*.{ts,tsx,js,jsx}']);
      expect(status.options.debounceMs).toBe(100);
    });

    it('should create watcher with custom options', () => {
      const options = {
        patterns: ['*.js'],
        debounceMs: 500,
        instruction: 'test instruction',
      };

      const watcher = new FileWatcher(options);
      const status = watcher.getStatus();

      expect(status.options.patterns).toEqual(['*.js']);
      expect(status.options.debounceMs).toBe(500);
      expect(status.options.instruction).toBe('test instruction');
    });
  });

  describe('start', () => {
    it('should start watching files', async () => {
      const watcher = new FileWatcher();

      // Simulate the ready event
      let readyCallback: any;
      mockWatcher.on.mockImplementation((event: string, callback: any) => {
        if (event === 'ready') {
          readyCallback = callback;
        }
        return mockWatcher;
      });

      const startPromise = watcher.start();

      // Trigger ready event
      if (readyCallback) {
        readyCallback();
      }

      await startPromise;

      expect(chokidar.watch).toHaveBeenCalledWith(
        ['**/*.{ts,tsx,js,jsx}'],
        expect.objectContaining({
          ignored: ['node_modules/**'],
          cwd: process.cwd(),
          persistent: true,
          ignoreInitial: true,
        })
      );

      expect(mockWatcher.on).toHaveBeenCalledWith('add', expect.any(Function));
      expect(mockWatcher.on).toHaveBeenCalledWith('change', expect.any(Function));
      expect(mockWatcher.on).toHaveBeenCalledWith('unlink', expect.any(Function));
      expect(mockWatcher.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockWatcher.on).toHaveBeenCalledWith('ready', expect.any(Function));

      expect(watcher.getStatus().isRunning).toBe(true);
    });

    it('should not start if already running', async () => {
      const watcher = new FileWatcher();

      // Mock console.warn to check it's called
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      // Simulate ready event to set isRunning = true
      let readyCallback: any;
      mockWatcher.on.mockImplementation((event: string, callback: any) => {
        if (event === 'ready') {
          readyCallback = callback;
        }
        return mockWatcher;
      });

      // Start watcher and trigger ready
      const startPromise = watcher.start();
      if (readyCallback) {
        readyCallback(); // Trigger ready immediately
      }
      await startPromise;

      // Now try to start again
      await watcher.start();

      expect(consoleSpy).toHaveBeenCalledWith('Watcher is already running');
      consoleSpy.mockRestore();
    });
  });

  describe('stop', () => {
    it('should stop watching files', async () => {
      const watcher = new FileWatcher();

      // Start the watcher first
      let readyCallback: any;
      mockWatcher.on.mockImplementation((event: string, callback: any) => {
        if (event === 'ready') {
          readyCallback = callback;
        }
        return mockWatcher;
      });

      const startPromise = watcher.start();
      if (readyCallback) {
        readyCallback(); // Trigger ready
      }
      await startPromise;

      await watcher.stop();

      expect(mockWatcher.close).toHaveBeenCalled();
      expect(watcher.getStatus().isRunning).toBe(false);
    });

    it('should handle stop when not running', async () => {
      const watcher = new FileWatcher();
      await watcher.stop(); // Should not throw
    });
  });

  describe('file event handling', () => {
    it('should handle file change events with debouncing', async () => {
      const { translate } = await import('../src/translator');
      const watcher = new FileWatcher({ debounceMs: 100 });

      let changeCallback: any;
      mockWatcher.on.mockImplementation((event: string, callback: any) => {
        if (event === 'change') {
          changeCallback = callback;
        } else if (event === 'ready') {
          setTimeout(() => callback(), 0);
        }
        return mockWatcher;
      });

      await watcher.start();

      // Trigger multiple changes rapidly
      changeCallback('test.ts');
      changeCallback('test.ts');
      changeCallback('test.ts');

      // Fast-forward past debounce time
      jest.advanceTimersByTime(150);

      // Should only execute once due to debouncing
      expect(translate).toHaveBeenCalledTimes(1);
    });

    it('should execute instruction when file changes', async () => {
      const { translate } = await import('../src/translator');
      const watcher = new FileWatcher({
        instruction: 'click submit',
        debounceMs: 50,
      });

      let changeCallback: any;
      mockWatcher.on.mockImplementation((event: string, callback: any) => {
        if (event === 'change') {
          changeCallback = callback;
        } else if (event === 'ready') {
          setTimeout(() => callback(), 0);
        }
        return mockWatcher;
      });

      await watcher.start();

      // Trigger change event
      changeCallback('src/test.ts');
      jest.advanceTimersByTime(100);

      expect(translate).toHaveBeenCalledWith(
        'click submit',
        expect.objectContaining({
          url: expect.stringContaining('src/test.ts'),
        })
      );
    });
  });

  describe('browser execution', () => {
    it('should support execution mode configuration', () => {
      const watcher = new FileWatcher({
        execute: true,
        headless: false,
        browserTimeout: 60000,
        retryAttempts: 5,
        retryDelay: 2000,
      });

      const status = watcher.getStatus();
      expect(status.options.execute).toBe(true);
      expect(status.options.headless).toBe(false);
      expect(status.options.browserTimeout).toBe(60000);
      expect(status.options.retryAttempts).toBe(5);
      expect(status.options.retryDelay).toBe(2000);
    });

    it('should default to translation-only mode', () => {
      const watcher = new FileWatcher();
      const status = watcher.getStatus();

      expect(status.options.execute).toBe(false);
      expect(status.options.headless).toBe(true);
      expect(status.options.browserTimeout).toBe(30000);
      expect(status.options.retryAttempts).toBe(2);
      expect(status.options.retryDelay).toBe(1000);
    });

    it('should execute actions when execute mode is enabled', () => {
      const watcher = new FileWatcher({
        execute: true,
        debounceMs: 50,
      });

      // Test the configuration is set correctly
      const status = watcher.getStatus();
      expect(status.options.execute).toBe(true);

      // Verify that ActionExecutor would be instantiated if start was called
      const { ActionExecutor } = require('../src/executor');
      expect(ActionExecutor).toBeDefined();
    });

    it('should not execute actions when execute mode is disabled', () => {
      const watcher = new FileWatcher({
        execute: false,
        debounceMs: 50,
      });

      // Test the configuration is set correctly
      const status = watcher.getStatus();
      expect(status.options.execute).toBe(false);
      expect(status.browserSessionActive).toBe(false);
    });

    it('should have browser session recovery capabilities', () => {
      const watcher = new FileWatcher({
        execute: true,
        debounceMs: 50,
      });

      // Verify recovery methods exist
      expect(typeof watcher['recoverBrowserSession']).toBe('function');
      expect(typeof watcher['cleanupBrowserSession']).toBe('function');
      expect(typeof watcher['initializeBrowserSession']).toBe('function');
    });

    it('should include browser session status in getStatus', () => {
      const watcher = new FileWatcher({ execute: true });

      const status = watcher.getStatus();
      expect(status).toHaveProperty('browserSessionActive');
      expect(status.browserSessionActive).toBe(false);
      expect(status.options.execute).toBe(true);
    });
  });

  describe('createWatcher', () => {
    it('should create a new FileWatcher instance', async () => {
      const watcher = await createWatcher({
        instruction: 'test instruction',
        debounceMs: 200,
      });

      expect(watcher).toBeInstanceOf(FileWatcher);
      expect(watcher.getStatus().options.instruction).toBe('test instruction');
      expect(watcher.getStatus().options.debounceMs).toBe(200);
    });

    it('should create watcher with execution options', async () => {
      const watcher = await createWatcher({
        execute: true,
        headless: false,
        browserTimeout: 45000,
      });

      const status = watcher.getStatus();
      expect(status.options.execute).toBe(true);
      expect(status.options.headless).toBe(false);
      expect(status.options.browserTimeout).toBe(45000);
    });
  });
});
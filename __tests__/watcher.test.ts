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

      // Simulate ready event
      mockWatcher.on.mockImplementation((event: string, callback: any) => {
        if (event === 'ready') {
          setTimeout(callback, 0);
        }
        return mockWatcher;
      });

      await watcher.start();
      await watcher.start(); // Try to start again

      expect(consoleSpy).toHaveBeenCalledWith('Watcher is already running');
      consoleSpy.mockRestore();
    });
  });

  describe('stop', () => {
    it('should stop watching files', async () => {
      const watcher = new FileWatcher();

      // Start the watcher first
      mockWatcher.on.mockImplementation((event: string, callback: any) => {
        if (event === 'ready') {
          setTimeout(callback, 0);
        }
        return mockWatcher;
      });

      await watcher.start();
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
  });
});
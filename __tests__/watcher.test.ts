import { FileWatcher, createWatcher, watchFiles } from '../src/watcher';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

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
    reasoning: 'Test translation',
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
  // Feedback mode's classifier opens a SQLite vision cache through this. The
  // REAL implementation, not a stub: a no-op left the directory uncreated, which
  // passed locally (the dir already existed) and failed in CI.
  ensureDatabaseDir: jest.requireActual('../src/db').ensureDatabaseDir,
}));

// Mock executor
// Shared mock Page: execute mode now navigates the page before running actions,
// so the page must expose a goto() that the real browser.navigate() helper calls.
const mockPage = { goto: jest.fn().mockResolvedValue(undefined) };
const mockExecutorInstance = {
  launchBrowser: jest.fn().mockResolvedValue({}),
  createPage: jest.fn().mockResolvedValue(mockPage),
  executeAction: jest.fn().mockResolvedValue({
    success: true,
    action: { type: 'click', selector: '#test' },
    duration: 100,
    context: { url: 'http://example.com', timestamp: Date.now() },
  }),
  cleanup: jest.fn().mockResolvedValue(undefined),
};

jest.mock('../src/executor', () => ({
  ActionExecutor: jest.fn().mockImplementation(() => mockExecutorInstance),
}));

import chokidar from 'chokidar';
import * as captureModule from '../src/visual/capture';
import * as diffModule from '../src/visual/diff';
import * as classifierModule from '../src/visual/ai-classifier';

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
        }),
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
        }),
      );
    });

    it('closes the database even when insertTestRun throws', async () => {
      const { initializeDatabase, insertTestRun } = await import('../src/db');
      const closeSpy = jest.fn();
      (initializeDatabase as jest.Mock).mockReturnValue({ close: closeSpy });
      (insertTestRun as jest.Mock).mockImplementation(() => {
        throw new Error('disk full');
      });
      const errorSpy = jest.spyOn(console, 'error').mockImplementation();

      const watcher = new FileWatcher({ instruction: 'click submit', debounceMs: 50 });

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
      changeCallback('src/test.ts');
      await jest.advanceTimersByTimeAsync(100);

      // The throw must not skip the close — that's the leak this fix prevents
      expect(insertTestRun).toHaveBeenCalled();
      expect(closeSpy).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to persist'),
        expect.any(Error),
      );

      errorSpy.mockRestore();
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

describe('FileWatcher execute-mode runtime', () => {
  let mockWatcher: any;
  let changeCallback: ((p: string) => void) | undefined;
  let unlinkCallback: ((p: string) => void) | undefined;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    changeCallback = undefined;
    unlinkCallback = undefined;

    mockWatcher = {
      on: jest.fn().mockImplementation((event: string, cb: any) => {
        if (event === 'change') changeCallback = cb;
        else if (event === 'unlink') unlinkCallback = cb;
        else if (event === 'ready') setTimeout(() => cb(), 0);
        return mockWatcher;
      }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    (chokidar.watch as jest.Mock).mockReturnValue(mockWatcher);

    logSpy = jest.spyOn(console, 'log').mockImplementation();
    errorSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('runs the action loop and persists execution counts on success', async () => {
    const { insertTestRun } = await import('../src/db');
    const watcher = new FileWatcher({ execute: true, debounceMs: 50 });

    await watcher.start();
    expect(mockExecutorInstance.launchBrowser).toHaveBeenCalled();

    changeCallback!('src/test.ts');
    await jest.advanceTimersByTimeAsync(60);

    // The page is navigated to the changed file before any action runs, so
    // DOM-targeting actions operate on the real page instead of about:blank.
    expect(mockPage.goto).toHaveBeenCalledWith(
      pathToFileURL(path.resolve(process.cwd(), 'src/test.ts')).href,
    );

    // The single default action from the translator mock is executed.
    expect(mockExecutorInstance.executeAction).toHaveBeenCalledTimes(1);
    expect(insertTestRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: 'success',
        instruction: expect.stringContaining('Executed: 1/1 actions'),
      }),
    );
  });

  it('skips browser execution entirely on unlink events (the file is gone)', async () => {
    const watcher = new FileWatcher({ execute: true, debounceMs: 50 });

    await watcher.start();

    unlinkCallback!('src/test.ts');
    await jest.advanceTimersByTimeAsync(60);

    // Neither navigation nor translated actions run for a deleted file: goto would
    // only 404, and actions would otherwise hit the stale previously-opened page.
    expect(mockPage.goto).not.toHaveBeenCalled();
    expect(mockExecutorInstance.executeAction).not.toHaveBeenCalled();
  });

  it('reports partial failure when one action fails but continues the loop', async () => {
    const { translate } = await import('../src/translator');
    const { insertTestRun } = await import('../src/db');

    (translate as jest.Mock).mockResolvedValueOnce({
      actions: [
        { type: 'click', selector: '#a' },
        { type: 'click', selector: '#b' },
      ],
      method: 'pattern',
      confidence: 0.9,
    });
    mockExecutorInstance.executeAction
      .mockResolvedValueOnce({ success: true, duration: 10, context: {} })
      .mockResolvedValueOnce({ success: false, error: 'not found', duration: 10 });

    const watcher = new FileWatcher({ execute: true, debounceMs: 50 });
    await watcher.start();

    changeCallback!('src/test.ts');
    await jest.advanceTimersByTimeAsync(60);

    // Both actions run even though the first-reported failure does not abort.
    expect(mockExecutorInstance.executeAction).toHaveBeenCalledTimes(2);
    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('1/2 actions completed successfully');
    expect(insertTestRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: 'error',
        instruction: expect.stringContaining('Executed: 1/2 actions'),
      }),
    );
  });

  it('serializes overlapping executions and coalesces them into one follow-up run', async () => {
    const { translate } = await import('../src/translator');
    let resolveFirstAction!: (v: unknown) => void;
    mockExecutorInstance.executeAction.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstAction = resolve;
        }),
    );

    const watcher = new FileWatcher({ execute: true, debounceMs: 50 });
    await watcher.start();

    changeCallback!('first.ts');
    await jest.advanceTimersByTimeAsync(60); // run #1 is mid-flight, awaiting executeAction

    expect(translate).toHaveBeenCalledTimes(1);

    // Two more events while run #1 is still executing: neither may start a
    // concurrent run, and they must coalesce into a single follow-up.
    changeCallback!('second.ts');
    changeCallback!('third.ts');
    await jest.advanceTimersByTimeAsync(60);

    expect(translate).toHaveBeenCalledTimes(1);
    expect(mockExecutorInstance.launchBrowser).toHaveBeenCalledTimes(1);

    resolveFirstAction({ success: true, duration: 5, context: {} });
    await jest.advanceTimersByTimeAsync(0);

    // Exactly one coalesced rerun, reflecting the latest event, on the same session.
    expect(translate).toHaveBeenCalledTimes(2);
    expect(translate).toHaveBeenLastCalledWith(
      'click submit',
      expect.objectContaining({ url: expect.stringContaining('third.ts') }),
    );
    expect(mockExecutorInstance.launchBrowser).toHaveBeenCalledTimes(1);
    expect(mockExecutorInstance.createPage).toHaveBeenCalledTimes(1);
  });

  it('does not start a concurrent run while failure recovery is in progress', async () => {
    const { translate } = await import('../src/translator');
    mockExecutorInstance.executeAction.mockRejectedValueOnce(new Error('page crashed'));

    const watcher = new FileWatcher({ execute: true, debounceMs: 50 });
    await watcher.start();

    changeCallback!('first.ts');
    await jest.advanceTimersByTimeAsync(60); // run #1 fails; recovery is in its 2000ms backoff

    // An event landing during recovery must not observe the torn-down session
    // and launch its own browser alongside recovery's re-init.
    changeCallback!('second.ts');
    await jest.advanceTimersByTimeAsync(60);

    // Still inside recovery's backoff: the second run must not have started,
    // and no extra browser may have been launched against the torn-down session.
    expect(translate).toHaveBeenCalledTimes(1);
    expect(mockExecutorInstance.launchBrowser).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(2000);
    await jest.advanceTimersByTimeAsync(0);

    expect(mockExecutorInstance.cleanup).toHaveBeenCalledTimes(1);
    // start() init + recovery re-init only — no third launch from the second run.
    expect(mockExecutorInstance.launchBrowser).toHaveBeenCalledTimes(2);
    expect(translate).toHaveBeenCalledTimes(2);
  });

  it('stop() waits for the in-flight execution before tearing down the browser', async () => {
    let resolveAction!: (v: unknown) => void;
    mockExecutorInstance.executeAction.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAction = resolve;
        }),
    );

    const watcher = new FileWatcher({ execute: true, debounceMs: 50 });
    await watcher.start();

    changeCallback!('src/test.ts');
    await jest.advanceTimersByTimeAsync(60); // run is mid-flight

    const stopPromise = watcher.stop();
    await jest.advanceTimersByTimeAsync(0);
    expect(mockExecutorInstance.cleanup).not.toHaveBeenCalled();

    resolveAction({ success: true, duration: 5, context: {} });
    await stopPromise;
    expect(mockExecutorInstance.cleanup).toHaveBeenCalledTimes(1);
  });

  it('discards events that land while the watcher is stopping', async () => {
    const { translate } = await import('../src/translator');
    const watcher = new FileWatcher({ execute: true, debounceMs: 50 });
    await watcher.start();
    await jest.advanceTimersByTimeAsync(1); // let the ready callback mark it running

    const stopPromise = watcher.stop();
    changeCallback!('late.ts'); // chokidar can still emit during watcher.close()
    await jest.advanceTimersByTimeAsync(60);
    await stopPromise;
    await jest.advanceTimersByTimeAsync(60);

    // The late event must not schedule a run after teardown — that would
    // relaunch a browser with no owner left to clean it up.
    expect(translate).not.toHaveBeenCalled();
    expect(mockExecutorInstance.launchBrowser).toHaveBeenCalledTimes(1); // start() only
  });

  it('stop() before the ready event still tears down the eagerly launched browser', async () => {
    const watcher = new FileWatcher({ execute: true, debounceMs: 50 });
    await watcher.start(); // ready callback is queued on a timer and has NOT fired

    await watcher.stop();

    // Pre-ready stop must not leak the browser start() already launched.
    expect(mockExecutorInstance.cleanup).toHaveBeenCalledTimes(1);
    expect(watcher.getStatus().browserSessionActive).toBe(false);
  });

  it('stop() during recovery backoff does not relaunch the browser', async () => {
    mockExecutorInstance.executeAction.mockRejectedValueOnce(new Error('page crashed'));

    const watcher = new FileWatcher({ execute: true, debounceMs: 50 });
    await watcher.start();

    changeCallback!('src/test.ts');
    await jest.advanceTimersByTimeAsync(60); // run fails; recovery enters its 2000ms backoff
    expect(mockExecutorInstance.launchBrowser).toHaveBeenCalledTimes(1);

    const stopPromise = watcher.stop(); // awaits the active run, including recovery
    await jest.advanceTimersByTimeAsync(2000);
    await stopPromise;

    // Recovery must not stand up a fresh browser just for stop() to destroy it.
    expect(mockExecutorInstance.launchBrowser).toHaveBeenCalledTimes(1);
    expect(mockExecutorInstance.cleanup).toHaveBeenCalledTimes(1);
  });

  it('concurrent initializeBrowserSession callers share a single launch', async () => {
    let resolveCreatePage!: (v: unknown) => void;
    mockExecutorInstance.createPage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCreatePage = resolve;
        }),
    );

    const watcher = new FileWatcher({ execute: true });
    const first = watcher['initializeBrowserSession']();
    const second = watcher['initializeBrowserSession'](); // re-entry mid-init

    await jest.advanceTimersByTimeAsync(0); // let init reach the pending createPage
    resolveCreatePage(mockPage);
    await Promise.all([first, second]);

    expect(mockExecutorInstance.launchBrowser).toHaveBeenCalledTimes(1);
    expect(mockExecutorInstance.createPage).toHaveBeenCalledTimes(1);
    expect(watcher.getStatus().browserSessionActive).toBe(true);
  });

  it('cleanupBrowserSession waits for an in-progress init instead of tearing it mid-flight', async () => {
    let resolveCreatePage!: (v: unknown) => void;
    mockExecutorInstance.createPage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCreatePage = resolve;
        }),
    );

    const watcher = new FileWatcher({ execute: true });
    const initPromise = watcher['initializeBrowserSession']();
    const cleanupPromise = watcher['cleanupBrowserSession']();

    await Promise.resolve(); // let cleanup reach its await on the init promise
    expect(mockExecutorInstance.cleanup).not.toHaveBeenCalled();

    resolveCreatePage(mockPage);
    await Promise.all([initPromise, cleanupPromise]);

    expect(mockExecutorInstance.cleanup).toHaveBeenCalledTimes(1);
    expect(watcher.getStatus().browserSessionActive).toBe(false);
  });

  it('does not leak a launched browser when createPage fails during init', async () => {
    mockExecutorInstance.createPage.mockRejectedValueOnce(new Error('no page'));

    const watcher = new FileWatcher({ execute: true });

    await expect(watcher['initializeBrowserSession']()).rejects.toThrow(
      'Browser session initialization failed',
    );

    // The successfully launched browser must be torn down, not orphaned.
    expect(mockExecutorInstance.cleanup).toHaveBeenCalledTimes(1);
    expect(watcher.getStatus().browserSessionActive).toBe(false);
  });

  it('recovers the browser session when an action throws', async () => {
    mockExecutorInstance.executeAction.mockRejectedValueOnce(new Error('page crashed'));

    const watcher = new FileWatcher({ execute: true, debounceMs: 50 });
    await watcher.start();

    changeCallback!('src/test.ts');
    // Debounce fires -> executeInstruction catch -> recoverBrowserSession,
    // which waits 2000ms before re-initializing.
    await jest.advanceTimersByTimeAsync(60);
    await jest.advanceTimersByTimeAsync(2000);

    const errorOutput = errorSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(errorOutput).toContain('Browser execution failed');
    // Recovery tears down the old session and stands up a new one.
    expect(mockExecutorInstance.cleanup).toHaveBeenCalled();
    const logOutput = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logOutput).toContain('Browser session recovered');
  });
});

describe('watchFiles entry point', () => {
  let processOnSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  const tmpFiles: string[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers(); // watchFiles awaits real fs.stat; no debounce needed here

    (chokidar.watch as jest.Mock).mockReturnValue({
      on: jest.fn().mockReturnThis(),
      close: jest.fn().mockResolvedValue(undefined),
    });

    // Record signal handler registration without leaking real handlers.
    processOnSpy = jest.spyOn(process, 'on').mockImplementation(() => process);
    logSpy = jest.spyOn(console, 'log').mockImplementation();
  });

  afterEach(() => {
    processOnSpy.mockRestore();
    logSpy.mockRestore();
    for (const f of tmpFiles.splice(0)) {
      fs.rmSync(f, { recursive: true, force: true });
    }
  });

  // watchFiles never resolves (keep-alive promise); start it and let the
  // observable setup work (fs.stat, createWatcher, start) flush.
  const startWatchFiles = async (target?: string): Promise<void> => {
    void watchFiles(target, 'click submit');
    await new Promise((r) => setTimeout(r, 20));
  };

  it('rejects remote URL targets', async () => {
    await expect(watchFiles('https://example.com', 'click submit')).rejects.toThrow(
      'Cannot watch remote URLs',
    );
  });

  it('treats a glob target as a watch pattern', async () => {
    await startWatchFiles('src/**/*.ts');

    expect(chokidar.watch).toHaveBeenCalledWith(
      ['src/**/*.ts'],
      expect.objectContaining({ ignoreInitial: true }),
    );
  });

  it('uses a directory target as the working directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-watch-'));
    tmpFiles.push(dir);

    await startWatchFiles(dir);

    expect(chokidar.watch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cwd: dir }),
    );
  });

  it('treats a non-glob file target as a watch pattern', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-watch-'));
    const file = path.join(dir, 'page.html');
    fs.writeFileSync(file, '<html></html>');
    tmpFiles.push(dir);

    await startWatchFiles(file);

    expect(chokidar.watch).toHaveBeenCalledWith(
      [file],
      expect.objectContaining({ ignoreInitial: true }),
    );
  });

  it('registers SIGINT and SIGTERM shutdown handlers', async () => {
    await startWatchFiles('src/**/*.ts');

    const signals = processOnSpy.mock.calls.map((c) => c[0]);
    expect(signals).toContain('SIGINT');
    expect(signals).toContain('SIGTERM');
  });
});

/**
 * AI feedback mode (issue #118 / plan 015).
 *
 * The pipeline is gated twice before it spends anything — an unchanged page
 * never reaches the AI, and a session cap bounds a hot edit loop — so much of
 * what is under test here is what does NOT happen.
 */
describe('FileWatcher AI feedback mode', () => {
  let mockWatcher: any;
  let changeCallback: ((p: string) => void) | undefined;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  const capture = jest.fn();
  const compare = jest.fn();
  const analyzeChange = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    changeCallback = undefined;

    mockWatcher = {
      on: jest.fn().mockImplementation((event: string, cb: any) => {
        if (event === 'change') changeCallback = cb;
        else if (event === 'ready') setTimeout(() => cb(), 0);
        return mockWatcher;
      }),
      close: jest.fn().mockResolvedValue(undefined),
    };
    (chokidar.watch as jest.Mock).mockReturnValue(mockWatcher);

    // Distinct buffers so "which capture was compared against which?" is
    // observable. The first is taken at startup, before any file change.
    capture
      .mockResolvedValueOnce({ success: true, buffer: Buffer.from('shot-1'), metadata: {} })
      .mockResolvedValue({ success: true, buffer: Buffer.from('shot-2'), metadata: {} });
    // Default: a real visual change, i.e. worth asking about.
    compare.mockResolvedValue({
      success: true,
      passed: false,
      similarity: 0.5,
      pixelDifference: 1000,
      threshold: 0.001,
      diffBuffer: Buffer.from('diff'),
    });
    analyzeChange.mockResolvedValue({
      classification: 'layout-shift',
      confidence: 0.9,
      description: 'The header moved down',
      severity: 'medium',
      suggestions: ['Check the new margin on .header'],
      isIntentional: false,
      changeType: 'layout',
      reasoning: 'because',
    });

    jest.spyOn(captureModule.VisualCaptureEngine.prototype, 'capture').mockImplementation(capture);
    jest.spyOn(diffModule.VisualDiffEngine.prototype, 'compare').mockImplementation(compare);
    jest
      .spyOn(classifierModule.AIVisualClassifier.prototype, 'analyzeChange')
      .mockImplementation(analyzeChange);

    logSpy = jest.spyOn(console, 'log').mockImplementation();
    errorSpy = jest.spyOn(console, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    jest.restoreAllMocks();
  });

  const startFeedbackWatcher = async (overrides: Record<string, unknown> = {}) => {
    const watcher = new FileWatcher({
      feedback: true,
      feedbackUrl: 'http://localhost:3000',
      debounceMs: 50,
      ai: { provider: 'openai', apiKey: 'sk-test' },
      ...overrides,
    });
    await watcher.start();
    return watcher;
  };

  const logged = () => logSpy.mock.calls.map((c) => String(c[0])).join('\n');
  const errored = () => errorSpy.mock.calls.map((c) => String(c[0])).join('\n');

  describe('the reference', () => {
    it('is captured at startup, so the very first save gets feedback', async () => {
      // Establishing it on the first *change* instead would mean the most
      // likely first thing a user does produces no feedback at all.
      await startFeedbackWatcher();

      expect(capture).toHaveBeenCalledTimes(1);
      expect(analyzeChange).not.toHaveBeenCalled();
      expect(logged()).toContain('Reference captured');

      changeCallback!('src/app.css');
      await jest.advanceTimersByTimeAsync(60);

      expect(analyzeChange).toHaveBeenCalledTimes(1);
    });

    it('is deferred to the first change when no URL is configured', async () => {
      // The observed page is then the changed file itself, which cannot be
      // known before something changes.
      await startFeedbackWatcher({ feedbackUrl: undefined });

      expect(capture).not.toHaveBeenCalled();
      expect(logged()).toContain('first change will establish the reference');

      changeCallback!('page.html');
      await jest.advanceTimersByTimeAsync(60);

      expect(capture).toHaveBeenCalledTimes(1);
      expect(analyzeChange).not.toHaveBeenCalled();
    });

    it('does not block startup when the reference capture fails', async () => {
      capture.mockReset().mockRejectedValue(new Error('page unreachable'));

      await expect(startFeedbackWatcher()).resolves.toBeDefined();
      expect(logged()).toContain('Could not capture a reference');
    });
  });

  describe('resource lifecycle', () => {
    it('does not build the classifier until a change actually needs one', async () => {
      // Building one opens a SQLite-backed vision cache. A watcher that never
      // sees a visual change should not open a database to prove it — and the
      // eager version could not even be constructed without a writable cache
      // directory, which is how CI found this.
      const construct = jest.spyOn(classifierModule, 'AIVisualClassifier');

      await startFeedbackWatcher();
      expect(construct).not.toHaveBeenCalled();

      changeCallback!('src/app.css');
      await jest.advanceTimersByTimeAsync(60);
      expect(construct).toHaveBeenCalledTimes(1);
    });

    it('closes the classifier on stop', async () => {
      const close = jest
        .spyOn(classifierModule.AIVisualClassifier.prototype, 'close')
        .mockImplementation();
      const watcher = await startFeedbackWatcher();

      changeCallback!('src/app.css'); // forces the classifier into existence
      await jest.advanceTimersByTimeAsync(60);
      await watcher.stop();

      // A watcher stopped and restarted in-process would otherwise accumulate
      // open SQLite handles.
      expect(close).toHaveBeenCalled();
    });

    it('is safe to stop when no classifier was ever built', async () => {
      compare.mockResolvedValue({
        success: true,
        passed: true,
        similarity: 1,
        pixelDifference: 0,
        threshold: 0.001,
      });
      const watcher = await startFeedbackWatcher();

      changeCallback!('src/app.css');
      await jest.advanceTimersByTimeAsync(60);

      await expect(watcher.stop()).resolves.toBeUndefined();
    });
  });

  describe('cost gates', () => {
    it('skips the AI when the page did not visually change', async () => {
      compare.mockResolvedValue({
        success: true,
        passed: true,
        similarity: 1,
        pixelDifference: 0,
        threshold: 0.001,
      });
      await startFeedbackWatcher();

      changeCallback!('src/app.css');
      await jest.advanceTimersByTimeAsync(60);

      expect(compare).toHaveBeenCalledTimes(1);
      // The gate that makes a save touching no rendered pixels free.
      expect(analyzeChange).not.toHaveBeenCalled();
      expect(logged()).toContain('No visual change');
    });

    it('stops calling the AI once the session cap is reached, and says so once', async () => {
      await startFeedbackWatcher({ maxAiCalls: 1 });

      for (let i = 0; i < 4; i++) {
        changeCallback!('src/app.css');
        await jest.advanceTimersByTimeAsync(60);
      }

      expect(analyzeChange).toHaveBeenCalledTimes(1);
      const notices = logSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((line) => line.includes('AI call cap reached'));
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain('--max-ai-calls');
    });
  });

  describe('reporting', () => {
    it('classifies a real change and prints severity, description and suggestions', async () => {
      await startFeedbackWatcher();

      changeCallback!('src/app.css');
      await jest.advanceTimersByTimeAsync(60);

      expect(analyzeChange).toHaveBeenCalledTimes(1);
      const request = analyzeChange.mock.calls[0][0];
      // Compared against the startup reference, not against itself.
      expect(request.baselineImage.toString()).toBe('shot-1');
      expect(request.currentImage.toString()).toBe('shot-2');
      expect(request.diffImage.toString()).toBe('diff');

      const output = logged();
      expect(output).toContain('MEDIUM');
      expect(output).toContain('The header moved down');
      expect(output).toContain('Check the new margin on .header');
    });

    it('reports a provider outage as a failure, not as a confident finding', async () => {
      // analyzeChange answers with a fallback shape rather than throwing, so
      // without the analysisFailed check an outage prints as "MEDIUM: Failed to
      // analyze visual changes: …" — a verdict-shaped error. Observed live.
      analyzeChange.mockResolvedValueOnce({
        classification: 'unknown',
        confidence: 0.5,
        description: 'Failed to analyze visual changes: All providers failed',
        severity: 'medium',
        suggestions: ['Review the visual changes manually'],
        isIntentional: false,
        changeType: 'unknown',
        reasoning: 'Analysis failed: All providers failed',
        analysisFailed: true,
      });
      await startFeedbackWatcher();

      changeCallback!('src/app.css');
      await jest.advanceTimersByTimeAsync(60);

      expect(errored()).toContain('AI analysis unavailable');
      // Crucially NOT rendered as a severity line.
      expect(logged()).not.toContain('MEDIUM');
    });
  });

  describe('resilience', () => {
    it('keeps watching after an AI failure', async () => {
      analyzeChange.mockRejectedValueOnce(new Error('provider exploded'));
      await startFeedbackWatcher();

      changeCallback!('src/app.css');
      await jest.advanceTimersByTimeAsync(60);
      expect(errored()).toContain('provider exploded');

      // A watcher that dies on a provider hiccup is worse than one that says so.
      changeCallback!('src/app.css');
      await jest.advanceTimersByTimeAsync(60);
      expect(analyzeChange).toHaveBeenCalledTimes(2);
    });

    it('holds the comparison point when analysis did not happen', async () => {
      // Advancing the reference after a failure would compare the NEXT save
      // against an unanalysed state, silently dropping the change nobody heard
      // about. Holding it means the change is included next time.
      analyzeChange.mockRejectedValueOnce(new Error('provider exploded'));
      capture
        .mockReset()
        .mockResolvedValueOnce({ success: true, buffer: Buffer.from('a'), metadata: {} })
        .mockResolvedValueOnce({ success: true, buffer: Buffer.from('b'), metadata: {} })
        .mockResolvedValue({ success: true, buffer: Buffer.from('c'), metadata: {} });
      await startFeedbackWatcher();

      changeCallback!('src/app.css'); // a -> b, AI throws
      await jest.advanceTimersByTimeAsync(60);
      changeCallback!('src/app.css'); // should still compare against a, not b
      await jest.advanceTimersByTimeAsync(60);

      expect(compare.mock.calls[1][0].toString()).toBe('a');
      expect(analyzeChange.mock.calls[1][0].baselineImage.toString()).toBe('a');
    });
  });

  describe('which page is observed', () => {
    it('uses the feedback URL rather than the changed file', async () => {
      await startFeedbackWatcher();

      changeCallback!('src/app.css');
      await jest.advanceTimersByTimeAsync(60);

      // A dev server is the point; the changed .css file would render as nothing.
      expect(mockPage.goto).toHaveBeenCalledWith('http://localhost:3000');
    });

    it('falls back to the changed file when no URL is configured', async () => {
      await startFeedbackWatcher({ feedbackUrl: undefined });

      changeCallback!('page.html');
      await jest.advanceTimersByTimeAsync(60);

      expect(mockPage.goto).toHaveBeenCalledWith(
        pathToFileURL(path.resolve(process.cwd(), 'page.html')).href,
      );
    });
  });

  it('leaves the default watch path untouched', async () => {
    // Feedback mode is additive: without the flag, nothing in the visual stack
    // should be constructed or called.
    const { translate } = await import('../src/translator');
    const watcher = new FileWatcher({ debounceMs: 50 });
    await watcher.start();

    changeCallback!('src/test.ts');
    await jest.advanceTimersByTimeAsync(60);

    expect(translate).toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(analyzeChange).not.toHaveBeenCalled();
  });
});

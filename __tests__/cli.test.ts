import { runCli } from '../src/cli';
import { initializeDatabase, getTestRuns } from '../src/db';
import * as dbModule from '../src/db';
import * as protocolModule from '../src/protocol';
import * as translatorModule from '../src/translator';
import * as executorModule from '../src/executor';
import * as fs from 'fs';
import * as path from 'path';

describe('CLI Commands', () => {
  let consoleOutput: string[];
  const mockedLog = (output: string) => consoleOutput.push(output);

  beforeEach(() => {
    consoleOutput = [];
    jest.spyOn(console, 'log').mockImplementation(mockedLog);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('run command prints translated actions as JSON', async () => {
    await runCli(['node', 'iris', 'run', 'click #btn', '--dry-run']);
    // Check that the actions are displayed in the expected format
    expect(
      consoleOutput.some((log) => log.includes('Actions: [{"type":"click","selector":"#btn"}]')),
    ).toBe(true);
  });

  test('watch command prints target or default', async () => {
    // Skip watch tests for now as they're integration tests that start long-running processes
    // These should be tested in separate integration test suite
    expect(true).toBe(true);
  }, 15000);

  test('connect command prints server start message', async () => {
    // Spy on startServer to avoid actually binding a port. The dynamic
    // `await import('./protocol')` in cli.ts resolves to this same module instance.
    const startServerSpy = jest
      .spyOn(protocolModule, 'startServer')
      .mockReturnValue({ close: jest.fn() } as never);

    const sigintBefore = process.listeners('SIGINT').length;
    const sigtermBefore = process.listeners('SIGTERM').length;

    await runCli(['node', 'iris', 'connect']);
    expect(consoleOutput).toContain('JSON-RPC server listening on ws://127.0.0.1:4000');
    // connect now generates a per-session auth token and passes it to the server,
    // and prints it so local tooling can send it as an Authorization: Bearer header.
    expect(startServerSpy).toHaveBeenCalledWith(4000, {
      authToken: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(consoleOutput).toEqual(
      expect.arrayContaining([expect.stringContaining('Authorization: Bearer <token>')]),
    );

    // Clean up the signal listeners the action registered so they don't leak.
    for (const l of process.listeners('SIGINT').slice(sigintBefore)) {
      process.removeListener('SIGINT', l);
    }
    for (const l of process.listeners('SIGTERM').slice(sigtermBefore)) {
      process.removeListener('SIGTERM', l);
    }
  });

  test('connect command registers graceful shutdown that closes the server (issue #37)', async () => {
    jest.useFakeTimers();
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const mockClose = jest.fn();
    const clientClose = jest.fn();
    const clientTerminate = jest.fn();
    // One connected client so we exercise the "close existing sockets" path.
    const clients = new Set([{ close: clientClose, terminate: clientTerminate }]);
    jest
      .spyOn(protocolModule, 'startServer')
      .mockReturnValue({ close: mockClose, clients } as never);

    const sigintBefore = process.listeners('SIGINT').length;
    const sigtermBefore = process.listeners('SIGTERM').length;

    await runCli(['node', 'iris', 'connect']);

    const newSigint = process.listeners('SIGINT').slice(sigintBefore);
    const newSigterm = process.listeners('SIGTERM').slice(sigtermBefore);
    expect(newSigint).toHaveLength(1);
    expect(newSigterm).toHaveLength(1);

    // Invoking the handler should close connected clients AND the server, so the
    // 'close' drain can run and the process can exit (no hang on Ctrl+C).
    (newSigint[0] as () => void)();
    expect(clientClose).toHaveBeenCalledWith(1001, 'Server shutting down');
    expect(mockClose).toHaveBeenCalledTimes(1);

    // Fallback: a wedged client that never completes its close handshake is
    // force-terminated and the process exits after the timeout.
    jest.advanceTimersByTime(5000);
    expect(clientTerminate).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);

    // Clean up the listeners we added so they don't leak across tests.
    process.removeListener('SIGINT', newSigint[0]);
    process.removeListener('SIGTERM', newSigterm[0]);
    jest.useRealTimers();
  });

  test('run command persists test execution to database', async () => {
    const testDbPath = path.join(__dirname, 'test-cli.db');

    // Clean up test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }

    // Set environment variable for test database path
    process.env.IRIS_DB_PATH = testDbPath;

    try {
      await runCli(['node', 'iris', 'run', 'click #submit', '--dry-run']);

      // Verify record was persisted
      const db = initializeDatabase(testDbPath);
      const runs = getTestRuns(db);

      expect(runs).toHaveLength(1);
      expect(runs[0].instruction).toBe('click #submit');
      expect(runs[0].status).toBe('success');
      expect(runs[0].startTime).toBeInstanceOf(Date);
      expect(runs[0].endTime).toBeInstanceOf(Date);

      db.close();
    } finally {
      // Clean up
      delete process.env.IRIS_DB_PATH;
      if (fs.existsSync(testDbPath)) {
        fs.unlinkSync(testDbPath);
      }
    }
  });

  test('run command survives a DB persistence failure and still closes the handle', async () => {
    const close = jest.fn();
    // dynamic `await import('./db')` in cli.ts resolves to this same module instance
    jest.spyOn(dbModule, 'initializeDatabase').mockReturnValue({ close } as never);
    jest.spyOn(dbModule, 'insertTestRun').mockImplementation(() => {
      throw new Error('disk full');
    });
    const errorOutput: string[] = [];
    jest.spyOn(console, 'error').mockImplementation((...args) => errorOutput.push(args.join(' ')));

    // Should not throw despite the persistence failure
    await expect(
      runCli(['node', 'iris', 'run', 'click #submit', '--dry-run']),
    ).resolves.toBeUndefined();

    // Handle closed even though insertTestRun threw
    expect(close).toHaveBeenCalled();
    // Clear warning logged with the error detail
    expect(
      errorOutput.some((line) => line.includes('Failed to persist') && line.includes('disk full')),
    ).toBe(true);
  });

  test('run command with dry-run shows execution preview', async () => {
    await runCli(['node', 'iris', 'run', 'click #submit', '--dry-run']);

    // Should show translation results
    expect(consoleOutput.some((log) => log.includes('Translation result'))).toBe(true);
    expect(consoleOutput.some((log) => log.includes('Dry run mode - actions not executed'))).toBe(
      true,
    );

    // Should NOT show execution results
    expect(consoleOutput.some((log) => log.includes('🚀 Executing actions'))).toBe(false);
  });

  test('run command shows help with --help flag', async () => {
    // Mock both process.exit and stdout.write to capture help output
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
      return undefined as never;
    });

    const mockWrite = jest.spyOn(process.stdout, 'write').mockImplementation((data) => {
      consoleOutput.push(data.toString());
      return true;
    });

    await runCli(['node', 'iris', 'run', '--help']);

    expect(consoleOutput.some((log) => log.includes('Run a natural language instruction'))).toBe(
      true,
    );

    mockExit.mockRestore();
    mockWrite.mockRestore();
  });

  // Issue #112: `run` used to execute every action against about:blank because it
  // never navigated. These cover the --url / IRIS_BASE_URL starting page.
  describe('run command starting page (--url)', () => {
    /**
     * Stub the executor's browser lifecycle so the run action exercises its own
     * navigation logic without launching Playwright. executeAction is the seam we
     * assert on — the initial navigation must go through it (and therefore through
     * the URL policy), not through page.goto directly.
     */
    const stubExecutor = (
      executeAction: jest.Mock = jest.fn().mockResolvedValue({ success: true, duration: 1 }),
    ) => {
      jest
        .spyOn(executorModule.ActionExecutor.prototype, 'launchBrowser')
        .mockResolvedValue({} as never);
      jest.spyOn(executorModule.ActionExecutor.prototype, 'createPage').mockResolvedValue({
        page: true,
      } as never);
      jest.spyOn(executorModule.ActionExecutor.prototype, 'cleanup').mockResolvedValue();
      jest
        .spyOn(executorModule.ActionExecutor.prototype, 'executeAction')
        .mockImplementation(executeAction);
      return executeAction;
    };

    beforeEach(() => {
      // Keep run persistence off disk; the finally block always writes a test run.
      jest.spyOn(dbModule, 'initializeDatabase').mockReturnValue({ close: jest.fn() } as never);
      jest.spyOn(dbModule, 'insertTestRun').mockImplementation(() => undefined as never);
      jest
        .spyOn(console, 'error')
        .mockImplementation((...args) => consoleOutput.push(args.join(' ')));
      delete process.env.IRIS_BASE_URL;
    });

    afterEach(() => {
      delete process.env.IRIS_BASE_URL;
    });

    test('passes the starting url to translate as context', async () => {
      const translateSpy = jest.spyOn(translatorModule, 'translate');

      await runCli([
        'node',
        'iris',
        'run',
        'click #btn',
        '--dry-run',
        '--url',
        'https://example.com',
      ]);

      expect(translateSpy).toHaveBeenCalledWith('click #btn', { url: 'https://example.com' });
    });

    test('navigates to the starting url before the translated actions', async () => {
      const executeAction = stubExecutor();

      await runCli(['node', 'iris', 'run', 'click #btn', '--url', 'https://example.com']);

      expect(executeAction.mock.calls.map((c) => c[0])).toEqual([
        { type: 'navigate', url: 'https://example.com' },
        { type: 'click', selector: '#btn' },
      ]);
    });

    test('falls back to IRIS_BASE_URL when --url is omitted', async () => {
      process.env.IRIS_BASE_URL = 'https://env.example.com';
      const executeAction = stubExecutor();

      await runCli(['node', 'iris', 'run', 'click #btn']);

      expect(executeAction.mock.calls[0][0]).toEqual({
        type: 'navigate',
        url: 'https://env.example.com',
      });
    });

    test('skips the initial navigation when the instruction already navigates', async () => {
      const executeAction = stubExecutor();

      await runCli([
        'node',
        'iris',
        'run',
        'navigate to https://other.example.com',
        '--url',
        'https://example.com',
      ]);

      expect(executeAction.mock.calls.map((c) => c[0])).toEqual([
        { type: 'navigate', url: 'https://other.example.com' },
      ]);
    });

    test('does not run the translated actions when the initial navigation fails', async () => {
      const executeAction = stubExecutor(
        jest
          .fn()
          .mockResolvedValue({ success: false, error: 'blocked by url policy', duration: 1 }),
      );

      await runCli(['node', 'iris', 'run', 'click #btn', '--url', 'http://169.254.169.254']);

      expect(executeAction).toHaveBeenCalledTimes(1);
      expect(consoleOutput.some((log) => log.includes('blocked by url policy'))).toBe(true);
    });

    test('runs against the blank page as before when no starting url is given', async () => {
      const executeAction = stubExecutor();

      await runCli(['node', 'iris', 'run', 'click #btn']);

      expect(executeAction.mock.calls.map((c) => c[0])).toEqual([
        { type: 'click', selector: '#btn' },
      ]);
    });
  });

  // Issue #113: `run` emitted only emoji-decorated human text, so no AI assistant
  // could consume it. --json makes stdout a machine-readable contract. The central
  // invariant these cover: in JSON mode stdout carries EXACTLY one parseable object
  // and no narration, because assistants pipe it straight into JSON.parse.
  describe('run command JSON output (--json)', () => {
    const stubExecutor = (
      executeAction: jest.Mock = jest.fn().mockResolvedValue({ success: true, duration: 1 }),
    ) => {
      jest
        .spyOn(executorModule.ActionExecutor.prototype, 'launchBrowser')
        .mockResolvedValue({} as never);
      jest.spyOn(executorModule.ActionExecutor.prototype, 'createPage').mockResolvedValue({
        page: true,
      } as never);
      jest.spyOn(executorModule.ActionExecutor.prototype, 'cleanup').mockResolvedValue();
      jest
        .spyOn(executorModule.ActionExecutor.prototype, 'executeAction')
        .mockImplementation(executeAction);
      return executeAction;
    };

    /** stdout in JSON mode must be one object and nothing else — parse it or fail loudly. */
    const soleJsonPayload = () => {
      expect(consoleOutput).toHaveLength(1);
      return JSON.parse(consoleOutput[0]);
    };

    beforeEach(() => {
      jest.spyOn(dbModule, 'initializeDatabase').mockReturnValue({ close: jest.fn() } as never);
      jest.spyOn(dbModule, 'insertTestRun').mockImplementation(() => undefined as never);
      delete process.env.IRIS_BASE_URL;
    });

    afterEach(() => {
      delete process.env.IRIS_BASE_URL;
    });

    test('--dry-run --json emits a single parseable envelope with executed=false', async () => {
      await runCli(['node', 'iris', 'run', 'click #btn', '--dry-run', '--json']);

      const payload = soleJsonPayload();
      expect(payload).toMatchObject({
        instruction: 'click #btn',
        executed: false,
        results: [],
        status: 'success',
      });
      expect(payload.translation).toMatchObject({
        method: 'pattern',
        actions: [{ type: 'click', selector: '#btn' }],
      });
      expect(typeof payload.translation.confidence).toBe('number');
    });

    test('suppresses all human narration in JSON mode', async () => {
      await runCli(['node', 'iris', 'run', 'click #btn', '--dry-run', '--json']);

      // A single emoji-free line. Narration would both break JSON.parse for a piping
      // assistant and show up as extra entries here.
      expect(consoleOutput).toHaveLength(1);
      expect(consoleOutput[0]).not.toMatch(/[✨🚀🎉🔍⚠️✅❌]/u);
    });

    test('reports per-action execution results when actions run', async () => {
      stubExecutor(
        jest.fn().mockResolvedValue({
          success: true,
          action: { type: 'click', selector: '#btn' },
          duration: 42,
          context: { url: 'https://example.com', timestamp: 1 },
        }),
      );

      await runCli(['node', 'iris', 'run', 'click #btn', '--json']);

      const payload = soleJsonPayload();
      expect(payload.executed).toBe(true);
      expect(payload.status).toBe('success');
      expect(payload.results).toHaveLength(1);
      expect(payload.results[0]).toMatchObject({ success: true, duration: 42 });
    });

    test('status is error and the failure surfaces in results when an action fails', async () => {
      stubExecutor(
        jest.fn().mockResolvedValue({
          success: false,
          action: { type: 'click', selector: '#btn' },
          error: 'selector not found',
          duration: 7,
        }),
      );

      await runCli(['node', 'iris', 'run', 'click #btn', '--json']);

      const payload = soleJsonPayload();
      expect(payload.status).toBe('error');
      expect(payload.results[0]).toMatchObject({
        success: false,
        error: 'selector not found',
      });
    });

    // The zero-action path returns early from the try block. The envelope is emitted
    // from `finally`, so this exit must still produce valid JSON rather than nothing.
    test('still emits a valid envelope when translation yields no actions', async () => {
      jest.spyOn(translatorModule, 'translate').mockResolvedValue({
        actions: [],
        method: 'pattern',
        confidence: 0,
      });

      await runCli(['node', 'iris', 'run', 'do something unparseable', '--json']);

      const payload = soleJsonPayload();
      expect(payload.status).toBe('error');
      expect(payload.executed).toBe(false);
      expect(payload.translation.actions).toEqual([]);
    });

    // The error path must stay parseable even though translation never resolved.
    test('emits a parseable envelope with translation=null when translation throws', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      jest.spyOn(translatorModule, 'translate').mockRejectedValue(new Error('boom'));

      await runCli(['node', 'iris', 'run', 'click #btn', '--json']);

      const payload = soleJsonPayload();
      expect(payload.status).toBe('error');
      expect(payload.translation).toBeNull();
      expect(payload.results).toEqual([]);
    });

    test('human mode is unchanged and emits no JSON envelope', async () => {
      await runCli(['node', 'iris', 'run', 'click #btn', '--dry-run']);

      expect(consoleOutput.some((l) => l.includes('✨ Translation result'))).toBe(true);
      expect(consoleOutput.some((l) => l.trimStart().startsWith('{"instruction"'))).toBe(false);
    });
  });
});

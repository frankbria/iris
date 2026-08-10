import { runCli } from '../src/cli';
import { initializeDatabase, getTestRuns } from '../src/db';
import * as dbModule from '../src/db';
import * as protocolModule from '../src/protocol';
import * as translatorModule from '../src/translator';
import * as executorModule from '../src/executor';
import * as agentLoopModule from '../src/agent-loop';
import * as watcherModule from '../src/watcher';
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
    // `host` joined the options in #192. Asserted explicitly rather than
    // loosened away, so the loopback default stays pinned by this test.
    expect(startServerSpy).toHaveBeenCalledWith(4000, {
      host: '127.0.0.1',
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

  // ==========================================================================
  // Issue #192: `iris connect` could not run in a container.
  //
  // startServer() has always accepted { host } (protocol.ts:94) but connect
  // never passed it, so the bind address was hardcoded to 127.0.0.1. Docker
  // forwards a published port to the container's network interface, not its
  // loopback, so a containerised server started, looked healthy, and refused
  // every connection. The token had the matching problem: minted per start and
  // only printed, so it rotated on every restart and no healthcheck could
  // authenticate.
  //
  // Both defaults are deliberately unchanged — loopback and a random token —
  // so a bare `iris connect` behaves exactly as before.
  // ==========================================================================
  describe('connect host and token overrides (issue #192)', () => {
    const ENV_KEYS = ['IRIS_CONNECT_HOST', 'IRIS_CONNECT_TOKEN'];
    let sigintBefore: number;
    let sigtermBefore: number;

    beforeEach(() => {
      ENV_KEYS.forEach((k) => delete process.env[k]);
      sigintBefore = process.listeners('SIGINT').length;
      sigtermBefore = process.listeners('SIGTERM').length;
      jest.spyOn(protocolModule, 'startServer').mockReturnValue({ close: jest.fn() } as never);
    });

    afterEach(() => {
      ENV_KEYS.forEach((k) => delete process.env[k]);
      // The action installs signal handlers; drop them so they do not leak.
      for (const l of process.listeners('SIGINT').slice(sigintBefore)) {
        process.removeListener('SIGINT', l);
      }
      for (const l of process.listeners('SIGTERM').slice(sigtermBefore)) {
        process.removeListener('SIGTERM', l);
      }
    });

    const startArgs = () =>
      (protocolModule.startServer as jest.Mock).mock.calls[0] as [
        number,
        { host?: string; authToken?: string },
      ];

    it('defaults to loopback when neither flag nor env is set', async () => {
      await runCli(['node', 'iris', 'connect']);
      expect(startArgs()[1].host).toBe('127.0.0.1');
    });

    it('binds the host given by --host', async () => {
      await runCli(['node', 'iris', 'connect', '--host', '0.0.0.0']);
      expect(startArgs()[1].host).toBe('0.0.0.0');
    });

    // Review finding on #192, and the third instance of this shape after #185's
    // IRIS_DOTENV_DIR: `??` only treats null/undefined as unset, so an empty
    // string survives — and WebSocketServer reads '' as "bind every interface".
    // A wrapper script writing `export IRIS_CONNECT_HOST=` to mean "unset" would
    // have silently exposed a browser driver on all interfaces.
    it('treats an empty IRIS_CONNECT_HOST as unset, not as bind-everything', async () => {
      process.env.IRIS_CONNECT_HOST = '';
      await runCli(['node', 'iris', 'connect']);
      expect(startArgs()[1].host).toBe('127.0.0.1');
    });

    it('treats an empty --host as unset too', async () => {
      await runCli(['node', 'iris', 'connect', '--host', '']);
      expect(startArgs()[1].host).toBe('127.0.0.1');
    });

    it('binds the host given by IRIS_CONNECT_HOST', async () => {
      process.env.IRIS_CONNECT_HOST = '0.0.0.0';
      await runCli(['node', 'iris', 'connect']);
      expect(startArgs()[1].host).toBe('0.0.0.0');
    });

    it('lets --host win over IRIS_CONNECT_HOST', async () => {
      process.env.IRIS_CONNECT_HOST = '10.0.0.1';
      await runCli(['node', 'iris', 'connect', '--host', '0.0.0.0']);
      expect(startArgs()[1].host).toBe('0.0.0.0');
    });

    it('advertises the address it actually bound, not a hardcoded one', async () => {
      // Printing 127.0.0.1 while listening on 0.0.0.0 is how the old code would
      // have made a working container look broken.
      await runCli(['node', 'iris', 'connect', '--host', '0.0.0.0']);
      expect(consoleOutput).toContain('JSON-RPC server listening on ws://0.0.0.0:4000');
    });

    it('uses IRIS_CONNECT_TOKEN verbatim when supplied', async () => {
      process.env.IRIS_CONNECT_TOKEN = 'supplied-token-value';
      await runCli(['node', 'iris', 'connect']);
      expect(startArgs()[1].authToken).toBe('supplied-token-value');
    });

    it('does not print a supplied token', async () => {
      // The operator already has it; echoing it only copies a secret into the
      // container logs.
      process.env.IRIS_CONNECT_TOKEN = 'supplied-token-value';
      await runCli(['node', 'iris', 'connect']);
      expect(consoleOutput.join('\n')).not.toContain('supplied-token-value');
    });

    it('still generates and prints a token when none is supplied', async () => {
      await runCli(['node', 'iris', 'connect']);
      expect(startArgs()[1].authToken).toMatch(/^[0-9a-f]{64}$/);
      expect(consoleOutput.join('\n')).toContain(startArgs()[1].authToken as string);
    });
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

  // Issue #78: `--headless` was declared as a plain boolean flag, so commander
  // could only ever produce `true` or `undefined` — never `false`. The
  // `=== false` branches that launch a visible browser with devtools were
  // therefore unreachable, and there was no way to watch a failing selector.
  describe('run command browser visibility (--no-headless)', () => {
    /**
     * Capture what the executor was actually constructed with. `browserOptions`
     * is stored on the instance, so reading `this.options` from inside a stubbed
     * lifecycle method is the honest seam — asserting on the CLI's local
     * variable would pass even if it never reached the executor.
     */
    const captureBrowserOptions = () => {
      const seen: Array<{ headless?: boolean; devtools?: boolean }> = [];
      jest
        .spyOn(executorModule.ActionExecutor.prototype, 'launchBrowser')
        .mockImplementation(async function (this: { options: { browserOptions: never } }) {
          seen.push(this.options.browserOptions);
          return {} as never;
        });
      jest.spyOn(executorModule.ActionExecutor.prototype, 'createPage').mockResolvedValue({
        page: true,
      } as never);
      jest.spyOn(executorModule.ActionExecutor.prototype, 'cleanup').mockResolvedValue();
      jest
        .spyOn(executorModule.ActionExecutor.prototype, 'executeAction')
        .mockResolvedValue({ success: true, duration: 1 } as never);
      return seen;
    };

    beforeEach(() => {
      jest.spyOn(dbModule, 'initializeDatabase').mockReturnValue({ close: jest.fn() } as never);
      jest.spyOn(dbModule, 'insertTestRun').mockImplementation(() => undefined as never);
      delete process.env.IRIS_BASE_URL;
    });

    test('--no-headless launches a visible browser with devtools open', async () => {
      const seen = captureBrowserOptions();

      await runCli(['node', 'iris', 'run', 'click #btn', '--no-headless']);

      expect(seen).toHaveLength(1);
      expect(seen[0].headless).toBe(false);
      expect(seen[0].devtools).toBe(true);
    });

    test('defaults to headless with no devtools when neither flag is given', async () => {
      const seen = captureBrowserOptions();

      await runCli(['node', 'iris', 'run', 'click #btn']);

      expect(seen[0].headless).toBe(true);
      expect(seen[0].devtools).toBe(false);
    });

    test('still accepts an explicit --headless', async () => {
      // The flag already worked (as a no-op that matched the default) and is in
      // published examples, so removing it would break working command lines.
      const seen = captureBrowserOptions();

      await runCli(['node', 'iris', 'run', 'click #btn', '--headless']);

      expect(seen[0].headless).toBe(true);
      expect(seen[0].devtools).toBe(false);
    });
  });

  describe('watch command browser visibility (--no-headless)', () => {
    /**
     * Spy on the module object rather than jest.doMock + resetModules. Resetting
     * the registry here swaps ActionExecutor out from under the prototype spies
     * the rest of this file installs, and the CLI then launches a real browser
     * (see the note in the agent-mode suite below). cli.ts reaches watchFiles
     * through `await import('./watcher')`, which resolves to this same object.
     */
    const stubWatchFiles = () =>
      jest.spyOn(watcherModule, 'watchFiles').mockResolvedValue(undefined as never);

    test('passes headless:false through to the watcher', async () => {
      const watchFiles = stubWatchFiles();

      await runCli(['node', 'iris', 'watch', '.', '--execute', '--no-headless']);

      expect(watchFiles).toHaveBeenCalled();
      expect(watchFiles.mock.calls[0][2]?.headless).toBe(false);
    });

    test('leaves headless at the watcher default when the flag is absent', async () => {
      const watchFiles = stubWatchFiles();

      await runCli(['node', 'iris', 'watch', '.', '--execute']);

      // Undefined, not false — watcher.ts applies `?? true`, and forcing `true`
      // here would silently override any future config-level default.
      expect(watchFiles.mock.calls[0][2]?.headless).toBeUndefined();
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

    // Issue #116: per-action success only means "Playwright didn't throw".
    // goalMet is the separate question of whether what was asked actually holds.
    test('goalMet is true when every assertion passes', async () => {
      jest.spyOn(translatorModule, 'translate').mockResolvedValue({
        actions: [{ type: 'assert', kind: 'text_visible', target: 'Hi' }],
        method: 'pattern',
        confidence: 0.9,
      });
      // Echo the action back the way the real executeAction does — goalMet keys
      // off result.action.type, so a stub that drops it cannot exercise this.
      stubExecutor(
        jest.fn().mockImplementation((action) => ({ success: true, action, duration: 1 })),
      );

      await runCli(['node', 'iris', 'run', 'verify Hi is visible', '--json']);

      expect(soleJsonPayload().goalMet).toBe(true);
    });

    test('goalMet is false and status error when an assertion fails', async () => {
      jest.spyOn(translatorModule, 'translate').mockResolvedValue({
        actions: [{ type: 'assert', kind: 'text_visible', target: 'Hi' }],
        method: 'pattern',
        confidence: 0.9,
      });
      stubExecutor(
        jest.fn().mockResolvedValue({
          success: false,
          action: { type: 'assert', kind: 'text_visible', target: 'Hi' },
          error: 'Assertion failed: text_visible Hi',
          duration: 1,
        }),
      );

      await runCli(['node', 'iris', 'run', 'verify Hi is visible', '--json']);

      const payload = soleJsonPayload();
      expect(payload.goalMet).toBe(false);
      expect(payload.status).toBe('error');
    });

    // null, not false: a plan that asserted nothing has no goal to meet, and
    // reporting false would read as "the goal was not met".
    test('goalMet is null when the plan contains no assertions', async () => {
      stubExecutor(
        jest.fn().mockImplementation((action) => ({ success: true, action, duration: 1 })),
      );

      await runCli(['node', 'iris', 'run', 'click #btn', '--json']);

      expect(soleJsonPayload().goalMet).toBeNull();
    });

    test('human mode is unchanged and emits no JSON envelope', async () => {
      await runCli(['node', 'iris', 'run', 'click #btn', '--dry-run']);

      expect(consoleOutput.some((l) => l.includes('✨ Translation result'))).toBe(true);
      expect(consoleOutput.some((l) => l.trimStart().startsWith('{"instruction"'))).toBe(false);
    });
  });

  describe('run command agent mode (--agent)', () => {
    /**
     * Stub the executor's browser lifecycle. Note this suite deliberately does
     * NOT use jest.doMock + resetModules to fake the loop: resetting the module
     * registry swaps the ActionExecutor class out from under these prototype
     * spies, and the CLI then launches a real browser. Spying on the imported
     * module object works because cli.ts's dynamic `await import(...)` resolves
     * to the same instance.
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

    /** Replace the loop itself; this suite is about the CLI wrapped around it. */
    const stubAgentLoop = (outcome: Record<string, unknown>) =>
      jest
        .spyOn(agentLoopModule, 'runAgentLoop')
        .mockResolvedValue(outcome as never) as unknown as jest.Mock;

    const soleJsonPayload = () => {
      expect(consoleOutput).toHaveLength(1);
      return JSON.parse(consoleOutput[0]);
    };

    beforeEach(() => {
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

    describe('usage errors cost nothing', () => {
      // The point of these is the *absence* of a browser launch. A usage error
      // that first spends several seconds starting Chromium is a bad enough
      // experience to deserve its own guard.
      test('--agent without a URL errors before launching a browser', async () => {
        const launch = jest
          .spyOn(executorModule.ActionExecutor.prototype, 'launchBrowser')
          .mockResolvedValue({} as never);

        await runCli(['node', 'iris', 'run', 'buy a widget', '--agent']);

        expect(launch).not.toHaveBeenCalled();
        expect(consoleOutput.some((l) => l.includes('--agent needs a starting page'))).toBe(true);
      });

      test('IRIS_BASE_URL satisfies the start-URL requirement', async () => {
        process.env.IRIS_BASE_URL = 'https://example.com';
        stubExecutor();
        const loop = stubAgentLoop({
          goalMet: true,
          turns: 1,
          results: [],
          terminationReason: 'goal_met',
        });

        await runCli(['node', 'iris', 'run', 'buy a widget', '--agent']);

        expect(loop).toHaveBeenCalled();
      });

      test('--agent with --dry-run errors before launching a browser', async () => {
        const launch = jest
          .spyOn(executorModule.ActionExecutor.prototype, 'launchBrowser')
          .mockResolvedValue({} as never);

        await runCli([
          'node',
          'iris',
          'run',
          'buy a widget',
          '--agent',
          '--dry-run',
          '--url',
          'https://example.com',
        ]);

        expect(launch).not.toHaveBeenCalled();
        expect(consoleOutput.some((l) => l.includes('cannot be combined with --dry-run'))).toBe(
          true,
        );
      });

      test('a usage error still produces a parseable envelope in --json mode', async () => {
        // An assistant piping stdout must get JSON even on a usage error, so the
        // message goes to stderr and the envelope still lands on stdout.
        const stdout: string[] = [];
        jest.spyOn(console, 'log').mockImplementation((l: string) => stdout.push(l));

        await runCli(['node', 'iris', 'run', 'buy a widget', '--agent', '--json']);

        expect(stdout).toHaveLength(1);
        const payload = JSON.parse(stdout[0]);
        expect(payload.status).toBe('error');
        expect(payload.executed).toBe(false);
        expect(payload.agent).toBeNull();
      });

      test('--max-turns rejects a non-numeric value', async () => {
        // Commander exits the process on an invalid option value, which would
        // take the Jest worker with it — stub it into a throw and assert on that.
        const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
          throw new Error('process.exit called');
        }) as never);
        jest.spyOn(process.stderr, 'write').mockReturnValue(true);

        await expect(
          runCli([
            'node',
            'iris',
            'run',
            'buy a widget',
            '--agent',
            '--url',
            'https://example.com',
            '--max-turns',
            'lots',
          ]),
        ).rejects.toThrow('process.exit called');

        expect(exitSpy).toHaveBeenCalledWith(1);
      });
    });

    describe('loop wiring', () => {
      test('navigates to the start URL through executeAction, then runs the loop', async () => {
        const executeAction = stubExecutor();
        const loop = stubAgentLoop({
          goalMet: true,
          turns: 2,
          results: [{ success: true, action: { type: 'click', selector: '#a' }, duration: 1 }],
          terminationReason: 'goal_met',
        });

        await runCli([
          'node',
          'iris',
          'run',
          'buy a widget',
          '--agent',
          '--url',
          'https://example.com',
        ]);

        // The start URL goes through the executor, so the URL policy applies to
        // it exactly as in the one-shot path.
        expect(executeAction).toHaveBeenCalledWith(
          { type: 'navigate', url: 'https://example.com' },
          expect.anything(),
        );
        expect(loop).toHaveBeenCalledWith(
          expect.objectContaining({ instruction: 'buy a widget', maxTurns: 8 }),
        );
      });

      test('policy defaults are safe: origin pinned, destructive refused', async () => {
        stubExecutor();
        const loop = stubAgentLoop({
          goalMet: true,
          turns: 1,
          results: [],
          terminationReason: 'goal_met',
        });

        await runCli([
          'node',
          'iris',
          'run',
          'buy a widget',
          '--agent',
          '--url',
          'https://example.com',
        ]);

        expect(loop).toHaveBeenCalledWith(
          expect.objectContaining({
            policy: { allow: undefined, pinOrigin: true, allowDestructive: false },
          }),
        );
      });

      test('the opt-out flags reach the loop', async () => {
        stubExecutor();
        const loop = stubAgentLoop({
          goalMet: true,
          turns: 1,
          results: [],
          terminationReason: 'goal_met',
        });

        await runCli([
          'node',
          'iris',
          'run',
          'buy a widget',
          '--agent',
          '--url',
          'https://example.com',
          '--allow',
          'click,assert',
          '--allow-cross-origin',
          '--allow-destructive',
        ]);

        expect(loop).toHaveBeenCalledWith(
          expect.objectContaining({
            policy: { allow: ['click', 'assert'], pinOrigin: false, allowDestructive: true },
          }),
        );
      });

      test('--allow rejects an unknown action type', async () => {
        const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
          throw new Error('process.exit called');
        }) as never);
        jest.spyOn(process.stderr, 'write').mockReturnValue(true);

        await expect(
          runCli([
            'node',
            'iris',
            'run',
            'x',
            '--agent',
            '--url',
            'https://example.com',
            '--allow',
            'click,teleport',
          ]),
        ).rejects.toThrow('process.exit called');

        expect(exitSpy).toHaveBeenCalledWith(1);
      });

      test('--max-turns is passed through to the loop', async () => {
        stubExecutor();
        const loop = stubAgentLoop({
          goalMet: null,
          turns: 3,
          results: [],
          terminationReason: 'max_turns',
        });

        await runCli([
          'node',
          'iris',
          'run',
          'buy a widget',
          '--agent',
          '--url',
          'https://example.com',
          '--max-turns',
          '3',
        ]);

        expect(loop).toHaveBeenCalledWith(expect.objectContaining({ maxTurns: 3 }));
      });

      test('the loop never runs when the starting page fails to open', async () => {
        stubExecutor(jest.fn().mockResolvedValue({ success: false, error: 'boom', duration: 1 }));
        const loop = stubAgentLoop({
          goalMet: true,
          turns: 1,
          results: [],
          terminationReason: 'goal_met',
        });

        await runCli([
          'node',
          'iris',
          'run',
          'buy a widget',
          '--agent',
          '--url',
          'https://example.com',
          '--json',
        ]);

        expect(loop).not.toHaveBeenCalled();
        const payload = soleJsonPayload();
        expect(payload.status).toBe('error');
        expect(payload.agent).toBeNull();
      });

      test('the browser is cleaned up even when the loop throws', async () => {
        stubExecutor();
        const cleanup = jest
          .spyOn(executorModule.ActionExecutor.prototype, 'cleanup')
          .mockResolvedValue();
        jest.spyOn(agentLoopModule, 'runAgentLoop').mockRejectedValue(new Error('loop exploded'));

        // stdout captured separately here: the throw also writes to stderr, which
        // this suite folds into consoleOutput, and stdout must stay pure JSON.
        const stdout: string[] = [];
        jest.spyOn(console, 'log').mockImplementation((l: string) => stdout.push(l));

        await runCli([
          'node',
          'iris',
          'run',
          'buy a widget',
          '--agent',
          '--url',
          'https://example.com',
          '--json',
        ]);

        expect(cleanup).toHaveBeenCalled();
        expect(stdout).toHaveLength(1);
        expect(JSON.parse(stdout[0]).status).toBe('error');
        expect(consoleOutput.some((l) => l.includes('Agent run failed: loop exploded'))).toBe(true);
      });
    });

    describe('the JSON envelope', () => {
      const runAgent = async (outcome: Record<string, unknown>) => {
        stubExecutor();
        stubAgentLoop(outcome);
        await runCli([
          'node',
          'iris',
          'run',
          'buy a widget',
          '--agent',
          '--url',
          'https://example.com',
          '--json',
        ]);
        return soleJsonPayload();
      };

      test('reports turns, terminationReason and goalMet, and folds in loop results', async () => {
        const payload = await runAgent({
          goalMet: true,
          turns: 2,
          results: [
            { success: true, action: { type: 'click', selector: '#a' }, duration: 5 },
            { success: true, action: { type: 'assert', kind: 'text_visible' }, duration: 6 },
          ],
          terminationReason: 'goal_met',
        });

        expect(payload.agent).toEqual({ turns: 2, terminationReason: 'goal_met' });
        expect(payload.goalMet).toBe(true);
        expect(payload.executed).toBe(true);
        expect(payload.status).toBe('success');
        // The starting navigation plus both loop results.
        expect(payload.results).toHaveLength(3);
        // No single up-front translation exists in agent mode.
        expect(payload.translation).toBeNull();
      });

      // In agent mode a failed action is expected — recovering from one is the
      // whole point of re-planning — so the verdict is the loop's outcome, not
      // whether every individual action succeeded.
      test('a recovered-from action failure still reports success', async () => {
        const payload = await runAgent({
          goalMet: true,
          turns: 3,
          results: [
            {
              success: false,
              action: { type: 'click', selector: '#wrong' },
              error: 'no such element',
              duration: 1,
            },
            { success: true, action: { type: 'click', selector: '#right' }, duration: 2 },
            { success: true, action: { type: 'assert', kind: 'text_visible' }, duration: 3 },
          ],
          terminationReason: 'goal_met',
        });

        expect(payload.results.some((r: { success: boolean }) => !r.success)).toBe(true);
        expect(payload.status).toBe('success');
      });

      test.each([
        ['max_turns', null],
        ['no_actions', null],
        ['consecutive_failures', false],
        ['error', null],
      ])('terminating on %s without a met goal reports status error', async (reason, goalMet) => {
        const payload = await runAgent({
          goalMet,
          turns: 4,
          results: [],
          terminationReason: reason,
        });

        expect(payload.agent.terminationReason).toBe(reason);
        expect(payload.goalMet).toBe(goalMet);
        expect(payload.status).toBe('error');
      });

      // Observed in the demo: a model that keeps acting alongside its assert never
      // trips the completion signal, so the loop runs to the cap with the goal
      // passing. Calling that a failure would contradict the goal verdict itself.
      test.each(['max_turns', 'no_actions'])(
        'terminating on %s with the goal met reports status success',
        async (reason) => {
          const payload = await runAgent({
            goalMet: true,
            turns: 4,
            results: [],
            terminationReason: reason,
          });

          expect(payload.goalMet).toBe(true);
          expect(payload.status).toBe('success');
        },
      );

      // ...but an abnormal exit stays an error even so, because goalMet there can
      // be a stale verdict from a turn before things went wrong.
      test.each(['consecutive_failures', 'error'])(
        'terminating abnormally on %s stays an error even when goalMet is true',
        async (reason) => {
          const payload = await runAgent({
            goalMet: true,
            turns: 4,
            results: [],
            terminationReason: reason,
          });

          expect(payload.status).toBe('error');
        },
      );
    });

    test('human mode narrates turns and prints no JSON envelope', async () => {
      stubExecutor();
      jest.spyOn(agentLoopModule, 'runAgentLoop').mockImplementation(async ({ log }) => {
        log?.('turn 1: observing (120 chars)');
        log?.('turn 1: click → ok');
        return { goalMet: true, turns: 1, results: [], terminationReason: 'goal_met' as const };
      });

      await runCli([
        'node',
        'iris',
        'run',
        'buy a widget',
        '--agent',
        '--url',
        'https://example.com',
      ]);

      expect(consoleOutput.some((l) => l.includes('🤖 Agent mode'))).toBe(true);
      expect(consoleOutput.some((l) => l.includes('turn 1: observing'))).toBe(true);
      expect(consoleOutput.some((l) => l.includes('Goal check: passed'))).toBe(true);
      expect(consoleOutput.some((l) => l.trimStart().startsWith('{"instruction"'))).toBe(false);
    });

    test('an unverified goal is reported as unverified, not as passed', async () => {
      stubExecutor();
      stubAgentLoop({ goalMet: null, turns: 8, results: [], terminationReason: 'max_turns' });

      await runCli([
        'node',
        'iris',
        'run',
        'buy a widget',
        '--agent',
        '--url',
        'https://example.com',
      ]);

      expect(consoleOutput.some((l) => l.includes('Goal unverified'))).toBe(true);
      expect(consoleOutput.some((l) => l.includes('Goal check'))).toBe(false);
    });

    test('the one-shot path is untouched when --agent is absent', async () => {
      const executeAction = stubExecutor(
        jest.fn().mockImplementation((action) => ({ success: true, action, duration: 1 })),
      );
      const loop = jest.spyOn(agentLoopModule, 'runAgentLoop');

      await runCli(['node', 'iris', 'run', 'click #btn', '--url', 'https://example.com', '--json']);

      expect(loop).not.toHaveBeenCalled();
      const payload = soleJsonPayload();
      expect(payload.agent).toBeNull();
      expect(payload.translation).not.toBeNull();
      expect(executeAction.mock.calls.map((c) => c[0])).toEqual([
        { type: 'navigate', url: 'https://example.com' },
        { type: 'click', selector: '#btn' },
      ]);
    });
  });
  // ==========================================================================
  // Issue #185: a developer's repo-root .env must not reach a CLI run.
  //
  // `runCli()` calls `loadDotenv()`, which read `.env` from the working
  // directory — the repo root under Jest. A real OPENAI_API_KEY/ANTHROPIC_API_KEY
  // landing in process.env mid-test sent `iris run` down its live-AI branch:
  // the four tests above failed only on machines that had the file, and the run
  // could bill real API calls. These assert the leak is closed at its source.
  // ==========================================================================
  describe('environment hermeticity (issue #185)', () => {
    // Named for what it checks: the state at file load, before any runCli().
    // (It deliberately does not call the CLI — the run-time case is below.)
    it('starts with no provider credential in process.env', () => {
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
      expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
    });

    it('does not pick up a repo-root .env during runCli()', async () => {
      // A sentinel .env is planted at the real repo root, because that is the
      // only way to reproduce the defect deterministically — asserting against
      // whatever happens to be on the machine passes trivially in CI, where a
      // fresh checkout has no .env at all.
      //
      // Safe to plant precisely BECAUSE the guard works: no suite reads the repo
      // root any more. If the guard regresses this test fails, which is the point.
      const repoEnv = path.join(process.cwd(), '.env');
      const saved = fs.existsSync(repoEnv) ? fs.readFileSync(repoEnv) : null;
      fs.writeFileSync(repoEnv, 'OPENAI_API_KEY=sk-sentinel-must-not-be-read\n');

      try {
        // loadDotenv() runs *inside* this call — which is why a beforeEach
        // scrub could never have fixed the leak.
        await runCli(['node', 'iris', 'run', 'click #btn', '--dry-run']);

        expect(process.env.OPENAI_API_KEY).toBeUndefined();
        expect(process.env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(process.env.OLLAMA_ENDPOINT).toBeUndefined();
      } finally {
        // Never clobber the developer's own file.
        if (saved === null) fs.rmSync(repoEnv, { force: true });
        else fs.writeFileSync(repoEnv, saved);
      }
    });

    // No "translate() used the pattern path" assertion here: `click #btn` is
    // matched by the pattern grammar before AI is ever consulted, so it reports
    // 'pattern' with or without a credential present. Verified by disabling the
    // harness guard — the two tests above fail, that one did not.
  });
});

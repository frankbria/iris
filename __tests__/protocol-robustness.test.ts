/**
 * RPC server request-handling robustness (issue #330).
 *
 * Test strategy: the crash this guards against is process-level — a frame that
 * parses as JSON but is not an object threw outside every try, the rejection
 * went unhandled, and Node exited, killing every session. Jest's own handlers
 * would swallow that in-process, so the frame tests run `iris connect` as a
 * real child process and prove it both answers and survives. The child runs
 * from source through ts-node (transpile-only) rather than `dist/`, so it never
 * races the MCP suite's `tsc` build.
 *
 * The readyState and process-policy tests run in-process: both need to observe
 * a call that must NOT happen, which a child process cannot report.
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter, once } from 'events';
import * as net from 'net';
import * as path from 'path';
import WebSocket from 'ws';
import { startServer, installProcessErrorPolicy, JsonRpcResponse } from '../src/protocol';
import * as translatorModule from '../src/translator';

const REPO_ROOT = path.resolve(__dirname, '..');
const TOKEN = 'robustness-test-token';

/** A port nothing is listening on right now. */
async function freePort(): Promise<number> {
  const srv = net.createServer().listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const { port } = srv.address() as net.AddressInfo;
  await new Promise((r) => srv.close(r));
  return port;
}

interface Connect {
  proc: ChildProcess;
  stdout: string;
  stderr: string;
  exit: Promise<number | null>;
}

function spawnConnect(port: number): Connect {
  const proc = spawn(
    process.execPath,
    ['-r', 'ts-node/register', path.join(REPO_ROOT, 'src/cli.ts'), 'connect', String(port)],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1', IRIS_CONNECT_TOKEN: TOKEN },
    },
  );
  const c: Connect = {
    proc,
    stdout: '',
    stderr: '',
    exit: new Promise((resolve) => proc.on('exit', (code) => resolve(code))),
  };
  proc.stdout!.on('data', (d) => (c.stdout += d));
  proc.stderr!.on('data', (d) => (c.stderr += d));
  return c;
}

async function waitFor(pred: () => boolean, what: string, ms = 20000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function openClient(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  await once(ws, 'open');
  return ws;
}

/**
 * Send a raw frame and resolve with the next reply on this socket. Rejects the
 * moment the socket closes, so a server that died fails fast instead of
 * leaving the test to time out.
 */
async function roundTrip(ws: WebSocket, frame: string): Promise<JsonRpcResponse> {
  const reply = Promise.race([
    once(ws, 'message'),
    once(ws, 'close').then(() => {
      throw new Error('socket closed before a reply');
    }),
  ]);
  ws.send(frame);
  const [data] = await reply;
  return JSON.parse(String(data));
}

describe('iris connect survives malformed frames (#330)', () => {
  let port: number;
  let server: Connect;

  beforeAll(async () => {
    port = await freePort();
    server = spawnConnect(port);
    await waitFor(() => server.stdout.includes('listening'), 'the server to listen');
  }, 30000);

  afterAll(async () => {
    server.proc.kill('SIGTERM');
    await server.exit;
  });

  it.each(['null', '1', '[]', '"x"'])(
    'answers %s with -32600 Invalid Request and keeps serving',
    async (frame) => {
      const ws = await openClient(port);
      try {
        const res = await roundTrip(ws, frame);
        expect(res).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32600 } });

        // Same connection still works...
        const status = await roundTrip(
          ws,
          JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getStatus' }),
        );
        expect(status.result).toMatchObject({ status: 'ready' });
      } finally {
        ws.close();
      }

      // ...and so does the process: a fresh connection is served too.
      const fresh = await openClient(port);
      try {
        const status = await roundTrip(
          fresh,
          JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'getStatus' }),
        );
        expect(status.result).toMatchObject({ status: 'ready' });
      } finally {
        fresh.close();
      }
      expect(server.proc.exitCode).toBeNull();
    },
  );
});

describe('iris connect bind failure (#330)', () => {
  it('reports a taken port and exits non-zero without claiming to listen', async () => {
    const blocker = net.createServer().listen(0, '127.0.0.1');
    await once(blocker, 'listening');
    const { port } = blocker.address() as net.AddressInfo;
    try {
      const c = spawnConnect(port);
      const code = await c.exit;
      expect(code).toBe(3);
      expect(c.stderr).toMatch(/already in use/i);
      expect(c.stdout).not.toMatch(/listening/i);
    } finally {
      blocker.close();
    }
  }, 30000);
});

describe('replies are only sent on an open socket (#330)', () => {
  it('does not send when the socket closed while the request was in flight', async () => {
    // Port 0: the OS picks, so nothing can take the port between probe and bind.
    const wss = startServer(0);
    await once(wss, 'listening');
    const { port } = wss.address() as net.AddressInfo;
    const sentWhileNotOpen: number[] = [];
    try {
      wss.on('connection', (serverWs: WebSocket) => {
        const send = serverWs.send.bind(serverWs);
        serverWs.send = ((...args: Parameters<WebSocket['send']>) => {
          if (serverWs.readyState !== WebSocket.OPEN) sentWhileNotOpen.push(serverWs.readyState);
          return send(...args);
        }) as WebSocket['send'];
        // Registered after the server's own handler, so it runs once that
        // handler has reached its first await (launchBrowser waits on the
        // session gate) — the socket is gone before the reply is ready.
        serverWs.on('message', () => serverWs.terminate());
      });

      const client = new WebSocket(`ws://127.0.0.1:${port}`);
      await once(client, 'open');
      const closed = once(client, 'close');
      client.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'launchBrowser', params: {} }));
      await closed;
      // Let the in-flight handler finish and attempt its reply.
      await new Promise((r) => setTimeout(r, 200));

      expect(sentWhileNotOpen).toEqual([]);
    } finally {
      await new Promise((r) => wss.close(r));
    }
  });
});

// Same class as the original crash, one level down: the catch block read
// `err.code` off whatever was thrown, so a `throw null` from anywhere in a
// handler's call graph escaped the catch itself.
describe('a non-object throw inside a handler (#330)', () => {
  let wss: ReturnType<typeof startServer>;
  let client: WebSocket;

  // Setup and teardown live in hooks, not a try/finally in the test: a
  // regression here means no reply, and a timed-out test body never reaches
  // its finally — the open server would then keep Jest from exiting.
  beforeEach(async () => {
    wss = startServer(0);
    await once(wss, 'listening');
    client = new WebSocket(`ws://127.0.0.1:${(wss.address() as net.AddressInfo).port}`);
    await once(client, 'open');
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    client.terminate();
    await new Promise((r) => wss.close(r));
  });

  it.each([null, undefined, 'text'])(
    'thrown %p still gets a -32000 reply',
    async (thrown) => {
      jest.spyOn(translatorModule, 'translateSync').mockImplementation(() => {
        throw thrown;
      });
      const res = await roundTrip(
        client,
        JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'executeCommand',
          params: { instruction: 'x' },
        }),
      );
      expect(res).toMatchObject({ id: 7, error: { code: -32000, message: 'Server error' } });
    },
    5000,
  );
});

describe('installProcessErrorPolicy (#330)', () => {
  function fakeProcess() {
    const proc = new EventEmitter() as EventEmitter & { exit: jest.Mock };
    proc.exit = jest.fn();
    return proc;
  }

  it('logs an unhandled rejection and keeps the process running', () => {
    const proc = fakeProcess();
    const log = jest.fn();
    installProcessErrorPolicy(proc as unknown as NodeJS.Process, log);

    proc.emit('unhandledRejection', new Error('boom'));

    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/unhandled rejection/i),
      expect.any(Error),
    );
    expect(proc.exit).not.toHaveBeenCalled();
  });

  it('logs an uncaught exception and exits non-zero', () => {
    const proc = fakeProcess();
    const log = jest.fn();
    installProcessErrorPolicy(proc as unknown as NodeJS.Process, log);

    proc.emit('uncaughtException', new Error('corrupt'));

    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/uncaught exception/i),
      expect.any(Error),
    );
    expect(proc.exit).toHaveBeenCalledWith(1);
  });
});

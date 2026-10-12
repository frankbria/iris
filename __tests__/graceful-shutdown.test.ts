/**
 * Graceful shutdown, readiness and MCP exit (issue #309).
 *
 * Before: SIGTERM closed every client at once, so a request in flight was never answered;
 * the only health signal was an authenticated RPC round trip (unusable in hosted mode); and
 * iris-mcp ignored SIGTERM and kept running after its client closed stdin.
 *
 * A "slow" action is a navigation to a local page that answers after a delay, so a request
 * is genuinely in flight when the drain starts.
 */

import { spawn, ChildProcess } from 'child_process';
import { once } from 'events';
import { createServer, Server } from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';
import WebSocket, { type WebSocketServer } from 'ws';
import type { ApiJobs } from '../src/jobs-api';
import { drainServer, startServer } from '../src/protocol';

const REPO_ROOT = path.resolve(__dirname, '..');
const TOKEN = 'graceful-shutdown-token';

let slow: Server;
let slowUrl = '';
beforeAll(async () => {
  slow = createServer((_req, res) => {
    setTimeout(() => {
      res.setHeader('content-type', 'text/html');
      res.end('<h1>slow</h1>');
    }, 1500);
  });
  await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
  slowUrl = `http://127.0.0.1:${(slow.address() as AddressInfo).port}/`;
});
afterAll(async () => {
  slow.closeAllConnections();
  await new Promise((resolve) => slow.close(resolve));
});

async function connectTo(url: string) {
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  await once(ws, 'open');
  let id = 0;
  const call = (method: string, params?: object): Promise<Record<string, any>> =>
    new Promise((resolve) => {
      const mine = ++id;
      const on = (d: WebSocket.Data) => {
        const reply = JSON.parse(String(d));
        if (reply.id === mine) {
          ws.off('message', on);
          resolve(reply);
        }
      };
      ws.on('message', on);
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: mine, method, params }));
    });
  return { ws, call };
}

const status = async (base: string, route: string) => (await fetch(`${base}${route}`)).status;

describe('readiness and drain, in process (#309)', () => {
  let wss: WebSocketServer;
  let http = '';
  let ws = '';

  beforeEach(async () => {
    wss = startServer(0, { authToken: TOKEN });
    await once(wss, 'listening');
    const { port } = wss.address() as AddressInfo;
    http = `http://127.0.0.1:${port}`;
    ws = `ws://127.0.0.1:${port}`;
  });
  afterEach(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
  });

  it('answers liveness and readiness without authentication', async () => {
    expect(await status(http, '/health/live')).toBe(200);
    expect(await status(http, '/health/ready')).toBe(200);
    expect(await (await fetch(`${http}/health/ready`)).json()).toEqual({ status: 'ok' });
  });

  it('drains: answers what is in flight, refuses what is new, turns readiness 503', async () => {
    const { call } = await connectTo(ws);
    await call('launchBrowser');
    const inFlight = call('executeBrowserAction', {
      actions: [{ type: 'navigate', url: slowUrl }],
    });
    await new Promise((resolve) => setTimeout(resolve, 300)); // the navigation is under way

    const drained = drainServer(wss, 10_000);
    expect(await status(http, '/health/ready')).toBe(503);
    expect(await status(http, '/health/live')).toBe(200);

    // A new request on the open socket is refused, and so is a new connection.
    const refused = await call('getStatus');
    expect(refused.error).toMatchObject({ code: -32000, message: 'Server is shutting down' });
    const late = new WebSocket(ws, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const [, response] = await once(late, 'unexpected-response');
    expect(response.statusCode).toBe(503);
    late.on('error', () => undefined);

    // Nor is new REST work (a plain request: no job API here, so 426 when not draining).
    expect(await status(http, '/v1/jobs')).toBe(503);

    // The request in flight is answered, and the drain resolves after it.
    expect((await inFlight).result).toMatchObject({ success: true });
    expect(await drained).toBe(true);
  }, 60_000);

  it('gives up at the deadline when a request outlasts it', async () => {
    const { call } = await connectTo(ws);
    await call('launchBrowser');
    void call('executeBrowserAction', { actions: [{ type: 'navigate', url: slowUrl }] });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await drainServer(wss, 200)).toBe(false);
  }, 60_000);
});

describe('an upgrade whose key check ends after the drain began (#309)', () => {
  it('is refused with 503, not admitted', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const wss = startServer(0, {
      authenticate: {
        verify: async () => {
          await held;
          return { orgId: 'org-a', keyId: 'key-a' };
        },
        recheck: async () => true,
      },
    });
    await once(wss, 'listening');
    const { port } = wss.address() as AddressInfo;
    try {
      const late = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { Authorization: 'Bearer iris_test' },
      });
      late.on('error', () => undefined);
      const answered = once(late, 'unexpected-response');
      await new Promise((resolve) => setTimeout(resolve, 200)); // the check is under way
      expect(await drainServer(wss, 1_000)).toBe(true);
      release();
      const [, response] = await answered;
      expect(response.statusCode).toBe(503);
    } finally {
      await new Promise((resolve) => wss.close(resolve));
    }
  });
});

describe('a REST request whose key check spans the drain start (#309)', () => {
  it('is answered before the drain resolves', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const wss = startServer(0, {
      authenticate: {
        verify: async () => {
          await held;
          return null; // answered 401: what matters is that it is answered
        },
        recheck: async () => true,
      },
      jobs: { forOrg: () => ({}) as ApiJobs }, // never reached: the key is refused
    });
    await once(wss, 'listening');
    const { port } = wss.address() as AddressInfo;
    try {
      const answer = fetch(`http://127.0.0.1:${port}/v1/a11y/jobs`, {
        method: 'POST',
        headers: { authorization: 'Bearer iris_test', 'content-type': 'application/json' },
        body: '{}',
      });
      await new Promise((resolve) => setTimeout(resolve, 200)); // the check is under way
      let drained = false;
      const drain = drainServer(wss, 5_000).then((ok) => (drained = ok));
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(drained).toBe(false); // still waiting for the request
      release();
      expect((await answer).status).toBe(401);
      await drain;
      expect(drained).toBe(true);
    } finally {
      await new Promise((resolve) => wss.close(resolve));
    }
  });
});

/** Wait for a spawned process to exit, failing after `ms`. */
function exitOf(proc: ChildProcess, ms: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`did not exit within ${ms}ms`)), ms);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

describe('iris connect on SIGTERM, as a real process (#309)', () => {
  it('answers the request in flight, then exits 0', async () => {
    const port = 45300 + Math.floor(Math.random() * 500);
    const proc = spawn(
      process.execPath,
      ['-r', 'ts-node/register', path.join(REPO_ROOT, 'src/cli.ts'), 'connect', String(port)],
      {
        cwd: REPO_ROOT,
        env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1', IRIS_CONNECT_TOKEN: TOKEN },
      },
    );
    let stdout = '';
    proc.stdout!.on('data', (d) => (stdout += d));
    proc.stderr!.on('data', () => undefined);
    const deadline = Date.now() + 30_000;
    while (!stdout.includes('listening') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const { call } = await connectTo(`ws://127.0.0.1:${port}`);
    await call('launchBrowser');
    const inFlight = call('executeBrowserAction', {
      actions: [{ type: 'navigate', url: slowUrl }],
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    proc.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await status(`http://127.0.0.1:${port}`, '/health/ready')).toBe(503);
    expect((await inFlight).result).toMatchObject({ success: true });
    expect(await exitOf(proc, 20_000)).toBe(0);
  }, 90_000);
});

describe('iris-mcp exits (#309)', () => {
  const mcp = () =>
    spawn(process.execPath, ['-r', 'ts-node/register', path.join(REPO_ROOT, 'src/mcp/server.ts')], {
      cwd: REPO_ROOT,
      env: { ...process.env, TS_NODE_TRANSPILE_ONLY: '1' },
    });
  /** Started: it answers an MCP initialize on stdout. */
  async function started(proc: ChildProcess) {
    proc.stdin!.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 't', version: '1' },
        },
      }) + '\n',
    );
    await once(proc.stdout!, 'data');
  }

  it('on SIGTERM', async () => {
    const proc = mcp();
    await started(proc);
    proc.kill('SIGTERM');
    expect(await exitOf(proc, 10_000)).toBe(0);
  }, 60_000);

  it('when its client closes stdin', async () => {
    const proc = mcp();
    await started(proc);
    proc.stdin!.end();
    expect(await exitOf(proc, 10_000)).toBe(0);
  }, 60_000);
});

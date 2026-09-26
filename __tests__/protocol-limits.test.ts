import WebSocket from 'ws';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import { startServer, JsonRpcResponse, ServerLimits, DEFAULT_SERVER_LIMITS } from '../src/protocol';
import { ActionExecutor } from '../src/executor';

/**
 * Server-side resource limits (#338), each exercised over a real socket.
 *
 * Every server here binds port 0 and runs with a token, the deployed shape. No
 * test navigates, so launchBrowser never starts a Chromium: sessions are created
 * lazily and these tests only count them.
 */

const TOKEN = 'limits-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

type Server = ReturnType<typeof startServer>;
const servers: Server[] = [];
const sockets: WebSocket[] = [];

async function serve(limits: Partial<ServerLimits> = {}, extra = {}): Promise<string> {
  const wss = startServer(0, { authToken: TOKEN, limits, ...extra });
  servers.push(wss);
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  return `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
}

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
});

/** Open a socket; resolves once it is accepted, rejects with the upgrade's HTTP status. */
function open(
  url: string,
  options: WebSocket.ClientOptions = { headers: AUTH },
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    sockets.push(ws);
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => {
      reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
      ws.terminate();
    });
    ws.once('error', reject);
  });
}

async function statusOf(promise: Promise<unknown>): Promise<number | undefined> {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return (err as { status?: number }).status;
  }
}

let nextId = 1;
function call(ws: WebSocket, method: string, params?: unknown): Promise<JsonRpcResponse> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onClose = () => reject(new Error('socket closed'));
    const onMessage = (data: WebSocket.Data) => {
      const res = JSON.parse(data.toString()) as JsonRpcResponse;
      if (res.id !== id) return;
      ws.off('message', onMessage).off('close', onClose);
      resolve(res);
    };
    ws.on('message', onMessage).on('close', onClose);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

/** Poll `check` until it holds. No wall-clock assertions (#190): attempts, not elapsed ms. */
async function eventually(check: () => Promise<boolean> | boolean, attempts = 100) {
  for (let i = 0; i < attempts; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition never held');
}

describe('defaults', () => {
  test('ship bounded values for every limit', () => {
    expect(DEFAULT_SERVER_LIMITS).toEqual({
      maxPayloadBytes: 1024 * 1024,
      maxConnections: 16,
      maxSessions: 4,
      maxActionsPerRequest: 100,
      maxTimeoutMs: 120_000,
      maxRetryAttempts: 5,
      maxRetryDelayMs: 10_000,
      maxSlowMoMs: 1_000,
      heartbeatIntervalMs: 30_000,
    });
  });
});

describe('authentication happens at the upgrade, before the socket is accepted', () => {
  test('missing or wrong token gets HTTP 401 and never becomes a client', async () => {
    const url = await serve();
    expect(await statusOf(open(url, {}))).toBe(401);
    expect(await statusOf(open(url, { headers: { authorization: 'Bearer nope' } }))).toBe(401);
    expect(servers[0].clients.size).toBe(0);
  });

  test('a disallowed Origin gets HTTP 403, even with a valid token', async () => {
    const url = await serve({}, { allowedOrigins: ['http://trusted.example'] });
    expect(await statusOf(open(url, { headers: AUTH, origin: 'http://evil.example' }))).toBe(403);
    // Positive control: the allowlisted origin with the token is accepted.
    const ws = await open(url, { headers: AUTH, origin: 'http://trusted.example' });
    expect((await call(ws, 'getStatus')).result.status).toBe('ready');
  });
});

describe('maxPayloadBytes', () => {
  test('a frame over the limit closes the socket with 1009; one under it is served', async () => {
    const url = await serve({ maxPayloadBytes: 1024 });
    const ok = await open(url);
    const small = await call(ok, 'getStatus', { pad: 'x'.repeat(500) });
    expect(small.result.status).toBe('ready');

    const big = await open(url);
    const code = await new Promise<number>((resolve) => {
      big.once('close', resolve);
      big.send(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getStatus', pad: 'x'.repeat(2048) }),
      );
    });
    expect(code).toBe(1009);
  });
});

describe('maxConnections', () => {
  test('the connection over the cap gets HTTP 503; a closed one frees its slot', async () => {
    const url = await serve({ maxConnections: 2 });
    const a = await open(url);
    await open(url);
    expect(await statusOf(open(url))).toBe(503);

    a.close();
    await eventually(() => servers[0].clients.size < 2);
    const c = await open(url);
    expect((await call(c, 'getStatus')).result.status).toBe('ready');
  });
});

describe('maxSessions', () => {
  test('caps browser sessions server-wide; relaunching your own session is not a new one', async () => {
    const url = await serve({ maxSessions: 1 });
    const a = await open(url);
    const b = await open(url);

    expect((await call(a, 'launchBrowser')).result.success).toBe(true);
    const refused = await call(b, 'launchBrowser');
    expect(refused.error?.code).toBe(-32000);
    expect(refused.error?.message).toMatch(/session limit/i);

    // Replacing a's own session tears the old one down first, so it fits.
    expect((await call(a, 'launchBrowser')).result.success).toBe(true);

    // a leaving frees the slot for b.
    a.close();
    await eventually(async () => (await call(b, 'getStatus')).result.activeSessions === 0);
    expect((await call(b, 'launchBrowser')).result.success).toBe(true);
  });
});

describe('maxActionsPerRequest', () => {
  test('an actions array over the cap is -32602; one at the cap passes validation', async () => {
    const url = await serve({ maxActionsPerRequest: 2 });
    const ws = await open(url);
    const click = { type: 'click', selector: '#x' };

    const over = await call(ws, 'executeBrowserAction', { actions: [click, click, click] });
    expect(over.error?.code).toBe(-32602);

    // No session, so a valid request fails later, on the session check.
    const atCap = await call(ws, 'executeBrowserAction', { actions: [click, click] });
    expect(atCap.error?.code).toBe(-32000);
  });
});

describe('maxActionsPerRequest on the instruction path', () => {
  // An AI translation has no bound of its own, so the cap has to hold for what
  // an instruction turns into, not only for a wire `actions` array. The provider
  // is a local HTTP server speaking Ollama's /api/generate, over a real socket.
  // HOME points at an empty dir so a developer's ~/.iris/config.json cannot pick
  // another provider.
  const saved = { HOME: process.env.HOME, OLLAMA_ENDPOINT: process.env.OLLAMA_ENDPOINT };
  let provider: http.Server;
  /** When set, the provider holds its answer until this settles and reports arrival. */
  let hold: { released: Promise<void>; arrived: () => void; answered: () => void } | null = null;

  beforeAll(async () => {
    const click = { type: 'click', selector: '#x' };
    provider = http.createServer(async (req, res) => {
      req.resume();
      const held = hold;
      if (held) {
        held.arrived();
        await held.released;
        res.on('finish', held.answered);
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ response: JSON.stringify({ actions: [click, click, click] }) }));
    });
    await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
    process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-limits-home-'));
    process.env.OLLAMA_ENDPOINT = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    fs.rmSync(process.env.HOME as string, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await new Promise((r) => provider.close(r));
  });

  test('an instruction translating to more actions than the cap is refused', async () => {
    const ws = await open(await serve({ maxActionsPerRequest: 2 }));
    await call(ws, 'launchBrowser');
    // Prose, so the pattern translator passes and the AI path runs.
    const res = await call(ws, 'executeBrowserAction', { instruction: 'do three things please' });
    expect(res.result.success).toBe(false);
    expect(res.result.error).toMatch(/translated to 3 actions; the limit is 2/);
    expect(res.result.translationResult.actions).toHaveLength(3);
    // Refused before the page: no browser was started for it.
    expect((await call(ws, 'getBrowserStatus')).result.hasPage).toBe(false);
  });

  // A launch queued behind an in-flight action resumes only when the action
  // settles. If the socket closed meanwhile, its 'close' cleanup has already run,
  // so a session inserted then would hold a maxSessions slot until the 30-minute
  // idle sweep. The held provider answer keeps the action in flight on demand.
  test('a launch that resumes after its socket closed inserts no session', async () => {
    const url = await serve({ maxActionsPerRequest: 2, maxSessions: 1 });
    const a = await open(url);
    await call(a, 'launchBrowser');

    let release!: () => void;
    let arrived!: () => void;
    let answered!: () => void;
    const arrival = new Promise<void>((r) => (arrived = r));
    const answer = new Promise<void>((r) => (answered = r));
    hold = { released: new Promise<void>((r) => (release = r)), arrived, answered };
    try {
      a.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'executeBrowserAction',
          params: { instruction: 'do three things please' },
        }),
      );
      await arrival; // the action is in flight, holding the gate open for readers
      a.send(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'launchBrowser' })); // queued writer
      a.close();
      await eventually(() => servers[0].clients.size === 0); // 'close' cleanup has run
    } finally {
      hold = null;
      release();
    }
    await answer;

    // The action settles on its refusal, then the queued launch runs. Several
    // round trips give it every chance to land a phantom session.
    const b = await open(url);
    for (let i = 0; i < 5; i++) {
      expect((await call(b, 'getStatus')).result.activeSessions).toBe(0);
    }
    expect((await call(b, 'launchBrowser')).result.success).toBe(true);
  });

  // Same interleaving, reader side: an action whose socket closes mid-flight used
  // to go on to createPage() on an executor whose cleanup had already run,
  // launching a Chromium that no map entry or sweep would ever reclaim. The spy
  // calls through; it only counts.
  test('an action that resumes after its socket closed starts no browser', async () => {
    const createPage = jest.spyOn(ActionExecutor.prototype, 'createPage');
    try {
      const url = await serve(); // 3 actions fit the default cap, so it would go on to the page
      const a = await open(url);
      await call(a, 'launchBrowser');

      let release!: () => void;
      let arrived!: () => void;
      let answered!: () => void;
      const arrival = new Promise<void>((r) => (arrived = r));
      const answer = new Promise<void>((r) => (answered = r));
      hold = { released: new Promise<void>((r) => (release = r)), arrived, answered };
      try {
        a.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'executeBrowserAction',
            params: { instruction: 'do three things please' },
          }),
        );
        await arrival;
        a.close();
        await eventually(() => servers[0].clients.size === 0);
      } finally {
        hold = null;
        release();
      }
      await answer;

      const b = await open(url);
      for (let i = 0; i < 5; i++) await call(b, 'getStatus');
      expect(createPage).not.toHaveBeenCalled();
    } finally {
      createPage.mockRestore();
    }
  });
});

describe('wire-controlled launch options', () => {
  test('headful and devtools are rejected over the wire (-32602)', async () => {
    const ws = await open(await serve());
    const headful = await call(ws, 'launchBrowser', {
      options: { browserOptions: { headless: false } },
    });
    expect(headful.error?.code).toBe(-32602);
    const devtools = await call(ws, 'launchBrowser', {
      options: { browserOptions: { devtools: true } },
    });
    expect(devtools.error?.code).toBe(-32602);
    // Asking for what the server does anyway is fine.
    const headless = await call(ws, 'launchBrowser', {
      options: { browserOptions: { headless: true } },
    });
    expect(headless.result.success).toBe(true);
  });

  test('timeout, retries, retry delay and slowMo are clamped to the server limits', async () => {
    const ws = await open(
      await serve({
        maxTimeoutMs: 5000,
        maxRetryAttempts: 1,
        maxRetryDelayMs: 100,
        maxSlowMoMs: 10,
      }),
    );
    const asked = await call(ws, 'launchBrowser', {
      options: {
        timeout: 10_000_000,
        retryAttempts: 1000,
        retryDelay: 60_000_000,
        browserOptions: { slowMo: 60_000 },
      },
    });
    expect(asked.result.options).toEqual({
      timeout: 5000,
      retryAttempts: 1,
      retryDelay: 100,
      slowMo: 10,
    });

    // Omitted values get the executor defaults, clamped the same way.
    const omitted = await call(ws, 'launchBrowser');
    expect(omitted.result.options).toEqual({
      timeout: 5000,
      retryAttempts: 1,
      retryDelay: 100,
      slowMo: 0,
    });
  });

  test('under the default limits, omitted values keep the executor defaults', async () => {
    const ws = await open(await serve());
    const res = await call(ws, 'launchBrowser');
    expect(res.result.options).toEqual({
      timeout: 30_000,
      retryAttempts: 3,
      retryDelay: 1000,
      slowMo: 0,
    });
  });
});

describe('heartbeat', () => {
  test('a peer that stops answering pings is terminated and its session freed', async () => {
    const url = await serve({ heartbeatIntervalMs: 50 });
    const live = await open(url);
    // autoPong:false is a half-open peer as the server sees it: frames arrive,
    // pongs never do.
    const dead = await open(url, { headers: AUTH, autoPong: false });
    expect((await call(dead, 'launchBrowser')).result.success).toBe(true);
    expect((await call(live, 'getStatus')).result.activeSessions).toBe(1);

    const code = await new Promise<number>((resolve) => dead.once('close', resolve));
    expect(code).toBe(1006); // terminated, no close handshake

    await eventually(async () => (await call(live, 'getStatus')).result.activeSessions === 0);
    // The ponging peer lived through the same intervals.
    expect(live.readyState).toBe(WebSocket.OPEN);
  });
});

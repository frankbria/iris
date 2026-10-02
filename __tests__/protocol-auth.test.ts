import WebSocket from 'ws';
import http from 'http';
import { AddressInfo } from 'net';
import type { RunInput, TenantScope } from '../src/history-store';
import * as translatorModule from '../src/translator';
import { startServer, JsonRpcResponse, Principal, Authenticator } from '../src/protocol';

/**
 * Per-tenant authentication at the RPC upgrade (#341) and per-key / per-org limits
 * (#342), over real sockets.
 *
 * Test strategy: `startServer({ authenticate })` is the seam hosted `iris connect`
 * plugs BetterAuth's key verification into. Here the authenticator reads an
 * in-test key table, so a test can revoke a key or make the backend fail at a
 * chosen moment. The BetterAuth half runs against real Postgres in
 * `api-key-auth.test.ts`. No test navigates, so no Chromium starts.
 */

type Server = ReturnType<typeof startServer>;
const servers: Server[] = [];
const sockets: WebSocket[] = [];

/** Key -> principal. Delete a key to revoke it. */
let keys: Map<string, Principal>;
let backendDown: boolean;
const seenHeaders: Array<string | undefined> = [];
const rechecked: Principal[] = [];

const authenticate: Authenticator = {
  async verify(header) {
    seenHeaders.push(header);
    if (backendDown) throw new Error('database unreachable');
    const key = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    return (key && keys.get(key)) || null;
  },
  // Gets the principal, never the key: a connection does not keep the plaintext.
  async recheck(principal) {
    rechecked.push(principal);
    if (backendDown) throw new Error('database unreachable');
    return [...keys.values()].some(
      (p) => p.keyId === principal.keyId && p.orgId === principal.orgId,
    );
  },
};

beforeEach(() => {
  keys = new Map([
    ['key-a', { orgId: 'org-a', keyId: 'id-a' }],
    ['key-a2', { orgId: 'org-a', keyId: 'id-a2' }],
    ['key-b', { orgId: 'org-b', keyId: 'id-b' }],
  ]);
  backendDown = false;
  seenHeaders.length = 0;
  rechecked.length = 0;
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))));
});

async function serve(options: Parameters<typeof startServer>[1] = {}): Promise<string> {
  const wss = startServer(0, { authenticate, ...options });
  servers.push(wss);
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  return `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
}

const as = (key: string) => ({ headers: { authorization: `Bearer ${key}` } });

/** Open a socket; resolves once it is accepted, rejects with the upgrade's HTTP status. */
function open(url: string, options: WebSocket.ClientOptions = {}): Promise<WebSocket> {
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
async function eventually(check: () => boolean, attempts = 100) {
  for (let i = 0; i < attempts; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('condition never held');
}

describe('the upgrade is authenticated by the tenant authenticator', () => {
  test('no key, an unknown key and a revoked key get HTTP 401 and never become clients', async () => {
    const url = await serve();
    expect(await statusOf(open(url))).toBe(401);
    expect(await statusOf(open(url, as('nope')))).toBe(401);
    keys.delete('key-a');
    expect(await statusOf(open(url, as('key-a')))).toBe(401);
    expect(servers[0].clients.size).toBe(0);
    // The raw header reaches the authenticator; the server does not parse keys itself.
    expect(seenHeaders).toEqual([undefined, 'Bearer nope', 'Bearer key-a']);
  });

  test('a live key is accepted', async () => {
    const ws = await open(await serve(), as('key-b'));
    expect((await call(ws, 'getStatus')).result.status).toBe('ready');
  });

  test('a failing auth backend is HTTP 503, not 401, and the server keeps serving', async () => {
    const url = await serve();
    backendDown = true;
    expect(await statusOf(open(url, as('key-a')))).toBe(503);
    backendDown = false;
    const ws = await open(url, as('key-a'));
    expect((await call(ws, 'getStatus')).result.status).toBe('ready');
  });

  test('connections still being verified count against maxConnections', async () => {
    // Hold the first verification open: without counting it, a burst of slow
    // verifications would each see an empty server and all be admitted.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let pending = false;
    const url = await serve({
      limits: { maxConnections: 1 },
      authenticate: {
        ...authenticate,
        verify: async (header) => {
          if (header === 'Bearer key-a') {
            pending = true;
            await held;
          }
          return authenticate.verify(header);
        },
      },
    });
    const first = open(url, as('key-a'));
    await eventually(() => pending);
    // The second arrives while the first is pending.
    expect(await statusOf(open(url, as('key-b')))).toBe(503);
    release();
    const ws = await first;
    expect((await call(ws, 'getStatus')).result.status).toBe('ready');
  });

  test('authToken and authenticate together are refused', () => {
    expect(() => startServer(0, { authToken: 't', authenticate })).toThrow(/one at a time/);
  });
});

describe("the key's org is bound to the connection and its sessions", () => {
  test('getStatus counts only the caller org sessions', async () => {
    const url = await serve();
    const a = await open(url, as('key-a'));
    const b = await open(url, as('key-b'));
    // launchBrowser creates the session lazily; no Chromium starts.
    expect((await call(a, 'launchBrowser')).result.success).toBe(true);
    expect((await call(a, 'getStatus')).result).toMatchObject({
      activeSessions: 1,
      hasSession: true,
    });
    // Org B must not learn that org A is running a browser.
    expect((await call(b, 'getStatus')).result).toMatchObject({
      activeSessions: 0,
      hasSession: false,
    });
  });
});

describe('a key revoked while connected', () => {
  test('loses its connection at the next re-check', async () => {
    const url = await serve({ authRecheckMs: 20 });
    const a = await open(url, as('key-a'));
    const b = await open(url, as('key-b'));
    let closeCode: number | undefined;
    a.on('close', (code) => (closeCode = code));
    keys.delete('key-a');
    await eventually(() => closeCode !== undefined);
    expect(closeCode).toBe(1008);
    // The other tenant's live key is untouched.
    expect((await call(b, 'getStatus')).result.status).toBe('ready');
  });

  test('keeps its connection when the re-check cannot reach the backend', async () => {
    const url = await serve({ authRecheckMs: 20 });
    const a = await open(url, as('key-a'));
    backendDown = true;
    // Several re-check rounds fail with an error, not a verdict.
    await eventually(() => rechecked.length >= 3);
    backendDown = false;
    expect((await call(a, 'getStatus')).result.status).toBe('ready');
  });

  test('is re-checked by key id and org, without the key and without re-verifying it', async () => {
    const url = await serve({ authRecheckMs: 20 });
    await open(url, as('key-a'));
    await eventually(() => rechecked.length >= 2);
    expect(rechecked[0]).toEqual({ orgId: 'org-a', keyId: 'id-a' });
    // Only the upgrade verified the key; the re-checks did not.
    expect(seenHeaders).toEqual(['Bearer key-a']);
  });
});

/** The JSON-RPC error a rate-limited request gets, or undefined if it was served. */
async function limited(ws: WebSocket, method = 'getStatus') {
  const res = await call(ws, method);
  return res.error;
}

describe('request rate limits (#342)', () => {
  test('a key over its rate is refused with -32029 and a retry hint; other orgs are not', async () => {
    const url = await serve({ limits: { keyRequestsPerMinute: 3 } });
    const a = await open(url, as('key-a'));
    const b = await open(url, as('key-b'));
    for (let i = 0; i < 3; i++) expect(await limited(a)).toBeUndefined();
    const refused = await limited(a);
    expect(refused).toMatchObject({ code: -32029, message: 'Rate limit exceeded' });
    expect(refused!.data.retryAfterMs).toBeGreaterThan(0);
    expect(refused!.data.retryAfterMs).toBeLessThanOrEqual(20_000);
    expect(await limited(b)).toBeUndefined();
  });

  test('keys of one org share the org rate, so minting keys does not multiply it', async () => {
    const url = await serve({ limits: { keyRequestsPerMinute: 100, orgRequestsPerMinute: 4 } });
    const a = await open(url, as('key-a'));
    const a2 = await open(url, as('key-a2'));
    for (let i = 0; i < 2; i++) expect(await limited(a)).toBeUndefined();
    for (let i = 0; i < 2; i++) expect(await limited(a2)).toBeUndefined();
    expect((await limited(a2))?.code).toBe(-32029);
    expect((await limited(a))?.code).toBe(-32029);
  });

  test('a refused request is not executed', async () => {
    const url = await serve({ limits: { keyRequestsPerMinute: 1 } });
    const a = await open(url, as('key-a'));
    const a2 = await open(url, as('key-a2'));
    expect(await limited(a)).toBeUndefined();
    expect((await limited(a, 'launchBrowser'))?.code).toBe(-32029);
    // Same org, its own key budget: the refused launch created no session.
    expect((await call(a2, 'getStatus')).result.activeSessions).toBe(0);
  });

  test('malformed frames spend the budget too', async () => {
    const url = await serve({ limits: { keyRequestsPerMinute: 2 } });
    const a = await open(url, as('key-a'));
    const replies: JsonRpcResponse[] = [];
    a.on('message', (d) => replies.push(JSON.parse(d.toString())));
    for (let i = 0; i < 3; i++) a.send('null');
    await eventually(() => replies.length === 3);
    expect(replies.map((r) => r.error?.code)).toEqual([-32600, -32600, -32029]);
  });

  test('frames that are not JSON spend the budget too, though they get no reply', async () => {
    const url = await serve({ limits: { keyRequestsPerMinute: 2 } });
    const a = await open(url, as('key-a'));
    a.send('not json');
    a.send('{');
    expect((await limited(a))?.code).toBe(-32029);
  });

  test('a wall clock stepping backward does not drain a budget', async () => {
    // WSL2's clock steps backward (#190). Measured on wall time, the negative
    // elapsed time would subtract tokens and refuse a client that sent nothing.
    const url = await serve({ limits: { keyRequestsPerMinute: 3 } });
    const a = await open(url, as('key-a'));
    expect(await limited(a)).toBeUndefined();
    const realNow = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(realNow - 3_600_000);
    try {
      expect(await limited(a)).toBeUndefined();
      expect(await limited(a)).toBeUndefined();
    } finally {
      clock.mockRestore();
    }
  });

  test('reconnecting does not reset a key budget', async () => {
    const url = await serve({ limits: { keyRequestsPerMinute: 2 } });
    const a = await open(url, as('key-a'));
    expect(await limited(a)).toBeUndefined();
    expect(await limited(a)).toBeUndefined();
    a.close();
    const again = await open(url, as('key-a'));
    expect((await limited(again))?.code).toBe(-32029);
  });

  test('local mode, with no principal, is not rate limited', async () => {
    const wss = startServer(0, { authToken: 'local', limits: { keyRequestsPerMinute: 1 } });
    servers.push(wss);
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
    const ws = await open(url, { headers: { authorization: 'Bearer local' } });
    for (let i = 0; i < 4; i++) expect(await limited(ws)).toBeUndefined();
  });
});

describe('per-org caps (#342)', () => {
  test('one org cannot hold every browser session', async () => {
    const url = await serve({ limits: { maxSessions: 4, maxSessionsPerOrg: 1 } });
    const a = await open(url, as('key-a'));
    const a2 = await open(url, as('key-a2'));
    const b = await open(url, as('key-b'));
    expect((await call(a, 'launchBrowser')).result.success).toBe(true);
    expect((await call(a2, 'launchBrowser')).error).toMatchObject({
      code: -32000,
      message: 'Organization session limit reached (1); try again later',
    });
    // Another org still gets a slot.
    expect((await call(b, 'launchBrowser')).result.success).toBe(true);
    // Relaunching your own session replaces it; it is not a second one.
    expect((await call(a, 'launchBrowser')).result.success).toBe(true);
  });

  test('one org cannot hold every connection: its next upgrade gets 429', async () => {
    const url = await serve({ limits: { maxConnectionsPerOrg: 1 } });
    const a = await open(url, as('key-a'));
    expect(await statusOf(open(url, as('key-a2')))).toBe(429);
    expect((await call(await open(url, as('key-b')), 'getStatus')).result.status).toBe('ready');
    a.close();
    await eventually(() => servers[0].clients.size === 1);
    expect((await call(await open(url, as('key-a2')), 'getStatus')).result.status).toBe('ready');
  });
});

describe('hosted RPC history (#254)', () => {
  // Real Chromium: an action needs a page. The fixture is a local http page, since
  // the default URL policy refuses data: URLs.
  let site: http.Server;
  let siteUrl: string;
  beforeAll(async () => {
    site = http.createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end('<input id="pw" type="password"><button id="go">Go</button>');
    });
    await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
  });
  afterAll(() => new Promise((r) => site.close(r)));

  test("records each executeBrowserAction under the key's org and key, never the typed value", async () => {
    const recorded: Array<{ scope: TenantScope; run: RunInput }> = [];
    const history = {
      forOrg: (scope: TenantScope) => ({
        record: async (run: RunInput) => {
          recorded.push({ scope, run });
          return 'run-1';
        },
      }),
    };
    const url = await serve({ history });
    const a = await open(url, as('key-a'));
    await call(a, 'launchBrowser');
    const res = await call(a, 'executeBrowserAction', {
      actions: [
        { type: 'navigate', url: siteUrl },
        { type: 'fill', selector: '#pw', text: 'hunter2-secret' },
        { type: 'click', selector: '#missing', timeout: 500 },
      ],
    });
    expect(res.result.success).toBe(false);
    await call(a, 'closeBrowser');

    expect(recorded).toHaveLength(1);
    expect(recorded[0].scope).toEqual({ orgId: 'org-a', apiKeyId: 'id-a' });
    const run = recorded[0].run as Extract<RunInput, { kind: 'rpc' }>;
    expect(run.kind).toBe('rpc');
    expect(run.success).toBe(false);
    expect(run.results.map((r) => r.success)).toEqual([true, true, false]);
    expect(run.finishedAt.getTime()).toBeGreaterThanOrEqual(run.startedAt.getTime());
  }, 60_000);

  test('a failing history write is logged and the request still succeeds', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const history = {
      forOrg: () => ({
        record: async (): Promise<string> => {
          throw new Error('database unreachable');
        },
      }),
    };
    const url = await serve({ history });
    const a = await open(url, as('key-a'));
    await call(a, 'launchBrowser');
    const res = await call(a, 'executeBrowserAction', {
      actions: [{ type: 'navigate', url: siteUrl }],
    });
    await call(a, 'closeBrowser');
    expect(res.result.success).toBe(true);
    expect(errors.mock.calls.flat().join(' ')).toMatch(/history.*database unreachable/s);
    errors.mockRestore();
  }, 60_000);

  test('local mode, with no principal, records nothing', async () => {
    const recorded: unknown[] = [];
    const history = {
      forOrg: () => ({ record: async (run: RunInput) => (recorded.push(run), 'x') }),
    };
    const wss = startServer(0, { authToken: 'local', history });
    servers.push(wss);
    await new Promise<void>((resolve) => wss.once('listening', resolve));
    const ws = await open(`ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, {
      headers: { authorization: 'Bearer local' },
    });
    await call(ws, 'launchBrowser');
    await call(ws, 'executeBrowserAction', { actions: [{ type: 'navigate', url: siteUrl }] });
    await call(ws, 'closeBrowser');
    expect(recorded).toEqual([]);
  }, 60_000);
});

describe('AI spend is charged to the org (#255)', () => {
  test("an instruction is translated on the principal's org", async () => {
    const translate = jest
      .spyOn(translatorModule, 'translate')
      .mockResolvedValue({ actions: [], method: 'ai', confidence: 0, reasoning: 'stub' });
    try {
      const url = await serve();
      const a = await open(url, as('key-a'));
      await call(a, 'launchBrowser');
      await call(a, 'executeBrowserAction', { instruction: 'check the order total' });
      // No credentials resolver: the tenant has no AI, and the operator's process-wide
      // keys are never used for it (#258).
      expect(translate).toHaveBeenCalledWith('check the order total', undefined, {
        orgId: 'org-a',
        credentials: expect.any(Function),
      });
      expect(await (translate.mock.calls[0][2] as any).credentials()).toBeNull();
    } finally {
      translate.mockRestore();
    }
  });

  test('a failing credentials lookup is no AI for that request, not a leaked error', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const translate = jest
      .spyOn(translatorModule, 'translate')
      .mockResolvedValue({ actions: [], method: 'ai', confidence: 0, reasoning: 'stub' });
    try {
      const url = await serve({
        aiCredentials: async () => {
          throw new Error('decrypt failed: master key mismatch at kms://internal');
        },
      });
      const a = await open(url, as('key-a'));
      await call(a, 'launchBrowser');
      await call(a, 'executeBrowserAction', { instruction: 'check the order total' });
      const scope = translate.mock.calls[0][2] as any;
      expect(await scope.credentials()).toBeNull();
      expect(errors.mock.calls.flat().join(' ')).toMatch(/credentials/);
    } finally {
      translate.mockRestore();
      errors.mockRestore();
    }
  });

  test("an instruction runs with the principal's own AI credentials (#258)", async () => {
    const translate = jest
      .spyOn(translatorModule, 'translate')
      .mockResolvedValue({ actions: [], method: 'ai', confidence: 0, reasoning: 'stub' });
    const asked: Principal[] = [];
    try {
      const url = await serve({
        aiCredentials: async (principal) => {
          asked.push(principal);
          return principal.orgId === 'org-a' ? { provider: 'openai', apiKey: 'sk-org-a' } : null;
        },
      });
      const a = await open(url, as('key-a'));
      const b = await open(url, as('key-b'));
      await call(a, 'launchBrowser');
      await call(b, 'launchBrowser');
      await call(a, 'executeBrowserAction', { instruction: 'check the order total' });
      await call(b, 'executeBrowserAction', { instruction: 'check the order total' });
      // Handed over lazily: translate() asks only if patterns did not match.
      expect(asked).toEqual([]);
      const [first, second] = translate.mock.calls.map((c) => c[2] as any);
      expect(first.orgId).toBe('org-a');
      expect(await first.credentials()).toEqual({ provider: 'openai', apiKey: 'sk-org-a' });
      expect(second.orgId).toBe('org-b');
      expect(await second.credentials()).toBeNull();
      expect(asked.map((p) => p.orgId)).toEqual(['org-a', 'org-b']);
    } finally {
      translate.mockRestore();
    }
  });
});

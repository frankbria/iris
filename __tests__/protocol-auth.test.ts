import WebSocket from 'ws';
import { AddressInfo } from 'net';
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

// Hosted mode, before anything reads the switch: log lines are JSON (#275).
process.env.IRIS_HOSTED = '1';

import WebSocket from 'ws';
import { AddressInfo } from 'net';
import * as translatorModule from '../src/translator';
import { startServer, JsonRpcResponse, Principal, Authenticator } from '../src/protocol';
import { serveMetrics } from '../src/metrics';
import { hostedEgressProxy } from '../src/egress-proxy';
import type { OrgJobs } from '../src/history-store';

/**
 * Request logs and metrics of the hosted server (#275), over real sockets.
 *
 * Test strategy: the in-test key table of `protocol-auth.test.ts` stands in for
 * BetterAuth, and every log line the server writes (all go through console.error) is
 * captured and parsed as JSON. Metrics are scraped from a real loopback listener. One
 * test launches Chromium, to show a fill value never reaches a log line; the rest
 * start no browser.
 */

const MARK = 'obs-m4rker-77c1';
const keys = new Map<string, Principal>([
  ['key-a', { orgId: 'org-a', keyId: 'id-a' }],
  [`key-${MARK}`, { orgId: 'org-m', keyId: 'id-m' }],
]);
const authenticate: Authenticator = {
  async verify(header) {
    const key = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    return (key && keys.get(key)) || null;
  },
  async recheck() {
    return true;
  },
};
const jobs = {
  forOrg: (): OrgJobs => ({
    enqueue: async () => '00000000-0000-4000-8000-000000000001',
    get: async () => null,
  }),
};

type Server = ReturnType<typeof startServer>;
let server: Server;
let wsUrl: string;
let httpBase: string;
let lines: Array<Record<string, any>>;
const sockets: WebSocket[] = [];

async function serve(options: Parameters<typeof startServer>[1] = {}) {
  server = startServer(0, { authenticate, jobs, ...options });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  wsUrl = `ws://127.0.0.1:${port}`;
  httpBase = `http://127.0.0.1:${port}`;
}

beforeEach(() => {
  lines = [];
  jest.spyOn(console, 'error').mockImplementation((line: unknown) => {
    try {
      lines.push(JSON.parse(String(line)));
    } catch {
      lines.push({ raw: String(line) }); // not ours; a hosted line is always JSON
    }
  });
});
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  if (server) await new Promise((r) => server.close(() => r(null)));
  jest.restoreAllMocks();
});

const as = (key: string) => ({ headers: { authorization: `Bearer ${key}` } });

function open(options: WebSocket.ClientOptions = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, options);
    sockets.push(ws);
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => {
      reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode }));
      ws.terminate();
    });
    ws.once('error', reject);
  });
}

let nextId = 1;
function call(ws: WebSocket, method: string, params?: unknown): Promise<JsonRpcResponse> {
  const id = nextId++;
  return new Promise((resolve) => {
    const onMessage = (data: WebSocket.Data) => {
      const res = JSON.parse(data.toString()) as JsonRpcResponse;
      if (res.id !== id) return;
      ws.off('message', onMessage);
      resolve(res);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
}

// The one Chromium test starts the hosted egress proxy; it would keep Jest alive.
afterAll(async () => (await hostedEgressProxy()).close());

const requestLines = (kind: 'rpc' | 'rest') => lines.filter((l) => l.msg === `${kind} request`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

async function scrape(): Promise<string> {
  const metricsServer = await serveMetrics(0);
  try {
    const { port } = metricsServer.address() as AddressInfo;
    return await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
  } finally {
    await new Promise((r) => metricsServer.close(r));
  }
}

/** The value of one exposition line, or 0 when the series is absent. */
const sample = (text: string, series: string) => {
  const line = text.split('\n').find((l) => l.startsWith(`${series} `));
  return line ? Number(line.slice(series.length + 1)) : 0;
};

describe('RPC request logs', () => {
  it('logs request id, org, key, method, latency and outcome for each request', async () => {
    await serve();
    const ws = await open(as('key-a'));
    await call(ws, 'getStatus');
    await call(ws, 'noSuchMethod');
    const [ok, unknown] = requestLines('rpc');
    expect(ok).toMatchObject({
      level: 'info',
      orgId: 'org-a',
      keyId: 'id-a',
      method: 'getStatus',
      outcome: 'ok',
    });
    expect(ok.requestId).toMatch(UUID);
    expect(typeof ok.latencyMs).toBe('number');
    expect(typeof ok.ts).toBe('string');
    // A method the server does not know is not echoed as a label.
    expect(unknown).toMatchObject({ method: 'unknown', outcome: 'client_error', code: -32601 });
    expect(unknown.requestId).not.toBe(ok.requestId);
    expect(lines.find((l) => l.msg === 'connection opened')).toMatchObject({ orgId: 'org-a' });
  });

  it('logs a rate-limited request as rate_limited, and it is counted', async () => {
    await serve({ limits: { keyRequestsPerMinute: 1 } });
    const before = sample(
      await scrape(),
      'iris_requests_total{method="getStatus",outcome="rate_limited"}',
    );
    const ws = await open(as('key-a'));
    await call(ws, 'getStatus');
    const refused = await call(ws, 'getStatus');
    expect(refused.error?.code).toBe(-32029);
    expect(requestLines('rpc').map((l) => l.outcome)).toEqual(['ok', 'rate_limited']);
    expect(requestLines('rpc')[1]).toMatchObject({ orgId: 'org-a', method: 'getStatus' });
    expect(
      sample(await scrape(), 'iris_requests_total{method="getStatus",outcome="rate_limited"}'),
    ).toBe(before + 1);
  });

  it('logs refused upgrades with a reason and never the key', async () => {
    await serve();
    await expect(open(as(`wrong-${MARK}`))).rejects.toMatchObject({ status: 401 });
    expect(lines).toContainEqual(
      expect.objectContaining({ msg: 'connection refused', reason: 'invalid_key', status: 401 }),
    );
    expect(JSON.stringify(lines)).not.toContain(MARK);
  });

  it('logs session start and end with the reason it ended', async () => {
    await serve();
    const ws = await open(as('key-a'));
    await call(ws, 'launchBrowser');
    await call(ws, 'closeBrowser');
    const started = lines.find((l) => l.msg === 'session started');
    const ended = lines.find((l) => l.msg === 'session ended');
    expect(started).toMatchObject({ orgId: 'org-a', keyId: 'id-a' });
    expect(ended).toMatchObject({
      sessionId: started!.sessionId,
      reason: 'closed',
      browserStarted: false,
    });
  });

  it('never logs a fill value or the Authorization header, but logs the action types', async () => {
    await serve();
    const ws = await open(as(`key-${MARK}`));
    await call(ws, 'launchBrowser', { options: { timeout: 1000, retryAttempts: 0 } });
    const res = await call(ws, 'executeBrowserAction', {
      actions: [{ type: 'fill', selector: '#nowhere', text: `secret ${MARK}` }],
    });
    expect(res.result.success).toBe(false); // about:blank has no #nowhere
    await call(ws, 'closeBrowser');
    const line = requestLines('rpc').find((l) => l.method === 'executeBrowserAction');
    expect(line).toMatchObject({
      orgId: 'org-m',
      keyId: 'id-m',
      actions: ['fill'],
      success: false,
    });
    expect(JSON.stringify(lines)).not.toContain(MARK);
  }, 60_000);
});

describe('REST request logs', () => {
  const post = (headers: Record<string, string> = {}) =>
    fetch(`${httpBase}/v1/a11y/jobs`, {
      method: 'POST',
      headers: { authorization: 'Bearer key-a', 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ urls: ['https://example.com/'] }),
    });

  it('echoes X-Request-Id (generated, or a safe one the client sent) and logs it', async () => {
    await serve();
    const generated = await post();
    expect(generated.status).toBe(202);
    const id = generated.headers.get('x-request-id')!;
    expect(id).toMatch(UUID);
    expect((await post({ 'x-request-id': 'client-id.42' })).headers.get('x-request-id')).toBe(
      'client-id.42',
    );
    const unsafe = await post({ 'x-request-id': `${'x'.repeat(65)}` });
    expect(unsafe.headers.get('x-request-id')).toMatch(UUID);
    const unauth = await fetch(`${httpBase}/v1/jobs/abc`);
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get('x-request-id')).toMatch(UUID);

    // The log line is written when the response closes, just after the client has it.
    await new Promise((r) => setTimeout(r, 50));
    const rest = requestLines('rest');
    expect(rest[0]).toMatchObject({
      requestId: id,
      method: 'POST /v1/a11y/jobs',
      status: 202,
      outcome: 'ok',
      orgId: 'org-a',
      keyId: 'id-a',
    });
    expect(rest[1].requestId).toBe('client-id.42');
    // No org before authentication; the id is folded out of the route label.
    expect(rest[3]).toMatchObject({ method: 'GET /v1/jobs/:id', status: 401 });
    expect(rest[3].orgId).toBeUndefined();
    expect(rest[3].outcome).toBe('client_error');
  });

  it('logs a 429 from the request budget as rate_limited', async () => {
    await serve({ limits: { keyRequestsPerMinute: 1 } });
    await post();
    expect((await post()).status).toBe(429);
    await new Promise((r) => setTimeout(r, 50));
    expect(requestLines('rest').map((l) => l.outcome)).toEqual(['ok', 'rate_limited']);
  });
});

describe('metrics', () => {
  it('exposes request counts, latency, sessions and browsers after some requests', async () => {
    await serve();
    const before = await scrape();
    const ws = await open(as('key-a'));
    await call(ws, 'getStatus');
    await call(ws, 'getStatus');
    await call(ws, 'launchBrowser');
    const text = await scrape();
    expect(
      sample(text, 'iris_requests_total{method="getStatus",outcome="ok"}') -
        sample(before, 'iris_requests_total{method="getStatus",outcome="ok"}'),
    ).toBe(2);
    expect(text).toMatch(/^# TYPE iris_request_duration_seconds histogram$/m);
    expect(text).toMatch(
      /^iris_request_duration_seconds_bucket\{method="getStatus",le="\+Inf"\} \d+$/m,
    );
    expect(sample(text, 'iris_sessions_active')).toBe(1);
    expect(sample(text, 'iris_browsers_active')).toBe(0); // no page yet: Chromium starts lazily
    expect(text).toMatch(/^iris_up 1$/m);
    // No org or key in any series.
    expect(text).not.toMatch(/org-a|id-a/);
  });

  it('adds the cost of each settled AI call to iris_ai_spend_usd_total, ledger or not', async () => {
    const series =
      'iris_ai_spend_usd_total{provider="openai",kind="text_call",billing_mode="byok"}';
    jest.spyOn(translatorModule, 'translate').mockImplementation(async (_i, _c, scope) => {
      await scope?.onUsage?.({
        callId: `c${nextId}`,
        operation: 'text',
        provider: 'openai',
        model: 'gpt-4o-mini',
        costUsd: 0.25,
        estimated: false,
      });
      return { actions: [], method: 'ai', confidence: 0, reasoning: 'stub' };
    });
    const recorded: unknown[] = [];
    for (const usage of [
      { record: async (_o: string, e: unknown[]) => void recorded.push(...e) },
      undefined,
    ]) {
      await serve({ usage });
      const before = sample(await scrape(), series);
      const ws = await open(as('key-a'));
      await call(ws, 'launchBrowser');
      await call(ws, 'executeBrowserAction', { instruction: 'check the order total' });
      expect(sample(await scrape(), series)).toBeCloseTo(before + 0.25);
      ws.terminate();
      await new Promise((r) => server.close(() => r(null)));
    }
    expect(recorded).toHaveLength(1); // the ledger still gets its row when there is one
    server = undefined as unknown as Server;
  });
});

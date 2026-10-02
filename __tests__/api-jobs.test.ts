import { AddressInfo } from 'net';
import WebSocket from 'ws';
import { startServer, Authenticator, Principal } from '../src/protocol';
import type { OrgJobs, StoredJob, TenantScope } from '../src/history-store';

/**
 * The job REST API (#267) over real sockets: authentication, validation, limits,
 * routing, and org isolation. The store is an in-memory one with the same contract
 * as `postgresJobs` (tested against Postgres in `db/jobs.test.ts` and end to end in
 * `hosted-a11y-job.test.ts`); no Chromium starts.
 */

const keys = new Map<string, Principal>([
  ['key-a', { orgId: 'org-a', keyId: 'id-a' }],
  ['key-b', { orgId: 'org-b', keyId: 'id-b' }],
]);
let backendDown = false;
const authenticate: Authenticator = {
  async verify(header) {
    if (backendDown) throw new Error('database unreachable');
    const key = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    return (key && keys.get(key)) || null;
  },
  async recheck() {
    return true;
  },
};

let stored: Map<string, StoredJob & { orgId: string; params: unknown; keyId?: string }>;
const jobs = {
  forOrg({ orgId, apiKeyId }: TenantScope): OrgJobs {
    return {
      async enqueue({ kind, params }, { maxOutstanding = Infinity } = {}) {
        const outstanding = [...stored.values()].filter(
          (j) => j.orgId === orgId && (j.status === 'queued' || j.status === 'running'),
        ).length;
        if (outstanding >= maxOutstanding) return null;
        const id = `00000000-0000-4000-8000-${String(stored.size).padStart(12, '0')}`;
        stored.set(id, {
          id,
          orgId,
          kind,
          params,
          keyId: apiKeyId,
          status: 'queued',
          createdAt: new Date(),
          startedAt: null,
          finishedAt: null,
          summary: null,
          error: null,
          results: [],
        });
        return id;
      },
      async get(id) {
        const job = stored.get(id);
        return job && job.orgId === orgId ? job : null;
      },
    };
  },
};

let server: ReturnType<typeof startServer>;
let base: string;

async function serve(limits = {}, auth: Authenticator = authenticate) {
  server = startServer(0, { authenticate: auth, jobs, limits });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

beforeEach(() => {
  stored = new Map();
  backendDown = false;
});
afterEach(async () => {
  await new Promise((r) => server.close(() => r(null)));
});

const call = (
  method: string,
  path: string,
  { key = 'key-a', body }: { key?: string | null; body?: unknown } = {},
) =>
  fetch(base + path, {
    method,
    headers: {
      ...(key && { authorization: `Bearer ${key}` }),
      ...(body !== undefined && { 'content-type': 'application/json' }),
    },
    body: typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body),
  });

const submit = (body: unknown, key = 'key-a') => call('POST', '/v1/a11y/jobs', { key, body });

describe('job REST API', () => {
  it('queues a job (202) with defaults filled in, and reads it back', async () => {
    await serve();
    const res = await submit({ urls: ['https://example.com/'] });
    expect(res.status).toBe(202);
    const { id, status } = await res.json();
    expect(status).toBe('queued');
    expect(stored.get(id)).toMatchObject({
      orgId: 'org-a',
      keyId: 'id-a',
      params: { urls: ['https://example.com/'], wcagLevel: 'AA', failOn: ['critical', 'serious'] },
    });

    const got = await call('GET', `/v1/jobs/${id}`);
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ id, kind: 'a11y', status: 'queued' });
  });

  it('returns summary and results once finished, and error for a failed run', async () => {
    await serve();
    const { id } = await (await submit({ urls: ['https://example.com/'] })).json();
    Object.assign(stored.get(id)!, {
      status: 'succeeded',
      finishedAt: new Date(),
      summary: 'a11y: 1 page(s), 0 violation(s)',
      results: [{ url: 'https://example.com/', passed: true, result: {} }],
    });
    expect(await (await call('GET', `/v1/jobs/${id}`)).json()).toMatchObject({
      status: 'succeeded',
      summary: 'a11y: 1 page(s), 0 violation(s)',
      results: [{ url: 'https://example.com/', passed: true }],
    });
    Object.assign(stored.get(id)!, { status: 'failed', error: 'Navigation refused', results: [] });
    const failed = await (await call('GET', `/v1/jobs/${id}`)).json();
    expect(failed).toMatchObject({ status: 'failed', error: 'Navigation refused' });
    expect(failed).not.toHaveProperty('results');
  });

  it('answers another org, an unknown id and a non-uuid with the same 404', async () => {
    await serve();
    const { id } = await (await submit({ urls: ['https://example.com/'] })).json();
    for (const path of [
      `/v1/jobs/${id}`,
      '/v1/jobs/00000000-0000-4000-8000-0000000000ff',
      '/v1/jobs/x',
    ]) {
      expect((await call('GET', path, { key: 'key-b' })).status).toBe(404);
    }
  });

  it('401 without a valid key, 503 when verification cannot decide', async () => {
    await serve();
    expect((await call('GET', '/v1/jobs/x', { key: null })).status).toBe(401);
    expect((await call('GET', '/v1/jobs/x', { key: 'nope' })).status).toBe(401);
    backendDown = true;
    expect((await call('GET', '/v1/jobs/x')).status).toBe(503);
  });

  it.each([
    ['not JSON', '{nope'],
    ['no urls', {}],
    ['empty urls', { urls: [] }],
    ['21 urls', { urls: Array(21).fill('https://a.example/') }],
    ['file: URL', { urls: ['file:///etc/passwd'] }],
    ['not a URL', { urls: ['https://'] }],
    ['URL over 2048', { urls: [`https://a.example/${'x'.repeat(2048)}`] }],
    ['bad level', { urls: ['https://a.example/'], wcagLevel: 'B' }],
    ['bad impact', { urls: ['https://a.example/'], failOn: ['huge'] }],
    ['unknown field', { urls: ['https://a.example/'], extra: 1 }],
  ])('400 for %s, and queues nothing', async (_name, body) => {
    await serve();
    const res = await submit(body);
    expect(res.status).toBe(400);
    expect(typeof (await res.json()).error).toBe('string');
    expect(stored.size).toBe(0);
  });

  it('413 for a body over the limit', async () => {
    await serve();
    const res = await submit({ urls: ['https://a.example/'], pad: 'x'.repeat(70 * 1024) });
    expect(res.status).toBe(413);
    expect(stored.size).toBe(0);
  });

  it('404 for an unknown route, 405 with Allow for a wrong method', async () => {
    await serve();
    expect((await call('GET', '/v1/nothing')).status).toBe(404);
    const get = await call('GET', '/v1/a11y/jobs');
    expect([get.status, get.headers.get('allow')]).toEqual([405, 'POST']);
    const post = await call('POST', '/v1/jobs/x', { body: {} });
    expect([post.status, post.headers.get('allow')]).toEqual([405, 'GET']);
  });

  it('charges the RPC request budgets: 429 with Retry-After once the key is spent', async () => {
    await serve({ keyRequestsPerMinute: 2, orgRequestsPerMinute: 100 });
    expect((await call('GET', '/v1/jobs/x')).status).toBe(404);
    expect((await call('GET', '/v1/jobs/x')).status).toBe(404);
    const limited = await call('GET', '/v1/jobs/x');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // Another org has its own budget.
    expect((await call('GET', '/v1/jobs/x', { key: 'key-b' })).status).toBe(404);
  });

  it('sets no CORS headers', async () => {
    await serve();
    const res = await call('GET', '/v1/jobs/x');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('still upgrades WebSockets on the same port', async () => {
    await serve();
    const ws = new WebSocket(base.replace('http', 'ws'), {
      headers: { authorization: 'Bearer key-a' },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.close();
  });

  it('without `jobs` plain HTTP gets 426 as before, and `jobs` needs `authenticate`', async () => {
    server = startServer(0, { authenticate });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/a11y/jobs`;
    expect((await fetch(url, { method: 'POST' })).status).toBe(426);
    expect(() => startServer(0, { jobs, authToken: 't' })).toThrow('needs authenticate');
  });

  it('429 once an org has maxQueuedJobsPerOrg outstanding jobs; finishing one frees a slot', async () => {
    await serve({ maxQueuedJobsPerOrg: 2 });
    const first = await (await submit({ urls: ['https://a.example/'] })).json();
    expect((await submit({ urls: ['https://a.example/'] })).status).toBe(202);
    const over = await submit({ urls: ['https://a.example/'] });
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: 'Too many queued jobs' });
    // Another org is not affected.
    expect((await submit({ urls: ['https://a.example/'] }, 'key-b')).status).toBe(202);
    stored.get(first.id)!.status = 'succeeded';
    expect((await submit({ urls: ['https://a.example/'] })).status).toBe(202);
  });

  describe('verification cap (maxConnections)', () => {
    /** An authenticator whose verify calls stay pending until `release()`. */
    function slowAuth() {
      const calls: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const auth: Authenticator = {
        async verify(header) {
          calls.push(header ?? '');
          await gate;
          return authenticate.verify(header);
        },
        recheck: authenticate.recheck,
      };
      return { auth, calls, release };
    }

    it('503 with Retry-After without calling verify past the cap, and a WS upgrade is refused too', async () => {
      const { auth, calls, release } = slowAuth();
      await serve({ maxConnections: 2 }, auth);
      const pending = [call('GET', '/v1/jobs/x'), call('GET', '/v1/jobs/x')];
      await new Promise((r) => setTimeout(r, 200));
      expect(calls).toHaveLength(2);

      const refused = await call('GET', '/v1/jobs/x');
      expect(refused.status).toBe(503);
      expect(refused.headers.get('retry-after')).toBe('1');
      expect(calls).toHaveLength(2);

      const status = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(base.replace('http', 'ws'), {
          headers: { authorization: 'Bearer key-a' },
        });
        ws.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.once('open', () => reject(new Error('upgrade accepted')));
        ws.once('error', () => undefined);
      });
      expect(status).toBe(503);

      release();
      expect((await Promise.all(pending)).map((r) => r.status)).toEqual([404, 404]);
      // The slots are free again.
      expect((await call('GET', '/v1/jobs/x')).status).toBe(404);
    });
  });
});

describe('shutdown', () => {
  it('stops accepting REST requests as soon as close() is called, even with a WS client lingering', async () => {
    await serve();
    const ws = new WebSocket(base.replace('http', 'ws'), {
      headers: { authorization: 'Bearer key-a' },
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    let closed = false;
    server.close(() => (closed = true));
    await new Promise((r) => setTimeout(r, 100));
    await expect(submit({ urls: ['https://a.example/'] })).rejects.toThrow();
    expect(stored.size).toBe(0);
    // The callback waits for the lingering client.
    expect(closed).toBe(false);
    ws.close();
    await new Promise((r) => ws.once('close', r));
    await new Promise((r) => setTimeout(r, 200));
    expect(closed).toBe(true);
  });
});

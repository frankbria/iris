/**
 * The results retrieval API (#269) over real sockets and real Postgres: listing with
 * filters and cursors, run detail, and org isolation. Runs are recorded through the
 * real history store; only the API-key check is an in-test table (as in api-jobs).
 */

import { randomBytes } from 'crypto';
import { AddressInfo } from 'net';
import { Kysely, sql } from 'kysely';
import { Client } from 'pg';
import { startServer, Authenticator, Principal } from '../src/protocol';
import { createPostgresDb } from '../src/db/postgres';
import { migrateToLatest } from '../src/db/migrate';
import { postgresHistory, postgresJobs, RunInput } from '../src/history-store';
import { metrics } from '../src/metrics';

const ADMIN_URL = process.env.IRIS_TEST_DATABASE_URL;
if (!ADMIN_URL) {
  if (process.env.CI) throw new Error('IRIS_TEST_DATABASE_URL is required in CI');
  console.warn('Skipping results API tests: set IRIS_TEST_DATABASE_URL');
}

const keys = new Map<string, Principal>([
  ['key-a', { orgId: 'org-a', keyId: 'id-a' }],
  ['key-b', { orgId: 'org-b', keyId: 'id-b' }],
]);
const suspendedOrgs = new Set<string>();
const authenticate: Authenticator = {
  async verify(header) {
    const key = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    const principal = (key && keys.get(key)) || null;
    return principal && suspendedOrgs.has(principal.orgId) ? 'suspended' : principal;
  },
  async recheck() {
    return true;
  },
};

const at = (iso: string) => new Date(iso);
const rpcRun = (success: boolean, startedAt: Date): RunInput => ({
  kind: 'rpc',
  startedAt,
  finishedAt: startedAt,
  success,
  results: [
    {
      success: true,
      action: { type: 'navigate', url: 'https://shop.example/login' },
      context: { url: 'https://shop.example/login', timestamp: 1 },
    },
    {
      success,
      action: { type: 'fill', selector: '#password', text: 'hunter2-secret' },
      ...(!success && { error: 'Timeout waiting for #password' }),
    },
  ],
});

(ADMIN_URL ? describe : describe.skip)('results API (#269)', () => {
  const dbName = `iris_runs_api_${process.pid}_${randomBytes(4).toString('hex')}`;
  let db: Kysely<unknown>;
  let server: ReturnType<typeof startServer>;
  let base: string;
  /** org-a's runs, newest first. */
  const aRuns: string[] = [];
  let bRun: string;

  async function admin(query: string) {
    const client = new Client({ connectionString: ADMIN_URL });
    await client.connect();
    try {
      await client.query(query);
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    await admin(`CREATE DATABASE "${dbName}"`);
    const u = new URL(ADMIN_URL!);
    u.pathname = `/${dbName}`;
    db = createPostgresDb(u.toString());
    await migrateToLatest(db);
    for (const org of ['org-a', 'org-b']) {
      await sql`insert into organization (id, name, slug, "createdAt")
        values (${org}, ${org}, ${org}, now())`.execute(db);
    }
    const history = postgresHistory(db);
    // Recorded one after another, so created_at follows this order.
    for (const [ok, day] of [
      [true, '01'],
      [false, '02'],
      [true, '03'],
    ] as const) {
      aRuns.unshift(
        await history.forOrg({ orgId: 'org-a' }).record(rpcRun(ok, at(`2026-06-${day}T10:00:00Z`))),
      );
    }
    bRun = await history
      .forOrg({ orgId: 'org-b' })
      .record(rpcRun(true, at('2026-06-01T10:00:00Z')));
    server = startServer(0, {
      authenticate,
      jobs: postgresJobs(db),
      runs: postgresHistory(db),
    });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => server?.close(() => r(null)));
    await db?.destroy();
    await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  });

  beforeEach(() => suspendedOrgs.clear());

  const get = (path: string, key: string | null = 'key-a', method = 'GET') =>
    fetch(base + path, { method, headers: key ? { authorization: `Bearer ${key}` } : {} });

  it("lists the caller org's finished runs, newest first", async () => {
    const res = await get('/v1/runs');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runs.map((r: { id: string }) => r.id)).toEqual(aRuns);
    expect(body.runs[0]).toEqual({
      id: aRuns[0],
      kind: 'rpc',
      status: 'succeeded',
      summary: expect.any(String),
      startedAt: '2026-06-03T10:00:00.000Z',
      finishedAt: '2026-06-03T10:00:00.000Z',
      createdAt: expect.any(String),
    });
    expect(body.nextCursor).toBeNull();
    // org-b sees only its own.
    const b = await (await get('/v1/runs', 'key-b')).json();
    expect(b.runs.map((r: { id: string }) => r.id)).toEqual([bRun]);
  });

  it('pages with limit and cursor, and filters by status and kind', async () => {
    const first = await (await get('/v1/runs?limit=2')).json();
    expect(first.runs.map((r: { id: string }) => r.id)).toEqual(aRuns.slice(0, 2));
    const next = await (
      await get(`/v1/runs?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)
    ).json();
    expect(next.runs.map((r: { id: string }) => r.id)).toEqual(aRuns.slice(2));
    expect(next.nextCursor).toBeNull();
    const failed = await (await get('/v1/runs?status=failed')).json();
    expect(failed.runs.map((r: { id: string }) => r.id)).toEqual([aRuns[1]]);
    expect((await (await get('/v1/runs?kind=a11y')).json()).runs).toEqual([]);
  });

  it('filters by finish time (from inclusive, to exclusive)', async () => {
    const from = await (await get('/v1/runs?from=2026-06-02T10:00:00Z')).json();
    expect(from.runs.map((r: { id: string }) => r.id)).toEqual(aRuns.slice(0, 2));
    const to = await (await get('/v1/runs?to=2026-06-02T10:00:00Z')).json();
    expect(to.runs.map((r: { id: string }) => r.id)).toEqual(aRuns.slice(2));
  });

  it('returns run detail with its results, and never the typed value', async () => {
    const res = await get(`/v1/runs/${aRuns[1]}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: aRuns[1], kind: 'rpc', status: 'failed' });
    expect(body.results).toHaveLength(2);
    expect(body.results[0]).toMatchObject({ url: 'https://shop.example/login', passed: true });
    expect(JSON.stringify(body)).not.toContain('hunter2-secret');
  });

  it('accepts canceled as a status filter', async () => {
    const res = await get('/v1/runs?status=canceled');
    expect(res.status).toBe(200);
    expect((await res.json()).runs).toEqual([]);
  });

  // #254 strips URL userinfo when it stores a run; run detail is readable by every key
  // of the org, so secret-looking query values go too (the logger's rules, #275).
  it('cuts secret-looking query values from run detail', async () => {
    const run = rpcRun(true, at('2026-06-04T10:00:00Z')) as Extract<RunInput, { kind: 'rpc' }>;
    run.results[0] = {
      success: true,
      action: { type: 'navigate', url: 'https://shop.example/reset?token=s3cr3t-tok&page=2' },
      context: { url: 'https://shop.example/reset?token=s3cr3t-tok&page=2', timestamp: 1 },
    };
    const id = await postgresHistory(db).forOrg({ orgId: 'org-a' }).record(run);
    try {
      const text = await (await get(`/v1/runs/${id}`)).text();
      expect(text).not.toContain('s3cr3t-tok');
      expect(text).toContain('page=2');
    } finally {
      await sql`delete from run_results where run_id = ${id}`.execute(db);
      await sql`delete from runs where id = ${id}`.execute(db);
    }
  });

  it('a job that could not run says why: its error, no results', async () => {
    const { rows } = await sql<{ id: string }>`
      insert into runs (org_id, kind, status, error, started_at, finished_at)
      values ('org-a', 'a11y', 'failed', 'Organization suspended', now(), now())
      returning id`.execute(db);
    try {
      const body = await (await get(`/v1/runs/${rows[0].id}`)).json();
      expect(body).toMatchObject({
        status: 'failed',
        summary: null,
        error: 'Organization suspended',
        results: [],
      });
    } finally {
      await sql`delete from runs where id = ${rows[0].id}`.execute(db);
    }
  });

  it("answers 404 for another org's run, an unknown id and a non-uuid", async () => {
    expect((await get(`/v1/runs/${bRun}`)).status).toBe(404);
    expect((await get(`/v1/runs/${aRuns[0]}`, 'key-b')).status).toBe(404);
    expect((await get('/v1/runs/00000000-0000-4000-8000-000000000999')).status).toBe(404);
    expect((await get('/v1/runs/not-a-uuid')).status).toBe(404);
  });

  it.each([
    ['limit=0'],
    ['limit=101'],
    ['limit=ten'],
    ['kind=video'],
    ['status=running'],
    ['from=yesterday'],
    ['cursor=garbage'],
    ['unknown=1'],
    // Repeated parameters would silently keep the last value.
    ['kind=rpc&kind=a11y'],
    // Number() reads these as 16 and 10; only plain digits are a limit.
    ['limit=0x10'],
    ['limit=1e1'],
    ['from=2026-06-01'],
    // Well-formed but impossible: zod checks the shape only, and Postgres would 500.
    ['from=2026-13-01T00:00:00Z'],
    ['to=2026-02-30T00:00:00Z'],
    ['from=2026-06-01T25:00:00Z'],
  ])('400 for %s', async (query) => {
    const res = await get(`/v1/runs?${query}`);
    expect(res.status).toBe(400);
    expect(typeof (await res.json()).error).toBe('string');
  });

  it('needs a key (401), refuses a suspended org (403), and only GET (405)', async () => {
    expect((await get('/v1/runs', null)).status).toBe(401);
    expect((await get('/v1/runs/x', 'nope')).status).toBe(401);
    suspendedOrgs.add('org-a');
    expect((await get('/v1/runs')).status).toBe(403);
    expect((await get(`/v1/runs/${aRuns[0]}`)).status).toBe(403);
    suspendedOrgs.clear();
    const post = await get('/v1/runs', 'key-a', 'POST');
    expect([post.status, post.headers.get('allow')]).toEqual([405, 'GET']);
  });

  it('labels requests by route, the id folded', async () => {
    await get(`/v1/runs/${aRuns[0]}`);
    const text = metrics.render();
    expect(text).toMatch(/method="GET \/v1\/runs\/:id"/);
    expect(text).toMatch(/method="GET \/v1\/runs"/);
    expect(text).not.toContain(aRuns[0]);
  });
});

/**
 * The hosted a11y job, end to end (#267): HTTP submit -> worker -> HTTP result.
 *
 * Test strategy: real everything. `startServer` with the Postgres job store, a real
 * Chromium through the hardened launcher, IRIS_HOSTED=1 (set before any module reads
 * it). The shared egress proxy is started first with a fake resolver and a dialer that
 * serves one "public" name, `site.test`, from a local server, so the scanned page is
 * fetched *through* the hosted proxy. Refusal tests assert the local server was never
 * hit. Needs IRIS_TEST_DATABASE_URL (required under CI, skipped locally without it).
 */
process.env.IRIS_HOSTED = '1';

import { randomBytes } from 'crypto';
import { once } from 'events';
import * as http from 'http';
import * as net from 'net';
import { AddressInfo } from 'net';
import { Kysely, sql } from 'kysely';
import { Client } from 'pg';
import { createPostgresDb } from '../src/db/postgres';
import { migrateToLatest } from '../src/db/migrate';
import { hostedEgressProxy } from '../src/egress-proxy';
import { postgresJobs } from '../src/history-store';
import { startServer, type Authenticator, type Principal } from '../src/protocol';
import { processNextA11yJob } from '../src/worker';
import { orgSuspensions } from '../src/org-suspension';

const ADMIN_URL = process.env.IRIS_TEST_DATABASE_URL;

if (!ADMIN_URL) {
  if (process.env.CI) throw new Error('IRIS_TEST_DATABASE_URL is required in CI');
  console.warn('Skipping hosted a11y job tests: set IRIS_TEST_DATABASE_URL');
}

const PUBLIC = '8.8.8.8';
// An <img> with no alt text: a critical axe violation.
const PAGE =
  '<!doctype html><html lang="en"><head><title>t</title></head><body><main><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></main></body></html>';

(ADMIN_URL ? describe : describe.skip)('hosted a11y job API, end to end', () => {
  const dbName = `iris_e2e_${process.pid}_${randomBytes(4).toString('hex')}`;
  let db: Kysely<unknown>;
  let site: http.Server;
  let sitePort: number;
  let seen: string[] = [];
  let server: ReturnType<typeof startServer>;
  let base: string;

  const keys = new Map<string, Principal>([
    ['key-a', { orgId: 'org-a', keyId: 'key-org-a' }],
    ['key-b', { orgId: 'org-b', keyId: 'key-org-b' }],
  ]);
  const authenticate: Authenticator = {
    async verify(header) {
      return keys.get(header?.replace('Bearer ', '') ?? '') ?? null;
    },
    async recheck() {
      return true;
    },
  };

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
      await sql`insert into apikey (id, "configId", "referenceId", key, "createdAt", "updatedAt")
        values (${`key-${org}`}, 'default', ${org}, ${`hash-${org}`}, now(), now())`.execute(db);
    }

    site = http.createServer((req, res) => {
      seen.push(`${req.headers.host} ${req.url}`);
      res.setHeader('content-type', 'text/html');
      res.end(PAGE);
    });
    site.listen(0, '127.0.0.1');
    await once(site, 'listening');
    sitePort = (site.address() as AddressInfo).port;

    // Before the first launch: the one proxy of this process.
    // Every address a refusal test might use is dialed to the site server, so a policy
    // that let one through would show up as a hit in `seen`, not as a failed dial.
    const INTERNAL = new Set(['10.0.0.5', '127.0.0.1', '169.254.169.254']);
    await hostedEgressProxy({
      lookup: async (host) => {
        if (host === 'site.test') return [PUBLIC];
        if (host === 'internal.test') return ['10.0.0.5'];
        if (host === 'localhost') return ['127.0.0.1'];
        throw new Error(`ENOTFOUND ${host}`);
      },
      connect: (address) =>
        net.connect({
          host: '127.0.0.1',
          port: address === PUBLIC || INTERNAL.has(address) ? sitePort : 1,
        }),
    });

    server = startServer(0, { authenticate, jobs: postgresJobs(db) });
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => server?.close(() => r(null)));
    site?.close();
    await db?.destroy();
    await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  });

  beforeEach(() => {
    seen = [];
  });

  const api = (method: string, path: string, key = 'key-a', body?: unknown) =>
    fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const submit = async (urls: string[]) => {
    const res = await api('POST', '/v1/a11y/jobs', 'key-a', { urls, failOn: ['critical'] });
    expect(res.status).toBe(202);
    return ((await res.json()) as { id: string }).id;
  };

  it('scans a public page through the hosted proxy and reports the violation', async () => {
    const id = await submit([`http://site.test:${sitePort}/page`]);
    expect(await (await api('GET', `/v1/jobs/${id}`)).json()).toMatchObject({ status: 'queued' });

    const job = await processNextA11yJob(postgresJobs(db));
    expect(job?.id).toBe(id);
    expect(seen).toEqual([`site.test:${sitePort} /page`]);

    const body = await (await api('GET', `/v1/jobs/${id}`)).json();
    expect(body).toMatchObject({
      id,
      kind: 'a11y',
      // The run's verdict: a critical violation breaches failOn.
      status: 'failed',
      summary: 'a11y: 1 page(s), 1 violation(s)',
      results: [{ url: `http://site.test:${sitePort}/page`, passed: false }],
    });
    expect(body).not.toHaveProperty('error');
    expect(body.results[0].result.violations.critical).toBe(1);
    expect(body.startedAt).toBeTruthy();
    expect(body.finishedAt).toBeTruthy();

    // Another org cannot see it.
    expect((await api('GET', `/v1/jobs/${id}`, 'key-b')).status).toBe(404);

    const runs = await sql<{ org_id: string; api_key_id: string; status: string }>`
      select org_id, api_key_id, status from runs where id = ${id}`.execute(db);
    expect(runs.rows).toEqual([{ org_id: 'org-a', api_key_id: 'key-org-a', status: 'failed' }]);
    const results =
      await sql`select 1 from run_results where run_id = ${id} and org_id = 'org-a'`.execute(db);
    expect(results.rows).toHaveLength(1);
    const usage = await sql<{
      org_id: string;
      kind: string;
      idempotency_key: string;
      quantity: string;
    }>`
      select org_id, kind, idempotency_key, quantity from usage_events where run_id = ${id}`.execute(
      db,
    );
    expect(usage.rows).toEqual([
      { org_id: 'org-a', kind: 'a11y_job', idempotency_key: `job:${id}`, quantity: '1' },
    ]);
  });

  // `policy`: the URL policy refuses it before any request (literal hosts). `proxy`: only the
  // egress proxy can, because the name resolves to an internal address.
  it.each([
    [
      'loopback',
      () => `http://127.0.0.1:${sitePort}/`,
      /blocked by navigation policy: .*private\/loopback/,
    ],
    [
      'link-local metadata',
      () => 'http://169.254.169.254/latest/meta-data/',
      /blocked by navigation policy: .*link-local/,
    ],
    [
      'localhost',
      () => `http://localhost:${sitePort}/`,
      /blocked by navigation policy: .*private\/loopback/,
    ],
    [
      'a name resolving to a private address',
      () => `http://internal.test:${sitePort}/`,
      /answered HTTP 403/,
    ],
  ])('refuses a job for %s: it fails, nothing is fetched, no usage', async (_name, url, reason) => {
    const id = await submit([url()]);
    await processNextA11yJob(postgresJobs(db));
    expect(seen).toEqual([]);

    const body = await (await api('GET', `/v1/jobs/${id}`)).json();
    expect(body.status).toBe('failed');
    expect(body.error).toMatch(reason);
    expect(body).not.toHaveProperty('results');
    const usage = await sql`select 1 from usage_events where run_id = ${id}`.execute(db);
    expect(usage.rows).toEqual([]);
  });

  it("fails a suspended org's queued job without running it: no fetch, no usage (#348)", async () => {
    const id = await submit([`http://site.test:${sitePort}/page`]);
    const susp = orgSuspensions(db);
    await susp.suspend('org-a', { reason: 'abuse report', actor: 'test' });
    try {
      const job = await processNextA11yJob(postgresJobs(db));
      expect(job?.id).toBe(id);
    } finally {
      await susp.unsuspend('org-a', { reason: 'resolved', actor: 'test' });
    }
    expect(seen).toEqual([]);
    const body = await (await api('GET', `/v1/jobs/${id}`)).json();
    expect(body).toMatchObject({ status: 'failed', error: 'Organization suspended' });
    expect(body).not.toHaveProperty('results');
    const usage = await sql`select 1 from usage_events where run_id = ${id}`.execute(db);
    expect(usage.rows).toEqual([]);
  });

  it('an empty queue is a no-op', async () => {
    expect(await processNextA11yJob(postgresJobs(db))).toBeNull();
  });
});

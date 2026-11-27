/**
 * Hosted MCP, end to end (#314): MCP tool call over HTTP -> job queue -> worker -> result,
 * with the run in the org's history and one usage row.
 *
 * Test strategy: real everything, as `hosted-a11y-job.test.ts`. The SDK's Streamable HTTP
 * client calls `/v1/mcp` on `startServer` with the Postgres job store; a real worker pass
 * (`processNextA11yJob`) scans the page in real Chromium through the hosted egress proxy
 * (fake resolver, one "public" name served from a local server). IRIS_HOSTED=1 is set
 * before any module reads it. Needs IRIS_TEST_DATABASE_URL (required under CI).
 */
process.env.IRIS_HOSTED = '1';

import { randomBytes } from 'crypto';
import { once } from 'events';
import * as http from 'http';
import * as net from 'net';
import { AddressInfo } from 'net';
import { Kysely, sql } from 'kysely';
import { Client as PgClient } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createPostgresDb } from '../src/db/postgres';
import { migrateToLatest } from '../src/db/migrate';
import { hostedEgressProxy } from '../src/egress-proxy';
import { postgresHistory, postgresJobs, type ClaimedJob } from '../src/history-store';
import { startServer, type Authenticator, type Principal } from '../src/protocol';
import { processNextA11yJob } from '../src/worker';
import { axeRuleHelpUrl } from '../src/mcp/axe-help-url';

const ADMIN_URL = process.env.IRIS_TEST_DATABASE_URL;

if (!ADMIN_URL) {
  if (process.env.CI) throw new Error('IRIS_TEST_DATABASE_URL is required in CI');
  console.warn('Skipping hosted MCP job tests: set IRIS_TEST_DATABASE_URL');
}

const PUBLIC = '8.8.8.8';
// An <img> with no alt text: a critical axe violation.
const PAGE =
  '<!doctype html><html lang="en"><head><title>t</title></head><body><main><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></main></body></html>';

(ADMIN_URL ? describe : describe.skip)('hosted MCP tool call, end to end', () => {
  const dbName = `iris_mcp_${process.pid}_${randomBytes(4).toString('hex')}`;
  let db: Kysely<unknown>;
  let site: http.Server;
  let sitePort: number;
  let seen: string[] = [];
  let server: ReturnType<typeof startServer>;
  let base: string;
  const clients: Client[] = [];

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
    const client = new PgClient({ connectionString: ADMIN_URL });
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
      if (req.url === '/moved') {
        res.writeHead(302, { location: '/signin?token=s3cret' }).end();
        return;
      }
      res.setHeader('content-type', 'text/html');
      // Pages that move on by script once their own response has arrived (#662).
      const moves: Record<string, string> = {
        '/moved-by-script': '/signin?token=s3cret',
        '/script-to-internal': `http://internal.test:${sitePort}/secret-path`,
      };
      const target = moves[req.url ?? ''];
      res.end(
        target
          ? PAGE.replace('<main>', `<script>location.replace('${target}')</script><main>`)
          : PAGE,
      );
    });
    site.listen(0, '127.0.0.1');
    await once(site, 'listening');
    sitePort = (site.address() as AddressInfo).port;

    // Before the first launch: the one proxy of this process. An internal address is
    // dialed to the site server too, so a policy that let it through shows up in `seen`.
    await hostedEgressProxy({
      lookup: async (host) => {
        if (host === 'site.test') return [PUBLIC];
        if (host === 'internal.test') return ['10.0.0.5'];
        throw new Error(`ENOTFOUND ${host}`);
      },
      connect: (address) =>
        net.connect({
          host: '127.0.0.1',
          port: address === PUBLIC || address === '10.0.0.5' ? sitePort : 1,
        }),
    });

    server = startServer(0, { authenticate, jobs: postgresJobs(db), runs: postgresHistory(db) });
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close()));
    await new Promise((r) => server?.close(() => r(null)));
    site?.closeAllConnections();
    site?.close();
    await db?.destroy();
    await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  });

  beforeEach(() => {
    seen = [];
  });

  async function connect(key = 'key-a'): Promise<Client> {
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/v1/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${key}` } },
      }),
    );
    clients.push(client);
    return client;
  }

  /** One worker pass, once the tool call has queued its job. Bounded by poll count. */
  async function workerRunsNext(): Promise<ClaimedJob> {
    for (let i = 0; i < 100; i++) {
      const job = await processNextA11yJob(postgresJobs(db));
      if (job) return job;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('the tool call queued no job');
  }

  const textOf = (result: Awaited<ReturnType<Client['callTool']>>) =>
    (result.content as Array<{ text: string }>).map((c) => c.text).join('\n');

  it('scans the page in the worker and records the run in history and usage', async () => {
    const client = await connect();
    const url = `http://site.test:${sitePort}/page`;
    const [result, job] = await Promise.all([
      client.callTool({ name: 'run_accessibility_test', arguments: { url } }),
      workerRunsNext(),
    ]);

    expect(seen).toEqual([`site.test:${sitePort} /page`]); // fetched through the proxy
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      jobId: job.id,
      status: 'finished',
      url,
      passed: false,
      violationCount: 1,
      violations: [{ id: 'image-alt', impact: 'critical', nodes: 1 }],
    });
    expect(textOf(result)).toContain('[critical] image-alt');

    // History: the org's run list, through the results API, with the key that asked.
    const list = await fetch(`${base}/v1/runs?kind=a11y`, {
      headers: { authorization: 'Bearer key-a' },
    });
    expect(((await list.json()) as { runs: Array<{ id: string }> }).runs.map((r) => r.id)).toEqual([
      job.id,
    ]);
    const runs = await sql<{ org_id: string; api_key_id: string; status: string }>`
      select org_id, api_key_id, status from runs where id = ${job.id}`.execute(db);
    expect(runs.rows).toEqual([{ org_id: 'org-a', api_key_id: 'key-org-a', status: 'failed' }]);

    // Usage: one a11y job, tied to the run.
    const usage = await sql<{ org_id: string; kind: string; quantity: string }>`
      select org_id, kind, quantity from usage_events where run_id = ${job.id}`.execute(db);
    expect(usage.rows).toEqual([{ org_id: 'org-a', kind: 'a11y_job', quantity: '1' }]);

    // The other org sees neither the run nor the scan.
    const other = await (
      await connect('key-b')
    ).callTool({ name: 'get_accessibility_test_result', arguments: { jobId: job.id } });
    expect(other.isError).toBe(true);
    // The org that ran it reads it back without a second scan.
    const again = await client.callTool({
      name: 'get_accessibility_test_result',
      arguments: { jobId: job.id },
    });
    expect(again.structuredContent).toMatchObject({ status: 'finished', violationCount: 1 });
    expect(seen).toHaveLength(1);
  });

  it('reports the page a redirect landed on, with a help link per rule (#648)', async () => {
    const client = await connect();
    const url = `http://site.test:${sitePort}/moved`;
    const [result, job] = await Promise.all([
      client.callTool({ name: 'run_accessibility_test', arguments: { url } }),
      workerRunsNext(),
    ]);

    expect(seen).toEqual([
      `site.test:${sitePort} /moved`,
      `site.test:${sitePort} /signin?token=s3cret`,
    ]);
    const landed = `http://site.test:${sitePort}/signin`;
    expect(result.structuredContent).toMatchObject({
      jobId: job.id,
      status: 'finished',
      url: landed,
      redirected: true,
      redirectedFrom: url,
      violations: [{ id: 'image-alt', helpUrl: axeRuleHelpUrl('image-alt') }],
    });
    expect(textOf(result)).toContain(`on ${landed} (redirected from ${url})`);

    // Stored beside the request, cut: what the results API serves to the whole org.
    const read = await fetch(`${base}/v1/runs/${job.id}`, {
      headers: { authorization: 'Bearer key-a' },
    });
    const body = await read.text();
    expect(body).toContain(`"landedUrl":"${landed}"`);
    expect(body).not.toContain('s3cret');
  });

  it('reports the page a script moved on to, and stores it as landedUrl (#662)', async () => {
    const client = await connect();
    const url = `http://site.test:${sitePort}/moved-by-script`;
    const [result, job] = await Promise.all([
      client.callTool({ name: 'run_accessibility_test', arguments: { url } }),
      workerRunsNext(),
    ]);

    expect(seen).toEqual([
      `site.test:${sitePort} /moved-by-script`,
      `site.test:${sitePort} /signin?token=s3cret`,
    ]);
    const landed = `http://site.test:${sitePort}/signin`;
    expect(result.structuredContent).toMatchObject({
      jobId: job.id,
      status: 'finished',
      url: landed,
      redirected: true,
      redirectedFrom: url,
    });
    expect(textOf(result)).toContain(`on ${landed} (redirected from ${url})`);

    const read = await fetch(`${base}/v1/runs/${job.id}`, {
      headers: { authorization: 'Bearer key-a' },
    });
    const body = await read.text();
    expect(body).toContain(`"landedUrl":"${landed}"`);
    expect(body).not.toContain('s3cret');
  });

  it('a script that moves on to a name the egress proxy refuses fails the scan (#662)', async () => {
    const client = await connect();
    const url = `http://site.test:${sitePort}/script-to-internal`;
    const [result, job] = await Promise.all([
      client.callTool({ name: 'run_accessibility_test', arguments: { url } }),
      workerRunsNext(),
    ]);

    // The first page was fetched; the internal one never was.
    expect(seen).toEqual([`site.test:${sitePort} /script-to-internal`]);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      `Accessibility scan ${job.id} failed: the scan could not be completed (details are on the server log).`,
    );
    expect(JSON.stringify(result)).not.toContain('internal.test');
    const usage = await sql`select 1 from usage_events where run_id = ${job.id}`.execute(db);
    expect(usage.rows).toEqual([]);
  });

  it('a page the egress proxy refuses is a tool error in fixed words, with no usage', async () => {
    const client = await connect();
    const url = `http://internal.test:${sitePort}/secret-path`;
    const [result, job] = await Promise.all([
      client.callTool({ name: 'run_accessibility_test', arguments: { url } }),
      workerRunsNext(),
    ]);

    expect(seen).toEqual([]);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      `Accessibility scan ${job.id} failed: the scan could not be completed (details are on the server log).`,
    );
    const usage = await sql`select 1 from usage_events where run_id = ${job.id}`.execute(db);
    expect(usage.rows).toEqual([]);
  });
});

/**
 * The hosted visual-diff job, end to end (#268): submit -> worker -> results with diff
 * images -> approve -> the next run passes against the approved baseline.
 *
 * Test strategy: real everything, as in hosted-a11y-job.test.ts. IRIS_HOSTED=1 (set
 * before any module reads it), Postgres, a real Chromium through the hardened launcher,
 * the egress proxy serving one "public" name (`site.test`) from a local server whose
 * page the test changes between runs, and SeaweedFS for the artifacts. Needs
 * IRIS_TEST_DATABASE_URL and IRIS_TEST_S3_* (required under CI, skipped locally).
 */
process.env.IRIS_HOSTED = '1';

import { randomBytes } from 'crypto';
import { once } from 'events';
import * as http from 'http';
import * as net from 'net';
import { AddressInfo } from 'net';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Kysely, sql } from 'kysely';
import { Client } from 'pg';
import { S3ArtifactStore } from '../src/artifact-store';
import { createPostgresDb } from '../src/db/postgres';
import { migrateToLatest } from '../src/db/migrate';
import { hostedEgressProxy } from '../src/egress-proxy';
import { postgresHistory, postgresJobs } from '../src/history-store';
import { startServer, type Authenticator, type Principal } from '../src/protocol';
import { processNextVisualJob } from '../src/worker';
import { runVisualJob } from '../src/visual/hosted-job';
import { orgArtifacts } from '../src/artifact-store';

const ADMIN_URL = process.env.IRIS_TEST_DATABASE_URL;
const S3 = {
  endpoint: process.env.IRIS_TEST_S3_ENDPOINT,
  accessKeyId: process.env.IRIS_TEST_S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.IRIS_TEST_S3_SECRET_ACCESS_KEY,
};
const READY = Boolean(ADMIN_URL && S3.endpoint && S3.accessKeyId && S3.secretAccessKey);
if (!READY) {
  if (process.env.CI)
    throw new Error('IRIS_TEST_DATABASE_URL and IRIS_TEST_S3_* are required in CI');
  console.warn('Skipping hosted visual job tests: set IRIS_TEST_DATABASE_URL and IRIS_TEST_S3_*');
}

const PUBLIC = '8.8.8.8';
const page = (color: string) =>
  `<!doctype html><html><head><style>html,body{margin:0;height:100%;background:#fff}` +
  `div{height:300px;background:${color}}</style></head><body><div></div></body></html>`;

(READY ? describe : describe.skip)('hosted visual-diff job API, end to end (#268)', () => {
  const dbName = `iris_vis_${process.pid}_${randomBytes(4).toString('hex')}`;
  const bucket = `iris-vis-${randomBytes(4).toString('hex')}`;
  const credentials = { accessKeyId: S3.accessKeyId!, secretAccessKey: S3.secretAccessKey! };
  const store = new S3ArtifactStore({
    endpoint: S3.endpoint!,
    region: 'us-east-1',
    bucket,
    credentials,
  });
  let db: Kysely<unknown>;
  let site: http.Server;
  let sitePort: number;
  let color = '#000';
  let status = 200;
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
    const s3 = new S3Client({
      endpoint: S3.endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials,
    });
    for (let i = 1; ; i++) {
      try {
        await s3.send(new CreateBucketCommand({ Bucket: bucket }));
        break;
      } catch (e) {
        if (i >= 30) throw e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    s3.destroy();

    site = http.createServer((_req, res) => {
      res.statusCode = status;
      res.setHeader('content-type', 'text/html');
      res.end(page(color));
    });
    site.listen(0, '127.0.0.1');
    await once(site, 'listening');
    sitePort = (site.address() as AddressInfo).port;
    await hostedEgressProxy({
      lookup: async (host) => {
        if (host === 'site.test') return [PUBLIC];
        throw new Error(`ENOTFOUND ${host}`);
      },
      connect: (address) =>
        net.connect({ host: '127.0.0.1', port: address === PUBLIC ? sitePort : 1 }),
    });

    server = startServer(0, {
      authenticate,
      jobs: postgresJobs(db),
      runs: postgresHistory(db),
      artifacts: store,
    });
    await once(server, 'listening');
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => server?.close(() => r(null)));
    site?.close();
    store.close();
    await db?.destroy();
    await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  });

  const api = (method: string, path: string, key = 'key-a', body?: unknown) =>
    fetch(base + path, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const url = () => `http://site.test:${sitePort}/`;
  /** Submits, runs the worker once, and returns the finished run's detail. */
  async function run(project = 'shop') {
    const res = await api('POST', '/v1/visual/jobs', 'key-a', { project, urls: [url()] });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    expect((await processNextVisualJob(postgresJobs(db), { artifacts: store }))?.id).toBe(id);
    const detail = await (await api('GET', `/v1/runs/${id}`)).json();
    return { id, detail };
  }
  const fetchText = async (u: string) => (await fetch(u)).status;

  it('first run creates the baseline, second diffs, approval replaces it', async () => {
    // 1. No baseline yet: this run's screenshot becomes it.
    color = '#000';
    const first = await run();
    expect(first.detail).toMatchObject({ kind: 'visual', status: 'succeeded' });
    const r1 = first.detail.results[0];
    expect(r1).toMatchObject({ url: url(), passed: true });
    expect(r1.result).toMatchObject({ project: 'shop', device: 'desktop', newBaseline: true });
    expect(Object.keys(r1.result.artifacts).sort()).toEqual(['baseline', 'current']);
    expect(await fetchText(r1.result.artifacts.baseline.url)).toBe(200);

    // 2. The page changed: the run fails with a diff image.
    color = '#c00';
    const second = await run();
    expect(second.detail).toMatchObject({ status: 'failed' });
    const r2 = second.detail.results[0];
    expect(r2.passed).toBe(false);
    expect(r2.result.diffPercentage).toBeGreaterThan(0);
    expect(Object.keys(r2.result.artifacts).sort()).toEqual(['baseline', 'current', 'diff']);
    const diff = await fetch(r2.result.artifacts.diff.url);
    expect(diff.status).toBe(200);
    expect(diff.headers.get('content-type')).toBe('image/png');

    // Another org cannot approve it.
    expect((await api('POST', `/v1/runs/${second.id}/results/0/approve`, 'key-b')).status).toBe(
      404,
    );

    // 3. Approve the change: the changed screenshot is the baseline now.
    const approved = await api('POST', `/v1/runs/${second.id}/results/0/approve`);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({
      project: 'shop',
      page: url(),
      device: 'desktop',
    });

    // 4. Same page again: passes against the approved baseline.
    const third = await run();
    expect(third.detail).toMatchObject({ status: 'succeeded' });
    expect(third.detail.results[0].result.newBaseline).toBeUndefined();
    expect(third.detail.results[0].result.diffPercentage).toBe(0);

    // Usage: one visual_job per run, keyed by the job.
    const usage = await sql<{ n: number }>`select count(*)::int as n from usage_events
      where org_id = 'org-a' and kind = 'visual_job'`.execute(db);
    expect(usage.rows[0].n).toBe(3);
  }, 180_000);

  // Two jobs of one project that both find no baseline: one seeds, the other compares
  // with it. A stale seeder (reaped, still running) never overwrites, even an approval.
  it('seeds a first baseline once, whatever the race, and never over an approval', async () => {
    color = '#00c';
    const submit = async () =>
      (
        (await (
          await api('POST', '/v1/visual/jobs', 'key-a', { project: 'race', urls: [url()] })
        ).json()) as {
          id: string;
        }
      ).id;
    const ids = [await submit(), await submit()];
    await Promise.all([
      processNextVisualJob(postgresJobs(db), { artifacts: store }),
      processNextVisualJob(postgresJobs(db), { artifacts: store }),
    ]);
    const details = await Promise.all(
      ids.map(async (id) => (await api('GET', `/v1/runs/${id}`)).json()),
    );
    expect(details.filter((d) => d.results[0].result.newBaseline)).toHaveLength(1);
    expect(details.every((d) => d.status === 'succeeded')).toBe(true);

    // A seeding attempt after an approval changes nothing.
    const baselines = postgresJobs(db).baselines('org-a');
    const before = await sql`select object_key, approved_by from visual_baselines
      where org_id = 'org-a' and project = 'race'`.execute(db);
    const row = before.rows[0] as { object_key: string };
    expect(
      await baselines.insertIfAbsent({
        project: 'race',
        name: (
          await sql<{
            name: string;
          }>`select name from visual_baselines where project = 'race'`.execute(db)
        ).rows[0].name,
        page: url(),
        device: 'desktop',
        objectKey: 'org/org-a/project/race/baselines/stale.png',
        runId: null,
        approvedBy: 'first-run',
      }),
    ).toBe(false);
    const after = await sql`select object_key, approved_by from visual_baselines
      where org_id = 'org-a' and project = 'race'`.execute(db);
    expect(after.rows).toEqual(before.rows);
    expect(row.object_key).toMatch(/--[0-9a-f]{12}\.png$/);
  }, 180_000);

  it('an old run keeps linking the baseline it was compared with', async () => {
    // From the first test: run 2 compared with run 1's baseline; run 2 was then approved.
    const { rows } = await sql<{ id: string }>`select id from runs where org_id = 'org-a'
      and kind = 'visual' and status = 'failed' order by finished_at limit 1`.execute(db);
    const detail = await (await api('GET', `/v1/runs/${rows[0].id}`)).json();
    const { url: baselineUrl } = detail.results[0].result.artifacts.baseline;
    const { url: currentUrl } = detail.results[0].result.artifacts.current;
    // The baseline it was compared with (black), not the approved one (its own, red).
    const [b, c] = await Promise.all(
      [baselineUrl, currentUrl].map(async (u) => Buffer.from(await (await fetch(u)).arrayBuffer())),
    );
    expect(b.equals(c)).toBe(false);
  });

  it('stops at the deadline and refuses a too-tall page', async () => {
    const ctx = {
      artifacts: orgArtifacts(store, 'org-a'),
      baselines: postgresJobs(db).baselines('org-a'),
      orgId: 'org-a',
      runId: '00000000-0000-4000-8000-000000000001',
    };
    const params = {
      project: 'limits',
      urls: [url()],
      devices: ['desktop' as const],
      threshold: 0.01,
    };
    await expect(runVisualJob(params, { ...ctx, deadlineMs: -1 })).rejects.toThrow(
      /ran out of time/,
    );
    await expect(runVisualJob(params, { ...ctx, maxPageHeight: 100 })).rejects.toThrow(/px tall/);
  }, 120_000);

  it('baselines belong to a project: another project starts its own', async () => {
    color = '#c00';
    const other = await run('blog');
    expect(other.detail.results[0].result).toMatchObject({ project: 'blog', newBaseline: true });
  }, 120_000);

  it('an error page fails the job instead of becoming a baseline', async () => {
    status = 403;
    try {
      const res = await api('POST', '/v1/visual/jobs', 'key-a', {
        project: 'errors',
        urls: [url()],
      });
      const { id } = (await res.json()) as { id: string };
      await processNextVisualJob(postgresJobs(db), { artifacts: store });
      const job = await (await api('GET', `/v1/jobs/${id}`)).json();
      expect(job).toMatchObject({ status: 'failed', error: expect.stringMatching(/HTTP 403/) });
      const rows = await sql`select 1 from visual_baselines where project = 'errors'`.execute(db);
      expect(rows.rows).toHaveLength(0);
    } finally {
      status = 200;
    }
  }, 120_000);

  it.each([
    [{ project: 'bad/name', urls: ['https://a.example/'] }, /project/],
    [{ project: 'p', urls: ['https://u:p@a.example/'] }, /credentials/],
    [{ project: 'p', urls: ['https://a.example/'], devices: ['watch'] }, /devices/],
    [{ project: 'p', urls: ['https://a.example/'], threshold: 2 }, /threshold/],
  ])('refuses an invalid submit %#', async (body, why) => {
    const res = await api('POST', '/v1/visual/jobs', 'key-a', body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(why);
  });

  it('refuses to approve what is not a visual result with a screenshot', async () => {
    const { rows } = await sql<{
      id: string;
    }>`insert into runs (org_id, kind, status, summary, started_at, finished_at)
      values ('org-a', 'a11y', 'succeeded', 'a11y', now(), now()) returning id`.execute(db);
    await sql`insert into run_results (org_id, run_id, position, url, passed, result)
      values ('org-a', ${rows[0].id}, 0, 'https://a.example/', true, '{}')`.execute(db);
    expect((await api('POST', `/v1/runs/${rows[0].id}/results/0/approve`)).status).toBe(409);
    expect((await api('POST', `/v1/runs/${rows[0].id}/results/9/approve`)).status).toBe(404);
    expect((await api('POST', '/v1/runs/not-a-uuid/results/0/approve')).status).toBe(404);
    expect((await api('GET', `/v1/runs/${rows[0].id}/results/0/approve`)).status).toBe(405);
  });
});

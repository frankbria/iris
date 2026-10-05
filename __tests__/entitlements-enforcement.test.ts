/**
 * Plan limits at the API boundary (#346), over real sockets and real Postgres: the
 * monthly run limit on job submits. Only API-key auth is an in-test table; the job
 * store, the usage ledger and the entitlements are the real ones.
 */

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import { Kysely, sql } from 'kysely';
import { Client } from 'pg';
import { FilesystemArtifactStore } from '../src/artifact-store';
import { orgEntitlements } from '../src/billing/plans';
import { createPostgresDb } from '../src/db/postgres';
import { migrateToLatest } from '../src/db/migrate';
import { postgresJobs } from '../src/history-store';
import { startServer, type Authenticator, type Principal } from '../src/protocol';

const ADMIN_URL = process.env.IRIS_TEST_DATABASE_URL;
if (!ADMIN_URL) {
  if (process.env.CI) throw new Error('IRIS_TEST_DATABASE_URL is required in CI');
  console.warn('Skipping entitlement enforcement tests: set IRIS_TEST_DATABASE_URL');
}

const keys = new Map<string, Principal>([
  ['key-a', { orgId: 'org-a', keyId: 'id-a' }],
  ['key-b', { orgId: 'org-b', keyId: 'id-b' }],
  ['key-c', { orgId: 'org-c', keyId: 'id-c' }],
]);
const authenticate: Authenticator = {
  async verify(header) {
    return keys.get(header?.replace('Bearer ', '') ?? '') ?? null;
  },
  async recheck() {
    return true;
  },
};

(ADMIN_URL ? describe : describe.skip)('plan limits on job submits (#346)', () => {
  const dbName = `iris_ent_api_${process.pid}_${randomBytes(4).toString('hex')}`;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-ent-'));
  let db: Kysely<unknown>;
  let server: ReturnType<typeof startServer>;
  let base: string;

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
    for (const org of ['org-a', 'org-b', 'org-c']) {
      await sql`insert into organization (id, name, slug, "createdAt")
        values (${org}, ${org}, ${org}, now())`.execute(db);
    }
    server = startServer(0, {
      authenticate,
      jobs: postgresJobs(db),
      // Visual submits need a store; the filesystem one is enough to queue.
      artifacts: new FilesystemArtifactStore(root),
      entitlements: (orgId) => orgEntitlements(db).get(orgId),
      limits: { maxQueuedJobsPerOrg: 100, orgRequestsPerMinute: 1000, keyRequestsPerMinute: 1000 },
    });
    await new Promise<void>((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => server?.close(() => r(null)));
    await db?.destroy();
    await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const submit = (key: string, kind: 'a11y' | 'visual', body: object) =>
    fetch(`${base}/v1/${kind}/jobs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const a11y = { urls: ['https://a.example/'] };

  it('refuses a submit past the monthly run limit with 402, and counts billed usage', async () => {
    await orgEntitlements(db).setPlan('org-a', 'free', { runsPerMonth: 3 });
    // One run billed this month, and one last month (which does not count).
    await sql`insert into usage_events (org_id, kind, quantity, idempotency_key, created_at)
      values ('org-a', 'a11y_job', 1, 'job:old-1', now()),
             ('org-a', 'a11y_job', 5, 'job:old-2', date_trunc('month', now()) - interval '1 day')`.execute(
      db,
    );
    expect((await submit('key-a', 'a11y', a11y)).status).toBe(202);
    expect((await submit('key-a', 'a11y', a11y)).status).toBe(202);
    const over = await submit('key-a', 'a11y', a11y);
    expect(over.status).toBe(402);
    expect(await over.json()).toEqual({ error: 'Monthly run limit reached', limit: 3, used: 3 });
    // Another org is unaffected.
    expect((await submit('key-b', 'a11y', a11y)).status).toBe(202);
    // An upgrade lifts it.
    await orgEntitlements(db).setPlan('org-a', 'pro');
    expect((await submit('key-a', 'a11y', a11y)).status).toBe(202);
  });

  it('counts a visual job per comparison, pages x devices', async () => {
    await orgEntitlements(db).setPlan('org-b', 'free', { runsPerMonth: 5 });
    // org-b already has one a11y job queued from the test above: 4 left.
    const big = {
      project: 'p',
      urls: ['https://a.example/', 'https://b.example/'],
      devices: ['desktop', 'mobile', 'tablet'],
    };
    const over = await submit('key-b', 'visual', big);
    expect(over.status).toBe(402);
    expect(await over.json()).toMatchObject({ limit: 5, used: 1 });
    const fits = {
      project: 'p',
      urls: ['https://a.example/', 'https://b.example/'],
      devices: ['desktop', 'mobile'],
    };
    expect((await submit('key-b', 'visual', fits)).status).toBe(202);
    expect((await submit('key-b', 'a11y', a11y)).status).toBe(402);
  });

  it('parallel submits cannot overshoot the limit', async () => {
    await orgEntitlements(db).setPlan('org-c', 'free', { runsPerMonth: 4 });
    const statuses = await Promise.all(
      Array.from({ length: 10 }, () => submit('key-c', 'a11y', a11y)).map(
        async (p) => (await p).status,
      ),
    );
    expect(statuses.filter((s) => s === 202)).toHaveLength(4);
    expect(statuses.filter((s) => s === 402)).toHaveLength(6);
  });
});

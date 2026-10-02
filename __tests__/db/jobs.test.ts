/**
 * The hosted job queue (#267) over real Postgres.
 *
 * Test strategy: a throwaway migrated database with two orgs. Jobs are enqueued
 * through `forOrg(scope)`, claimed and finished as a worker would, and the tenant
 * boundary and the one-transaction outcome are checked against the tables.
 */

import { randomBytes } from 'crypto';
import { Kysely, sql } from 'kysely';
import { Client } from 'pg';
import { createPostgresDb } from '../../src/db/postgres';
import { migrateToLatest } from '../../src/db/migrate';
import { postgresHistory, postgresJobs, type A11yJobParams } from '../../src/history-store';
import type { AccessibilityTestResult } from '../../src/a11y/a11y-runner';

const ADMIN_URL = process.env.IRIS_TEST_DATABASE_URL;

if (!ADMIN_URL) {
  if (process.env.CI) throw new Error('IRIS_TEST_DATABASE_URL is required in CI');
  console.warn('Skipping job store tests: set IRIS_TEST_DATABASE_URL');
}

const params: A11yJobParams = {
  urls: ['https://a.example/'],
  wcagLevel: 'AA',
  failOn: ['critical'],
};
const result = {
  summary: { pagesTested: 1, totalViolations: 1, passed: false },
  results: [
    {
      page: 'https://a.example/',
      axeResult: { violations: [{ impact: 'critical' }] },
      keyboardResult: { passed: true },
    },
  ],
} as unknown as AccessibilityTestResult;

(ADMIN_URL ? describe : describe.skip)('postgresJobs', () => {
  const dbName = `iris_jobs_${process.pid}_${randomBytes(4).toString('hex')}`;
  let db: Kysely<unknown>;

  async function admin(query: string): Promise<void> {
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
  });

  afterAll(async () => {
    await db?.destroy();
    await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  });

  // Each test starts from an empty queue.
  beforeEach(async () => {
    await sql`delete from usage_events`.execute(db);
    await sql`delete from runs`.execute(db);
  });

  const jobs = () => postgresJobs(db);
  const A = { orgId: 'org-a' };
  const B = { orgId: 'org-b' };
  const enqueue = (scope = A) => jobs().forOrg(scope).enqueue({ kind: 'a11y', params });

  it('enqueues a queued job its org can read, with no results yet', async () => {
    const id = await enqueue();
    expect(await jobs().forOrg(A).get(id)).toMatchObject({
      id,
      kind: 'a11y',
      status: 'queued',
      startedAt: null,
      finishedAt: null,
      error: null,
      results: [],
    });
  });

  it('claims the oldest queued job across orgs, once, and null when empty', async () => {
    expect(await jobs().claim('a11y')).toBeNull();
    const first = await enqueue(B);
    const second = await enqueue(A);
    const claimed = await jobs().claim('a11y');
    expect(claimed).toMatchObject({ id: first, orgId: 'org-b', kind: 'a11y', params });
    expect((await jobs().forOrg(B).get(first))!.status).toBe('running');
    expect((await jobs().claim('a11y'))!.id).toBe(second);
    expect(await jobs().claim('a11y')).toBeNull();
  });

  it('gives two concurrent claims different jobs (SKIP LOCKED)', async () => {
    await enqueue();
    await enqueue();
    const [x, y] = await Promise.all([jobs().claim('a11y'), jobs().claim('a11y')]);
    expect(x && y).toBeTruthy();
    expect(x!.id).not.toBe(y!.id);
  });

  it('finish writes status, results and usage together', async () => {
    const id = await enqueue();
    const job = (await jobs().claim('a11y'))!;
    await jobs().finish(job, result);

    expect(await jobs().forOrg(A).get(id)).toMatchObject({
      status: 'failed', // the run's verdict: a critical violation breaches the threshold
      summary: 'a11y: 1 page(s), 1 violation(s)',
      error: null,
      results: [{ url: 'https://a.example/', passed: false }],
    });
    const usage = await sql<{
      org_id: string;
      kind: string;
      idempotency_key: string;
      run_id: string;
      billing_mode: string | null;
    }>`select org_id, kind, idempotency_key, run_id, billing_mode from usage_events`.execute(db);
    expect(usage.rows).toEqual([
      {
        org_id: 'org-a',
        kind: 'a11y_job',
        idempotency_key: `job:${id}`,
        run_id: id,
        billing_mode: null,
      },
    ]);
  });

  it('finish of a job that is not running writes nothing', async () => {
    const id = await enqueue();
    const job = (await jobs().claim('a11y'))!;
    await jobs().fail(job, 'boom');
    await expect(jobs().finish(job, result)).rejects.toThrow('not running');
    expect((await sql`select 1 from run_results where run_id = ${id}`.execute(db)).rows).toEqual(
      [],
    );
    expect((await sql`select 1 from usage_events`.execute(db)).rows).toEqual([]);
  });

  it('fail records a bounded error, no usage', async () => {
    const id = await enqueue();
    const job = (await jobs().claim('a11y'))!;
    await jobs().fail(job, 'x'.repeat(2000));
    const stored = await jobs().forOrg(A).get(id);
    expect(stored).toMatchObject({ status: 'failed', finishedAt: expect.any(Date) });
    expect(stored!.error).toHaveLength(500);
    expect((await sql`select 1 from usage_events`.execute(db)).rows).toEqual([]);
  });

  it('keeps jobs from the other org, and unfinished jobs out of history', async () => {
    const id = await enqueue();
    expect(await jobs().forOrg(B).get(id)).toBeNull();
    expect(await jobs().forOrg(A).get('not-a-uuid')).toBeNull();
    expect(await postgresHistory(db).forOrg(A).list()).toEqual([]);
    expect(await postgresHistory(db).forOrg(A).get(id)).toBeNull();
    await jobs().finish((await jobs().claim('a11y'))!, result);
    expect(await postgresHistory(db).forOrg(A).list()).toHaveLength(1);
  });
});

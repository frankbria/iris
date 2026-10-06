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
import { orgSuspensions } from '../../src/org-suspension';
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
      // The runner's verdict (#288): what the stores record.
      passed: false,
      failureReasons: ['axe: 1 violation(s) at the failure threshold'],
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
  const enqueue = async (scope = A) =>
    (await jobs().forOrg(scope).enqueue({ kind: 'a11y', params }))!;

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

  it("claim says whether the job's org is suspended, in the same statement (#348)", async () => {
    const susp = orgSuspensions(db);
    await enqueue(A);
    await enqueue(B);
    await susp.suspend('org-b', { reason: 'r', actor: 'test' });
    try {
      expect(await jobs().claim('a11y')).toMatchObject({ orgId: 'org-a', orgSuspended: false });
      expect(await jobs().claim('a11y')).toMatchObject({ orgId: 'org-b', orgSuspended: true });
    } finally {
      await susp.unsuspend('org-b', { reason: 'r', actor: 'test' });
    }
  });

  it('queueDepth counts queued jobs of a kind across orgs, not running ones (#275)', async () => {
    expect(await jobs().queueDepth('a11y')).toBe(0);
    await enqueue(A);
    await enqueue(B);
    await enqueue(B);
    expect(await jobs().queueDepth('a11y')).toBe(3);
    await jobs().claim('a11y');
    expect(await jobs().queueDepth('a11y')).toBe(2);
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
    expect(await jobs().finish(job, result)).toBe(false);
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

  it('caps the outstanding jobs of an org jobs atomically, even for concurrent enqueues', async () => {
    const cap = { maxOutstanding: 3 };
    const ids = await Promise.all(
      Array.from({ length: 8 }, () => jobs().forOrg(A).enqueue({ kind: 'a11y', params }, cap)),
    );
    expect(ids.filter((id) => id !== null)).toHaveLength(3);
    // Other orgs have their own count.
    expect(await jobs().forOrg(B).enqueue({ kind: 'a11y', params }, cap)).toEqual(
      expect.any(String),
    );
    // A running job still counts; a finished one frees its slot.
    const claimed = (await jobs().claim('a11y'))!;
    expect(
      await jobs()
        .forOrg(claimed.orgId === 'org-a' ? A : B)
        .enqueue({ kind: 'a11y', params }, cap),
    ).toBeNull();
    await jobs().fail(claimed, 'done');
    expect(await jobs().forOrg(A).enqueue({ kind: 'a11y', params }, cap)).toEqual(
      expect.any(String),
    );
  });

  describe('reaping stuck jobs (#435)', () => {
    // Staleness is simulated by moving the heartbeat back, not by sleeping.
    const age = (id: string, seconds: number) =>
      sql`update runs set heartbeat_at = now() - make_interval(secs => ${seconds}) where id = ${id}`.execute(
        db,
      );
    const row = async (id: string) =>
      (
        await sql<{
          status: string;
          attempts: number;
          claim_token: string | null;
          heartbeat_at: Date | null;
          started_at: Date | null;
          error: string | null;
        }>`select status, attempts, claim_token, heartbeat_at, started_at, error from runs where id = ${id}`.execute(
          db,
        )
      ).rows[0];
    const usageCount = async () => (await sql`select 1 from usage_events`.execute(db)).rows.length;
    const STALE = { staleMs: 180_000 };

    it('claim counts the attempt and sets a token and heartbeat', async () => {
      const id = await enqueue();
      const job = (await jobs().claim('a11y'))!;
      expect(job.attempts).toBe(1);
      expect(job.claimToken).toEqual(expect.any(String));
      expect(await row(id)).toMatchObject({ attempts: 1, claim_token: job.claimToken });
      expect((await row(id)).heartbeat_at).toBeInstanceOf(Date);
    });

    it('requeues a stuck job, and leaves a fresh one alone', async () => {
      const stuck = await enqueue();
      const fresh = await enqueue();
      await jobs().claim('a11y');
      await jobs().claim('a11y');
      await age(stuck, 200);
      expect(await jobs().reapStuck(STALE)).toEqual({ requeued: 1, failed: 0 });
      expect(await row(stuck)).toMatchObject({
        status: 'queued',
        claim_token: null,
        heartbeat_at: null,
        started_at: null,
        attempts: 1,
      });
      expect((await row(fresh)).status).toBe('running');
      expect(await jobs().forOrg(A).get(stuck)).toMatchObject({
        status: 'queued',
        startedAt: null,
      });
      expect((await jobs().claim('a11y'))!.attempts).toBe(2);
    });

    it('a late finish by the reaped claim writes nothing; the new claim finishes once', async () => {
      const id = await enqueue();
      const old = (await jobs().claim('a11y'))!;
      await age(id, 200);
      await jobs().reapStuck(STALE);
      const next = (await jobs().claim('a11y'))!;
      expect(next.claimToken).not.toBe(old.claimToken);

      // Both while the job is queued again and while another worker holds it.
      expect(await jobs().finish(old, result)).toBe(false);
      expect(await jobs().fail(old, 'late')).toBe(false);
      expect((await sql`select 1 from run_results`.execute(db)).rows).toEqual([]);
      expect(await usageCount()).toBe(0);
      expect((await row(id)).status).toBe('running');

      expect(await jobs().finish(next, result)).toBe(true);
      expect(await jobs().finish(next, result)).toBe(false);
      expect((await sql`select 1 from run_results`.execute(db)).rows).toHaveLength(1);
      expect(await usageCount()).toBe(1);
    });

    it('fails a job whose attempts are used up, with no usage', async () => {
      const id = await enqueue();
      for (let i = 0; i < 3; i++) {
        await jobs().claim('a11y');
        await age(id, 200);
        expect(await jobs().reapStuck({ ...STALE, maxAttempts: 3 })).toEqual(
          i < 2 ? { requeued: 1, failed: 0 } : { requeued: 0, failed: 1 },
        );
      }
      expect(await row(id)).toMatchObject({
        status: 'failed',
        error: 'The job was interrupted too many times',
        claim_token: null,
      });
      expect(await jobs().forOrg(A).get(id)).toMatchObject({
        status: 'failed',
        finishedAt: expect.any(Date),
      });
      expect(await jobs().claim('a11y')).toBeNull();
      expect(await usageCount()).toBe(0);
    });

    it('frees the org cap after a reap to failed and after a requeue and finish', async () => {
      const cap = { maxOutstanding: 1 };
      const enq = () => jobs().forOrg(A).enqueue({ kind: 'a11y', params }, cap);
      const id = (await enq())!;
      await jobs().claim('a11y');
      expect(await enq()).toBeNull();

      await age(id, 200);
      await jobs().reapStuck({ ...STALE, maxAttempts: 2 }); // requeued: still counts
      expect(await enq()).toBeNull();
      const job = (await jobs().claim('a11y'))!;
      await age(id, 200);
      await jobs().reapStuck({ ...STALE, maxAttempts: 2 }); // attempts used up: failed
      expect(await enq()).toEqual(expect.any(String));
      expect(job.attempts).toBe(2);

      await sql`delete from runs`.execute(db);
      const id2 = (await enq())!;
      await jobs().claim('a11y');
      await age(id2, 200);
      await jobs().reapStuck(STALE);
      await jobs().finish((await jobs().claim('a11y'))!, result);
      expect(await enq()).toEqual(expect.any(String));
    });

    it('a heartbeat keeps a long job from being reaped', async () => {
      const id = await enqueue();
      const job = (await jobs().claim('a11y'))!;
      await age(id, 200);
      expect(await jobs().heartbeat(job)).toBe(true);
      expect(await jobs().reapStuck(STALE)).toEqual({ requeued: 0, failed: 0 });
      expect((await row(id)).status).toBe('running');
    });

    it('a heartbeat of a lost claim reports false and revives nothing', async () => {
      const id = await enqueue();
      const old = (await jobs().claim('a11y'))!;
      await age(id, 200);
      await jobs().reapStuck(STALE);
      expect(await jobs().heartbeat(old)).toBe(false);
      expect((await row(id)).heartbeat_at).toBeNull();
    });

    it('two concurrent reapers process a stuck job once', async () => {
      const ids = [await enqueue(), await enqueue(), await enqueue()];
      for (const id of ids) {
        await jobs().claim('a11y');
        await age(id, 200);
      }
      const counts = await Promise.all([jobs().reapStuck(STALE), jobs().reapStuck(STALE)]);
      expect(counts.reduce((n, c) => n + c.requeued, 0)).toBe(3);
      expect(counts.reduce((n, c) => n + c.failed, 0)).toBe(0);
      for (const id of ids) expect((await row(id)).attempts).toBe(1);
    });

    it('a job claimed by a worker that died is reaped and completed by another worker', async () => {
      const { processNextA11yJob } = await import('../../src/worker');
      jest.doMock('../../src/a11y/a11y-runner', () => ({
        AccessibilityRunner: class {
          async run() {
            return result;
          }
        },
      }));
      try {
        const id = await enqueue();
        await jobs().claim('a11y'); // the dead worker: claims, then never reports again
        await age(id, 200);
        await jobs().reapStuck(STALE);
        const done = await processNextA11yJob(jobs());
        expect(done).toMatchObject({ id, attempts: 2 });
        expect(await jobs().forOrg(A).get(id)).toMatchObject({
          status: 'failed', // the scan's verdict (a critical violation), not an interruption
          results: [{ url: 'https://a.example/', passed: false }],
        });
        expect(await usageCount()).toBe(1);
      } finally {
        jest.dontMock('../../src/a11y/a11y-runner');
      }
    });

    it('reaps a running row from before the migration (no heartbeat) by its start time', async () => {
      const id = await enqueue();
      await sql`update runs set status = 'running', started_at = now() - interval '1 hour'
        where id = ${id}`.execute(db);
      const recent = await enqueue();
      await sql`update runs set status = 'running', started_at = now() where id = ${recent}`.execute(
        db,
      );
      expect(await jobs().reapStuck(STALE)).toEqual({ requeued: 1, failed: 0 });
      expect((await row(id)).status).toBe('queued');
      expect((await row(recent)).status).toBe('running');
    });
  });
});

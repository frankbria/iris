/**
 * The billable usage ledger (#263) over real Postgres.
 *
 * Test strategy: a throwaway database migrated to latest with two orgs. Usage is
 * recorded through the ledger and through the history store's run transaction, and
 * the billing-period summary is checked against hand-computed totals.
 */

import { randomBytes } from 'crypto';
import { Kysely, sql } from 'kysely';
import { Client } from 'pg';
import { createPostgresDb } from '../../src/db/postgres';
import { migrateToLatest } from '../../src/db/migrate';
import { usageLedger } from '../../src/billing/usage';
import { postgresHistory } from '../../src/history-store';

const ADMIN_URL = process.env.IRIS_TEST_DATABASE_URL;
if (!ADMIN_URL) {
  if (process.env.CI) throw new Error('IRIS_TEST_DATABASE_URL is required in CI');
  console.warn('Skipping usage ledger tests: set IRIS_TEST_DATABASE_URL');
}

const JUNE = { from: new Date('2026-06-01T00:00:00Z'), to: new Date('2026-07-01T00:00:00Z') };

(ADMIN_URL ? describe : describe.skip)('usageLedger', () => {
  const dbName = `iris_usage_${process.pid}_${randomBytes(4).toString('hex')}`;
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

  const at = (iso: string) => new Date(iso);

  it('records each kind, once per idempotency key, and sums a billing period per org', async () => {
    const ledger = usageLedger(db);
    await ledger.record('org-a', [
      {
        kind: 'browser_minutes',
        quantity: 12.5,
        idempotencyKey: 'session:1',
        at: at('2026-06-03T10:00:00Z'),
      },
      {
        kind: 'text_call',
        quantity: 1,
        unitCostUsd: 0.0021,
        billingMode: 'byok',
        idempotencyKey: 'text:1',
        at: at('2026-06-03T10:01:00Z'),
      },
      {
        kind: 'text_call',
        quantity: 1,
        unitCostUsd: 0.0009,
        billingMode: 'byok',
        idempotencyKey: 'text:2',
        at: at('2026-06-04T10:01:00Z'),
      },
      {
        kind: 'vision_call',
        quantity: 1,
        unitCostUsd: 0.01,
        billingMode: 'managed',
        estimated: true,
        idempotencyKey: 'vision:1',
        at: at('2026-06-05T00:00:00Z'),
      },
      // Outside June.
      {
        kind: 'text_call',
        quantity: 1,
        unitCostUsd: 5,
        billingMode: 'byok',
        idempotencyKey: 'text:may',
        at: at('2026-05-31T23:59:59Z'),
      },
    ]);
    // A retried write is a no-op, not a second charge.
    await ledger.record('org-a', [
      {
        kind: 'text_call',
        quantity: 1,
        unitCostUsd: 0.0021,
        billingMode: 'byok',
        idempotencyKey: 'text:1',
        at: at('2026-06-03T10:01:00Z'),
      },
    ]);
    await ledger.record('org-b', [
      {
        kind: 'text_call',
        quantity: 1,
        unitCostUsd: 1,
        billingMode: 'byok',
        idempotencyKey: 'text:1',
        at: at('2026-06-03T10:01:00Z'),
      },
    ]);

    const summary = await ledger.summary('org-a', JUNE.from, JUNE.to);
    expect(summary).toEqual([
      {
        kind: 'browser_minutes',
        billingMode: null,
        quantity: 12.5,
        costUsd: 0,
        estimatedCostUsd: 0,
      },
      { kind: 'text_call', billingMode: 'byok', quantity: 2, costUsd: 0.003, estimatedCostUsd: 0 },
      {
        kind: 'vision_call',
        billingMode: 'managed',
        quantity: 1,
        costUsd: 0.01,
        estimatedCostUsd: 0.01,
      },
    ]);
    expect(await ledger.summary('org-b', JUNE.from, JUNE.to)).toEqual([
      { kind: 'text_call', billingMode: 'byok', quantity: 1, costUsd: 1, estimatedCostUsd: 0 },
    ]);
  });

  it('requires a billing mode on AI usage, and refuses one on platform usage', async () => {
    const ledger = usageLedger(db);
    // Whose key paid the provider only means something for an AI call.
    await expect(
      ledger.record('org-a', [{ kind: 'text_call', quantity: 1, idempotencyKey: 'nomode' }]),
    ).rejects.toThrow();
    await expect(
      ledger.record('org-a', [
        { kind: 'browser_minutes', quantity: 1, billingMode: 'byok', idempotencyKey: 'modeful' },
      ]),
    ).rejects.toThrow();
  });

  it('refuses a negative quantity or an unknown kind', async () => {
    const ledger = usageLedger(db);
    await expect(
      ledger.record('org-a', [
        { kind: 'text_call', quantity: -1, billingMode: 'byok', idempotencyKey: 'neg' },
      ]),
    ).rejects.toThrow();
    await expect(
      ledger.record('org-a', [
        { kind: 'gpu_hours' as never, quantity: 1, billingMode: 'byok', idempotencyKey: 'x' },
      ]),
    ).rejects.toThrow();
  });

  it("writes a job's usage in its run's transaction: both or neither", async () => {
    const history = postgresHistory(db).forOrg({ orgId: 'org-a' });
    const run = {
      kind: 'a11y' as const,
      startedAt: at('2026-06-10T00:00:00Z'),
      finishedAt: at('2026-06-10T00:00:05Z'),
      result: {
        summary: { pagesTested: 1, totalViolations: 0, passed: true },
        results: [],
      } as never,
    };
    const id = await history.record(run, {
      usage: [{ kind: 'a11y_job', quantity: 1, idempotencyKey: 'job:1' }],
    });
    const rows = await sql<{ run_id: string; kind: string }>`
      select run_id, kind from usage_events where idempotency_key = 'job:1'`.execute(db);
    expect(rows.rows).toEqual([{ run_id: id, kind: 'a11y_job' }]);

    // A usage row that cannot be written takes the run down with it.
    const before = await sql<{ n: string }>`select count(*) as n from runs`.execute(db);
    await expect(
      history.record(run, {
        usage: [{ kind: 'a11y_job', quantity: -1, idempotencyKey: 'job:2' }],
      }),
    ).rejects.toThrow();
    const after = await sql<{ n: string }>`select count(*) as n from runs`.execute(db);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

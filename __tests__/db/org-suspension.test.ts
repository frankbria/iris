/**
 * Org suspension store (#348).
 *
 * Test strategy: a throwaway database migrated to latest, orgs inserted directly.
 * The store, its idempotency, the kept history and the shared `suspendedSql` probe
 * are checked against real Postgres.
 */

import { randomBytes } from 'crypto';
import { Kysely, sql } from 'kysely';
import { Client } from 'pg';
import { createPostgresDb } from '../../src/db/postgres';
import { migrateToLatest } from '../../src/db/migrate';
import { orgSuspensions, suspendedSql, UnknownOrgError } from '../../src/org-suspension';

const ADMIN_URL = process.env.IRIS_TEST_DATABASE_URL;
if (!ADMIN_URL) {
  if (process.env.CI) throw new Error('IRIS_TEST_DATABASE_URL is required in CI');
  console.warn('Skipping org suspension tests: set IRIS_TEST_DATABASE_URL');
}

(ADMIN_URL ? describe : describe.skip)('orgSuspensions', () => {
  const dbName = `iris_susp_${process.pid}_${randomBytes(4).toString('hex')}`;
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
    for (const org of ['org-a', 'org-b', 'org-c']) {
      await sql`insert into organization (id, name, slug, "createdAt")
        values (${org}, ${org}, ${org}, now())`.execute(db);
    }
  });

  afterAll(async () => {
    await db?.destroy();
    await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  });

  const store = () => orgSuspensions(db);
  const by = (reason: string, actor = 'ops') => ({ reason, actor });

  it('an org with no history is active', async () => {
    expect(await store().isSuspended('org-a')).toBe(false);
    expect(await store().status('org-a')).toEqual({ suspended: false, last: null });
    expect(await store().history('org-a')).toEqual([]);
  });

  it('suspends and unsuspends, keeping every action with actor, reason and time', async () => {
    const s = await store().suspend('org-a', by('phishing reports', 'alice'));
    expect(s).toMatchObject({ suspended: true, changed: true, last: { action: 'suspend' } });
    expect(await store().isSuspended('org-a')).toBe(true);
    // Only org-a.
    expect(await store().isSuspended('org-b')).toBe(false);

    const u = await store().unsuspend('org-a', by('resolved', 'bob'));
    expect(u).toMatchObject({ suspended: false, changed: true });
    expect(await store().isSuspended('org-a')).toBe(false);

    await store().suspend('org-a', by('again'));
    expect(await store().isSuspended('org-a')).toBe(true);

    const history = await store().history('org-a');
    expect(history.map(({ action, reason, actor }) => [action, reason, actor])).toEqual([
      ['suspend', 'phishing reports', 'alice'],
      ['unsuspend', 'resolved', 'bob'],
      ['suspend', 'again', 'ops'],
    ]);
    expect(history.every((e) => e.createdAt instanceof Date)).toBe(true);
    expect(history[0].createdAt.getTime()).toBeLessThanOrEqual(history[2].createdAt.getTime());
  });

  it('is idempotent: repeating the current state records nothing', async () => {
    await store().suspend('org-b', by('first'));
    const again = await store().suspend('org-b', by('second'));
    expect(again).toMatchObject({ suspended: true, changed: false, last: { reason: 'first' } });
    // Unsuspending an org never suspended is a no-op too.
    expect(await store().unsuspend('org-c', by('nothing to do'))).toMatchObject({
      suspended: false,
      changed: false,
    });
    expect(await store().history('org-b')).toHaveLength(1);
    expect(await store().history('org-c')).toHaveLength(0);
  });

  it('concurrent suspends of one org record one action', async () => {
    await store().unsuspend('org-b', by('reset'));
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) => store().suspend('org-b', by(`race ${i}`))),
    );
    expect(results.filter((r) => r.changed)).toHaveLength(1);
    const { rows } = await sql<{ n: string }>`
      select count(*) as n from org_suspensions where org_id = 'org-b' and action = 'suspend'`.execute(
      db,
    );
    expect(rows[0].n).toBe('2');
  });

  it('refuses an unknown org id, and a blank reason or actor', async () => {
    await expect(store().suspend('org-nope', by('x'))).rejects.toThrow(UnknownOrgError);
    await expect(store().unsuspend('org-nope', by('x'))).rejects.toThrow(UnknownOrgError);
    await expect(store().status('org-nope')).rejects.toThrow(/No organization with id "org-nope"/);
    await expect(store().history('org-nope')).rejects.toThrow(UnknownOrgError);
    await expect(store().suspend('org-c', by('  '))).rejects.toThrow(/reason/);
    await expect(store().suspend('org-c', by('x', ''))).rejects.toThrow(/actor/);
    expect(await store().isSuspended('org-c')).toBe(false);
  });

  it('the table refuses an unknown org and an unknown action (FK and check)', async () => {
    await expect(
      sql`insert into org_suspensions (org_id, action, reason, actor)
          values ('org-nope', 'suspend', 'r', 'a')`.execute(db),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      sql`insert into org_suspensions (org_id, action, reason, actor)
          values ('org-c', 'ban', 'r', 'a')`.execute(db),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('suspendedSql works on a column reference inside another statement', async () => {
    const { rows } = await sql<{ id: string; s: boolean }>`
      select o.id, ${suspendedSql(sql.ref('o.id'))} as s from organization o order by o.id`.execute(
      db,
    );
    expect(rows).toEqual([
      { id: 'org-a', s: true },
      { id: 'org-b', s: true },
      { id: 'org-c', s: false },
    ]);
  });
});

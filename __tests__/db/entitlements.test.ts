/**
 * Org entitlements over real Postgres (#260).
 *
 * Test strategy: a throwaway database migrated to latest with two orgs; plans are set
 * through the store and read back as resolved entitlements.
 */

import { randomBytes } from 'crypto';
import { Kysely, sql } from 'kysely';
import { Client } from 'pg';
import { createPostgresDb } from '../../src/db/postgres';
import { migrateToLatest } from '../../src/db/migrate';
import { freeOrgLimitReached, orgEntitlements, PLANS, retractOrg } from '../../src/billing/plans';

const ADMIN_URL = process.env.IRIS_TEST_DATABASE_URL;
if (!ADMIN_URL) {
  if (process.env.CI) throw new Error('IRIS_TEST_DATABASE_URL is required in CI');
  console.warn('Skipping entitlement tests: set IRIS_TEST_DATABASE_URL');
}

(ADMIN_URL ? describe : describe.skip)('orgEntitlements', () => {
  const dbName = `iris_ent_${process.pid}_${randomBytes(4).toString('hex')}`;
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

  it('gives an org with no plan row the free plan', async () => {
    expect(await orgEntitlements(db).get('org-a')).toEqual({ plan: 'free', ...PLANS.free });
  });

  it("sets an org's plan and overrides, and only that org's", async () => {
    const ent = orgEntitlements(db);
    await ent.setPlan('org-a', 'team', { runsPerMonth: 9000 });
    expect(await ent.get('org-a')).toEqual({ plan: 'team', ...PLANS.team, runsPerMonth: 9000 });
    expect(await ent.get('org-b')).toEqual({ plan: 'free', ...PLANS.free });

    // Setting again replaces both: an upgrade does not keep a stale grant.
    await ent.setPlan('org-a', 'pro');
    expect(await ent.get('org-a')).toEqual({ plan: 'pro', ...PLANS.pro });
  });

  it('refuses an unknown plan or org when setting', async () => {
    const ent = orgEntitlements(db);
    await expect(ent.setPlan('org-a', 'enterprise' as any)).rejects.toThrow(/Unknown plan/);
    await expect(ent.setPlan('no-such-org', 'pro')).rejects.toThrow();
  });

  it('reads a row someone wrote with an unknown plan as free', async () => {
    await sql`update org_plans set plan = 'legacy-gold' where org_id = 'org-a'`.execute(db);
    expect(await orgEntitlements(db).get('org-a')).toEqual({ plan: 'free', ...PLANS.free });
  });

  it('counts the free orgs a user owns, by owner token, unknown plans as free', async () => {
    await sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      values ('u1', 'U', 'u1@iris.test', true, now(), now())`.execute(db);
    const own = (org: string, role: string) =>
      sql`insert into member (id, "organizationId", "userId", role, "createdAt")
        values (${'m-' + org}, ${org}, 'u1', ${role}, now())`.execute(db);
    expect(await freeOrgLimitReached(db, 'u1')).toBe(false);
    await own('org-b', 'admin,owner'); // org-b has no plan row: free
    expect(await freeOrgLimitReached(db, 'u1')).toBe(true);
    expect(await freeOrgLimitReached(db, 'u1', 2)).toBe(false);
    await orgEntitlements(db).setPlan('org-b', 'pro');
    expect(await freeOrgLimitReached(db, 'u1')).toBe(false);
    // org-a holds the unknown 'legacy-gold' from the test above: free for the cap too.
    await own('org-a', 'owner');
    expect(await freeOrgLimitReached(db, 'u1')).toBe(true);
  });

  it('takes back an over-cap org: deleted, or suspended once data hangs off it', async () => {
    for (const org of ['org-x', 'org-y']) {
      await sql`insert into organization (id, name, slug, "createdAt")
        values (${org}, ${org}, ${org}, now())`.execute(db);
    }
    await sql`insert into provider_keys (org_id, provider, ciphertext)
      values ('org-y', 'openai', '\\x00')`.execute(db);

    expect(await db.transaction().execute((tx) => retractOrg(tx, 'org-x'))).toBe('deleted');
    const gone = await sql`select 1 from organization where id = 'org-x'`.execute(db);
    expect(gone.rows).toHaveLength(0);

    // The provider key has no cascade: the delete is refused, so the org is suspended.
    expect(await db.transaction().execute((tx) => retractOrg(tx, 'org-y'))).toBe('suspended');
    const kept = await sql`select 1 from organization where id = 'org-y'`.execute(db);
    expect(kept.rows).toHaveLength(1);
    const { rows } = await sql<{ action: string; actor: string }>`
      select action, actor from org_suspensions where org_id = 'org-y'`.execute(db);
    expect(rows).toEqual([{ action: 'suspend', actor: 'system' }]);
  });
});

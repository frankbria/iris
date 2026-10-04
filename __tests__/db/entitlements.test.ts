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
import { orgEntitlements, PLANS } from '../../src/billing/plans';

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
});

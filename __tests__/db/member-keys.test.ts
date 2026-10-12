/**
 * API keys follow their creator's membership (#408), over real Postgres.
 *
 * Test strategy: a throwaway database with one org, two users and keys whose creators are
 * on record in the audit log, as #361's hooks write them. `revokeIfCreatorLeft` is the
 * create path's re-check, which closes the race codex found: a removal that ran while a
 * key was being created, before its audit row existed. BetterAuth's endpoints cannot
 * force that interleaving, so the state it leaves is set up directly.
 */

import { randomBytes } from 'crypto';
import { Kysely, sql } from 'kysely';
import { Client } from 'pg';
import { recordAudit } from '../../src/audit-log';
import { createPostgresDb } from '../../src/db/postgres';
import { migrateToLatest } from '../../src/db/migrate';
import { revokeIfCreatorLeft, revokeKeysCreatedBy } from '../../src/member-keys';

const ADMIN_URL = process.env.IRIS_TEST_DATABASE_URL;
if (!ADMIN_URL) {
  if (process.env.CI) throw new Error('IRIS_TEST_DATABASE_URL is required in CI');
  console.warn('Skipping member key tests: set IRIS_TEST_DATABASE_URL');
}

(ADMIN_URL ? describe : describe.skip)('member keys (#408)', () => {
  const dbName = `iris_mkeys_${process.pid}_${randomBytes(4).toString('hex')}`;
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
    await sql`insert into organization (id, name, slug, "createdAt")
      values ('org-a', 'A', 'a', now())`.execute(db);
    for (const user of ['ann', 'bo']) {
      await sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
        values (${user}, ${user}, ${user + '@iris.test'}, true, now(), now())`.execute(db);
    }
  });

  afterAll(async () => {
    await db?.destroy();
    await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  });

  beforeEach(async () => {
    await sql`delete from audit_log`.execute(db);
    await sql`delete from apikey`.execute(db);
    await sql`delete from member`.execute(db);
  });

  const member = (user: string) =>
    sql`insert into member (id, "organizationId", "userId", role, "createdAt")
      values (${'m-' + user}, 'org-a', ${user}, 'admin', now())`.execute(db);
  /** A key in the org, its creation audited as BetterAuth's hook does. */
  async function key(id: string, creator: string) {
    await sql`insert into apikey (id, "configId", "referenceId", key, "createdAt", "updatedAt")
      values (${id}, 'default', 'org-a', ${'hash-' + id}, now(), now())`.execute(db);
    await recordAudit(db, {
      orgId: 'org-a',
      actor: { userId: creator },
      action: 'api_key.create',
      target: `key:${id}`,
    });
  }
  const keys = async () =>
    (await sql<{ id: string }>`select id from apikey order by id`.execute(db)).rows.map(
      (r) => r.id,
    );
  const deletions = async () =>
    (
      await sql<{ target: string; metadata: unknown }>`select target, metadata from audit_log
        where action = 'api_key.delete' order by id`.execute(db)
    ).rows;

  it('revokes the keys a member created, and only theirs, auditing each', async () => {
    await key('k-ann-1', 'ann');
    await key('k-ann-2', 'ann');
    await key('k-bo', 'bo');
    const revoked = await revokeKeysCreatedBy(
      db,
      'org-a',
      'ann',
      { userId: 'bo' },
      'member.remove',
    );
    expect(revoked.sort()).toEqual(['k-ann-1', 'k-ann-2']);
    expect(await keys()).toEqual(['k-bo']);
    expect(await deletions()).toHaveLength(2);
  });

  it('after a create, keeps the key of a creator who is still a member', async () => {
    await member('ann');
    await key('k-ann', 'ann');
    expect(await revokeIfCreatorLeft(db, 'org-a', 'ann', 'k-ann')).toBe(false);
    expect(await keys()).toEqual(['k-ann']);
  });

  it('after a create, revokes the key when its creator was removed meanwhile (the race)', async () => {
    // The removal ran before this key's audit row existed, so it did not see the key:
    // no membership is left, and the key is live. The re-check finds and revokes it.
    await key('k-late', 'ann');
    expect(await revokeIfCreatorLeft(db, 'org-a', 'ann', 'k-late')).toBe(true);
    expect(await keys()).toEqual([]);
    expect(await deletions()).toEqual([
      { target: 'key:k-late', metadata: { reason: 'creator_left' } },
    ]);
  });
});

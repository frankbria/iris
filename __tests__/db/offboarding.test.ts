/**
 * Org offboarding, account deletion and retention over real Postgres (#349).
 *
 * Test strategy: a throwaway database migrated to latest. Orgs, users, runs, usage and
 * keys are inserted as the services would write them; the clock is the `now` passed to
 * the retention pass, so 30 days, 90 days and 7 years are crossed without waiting.
 */

import { randomBytes } from 'crypto';
import { Kysely, sql } from 'kysely';
import { Client } from 'pg';
import { createPostgresDb } from '../../src/db/postgres';
import { migrateToLatest } from '../../src/db/migrate';
import { offboarding, OffboardingError } from '../../src/offboarding';
import { orgSuspensions } from '../../src/org-suspension';

const ADMIN_URL = process.env.IRIS_TEST_DATABASE_URL;
if (!ADMIN_URL) {
  if (process.env.CI) throw new Error('IRIS_TEST_DATABASE_URL is required in CI');
  console.warn('Skipping offboarding tests: set IRIS_TEST_DATABASE_URL');
}

const DAY = 24 * 60 * 60 * 1000;
const at = (base: Date, days: number) => new Date(base.getTime() + days * DAY);

(ADMIN_URL ? describe : describe.skip)('offboarding and retention', () => {
  const dbName = `iris_off_${process.pid}_${randomBytes(4).toString('hex')}`;
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

  const count = async (table: string, where = 'true') =>
    (
      await sql<{
        n: number;
      }>`select count(*)::int as n from ${sql.raw(table)} where ${sql.raw(where)}`.execute(db)
    ).rows[0].n;

  async function user(id: string) {
    await sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      values (${id}, ${id}, ${id + '@iris.test'}, true, now(), now())`.execute(db);
  }

  /** An org with an owner, a member, a key, a provider key, a plan, runs and usage. */
  async function org(id: string, owner: string, now: Date) {
    await sql`insert into organization (id, name, slug, "createdAt")
      values (${id}, ${'Org ' + id}, ${id}, now())`.execute(db);
    await sql`insert into member (id, "organizationId", "userId", role, "createdAt")
      values (${'m-' + id}, ${id}, ${owner}, 'owner', now())`.execute(db);
    await sql`insert into apikey (id, "configId", "referenceId", key, "createdAt", "updatedAt")
      values (${'k-' + id}, 'default', ${id}, ${'hash-' + id}, now(), now())`.execute(db);
    await sql`insert into provider_keys (org_id, provider, ciphertext)
      values (${id}, 'openai', '\\x00')`.execute(db);
    await sql`insert into org_plans (org_id, plan) values (${id}, 'pro')`.execute(db);
    // An old run with billed usage, and a recent one.
    for (const [name, daysAgo] of [
      ['old', 120],
      ['new', 10],
    ] as const) {
      const finished = at(now, -daysAgo);
      const { rows } = await sql<{ id: string }>`
        insert into runs (org_id, kind, status, summary, started_at, finished_at, created_at)
        values (${id}, 'a11y', 'succeeded', ${name}, ${finished}, ${finished}, ${finished})
        returning id`.execute(db);
      await sql`insert into run_results (org_id, run_id, position, url, passed, result)
        values (${id}, ${rows[0].id}, 0, 'https://a.example/', true, '{}')`.execute(db);
      await sql`insert into usage_events (org_id, run_id, kind, quantity, idempotency_key, created_at)
        values (${id}, ${rows[0].id}, 'a11y_job', 1, ${'job:' + id + name}, ${finished})`.execute(
        db,
      );
    }
  }

  beforeAll(async () => {
    await admin(`CREATE DATABASE "${dbName}"`);
    const u = new URL(ADMIN_URL!);
    u.pathname = `/${dbName}`;
    db = createPostgresDb(u.toString());
    await migrateToLatest(db);
  });

  afterAll(async () => {
    await db?.destroy();
    await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  });

  it('soft-deletes an org: suspended at once, restorable within 30 days', async () => {
    const now = new Date();
    await user('alice');
    await org('org-r', 'alice', now);
    const off = offboarding(db);

    await off.requestOrgDeletion('org-r', { reason: 'customer request', actor: 'ops' });
    expect((await orgSuspensions(db).status('org-r')).suspended).toBe(true);
    // A second request does not move the purge date.
    await expect(
      off.requestOrgDeletion('org-r', { reason: 'again', actor: 'ops' }),
    ).rejects.toThrow(/already/);

    await off.restoreOrg('org-r', { actor: 'ops' });
    expect((await orgSuspensions(db).status('org-r')).suspended).toBe(false);
    expect(await count('org_deletions', "org_id = 'org-r'")).toBe(0);
    // A pass past the old purge date purges nothing: the request is gone.
    await off.runRetention({ now: at(now, 31) });
    expect(await count('provider_keys', "org_id = 'org-r'")).toBe(1);
  });

  it('does not suspend-and-lift an org that an operator had already suspended', async () => {
    const now = new Date();
    await user('erin');
    await org('org-s', 'erin', now);
    await orgSuspensions(db).suspend('org-s', { reason: 'abuse', actor: 'ops' });
    const off = offboarding(db);
    await off.requestOrgDeletion('org-s', { reason: 'customer request', actor: 'ops' });
    await off.restoreOrg('org-s', { actor: 'ops' });
    // Restoring the deletion leaves the abuse suspension in place.
    expect((await orgSuspensions(db).status('org-s')).suspended).toBe(true);
  });

  it('purges an org after 30 days, keeping only a tombstone with its billing records', async () => {
    const now = new Date();
    await user('bob');
    await user('carol');
    await org('org-p', 'bob', now);
    await sql`insert into member (id, "organizationId", "userId", role, "createdAt")
      values ('m-carol', 'org-p', 'carol', 'member', now())`.execute(db);
    await sql`insert into invitation (id, "organizationId", email, role, status, "expiresAt", "inviterId")
      values ('inv-p', 'org-p', 'x@iris.test', 'member', 'pending', now(), 'bob')`.execute(db);
    await sql`insert into session (id, "expiresAt", token, "createdAt", "updatedAt", "userId", "activeOrganizationId")
      values ('s-bob', ${at(now, 365)}, 'tok-bob', now(), now(), 'bob', 'org-p')`.execute(db);
    const off = offboarding(db);
    await off.requestOrgDeletion('org-p', { reason: 'customer request', actor: 'ops' });

    // Day 29: still in the grace period, nothing purged.
    await off.runRetention({ now: at(now, 29) });
    expect(await count('provider_keys', "org_id = 'org-p'")).toBe(1);

    const report = await off.runRetention({ now: at(now, 31) });
    expect(report.orgsPurged).toEqual(['org-p']);
    for (const table of ['runs', 'provider_keys', 'org_plans', 'audit_log']) {
      expect(await count(table, "org_id = 'org-p'")).toBe(0);
    }
    expect(await count('apikey', `"referenceId" = 'org-p'`)).toBe(0);
    expect(await count('member', `"organizationId" = 'org-p'`)).toBe(0);
    expect(await count('invitation', `"organizationId" = 'org-p'`)).toBe(0);
    expect(await count('session', `"activeOrganizationId" = 'org-p'`)).toBe(0);
    // The users themselves stay: deleting an org is not deleting its people.
    expect(await count('"user"', "id in ('bob', 'carol')")).toBe(2);

    // Billing records stay, detached from the deleted runs, on a scrubbed tombstone.
    expect(await count('usage_events', "org_id = 'org-p' and run_id is null")).toBe(2);
    const { rows } = await sql<{ name: string; slug: string }>`
      select name, slug from organization where id = 'org-p'`.execute(db);
    expect(rows).toEqual([{ name: 'Deleted organization', slug: 'deleted-org-p' }]);
    expect((await orgSuspensions(db).status('org-p')).suspended).toBe(true);
    await expect(off.restoreOrg('org-p', { actor: 'ops' })).rejects.toThrow(OffboardingError);

    // A second pass is a no-op.
    expect((await off.runRetention({ now: at(now, 32) })).orgsPurged).toEqual([]);

    // A write that lands on the tombstone after the purge (a late billing webhook)
    // must not keep it alive past its 7 years.
    await sql`insert into org_plans (org_id, plan) values ('org-p', 'pro')`.execute(db);

    // Seven years after the purge, the tombstone and its billing records go.
    const late = await off.runRetention({ now: at(now, 31 + 7 * 366) });
    expect(late.failures).toEqual([]);
    expect(late.tombstonesDropped).toBeGreaterThanOrEqual(1);
    expect(await count('usage_events', "org_id = 'org-p'")).toBe(0);
    expect(await count('org_plans', "org_id = 'org-p'")).toBe(0);
    expect(await count('organization', "id = 'org-p'")).toBe(0);
  });

  // Both containers run the pass; each lists the org, the row lock lets one purge it.
  // The same re-check is what lets a restore that commits after the listing win.
  it('purges an org once when two passes run at the same time', async () => {
    const now = new Date();
    await user('kim');
    await org('org-twice', 'kim', now);
    await offboarding(db).requestOrgDeletion('org-twice', { reason: 'x', actor: 'ops' });
    const [a, b] = await Promise.all([
      offboarding(db).runRetention({ now: at(now, 31) }),
      offboarding(db).runRetention({ now: at(now, 31) }),
    ]);
    expect([...a.orgsPurged, ...b.orgsPurged].filter((o) => o === 'org-twice')).toHaveLength(1);
    const { rows } = await sql<{ n: number }>`select count(*)::int as n from org_suspensions
      where org_id = 'org-twice'`.execute(db);
    expect(rows[0].n).toBe(1);
  });

  it('runs every step even when one fails, and reports the failure', async () => {
    const now = new Date();
    await user('lea');
    await sql`insert into session (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
      values ('s-stuck', ${at(now, -1)}, 't-stuck', now(), now(), 'lea')`.execute(db);
    await sql`insert into verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
      values ('v-after', 'lea', 'z', ${at(now, -1)}, now(), now())`.execute(db);
    // A real failure in the sessions step: the database refuses the delete.
    await sql
      .raw(
        `create function iris_test_refuse() returns trigger language plpgsql as
      $$ begin raise exception 'refused by test'; end $$`,
      )
      .execute(db);
    await sql
      .raw(
        `create trigger refuse_session_delete before delete on session
      for each row execute function iris_test_refuse()`,
      )
      .execute(db);
    try {
      const report = await offboarding(db).runRetention({ now });
      expect(report.failures).toEqual(['sessions']);
      // The step after it still ran.
      expect(await count('verification', "id = 'v-after'")).toBe(0);
    } finally {
      await sql.raw('drop trigger refuse_session_delete on session').execute(db);
      await sql.raw('drop function iris_test_refuse()').execute(db);
    }
  });

  it('lists the purged orgs, whose AI state each container then removes', async () => {
    expect(await offboarding(db).purgedOrgIds()).toEqual(expect.arrayContaining(['org-twice']));
    expect(await offboarding(db).purgedOrgIds()).not.toContain('org-r');
  });

  it('drops finished runs after 90 days but keeps their billing records', async () => {
    const now = new Date();
    await user('dan');
    await org('org-a', 'dan', now);
    const report = await offboarding(db).runRetention({ now });
    expect(report.runsDeleted).toBeGreaterThanOrEqual(1);
    const runs = await sql<{
      summary: string;
    }>`select summary from runs where org_id = 'org-a'`.execute(db);
    expect(runs.rows.map((r) => r.summary)).toEqual(['new']);
    expect(await count('run_results', "org_id = 'org-a'")).toBe(1);
    expect(await count('usage_events', "org_id = 'org-a'")).toBe(2);
    expect(await count('usage_events', "org_id = 'org-a' and run_id is null")).toBe(1);
  });

  it('drops expired sessions and verification tokens, and nothing live', async () => {
    const now = new Date();
    await user('fay');
    await sql`insert into session (id, "expiresAt", token, "createdAt", "updatedAt", "userId")
      values ('s-old', ${at(now, -1)}, 't-old', now(), now(), 'fay'),
             ('s-live', ${at(now, 1)}, 't-live', now(), now(), 'fay')`.execute(db);
    await sql`insert into verification (id, identifier, value, "expiresAt", "createdAt", "updatedAt")
      values ('v-old', 'fay', 'x', ${at(now, -1)}, now(), now()),
             ('v-live', 'fay', 'y', ${at(now, 1)}, now(), now())`.execute(db);
    const report = await offboarding(db).runRetention({ now });
    expect(report.sessionsDeleted).toBeGreaterThanOrEqual(1);
    expect(await count('session', "id in ('s-old', 's-live')")).toBe(1);
    expect(await count('verification', "id in ('v-old', 'v-live')")).toBe(1);
  });

  it('pseudonymises terms evidence when a user is deleted, and drops it after 7 years', async () => {
    const now = new Date();
    await user('gus');
    await sql`insert into terms_acceptances (user_id, document, version, accepted_at, ip)
      values ('gus', 'terms', '2026-10-02', now(), '203.0.113.7')`.execute(db);
    // Elsewhere: an audit row naming them, and an invitation addressed to them.
    await sql`insert into organization (id, name, slug, "createdAt")
      values ('org-g', 'G', 'g', now())`.execute(db);
    await sql`insert into audit_log (org_id, actor_user_id, action) values ('org-g', 'gus', 'key.create')`.execute(
      db,
    );
    await user('ivy');
    await sql`insert into invitation (id, "organizationId", email, role, status, "expiresAt", "inviterId")
      values ('inv-g', 'org-g', 'GUS@iris.test', 'member', 'pending', now(), 'ivy')`.execute(db);
    await offboarding(db).deleteUser('gus');
    // The raw id is the pseudonym's preimage: nothing keeps it.
    expect(await count('audit_log', "actor_user_id = 'gus'")).toBe(0);
    expect(await count('audit_log', "org_id = 'org-g'")).toBe(1);
    expect(await count('invitation', "id = 'inv-g'")).toBe(0);

    const { rows } = await sql<{ user_id: string | null; user_hash: string; ip: string }>`
      select user_id, user_hash, ip from terms_acceptances where document = 'terms'
        and user_hash is not null`.execute(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBeNull();
    expect(rows[0].user_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].user_hash).not.toContain('gus');
    expect(rows[0].ip).toBe('203.0.113.7');

    await offboarding(db).runRetention({ now: at(now, 6 * 365) });
    expect(await count('terms_acceptances', 'user_hash is not null')).toBe(1);
    await offboarding(db).runRetention({ now: at(now, 7 * 366) });
    expect(await count('terms_acceptances', 'user_hash is not null')).toBe(0);
  });

  it("refuses to delete a user who is a live org's only owner", async () => {
    const now = new Date();
    await user('hal');
    await org('org-h', 'hal', now);
    await expect(offboarding(db).deleteUser('hal')).rejects.toThrow(/only owner/);
    // Once the org's deletion is requested, the user can go.
    await offboarding(db).requestOrgDeletion('org-h', { reason: 'leaving', actor: 'ops' });
    await offboarding(db).deleteUser('hal');
    expect(await count('"user"', "id = 'hal'")).toBe(0);
  });

  it('refuses unknown orgs and users', async () => {
    const off = offboarding(db);
    await expect(off.requestOrgDeletion('nope', { reason: 'x', actor: 'ops' })).rejects.toThrow(
      OffboardingError,
    );
    await expect(off.restoreOrg('nope', { actor: 'ops' })).rejects.toThrow(OffboardingError);
    await expect(off.deleteUser('nobody')).rejects.toThrow(OffboardingError);
  });
});

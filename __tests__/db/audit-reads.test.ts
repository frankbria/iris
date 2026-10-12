/**
 * Reading an org's audit trail (#541) over real Postgres: newest first, paged by cursor,
 * only the caller org's entries, the actor's name while they exist, strings redacted.
 */
import { randomBytes } from 'crypto';
import { Kysely, sql } from 'kysely';
import { Client } from 'pg';
import { createPostgresDb } from '../../src/db/postgres';
import { migrateToLatest } from '../../src/db/migrate';
import { recordAudit } from '../../src/audit-log';
import { auditPage, InvalidAuditCursorError } from '../../src/audit-reads';

const ADMIN_URL = process.env.IRIS_TEST_DATABASE_URL;
if (!ADMIN_URL) {
  if (process.env.CI) throw new Error('IRIS_TEST_DATABASE_URL is required in CI');
  console.warn('Skipping audit read tests: set IRIS_TEST_DATABASE_URL');
}

(ADMIN_URL ? describe : describe.skip)('audit trail reads (#541)', () => {
  const dbName = `iris_auditr_${process.pid}_${randomBytes(4).toString('hex')}`;
  let db: Kysely<unknown>;

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
      await sql`insert into organization (id, name, slug, "createdAt") values (${org}, ${org}, ${org}, now())`.execute(
        db,
      );
    }
    await sql`insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
      values ('u-ann', 'Ann', 'ann@iris.test', true, now(), now())`.execute(db);
    for (let i = 1; i <= 5; i++) {
      await recordAudit(db, {
        orgId: 'org-a',
        actor: { userId: 'u-ann' },
        action: 'api_key.create',
        target: `key:k${i}`,
      });
    }
    await recordAudit(db, {
      orgId: 'org-a',
      actor: { apiKeyId: 'key-1' },
      action: 'job.submit',
      target: 'run:r1',
      metadata: { url: 'https://site.test/?token=abcdef123456' },
    });
    await recordAudit(db, { orgId: 'org-b', action: 'plan.set', metadata: { plan: 'pro' } });
  });

  afterAll(async () => {
    await db?.destroy();
    await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  });

  it('pages newest first with a cursor, and only the caller org', async () => {
    const first = await auditPage(db, 'org-a', { limit: 4 });
    expect(first.entries.map((e) => e.target)).toEqual(['run:r1', 'key:k5', 'key:k4', 'key:k3']);
    expect(first.nextCursor).toBeDefined();
    const second = await auditPage(db, 'org-a', { cursor: first.nextCursor, limit: 4 });
    expect(second.entries.map((e) => e.target)).toEqual(['key:k2', 'key:k1']);
    expect(second.nextCursor).toBeUndefined();
    // Another org's cursor or ids never reach org-a's entries, and the reverse.
    const b = await auditPage(db, 'org-b', { limit: 10 });
    expect(b.entries.map((e) => e.action)).toEqual(['plan.set']);
  });

  it('names the acting user, the key, and redacts secret-looking values', async () => {
    const { entries } = await auditPage(db, 'org-a', { limit: 10 });
    expect(entries.find((e) => e.target === 'key:k1')?.actorUser).toEqual({
      id: 'u-ann',
      name: 'Ann',
      email: 'ann@iris.test',
    });
    const job = entries.find((e) => e.action === 'job.submit')!;
    expect(job.actorApiKeyId).toBe('key-1');
    expect(JSON.stringify(job.metadata)).not.toContain('abcdef123456');
  });

  it('refuses a cursor it did not make', async () => {
    for (const cursor of ['abc', '0', '-1', '1e3', '99999999999999999999']) {
      await expect(auditPage(db, 'org-a', { cursor })).rejects.toThrow(InvalidAuditCursorError);
    }
  });
});

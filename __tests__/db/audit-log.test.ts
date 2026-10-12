/**
 * The tenant audit log over real Postgres (#361).
 *
 * Test strategy: a throwaway database migrated to latest with two orgs; each audited
 * change is made through the store that owns it, and the audit rows are read back.
 * API-key writes are audited by BetterAuth hooks (auth-apikey.test.ts); session start and
 * end by the RPC server (below, through its `audit` seam).
 */

import { randomBytes } from 'crypto';
import { once } from 'events';
import type { AddressInfo } from 'net';
import { Kysely, sql } from 'kysely';
import { Client } from 'pg';
import WebSocket from 'ws';
import { actorFrom, type AuditEntry } from '../../src/audit-log';
import { orgAiSettings } from '../../src/billing/managed-ai';
import { orgEntitlements } from '../../src/billing/plans';
import { resolveKeyring } from '../../src/byok/crypto';
import { providerKeyStore } from '../../src/byok/store';
import { createPostgresDb } from '../../src/db/postgres';
import { migrateToLatest } from '../../src/db/migrate';
import { postgresJobs, type A11yJobParams } from '../../src/history-store';
import { startServer } from '../../src/protocol';

const ADMIN_URL = process.env.IRIS_TEST_DATABASE_URL;
if (!ADMIN_URL) {
  if (process.env.CI) throw new Error('IRIS_TEST_DATABASE_URL is required in CI');
  console.warn('Skipping audit log tests: set IRIS_TEST_DATABASE_URL');
}

const A11Y: A11yJobParams = {
  urls: ['https://example.com/'],
  wcagLevel: 'AA',
  failOn: ['serious'],
};
const OPENAI_KEY = ['sk', 'proj', randomBytes(24).toString('hex')].join('-');

(ADMIN_URL ? describe : describe.skip)('tenant audit log (#361)', () => {
  const dbName = `iris_audit_${process.pid}_${randomBytes(4).toString('hex')}`;
  let db: Kysely<unknown>;
  const keyring = resolveKeyring({
    IRIS_KEY_ENCRYPTION_KEY: `k1:${randomBytes(32).toString('base64')}`,
  });

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

  beforeEach(async () => {
    await sql`delete from audit_log`.execute(db);
  });

  /** The org's entries, oldest first, without ids and times. */
  const entries = async (orgId: string) =>
    (
      await sql<{
        actor_user_id: string | null;
        actor_api_key_id: string | null;
        action: string;
        target: string | null;
        metadata: unknown;
      }>`select actor_user_id, actor_api_key_id, action, target, metadata from audit_log
        where org_id = ${orgId} order by id`.execute(db)
    ).rows.map(({ actor_user_id, actor_api_key_id, ...rest }) => ({
      actor: { userId: actor_user_id, apiKeyId: actor_api_key_id },
      ...rest,
    }));
  const alice = { userId: 'alice', apiKeyId: null };

  it('records provider key save, replace and remove with the user, never the key', async () => {
    const store = providerKeyStore(db, keyring);
    await store.set('org-a', 'openai', OPENAI_KEY, { userId: 'alice' });
    await store.set('org-a', 'openai', OPENAI_KEY, { userId: 'alice' });
    await store.remove('org-a', 'openai', { userId: 'alice' });
    // Removing nothing changes nothing, so it records nothing.
    await store.remove('org-a', 'openai', { userId: 'alice' });

    expect(await entries('org-a')).toEqual([
      {
        actor: alice,
        action: 'provider_key.save',
        target: 'provider:openai',
        metadata: { replaced: false },
      },
      {
        actor: alice,
        action: 'provider_key.save',
        target: 'provider:openai',
        metadata: { replaced: true },
      },
      { actor: alice, action: 'provider_key.remove', target: 'provider:openai', metadata: null },
    ]);
    expect(await entries('org-b')).toEqual([]);
    const all = await sql`select * from audit_log`.execute(db);
    expect(JSON.stringify(all.rows)).not.toContain(OPENAI_KEY);
  });

  it("records a master-key rewrap in each affected org's log", async () => {
    const store = providerKeyStore(db, keyring);
    await store.set('org-a', 'openai', OPENAI_KEY);
    await store.set('org-b', 'openai', OPENAI_KEY);
    await sql`delete from audit_log`.execute(db);
    expect(await store.rewrapAll()).toBe(2);
    for (const org of ['org-a', 'org-b']) {
      expect(await entries(org)).toEqual([
        {
          actor: { userId: null, apiKeyId: null },
          action: 'provider_key.rewrap',
          target: 'provider:openai',
          metadata: { masterKey: 'k1' },
        },
      ]);
    }
    await store.remove('org-a', 'openai');
    await store.remove('org-b', 'openai');
  });

  it('records the AI mode and plan changes', async () => {
    await orgAiSettings(db).set('org-a', 'managed', 'user:alice');
    await orgEntitlements(db).setPlan('org-a', 'team', { runsPerMonth: 9000 }, { userId: 'op' });
    expect(await entries('org-a')).toEqual([
      { actor: alice, action: 'ai_mode.set', target: null, metadata: { mode: 'managed' } },
      {
        actor: { userId: 'op', apiKeyId: null },
        action: 'plan.set',
        target: null,
        metadata: { plan: 'team', overrides: { runsPerMonth: 9000 } },
      },
    ]);
  });

  it('records a job submit with its key, in the same transaction as the run', async () => {
    const id = await postgresJobs(db)
      .forOrg({ orgId: 'org-a', apiKeyId: 'key-a' })
      .enqueue({ kind: 'a11y', params: A11Y });
    expect(await entries('org-a')).toEqual([
      {
        actor: { userId: null, apiKeyId: 'key-a' },
        action: 'job.submit',
        target: `run:${id}`,
        metadata: { kind: 'a11y' },
      },
    ]);
    // Refused over the outstanding cap: no run, so no entry.
    expect(
      await postgresJobs(db)
        .forOrg({ orgId: 'org-a', apiKeyId: 'key-a' })
        .enqueue({ kind: 'a11y', params: A11Y }, { maxOutstanding: 1 }),
    ).toBeNull();
    expect(await entries('org-a')).toHaveLength(1);
    await sql`delete from runs`.execute(db);
  });

  it('reads the portal and API actor forms', () => {
    expect(actorFrom('user:u1')).toEqual({ userId: 'u1' });
    expect(actorFrom('key:k1')).toEqual({ apiKeyId: 'k1' });
    expect(actorFrom('first-run')).toEqual({});
  });
});

describe('RPC session start and end are audited (#361)', () => {
  it('records both for a tenant connection, with its key', async () => {
    const seen: AuditEntry[] = [];
    const wss = startServer(0, {
      authenticate: {
        verify: async () => ({ orgId: 'org-a', keyId: 'key-a' }),
        recheck: async () => true,
      },
      audit: async (entry) => {
        seen.push(entry);
      },
    });
    await once(wss, 'listening');
    const { port } = wss.address() as AddressInfo;
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { Authorization: 'Bearer iris_test' },
      });
      await once(ws, 'open');
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'launchBrowser' }));
      await once(ws, 'message');
      ws.close();
      const deadline = Date.now() + 10_000;
      while (seen.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const actor = { apiKeyId: 'key-a' };
      expect(seen).toEqual([
        {
          orgId: 'org-a',
          actor,
          action: 'session.start',
          target: expect.stringMatching(/^session:/),
        },
        { orgId: 'org-a', actor, action: 'session.end', target: seen[0].target },
      ]);
    } finally {
      await new Promise((resolve) => wss.close(resolve));
    }
  }, 30_000);
});

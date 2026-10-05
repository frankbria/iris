/**
 * Managed AI credits (#479, ADR 0001 §6) over real Postgres: the org's mode, its plan's
 * monthly credit, this month's managed spend in the ledger and its own stored key decide
 * each call's credential. The provider-key store is the real one, sealing with a keyring.
 */

import { randomBytes } from 'crypto';
import { Kysely, sql } from 'kysely';
import { Client } from 'pg';
import { createPostgresDb } from '../../src/db/postgres';
import { migrateToLatest } from '../../src/db/migrate';
import { resolveKeyring } from '../../src/byok/crypto';
import { providerKeyStore } from '../../src/byok/store';
import { orgEntitlements } from '../../src/billing/plans';
import {
  managedAiResolver,
  managedSpendThisMonth,
  orgAiSettings,
  resolveManagedKey,
} from '../../src/billing/managed-ai';

const ADMIN_URL = process.env.IRIS_TEST_DATABASE_URL;
if (!ADMIN_URL) {
  if (process.env.CI) throw new Error('IRIS_TEST_DATABASE_URL is required in CI');
  console.warn('Skipping managed AI tests: set IRIS_TEST_DATABASE_URL');
}

const ORG_KEY = ['sk', 'proj', randomBytes(24).toString('hex')].join('-');
const MANAGED = { provider: 'anthropic' as const, apiKey: 'iris-managed-key' };

(ADMIN_URL ? describe : describe.skip)('managed AI credits', () => {
  const dbName = `iris_managed_${process.pid}_${randomBytes(4).toString('hex')}`;
  let db: Kysely<unknown>;
  const keyring = resolveKeyring({
    IRIS_KEY_ENCRYPTION_KEY: `k1:${randomBytes(32).toString('base64')}`,
  });

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
    for (const org of ['org-m', 'org-b', 'org-x']) {
      await sql`insert into organization (id, name, slug, "createdAt") values (${org}, ${org}, ${org}, now())`.execute(
        db,
      );
    }
  });

  afterAll(async () => {
    await db?.destroy();
    await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  });

  const resolver = (managedKey = MANAGED as typeof MANAGED | null) =>
    managedAiResolver({
      db,
      entitlements: (o) => orgEntitlements(db).get(o),
      providerKeys: providerKeyStore(db, keyring),
      managedKey,
    });
  const spend = (org: string, usd: number, mode: 'managed' | 'byok', when = sql`now()`) =>
    sql`insert into usage_events (org_id, kind, quantity, billing_mode, unit_cost_usd, idempotency_key, created_at)
      values (${org}, 'text_call', 1, ${mode}, ${usd}, ${`k-${randomBytes(4).toString('hex')}`}, ${when})`.execute(
      db,
    );

  it('a BYOK org (the default) uses its own key and is never switched to managed', async () => {
    expect(await orgAiSettings(db).get('org-b')).toBe('byok');
    await providerKeyStore(db, keyring).set('org-b', 'openai', ORG_KEY);
    await orgEntitlements(db).setPlan('org-b', 'team'); // $50 of credit it did not choose
    expect(await resolver()({ orgId: 'org-b' })).toMatchObject({
      provider: 'openai',
      apiKey: ORG_KEY,
      billingMode: 'byok',
    });
  });

  it("a managed org with credit left gets IRIS's key; spent, it falls back to its own key", async () => {
    await orgEntitlements(db).setPlan('org-m', 'pro'); // $10 a month
    await orgAiSettings(db).set('org-m', 'managed', 'user:u1');
    await spend('org-m', 9.5, 'managed');
    await spend('org-m', 100, 'byok'); // its own spend never uses the credit
    await spend('org-m', 100, 'managed', sql`date_trunc('month', now()) - interval '1 day'`); // last month
    await spend('org-b', 100, 'managed'); // another org's spend is its own
    expect(await managedSpendThisMonth(db, 'org-m')).toBeCloseTo(9.5);
    expect(await resolver()({ orgId: 'org-m' })).toEqual({ ...MANAGED, billingMode: 'managed' });

    await spend('org-m', 0.5, 'managed'); // the credit is used up
    // No key of its own yet: no AI, and never someone else's key.
    expect(await resolver()({ orgId: 'org-m' })).toBeNull();
    await providerKeyStore(db, keyring).set('org-m', 'openai', ORG_KEY);
    expect(await resolver()({ orgId: 'org-m' })).toMatchObject({
      apiKey: ORG_KEY,
      billingMode: 'byok',
    });
  });

  it('managed mode without an operator key, or a plan without BYOK, degrades safely', async () => {
    await orgEntitlements(db).setPlan('org-x', 'free', { byokAllowed: false });
    await orgAiSettings(db).set('org-x', 'managed', 'user:u2');
    await providerKeyStore(db, keyring).set('org-x', 'openai', ORG_KEY);
    // Free has no credit, and its plan forbids BYOK: no AI at all.
    expect(await resolver()({ orgId: 'org-x' })).toBeNull();
    // With credit but no managed key configured on this server: the org's key if allowed.
    await orgEntitlements(db).setPlan('org-x', 'pro');
    expect(await resolver(null)({ orgId: 'org-x' })).toMatchObject({ billingMode: 'byok' });
  });

  it('resolves the operator key from the environment, all or nothing', () => {
    expect(resolveManagedKey({})).toBeNull();
    expect(
      resolveManagedKey({ IRIS_MANAGED_AI_PROVIDER: 'openai', IRIS_MANAGED_AI_KEY: 'k' }),
    ).toEqual({
      provider: 'openai',
      apiKey: 'k',
    });
    expect(() => resolveManagedKey({ IRIS_MANAGED_AI_PROVIDER: 'openai' })).toThrow(/together/);
    expect(() => resolveManagedKey({ IRIS_MANAGED_AI_KEY: 'k' })).toThrow(/together/);
    expect(() =>
      resolveManagedKey({ IRIS_MANAGED_AI_PROVIDER: 'ollama', IRIS_MANAGED_AI_KEY: 'k' }),
    ).toThrow(/openai or anthropic/);
  });

  it('refuses an unknown mode', async () => {
    await expect(orgAiSettings(db).set('org-b', 'free-for-all' as never, 'x')).rejects.toThrow(
      /Unknown AI mode/,
    );
  });
});

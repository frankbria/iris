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
import { managedCallEstimateUsd } from '../../src/ai-client/cost-tracker';

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
    for (const org of ['org-m', 'org-b', 'org-x', 'org-r', 'org-big']) {
      await sql`insert into organization (id, name, slug, "createdAt") values (${org}, ${org}, ${org}, now())`.execute(
        db,
      );
    }
  });

  afterAll(async () => {
    await db?.destroy();
    await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  });

  const resolver = (
    managedKey = MANAGED as typeof MANAGED | null,
    estimateUsd = (inputChars: number) => managedCallEstimateUsd(MANAGED.provider, inputChars),
  ) =>
    managedAiResolver({
      db,
      entitlements: (o) => orgEntitlements(db).get(o),
      providerKeys: providerKeyStore(db, keyring),
      managedKey,
      estimateUsd,
    });
  /** The credential without its `release` handle, for equality checks. */
  const creds = (r: Awaited<ReturnType<ReturnType<typeof resolver>>>) => {
    if (!r) return r;
    const { release: _release, ...rest } = r as typeof r & { release?: unknown };
    return rest;
  };
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
    const admitted = await resolver()({ orgId: 'org-m' });
    expect(creds(admitted)).toEqual({ ...MANAGED, billingMode: 'managed' });
    await admitted?.release?.();

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

  // #482: credit is reserved before the call, so parallel calls cannot overshoot it.
  it('admits only as many parallel managed calls as the credit covers (#482)', async () => {
    await orgEntitlements(db).setPlan('org-r', 'pro'); // $10
    await orgAiSettings(db).set('org-r', 'managed', 'user:u3');
    await spend('org-r', 7, 'managed'); // $3 left: three calls at a $1 worst case
    const resolve = resolver(MANAGED, () => 1);
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => resolve({ orgId: 'org-r' })));
    const managed = results.filter((r) => r?.billingMode === 'managed');
    expect(managed).toHaveLength(3);
    expect(results.filter((r) => r === null)).toHaveLength(2); // no key of its own: no AI
    const reserved = async () =>
      (
        await sql<{ n: number }>`select count(*)::int as n from managed_ai_reservations
          where org_id = 'org-r'`.execute(db)
      ).rows[0].n;
    expect(await reserved()).toBe(3);

    // A settled call is in the ledger and its reservation released: $0.99 of room, less
    // than a worst case, so still no admission.
    await spend('org-r', 0.01, 'managed');
    await managed[0]!.release!();
    expect(await reserved()).toBe(2);
    expect((await resolve({ orgId: 'org-r' }))?.billingMode).not.toBe('managed');
    // A call that failed before the provider billed releases its whole reservation.
    await managed[1]!.release!();
    expect((await resolve({ orgId: 'org-r' }))?.billingMode).toBe('managed');
    // Releasing twice is harmless.
    await managed[0]!.release!();

    // A reservation left by a crashed call stops counting after a while.
    await sql`update managed_ai_reservations set created_at = now() - interval '1 hour'
      where org_id = 'org-r'`.execute(db);
    expect((await resolve({ orgId: 'org-r' }))?.billingMode).toBe('managed');
  });

  // Codex review: priced at the provider's dearest registered rates, because the model a
  // call runs on may be a rescued successor of a retired default (#184); and the request's
  // own size is added to the input ceiling, as the budget reservation does (#244).
  it("prices the worst case at the provider's dearest rates plus the request size (#482)", () => {
    // claude-opus-5: 8000 input tokens at $5/M plus 1000 output at $25/M.
    expect(managedCallEstimateUsd('anthropic')).toBeCloseTo(0.065, 6);
    expect(managedCallEstimateUsd('anthropic', 2000)).toBeCloseTo(0.075, 6);
    // gpt-4o-2024-05-13: 8000 at $5/M plus 1000 at $15/M.
    expect(managedCallEstimateUsd('openai')).toBeCloseTo(0.055, 6);
  });

  it('reserves more for a larger request (#482)', async () => {
    await orgEntitlements(db).setPlan('org-big', 'pro'); // $10
    await orgAiSettings(db).set('org-big', 'managed', 'user:u4');
    await spend('org-big', 9.9, 'managed'); // $0.10 left
    const resolve = resolver(MANAGED, (chars) => managedCallEstimateUsd('anthropic', chars));
    // A short instruction fits; one of 100k characters (~$0.50 of input) does not.
    const small = await resolve({ orgId: 'org-big' }, { inputChars: 100 });
    expect(small?.billingMode).toBe('managed');
    await small?.release?.();
    expect(await resolve({ orgId: 'org-big' }, { inputChars: 100_000 })).toBeNull();
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

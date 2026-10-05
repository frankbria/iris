/**
 * Org provider keys in Postgres (#344).
 *
 * Test strategy: a throwaway database migrated to latest, two orgs inserted
 * directly, and the store under test sealing with a real keyring. Isolation is
 * checked through the store and, for the at-rest property, against the table.
 */

import { randomBytes } from 'crypto';
import { Kysely, sql } from 'kysely';
import { Client } from 'pg';
import { createPostgresDb } from '../../src/db/postgres';
import { migrateToLatest } from '../../src/db/migrate';
import { resolveKeyring } from '../../src/byok/crypto';
import { providerKeyStore } from '../../src/byok/store';
import { orgEntitlements } from '../../src/billing/plans';

const ADMIN_URL = process.env.IRIS_TEST_DATABASE_URL;
if (!ADMIN_URL) {
  if (process.env.CI) throw new Error('IRIS_TEST_DATABASE_URL is required in CI');
  console.warn('Skipping provider key store tests: set IRIS_TEST_DATABASE_URL');
}

// Shaped like real keys, built at runtime so no literal looks like a credential.
const OPENAI_KEY = ['sk', 'proj', randomBytes(24).toString('hex')].join('-');
const ANTHROPIC_KEY = ['sk', 'ant', 'api03', randomBytes(24).toString('hex')].join('-');

(ADMIN_URL ? describe : describe.skip)('providerKeyStore', () => {
  const dbName = `iris_byok_${process.pid}_${randomBytes(4).toString('hex')}`;
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

  const store = () => providerKeyStore(db, keyring);

  it('stores a key encrypted and gives it back only as credentials for its org', async () => {
    await store().set('org-a', 'openai', OPENAI_KEY);
    expect(await store().credentialsFor('org-a')).toEqual({
      provider: 'openai',
      apiKey: OPENAI_KEY,
    });
    const { rows } = await sql<{ t: string }>`
      select encode(ciphertext, 'escape') as t from provider_keys where org_id = 'org-a'`.execute(
      db,
    );
    expect(rows[0].t).not.toContain(OPENAI_KEY.slice(8));
  });

  it("lists which providers are configured, never a key, and nothing of another org's", async () => {
    const listed = await store().list('org-a');
    expect(listed).toEqual([{ provider: 'openai', updatedAt: expect.any(Date) }]);
    expect(JSON.stringify(listed)).not.toContain(OPENAI_KEY);
    expect(await store().list('org-b')).toEqual([]);
    expect(await store().credentialsFor('org-b')).toBeNull();
  });

  it('replaces a key, and uses the provider saved most recently', async () => {
    await store().set('org-a', 'anthropic', ANTHROPIC_KEY);
    expect(await store().credentialsFor('org-a')).toEqual({
      provider: 'anthropic',
      apiKey: ANTHROPIC_KEY,
    });
    const replacement = ['sk', 'proj', randomBytes(24).toString('hex')].join('-');
    await store().set('org-a', 'openai', replacement);
    expect(await store().credentialsFor('org-a')).toEqual({
      provider: 'openai',
      apiKey: replacement,
    });
    expect((await store().list('org-a')).map((k) => k.provider)).toEqual(['anthropic', 'openai']);
  });

  it('removes a key; the other provider stays', async () => {
    await store().remove('org-a', 'openai');
    expect(await store().credentialsFor('org-a')).toEqual({
      provider: 'anthropic',
      apiKey: ANTHROPIC_KEY,
    });
    await store().remove('org-a', 'anthropic');
    expect(await store().credentialsFor('org-a')).toBeNull();
  });

  it("refuses a row copied from another org: it does not decrypt as that org's key", async () => {
    await store().set('org-a', 'openai', OPENAI_KEY);
    await sql`insert into provider_keys (org_id, provider, ciphertext)
      select 'org-b', provider, ciphertext from provider_keys where org_id = 'org-a'`.execute(db);
    await expect(store().credentialsFor('org-b')).rejects.toThrow();
  });

  it('re-seals every row under the current master key after a rotation', async () => {
    const old = `old:${randomBytes(32).toString('base64')}`;
    const fresh = `new:${randomBytes(32).toString('base64')}`;
    const oldRing = resolveKeyring({ IRIS_KEY_ENCRYPTION_KEY: old });
    await sql`delete from provider_keys`.execute(db);
    await providerKeyStore(db, oldRing).set('org-a', 'openai', OPENAI_KEY);
    await providerKeyStore(db, oldRing).set('org-b', 'anthropic', ANTHROPIC_KEY);

    const rotated = resolveKeyring({ IRIS_KEY_ENCRYPTION_KEY: `${fresh},${old}` });
    expect(await providerKeyStore(db, rotated).rewrapAll()).toBe(2);

    // The old key can now be dropped: the new one alone opens every row.
    const onlyNew = providerKeyStore(db, resolveKeyring({ IRIS_KEY_ENCRYPTION_KEY: fresh }));
    expect(await onlyNew.credentialsFor('org-a')).toEqual({
      provider: 'openai',
      apiKey: OPENAI_KEY,
    });
    expect(await onlyNew.credentialsFor('org-b')).toEqual({
      provider: 'anthropic',
      apiKey: ANTHROPIC_KEY,
    });
    await sql`delete from provider_keys`.execute(db);
  });

  it.each([
    ['openai', ''],
    ['openai', 'not-a-key'],
    ['openai', `${OPENAI_KEY} trailing`],
    ['anthropic', OPENAI_KEY],
    ['openai', 'sk-' + 'x'.repeat(600)],
    ['ollama', 'sk-whatever-long-enough-to-pass-length'],
  ])('refuses provider %p with a malformed key', async (provider, key) => {
    await expect(store().set('org-b', provider as never, key)).rejects.toThrow(/provider key/i);
  });

  // #346: the stored key is used only while the org's plan allows bring-your-own-key.
  it('gives no stored key to an org whose plan does not allow BYOK', async () => {
    // Loaded here: api-key-auth pulls BetterAuth (ESM) only where used, not at import.
    const { planAwareCredentials } = await import('../../src/api-key-auth');
    await store().set('org-a', 'openai', OPENAI_KEY);
    const credentials = planAwareCredentials((o) => orgEntitlements(db).get(o), store());
    const principal = { orgId: 'org-a', keyId: 'k' };
    expect(await credentials(principal)).toMatchObject({ provider: 'openai' });
    await orgEntitlements(db).setPlan('org-a', 'free', { byokAllowed: false });
    expect(await credentials(principal)).toBeNull();
    await orgEntitlements(db).setPlan('org-a', 'free');
  });
});

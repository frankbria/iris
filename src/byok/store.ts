import { sql, type Kysely } from 'kysely';
import type { AICredentials } from '../ai-client/credentials';
import { openProviderKey, sealProviderKey, type Keyring, type StoredProvider } from './crypto';

/** What anyone in the org may see about a stored key: that it exists, and since when. */
export interface ProviderKeySummary {
  provider: StoredProvider;
  updatedAt: Date;
}

/** A provider key the store refuses, with a message the portal can show. */
export class ProviderKeyError extends Error {
  readonly name = 'ProviderKeyError';
}

const PREFIX: Record<StoredProvider, RegExp> = {
  // Anthropic keys also start `sk-`: the more specific prefix tells them apart.
  openai: /^sk-(?!ant-)/,
  anthropic: /^sk-ant-/,
};

/**
 * A key shaped like the provider's: no whitespace, a plausible length, the vendor's
 * prefix. Not a live check against the vendor: that would make the portal call
 * OpenAI on every save. Hosted vendors only (#258: no endpoint, no Ollama).
 */
function validate(provider: StoredProvider, apiKey: string): void {
  if (!(provider in PREFIX))
    throw new ProviderKeyError(`Unsupported provider key vendor: ${provider}`);
  if (!/^\S{20,512}$/.test(apiKey) || !PREFIX[provider].test(apiKey)) {
    throw new ProviderKeyError(
      `That does not look like an ${provider === 'openai' ? 'OpenAI' : 'Anthropic'} provider key`,
    );
  }
}

/**
 * The orgs' own AI provider keys (BYOK, #344), envelope-encrypted at rest. Every
 * query names its org; the plaintext leaves only through {@link credentialsFor}, for
 * the server to make that org's AI calls.
 */
export function providerKeyStore(db: Kysely<unknown>, keyring: Keyring) {
  return {
    /** Save or replace the org's key for a provider. */
    async set(orgId: string, provider: StoredProvider, apiKey: string): Promise<void> {
      validate(provider, apiKey);
      const ciphertext = sealProviderKey(apiKey, { orgId, provider }, keyring);
      await sql`
        insert into provider_keys (org_id, provider, ciphertext)
        values (${orgId}, ${provider}, ${ciphertext})
        on conflict (org_id, provider)
        do update set ciphertext = excluded.ciphertext, updated_at = now()`.execute(db);
    },

    async remove(orgId: string, provider: StoredProvider): Promise<void> {
      await sql`delete from provider_keys where org_id = ${orgId} and provider = ${provider}`.execute(
        db,
      );
    },

    async list(orgId: string): Promise<ProviderKeySummary[]> {
      const { rows } = await sql<{ provider: StoredProvider; updated_at: Date }>`
        select provider, updated_at from provider_keys where org_id = ${orgId}
        order by provider`.execute(db);
      return rows.map((r) => ({ provider: r.provider, updatedAt: r.updated_at }));
    },

    /**
     * The org's credentials for an AI call, or `null` when it stored none. With keys for
     * both vendors, the one saved most recently is used.
     *
     * ponytail: "most recent wins" until managed credits (#346) add an explicit org AI
     * setting to choose by.
     *
     * @throws when the stored key does not open (another org's row, a changed row, a
     *   missing master key): the caller treats that as no AI
     */
    /**
     * Re-seal every org's key under the keyring's current master key, for a rotation:
     * list the new key first, run this (`node dist/byok/rewrap.js`), then drop the
     * old key. Operator use only: it opens every org's key in this process.
     *
     * @returns how many rows were re-sealed
     */
    async rewrapAll(): Promise<number> {
      const { rows } = await sql<{
        id: string;
        org_id: string;
        provider: StoredProvider;
        ciphertext: Buffer;
      }>`
        select id, org_id, provider, ciphertext from provider_keys`.execute(db);
      for (const row of rows) {
        const owner = { orgId: row.org_id, provider: row.provider };
        const resealed = sealProviderKey(
          openProviderKey(row.ciphertext, owner, keyring),
          owner,
          keyring,
        );
        // updated_at is untouched: the key did not change, and it orders which vendor is used.
        await sql`update provider_keys set ciphertext = ${resealed} where id = ${row.id}`.execute(
          db,
        );
      }
      return rows.length;
    },

    async credentialsFor(orgId: string): Promise<AICredentials | null> {
      const { rows } = await sql<{ provider: StoredProvider; ciphertext: Buffer }>`
        select provider, ciphertext from provider_keys where org_id = ${orgId}
        order by updated_at desc, provider limit 1`.execute(db);
      const row = rows[0];
      if (!row) return null;
      return {
        provider: row.provider,
        apiKey: openProviderKey(row.ciphertext, { orgId, provider: row.provider }, keyring),
      };
    },
  };
}

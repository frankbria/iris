import { sql, type Kysely } from 'kysely';
import type { AICredentials } from './ai-client/credentials';
import type { PostgresHistory } from './history-store';
import type { Authenticator, Principal } from './protocol';

/** The slice of a BetterAuth instance (`createAuth()`) this module uses. */
export interface KeyVerifier {
  api: {
    verifyApiKey(input: { body: { key: string } }): Promise<{
      valid: boolean;
      key: { id: string; referenceId: string } | null;
    }>;
  };
}

/** Read-only checks against the key rows, independent of `verifyApiKey`. */
export interface KeyStore {
  /** Whether the row for this plaintext key would let it verify. */
  isUsable(key: string): Promise<boolean>;
  /** Whether the key with this id still belongs to this org and would verify. */
  isLive(principal: Principal): Promise<boolean>;
}

/**
 * Per-tenant key authentication for the hosted RPC server (#341, ADR 0001 §4).
 *
 * `verify` reads `Authorization: Bearer <key>` and verifies the key with the api-key
 * plugin. Keys are org-owned, so the verified key's `referenceId` is the org the
 * connection acts for.
 *
 * `verifyApiKey` reports a backend failure the same way as an unknown key
 * (`valid: false`, `INVALID_API_KEY`): the plugin catches every error, including a
 * timed-out lookup, a locked table and the write it makes on a read-only database.
 * So a refusal is only believed when `store.isUsable(key)`, a read of the key's own
 * row, agrees the key is gone, disabled, expired or used up. For a key whose row is
 * fine this throws, and the server answers 503 rather than telling a valid key it is
 * invalid.
 *
 * `recheck` asks the store by key id only (#342): `verifyApiKey` writes `lastRequest`
 * and spends `remaining` on every call, and a connection need not keep the key.
 */
export function apiKeyAuthenticator(auth: KeyVerifier, store: KeyStore): Authenticator {
  return {
    async verify(authorization) {
      const key = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
      if (!key) return null;
      const result = await auth.api.verifyApiKey({ body: { key } });
      if (result.valid && result.key) {
        return { orgId: result.key.referenceId, keyId: result.key.id };
      }
      if (await store.isUsable(key)) {
        throw new Error('API key verification failed for a usable key');
      }
      return null;
    },
    recheck: (principal) => store.isLive(principal),
  };
}

interface KeyRow {
  enabled: boolean | null;
  expiresAt: Date | null;
  remaining: number | null;
  refillAmount: number | null;
  refillInterval: number | null;
  lastRefillAt: Date | null;
  createdAt: Date;
}

const KEY_COLUMNS = sql.raw(
  'enabled, "expiresAt", remaining, "refillAmount", "refillInterval", "lastRefillAt", "createdAt"',
);

/**
 * The plugin's own conditions for a key row to verify (`validateApiKey`,
 * `consumeRemaining`), read without spending anything: enabled, unexpired, and quota
 * left, where a used-up key with a refill counts once its next refill is due (the
 * plugin refills it on that verification).
 */
function usableRow(row: KeyRow | undefined): boolean {
  if (!row || row.enabled === false) return false;
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return false;
  if (row.remaining !== 0) return true;
  if (!row.refillAmount || !row.refillInterval) return false;
  const lastRefill = (row.lastRefillAt ?? row.createdAt).getTime();
  return Date.now() - lastRefill > row.refillInterval;
}

/** `KeyStore` over the `apikey` table. Plaintext keys are looked up by the plugin's own hash. */
export function postgresKeyStore(db: Kysely<unknown>): KeyStore {
  return {
    async isUsable(key) {
      // ESM-only, like BetterAuth: loaded on use (require(esm)).
      const { defaultKeyHasher } = await import('@better-auth/api-key');
      const hash = await defaultKeyHasher(key);
      const { rows } = await sql<KeyRow>`
        select ${KEY_COLUMNS} from apikey where key = ${hash}`.execute(db);
      return usableRow(rows[0]);
    },
    async isLive({ keyId, orgId }) {
      const { rows } = await sql<KeyRow>`
        select ${KEY_COLUMNS} from apikey
        where id = ${keyId} and "referenceId" = ${orgId}`.execute(db);
      return usableRow(rows[0]);
    },
  };
}

/**
 * The hosted server's authenticator and run history, from the process environment (ADR 0001 §5: no
 * ambient config files). Needs the portal's `BETTER_AUTH_SECRET` and
 * `BETTER_AUTH_URL`, and `DATABASE_URL` or `DATABASE_URL_FILE`.
 *
 * @throws naming what is missing, or when the database does not answer, so
 *   `iris connect` refuses to start rather than serve nothing but 503s
 */
export async function hostedServices(env: NodeJS.ProcessEnv = process.env): Promise<{
  authenticate: Authenticator;
  history: PostgresHistory;
  aiCredentials: (principal: Principal) => Promise<AICredentials | null>;
}> {
  const missing = ['BETTER_AUTH_SECRET', 'BETTER_AUTH_URL'].filter((name) => !env[name]);
  if (missing.length) throw new Error(`Hosted mode needs ${missing.join(' and ')}`);
  // Before the database: without the master key no org's AI key can be opened, and
  // ADR 0001 §5 has hosted mode refuse to start without it.
  const { resolveKeyring } = await import('./byok/crypto');
  const keyring = resolveKeyring(env);
  // Loaded here, not at the top: BetterAuth is ESM-only (require(esm)), and this
  // module is itself only loaded in hosted mode.
  const { createPostgresDb, resolveDatabaseUrl } = await import('./db/postgres');
  const { createAuth } = await import('./auth/config');
  // Bounded: a stalled query would hold an upgrade's connection slot, and stall
  // every later revocation re-check behind it.
  const db = createPostgresDb(resolveDatabaseUrl(env), { queryTimeoutMs: 5_000 });
  const auth = createAuth({
    secret: env.BETTER_AUTH_SECRET!,
    baseURL: env.BETTER_AUTH_URL!,
    database: { db, type: 'postgres' },
    // Verification and reset mail is the portal's job; this process only verifies keys.
    sendEmail: async () => {
      throw new Error('iris connect sends no account mail');
    },
  });
  try {
    await sql`select 1`.execute(db);
  } catch (err) {
    await db.destroy();
    throw new Error(`Cannot reach the database: ${(err as Error).message}`);
  }
  // Run history and the orgs' own AI keys share the pool, and its query timeout.
  const { postgresHistory } = await import('./history-store');
  const { providerKeyStore } = await import('./byok/store');
  const providerKeys = providerKeyStore(db, keyring);
  return {
    authenticate: apiKeyAuthenticator(auth, postgresKeyStore(db)),
    history: postgresHistory(db),
    // BYOK (#344): a tenant's AI runs on the key its org stored, or not at all (#258).
    aiCredentials: (principal) => providerKeys.credentialsFor(principal.orgId),
  };
}

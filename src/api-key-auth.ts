import { sql, type Kysely } from 'kysely';
import type { PostgresHistory, PostgresJobs } from './history-store';
import type { Authenticator, Principal, TenantCredentials } from './protocol';
import { orgSuspensions } from './org-suspension';
import { readSecretEnv } from './secret-env';

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
  /** Whether an operator has suspended the org (#348). */
  isSuspended(orgId: string): Promise<boolean>;
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
 *
 * A valid key of a suspended org (#348) is `'suspended'` on both paths, so the
 * server answers 403 and closes live connections at the next re-check.
 */
export function apiKeyAuthenticator(
  auth: KeyVerifier,
  store: KeyStore,
  /** The org's concurrent-session limit from its plan (#346), carried on the principal. */
  maxSessions?: (orgId: string) => Promise<number>,
): Authenticator {
  return {
    async verify(authorization) {
      const key = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
      if (!key) return null;
      const result = await auth.api.verifyApiKey({ body: { key } });
      if (result.valid && result.key) {
        const orgId = result.key.referenceId;
        if (await store.isSuspended(orgId)) return 'suspended';
        return {
          orgId,
          keyId: result.key.id,
          ...(maxSessions && { maxSessions: await maxSessions(orgId) }),
        };
      }
      if (await store.isUsable(key)) {
        throw new Error('API key verification failed for a usable key');
      }
      return null;
    },
    async recheck(principal) {
      const [live, suspended] = await Promise.all([
        store.isLive(principal),
        store.isSuspended(principal.orgId),
      ]);
      return live && suspended ? 'suspended' : live;
    },
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
    isSuspended: (orgId) => orgSuspensions(db).isSuspended(orgId),
  };
}

/**
 * The hosted server's authenticator and run history, from the process environment (ADR 0001 §5: no
 * ambient config files). Needs the portal's `BETTER_AUTH_SECRET` (or `_FILE`) and
 * `BETTER_AUTH_URL`, and `DATABASE_URL` or `DATABASE_URL_FILE`.
 *
 * @throws naming what is missing, or when the database does not answer, so
 *   `iris connect` refuses to start rather than serve nothing but 503s
 */
export async function hostedServices(env: NodeJS.ProcessEnv = process.env): Promise<{
  authenticate: Authenticator;
  history: PostgresHistory;
  aiCredentials: (principal: Principal) => Promise<TenantCredentials | null>;
  usage: ReturnType<typeof import('./billing/usage').usageLedger>;
  jobs: PostgresJobs;
  entitlements: (orgId: string) => Promise<import('./billing/plans').Entitlements>;
}> {
  const secret = readSecretEnv('BETTER_AUTH_SECRET', env);
  const missing = [
    !secret && 'BETTER_AUTH_SECRET',
    !env.BETTER_AUTH_URL && 'BETTER_AUTH_URL',
  ].filter(Boolean);
  if (missing.length) throw new Error(`Hosted mode needs ${missing.join(' and ')}`);
  // Before the database: without the master key no org's AI key can be opened, and
  // ADR 0001 §5 has hosted mode refuse to start without it.
  const { resolveKeyring } = await import('./byok/crypto');
  const keyring = resolveKeyring(env);
  // IRIS's own vendor key for managed credits (#479): read once, here, never per request.
  const { managedAiResolver, resolveManagedKey } = await import('./billing/managed-ai');
  const managedKey = resolveManagedKey(env);
  // Loaded here, not at the top: BetterAuth is ESM-only (require(esm)), and this
  // module is itself only loaded in hosted mode.
  const { createPostgresDb, probeDatabase, resolveDatabaseUrl } = await import('./db/postgres');
  const { createAuth } = await import('./auth/config');
  // Bounded: a stalled query would hold an upgrade's connection slot, and stall
  // every later revocation re-check behind it.
  const db = createPostgresDb(resolveDatabaseUrl(env), { queryTimeoutMs: 5_000 });
  const auth = createAuth({
    secret: secret!,
    baseURL: env.BETTER_AUTH_URL!,
    database: { db, type: 'postgres' },
    // Verification and reset mail is the portal's job; this process only verifies keys.
    sendEmail: async () => {
      throw new Error('iris connect sends no account mail');
    },
  });
  try {
    await probeDatabase(db as Kysely<unknown>);
  } catch (err) {
    await db.destroy();
    throw err;
  }
  // Run history and the orgs' own AI keys share the pool, and its query timeout.
  const { postgresHistory, postgresJobs } = await import('./history-store');
  const { providerKeyStore } = await import('./byok/store');
  const providerKeys = providerKeyStore(db, keyring);
  const { usageLedger } = await import('./billing/usage');
  const { orgEntitlements } = await import('./billing/plans');
  const entitlements = (orgId: string) => orgEntitlements(db as Kysely<unknown>).get(orgId);
  return {
    authenticate: apiKeyAuthenticator(
      auth,
      postgresKeyStore(db),
      async (orgId) => (await entitlements(orgId)).maxConcurrentSessions,
    ),
    history: postgresHistory(db),
    // BYOK (#344): a tenant's AI runs on the key its org stored, or not at all (#258).
    // Managed credits or the org's own key, per ADR 0001 §6 (#479).
    aiCredentials: managedAiResolver({
      db: db as Kysely<unknown>,
      entitlements,
      providerKeys,
      managedKey,
    }),
    // Billable usage of tenant sessions and AI calls (#263).
    usage: usageLedger(db),
    // The job API (#267): `iris worker` runs what it queues.
    jobs: postgresJobs(db),
    // Plan limits at the API boundary (#346).
    entitlements,
  };
}

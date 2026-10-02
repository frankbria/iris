import { sql, type Kysely } from 'kysely';
import type { Authenticator } from './protocol';

/** The slice of a BetterAuth instance (`createAuth()`) this module uses. */
export interface KeyVerifier {
  api: {
    verifyApiKey(input: { body: { key: string } }): Promise<{
      valid: boolean;
      key: { id: string; referenceId: string } | null;
    }>;
  };
}

/**
 * Per-tenant key authentication for the hosted RPC server (#341, ADR 0001 §4).
 *
 * Reads `Authorization: Bearer <key>` and verifies the key with the api-key plugin.
 * Keys are org-owned, so the verified key's `referenceId` is the org the
 * connection acts for.
 *
 * `verifyApiKey` reports a backend failure the same way as an unknown key
 * (`valid: false`, `INVALID_API_KEY`): the plugin catches every error, including a
 * timed-out lookup, a locked table and the write it makes on a read-only database.
 * So a refusal is only believed when `isUsable(key)`, a read of the key's own row,
 * agrees the key is gone, disabled, expired or used up. For a key whose row is fine
 * this throws, and the server answers 503 (or keeps a live connection) rather than
 * telling a valid key it is invalid.
 */
export function apiKeyAuthenticator(
  auth: KeyVerifier,
  isUsable: (key: string) => Promise<boolean>,
): Authenticator {
  return async (authorization) => {
    const key = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!key) return null;
    const result = await auth.api.verifyApiKey({ body: { key } });
    if (result.valid && result.key) {
      return { orgId: result.key.referenceId, keyId: result.key.id };
    }
    if (await isUsable(key)) throw new Error('API key verification failed for a usable key');
    return null;
  };
}

/**
 * Whether the key's own row would let it verify: present, enabled, not expired and
 * not used up. Read-only, by the plugin's own hash of the key.
 */
export function keyIsUsable(db: Kysely<unknown>): (key: string) => Promise<boolean> {
  return async (key) => {
    // ESM-only, like BetterAuth: loaded on use (require(esm)).
    const { defaultKeyHasher } = await import('@better-auth/api-key');
    const { rows } = await sql<{
      enabled: boolean | null;
      expiresAt: Date | null;
      remaining: number | null;
    }>`select enabled, "expiresAt", remaining from apikey where key = ${await defaultKeyHasher(key)}`.execute(
      db,
    );
    const row = rows[0];
    return (
      !!row &&
      row.enabled !== false &&
      (!row.expiresAt || row.expiresAt.getTime() > Date.now()) &&
      row.remaining !== 0
    );
  };
}

/**
 * The hosted server's authenticator, from the process environment (ADR 0001 §5: no
 * ambient config files). Needs the portal's `BETTER_AUTH_SECRET` and
 * `BETTER_AUTH_URL`, and `DATABASE_URL` or `DATABASE_URL_FILE`.
 *
 * @throws naming what is missing, or when the database does not answer, so
 *   `iris connect` refuses to start rather than serve nothing but 503s
 */
export async function hostedAuthenticator(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Authenticator> {
  const missing = ['BETTER_AUTH_SECRET', 'BETTER_AUTH_URL'].filter((name) => !env[name]);
  if (missing.length) throw new Error(`Hosted mode needs ${missing.join(' and ')}`);
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
  return apiKeyAuthenticator(auth, keyIsUsable(db));
}

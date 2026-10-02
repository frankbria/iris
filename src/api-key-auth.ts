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
 * `verifyApiKey` reports a database failure the same way as an unknown key
 * (`valid: false`, `INVALID_API_KEY`): the plugin catches every error. So a refusal
 * is only trusted when it repeats after `reachable()` shows the key store answering:
 * the first lookup may have timed out on a database that has since come back.
 * Otherwise this throws, and the server answers 503 rather than telling a valid key
 * it is invalid, or dropping every live connection during a database restart.
 *
 * ponytail: the store can still fail again between the probe and the second lookup;
 * a read-only check by key id would close that window (see #342).
 */
export function apiKeyAuthenticator(
  auth: KeyVerifier,
  reachable: () => Promise<unknown>,
): Authenticator {
  return async (authorization) => {
    const key = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!key) return null;
    const verify = async () => {
      const result = await auth.api.verifyApiKey({ body: { key } });
      return result.valid && result.key
        ? { orgId: result.key.referenceId, keyId: result.key.id }
        : null;
    };
    const first = await verify();
    if (first) return first;
    await reachable();
    return verify();
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
  // Loaded here, not at the top: BetterAuth and Kysely are ESM-only (require(esm)),
  // and local mode never needs them.
  const { createPostgresDb, resolveDatabaseUrl } = await import('./db/postgres');
  const { createAuth } = await import('./auth/config');
  const { sql } = await import('kysely');
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
  const reachable = () => sql`select 1`.execute(db);
  try {
    await reachable();
  } catch (err) {
    await db.destroy();
    throw new Error(`Cannot reach the database: ${(err as Error).message}`);
  }
  return apiKeyAuthenticator(auth, reachable);
}

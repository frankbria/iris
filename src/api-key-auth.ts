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
 * is only trusted once `reachable()` shows the key store answering. Otherwise this
 * throws, and the server answers 503 rather than telling a valid key it is invalid,
 * or dropping every live connection during a database restart.
 */
export function apiKeyAuthenticator(
  auth: KeyVerifier,
  reachable: () => Promise<unknown>,
): Authenticator {
  return async (authorization) => {
    const key = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!key) return null;
    const result = await auth.api.verifyApiKey({ body: { key } });
    if (result.valid && result.key) {
      return { orgId: result.key.referenceId, keyId: result.key.id };
    }
    await reachable();
    return null;
  };
}

/**
 * The hosted server's authenticator, from the process environment (ADR 0001 §5: no
 * ambient config files). Needs the portal's `BETTER_AUTH_SECRET` and
 * `BETTER_AUTH_URL`, and `DATABASE_URL` or `DATABASE_URL_FILE`.
 *
 * @throws naming what is missing, so `iris connect` refuses to start
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
  const db = createPostgresDb(resolveDatabaseUrl(env));
  const auth = createAuth({
    secret: env.BETTER_AUTH_SECRET!,
    baseURL: env.BETTER_AUTH_URL!,
    database: { db, type: 'postgres' },
    // Verification and reset mail is the portal's job; this process only verifies keys.
    sendEmail: async () => {
      throw new Error('iris connect sends no account mail');
    },
  });
  return apiKeyAuthenticator(auth, () => sql`select 1`.execute(db));
}

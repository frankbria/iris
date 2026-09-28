import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { organization } from 'better-auth/plugins';

/**
 * The one BetterAuth configuration shared by `apps/portal` and `iris-api`
 * (ADR 0001 §4), so neither owns a second user table.
 *
 * The plugin set lives here because both sides must agree on it; the caller
 * supplies what differs per process (secret, base URL, database).
 *
 * `better-auth` is ESM-only. This CommonJS build loads it through Node's
 * `require(esm)`, which the `engines` floor enables by default. Jest's sandboxed
 * `require` does not implement that, so the test spawns a real Node process.
 */
export function createAuth(options: Omit<BetterAuthOptions, 'plugins'> = {}) {
  return betterAuth({ ...options, plugins: [organization()] });
}

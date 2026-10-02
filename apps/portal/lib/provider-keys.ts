// Holds the master keyring: a client import must fail the build, not ship it.
import "server-only"

import { resolveKeyring } from "../../../src/byok/crypto"
import { providerKeyStore } from "../../../src/byok/store"
import { createPostgresDb, resolveDatabaseUrl } from "../../../src/db/postgres"

let store: ReturnType<typeof providerKeyStore> | undefined

/**
 * The orgs' own AI provider keys (BYOK, #344), sealed with the master key from
 * `IRIS_KEY_ENCRYPTION_KEY` / `IRIS_KEY_ENCRYPTION_KEY_FILE`, the same one `iris
 * connect` opens them with. Built on first use, like `getAuth()`, so `next build`
 * needs no secrets. Server code only: it holds the master key.
 */
export function getProviderKeys() {
  store ??= providerKeyStore(
    // Bounded, as for iris connect (#341): a stalled query must not hang a page.
    createPostgresDb(resolveDatabaseUrl(), { queryTimeoutMs: 5_000 }),
    resolveKeyring()
  )
  return store
}

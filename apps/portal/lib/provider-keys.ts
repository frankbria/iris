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
    createPostgresDb(resolveDatabaseUrl()),
    resolveKeyring()
  )
  return store
}

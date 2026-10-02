import { createPostgresDb, resolveDatabaseUrl } from '../db/postgres';
import { resolveKeyring } from './crypto';
import { providerKeyStore } from './store';

// The process entry runs only as a spawned `node`, which Jest cannot instrument; the
// work is `providerKeyStore().rewrapAll()`, tested against real Postgres.
/* istanbul ignore next */
/**
 * `node dist/byok/rewrap.js`: after listing a new master key first in
 * `IRIS_KEY_ENCRYPTION_KEY(_FILE)`, re-seal every stored provider key under it. Then
 * the old key can be removed. Exits 1 on failure.
 */
async function main(): Promise<void> {
  const keyring = resolveKeyring();
  const db = createPostgresDb(resolveDatabaseUrl());
  try {
    const count = await providerKeyStore(db, keyring).rewrapAll();
    console.log(`re-sealed ${count} provider key(s) under master key ${keyring.current.id}`);
  } finally {
    await db.destroy();
  }
}

/* istanbul ignore next */
if (require.main === module) {
  main().catch((err) => {
    // The message only: an inspected error can carry the database URL.
    console.error('rewrap failed:', (err as Error)?.message || String(err));
    process.exit(1);
  });
}

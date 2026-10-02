import type { Kysely } from 'kysely';
import { type MigrationResult, Migrator } from 'kysely/migration';
import * as initial from './migrations/0001_initial';
import * as history from './migrations/0002_history';
import * as usage from './migrations/0003_usage';
import * as jobs from './migrations/0004_jobs';
import { createPostgresDb, resolveDatabaseUrl } from './postgres';

/**
 * Every migration, keyed by name. The Migrator applies them in name order, so
 * name a new one `NNNN_<what>` and add it here. A static map rather than a
 * directory scan: it resolves the same under ts-node, `dist/` and the image.
 */
const MIGRATIONS = {
  '0001_initial': initial,
  '0002_history': history,
  '0003_usage': usage,
  '0004_jobs': jobs,
};

/**
 * Applies every pending migration (ADR 0001 §2, #248). Idempotent: applied names
 * are recorded in `kysely_migration`, and the Migrator holds a lock, so two
 * concurrent runs cannot both apply one. On Postgres the pending batch runs in
 * one transaction, so a failure applies none of it.
 *
 * @returns the migrations this call applied (empty when already current)
 * @throws the first migration's error, after its transaction rolled back
 */
export async function migrateToLatest(db: Kysely<unknown>): Promise<MigrationResult[]> {
  const migrator = new Migrator({ db, provider: { getMigrations: async () => MIGRATIONS } });
  const { error, results = [] } = await migrator.migrateToLatest();
  if (error) throw error;
  return results;
}

// The process entry below runs only as a spawned `node`, which Jest cannot
// instrument; __tests__/db/postgres.test.ts spawns it (current, bad password,
// silent server). Same exemption as src/mcp/server.ts.
/* istanbul ignore next */
/**
 * `node dist/db/migrate.js` (or `npm run db:migrate`): the deploy step. Runs as
 * its own process, never at server boot (ADR 0001 §2). Exits 1 on failure.
 */
async function main(): Promise<void> {
  const db = createPostgresDb(resolveDatabaseUrl());
  try {
    const results = await migrateToLatest(db);
    for (const r of results) console.log(`applied ${r.migrationName}`);
    console.log('database schema up to date');
  } finally {
    await db.destroy();
  }
}

/* istanbul ignore next */
if (require.main === module) {
  main().catch((err) => {
    // Message or code only: an inspected error can carry the URL, password included.
    // A refused connection is an AggregateError whose message is empty.
    const e = err as { message?: string; code?: string };
    console.error('migration failed:', e?.message || e?.code || String(err));
    process.exit(1);
  });
}

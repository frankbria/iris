import type { Kysely } from 'kysely';
import { type MigrationResult, Migrator } from 'kysely/migration';
import * as initial from './migrations/0001_initial';
import { createPostgresDb, resolveDatabaseUrl } from './postgres';

/**
 * Every migration, keyed by name. The Migrator applies them in name order, so
 * name a new one `NNNN_<what>` and add it here. A static map rather than a
 * directory scan: it resolves the same under ts-node, `dist/` and the image.
 */
const MIGRATIONS = { '0001_initial': initial };

/**
 * Applies every pending migration (ADR 0001 §2, #248). Idempotent: applied names
 * are recorded in `kysely_migration`, and the Migrator holds a lock, so two
 * concurrent runs cannot both apply one. On Postgres each migration runs in a
 * transaction, so a failed one leaves nothing half-applied.
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

if (require.main === module) {
  main().catch((err) => {
    console.error('migration failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}

import { sql, type Kysely } from 'kysely';
import { type MigrationResult, Migrator } from 'kysely/migration';
import * as initial from './migrations/0001_initial';
import * as history from './migrations/0002_history';
import * as usage from './migrations/0003_usage';
import * as jobs from './migrations/0004_jobs';
import * as jobClaims from './migrations/0005_job_claims';
import * as terms from './migrations/0006_terms_acceptances';
import * as suspensions from './migrations/0007_org_suspensions';
import * as runsFinished from './migrations/0008_runs_finished_idx';
import * as orgPlans from './migrations/0009_org_plans';
import * as offboarding from './migrations/0010_offboarding';
import * as visualBaselines from './migrations/0011_visual_baselines';
import * as artifactPurges from './migrations/0012_artifact_purges';
import { createPostgresDb, resolveDatabaseUrl } from './postgres';

/**
 * Every migration, keyed by name. The Migrator applies them in name order, so
 * name a new one `NNNN_<what>` and add it here. A static map rather than a
 * directory scan: it resolves the same under ts-node, `dist/` and the image.
 */
export const MIGRATIONS = {
  '0001_initial': initial,
  '0002_history': history,
  '0003_usage': usage,
  '0004_jobs': jobs,
  '0005_job_claims': jobClaims,
  '0006_terms_acceptances': terms,
  '0007_org_suspensions': suspensions,
  '0008_runs_finished_idx': runsFinished,
  '0009_org_plans': orgPlans,
  '0010_offboarding': offboarding,
  '0011_visual_baselines': visualBaselines,
  '0012_artifact_purges': artifactPurges,
};

/**
 * Applies every pending migration (ADR 0001 §2, #248). Idempotent: applied names
 * are recorded in `kysely_migration`, and the Migrator holds a lock, so two
 * concurrent runs cannot both apply one. On Postgres the pending batch runs in
 * one transaction, so a failure applies none of it.
 *
 * A database ahead of this release (#273): a rollback deploys an older image whose
 * catalog lacks migrations a newer release applied, and Kysely refuses that as
 * "corrupted migrations". When every migration this release knows is applied, that
 * is the expected state of a rollback (expand/contract keeps the old code working on
 * the new schema): nothing to apply. When this release also has unapplied ones, it
 * branched off before the newer release, and interleaving them is not safe: refuse.
 *
 * @param migrations the catalog; the default is this release's
 * @returns the migrations this call applied (empty when already current, or ahead)
 * @throws the first migration's error, after its transaction rolled back; or when
 *   the database is ahead of this release and this release still has pending ones
 */
export async function migrateToLatest(
  db: Kysely<unknown>,
  migrations: Record<string, (typeof MIGRATIONS)[keyof typeof MIGRATIONS]> = MIGRATIONS,
): Promise<MigrationResult[]> {
  const executed = await executedMigrations(db);
  const newer = executed.filter((name) => !(name in migrations));
  if (newer.length) {
    const pending = Object.keys(migrations).filter((name) => !executed.includes(name));
    if (pending.length) {
      throw new Error(
        `The database has migrations this release does not know (${newer.join(', ')}) ` +
          `and this release has unapplied ones (${pending.join(', ')}): it branched off ` +
          'before a newer release. Deploy a release that contains both.',
      );
    }
    console.log(
      `schema is ahead of this release (newer migrations: ${newer.join(', ')}); nothing to apply`,
    );
    return [];
  }
  const migrator = new Migrator({ db, provider: { getMigrations: async () => migrations } });
  const { error, results = [] } = await migrator.migrateToLatest();
  if (error) throw error;
  return results;
}

/** Names recorded in `kysely_migration`; none before the first migration. */
async function executedMigrations(db: Kysely<unknown>): Promise<string[]> {
  const { rows } = await sql<{ name: string }>`select name from kysely_migration`
    .execute(db)
    .catch((err: { code?: string }) => {
      // 42P01: the table does not exist yet (a fresh database).
      if (err.code === '42P01') return { rows: [] as { name: string }[] };
      throw err;
    });
  return rows.map((r) => r.name);
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

import { type Kysely, sql } from 'kysely';

/**
 * A purged org's object prefix is swept once more a day after the purge (#476): a visual job
 * already running at the purge can still write images. Expand-only: the previous release
 * never reads the column.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table org_deletions add column resweep_done boolean not null default false`.execute(
    db,
  );
}

import { type Kysely, sql } from 'kysely';

/**
 * Artifact storage per org (#315): one row per object an org stored, with its size, so the
 * plan's `artifactStorageBytes` can be enforced and shown. Written beside each put, removed
 * with the objects (offboarding's purge queue, #472). Objects stored before this migration
 * have no row and are not counted.
 */
const STATEMENTS = [
  // Cascade: the 7-year tombstone deletion removes the org row, and accounting rows of a
  // purge that is still pending must not block it (codex review).
  `create table artifact_objects (
     org_id text not null references organization (id) on delete cascade,
     key text not null,
     bytes bigint not null check (bytes >= 0),
     created_at timestamptz not null default now(),
     primary key (org_id, key)
   )`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
}

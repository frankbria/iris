import { type Kysely, sql } from 'kysely';

/**
 * Artifact prefixes waiting to be deleted from object storage (#472). The retention pass
 * (#349) deletes rows and object storage is not transactional with them, so a prefix is
 * queued here in the same transaction that deletes its rows, and removed only once its
 * objects are gone: a store failure is retried by the next pass, never forgotten. No
 * foreign key: an entry may outlive the org's tombstone.
 */
const STATEMENTS = [
  `create table artifact_purges (
     id bigserial primary key,
     org_id text not null,
     prefix text not null,
     created_at timestamptz not null default now()
   )`,
  `create index artifact_purges_org_idx on artifact_purges (org_id, id)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
}

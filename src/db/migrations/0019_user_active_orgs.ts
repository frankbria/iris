import { type Kysely, sql } from 'kysely';

/**
 * The org each user last made active (#409), so a new session starts there instead of in an
 * arbitrary membership. One row per user, replaced on every switch; read only while the user
 * is still a member. Sessions cannot hold it: sign-out deletes the session row.
 */
const STATEMENTS = [
  `create table user_active_orgs (
     user_id text primary key references "user" (id) on delete cascade,
     org_id text not null references organization (id) on delete cascade,
     updated_at timestamptz not null default now()
   )`,
  `create index user_active_orgs_org_idx on user_active_orgs (org_id)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
}

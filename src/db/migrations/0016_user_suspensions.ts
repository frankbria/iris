import { type Kysely, sql } from 'kysely';

/**
 * User bans (#457): an append-only history of operator ban / unban actions, as
 * `org_suspensions` (0007) is for orgs, with the same `suspend` / `unsuspend` actions.
 * Person-scoped, so no `org_id`; deleting the user deletes their history.
 */
const STATEMENTS = [
  `create table user_suspensions (
     id uuid primary key default gen_random_uuid(),
     user_id text not null references "user" (id) on delete cascade,
     action text not null check (action in ('suspend', 'unsuspend')),
     reason text not null,
     actor text not null,
     created_at timestamptz not null default now()
   )`,
  `create index user_suspensions_user_idx on user_suspensions (user_id, created_at desc)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
}

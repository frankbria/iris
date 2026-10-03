import { type Kysely, sql } from 'kysely';

/**
 * Org suspensions (#348): an append-only history of operator suspend / unsuspend
 * actions. An org's current state is its latest row's `action`; no rows means active.
 * A table of its own rather than a column on BetterAuth's `organization`, so the
 * auth schema is untouched and every action keeps its actor, reason and time.
 * No cascade: org deletion is disabled until offboarding (#349).
 */
const STATEMENTS = [
  `create table org_suspensions (
     id uuid primary key default gen_random_uuid(),
     org_id text not null references organization (id),
     action text not null check (action in ('suspend', 'unsuspend')),
     reason text not null,
     actor text not null,
     created_at timestamptz not null default now()
   )`,
  `create index org_suspensions_org_idx on org_suspensions (org_id, created_at desc)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
}

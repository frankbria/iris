import { type Kysely, sql } from 'kysely';

/**
 * Org plans (#260): which code-defined plan an org is on, and per-org overrides (a
 * support grant). No row means the default (free) plan. No check on `plan`: plans are
 * defined in src/billing/plans.ts, and an id the code does not know resolves to free,
 * so adding a plan needs no migration. No cascade: org deletion is disabled until
 * offboarding (#349).
 */
const STATEMENTS = [
  `create table org_plans (
     org_id text primary key references organization (id),
     plan text not null,
     overrides jsonb not null default '{}'::jsonb,
     updated_at timestamptz not null default now()
   )`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
}

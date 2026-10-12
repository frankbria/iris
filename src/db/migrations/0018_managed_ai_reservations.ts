import { type Kysely, sql } from 'kysely';

/**
 * Managed AI credit reserved before a call (#482): one row per managed call in flight, at its
 * worst-case cost, deleted when the call is over (its settled cost is then in
 * `usage_events`). Admission counts spend plus live reservations, so parallel calls cannot
 * overshoot an org's credit. A row left by a crash stops counting after a short window.
 */
const STATEMENTS = [
  `create table managed_ai_reservations (
     id uuid primary key default gen_random_uuid(),
     org_id text not null references organization (id) on delete cascade,
     amount_usd numeric not null check (amount_usd >= 0),
     created_at timestamptz not null default now()
   )`,
  `create index managed_ai_reservations_org_idx on managed_ai_reservations (org_id, created_at)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
}

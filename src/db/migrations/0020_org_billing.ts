import { type Kysely, sql } from 'kysely';

/**
 * Stripe billing (#261, #345, ADR 0001 §6). `org_billing` is one Stripe customer per org
 * and its current subscription as the verified webhook last read it from Stripe. `stripe_events`
 * holds every processed event id: a redelivery conflicts and has no effect. The plan
 * itself stays in `org_plans`. Both cascade from the org: the 7-year tombstone pass
 * deletes the org row last.
 */
const STATEMENTS = [
  `create table org_billing (
     org_id text primary key references organization (id) on delete cascade,
     stripe_customer_id text not null unique,
     stripe_subscription_id text,
     subscription_status text,
     updated_at timestamptz not null default now()
   )`,
  `create table stripe_events (
     event_id text primary key,
     org_id text not null references organization (id) on delete cascade,
     type text not null,
     processed_at timestamptz not null default now()
   )`,
  `create index stripe_events_org_idx on stripe_events (org_id, processed_at)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
}

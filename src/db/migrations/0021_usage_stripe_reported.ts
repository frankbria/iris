import { type Kysely, sql } from 'kysely';

/**
 * Stripe meter reporting (#264): when a managed usage row was sent to the Stripe meter.
 * Null is not yet sent; only managed rows are ever sent. The first partial index is the
 * reporter's work list, so a pass does not scan the ledger; the second serves the
 * reconciliation report's period scan across orgs.
 */
const STATEMENTS = [
  // An exclusive lock on a table every request writes: fail fast behind a long
  // transaction instead of queueing every writer behind this, as 0005 does (#273).
  `set local lock_timeout = '5s'`,
  `alter table usage_events add column stripe_reported_at timestamptz`,
  `create index usage_events_stripe_unreported_idx on usage_events (id)
     where billing_mode = 'managed' and stripe_reported_at is null`,
  `create index usage_events_managed_created_at_idx on usage_events (created_at)
     where billing_mode = 'managed'`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
}

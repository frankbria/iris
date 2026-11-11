import { type Kysely, sql } from 'kysely';

/**
 * Stripe meter reporting (#264): when a managed usage row was sent to the Stripe meter.
 * Null is not yet sent; only managed rows are ever sent. The partial index is the
 * reporter's work list, so a pass does not scan the ledger.
 */
const STATEMENTS = [
  `alter table usage_events add column stripe_reported_at timestamptz`,
  `create index usage_events_stripe_unreported_idx on usage_events (id)
     where billing_mode = 'managed' and stripe_reported_at is null`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
}

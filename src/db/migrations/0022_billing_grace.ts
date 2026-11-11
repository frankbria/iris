import { type Kysely, sql } from 'kysely';

/**
 * Payment failure (#266). `payment_grace_ends_at` is set when the webhook first reads a
 * failed payment and cleared when it is settled; `payment_suspended_at` records that the
 * sweep suspended the org for it, so each failure suspends once. Both nullable: the
 * previous release neither reads nor writes them.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table org_billing
    add column payment_grace_ends_at timestamptz,
    add column payment_suspended_at timestamptz`.execute(db);
}

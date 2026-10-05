import { type Kysely, sql } from 'kysely';

/**
 * Offboarding and retention (#349; owner decisions 2026-10-03).
 *
 * - `org_deletions`: a soft delete. The org is suspended at once and purged after
 *   `purge_after` (30 days) unless restored; `purged_at` marks the tombstone, whose
 *   billing records are kept for 7 years.
 * - `terms_acceptances` evidence survives the user, pseudonymised: the FK now sets
 *   `user_id` null, and a `before delete` trigger on "user" first stores a SHA-256 of the
 *   id and the time, whatever deletes the user (BetterAuth, the operator CLI, SQL).
 *
 * Expand-only: the previous release keeps inserting `user_id` and never reads the new
 * columns or table.
 */
const STATEMENTS = [
  `create table org_deletions (
     org_id text primary key references organization (id),
     requested_at timestamptz not null default now(),
     requested_by text not null,
     reason text not null,
     purge_after timestamptz not null,
     purged_at timestamptz
   )`,
  `alter table terms_acceptances
     alter column user_id drop not null,
     add column user_hash text,
     add column pseudonymised_at timestamptz`,
  `alter table terms_acceptances drop constraint terms_acceptances_user_id_fkey`,
  `alter table terms_acceptances add constraint terms_acceptances_user_id_fkey
     foreign key (user_id) references "user" (id) on delete set null`,
  `create index terms_acceptances_pseudonymised_idx on terms_acceptances (pseudonymised_at)
     where pseudonymised_at is not null`,
  `create function iris_pseudonymise_terms() returns trigger language plpgsql as $$
   begin
     update terms_acceptances
        set user_hash = encode(sha256(convert_to(old.id, 'UTF8')), 'hex'),
            pseudonymised_at = now()
      where user_id = old.id;
     return old;
   end $$`,
  `create trigger user_pseudonymise_terms before delete on "user"
     for each row execute function iris_pseudonymise_terms()`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
}

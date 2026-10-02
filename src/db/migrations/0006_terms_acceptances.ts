import { type Kysely, sql } from 'kysely';

/**
 * Acceptance of the Terms of Service and Acceptable Use Policy (#276): one row per user,
 * document and version, so the history survives a new version. The one IRIS table with
 * no `org_id`: acceptance belongs to the person, who may belong to several orgs (the
 * catalog test lists the exemption). Deleting a user deletes their rows.
 */
const STATEMENTS = [
  `create table terms_acceptances (
     id uuid primary key default gen_random_uuid(),
     user_id text not null references "user" (id) on delete cascade,
     document text not null check (document in ('terms', 'acceptable-use')),
     version text not null,
     accepted_at timestamptz not null default now(),
     ip text,
     unique (user_id, document, version)
   )`,
  `create index terms_acceptances_user_idx on terms_acceptances (user_id)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
}

import { type Kysely, sql } from 'kysely';

/**
 * Each org's AI mode (#479, ADR 0001 §6): `byok` (its own provider key) or `managed`
 * (IRIS's key, paid from the plan's monthly credit). No row means `byok`, so no org is
 * billed for AI it did not choose.
 */
const STATEMENTS = [
  `create table org_ai_settings (
     org_id text primary key references organization (id) on delete cascade,
     mode text not null check (mode in ('byok', 'managed')),
     updated_by text,
     updated_at timestamptz not null default now()
   )`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
}

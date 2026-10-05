import { type Kysely, sql } from 'kysely';

/**
 * Hosted visual baselines (#268, ADR 0001 §3): a project's approved screenshot per page
 * and device. `name` is `artifactName(page, device)`; `object_key` is where the image is
 * (`baselineKey()`). `run_id` is the run the image came from; runs are pruned after 90
 * days (#349), so it is set null rather than blocking that. `approved_by` is the API key
 * that approved it, or `first-run` for a project's first screenshot of the page.
 */
const STATEMENTS = [
  `create table visual_baselines (
     -- Cascade: a rollback to a release without this table in its purge must not have
     -- its org purge refused by these rows (expand/contract, #273).
     org_id text not null references organization (id) on delete cascade,
     project text not null,
     name text not null,
     page text not null,
     device text not null,
     object_key text not null,
     run_id uuid,
     approved_by text not null,
     updated_at timestamptz not null default now(),
     primary key (org_id, project, name),
     foreign key (org_id, run_id) references runs (org_id, id) on delete set null (run_id)
   )`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
}

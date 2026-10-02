import { type Kysely, sql } from 'kysely';

/**
 * Run history for the hosted service (#254): RPC runs join a11y and visual, each
 * run says what it was (`summary`) and which API key started it (`api_key_id`),
 * its results keep their order (`position`), and the org's run list has the index
 * it reads by.
 *
 * `api_key_id` is checked against the key's own org: `apikey` is org-owned
 * (`referenceId` is the org id), so `(org_id, api_key_id)` must name a key of the
 * same org, and a run in org A cannot record org B's key. Deleting the key clears
 * only `api_key_id` (Postgres 15+ column list); the run stays with its org.
 */
const STATEMENTS = [
  `alter table runs drop constraint runs_kind_check`,
  `alter table runs add constraint runs_kind_check check (kind in ('a11y', 'visual', 'rpc'))`,
  `alter table runs add column summary text`,
  `alter table runs add column api_key_id text`,
  `alter table apikey add constraint apikey_referenceId_id_key unique ("referenceId", id)`,
  `alter table runs add constraint runs_org_id_api_key_id_fkey
    foreign key (org_id, api_key_id) references apikey ("referenceId", id)
    on delete set null (api_key_id)`,
  `create index runs_org_id_created_at_idx on runs (org_id, created_at)`,
  // Deleting a key looks up its runs (the foreign key above); without this, every
  // revoke would scan the org's whole history.
  `create index runs_org_id_api_key_id_idx on runs (org_id, api_key_id)`,
  // A run's results in the order they happened: rows written in one transaction
  // share created_at, and ids are random.
  `alter table run_results add column position integer not null default 0`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
}

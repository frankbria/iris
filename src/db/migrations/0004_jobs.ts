import { type Kysely, sql } from 'kysely';

/**
 * Queued work (#267, ADR 0001 §1): a job is a `runs` row that starts `queued`, with
 * the request's parameters, and a worker claims it. `error` says why a job failed
 * (a finished run has no results to say it). The index serves the claim, which looks
 * across every org for the oldest queued row of a kind.
 */
const STATEMENTS = [
  `alter table runs add column params jsonb`,
  `alter table runs add column error text`,
  `create index runs_claim_idx on runs (kind, status, created_at)`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
}

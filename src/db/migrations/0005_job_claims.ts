import { type Kysely, sql } from 'kysely';

/**
 * Job claims (#435): a worker that dies leaves its job `running` for good. Each claim
 * now carries a token (so only the holder may write the outcome), a heartbeat (so a
 * dead worker is noticed) and an attempt count (so a poison job is not retried forever).
 * The partial index serves the reaper's scan of running rows.
 */
const STATEMENTS = [
  `alter table runs add column attempts int not null default 0`,
  `alter table runs add column claim_token uuid`,
  `alter table runs add column heartbeat_at timestamptz`,
  `create index runs_running_heartbeat_idx on runs (heartbeat_at) where status = 'running'`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
}

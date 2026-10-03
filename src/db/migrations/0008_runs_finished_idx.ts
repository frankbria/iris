import { type Kysely, sql } from 'kysely';

/**
 * The results API (#269) lists an org's finished runs newest first by finish time and
 * pages on (finished_at, id). This index serves that scan; the (org_id, created_at)
 * index serves the job queue and history reads by creation.
 */
const STATEMENTS = [
  // An index build locks `runs` while the old release still serves it: fail fast rather
  // than queue every query behind a long transaction (#273, as in 0005).
  `set local lock_timeout = '5s'`,
  `create index runs_org_finished_idx on runs (org_id, finished_at desc, id desc)
     where finished_at is not null`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
}

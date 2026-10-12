import { type Kysely, sql } from 'kysely';

/**
 * `observation` usage (#312): each RPC `observe` call (a screenshot and a page snapshot)
 * is metered, as platform usage priced by the plan (no billing mode, no unit cost). Both
 * kind checks only widen, so the previous release keeps working on this schema (#273).
 */
const STATEMENTS = [
  // The constraint swap takes an exclusive lock on usage_events: fail fast rather than
  // queue every usage write behind a long transaction (as 0005 does for runs).
  `set local lock_timeout = '5s'`,
  `alter table usage_events drop constraint usage_events_kind_check`,
  `alter table usage_events add constraint usage_events_kind_check check (kind in
    ('browser_minutes', 'text_call', 'vision_call', 'agent_turn', 'a11y_job', 'visual_job',
     'observation'))`,
  `alter table usage_events drop constraint usage_events_billing_mode_by_kind_check`,
  `alter table usage_events add constraint usage_events_billing_mode_by_kind_check check (
    (kind in ('browser_minutes', 'a11y_job', 'visual_job', 'observation')) = (billing_mode is null))`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
}

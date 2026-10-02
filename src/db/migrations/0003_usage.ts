import { type Kysely, sql } from 'kysely';

/**
 * The billable usage ledger (#263): job kinds join the AI and browser kinds, an AI
 * call carries its unit cost (null for platform usage, which the plan prices, #260),
 * and whether that cost is estimated (#243: no exact price row for the model).
 * `billing_mode` (whose key paid the provider) is required on AI usage and absent on
 * platform usage, where it means nothing.
 */
const STATEMENTS = [
  `alter table usage_events drop constraint usage_events_kind_check`,
  `alter table usage_events add constraint usage_events_kind_check check (kind in
    ('browser_minutes', 'text_call', 'vision_call', 'agent_turn', 'a11y_job', 'visual_job'))`,
  `alter table usage_events add column unit_cost_usd numeric check (unit_cost_usd >= 0)`,
  `alter table usage_events add column estimated boolean not null default false`,
  `alter table usage_events alter column billing_mode drop not null`,
  `alter table usage_events add constraint usage_events_billing_mode_check2 check (
    (kind in ('browser_minutes', 'a11y_job', 'visual_job')) = (billing_mode is null))`,
];

export async function up(db: Kysely<unknown>): Promise<void> {
  for (const statement of STATEMENTS) await sql.raw(statement).execute(db);
}

import { sql, type Kysely } from 'kysely';

/**
 * Billable usage (#263, ADR 0001 §6): `usage_events` in Postgres is the system of
 * record that Stripe is fed from (#264). Every row names its org, and its
 * idempotency key is unique per org, so a retried write is a no-op, not a second
 * charge.
 */

export type UsageKind =
  'browser_minutes' | 'text_call' | 'vision_call' | 'agent_turn' | 'a11y_job' | 'visual_job';

export interface UsageEvent {
  kind: UsageKind;
  quantity: number;
  /**
   * Whose key paid the AI provider: the org's (`byok`, #344) or IRIS's (`managed`,
   * #346). AI usage only: platform usage (minutes, jobs) has none, and the database
   * refuses one there.
   */
  billingMode?: 'byok' | 'managed';
  /** Unique per org: a retry with the same key records nothing new. */
  idempotencyKey: string;
  /** What one unit cost IRIS at the provider. Omitted for platform usage (minutes, jobs). */
  unitCostUsd?: number;
  /** The cost is the estimated rate for an unpriced model (#243). */
  estimated?: boolean;
  /** The run it belongs to, if any; checked against the org by a foreign key. */
  runId?: string;
  at?: Date;
}

export interface UsageSummaryRow {
  kind: UsageKind;
  billingMode: 'byok' | 'managed' | null;
  quantity: number;
  costUsd: number;
  /** The part of `costUsd` that came from estimated rates. */
  estimatedCostUsd: number;
}

/**
 * Insert usage rows through `executor`: the database, or the transaction of the work
 * they meter (the history store records a job's run and usage together).
 */
export async function insertUsage(
  executor: Kysely<unknown>,
  orgId: string,
  events: UsageEvent[],
): Promise<void> {
  if (!events.length) return;
  const values = events.map(
    (e) =>
      sql`(${orgId}, ${e.runId ?? null}, ${e.kind}, ${e.quantity}, ${e.billingMode ?? null},
           ${e.idempotencyKey}, ${e.unitCostUsd ?? null}, ${e.estimated ?? false},
           ${e.at ?? new Date()})`,
  );
  await sql`
    insert into usage_events
      (org_id, run_id, kind, quantity, billing_mode, idempotency_key, unit_cost_usd, estimated, created_at)
    values ${sql.join(values)}
    on conflict (org_id, idempotency_key) do nothing`.execute(executor);
}

export function usageLedger(db: Kysely<unknown>) {
  return {
    record: (orgId: string, events: UsageEvent[]) => insertUsage(db, orgId, events),

    /**
     * An org's usage in `[from, to)`: quantity and provider cost per kind and billing
     * mode, with the estimated part of the cost apart (#243), for invoicing (#264) and
     * the portal's usage page (#271).
     */
    async summary(orgId: string, from: Date, to: Date): Promise<UsageSummaryRow[]> {
      const { rows } = await sql<{
        kind: UsageKind;
        billing_mode: 'byok' | 'managed' | null;
        quantity: string;
        cost: string;
        estimated_cost: string;
      }>`
        select kind, billing_mode,
               sum(quantity) as quantity,
               coalesce(sum(quantity * unit_cost_usd), 0) as cost,
               coalesce(sum(quantity * unit_cost_usd) filter (where estimated), 0) as estimated_cost
        from usage_events
        where org_id = ${orgId} and created_at >= ${from} and created_at < ${to}
        group by kind, billing_mode
        order by kind, billing_mode nulls first`.execute(db);
      return rows.map((r) => ({
        kind: r.kind,
        billingMode: r.billing_mode,
        quantity: Number(r.quantity),
        costUsd: Number(r.cost),
        estimatedCostUsd: Number(r.estimated_cost),
      }));
    },
  };
}

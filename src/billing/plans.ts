import { sql, type Kysely } from 'kysely';

/**
 * The plan catalog and org entitlements (#260). Plans are code-defined; an org's row in
 * `org_plans` names its plan and may carry per-org overrides (a support grant). The
 * limits are the owner-approved launch values (2026-10-03). Prices live on the Stripe
 * products (#261), and enforcement at the API is #346.
 */

export type PlanId = 'free' | 'pro' | 'team';

export interface PlanLimits {
  maxConcurrentSessions: number;
  runsPerMonth: number;
  agentTurnsPerMonth: number;
  visionCallsPerMonth: number;
  artifactStorageBytes: number;
  managedAiCreditUsdPerMonth: number;
  byokAllowed: boolean;
}

export type Entitlements = { plan: PlanId } & PlanLimits;

const GB = 1024 ** 3;

export const PLANS: Readonly<Record<PlanId, Readonly<PlanLimits>>> = {
  free: {
    maxConcurrentSessions: 1,
    runsPerMonth: 50,
    agentTurnsPerMonth: 100,
    visionCallsPerMonth: 50,
    artifactStorageBytes: 1 * GB,
    managedAiCreditUsdPerMonth: 0,
    byokAllowed: true,
  },
  pro: {
    maxConcurrentSessions: 2,
    runsPerMonth: 1000,
    agentTurnsPerMonth: 2000,
    visionCallsPerMonth: 1000,
    artifactStorageBytes: 20 * GB,
    managedAiCreditUsdPerMonth: 10,
    byokAllowed: true,
  },
  team: {
    maxConcurrentSessions: 4,
    runsPerMonth: 5000,
    agentTurnsPerMonth: 10000,
    visionCallsPerMonth: 5000,
    artifactStorageBytes: 100 * GB,
    managedAiCreditUsdPerMonth: 50,
    byokAllowed: true,
  },
};

/** Every new org starts here (self-serve free tier). */
export const DEFAULT_PLAN: PlanId = 'free';

/**
 * Free orgs a user may own. Each free org carries its own allowance, so without a cap
 * one person could multiply it. Paid orgs do not count.
 */
export const FREE_ORGS_PER_USER = 1;

const isPlan = (id: unknown): id is PlanId =>
  typeof id === 'string' && Object.prototype.hasOwnProperty.call(PLANS, id);

/**
 * A plan's limits with an org's overrides on top. Only known limit keys with a valid
 * value apply (a non-negative safe integer, or a boolean for `byokAllowed`); anything
 * else is ignored, and an unknown plan id is the free plan: a bad row grants nothing.
 */
export function resolveEntitlements(plan: unknown, overrides: unknown): Entitlements {
  const id = isPlan(plan) ? plan : DEFAULT_PLAN;
  const limits: PlanLimits = { ...PLANS[id] };
  if (overrides && typeof overrides === 'object' && !Array.isArray(overrides)) {
    for (const [key, value] of Object.entries(overrides)) {
      if (!Object.prototype.hasOwnProperty.call(limits, key)) continue;
      const k = key as keyof PlanLimits;
      if (k === 'byokAllowed') {
        if (typeof value === 'boolean') limits.byokAllowed = value;
      } else if (Number.isSafeInteger(value) && (value as number) >= 0) {
        limits[k] = value as number;
      }
    }
  }
  return { plan: id, ...limits };
}

/** Org entitlements in Postgres (`org_plans`, migration 0009). */
export function orgEntitlements(db: Kysely<unknown>) {
  return {
    /** An org with no row is on the default (free) plan. */
    async get(orgId: string): Promise<Entitlements> {
      const { rows } = await sql<{ plan: string; overrides: unknown }>`
        select plan, overrides from org_plans where org_id = ${orgId}`.execute(db);
      return resolveEntitlements(rows[0]?.plan ?? DEFAULT_PLAN, rows[0]?.overrides ?? {});
    },

    /** Sets the plan and replaces the overrides (none unless given). */
    async setPlan(orgId: string, plan: PlanId, overrides: Partial<PlanLimits> = {}): Promise<void> {
      if (!isPlan(plan)) throw new Error(`Unknown plan: ${JSON.stringify(plan)}`);
      await sql`
        insert into org_plans (org_id, plan, overrides)
        values (${orgId}, ${plan}, ${JSON.stringify(overrides)}::jsonb)
        on conflict (org_id) do update
          set plan = excluded.plan, overrides = excluded.overrides, updated_at = now()`.execute(db);
    },
  };
}

/** Plans that do not count against the free-org cap. An unknown id resolves to free, so it counts. */
const PAID_PLANS = (Object.keys(PLANS) as PlanId[]).filter((id) => id !== DEFAULT_PLAN);

/**
 * True when the user owns at least `limit` (default `FREE_ORGS_PER_USER`) orgs on the free
 * plan; an org with no `org_plans` row is free. At least, not exactly: a downgrade can
 * leave someone above the cap. Owner role, not membership: joining someone else's org
 * costs nothing, but an invited co-owner of a free org does use their allowance.
 * BetterAuth stores several roles as one comma-separated string (`admin,owner`), so
 * `owner` is matched as a token.
 */
export async function freeOrgLimitReached(
  db: Kysely<unknown>,
  userId: string,
  limit = FREE_ORGS_PER_USER,
): Promise<boolean> {
  const { rows } = await sql<{ n: number }>`
    select count(*)::int as n from member m
    left join org_plans p on p.org_id = m."organizationId"
    where m."userId" = ${userId}
      and 'owner' = any (string_to_array(replace(m.role, ' ', ''), ','))
      and coalesce(p.plan, ${DEFAULT_PLAN}) not in (${sql.join(PAID_PLANS)})`.execute(db);
  return (rows[0]?.n ?? 0) >= limit;
}

import { sql, type Kysely } from 'kysely';
import type { AICredentials } from '../ai-client/credentials';
import { readSecretEnv } from '../secret-env';

/**
 * Managed AI credits (#479, ADR 0001 §6). An org runs AI in one of two modes:
 * - `byok`: its own provider key (#344), billed to it by the vendor (`billing_mode = byok`);
 * - `managed`: IRIS's key, paid from the plan's monthly credit (`billing_mode = managed`).
 *
 * Per call: a managed org with credit left gets IRIS's key; with none left (or no managed
 * key configured) it falls back to its own key, else no AI. A BYOK org is never switched
 * to managed: that would bill spend the org did not choose.
 */

export type AiMode = 'byok' | 'managed';
export type BillingMode = 'byok' | 'managed';

/** IRIS's own vendor key: operator configuration, read once at startup. */
export interface ManagedKey {
  provider: 'openai' | 'anthropic';
  apiKey: string;
}

/**
 * `IRIS_MANAGED_AI_PROVIDER` (`openai` | `anthropic`) and `IRIS_MANAGED_AI_KEY(_FILE)`.
 * Neither: `null` (managed mode unavailable). One without the other, or an unknown
 * provider: throws, so a typo cannot quietly turn managed AI off.
 */
export function resolveManagedKey(env: NodeJS.ProcessEnv = process.env): ManagedKey | null {
  const provider = env.IRIS_MANAGED_AI_PROVIDER;
  const apiKey = readSecretEnv('IRIS_MANAGED_AI_KEY', env);
  if (!provider && !apiKey) return null;
  if (!provider || !apiKey)
    throw new Error('Set IRIS_MANAGED_AI_PROVIDER and IRIS_MANAGED_AI_KEY (or _FILE) together');
  if (provider !== 'openai' && provider !== 'anthropic')
    throw new Error(
      `IRIS_MANAGED_AI_PROVIDER must be openai or anthropic, not ${JSON.stringify(provider)}`,
    );
  return { provider, apiKey };
}

/** The org's AI mode; settable by owners and admins (the portal checks). */
export function orgAiSettings(db: Kysely<unknown>) {
  return {
    async get(orgId: string): Promise<AiMode> {
      const { rows } = await sql<{ mode: AiMode }>`
        select mode from org_ai_settings where org_id = ${orgId}`.execute(db);
      return rows[0]?.mode ?? 'byok';
    },
    async set(orgId: string, mode: AiMode, actor: string): Promise<void> {
      if (mode !== 'byok' && mode !== 'managed') throw new Error(`Unknown AI mode: ${mode}`);
      await sql`insert into org_ai_settings (org_id, mode, updated_by) values (${orgId}, ${mode}, ${actor})
        on conflict (org_id) do update set mode = excluded.mode,
          updated_by = excluded.updated_by, updated_at = now()`.execute(db);
    },
  };
}

/** This UTC month's managed AI spend of an org, in USD (the ledger is the record, #263). */
export async function managedSpendThisMonth(db: Kysely<unknown>, orgId: string): Promise<number> {
  const { rows } = await sql<{ spent: string }>`
    select coalesce(sum(quantity * coalesce(unit_cost_usd, 0)), 0) as spent from usage_events
    where org_id = ${orgId} and billing_mode = 'managed'
      and created_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'`.execute(
    db,
  );
  return Number(rows[0].spent);
}

export type ResolvedAI = AICredentials & { billingMode: BillingMode };

/**
 * The per-call credential resolver for hosted requests (`startServer({ aiCredentials })`).
 *
 * ponytail: a managed call is admitted while any credit is left, and its usage is written
 * when it settles, so the overshoot is the cost of the calls in flight for the org (bounded
 * by its rate buckets and sessions; the operator's CostTracker budget still reserves per
 * call, #244). Reserve in Postgres if that overshoot ever matters.
 */
export function managedAiResolver(deps: {
  db: Kysely<unknown>;
  entitlements: (
    orgId: string,
  ) => Promise<{ byokAllowed: boolean; managedAiCreditUsdPerMonth: number }>;
  providerKeys: { credentialsFor(orgId: string): Promise<AICredentials | null> };
  managedKey: ManagedKey | null;
}): (principal: { orgId: string }) => Promise<ResolvedAI | null> {
  const settings = orgAiSettings(deps.db);
  return async ({ orgId }) => {
    const [mode, plan] = await Promise.all([settings.get(orgId), deps.entitlements(orgId)]);
    if (mode === 'managed' && deps.managedKey) {
      const left = plan.managedAiCreditUsdPerMonth - (await managedSpendThisMonth(deps.db, orgId));
      if (left > 0)
        return {
          provider: deps.managedKey.provider,
          apiKey: deps.managedKey.apiKey,
          billingMode: 'managed',
        };
    }
    // BYOK, or managed with no credit left: the org's own key, never the reverse.
    if (!plan.byokAllowed) return null;
    const own = await deps.providerKeys.credentialsFor(orgId);
    return own ? { ...own, billingMode: 'byok' } : null;
  };
}

import { actorFrom, recordAudit } from '../audit-log';
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
    /** `actor` is `user:<id>` or `key:<id>`, kept as `updated_by` and audited (#361). */
    async set(orgId: string, mode: AiMode, actor: string): Promise<void> {
      if (mode !== 'byok' && mode !== 'managed') throw new Error(`Unknown AI mode: ${mode}`);
      await db.transaction().execute(async (tx) => {
        await sql`insert into org_ai_settings (org_id, mode, updated_by) values (${orgId}, ${mode}, ${actor})
          on conflict (org_id) do update set mode = excluded.mode,
            updated_by = excluded.updated_by, updated_at = now()`.execute(tx);
        await recordAudit(tx, {
          orgId,
          actor: actorFrom(actor),
          action: 'ai_mode.set',
          metadata: { mode },
        });
      });
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

/**
 * A credential for one call. A managed one carries `release`: the caller runs it once the
 * call is over (settled or not), which frees the credit reserved for it (#482).
 */
export type ResolvedAI = AICredentials & {
  billingMode: BillingMode;
  release?: () => Promise<void>;
};

/** A reservation older than this no longer counts: its call crashed or hung (#482). */
const RESERVATION_TTL_MINUTES = 10;

/**
 * Reserves `estimateUsd` of the org's managed credit if spend plus live reservations leave
 * room for it, under a per-org lock so parallel calls cannot all pass. Returns the
 * reservation's id, or null when the credit is used up.
 */
async function reserveCredit(
  db: Kysely<unknown>,
  orgId: string,
  creditUsd: number,
  estimateUsd: number,
): Promise<string | null> {
  return db.transaction().execute(async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${'managed-ai:' + orgId}))`.execute(tx);
    // Stale rows of this org go here: nothing else sweeps them.
    await sql`delete from managed_ai_reservations where org_id = ${orgId}
      and created_at < now() - make_interval(mins => ${RESERVATION_TTL_MINUTES})`.execute(tx);
    const { rows } = await sql<{ reserved: string }>`
      select coalesce(sum(amount_usd), 0) as reserved from managed_ai_reservations
      where org_id = ${orgId}`.execute(tx);
    const committed = (await managedSpendThisMonth(tx, orgId)) + Number(rows[0].reserved);
    if (committed + estimateUsd > creditUsd) return null;
    const inserted = await sql<{ id: string }>`
      insert into managed_ai_reservations (org_id, amount_usd) values (${orgId}, ${estimateUsd})
      returning id`.execute(tx);
    return inserted.rows[0].id;
  });
}

/**
 * The per-call credential resolver for hosted requests (`startServer({ aiCredentials })`).
 *
 * A managed call reserves its worst-case cost first (#482): it is admitted only when this
 * month's managed spend plus the calls in flight leave room for it, so N parallel calls stay
 * within the credit. The caller releases the reservation when the call is over.
 */
export function managedAiResolver(deps: {
  db: Kysely<unknown>;
  entitlements: (
    orgId: string,
  ) => Promise<{ byokAllowed: boolean; managedAiCreditUsdPerMonth: number }>;
  providerKeys: { credentialsFor(orgId: string): Promise<AICredentials | null> };
  managedKey: ManagedKey | null;
  /**
   * Worst-case cost of one managed call of `inputChars` request characters, reserved before
   * it (#482): hosted wiring passes `managedCallEstimateUsd` (src/ai-client/cost-tracker.ts).
   * A parameter, not an import: the portal loads this module, and the cost tracker would
   * bring SQLite into its bundle.
   */
  estimateUsd: (inputChars: number) => number;
}): (
  principal: { orgId: string },
  request?: { inputChars?: number },
) => Promise<ResolvedAI | null> {
  const settings = orgAiSettings(deps.db);
  return async ({ orgId }, request) => {
    const [mode, plan] = await Promise.all([settings.get(orgId), deps.entitlements(orgId)]);
    if (mode === 'managed' && deps.managedKey) {
      const estimate = deps.estimateUsd(request?.inputChars ?? 0);
      const id = await reserveCredit(deps.db, orgId, plan.managedAiCreditUsdPerMonth, estimate);
      if (id)
        return {
          provider: deps.managedKey.provider,
          apiKey: deps.managedKey.apiKey,
          billingMode: 'managed',
          release: async () => {
            await sql`delete from managed_ai_reservations where id = ${id}`.execute(deps.db);
          },
        };
    }
    // BYOK, or managed with no credit left: the org's own key, never the reverse.
    if (!plan.byokAllowed) return null;
    const own = await deps.providerKeys.credentialsFor(orgId);
    return own ? { ...own, billingMode: 'byok' } : null;
  };
}

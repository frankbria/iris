/**
 * The tenant audit log (#361): who changed what in an org, in `audit_log` (migration 0001).
 *
 * Actors are plain ids, not foreign keys, so an entry outlives the user or key (offboarding
 * pseudonymises users, #349). Never the secret: a provider key's entry names the provider, an
 * API key's entry its id. Kysely only, so the portal can import it (as visual-baselines).
 *
 * Write an entry on the transaction that makes the change, so neither is committed without
 * the other; a store that changes something audited takes the actor for that reason.
 */

import { sql, type Kysely } from 'kysely';

/** Who acted: a portal user, an org API key, or neither (an operator, the system). */
export interface AuditActor {
  userId?: string | null;
  apiKeyId?: string | null;
}

export interface AuditEntry {
  orgId: string;
  actor?: AuditActor;
  /** `<resource>.<verb>`, e.g. `api_key.create`, `provider_key.remove`, `job.submit`. */
  action: string;
  /** What it acted on, e.g. `key:<id>`, `provider:openai`, `run:<id>`. */
  target?: string;
  metadata?: Record<string, unknown>;
}

/** Writes one entry on `db`; pass the change's transaction to commit them together. */
export async function recordAudit(db: Kysely<unknown>, entry: AuditEntry): Promise<void> {
  await sql`insert into audit_log (org_id, actor_user_id, actor_api_key_id, action, target, metadata)
    values (${entry.orgId}, ${entry.actor?.userId ?? null}, ${entry.actor?.apiKeyId ?? null},
      ${entry.action}, ${entry.target ?? null},
      ${entry.metadata === undefined ? null : JSON.stringify(entry.metadata)}::jsonb)`.execute(db);
}

/** An actor from the `user:<id>` / `key:<id>` form the stores already record (`updated_by`). */
export function actorFrom(by: string | null | undefined): AuditActor {
  if (by?.startsWith('user:')) return { userId: by.slice(5) };
  if (by?.startsWith('key:')) return { apiKeyId: by.slice(4) };
  return {};
}

/**
 * How many of the org's live API keys each user created, by user id (#408): what removing
 * them would revoke. From the audit log, so keys made before #361 are not counted.
 */
export async function liveKeysByCreator(
  db: Kysely<unknown>,
  orgId: string,
): Promise<Map<string, number>> {
  const { rows } = await sql<{ user_id: string; n: number }>`
    select a.actor_user_id as user_id, count(*)::int as n from audit_log a
    join apikey k on k.id = substr(a.target, 5) and k."referenceId" = a.org_id
    where a.org_id = ${orgId} and a.action = 'api_key.create' and a.actor_user_id is not null
    group by a.actor_user_id`.execute(db);
  return new Map(rows.map((r) => [r.user_id, r.n]));
}

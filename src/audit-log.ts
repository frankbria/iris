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

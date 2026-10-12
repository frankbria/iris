/**
 * An org's API keys follow their creator's membership (#408). Keys belong to the org and
 * record no creator (#340); #361's audit log does (`api_key.create`, actor user), so the
 * keys a departing member made can be found and revoked. Kysely only, so Jest can test it
 * against Postgres (BetterAuth's hooks call it, and Jest cannot load BetterAuth).
 */

import { sql, type Kysely } from 'kysely';
import { recordAudit, type AuditActor } from './audit-log';

/**
 * Deletes the org's live keys `userId` created and audits each (`api_key.delete`,
 * `reason`). Returns their ids. Keys made before #361 have no creator on record and stay.
 */
export async function revokeKeysCreatedBy(
  db: Kysely<unknown>,
  orgId: string,
  userId: string,
  actor: AuditActor,
  reason: string,
): Promise<string[]> {
  const { rows } = await sql<{ id: string }>`
    delete from apikey where "referenceId" = ${orgId} and id in (
      select substr(target, 5) from audit_log
      where org_id = ${orgId} and action = 'api_key.create' and actor_user_id = ${userId})
    returning id`.execute(db);
  for (const { id } of rows) {
    await recordAudit(db, {
      orgId,
      actor,
      action: 'api_key.delete',
      target: `key:${id}`,
      metadata: { reason },
    });
  }
  return rows.map((r) => r.id);
}

/**
 * Called after a key's creation is audited: revokes it when its creator is no longer a
 * member (codex review on #408). A removal that ran while the key was being created did
 * not see its audit row yet, so this check, made after that row is committed, closes the
 * gap: either the removal sees the row, or this sees the member gone.
 */
export async function revokeIfCreatorLeft(
  db: Kysely<unknown>,
  orgId: string,
  userId: string,
  keyId: string,
): Promise<boolean> {
  const { rows } = await sql`
    select 1 from member where "organizationId" = ${orgId} and "userId" = ${userId}`.execute(db);
  if (rows.length > 0) return false;
  const { rows: gone } = await sql<{ id: string }>`
    delete from apikey where id = ${keyId} and "referenceId" = ${orgId} returning id`.execute(db);
  if (gone.length > 0) {
    await recordAudit(db, {
      orgId,
      actor: { userId },
      action: 'api_key.delete',
      target: `key:${keyId}`,
      metadata: { reason: 'creator_left' },
    });
  }
  return gone.length > 0;
}

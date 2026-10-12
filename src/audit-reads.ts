/**
 * Reading an org's audit trail (#541): the entries #361 records, newest first, paged. Kysely
 * only and no runner imports, so the portal can load it (as `run-reads`, #270).
 */

import { sql, type Kysely } from 'kysely';
import { redactStrings } from './log';

export interface AuditRecord {
  id: string;
  createdAt: Date;
  action: string;
  target: string | null;
  metadata: unknown;
  /** The acting user's id and, while they exist, their name and email. */
  actorUser: { id: string; name: string | null; email: string | null } | null;
  actorApiKeyId: string | null;
}

export interface AuditPage {
  entries: AuditRecord[];
  /** Pass back for the next (older) page; absent on the last one. */
  nextCursor?: string;
}

/** A cursor that is not one this module made. */
export class InvalidAuditCursorError extends Error {
  constructor() {
    super('Invalid cursor');
    this.name = 'InvalidAuditCursorError';
  }
}

const CURSOR = /^[1-9][0-9]{0,18}$/;
/** Postgres bigint's maximum: 19 digits can exceed it (codex review). */
const MAX_ID = 9223372036854775807n;
const validCursor = (cursor: string) => CURSOR.test(cursor) && BigInt(cursor) <= MAX_ID;

interface Row {
  id: string;
  created_at: Date;
  action: string;
  target: string | null;
  metadata: unknown;
  actor_user_id: string | null;
  actor_api_key_id: string | null;
  user_name: string | null;
  user_email: string | null;
}

/**
 * One page of `orgId`'s audit entries, newest first, at most `limit` (1-100). Only that
 * org's entries, whatever the cursor says: the cursor is an entry id, and every page
 * filters by org. Strings go through `redactStrings` (src/log.ts), as run detail does:
 * entries carry no secrets by construction, this is the net.
 * ponytail: paged by the identity id, newest first, over the (org_id, created_at) index's
 * org filter; add an (org_id, id) index if one org's trail grows large.
 */
export async function auditPage(
  db: Kysely<unknown>,
  orgId: string,
  { cursor, limit = 50 }: { cursor?: string; limit?: number },
): Promise<AuditPage> {
  if (cursor !== undefined && !validCursor(cursor)) throw new InvalidAuditCursorError();
  const size = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const { rows } = await sql<Row>`
    select a.id::text as id, a.created_at, a.action, a.target, a.metadata,
      a.actor_user_id, a.actor_api_key_id, u.name as user_name, u.email as user_email
    from audit_log a left join "user" u on u.id = a.actor_user_id
    where a.org_id = ${orgId} ${cursor === undefined ? sql`` : sql`and a.id < ${cursor}::bigint`}
    order by a.id desc limit ${size + 1}`.execute(db);
  const entries = rows.slice(0, size).map(toRecord);
  return rows.length > size ? { entries, nextCursor: entries[entries.length - 1].id } : { entries };
}

function toRecord(r: Row): AuditRecord {
  return {
    id: r.id,
    createdAt: r.created_at,
    action: r.action,
    target: r.target === null ? null : (redactStrings(r.target) as string),
    metadata: redactStrings(r.metadata),
    actorUser:
      r.actor_user_id === null
        ? null
        : { id: r.actor_user_id, name: r.user_name, email: r.user_email },
    actorApiKeyId: r.actor_api_key_id,
  };
}

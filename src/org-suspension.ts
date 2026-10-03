import { sql, type Kysely, type RawBuilder } from 'kysely';
import { log } from './log';

/**
 * Operator suspension of an org (#348). `org_suspensions` (migration 0007) is an
 * append-only history; an org's state is its latest row's action, and an org with no
 * rows is active. The reason is for operators: it is never sent to a tenant.
 */

export type SuspensionAction = 'suspend' | 'unsuspend';

export interface SuspensionEvent {
  action: SuspensionAction;
  reason: string;
  actor: string;
  createdAt: Date;
}

export interface SuspensionStatus {
  suspended: boolean;
  /** The latest action, or `null` for an org never suspended. */
  last: SuspensionEvent | null;
}

/** Thrown for an org id with no `organization` row. */
export class UnknownOrgError extends Error {
  constructor(orgId: string) {
    super(`No organization with id ${JSON.stringify(orgId)}`);
    this.name = 'UnknownOrgError';
  }
}

/**
 * `true` when the org's latest action is `suspend`: one probe of
 * `org_suspensions_org_idx`. `orgId` is a value, or a column reference such as
 * `sql.ref('runs.org_id')` to use it inside another statement.
 */
export function suspendedSql(orgId: string | RawBuilder<unknown>): RawBuilder<boolean> {
  return sql<boolean>`coalesce((
    select s.action = 'suspend' from org_suspensions s where s.org_id = ${orgId}
    order by s.created_at desc, s.id desc limit 1), false)`;
}

interface EventRow {
  action: SuspensionAction;
  reason: string;
  actor: string;
  created_at: Date;
}

const toEvent = (r: EventRow): SuspensionEvent => ({
  action: r.action,
  reason: r.reason,
  actor: r.actor,
  createdAt: r.created_at,
});

export function orgSuspensions(db: Kysely<unknown>) {
  const assertOrg = async (q: Kysely<unknown>, orgId: string) => {
    const { rows } = await sql`select 1 from organization where id = ${orgId}`.execute(q);
    if (!rows.length) throw new UnknownOrgError(orgId);
  };

  const latest = async (q: Kysely<unknown>, orgId: string): Promise<SuspensionEvent | null> => {
    const { rows } = await sql<EventRow>`
      select action, reason, actor, created_at from org_suspensions where org_id = ${orgId}
      order by created_at desc, id desc limit 1`.execute(q);
    return rows[0] ? toEvent(rows[0]) : null;
  };

  /**
   * Records `action` unless the org is already in that state (then nothing is written).
   * Serialized per org, so two operators acting at once record one change, not two.
   */
  const act = async (
    action: SuspensionAction,
    orgId: string,
    { reason, actor }: { reason: string; actor: string },
  ): Promise<SuspensionStatus & { changed: boolean }> => {
    if (!reason.trim()) throw new Error('A reason is required');
    if (!actor.trim()) throw new Error('An actor is required');
    const result = await db.transaction().execute(async (tx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${'org_suspensions:' + orgId}))`.execute(tx);
      await assertOrg(tx, orgId);
      const last = await latest(tx, orgId);
      if ((last?.action ?? 'unsuspend') === action) {
        return { suspended: action === 'suspend', last, changed: false };
      }
      const { rows } = await sql<EventRow>`
        insert into org_suspensions (org_id, action, reason, actor)
        values (${orgId}, ${action}, ${reason.trim()}, ${actor.trim()})
        returning action, reason, actor, created_at`.execute(tx);
      return { suspended: action === 'suspend', last: toEvent(rows[0]), changed: true };
    });
    if (result.changed) {
      log('info', action === 'suspend' ? 'org suspended' : 'org unsuspended', {
        orgId,
        actor: actor.trim(),
        reason: reason.trim(),
      });
    }
    return result;
  };

  return {
    suspend: (orgId: string, by: { reason: string; actor: string }) => act('suspend', orgId, by),
    unsuspend: (orgId: string, by: { reason: string; actor: string }) =>
      act('unsuspend', orgId, by),
    /** The hot-path check (auth, worker, portal): one indexed query, no existence check. */
    async isSuspended(orgId: string): Promise<boolean> {
      const { rows } = await sql<{ s: boolean }>`select ${suspendedSql(orgId)} as s`.execute(db);
      return rows[0].s;
    },
    /** @throws UnknownOrgError */
    async status(orgId: string): Promise<SuspensionStatus> {
      await assertOrg(db, orgId);
      const last = await latest(db, orgId);
      return { suspended: last?.action === 'suspend', last };
    },
    /** Every action, oldest first. @throws UnknownOrgError */
    async history(orgId: string): Promise<SuspensionEvent[]> {
      await assertOrg(db, orgId);
      const { rows } = await sql<EventRow>`
        select action, reason, actor, created_at from org_suspensions where org_id = ${orgId}
        order by created_at, id`.execute(db);
      return rows.map(toEvent);
    },
  };
}

export type OrgSuspensions = ReturnType<typeof orgSuspensions>;

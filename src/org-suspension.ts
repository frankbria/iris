import { sql, type Kysely, type RawBuilder } from 'kysely';
import { log } from './log';
import { revokeKeysCreatedBy } from './member-keys';

/**
 * Operator suspension of an org (#348) or a user (#457, `iris admin ban-user`).
 * `org_suspensions` (migration 0007) and `user_suspensions` (0016) are append-only
 * histories; the subject's state is its latest row's action, and no rows means active.
 * The reason is for operators: it is never sent to a tenant.
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

/** Thrown for a user id or email with no `user` row. */
export class UnknownUserError extends Error {
  constructor(ref: string) {
    super(`No user with id or email ${JSON.stringify(ref)}`);
    this.name = 'UnknownUserError';
  }
}

/** One history table: whose state it holds and how a reference names one. */
interface Subject {
  label: 'org' | 'user';
  table: 'org_suspensions' | 'user_suspensions';
  column: 'org_id' | 'user_id';
  /** The subject's id for `ref`, or the subject's Unknown*Error. */
  resolve(q: Kysely<unknown>, ref: string): Promise<string>;
  /** Runs in the suspending transaction, after the row is written. */
  onSuspend?(tx: Kysely<unknown>, id: string): Promise<void>;
}

function latestSql(subject: Subject, id: string | RawBuilder<unknown>): RawBuilder<boolean> {
  return sql<boolean>`coalesce((
    select s.action = 'suspend' from ${sql.table(subject.table)} s
    where ${sql.ref('s.' + subject.column)} = ${id}
    order by s.created_at desc, s.id desc limit 1), false)`;
}

const ORG: Subject = {
  label: 'org',
  table: 'org_suspensions',
  column: 'org_id',
  async resolve(q, orgId) {
    const { rows } = await sql`select 1 from organization where id = ${orgId}`.execute(q);
    if (!rows.length) throw new UnknownOrgError(orgId);
    return orgId;
  },
};

const USER: Subject = {
  label: 'user',
  table: 'user_suspensions',
  column: 'user_id',
  async resolve(q, ref) {
    const { rows } = await sql<{ id: string }>`
      select id from "user" where id = ${ref} or email = lower(${ref})`.execute(q);
    if (rows.length !== 1) throw new UnknownUserError(ref);
    return rows[0].id;
  },
  // A ban takes effect at once: sessions are read from the table on every request (no
  // cookie cache), and keys the user made are revoked in each org, as when they leave
  // one (#408). Keys from before #361 have no creator on record and stay.
  async onSuspend(tx, userId) {
    await sql`delete from session where "userId" = ${userId}`.execute(tx);
    const { rows } = await sql<{ org: string }>`
      select "organizationId" as org from member where "userId" = ${userId}`.execute(tx);
    for (const { org } of rows) await revokeKeysCreatedBy(tx, org, userId, {}, 'user banned');
  },
};

/**
 * `true` when the org's latest action is `suspend`: one probe of
 * `org_suspensions_org_idx`. `orgId` is a value, or a column reference such as
 * `sql.ref('runs.org_id')` to use it inside another statement.
 */
export function suspendedSql(orgId: string | RawBuilder<unknown>): RawBuilder<boolean> {
  return latestSql(ORG, orgId);
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

function suspensions(db: Kysely<unknown>, subject: Subject) {
  const table = sql.table(subject.table);
  const column = sql.ref(subject.column);
  const latest = async (q: Kysely<unknown>, id: string): Promise<SuspensionEvent | null> => {
    const { rows } = await sql<EventRow>`
      select action, reason, actor, created_at from ${table} where ${column} = ${id}
      order by created_at desc, id desc limit 1`.execute(q);
    return rows[0] ? toEvent(rows[0]) : null;
  };

  /**
   * Records `action` unless the subject is already in that state (then nothing is
   * written). Serialized per subject, so two operators acting at once record one change.
   */
  const act = async (
    action: SuspensionAction,
    ref: string,
    { reason, actor }: { reason: string; actor: string },
  ): Promise<SuspensionStatus & { changed: boolean }> => {
    if (!reason.trim()) throw new Error('A reason is required');
    if (!actor.trim()) throw new Error('An actor is required');
    const result = await db.transaction().execute(async (tx) => {
      const id = await subject.resolve(tx, ref);
      await sql`select pg_advisory_xact_lock(hashtext(${subject.table + ':' + id}))`.execute(tx);
      const last = await latest(tx, id);
      if ((last?.action ?? 'unsuspend') === action) {
        return { id, suspended: action === 'suspend', last, changed: false };
      }
      // Dated strictly after the subject's latest row, under the lock: `now()` is when the
      // transaction began, and a transaction that began first can take the lock second,
      // which would date the later action earlier and let the earlier one read as current.
      const { rows } = await sql<EventRow>`
        insert into ${table} (${column}, action, reason, actor, created_at)
        values (${id}, ${action}, ${reason.trim()}, ${actor.trim()}, greatest(
          clock_timestamp(),
          (select max(created_at) from ${table} where ${column} = ${id})
            + interval '1 microsecond'))
        returning action, reason, actor, created_at`.execute(tx);
      if (action === 'suspend') await subject.onSuspend?.(tx, id);
      return { id, suspended: action === 'suspend', last: toEvent(rows[0]), changed: true };
    });
    const { id, ...status } = result;
    if (status.changed) {
      log('info', `${subject.label} ${action === 'suspend' ? 'suspended' : 'unsuspended'}`, {
        [subject.label + 'Id']: id,
        actor: actor.trim(),
        reason: reason.trim(),
      });
    }
    return status;
  };

  return {
    suspend: (ref: string, by: { reason: string; actor: string }) => act('suspend', ref, by),
    unsuspend: (ref: string, by: { reason: string; actor: string }) => act('unsuspend', ref, by),
    /** The hot-path check (auth, worker, portal): one indexed query, no existence check. */
    async isSuspended(id: string): Promise<boolean> {
      const { rows } = await sql<{ s: boolean }>`select ${latestSql(subject, id)} as s`.execute(db);
      return rows[0].s;
    },
    /** @throws the subject's Unknown*Error */
    async status(ref: string): Promise<SuspensionStatus> {
      const last = await latest(db, await subject.resolve(db, ref));
      return { suspended: last?.action === 'suspend', last };
    },
    /** Every action, oldest first. @throws the subject's Unknown*Error */
    async history(ref: string): Promise<SuspensionEvent[]> {
      const id = await subject.resolve(db, ref);
      const { rows } = await sql<EventRow>`
        select action, reason, actor, created_at from ${table} where ${column} = ${id}
        order by created_at, id`.execute(db);
      return rows.map(toEvent);
    },
  };
}

/**
 * Whether the user is banned, read under the ban's own lock (#457, codex review). A write
 * committed before this call is either seen by a ban in progress (its session delete or
 * key revocation) or waits here for that ban and sees it.
 */
export async function userBannedLocked(db: Kysely<unknown>, userId: string): Promise<boolean> {
  return db.transaction().execute(async (tx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${USER.table + ':' + userId}))`.execute(tx);
    const { rows } = await sql<{ s: boolean }>`select ${latestSql(USER, userId)} as s`.execute(tx);
    return rows[0].s;
  });
}

/** After a key's creation is audited: revokes the user's keys in the org if they are banned. */
export async function revokeIfCreatorBanned(
  db: Kysely<unknown>,
  orgId: string,
  userId: string,
): Promise<boolean> {
  if (!(await userBannedLocked(db, userId))) return false;
  return (await revokeKeysCreatedBy(db, orgId, userId, {}, 'user banned')).length > 0;
}

/** Org suspension (#348), by org id. */
export const orgSuspensions = (db: Kysely<unknown>) => suspensions(db, ORG);

/**
 * User bans (#457), by user id or email. A ban revokes the user's sessions and the keys
 * they created in the same transaction; `createAuth()` then refuses their sign-in.
 */
export const userSuspensions = (db: Kysely<unknown>) => suspensions(db, USER);

export type OrgSuspensions = ReturnType<typeof orgSuspensions>;

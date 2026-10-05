import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { sql, type Kysely } from 'kysely';
import { log } from './log';

/**
 * Org offboarding, account deletion and the daily retention pass (#349; owner decisions
 * 2026-10-03). Operator-run (`iris admin delete-org | restore-org | delete-user |
 * retention`); every step is idempotent, so a pass that dies half-way is finished by the
 * next one.
 */

export const GRACE_DAYS = 30;
export const RUN_RETENTION_DAYS = 90;
export const RECORD_RETENTION_YEARS = 7;

/** Refusals an operator should see as such (unknown org, already purged, …): exit 1. */
export class OffboardingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OffboardingError';
  }
}

/** The suspension a deletion request adds; restore lifts only a suspension it added. */
const DELETION_REASON = 'Organization deletion requested';

export interface RetentionReport {
  orgsPurged: string[];
  tombstonesDropped: number;
  runsDeleted: number;
  sessionsDeleted: number;
  verificationsDeleted: number;
  termsDropped: number;
}

export function offboarding(db: Kysely<unknown>) {
  const orgExists = async (q: Kysely<unknown>, orgId: string) =>
    (await sql`select 1 from organization where id = ${orgId}`.execute(q)).rows.length > 0;

  const latestSuspension = async (q: Kysely<unknown>, orgId: string) =>
    (
      await sql<{ action: string; reason: string }>`
        select action, reason from org_suspensions where org_id = ${orgId}
        order by created_at desc, id desc limit 1`.execute(q)
    ).rows[0];

  /** Appends a suspension row dated after the org's latest one (the #348 lock order). */
  const stampSuspension = async (
    q: Kysely<unknown>,
    orgId: string,
    action: 'suspend' | 'unsuspend',
    reason: string,
    actor: string,
  ) => {
    await sql`select pg_advisory_xact_lock(hashtext(${'org_suspensions:' + orgId}))`.execute(q);
    await sql`insert into org_suspensions (org_id, action, reason, actor, created_at)
      values (${orgId}, ${action}, ${reason}, ${actor}, greatest(clock_timestamp(),
        (select max(created_at) from org_suspensions where org_id = ${orgId})
          + interval '1 microsecond'))`.execute(q);
  };

  /** Deletes an org's data and scrubs its row into a tombstone holding its billing records. */
  const purgeOrg = async (tx: Kysely<unknown>, orgId: string) => {
    // Billing records outlive their runs (7 years): detach before the runs go.
    await sql`update usage_events set run_id = null where org_id = ${orgId}`.execute(tx);
    await sql`delete from runs where org_id = ${orgId}`.execute(tx); // results cascade
    await sql`delete from provider_keys where org_id = ${orgId}`.execute(tx);
    await sql`delete from apikey where "referenceId" = ${orgId}`.execute(tx);
    await sql`delete from org_plans where org_id = ${orgId}`.execute(tx);
    await sql`delete from audit_log where org_id = ${orgId}`.execute(tx);
    await sql`delete from member where "organizationId" = ${orgId}`.execute(tx);
    await sql`delete from invitation where "organizationId" = ${orgId}`.execute(tx);
    await sql`update session set "activeOrganizationId" = null
      where "activeOrganizationId" = ${orgId}`.execute(tx);
    // One suspension remains (the reasons may name people): the tombstone stays unusable.
    await sql`delete from org_suspensions where org_id = ${orgId}`.execute(tx);
    await sql`insert into org_suspensions (org_id, action, reason, actor)
      values (${orgId}, 'suspend', 'Organization deleted', 'system')`.execute(tx);
    await sql`update organization set name = 'Deleted organization', slug = ${'deleted-' + orgId},
      logo = null, metadata = null where id = ${orgId}`.execute(tx);
    await sql`update org_deletions set purged_at = now(), reason = 'purged', requested_by = 'purged'
      where org_id = ${orgId}`.execute(tx);
  };

  return {
    /**
     * Soft delete: recorded with a purge date `GRACE_DAYS` out, and the org suspended now
     * (keys 403, jobs refused, the portal shows the banner: #348).
     */
    async requestOrgDeletion(orgId: string, { reason, actor }: { reason: string; actor: string }) {
      return db.transaction().execute(async (tx) => {
        if (!(await orgExists(tx, orgId)))
          throw new OffboardingError(`Unknown organization: ${orgId}`);
        const inserted = await sql`
          insert into org_deletions (org_id, requested_by, reason, purge_after)
          values (${orgId}, ${actor}, ${reason}, now() + make_interval(days => ${GRACE_DAYS}))
          on conflict (org_id) do nothing returning purge_after`.execute(tx);
        if (!inserted.rows.length)
          throw new OffboardingError(`Deletion of ${orgId} was already requested`);
        if ((await latestSuspension(tx, orgId))?.action !== 'suspend')
          await stampSuspension(tx, orgId, 'suspend', DELETION_REASON, actor);
        log('info', 'org deletion requested', { orgId, actor });
        return (inserted.rows[0] as { purge_after: Date }).purge_after;
      });
    },

    /** Within the grace period: drops the request and lifts the suspension it added. */
    async restoreOrg(orgId: string, { actor }: { actor: string }) {
      await db.transaction().execute(async (tx) => {
        const { rows } = await sql<{ purged_at: Date | null }>`
          select purged_at from org_deletions where org_id = ${orgId} for update`.execute(tx);
        if (!rows.length) throw new OffboardingError(`No pending deletion for ${orgId}`);
        if (rows[0].purged_at) throw new OffboardingError(`${orgId} was already purged`);
        await sql`delete from org_deletions where org_id = ${orgId}`.execute(tx);
        // An operator's own suspension (abuse) is not ours to lift.
        const last = await latestSuspension(tx, orgId);
        if (last?.action === 'suspend' && last.reason === DELETION_REASON)
          await stampSuspension(tx, orgId, 'unsuspend', 'Organization deletion cancelled', actor);
      });
      log('info', 'org deletion cancelled', { orgId, actor });
    },

    /**
     * Deletes a user: memberships, sessions and accounts cascade; the terms evidence is
     * pseudonymised by the database trigger (migration 0010). Refused while the user is
     * the only owner of an org not being deleted, which would be left with no owner.
     */
    async deleteUser(userId: string) {
      await db.transaction().execute(async (tx) => {
        const exists = await sql`select 1 from "user" where id = ${userId} for update`.execute(tx);
        if (!exists.rows.length) throw new OffboardingError(`Unknown user: ${userId}`);
        const { rows } = await sql<{ org: string }>`
          select m."organizationId" as org from member m
          where m."userId" = ${userId}
            and 'owner' = any (string_to_array(replace(m.role, ' ', ''), ','))
            and not exists (select 1 from org_deletions d where d.org_id = m."organizationId")
            and not exists (
              select 1 from member o where o."organizationId" = m."organizationId"
                and o."userId" <> ${userId}
                and 'owner' = any (string_to_array(replace(o.role, ' ', ''), ',')))`.execute(tx);
        if (rows.length)
          throw new OffboardingError(
            `${userId} is the only owner of ${rows.map((r) => r.org).join(', ')}: ` +
              'delete those organizations or add another owner first',
          );
        await sql`delete from "user" where id = ${userId}`.execute(tx);
      });
      log('info', 'user deleted', { userId });
    },

    /** The daily pass. `now` is injectable so tests cross 30 days, 90 days and 7 years. */
    async runRetention({ now = new Date() }: { now?: Date } = {}): Promise<RetentionReport> {
      const due = await sql<{ org_id: string }>`
        select org_id from org_deletions where purged_at is null and purge_after <= ${now}
        order by purge_after`.execute(db);
      const orgsPurged: string[] = [];
      for (const { org_id } of due.rows) {
        // One transaction per org: a failure leaves that org for the next pass.
        try {
          await db.transaction().execute((tx) => purgeOrg(tx, org_id));
          orgsPurged.push(org_id);
          log('info', 'org purged', { orgId: org_id });
        } catch (err) {
          log('error', 'org purge failed', { orgId: org_id, err: (err as Error).message });
        }
      }

      const sevenYearsAgo = sql`${now}::timestamptz - make_interval(years => ${RECORD_RETENTION_YEARS})`;
      const tombstonesDropped = await db.transaction().execute(async (tx) => {
        const { rows } = await sql<{ org_id: string }>`
          select org_id from org_deletions where purged_at < ${sevenYearsAgo}`.execute(tx);
        for (const { org_id } of rows) {
          await sql`delete from usage_events where org_id = ${org_id}`.execute(tx);
          await sql`delete from org_suspensions where org_id = ${org_id}`.execute(tx);
          await sql`delete from org_deletions where org_id = ${org_id}`.execute(tx);
          await sql`delete from organization where id = ${org_id}`.execute(tx);
        }
        return rows.length;
      });

      const runsDeleted = await db.transaction().execute(async (tx) => {
        const cutoff = sql`${now}::timestamptz - make_interval(days => ${RUN_RETENTION_DAYS})`;
        await sql`update usage_events u set run_id = null from runs r
          where u.org_id = r.org_id and u.run_id = r.id
            and r.finished_at is not null and r.finished_at < ${cutoff}`.execute(tx);
        const res = await sql`delete from runs
          where finished_at is not null and finished_at < ${cutoff}`.execute(tx);
        return Number(res.numAffectedRows ?? 0);
      });

      const sessionsDeleted = Number(
        (await sql`delete from session where "expiresAt" < ${now}`.execute(db)).numAffectedRows ??
          0,
      );
      const verificationsDeleted = Number(
        (await sql`delete from verification where "expiresAt" < ${now}`.execute(db))
          .numAffectedRows ?? 0,
      );
      const termsDropped = Number(
        (
          await sql`delete from terms_acceptances
            where user_id is null and pseudonymised_at < ${sevenYearsAgo}`.execute(db)
        ).numAffectedRows ?? 0,
      );

      const report = {
        orgsPurged,
        tombstonesDropped,
        runsDeleted,
        sessionsDeleted,
        verificationsDeleted,
        termsDropped,
      };
      log('info', 'retention pass', { ...report, orgsPurged: orgsPurged.length });
      return report;
    },

    /** Orgs whose data was purged: their AI ledger and cache rows go too (per container). */
    async purgedOrgIds(): Promise<string[]> {
      const { rows } = await sql<{ org_id: string }>`
        select org_id from org_deletions where purged_at is not null`.execute(db);
      return rows.map((r) => r.org_id);
    },
  };
}

/**
 * Removes purged orgs' rows from this container's AI cost ledger and vision cache (the
 * SQLite files under `<data dir>/cache/`, #255): each container that makes AI calls has
 * its own, so `iris admin retention` runs in each. Rows are matched by `org_id` and by
 * the `org=<id>:` key prefix (compared by substring, so `_` and `%` in an id are not
 * wildcards). A file that does not exist has nothing to purge. A running process's
 * in-memory LRU may hold such entries until their TTL; no request can reach them, since
 * a purged org has no keys.
 */
export function purgeOrgAiState(
  orgIds: string[],
  cacheDir: string,
): { ledgerRows: number; cacheRows: number } {
  let ledgerRows = 0;
  let cacheRows = 0;
  if (!orgIds.length) return { ledgerRows, cacheRows };
  const ledger = path.join(cacheDir, 'cost-tracking.db');
  if (fs.existsSync(ledger)) {
    const db = new Database(ledger);
    try {
      const hasOrg = (
        db
          .prepare(
            `select count(*) as n from pragma_table_info('cost_tracking') where name = 'org_id'`,
          )
          .get() as { n: number }
      ).n;
      if (hasOrg) {
        const del = db.prepare('delete from cost_tracking where org_id = ?');
        for (const id of orgIds) ledgerRows += del.run(id).changes;
      }
    } finally {
      db.close();
    }
  }
  const cache = path.join(cacheDir, 'vision-cache.db');
  if (fs.existsSync(cache)) {
    const db = new Database(cache);
    try {
      const del = db.prepare('delete from ai_vision_cache where substr(key, 1, length(?)) = ?');
      for (const id of orgIds) {
        const prefix = `org=${id}:`;
        cacheRows += del.run(prefix, prefix).changes;
      }
    } finally {
      db.close();
    }
  }
  return { ledgerRows, cacheRows };
}

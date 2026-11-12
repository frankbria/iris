import { sql, type Kysely } from 'kysely';
import { recordAudit } from '../audit-log';
import { errMessage, log } from '../log';
import { BILLING_ACTOR, orgSuspensions, suspendedSql } from '../org-suspension';

/**
 * Payment failure (#266): a grace period, then suspension, then restore.
 *
 * The Stripe webhook calls `trackPayment` with what it just read from Stripe. A failed
 * payment sets the org's deadline once (`org_billing.payment_grace_ends_at`); a sweep in the
 * API server suspends orgs past it, as an `org_suspensions` row by `billing`, so #348's
 * enforcement applies unchanged; a settled payment clears the deadline and lifts that
 * suspension, and only that one.
 */

const GRACE_DAYS_SETTING = 'IRIS_BILLING_GRACE_DAYS';
const DEFAULT_GRACE_DAYS = 7;
const MAX_GRACE_DAYS = 90;

/**
 * Days between a failed payment and suspension, from `IRIS_BILLING_GRACE_DAYS` (default 7).
 * @throws for anything but a whole number from 0 to 90, so a typo cannot mean "never"
 */
export function resolveGraceDays(env: NodeJS.ProcessEnv = process.env): number {
  const value = env[GRACE_DAYS_SETTING];
  if (!value) return DEFAULT_GRACE_DAYS;
  const days = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!(days <= MAX_GRACE_DAYS)) {
    throw new Error(
      `${GRACE_DAYS_SETTING} must be a whole number of days from 0 to ${MAX_GRACE_DAYS}`,
    );
  }
  return days;
}

/**
 * Records what Stripe says about the org's payment, on the webhook's transaction (which
 * holds the `org_billing` row lock). `failing` with no deadline yet starts the grace
 * period; not `failing` with one ends it and lifts a billing suspension. Anything else is
 * no change, so repeated and out-of-order events write nothing.
 */
export async function trackPayment(
  tx: Kysely<unknown>,
  orgId: string,
  { failing, graceDays = DEFAULT_GRACE_DAYS }: { failing: boolean; graceDays?: number },
): Promise<void> {
  const { rows } = await sql<{ ends: Date | null }>`
    select payment_grace_ends_at as ends from org_billing where org_id = ${orgId}`.execute(tx);
  if (failing === (rows[0].ends !== null)) return;
  if (failing) {
    const started = await sql<{ ends: Date }>`
      update org_billing
      set payment_grace_ends_at = now() + make_interval(days => ${graceDays}::int)
      where org_id = ${orgId} returning payment_grace_ends_at as ends`.execute(tx);
    await recordAudit(tx, {
      orgId,
      action: 'billing.grace_start',
      metadata: { graceEndsAt: started.rows[0].ends.toISOString() },
    });
    return;
  }
  await sql`update org_billing set payment_grace_ends_at = null, payment_suspended_at = null
    where org_id = ${orgId}`.execute(tx);
  // An operator's suspension (abuse, deletion) is not billing's to lift. Whose it is gets
  // read under the suspension lock, so one recorded over billing's at this moment stays.
  const { changed: suspensionLifted } = await orgSuspensions(tx).unsuspend(orgId, {
    reason: 'payment settled',
    actor: BILLING_ACTOR,
    onlyIfBy: BILLING_ACTOR,
  });
  await recordAudit(tx, { orgId, action: 'billing.restore', metadata: { suspensionLifted } });
}

/**
 * Suspends every org whose grace period ended by `now`, once per failed payment: an
 * operator's later `unsuspend-org` is an extension that stays. An org already suspended
 * (by an operator) is left for a later pass, which suspends it if that is lifted first.
 * Each org is re-read under the webhook's row lock, so a payment settling at the same
 * moment either is seen here or lifts the suspension after it. An org that fails is logged
 * and left for the next pass; the others are still suspended.
 *
 * @returns the orgs this call suspended
 */
export async function suspendOverdueOrgs(
  db: Kysely<unknown>,
  now: Date = new Date(),
): Promise<string[]> {
  const due = sql`payment_grace_ends_at <= ${now} and payment_suspended_at is null`;
  const { rows } = await sql<{ org_id: string }>`
    select org_id from org_billing
    where ${due} and not ${suspendedSql(sql.ref('org_billing.org_id'))}`.execute(db);
  const suspended: string[] = [];
  for (const { org_id: orgId } of rows) {
    const suspend = db.transaction().execute(async (tx) => {
      const locked = await sql<{ ends: Date }>`
        select payment_grace_ends_at as ends from org_billing
        where org_id = ${orgId} and ${due} for update`.execute(tx);
      if (!locked.rows.length) return false;
      const { changed } = await orgSuspensions(tx).suspend(orgId, {
        reason: 'payment failed and the grace period ended',
        actor: BILLING_ACTOR,
      });
      if (!changed) return false;
      await sql`update org_billing set payment_suspended_at = now()
        where org_id = ${orgId}`.execute(tx);
      await recordAudit(tx, {
        orgId,
        action: 'billing.suspend',
        metadata: { graceEndedAt: locked.rows[0].ends.toISOString() },
      });
      return true;
    });
    // One org's failure must not keep the orgs after it active: logged, retried next pass.
    const done = await suspend.catch((err: unknown) => {
      log('error', 'payment suspension failed', { orgId, err: errMessage(err) });
      return false;
    });
    if (done) suspended.push(orgId);
  }
  return suspended;
}

/** An org's failed payment, for the portal's banner. */
export interface PaymentState {
  graceEndsAt: Date;
  /** The org is suspended, and for this: its latest suspension is billing's. */
  suspended: boolean;
}

/** The org's unsettled failed payment, or `null` when it has none. */
export async function paymentState(
  db: Kysely<unknown>,
  orgId: string,
): Promise<PaymentState | null> {
  const { rows } = await sql<PaymentState>`
    select b.payment_grace_ends_at as "graceEndsAt", coalesce((
      select s.action = 'suspend' and s.actor = ${BILLING_ACTOR} from org_suspensions s
      where s.org_id = b.org_id order by s.created_at desc, s.id desc limit 1), false) as suspended
    from org_billing b
    where b.org_id = ${orgId} and b.payment_grace_ends_at is not null`.execute(db);
  return rows[0] ?? null;
}

/**
 * Runs `suspendOverdueOrgs` every `intervalMs` for the life of the process. A failed pass
 * is logged and the next one tries again. The timer does not keep the process alive.
 */
export function startGraceSweep(db: Kysely<unknown>, intervalMs = 60_000): NodeJS.Timeout {
  let running = false;
  const timer = setInterval(async () => {
    // A pass slower than the interval must not overlap the next: they would queue on locks.
    if (running) return;
    running = true;
    try {
      await suspendOverdueOrgs(db);
    } catch (err) {
      log('error', 'payment grace sweep failed', { err: errMessage(err) });
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return timer;
}

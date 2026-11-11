import { setTimeout as sleep } from 'timers/promises';
import Stripe from 'stripe';
import { sql, type Kysely } from 'kysely';
import { errMessage, log } from '../log';
import { metrics } from '../metrics';

/**
 * Managed AI usage reported to a Stripe meter (#264, ADR 0001 §6). `usage_events` is the
 * record; Stripe is fed from it: one meter event per `managed` row, in micro-USD of
 * provider cost, at the time the usage happened. BYOK and platform usage are never sent.
 */

/** The `event_name` of the Stripe meter the operator creates (runbook "Stripe billing"). */
export const METER_EVENT_NAME = 'iris_managed_ai_micro_usd';

export interface MeterEvent {
  /** Stable per usage row: Stripe counts a resent identifier once. */
  identifier: string;
  customerId: string;
  microUsd: number;
  at: Date;
}

/** The meter as IRIS uses it: Stripe (`stripeMeters`), or an in-test one. */
export interface UsageMeters {
  /** @throws MeterEventRejected when Stripe refuses this event; anything else is an outage */
  send(event: MeterEvent): Promise<void>;
  /** The meter's total for a customer in `[from, to)`, both on whole minutes. */
  total(customerId: string, from: Date, to: Date): Promise<number>;
}

/** Stripe refused this one event (an invalid request): resending it as it is cannot work. */
export class MeterEventRejected extends Error {}

export function stripeMeters(stripe: Stripe): UsageMeters {
  let meterId: string | undefined;
  async function findMeter(): Promise<string> {
    for await (const meter of stripe.billing.meters.list({ status: 'active', limit: 100 }))
      if (meter.event_name === METER_EVENT_NAME) return meter.id;
    throw new Error(`No active Stripe meter with the event name ${METER_EVENT_NAME}`);
  }
  const seconds = (time: Date) => Math.floor(time.getTime() / 1000);
  return {
    async send(event) {
      try {
        await stripe.billing.meterEvents.create(
          {
            event_name: METER_EVENT_NAME,
            identifier: event.identifier,
            timestamp: seconds(event.at),
            payload: { stripe_customer_id: event.customerId, value: String(event.microUsd) },
          },
          { idempotencyKey: event.identifier },
        );
      } catch (err) {
        // A refused key is an invalid request to Stripe too, but it fails every event.
        if (err instanceof Stripe.errors.StripeInvalidRequestError && err.statusCode !== 401)
          throw new MeterEventRejected(err.message);
        throw err;
      }
    },
    async total(customerId, from, to) {
      meterId ??= await findMeter();
      let total = 0;
      for await (const summary of stripe.billing.meters.listEventSummaries(meterId, {
        customer: customerId,
        start_time: seconds(from),
        end_time: seconds(to),
        limit: 100,
      }))
        total += summary.aggregated_value;
      return total;
    },
  };
}

const meterEvents = metrics.counter(
  'iris_stripe_meter_events_total',
  'Managed usage rows offered to the Stripe meter, by outcome (sent, rejected)',
);

/** Stripe takes a timestamp up to 35 days old; a day inside that, against clock skew. */
const REPORTABLE_DAYS = 34;

const MICRO_USD = sql`round(u.quantity * u.unit_cost_usd * 1000000)`;

export interface MeterPass {
  sent: number;
  rejected: number;
}

/**
 * One pass: sends every unreported managed row of an org with a Stripe customer and marks
 * each as Stripe accepts it. A session advisory lock lets one pass run at a time: `null`
 * when another holds it. A row Stripe rejects is left for the next pass; any other failure
 * ends this one. A crash between send and mark resends the row with the same identifier
 * and idempotency key, which Stripe counts once (it promises that for 24 hours).
 * shortcut: one request per row, in sequence (Stripe allows one concurrent call per
 * customer), upgrade to meter event streams when a pass no longer fits its interval.
 */
export async function reportManagedUsage(
  db: Kysely<unknown>,
  meters: UsageMeters,
  { pageSize = 100 }: { pageSize?: number } = {},
): Promise<MeterPass | null> {
  return db.connection().execute(async (connection) => {
    const lock = sql`hashtext('stripe-meter-report')`;
    const { rows: locks } = await sql<{ locked: boolean }>`
      select pg_try_advisory_lock(${lock}) as locked`.execute(connection);
    if (!locks[0].locked) return null;
    const pass: MeterPass = { sent: 0, rejected: 0 };
    let firstRejection: string | undefined;
    try {
      // Keyset by id, so rejected rows (still unreported) are not read again this pass.
      for (let after = '00000000-0000-0000-0000-000000000000'; ;) {
        const { rows } = await sql<{
          id: string;
          customer_id: string;
          micro_usd: string;
          created_at: Date;
        }>`
          select u.id, b.stripe_customer_id as customer_id, ${MICRO_USD} as micro_usd, u.created_at
          from usage_events u join org_billing b on b.org_id = u.org_id
          where u.billing_mode = 'managed' and u.stripe_reported_at is null
            and u.created_at > now() - make_interval(days => ${REPORTABLE_DAYS})
            and u.id > ${after}
          order by u.id limit ${pageSize}`.execute(connection);
        for (const row of rows) {
          after = row.id;
          const microUsd = Number(row.micro_usd);
          // A row that cost nothing adds nothing to the meter: marked, not sent.
          if (microUsd > 0) {
            try {
              await meters.send({
                identifier: `usage-${row.id}`,
                customerId: row.customer_id,
                microUsd,
                at: row.created_at,
              });
            } catch (err) {
              if (!(err instanceof MeterEventRejected)) throw err;
              pass.rejected++;
              firstRejection ??= err.message;
              continue;
            }
            pass.sent++;
          }
          await sql`update usage_events set stripe_reported_at = now()
            where id = ${row.id}`.execute(connection);
        }
        if (rows.length < pageSize) break;
      }
    } finally {
      meterEvents.inc({ outcome: 'sent' }, pass.sent);
      meterEvents.inc({ outcome: 'rejected' }, pass.rejected);
      if (pass.sent || pass.rejected)
        log(pass.rejected ? 'error' : 'info', 'stripe meter report', {
          ...pass,
          ...(firstRejection !== undefined && { firstRejection }),
        });
      await sql`select pg_advisory_unlock(${lock})`.execute(connection);
    }
    return pass;
  });
}

/**
 * The worker's periodic report: a pass every `intervalMs` until `signal` aborts. A failed
 * pass (Stripe or the database down) is logged and the next one resumes where it stopped.
 */
export async function runMeterReports(options: {
  db: Kysely<unknown>;
  meters: UsageMeters;
  signal: AbortSignal;
  intervalMs?: number;
}): Promise<void> {
  const { db, meters, signal, intervalMs = 5 * 60_000 } = options;
  while (!signal.aborted) {
    try {
      await reportManagedUsage(db, meters);
    } catch (err) {
      log('error', 'stripe meter report failed', { err: errMessage(err) });
    }
    // Rejects on abort: the loop condition ends it.
    await sleep(intervalMs, undefined, { signal }).catch(() => undefined);
  }
}

export interface MeterReconciliationRow {
  orgId: string;
  /** `null`: the org has no Stripe customer, so nothing of it can be on the meter. */
  customerId: string | null;
  ledgerMicroUsd: number;
  /** The part of the ledger total priced at an estimated rate (#243). */
  estimatedMicroUsd: number;
  /** The part of the ledger total not sent to Stripe yet. */
  unreportedMicroUsd: number;
  stripeMicroUsd: number | null;
  /** Ledger minus Stripe: positive is usage Stripe does not have, negative is extra. */
  differenceMicroUsd: number;
}

const MINUTE_MS = 60_000;
const onTheMinute = (time: Date) => time.getTime() % MINUTE_MS === 0;

/**
 * The reconciliation report for `[from, to)`: per org with managed usage in the period,
 * the ledger's total against the Stripe meter's. Stripe aggregates by the minute and
 * asynchronously, so the period is in whole minutes and a just-sent event may be missing.
 */
export async function meterReconciliation(
  db: Kysely<unknown>,
  meters: UsageMeters,
  { from, to }: { from: Date; to: Date },
): Promise<MeterReconciliationRow[]> {
  if (!onTheMinute(from) || !onTheMinute(to) || !(from < to))
    throw new Error('The period must run from one time to a later one, both on whole minutes');
  const { rows } = await sql<{
    org_id: string;
    customer_id: string | null;
    ledger: string;
    estimated: string;
    unreported: string;
  }>`
    select u.org_id, b.stripe_customer_id as customer_id,
           sum(${MICRO_USD}) as ledger,
           coalesce(sum(${MICRO_USD}) filter (where u.estimated), 0) as estimated,
           coalesce(sum(${MICRO_USD}) filter (where u.stripe_reported_at is null), 0) as unreported
    from usage_events u left join org_billing b on b.org_id = u.org_id
    where u.billing_mode = 'managed' and u.created_at >= ${from} and u.created_at < ${to}
    group by u.org_id, b.stripe_customer_id
    order by u.org_id`.execute(db);
  const report: MeterReconciliationRow[] = [];
  for (const row of rows) {
    const ledgerMicroUsd = Number(row.ledger);
    const stripeMicroUsd = row.customer_id ? await meters.total(row.customer_id, from, to) : null;
    report.push({
      orgId: row.org_id,
      customerId: row.customer_id,
      ledgerMicroUsd,
      estimatedMicroUsd: Number(row.estimated),
      unreportedMicroUsd: Number(row.unreported),
      stripeMicroUsd,
      differenceMicroUsd: ledgerMicroUsd - (stripeMicroUsd ?? 0),
    });
  }
  return report;
}

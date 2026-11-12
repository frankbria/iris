/**
 * Managed AI usage reported to a Stripe meter (#264) over real Postgres.
 *
 * Test strategy: a throwaway database migrated to latest. Stripe is played by an in-test
 * meter that keeps events by identifier, as Stripe does: a resent identifier is not a
 * second event. The pass, its retries and the reconciliation report are checked against
 * hand-computed totals. One call to a real test-mode meter runs only when
 * `IRIS_TEST_STRIPE_SECRET_KEY` is set (skipped under CI too, until the owner's test
 * account exists).
 */

import { randomBytes } from 'crypto';
import { Kysely, sql } from 'kysely';
import { Client } from 'pg';
import { createPostgresDb } from '../../src/db/postgres';
import { migrateToLatest } from '../../src/db/migrate';
import { stripeClient } from '../../src/billing/stripe';
import {
  METER_EVENT_NAME,
  MeterEventRejected,
  meterReconciliation,
  reportManagedUsage,
  runMeterReports,
  stripeMeters,
  type MeterEvent,
  type UsageMeters,
} from '../../src/billing/stripe-meter';
import { usageLedger, type UsageEvent } from '../../src/billing/usage';

const ADMIN_URL = process.env.IRIS_TEST_DATABASE_URL;
if (!ADMIN_URL) {
  if (process.env.CI) throw new Error('IRIS_TEST_DATABASE_URL is required in CI');
  console.warn('Skipping Stripe meter tests: set IRIS_TEST_DATABASE_URL');
}
const STRIPE_KEY = process.env.IRIS_TEST_STRIPE_SECRET_KEY;
if (!STRIPE_KEY)
  console.warn('Skipping the Stripe test-mode meter: set IRIS_TEST_STRIPE_SECRET_KEY');

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Stripe's side of a meter: events by identifier, summed per customer and period. */
function inTestMeter() {
  const events = new Map<string, MeterEvent>();
  const calls: MeterEvent[] = [];
  const meter: UsageMeters = {
    async send(event) {
      calls.push(event);
      if (!events.has(event.identifier)) events.set(event.identifier, event);
    },
    async total(customerId, from, to) {
      return [...events.values()]
        .filter((e) => e.customerId === customerId && e.at >= from && e.at < to)
        .reduce((sum, e) => sum + e.microUsd, 0);
    },
  };
  return { meter, events, calls };
}

(ADMIN_URL ? describe : describe.skip)('Stripe meter reporting', () => {
  const dbName = `iris_meter_${process.pid}_${randomBytes(4).toString('hex')}`;
  let db: Kysely<unknown>;
  let orgCount = 0;

  async function admin(query: string): Promise<void> {
    const client = new Client({ connectionString: ADMIN_URL });
    await client.connect();
    try {
      await client.query(query);
    } finally {
      await client.end();
    }
  }

  /** A new org; with `customer`, its Stripe customer is `cus_<orgId>`. */
  async function newOrg({ customer = true } = {}): Promise<string> {
    const orgId = `org-${++orgCount}`;
    await sql`insert into organization (id, name, slug, "createdAt")
      values (${orgId}, ${orgId}, ${orgId}, now())`.execute(db);
    if (customer)
      await sql`insert into org_billing (org_id, stripe_customer_id)
        values (${orgId}, ${'cus_' + orgId})`.execute(db);
    return orgId;
  }

  const managedCall = (key: string, unitCostUsd: number, more: Partial<UsageEvent> = {}) =>
    ({
      kind: 'text_call',
      quantity: 1,
      billingMode: 'managed',
      idempotencyKey: key,
      unitCostUsd,
      ...more,
    }) satisfies UsageEvent;

  async function unreportedKeys(orgId: string): Promise<string[]> {
    const { rows } = await sql<{ idempotency_key: string }>`
      select idempotency_key from usage_events
      where org_id = ${orgId} and stripe_reported_at is null order by idempotency_key`.execute(db);
    return rows.map((r) => r.idempotency_key);
  }

  beforeAll(async () => {
    await admin(`CREATE DATABASE "${dbName}"`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${dbName}`;
    db = createPostgresDb(url.toString());
    await migrateToLatest(db);
  });

  // Each test reports only its own rows: nothing is left unreported for the next one.
  afterEach(async () => {
    await sql`update usage_events set stripe_reported_at = now()
      where stripe_reported_at is null`.execute(db);
  });

  afterAll(async () => {
    await db?.destroy();
    await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  });

  describe('reportManagedUsage', () => {
    it('sends each managed row once, as micro-USD at the time it happened', async () => {
      const orgId = await newOrg();
      const at = new Date(Date.now() - 2 * DAY_MS);
      await usageLedger(db).record(orgId, [
        managedCall('a', 0.0125, { at }),
        managedCall('b', 0.000001, { quantity: 3, kind: 'vision_call' }),
      ]);
      const { meter, calls } = inTestMeter();

      expect(await reportManagedUsage(db, meter)).toEqual({ sent: 2, rejected: 0 });

      const { rows } = await sql<{ id: string; idempotency_key: string }>`
        select id, idempotency_key from usage_events where org_id = ${orgId}`.execute(db);
      const idOf = (key: string) => rows.find((r) => r.idempotency_key === key)!.id;
      expect(calls).toHaveLength(2);
      expect(calls).toEqual(
        expect.arrayContaining([
          { identifier: `usage-${idOf('a')}`, customerId: `cus_${orgId}`, microUsd: 12_500, at },
          expect.objectContaining({ identifier: `usage-${idOf('b')}`, microUsd: 3 }),
        ]),
      );
      expect(await unreportedKeys(orgId)).toEqual([]);

      // Nothing is left: a second pass calls Stripe for nothing.
      expect(await reportManagedUsage(db, meter)).toEqual({ sent: 0, rejected: 0 });
      expect(calls).toHaveLength(2);
    });

    it('never sends BYOK or platform usage', async () => {
      const orgId = await newOrg();
      await usageLedger(db).record(orgId, [
        {
          kind: 'text_call',
          quantity: 1,
          billingMode: 'byok',
          idempotencyKey: 'own-key',
          unitCostUsd: 5,
        },
        { kind: 'browser_minutes', quantity: 30, idempotencyKey: 'minutes' },
        { kind: 'a11y_job', quantity: 1, idempotencyKey: 'job' },
        managedCall('managed', 0.02),
      ]);
      const { meter, calls } = inTestMeter();

      expect(await reportManagedUsage(db, meter)).toEqual({ sent: 1, rejected: 0 });

      expect(calls.map((c) => c.microUsd)).toEqual([20_000]);
      expect(await meter.total(`cus_${orgId}`, new Date(0), new Date(Date.now() + DAY_MS))).toBe(
        20_000,
      );
      // They are not billed and not waiting to be: only the managed row was ever a candidate.
      expect(await unreportedKeys(orgId)).toEqual(['job', 'minutes', 'own-key']);
    });

    it('resends with the same identifier when the mark was lost, so Stripe counts it once', async () => {
      const orgId = await newOrg();
      await usageLedger(db).record(orgId, [managedCall('once', 0.5)]);
      const { meter, events, calls } = inTestMeter();
      await reportManagedUsage(db, meter);
      // A crash after Stripe accepted the event and before the row was marked.
      await sql`update usage_events set stripe_reported_at = null where org_id = ${orgId}`.execute(
        db,
      );

      expect(await reportManagedUsage(db, meter)).toEqual({ sent: 1, rejected: 0 });

      expect(calls).toHaveLength(2);
      expect(calls[1].identifier).toBe(calls[0].identifier);
      expect(events.size).toBe(1);
      expect(await meter.total(`cus_${orgId}`, new Date(0), new Date(Date.now() + DAY_MS))).toBe(
        500_000,
      );
    });

    it('leaves a row Stripe rejects unreported and still sends the others', async () => {
      const orgId = await newOrg();
      await usageLedger(db).record(orgId, [
        managedCall('bad', 0.03),
        managedCall('good-1', 0.01),
        managedCall('good-2', 0.01),
      ]);
      const { meter } = inTestMeter();
      const rejecting: UsageMeters = {
        ...meter,
        async send(event) {
          if (event.microUsd === 30_000) throw new MeterEventRejected('No such customer');
          await meter.send(event);
        },
      };

      expect(await reportManagedUsage(db, rejecting)).toEqual({ sent: 2, rejected: 1 });
      expect(await unreportedKeys(orgId)).toEqual(['bad']);

      // Once Stripe takes it (the customer was fixed), the next pass sends it.
      expect(await reportManagedUsage(db, meter)).toEqual({ sent: 1, rejected: 0 });
      expect(await unreportedKeys(orgId)).toEqual([]);
    });

    it('ends the pass when Stripe is unreachable, and the next pass sends the rest', async () => {
      const orgId = await newOrg();
      await usageLedger(db).record(orgId, [
        managedCall('x', 0.01),
        managedCall('y', 0.01),
        managedCall('z', 0.01),
      ]);
      const { meter, events } = inTestMeter();
      let sends = 0;
      const failing: UsageMeters = {
        ...meter,
        async send(event) {
          if (++sends === 2) throw new Error('connect ETIMEDOUT');
          await meter.send(event);
        },
      };

      await expect(reportManagedUsage(db, failing)).rejects.toThrow('connect ETIMEDOUT');
      // The one Stripe accepted before the outage is marked; the pass did not go on.
      expect(sends).toBe(2);
      expect(await unreportedKeys(orgId)).toHaveLength(2);

      expect(await reportManagedUsage(db, meter)).toEqual({ sent: 2, rejected: 0 });
      expect(events.size).toBe(3);
      // The lock was released when the failed pass ended.
      expect(await reportManagedUsage(db, meter)).toEqual({ sent: 0, rejected: 0 });
    });

    it('lets only one pass run at a time: a second one sends nothing', async () => {
      const orgId = await newOrg();
      await usageLedger(db).record(orgId, [managedCall('p', 0.01), managedCall('q', 0.01)]);
      const { meter, calls } = inTestMeter();
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      let entered!: () => void;
      const inFirstSend = new Promise<void>((resolve) => (entered = resolve));
      const slow: UsageMeters = {
        ...meter,
        async send(event) {
          entered();
          await released;
          await meter.send(event);
        },
      };

      const first = reportManagedUsage(db, slow);
      await inFirstSend;
      // Released whatever the second pass did: a pass left blocked would hang the file.
      const second = await reportManagedUsage(db, meter).finally(release);
      expect(second).toBeNull();

      expect(await first).toEqual({ sent: 2, rejected: 0 });
      expect(calls).toHaveLength(2);
      expect(await unreportedKeys(orgId)).toEqual([]);
    });

    it('stops between two rows when told to, leaving the rest for the next pass', async () => {
      const orgId = await newOrg();
      await usageLedger(db).record(orgId, [
        managedCall('s-1', 0.01),
        managedCall('s-2', 0.01),
        managedCall('s-3', 0.01),
      ]);
      const { meter, calls } = inTestMeter();
      const stop = new AbortController();
      const stopping: UsageMeters = {
        ...meter,
        async send(event) {
          await meter.send(event);
          stop.abort();
        },
      };

      expect(await reportManagedUsage(db, stopping, { signal: stop.signal })).toEqual({
        sent: 1,
        rejected: 0,
      });
      expect(calls).toHaveLength(1);
      // The row Stripe took is marked; the lock is free for the next pass.
      expect(await unreportedKeys(orgId)).toHaveLength(2);
      expect(await reportManagedUsage(db, meter)).toEqual({ sent: 2, rejected: 0 });
    });

    it('does not send what Stripe cannot take: no customer, or older than its window', async () => {
      const noCustomer = await newOrg({ customer: false });
      const orgId = await newOrg();
      await usageLedger(db).record(noCustomer, [managedCall('granted', 0.01)]);
      await usageLedger(db).record(orgId, [
        managedCall('too-old', 0.01, { at: new Date(Date.now() - 40 * DAY_MS) }),
        managedCall('recent', 0.01, { at: new Date(Date.now() - 30 * DAY_MS) }),
      ]);
      const { meter, calls } = inTestMeter();

      expect(await reportManagedUsage(db, meter)).toEqual({ sent: 1, rejected: 0 });

      expect(calls.map((c) => c.customerId)).toEqual([`cus_${orgId}`]);
      expect(await unreportedKeys(noCustomer)).toEqual(['granted']);
      expect(await unreportedKeys(orgId)).toEqual(['too-old']);
    });

    it('marks a row that cost nothing without calling Stripe', async () => {
      const orgId = await newOrg();
      await usageLedger(db).record(orgId, [managedCall('free', 0)]);
      const { meter, calls } = inTestMeter();

      expect(await reportManagedUsage(db, meter)).toEqual({ sent: 0, rejected: 0 });

      expect(calls).toEqual([]);
      expect(await unreportedKeys(orgId)).toEqual([]);
    });

    it('works through more rows than one page', async () => {
      const orgId = await newOrg();
      await usageLedger(db).record(
        orgId,
        Array.from({ length: 7 }, (_, n) => managedCall(`n-${n}`, 0.001)),
      );
      const { meter, events } = inTestMeter();

      expect(await reportManagedUsage(db, meter, { pageSize: 3 })).toEqual({
        sent: 7,
        rejected: 0,
      });
      expect(events.size).toBe(7);
    });
  });

  describe('runMeterReports', () => {
    it('reports on every interval until stopped, and survives a failing pass', async () => {
      const orgId = await newOrg();
      await usageLedger(db).record(orgId, [managedCall('loop', 0.01)]);
      const { meter, events } = inTestMeter();
      const stop = new AbortController();
      let sends = 0;
      const flaky: UsageMeters = {
        ...meter,
        async send(event) {
          if (++sends === 1) throw new Error('Stripe is down');
          await meter.send(event);
          stop.abort();
        },
      };

      await runMeterReports({ db, meters: flaky, signal: stop.signal, intervalMs: 5 });

      expect(sends).toBe(2);
      expect(events.size).toBe(1);
      expect(await unreportedKeys(orgId)).toEqual([]);
    });

    it('returns at once when already stopped', async () => {
      const { meter, calls } = inTestMeter();
      const stop = new AbortController();
      stop.abort();
      await runMeterReports({ db, meters: meter, signal: stop.signal, intervalMs: 5 });
      expect(calls).toEqual([]);
    });
  });

  describe('meterReconciliation', () => {
    const JUNE = { from: new Date('2026-06-01T00:00:00Z'), to: new Date('2026-07-01T00:00:00Z') };
    const inJune = new Date('2026-06-15T12:00:00Z');

    it('sets the ledger total against the Stripe total per org for the period', async () => {
      const matching = await newOrg();
      const behind = await newOrg();
      const noCustomer = await newOrg({ customer: false });
      const { meter } = inTestMeter();
      // June rows are older than Stripe's window, so this plays a pass that ran in June.
      const report = async (orgId: string, events: UsageEvent[]) => {
        await usageLedger(db).record(orgId, events);
        const { rows } = await sql<{ id: string; micro_usd: string; created_at: Date }>`
          update usage_events set stripe_reported_at = now()
          where org_id = ${orgId} and stripe_reported_at is null
          returning id, round(quantity * unit_cost_usd * 1000000) as micro_usd, created_at`.execute(
          db,
        );
        for (const row of rows)
          await meter.send({
            identifier: `usage-${row.id}`,
            customerId: `cus_${orgId}`,
            microUsd: Number(row.micro_usd),
            at: row.created_at,
          });
      };
      await report(matching, [
        managedCall('m-1', 0.25, { at: inJune }),
        managedCall('m-2', 0.5, { at: inJune, estimated: true }),
        // Outside the period, and not managed: neither is in the totals.
        managedCall('m-july', 9, { at: new Date('2026-07-01T00:00:00Z') }),
      ]);
      await usageLedger(db).record(matching, [
        {
          kind: 'text_call',
          quantity: 1,
          billingMode: 'byok',
          idempotencyKey: 'm-byok',
          unitCostUsd: 7,
          at: inJune,
        },
      ]);
      await report(behind, [managedCall('b-1', 0.1, { at: inJune })]);
      await usageLedger(db).record(behind, [managedCall('b-unsent', 0.04, { at: inJune })]);
      await usageLedger(db).record(noCustomer, [managedCall('n-1', 0.02, { at: inJune })]);

      const rows = await meterReconciliation(db, meter, JUNE);

      expect(rows.filter((r) => [matching, behind, noCustomer].includes(r.orgId))).toEqual([
        {
          orgId: matching,
          customerId: `cus_${matching}`,
          ledgerMicroUsd: 750_000,
          estimatedMicroUsd: 500_000,
          unreportedMicroUsd: 0,
          stripeMicroUsd: 750_000,
          differenceMicroUsd: 0,
        },
        {
          orgId: behind,
          customerId: `cus_${behind}`,
          ledgerMicroUsd: 140_000,
          estimatedMicroUsd: 0,
          unreportedMicroUsd: 40_000,
          stripeMicroUsd: 100_000,
          differenceMicroUsd: 40_000,
        },
        {
          orgId: noCustomer,
          customerId: null,
          ledgerMicroUsd: 20_000,
          estimatedMicroUsd: 0,
          unreportedMicroUsd: 20_000,
          stripeMicroUsd: null,
          differenceMicroUsd: 20_000,
        },
      ]);
    });

    it('shows a Stripe total above the ledger as a negative difference', async () => {
      const orgId = await newOrg();
      await usageLedger(db).record(orgId, [managedCall('d-1', 0.1, { at: inJune })]);
      const { meter } = inTestMeter();
      await meter.send({
        identifier: 'usage-d-1',
        customerId: `cus_${orgId}`,
        microUsd: 100_000,
        at: inJune,
      });
      await meter.send({
        identifier: 'stray',
        customerId: `cus_${orgId}`,
        microUsd: 100_000,
        at: inJune,
      });

      const rows = await meterReconciliation(db, meter, JUNE);

      expect(rows.find((r) => r.orgId === orgId)).toMatchObject({
        ledgerMicroUsd: 100_000,
        stripeMicroUsd: 200_000,
        differenceMicroUsd: -100_000,
      });
    });

    it('keeps the other orgs when Stripe cannot be asked about one', async () => {
      const unknown = await newOrg();
      const fine = await newOrg();
      const august = { at: new Date('2026-08-15T12:00:00Z') };
      await usageLedger(db).record(unknown, [managedCall('u-1', 0.1, august)]);
      await usageLedger(db).record(fine, [managedCall('f-1', 0.2, august)]);
      const { meter } = inTestMeter();
      const partial: UsageMeters = {
        ...meter,
        async total(customerId, from, to) {
          if (customerId === `cus_${unknown}`) throw new Error('No such customer');
          return meter.total(customerId, from, to);
        },
      };

      const rows = await meterReconciliation(db, partial, {
        from: new Date('2026-08-01T00:00:00Z'),
        to: new Date('2026-09-01T00:00:00Z'),
      });

      expect(rows.find((r) => r.orgId === unknown)).toMatchObject({
        stripeMicroUsd: null,
        differenceMicroUsd: 100_000,
        stripeError: 'No such customer',
      });
      const other = rows.find((r) => r.orgId === fine)!;
      expect(other).toMatchObject({ ledgerMicroUsd: 200_000, stripeMicroUsd: 0 });
      expect(other).not.toHaveProperty('stripeError');
    });

    it.each([
      ['an invalid date', new Date('nonsense'), JUNE.to],
      ['a start off the minute', new Date('2026-06-01T00:00:30Z'), JUNE.to],
      ['an end off the minute', JUNE.from, new Date('2026-07-01T00:00:00.500Z')],
      ['an empty period', JUNE.to, JUNE.from],
    ])('refuses %s', async (_name, from, to) => {
      await expect(meterReconciliation(db, inTestMeter().meter, { from, to })).rejects.toThrow(
        /whole minutes/,
      );
    });
  });

  (STRIPE_KEY ? describe : describe.skip)('against Stripe test mode', () => {
    it('sends a managed row to the real meter and reads the meter back', async () => {
      const stripe = stripeClient({ secretKey: STRIPE_KEY! });
      let exists = false;
      for await (const meter of stripe.billing.meters.list({ status: 'active' }))
        exists ||= meter.event_name === METER_EVENT_NAME;
      if (!exists)
        await stripe.billing.meters.create({
          display_name: 'IRIS managed AI (micro-USD)',
          event_name: METER_EVENT_NAME,
          default_aggregation: { formula: 'sum' },
        });
      const customer = await stripe.customers.create({ metadata: { test: 'iris-meter' } });
      const orgId = await newOrg({ customer: false });
      await sql`insert into org_billing (org_id, stripe_customer_id)
        values (${orgId}, ${customer.id})`.execute(db);
      await usageLedger(db).record(orgId, [managedCall('real', 0.0125)]);
      const meters = stripeMeters(stripe);

      expect(await reportManagedUsage(db, meters)).toEqual({ sent: 1, rejected: 0 });
      expect(await unreportedKeys(orgId)).toEqual([]);
      // Stripe aggregates asynchronously, so the total is only read, not compared.
      const from = new Date(Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS - 60 * MINUTE_MS);
      const total = await meters.total(
        customer.id,
        from,
        new Date(from.getTime() + 120 * MINUTE_MS),
      );
      expect(total).toBeGreaterThanOrEqual(0);
    });
  });
});

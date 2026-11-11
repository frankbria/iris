/**
 * The Stripe webhook over real Postgres (#345).
 *
 * Test strategy: no Stripe account. Each payload is signed with the SDK's own
 * `generateTestHeaderString` and goes through the real `constructEvent` verification.
 * An event only names the customer: the handler re-reads the customer's subscriptions,
 * here from an in-test reader whose fixtures the tests change to play Stripe's current
 * state. So the order events arrive in must not matter, only that state.
 */

import { randomBytes } from 'crypto';
import { Kysely, sql } from 'kysely';
import { Client } from 'pg';
import Stripe from 'stripe';
import { createPostgresDb } from '../../src/db/postgres';
import { migrateToLatest } from '../../src/db/migrate';
import { orgEntitlements } from '../../src/billing/plans';
import { stripeWebhookHandler, type SubscriptionSnapshot } from '../../src/billing/stripe-webhook';
import type { StripeConfig } from '../../src/billing/stripe';
import { paymentState, startGraceSweep, suspendOverdueOrgs } from '../../src/billing/payment-grace';
import { orgSuspensions } from '../../src/org-suspension';
import { offboarding } from '../../src/offboarding';
import { postgresKeyStore } from '../../src/api-key-auth';
import { postgresJobs } from '../../src/history-store';

const ADMIN_URL = process.env.IRIS_TEST_DATABASE_URL;
if (!ADMIN_URL) {
  if (process.env.CI) throw new Error('IRIS_TEST_DATABASE_URL is required in CI');
  console.warn('Skipping Stripe webhook tests: set IRIS_TEST_DATABASE_URL');
}

const CONFIG: StripeConfig = {
  secretKey: 'sk_test_unused',
  webhookSecret: 'whsec_test_secret',
  prices: { pro: 'price_pro', team: 'price_team' },
};

const signer = new Stripe(CONFIG.secretKey);

/** Stripe's current subscriptions per customer, as the tests set them. */
const stripeState = new Map<string, SubscriptionSnapshot[]>();
const readsByCustomer: string[] = [];
let stripeDown = false;

async function readSubscriptions(customerId: string): Promise<SubscriptionSnapshot[]> {
  readsByCustomer.push(customerId);
  if (stripeDown) throw new Error('Stripe API unavailable');
  return stripeState.get(customerId) ?? [];
}

const snapshot = (
  id: string,
  status: string,
  priceId: string,
  created: number,
): SubscriptionSnapshot => ({ id, status, priceId, created });

let eventCounter = 0;
/** A handled event about `customer`; only the type and the customer are read. */
function event(type: string, customer: string) {
  return {
    id: `evt_${++eventCounter}_${randomBytes(3).toString('hex')}`,
    object: 'event',
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: `obj_${eventCounter}`, customer } },
  };
}

function signed(payload: object, secret = CONFIG.webhookSecret) {
  const body = JSON.stringify(payload);
  return { body, signature: signer.webhooks.generateTestHeaderString({ payload: body, secret }) };
}

(ADMIN_URL ? describe : describe.skip)('stripeWebhookHandler', () => {
  const dbName = `iris_stripe_${process.pid}_${randomBytes(4).toString('hex')}`;
  let db: Kysely<unknown>;
  let handle: ReturnType<typeof stripeWebhookHandler>;

  async function admin(query: string): Promise<void> {
    const client = new Client({ connectionString: ADMIN_URL });
    await client.connect();
    try {
      await client.query(query);
    } finally {
      await client.end();
    }
  }

  async function deliver(payload: object) {
    const { body, signature } = signed(payload);
    return handle(body, signature);
  }

  async function billing(orgId: string) {
    const { rows } = await sql<{ subscription: string | null; status: string | null }>`
      select stripe_subscription_id as subscription, subscription_status as status
      from org_billing where org_id = ${orgId}`.execute(db);
    return { ...rows[0], plan: (await orgEntitlements(db).get(orgId)).plan };
  }

  async function auditEntries(orgId: string, action: string | null = null) {
    const { rows } = await sql<{ n: string }>`select count(*) as n from audit_log
      where org_id = ${orgId} and (${action}::text is null or action = ${action})`.execute(db);
    return Number(rows[0].n);
  }

  async function recordedEvents(orgId: string) {
    const { rows } = await sql<{ n: string }>`select count(*) as n from stripe_events
      where org_id = ${orgId}`.execute(db);
    return Number(rows[0].n);
  }

  async function newOrg(orgId: string, customerId: string) {
    await sql`insert into organization (id, name, slug, "createdAt")
      values (${orgId}, ${orgId}, ${orgId}, now())`.execute(db);
    await sql`insert into org_billing (org_id, stripe_customer_id)
      values (${orgId}, ${customerId})`.execute(db);
  }

  beforeAll(async () => {
    await admin(`CREATE DATABASE "${dbName}"`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${dbName}`;
    db = createPostgresDb(url.toString());
    await migrateToLatest(db);
    handle = stripeWebhookHandler(db, CONFIG, { readSubscriptions });
  });

  beforeEach(() => {
    readsByCustomer.length = 0;
    stripeDown = false;
  });

  afterAll(async () => {
    await db?.destroy();
    await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  });

  it('refuses a payload whose signature is wrong, missing or for another secret', async () => {
    await newOrg('org-sig', 'cus_sig');
    stripeState.set('cus_sig', [snapshot('sub_sig', 'active', 'price_pro', 1)]);
    const payload = event('customer.subscription.updated', 'cus_sig');
    const { body, signature } = signed(payload);
    expect(await handle(body.replace('cus_sig', 'cus_other'), signature)).toBe('invalid_signature');
    expect(await handle(body, undefined)).toBe('invalid_signature');
    expect(await handle(body, signed(payload, 'whsec_other').signature)).toBe('invalid_signature');
    expect(await billing('org-sig')).toEqual({ subscription: null, status: null, plan: 'free' });
    expect(readsByCustomer).toEqual([]);
    // Positive control: the same body, correctly signed, is applied.
    expect(await handle(body, signature)).toBe('applied');
    expect((await billing('org-sig')).plan).toBe('pro');
  });

  it('subscribe, upgrade, cancel: follows Stripe through each event', async () => {
    await newOrg('org-life', 'cus_life');
    stripeState.set('cus_life', [snapshot('sub_life', 'active', 'price_pro', 10)]);
    expect(await deliver(event('checkout.session.completed', 'cus_life'))).toBe('applied');
    expect(await billing('org-life')).toEqual({
      subscription: 'sub_life',
      status: 'active',
      plan: 'pro',
    });

    stripeState.set('cus_life', [snapshot('sub_life', 'active', 'price_team', 10)]);
    expect(await deliver(event('customer.subscription.updated', 'cus_life'))).toBe('applied');
    expect((await billing('org-life')).plan).toBe('team');

    stripeState.set('cus_life', [snapshot('sub_life', 'canceled', 'price_team', 10)]);
    expect(await deliver(event('customer.subscription.deleted', 'cus_life'))).toBe('applied');
    expect(await billing('org-life')).toEqual({
      subscription: 'sub_life',
      status: 'canceled',
      plan: 'free',
    });

    const { rows } = await sql<{ action: string; metadata: unknown }>`
      select action, metadata from audit_log where org_id = 'org-life' order by id`.execute(db);
    expect(rows.map((r) => r.action)).toEqual([
      'plan.set',
      'subscription.update',
      'plan.set',
      'subscription.update',
      'plan.set',
      'subscription.update',
    ]);
    expect(rows[1].metadata).toEqual({
      type: 'checkout.session.completed',
      subscription: 'sub_life',
      status: 'active',
      plan: 'pro',
    });
  });

  // Codex review of #636: a deletion delivered before its creation, then the creation.
  it('keeps a canceled subscription canceled when its creation arrives last', async () => {
    await newOrg('org-late-create', 'cus_lc');
    stripeState.set('cus_lc', [snapshot('sub_lc', 'canceled', 'price_pro', 20)]);
    await deliver(event('customer.subscription.deleted', 'cus_lc'));
    await deliver(event('customer.subscription.created', 'cus_lc'));
    expect(await billing('org-late-create')).toEqual({
      subscription: 'sub_lc',
      status: 'canceled',
      plan: 'free',
    });
  });

  // Codex review of #636: a late payment_failed after the newer invoice.paid.
  it('keeps a paid subscription active when an earlier payment failure arrives last', async () => {
    await newOrg('org-late-fail', 'cus_lf');
    stripeState.set('cus_lf', [snapshot('sub_lf', 'active', 'price_pro', 30)]);
    await deliver(event('invoice.paid', 'cus_lf'));
    await deliver(event('invoice.payment_failed', 'cus_lf'));
    expect(await billing('org-late-fail')).toEqual({
      subscription: 'sub_lf',
      status: 'active',
      plan: 'pro',
    });
  });

  it('marks the subscription past due while the payment is still failing, plan kept', async () => {
    await newOrg('org-past-due', 'cus_pd');
    stripeState.set('cus_pd', [snapshot('sub_pd', 'past_due', 'price_team', 30)]);
    await deliver(event('invoice.payment_failed', 'cus_pd'));
    expect(await billing('org-past-due')).toEqual({
      subscription: 'sub_pd',
      status: 'past_due',
      plan: 'team',
    });
  });

  it('follows a resubscribe after a cancel, whatever order the events arrive in', async () => {
    await newOrg('org-resub', 'cus_rs');
    stripeState.set('cus_rs', [
      snapshot('sub_new', 'active', 'price_team', 50),
      snapshot('sub_old', 'canceled', 'price_pro', 40),
    ]);
    // The old subscription's deletion arrives after the new one's creation.
    await deliver(event('customer.subscription.created', 'cus_rs'));
    await deliver(event('customer.subscription.deleted', 'cus_rs'));
    await deliver(event('checkout.session.completed', 'cus_rs'));
    expect(await billing('org-resub')).toEqual({
      subscription: 'sub_new',
      status: 'active',
      plan: 'team',
    });
  });

  it('prefers the entitled subscription when the customer has two', async () => {
    await newOrg('org-two', 'cus_two');
    // The newest one never got paid; the older live one is what the org is paying for.
    stripeState.set('cus_two', [
      snapshot('sub_unpaid', 'incomplete', 'price_team', 70),
      snapshot('sub_live', 'active', 'price_pro', 60),
    ]);
    await deliver(event('customer.subscription.created', 'cus_two'));
    expect(await billing('org-two')).toEqual({
      subscription: 'sub_live',
      status: 'active',
      plan: 'pro',
    });
  });

  it('gives an unpaid, unknown-price or missing subscription no paid plan', async () => {
    await newOrg('org-unpaid', 'cus_unpaid');
    stripeState.set('cus_unpaid', [snapshot('sub_u', 'incomplete', 'price_pro', 80)]);
    await deliver(event('customer.subscription.created', 'cus_unpaid'));
    expect(await billing('org-unpaid')).toEqual({
      subscription: 'sub_u',
      status: 'incomplete',
      plan: 'free',
    });
    stripeState.set('cus_unpaid', [snapshot('sub_u', 'active', 'price_other', 80)]);
    await deliver(event('customer.subscription.updated', 'cus_unpaid'));
    expect(await billing('org-unpaid')).toEqual({
      subscription: 'sub_u',
      status: 'active',
      plan: 'free',
    });
    stripeState.set('cus_unpaid', []);
    await deliver(event('customer.subscription.deleted', 'cus_unpaid'));
    expect(await billing('org-unpaid')).toEqual({ subscription: null, status: null, plan: 'free' });
  });

  it('applies a replayed event once, and asks Stripe only for the first', async () => {
    await newOrg('org-dup', 'cus_dup');
    stripeState.set('cus_dup', [snapshot('sub_dup', 'active', 'price_pro', 90)]);
    const created = event('customer.subscription.created', 'cus_dup');
    const results = await Promise.all([deliver(created), deliver(created)]);
    expect(results.sort()).toEqual(['applied', 'duplicate']);
    expect(await deliver(created)).toBe('duplicate');
    expect(readsByCustomer).toEqual(['cus_dup']);
    expect(await auditEntries('org-dup', 'subscription.update')).toBe(1);
    expect(await auditEntries('org-dup', 'plan.set')).toBe(1);
    expect(await recordedEvents('org-dup')).toBe(1);
  });

  it('records nothing when Stripe cannot be read, so the redelivery applies', async () => {
    await newOrg('org-down', 'cus_down');
    stripeState.set('cus_down', [snapshot('sub_down', 'active', 'price_team', 95)]);
    const created = event('customer.subscription.created', 'cus_down');
    stripeDown = true;
    await expect(deliver(created)).rejects.toThrow('Stripe API unavailable');
    expect(await recordedEvents('org-down')).toBe(0);
    expect(await auditEntries('org-down')).toBe(0);
    expect((await billing('org-down')).plan).toBe('free');

    stripeDown = false;
    expect(await deliver(created)).toBe('applied');
    expect((await billing('org-down')).plan).toBe('team');
  });

  it('keeps a support grant when an event does not change the plan', async () => {
    await newOrg('org-grant', 'cus_grant');
    stripeState.set('cus_grant', [snapshot('sub_g', 'active', 'price_pro', 100)]);
    await deliver(event('customer.subscription.created', 'cus_grant'));
    await orgEntitlements(db).setPlan('org-grant', 'pro', { runsPerMonth: 5000 });
    await deliver(event('invoice.paid', 'cus_grant'));
    expect((await orgEntitlements(db).get('org-grant')).runsPerMonth).toBe(5000);
  });

  it('ignores an unknown customer and an event type it does not act on, without asking Stripe', async () => {
    const stranger = event('customer.subscription.created', 'cus_nobody');
    expect(await deliver(stranger)).toBe('ignored');
    expect(await deliver(event('charge.succeeded', 'cus_life'))).toBe('ignored');
    expect(readsByCustomer).toEqual([]);
    const recorded = await sql<{ n: string }>`select count(*) as n from stripe_events
      where event_id = ${stranger.id}`.execute(db);
    expect(recorded.rows[0].n).toBe('0');
  });

  // Payment failure (#266). The fixtures play Stripe: a failed renewal leaves the
  // subscription `past_due`, a settled one `active`. The sweep takes the time it runs at.
  describe('payment failure: grace period, suspension and restore', () => {
    const DAY_MS = 86_400_000;
    const OPERATOR = { reason: 'abuse report', actor: 'ops' };

    async function grace(orgId: string) {
      const { rows } = await sql<{ ends: Date | null; suspended_at: Date | null; days: number }>`
        select payment_grace_ends_at as ends, payment_suspended_at as suspended_at,
          extract(epoch from payment_grace_ends_at - updated_at) / 86400 as days
        from org_billing where org_id = ${orgId}`.execute(db);
      return rows[0];
    }

    async function actions(orgId: string) {
      const { rows } = await sql<{ action: string; metadata: Record<string, unknown> }>`
        select action, metadata from audit_log
        where org_id = ${orgId} and action like 'billing.%' order by id`.execute(db);
      return rows;
    }

    /** A paying org whose renewal has just failed, and when its grace period ends. */
    async function failedPayment(orgId: string, customerId: string): Promise<Date> {
      await newOrg(orgId, customerId);
      stripeState.set(customerId, [snapshot(`sub_${orgId}`, 'active', 'price_pro', 1)]);
      await deliver(event('checkout.session.completed', customerId));
      stripeState.set(customerId, [snapshot(`sub_${orgId}`, 'past_due', 'price_pro', 1)]);
      expect(await deliver(event('invoice.payment_failed', customerId))).toBe('applied');
      return (await grace(orgId)).ends!;
    }

    async function settle(orgId: string, customerId: string) {
      stripeState.set(customerId, [snapshot(`sub_${orgId}`, 'active', 'price_pro', 1)]);
      expect(await deliver(event('invoice.paid', customerId))).toBe('applied');
    }

    const suspended = (orgId: string) => orgSuspensions(db).isSuspended(orgId);
    /** One pass, less the orgs earlier tests left overdue: the database is shared. */
    const seen = new Set<string>();
    async function sweep(now: Date): Promise<string[]> {
      return (await suspendOverdueOrgs(db, now)).filter((org) => !seen.has(org));
    }
    afterAll(() => jest.restoreAllMocks());
    afterEach(async () => {
      const { rows } = await sql<{ org_id: string }>`select org_id from org_billing`.execute(db);
      for (const { org_id } of rows) seen.add(org_id);
    });
    const after = (deadline: Date) => new Date(deadline.getTime() + 1000);

    it('invoice.payment_failed starts the grace period once and keeps the plan', async () => {
      const deadline = await failedPayment('org-grace', 'cus_grace');
      expect(Number((await grace('org-grace')).days)).toBe(7);
      expect((await billing('org-grace')).plan).toBe('pro');
      expect(await suspended('org-grace')).toBe(false);
      expect(await actions('org-grace')).toEqual([
        { action: 'billing.grace_start', metadata: { graceEndsAt: deadline.toISOString() } },
      ]);
      expect(await paymentState(db, 'org-grace')).toEqual({
        graceEndsAt: deadline,
        suspended: false,
      });

      // Stripe's retries fail too: the deadline does not move.
      await deliver(event('invoice.payment_failed', 'cus_grace'));
      await deliver(event('customer.subscription.updated', 'cus_grace'));
      expect((await grace('org-grace')).ends).toEqual(deadline);
      expect(await actions('org-grace')).toHaveLength(1);
    });

    it('suspends the org when the grace period ends: keys and jobs refused, once', async () => {
      const deadline = await failedPayment('org-overdue', 'cus_overdue');
      await postgresJobs(db)
        .forOrg({ orgId: 'org-overdue' })
        .enqueue({
          kind: 'a11y',
          params: { urls: ['https://example.com/'], wcagLevel: 'AA', failOn: ['critical'] },
        });

      expect(await sweep(new Date(deadline.getTime() - 1000))).toEqual([]);
      expect(await suspended('org-overdue')).toBe(false);

      expect(await sweep(after(deadline))).toEqual(['org-overdue']);
      // What key auth asks at connect and at each re-check of a live connection (#348).
      expect(await postgresKeyStore(db).isSuspended('org-overdue')).toBe(true);
      expect((await postgresJobs(db).claim('a11y'))?.orgSuspended).toBe(true);
      expect((await orgSuspensions(db).status('org-overdue')).last).toMatchObject({
        action: 'suspend',
        actor: 'billing',
      });
      expect(await paymentState(db, 'org-overdue')).toEqual({
        graceEndsAt: deadline,
        suspended: true,
      });
      expect((await actions('org-overdue')).map((a) => a.action)).toEqual([
        'billing.grace_start',
        'billing.suspend',
      ]);

      expect(await sweep(after(deadline))).toEqual([]);
      expect(await orgSuspensions(db).history('org-overdue')).toHaveLength(1);
    });

    it('invoice.paid restores a suspended org', async () => {
      const deadline = await failedPayment('org-restore', 'cus_restore');
      await suspendOverdueOrgs(db, after(deadline));
      expect(await suspended('org-restore')).toBe(true);

      await settle('org-restore', 'cus_restore');
      expect(await suspended('org-restore')).toBe(false);
      expect(await grace('org-restore')).toMatchObject({ ends: null, suspended_at: null });
      expect(await paymentState(db, 'org-restore')).toBeNull();
      expect((await billing('org-restore')).plan).toBe('pro');
      expect(
        (await orgSuspensions(db).history('org-restore')).map((e) => [e.action, e.actor]),
      ).toEqual([
        ['suspend', 'billing'],
        ['unsuspend', 'billing'],
      ]);
      expect(await actions('org-restore')).toEqual([
        { action: 'billing.grace_start', metadata: { graceEndsAt: deadline.toISOString() } },
        { action: 'billing.suspend', metadata: { graceEndedAt: deadline.toISOString() } },
        { action: 'billing.restore', metadata: { suspensionLifted: true } },
      ]);
    });

    it('a payment settled within the grace period suspends nothing, then or later', async () => {
      const deadline = await failedPayment('org-in-time', 'cus_in_time');
      await settle('org-in-time', 'cus_in_time');
      expect(await sweep(after(deadline))).toEqual([]);
      expect(await suspended('org-in-time')).toBe(false);
      expect((await actions('org-in-time')).map((a) => a.metadata)).toEqual([
        { graceEndsAt: deadline.toISOString() },
        { suspensionLifted: false },
      ]);
    });

    // Delivery order (#636): a failure that arrives after the payment that settled it.
    it('a late invoice.payment_failed for a paid subscription starts nothing', async () => {
      await newOrg('org-late', 'cus_late');
      stripeState.set('cus_late', [snapshot('sub_late', 'active', 'price_pro', 1)]);
      await deliver(event('invoice.paid', 'cus_late'));
      await deliver(event('invoice.payment_failed', 'cus_late'));
      expect((await grace('org-late')).ends).toBeNull();
      expect(await actions('org-late')).toEqual([]);
    });

    it("leaves an operator's suspension in place when the invoice is paid", async () => {
      const deadline = await failedPayment('org-abuse', 'cus_abuse');
      await orgSuspensions(db).suspend('org-abuse', OPERATOR);
      expect(await sweep(after(deadline))).toEqual([]);
      expect(await paymentState(db, 'org-abuse')).toMatchObject({ suspended: false });

      await settle('org-abuse', 'cus_abuse');
      expect(await suspended('org-abuse')).toBe(true);
      expect(await orgSuspensions(db).history('org-abuse')).toHaveLength(1);
      expect((await actions('org-abuse')).at(-1)).toEqual({
        action: 'billing.restore',
        metadata: { suspensionLifted: false },
      });
    });

    it('a payment settled after the org asked to be deleted does not reopen it', async () => {
      const deadline = await failedPayment('org-leaving', 'cus_leaving');
      await suspendOverdueOrgs(db, after(deadline));
      await offboarding(db).requestOrgDeletion('org-leaving', { reason: 'closing', actor: 'ops' });
      // Stripe's retry of the card succeeds during the deletion's own grace period.
      await settle('org-leaving', 'cus_leaving');
      expect(await suspended('org-leaving')).toBe(true);
      expect((await actions('org-leaving')).at(-1)?.metadata).toEqual({ suspensionLifted: false });
    });

    it('suspends for the payment once an operator lifts their own suspension', async () => {
      const deadline = await failedPayment('org-both', 'cus_both');
      await orgSuspensions(db).suspend('org-both', OPERATOR);
      expect(await sweep(after(deadline))).toEqual([]);
      await orgSuspensions(db).unsuspend('org-both', OPERATOR);
      expect(await sweep(after(deadline))).toEqual(['org-both']);
      expect((await orgSuspensions(db).status('org-both')).last?.actor).toBe('billing');
    });

    it("keeps an operator's unsuspend as an extension until the payment fails again", async () => {
      const deadline = await failedPayment('org-extend', 'cus_extend');
      await suspendOverdueOrgs(db, after(deadline));
      await orgSuspensions(db).unsuspend('org-extend', { reason: 'paying by wire', actor: 'ops' });
      expect(await sweep(after(deadline))).toEqual([]);
      expect(await suspended('org-extend')).toBe(false);

      await settle('org-extend', 'cus_extend');
      stripeState.set('cus_extend', [snapshot('sub_org-extend', 'past_due', 'price_pro', 1)]);
      await deliver(event('invoice.payment_failed', 'cus_extend'));
      const second = (await grace('org-extend')).ends!;
      expect(await sweep(after(second))).toEqual(['org-extend']);
    });

    it('ends the failure when Stripe cancels the subscription: free plan, not suspended', async () => {
      const deadline = await failedPayment('org-cancel', 'cus_cancel');
      await suspendOverdueOrgs(db, after(deadline));
      stripeState.set('cus_cancel', [snapshot('sub_org-cancel', 'canceled', 'price_pro', 1)]);
      await deliver(event('customer.subscription.deleted', 'cus_cancel'));
      expect((await billing('org-cancel')).plan).toBe('free');
      expect(await suspended('org-cancel')).toBe(false);
      expect((await grace('org-cancel')).ends).toBeNull();
    });

    it('treats an unpaid subscription as a failed payment', async () => {
      await newOrg('org-unpaid-sub', 'cus_unpaid_sub');
      stripeState.set('cus_unpaid_sub', [snapshot('sub_up', 'unpaid', 'price_pro', 1)]);
      await deliver(event('customer.subscription.updated', 'cus_unpaid_sub'));
      expect((await grace('org-unpaid-sub')).ends).not.toBeNull();
    });

    it('takes the grace period from its setting; zero days is due at once', async () => {
      await newOrg('org-zero', 'cus_zero');
      await newOrg('org-long', 'cus_long');
      for (const customer of ['cus_zero', 'cus_long'])
        stripeState.set(customer, [snapshot(`sub_${customer}`, 'past_due', 'price_pro', 1)]);
      const withDays = (graceDays: number) =>
        stripeWebhookHandler(db, CONFIG, { readSubscriptions, graceDays });
      const zero = signed(event('invoice.payment_failed', 'cus_zero'));
      await withDays(0)(zero.body, zero.signature);
      const long = signed(event('invoice.payment_failed', 'cus_long'));
      await withDays(30)(long.body, long.signature);
      expect(Number((await grace('org-zero')).days)).toBe(0);
      expect(Number((await grace('org-long')).days)).toBe(30);

      const deadline = (await grace('org-zero')).ends!;
      expect(await sweep(after(deadline))).toEqual(['org-zero']);
      expect(await suspended('org-long')).toBe(false);
      expect(await sweep(new Date(deadline.getTime() + 29 * DAY_MS))).toEqual([]);
    });

    it('a payment that settles while the sweep runs ends with the org active', async () => {
      const deadline = await failedPayment('org-race', 'cus_race');
      stripeState.set('cus_race', [snapshot('sub_org-race', 'active', 'price_pro', 1)]);
      await Promise.all([
        suspendOverdueOrgs(db, after(deadline)),
        deliver(event('invoice.paid', 'cus_race')),
      ]);
      expect(await suspended('org-race')).toBe(false);
      expect(await sweep(after(deadline))).toEqual([]);
    });

    it('the sweep timer suspends an overdue org, and outlives a failed pass', async () => {
      await newOrg('org-timer', 'cus_timer');
      stripeState.set('cus_timer', [snapshot('sub_timer', 'past_due', 'price_pro', 1)]);
      const due = signed(event('invoice.payment_failed', 'cus_timer'));
      await stripeWebhookHandler(db, CONFIG, { readSubscriptions, graceDays: 0 })(
        due.body,
        due.signature,
      );
      const errors: string[] = [];
      // Not restored here: a failing pass still in flight logs after its timer is cleared.
      jest.spyOn(console, 'error').mockImplementation((line) => {
        errors.push(String(line));
      });
      // A database that does not exist: every pass fails, and the timer keeps going.
      const missing = new URL(ADMIN_URL!);
      missing.pathname = `/${dbName}_missing`;
      const gone = createPostgresDb(missing.toString());
      const broken = startGraceSweep(gone, 5);
      const timer = startGraceSweep(db, 5);
      try {
        while (!(await suspended('org-timer')) || !errors.length)
          await new Promise((resolve) => setTimeout(resolve, 5));
      } finally {
        clearInterval(timer);
        clearInterval(broken);
        await gone.destroy();
      }
      expect(errors.join('')).toContain('payment grace sweep failed');
    });
  });
});

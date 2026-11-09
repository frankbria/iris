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
});

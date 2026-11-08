/**
 * The Stripe webhook over real Postgres (#345).
 *
 * Test strategy: no Stripe account. Each payload is signed with the SDK's own
 * `generateTestHeaderString` and goes through the real `constructEvent` verification,
 * then the handler writes to a throwaway database migrated to latest.
 */

import { randomBytes } from 'crypto';
import { Kysely, sql } from 'kysely';
import { Client } from 'pg';
import Stripe from 'stripe';
import { createPostgresDb } from '../../src/db/postgres';
import { migrateToLatest } from '../../src/db/migrate';
import { orgEntitlements } from '../../src/billing/plans';
import { stripeWebhookHandler } from '../../src/billing/stripe-webhook';
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

let eventCounter = 0;
function event(type: string, object: Record<string, unknown>, created: number) {
  return {
    id: `evt_${++eventCounter}_${randomBytes(3).toString('hex')}`,
    object: 'event',
    type,
    created,
    data: { object },
  };
}

function subscription(customer: string, id: string, status: string, price: string) {
  return {
    id,
    object: 'subscription',
    customer,
    status,
    items: { data: [{ price: { id: price } }] },
  };
}

function invoice(customer: string, subscriptionId: string) {
  return {
    id: `in_${randomBytes(3).toString('hex')}`,
    object: 'invoice',
    customer,
    parent: {
      type: 'subscription_details',
      subscription_details: { subscription: subscriptionId },
    },
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
  const now = Math.floor(Date.now() / 1000);

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
    handle = stripeWebhookHandler(db, CONFIG);
  });

  afterAll(async () => {
    await db?.destroy();
    await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  });

  it('refuses a payload whose signature is wrong, missing or for another secret', async () => {
    await newOrg('org-sig', 'cus_sig');
    const payload = event(
      'customer.subscription.updated',
      subscription('cus_sig', 'sub_sig', 'active', 'price_pro'),
      now,
    );
    const { body, signature } = signed(payload);
    expect(await handle(body.replace('price_pro', 'price_team'), signature)).toBe(
      'invalid_signature',
    );
    expect(await handle(body, undefined)).toBe('invalid_signature');
    expect(await handle(body, signed(payload, 'whsec_other').signature)).toBe('invalid_signature');
    expect(await billing('org-sig')).toEqual({ subscription: null, status: null, plan: 'free' });
    // Positive control: the same body, correctly signed, is applied.
    expect(await handle(body, signature)).toBe('applied');
    expect((await billing('org-sig')).plan).toBe('pro');
  });

  it('subscribe, upgrade, cancel: links the subscription and follows its plan and status', async () => {
    await newOrg('org-life', 'cus_life');
    const checkout = event(
      'checkout.session.completed',
      { id: 'cs_1', object: 'checkout.session', customer: 'cus_life', subscription: 'sub_life' },
      now,
    );
    expect(await deliver(checkout)).toBe('applied');
    expect(await billing('org-life')).toEqual({
      subscription: 'sub_life',
      status: null,
      plan: 'free',
    });

    const created = subscription('cus_life', 'sub_life', 'active', 'price_pro');
    expect(await deliver(event('customer.subscription.created', created, now + 1))).toBe('applied');
    expect(await billing('org-life')).toEqual({
      subscription: 'sub_life',
      status: 'active',
      plan: 'pro',
    });

    const upgraded = subscription('cus_life', 'sub_life', 'active', 'price_team');
    expect(await deliver(event('customer.subscription.updated', upgraded, now + 2))).toBe(
      'applied',
    );
    expect((await billing('org-life')).plan).toBe('team');

    const deleted = subscription('cus_life', 'sub_life', 'canceled', 'price_team');
    expect(await deliver(event('customer.subscription.deleted', deleted, now + 3))).toBe('applied');
    expect(await billing('org-life')).toEqual({
      subscription: 'sub_life',
      status: 'canceled',
      plan: 'free',
    });

    const { rows } = await sql<{ action: string }>`select action from audit_log
      where org_id = 'org-life' order by id`.execute(db);
    expect(rows.map((r) => r.action)).toEqual([
      'subscription.update',
      'plan.set',
      'subscription.update',
      'plan.set',
      'subscription.update',
      'plan.set',
      'subscription.update',
    ]);
  });

  it('records invoice.paid and invoice.payment_failed as the status, plan unchanged', async () => {
    await newOrg('org-inv', 'cus_inv');
    await deliver(
      event(
        'customer.subscription.created',
        subscription('cus_inv', 'sub_inv', 'active', 'price_pro'),
        now,
      ),
    );
    expect(
      await deliver(event('invoice.payment_failed', invoice('cus_inv', 'sub_inv'), now + 1)),
    ).toBe('applied');
    expect(await billing('org-inv')).toEqual({
      subscription: 'sub_inv',
      status: 'past_due',
      plan: 'pro',
    });
    expect(await deliver(event('invoice.paid', invoice('cus_inv', 'sub_inv'), now + 2))).toBe(
      'applied',
    );
    expect(await billing('org-inv')).toEqual({
      subscription: 'sub_inv',
      status: 'active',
      plan: 'pro',
    });
  });

  it('applies a replayed event once', async () => {
    await newOrg('org-dup', 'cus_dup');
    const paid = event(
      'customer.subscription.created',
      subscription('cus_dup', 'sub_dup', 'active', 'price_pro'),
      now,
    );
    const results = await Promise.all([deliver(paid), deliver(paid)]);
    expect(results.sort()).toEqual(['applied', 'duplicate']);
    expect(await deliver(paid)).toBe('duplicate');
    const { rows } = await sql<{ n: string }>`select count(*) as n from audit_log
      where org_id = 'org-dup' and action = 'plan.set'`.execute(db);
    expect(rows[0].n).toBe('1');
    const events = await sql<{ n: string }>`select count(*) as n from stripe_events
      where event_id = ${paid.id}`.execute(db);
    expect(events.rows[0].n).toBe('1');
  });

  it('records an event older than the state but does not apply it', async () => {
    await newOrg('org-late', 'cus_late');
    const newer = event(
      'customer.subscription.updated',
      subscription('cus_late', 'sub_late', 'active', 'price_team'),
      now + 10,
    );
    const older = event(
      'customer.subscription.updated',
      subscription('cus_late', 'sub_late', 'active', 'price_pro'),
      now,
    );
    expect(await deliver(newer)).toBe('applied');
    expect(await deliver(older)).toBe('stale');
    expect((await billing('org-late')).plan).toBe('team');
    const recorded = await sql<{ n: string }>`select count(*) as n from stripe_events
      where org_id = 'org-late'`.execute(db);
    expect(recorded.rows[0].n).toBe('2');
  });

  it("does not let an old subscription's deletion or invoice touch the current one", async () => {
    await newOrg('org-two', 'cus_two');
    await deliver(
      event(
        'customer.subscription.created',
        subscription('cus_two', 'sub_new', 'active', 'price_pro'),
        now,
      ),
    );
    const oldDeleted = subscription('cus_two', 'sub_old', 'canceled', 'price_pro');
    expect(await deliver(event('customer.subscription.deleted', oldDeleted, now + 1))).toBe(
      'stale',
    );
    expect(
      await deliver(event('invoice.payment_failed', invoice('cus_two', 'sub_old'), now + 1)),
    ).toBe('stale');
    expect(await billing('org-two')).toEqual({
      subscription: 'sub_new',
      status: 'active',
      plan: 'pro',
    });
  });

  it('gives an unpaid or unknown-price subscription no paid plan', async () => {
    await newOrg('org-unpaid', 'cus_unpaid');
    await deliver(
      event(
        'customer.subscription.created',
        subscription('cus_unpaid', 'sub_u', 'incomplete', 'price_pro'),
        now,
      ),
    );
    expect(await billing('org-unpaid')).toEqual({
      subscription: 'sub_u',
      status: 'incomplete',
      plan: 'free',
    });
    await deliver(
      event(
        'customer.subscription.updated',
        subscription('cus_unpaid', 'sub_u', 'active', 'price_other'),
        now + 1,
      ),
    );
    expect((await billing('org-unpaid')).plan).toBe('free');
  });

  it('keeps a support grant when an event does not change the plan', async () => {
    await newOrg('org-grant', 'cus_grant');
    await deliver(
      event(
        'customer.subscription.created',
        subscription('cus_grant', 'sub_g', 'active', 'price_pro'),
        now,
      ),
    );
    await orgEntitlements(db).setPlan('org-grant', 'pro', { runsPerMonth: 5000 });
    await deliver(event('invoice.paid', invoice('cus_grant', 'sub_g'), now + 1));
    expect((await orgEntitlements(db).get('org-grant')).runsPerMonth).toBe(5000);
  });

  it('ignores an unknown customer and an event type it does not act on', async () => {
    const stranger = event(
      'customer.subscription.created',
      subscription('cus_nobody', 'sub_x', 'active', 'price_team'),
      now,
    );
    expect(await deliver(stranger)).toBe('ignored');
    expect(
      await deliver(
        event('charge.succeeded', { id: 'ch_1', object: 'charge', customer: 'cus_life' }, now),
      ),
    ).toBe('ignored');
    const recorded = await sql<{ n: string }>`select count(*) as n from stripe_events
      where event_id = ${stranger.id}`.execute(db);
    expect(recorded.rows[0].n).toBe('0');
  });
});

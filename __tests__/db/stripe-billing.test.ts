/**
 * Stripe customers, Checkout and the Customer Portal (#261) over real Postgres.
 *
 * Test strategy: the refusals decided from the database run with a placeholder key. The
 * one-subscription guard (#688) runs the real Stripe SDK against a local HTTP server that
 * keeps subscriptions and Checkout Sessions as Stripe does. The calls to Stripe itself run only when
 * `IRIS_TEST_STRIPE_SECRET_KEY` (a test-mode key) is set: optional until the owner's
 * test account exists, so they are skipped under CI too, not required.
 */

import { randomBytes } from 'crypto';
import * as http from 'http';
import type { AddressInfo } from 'net';
import Stripe from 'stripe';
import { Kysely, sql } from 'kysely';
import { Client } from 'pg';
import { createPostgresDb } from '../../src/db/postgres';
import { migrateToLatest } from '../../src/db/migrate';
import {
  BillingError,
  MAX_CONCURRENT_CHECKOUTS,
  STRIPE_API_VERSION,
  stripeBilling,
  stripeClient,
  type StripeConfig,
} from '../../src/billing/stripe';
import { stripeWebhookHandler } from '../../src/billing/stripe-webhook';

const ADMIN_URL = process.env.IRIS_TEST_DATABASE_URL;
if (!ADMIN_URL) {
  if (process.env.CI) throw new Error('IRIS_TEST_DATABASE_URL is required in CI');
  console.warn('Skipping Stripe billing tests: set IRIS_TEST_DATABASE_URL');
}
const STRIPE_KEY = process.env.IRIS_TEST_STRIPE_SECRET_KEY;
if (!STRIPE_KEY) console.warn('Skipping Stripe test-mode calls: set IRIS_TEST_STRIPE_SECRET_KEY');

(ADMIN_URL ? describe : describe.skip)('stripeBilling', () => {
  const dbName = `iris_billing_${process.pid}_${randomBytes(4).toString('hex')}`;
  let db: Kysely<unknown>;

  async function admin(query: string): Promise<void> {
    const client = new Client({ connectionString: ADMIN_URL });
    await client.connect();
    try {
      await client.query(query);
    } finally {
      await client.end();
    }
  }

  async function newOrg(orgId: string) {
    await sql`insert into organization (id, name, slug, "createdAt")
      values (${orgId}, ${orgId}, ${orgId}, now())`.execute(db);
  }

  beforeAll(async () => {
    await admin(`CREATE DATABASE "${dbName}"`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${dbName}`;
    db = createPostgresDb(url.toString());
    await migrateToLatest(db);
  });

  afterAll(async () => {
    await db?.destroy();
    await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  });

  describe('refusals, decided before Stripe is called', () => {
    // A placeholder key: any call that reached Stripe would fail authentication.
    const config: StripeConfig = {
      secretKey: 'sk_test_placeholder',
      webhookSecret: 'whsec_placeholder',
      prices: { pro: 'price_pro', team: 'price_team' },
    };
    const billing = () => stripeBilling(db, stripeClient(config), config);

    it('answers subscribed while the stored subscription is live, before asking Stripe', async () => {
      await newOrg('org-live');
      await sql`insert into org_billing (org_id, stripe_customer_id, subscription_status)
        values ('org-live', 'cus_live', 'past_due')`.execute(db);
      await expect(
        billing().checkout('org-live', 'team', 'https://portal.test/org', {}),
      ).resolves.toEqual({ outcome: 'subscribed' });
    });

    it('refuses a Portal session before the org has a customer', async () => {
      await newOrg('org-none');
      await expect(billing().portalUrl('org-none', 'https://portal.test/org')).rejects.toThrow(
        BillingError,
      );
      expect(await billing().account('org-none')).toBeNull();
    });
  });

  describe('one subscription per org (#688), against a local Stripe', () => {
    interface FakeSession {
      id: string;
      customer: string;
      status: 'open' | 'expired' | 'complete';
    }
    let server: http.Server;
    let stripe: Stripe;
    let subscriptions: Map<string, Stripe.Subscription.Status[]>;
    let sessions: FakeSession[];
    // Held before answering a subscription list, so a test can keep checkouts in flight.
    let subscriptionListGate: Promise<void>;
    let listsWaiting: number;
    let onListWaiting: () => void;
    /** Resolves once `count` subscription lists are waiting at the gate. */
    const untilListsWaiting = (count: number) =>
      new Promise<void>((resolve) => {
        onListWaiting = () => listsWaiting >= count && resolve();
        onListWaiting();
      });
    // A session that completes between the list and its expiry: Stripe refuses the expiry.
    let completesBeforeExpiry: Set<string>;
    const config: StripeConfig = {
      secretKey: 'sk_test_local',
      webhookSecret: 'whsec_unused',
      prices: { pro: 'price_pro', team: 'price_team' },
    };
    const billing = () => stripeBilling(db, stripe, config);
    const openSessions = (customer: string) =>
      sessions.filter((s) => s.customer === customer && s.status === 'open').map((s) => s.id);
    const list = (data: object[]) => ({ object: 'list', data, has_more: false, url: '/v1/x' });

    async function answer(method: string, url: URL): Promise<[number, object]> {
      const customer = url.searchParams.get('customer') ?? '';
      if (method === 'POST' && url.pathname === '/v1/customers')
        return [200, { id: `cus_${randomBytes(4).toString('hex')}`, object: 'customer' }];
      if (method === 'GET' && url.pathname === '/v1/subscriptions') {
        listsWaiting++;
        onListWaiting();
        await subscriptionListGate;
        const statuses = subscriptions.get(customer) ?? [];
        return [200, list(statuses.map((status, n) => ({ id: `sub_${n}`, status })))];
      }
      if (method === 'GET' && url.pathname === '/v1/checkout/sessions')
        return [200, list(openSessions(customer).map((id) => ({ id, status: 'open' })))];
      const expire = url.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)\/expire$/);
      if (method === 'POST' && expire) {
        const session = sessions.find((s) => s.id === expire[1])!;
        if (completesBeforeExpiry.has(session.id)) session.status = 'complete';
        if (session.status !== 'open')
          return [
            400,
            { error: { type: 'invalid_request_error', message: 'Only open sessions expire.' } },
          ];
        session.status = 'expired';
        return [200, { id: session.id, status: 'expired' }];
      }
      return [404, { error: { type: 'invalid_request_error', message: url.pathname } }];
    }

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', async () => {
          const url = new URL(req.url ?? '/', 'http://stripe.test');
          let [status, body] = await answer(req.method ?? '', url);
          if (req.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
            const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
            const id = `cs_${randomBytes(4).toString('hex')}`;
            sessions.push({ id, customer: form.get('customer')!, status: 'open' });
            [status, body] = [200, { id, url: `https://checkout.stripe.test/${id}` }];
          }
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      stripe = new Stripe(config.secretKey, {
        apiVersion: STRIPE_API_VERSION,
        host: '127.0.0.1',
        port,
        protocol: 'http',
        maxNetworkRetries: 0,
      });
    });

    afterAll(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    beforeEach(() => {
      subscriptions = new Map();
      sessions = [];
      subscriptionListGate = Promise.resolve();
      listsWaiting = 0;
      onListWaiting = () => {};
      completesBeforeExpiry = new Set();
    });

    /** A new org whose customer exists, with Stripe holding `statuses` for it. */
    async function orgWithCustomer(statuses: Stripe.Subscription.Status[] = []) {
      const orgId = `org-guard-${randomBytes(4).toString('hex')}`;
      await newOrg(orgId);
      const customer = `cus_${orgId}`;
      await sql`insert into org_billing (org_id, stripe_customer_id)
        values (${orgId}, ${customer})`.execute(db);
      subscriptions.set(customer, statuses);
      return { orgId, customer };
    }

    const checkout = (orgId: string) =>
      billing().checkout(orgId, 'pro', 'https://portal.test/org', { userId: 'u-1' });

    it.each(['active', 'trialing', 'past_due', 'unpaid', 'paused'] as const)(
      'answers subscribed when Stripe lists a %s subscription the webhook has not stored',
      async (status) => {
        const { orgId, customer } = await orgWithCustomer(['canceled', status]);
        await expect(checkout(orgId)).resolves.toEqual({ outcome: 'subscribed' });
        expect(sessions.filter((s) => s.customer === customer)).toEqual([]);
      },
    );

    it('opens Checkout when every subscription Stripe lists has ended', async () => {
      const { orgId, customer } = await orgWithCustomer([
        'canceled',
        'incomplete_expired',
        'incomplete',
      ]);
      const result = await checkout(orgId);
      expect(result).toEqual({
        outcome: 'checkout',
        url: `https://checkout.stripe.test/${openSessions(customer)[0]}`,
      });
    });

    it("expires the customer's open sessions, so only the newest can be paid", async () => {
      const { orgId, customer } = await orgWithCustomer();
      await checkout(orgId);
      const [first] = openSessions(customer);
      await checkout(orgId);
      expect(sessions.find((s) => s.id === first)?.status).toBe('expired');
      expect(openSessions(customer)).toHaveLength(1);
      expect(openSessions(customer)).not.toContain(first);
    });

    it('refuses when an open session was completed before it could be expired', async () => {
      const { orgId, customer } = await orgWithCustomer();
      await checkout(orgId);
      const [first] = openSessions(customer);
      completesBeforeExpiry.add(first);
      // Completing it is what creates the subscription in Stripe.
      subscriptions.set(customer, ['active']);
      await expect(checkout(orgId)).resolves.toEqual({ outcome: 'subscribed' });
      expect(openSessions(customer)).toEqual([]);
    });

    it('lets one of two concurrent calls for an org through: at most one open session', async () => {
      const { orgId, customer } = await orgWithCustomer();
      let release!: () => void;
      subscriptionListGate = new Promise((resolve) => (release = resolve));
      const calls = [checkout(orgId), checkout(orgId)];
      // One holds the org's lock at the gate, so the other can only come back refused.
      // Both at the gate would mean both passed the check: release them to show it.
      await Promise.race([...calls, untilListsWaiting(2)]);
      release();
      const outcomes = (await Promise.all(calls)).map((r) => r.outcome).sort();
      expect(outcomes).toEqual(['busy', 'checkout']);
      expect(openSessions(customer)).toHaveLength(1);
    });

    it(`holds at most ${MAX_CONCURRENT_CHECKOUTS} connections across Stripe calls; tenant queries still run`, async () => {
      const orgs = await Promise.all(
        Array.from({ length: MAX_CONCURRENT_CHECKOUTS + 1 }, () => orgWithCustomer()),
      );
      let release!: () => void;
      subscriptionListGate = new Promise((resolve) => (release = resolve));
      const shared = billing();
      const call = (orgId: string) =>
        shared.checkout(orgId, 'pro', 'https://portal.test/org', { userId: 'u-1' });
      const held = orgs.slice(0, MAX_CONCURRENT_CHECKOUTS).map(({ orgId }) => call(orgId));
      await untilListsWaiting(MAX_CONCURRENT_CHECKOUTS);
      // Past the cap: refused at once. Reaching Stripe instead would mean a third connection held.
      const overCap = call(orgs[MAX_CONCURRENT_CHECKOUTS].orgId);
      const reachedStripe = untilListsWaiting(MAX_CONCURRENT_CHECKOUTS + 1).then(
        () => 'reached Stripe',
      );
      const first = await Promise.race([overCap, reachedStripe]);
      // While the held ones wait on Stripe, the rest of the pool serves tenants.
      const tenantQueries = Array.from({ length: 8 }, () => sql`select 1`.execute(db));
      await expect(Promise.all(tenantQueries)).resolves.toHaveLength(8);
      release();
      expect(first).toEqual({ outcome: 'busy' });
      expect((await Promise.all(held)).map((r) => r.outcome)).toEqual(
        Array(MAX_CONCURRENT_CHECKOUTS).fill('checkout'),
      );
    });
  });

  (STRIPE_KEY ? describe : describe.skip)('against Stripe test mode', () => {
    let config: StripeConfig;
    // New ids each run: the customer's idempotency key (`customer-<org>`) lasts 24 hours.
    const run = randomBytes(4).toString('hex');
    const checkoutOrg = `org-checkout-${run}`;
    const trialingOrg = `org-trialing-${run}`;
    const concurrentOrg = `org-concurrent-${run}`;

    beforeAll(async () => {
      const stripe = stripeClient({ secretKey: STRIPE_KEY! });
      // The account's own prices when the environment names them, so a run adds no products.
      const existing = (name: string, unitAmount: number) => {
        const id = process.env[name];
        return id
          ? stripe.prices.retrieve(id)
          : stripe.prices.create({
              currency: 'usd',
              unit_amount: unitAmount,
              recurring: { interval: 'month' },
              product_data: { name: `IRIS test ${unitAmount}` },
            });
      };
      const [pro, team] = await Promise.all([
        existing('IRIS_TEST_STRIPE_PRICE_PRO', 4900),
        existing('IRIS_TEST_STRIPE_PRICE_TEAM', 19900),
      ]);
      config = {
        secretKey: STRIPE_KEY!,
        webhookSecret: 'whsec_unused',
        prices: { pro: pro.id, team: team.id },
      };
    });

    // Every customer this file made in Stripe, with its subscriptions.
    afterAll(async () => {
      const stripe = stripeClient(config);
      const { rows } = await sql<{ id: string }>`
        select stripe_customer_id as id from org_billing
        where org_id in (${checkoutOrg}, ${trialingOrg}, ${concurrentOrg})`.execute(db);
      await Promise.all(rows.map(({ id }) => stripe.customers.del(id)));
    });

    it('creates one customer per org and a Checkout session for the plan', async () => {
      await newOrg(checkoutOrg);
      const billing = stripeBilling(db, stripeClient(config), config);
      const result = await billing.checkout(checkoutOrg, 'pro', 'https://portal.test/org', {
        userId: 'u-1',
      });
      expect(result).toEqual({
        outcome: 'checkout',
        url: expect.stringMatching(/^https:\/\/checkout\.stripe\.com\//),
      });
      const first = await billing.account(checkoutOrg);
      await billing.checkout(checkoutOrg, 'team', 'https://portal.test/org', {
        userId: 'u-1',
      });
      expect(await billing.account(checkoutOrg)).toEqual(first);

      const customer = await stripeClient(config).customers.retrieve(first!.customerId);
      expect(customer).toMatchObject({ metadata: { org_id: checkoutOrg } });
      const { rows } = await sql<{ action: string; actor: string }>`
        select action, actor_user_id as actor from audit_log where org_id = ${checkoutOrg}`.execute(
        db,
      );
      expect(rows).toEqual([{ action: 'billing_customer.create', actor: 'u-1' }]);

      // #688: the second request expired the first's session; only the newest can be paid.
      const sessions = await stripeClient(config).checkout.sessions.list({
        customer: first!.customerId,
        limit: 10,
      });
      expect(sessions.data.map((s) => s.status)).toEqual(['open', 'expired']);
    });

    // #688. Each test org has its own customer.
    describe('one subscription per org', () => {
      async function orgWithCustomer(name: string) {
        await newOrg(name);
        const billing = stripeBilling(db, stripeClient(config), config);
        // The customer as the first Checkout makes it; its session is expired by the next.
        await billing.checkout(name, 'pro', 'https://portal.test/org', { userId: 'u-1' });
        const { customerId } = (await billing.account(name))!;
        return { billing, customerId };
      }

      const openSessions = async (customer: string) =>
        (await stripeClient(config).checkout.sessions.list({ customer, status: 'open' })).data;

      it('answers subscribed for a trialing subscription the webhook never stored', async () => {
        const { billing, customerId } = await orgWithCustomer(trialingOrg);
        await stripeClient(config).subscriptions.create({
          customer: customerId,
          items: [{ price: config.prices.pro }],
          trial_period_days: 7,
          trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
        });
        expect(await billing.account(trialingOrg)).toMatchObject({ subscriptionStatus: null });
        await expect(
          billing.checkout(trialingOrg, 'team', 'https://portal.test/org', {}),
        ).resolves.toEqual({ outcome: 'subscribed' });
        expect(await openSessions(customerId)).toEqual([]);
      });

      it('leaves at most one open session after two concurrent requests', async () => {
        const { billing, customerId } = await orgWithCustomer(concurrentOrg);
        const outcomes = await Promise.all(
          (['pro', 'team'] as const).map((plan) =>
            billing.checkout(concurrentOrg, plan, 'https://portal.test/org', {}),
          ),
        );
        expect(outcomes.filter((o) => o.outcome === 'checkout').length).toBeGreaterThanOrEqual(1);
        expect(await openSessions(customerId)).toHaveLength(1);
      });
    });

    // Needs the test account's Customer Portal configuration saved once in the dashboard.
    it('opens a Customer Portal session once a customer exists', async () => {
      const billing = stripeBilling(db, stripeClient(config), config);
      expect(await billing.portalUrl(checkoutOrg, 'https://portal.test/org')).toMatch(
        /^https:\/\/billing\.stripe\.com\//,
      );
    });

    // The webhook's default reader: a signed event makes it read the customer's real
    // subscriptions. Unpaid (no card in test mode), so `incomplete` and no paid plan.
    it("stores the customer's current subscription as the API reports it", async () => {
      const stripe = stripeClient(config);
      const { customerId } = (await stripeBilling(db, stripe, config).account(checkoutOrg))!;
      const subscription = await stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: config.prices.team }],
        payment_behavior: 'default_incomplete',
      });
      const payload = JSON.stringify({
        id: `evt_test_${randomBytes(4).toString('hex')}`,
        object: 'event',
        type: 'customer.subscription.created',
        created: subscription.created,
        data: { object: { id: subscription.id, customer: customerId } },
      });
      const handle = stripeWebhookHandler(db, config);
      const signature = stripe.webhooks.generateTestHeaderString({
        payload,
        secret: config.webhookSecret,
      });
      expect(await handle(payload, signature)).toBe('applied');
      const { rows } = await sql<{ id: string; status: string }>`
        select stripe_subscription_id as id, subscription_status as status
        from org_billing where org_id = ${checkoutOrg}`.execute(db);
      expect(rows).toEqual([{ id: subscription.id, status: 'incomplete' }]);
    });
  });
});

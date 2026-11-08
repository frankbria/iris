/**
 * Stripe customers, Checkout and the Customer Portal (#261) over real Postgres.
 *
 * Test strategy: the refusals are decided from the database before Stripe is called, so
 * they run with a placeholder key. The calls to Stripe itself run only when
 * `IRIS_TEST_STRIPE_SECRET_KEY` (a test-mode key) is set: optional until the owner's
 * test account exists, so they are skipped under CI too, not required.
 */

import { randomBytes } from 'crypto';
import { Kysely, sql } from 'kysely';
import { Client } from 'pg';
import { createPostgresDb } from '../../src/db/postgres';
import { migrateToLatest } from '../../src/db/migrate';
import {
  BillingError,
  stripeBilling,
  stripeClient,
  type StripeConfig,
} from '../../src/billing/stripe';

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

    it('refuses a second Checkout while a subscription is live', async () => {
      await newOrg('org-live');
      await sql`insert into org_billing (org_id, stripe_customer_id, subscription_status)
        values ('org-live', 'cus_live', 'past_due')`.execute(db);
      await expect(
        billing().checkoutUrl('org-live', 'team', 'https://portal.test/org', {}),
      ).rejects.toThrow(BillingError);
    });

    it('refuses a Portal session before the org has a customer', async () => {
      await newOrg('org-none');
      await expect(billing().portalUrl('org-none', 'https://portal.test/org')).rejects.toThrow(
        BillingError,
      );
      expect(await billing().account('org-none')).toBeNull();
    });
  });

  (STRIPE_KEY ? describe : describe.skip)('against Stripe test mode', () => {
    let config: StripeConfig;

    beforeAll(async () => {
      const stripe = stripeClient({
        secretKey: STRIPE_KEY!,
        webhookSecret: '',
        prices: { pro: '', team: '' },
      });
      const price = (unitAmount: number) =>
        stripe.prices.create({
          currency: 'usd',
          unit_amount: unitAmount,
          recurring: { interval: 'month' },
          product_data: { name: `IRIS test ${unitAmount}` },
        });
      const [pro, team] = await Promise.all([price(4900), price(19900)]);
      config = {
        secretKey: STRIPE_KEY!,
        webhookSecret: 'whsec_unused',
        prices: { pro: pro.id, team: team.id },
      };
    });

    it('creates one customer per org and a Checkout session for the plan', async () => {
      await newOrg('org-checkout');
      const billing = stripeBilling(db, stripeClient(config), config);
      const url = await billing.checkoutUrl('org-checkout', 'pro', 'https://portal.test/org', {
        userId: 'u-1',
      });
      expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
      const first = await billing.account('org-checkout');
      await billing.checkoutUrl('org-checkout', 'team', 'https://portal.test/org', {
        userId: 'u-1',
      });
      expect(await billing.account('org-checkout')).toEqual(first);

      const customer = await stripeClient(config).customers.retrieve(first!.customerId);
      expect(customer).toMatchObject({ metadata: { org_id: 'org-checkout' } });
      const { rows } = await sql<{ action: string; actor: string }>`
        select action, actor_user_id as actor from audit_log where org_id = 'org-checkout'`.execute(
        db,
      );
      expect(rows).toEqual([{ action: 'billing_customer.create', actor: 'u-1' }]);
    });

    // Needs the test account's Customer Portal configuration saved once in the dashboard.
    it('opens a Customer Portal session once a customer exists', async () => {
      const billing = stripeBilling(db, stripeClient(config), config);
      expect(await billing.portalUrl('org-checkout', 'https://portal.test/org')).toMatch(
        /^https:\/\/billing\.stripe\.com\//,
      );
    });
  });
});

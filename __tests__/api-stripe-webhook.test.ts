/**
 * `POST /v1/stripe/webhook` (#345) on the hosted listener, over real sockets and real
 * Postgres: no API key, the raw body reaches signature verification unchanged, 400 on a
 * bad signature, 200 once handled, and the shared body cap.
 *
 * Test strategy: payloads are signed with the SDK's `generateTestHeaderString`; no Stripe
 * account is needed.
 */

import { randomBytes } from 'crypto';
import { AddressInfo } from 'net';
import { Kysely, sql } from 'kysely';
import { Client } from 'pg';
import Stripe from 'stripe';
import { createPostgresDb } from '../src/db/postgres';
import { migrateToLatest } from '../src/db/migrate';
import { startServer, type Authenticator } from '../src/protocol';
import { MAX_BODY_BYTES } from '../src/jobs-api';
import { stripeWebhookHandler, type ReadSubscriptions } from '../src/billing/stripe-webhook';
import type { StripeConfig } from '../src/billing/stripe';

const ADMIN_URL = process.env.IRIS_TEST_DATABASE_URL;
if (!ADMIN_URL) {
  if (process.env.CI) throw new Error('IRIS_TEST_DATABASE_URL is required in CI');
  console.warn('Skipping Stripe webhook route tests: set IRIS_TEST_DATABASE_URL');
}

const CONFIG: StripeConfig = {
  secretKey: 'sk_test_unused',
  webhookSecret: 'whsec_route_secret',
  prices: { pro: 'price_pro', team: 'price_team' },
};
const signer = new Stripe(CONFIG.secretKey);

/** Every key is refused: the webhook must not need one. */
const authenticate: Authenticator = {
  async verify() {
    return null;
  },
  async recheck() {
    return false;
  },
};
/** Stripe's current state for the route's customer: one active Team subscription. */
const onTeam: ReadSubscriptions = async () => [
  { id: 'sub_route', status: 'active', priceId: 'price_team', created: 1 },
];
const unreachable: ReadSubscriptions = async () => {
  throw new Error('Stripe API unavailable');
};
const jobs = { forOrg: () => ({ enqueue: async () => null, get: async () => null }) };

(ADMIN_URL ? describe : describe.skip)('Stripe webhook route', () => {
  const dbName = `iris_stripe_route_${process.pid}_${randomBytes(4).toString('hex')}`;
  let db: Kysely<unknown>;
  let server: ReturnType<typeof startServer>;
  let base: string;

  async function admin(query: string): Promise<void> {
    const client = new Client({ connectionString: ADMIN_URL });
    await client.connect();
    try {
      await client.query(query);
    } finally {
      await client.end();
    }
  }

  async function serve(stripeWebhook?: ReturnType<typeof stripeWebhookHandler>) {
    server = startServer(0, { authenticate, jobs, stripeWebhook });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const post = (body: string, signature?: string) =>
    fetch(`${base}/v1/stripe/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(signature && { 'stripe-signature': signature }),
      },
      body,
    });

  beforeAll(async () => {
    await admin(`CREATE DATABASE "${dbName}"`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${dbName}`;
    db = createPostgresDb(url.toString());
    await migrateToLatest(db);
    await sql`insert into organization (id, name, slug, "createdAt")
      values ('org-route', 'Route', 'org-route', now())`.execute(db);
    await sql`insert into org_billing (org_id, stripe_customer_id)
      values ('org-route', 'cus_route')`.execute(db);
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(() => resolve(null)));
  });

  afterAll(async () => {
    await db?.destroy();
    await admin(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  });

  // Whitespace and key order as Stripe sends them: re-serialising would break the signature.
  const payload = (eventId: string) => `{
  "id": "${eventId}", "object": "event", "type": "customer.subscription.created",
  "created": ${Math.floor(Date.now() / 1000)},
  "data": { "object": { "id": "sub_route", "object": "subscription", "customer": "cus_route",
    "status": "active", "items": { "data": [ { "price": { "id": "price_team" } } ] } } }
}`;
  const body = payload('evt_route_1');
  const signatureOf = (text: string) =>
    signer.webhooks.generateTestHeaderString({ payload: text, secret: CONFIG.webhookSecret });
  const signature = () => signatureOf(body);

  it('answers 400 to a bad or missing signature without an API key, and 200 once applied', async () => {
    await serve(stripeWebhookHandler(db, CONFIG, { readSubscriptions: onTeam }));
    expect((await post(body)).status).toBe(400);
    expect((await post(body, 't=1,v1=deadbeef')).status).toBe(400);

    const res = await post(body, signature());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });
    const { rows } = await sql<{ plan: string }>`select plan from org_plans
      where org_id = 'org-route'`.execute(db);
    expect(rows).toEqual([{ plan: 'team' }]);

    // A redelivery is a 200 too, so Stripe stops retrying it.
    expect((await post(body, signature())).status).toBe(200);
  });

  it('refuses another method and a body over the cap', async () => {
    await serve(stripeWebhookHandler(db, CONFIG, { readSubscriptions: onTeam }));
    const get = await fetch(`${base}/v1/stripe/webhook`);
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect((await post('x'.repeat(MAX_BODY_BYTES + 1), signature())).status).toBe(413);
  });

  it('answers 500 when Stripe cannot be read, so Stripe delivers the event again', async () => {
    const retried = payload('evt_route_retry');
    await serve(stripeWebhookHandler(db, CONFIG, { readSubscriptions: unreachable }));
    expect((await post(retried, signatureOf(retried))).status).toBe(500);
    await new Promise((resolve) => server.close(() => resolve(null)));

    await serve(stripeWebhookHandler(db, CONFIG, { readSubscriptions: onTeam }));
    expect((await post(retried, signatureOf(retried))).status).toBe(200);
  });

  it('is not served when billing is off', async () => {
    await serve();
    expect((await post(body, signature())).status).toBe(404);
  });
});

import Stripe from 'stripe';
import { sql, type Kysely } from 'kysely';
import { recordAudit, type AuditActor } from '../audit-log';
import { readSecretEnv } from '../secret-env';
import type { PlanId } from './plans';

/**
 * Stripe customers, Checkout and the Customer Portal (#261, ADR 0001 §6). Subscription
 * state is never written from here: only the verified webhook (src/billing/stripe-webhook.ts)
 * changes it. Checkout reads Stripe's list only to refuse a second subscription (#688).
 */

export type PaidPlan = Exclude<PlanId, 'free'>;

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  prices: Record<PaidPlan, string>;
}

/** The API version this code was written against; the webhook endpoint must use it too. */
export const STRIPE_API_VERSION = '2026-10-28.endive';

const SETTINGS = {
  secretKey: 'IRIS_STRIPE_SECRET_KEY',
  webhookSecret: 'IRIS_STRIPE_WEBHOOK_SECRET',
  pro: 'IRIS_STRIPE_PRICE_PRO',
  team: 'IRIS_STRIPE_PRICE_TEAM',
} as const;

/**
 * The four `IRIS_STRIPE_*` settings (each also as `_FILE`). None set: `null`, billing is
 * off. Some but not all: throws, so a missing one cannot quietly turn billing off.
 */
export function resolveStripeConfig(env: NodeJS.ProcessEnv = process.env): StripeConfig | null {
  const names = Object.values(SETTINGS);
  const values = names.map((name) => readSecretEnv(name, env));
  const present = values.filter((value): value is string => Boolean(value));
  if (!present.length) return null;
  if (present.length < names.length) {
    const missing = names.filter((_name, index) => !values[index]);
    throw new Error(`Stripe billing also needs ${missing.join(', ')} (or _FILE)`);
  }
  const [secretKey, webhookSecret, pro, team] = present;
  return { secretKey, webhookSecret, prices: { pro, team } };
}

/** The paid plan a Stripe price buys, or `null` for a price IRIS does not sell. */
export function planForPrice(config: StripeConfig, priceId: string): PaidPlan | null {
  if (priceId === config.prices.pro) return 'pro';
  if (priceId === config.prices.team) return 'team';
  return null;
}

/** `limits`: a caller that holds a lock while it waits bounds the request and skips retries. */
export function stripeClient(
  config: Pick<StripeConfig, 'secretKey'>,
  limits: Pick<Stripe.StripeConfig, 'timeout' | 'maxNetworkRetries'> = {},
): Stripe {
  return new Stripe(config.secretKey, { apiVersion: STRIPE_API_VERSION, ...limits });
}

/** Statuses after which a subscription is over and the org may check out again. */
const ENDED_STATUSES = ['canceled', 'incomplete_expired'];

export interface OrgBillingAccount {
  customerId: string;
  subscriptionStatus: string | null;
}

/** True while the org has a subscription that is not over: plan changes go through the Portal. */
export function hasLiveSubscription(account: OrgBillingAccount | null): boolean {
  const status = account?.subscriptionStatus;
  return status != null && !ENDED_STATUSES.includes(status);
}

export class BillingError extends Error {}

/** Stripe statuses that still bill or can bill again: a second subscription would be a second charge. */
const SUBSCRIBED_STATUSES: readonly Stripe.Subscription.Status[] = [
  'active',
  'trialing',
  'past_due',
  'unpaid',
  'paused',
];

/**
 * Checkouts that may hold a portal pool connection at once (pg's default pool is 10): each
 * holds one across its Stripe calls, so more waiting on Stripe could starve sign-ins.
 */
export const MAX_CONCURRENT_CHECKOUTS = 2;

/** Each Stripe call made while a checkout holds its connection: bounded, never retried. */
const BOUNDED: Stripe.RequestOptions = { timeout: 10_000, maxNetworkRetries: 0 };

export type CheckoutResult =
  { outcome: 'checkout'; url: string } | { outcome: 'subscribed' } | { outcome: 'busy' };

/** One org's Stripe side, for the portal's server actions. */
export function stripeBilling(db: Kysely<unknown>, stripe: Stripe, config: StripeConfig) {
  async function account(orgId: string): Promise<OrgBillingAccount | null> {
    const { rows } = await sql<OrgBillingAccount>`
      select stripe_customer_id as "customerId", subscription_status as "subscriptionStatus"
      from org_billing where org_id = ${orgId}`.execute(db);
    return rows[0] ?? null;
  }

  /**
   * The org's one customer, created on first use. The idempotency key makes two racing
   * calls get the same customer from Stripe, and the insert keeps the first row.
   */
  async function ensureCustomer(orgId: string, actor: AuditActor): Promise<string> {
    const existing = await account(orgId);
    if (existing) return existing.customerId;
    const customer = await stripe.customers.create(
      { metadata: { org_id: orgId } },
      { idempotencyKey: `customer-${orgId}` },
    );
    await db.transaction().execute(async (tx) => {
      const inserted = await sql`insert into org_billing (org_id, stripe_customer_id)
        values (${orgId}, ${customer.id}) on conflict (org_id) do nothing
        returning org_id`.execute(tx);
      if (!inserted.rows.length) return;
      await recordAudit(tx, {
        orgId,
        actor,
        action: 'billing_customer.create',
        target: `customer:${customer.id}`,
      });
    });
    // A racing call may have stored its row first; the stored one is the org's.
    return (await account(orgId))?.customerId ?? customer.id;
  }

  /** The customer's Checkout Sessions still open are expired, so none of them can be paid. */
  async function expireOpenSessions(customer: string): Promise<void> {
    for await (const session of stripe.checkout.sessions.list(
      { customer, status: 'open', limit: 100 },
      BOUNDED,
    )) {
      try {
        await stripe.checkout.sessions.expire(session.id, {}, BOUNDED);
      } catch (error) {
        // Completed since the list: its subscription is what the next read finds.
        if (!(error instanceof Stripe.errors.StripeInvalidRequestError)) throw error;
      }
    }
  }

  async function hasLiveStripeSubscription(customer: string): Promise<boolean> {
    for await (const subscription of stripe.subscriptions.list(
      { customer, status: 'all', limit: 100 },
      BOUNDED,
    ))
      if (SUBSCRIBED_STATUSES.includes(subscription.status)) return true;
    return false;
  }

  let checkoutsInFlight = 0;

  return {
    account,

    /**
     * Stripe Checkout for a first subscription, or `subscribed` when the org already has
     * one (the database's last webhook state, then Stripe's own list). One call per org at
     * a time: `busy` when another is running for the org, or when `MAX_CONCURRENT_CHECKOUTS`
     * are running at all. Before a new session, the customer's open ones are expired.
     */
    async checkout(
      orgId: string,
      plan: PaidPlan,
      returnUrl: string,
      actor: AuditActor,
    ): Promise<CheckoutResult> {
      if (hasLiveSubscription(await account(orgId))) return { outcome: 'subscribed' };
      const customer = await ensureCustomer(orgId, actor);
      // shortcut: a per-process count, as the webhook's; a second portal process needs a shared one.
      if (checkoutsInFlight >= MAX_CONCURRENT_CHECKOUTS) return { outcome: 'busy' };
      checkoutsInFlight++;
      try {
        return await db.transaction().execute(async (tx): Promise<CheckoutResult> => {
          const { rows } = await sql<{ locked: boolean }>`
            select pg_try_advisory_xact_lock(hashtext(${`stripe-checkout:${orgId}`})) as locked`.execute(
            tx,
          );
          if (!rows[0].locked) return { outcome: 'busy' };
          await expireOpenSessions(customer);
          if (await hasLiveStripeSubscription(customer)) return { outcome: 'subscribed' };
          const session = await stripe.checkout.sessions.create(
            {
              mode: 'subscription',
              customer,
              client_reference_id: orgId,
              line_items: [{ price: config.prices[plan], quantity: 1 }],
              success_url: returnUrl,
              cancel_url: returnUrl,
            },
            BOUNDED,
          );
          if (!session.url) throw new BillingError('Stripe returned no Checkout URL.');
          return { outcome: 'checkout', url: session.url };
        });
      } finally {
        checkoutsInFlight--;
      }
    },

    /** A Customer Portal URL: plan changes, cards, invoices and cancelling. */
    async portalUrl(orgId: string, returnUrl: string): Promise<string> {
      const existing = await account(orgId);
      if (!existing) throw new BillingError('This organization has no billing account yet.');
      const session = await stripe.billingPortal.sessions.create({
        customer: existing.customerId,
        return_url: returnUrl,
      });
      return session.url;
    },
  };
}

import Stripe from 'stripe';
import { sql, type Kysely } from 'kysely';
import { recordAudit, type AuditActor } from '../audit-log';
import { readSecretEnv } from '../secret-env';
import type { PlanId } from './plans';

/**
 * Stripe customers, Checkout and the Customer Portal (#261, ADR 0001 §6). Subscription
 * state is never read from here: only the verified webhook (src/billing/stripe-webhook.ts)
 * changes it.
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

  return {
    account,

    /** A Checkout URL for a first subscription; refused while one is live. */
    async checkoutUrl(
      orgId: string,
      plan: PaidPlan,
      returnUrl: string,
      actor: AuditActor,
    ): Promise<string> {
      if (hasLiveSubscription(await account(orgId)))
        throw new BillingError('This organization already has a subscription.');
      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: await ensureCustomer(orgId, actor),
        client_reference_id: orgId,
        line_items: [{ price: config.prices[plan], quantity: 1 }],
        success_url: returnUrl,
        cancel_url: returnUrl,
      });
      if (!session.url) throw new BillingError('Stripe returned no Checkout URL.');
      return session.url;
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

import type Stripe from 'stripe';
import { sql, type Kysely } from 'kysely';
import { recordAudit } from '../audit-log';
import { orgEntitlements, type PlanId } from './plans';
import { trackPayment } from './payment-grace';
import { planForPrice, stripeClient, type StripeConfig } from './stripe';

/**
 * The Stripe webhook (#345, ADR 0001 §6): the only writer of an org's subscription state.
 * Stripe does not deliver events in order, so an event's payload is never applied: a
 * verified event only names the customer, and the handler reads that customer's current
 * subscriptions from Stripe and stores them. Whatever order events arrive in, the state
 * after the last one is Stripe's state at that moment.
 */

export type WebhookOutcome =
  /** The signature (or its header) is missing or wrong: answer 400. */
  | 'invalid_signature'
  /** A type IRIS does not act on, or a customer it does not know: answer 200. */
  | 'ignored'
  /** Seen before: answer 200, nothing read or changed. */
  | 'duplicate'
  | 'applied'
  /** Too many deliveries in flight: answer 503, and Stripe delivers it again later. */
  | 'busy';

/** What IRIS needs of one of the customer's subscriptions. */
export interface SubscriptionSnapshot {
  id: string;
  status: string;
  priceId: string | null;
  /** Seconds since the epoch, as Stripe gives it. */
  created: number;
}

/** The customer's subscriptions as Stripe has them now, any status. */
export type ReadSubscriptions = (customerId: string) => Promise<SubscriptionSnapshot[]>;

/** Statuses that keep the paid plan; past_due too: the grace period (#266) suspends, it does not downgrade. */
const ENTITLED_STATUSES = ['active', 'trialing', 'past_due'];

/** Statuses of a subscription whose latest invoice went unpaid (#266). */
const PAYMENT_FAILED_STATUSES = ['past_due', 'unpaid'];

type Reference = string | { id: string } | null | undefined;
const idOf = (reference: Reference): string | null =>
  typeof reference === 'string' ? reference : (reference?.id ?? null);

/** The customer a handled event is about; `null` for every other type. */
function customerOf(event: Stripe.Event): string | null {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
    case 'invoice.paid':
    case 'invoice.payment_failed':
      return idOf(event.data.object.customer);
    default:
      return null;
  }
}

/** The newest entitled subscription (what the org pays for), else the newest, else none. */
function currentSubscription(subscriptions: SubscriptionSnapshot[]): SubscriptionSnapshot | null {
  const newestFirst = [...subscriptions].sort((a, b) => b.created - a.created);
  const entitled = newestFirst.find((s) => ENTITLED_STATUSES.includes(s.status));
  return entitled ?? newestFirst[0] ?? null;
}

function planOf(current: SubscriptionSnapshot | null, config: StripeConfig): PlanId {
  if (!current || !ENTITLED_STATUSES.includes(current.status)) return 'free';
  // A price IRIS does not sell grants nothing.
  return planForPrice(config, current.priceId ?? '') ?? 'free';
}

/** Only on a real change: `setPlan` replaces the overrides, and a support grant should stay. */
async function applyPlan(tx: Kysely<unknown>, orgId: string, plan: PlanId) {
  const entitlements = orgEntitlements(tx);
  if ((await entitlements.get(orgId)).plan !== plan) await entitlements.setPlan(orgId, plan);
}

/**
 * Applies one event for a known customer. The row lock is held while Stripe is read, so
 * two events of one org are applied one after the other and the later commit carries the
 * later read. A redelivery waits on the event key and reads nothing.
 */
async function applyEvent(
  tx: Kysely<unknown>,
  event: Stripe.Event,
  customerId: string,
  dependencies: { config: StripeConfig; readSubscriptions: ReadSubscriptions; graceDays?: number },
): Promise<WebhookOutcome> {
  const { rows } = await sql<{ org_id: string }>`
    select org_id from org_billing where stripe_customer_id = ${customerId} for update`.execute(tx);
  const orgId = rows[0]?.org_id;
  if (!orgId) return 'ignored';
  const recorded = await sql`insert into stripe_events (event_id, org_id, type)
    values (${event.id}, ${orgId}, ${event.type})
    on conflict (event_id) do nothing returning event_id`.execute(tx);
  if (!recorded.rows.length) return 'duplicate';
  const current = currentSubscription(await dependencies.readSubscriptions(customerId));
  const plan = planOf(current, dependencies.config);
  await sql`update org_billing set stripe_subscription_id = ${current?.id ?? null},
      subscription_status = ${current?.status ?? null}, updated_at = now()
    where org_id = ${orgId}`.execute(tx);
  await applyPlan(tx, orgId, plan);
  await trackPayment(tx, orgId, {
    failing: PAYMENT_FAILED_STATUSES.includes(current?.status ?? ''),
    graceDays: dependencies.graceDays,
  });
  await recordAudit(tx, {
    orgId,
    action: 'subscription.update',
    target: `event:${event.id}`,
    metadata: {
      type: event.type,
      subscription: current?.id ?? null,
      status: current?.status ?? null,
      plan,
    },
  });
  return 'applied';
}

/**
 * Reads through the Stripe API. Bounded and without retries: it runs while the org's row
 * is locked, and a failure is retried by Stripe redelivering the event instead.
 */
function stripeSubscriptionReader(config: StripeConfig): ReadSubscriptions {
  const stripe = stripeClient(config, { timeout: 10_000, maxNetworkRetries: 0 });
  return async (customerId) => {
    const snapshots: SubscriptionSnapshot[] = [];
    // The iterator follows `has_more`: an older live subscription may be past the first page.
    for await (const subscription of stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 100,
    })) {
      snapshots.push({
        id: subscription.id,
        status: subscription.status,
        priceId: subscription.items.data[0]?.price.id ?? null,
        created: subscription.created,
      });
    }
    return snapshots;
  };
}

/**
 * Deliveries applied at once. Each holds a connection of the pool tenant traffic shares for
 * up to the Stripe read's 10 s timeout, so a Stripe outage's redelivery waves must not take
 * every connection: the rest are answered `busy` and Stripe redelivers them.
 */
export const MAX_CONCURRENT_DELIVERIES = 2;

/**
 * Answers one delivery, given the exact body bytes Stripe signed and its signature header.
 * Rejects when Stripe cannot be read: nothing is recorded, the route answers 500, and
 * Stripe delivers the event again.
 */
export function stripeWebhookHandler(
  db: Kysely<unknown>,
  config: StripeConfig,
  {
    readSubscriptions = stripeSubscriptionReader(config),
    maxConcurrentDeliveries = MAX_CONCURRENT_DELIVERIES,
    graceDays,
  }: {
    readSubscriptions?: ReadSubscriptions;
    maxConcurrentDeliveries?: number;
    /** Days from a failed payment to suspension (#266); `resolveGraceDays()` in production. */
    graceDays?: number;
  } = {},
) {
  let deliveriesInFlight = 0;
  const stripe = stripeClient(config);
  const verify = (rawBody: string, signature: string): Stripe.Event | null => {
    try {
      return stripe.webhooks.constructEvent(rawBody, signature, config.webhookSecret);
    } catch {
      return null;
    }
  };
  return async (rawBody: string, signature: string | undefined): Promise<WebhookOutcome> => {
    const event = signature ? verify(rawBody, signature) : null;
    if (!event) return 'invalid_signature';
    const customerId = customerOf(event);
    if (!customerId) return 'ignored';
    if (deliveriesInFlight >= maxConcurrentDeliveries) return 'busy';
    deliveriesInFlight++;
    try {
      return await db
        .transaction()
        .execute((tx) =>
          applyEvent(tx, event, customerId, { config, readSubscriptions, graceDays }),
        );
    } finally {
      deliveriesInFlight--;
    }
  };
}

import type Stripe from 'stripe';
import { sql, type Kysely } from 'kysely';
import { recordAudit } from '../audit-log';
import { orgEntitlements, type PlanId } from './plans';
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
  | 'applied';

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

/** Statuses that keep the paid plan; past_due too, until #266's grace period decides. */
const ENTITLED_STATUSES = ['active', 'trialing', 'past_due'];

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
  dependencies: { config: StripeConfig; readSubscriptions: ReadSubscriptions },
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
    // shortcut: the first 100 subscriptions only; a customer has one or two, page past 100 if that ever changes.
    const page = await stripe.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 100,
    });
    return page.data.map((subscription) => ({
      id: subscription.id,
      status: subscription.status,
      priceId: subscription.items.data[0]?.price.id ?? null,
      created: subscription.created,
    }));
  };
}

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
  }: { readSubscriptions?: ReadSubscriptions } = {},
) {
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
    return db
      .transaction()
      .execute((tx) => applyEvent(tx, event, customerId, { config, readSubscriptions }));
  };
}

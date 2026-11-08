import type Stripe from 'stripe';
import { sql, type Kysely } from 'kysely';
import { recordAudit } from '../audit-log';
import { orgEntitlements, type PlanId } from './plans';
import { planForPrice, stripeClient, type StripeConfig } from './stripe';

/**
 * The Stripe webhook (#345, ADR 0001 §6): the only writer of an org's subscription state.
 * Each event is verified against the raw body, recorded once in `stripe_events` (a
 * redelivery has no effect) and applied only when it is not older than the state it
 * would replace (Stripe does not deliver in order).
 */

export type WebhookOutcome =
  /** The signature (or its header) is missing or wrong: answer 400. */
  | 'invalid_signature'
  /** A type IRIS does not act on, or a customer it does not know: answer 200. */
  | 'ignored'
  /** Seen before: answer 200, nothing changed. */
  | 'duplicate'
  /** Recorded, but older than the state, or about another subscription. */
  | 'stale'
  | 'applied';

/** What one event says about an org's billing. */
interface BillingChange {
  customerId: string;
  subscriptionId: string | null;
  status?: string;
  plan?: PlanId;
  /** Only applies to the subscription the org has now (a deleted old one must not downgrade). */
  currentOnly?: boolean;
}

/** Statuses that keep the paid plan; past_due too, until #266's grace period decides. */
const ENTITLED_STATUSES = ['active', 'trialing', 'past_due'];

type Reference = string | { id: string } | null | undefined;
const idOf = (reference: Reference): string | null =>
  typeof reference === 'string' ? reference : (reference?.id ?? null);

function fromSubscription(subscription: Stripe.Subscription, config: StripeConfig): BillingChange {
  const price = subscription.items.data[0]?.price.id ?? '';
  const paid = ENTITLED_STATUSES.includes(subscription.status);
  return {
    customerId: idOf(subscription.customer) ?? '',
    subscriptionId: subscription.id,
    status: subscription.status,
    // A price IRIS does not sell grants nothing.
    plan: (paid && planForPrice(config, price)) || 'free',
  };
}

function fromInvoice(invoice: Stripe.Invoice, status: string): BillingChange | null {
  const customerId = idOf(invoice.customer);
  const subscriptionId = idOf(invoice.parent?.subscription_details?.subscription);
  if (!customerId || !subscriptionId) return null;
  return { customerId, subscriptionId, status, currentOnly: true };
}

function changeFor(event: Stripe.Event, config: StripeConfig): BillingChange | null {
  switch (event.type) {
    case 'checkout.session.completed': {
      const customerId = idOf(event.data.object.customer);
      const subscriptionId = idOf(event.data.object.subscription);
      return customerId ? { customerId, subscriptionId } : null;
    }
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      return fromSubscription(event.data.object, config);
    case 'customer.subscription.deleted':
      return { ...fromSubscription(event.data.object, config), plan: 'free', currentOnly: true };
    case 'invoice.paid':
      return fromInvoice(event.data.object, 'active');
    case 'invoice.payment_failed':
      return fromInvoice(event.data.object, 'past_due');
    default:
      return null;
  }
}

interface BillingRow {
  org_id: string;
  stripe_subscription_id: string | null;
  subscription_status: string | null;
  status_at: Date | null;
}

/** Stripe never reactivates an ended subscription, so nothing later about it applies. */
const ENDED_STATUSES = ['canceled', 'incomplete_expired'];
const hasEnded = (row: BillingRow, change: BillingChange): boolean =>
  ENDED_STATUSES.includes(row.subscription_status ?? '') &&
  row.stripe_subscription_id !== null &&
  row.stripe_subscription_id === change.subscriptionId;

function isStale(row: BillingRow, change: BillingChange, eventAt: Date): boolean {
  if (row.status_at && row.status_at > eventAt) return true;
  if (hasEnded(row, change)) return true;
  return (
    Boolean(change.currentOnly && row.stripe_subscription_id) &&
    row.stripe_subscription_id !== change.subscriptionId
  );
}

function nextState(row: BillingRow, change: BillingChange, eventAt: Date) {
  const subscriptionId = change.subscriptionId ?? row.stripe_subscription_id;
  // A newly linked subscription must not inherit the old one's status (an ended one is final).
  const keptStatus = subscriptionId === row.stripe_subscription_id ? row.subscription_status : null;
  return {
    subscriptionId,
    status: change.status ?? keptStatus,
    // Only subscription events carry the plan; Checkout and invoices arrive after the
    // subscription event they follow, so they must not make it stale.
    statusAt: change.plan === undefined ? row.status_at : eventAt,
  };
}

async function applyChange(
  tx: Kysely<unknown>,
  event: Stripe.Event,
  change: BillingChange,
): Promise<WebhookOutcome> {
  // The row lock orders events for one org; a concurrent redelivery waits on the event key.
  const { rows } = await sql<BillingRow>`
    select org_id, stripe_subscription_id, subscription_status, status_at from org_billing
    where stripe_customer_id = ${change.customerId} for update`.execute(tx);
  const row = rows[0];
  if (!row) return 'ignored';
  const recorded = await sql`insert into stripe_events (event_id, org_id, type)
    values (${event.id}, ${row.org_id}, ${event.type})
    on conflict (event_id) do nothing returning event_id`.execute(tx);
  if (!recorded.rows.length) return 'duplicate';
  const eventAt = new Date(event.created * 1000);
  if (isStale(row, change, eventAt)) return 'stale';
  const next = nextState(row, change, eventAt);
  await sql`update org_billing set
      stripe_subscription_id = ${next.subscriptionId}, subscription_status = ${next.status},
      status_at = ${next.statusAt}, updated_at = now()
    where org_id = ${row.org_id}`.execute(tx);
  await applyPlan(tx, row.org_id, change.plan);
  await recordAudit(tx, {
    orgId: row.org_id,
    action: 'subscription.update',
    target: `event:${event.id}`,
    metadata: { type: event.type, status: change.status ?? null, plan: change.plan ?? null },
  });
  return 'applied';
}

/** Only on a real change: `setPlan` replaces the overrides, and a support grant should stay. */
async function applyPlan(tx: Kysely<unknown>, orgId: string, plan: PlanId | undefined) {
  const entitlements = orgEntitlements(tx);
  if (plan && (await entitlements.get(orgId)).plan !== plan)
    await entitlements.setPlan(orgId, plan);
}

/** Answers one delivery, given the exact body bytes Stripe signed and its signature header. */
export function stripeWebhookHandler(db: Kysely<unknown>, config: StripeConfig) {
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
    const change = changeFor(event, config);
    if (!change) return 'ignored';
    return db.transaction().execute((tx) => applyChange(tx, event, change));
  };
}

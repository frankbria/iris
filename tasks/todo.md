# #266 [P0.38] Payment failure: grace period, suspension and restore

Stacked on `feature/261-345-stripe-billing` (draft PR #636): this needs its webhook and
`org_billing`. Self-authored plan (the issue had none); the owner's comment on the issue
says to reuse `org_suspensions` with actor `billing`.

## Decisions (autonomous)
- **Driven by Stripe's state, not the event type** (the #636 rule: a payload is never
  applied). Any handled event re-reads the customer's subscriptions; a current subscription
  that is `past_due` or `unpaid` means a payment failed. `invoice.payment_failed` is what
  triggers that read in practice, `invoice.paid` the one that ends it.
- **The deadline is stored** (`org_billing.payment_grace_ends_at`, set once when the failure
  is first seen): the sweep and the portal need no configuration, and changing the setting
  never moves a running deadline.
- **`IRIS_BILLING_GRACE_DAYS`**, whole days 0-90, default 7, read by the API server
  (the webhook's process). Malformed refuses to start, like the other billing settings.
- **Suspension is an `org_suspensions` row with actor `billing`**, written by a sweep in the
  API server (every minute, only when Stripe is configured). Enforcement is #348's, unchanged:
  key auth 403, live connections closed at the re-check, jobs refused, portal key writes.
- **One billing suspension per failure** (`payment_suspended_at`): an operator's
  `unsuspend-org` after it is an extension that stays until the payment is settled or fails
  again. An org an operator already suspended is left alone and picked up if they lift it.
- **Restore lifts only a billing suspension** (latest row is `suspend` by `billing`); an
  operator's abuse suspension survives a paid invoice.
- **A cancelled subscription ends the failure too**: the org drops to free (already #345)
  and the suspension lifts, since nothing more is owed going forward. For Frank to confirm.
- A billing-suspended org's owners and admins can still open the Stripe Customer Portal
  (otherwise they could not pay); Checkout and key writes stay refused.
- Migration is `0022`: `0021` is taken by draft PR #637 (#264). Merge #637 first.

## Steps
1. Migration `0022_billing_grace`: `org_billing.payment_grace_ends_at`,
   `payment_suspended_at` (both nullable timestamptz).
2. `org-suspension.ts`: `suspend`/`unsuspend` join a caller's transaction (as `setPlan` does).
3. `src/billing/payment-grace.ts`: `resolveGraceDays(env)`, `suspendOverdueOrgs(db, now)`,
   `paymentState(db, orgId)`, `startGraceSweep(db)`.
4. `stripe-webhook.ts`: start the grace period / restore inside the event's transaction;
   audit `billing.grace_start`, `billing.suspend`, `billing.restore`.
5. `hostedServices`: grace days into the handler, start the sweep.
6. Portal: `requireOrg()` returns `payment`; one `OrgBanner` (grace warning, payment
   suspension with a link to Billing, operator suspension); `openBillingPortal` allowed for a
   billing suspension.
7. Docs: `.claude/rules/hosted-data.md`, `docs/data-flows.md`, runbook, `plans/README.md`.

## Acceptance criteria
- [ ] `invoice.payment_failed` starts a grace period (configurable); after it the org is
      suspended: new sessions/jobs rejected, live sessions closed, portal banner shown
- [ ] `invoice.paid` restores; all transitions audited
- [ ] Tests drive the state machine with webhook fixtures

## Test strategy
- `__tests__/db/payment-grace.test.ts`: real Postgres, signed webhook fixtures, the in-test
  Stripe reader; the sweep takes `now`. Asserts key-store suspension, job claim refusal,
  audit rows, operator-suspension interplay, out-of-order delivery.
- `__tests__/billing/payment-grace.test.ts`: `resolveGraceDays`.
- Portal: Jest for the banner, E2E (`billing.spec.ts`) for the banner states and the
  Customer Portal exemption.

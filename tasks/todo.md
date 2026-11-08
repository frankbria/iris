# #261 [P0.33] + #345 [P0.34] Stripe customer, subscription lifecycle and webhook

Scope decided with the owner (2026-11-08): one PR closes both. ADR 0001 §6 says subscription
state comes only from signature-verified, idempotent webhooks, so #261's subscribe/upgrade/cancel
E2E cannot pass without #345. Prices: pro $49/mo, team $199/mo, no annual.

## Decisions (autonomous)
- SDK: `stripe@23.1.0`, pinned exactly in the root package (the API server and the portal both
  import `src/`).
- Config, all through `readSecretEnv` (`_FILE` variants): `IRIS_STRIPE_SECRET_KEY`,
  `IRIS_STRIPE_WEBHOOK_SECRET`, `IRIS_STRIPE_PRICE_PRO`, `IRIS_STRIPE_PRICE_TEAM`. None set means
  billing is off (buttons hidden, webhook 404). A partial config throws at startup, like
  `resolveManagedKey`.
- The webhook lives on the REST surface (ADR: `REST /v1/... Stripe webhook`): `POST /v1/stripe/webhook`.
- Plan changes go through the existing `orgEntitlements(db).setPlan` (audits `plan.set`).
- The grace period and suspension on payment failure are #266. Here, `invoice.payment_failed`
  and `invoice.paid` only record `subscription_status`.

## Steps
1. **Migration `0020_org_billing`** (register it in `src/db/migrate.ts`):
   - `org_billing`: `org_id` text pk referencing organization, `stripe_customer_id` unique not null,
     `stripe_subscription_id`, `subscription_status`, `status_at` timestamptz (the Stripe event's
     `created`, for out-of-order delivery), `updated_at`.
   - `stripe_events`: `event_id` text pk, `org_id` not null, `type`, `processed_at`, plus an index
     leading with `org_id`.
2. **`src/billing/stripe.ts`**: config resolution; plan↔price map; `ensureCustomer(db, stripe, orgId)`
   (one customer per org, metadata `org_id`, idempotency key `customer-<orgId>`);
   `checkoutUrl(orgId, plan, returnUrl)` (mode subscription, `client_reference_id` = orgId);
   `portalUrl(orgId, returnUrl)`.
3. **`src/billing/stripe-webhook.ts`**: verify with `stripe.webhooks.constructEvent` on the raw
   body. Resolve the org from customer → `org_billing`. In one transaction: insert the event id
   (on conflict do nothing → duplicate, no effect), then apply:
   - `checkout.session.completed` links customer and subscription.
   - `customer.subscription.created`/`updated` sets the plan from the price and the status.
   - `customer.subscription.deleted` sets free and canceled.
   - `invoice.paid` / `invoice.payment_failed` set the status.

   Events older than `status_at` are recorded but don't change state. Unknown customers get a
   200 and are ignored.
4. **Route** `POST /v1/stripe/webhook` with the raw body capped like `MAX_BODY_BYTES`: 400 on a bad
   signature, 200 on handled or duplicate.
5. **Portal**: a `billing: ['manage']` resource for owner and admin in `src/auth/config.ts`. Server
   actions `startCheckout` and `openBillingPortal` (permission check → suspension check → redirect to
   the Stripe URL). The org page shows the plan and status, with Upgrade buttons for managers or
   Manage billing once a customer exists.
6. **Ops and docs**: compose files and `deploy.sh` (optional `_FILE` secrets), the `jest.setup.ts`
   scrub list, `docs/data-flows.md` (Payments section, the new stores, audit actions),
   `.claude/rules/hosted-data.md`, `plans/README.md`, and runbook notes for Stripe setup.

## Acceptance criteria
- [ ] (#261) One Stripe customer per org; Checkout for plan purchase; Customer Portal link
- [ ] (#261) Org stores `stripe_customer_id`, `plan`, `subscription_status`
- [ ] (#261) Test-mode E2E: subscribe, upgrade, cancel (**needs the owner's Stripe test account**)
- [ ] (#345) Handler verifies signatures, stores processed event IDs (unique), handles out-of-order delivery
- [ ] (#345) Handles checkout.session.completed, customer.subscription.updated/deleted, invoice.paid, invoice.payment_failed
- [ ] (#345) Replaying the same event twice has one effect

## Test strategy
- Unit: config resolution (all, none, partial) and the price↔plan map.
- DB integration (real Postgres): the webhook handler, with payloads signed by
  `stripe.webhooks.generateTestHeaderString` (real verification, no Stripe account): bad signature,
  duplicate replay, out-of-order, every event type, unknown customer.
- HTTP: the route returns 400/200 and enforces the body cap.
- E2E (portal): a forged post by a member is refused; the controls are hidden for members.
- Gated on `IRIS_TEST_STRIPE_SECRET_KEY`: Checkout and Portal session creation against Stripe test
  mode, plus the demo of subscribe → upgrade → cancel through the Stripe CLI.

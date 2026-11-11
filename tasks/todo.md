# #264 [P0.36] Report managed-credit usage to Stripe meters

Stacked on `feature/261-345-stripe-billing` (draft PR #636): it needs `org_billing` and the
Stripe client from there. Stays a draft until #636 merges and the Stripe test-mode run is done
(the issue closes on test mode, owner scope note 2026-10-10).

## Decisions (autonomous)
- **Where it runs:** the worker, under a Postgres advisory lock, as ADR 0001 §1 says. So the
  worker service now receives the four `IRIS_STRIPE_*` settings (all or none, as in `iris connect`).
- **One meter event per managed `usage_events` row**, with the row's own timestamp, so usage
  lands in the billing period it happened in. Identifier and idempotency key are both
  `usage-<row id>`: a retry is not a second charge.
- **Unit:** integer micro-USD of provider cost (`round(quantity * unit_cost_usd * 1e6)`), so
  ledger and Stripe totals compare exactly. The meter's event name is a constant,
  `iris_managed_ai_micro_usd`; no new setting.
- **Estimated rows (#243) are reported as they are.** The credit gate already counts them at
  that rate (`managedSpendThisMonth`), so the meter matches what the org's credit was charged.
  The reconciliation report shows the estimated part apart. Reversible: a filter on the query.
- **What the meter is priced at is not decided here.** A meter records usage whether or not a
  price is attached. Managed usage cannot exceed the plan's included credit today, so there is
  nothing to charge beyond the subscription; a metered price is an owner decision for later.
- Rows of an org with no Stripe customer, and rows older than Stripe's 35-day window, cannot be
  sent. They stay unreported and show in the reconciliation report.

## Steps
1. **Migration `0021_usage_stripe_reported`**: `usage_events.stripe_reported_at timestamptz`,
   and a partial index on `(id)` for unreported managed rows. Register in `src/db/migrate.ts`.
2. **`src/billing/stripe-meter.ts`**:
   - `stripeMeters(stripe)`: `send(event)` (meter event, identifier + idempotency key) and
     `total(customerId, from, to)` (the meter's event summaries). A Stripe invalid-request
     error becomes `MeterEventRejected`; anything else propagates.
   - `reportManagedUsage(db, meters)`: one pass under `pg_try_advisory_lock`; pages by id,
     sends each row, marks the accepted ones; a rejected row is counted and left, any other
     error ends the pass.
   - `runMeterReports({ db, meters, signal, intervalMs })`: the periodic loop.
   - `meterReconciliation(db, meters, { from, to })`: per org, ledger total, estimated part,
     unreported part, Stripe total, difference.
3. **CLI**: `iris worker` starts the loop when Stripe is configured (partial config exits 3);
   `iris admin billing-reconcile --from --to` prints the report as JSON, exit 3 on a difference.
4. **Compose**: Stripe settings and secrets on the worker service.
5. **Docs**: `.claude/rules/hosted-data.md`, `docs/data-flows.md`, runbook (meter setup, key
   permissions, the reconcile command), `plans/README.md` (P0.36, and P0.54 per the owner).

## Acceptance criteria
- [ ] Periodic job sends unreported managed usage as Stripe meter events with idempotency
      keys; retries safely
- [ ] BYOK usage is not billed as AI spend
- [ ] Reconciliation report: ledger total vs Stripe total per period

## Tests
- `__tests__/db/stripe-meter.test.ts` (real Postgres, an in-test meter): only managed rows are
  sent; BYOK and platform rows never; a second pass sends nothing; a crash between send and
  mark resends with the same identifier; a rejected row does not block the others; a Stripe
  outage ends the pass and the next one resumes; two concurrent passes send each row once; no
  customer and too-old rows stay unreported; the reconciliation totals.
- `__tests__/billing/stripe-meter-gateway.test.ts`: the real Stripe SDK against a local HTTP
  server: the request it sends (event name, payload, identifier, timestamp, idempotency key),
  400 → `MeterEventRejected`, 500 → propagates, summaries summed over pages.
- Gated on `IRIS_TEST_STRIPE_SECRET_KEY`: one row to a real test-mode meter.
- `container-config.test.ts`, `worker-cli.test.ts`, `admin-cli.test.ts`, `db/postgres.test.ts`.

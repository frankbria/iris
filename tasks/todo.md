# #271 [P0.43] Portal: usage and billing page

Stacked on #636 (`feature/261-345-stripe-billing`): the Customer Portal action and
`org_billing` come from there. Self-authored plan (the issue had none).

## Decisions (autonomous)
- One page, `/usage`, linked from the dashboard. Every member can read it; the billing
  controls are for owners and admins, as on `/org` (the `billing: ['manage']` permission).
- The period is the current UTC calendar month: it is the window the limits are enforced
  on (#346) and the managed credit is counted on (#479), whatever the Stripe billing date.
- "Runs" shows the number the API enforces: this month's billed jobs plus queued and
  running ones. The query moves out of `enqueue` into `runsUsedThisMonth` so the page and
  the 402 cannot disagree.
- Credit left = plan credit minus this month's managed spend, the figure `/provider-keys`
  already shows.
- The Billing section of `/org` becomes a shared server component, rendered on both pages.

## Steps
1. `src/billing/usage.ts`: `runsUsedThisMonth(db, orgId)`; `enqueue` uses it.
   Test: `__tests__/db/usage-ledger.test.ts`.
2. `apps/portal/lib/usage.ts` (pure): month bounds, usage-vs-limit lines, the BYOK/managed
   split, USD formatting. Test: `apps/portal/__tests__/usage.test.ts`.
3. `apps/portal/components/billing-section.tsx` (moved from `app/org/page.tsx`),
   `apps/portal/app/usage/page.tsx`, dashboard link. Test: `apps/portal/e2e/usage.spec.ts`.
4. Docs: `.claude/rules/portal-pages.md`, `docs/data-flows.md` if a read is new,
   `plans/README.md`.

## Acceptance criteria
- [ ] Current plan, period usage vs limits, managed credits remaining, BYOK vs managed split
- [ ] Links to Stripe Customer Portal

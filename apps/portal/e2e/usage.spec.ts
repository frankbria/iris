import { expect, test } from "@playwright/test"
import { Client } from "pg"

import {
  logIn,
  ownRateLimitBucket,
  PASSWORD,
  signUpVerified,
  unique,
} from "./accounts"
import { e2eEnv } from "./env"

/**
 * The usage and billing page (#271) through the real portal: the plan, this month's
 * usage against its limits, the IRIS credit left and the BYOK/managed split, all read
 * from rows written the way the ledger (#263) and the webhook (#345) write them.
 * Stripe is configured with placeholders and never reached (as billing.spec.ts).
 */
const { baseURL, databaseUrl } = e2eEnv()

test.beforeEach(({ context }) => ownRateLimitBucket(context))

async function sql<T>(query: string, params: unknown[] = []): Promise<T[]> {
  const db = new Client({ connectionString: databaseUrl })
  await db.connect()
  try {
    return (await db.query(query, params)).rows as T[]
  } finally {
    await db.end()
  }
}

const orgOf = async (email: string) =>
  (
    await sql<{ id: string }>(
      `select "organizationId" as id from member where "userId" = (select id from "user" where email = $1)`,
      [email]
    )
  )[0].id

test("a new org: the free plan, nothing used, no credits, reached from the dashboard", async ({
  page,
  context,
}) => {
  const email = unique()
  await signUpVerified(context.request, email, "Uma")
  await logIn(page, email, PASSWORD)
  await page.getByRole("link", { name: "Usage and billing" }).click()
  await expect(page).toHaveURL(/\/usage$/)

  const plan = page.getByRole("region", { name: "Plan" })
  await expect(plan.getByText("Plan: Free")).toBeVisible()
  await expect(plan.getByText("1 browser session at a time.")).toBeVisible()
  await expect(
    plan.getByRole("button", { name: "Upgrade to Pro", exact: true })
  ).toBeVisible()
  await expect(
    plan.getByRole("button", { name: "Manage billing" })
  ).toHaveCount(0)

  const usage = page.getByRole("table", { name: /^Usage from / })
  await expect(
    usage.getByRole("row", { name: "Runs 0 50", exact: true })
  ).toBeVisible()
  await expect(
    usage.getByRole("row", {
      name: "Artifact storage 0 B 1.0 GiB",
      exact: true,
    })
  ).toBeVisible()

  const credits = page.getByRole("region", { name: "IRIS credits" })
  await expect(
    credits.getByText("Your plan includes no IRIS credits.")
  ).toBeVisible()
  await expect(
    credits.getByText("AI calls use your organization's own provider keys.")
  ).toBeVisible()
  await expect(
    page
      .getByRole("table", { name: "AI usage this month, by who paid" })
      .getByRole("row", { name: "Total 0 $0.00 0 $0.00", exact: true })
  ).toBeVisible()
})

test("a paid org: usage against the plan, credit left, the split, and billing for managers only", async ({
  page,
  context,
  browser,
}) => {
  const email = unique()
  await signUpVerified(context.request, email, "Bea")
  await logIn(page, email, PASSWORD)
  await expect(page).toHaveURL(/\/dashboard$/)
  const orgId = await orgOf(email)

  // As the webhook leaves a subscribed org (#345), with a support grant on one limit.
  await sql(
    "insert into org_billing (org_id, stripe_customer_id, stripe_subscription_id, subscription_status) values ($1, $2, 'sub_usage', 'past_due')",
    [orgId, `cus_usage_${orgId}`]
  )
  await sql(
    `insert into org_plans (org_id, plan, overrides) values ($1, 'pro', '{"visionCallsPerMonth": 1}')`,
    [orgId]
  )
  await sql(
    "insert into org_ai_settings (org_id, mode, updated_by) values ($1, 'managed', 'user:e2e')",
    [orgId]
  )
  // Another org, and last month: neither may show up below.
  const other = `other-${orgId}`
  await sql(
    `insert into organization (id, name, slug, "createdAt") values ($1, $1, $1, now())`,
    [other]
  )
  await sql(
    `insert into usage_events (org_id, kind, quantity, billing_mode, idempotency_key, unit_cost_usd, estimated, created_at) values
      ($1, 'a11y_job', 3, null, 'a', null, false, now()),
      ($1, 'visual_job', 4, null, 'v', null, false, now()),
      ($1, 'agent_turn', 5, 'byok', 'g', 0.1, false, now()),
      ($1, 'text_call', 2, 'byok', 't1', 0.01, false, now()),
      ($1, 'text_call', 2, 'managed', 't2', 0.5, false, now()),
      ($1, 'text_call', 1, 'managed', 't3', 0.5, true, now()),
      ($1, 'vision_call', 1, 'managed', 'i', 0.25, false, now()),
      ($1, 'browser_minutes', 12.25, null, 'm', null, false, now()),
      ($1, 'observation', 7, null, 'o', null, false, now()),
      ($1, 'text_call', 100, 'managed', 'old', 1, false, date_trunc('month', now()) - interval '1 day'),
      ($1, 'a11y_job', 100, null, 'old-job', null, false, date_trunc('month', now()) - interval '1 day'),
      ($2, 'text_call', 100, 'managed', 'theirs', 1, false, now()),
      ($2, 'a11y_job', 100, null, 'their-job', null, false, now())`,
    [orgId, other]
  )
  // A queued job counts against the month before it is billed (#346).
  await sql(
    `insert into runs (org_id, kind, status, params) values ($1, 'a11y', 'queued', '{"urls":["https://a.example/"]}')`,
    [orgId]
  )
  await sql(
    "insert into artifact_objects (org_id, key, bytes) values ($1, 'k', $2)",
    [orgId, 5 * 1024 ** 3]
  )

  await page.goto("/usage")
  const plan = page.getByRole("region", { name: "Plan" })
  await expect(plan.getByText("Plan: Pro")).toBeVisible()
  await expect(plan.getByText("(subscription past due)")).toBeVisible()
  await expect(plan.getByText("2 browser sessions at a time.")).toBeVisible()
  // The way to the Stripe Customer Portal: invoices, cards, plan changes, cancelling.
  await expect(
    plan.getByRole("button", { name: "Manage billing" })
  ).toBeVisible()
  await expect(plan.getByRole("button", { name: /^Upgrade/ })).toHaveCount(0)

  const usage = page.getByRole("table", { name: /^Usage from / })
  for (const name of [
    "Runs 8 1,000",
    "Agent turns 5 2,000",
    "Vision calls 1 1 (limit reached)",
    "Artifact storage 5.0 GiB 20.0 GiB",
    "Text AI calls 5 No monthly limit",
    "Page observations 7 No monthly limit",
    "Browser minutes 12.3 No monthly limit",
  ])
    await expect(usage.getByRole("row", { name, exact: true })).toBeVisible()

  const credits = page.getByRole("region", { name: "IRIS credits" })
  await expect(
    credits.getByText("$8.25 of $10.00 left this month.")
  ).toBeVisible()
  await expect(
    credits.getByText("AI calls use IRIS credits first, then your own keys.")
  ).toBeVisible()
  await expect(
    credits.getByRole("link", { name: "AI provider keys" })
  ).toHaveAttribute("href", "/provider-keys")

  const split = page.getByRole("table", {
    name: "AI usage this month, by who paid",
  })
  for (const name of [
    "Text AI calls 2 $0.02 3 $1.50",
    "Vision calls 0 $0.00 1 $0.25",
    "Agent turns 5 $0.50 0 $0.00",
    "Total 7 $0.52 4 $1.75",
  ])
    await expect(split.getByRole("row", { name, exact: true })).toBeVisible()
  await expect(
    page.getByText("$0.50 of these costs is priced at an estimated rate.")
  ).toBeVisible()

  // A member reads the same usage, and gets no billing controls.
  const memberEmail = unique()
  const invited = await context.request.post(
    "/api/auth/organization/invite-member",
    {
      headers: { origin: baseURL },
      data: { email: memberEmail, role: "member" },
    }
  )
  expect(invited.ok()).toBe(true)
  const theirs = await browser.newContext()
  await ownRateLimitBucket(theirs)
  await signUpVerified(theirs.request, memberEmail, "Max")
  expect(
    (
      await theirs.request.post("/api/auth/sign-in/email", {
        data: { email: memberEmail, password: PASSWORD },
      })
    ).ok()
  ).toBe(true)
  expect(
    (
      await theirs.request.post("/api/auth/organization/accept-invitation", {
        headers: { origin: baseURL },
        data: { invitationId: (await invited.json()).id },
      })
    ).ok()
  ).toBe(true)
  const them = await theirs.newPage()
  await them.goto("/usage")
  const theirPlan = them.getByRole("region", { name: "Plan" })
  await expect(theirPlan.getByText("Plan: Pro")).toBeVisible()
  await expect(
    theirPlan.getByText("Only owners and admins can change billing.")
  ).toBeVisible()
  await expect(theirPlan.getByRole("button")).toHaveCount(0)
  await expect(
    them
      .getByRole("table", { name: /^Usage from / })
      .getByRole("row", { name: "Runs 8 1,000", exact: true })
  ).toBeVisible()
  await theirs.close()
})

test("signed out, the page sends you to log in", async ({ request }) => {
  const res = await request.get("/usage", { maxRedirects: 0 })
  expect(res.status()).toBe(307)
  expect(res.headers().location).toBe("/login")
})

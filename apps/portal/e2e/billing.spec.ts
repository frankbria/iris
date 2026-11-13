import { expect, test, type BrowserContext } from "@playwright/test"
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
 * The org page's Billing section (#261) through the real portal. Stripe is configured
 * with placeholders and never reached: the state comes from the database (as the
 * webhook writes it, #345), and the refusals are forged posts, with a positive control
 * that is refused only after the permission check (an operator's suspension). A live
 * subscription's Checkout goes to the Customer Portal (#688), which would reach Stripe.
 */
const { baseURL, databaseUrl } = e2eEnv()

test.beforeEach(({ context }) => ownRateLimitBucket(context))

async function sql<T>(query: string, params: unknown[]): Promise<T[]> {
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

/** The hidden fields of the `/org` form containing `marker`, as the server renders it. */
async function formFields(context: BrowserContext, marker: string) {
  const html = await (await context.request.get("/org")).text()
  const ssrForm = [...html.matchAll(/<form[^>]*>[\s\S]*?<\/form>/g)]
    .map((m) => m[0])
    .find((f) => f.includes(marker))!
  const fields: Record<string, string> = {}
  for (const [, name, value] of ssrForm.matchAll(
    /<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?\/>/g
  ))
    fields[name] = (value ?? "").replaceAll("&quot;", '"')
  return fields
}

/** Posts a form's fields to `/org` from `context`'s session: a forged submit. */
const post = async (context: BrowserContext, fields: Record<string, string>) =>
  (
    await context.request.post("/org", {
      headers: { origin: baseURL },
      multipart: fields,
    })
  ).text()

// The action's answer in the form state, not the banner (which says the same of an operator's).
const REFUSED_SUSPENDED = '{"error":"This organization is suspended."}'

test("managers see the plan and Upgrade; a member's forged Checkout is refused", async ({
  page,
  context,
  browser,
}) => {
  const email = unique()
  await signUpVerified(context.request, email, "Bea")
  await logIn(page, email, PASSWORD)
  await expect(page).toHaveURL(/\/dashboard$/)
  const orgId = await orgOf(email)

  await page.goto("/org")
  const billing = page.getByRole("region", { name: "Billing" })
  await expect(billing.getByText("Plan: Free")).toBeVisible()
  await expect(
    billing.getByRole("button", { name: "Upgrade to Pro", exact: true })
  ).toBeVisible()
  await expect(
    billing.getByRole("button", { name: "Upgrade to Team", exact: true })
  ).toBeVisible()
  await expect(
    billing.getByRole("button", { name: "Manage billing" })
  ).toHaveCount(0)

  // The owner's Checkout form exactly as the server renders it.
  const fields = await formFields(context, 'name="plan" value="pro"')
  const forge = (ctx: BrowserContext) => post(ctx, fields)

  // The webhook has recorded a subscription: the plan shows, Manage billing replaces Upgrade.
  await sql(
    "insert into org_billing (org_id, stripe_customer_id, stripe_subscription_id, subscription_status) values ($1, $2, 'sub_e2e', 'active')",
    [orgId, `cus_e2e_${orgId}`]
  )
  await sql("insert into org_plans (org_id, plan) values ($1, 'pro')", [orgId])
  await page.reload()
  await expect(billing.getByText("Plan: Pro")).toBeVisible()
  await expect(billing.getByText("(subscription active)")).toBeVisible()
  await expect(
    billing.getByRole("button", { name: "Manage billing" })
  ).toBeVisible()
  await expect(billing.getByRole("button", { name: /^Upgrade/ })).toHaveCount(0)

  // A member: sees the plan, no controls.
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
  await them.goto("/org")
  const theirBilling = them.getByRole("region", { name: "Billing" })
  await expect(theirBilling.getByText("Plan: Pro")).toBeVisible()
  await expect(
    theirBilling.getByText("Only owners and admins can change billing.")
  ).toBeVisible()
  await expect(theirBilling.getByRole("button")).toHaveCount(0)

  // Positive control: from the owner's session the forged post reaches the action and
  // passes the permission check; an operator's suspension refuses it before Stripe.
  await sql(
    "insert into org_suspensions (org_id, action, reason, actor) values ($1, 'suspend', 'e2e', 'e2e-operator')",
    [orgId]
  )
  expect(await forge(context)).toContain(REFUSED_SUSPENDED)
  // From the member's session it is refused at the permission check.
  expect(await forge(theirs)).toContain(
    "Only owners and admins can change billing."
  )
  await theirs.close()

  // Neither post reached Stripe: the customer the webhook recorded is the only one.
  expect(
    await sql("select stripe_customer_id from org_billing where org_id = $1", [
      orgId,
    ])
  ).toEqual([{ stripe_customer_id: `cus_e2e_${orgId}` }])
})

/**
 * Payment failure (#266). The state is written as the webhook and the sweep write it:
 * the deadline on `org_billing`, and the suspension as a row by `billing`.
 */

test("a failed payment warns, then suspends with its own banner; an operator's suspension still blocks the Customer Portal", async ({
  page,
  context,
}) => {
  const email = unique()
  await signUpVerified(context.request, email, "Pia")
  await logIn(page, email, PASSWORD)
  await expect(page).toHaveURL(/\/dashboard$/)
  const orgId = await orgOf(email)
  const checkout = await formFields(context, 'name="plan" value="pro"')
  const suspend = (action: "suspend" | "unsuspend", actor: string) =>
    sql(
      "insert into org_suspensions (org_id, action, reason, actor) values ($1, $2, 'e2e', $3)",
      [orgId, action, actor]
    )

  // Within the grace period: a warning with the day it ends, on every org page.
  await sql(
    "insert into org_billing (org_id, stripe_customer_id, stripe_subscription_id, subscription_status, payment_grace_ends_at) values ($1, $2, 'sub_e2e', 'past_due', now() + interval '7 days')",
    [orgId, `cus_e2e_${orgId}`]
  )
  await page.reload()
  const banner = page.getByRole("note")
  await expect(banner).toContainText(
    /A payment for this organization failed\. Update the payment method under Billing by \d{4}-\d\d-\d\d \(UTC\) to avoid suspension\./
  )
  await page.goto("/api-keys")
  await expect(banner).toContainText("A payment for this organization failed.")
  await banner.getByRole("link", { name: "Billing" }).click()
  await expect(page).toHaveURL(/\/org#billing$/)

  // Past it, suspended by billing: the banner says why and Manage billing is still offered.
  await sql(
    "update org_billing set payment_grace_ends_at = now() - interval '1 minute', payment_suspended_at = now() where org_id = $1",
    [orgId]
  )
  await suspend("suspend", "billing")
  await page.reload()
  await expect(banner).toHaveText(
    "This organization is suspended because a payment failed. An owner or admin can update the payment method under Billing to restore it."
  )
  await expect(
    page
      .getByRole("region", { name: "Billing" })
      .getByRole("button", { name: "Manage billing" })
  ).toBeVisible()
  // Paying is the only thing a billing suspension lets through: Checkout stays refused.
  expect(await post(context, checkout)).toContain(REFUSED_SUSPENDED)

  // An operator suspends it as well: the generic banner, and no Customer Portal either.
  const manage = await formFields(context, "Manage billing")
  await suspend("unsuspend", "e2e-operator")
  await suspend("suspend", "e2e-operator")
  await page.reload()
  await expect(banner).toContainText("This organization is suspended. Contact")
  expect(await post(context, manage)).toContain(REFUSED_SUSPENDED)

  // Settled, and the operator done: no banner.
  await suspend("unsuspend", "e2e-operator")
  await sql(
    "update org_billing set subscription_status = 'active', payment_grace_ends_at = null, payment_suspended_at = null where org_id = $1",
    [orgId]
  )
  await page.reload()
  await expect(page.getByRole("region", { name: "Billing" })).toBeVisible()
  await expect(banner).toHaveCount(0)
})

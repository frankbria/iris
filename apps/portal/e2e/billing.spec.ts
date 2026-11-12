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
 * that is refused only after the permission check (a live subscription).
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
  const html = await (await context.request.get("/org")).text()
  const ssrForm = [...html.matchAll(/<form[^>]*>[\s\S]*?<\/form>/g)]
    .map((m) => m[0])
    .find((f) => f.includes('name="plan" value="pro"'))!
  const fields: Record<string, string> = {}
  for (const [, name, value] of ssrForm.matchAll(
    /<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?\/>/g
  ))
    fields[name] = (value ?? "").replaceAll("&quot;", '"')
  const forge = async (ctx: BrowserContext) =>
    (
      await ctx.request.post("/org", {
        headers: { origin: baseURL },
        multipart: fields,
      })
    ).text()

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
  // passes the permission check; the live subscription refuses it before Stripe.
  expect(await forge(context)).toContain(
    "This organization already has a subscription."
  )
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

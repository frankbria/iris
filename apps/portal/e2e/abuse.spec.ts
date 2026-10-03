import { randomBytes } from "node:crypto"

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
 * Abuse handling and contacts (#348) through the real portal. The org is suspended
 * by writing the history row directly, as `iris admin suspend-org` does; the
 * refusals come from the server (BetterAuth hook, server action), not hidden buttons.
 * The server runs with a security and a support contact and no abuse contact
 * (playwright.config.ts); the unset-security case is the route's unit test.
 */
const { databaseUrl } = e2eEnv()

test.beforeEach(({ context }) => ownRateLimitBucket(context))

async function sql(query: string, params: unknown[] = []) {
  const db = new Client({ connectionString: databaseUrl })
  await db.connect()
  try {
    return (await db.query(query, params)).rows
  } finally {
    await db.end()
  }
}

const setSuspended = (orgId: string, action: "suspend" | "unsuspend") =>
  sql(
    `insert into org_suspensions (org_id, action, reason, actor) values ($1, $2, 'e2e reason', 'e2e')`,
    [orgId, action]
  )

test("security.txt is RFC 9116 and points at the contact page", async ({
  request,
  baseURL,
}) => {
  const res = await request.get("/.well-known/security.txt")
  expect(res.status()).toBe(200)
  expect(res.headers()["content-type"]).toBe("text/plain; charset=utf-8")
  const text = await res.text()
  expect(text).toMatch(/^Contact: mailto:security@iris\.test$/m)
  expect(text).toMatch(/^Expires: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/m)
  expect(text).toMatch(/^Preferred-Languages: en$/m)
  expect(text).toContain(`Policy: ${baseURL}/contact`)
  expect(text).toContain(`Canonical: ${baseURL}/.well-known/security.txt`)
})

test("the contact page is public, lists the configured contacts and a placeholder", async ({
  page,
}) => {
  await page.goto("/contact")
  await expect(page).toHaveURL(/\/contact$/)
  await expect(
    page.getByRole("link", { name: "security@iris.test" })
  ).toHaveAttribute("href", "mailto:security@iris.test")
  await expect(
    page.getByRole("link", { name: "support@iris.test" })
  ).toBeVisible()
  await expect(page.getByText("[abuse contact]")).toBeVisible()
  // Linked from the legal footer of the sign-in pages.
  await page.goto("/login")
  await page
    .getByRole("navigation", { name: "Legal" })
    .getByRole("link", { name: "Contact" })
    .click()
  await expect(page).toHaveURL(/\/contact$/)
})

test("a suspended org sees a banner and cannot create keys; unsuspending restores it", async ({
  page,
  context,
}) => {
  const email = unique()
  await signUpVerified(context.request, email, "Sam")
  await logIn(page, email, PASSWORD)
  await expect(page).toHaveURL(/\/dashboard$/)
  const [{ id: orgId }] = await sql(
    `select "organizationId" as id from member where "userId" = (select id from "user" where email = $1)`,
    [email]
  )
  await expect(page.getByText("This organization is suspended")).toHaveCount(0)

  await setSuspended(orgId, "suspend")
  await page.reload()
  const banner = page.getByRole("note")
  await expect(banner).toHaveText(
    "This organization is suspended. Contact support@iris.test."
  )
  // The operator's reason never reaches the tenant.
  expect(await page.content()).not.toContain("e2e reason")

  // API keys: refused by the server.
  await page.goto("/api-keys")
  await expect(page.getByRole("note")).toBeVisible()
  await page.getByLabel("Name").fill("ci")
  await page.getByRole("button", { name: "Create key" }).click()
  await expect(page.getByText("This organization is suspended.")).toHaveCount(2)
  await expect(page.getByLabel("Your new key")).toHaveCount(0)
  expect(
    await sql(`select 1 from apikey where "referenceId" = $1`, [orgId])
  ).toHaveLength(0)

  // Provider keys: refused by the server action.
  await page.goto("/provider-keys")
  const key = ["sk", "proj", randomBytes(24).toString("hex")].join("-")
  await page.getByLabel("OpenAI key").fill(key)
  await page
    .getByRole("region", { name: "OpenAI" })
    .getByRole("button", { name: "Save" })
    .click()
  await expect(
    page
      .getByRole("region", { name: "OpenAI" })
      .getByText("This organization is suspended.")
  ).toBeVisible()
  expect(
    await sql(`select 1 from provider_keys where org_id = $1`, [orgId])
  ).toHaveLength(0)

  // Unsuspended: no banner, and a key can be created again.
  await new Promise((r) => setTimeout(r, 5))
  await setSuspended(orgId, "unsuspend")
  await page.goto("/api-keys")
  await expect(page.getByRole("note")).toHaveCount(0)
  await page.getByLabel("Name").fill("ci")
  await page.getByRole("button", { name: "Create key" }).click()
  await expect(page.getByLabel("Your new key")).toHaveValue(/^iris_/)
})

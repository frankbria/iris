import { randomBytes } from "node:crypto"

import { expect, test, type BrowserContext, type Page } from "@playwright/test"
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
 * The org's own AI provider keys through the real portal (BYOK, #344): saved
 * through a server action, sealed with the run's master key, never shown again.
 * The refusals are forged requests, not hidden buttons: a member's page given a
 * manager's form, and an owner's form pointed at another org.
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

// Shaped like real keys, built at runtime so no literal reads as a credential.
const openaiKey = () =>
  ["sk", "proj", randomBytes(24).toString("hex")].join("-")

async function owner(page: Page, context: BrowserContext, name: string) {
  const email = unique()
  await signUpVerified(context.request, email, name)
  await logIn(page, email, PASSWORD)
  await expect(page).toHaveURL(/\/dashboard$/)
  return email
}

test("an owner saves, replaces and removes a key that is never shown again", async ({
  page,
  context,
}) => {
  const email = await owner(page, context, "Kim")
  await page.getByRole("link", { name: "AI provider keys" }).click()
  await expect(page).toHaveURL(/\/provider-keys$/)
  const openai = page.getByRole("region", { name: "OpenAI" })
  await expect(openai.getByText("No key set.")).toBeVisible()

  const first = openaiKey()
  await page.getByLabel("OpenAI key").fill(first)
  await openai.getByRole("button", { name: "Save" }).click()
  await expect(openai.getByText(/^Key set /)).toBeVisible()

  // Encrypted at rest, and nowhere on the page.
  const [row] = await sql<{ t: string }>(
    `select encode(ciphertext, 'escape') as t from provider_keys where org_id = $1 and provider = 'openai'`,
    [await orgOf(email)]
  )
  expect(row.t).not.toContain(first.slice(8))
  await page.reload()
  expect(await page.content()).not.toContain(first.slice(8, 30))

  // A malformed key is refused with a reason.
  await page.getByLabel("Replace the OpenAI key").fill("not-a-key")
  await openai.getByRole("button", { name: "Save" }).click()
  await expect(
    page.getByRole("alert").filter({ hasText: "does not look like" })
  ).toBeVisible()

  // Replaced, then removed.
  await page.getByLabel("Replace the OpenAI key").fill(openaiKey())
  await openai.getByRole("button", { name: "Save" }).click()
  await expect(page.getByText("Saved.")).toBeVisible()
  await page.getByRole("button", { name: "Remove the OpenAI key" }).click()
  await expect(openai.getByText("No key set.")).toBeVisible()
  expect(
    await sql("select 1 from provider_keys where org_id = $1", [
      await orgOf(email),
    ])
  ).toEqual([])
})

test("a member sees which keys are set, and the server refuses a member's save", async ({
  page,
  context,
  browser,
}) => {
  const email = await owner(page, context, "Ola")
  await page.goto("/provider-keys")
  const openai = page.getByRole("region", { name: "OpenAI" })
  await page.getByLabel("OpenAI key").fill(openaiKey())
  await openai.getByRole("button", { name: "Save" }).click()
  await expect(page.getByText(/^Key set /).first()).toBeVisible()

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
  await signUpVerified(theirs.request, memberEmail, "Mia")
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
  await them.goto("/provider-keys")
  await expect(them.getByText(/^Key set /).first()).toBeVisible()
  await expect(them.getByRole("button", { name: "Save" })).toHaveCount(0)
  await expect(
    them.getByText("Only owners and admins can change provider keys.")
  ).toBeVisible()

  // Forge it: the owner's form exactly as the server renders it (the server action's
  // reference, key and bound state in hidden fields), posted as a no-JS submission.
  const html = await (await context.request.get("/provider-keys")).text()
  // The save form: the Remove form comes first in the section once a key is set.
  const ssrForm = [...html.matchAll(/<form[^>]*>[\s\S]*?<\/form>/g)]
    .map((m) => m[0])
    .find((f) => f.includes('name="apiKey"'))!
  const fields: Record<string, string> = {}
  for (const [, name, value] of ssrForm.matchAll(
    /<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?\/>/g
  ))
    fields[name] = (value ?? "").replaceAll("&quot;", '"')
  const submit = (ctx: BrowserContext) =>
    ctx.request.post("/provider-keys", {
      headers: { origin: baseURL },
      multipart: { ...fields, apiKey: openaiKey() },
    })
  const stored = async () =>
    (
      await sql<{ c: string }>(
        "select encode(ciphertext, 'hex') as c from provider_keys where org_id = $1",
        [await orgOf(email)]
      )
    )[0].c

  // Positive control: from the owner's session the forged post does reach the action
  // and replaces the key. Without it, a post that never reached it would pass below.
  const before = await stored()
  expect((await submit(context)).ok()).toBe(true)
  const controlled = await stored()
  expect(controlled).not.toBe(before)

  // From the member's session the same post is refused, and the key is unchanged.
  await submit(theirs)
  expect(await stored()).toBe(controlled)
  await theirs.close()
})

test("an owner cannot save a key into another org", async ({
  page,
  context,
  browser,
}) => {
  const victim = unique()
  const theirs = await browser.newContext()
  await ownRateLimitBucket(theirs)
  await signUpVerified(theirs.request, victim, "Vic")
  expect(
    (
      await theirs.request.post("/api/auth/sign-in/email", {
        data: { email: victim, password: PASSWORD },
      })
    ).ok()
  ).toBe(true)
  // The victim's org exists once a session made it.
  const victimOrg = await orgOf(victim)
  await theirs.close()

  await owner(page, context, "Mal")
  await page.goto("/provider-keys")
  const openai = page.getByRole("region", { name: "OpenAI" })
  // The page's own OpenAI form, pointed at the other org.
  await openai
    .locator("input[name=organizationId]")
    .first()
    .evaluate(
      (input, id) => ((input as HTMLInputElement).value = id),
      victimOrg
    )
  await page.getByLabel("OpenAI key").fill(openaiKey())
  await openai.getByRole("button", { name: "Save" }).click()
  await expect(
    page.getByRole("alert").filter({ hasText: "Only owners and admins" })
  ).toBeVisible()
  expect(
    await sql("select 1 from provider_keys where org_id = $1", [victimOrg])
  ).toEqual([])
})

// #479: how the org pays for AI. Owners and admins switch it; a member's forged post of
// the owner's form changes nothing (with a positive control from the owner's session).
test("an owner switches to IRIS credits; a member cannot", async ({
  page,
  context,
  browser,
}) => {
  const email = await owner(page, context, "Ava")
  const orgId = await orgOf(email)
  await sql("insert into org_plans (org_id, plan) values ($1, 'pro')", [orgId])
  await page.goto("/provider-keys")
  const usage = page.getByRole("region", { name: "AI usage" })
  await expect(
    usage.getByText("Your organization's own keys are used.")
  ).toBeVisible()
  await usage.getByLabel(/IRIS credits/).check()
  await usage.getByRole("button", { name: "Save AI setting" }).click()
  await expect(usage.getByText("IRIS credits are on.")).toBeVisible()
  await page.reload()
  await expect(
    usage.getByText("IRIS credits: $10.00 of $10.00 left this month.")
  ).toBeVisible()
  const mode = async () =>
    (
      await sql<{ mode: string }>(
        "select mode from org_ai_settings where org_id = $1",
        [orgId]
      )
    )[0]?.mode

  // A member: sees the setting, has no form, and a forged post is refused.
  const memberEmail = unique()
  const invited = await context.request.post(
    "/api/auth/organization/invite-member",
    {
      headers: { origin: baseURL },
      data: { email: memberEmail, role: "member" },
    }
  )
  const theirs = await browser.newContext()
  await ownRateLimitBucket(theirs)
  await signUpVerified(theirs.request, memberEmail, "Moe")
  await theirs.request.post("/api/auth/sign-in/email", {
    data: { email: memberEmail, password: PASSWORD },
  })
  await theirs.request.post("/api/auth/organization/accept-invitation", {
    headers: { origin: baseURL },
    data: { invitationId: (await invited.json()).id },
  })
  const them = await theirs.newPage()
  await them.goto("/provider-keys")
  await expect(them.getByText(/IRIS credits: \$/)).toBeVisible()
  await expect(
    them.getByRole("button", { name: "Save AI setting" })
  ).toHaveCount(0)

  const html = await (await context.request.get("/provider-keys")).text()
  const ssrForm = [...html.matchAll(/<form[^>]*>[\s\S]*?<\/form>/g)]
    .map((m) => m[0])
    .find((f) => f.includes('name="mode"'))!
  const fields: Record<string, string> = {}
  for (const [, name, value] of ssrForm.matchAll(
    /<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?\/>/g
  ))
    fields[name] = (value ?? "").replaceAll("&quot;", '"')
  const post = (ctx: BrowserContext, to: string) =>
    ctx.request.post("/provider-keys", {
      headers: { origin: baseURL },
      multipart: { ...fields, mode: to },
    })
  await post(theirs, "byok")
  expect(await mode()).toBe("managed")
  // Positive control: the same post from the owner's session goes through.
  expect((await post(context, "byok")).ok()).toBe(true)
  expect(await mode()).toBe("byok")
  await theirs.close()
})

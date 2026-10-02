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
 * Org-owned API keys through the real portal (#340). Each browser context is one
 * person. Cookie-bearing API calls send the portal's Origin, as the browser would, so a
 * refusal is the one under test and not BetterAuth's CSRF check; the assertions check
 * the error code for the same reason.
 */
const { baseURL, databaseUrl } = e2eEnv()
const sameOrigin = { origin: baseURL }

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

/** Signs `email` up in a context of its own, signed in, with its own personal org. */
async function person(
  browser: { newContext(): Promise<BrowserContext> },
  email: string,
  name: string
) {
  const context = await browser.newContext()
  await ownRateLimitBucket(context)
  await signUpVerified(context.request, email, name)
  const res = await context.request.post("/api/auth/sign-in/email", {
    data: { email, password: PASSWORD },
  })
  expect(res.ok()).toBe(true)
  return context
}

test("an owner creates a key, sees it once, and revokes it", async ({
  page,
  context,
}) => {
  const owner = unique()
  await signUpVerified(context.request, owner, "Kim")
  await logIn(page, owner, PASSWORD)
  await expect(page).toHaveURL(/\/dashboard$/)
  await page.getByRole("link", { name: "API keys" }).click()
  await expect(page).toHaveURL(/\/api-keys$/)
  await expect(page.getByText("No keys yet.")).toBeVisible()

  await page.getByLabel("Name").fill("ci")
  await page.getByRole("button", { name: "Create key" }).click()
  const shown = page.getByLabel("Your new key")
  await expect(shown).toHaveValue(/^iris_\w{32,}$/)
  const key = await shown.inputValue()
  const keys = page.getByRole("list", { name: "Keys" })
  await expect(keys).toContainText("ci")
  await expect(keys).toContainText(key.slice(0, 6))

  // Stored as a hash, owned by the org.
  const [row] = await sql<{ key: string; referenceId: string; id: string }>(
    `select id, key, "referenceId" from apikey where name = 'ci' and "referenceId" =
       (select "organizationId" from member where "userId" = (select id from "user" where email = $1))`,
    [owner]
  )
  expect(row.key).not.toContain(key.slice(5))

  // Shown once: after a reload the key is nowhere on the page.
  await page.reload()
  await expect(page.getByLabel("Your new key")).toHaveCount(0)
  expect(await page.content()).not.toContain(key.slice(6))

  page.once("dialog", (dialog) => dialog.accept())
  await page.getByRole("button", { name: "Revoke ci" }).click()
  await expect(page.getByText("No keys yet.")).toBeVisible()
  expect(await sql("select 1 from apikey where id = $1", [row.id])).toEqual([])
})

test("a member sees the org's keys but cannot create or revoke them", async ({
  page,
  context,
  browser,
}) => {
  const owner = unique()
  const member = unique()
  await signUpVerified(context.request, owner, "Ola")
  await logIn(page, owner, PASSWORD)
  await expect(page).toHaveURL(/\/dashboard$/)
  const created = await context.request.post("/api/auth/api-key/create", {
    headers: sameOrigin,
    data: { name: "deploy", organizationId: await activeOrg(context) },
  })
  expect(created.ok()).toBe(true)
  const keyId = (await created.json()).id
  const invited = await context.request.post(
    "/api/auth/organization/invite-member",
    { headers: sameOrigin, data: { email: member, role: "member" } }
  )
  expect(invited.ok()).toBe(true)
  const invitationId = (await invited.json()).id

  const theirs = await person(browser, member, "Mia")
  const accepted = await theirs.request.post(
    "/api/auth/organization/accept-invitation",
    { headers: sameOrigin, data: { invitationId } }
  )
  expect(accepted.ok()).toBe(true)
  const them = await theirs.newPage()
  await them.goto("/api-keys")
  await expect(them.getByRole("list", { name: "Keys" })).toContainText("deploy")
  await expect(them.getByRole("button", { name: "Create key" })).toHaveCount(0)
  await expect(them.getByRole("button", { name: "Revoke deploy" })).toHaveCount(
    0
  )
  await expect(
    them.getByText("Only owners and admins can create or revoke keys.")
  ).toBeVisible()

  // The server refuses too, not only the page.
  const create = await theirs.request.post("/api/auth/api-key/create", {
    headers: sameOrigin,
    data: { name: "mine", organizationId: await activeOrg(theirs) },
  })
  expect(create.status()).toBe(403)
  expect((await create.json()).code).toBe("INSUFFICIENT_API_KEY_PERMISSIONS")
  const revoke = await theirs.request.post("/api/auth/api-key/delete", {
    headers: sameOrigin,
    data: { keyId },
  })
  expect(revoke.status()).toBe(403)
  expect((await revoke.json()).code).toBe("INSUFFICIENT_API_KEY_PERMISSIONS")
  await theirs.close()
})

test("another org cannot list, create in or revoke an org's keys", async ({
  context,
  browser,
}) => {
  const alice = unique()
  await signUpVerified(context.request, alice, "Ana")
  const signIn = await context.request.post("/api/auth/sign-in/email", {
    data: { email: alice, password: PASSWORD },
  })
  expect(signIn.ok()).toBe(true)
  const orgA = await activeOrg(context)
  const created = await context.request.post("/api/auth/api-key/create", {
    headers: sameOrigin,
    data: { name: "alice-ci", organizationId: orgA },
  })
  const keyId = (await created.json()).id

  const bobs = await person(browser, unique(), "Bo")
  const list = await bobs.request.get(
    `/api/auth/api-key/list?organizationId=${orgA}`
  )
  expect(list.status()).toBe(403)
  expect((await list.json()).code).toBe("USER_NOT_MEMBER_OF_ORGANIZATION")
  const create = await bobs.request.post("/api/auth/api-key/create", {
    headers: sameOrigin,
    data: { name: "mallory", organizationId: orgA },
  })
  expect(create.status()).toBe(403)
  expect((await create.json()).code).toBe("USER_NOT_MEMBER_OF_ORGANIZATION")
  const revoke = await bobs.request.post("/api/auth/api-key/delete", {
    headers: sameOrigin,
    data: { keyId },
  })
  expect(revoke.status()).toBe(403)
  expect((await revoke.json()).code).toBe("USER_NOT_MEMBER_OF_ORGANIZATION")
  expect(await sql("select 1 from apikey where id = $1", [keyId])).toHaveLength(
    1
  )
  await bobs.close()
})

test("the API keys page needs a session", async ({ page }) => {
  await page.goto("/api-keys")
  await expect(page).toHaveURL(/\/login$/)
})

async function activeOrg(context: BrowserContext): Promise<string> {
  const session = await (
    await context.request.get("/api/auth/get-session")
  ).json()
  return session.session.activeOrganizationId
}

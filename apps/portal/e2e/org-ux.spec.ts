import { randomUUID } from "node:crypto"

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
import { linkFromMail } from "./mailpit"

/**
 * Org UX follow-ups from #250 (#409): an invitee who has no account yet signs up from the
 * invitation and lands back on it; a signed-in visit to /login goes on; /org pages its
 * members past 100. (A new session starting in the last active org is covered against real
 * BetterAuth and Postgres in __tests__/auth-org.test.ts.)
 */
const { baseURL, databaseUrl } = e2eEnv()
const sameOrigin = { origin: baseURL }

test.beforeEach(({ context }) => ownRateLimitBucket(context))

async function activeOrg(context: BrowserContext): Promise<string> {
  const session = await (
    await context.request.get("/api/auth/get-session")
  ).json()
  return session.session.activeOrganizationId
}

test("an invitee without an account signs up from the invitation and lands back on it", async ({
  context,
  browser,
}) => {
  const owner = unique()
  const invitee = unique()
  await signUpVerified(context.request, owner, "Olive")
  const signIn = await context.request.post("/api/auth/sign-in/email", {
    data: { email: owner, password: PASSWORD },
  })
  expect(signIn.ok()).toBe(true)
  const invited = await context.request.post(
    "/api/auth/organization/invite-member",
    { headers: sameOrigin, data: { email: invitee, role: "member" } }
  )
  expect(invited.ok()).toBe(true)
  const link = await linkFromMail(invitee, "Join Olive's organization")
  const invitationPath = new URL(link).pathname

  const theirs = await browser.newContext()
  await ownRateLimitBucket(theirs)
  const them = await theirs.newPage()
  await them.goto(link)
  await expect(them).toHaveURL(/\/login\?next=%2Faccept-invitation%2F/)
  await them.getByRole("link", { name: "Create an account" }).click()
  await expect(them).toHaveURL(/\/signup\?next=%2Faccept-invitation%2F/)
  await them.getByLabel("Name").fill("Ivan")
  await them.getByLabel("Email").fill(invitee)
  await them.getByLabel("Password").fill(PASSWORD)
  await them.getByLabel(/I agree to the/).check()
  await them.getByRole("button", { name: "Create account" }).click()
  await expect(them.getByText(`We sent a link to ${invitee}`)).toBeVisible()

  // The verification link keeps where the invitee was going.
  await them.goto(await linkFromMail(invitee, "Verify"))
  await expect(them).toHaveURL(
    /\/login\?verified=1&next=%2Faccept-invitation%2F/
  )
  await expect(
    them.getByText("Email verified. Log in to continue.")
  ).toBeVisible()
  await them.getByLabel("Email").fill(invitee)
  await them.getByLabel("Password").fill(PASSWORD)
  await them.getByRole("button", { name: "Log in" }).click()
  await expect(them).toHaveURL(new RegExp(`${invitationPath}$`))
  await expect(them.getByText("Join Olive's organization")).toBeVisible()
  await theirs.close()
})

test("a signed-in visit to /login goes on to next, or the dashboard", async ({
  page,
  context,
}) => {
  const email = unique()
  await signUpVerified(context.request, email)
  await logIn(page, email, PASSWORD)
  await expect(page).toHaveURL(/\/dashboard$/)

  await page.goto("/login")
  await expect(page).toHaveURL(/\/dashboard$/)
  await page.goto("/login?next=%2Forg")
  await expect(page).toHaveURL(/\/org$/)
  // Never back into the login gate itself.
  await page.goto("/login?next=%2Flogin%3Fnext%3D%252Flogin")
  await expect(page).toHaveURL(/\/dashboard$/)
  // An off-site next is still refused.
  await page.goto("/login?next=%2F%2Fevil.example")
  await expect(page).toHaveURL(/\/dashboard$/)
})

test("/org pages its members past the first 100", async ({ page, context }) => {
  const owner = unique()
  await signUpVerified(context.request, owner, "Pam")
  await logIn(page, owner, PASSWORD)
  await expect(page).toHaveURL(/\/dashboard$/)
  const orgId = await activeOrg(context)

  // 120 members besides the owner, added straight to the database.
  const db = new Client({ connectionString: databaseUrl })
  await db.connect()
  try {
    for (let i = 0; i < 120; i++) {
      const id = randomUUID()
      const email = `bulk-${i}-${id.slice(0, 8)}@iris.test`
      await db.query(
        `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
         values ($1, 'Bulk', $2, true, now(), now())`,
        [id, email]
      )
      await db.query(
        `insert into member (id, "organizationId", "userId", role, "createdAt")
         values ($1, $2, $3, 'member', now() + ($4 || ' milliseconds')::interval)`,
        [randomUUID(), orgId, id, String(i + 1)]
      )
    }
  } finally {
    await db.end()
  }

  await page.goto("/org")
  const members = page.getByRole("list", { name: "Members" }).locator("li")
  await expect(members).toHaveCount(100)
  await expect(members.first()).toContainText(`${owner} owner`)
  const pages = page.getByRole("navigation", { name: "Member pages" })
  await expect(pages).toContainText("1–100 of 121")
  await pages.getByRole("link", { name: "More members" }).click()
  await expect(page).toHaveURL(/\/org\?page=2$/)
  await expect(members).toHaveCount(21)
  await expect(pages).toContainText("101–121 of 121")
  await expect(pages.getByRole("link", { name: "More members" })).toHaveCount(0)
  await pages.getByRole("link", { name: "Previous members" }).click()
  await expect(page).toHaveURL(/\/org\?page=1$/)
  // The sole owner is still protected on page 1, though owners are counted org-wide.
  await expect(
    page.getByText("The only owner cannot be removed, demoted or leave.")
  ).toBeVisible()
})

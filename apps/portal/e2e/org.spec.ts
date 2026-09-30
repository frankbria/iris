import { expect, test } from "@playwright/test"

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
 * Organizations, invitations and roles through the real portal (#250). Two browser
 * contexts are two people: the owner who invites and the person invited, each with
 * their own cookies and rate-limit counter. The invitation link is the one in the mail.
 *
 * Cookie-bearing API calls send the portal's Origin, as the browser would: without it
 * BetterAuth refuses them for CSRF, and a test for "refused" would pass for that reason.
 * The assertions check the error code for the same reason.
 */
const { baseURL } = e2eEnv()
const sameOrigin = { origin: baseURL }

test.beforeEach(({ context }) => ownRateLimitBucket(context))

test("an owner invites by email; the invitee joins as a member and cannot invite", async ({
  page,
  context,
  browser,
}) => {
  const owner = unique()
  const invitee = unique()
  await signUpVerified(context.request, owner, "Olive")

  // The first sign-in lands in a personal org the owner owns.
  await logIn(page, owner, PASSWORD)
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(page.getByLabel("Organization")).toHaveText(
    "Olive's organization"
  )
  await expect(page.getByText("Your role: owner")).toBeVisible()

  await page.getByRole("link", { name: "Members" }).click()
  await expect(page).toHaveURL(/\/org$/)
  await page.getByLabel("Email").fill(invitee)
  await page.getByLabel("Role").selectOption("member")
  await page.getByRole("button", { name: "Send invitation" }).click()
  await expect(
    page.getByRole("list", { name: "Pending invitations" })
  ).toContainText(invitee)

  // The invitee, in a browser of their own.
  const theirs = await browser.newContext()
  await ownRateLimitBucket(theirs)
  const them = await theirs.newPage()
  await signUpVerified(theirs.request, invitee, "Ivan")
  const link = await linkFromMail(invitee, "Join Olive's organization")
  expect(link).toMatch(/\/accept-invitation\/[\w-]+$/)

  // Logged out, the link goes through login and comes back.
  await them.goto(link)
  await expect(them).toHaveURL(/\/login\?next=%2Faccept-invitation%2F/)
  await them.getByLabel("Email").fill(invitee)
  await them.getByLabel("Password").fill(PASSWORD)
  await them.getByRole("button", { name: "Log in" }).click()
  await expect(them).toHaveURL(new RegExp(`${new URL(link).pathname}$`))
  await expect(them.getByText("Join Olive's organization")).toBeVisible()
  await them.getByRole("button", { name: "Accept invitation" }).click()

  await expect(them).toHaveURL(/\/org$/)
  const members = them.getByRole("list", { name: "Members" })
  await expect(members).toContainText(`${owner} owner`)
  await expect(members).toContainText(`${invitee} member`)
  await expect(
    them.getByRole("button", { name: "Send invitation" })
  ).toHaveCount(0)

  // The server refuses too, not only the page.
  const res = await theirs.request.post(
    "/api/auth/organization/invite-member",
    { headers: sameOrigin, data: { email: unique(), role: "member" } }
  )
  expect(res.status()).toBe(403)
  expect((await res.json()).code).toBe(
    "YOU_ARE_NOT_ALLOWED_TO_INVITE_USERS_TO_THIS_ORGANIZATION"
  )

  // The owner's page lists the new member and no longer the invitation.
  await page.reload()
  await expect(page.getByRole("list", { name: "Members" })).toContainText(
    `${invitee} member`
  )
  await expect(
    page.getByRole("list", { name: "Pending invitations" })
  ).not.toContainText(invitee)
  await theirs.close()
})

test("a member of one org cannot read another, and the portal recovers its own", async ({
  page,
  context,
  browser,
}) => {
  const alice = unique()
  const bob = unique()
  await signUpVerified(context.request, alice, "Alice")
  await logIn(page, alice, PASSWORD)
  await expect(page).toHaveURL(/\/dashboard$/)

  const bobs = await browser.newContext()
  await ownRateLimitBucket(bobs)
  await signUpVerified(bobs.request, bob, "Bob")
  const signIn = await bobs.request.post("/api/auth/sign-in/email", {
    data: { email: bob, password: PASSWORD },
  })
  expect(signIn.ok()).toBe(true)
  const [bobOrg] = await (
    await bobs.request.get("/api/auth/organization/list")
  ).json()
  expect(bobOrg.name).toBe("Bob's organization")
  await bobs.close()

  // Alice asks for Bob's org by id, the one way a request could name another tenant.
  const read = await context.request.get(
    `/api/auth/organization/get-full-organization?organizationId=${bobOrg.id}`
  )
  expect(read.status()).toBe(403)
  expect((await read.json()).code).toBe(
    "USER_IS_NOT_A_MEMBER_OF_THE_ORGANIZATION"
  )
  const members = await context.request.get(
    `/api/auth/organization/list-members?organizationId=${bobOrg.id}`
  )
  expect(members.status()).toBe(403)
  expect((await members.json()).code).toBe(
    "YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION"
  )
  const invite = await context.request.post(
    "/api/auth/organization/invite-member",
    {
      headers: sameOrigin,
      data: { email: unique(), role: "owner", organizationId: bobOrg.id },
    }
  )
  // BetterAuth answers a non-member with 400, not 403.
  expect(invite.status()).toBe(400)
  expect((await invite.json()).code).toBe("MEMBER_NOT_FOUND")

  // That refusal cleared Alice's active org (BetterAuth). The portal falls back to an
  // org she belongs to, and shows nothing of Bob's.
  await page.goto("/org")
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Alice's organization"
  )
  const list = page.getByRole("list", { name: "Members" })
  await expect(list).toContainText(alice)
  await expect(list).not.toContainText(bob)
})

test("an invitation cannot be opened by another account", async ({
  page,
  context,
  browser,
}) => {
  const owner = unique()
  const invitee = unique()
  const other = unique()
  await signUpVerified(context.request, owner, "Otto")
  await logIn(page, owner, PASSWORD)
  await expect(page).toHaveURL(/\/dashboard$/)
  const res = await context.request.post(
    "/api/auth/organization/invite-member",
    { headers: sameOrigin, data: { email: invitee, role: "admin" } }
  )
  expect(res.ok()).toBe(true)
  const link = await linkFromMail(invitee, "Join Otto's organization")

  const theirs = await browser.newContext()
  await ownRateLimitBucket(theirs)
  const them = await theirs.newPage()
  await signUpVerified(theirs.request, other)
  await logIn(them, other, PASSWORD)
  await expect(them).toHaveURL(/\/dashboard$/)
  await them.goto(link)
  // Next's route announcer is also role="alert": match by text.
  await expect(
    them
      .getByRole("alert")
      .filter({ hasText: "This invitation is not for this account" })
  ).toBeVisible()
  await expect(
    them.getByRole("button", { name: "Accept invitation" })
  ).toHaveCount(0)
  await theirs.close()
})

test("the members page needs a session", async ({ page }) => {
  await page.goto("/org")
  await expect(page).toHaveURL(/\/login$/)
})

test("login ignores a next that leaves the portal", async ({
  page,
  context,
}) => {
  const email = unique()
  await signUpVerified(context.request, email)
  await page.goto("/login?next=//evil.example/steal")
  await page.getByLabel("Email").fill(email)
  await page.getByLabel("Password").fill(PASSWORD)
  await page.getByRole("button", { name: "Log in" }).click()
  await expect(page).toHaveURL(/\/dashboard$/)
})

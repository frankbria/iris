import { expect, test, type BrowserContext } from "@playwright/test"

import {
  logIn,
  ownRateLimitBucket,
  PASSWORD,
  signUpVerified,
  unique,
} from "./accounts"
import { e2eEnv } from "./env"

/**
 * The audit log page (#541) through the real portal: an owner reads the entries #361
 * recorded for their org, newest first; a member of the same org is told it is for owners
 * and admins and sees none.
 */
const { baseURL } = e2eEnv()
const sameOrigin = { origin: baseURL }

test.beforeEach(({ context }) => ownRateLimitBucket(context))

async function activeOrg(context: BrowserContext): Promise<string> {
  const session = await (
    await context.request.get("/api/auth/get-session")
  ).json()
  return session.session.activeOrganizationId
}

test("an owner reads the org's audit log; a member cannot", async ({
  page,
  context,
  browser,
}) => {
  const owner = unique()
  const member = unique()
  await signUpVerified(context.request, owner, "Ada")
  await logIn(page, owner, PASSWORD)
  await expect(page).toHaveURL(/\/dashboard$/)
  const organizationId = await activeOrg(context)
  const keyIds: string[] = []
  for (const name of ["first", "second"]) {
    const created = await context.request.post("/api/auth/api-key/create", {
      headers: sameOrigin,
      data: { name, organizationId },
    })
    expect(created.ok()).toBe(true)
    keyIds.push((await created.json()).id)
  }

  await page.getByRole("link", { name: "Audit log" }).click()
  await expect(page).toHaveURL(/\/audit$/)
  const table = page.getByRole("table", { name: "Audit entries, newest first" })
  const rows = table.locator("tbody tr")
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toContainText("api_key.create")
  await expect(rows.nth(0)).toContainText("Ada")
  // Newest first: the second key's entry above the first's.
  const targets = await rows.locator("td:nth-child(4)").allTextContents()
  expect(targets).toEqual([`key:${keyIds[1]}`, `key:${keyIds[0]}`])

  // A member of the same org: invited, accepted, and refused.
  const invited = await context.request.post(
    "/api/auth/organization/invite-member",
    { headers: sameOrigin, data: { email: member, role: "member" } }
  )
  expect(invited.ok()).toBe(true)
  const invitationId = (await invited.json()).id
  const theirs = await browser.newContext()
  await ownRateLimitBucket(theirs)
  await signUpVerified(theirs.request, member, "Moe")
  expect(
    (
      await theirs.request.post("/api/auth/sign-in/email", {
        data: { email: member, password: PASSWORD },
      })
    ).ok()
  ).toBe(true)
  const accepted = await theirs.request.post(
    "/api/auth/organization/accept-invitation",
    { headers: sameOrigin, data: { invitationId } }
  )
  expect(accepted.ok()).toBe(true)
  const them = await theirs.newPage()
  await them.goto("/audit")
  await expect(
    them.getByText("Only owners and admins can view the audit log.")
  ).toBeVisible()
  await expect(them.getByRole("table")).toHaveCount(0)
  await theirs.close()
})

test("a stale or forged cursor shows a way back, not an error page", async ({
  page,
  context,
}) => {
  const owner = unique()
  await signUpVerified(context.request, owner, "Bea")
  await logIn(page, owner, PASSWORD)
  await expect(page).toHaveURL(/\/dashboard$/)
  await page.goto("/audit?cursor=not-a-cursor")
  await expect(
    page.getByText("That page link is no longer valid.")
  ).toBeVisible()
  await page.getByRole("link", { name: "Show the newest entries" }).click()
  await expect(page).toHaveURL(/\/audit$/)
})

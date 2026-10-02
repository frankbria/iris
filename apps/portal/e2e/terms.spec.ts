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
 * Terms and Acceptable Use (#276) through the real portal: the public pages, the
 * sign-up checkbox, the server's refusal of a sign-up that skips it, and re-acceptance
 * after a version bump (simulated by ageing the user's stored rows).
 */
const { baseURL, databaseUrl } = e2eEnv()

test.beforeEach(({ context }) => ownRateLimitBucket(context))

test("both documents are public and say they are drafts", async ({ page }) => {
  for (const [path, title] of [
    ["/terms", "Terms of Service"],
    ["/acceptable-use", "Acceptable Use Policy"],
  ]) {
    await page.goto(path)
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title)
    await expect(
      page.getByText("Draft — pending review; not yet in effect")
    ).toBeVisible()
    await expect(page.getByText(/^Version \d{4}-\d{2}-\d{2}$/)).toBeVisible()
  }
})

test("sign-up needs the checkbox in the form and on the server", async ({
  page,
  request,
}) => {
  await page.goto("/signup")
  await page.getByLabel("Name").fill("No Box")
  await page.getByLabel("Email").fill(unique())
  await page.getByLabel("Password").fill(PASSWORD)
  const box = page.getByLabel(/I agree to the/)
  await expect(box).toHaveAttribute("required", "")
  await page.getByRole("button", { name: "Create account" }).click()
  // The browser stops the submit: still on the form, nothing was sent.
  await expect(page.getByText("Check your email")).toHaveCount(0)
  await expect(page).toHaveURL(/\/signup$/)

  // A client that skips the form is refused by the server, with a code.
  const res = await request.post("/api/auth/sign-up/email", {
    headers: { origin: baseURL },
    data: { email: unique(), password: PASSWORD, name: "Direct" },
  })
  expect(res.status()).toBe(400)
  expect((await res.json()).code).toBe("TERMS_NOT_ACCEPTED")
})

test("a new version of the terms sends a signed-in user to accept it", async ({
  page,
  context,
}) => {
  const email = unique()
  await signUpVerified(context.request, email, "Reaccept")
  await logIn(page, email, PASSWORD)
  await expect(page).toHaveURL(/\/dashboard$/)

  // Version bump: what this user accepted is now out of date.
  const db = new Client({ connectionString: databaseUrl })
  await db.connect()
  try {
    await db.query(
      `update terms_acceptances set version = '2000-01-01'
       where user_id = (select id from "user" where email = $1)`,
      [email]
    )
    for (const path of ["/dashboard", "/api-keys", "/org"]) {
      await page.goto(path)
      await expect(page).toHaveURL(/\/accept-terms$/)
    }

    // A scripted POST without the `agree` field records nothing and the gate stays.
    await page
      .getByLabel(/I agree to the/)
      .evaluate((el) => el.removeAttribute("required"))
    await page.getByRole("button", { name: "Accept and continue" }).click()
    await expect(page).toHaveURL(/\/accept-terms\?error=1$/)
    await expect(
      page.getByRole("alert").filter({ hasText: "Tick the box" })
    ).toBeVisible()
    await page.goto("/dashboard")
    await expect(page).toHaveURL(/\/accept-terms$/)
    const none = await db.query(
      `select count(*)::int as n from terms_acceptances where version <> '2000-01-01'
       and user_id = (select id from "user" where email = $1)`,
      [email]
    )
    expect(none.rows[0].n).toBe(0)

    // A malformed X-Real-IP is not stored; a valid one is.
    await context.setExtraHTTPHeaders({ "x-real-ip": "not-an-ip" })
    await page.reload()
    await page.getByLabel(/I agree to the/).check()
    await page.getByRole("button", { name: "Accept and continue" }).click()
    await expect(page).toHaveURL(/\/dashboard$/)
    const bad = await db.query(
      `select ip from terms_acceptances where version <> '2000-01-01'
       and user_id = (select id from "user" where email = $1)`,
      [email]
    )
    expect(bad.rows.map((r) => r.ip)).toEqual([null, null])
    await db.query(
      `delete from terms_acceptances where version <> '2000-01-01'
       and user_id = (select id from "user" where email = $1)`,
      [email]
    )
    await context.setExtraHTTPHeaders({ "x-real-ip": "198.51.100.77" })
    await page.goto("/accept-terms")
    await page.getByLabel(/I agree to the/).check()
    await page.getByRole("button", { name: "Accept and continue" }).click()
    await expect(page).toHaveURL(/\/dashboard$/)

    const { rows } = await db.query(
      `select count(*)::int as n, count(*) filter (where version = '2000-01-01')::int as old
       from terms_acceptances where user_id = (select id from "user" where email = $1)`,
      [email]
    )
    expect(rows[0]).toEqual({ n: 4, old: 2 })
    const ips = await db.query(
      `select distinct ip from terms_acceptances where version <> '2000-01-01'
       and user_id = (select id from "user" where email = $1)`,
      [email]
    )
    expect(ips.rows).toEqual([{ ip: "198.51.100.77" }])
  } finally {
    await db.end()
  }
})

test("the accept page needs a session", async ({ page }) => {
  await page.goto("/accept-terms")
  await expect(page).toHaveURL(/\/login$/)
})

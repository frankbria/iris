import { randomBytes } from "node:crypto"

import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test"

import { linkFromMail } from "./mailpit"

/**
 * Account lifecycle through the real portal (#249): the production build, real
 * Postgres, real SMTP. Every mail is read from Mailpit, so the link the test follows
 * is the one a user would receive.
 *
 * BetterAuth rate-limits sign-in to 3 per 10s per client IP. Each test sends its own
 * X-Forwarded-For so that it gets a counter of its own. The limit test depends on the
 * same behavior.
 */
test.beforeEach(async ({ context }) => {
  // Random, not a counter: Playwright restarts the worker after a failure, which
  // would reset a counter and put the next test in an already-spent bucket.
  const [a, b, c] = randomBytes(3)
  await context.setExtraHTTPHeaders({ "x-forwarded-for": `10.${a}.${b}.${c}` })
})

const unique = () => `e2e-${randomBytes(4).toString("hex")}@iris.test`
const PASSWORD = "correct-horse-battery-staple"

async function logIn(page: Page, email: string, password: string) {
  await page.goto("/login")
  await page.getByLabel("Email").fill(email)
  await page.getByLabel("Password").fill(password)
  await page.getByRole("button", { name: "Log in" }).click()
}

async function signUpVerified(request: APIRequestContext, email: string) {
  const res = await request.post("/api/auth/sign-up/email", {
    data: { email, password: PASSWORD, name: "E2E", callbackURL: "/dashboard" },
  })
  expect(res.ok()).toBe(true)
  const verify = await request.get(await linkFromMail(email, "Verify"), {
    maxRedirects: 0,
  })
  // A bad token redirects too, to `?error=INVALID_TOKEN`: check where it went.
  expect(verify.status()).toBe(302)
  expect(verify.headers().location).toBe("/dashboard")
}

test("sign up, verify, log in, log out", async ({ page, context }) => {
  const email = unique()

  // An anonymous visitor cannot reach the dashboard.
  await page.goto("/dashboard")
  await expect(page).toHaveURL(/\/login$/)

  await page.goto("/signup")
  await page.getByLabel("Name").fill("E2E User")
  await page.getByLabel("Email").fill(email)
  await page.getByLabel("Password").fill(PASSWORD)
  await page.getByRole("button", { name: "Create account" }).click()
  await expect(page.getByText(`We sent a link to ${email}`)).toBeVisible()

  // No session until the address is verified. Trying mails a fresh link, so a
  // lost or expired one (or a failed send) is not a dead end.
  await logIn(page, email, PASSWORD)
  await expect(
    page.getByRole("alert").filter({ hasText: "We sent you a new link" })
  ).toBeVisible()
  await expect(page).toHaveURL(/\/login$/)
  const fresh = await linkFromMail(email, "Verify", 2)

  // Following the link verifies the address but does not sign in (login CSRF).
  await page.goto(fresh)
  await expect(page).toHaveURL(/\/login$/)

  await logIn(page, email, PASSWORD)
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(page.getByText(email)).toBeVisible()

  const session = (await context.cookies()).find((c) =>
    c.name.endsWith("session_token")
  )
  expect(session).toMatchObject({ httpOnly: true, sameSite: "Lax" })

  await page.getByRole("button", { name: "Log out" }).click()
  await expect(page).toHaveURL(/\/login$/)
  await page.goto("/dashboard")
  await expect(page).toHaveURL(/\/login$/)

  // Logging out revoked the session on the server, not only the browser's copy.
  await context.addCookies([session!])
  await page.goto("/dashboard")
  await expect(page).toHaveURL(/\/login$/)

  await logIn(page, email, PASSWORD)
  await expect(page).toHaveURL(/\/dashboard$/)
  await expect(page.getByText(email)).toBeVisible()
})

test("a bad verification link is not reported as a success", async ({
  page,
}) => {
  // BetterAuth sends a failed verification back to the sign-up callbackURL with
  // `&error=...` appended, i.e. next to its `verified=1`.
  await page.goto(
    "/api/auth/verify-email?token=not-a-token&callbackURL=%2Flogin%3Fverified%3D1"
  )
  await expect(page).toHaveURL(/\/login\?verified=1&error=/)
  await expect(page.getByRole("status")).toContainText(
    "That link has expired or was already used"
  )
  await expect(page.getByText("Email verified")).toHaveCount(0)
})

test("a wrong password is refused", async ({ page, context }) => {
  const email = unique()
  await signUpVerified(context.request, email)

  await logIn(page, email, "not-the-password")
  await expect(
    page.getByRole("alert").filter({ hasText: "Invalid email or password" })
  ).toBeVisible()
  await expect(page).toHaveURL(/\/login$/)
})

test("reset a forgotten password", async ({ page, context }) => {
  const email = unique()
  await signUpVerified(context.request, email)

  await page.goto("/login")
  await page.getByRole("link", { name: "Forgot password?" }).click()
  // /login has an Email field too: fill only once the client navigation has landed.
  await expect(page).toHaveURL(/\/forgot-password$/)
  await page.getByLabel("Email").fill(email)
  await page.getByRole("button", { name: "Send reset link" }).click()
  await expect(page.getByText(`If ${email} has an account`)).toBeVisible()

  await page.goto(await linkFromMail(email, "Reset"))
  await expect(page).toHaveURL(/\/reset-password\?token=/)
  const newPassword = "a-brand-new-long-password"
  await page.getByLabel("New password").fill(newPassword)
  await page.getByRole("button", { name: "Set password" }).click()
  await expect(page).toHaveURL(/\/login\?reset=1$/)

  await logIn(page, email, PASSWORD)
  await expect(
    page.getByRole("alert").filter({ hasText: "Invalid email or password" })
  ).toBeVisible()
  await logIn(page, email, newPassword)
  await expect(page).toHaveURL(/\/dashboard$/)
})

test("auth endpoints are rate-limited", async ({ context }) => {
  const attempt = () =>
    context.request.post("/api/auth/sign-in/email", {
      data: { email: unique(), password: "wrong-password-1" },
    })
  const statuses = []
  for (let i = 0; i < 4; i++) statuses.push((await attempt()).status())
  // BetterAuth's sign-in rule: 3 per 10s, then 429.
  expect(statuses).toEqual([401, 401, 401, 429])
})

test.describe("before the page is interactive", () => {
  // No JavaScript is what a form looks like until React hydrates it. A native
  // submit then is a GET to the page, with the password in the query string.
  test.use({ javaScriptEnabled: false })

  test("the login form cannot be submitted, so a password never reaches the URL", async ({
    page,
  }) => {
    await page.goto("/login")
    await expect(page.getByRole("button", { name: "Log in" })).toBeDisabled()
    await page.getByLabel("Email").fill("someone@iris.test")
    await page.getByLabel("Password").fill("do-not-leak-this")
    await page.getByLabel("Password").press("Enter")
    await page.waitForLoadState()
    expect(page.url()).not.toContain("do-not-leak-this")
  })
})

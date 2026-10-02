import { randomBytes } from "node:crypto"

import {
  expect,
  type APIRequestContext,
  type BrowserContext,
  type Page,
} from "@playwright/test"

import { linkFromMail } from "./mailpit"

/**
 * BetterAuth rate-limits sign-in to 3 per 10s per client IP, which it reads from
 * X-Real-IP (the header the ingress overwrites, #347). Giving each browser context its
 * own X-Real-IP gives it a counter of its own. Random, not a
 * counter: Playwright restarts the worker after a failure, which would reset a counter
 * and put the next test in an already-spent bucket.
 */
export async function ownRateLimitBucket(context: BrowserContext) {
  const [a, b, c] = randomBytes(3)
  await context.setExtraHTTPHeaders({ "x-real-ip": `10.${a}.${b}.${c}` })
}

export const unique = () => `e2e-${randomBytes(4).toString("hex")}@iris.test`
export const PASSWORD = "correct-horse-battery-staple"

export async function logIn(page: Page, email: string, password: string) {
  await page.goto("/login")
  await page.getByLabel("Email").fill(email)
  await page.getByLabel("Password").fill(password)
  await page.getByRole("button", { name: "Log in" }).click()
}

export async function signUpVerified(
  request: APIRequestContext,
  email: string,
  name = "E2E"
) {
  const res = await request.post("/api/auth/sign-up/email", {
    data: { email, password: PASSWORD, name, callbackURL: "/dashboard" },
  })
  expect(res.ok()).toBe(true)
  const verify = await request.get(await linkFromMail(email, "Verify"), {
    maxRedirects: 0,
  })
  // A bad token redirects too, to `?error=INVALID_TOKEN`: check where it went.
  expect(verify.status()).toBe(302)
  expect(verify.headers().location).toBe("/dashboard")
}

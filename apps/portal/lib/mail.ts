import { createTransport } from "nodemailer"

import { readSecretEnv } from "../../../src/secret-env"

/**
 * The portal's mail transport, from `SMTP_URL` or `SMTP_URL_FILE` (the deployed form:
 * the URL carries the SMTP password, #273), e.g. `smtps://user:pass@smtp.example.com`.
 * Shared by `getAuth()` and the deploy's readiness check (`scripts/verify-smtp.ts`), so
 * the check tests the transport the portal sends with.
 */
export function createMailTransport(env: NodeJS.ProcessEnv = process.env) {
  const url = readSecretEnv("SMTP_URL", env)
  if (!url) throw new Error("Set SMTP_URL (or SMTP_URL_FILE) for the portal")
  return createTransport(url)
}

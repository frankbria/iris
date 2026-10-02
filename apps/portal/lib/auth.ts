import { createAuth } from "../../../src/auth/config"
import { createPostgresDb, resolveDatabaseUrl } from "../../../src/db/postgres"
import { readSecretEnv } from "../../../src/secret-env"

import { createMailTransport } from "./mail"

/** `name`, or `name_FILE` for a secret (#273). */
function required(name: string): string {
  const value = readSecretEnv(name)
  if (!value) throw new Error(`Set ${name} for the portal`)
  return value
}

let auth: ReturnType<typeof createAuth> | undefined

/**
 * The portal's BetterAuth instance, built from the shared `createAuth()` (#249).
 *
 * The instance is built on first use, not at import, so `next build` needs no secrets.
 * Configuration:
 * - `BETTER_AUTH_SECRET` / `BETTER_AUTH_SECRET_FILE`: signs sessions
 * - `BETTER_AUTH_URL`: the portal's public origin
 * - `DATABASE_URL` / `DATABASE_URL_FILE`: see `resolveDatabaseUrl`
 * - `SMTP_URL` / `SMTP_URL_FILE`: see `createMailTransport`
 * - `SMTP_FROM`: the sender address
 */
export function getAuth() {
  if (auth) return auth
  const mail = createMailTransport()
  const from = required("SMTP_FROM")
  auth = createAuth({
    secret: required("BETTER_AUTH_SECRET"),
    baseURL: required("BETTER_AUTH_URL"),
    database: { db: createPostgresDb(resolveDatabaseUrl()), type: "postgres" },
    sendEmail: async ({ to, subject, text }) => {
      await mail.sendMail({ from, to, subject, text })
    },
  })
  return auth
}

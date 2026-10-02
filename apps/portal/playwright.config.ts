import { randomBytes } from "node:crypto"

import { defineConfig } from "@playwright/test"

import { e2eEnv } from "./e2e/env"

/**
 * Portal E2E (#249): a production build (`npm run build` first) against real
 * Postgres and a real SMTP catcher (Mailpit). See e2e/env.ts for the variables.
 */
const env = e2eEnv()

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  // One database and one set of rate-limit counters: run the specs in order.
  workers: 1,
  use: { baseURL: env.baseURL },
  webServer: {
    command: `npx next start --port ${env.port}`,
    url: env.baseURL,
    reuseExistingServer: false,
    env: {
      BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
      BETTER_AUTH_URL: env.baseURL,
      BETTER_AUTH_TELEMETRY: "0",
      DATABASE_URL: env.databaseUrl,
      SMTP_URL: env.smtpUrl,
      SMTP_FROM: "IRIS <no-reply@iris.test>",
      // BYOK master key (#344): seals provider keys; a fresh one per run.
      IRIS_KEY_ENCRYPTION_KEY: `e2e:${randomBytes(32).toString("base64")}`,
    },
  },
})

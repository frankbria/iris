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
      // Published contacts (#348): abuse left unset to show its placeholder.
      IRIS_SECURITY_CONTACT: "mailto:security@iris.test",
      IRIS_SUPPORT_CONTACT: "mailto:support@iris.test",
      // Signed screenshot URLs on run detail (#463); the bucket is made by global setup.
      IRIS_S3_ENDPOINT: env.s3.endpoint,
      IRIS_S3_BUCKET: env.s3.bucket,
      IRIS_S3_ACCESS_KEY_ID: env.s3.accessKeyId,
      IRIS_S3_SECRET_ACCESS_KEY: env.s3.secretAccessKey,
    },
  },
})

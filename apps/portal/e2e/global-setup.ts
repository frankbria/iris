import { execFileSync } from "node:child_process"
import path from "node:path"

import { Client } from "pg"

import { e2eEnv } from "./env"

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..")

/**
 * A fresh, migrated database for every run. Migrations run the way a deploy runs
 * them, as `src/db/migrate.ts` in its own process. Playwright's loader also cannot link
 * Kysely's ESM-only `kysely/migration` in-process.
 */
export default async function globalSetup() {
  const env = e2eEnv()
  const admin = new Client({ connectionString: env.adminUrl })
  await admin.connect()
  await admin.query("DROP DATABASE IF EXISTS iris_portal_e2e WITH (FORCE)")
  await admin.query("CREATE DATABASE iris_portal_e2e")
  await admin.end()

  execFileSync(
    process.execPath,
    ["-r", "ts-node/register", "src/db/migrate.ts"],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        TS_NODE_TRANSPILE_ONLY: "1",
        DATABASE_URL: env.databaseUrl,
      },
      stdio: "inherit",
    }
  )
}

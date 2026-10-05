import { execFileSync } from "node:child_process"
import path from "node:path"

import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3"
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

  // The run's screenshot bucket (#463). The S3 port answers before its storage is
  // ready, so the first create is retried briefly; "already exists" is fine.
  const s3 = new S3Client({
    endpoint: env.s3.endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.s3.accessKeyId,
      secretAccessKey: env.s3.secretAccessKey,
    },
  })
  for (let attempt = 1; ; attempt++) {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: env.s3.bucket }))
      break
    } catch (error) {
      const name = (error as { name?: string }).name
      if (name === "BucketAlreadyOwnedByYou" || name === "BucketAlreadyExists")
        break
      if (attempt >= 30) throw error
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  s3.destroy()
}

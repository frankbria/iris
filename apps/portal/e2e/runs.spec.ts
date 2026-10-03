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
 * Runs and results pages (#270) through the real portal over real Postgres. Runs are
 * seeded straight into the signed-in user's org, as the API and worker would write
 * them; the pages read them through the same store.
 */
const { databaseUrl } = e2eEnv()

test.beforeEach(({ context }) => ownRateLimitBucket(context))

async function sql(query: string, params: unknown[] = []) {
  const db = new Client({ connectionString: databaseUrl })
  await db.connect()
  try {
    return (await db.query(query, params)).rows
  } finally {
    await db.end()
  }
}

/** Signs a fresh user in and returns their org id. */
async function signedIn(
  page: import("@playwright/test").Page,
  context: import("@playwright/test").BrowserContext
) {
  const email = unique()
  await signUpVerified(context.request, email, "Runa")
  await logIn(page, email, PASSWORD)
  await expect(page).toHaveURL(/\/dashboard$/)
  const [{ id }] = await sql(
    `select "organizationId" as id from member where "userId" = (select id from "user" where email = $1)`,
    [email]
  )
  return id as string
}

/** One finished run with its results; `minutesAgo` sets its finish time. */
async function seedRun(
  orgId: string,
  run: {
    kind: "rpc" | "a11y" | "visual"
    status: "succeeded" | "failed"
    summary: string
    minutesAgo: number
    results?: Array<{ url: string | null; passed: boolean; result: object }>
  }
) {
  const [{ id }] = await sql(
    `insert into runs (org_id, kind, status, summary, started_at, finished_at, created_at)
     values ($1, $2, $3, $4, now() - make_interval(mins => $5 + 1), now() - make_interval(mins => $5),
             now() - make_interval(mins => $5 + 1))
     returning id`,
    [orgId, run.kind, run.status, run.summary, run.minutesAgo]
  )
  for (const [i, r] of (run.results ?? []).entries()) {
    await sql(
      `insert into run_results (org_id, run_id, position, url, passed, result) values ($1, $2, $3, $4, $5, $6)`,
      [orgId, id, i, r.url, r.passed, JSON.stringify(r.result)]
    )
  }
  return id as string
}

test("a new org sees the empty state", async ({ page, context }) => {
  await signedIn(page, context)
  await page.getByRole("link", { name: "Runs" }).click()
  await expect(page).toHaveURL(/\/runs$/)
  await expect(page.getByRole("heading", { name: "Runs" })).toBeVisible()
  await expect(page.getByRole("status")).toContainText("No runs yet")
})

test("lists runs newest first, filters them and pages through them", async ({
  page,
  context,
}) => {
  const orgId = await signedIn(page, context)
  // 25 runs, one a minute; every fifth an a11y job that failed.
  for (let m = 0; m < 25; m++) {
    const a11y = m % 5 === 0
    await seedRun(orgId, {
      kind: a11y ? "a11y" : "rpc",
      status: a11y ? "failed" : "succeeded",
      summary: `run ${m}`,
      minutesAgo: m,
    })
  }
  await page.goto("/runs")
  const rows = page.getByRole("table").getByRole("row")
  await expect(rows).toHaveCount(21) // header + a page of 20
  await expect(rows.nth(1)).toContainText("run 0")
  await expect(rows.nth(20)).toContainText("run 19")

  await page.getByRole("link", { name: "Older runs" }).click()
  await expect(rows).toHaveCount(6)
  await expect(rows.nth(1)).toContainText("run 20")
  await expect(page.getByRole("link", { name: "Older runs" })).toHaveCount(0)
  await page.getByRole("link", { name: "Newest runs" }).click()
  await expect(rows.nth(1)).toContainText("run 0")

  await page
    .getByRole("navigation", { name: "Filter runs" })
    .getByRole("link", { name: "Accessibility" })
    .click()
  await expect(page).toHaveURL(/kind=a11y/)
  await expect(rows).toHaveCount(6)
  for (const n of [0, 5, 10, 15, 20])
    await expect(page.getByText(`run ${n}`, { exact: true })).toBeVisible()
  await expect(
    page.getByRole("link", { name: "Accessibility" })
  ).toHaveAttribute("aria-current", "true")
})

test("shows each kind's detail, redacts recorded secrets, and 404s another org's run", async ({
  page,
  context,
}) => {
  const orgId = await signedIn(page, context)
  const a11y = await seedRun(orgId, {
    kind: "a11y",
    status: "failed",
    summary: "a11y: 1 page(s), 5 violation(s)",
    minutesAgo: 2,
    results: [
      {
        url: "https://shop.example/",
        passed: false,
        result: {
          score: 20,
          violations: { critical: 2, serious: 3, moderate: 0, minor: 0 },
        },
      },
    ],
  })
  const rpc = await seedRun(orgId, {
    kind: "rpc",
    status: "failed",
    summary: "rpc: 2 action(s), 1 failed",
    minutesAgo: 1,
    results: [
      {
        url: "https://shop.example/reset?token=s3cr3t&page=2",
        passed: true,
        result: {
          action: "navigate https://shop.example/reset?token=s3cr3t&page=2",
        },
      },
      {
        url: null,
        passed: false,
        result: {
          action: "fill #pw = <redacted>",
          error: "Timeout waiting for #pw",
        },
      },
    ],
  })

  await page.goto(`/runs/${a11y}`)
  await expect(
    page.getByRole("heading", { name: "Accessibility run" })
  ).toBeVisible()
  const a11yRow = page.getByRole("table").getByRole("row").nth(1)
  await expect(a11yRow).toContainText("https://shop.example/")
  await expect(a11yRow).toContainText("Failed")
  await expect(a11yRow).toContainText("score 20 · 2 critical, 3 serious")

  await page.goto(`/runs/${rpc}`)
  await expect(
    page.getByRole("heading", { name: "Browser session run" })
  ).toBeVisible()
  await expect(page.getByText("Timeout waiting for #pw")).toBeVisible()
  expect(await page.content()).not.toContain("s3cr3t")
  await expect(page.getByText(/page=2/)).toBeVisible()

  // Another org's run: the same id is a 404 from this user's org.
  const otherOrg = `other-${unique()}`.replace(/[^a-z0-9-]/gi, "-")
  await sql(
    `insert into organization (id, name, slug, "createdAt") values ($1, $1, $1, now())`,
    [otherOrg]
  )
  const foreign = await seedRun(otherOrg, {
    kind: "rpc",
    status: "succeeded",
    summary: "theirs",
    minutesAgo: 0,
  })
  const res = await page.goto(`/runs/${foreign}`)
  expect(res?.status()).toBe(404)
  expect(await page.content()).not.toContain("theirs")
  await page.goto("/runs")
  await expect(page.getByText("theirs")).toHaveCount(0)
})

test("a stale page link says so and links back to the newest runs", async ({
  page,
  context,
}) => {
  await signedIn(page, context)
  await page.goto("/runs?cursor=not-a-cursor")
  await expect(page.getByRole("status")).toContainText("no longer valid")
  await page.getByRole("link", { name: "Show the newest runs" }).click()
  await expect(page).toHaveURL(/\/runs$/)
})

test("is usable from the keyboard: Tab reaches a run, Enter opens it", async ({
  page,
  context,
}) => {
  const orgId = await signedIn(page, context)
  const id = await seedRun(orgId, {
    kind: "rpc",
    status: "succeeded",
    summary: "keyboard run",
    minutesAgo: 0,
  })
  await page.goto("/runs")
  const link = page.getByRole("table").getByRole("link").first()
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press("Tab")
    if (await link.evaluate((el) => el === document.activeElement)) break
  }
  await expect(link).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(new RegExp(`/runs/${id}$`))
})

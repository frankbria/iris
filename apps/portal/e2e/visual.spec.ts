import { expect, test, type BrowserContext, type Page } from "@playwright/test"
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
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
 * Visual diffs and baseline approval on run detail (#463), through the real portal over
 * real Postgres and SeaweedFS. A visual run is seeded as the hosted worker writes one
 * (#268): results carrying object keys, the images in the bucket. The refusal is a
 * forged request, not a hidden button: a member posting an owner's form.
 */
const { baseURL, databaseUrl, s3 } = e2eEnv()

test.beforeEach(({ context }) => ownRateLimitBucket(context))

async function sql<T>(query: string, params: unknown[] = []): Promise<T[]> {
  const db = new Client({ connectionString: databaseUrl })
  await db.connect()
  try {
    return (await db.query(query, params)).rows as T[]
  } finally {
    await db.end()
  }
}

// A valid 1x1 PNG, so the browser actually decodes what the signed URL serves.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
)

async function put(key: string) {
  const client = new S3Client({
    endpoint: s3.endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey,
    },
  })
  await client.send(
    new PutObjectCommand({
      Bucket: s3.bucket,
      Key: key,
      Body: PNG,
      ContentType: "image/png",
    })
  )
  client.destroy()
}

async function owner(page: Page, context: BrowserContext) {
  const email = unique()
  await signUpVerified(context.request, email, "Vera")
  await logIn(page, email, PASSWORD)
  await expect(page).toHaveURL(/\/dashboard$/)
  const [{ org, user }] = await sql<{ org: string; user: string }>(
    `select m."organizationId" as org, u.id as "user" from member m join "user" u on u.id = m."userId"
     where u.email = $1`,
    [email]
  )
  return { email, org, user }
}

/** A failed visual comparison of `/` on desktop, with its three images stored. */
async function visualRun(org: string) {
  const [{ id }] = await sql<{ id: string }>(
    `insert into runs (org_id, kind, status, summary, started_at, finished_at)
     values ($1, 'visual', 'failed', 'visual: 1 comparison(s), 1 failed', now(), now()) returning id`,
    [org]
  )
  const prefix = `org/${org}/project/shop`
  const artifacts = {
    current: `${prefix}/run/${id}/current/home_desktop-0123456789--aaaaaaaaaaaa.png`,
    diff: `${prefix}/run/${id}/diff/home_desktop-0123456789--aaaaaaaaaaaa.png`,
    baseline: `${prefix}/baselines/home_desktop-0123456789--bbbbbbbbbbbb.png`,
  }
  for (const key of Object.values(artifacts)) await put(key)
  await sql(
    `insert into run_results (org_id, run_id, position, url, passed, result)
     values ($1, $2, 0, 'https://shop.example/', false, $3)`,
    [
      org,
      id,
      JSON.stringify({
        device: "desktop",
        project: "shop",
        diffPercentage: 0.04,
        severity: "minor",
        artifacts,
      }),
    ]
  )
  return id
}

test("shows baseline, this run and the differences, and an owner approves from the keyboard", async ({
  page,
  context,
}) => {
  const me = await owner(page, context)
  const id = await visualRun(me.org)
  await page.goto(`/runs/${id}`)

  const where = "https://shop.example/ on desktop"
  for (const label of ["Baseline", "This run", "Differences"]) {
    const img = page.getByRole("img", { name: `${label} of ${where}` })
    await expect(img).toBeVisible()
    // Loaded through its signed URL, not a broken image.
    expect(
      await img.evaluate((el) => (el as HTMLImageElement).naturalWidth)
    ).toBe(1)
  }
  // An object key appears only inside a signed URL, never on its own.
  const html = await page.content()
  const mentions = [
    ...html.matchAll(
      /baselines\/home_desktop-0123456789--bbbbbbbbbbbb\.png(.{0,20})/g
    ),
  ]
  expect(mentions.length).toBeGreaterThan(0)
  for (const [, after] of mentions) expect(after).toMatch(/^\?X-Amz-Algorithm/)

  const approve = page.getByRole("button", {
    name: `Approve as new baseline: ${where}`,
  })
  await approve.focus()
  await page.keyboard.press("Enter")
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Approved as the desktop baseline" })
  ).toBeVisible()

  const [baseline] = await sql<{ approved_by: string; run_id: string }>(
    "select approved_by, run_id from visual_baselines where org_id = $1 and project = 'shop'",
    [me.org]
  )
  expect(baseline).toEqual({ approved_by: `user:${me.user}`, run_id: id })
  const audit = await sql<{ actor_user_id: string; action: string }>(
    "select actor_user_id, action from audit_log where org_id = $1",
    [me.org]
  )
  expect(audit).toEqual([
    { actor_user_id: me.user, action: "visual_baseline.approve" },
  ])
})

test("a member sees the images but cannot approve, even with a forged form", async ({
  page,
  context,
  browser,
}) => {
  const me = await owner(page, context)
  const id = await visualRun(me.org)

  const memberEmail = unique()
  const invited = await context.request.post(
    "/api/auth/organization/invite-member",
    {
      headers: { origin: baseURL },
      data: { email: memberEmail, role: "member" },
    }
  )
  expect(invited.ok()).toBe(true)
  const theirs = await browser.newContext()
  await ownRateLimitBucket(theirs)
  await signUpVerified(theirs.request, memberEmail, "Max")
  expect(
    (
      await theirs.request.post("/api/auth/sign-in/email", {
        data: { email: memberEmail, password: PASSWORD },
      })
    ).ok()
  ).toBe(true)
  expect(
    (
      await theirs.request.post("/api/auth/organization/accept-invitation", {
        headers: { origin: baseURL },
        data: { invitationId: (await invited.json()).id },
      })
    ).ok()
  ).toBe(true)

  const them = await theirs.newPage()
  await them.goto(`/runs/${id}`)
  await expect(
    them.getByRole("img", { name: /^Differences of / })
  ).toBeVisible()
  await expect(
    them.getByRole("button", { name: /Approve as new baseline/ })
  ).toHaveCount(0)

  // Forge it: the owner's form as the server renders it, posted from the member's session.
  const html = await (await context.request.get(`/runs/${id}`)).text()
  const ssrForm = [...html.matchAll(/<form[^>]*>[\s\S]*?<\/form>/g)]
    .map((m) => m[0])
    .find((f) => f.includes('name="runId"'))!
  const fields: Record<string, string> = {}
  for (const [, name, value] of ssrForm.matchAll(
    /<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?\/>/g
  ))
    fields[name] = (value ?? "").replaceAll("&quot;", '"')
  const submit = (ctx: BrowserContext) =>
    ctx.request.post(`/runs/${id}`, {
      headers: { origin: baseURL },
      multipart: fields,
    })
  const approvals = async () =>
    (
      await sql<{ n: number }>(
        "select count(*)::int as n from audit_log where org_id = $1",
        [me.org]
      )
    )[0].n

  await submit(theirs)
  expect(await approvals()).toBe(0)
  // Positive control: the same post from the owner's session does reach the action.
  expect((await submit(context)).ok()).toBe(true)
  expect(await approvals()).toBe(1)
  await theirs.close()
})

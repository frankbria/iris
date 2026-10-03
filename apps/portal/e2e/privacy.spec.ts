import { expect, test } from "@playwright/test"

/**
 * Privacy policy, subprocessor list and DPA (#277) through the real portal: each page is
 * public (no session), says it is a draft, and every link in the legal footer resolves,
 * from the legal pages and from the sign-in page.
 */
const PAGES = [
  ["/privacy", "Privacy Policy"],
  ["/subprocessors", "Subprocessors"],
  ["/dpa", "Data Processing Agreement"],
] as const

test("the documents are public and say they are drafts", async ({ page }) => {
  for (const [path, title] of PAGES) {
    const res = await page.goto(path)
    expect(res?.status()).toBe(200)
    await expect(page).toHaveURL(new RegExp(`${path}$`))
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title)
    await expect(
      page.getByText("Draft — pending review; not yet in effect")
    ).toBeVisible()
  }
})

test("the subprocessor list is a table with the vendors", async ({ page }) => {
  await page.goto("/subprocessors")
  const table = page.getByRole("table")
  for (const name of ["OpenAI", "Anthropic", "Stripe", "[hosting provider]"])
    await expect(table.getByText(name, { exact: false }).first()).toBeVisible()
})

test("every footer link resolves, from a legal page and from login", async ({
  page,
}) => {
  for (const start of ["/privacy", "/login"]) {
    await page.goto(start)
    const nav = page.getByRole("navigation", { name: "Legal" })
    const hrefs = await nav
      .getByRole("link")
      .evaluateAll((links) => links.map((a) => a.getAttribute("href")))
    expect(hrefs).toEqual([
      "/terms",
      "/acceptable-use",
      "/privacy",
      "/subprocessors",
      "/dpa",
    ])
    for (const href of hrefs) {
      const res = await page.request.get(href!)
      expect(res.status(), href!).toBe(200)
    }
  }
  // A click goes where it says.
  await page
    .getByRole("navigation", { name: "Legal" })
    .getByRole("link", { name: "Subprocessors" })
    .click()
  await expect(page).toHaveURL(/\/subprocessors$/)
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Subprocessors"
  )
})

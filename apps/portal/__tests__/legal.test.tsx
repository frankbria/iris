import { readFileSync } from "node:fs"
import path from "node:path"

import { render, screen, within } from "@testing-library/react"

import { LEGAL_LINKS, LegalDocument } from "@/components/legal-document"
import { parseLegal, readLegal } from "@/lib/legal"

const BANNER = "Draft — pending review; not yet in effect"
const doc = (extra = "", body = "## A\n\nText") =>
  parseLegal(`---\ntitle: T\nversion: 2026-01-01\n${extra}---\n${body}`)

describe("legal documents", () => {
  it("shows the draft banner only while front matter says draft", () => {
    const { rerender } = render(<LegalDocument doc={doc("draft: true\n")} />)
    expect(screen.getByRole("note").textContent).toBe(BANNER)
    rerender(<LegalDocument doc={doc()} />)
    expect(screen.queryByText(BANNER)).toBeNull()
  })

  it("renders headings, lists, bold and safe links, and escapes markup", () => {
    render(
      <LegalDocument
        doc={doc(
          "",
          "## Head\n\n- one **bold**\n- [site](/terms)\n\n<script>x</script> [bad](javascript:alert(1))"
        )}
      />
    )
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Head")
    expect(screen.getAllByRole("listitem")).toHaveLength(2)
    expect(screen.getByText("bold").tagName).toBe("STRONG")
    expect(
      screen.getByRole("link", { name: "site" }).getAttribute("href")
    ).toBe("/terms")
    // Markup is text, and a javascript: link is only its label.
    expect(screen.getByText(/<script>x<\/script>/)).toBeTruthy()
    expect(screen.queryByRole("link", { name: "bad" })).toBeNull()
  })

  it("requires front matter", () => {
    expect(() => parseLegal("# no front matter")).toThrow(/front matter/)
  })

  it("the shipped files parse, and carry the versions the server enforces", async () => {
    const { LEGAL_VERSIONS } = await import("../../../src/legal/versions")
    for (const name of ["terms", "acceptable-use"] as const) {
      const d = readLegal(name)
      expect(d.version).toBe(LEGAL_VERSIONS[name])
      expect(d.body.length).toBeGreaterThan(500)
    }
  })

  it("renders a pipe table, escaping its cells like any text", () => {
    render(
      <LegalDocument
        doc={doc(
          "",
          "| Name | Link |\n|---|---|\n| <b>x</b> | [ok](/privacy) |\n| **y** | [bad](javascript:alert(1)) |"
        )}
      />
    )
    const table = screen.getByRole("table")
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent)
    ).toEqual(["Name", "Link"])
    expect(within(table).getAllByRole("row")).toHaveLength(3)
    expect(within(table).getByText("<b>x</b>").tagName).toBe("TD")
    expect(within(table).getByText("y").tagName).toBe("STRONG")
    expect(
      within(table).getByRole("link", { name: "ok" }).getAttribute("href")
    ).toBe("/privacy")
    expect(within(table).queryByRole("link", { name: "bad" })).toBeNull()
  })

  it("leaves pipe lines without a separator row as a paragraph", () => {
    render(<LegalDocument doc={doc("", "| a | b |\n| c | d |")} />)
    expect(screen.queryByRole("table")).toBeNull()
  })

  it("links every legal document from the footer", () => {
    render(<LegalDocument doc={doc()} />)
    const nav = screen.getByRole("navigation", { name: "Legal" })
    expect(
      within(nav)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href"))
    ).toEqual(LEGAL_LINKS.map(([href]) => href))
  })

  it("the published documents parse, are drafts, and carry their pinned versions", async () => {
    const { PUBLISHED_VERSIONS } = await import("../../../src/legal/versions")
    for (const name of ["privacy", "subprocessors", "dpa"] as const) {
      const d = readLegal(name)
      expect(d.version).toBe(PUBLISHED_VERSIONS[name])
      expect(d.draft).toBe(true)
      expect(d.body.length).toBeGreaterThan(500)
    }
  })

  it("the subprocessor table names hosting, email, the AI vendors and Stripe", () => {
    render(<LegalDocument doc={readLegal("subprocessors")} />)
    const rows = within(screen.getByRole("table"))
      .getAllByRole("row")
      .map((r) => r.textContent ?? "")
    for (const name of [
      "[hosting provider]",
      "[email delivery provider]",
      "OpenAI",
      "Anthropic",
      "Stripe",
    ])
      expect(rows.some((r) => r.includes(name))).toBe(true)
  })

  it("the DPA template in docs/ is the page the portal publishes", () => {
    const file = (p: string) =>
      readFileSync(path.join(process.cwd(), p), "utf8")
    expect(file("../../docs/legal/dpa-template.md")).toBe(
      file("content/legal/dpa.md")
    )
  })
})

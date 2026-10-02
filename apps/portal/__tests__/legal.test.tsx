import { render, screen } from "@testing-library/react"

import { LegalDocument } from "@/components/legal-document"
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
})

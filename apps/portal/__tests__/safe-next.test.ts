import { safeNext } from "@/lib/safe-next"

describe("safeNext", () => {
  it("keeps a path on this site, query and all", () => {
    expect(safeNext("/accept-invitation/abc")).toBe("/accept-invitation/abc")
    expect(safeNext("/org?tab=1#x")).toBe("/org?tab=1#x")
  })

  it.each([
    undefined,
    "",
    "https://evil.example/",
    "//evil.example/",
    "/\\evil.example/",
    "/\t/evil.example/",
    "/\n/evil.example/",
    "javascript:alert(1)",
    "dashboard",
  ])("sends %j to the dashboard", (next) => {
    expect(safeNext(next)).toBe("/dashboard")
  })
})

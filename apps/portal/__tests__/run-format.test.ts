import { describeResult, formatTime, runsHref } from "@/lib/run-format"

/** How run results read on the portal (#270), one shape per run kind (#254). */
describe("describeResult", () => {
  it("an a11y page: its score and violations by impact, worst first", () => {
    expect(
      describeResult("a11y", {
        url: "https://a.example/",
        passed: false,
        result: {
          score: 20,
          violations: { minor: 1, serious: 3, critical: 2, moderate: 0 },
        },
      })
    ).toEqual({
      subject: "https://a.example/",
      outcome: "Failed",
      detail: "score 20 · 2 critical, 3 serious, 1 minor",
    })
    expect(
      describeResult("a11y", {
        url: "https://b.example/",
        passed: true,
        result: { score: 100, violations: {} },
      }).detail
    ).toBe("score 100 · no violations")
  })

  it("an RPC action: its description and error", () => {
    expect(
      describeResult("rpc", {
        url: null,
        passed: false,
        result: { action: "fill #q = <redacted>", error: "Timeout" },
      })
    ).toEqual({
      subject: "fill #q = <redacted>",
      outcome: "Failed",
      detail: "Timeout",
    })
  })

  it("a visual page: device, share of pixels that differ, severity", () => {
    expect(
      describeResult("visual", {
        url: "/pricing",
        passed: false,
        result: { device: "mobile", diffPercentage: 0.0312, severity: "major" },
      })
    ).toEqual({
      subject: "/pricing (mobile)",
      outcome: "Failed",
      detail: "3.12% of pixels differ · major",
    })
  })

  it("tolerates a result missing its fields", () => {
    expect(
      describeResult("rpc", { url: null, passed: true, result: {} })
    ).toEqual({ subject: "(action)", outcome: "Passed", detail: "" })
  })
})

describe("runsHref", () => {
  it("keeps filters, drops the cursor when a filter changes", () => {
    const current = { kind: "a11y", cursor: "abc" }
    expect(runsHref(current, { cursor: "next" })).toBe(
      "/runs?kind=a11y&cursor=next"
    )
    expect(runsHref(current, { status: "failed" })).toBe(
      "/runs?kind=a11y&status=failed"
    )
    expect(runsHref(current, { kind: null })).toBe("/runs")
  })
})

it("formatTime is UTC, to the second", () => {
  expect(formatTime("2026-06-01T10:00:00.123Z")).toBe("2026-06-01 10:00:00 UTC")
})

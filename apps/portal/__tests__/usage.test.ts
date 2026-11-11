import { aiSplit, formatUsd, planUsage, utcMonth } from "@/lib/usage"
import type { Entitlements } from "../../../src/billing/plans"
import type { UsageSummaryRow } from "../../../src/billing/usage"

/** What the usage page (#271) shows, from the ledger's summary rows (#263). */
const row = (
  kind: UsageSummaryRow["kind"],
  billingMode: UsageSummaryRow["billingMode"],
  quantity: number,
  costUsd = 0,
  estimatedCostUsd = 0
): UsageSummaryRow => ({ kind, billingMode, quantity, costUsd, estimatedCostUsd })

const SUMMARY = [
  row("a11y_job", null, 3),
  row("agent_turn", "byok", 5, 0.5),
  row("browser_minutes", null, 12.25),
  row("observation", null, 7),
  row("text_call", "byok", 2, 0.02),
  row("text_call", "managed", 3, 1.5, 0.5),
  row("vision_call", "managed", 1000, 0.25),
]

describe("utcMonth", () => {
  it("is the UTC calendar month around a moment, end exclusive", () => {
    expect(utcMonth(new Date("2026-11-11T05:00:00Z"))).toEqual({
      from: new Date("2026-11-01T00:00:00Z"),
      to: new Date("2026-12-01T00:00:00Z"),
    })
  })

  it("rolls over the year, and does not follow the local time zone", () => {
    expect(utcMonth(new Date("2026-12-31T23:59:59.999Z"))).toEqual({
      from: new Date("2026-12-01T00:00:00Z"),
      to: new Date("2027-01-01T00:00:00Z"),
    })
    expect(utcMonth(new Date("2027-01-01T00:00:00Z")).from).toEqual(
      new Date("2027-01-01T00:00:00Z")
    )
  })
})

describe("planUsage", () => {
  // Written out, not imported: `plans.ts` loads Kysely, which this jsdom suite cannot.
  const plan: Entitlements = {
    plan: "pro",
    maxConcurrentSessions: 2,
    runsPerMonth: 1000,
    agentTurnsPerMonth: 2000,
    visionCallsPerMonth: 1000,
    artifactStorageBytes: 20 * 1024 ** 3,
    managedAiCreditUsdPerMonth: 10,
    byokAllowed: true,
  }

  it("sets each metered kind against the plan's limit", () => {
    expect(planUsage(plan, SUMMARY, 8, 5 * 1024 ** 3)).toEqual([
      { label: "Runs", used: "8", limit: "1,000", reached: false },
      { label: "Agent turns", used: "5", limit: "2,000", reached: false },
      { label: "Vision calls", used: "1,000", limit: "1,000", reached: true },
      {
        label: "Artifact storage",
        used: "5.0 GiB",
        limit: "20.0 GiB",
        reached: false,
      },
      { label: "Text AI calls", used: "5", limit: null, reached: false },
      { label: "Page observations", used: "7", limit: null, reached: false },
      { label: "Browser minutes", used: "12.3", limit: null, reached: false },
    ])
  })

  it("shows zeros for an org with no usage, and a limit of zero as reached", () => {
    const lines = planUsage({ ...plan, runsPerMonth: 0 }, [], 0, 0)
    expect(lines.map((l) => l.used)).toEqual([
      "0",
      "0",
      "0",
      "0 B",
      "0",
      "0",
      "0",
    ])
    expect(lines[0]).toEqual({
      label: "Runs",
      used: "0",
      limit: "0",
      reached: true,
    })
  })

  it("runs come from the enforced count, not the ledger rows", () => {
    expect(planUsage(plan, SUMMARY, 1001, 0)[0]).toEqual({
      label: "Runs",
      used: "1,001",
      limit: "1,000",
      reached: true,
    })
  })
})

describe("aiSplit", () => {
  it("splits AI calls and their cost by who paid the provider", () => {
    expect(aiSplit(SUMMARY)).toEqual({
      rows: [
        {
          label: "Text AI calls",
          byok: { calls: 2, costUsd: 0.02 },
          managed: { calls: 3, costUsd: 1.5 },
        },
        {
          label: "Vision calls",
          byok: { calls: 0, costUsd: 0 },
          managed: { calls: 1000, costUsd: 0.25 },
        },
        {
          label: "Agent turns",
          byok: { calls: 5, costUsd: 0.5 },
          managed: { calls: 0, costUsd: 0 },
        },
      ],
      total: {
        label: "Total",
        byok: { calls: 7, costUsd: 0.52 },
        managed: { calls: 1003, costUsd: 1.75 },
      },
      estimatedCostUsd: 0.5,
    })
  })

  it("is all zeros with no AI usage: platform rows are not AI", () => {
    const split = aiSplit([row("a11y_job", null, 3)])
    expect(split.total).toEqual({
      label: "Total",
      byok: { calls: 0, costUsd: 0 },
      managed: { calls: 0, costUsd: 0 },
    })
    expect(split.estimatedCostUsd).toBe(0)
  })
})

describe("formatUsd", () => {
  it("shows cents, and says so when an amount is under one", () => {
    expect(formatUsd(0)).toBe("$0.00")
    expect(formatUsd(0.004)).toBe("under $0.01")
    expect(formatUsd(0.01)).toBe("$0.01")
    expect(formatUsd(1234.5)).toBe("$1,234.50")
  })
})

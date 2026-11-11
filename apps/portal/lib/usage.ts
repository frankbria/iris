import type { Entitlements } from "../../../src/billing/plans"
import type { UsageKind, UsageSummaryRow } from "../../../src/billing/usage"
import { formatBytes } from "@/lib/run-format"

/**
 * What the usage page (#271) shows, worked out from the ledger's summary (#263) and the
 * org's entitlements (#260). Pure, so it is unit-tested without a database.
 */

/** The UTC calendar month around `now`, end exclusive: the window limits are enforced on (#346). */
export function utcMonth(now: Date): { from: Date; to: Date } {
  const year = now.getUTCFullYear()
  const month = now.getUTCMonth()
  return {
    from: new Date(Date.UTC(year, month, 1)),
    to: new Date(Date.UTC(year, month + 1, 1)),
  }
}

const count = (n: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: 1 })

/** Cents; an amount under one cent says so instead of rounding to nothing. */
export const formatUsd = (usd: number) =>
  usd > 0 && usd < 0.01
    ? "under $0.01"
    : usd.toLocaleString("en-US", { style: "currency", currency: "USD" })

export interface UsageLine {
  label: string
  used: string
  /** `null`: metered, but the plan sets no monthly limit on it. */
  limit: string | null
  reached: boolean
}

const AI_KINDS = [
  ["text_call", "Text AI calls"],
  ["vision_call", "Vision calls"],
  ["agent_turn", "Agent turns"],
] as const satisfies readonly (readonly [UsageKind, string])[]

/**
 * This month's usage against the plan. `runsUsed` is the number the API enforces
 * (`runsUsedThisMonth`: billed jobs plus queued and running ones), not the ledger's.
 */
export function planUsage(
  plan: Entitlements,
  summary: UsageSummaryRow[],
  runsUsed: number,
  storageBytes: number
): UsageLine[] {
  const used = (kind: UsageKind) =>
    summary
      .filter((row) => row.kind === kind)
      .reduce((sum, row) => sum + row.quantity, 0)
  const line = (
    label: string,
    value: number,
    limit: number | null,
    format = count
  ): UsageLine => ({
    label,
    used: format(value),
    limit: limit === null ? null : format(limit),
    reached: limit !== null && value >= limit,
  })
  return [
    line("Runs", runsUsed, plan.runsPerMonth),
    line("Agent turns", used("agent_turn"), plan.agentTurnsPerMonth),
    line("Vision calls", used("vision_call"), plan.visionCallsPerMonth),
    line(
      "Artifact storage",
      storageBytes,
      plan.artifactStorageBytes,
      formatBytes
    ),
    line("Text AI calls", used("text_call"), null),
    line("Page observations", used("observation"), null),
    line("Browser minutes", used("browser_minutes"), null),
  ]
}

export interface ModeUsage {
  calls: number
  costUsd: number
}

export interface AiSplitRow {
  label: string
  /** Paid with the org's own provider key. */
  byok: ModeUsage
  /** Paid with IRIS's key, from the plan's credit (#479). */
  managed: ModeUsage
}

/** AI calls and provider cost by who paid (`billing_mode`), per kind and in total. */
export function aiSplit(summary: UsageSummaryRow[]): {
  rows: AiSplitRow[]
  total: AiSplitRow
  /** The part of the total cost priced at an estimated rate (#243). */
  estimatedCostUsd: number
} {
  const of = (
    mode: "byok" | "managed",
    kinds: readonly UsageKind[]
  ): ModeUsage =>
    summary
      .filter((row) => row.billingMode === mode && kinds.includes(row.kind))
      .reduce(
        (sum, row) => ({
          calls: sum.calls + row.quantity,
          costUsd: sum.costUsd + row.costUsd,
        }),
        { calls: 0, costUsd: 0 }
      )
  const split = (label: string, kinds: readonly UsageKind[]): AiSplitRow => ({
    label,
    byok: of("byok", kinds),
    managed: of("managed", kinds),
  })
  return {
    rows: AI_KINDS.map(([kind, label]) => split(label, [kind])),
    total: split(
      "Total",
      AI_KINDS.map(([kind]) => kind)
    ),
    estimatedCostUsd: summary.reduce(
      (sum, row) => sum + row.estimatedCostUsd,
      0
    ),
  }
}

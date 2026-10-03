/**
 * How the portal shows a run and its results (#270). Pure functions, shared by the
 * runs pages and their tests. A result's shape depends on the run's kind (#254):
 * a11y pages carry a score and violation counts by impact, RPC actions a description
 * and an error, visual pages a pass/fail (their images are #463).
 */

export const RUN_KINDS = ["rpc", "a11y", "visual"] as const
export const RUN_STATUSES = ["succeeded", "failed", "canceled"] as const

export type RunKind = (typeof RUN_KINDS)[number]

export const KIND_LABEL: Record<RunKind, string> = {
  rpc: "Browser session",
  a11y: "Accessibility",
  visual: "Visual",
}

const IMPACTS = ["critical", "serious", "moderate", "minor"] as const

/** One result as a row: what it concerns and what happened, in words. */
export function describeResult(
  kind: string,
  result: {
    url: string | null
    passed: boolean
    result: Record<string, unknown>
  }
): { subject: string; outcome: string; detail: string } {
  const r = result.result
  const outcome = result.passed ? "Passed" : "Failed"
  if (kind === "a11y") {
    const v = (r.violations ?? {}) as Record<string, number>
    const counts = IMPACTS.filter((i) => (v[i] ?? 0) > 0).map(
      (i) => `${v[i]} ${i}`
    )
    const score = typeof r.score === "number" ? `score ${r.score}` : null
    return {
      subject: result.url ?? "(page)",
      outcome,
      detail: [score, counts.length ? counts.join(", ") : "no violations"]
        .filter(Boolean)
        .join(" · "),
    }
  }
  if (kind === "rpc") {
    const action = typeof r.action === "string" ? r.action : "(action)"
    const error = typeof r.error === "string" ? r.error : ""
    return { subject: action, outcome, detail: error }
  }
  // visual: one page on one device, its share of pixels that differ.
  const device = typeof r.device === "string" ? ` (${r.device})` : ""
  const diff =
    typeof r.diffPercentage === "number"
      ? `${(r.diffPercentage * 100).toFixed(2)}% of pixels differ`
      : ""
  const severity = typeof r.severity === "string" ? r.severity : ""
  return {
    subject: `${result.url ?? "(page)"}${device}`,
    outcome,
    detail: [diff, severity].filter(Boolean).join(" · "),
  }
}

/** A list URL keeping the current filters, with `changes` applied (undefined removes). */
export function runsHref(
  current: { kind?: string; status?: string; cursor?: string },
  changes: {
    kind?: string | null
    status?: string | null
    cursor?: string | null
  }
): string {
  const merged: Record<string, string | undefined> = { ...current }
  for (const [k, v] of Object.entries(changes)) merged[k] = v ?? undefined
  // Changing a filter starts from the newest page.
  if ("kind" in changes || "status" in changes)
    merged.cursor = changes.cursor ?? undefined
  const qs = new URLSearchParams(
    Object.entries(merged).filter((e): e is [string, string] => Boolean(e[1]))
  ).toString()
  return qs ? `/runs?${qs}` : "/runs"
}

export const formatTime = (d: Date | string) =>
  new Date(d).toISOString().replace("T", " ").slice(0, 19) + " UTC"

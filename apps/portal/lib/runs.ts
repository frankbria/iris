// Reads tenant data from Postgres: a client import must fail the build.
import "server-only"

import { orgRunReads } from "../../../src/run-reads"
import { getDb } from "@/lib/auth"
import { RUN_KINDS, RUN_STATUSES } from "@/lib/run-format"

/**
 * An org's runs (#270), read straight from the store the API writes (ADR 0001: the
 * portal never calls the public API). The org id comes from `requireOrg()` only.
 */
export const runsFor = (orgId: string) => orgRunReads(getDb(), orgId)

export const PAGE_SIZE = 20

/** The list's filters from the URL: unknown values are dropped, not errors. */
export function listFilters(
  params: Record<string, string | string[] | undefined>
) {
  const one = (v: string | string[] | undefined) =>
    typeof v === "string" ? v : undefined
  const kind = one(params.kind)
  const status = one(params.status)
  return {
    kind: RUN_KINDS.find((k) => k === kind),
    status: RUN_STATUSES.find((s) => s === status),
    cursor: one(params.cursor),
  }
}

// Reads tenant data from Postgres: a client import must fail the build.
import "server-only"

import { orgRunReads } from "../../../src/run-reads"
import {
  resolveArtifactStore,
  signRunArtifacts,
  type ArtifactStore,
  type SignedArtifact,
} from "../../../src/artifact-store"
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

let store: ArtifactStore | null | undefined
/** The org artifact store from `IRIS_S3_*` (#460); `null` when the portal has none. */
export function artifactStore(): ArtifactStore | null {
  if (store === undefined) store = resolveArtifactStore()
  return store
}

/**
 * A visual result's images as signed URLs for this org and run (#460, #463): only the
 * run's own keys and the org's baselines are signed. `null` without a store.
 */
export async function visualImages(
  orgId: string,
  runId: string,
  artifacts: unknown
): Promise<Record<string, SignedArtifact> | null> {
  const s = artifactStore()
  if (!s) return null
  return (await signRunArtifacts(s, { orgId, runId }, artifacts)).signed
}

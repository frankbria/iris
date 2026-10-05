import { headers } from "next/headers"
import Link from "next/link"
import { notFound } from "next/navigation"

import { redactStrings } from "../../../../../src/log"
import type { StoredRun, StoredRunResult } from "../../../../../src/run-reads"
import { ApproveBaselineForm } from "@/components/approve-baseline-form"
import { SuspendedBanner } from "@/components/contact-link"
import { getAuth } from "@/lib/auth"
import { requireOrg } from "@/lib/org"
import { runsFor, visualImages } from "@/lib/runs"
import {
  describeResult,
  formatTime,
  KIND_LABEL,
  type RunKind,
} from "@/lib/run-format"

/**
 * One run and its results (#270). Read through the org's store, so another org's id
 * (or an unknown one) is a 404, never someone else's run. Strings pass through the
 * same redaction as the API (#269): a recorded `?token=` is not shown.
 */
export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { org, suspended } = await requireOrg()
  const { id } = await params
  const found = await runsFor(org.id).get(id)
  if (!found) notFound()
  // Artifact keys out before redaction (a key segment can look like a secret), signed
  // after (#460): raw keys are never rendered.
  const keys = found.results.map((r) => {
    const { artifacts, ...rest } = (r.result ?? {}) as Record<string, unknown>
    r.result = rest
    return artifacts
  })
  const run = redactStrings(found) as StoredRun & {
    error: string | null
    results: StoredRunResult[]
  }
  const visual = run.kind === "visual"
  const images = visual
    ? await Promise.all(
        keys.map((k) => (k ? visualImages(org.id, run.id, k) : null))
      )
    : []
  // Only owners and admins get the button (the action checks again, #463).
  const canApprove =
    visual &&
    !suspended &&
    Boolean(
      (
        await getAuth()
          .api.hasPermission({
            headers: await headers(),
            body: {
              organizationId: org.id,
              permissions: { visualBaseline: ["approve"] },
            },
          })
          .catch(() => null)
      )?.success
    )

  return (
    <main className="flex min-h-svh flex-col gap-4 p-6">
      {suspended && <SuspendedBanner />}
      <Link href="/runs" className="text-sm underline">
        All runs
      </Link>
      <h1 className="font-heading text-lg font-medium">
        {KIND_LABEL[run.kind as RunKind] ?? run.kind} run
      </h1>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Status</dt>
        <dd className={run.status === "succeeded" ? "" : "text-destructive"}>
          {run.status}
        </dd>
        <dt className="text-muted-foreground">Summary</dt>
        <dd>{run.summary ?? "—"}</dd>
        {run.error && (
          <>
            <dt className="text-muted-foreground">Error</dt>
            <dd className="break-words text-destructive">{run.error}</dd>
          </>
        )}
        <dt className="text-muted-foreground">Started</dt>
        <dd>{formatTime(run.startedAt)}</dd>
        <dt className="text-muted-foreground">Finished</dt>
        <dd>{formatTime(run.finishedAt)}</dd>
        <dt className="text-muted-foreground">Run id</dt>
        <dd className="font-mono text-xs">{run.id}</dd>
      </dl>

      {run.results.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          This run recorded no results.
        </p>
      ) : (
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Results, in the order they ran</caption>
          <thead className="text-muted-foreground">
            <tr>
              <th scope="col" className="py-2 pr-4 font-medium">
                {run.kind === "rpc" ? "Action" : "Page"}
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Outcome
              </th>
              <th scope="col" className="py-2 font-medium">
                Detail
              </th>
            </tr>
          </thead>
          <tbody>
            {run.results.map((result, i) => {
              const row = describeResult(run.kind, result)
              return (
                <tr key={i} className="border-t align-top">
                  <td className="py-2 pr-4 break-all">{row.subject}</td>
                  <td
                    className={
                      "py-2 pr-4 " + (result.passed ? "" : "text-destructive")
                    }
                  >
                    {row.outcome}
                  </td>
                  <td className="py-2 break-words">{row.detail || "—"}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {visual && images.some(Boolean) && (
        <section aria-labelledby="screenshots" className="flex flex-col gap-6">
          <h2 id="screenshots" className="font-heading text-base font-medium">
            Screenshots
          </h2>
          {run.results.map((result, i) => {
            const set = images[i]
            if (!set) return null
            const device = String(
              (result.result as { device?: unknown }).device ?? ""
            )
            const where = `${result.url ?? "page"} on ${device}`
            const shown = (["baseline", "current", "diff"] as const).filter(
              (k) => set[k]
            )
            return (
              <article key={i} className="flex flex-col gap-2 border-t pt-4">
                <h3 className="text-sm font-medium break-all">{where}</h3>
                <div className="grid gap-3 sm:grid-cols-3">
                  {shown.map((k) => (
                    <figure key={k} className="flex flex-col gap-1">
                      {/* Signed, short-lived URLs on the storage host: not for next/image. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={set[k].url}
                        alt={`${IMAGE_LABEL[k]} of ${where}`}
                        className="w-full border bg-white"
                      />
                      <figcaption className="text-xs text-muted-foreground">
                        {IMAGE_LABEL[k]}
                      </figcaption>
                    </figure>
                  ))}
                </div>
                {canApprove && !result.passed && set.current && (
                  <ApproveBaselineForm
                    organizationId={org.id}
                    runId={run.id}
                    position={i}
                    label={where}
                  />
                )}
              </article>
            )
          })}
        </section>
      )}
    </main>
  )
}

const IMAGE_LABEL = {
  baseline: "Baseline",
  current: "This run",
  diff: "Differences",
} as const

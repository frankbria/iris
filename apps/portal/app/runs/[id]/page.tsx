import Link from "next/link"
import { notFound } from "next/navigation"

import { redactStrings } from "../../../../../src/log"
import type { StoredRun, StoredRunResult } from "../../../../../src/run-reads"
import { SuspendedBanner } from "@/components/contact-link"
import { requireOrg } from "@/lib/org"
import { runsFor } from "@/lib/runs"
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
  const run = redactStrings(found) as StoredRun & { results: StoredRunResult[] }

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
    </main>
  )
}

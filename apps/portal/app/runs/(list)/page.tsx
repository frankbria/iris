import Link from "next/link"

import { InvalidCursorError } from "../../../../../src/run-reads"
import { SuspendedBanner } from "@/components/contact-link"
import { requireOrg } from "@/lib/org"
import { listFilters, PAGE_SIZE, runsFor } from "@/lib/runs"
import {
  formatTime,
  KIND_LABEL,
  RUN_KINDS,
  RUN_STATUSES,
  runsHref,
  type RunKind,
} from "@/lib/run-format"

/**
 * The org's runs (#270): newest first by finish time, filtered by kind and status,
 * paged with the store's cursor. Filters and paging are plain links, so the page needs
 * no client script and works from the keyboard as ordinary links do.
 */
export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { org, suspended } = await requireOrg()
  const filters = listFilters(await searchParams)

  let page
  try {
    page = await runsFor(org.id).listPage({ ...filters, limit: PAGE_SIZE })
  } catch (err) {
    if (!(err instanceof InvalidCursorError)) throw err
    page = null
  }

  const filterLink = (
    label: string,
    changes: { kind?: string | null; status?: string | null },
    active: boolean
  ) => (
    <Link
      key={label}
      href={runsHref(filters, changes)}
      aria-current={active ? "true" : undefined}
      className={
        active
          ? "rounded-md bg-muted px-2 py-1 font-medium"
          : "rounded-md px-2 py-1 underline-offset-4 hover:underline"
      }
    >
      {label}
    </Link>
  )

  return (
    <main className="flex min-h-svh flex-col gap-4 p-6">
      {suspended && <SuspendedBanner />}
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="font-heading text-lg font-medium">Runs</h1>
        <Link href="/dashboard" className="text-sm underline">
          Dashboard
        </Link>
      </div>

      <nav aria-label="Filter runs" className="flex flex-col gap-2 text-sm">
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-muted-foreground">Kind:</span>
          {filterLink("All", { kind: null }, !filters.kind)}
          {RUN_KINDS.map((k) =>
            filterLink(KIND_LABEL[k], { kind: k }, filters.kind === k)
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-muted-foreground">Status:</span>
          {filterLink("All", { status: null }, !filters.status)}
          {RUN_STATUSES.map((s) =>
            filterLink(
              s[0].toUpperCase() + s.slice(1),
              { status: s },
              filters.status === s
            )
          )}
        </div>
      </nav>

      {page === null ? (
        <p role="status" className="text-sm">
          That page link is no longer valid.{" "}
          <Link
            href={runsHref(filters, { cursor: null })}
            className="underline"
          >
            Show the newest runs
          </Link>
        </p>
      ) : page.runs.length === 0 ? (
        <div role="status" className="flex flex-col gap-1 text-sm">
          <p className="font-medium">No runs yet</p>
          <p className="text-muted-foreground">
            {filters.kind || filters.status
              ? "No run matches these filters."
              : "Runs appear here once an API key has run a browser session or a job."}
          </p>
        </div>
      ) : (
        <>
          <table className="w-full text-left text-sm">
            <caption className="sr-only">
              Runs, newest first by finish time
            </caption>
            <thead className="text-muted-foreground">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Finished
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Kind
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Status
                </th>
                <th scope="col" className="py-2 font-medium">
                  Summary
                </th>
              </tr>
            </thead>
            <tbody>
              {page.runs.map((run) => (
                <tr key={run.id} className="border-t">
                  <td className="py-2 pr-4 whitespace-nowrap">
                    <Link href={`/runs/${run.id}`} className="underline">
                      {formatTime(run.finishedAt)}
                    </Link>
                  </td>
                  <td className="py-2 pr-4">
                    {KIND_LABEL[run.kind as RunKind] ?? run.kind}
                  </td>
                  <td className="py-2 pr-4">
                    <span
                      className={
                        run.status === "succeeded" ? "" : "text-destructive"
                      }
                    >
                      {run.status}
                    </span>
                  </td>
                  <td className="py-2">{run.summary ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <nav aria-label="Pages" className="flex gap-4 text-sm">
            {filters.cursor && (
              <Link
                href={runsHref(filters, { cursor: null })}
                className="underline"
              >
                Newest runs
              </Link>
            )}
            {page.nextCursor && (
              <Link
                href={runsHref(filters, { cursor: page.nextCursor })}
                className="underline"
              >
                Older runs
              </Link>
            )}
          </nav>
        </>
      )}
    </main>
  )
}

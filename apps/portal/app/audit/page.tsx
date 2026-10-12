import Link from "next/link"

import {
  auditPage,
  InvalidAuditCursorError,
  type AuditRecord,
} from "../../../../src/audit-reads"
import { SuspendedBanner } from "@/components/contact-link"
import { getDb } from "@/lib/auth"
import { isManager, requireOrg } from "@/lib/org"
import { formatTime } from "@/lib/run-format"

/**
 * The org's audit trail (#541): what #361 records, newest first, paged by a cursor
 * link. Owners and admins only; members are told so. The org comes from the session
 * (`requireOrg()`), never the request.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { org, role, suspended } = await requireOrg()
  if (!isManager(role)) {
    return (
      <main className="flex min-h-svh flex-col gap-4 p-6">
        <h1 className="font-heading text-lg font-medium">Audit log</h1>
        <p role="status" className="text-sm">
          Only owners and admins can view the audit log.
        </p>
        <Link href="/dashboard" className="text-sm underline">
          Dashboard
        </Link>
      </main>
    )
  }
  const raw = (await searchParams).cursor
  const cursor = typeof raw === "string" ? raw : undefined

  let page
  try {
    page = await auditPage(getDb(), org.id, { cursor, limit: 50 })
  } catch (err) {
    if (!(err instanceof InvalidAuditCursorError)) throw err
    page = null
  }

  return (
    <main className="flex min-h-svh flex-col gap-4 p-6">
      {suspended && <SuspendedBanner />}
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="font-heading text-lg font-medium">Audit log</h1>
        <Link href="/dashboard" className="text-sm underline">
          Dashboard
        </Link>
      </div>
      {page === null ? (
        <p role="status" className="text-sm">
          That page link is no longer valid.{" "}
          <Link href="/audit" className="underline">
            Show the newest entries
          </Link>
        </p>
      ) : page.entries.length === 0 ? (
        <p role="status" className="text-sm text-muted-foreground">
          No entries yet. Key, provider-key, plan and AI-mode changes, job
          submits and browser sessions appear here.
        </p>
      ) : (
        <>
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Audit entries, newest first</caption>
            <thead className="text-muted-foreground">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">
                  When
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Who
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Action
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Target
                </th>
                <th scope="col" className="py-2 font-medium">
                  Details
                </th>
              </tr>
            </thead>
            <tbody>
              {page.entries.map((e) => (
                <tr key={e.id} className="border-t align-top">
                  <td className="py-2 pr-4 whitespace-nowrap">
                    {formatTime(e.createdAt)}
                  </td>
                  <td className="py-2 pr-4">{actorLabel(e)}</td>
                  <td className="py-2 pr-4 font-mono">{e.action}</td>
                  <td className="py-2 pr-4 font-mono">{e.target ?? ""}</td>
                  <td className="py-2 font-mono text-xs break-all">
                    {e.metadata ? JSON.stringify(e.metadata) : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {page.nextCursor && (
            <Link
              href={`/audit?cursor=${encodeURIComponent(page.nextCursor)}`}
              className="text-sm underline"
            >
              Older entries
            </Link>
          )}
        </>
      )}
    </main>
  )
}

function actorLabel(e: AuditRecord): string {
  if (e.actorUser) {
    return e.actorUser.name || e.actorUser.email || `user ${e.actorUser.id}`
  }
  if (e.actorApiKeyId) return `API key ${e.actorApiKeyId}`
  return "IRIS"
}

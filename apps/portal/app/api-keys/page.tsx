import { headers } from "next/headers"
import Link from "next/link"

import {
  CreateApiKeyForm,
  RevokeApiKeyButton,
} from "@/components/api-key-forms"
import { getAuth } from "@/lib/auth"
import { requireOrg } from "@/lib/org"

const when = (date: Date | string | null) =>
  date
    ? `${new Date(date).toISOString().slice(0, 16).replace("T", " ")} UTC`
    : "never"

/**
 * The active org's API keys (#340). BetterAuth checks the caller's role in the org on
 * every call: members may list, owners and admins may also create and revoke. A key is
 * shown once, by the form that created it; the list has only its first characters.
 *
 * ponytail: the list is BetterAuth's first page. Page it when an org outgrows that.
 */
export default async function ApiKeysPage() {
  const { org, role } = await requireOrg()
  const { apiKeys } = await getAuth().api.listApiKeys({
    headers: await headers(),
    query: { organizationId: org.id },
  })
  // A member may hold several roles, stored comma-separated.
  const manager = role.split(",").some((r) => r === "owner" || r === "admin")
  return (
    <main className="flex min-h-svh flex-col gap-6 p-6">
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-lg font-medium">
          API keys for {org.name}
        </h1>
        <Link href="/dashboard" className="text-sm underline">
          Back to the dashboard
        </Link>
      </div>
      <section className="flex flex-col gap-2">
        <h2 id="keys" className="font-medium">
          Keys
        </h2>
        <ul aria-labelledby="keys" className="flex flex-col gap-2 text-sm">
          {apiKeys.map((k) => (
            <li key={k.id} className="flex items-center gap-3">
              <span>{k.name}</span>
              <code className="text-muted-foreground">{k.start}…</code>
              <span className="text-muted-foreground">
                created {when(k.createdAt)}, last used {when(k.lastRequest)}
              </span>
              {manager && (
                <RevokeApiKeyButton keyId={k.id} name={k.name ?? k.id} />
              )}
            </li>
          ))}
        </ul>
        {apiKeys.length === 0 && (
          <p className="text-sm text-muted-foreground">No keys yet.</p>
        )}
      </section>
      {manager ? (
        <CreateApiKeyForm organizationId={org.id} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Only owners and admins can create or revoke keys.
        </p>
      )}
    </main>
  )
}

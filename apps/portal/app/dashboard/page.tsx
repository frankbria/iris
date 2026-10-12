import Link from "next/link"

import { LogOutButton } from "@/components/auth-forms"
import { OrgSwitcher } from "@/components/org-forms"
import { SuspendedBanner } from "@/components/contact-link"
import { getDb } from "@/lib/auth"
import { isManager, requireOrg } from "@/lib/org"
import { formatBytes } from "@/lib/run-format"
import { orgEntitlements } from "../../../../src/billing/plans"
import { storageUsage } from "../../../../src/storage-quota"

export default async function DashboardPage() {
  const { session, org, orgs, role, suspended } = await requireOrg()
  // Artifact storage against the plan (#315): what visual jobs and approvals stored.
  const [used, { artifactStorageBytes }] = await Promise.all([
    storageUsage(getDb(), org.id),
    orgEntitlements(getDb()).get(org.id),
  ])
  return (
    <main className="flex min-h-svh flex-col gap-4 p-6">
      {suspended && <SuspendedBanner />}
      <h1 className="font-heading text-lg font-medium">IRIS portal</h1>
      <p className="text-sm text-muted-foreground">
        Signed in as{" "}
        <span className="text-foreground">{session.user.email}</span>
      </p>
      <OrgSwitcher orgs={orgs} activeId={org.id} />
      <p className="text-sm text-muted-foreground">Your role: {role}</p>
      <p className="text-sm text-muted-foreground">
        Artifact storage: {formatBytes(used)} of{" "}
        {formatBytes(artifactStorageBytes)}
      </p>
      <Link href="/runs" className="text-sm underline">
        Runs
      </Link>
      <Link href="/org" className="text-sm underline">
        Members
      </Link>
      <Link href="/api-keys" className="text-sm underline">
        API keys
      </Link>
      <Link href="/provider-keys" className="text-sm underline">
        AI provider keys
      </Link>
      {isManager(role) && (
        <Link href="/audit" className="text-sm underline">
          Audit log
        </Link>
      )}
      <div>
        <LogOutButton />
      </div>
    </main>
  )
}

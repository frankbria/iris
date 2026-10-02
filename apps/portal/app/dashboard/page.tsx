import Link from "next/link"

import { LogOutButton } from "@/components/auth-forms"
import { OrgSwitcher } from "@/components/org-forms"
import { requireOrg } from "@/lib/org"

export default async function DashboardPage() {
  const { session, org, orgs, role } = await requireOrg()
  return (
    <main className="flex min-h-svh flex-col gap-4 p-6">
      <h1 className="font-heading text-lg font-medium">IRIS portal</h1>
      <p className="text-sm text-muted-foreground">
        Signed in as{" "}
        <span className="text-foreground">{session.user.email}</span>
      </p>
      <OrgSwitcher orgs={orgs} activeId={org.id} />
      <p className="text-sm text-muted-foreground">Your role: {role}</p>
      <Link href="/org" className="text-sm underline">
        Members
      </Link>
      <Link href="/api-keys" className="text-sm underline">
        API keys
      </Link>
      <div>
        <LogOutButton />
      </div>
    </main>
  )
}

import Link from "next/link"

import { InviteForm } from "@/components/org-forms"
import { SuspendedBanner } from "@/components/contact-link"
import { requireOrg } from "@/lib/org"

export default async function OrgPage() {
  const { org, role, suspended } = await requireOrg()
  const now = new Date()
  const pending = org.invitations.filter(
    (i) => i.status === "pending" && new Date(i.expiresAt) > now
  )
  return (
    <main className="flex min-h-svh flex-col gap-6 p-6">
      {suspended && <SuspendedBanner />}
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-lg font-medium">{org.name}</h1>
        <Link href="/dashboard" className="text-sm underline">
          Back to the dashboard
        </Link>
      </div>
      <section className="flex flex-col gap-2">
        <h2 id="members" className="font-medium">
          Members
        </h2>
        <ul aria-labelledby="members" className="text-sm">
          {org.members.map((m) => (
            <li key={m.id}>
              {m.user.email}{" "}
              <span className="text-muted-foreground">{m.role}</span>
            </li>
          ))}
        </ul>
      </section>
      <section className="flex flex-col gap-2">
        <h2 id="pending" className="font-medium">
          Pending invitations
        </h2>
        <ul aria-labelledby="pending" className="text-sm">
          {pending.map((i) => (
            <li key={i.id}>
              {i.email} <span className="text-muted-foreground">{i.role}</span>
            </li>
          ))}
        </ul>
        {pending.length === 0 && (
          <p className="text-sm text-muted-foreground">None.</p>
        )}
      </section>
      {role === "owner" || role === "admin" ? (
        <InviteForm organizationId={org.id} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Only owners and admins can invite people.
        </p>
      )}
    </main>
  )
}

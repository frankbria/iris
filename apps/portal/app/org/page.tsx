import Link from "next/link"

import { liveKeysByCreator } from "../../../../src/audit-log"
import {
  InviteForm,
  LeaveOrgButton,
  MemberControls,
} from "@/components/org-forms"
import { SuspendedBanner } from "@/components/contact-link"
import { getDb } from "@/lib/auth"
import { requireOrg } from "@/lib/org"

/** BetterAuth keeps several roles as one comma string (`admin,owner`). */
const hasRole = (roles: string, role: string) =>
  roles.split(",").some((r) => r.trim() === role)

export default async function OrgPage() {
  const { session, org, role, suspended } = await requireOrg()
  const now = new Date()
  const pending = org.invitations.filter(
    (i) => i.status === "pending" && new Date(i.expiresAt) > now
  )
  const manages = hasRole(role, "owner") || hasRole(role, "admin")
  const isOwner = hasRole(role, "owner")
  // BetterAuth refuses to remove, demote or let go the last owner; say so instead.
  const owners = org.members.filter((m) => hasRole(m.role, "owner")).length
  const soleOwner = (memberRole: string) =>
    hasRole(memberRole, "owner") && owners === 1
  const keys = await liveKeysByCreator(getDb(), org.id)
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
        <ul aria-labelledby="members" className="flex flex-col gap-2 text-sm">
          {org.members.map((m) => {
            const self = m.userId === session.user.id
            // An admin cannot act on an owner; nobody acts on the last owner.
            const editable =
              manages &&
              !self &&
              !soleOwner(m.role) &&
              (isOwner || !hasRole(m.role, "owner"))
            return (
              <li key={m.id} className="flex flex-col gap-1">
                <span>
                  {m.user.email}{" "}
                  <span className="text-muted-foreground">{m.role}</span>
                </span>
                {editable && (
                  <MemberControls
                    organizationId={org.id}
                    memberId={m.id}
                    email={m.user.email}
                    role={m.role}
                    roles={
                      isOwner
                        ? ["member", "admin", "owner"]
                        : ["member", "admin"]
                    }
                    keys={keys.get(m.userId) ?? 0}
                  />
                )}
              </li>
            )
          })}
        </ul>
        {manages && owners === 1 && (
          <p className="text-sm text-muted-foreground">
            The only owner cannot be removed, demoted or leave. Make someone
            else an owner first.
          </p>
        )}
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
      {manages ? (
        <InviteForm organizationId={org.id} />
      ) : (
        <p className="text-sm text-muted-foreground">
          Only owners and admins can invite people.
        </p>
      )}
      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Leave</h2>
        {soleOwner(role) ? (
          <p className="text-sm text-muted-foreground">
            You are the only owner, so you cannot leave. Make someone else an
            owner first.
          </p>
        ) : (
          <LeaveOrgButton
            organizationId={org.id}
            keys={keys.get(session.user.id) ?? 0}
          />
        )}
      </section>
    </main>
  )
}

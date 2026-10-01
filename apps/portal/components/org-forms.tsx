"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"

import { AuthCard, Field, text, useAuthAction } from "@/components/auth-forms"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { authClient } from "@/lib/auth-client"

/** Org calls are made signed in: pass BetterAuth's message through. */
const explain = (error: { status: number; message?: string }) =>
  error.status === 429
    ? "Too many attempts. Wait a minute and try again."
    : error.message || "Something went wrong. Try again."

const selectClass =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-base transition-colors outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-input/30"

/**
 * Invites someone to the org the page showed. Its id is sent, not left to the session:
 * another tab may have switched the active org since. BetterAuth checks the inviter's
 * role in that org.
 */
export function InviteForm({ organizationId }: { organizationId: string }) {
  const router = useRouter()
  const { busy, error, run } = useAuthAction(explain)
  const [sentTo, setSentTo] = useState<string | null>(null)
  return (
    <AuthCard
      title="Invite someone"
      description="They get an email with a link to join."
      notice={sentTo && `Invitation sent to ${sentTo}.`}
      submit="Send invitation"
      busy={busy}
      error={error}
      onSubmit={async (form) => {
        const email = text(form, "email")
        const ok = await run(() =>
          authClient.organization.inviteMember({
            organizationId,
            email,
            role: text(form, "role") as "member" | "admin",
          })
        )
        if (ok) {
          setSentTo(email)
          router.refresh()
        }
      }}
    >
      <Field label="Email" name="email" type="email" autoComplete="off" />
      <div className="grid gap-2">
        <Label htmlFor="role">Role</Label>
        <select id="role" name="role" className={selectClass}>
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
      </div>
    </AuthCard>
  )
}

export function AcceptInvitationButton({
  invitationId,
}: {
  invitationId: string
}) {
  const router = useRouter()
  const { busy, error, run } = useAuthAction(explain)
  return (
    <div className="flex flex-col gap-2">
      <Button
        disabled={busy}
        onClick={async () => {
          const ok = await run(() =>
            authClient.organization.acceptInvitation({ invitationId })
          )
          // Accepting makes the joined org the active one.
          if (ok) router.push("/org")
        }}
      >
        Accept invitation
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

/** Picks the active org; every page reads its data from that one. */
export function OrgSwitcher({
  orgs,
  activeId,
}: {
  orgs: { id: string; name: string }[]
  activeId: string
}) {
  const router = useRouter()
  const { busy, error, run } = useAuthAction(explain)
  return (
    <div className="grid max-w-xs gap-2">
      <Label htmlFor="org">Organization</Label>
      <select
        id="org"
        className={selectClass}
        defaultValue={activeId}
        disabled={busy}
        onChange={async (event) => {
          const select = event.currentTarget
          const ok = await run(() =>
            authClient.organization.setActive({ organizationId: select.value })
          )
          // On failure, show the org the session is still in, not the one picked.
          if (ok) router.refresh()
          else select.value = activeId
        }}
      >
        {orgs.map((org) => (
          <option key={org.id} value={org.id}>
            {org.name}
          </option>
        ))}
      </select>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

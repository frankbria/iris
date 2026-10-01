import { isAPIError } from "better-auth/api"
import { headers } from "next/headers"
import { redirect } from "next/navigation"

import { AcceptInvitationButton } from "@/components/org-forms"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { getAuth } from "@/lib/auth"

export default async function AcceptInvitationPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  // headers() first: it makes the page dynamic before getAuth() needs its secrets.
  const requestHeaders = await headers()
  const auth = getAuth()
  const session = await auth.api.getSession({ headers: requestHeaders })
  if (!session)
    redirect(`/login?next=${encodeURIComponent(`/accept-invitation/${id}`)}`)

  // BetterAuth refuses an invitation addressed to another email, or no longer pending.
  const invitation = await auth.api
    .getInvitation({ headers: requestHeaders, query: { id } })
    .catch((error: unknown) => {
      if (isAPIError(error)) return null
      throw error
    })
  if (!invitation)
    return (
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Invitation</CardTitle>
          <CardDescription role="alert">
            This invitation is not for this account, or it has expired or been
            used. You are signed in as {session.user.email}.
          </CardDescription>
        </CardHeader>
      </Card>
    )
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Join {invitation.organizationName}</CardTitle>
        <CardDescription>
          {invitation.inviterEmail} invited you as {invitation.role}.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AcceptInvitationButton invitationId={invitation.id} />
      </CardContent>
    </Card>
  )
}

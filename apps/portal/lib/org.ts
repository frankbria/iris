import { isAPIError } from "better-auth/api"
import { headers } from "next/headers"
import { redirect } from "next/navigation"

import { getAuth } from "@/lib/auth"

/**
 * The signed-in user, their active org and their role in it (#250). Every portal page
 * that shows tenant data starts here, and takes the org from here only: the org is
 * never read from the request. BetterAuth resolves the session's active org and checks
 * membership on every call. A form the page renders for that org sends its id back, so
 * it acts on the org the user saw even if another tab switched since.
 *
 * BetterAuth clears the active org when a read of it is refused (the user was removed,
 * or a request named an org they are not in), and answers 400 for one that no longer
 * exists. Either way the session moves to an org the user still belongs to.
 *
 * ponytail: `getFullOrganization` returns the first 100 members. Page it when an org
 * outgrows that.
 */
export async function requireOrg() {
  // headers() first: it makes the page dynamic before getAuth() needs its secrets.
  const requestHeaders = await headers()
  const auth = getAuth()
  const session = await auth.api.getSession({ headers: requestHeaders })
  if (!session) redirect("/login")

  const readActive = () =>
    auth.api
      .getFullOrganization({ headers: requestHeaders })
      .catch((error: unknown) => {
        if (
          isAPIError(error) &&
          (error.status === "FORBIDDEN" || error.status === "BAD_REQUEST")
        )
          return null
        throw error
      })
  const orgs = await auth.api.listOrganizations({ headers: requestHeaders })
  let org = await readActive()
  if (!org && orgs[0]) {
    await auth.api.setActiveOrganization({
      headers: requestHeaders,
      body: { organizationId: orgs[0].id },
    })
    org = await readActive()
  }
  // Sign-in creates an org for a user with none, so this is someone who left them all.
  if (!org)
    throw new Error(
      "This account is not in any organization. Log out and in again to get one."
    )
  const role = org.members.find((m) => m.userId === session.user.id)?.role
  return { session, org, orgs, role }
}

import { isAPIError } from "better-auth/api"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { cache } from "react"

import { hasAcceptedCurrent } from "../../../src/legal/acceptance"
import { orgSuspensions } from "../../../src/org-suspension"
import { getAuth, getDb } from "@/lib/auth"

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
 * Cached per request (React `cache`): a layout can run it as an auth gate before a
 * streaming boundary (so a redirect is a real 307, not a 200 with a meta refresh, #270)
 * and the page below reuses the answer instead of asking BetterAuth again.
 *
 * ponytail: `getFullOrganization` returns the first 100 members, so `/org` lists only
 * those. Page it when an org outgrows that.
 */
export const requireOrg = cache(async function requireOrg() {
  // headers() first: it makes the page dynamic before getAuth() needs its secrets.
  const requestHeaders = await headers()
  const auth = getAuth()
  const session = await auth.api.getSession({ headers: requestHeaders })
  if (!session) redirect("/login")
  // A new version of the terms (#276) sends the user to accept it before any tenant
  // page. Only the portal is gated: API keys are the org's, and keep working.
  if (!(await hasAcceptedCurrent(getDb(), session.user.id)))
    redirect("/accept-terms")

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
  // Sign-in creates an org for a user with none, so end this session and send them
  // to log in again. An error page here would also take away the logout button.
  if (!org) {
    await auth.api.signOut({ headers: requestHeaders })
    redirect("/login")
  }
  // Asked for directly: `org.members` is capped (below), and the caller may be past it.
  const { role } = await auth.api.getActiveMemberRole({
    headers: requestHeaders,
    query: { organizationId: org.id },
  })
  // An operator suspension (#348): pages show a banner, key writes are refused.
  const suspended = await orgIsSuspended(org.id)
  return { session, org, orgs, role, suspended }
})

/** Whether an operator has suspended the org (#348). One indexed query. */
export const orgIsSuspended = (orgId: string) =>
  orgSuspensions(getDb()).isSuspended(orgId)

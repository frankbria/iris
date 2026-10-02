"use server"

import { headers } from "next/headers"
import { getIP } from "better-auth/api"
import { redirect } from "next/navigation"

import { recordCurrentAcceptance } from "../../../../src/legal/acceptance"
import { ACCEPTED_TERMS } from "../../../../src/legal/versions"
import { getAuth, getDb } from "@/lib/auth"

/**
 * Records the signed-in user's acceptance of the current terms (#276). The form carries
 * the versions it was rendered for, so a form left open across a version bump is
 * refused and the page shows the new ones.
 */
export async function acceptTerms(form: FormData) {
  const requestHeaders = await headers()
  const session = await getAuth().api.getSession({ headers: requestHeaders })
  if (!session) redirect("/login")
  // Explicit agreement and the versions the form showed: anything else records nothing.
  if (
    form.get("agree") !== "on" ||
    form.get("acceptedTerms") !== ACCEPTED_TERMS
  )
    redirect("/accept-terms?error=1")
  await recordCurrentAcceptance(
    getDb(),
    session.user.id,
    // Validated and normalised like the sign-up path's (null for a malformed header).
    getIP(requestHeaders, getAuth().options)
  )
  redirect("/dashboard")
}

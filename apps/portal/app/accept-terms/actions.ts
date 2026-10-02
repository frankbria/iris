"use server"

import { headers } from "next/headers"
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
  if (form.get("acceptedTerms") === ACCEPTED_TERMS)
    await recordCurrentAcceptance(
      getDb(),
      session.user.id,
      requestHeaders.get("x-real-ip")
    )
  // Accepted, or not: the dashboard sends them back here if it is still missing.
  redirect("/dashboard")
}

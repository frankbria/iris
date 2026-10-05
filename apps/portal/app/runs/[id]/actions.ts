"use server"

import { revalidatePath } from "next/cache"
import { headers } from "next/headers"

import { approveVisualResult } from "../../../../../src/visual-baselines"
import { getAuth, getDb } from "@/lib/auth"
import { orgIsSuspended } from "@/lib/org"
import { artifactStore } from "@/lib/runs"

export type ApproveState = { error?: string; done?: string }

/**
 * Makes one visual result its project's new baseline (#463). BetterAuth decides who may:
 * the caller must be an owner or admin of the org the form names (`visualBaseline`
 * permission); members cannot. The org id comes from the form the page rendered for the
 * session's org, as other portal actions do; the run and result are read within it.
 */
export async function approveBaseline(
  _previous: ApproveState,
  form: FormData
): Promise<ApproveState> {
  const organizationId = String(form.get("organizationId") ?? "")
  const runId = String(form.get("runId") ?? "")
  const rawPosition = String(form.get("position") ?? "")
  // Digits only: `Number("")` is 0, which would name the first result.
  const position = /^\d{1,4}$/.test(rawPosition) ? Number(rawPosition) : -1
  // BetterAuth reads an empty id as "the active org".
  if (!organizationId) return { error: "You cannot approve baselines here." }
  const auth = getAuth()
  const requestHeaders = await headers()
  const permitted = await auth.api
    .hasPermission({
      headers: requestHeaders,
      body: { organizationId, permissions: { visualBaseline: ["approve"] } },
    })
    .catch(() => null)
  if (!permitted?.success)
    return { error: "Only owners and admins can approve a baseline." }
  if (await orgIsSuspended(organizationId))
    return { error: "This organization is suspended." }
  const store = artifactStore()
  if (!store) return { error: "Visual baselines are not configured." }
  const session = await auth.api.getSession({ headers: requestHeaders })
  // Every approval names who made it (the audit row); no session, no approval.
  if (!session) return { error: "Sign in again to approve." }
  const outcome = await approveVisualResult(getDb(), store, {
    orgId: organizationId,
    runId,
    position,
    actor: { userId: session.user.id },
  })
  if (outcome.status === "not-found")
    return { error: "That result was not found." }
  if (outcome.status === "conflict") return { error: outcome.reason }
  revalidatePath(`/runs/${runId}`)
  return {
    done: `Approved as the ${outcome.baseline.device} baseline of ${outcome.baseline.page}.`,
  }
}

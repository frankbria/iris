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
  const position = Number(form.get("position"))
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
  const outcome = await approveVisualResult(getDb(), store, {
    orgId: organizationId,
    runId,
    position,
    actor: { userId: session?.user.id ?? null },
  })
  if (outcome.status === "not-found")
    return { error: "That result was not found." }
  if (outcome.status === "conflict") return { error: outcome.reason }
  revalidatePath(`/runs/${runId}`)
  return {
    done: `Approved as the ${outcome.baseline.device} baseline of ${outcome.baseline.page}.`,
  }
}

"use server"

import { headers } from "next/headers"
import { redirect } from "next/navigation"

import { BillingError, type PaidPlan } from "../../../../src/billing/stripe"
import { paymentState } from "../../../../src/billing/payment-grace"
import { getAuth, getDb } from "@/lib/auth"
import { billingReturnUrl, getBilling } from "@/lib/billing"
import { orgIsSuspended } from "@/lib/org"

export type BillingState = { error?: string }

const PLANS: readonly PaidPlan[] = ["pro", "team"]

type Billing = NonNullable<ReturnType<typeof getBilling>>

/**
 * Billing for the named org, or why the caller may not manage it. BetterAuth decides:
 * owners and admins of that org (`billing` permission). The org id comes from the form
 * the page rendered, as other portal actions do.
 */
async function authorise(
  organizationId: string,
  { toPay = false } = {}
): Promise<{ billing: Billing } | { error: string }> {
  // BetterAuth reads an empty id as "the active org".
  if (!organizationId) return { error: "You cannot change billing here." }
  const permitted = await getAuth()
    .api.hasPermission({
      headers: await headers(),
      body: { organizationId, permissions: { billing: ["manage"] } },
    })
    .catch(() => null)
  if (!permitted?.success)
    return { error: "Only owners and admins can change billing." }
  // After the permission check, so a non-member learns nothing about the org (#348).
  // A suspension for a failed payment (#266) still reaches the Customer Portal (`toPay`):
  // paying there is the only way out of it.
  if (
    (await orgIsSuspended(organizationId)) &&
    !(toPay && (await paymentState(getDb(), organizationId))?.suspended)
  )
    return { error: "This organization is suspended." }
  const billing = getBilling()
  return billing ? { billing } : { error: "Billing is not available." }
}

/**
 * Where an Upgrade goes (#688): Checkout for a first subscription, the Customer Portal
 * when the org already has one (plan changes happen there), or why neither.
 */
async function checkoutDestination(
  billing: Billing,
  organizationId: string,
  plan: PaidPlan,
  userId: string
): Promise<{ url: string } | { error: string }> {
  try {
    const result = await billing.checkout(
      organizationId,
      plan,
      billingReturnUrl(),
      { userId }
    )
    if (result.outcome === "busy")
      return {
        error: "Billing is busy for this organization. Try again in a moment.",
      }
    if (result.outcome === "checkout") return { url: result.url }
    return { url: await billing.portalUrl(organizationId, billingReturnUrl()) }
  } catch (error) {
    if (error instanceof BillingError) return { error: error.message }
    throw error
  }
}

/** Sends the user to Stripe Checkout, or to the Customer Portal once subscribed. */
export async function startCheckout(
  _previous: BillingState,
  form: FormData
): Promise<BillingState> {
  const organizationId = String(form.get("organizationId") ?? "")
  const plan = PLANS.find((p) => p === form.get("plan"))
  if (!plan) return { error: "Choose Pro or Team." }
  const allowed = await authorise(organizationId)
  if ("error" in allowed) return allowed
  const session = await getAuth().api.getSession({ headers: await headers() })
  if (!session) return { error: "Sign in again to change billing." }
  const destination = await checkoutDestination(
    allowed.billing,
    organizationId,
    plan,
    session.user.id
  )
  if ("error" in destination) return destination
  redirect(destination.url)
}

/** Sends the user to the Stripe Customer Portal: plan changes, cards, cancelling. */
export async function openBillingPortal(
  _previous: BillingState,
  form: FormData
): Promise<BillingState> {
  const organizationId = String(form.get("organizationId") ?? "")
  const allowed = await authorise(organizationId, { toPay: true })
  if ("error" in allowed) return allowed
  let url: string
  try {
    url = await allowed.billing.portalUrl(organizationId, billingReturnUrl())
  } catch (error) {
    if (error instanceof BillingError) return { error: error.message }
    throw error
  }
  redirect(url)
}

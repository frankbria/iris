"use client"

import { useActionState } from "react"

import {
  openBillingPortal,
  startCheckout,
  type BillingState,
} from "@/app/org/actions"
import { Button } from "@/components/ui/button"

function BillingError({ state }: { state: BillingState }) {
  if (!state.error) return null
  return (
    <p role="alert" className="text-sm text-destructive">
      {state.error}
    </p>
  )
}

/** Starts Stripe Checkout for a first subscription (#261). Owners and admins only. */
export function UpgradeForm({
  organizationId,
  plan,
  label,
}: {
  organizationId: string
  plan: "pro" | "team"
  label: string
}) {
  const [state, action, pending] = useActionState<BillingState, FormData>(
    startCheckout,
    {}
  )
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="plan" value={plan} />
      <Button type="submit" disabled={pending}>
        {label}
      </Button>
      <BillingError state={state} />
    </form>
  )
}

/** Opens the Stripe Customer Portal: plan changes, cards, invoices, cancelling. */
export function ManageBillingForm({
  organizationId,
}: {
  organizationId: string
}) {
  const [state, action, pending] = useActionState<BillingState, FormData>(
    openBillingPortal,
    {}
  )
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="organizationId" value={organizationId} />
      <Button type="submit" variant="outline" disabled={pending}>
        Manage billing
      </Button>
      <BillingError state={state} />
    </form>
  )
}

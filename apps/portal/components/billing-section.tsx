import {
  hasLiveSubscription,
  type OrgBillingAccount,
} from "../../../src/billing/stripe"
import type { PlanId } from "../../../src/billing/plans"
import { ManageBillingForm, UpgradeForm } from "@/components/billing-forms"

const PLAN_NAMES: Record<PlanId, string> = {
  free: "Free",
  pro: "Pro",
  team: "Team",
}

/**
 * The org's plan and, once the verified webhook has written one (#345), its
 * subscription status. Never the Checkout redirect's word for it.
 */
export function PlanLine({
  plan,
  account,
}: {
  plan: PlanId
  account: OrgBillingAccount | null
}) {
  return (
    <p className="text-sm">
      Plan: {PLAN_NAMES[plan]}
      {account?.subscriptionStatus && (
        <span className="text-muted-foreground">
          {" "}
          (subscription {account.subscriptionStatus.replace("_", " ")})
        </span>
      )}
    </p>
  )
}

/**
 * Checkout and the Stripe Customer Portal (#261), on `/org` and `/usage`. Managers start
 * Checkout when no subscription is live, and use the Customer Portal once a customer
 * exists; everyone else is told who can.
 */
export function BillingControls({
  organizationId,
  manages,
  account,
}: {
  organizationId: string
  manages: boolean
  account: OrgBillingAccount | null
}) {
  if (!manages)
    return (
      <p className="text-sm text-muted-foreground">
        Only owners and admins can change billing.
      </p>
    )
  return (
    <>
      {!hasLiveSubscription(account) && (
        <div className="flex flex-wrap gap-2">
          <UpgradeForm
            organizationId={organizationId}
            plan="pro"
            label="Upgrade to Pro"
          />
          <UpgradeForm
            organizationId={organizationId}
            plan="team"
            label="Upgrade to Team"
          />
        </div>
      )}
      {account && <ManageBillingForm organizationId={organizationId} />}
    </>
  )
}

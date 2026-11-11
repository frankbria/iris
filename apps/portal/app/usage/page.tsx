import Link from "next/link"

import {
  managedSpendThisMonth,
  orgAiSettings,
} from "../../../../src/billing/managed-ai"
import { orgEntitlements } from "../../../../src/billing/plans"
import { runsUsedThisMonth, usageLedger } from "../../../../src/billing/usage"
import { storageUsage } from "../../../../src/storage-quota"
import { BillingControls, PlanLine } from "@/components/billing-section"
import { SuspendedBanner } from "@/components/contact-link"
import { getDb } from "@/lib/auth"
import { getBilling } from "@/lib/billing"
import { isManager, requireOrg } from "@/lib/org"
import {
  aiSplit,
  formatUsd,
  planUsage,
  utcMonth,
  type ModeUsage,
} from "@/lib/usage"

const day = (d: Date) => d.toISOString().slice(0, 10)

function ModeCells({ usage }: { usage: ModeUsage }) {
  return (
    <>
      <td className="py-2 pr-4">{usage.calls.toLocaleString("en-US")}</td>
      <td className="py-2 pr-4">{formatUsd(usage.costUsd)}</td>
    </>
  )
}

/**
 * Usage and billing (#271): the org's plan, this UTC month's usage against the plan's
 * limits, the IRIS credit left, and AI usage split by who paid the provider. Every
 * member can read it; the billing controls are for owners and admins. The org comes
 * from the session (`requireOrg()`), never the request.
 */
export default async function UsagePage() {
  const { org, role, suspended } = await requireOrg()
  const db = getDb()
  const billing = getBilling()
  const period = utcMonth(new Date())
  const [plan, summary, runsUsed, stored, mode, managedSpent, account] =
    await Promise.all([
      orgEntitlements(db).get(org.id),
      usageLedger(db).summary(org.id, period.from, period.to),
      runsUsedThisMonth(db, org.id),
      storageUsage(db, org.id),
      orgAiSettings(db).get(org.id),
      managedSpendThisMonth(db, org.id),
      billing ? billing.account(org.id) : null,
    ])
  const sessions = plan.maxConcurrentSessions
  const credit = plan.managedAiCreditUsdPerMonth
  const split = aiSplit(summary)
  // `to` is exclusive: the last day shown is the one before it.
  const lastDay = new Date(period.to.getTime() - 1)
  return (
    <main className="flex min-h-svh flex-col gap-6 p-6">
      {suspended && <SuspendedBanner />}
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-lg font-medium">
          Usage and billing for {org.name}
        </h1>
        <Link href="/dashboard" className="text-sm underline">
          Back to the dashboard
        </Link>
      </div>
      <section aria-labelledby="plan" className="flex flex-col gap-2">
        <h2 id="plan" className="font-medium">
          Plan
        </h2>
        <PlanLine plan={plan.plan} account={account} />
        <p className="text-sm text-muted-foreground">
          {sessions} browser {sessions === 1 ? "session" : "sessions"} at a
          time.
        </p>
        {billing && (
          <BillingControls
            organizationId={org.id}
            manages={isManager(role)}
            account={account}
          />
        )}
      </section>
      <section className="flex flex-col gap-2">
        <table className="w-full text-left text-sm">
          <caption className="pb-2 text-left font-medium">
            Usage from {day(period.from)} to {day(lastDay)} (UTC)
          </caption>
          <thead className="text-muted-foreground">
            <tr>
              <th scope="col" className="py-2 pr-4 font-medium">
                What
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Used
              </th>
              <th scope="col" className="py-2 font-medium">
                Plan limit
              </th>
            </tr>
          </thead>
          <tbody>
            {planUsage(plan, summary, runsUsed, stored).map((line) => (
              <tr key={line.label} className="border-t">
                <th scope="row" className="py-2 pr-4 font-normal">
                  {line.label}
                </th>
                <td className="py-2 pr-4">{line.used}</td>
                <td className="py-2">
                  {line.limit ?? "No monthly limit"}
                  {line.reached && " (limit reached)"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-sm text-muted-foreground">
          Runs are accessibility and visual jobs, counting those queued or
          running; a visual job counts one run per page and device. Limits reset
          on the first of each month (UTC). Storage is what is stored now.
        </p>
      </section>
      <section aria-labelledby="credits" className="flex flex-col gap-2">
        <h2 id="credits" className="font-medium">
          IRIS credits
        </h2>
        <p className="text-sm">
          {credit > 0
            ? `${formatUsd(Math.max(credit - managedSpent, 0))} of ${formatUsd(credit)} left this month.`
            : "Your plan includes no IRIS credits."}
        </p>
        <p className="text-sm text-muted-foreground">
          {mode === "managed"
            ? "AI calls use IRIS credits first, then your own keys."
            : "AI calls use your organization's own provider keys."}{" "}
          <Link href="/provider-keys" className="underline">
            AI provider keys
          </Link>
        </p>
      </section>
      <section className="flex flex-col gap-2">
        <table className="w-full text-left text-sm">
          <caption className="pb-2 text-left font-medium">
            AI usage this month, by who paid
          </caption>
          <thead className="text-muted-foreground">
            <tr>
              <th scope="col" className="py-2 pr-4 font-medium">
                What
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Your keys: calls
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                Your keys: provider cost
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                IRIS credits: calls
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                IRIS credits: cost
              </th>
            </tr>
          </thead>
          <tbody>
            {[...split.rows, split.total].map((row) => (
              <tr key={row.label} className="border-t">
                <th scope="row" className="py-2 pr-4 font-normal">
                  {row.label}
                </th>
                <ModeCells usage={row.byok} />
                <ModeCells usage={row.managed} />
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-sm text-muted-foreground">
          Calls on your own keys are billed to you by the provider; the cost
          here is what IRIS worked out from its price list.
          {split.estimatedCostUsd > 0 &&
            ` ${formatUsd(split.estimatedCostUsd)} of these costs is priced at an estimated rate.`}
        </p>
      </section>
    </main>
  )
}

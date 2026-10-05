import Link from "next/link"

import { orgEntitlements } from "../../../../src/billing/plans"
import {
  managedSpendThisMonth,
  orgAiSettings,
} from "../../../../src/billing/managed-ai"
import {
  AiModeForm,
  ProviderKeyForm,
  RemoveProviderKeyButton,
} from "@/components/provider-key-forms"
import { getDb } from "@/lib/auth"
import { SuspendedBanner } from "@/components/contact-link"
import { requireOrg } from "@/lib/org"
import { getProviderKeys } from "@/lib/provider-keys"

const PROVIDERS = [
  { id: "openai", label: "OpenAI" },
  { id: "anthropic", label: "Anthropic" },
] as const

const when = (date: Date) =>
  `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`

/**
 * The org's own AI provider keys (BYOK, #344). Everyone in the org sees which vendors
 * have a key and since when; owners and admins set, replace and remove them. A stored
 * key is never shown again: it is encrypted, and only `iris connect` opens it, to make
 * this org's AI calls. With keys for both vendors, the one saved last is used.
 */
export default async function ProviderKeysPage() {
  const { org, role, suspended } = await requireOrg()
  const stored = await getProviderKeys().list(org.id)
  // A member may hold several roles, stored comma-separated.
  const manager = role.split(",").some((r) => r === "owner" || r === "admin")
  // How the org pays for AI (#479) and what is left of this month's credit.
  const db = getDb()
  const [mode, plan, spent] = await Promise.all([
    orgAiSettings(db).get(org.id),
    orgEntitlements(db).get(org.id),
    managedSpendThisMonth(db, org.id),
  ])
  const credit = plan.managedAiCreditUsdPerMonth
  const left = Math.max(credit - spent, 0)
  return (
    <main className="flex min-h-svh flex-col gap-6 p-6">
      {suspended && <SuspendedBanner />}
      <div className="flex flex-col gap-1">
        <h1 className="font-heading text-lg font-medium">
          AI provider keys for {org.name}
        </h1>
        <p className="text-sm text-muted-foreground">
          IRIS uses your organization&apos;s own key for its AI calls. Keys are
          encrypted and never shown again.
        </p>
        <Link href="/dashboard" className="text-sm underline">
          Back to the dashboard
        </Link>
      </div>
      <section
        aria-labelledby="ai-mode-heading"
        className="flex flex-col gap-2"
      >
        <h2 id="ai-mode-heading" className="font-medium">
          AI usage
        </h2>
        <p className="text-sm">
          {mode === "managed"
            ? `IRIS credits: $${left.toFixed(2)} of $${credit.toFixed(2)} left this month.`
            : "Your organization's own keys are used."}
        </p>
        {manager && <AiModeForm organizationId={org.id} mode={mode} />}
      </section>
      {PROVIDERS.map(({ id, label }) => {
        const key = stored.find((k) => k.provider === id)
        return (
          <section
            key={id}
            aria-labelledby={`${id}-heading`}
            className="flex flex-col gap-2"
          >
            <h2 id={`${id}-heading`} className="font-medium">
              {label}
            </h2>
            <div className="flex items-center gap-3 text-sm">
              <span>
                {key ? `Key set ${when(key.updatedAt)}` : "No key set."}
              </span>
              {manager && key && (
                <RemoveProviderKeyButton
                  organizationId={org.id}
                  provider={id}
                  label={label}
                />
              )}
            </div>
            {manager && (
              <ProviderKeyForm
                organizationId={org.id}
                provider={id}
                label={label}
                configured={Boolean(key)}
              />
            )}
          </section>
        )
      })}
      {!manager && (
        <p className="text-sm text-muted-foreground">
          Only owners and admins can change provider keys.
        </p>
      )}
    </main>
  )
}

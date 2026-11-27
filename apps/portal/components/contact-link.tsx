import Link from "next/link"

import type { PaymentState } from "../../../src/billing/payment-grace"
import { contactLabel, readContacts } from "@/lib/contacts"

/** A configured contact as a link, or its `[placeholder]` while unset (#348). */
export function ContactLink({
  url,
  placeholder,
}: {
  url: string | null
  placeholder: string
}) {
  if (!url) return <span>{placeholder}</span>
  return (
    <a href={url} className="underline">
      {contactLabel(url)}
    </a>
  )
}

/** Shown on every org page while the org is suspended (#348). */
export function SuspendedBanner({
  support = readContacts().support,
}: {
  support?: string | null
}) {
  return (
    <p
      role="note"
      className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive"
    >
      This organization is suspended. Contact{" "}
      <ContactLink url={support} placeholder="[support contact]" />.
    </p>
  )
}

const BillingLink = () => (
  <Link href="/org#billing" className="underline">
    Billing
  </Link>
)

/**
 * The org's standing, on every org page: an operator's suspension (#348), a suspension
 * for a failed payment, or the warning during its grace period (#266). The payment
 * banners say why, because paying is what ends them; an operator's reason is never shown.
 */
export function OrgBanner({
  suspended,
  payment,
  support,
  now = new Date(),
}: {
  suspended: boolean
  payment: PaymentState | null
  support?: string | null
  now?: Date
}) {
  if (suspended && !payment?.suspended)
    return <SuspendedBanner support={support} />
  if (!payment) return null
  if (payment.suspended)
    return (
      <p
        role="note"
        className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive"
      >
        This organization is suspended because a payment failed. An owner or
        admin can update the payment method under <BillingLink /> to restore it.
      </p>
    )
  return (
    <p role="note" className="rounded-md border px-3 py-2 text-sm font-medium">
      A payment for this organization failed. Update the payment method under{" "}
      <BillingLink />
      {payment.graceEndsAt > now &&
        ` by ${payment.graceEndsAt.toISOString().slice(0, 10)} (UTC)`}{" "}
      to avoid suspension.
    </p>
  )
}

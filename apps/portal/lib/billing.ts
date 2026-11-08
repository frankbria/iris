// Holds the Stripe secret key: a client import must fail the build, not ship it.
import "server-only"

import {
  resolveStripeConfig,
  stripeBilling,
  stripeClient,
} from "../../../src/billing/stripe"
import { readSecretEnv } from "../../../src/secret-env"
import { getDb } from "@/lib/auth"

let billing: ReturnType<typeof stripeBilling> | null | undefined

/**
 * Stripe Checkout and the Customer Portal (#261), from `IRIS_STRIPE_*` (see
 * `resolveStripeConfig`). `null` when none is set: billing is off and the org page hides
 * it. A partial configuration throws. Built on first use, so `next build` needs no secrets.
 */
export function getBilling() {
  if (billing !== undefined) return billing
  const config = resolveStripeConfig()
  billing = config && stripeBilling(getDb(), stripeClient(config), config)
  return billing
}

/** Where Stripe sends the user back: the org page, on the portal's public origin. */
export const billingReturnUrl = () => `${readSecretEnv("BETTER_AUTH_URL")}/org`

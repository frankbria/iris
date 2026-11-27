/** @jest-environment node */
import { startCheckout } from "../app/org/actions"

/**
 * `startCheckout` (#688): what the user is sent to for each answer of the billing
 * guard. The guard itself runs against Postgres and Stripe in the root suite
 * (`__tests__/db/stripe-billing.test.ts`); here it is a stand-in.
 */

class Redirected extends Error {
  constructor(readonly to: string) {
    super(`redirect to ${to}`)
  }
}

const billing = { checkout: jest.fn(), portalUrl: jest.fn() }
const hasPermission = jest.fn()

jest.mock("next/headers", () => ({ headers: async () => new Headers() }))
jest.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirected(to)
  },
}))
jest.mock("../lib/auth", () => ({
  getAuth: () => ({
    api: {
      hasPermission: (request: unknown) => hasPermission(request),
      getSession: async () => ({ user: { id: "u1" } }),
    },
  }),
  getDb: () => ({}),
}))
jest.mock("../lib/billing", () => ({
  getBilling: () => billing,
  billingReturnUrl: () => "https://portal.test/org",
}))
jest.mock("../lib/org", () => ({ orgIsSuspended: async () => false }))
// Kysely and the Stripe SDK are not loadable in this Jest: only what the action reads.
jest.mock("../../../src/billing/stripe", () => ({
  BillingError: class BillingError extends Error {},
}))
jest.mock("../../../src/billing/payment-grace", () => ({
  paymentState: async () => null,
}))

const form = () => {
  const data = new FormData()
  data.set("organizationId", "o1")
  data.set("plan", "pro")
  return data
}

beforeEach(() => {
  jest.resetAllMocks()
  hasPermission.mockResolvedValue({ success: true })
})

test("a first subscription goes to Stripe Checkout", async () => {
  billing.checkout.mockResolvedValue({
    outcome: "checkout",
    url: "https://checkout.stripe.test/cs_1",
  })
  await expect(startCheckout({}, form())).rejects.toEqual(
    new Redirected("https://checkout.stripe.test/cs_1")
  )
  expect(billing.checkout).toHaveBeenCalledWith(
    "o1",
    "pro",
    "https://portal.test/org",
    { userId: "u1" }
  )
})

test("an org that already has a subscription is sent to the Customer Portal", async () => {
  billing.checkout.mockResolvedValue({ outcome: "subscribed" })
  billing.portalUrl.mockResolvedValue("https://billing.stripe.test/p_1")
  await expect(startCheckout({}, form())).rejects.toEqual(
    new Redirected("https://billing.stripe.test/p_1")
  )
  expect(billing.portalUrl).toHaveBeenCalledWith(
    "o1",
    "https://portal.test/org"
  )
})

test("a Checkout already starting for the org is answered with a message", async () => {
  billing.checkout.mockResolvedValue({ outcome: "busy" })
  await expect(startCheckout({}, form())).resolves.toEqual({
    error: "Billing is busy for this organization. Try again in a moment.",
  })
  expect(billing.portalUrl).not.toHaveBeenCalled()
})

test("a member is refused before the guard runs", async () => {
  hasPermission.mockResolvedValue({ success: false })
  await expect(startCheckout({}, form())).resolves.toEqual({
    error: "Only owners and admins can change billing.",
  })
  expect(billing.checkout).not.toHaveBeenCalled()
})

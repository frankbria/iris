/** @jest-environment node */
import { APIError } from "better-auth/api"

import { logInIfSignedOut, requireOrg } from "../lib/org"

class Redirected extends Error {
  constructor(readonly to: string) {
    super(`redirect to ${to}`)
  }
}

const api = {
  getSession: jest.fn(),
  listOrganizations: jest.fn(),
  getFullOrganization: jest.fn(),
  setActiveOrganization: jest.fn(),
  getActiveMemberRole: jest.fn(),
  signOut: jest.fn(),
}

// better-auth ships ES modules only, which this Jest setup cannot load: a stand-in with
// the one thing `logInIfSignedOut` reads, the body's code.
jest.mock("better-auth/api", () => {
  class APIError extends Error {
    constructor(
      readonly status: string,
      readonly body: { code: string }
    ) {
      super(body.code)
    }
  }
  return {
    APIError,
    isAPIError: (error: unknown) => error instanceof APIError,
  }
})
jest.mock("react", () => ({
  ...jest.requireActual<typeof import("react")>("react"),
  cache: <T>(fn: T) => fn,
}))
jest.mock("next/headers", () => ({ headers: async () => new Headers() }))
jest.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirected(to)
  },
}))
jest.mock("../lib/auth", () => ({
  getAuth: () => ({ api }),
  getDb: () => ({}),
}))
jest.mock("../../../src/legal/acceptance", () => ({
  hasAcceptedCurrent: async () => true,
}))
jest.mock("../../../src/org-suspension", () => ({
  orgSuspensions: () => ({ isSuspended: async () => false }),
}))

/** What BetterAuth's session middleware throws when the session is no longer there. */
const sessionGone = () => new APIError("UNAUTHORIZED", { code: "UNAUTHORIZED" })

const session = { user: { id: "u1", email: "nora@iris.test" } }
const org = { id: "o1", name: "Nora's organization" }

beforeEach(() => {
  jest.resetAllMocks()
  api.getSession.mockResolvedValue(session)
  api.listOrganizations.mockResolvedValue([org])
  api.getFullOrganization.mockResolvedValue(org)
  api.getActiveMemberRole.mockResolvedValue({ role: "owner" })
})

test("a signed-in member gets their session, org and role", async () => {
  await expect(requireOrg()).resolves.toEqual({
    session,
    org,
    orgs: [org],
    role: "owner",
    suspended: false,
  })
})

test("a user left in no org is signed out and sent to log in", async () => {
  api.listOrganizations.mockResolvedValue([])
  api.getFullOrganization.mockResolvedValue(null)
  await expect(requireOrg()).rejects.toEqual(new Redirected("/login"))
  expect(api.signOut).toHaveBeenCalledTimes(1)
})

// #685: another request (a second tab, a link prefetch) ended the session after this
// one had read it. Each later read then throws BetterAuth's bare "Unauthorized".
test.each([
  "listOrganizations",
  "getFullOrganization",
  "setActiveOrganization",
  "getActiveMemberRole",
] as const)(
  "a session that ends before %s is sent to log in, not to an error page",
  async (call) => {
    if (call === "setActiveOrganization")
      api.getFullOrganization.mockResolvedValue(null)
    api[call].mockRejectedValue(sessionGone())
    await expect(requireOrg()).rejects.toEqual(new Redirected("/login"))
  }
)

test("any other failure of a read still reaches the error page", async () => {
  const down = new Error("connection refused")
  api.listOrganizations.mockRejectedValue(down)
  await expect(requireOrg()).rejects.toBe(down)
  const refused = new APIError("FORBIDDEN", {
    code: "YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION",
  })
  api.listOrganizations.mockResolvedValue([org])
  api.getActiveMemberRole.mockRejectedValue(refused)
  await expect(requireOrg()).rejects.toBe(refused)
})

test("a 401 that is not the missing session is not taken for one", () => {
  const banned = new APIError("UNAUTHORIZED", { code: "USER_BANNED" })
  expect(() => logInIfSignedOut(banned)).toThrow(banned)
  expect(() => logInIfSignedOut(sessionGone())).toThrow(
    new Redirected("/login")
  )
})

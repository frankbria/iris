import { render, screen } from "@testing-library/react"

import { ContactLink, SuspendedBanner } from "@/components/contact-link"
import { contactLabel, readContacts, securityTxt } from "@/lib/contacts"

/**
 * Published contacts and security.txt (#348). The route handler is exercised with
 * and without a configured contact in `security-txt-route.test.ts` (node env); E2E
 * covers one configuration end to end.
 */

const BASE = "https://portal.example.com"

describe("readContacts", () => {
  it("is all null with a one-year expiry when nothing is configured", () => {
    expect(readContacts({})).toEqual({
      security: null,
      abuse: null,
      support: null,
      expiresDays: 365,
    })
  })

  it("accepts mailto: and https: URLs", () => {
    expect(
      readContacts({
        IRIS_SECURITY_CONTACT: "mailto:security@example.com",
        IRIS_ABUSE_CONTACT: " https://example.com/abuse ",
        IRIS_SUPPORT_CONTACT: "mailto:help@example.com",
        IRIS_SECURITY_TXT_EXPIRES_DAYS: "90",
      })
    ).toEqual({
      security: "mailto:security@example.com",
      abuse: "https://example.com/abuse",
      support: "mailto:help@example.com",
      expiresDays: 90,
    })
  })

  it.each([
    ["IRIS_SECURITY_CONTACT", "security@example.com"],
    ["IRIS_SECURITY_CONTACT", "http://example.com/security"],
    ["IRIS_ABUSE_CONTACT", "javascript:alert(1)"],
    ["IRIS_ABUSE_CONTACT", "mailto:not-an-address"],
    ["IRIS_SUPPORT_CONTACT", "mailto:a@b.com\nInjected: x"],
    ["IRIS_SUPPORT_CONTACT", "https://exa mple.com"],
  ])("refuses %s=%j, naming the variable", (name, value) => {
    expect(() => readContacts({ [name]: value })).toThrow(name)
  })

  it.each(["0", "366", "1.5", "a year"])(
    "refuses an expiry of %j days",
    (days) => {
      expect(() =>
        readContacts({ IRIS_SECURITY_TXT_EXPIRES_DAYS: days })
      ).toThrow(/IRIS_SECURITY_TXT_EXPIRES_DAYS/)
    }
  )
})

describe("securityTxt", () => {
  const from = new Date("2026-10-01T00:00:00.000Z")

  it("has the RFC 9116 fields, Expires the configured days after `from`", () => {
    const text = securityTxt(
      readContacts({
        IRIS_SECURITY_CONTACT: "mailto:security@example.com",
        IRIS_SECURITY_TXT_EXPIRES_DAYS: "30",
      }),
      BASE,
      from
    )
    expect(text).toBe(
      [
        "Contact: mailto:security@example.com",
        "Expires: 2026-10-31T00:00:00.000Z",
        "Preferred-Languages: en",
        "Policy: https://portal.example.com/contact",
        "Canonical: https://portal.example.com/.well-known/security.txt",
        "",
      ].join("\n")
    )
  })

  it("is null without a security contact (Contact is required), whatever else is set", () => {
    expect(
      securityTxt(
        readContacts({ IRIS_ABUSE_CONTACT: "mailto:abuse@example.com" }),
        BASE,
        from
      )
    ).toBeNull()
  })
})

describe("contact components", () => {
  it("links a configured contact by its address, and shows a placeholder otherwise", () => {
    const { rerender } = render(
      <ContactLink
        url="mailto:help@example.com"
        placeholder="[support contact]"
      />
    )
    const link = screen.getByRole("link", { name: "help@example.com" })
    expect(link.getAttribute("href")).toBe("mailto:help@example.com")
    rerender(<ContactLink url={null} placeholder="[support contact]" />)
    expect(screen.queryByRole("link")).toBeNull()
    expect(screen.getByText("[support contact]")).toBeTruthy()
    expect(contactLabel("https://example.com/help")).toBe(
      "https://example.com/help"
    )
  })

  it("the suspension banner names the support contact, or its placeholder", () => {
    const { rerender } = render(
      <SuspendedBanner support="mailto:help@example.com" />
    )
    expect(screen.getByRole("note").textContent).toBe(
      "This organization is suspended. Contact help@example.com."
    )
    rerender(<SuspendedBanner support={null} />)
    expect(screen.getByRole("note").textContent).toBe(
      "This organization is suspended. Contact [support contact]."
    )
  })
})

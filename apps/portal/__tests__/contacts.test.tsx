import { render, screen } from "@testing-library/react"

import {
  ContactLink,
  OrgBanner,
  SuspendedBanner,
} from "@/components/contact-link"
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
    // The URL parser drops a newline in a query, but the raw value is what is served:
    // it would add a line to security.txt.
    ["IRIS_SECURITY_CONTACT", "mailto:a@b.co?\nPolicy: https://evil.example"],
    ["IRIS_SECURITY_CONTACT", "mailto:a@b.co?subject=x\r\nExpires: 2099"],
    ["IRIS_SECURITY_CONTACT", "mailto:a@b.co?\tx"],
    // Shown decoded on /contact and in the banner: a bad escape must fail here, at
    // configuration, not later as a page that cannot render.
    ["IRIS_SUPPORT_CONTACT", "mailto:help%desk@example.com"],
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

  describe("OrgBanner (#266)", () => {
    const now = new Date("2026-11-11T12:00:00Z")
    const later = new Date("2026-11-18T09:30:00Z")
    const earlier = new Date("2026-11-10T09:30:00Z")

    it("shows nothing for an org in good standing", () => {
      const { container } = render(
        <OrgBanner suspended={false} payment={null} now={now} />
      )
      expect(container.textContent).toBe("")
    })

    it("warns of a failed payment with the day the grace period ends", () => {
      render(
        <OrgBanner
          suspended={false}
          payment={{ graceEndsAt: later, suspended: false }}
          now={now}
        />
      )
      expect(screen.getByRole("note").textContent).toBe(
        "A payment for this organization failed. Update the payment method under Billing by 2026-11-18 (UTC) to avoid suspension."
      )
      expect(
        screen.getByRole("link", { name: "Billing" }).getAttribute("href")
      ).toBe("/org#billing")
    })

    it("gives no date once the grace period is over but the org is not suspended", () => {
      render(
        <OrgBanner
          suspended={false}
          payment={{ graceEndsAt: earlier, suspended: false }}
          now={now}
        />
      )
      expect(screen.getByRole("note").textContent).toBe(
        "A payment for this organization failed. Update the payment method under Billing to avoid suspension."
      )
    })

    it("says a billing suspension is for the payment and how to end it", () => {
      render(
        <OrgBanner
          suspended
          payment={{ graceEndsAt: earlier, suspended: true }}
          now={now}
        />
      )
      expect(screen.getByRole("note").textContent).toBe(
        "This organization is suspended because a payment failed. An owner or admin can update the payment method under Billing to restore it."
      )
    })

    it("an operator's suspension shows the support banner, failed payment or not", () => {
      render(
        <OrgBanner
          suspended
          payment={{ graceEndsAt: earlier, suspended: false }}
          support="mailto:help@example.com"
          now={now}
        />
      )
      expect(screen.getByRole("note").textContent).toBe(
        "This organization is suspended. Contact help@example.com."
      )
    })
  })
})

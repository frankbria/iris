/**
 * The published contacts (#348), from operator configuration only: nothing is
 * invented. Each is a `mailto:` or `https:` URL; unset means not configured, and the
 * pages show a `[placeholder]`. A malformed value throws, so `/api/health` fails and
 * a deploy with a typo rolls back instead of publishing a broken address.
 */

export type ContactKind = "security" | "abuse" | "support"

const ENV: Record<ContactKind, string> = {
  security: "IRIS_SECURITY_CONTACT",
  abuse: "IRIS_ABUSE_CONTACT",
  support: "IRIS_SUPPORT_CONTACT",
}

export interface Contacts {
  security: string | null
  abuse: string | null
  support: string | null
  /** security.txt `Expires`: this many days after the portal process first serves it. */
  expiresDays: number
}

/** contactLabel() shows a mailto address decoded; a bad escape must fail at configuration. */
function decodes(text: string): boolean {
  try {
    decodeURIComponent(text)
    return true
  } catch {
    return false
  }
}

function contactUrl(name: string, raw: string | undefined): string | null {
  const value = raw?.trim()
  if (!value) return null
  // The raw value is what security.txt serves, and the URL parser silently drops
  // whitespace and control characters (e.g. a newline in a mailto query) that would add
  // a line to it. None belongs in a contact URL.
  if (/[\s\x00-\x1f\x7f]/.test(value))
    throw new Error(`${name} must be a mailto: or https: URL`)
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} must be a mailto: or https: URL`)
  }
  const ok =
    url.protocol === "mailto:"
      ? /^[^\s@/?#]+@[^\s@/?#]+\.[^\s@/?#]+$/.test(url.pathname) &&
        decodes(value.slice(7))
      : url.protocol === "https:" && url.hostname !== "" && !/\s/.test(value)
  if (!ok) throw new Error(`${name} must be a mailto: or https: URL`)
  return value
}

/** @throws naming the variable, for a malformed contact or expiry */
export function readContacts(
  env: Record<string, string | undefined> = process.env
): Contacts {
  const days = env.IRIS_SECURITY_TXT_EXPIRES_DAYS?.trim() || "365"
  // RFC 9116 recommends an expiry under a year.
  if (!/^\d+$/.test(days) || Number(days) < 1 || Number(days) > 365)
    throw new Error(
      "IRIS_SECURITY_TXT_EXPIRES_DAYS must be a whole number from 1 to 365"
    )
  return {
    security: contactUrl(ENV.security, env[ENV.security]),
    abuse: contactUrl(ENV.abuse, env[ENV.abuse]),
    support: contactUrl(ENV.support, env[ENV.support]),
    expiresDays: Number(days),
  }
}

/** What a contact looks like on a page: the address for mailto:, else the URL. */
export const contactLabel = (url: string) =>
  url.startsWith("mailto:") ? decodeURIComponent(url.slice(7)) : url

/**
 * `/.well-known/security.txt` (RFC 9116), or `null` without a security contact: the
 * RFC requires `Contact`, so no file beats an invalid one.
 */
export function securityTxt(
  contacts: Contacts,
  baseURL: string,
  from: Date
): string | null {
  if (!contacts.security) return null
  const expires = new Date(from.getTime() + contacts.expiresDays * 86_400_000)
  return [
    `Contact: ${contacts.security}`,
    `Expires: ${expires.toISOString()}`,
    "Preferred-Languages: en",
    `Policy: ${new URL("/contact", baseURL)}`,
    `Canonical: ${new URL("/.well-known/security.txt", baseURL)}`,
    "",
  ].join("\n")
}

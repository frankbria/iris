import { readContacts, securityTxt } from "@/lib/contacts"

// Read at request time: the contact is runtime configuration, not build input.
export const dynamic = "force-dynamic"

/** `Expires` counts from when this process first serves the file: a deploy renews it. */
const servedFrom = new Date()

/** RFC 9116 security.txt (#348); 404 while no security contact is configured. */
export function GET() {
  const body = securityTxt(
    readContacts(),
    process.env.BETTER_AUTH_URL ?? "",
    servedFrom
  )
  if (!body) return new Response("Not found", { status: 404 })
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  })
}

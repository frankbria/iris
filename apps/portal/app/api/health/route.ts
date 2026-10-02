import { checkAuthReady } from "@/lib/auth"
import { getProviderKeys } from "@/lib/provider-keys"

// Every request checks again: never prerendered, never cached.
export const dynamic = "force-dynamic"

/**
 * Readiness for the image's HEALTHCHECK and the deploy's wait (#273): 200 when the
 * auth settings, the BYOK master key and the database all work, else 503. The body
 * never says which: the reason goes to the server log only.
 */
export async function GET() {
  try {
    getProviderKeys()
    await checkAuthReady()
    return new Response("ok", { headers: { "cache-control": "no-store" } })
  } catch (err) {
    console.error("[portal] not ready:", (err as Error).message)
    return new Response("unavailable", {
      status: 503,
      headers: { "cache-control": "no-store" },
    })
  }
}

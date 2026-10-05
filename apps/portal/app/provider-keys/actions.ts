"use server"

import { revalidatePath } from "next/cache"
import { headers } from "next/headers"

import { ProviderKeyError } from "../../../../src/byok/store"
import { orgAiSettings } from "../../../../src/billing/managed-ai"
import { getAuth, getDb } from "@/lib/auth"
import { orgIsSuspended } from "@/lib/org"
import { getProviderKeys } from "@/lib/provider-keys"

export type ProviderKeyState = { error?: string; done?: string }

/** After the permission check, so a non-member learns nothing about the org (#348). */
const SUSPENDED = "This organization is suspended."

const PROVIDERS = ["openai", "anthropic"] as const
type Provider = (typeof PROVIDERS)[number]

/**
 * BetterAuth decides: the caller must be a member of `organizationId` with the
 * `providerKey` permission (owners and admins create and delete, #344). The org id
 * comes from the form the page rendered for the session's org, as `InviteForm`
 * does; BetterAuth refuses an org the caller is not in.
 */
async function allowed(organizationId: string, action: "create" | "delete") {
  // BetterAuth reads an empty id as "the active org": the org checked and the org
  // written would differ.
  if (!organizationId) return false
  const result = await getAuth()
    .api.hasPermission({
      headers: await headers(),
      body: { organizationId, permissions: { providerKey: [action] } },
    })
    .catch((error: unknown) => {
      // Refused, whatever the reason; the reason stays in the server log.
      const e = error as { body?: { code?: string }; message?: string }
      console.error(
        "[portal] provider key permission check refused:",
        e?.body?.code ?? e?.message ?? String(error)
      )
      return null
    })
  return Boolean(result?.success)
}

function provider(form: FormData): Provider | null {
  const value = String(form.get("provider") ?? "")
  return (PROVIDERS as readonly string[]).includes(value)
    ? (value as Provider)
    : null
}

/** Saves or replaces the org's key for a provider. The key is never sent back. */
export async function saveProviderKey(
  _previous: ProviderKeyState,
  form: FormData
): Promise<ProviderKeyState> {
  const organizationId = String(form.get("organizationId") ?? "")
  const vendor = provider(form)
  if (!vendor) return { error: "Choose OpenAI or Anthropic." }
  if (!(await allowed(organizationId, "create")))
    return { error: "Only owners and admins can change provider keys." }
  if (await orgIsSuspended(organizationId)) return { error: SUSPENDED }
  try {
    await getProviderKeys().set(
      organizationId,
      vendor,
      String(form.get("apiKey") ?? "").trim()
    )
  } catch (error) {
    if (error instanceof ProviderKeyError) return { error: error.message }
    throw error
  }
  revalidatePath("/provider-keys")
  return { done: "Saved." }
}

export async function removeProviderKey(
  _previous: ProviderKeyState,
  form: FormData
): Promise<ProviderKeyState> {
  const organizationId = String(form.get("organizationId") ?? "")
  const vendor = provider(form)
  if (!vendor) return { error: "Choose OpenAI or Anthropic." }
  if (!(await allowed(organizationId, "delete")))
    return { error: "Only owners and admins can change provider keys." }
  if (await orgIsSuspended(organizationId)) return { error: SUSPENDED }
  await getProviderKeys().remove(organizationId, vendor)
  revalidatePath("/provider-keys")
  return { done: "Removed." }
}

/**
 * The org's AI mode (#479, ADR 0001 §6): its own keys, or IRIS's credits. Owners and
 * admins (the same `providerKey` permission as the keys), for the org the form names.
 */
export async function setAiMode(
  _previous: ProviderKeyState,
  form: FormData
): Promise<ProviderKeyState> {
  const organizationId = String(form.get("organizationId") ?? "")
  const mode = String(form.get("mode") ?? "")
  if (mode !== "byok" && mode !== "managed")
    return { error: "Choose how to pay for AI." }
  if (!(await allowed(organizationId, "create")))
    return { error: "Only owners and admins can change how AI is paid for." }
  if (await orgIsSuspended(organizationId)) return { error: SUSPENDED }
  const session = await getAuth().api.getSession({ headers: await headers() })
  if (!session) return { error: "Sign in again to change this." }
  await orgAiSettings(getDb()).set(
    organizationId,
    mode,
    `user:${session.user.id}`
  )
  revalidatePath("/provider-keys")
  return {
    done:
      mode === "managed" ? "IRIS credits are on." : "Your own keys are used.",
  }
}

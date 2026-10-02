"use client"

import { useActionState } from "react"

import {
  removeProviderKey,
  saveProviderKey,
  type ProviderKeyState,
} from "@/app/provider-keys/actions"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

/**
 * Sets or replaces one provider's key for the org the page showed. A server action:
 * the form POSTs even before hydration, so the key never lands in a URL. The field
 * is cleared after a save, and nothing returns the key.
 */
export function ProviderKeyForm({
  organizationId,
  provider,
  label,
  configured,
}: {
  organizationId: string
  provider: string
  label: string
  configured: boolean
}) {
  const [state, action, pending] = useActionState<ProviderKeyState, FormData>(
    saveProviderKey,
    {}
  )
  const id = `${provider}-key`
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="provider" value={provider} />
      <Label htmlFor={id}>
        {configured ? `Replace the ${label} key` : `${label} key`}
      </Label>
      <div className="flex gap-2">
        <Input
          id={id}
          name="apiKey"
          type="password"
          autoComplete="off"
          required
          className="font-mono"
        />
        <Button type="submit" disabled={pending}>
          Save
        </Button>
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      {state.done && <p className="text-sm">{state.done}</p>}
    </form>
  )
}

export function RemoveProviderKeyButton({
  organizationId,
  provider,
  label,
}: {
  organizationId: string
  provider: string
  label: string
}) {
  const [state, action, pending] = useActionState<ProviderKeyState, FormData>(
    removeProviderKey,
    {}
  )
  return (
    <form action={action}>
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="provider" value={provider} />
      <Button
        type="submit"
        variant="outline"
        size="sm"
        disabled={pending}
        aria-label={`Remove the ${label} key`}
      >
        Remove
      </Button>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
    </form>
  )
}

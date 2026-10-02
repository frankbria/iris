"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"

import { AuthCard, Field, text, useAuthAction } from "@/components/auth-forms"
import { explain } from "@/components/org-forms"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { authClient } from "@/lib/auth-client"

/**
 * Creates a key for the org the page showed (its id is sent, as `InviteForm` does) and
 * shows it once. BetterAuth stores only a hash, so this state is the only copy: a
 * reload or another create replaces it.
 */
export function CreateApiKeyForm({
  organizationId,
}: {
  organizationId: string
}) {
  const router = useRouter()
  const { busy, error, run } = useAuthAction(explain)
  const [created, setCreated] = useState<string | null>(null)
  return (
    <AuthCard
      title="Create a key"
      description="The key is shown once. Store it somewhere safe."
      submit="Create key"
      busy={busy}
      error={error}
      onSubmit={async (form) => {
        let key: string | null = null
        const ok = await run(async () => {
          const res = await authClient.apiKey.create({
            name: text(form, "name"),
            organizationId,
          })
          key = res.data?.key ?? null
          return res
        })
        if (ok) {
          setCreated(key)
          router.refresh()
        }
      }}
    >
      {created && (
        <div className="grid gap-2">
          <Label htmlFor="new-key">Your new key</Label>
          <div className="flex gap-2">
            <Input
              id="new-key"
              readOnly
              value={created}
              className="font-mono"
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => navigator.clipboard.writeText(created)}
            >
              Copy
            </Button>
          </div>
        </div>
      )}
      <Field label="Name" name="name" autoComplete="off" maxLength={32} />
    </AuthCard>
  )
}

/** Deletes the key: it stops working at once, for every client that holds it. */
export function RevokeApiKeyButton({
  keyId,
  name,
}: {
  keyId: string
  name: string
}) {
  const router = useRouter()
  const { busy, error, run } = useAuthAction(explain)
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        aria-label={`Revoke ${name}`}
        onClick={async () => {
          if (!window.confirm(`Revoke ${name}? Clients using it stop working.`))
            return
          const ok = await run(() => authClient.apiKey.delete({ keyId }))
          if (ok) router.refresh()
        }}
      >
        Revoke
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  )
}

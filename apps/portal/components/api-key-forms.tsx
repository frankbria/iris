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
  const [copyFailed, setCopyFailed] = useState(false)
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
          // The reply is the only copy: a create that returned no key must not
          // look like a success.
          if (!res.error && !key)
            return {
              error: {
                status: 500,
                message:
                  "The key was created but not shown. Revoke it and create another.",
              },
            }
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
              onClick={async () => {
                // No clipboard on plain http, or permission refused.
                try {
                  await navigator.clipboard.writeText(created)
                  setCopyFailed(false)
                } catch {
                  setCopyFailed(true)
                }
              }}
            >
              Copy
            </Button>
          </div>
          {copyFailed && (
            <p role="alert" className="text-sm text-destructive">
              Could not copy. Select the key and copy it yourself.
            </p>
          )}
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

/**
 * Renames a key, and disables or re-enables it (#412): a reversible kill switch, e.g.
 * while a possible leak is investigated, where revoking is final. BetterAuth refuses
 * members (`INSUFFICIENT_API_KEY_PERMISSIONS`) and suspended orgs (#348).
 */
export function KeyControls({
  keyId,
  name,
  enabled,
}: {
  keyId: string
  name: string
  enabled: boolean
}) {
  const router = useRouter()
  const { busy, error, run } = useAuthAction(explain)
  const [renaming, setRenaming] = useState(false)
  return (
    <div className="flex flex-wrap items-center gap-2">
      {renaming ? (
        <form
          className="flex items-center gap-2"
          onSubmit={async (event) => {
            event.preventDefault()
            const newName = text(new FormData(event.currentTarget), "name")
            const ok = await run(() =>
              authClient.apiKey.update({ keyId, name: newName })
            )
            if (ok) {
              setRenaming(false)
              router.refresh()
            }
          }}
        >
          <Label htmlFor={`rename-${keyId}`} className="sr-only">
            New name for {name}
          </Label>
          <Input
            id={`rename-${keyId}`}
            name="name"
            defaultValue={name}
            required
            className="h-7 w-40"
          />
          <Button type="submit" size="sm" disabled={busy}>
            Save name
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setRenaming(false)}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          aria-label={`Rename ${name}`}
          onClick={() => setRenaming(true)}
        >
          Rename
        </Button>
      )}
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        aria-label={`${enabled ? "Disable" : "Enable"} ${name}`}
        onClick={async () => {
          const ok = await run(() =>
            authClient.apiKey.update({ keyId, enabled: !enabled })
          )
          if (ok) router.refresh()
        }}
      >
        {enabled ? "Disable" : "Enable"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}

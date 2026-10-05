"use client"

import { useActionState } from "react"

import { approveBaseline, type ApproveState } from "@/app/runs/[id]/actions"
import { Button } from "@/components/ui/button"

/** Approves one visual result as its project's baseline (#463). Owners and admins only. */
export function ApproveBaselineForm({
  organizationId,
  runId,
  position,
  label,
}: {
  organizationId: string
  runId: string
  position: number
  /** Names the page and device for screen readers: several of these share a page. */
  label: string
}) {
  const [state, action, pending] = useActionState<ApproveState, FormData>(
    approveBaseline,
    {}
  )
  return (
    <form action={action} className="flex flex-col gap-1">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="runId" value={runId} />
      <input type="hidden" name="position" value={position} />
      <Button
        type="submit"
        disabled={pending}
        aria-label={`Approve as new baseline: ${label}`}
      >
        Approve as new baseline
      </Button>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
      {state.done && (
        <p role="status" className="text-sm">
          {state.done}
        </p>
      )}
    </form>
  )
}

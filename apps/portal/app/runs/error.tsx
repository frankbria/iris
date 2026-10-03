"use client"

import Link from "next/link"

import { Button } from "@/components/ui/button"

/**
 * A runs page failed to load (#270), e.g. the database did not answer. The error
 * itself stays in the server log; the page says what the user can do.
 */
export default function RunsError({
  reset,
  retry,
}: {
  error: Error
  reset: () => void
  /** Next 16: fetches the page from the server again, then resets. */
  retry?: () => void
}) {
  return (
    <main className="flex min-h-svh flex-col items-start gap-4 p-6">
      <p role="alert" className="text-sm">
        Runs could not be loaded. Try again in a moment.
      </p>
      <div className="flex items-center gap-4">
        {/* reset() alone re-renders the same failed result: ask the server again. */}
        <Button type="button" onClick={() => (retry ?? reset)()}>
          Try again
        </Button>
        <Link href="/dashboard" className="text-sm underline">
          Dashboard
        </Link>
      </div>
    </main>
  )
}

"use client"

import Link from "next/link"

import { Button } from "@/components/ui/button"

/**
 * A runs page failed to load (#270), e.g. the database did not answer. The error
 * itself stays in the server log; the page says what the user can do.
 */
export default function RunsError({
  reset,
}: {
  error: Error
  reset: () => void
}) {
  return (
    <main className="flex min-h-svh flex-col items-start gap-4 p-6">
      <p role="alert" className="text-sm">
        Runs could not be loaded. Try again in a moment.
      </p>
      <div className="flex items-center gap-4">
        <Button type="button" onClick={() => reset()}>
          Try again
        </Button>
        <Link href="/dashboard" className="text-sm underline">
          Dashboard
        </Link>
      </div>
    </main>
  )
}

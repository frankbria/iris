/** Shown while a runs page loads (#270). */
export default function Loading() {
  return (
    <main className="flex min-h-svh flex-col gap-4 p-6">
      <p role="status" className="text-sm text-muted-foreground">
        Loading runs…
      </p>
    </main>
  )
}

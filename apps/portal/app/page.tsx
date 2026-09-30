import Link from "next/link"

export default function Page() {
  return (
    <main className="flex min-h-svh p-6">
      <div className="flex max-w-md min-w-0 flex-col gap-2 text-sm leading-loose">
        <h1 className="font-heading text-lg font-medium">IRIS portal</h1>
        <p className="text-muted-foreground">
          Accounts, organizations, API keys and billing for hosted IRIS.
        </p>
        <p className="flex gap-4">
          <Link href="/signup" className="underline">
            Create an account
          </Link>
          <Link href="/login" className="underline">
            Log in
          </Link>
        </p>
      </div>
    </main>
  )
}

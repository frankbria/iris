import { headers } from "next/headers"
import { redirect } from "next/navigation"

import { LogOutButton } from "@/components/auth-forms"
import { getAuth } from "@/lib/auth"

export default async function DashboardPage() {
  // headers() first: it makes the page dynamic before getAuth() needs its secrets.
  const requestHeaders = await headers()
  const session = await getAuth().api.getSession({ headers: requestHeaders })
  if (!session) redirect("/login")
  return (
    <main className="flex min-h-svh flex-col gap-4 p-6">
      <h1 className="font-heading text-lg font-medium">IRIS portal</h1>
      <p className="text-sm text-muted-foreground">
        Signed in as{" "}
        <span className="text-foreground">{session.user.email}</span>
      </p>
      <div>
        <LogOutButton />
      </div>
    </main>
  )
}

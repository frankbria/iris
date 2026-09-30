import { LogInForm } from "@/components/auth-forms"

const NOTICES: Record<string, string> = {
  reset: "Password changed. Log in with the new one.",
  verified: "Email verified. Log in to continue.",
}

export default async function LogInPage({
  searchParams,
}: {
  searchParams: Promise<{ reset?: string; verified?: string; error?: string }>
}) {
  const params = await searchParams
  // A failed verification comes back to the sign-up callbackURL with `&error=`
  // appended, next to its `verified=1`. The error wins. Logging in mails a fresh link.
  if (params.error)
    return (
      <LogInForm notice="That link has expired or was already used. Log in and we will send you a new one." />
    )
  const key = Object.keys(NOTICES).find(
    (k) => params[k as keyof typeof params] === "1"
  )
  return <LogInForm notice={key ? NOTICES[key] : null} />
}
